(function () {
  const PROTOCOL_VERSION = '1.0';
  const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;
  const DEFAULT_STALL_TIMEOUT_MS = 90 * 1000;
  let worker = null;
  let preloadPromise = null;
  let requestSequence = 0;
  const pending = new Map();

  function workerError(message, code = 'clip_worker_unavailable', autoRetry = true) {
    const error = new Error(message);
    error.code = code;
    error.retryable = true;
    error.autoRetry = autoRetry;
    return error;
  }

  function clearRequestTimers(entry) {
    clearTimeout(entry.timer);
    clearTimeout(entry.stallTimer);
  }

  function rejectAll(error) {
    for (const entry of pending.values()) {
      clearRequestTimers(entry);
      entry.reject(error);
    }
    pending.clear();
  }

  function resetWorker(reason = 'CLIP Worker 已重置', code = 'clip_worker_unavailable', autoRetry = true) {
    const previous = worker;
    worker = null;
    preloadPromise = null;
    if (previous) previous.terminate();
    rejectAll(workerError(reason, code, autoRetry));
  }

  function expireRequest(entry, reason, code) {
    if (pending.get(entry.requestId) !== entry || worker !== entry.target) return;
    const activeRecognition = [...pending.values()].some(other =>
      other.type === 'recognize' && other.target === entry.target);
    if (entry.type === 'recognize' || (entry.type === 'preload' && !activeRecognition)) {
      // A cancel message cannot interrupt a hung model download or WASM load.
      resetWorker(reason, code, false);
    } else {
      clearRequestTimers(entry);
      pending.delete(entry.requestId);
      entry.reject(workerError(reason, code, false));
    }
  }

  function armStallTimer(entry) {
    clearTimeout(entry.stallTimer);
    entry.stallTimer = setTimeout(() => {
      expireRequest(entry, '模型加载或识别长时间没有进展，请检查网络后重试', 'clip_worker_stalled');
    }, entry.stallTimeoutMs);
  }

  function noteProgress(entry, message) {
    if (entry.type !== 'recognize' && entry.type !== 'preload') return;
    // The pipeline may spend minutes on a phone CPU without progress events.
    if (message.stage === 'inference') {
      entry.inferenceStarted = true;
      clearTimeout(entry.stallTimer);
      return;
    }
    if (entry.inferenceStarted) return;
    const values = ['stage', 'source', 'file', 'loaded', 'total', 'percent', 'status']
      .map(key => message[key] ?? null);
    // Empty heartbeats and repeated progress must not keep a stalled job alive.
    if (message.type !== 'ready' && !values.some(value => value !== null && value !== '')) return;
    const fingerprint = JSON.stringify([message.type, ...values]);
    if (fingerprint === entry.progressFingerprint) return;
    entry.progressFingerprint = fingerprint;
    armStallTimer(entry);
  }

  function positiveTimeout(value, fallback) {
    const timeout = Number(value);
    return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
  }

  function ensureWorker() {
    if (worker) return worker;
    if (!window.Worker) throw workerError('当前浏览器不支持本地 AI Worker', 'worker_not_supported');
    let target;
    if (location.protocol === 'file:') {
      if (!window.ClipVisionWorkerSource) throw workerError('衣物识别程序未加载，请刷新页面后重试');
      const sourceUrl = URL.createObjectURL(new Blob([window.ClipVisionWorkerSource], { type: 'text/javascript' }));
      try { target = new Worker(sourceUrl); }
      finally { URL.revokeObjectURL(sourceUrl); }
    } else {
      target = new Worker('clip-vision-worker.js?v=clip-preload-q8-20261102', { type: 'module' });
    }
    worker = target;
    target.onmessage = (event) => {
      if (worker !== target) return;
      const message = event.data || {};
      if (message.protocol_version !== PROTOCOL_VERSION) return;
      const requestId = String(message.request_id || '');
      const entry = pending.get(requestId);
      if (!entry || entry.target !== target) return;
      if (message.type === 'progress' || message.type === 'ready') {
        noteProgress(entry, message);
        if (entry.onProgress) entry.onProgress(message);
        return;
      }
      if (!['result', 'pong', 'error'].includes(message.type)) return;
      clearRequestTimers(entry);
      pending.delete(requestId);
      if (message.type === 'result' || message.type === 'pong') {
        entry.resolve(message);
        return;
      }
      if (message.type === 'error') {
        const detail = message.error || {};
        const error = workerError(detail.message || '本地 AI 识别失败', detail.code || 'clip_worker_failed',
          detail.auto_retry !== false && message.auto_retry !== false);
        error.retryable = detail.retryable !== false;
        error.stage = message.stage || '';
        entry.reject(error);
      }
    };
    target.onerror = () => {
      if (worker === target) resetWorker('本地 AI Worker 加载失败');
    };
    target.onmessageerror = () => {
      if (worker === target) resetWorker('本地 AI Worker 消息解析失败');
    };
    return target;
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
      const entry = {
        requestId,
        type,
        target,
        resolve,
        reject,
        stallTimeoutMs: positiveTimeout(options.stallTimeoutMs, DEFAULT_STALL_TIMEOUT_MS),
        progressFingerprint: '',
        onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
      };
      entry.timer = setTimeout(() => {
        expireRequest(entry, '本地 AI 识别超时', 'clip_worker_timeout');
      }, positiveTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS));
      pending.set(requestId, entry);
      if (type === 'recognize' || type === 'preload') armStallTimer(entry);
      try {
        target.postMessage({
          protocol_version: PROTOCOL_VERSION,
          type,
          request_id: requestId,
          ...payload,
        });
      } catch (error) {
        clearRequestTimers(entry);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  window.ClipVision = {
    preload(options = {}) {
      if (!preloadPromise) {
        const attempt = request('preload', {}, options);
        preloadPromise = attempt;
        // A failed background attempt must allow the next upload to try again.
        attempt.catch(() => {
          if (preloadPromise === attempt) preloadPromise = null;
        });
      }
      return preloadPromise;
    },
    recognize({ image, labels, requestId, onProgress, timeoutMs, stallTimeoutMs } = {}) {
      return request('recognize', { image, labels }, { requestId, onProgress, timeoutMs, stallTimeoutMs });
    },
    ping(options = {}) {
      return request('ping', {}, { ...options, timeoutMs: options.timeoutMs || 5000 });
    },
    cancel(requestId) {
      if (!worker || !requestId) return;
      const id = String(requestId);
      const entry = pending.get(id);
      if (!entry) return;
      if (entry.type === 'recognize') resetWorker('识别已取消', 'clip_worker_cancelled', false);
      else {
        clearRequestTimers(entry);
        pending.delete(id);
        entry.reject(workerError('请求已取消', 'clip_worker_cancelled', false));
      }
    },
    reset: resetWorker,
  };
})();
