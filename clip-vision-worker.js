function clipVisionWorkerMain() {
const PROTOCOL_VERSION = '1.0';
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm';
const MODEL_NAME = 'Xenova/clip-vit-base-patch32';
const MODEL_VERSION = '3.8.1-q8-worker';
const MODEL_SOURCES = [
  { id: 'hf-mirror', host: 'https://hf-mirror.com/' },
  { id: 'huggingface', host: 'https://huggingface.co/' },
];

let activeSourceId = '';
let classifierPromise = null;
let jobQueue = Promise.resolve();
const cancelledRequests = new Set();
const modelFiles = new Map();
const modelRequests = new Set();
let lastModelProgress = null;

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
    code: error?.code || fallbackCode,
    message: message.slice(0, 240),
    retryable: true,
    auto_retry: error?.autoRetry !== false,
  };
}

function sendModelProgress(payload) {
  lastModelProgress = payload;
  for (const requestId of modelRequests) send('progress', requestId, payload);
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
  let hasUnknownTotal = false;
  for (const value of modelFiles.values()) {
    knownLoaded += value.total ? Math.min(value.loaded, value.total) : value.loaded;
    knownTotal += value.total;
    if (!value.total && !value.done) hasUnknownTotal = true;
  }
  const downloadTotal = hasUnknownTotal ? 0 : knownTotal;
  const rawPercent = downloadTotal ? knownLoaded / downloadTotal * 100 : 0;
  sendModelProgress({
    stage: event.status === 'ready' ? 'load' : 'download',
    percent: Math.max(0, Math.min(100, Math.round(rawPercent))),
    source: activeSourceId,
    file,
    loaded: knownLoaded,
    total: downloadTotal,
  });
}

function modelMetadata(sourceId = 'hf-mirror') {
  return {
    provider: 'transformers.js',
    registry: sourceId,
    name: MODEL_NAME,
    version: MODEL_VERSION,
    execution: 'mobile-worker',
  };
}

async function createClassifier() {
  const { pipeline, env } = await import(TRANSFORMERS_URL);
  if (env) {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    // GitHub Pages and file:// run without cross-origin isolation.
    env.backends.onnx.wasm.numThreads = 1;
  }
  let lastError = null;
  for (const source of MODEL_SOURCES) {
    activeSourceId = source.id;
    modelFiles.clear();
    if (env) env.remoteHost = source.host;
    sendModelProgress({
      stage: 'connecting',
      percent: 0,
      source: source.id,
    });
    try {
      const classifier = await pipeline(
        'zero-shot-image-classification',
        MODEL_NAME,
        {
          dtype: 'q8',
          revision: 'main',
          progress_callback: updateModelProgress,
        },
      );
      return { classifier, sourceId: source.id };
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(lastError?.message || '没有可用的 CLIP 模型下载源');
  error.code = 'clip_model_load_failed';
  error.autoRetry = false;
  throw error;
}

async function loadClassifier(requestId) {
  modelRequests.add(requestId);
  try {
    if (!classifierPromise) {
      lastModelProgress = null;
      classifierPromise = createClassifier().catch((error) => {
        classifierPromise = null;
        throw error;
      });
    } else if (lastModelProgress) {
      // An upload can join the download already started on page entry.
      send('progress', requestId, lastModelProgress);
    }
    return await classifierPromise;
  } finally {
    modelRequests.delete(requestId);
  }
}

async function preload(message) {
  const requestId = String(message.request_id || '');
  try {
    send('progress', requestId, { stage: 'boot', percent: 0 });
    const loaded = await loadClassifier(requestId);
    send('result', requestId, {
      preloaded: true,
      model: modelMetadata(loaded.sourceId),
    });
  } catch (error) {
    send('error', requestId, { stage: 'load', error: safeError(error) });
  }
}

async function recognize(message) {
  const requestId = String(message.request_id || '');
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
    const loaded = await loadClassifier(requestId);
    if (cancelledRequests.delete(requestId)) return;
    send('ready', requestId, {
      model: modelMetadata(loaded.sourceId),
    });
    send('progress', requestId, { stage: 'inference', percent: 0 });
    const predictions = await loaded.classifier(message.image, message.labels, {
      hypothesis_template: '{}',
    });
    if (cancelledRequests.delete(requestId)) return;
    send('result', requestId, {
      model: modelMetadata(loaded.sourceId),
      predictions: Array.isArray(predictions)
        ? predictions.map((item) => ({
            label: String(item.label || ''),
            score: Number(item.score) || 0,
          }))
        : [],
    });
  } catch (error) {
    if (cancelledRequests.delete(requestId)) return;
    send('error', requestId, {
      stage: 'inference',
      error: safeError(error),
    });
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
  if (message.type === 'preload') {
    // Loading is shared; inference stays serialized on the recognition queue.
    void preload(message);
    return;
  }
  if (message.type === 'recognize') {
    jobQueue = jobQueue.then(() => recognize(message));
  }
};
}


// Keep the same recognition worker available when index.html is opened directly.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.ClipVisionWorkerSource = `(${clipVisionWorkerMain.toString()})();`;
} else {
  clipVisionWorkerMain();
}
