let importQueue = null;
let importStorageWarning = '';

function isWardrobeItemReady(item) {
  return !item.status || item.status === 'available';
}

function importLabel(job) {
  if (!job) return '';
  if (job.phase === 'error') return { preparing: '无法读取照片', cutting: '抠图未完成' }[job.failedPhase] || '信息待补充';
  return (['cutting', 'recognizing'].includes(job.phase) && job.message) || { queued: '等待处理', preparing: '准备照片', cutting: '抠图中', recognizing: '识别衣物信息', saving: '正在保存', sync_error: '已保存本机，待同步' }[job.phase] || '';
}

function wardrobeItemCardHtml(item) {
  const job = importQueue?.get(item.id);
  const processing = job && ['queued', 'preparing', 'cutting', 'recognizing', 'saving'].includes(job.phase);
  const overlay = processing || job?.phase === 'error';
  const spinner = processing && job.phase !== 'queued' ? '<span class="cutout-spinner" aria-hidden="true"></span>' : '';
  const progress = ['cutting', 'recognizing'].includes(job?.phase) ? `<span class="import-progress"><span data-import-progress style="width:${Math.max(0, Math.min(100, job.progress || 0))}%"></span></span>` : '';
  const errorDetail = job?.phase === 'error' ? `<small>${escapeHtml(job.error || '请检查网络后重试')}</small>` : '';
  const actions = job?.phase === 'error'
    ? `<div class="import-actions"><button type="button" data-import-action="retry">重试</button>${job.failedPhase === 'cutting' && !job.useOriginal ? '<button type="button" data-import-action="original">保留原图</button>' : ''}${job.originalPhotoUrl ? '<button type="button" data-import-action="edit">补充信息</button>' : ''}</div>`
    : job?.phase === 'sync_error' ? '<div class="import-actions"><button type="button" data-import-action="retry">同步到衣橱</button></div>' : '';
  const meta = job?.phase === 'error'
    ? '处理未完成，请重试'
    : isWardrobeItemReady(item)
      ? [item.category, item.season, item.occasion].filter(Boolean).join(' · ')
      : '完成后自动保存';
  return `<span class="tag-dot"></span><div class="item-img">${itemMediaHtml(item)}${overlay ? `<div class="import-overlay">${spinner}<span data-import-label>${escapeHtml(importLabel(job))}</span>${progress}${errorDetail}</div>` : ''}</div><div class="item-name">${escapeHtml(item.name || '新衣物')}</div><div class="item-meta">${escapeHtml(meta)}</div>${job?.phase === 'sync_error' ? '<div class="import-local-note">已保存本机，联网后自动同步</div>' : ''}${actions}`;
}

function wardrobeItemRowHtml(item) {
  return `<div class="swipe-row" data-item-id="${escapeHtml(String(item.id))}"><button class="swipe-delete" type="button">删除</button><div class="swipe-content"><article class="item-card" data-id="${escapeHtml(String(item.id))}" aria-busy="${!isWardrobeItemReady(item)}">${wardrobeItemCardHtml(item)}</article></div></div>`;
}

function bindWardrobeRows(root) {
  root.querySelectorAll('.item-card').forEach(card => {
    bindItemCardInteraction(card);
    card.onclick = event => {
      const button = event.target.closest('[data-import-action]');
      if (!button) return;
      event.stopPropagation();
      if (button.dataset.importAction === 'edit') openItemEditor(card.dataset.id);
      else importQueue?.retry(card.dataset.id, button.dataset.importAction === 'original');
    };
  });
  root.querySelectorAll('.swipe-row').forEach(row => bindSwipeRow(row, () => deleteWardrobeItem(row.dataset.itemId)));
}

function renderImportSummary() {
  const summary = document.getElementById('importSummary');
  if (!summary || !importQueue) return;
  const jobs = importQueue.jobs.filter(job => !job.deleted);
  const pending = jobs.filter(job => ['queued', 'preparing', 'cutting', 'recognizing', 'saving'].includes(job.phase)).length;
  const failed = jobs.filter(job => job.phase === 'error' || job.phase === 'sync_error').length;
  summary.hidden = !pending && !failed;
  const status = pending ? `正在导入 ${pending} 件，期间可继续使用其他功能${failed ? ` · ${failed} 件待处理` : ''}` : `${failed} 件衣物待处理，可在卡片上重试或补充信息`;
  summary.textContent = `${status}${importStorageWarning ? `。${importStorageWarning}` : ''}`;
}

