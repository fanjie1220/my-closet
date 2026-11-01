(function () {
  'use strict';

  const activePhases = new Set(['preparing', 'cutting', 'recognizing', 'saving']);
  const pause = () => new Promise(resolve => setTimeout(resolve, 30));

  // Photos and checkpoints live in IndexedDB, rather than the upload dialog.
  class WardrobeImportQueue {
    constructor(options) {
      this.options = options;
      this.jobs = [];
      this.running = false;
      this.writes = Promise.resolve();
      this.failedWrites = new Set();
      this.ready = this.restore();
      window.addEventListener('online', () => this.retrySync());
    }

    async restore() {
      try {
        this.db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('wardrobe-imports-v1', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'key' });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Import storage is busy'));
        });
        this.db.onversionchange = () => this.db.close();
        const records = await new Promise((resolve, reject) => {
          const request = this.db.transaction('jobs').objectStore('jobs').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        for (const record of records.filter(record => record.scope === this.options.scope)) {
          const job = { ...record };
          if (job.deleted) { this.jobs.push(job); continue; }
          if (activePhases.has(job.phase) || job.phase === 'sync_error') job.phase = 'queued';
          job.requestId = '';
          if (!job.originalPhotoUrl && job.file) job.previewUrl = URL.createObjectURL(job.file);
          this.jobs.push(job);
        }
        this.jobs.sort((a, b) => a.createdAt - b.createdAt);
        this.jobs.forEach(job => { if (!job.deleted) this.notify(job, 'restored'); });
        this.cleanDeleted();
      } catch (error) {
        this.storageWarning(error);
      }
    }

    storageWarning(error) {
      if (this.warned) return;
      this.warned = true;
      console.warn('Import tasks could not be saved on this device.', error);
      this.options.onWarning?.('当前无法保存导入进度，请保持网页打开直到处理完成。');
    }

    persist(job) {
      if (!this.db) return Promise.resolve();
      const { previewUrl, ...record } = job;
      // Capture now, so a delayed write cannot resurrect a deleted checkpoint.
      let snapshot;
      try {
        snapshot = structuredClone({ ...record, scope: this.options.scope, key: `${this.options.scope}:${job.id}` });
      } catch (error) {
        // Failure to save a checkpoint must not stop the in-memory import queue.
        this.failedWrites.add(job.id);
        this.storageWarning(error);
        return Promise.resolve();
      }
      this.writes = this.writes.then(() => new Promise((resolve, reject) => {
        const transaction = this.db.transaction('jobs', 'readwrite');
        transaction.objectStore('jobs').put(snapshot);
        transaction.oncomplete = () => {
          this.failedWrites.delete(job.id);
          if (this.warned && !this.failedWrites.size) { this.warned = false; this.options.onWarning?.(''); }
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })).catch(error => { this.failedWrites.add(job.id); this.storageWarning(error); });
      return this.writes;
    }

    notify(job, event = 'changed') {
      this.options.onChange?.(job, event);
    }

    get(id) {
      return this.jobs.find(job => String(job.id) === String(id));
    }

    async add(files, source) {
      await this.ready;
      const createdAt = Date.now();
      const jobs = files.map((file, index) => ({
        id: `import_${crypto.randomUUID ? crypto.randomUUID() : `${createdAt}_${Math.random().toString(36).slice(2)}`}`,
        file, photoName: file.name || '衣物照片', source,
        createdAt: createdAt + index / 100, batchAt: createdAt, order: index,
        phase: 'queued', progress: 0,
        originalPhotoUrl: '', cutoutUrl: '', previewUrl: URL.createObjectURL(file),
        result: null, error: '', requestId: '', deleted: false
      }));
      this.jobs.push(...jobs);
      jobs.forEach(job => this.notify(job, 'added'));
      await Promise.all(jobs.map(job => this.persist(job)));
      this.start();
      return jobs;
    }

    start() {
      if (this.scheduled || this.running) return;
      this.scheduled = true;
      setTimeout(() => { this.scheduled = false; this.run(); }, 0);
    }

    async run() {
      await this.ready;
      if (this.running) return;
      this.running = true;
      let completed = 0;
      try {
        let job;
        while ((job = this.jobs.find(entry => !entry.deleted && entry.phase === 'queued'))) {
          const revision = job.revision || 0;
          const alive = () => !job.deleted && (job.revision || 0) === revision;
          const checkpoint = async patch => {
            if (!alive()) throw new Error('Import cancelled');
            Object.assign(job, patch);
            this.notify(job);
            await this.persist(job);
            if (!alive()) throw new Error('Import cancelled');
          };
          const report = patch => {
            if (!alive()) return;
            Object.assign(job, patch);
            this.notify(job, 'progress');
          };
          try {
            await checkpoint({ phase: 'preparing', failedPhase: 'preparing', error: '' });
            if (!job.result) {
              const result = await this.options.process(job, { checkpoint, report, alive });
              await checkpoint({ result });
            }
            await checkpoint({ phase: 'saving', progress: 100 });
            const result = await this.options.save(job.result);
            if (!alive()) { await this.cleanDeleted(); continue; }
            await checkpoint({ result, phase: 'done', file: null, requestId: '', error: '' });
            if (job.previewUrl) { URL.revokeObjectURL(job.previewUrl); job.previewUrl = ''; }
            completed++;
          } catch (error) {
            if (alive()) {
              job.phase = job.result ? 'sync_error' : 'error';
              job.error = error.message || '处理未完成，请重试';
              job.requestId = '';
              this.notify(job);
              await this.persist(job);
            }
          }
          await pause();
        }
      } finally {
        this.running = false;
        if (completed) this.options.onComplete?.(completed);
        if (this.jobs.some(job => !job.deleted && job.phase === 'queued')) this.start();
      }
    }

    async retry(id, useOriginal = false) {
      const job = this.get(id);
      if (!job || job.deleted || !['error', 'sync_error'].includes(job.phase)) return;
      if (useOriginal) job.useOriginal = true;
      job.phase = 'queued'; job.error = ''; job.progress = 0;
      this.notify(job);
      await this.persist(job);
      this.start();
    }

    async remember(id, item, { manual = false } = {}) {
      const job = this.get(id);
      if (!job || job.deleted) return;
      job.result = { ...item };
      if (manual) {
        if (job.requestId) this.options.cancel?.(job.requestId);
        job.revision = (job.revision || 0) + 1;
        job.phase = 'queued';
      }
      await this.persist(job);
      this.notify(job);
      if (job.phase === 'queued') this.start();
    }

    async remove(id) {
      const job = this.get(id);
      if (!job || job.deleted) return;
      if (job.requestId) this.options.cancel?.(job.requestId);
      if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
      Object.assign(job, {
        deleted: true, phase: 'deleted', revision: (job.revision || 0) + 1,
        file: null, result: null, previewUrl: '', originalPhotoUrl: '', cutoutUrl: '', requestId: ''
      });
      this.notify(job, 'deleted');
      await this.persist(job);
      await this.cleanDeleted();
    }

    async cleanDeleted() {
      for (const job of this.jobs.filter(job => job.deleted)) {
        try { await this.options.remove?.(job.id); }
        catch (error) { console.warn('Import deletion will be retried.', error); }
      }
    }

    async retrySync() {
      await this.ready;
      for (const job of this.jobs.filter(job => job.phase === 'sync_error')) {
        job.phase = 'queued'; this.notify(job); await this.persist(job);
      }
      this.cleanDeleted();
      this.start();
    }
  }

  window.WardrobeImportQueue = WardrobeImportQueue;
})();
