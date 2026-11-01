(function(){
  const userStorageKey='wardrobe-anonymous-user-id-v1';
  const jsonHeaders={'Content-Type':'application/json'};

  function createUserId(){
    if(window.crypto&&crypto.randomUUID) return `anon_${crypto.randomUUID()}`;
    return `anon_${Date.now()}_${Math.random().toString(36).slice(2,12)}`;
  }

  function getUserId(){
    try{
      let userId=localStorage.getItem(userStorageKey);
      if(!userId){
        userId=createUserId();
        localStorage.setItem(userStorageKey,userId);
      }
      return userId;
    }catch(err){
      if(!window.__wardrobeAnonymousUserId) window.__wardrobeAnonymousUserId=createUserId();
      return window.__wardrobeAnonymousUserId;
    }
  }

  async function request(path,options={}){
    const response=await fetch(path,{
      ...options,
      headers:{
        ...jsonHeaders,
        'X-Wardrobe-User-Id':getUserId(),
        ...(options.headers||{})
      }
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok){
      const error=new Error(payload.error||`API 请求失败：${response.status}`);
      error.status=response.status;
      error.payload=payload;
      throw error;
    }
    return payload;
  }

  window.WardrobeAPI={
    userId:getUserId,
    health:()=>request('/api/health'),
    validateRecognition:payload=>request('/api/ai/recognition/validate',{
      method:'POST',body:JSON.stringify(payload)
    }),
    runVision:payload=>request('/api/ai/recognition/run',{
      method:'POST',body:JSON.stringify(payload)
    }),
    recordCorrection:payload=>request('/api/ai/corrections',{
      method:'POST',body:JSON.stringify(payload)
    }),
    listItems:()=>request('/api/items'),
    createItem:item=>request('/api/items',{method:'POST',body:JSON.stringify(item)}),
    updateItem:(id,changes)=>request(`/api/items/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(changes)}),
    deleteItem:id=>request(`/api/items/${encodeURIComponent(id)}`,{method:'DELETE'}),
    getPreferences:()=>request('/api/preferences'),
    metrics:()=>request('/api/metrics'),
    updatePreferences:preferences=>request('/api/preferences',{method:'PATCH',body:JSON.stringify({preferences})}),
    recommend:(context,variantIndex=0)=>request('/api/recommendations/generate',{
      method:'POST',
      body:JSON.stringify({context,variant_index:variantIndex})
    }),
    track:(eventName,metadata={},sessionId='')=>request('/api/events',{
      method:'POST',
      body:JSON.stringify({event_name:eventName,metadata,session_id:sessionId})
    }),
    feedback:data=>request('/api/feedback',{method:'POST',body:JSON.stringify(data)})
  };

  // GitHub Pages and file:// have no Python API. Keep the same small API
  // surface so the page can work with data stored in this browser.
  const staticMode = location.protocol === 'file:'
    || /(^|\.)github\.io$/i.test(location.hostname || '')
    || document.documentElement.dataset.staticMode === 'true';
  if (staticMode) {
    const itemsKey = 'wardrobe-static-items-v1';
    const preferencesKey = 'wardrobe-static-preferences-v1';
    const memory = { items: [], preferences: {} };
    const read = (key, fallback) => {
      try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; }
      catch { return fallback; }
    };
    const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
    const attrsFromPayload = payload => {
      const attrs = payload && payload.attributes ? payload.attributes : (payload || {});
      return {
        category: attrs.category || '上装', subcategory: attrs.subcategory || GarmentTaxonomy.fields.subcategory.by_category[attrs.category || '上装']?.at(-1) || '',
        colors: Array.isArray(attrs.colors) ? attrs.colors : [], pattern: attrs.pattern || '未知',
        materials: Array.isArray(attrs.materials) ? attrs.materials : ['未知'],
        fit: attrs.fit || '未知', length: attrs.length || '未知',
        seasons: Array.isArray(attrs.seasons) ? attrs.seasons : [],
        styles: Array.isArray(attrs.styles) ? attrs.styles : [],
        occasions: Array.isArray(attrs.occasions) ? attrs.occasions : [],
        warmth: Number(attrs.warmth) || 3, formality: Number(attrs.formality) || 3,
      };
    };
    const rowFromPayload = payload => {
      const attrs = attrsFromPayload(payload);
      return {
        id: String(payload.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        name: String(payload.name || `${attrs.seasons[0] || ''}${attrs.category}`), ...attrs,
        attributes: attrs, status: payload.status || 'available',
        image_url: payload.images?.original_url ?? payload.image_url ?? null,
        cutout_url: payload.images?.cutout_url ?? payload.cutout_url ?? null,
        recognition: payload.recognition || {}, contract_version: '1.0', taxonomy_version: GarmentTaxonomy.version,
        worn_count: Number(payload.worn_count) || 0, last_worn_at: payload.last_worn_at || null,
      };
    };
    const savedItems = read(itemsKey, []);
    const savedPreferences = read(preferencesKey, {});
    memory.items = Array.isArray(savedItems) ? savedItems : [];
    memory.preferences = savedPreferences && typeof savedPreferences === 'object' ? savedPreferences : {};
    const saveItems = () => write(itemsKey, memory.items);
    const localItem = id => memory.items.find(item => String(item.id) === String(id));
    window.WardrobeAPI = {
      localOnly: true,
      fileMode: location.protocol === 'file:',
      userId: () => { try { return localStorage.getItem('wardrobe-static-user-v1') || 'static-local-user'; } catch { return 'static-local-user'; } },
      health: async () => ({ ok: true, mode: 'browser-local' }),
      validateRecognition: async () => ({ valid: true, errors: [], warnings: [] }),
      runVision: async payload => ({ recognition: payload.candidate, run_id: `local_${Date.now()}`, degraded: true }),
      recordCorrection: async () => ({ recorded: true }),
      listItems: async () => ({ items: memory.items.map(item => ({ ...item })) }),
      createItem: async payload => { const row = rowFromPayload(payload); const existing = localItem(row.id); if (existing) { Object.assign(existing, row); } else memory.items.push(row); saveItems(); return { item: { ...row } }; },
      updateItem: async (id, payload) => { const row = rowFromPayload({ ...payload, id }); const existing = localItem(id); if (existing) Object.assign(existing, row); else memory.items.push(row); saveItems(); return { item: { ...row } }; },
      deleteItem: async id => { memory.items = memory.items.filter(item => String(item.id) !== String(id)); saveItems(); return { deleted: true, id }; },
      getPreferences: async () => ({ preferences: { ...memory.preferences } }),
      updatePreferences: async preferences => { memory.preferences = { ...preferences }; write(preferencesKey, memory.preferences); return { preferences: memory.preferences }; },
      metrics: async () => ({ kpis: {}, feedback: {}, recognition: {} }),
      recommend: async () => { throw new Error('静态模式使用浏览器规则推荐'); },
      track: async () => ({ recorded: false, mode: 'browser-local' }),
      feedback: async () => ({ recorded: false, mode: 'browser-local' }),
    };
  }
})();