function updateWardrobeSummary() {
  const summary = document.getElementById('filterSummary');
  if (!summary) return;
  const count = filteredItems().length;
  const search = state.wardrobeSearch.trim();
  summary.innerHTML = search
    ? `搜索“<b>${escapeHtml(search)}</b>”，共 ${count} 件`
    : `当前：<b>${state.filter === '全部' ? '全部品类' : escapeHtml(state.filter)}</b> / <b>${state.season === '全部' ? '全部季节' : escapeHtml(state.season)}</b> / <b>${state.occasionFilter === '全部' ? '全部场景' : escapeHtml(state.occasionFilter)}</b>，共 ${count} 件`;
}

function onImportChange(job, event) {
  if (job.deleted) return;
  let item = state.items.find(entry => String(entry.id) === job.id);
  const record = job.result || {
    id: job.id, name: '新衣物', category: '', season: '', occasion: '', colors: [], styles: [],
    status: 'processing', originalPhotoUrl: job.originalPhotoUrl || '',
    photoUrl: job.cutoutUrl || job.originalPhotoUrl || job.previewUrl || '', source: job.source,
    keptOriginal: !job.cutoutUrl
  };
  if (!item) {
    item = {};
    const position = state.items.findIndex(entry => {
      const other = importQueue.get(entry.id);
      if (!other) return true;
      const batch = job.batchAt || job.createdAt, otherBatch = other.batchAt || other.createdAt;
      return batch > otherBatch || (batch === otherBatch && (job.order || 0) < (other.order || 0));
    });
    state.items.splice(position < 0 ? state.items.length : position, 0, item);
  }
  Object.assign(item, record, { importId: job.id, importPhase: job.phase });
  if (!job.result) item.status = job.phase === 'error' ? 'needs_details' : 'processing';
  renderImportSummary();
  const box = document.getElementById('wardrobeContent');
  const card = Array.from(box.querySelectorAll('.item-card')).find(card => card.dataset.id === job.id);
  if (card && event === 'progress') {
    const label = card.querySelector('[data-import-label]');
    if (label) label.textContent = job.message || importLabel(job);
    const bar = card.querySelector('[data-import-progress]');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, job.progress || 0))}%`;
  } else if (card) {
    card.innerHTML = wardrobeItemCardHtml(item);
    card.setAttribute('aria-busy', String(!isWardrobeItemReady(item)));
  } else if (filteredItems().includes(item)) {
    const grid = box.querySelector('.grid');
    if (grid) {
      const visible = filteredItems();
      const next = visible.slice(visible.indexOf(item) + 1).map(entry => Array.from(grid.children).find(row => row.dataset.itemId === String(entry.id))).find(Boolean);
      if (next) next.insertAdjacentHTML('beforebegin', wardrobeItemRowHtml(item));
      else grid.insertAdjacentHTML('beforeend', wardrobeItemRowHtml(item));
      bindWardrobeRows(grid);
    } else renderWardrobe();
  }
  updateWardrobeSummary();
  // Never redraw the editor, change pages, or replace unrelated wardrobe cards.
}

async function processWardrobeImport(job, controls) {
  if (!job.originalPhotoUrl) {
    let prepared;
    try { prepared = await prepareImageForAI(job.file); }
    catch (error) { throw new Error('无法读取这张照片，请重试或换成 JPG、PNG、WebP 图片。'); }
    await controls.checkpoint({ file: prepared.file, originalPhotoUrl: prepared.dataUrl });
  }

  // GitHub Pages has no server-side AI endpoint. On phones, downloading the
  // background-removal and CLIP models can fail or take several minutes, which
  // leaves an otherwise usable upload stuck in a processing state. Save the
  // original photo immediately with editable default labels instead. Desktop
  // browsers and deployments with a real API keep the full AI pipeline below.
  const mobileStaticMode = typeof isMobilePerformanceMode !== 'undefined'
    && isMobilePerformanceMode && window.WardrobeAPI?.localOnly;
  if (mobileStaticMode) {
    await controls.checkpoint({
      phase: 'recognizing', failedPhase: 'recognizing', progress: 100,
      message: '手机端快速保存原图，可稍后修改标签'
    });
    const category = '上装';
    const season = '四季';
    const occasion = '日常';
    const color = '灰色';
    const attributes = {
      category,
      subcategory: defaultSubcategory[category] || '其他上装',
      colors: [color],
      pattern: '未知',
      materials: ['未知'],
      fit: '未知',
      length: '未知',
      styles: ['简约'],
      seasons: [season],
      occasions: [occasion],
      warmth: 3,
      formality: 2
    };
    const requestId = `mobile_${job.id}`;
    const recognition = {
      contract_version: '1.0',
      request_id: requestId,
      taxonomy_version: GarmentTaxonomy.version,
      status: 'needs_review',
      model: { provider: 'mobile-fallback', name: 'manual-default', version: '1' },
      attributes,
      field_confidence: Object.fromEntries(Object.keys(attributes).map(field => [field, 0.1])),
      overall_confidence: 0.1,
      review: {
        required: true,
        fields: ['category', 'colors', 'seasons', 'occasions'],
        actions: { category: 'manual_required', colors: 'confirm', seasons: 'confirm', occasions: 'confirm' }
      },
      warnings: ['手机端快速导入，已保留原图并使用默认标签']
    };
    const filename = String(job.photoName || '').replace(/\.[^.]+$/, '').trim();
    return {
      id: job.id,
      name: filename || '新衣物',
      ...attributes,
      attributes,
      season,
      occasion,
      status: 'available',
      visual: visualMap[category] || 'top-cloth',
      photoUrl: job.originalPhotoUrl,
      originalPhotoUrl: job.originalPhotoUrl,
      source: job.source,
      keptOriginal: true,
      recognition,
      recognitionContract: recognition,
      recognitionRunId: '',
      manualFields: ['category', 'color', 'season', 'occasion']
    };
  }

  if (!job.cutoutUrl && !job.useOriginal) {
    await controls.checkpoint({ phase: 'cutting', failedPhase: 'cutting', progress: 0, message: '' });
    const cutoutUrl = await removeBackground(job.file, job.originalPhotoUrl, event => {
      const downloading = String(event.key).startsWith('fetch:');
      controls.report({
        progress: event.total ? Math.round(event.current / event.total * 100) : 0,
        message: downloading ? '正在下载抠图资源，首次使用较慢' : '正在抠图'
      });
    });
    await controls.checkpoint({ cutoutUrl });
  }
  const image = job.cutoutUrl || job.originalPhotoUrl;
  await controls.checkpoint({ phase: 'recognizing', failedPhase: 'recognizing', progress: 0, message: '', recognizeModelProgress: 0, recognizeSource: '', recognizeDownloadedBytes: 0, recognizeDownloadTotal: 0 });
  let raw;
  try {
    raw = await recognizeClothingV1(null, image, job.photoName, {}, message => {
        const details = recognitionProgressDetails({ ...job, recognizeProgress: job.progress }, message);
        controls.report({ requestId: message.request_id || job.requestId, progress: details.progress, message: details.message,
          recognizeModelProgress: details.modelProgress, recognizeSource: details.recognizeSource,
          recognizeDownloadedBytes: details.recognizeDownloadedBytes, recognizeDownloadTotal: details.recognizeDownloadTotal });
    });
  } catch (error) {
    throw new Error(recognitionFailureMessage(error));
  }
  if (!controls.alive()) throw new Error('Import cancelled');
  const color = await analyzeDominantColor(image);
  const recognition = await finalizeVisionRecognition(raw, color, image);
  if (!controls.alive()) throw new Error('Import cancelled');
  if (!recognition.contract?.attributes || !defaultCategories.includes(recognition.category)) throw new Error('未能确定衣物品类，可重试或之后补充信息。');
  const attributes = recognition.contract.attributes;
  return {
    id: job.id, name: generateItemName(recognition),
    ...attributes, attributes, season: recognition.season, occasion: recognition.occasion,
    colors: attributes.colors, styles: attributes.styles, status: 'available',
    visual: visualMap[recognition.category] || 'top-cloth', photoUrl: image,
    originalPhotoUrl: job.originalPhotoUrl, source: job.source, keptOriginal: !job.cutoutUrl,
    recognition: recognition.contract, recognitionContract: recognition.contract,
    recognitionRunId: recognition.runId || '', manualFields: []
  };
}

async function saveImportedWardrobeItem(item) {
  if (!window.WardrobeAPI) throw new Error('衣橱服务暂时不可用');
  const payload = apiItemFromLocal(item);
  let response;
  try { response = await WardrobeAPI.createItem(payload); }
  catch (error) {
    if (error.status !== 409) throw error;
    // A refresh after a successful write may replay this same stable item ID.
    response = await WardrobeAPI.updateItem(item.id, payload);
  }
  if (payload.contract_version === '1.0' && payload.recognition?.attributes && WardrobeAPI.recordCorrection) {
    const fields = ['category', 'subcategory', 'colors', 'pattern', 'materials', 'fit', 'length', 'styles', 'seasons', 'occasions', 'warmth', 'formality'];
    const changed = fields.filter(field => JSON.stringify(payload.attributes[field]) !== JSON.stringify(payload.recognition.attributes[field]));
    if (changed.length) {
      await WardrobeAPI.recordCorrection({
        item_id: String(item.id), request_id: payload.recognition.request_id,
        predicted: payload.recognition.attributes, corrected: payload.attributes, changed_fields: changed
      }).catch(error => console.warn('Recognition correction save failed.', error));
    }
  }
  trackEvent('item_auto_imported', { item_id: String(item.id), source: item.source || '相册' });
  return { ...item, ...localItemFromApi(response.item), importId: item.id };
}

function initWardrobeImports() {
  importQueue = new WardrobeImportQueue({
    scope: window.WardrobeAPI?.userId() || 'local', process: processWardrobeImport,
    save: saveImportedWardrobeItem,
    remove: async id => {
      if (!window.WardrobeAPI) return;
      try { await WardrobeAPI.deleteItem(id); }
      catch (error) { if (error.status !== 404) throw error; }
    },
    cancel: id => window.ClipVision?.cancel(id),
    onChange: onImportChange,
    onWarning: message => { importStorageWarning = message; renderImportSummary(); },
    onComplete: count => toast(`已自动保存 ${count} 件衣物`)
  });
  importQueue.ready.then(async () => {
    // Repair only the unedited default records produced by the previous file mode.
    const unfinished = importQueue.jobs.filter(job => !job.deleted && job.phase === 'done'
      && job.result?.recognition?.model?.provider === 'browser-fallback'
      && !(job.result.manualFields || []).length && job.originalPhotoUrl);
    for (const job of unfinished) {
      Object.assign(job, { phase: 'queued', result: null, useOriginal: false, cutoutUrl: '', progress: 0, error: '', message: '' });
      onImportChange(job, 'changed');
      await importQueue.persist(job);
    }
    renderImportSummary();
    importQueue.start();
    syncWardrobeWithApi();
  });
}

async function handlePhotoFiles(files, source) {
  const images = Array.from(files || []).filter(file => file && file.type.startsWith('image/'));
  if (!images.length) return;
  if (images.length > 12) { toast('一次最多选择 12 张照片'); return; }
  closeAll();
  state.filter = state.season = state.occasionFilter = '全部';
  state.wardrobeSearch = ''; state.wardrobeSearchOpen = false;
  renderTabs(); renderWardrobeSearch(); go('wardrobe');
  document.getElementById('view-wardrobe').scrollTop = 0;
  trackEvent('upload_started', { file_count: images.length, source });
  await importQueue.add(images, source);
  toast(`已添加 ${images.length} 张照片，可继续使用其他功能`);
}
