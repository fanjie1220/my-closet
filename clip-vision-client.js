(function () {
  const PROTOCOL_VERSION = '1.0';
  const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;
  let worker = null;
  let requestSequence = 0;
  const pending = new Map();

  function workerError(message, code = 'clip_worker_unavailable') {
    const error = new Error(message);
    error.code = code;
    error.retryable = true;
    return error;
  }

  function rejectAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function resetWorker(reason = 'CLIP Worker 已重置') {
    if (worker) worker.terminate();
    worker = null;
    rejectAll(workerError(reason));
  }

  function ensureWorker() {
    if (worker) return worker;
    if (!window.Worker) throw workerError('当前浏览器不支持本地 AI Worker', 'worker_not_supported');
    if (location.protocol === 'file:') {
      if (!window.ClipVisionWorkerSource) throw workerError('衣物识别程序未加载，请刷新页面后重试');
      const sourceUrl = URL.createObjectURL(new Blob([window.ClipVisionWorkerSource], { type: 'text/javascript' }));
      try { worker = new Worker(sourceUrl); }
      finally { URL.revokeObjectURL(sourceUrl); }
    } else {
      worker = new Worker('clip-vision-worker.js', { type: 'module' });
    }
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.protocol_version !== PROTOCOL_VERSION) return;
      const entry = pending.get(String(message.request_id || ''));
      if (!entry) return;
      if (message.type === 'progress' || message.type === 'ready') {
        if (entry.onProgress) entry.onProgress(message);
        return;
      }
      clearTimeout(entry.timer);
      pending.delete(message.request_id);
      if (message.type === 'result' || message.type === 'pong') {
        entry.resolve(message);
        return;
      }
      if (message.type === 'error') {
        const detail = message.error || {};
        const error = workerError(detail.message || '本地 AI 识别失败', detail.code || 'clip_worker_failed');
        error.retryable = detail.retryable !== false;
        error.stage = message.stage || '';
        entry.reject(error);
      }
    };
    worker.onerror = () => resetWorker('本地 AI Worker 加载失败');
    worker.onmessageerror = () => resetWorker('本地 AI Worker 消息解析失败');
    return worker;
  }

  function request(type, payload = {}, options = {}) {
    let target;
    try {
      target = ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = String(options.requestId || `clip_${Date.now()}_${++requestSequence}`);
    return new Promise((resolve, reject) => {
      const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        target.postMessage({ protocol_version: PROTOCOL_VERSION, type: 'cancel', request_id: requestId });
        reject(workerError('本地 AI 识别超时', 'clip_worker_timeout'));
      }, timeoutMs);
      pending.set(requestId, {
        resolve,
        reject,
        timer,
        onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
      });
      target.postMessage({
        protocol_version: PROTOCOL_VERSION,
        type,
        request_id: requestId,
        ...payload,
      });
    });
  }

  window.ClipVision = {
    recognize({ image, labels, requestId, onProgress, timeoutMs } = {}) {
      return request('recognize', { image, labels }, { requestId, onProgress, timeoutMs });
    },
    ping(options = {}) {
      return request('ping', {}, { ...options, timeoutMs: options.timeoutMs || 5000 });
    },
    cancel(requestId) {
      if (!worker || !requestId) return;
      const entry = pending.get(String(requestId));
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(String(requestId));
        entry.reject(workerError('识别已取消', 'clip_worker_cancelled'));
      }
      worker.postMessage({ protocol_version: PROTOCOL_VERSION, type: 'cancel', request_id: String(requestId) });
    },
    reset: resetWorker,
  };
})();
