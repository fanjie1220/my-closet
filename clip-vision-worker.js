function clipVisionWorkerMain() {
const PROTOCOL_VERSION = '1.0';
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm';
const MODEL_NAME = 'Marqo/marqo-fashionCLIP';
const MODEL_VERSION = '3.8.1-marqo-q8-worker-v1';
const MODEL_SOURCES = [
  { id: 'hf-mirror', host: 'https://hf-mirror.com/' },
  { id: 'huggingface', host: 'https://huggingface.co/' },
];

let classifierPromise = null;
let activeRequestId = '';
let jobQueue = Promise.resolve();
const cancelledRequests = new Set();
const modelFiles = new Map();

function send(type, requestId = '', payload = {}) {
  self.postMessage({
    protocol_version: PROTOCOL_VERSION,
    type,
    request_id: requestId,
    ...payload,
  });
}

function safeError(error, fallbackCode = 'clip_worker_failed') {
  const message = String(error && error.message ? error.message : error || 'CLIP worker failed');
  return {
    code: fallbackCode,
    message: message.slice(0, 240),
    retryable: true,
  };
}

function updateModelProgress(event = {}) {
  const file = String(event.file || event.name || 'model');
  const previous = modelFiles.get(file) || { loaded: 0, total: 0, done: false };
  const total = Number(event.total) || previous.total || 0;
  let loaded = Number(event.loaded);
  if (!Number.isFinite(loaded)) {
    const percent = Number(event.progress);
    loaded = total && Number.isFinite(percent) ? total * percent / 100 : previous.loaded;
  }
  const done = event.status === 'done' || previous.done;
  modelFiles.set(file, {
    loaded: done && total ? total : Math.max(0, loaded || 0),
    total: Math.max(0, total),
    done,
  });

  let knownLoaded = 0;
  let knownTotal = 0;
  for (const value of modelFiles.values()) {
    if (!value.total) continue;
    knownLoaded += Math.min(value.loaded, value.total);
    knownTotal += value.total;
  }
  const rawPercent = knownTotal ? knownLoaded / knownTotal * 100 : Number(event.progress) || 0;
  send('progress', activeRequestId, {
    stage: event.status === 'ready' ? 'load' : 'download',
    percent: Math.max(0, Math.min(100, Math.round(rawPercent))),
    file,
    loaded: Number(event.loaded) || 0,
    total: Number(event.total) || 0,
  });
}

function modelMetadata(sourceId = 'huggingface') {
  return {
    provider: 'transformers.js',
    registry: sourceId,
    name: MODEL_NAME,
    version: MODEL_VERSION,
    execution: 'mobile-worker',
  };
}

async function createClassifier() {
  // Marqo publishes separate ONNX text/vision encoders, rather than the combined
  // model_quantized.onnx expected by the generic zero-shot-image-classification pipeline.
  const { CLIPTextModelWithProjection, CLIPVisionModelWithProjection,
    AutoTokenizer, AutoProcessor, RawImage, softmax, dot, env } = await import(TRANSFORMERS_URL);
  if (env) {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    // file:// and GitHub Pages do not provide cross-origin isolation.
    env.backends.onnx.wasm.numThreads = 1;
  }
  let lastError = null;
  for (const source of MODEL_SOURCES) {
    modelFiles.clear();
    if (env) env.remoteHost = source.host;
    send('progress', activeRequestId, {
      stage: 'download',
      percent: 0,
      source: source.id,
    });
    try {
      const options = { dtype: 'q8', revision: 'main', progress_callback: updateModelProgress };
      const loaded = await Promise.allSettled([
        AutoTokenizer.from_pretrained(MODEL_NAME, options),
        AutoProcessor.from_pretrained(MODEL_NAME, options),
        CLIPTextModelWithProjection.from_pretrained(MODEL_NAME, options),
        CLIPVisionModelWithProjection.from_pretrained(MODEL_NAME, options),
      ]);
      const failure = loaded.find(result => result.status === 'rejected');
      if (failure) {
        await Promise.allSettled(loaded.filter(result => result.status === 'fulfilled')
          .map(result => result.value.dispose?.()));
        throw failure.reason;
      }
      const [tokenizer, processor, textModel, visionModel] = loaded.map(result => result.value);
      const textCache = new Map();
      const classifier = async (image, labels, requestId) => {
        const key = JSON.stringify(labels);
        let textEmbeddings = textCache.get(key);
        const textCacheHit = !!textEmbeddings;
        if (!textEmbeddings) {
          const embeddings = [];
          // Bound the text encoder's peak memory for the full wardrobe dictionary.
          for (let offset = 0; offset < labels.length; offset += 24) {
            if (cancelledRequests.has(requestId)) return null;
            const batch = labels.slice(offset, offset + 24);
            // The published text ONNX encoder has a fixed 77-token input axis.
            const inputs = tokenizer(batch, { padding: 'max_length', max_length: 77, truncation: true });
            const { text_embeds } = await textModel(inputs);
            embeddings.push(...text_embeds.normalize().tolist());
            send('progress', requestId, {
              stage: 'inference', percent: Math.round(Math.min(labels.length, offset + 24) / labels.length * 65),
            });
          }
          textEmbeddings = embeddings;
          if (textCache.size >= 4) textCache.delete(textCache.keys().next().value);
          textCache.set(key, textEmbeddings);
        }
        if (cancelledRequests.has(requestId)) return null;
        send('progress', requestId, { stage: 'inference', percent: 70 });
        const rawImage = await RawImage.read(image);
        const inputs = await processor(rawImage);
        const { image_embeds } = await visionModel(inputs);
        const imageEmbedding = image_embeds.normalize().tolist()[0];
        // Match the normalized embeddings and logit scale in Marqo's official example.
        const scores = softmax(textEmbeddings.map(embedding => 100 * dot(imageEmbedding, embedding)));
        return { predictions: labels.map((label, index) => ({ label, score: scores[index] }))
          .sort((a, b) => b.score - a.score), textCacheHit };
      };
      return { classifier, sourceId: source.id };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('没有可用的 CLIP 模型下载源');
}

async function loadClassifier() {
  if (!classifierPromise) {
    classifierPromise = createClassifier().catch((error) => {
      classifierPromise = null;
      throw error;
    });
  }
  return classifierPromise;
}

async function recognize(message) {
  const requestId = String(message.request_id || '');
  activeRequestId = requestId;
  if (!requestId || !message.image || !Array.isArray(message.labels) || !message.labels.length) {
    send('error', requestId, {
      stage: 'boot',
      error: {
        code: 'invalid_worker_request',
        message: '识别请求缺少图片或候选标签',
        retryable: false,
      },
    });
    return;
  }

  try {
    send('progress', requestId, { stage: 'boot', percent: 0 });
    const loaded = await loadClassifier();
    if (cancelledRequests.delete(requestId)) return;
    send('ready', requestId, {
      model: modelMetadata(loaded.sourceId),
    });
    send('progress', requestId, { stage: 'inference', percent: 0 });
    const startedAt = performance.now();
    const result = await loaded.classifier(message.image, message.labels, requestId);
    if (cancelledRequests.delete(requestId)) return;
    if (!result) return;
    send('result', requestId, {
      model: modelMetadata(loaded.sourceId),
      timing: { inference_ms: Math.round(performance.now() - startedAt), text_cache_hit: result.textCacheHit },
      predictions: result.predictions.map((item) => ({
            label: String(item.label || ''),
            score: Number(item.score) || 0,
          })),
    });
  } catch (error) {
    if (cancelledRequests.delete(requestId)) return;
    send('error', requestId, {
      stage: 'inference',
      error: safeError(error),
    });
  } finally {
    if (activeRequestId === requestId) activeRequestId = '';
  }
}

self.onmessage = (event) => {
  const message = event.data || {};
  const requestId = String(message.request_id || '');
  if (message.protocol_version !== PROTOCOL_VERSION) {
    send('error', requestId, {
      stage: 'boot',
      error: {
        code: 'protocol_mismatch',
        message: 'CLIP Worker 协议版本不一致',
        retryable: false,
      },
    });
    return;
  }
  if (message.type === 'ping') {
    send('pong', requestId, { model_name: MODEL_NAME });
    return;
  }
  if (message.type === 'cancel') {
    cancelledRequests.add(requestId);
    return;
  }
  if (message.type === 'recognize') {
    jobQueue = jobQueue.then(() => recognize(message));
  }
};
}

// Classic scripts can be loaded from file://. Pass the same worker code through
// a Blob URL there, without fetching a local module or relaxing browser security.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.ClipVisionWorkerSource = `(${clipVisionWorkerMain.toString()})();`;
} else {
  clipVisionWorkerMain();
}
