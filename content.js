// Content script: injects UI, extracts YouTube captions, orchestrates LLM flow

const CC_NS = 'CCAPTIPREPS';

// Simple state
let modalOpen = false;
let uiRoot = null;
let debugLogOpen = false;
let currentState = {
  videoId: null,
  title: null,
  subtitlesText: null,
  candidates: null,
  selected: null,
  cards: null,
  error: null,
};

// Debug log storage for temporary inspection
let debugLog = {
  subtitlesText: null,
  llm1Response: null,
  llm2Response: null,
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'CC_TOGGLE_MODAL') {
    toggleModal();
  }
});

function toggleModal() {
  if (modalOpen) {
    closeModal();
  } else {
    openModal();
  }
}

function openModal() {
  modalOpen = true;
  if (!uiRoot) createUI();
  uiRoot.style.display = 'block';
  bootFlow();
}

function closeModal() {
  modalOpen = false;
  if (uiRoot) uiRoot.style.display = 'none';
}

function createUI() {
  uiRoot = document.createElement('div');
  uiRoot.id = 'cc-root';
  const style = document.createElement('style');
  style.textContent = getStyles();
  document.documentElement.appendChild(style);

  uiRoot.innerHTML = `
    <div class="cc-overlay" role="dialog" aria-modal="true">
      <div class="cc-modal">
        <div class="cc-header">
          <div class="cc-title">CaptiPrep</div>
          <div class="cc-actions">
            <button class="cc-icon" id="cc-debug-log" title="Debug Log" aria-label="Debug Log">${iconLog()}</button>
            <button class="cc-icon" id="cc-settings" title="Settings" aria-label="Settings">${iconSettings()}</button>
            <button class="cc-icon" id="cc-close" title="Close" aria-label="Close">${iconClose()}</button>
          </div>
        </div>
        <div class="cc-body">
          <div id="cc-step"></div>
          <div id="cc-content"></div>
        </div>
        <div class="cc-footer">
          <button class="cc-btn" id="cc-regenerate" title="Regenerate">Regenerate</button>
          <button class="cc-btn danger" id="cc-delete" title="Delete All">Delete All</button>
          <button class="cc-btn" id="cc-export" title="Export CSV">Export</button>
        </div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(uiRoot);

  uiRoot.querySelector('#cc-close').addEventListener('click', closeModal);
  uiRoot.querySelector('#cc-settings').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CC_OPEN_OPTIONS' }));
  uiRoot.querySelector('#cc-debug-log').addEventListener('click', toggleDebugLog);
  uiRoot.querySelector('#cc-regenerate').addEventListener('click', () => startFlow(true));
  uiRoot.querySelector('#cc-delete').addEventListener('click', deleteAllForThisVideo);
  uiRoot.querySelector('#cc-export').addEventListener('click', exportCSV);
}

function getStyles() {
  return `
    #cc-root { position: fixed; inset: 0; z-index: 2147483647; display:none; }
    .cc-overlay { position: absolute; inset:0; background: rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; }
    .cc-modal { width: min(960px, 96vw); height: min(680px, 92vh); background:#fff; color:#000; border:3px solid #000; box-shadow: 8px 8px #000; display:flex; flex-direction:column; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .cc-debug-overlay { position: absolute; inset:0; background: rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index: 10; }
    .cc-debug-modal { width: min(1200px, 96vw); height: min(800px, 92vh); background:#fff; color:#000; border:3px solid #000; box-shadow: 8px 8px #000; display:flex; flex-direction:column; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .cc-header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:3px solid #000; background: #f5f5f5; }
    .cc-title { font-weight: 800; letter-spacing: 1px; }
    .cc-actions { display:flex; gap:8px; }
    .cc-icon { background:#000; color:#fff; border:2px solid #000; width:32px; height:32px; display:grid; place-items:center; cursor:pointer; }
    .cc-icon:hover { transform: translate(-1px, -1px); box-shadow: 2px 2px #000; }
    .cc-body { flex:1; overflow:auto; padding:12px; background: repeating-linear-gradient(45deg, #fafafa, #fafafa 2px, #f0f0f0 2px, #f0f0f0 4px); }
    .cc-footer { display:flex; gap:8px; padding:10px 12px; border-top:3px solid #000; background:#f5f5f5; }
    .cc-btn { background:#000; color:#fff; border:2px solid #000; padding:8px 12px; cursor:pointer; }
    .cc-btn.danger { background:#fff; color:#000; border-color:#000; }
    .cc-step { font-size:14px; margin-bottom:8px; }
    .cc-progress { display:flex; gap:8px; margin-bottom:12px; }
    .cc-stepchip { padding:6px 8px; border:2px solid #000; background:#fff; }
    .cc-stepchip.active { background:#000; color:#fff; }
    .cc-list { display:grid; grid-template-columns: 1fr auto; gap:8px; align-items:center; }
    .cc-card { border:2px solid #000; padding:12px; background:#fff; margin-bottom:8px; }
    .cc-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:8px; }
    .cc-flex { display:flex; gap:8px; align-items:center; }
    .cc-controls { display:flex; gap:8px; margin:8px 0; align-items:center; }
    .cc-input { padding:6px 8px; border:2px solid #000; }
    .cc-small { color:#333; font-size:12px; }
    .cc-spinner { width: 18px; height: 18px; border: 3px solid #000; border-right-color: transparent; border-radius: 50%; animation: ccspin 0.8s linear infinite; }
    .cc-debug-tabs { display:flex; border-bottom:2px solid #000; }
    .cc-debug-tab { padding:8px 12px; border-right:2px solid #000; background:#f0f0f0; cursor:pointer; }
    .cc-debug-tab.active { background:#000; color:#fff; }
    .cc-debug-content { flex:1; padding:12px; overflow:auto; background:#fafafa; }
    .cc-debug-pre { background:#fff; border:1px solid #ccc; padding:12px; margin:8px 0; white-space:pre-wrap; word-break:break-word; max-height:600px; overflow:auto; font-family:monospace; font-size:12px; }
    @keyframes ccspin { to { transform: rotate(360deg); } }
  `;
}

function iconClose() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12l-4.9 4.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.9a1 1 0 0 0 1.41-1.41L13.41 12l4.9-4.89a1 1 0 0 0-.01-1.4z"/></svg>`;
}
function iconSettings() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M19.14,12.94a7.43,7.43,0,0,0,.05-.94,7.43,7.43,0,0,0-.05-.94l2.11-1.65a.48.48,0,0,0,.12-.61l-2-3.46a.5.5,0,0,0-.6-.22l-2.49,1a7,7,0,0,0-1.63-.94l-.38-2.65A.5.5,0,0,0,13.72,2H10.28a.5.5,0,0,0-.5.42L9.4,5.07a7,7,0,0,0-1.63.94l-2.49-1a.5.5,0,0,0-.6.22l-2,3.46a.5.5,0,0,0,.12.61L5,11.06a7.43,7.43,0,0,0-.05.94,7.43,7.43,0,0,0,.05.94L2.86,14.59a.48.48,0,0,0-.12.61l2,3.46a.5.5,0,0,0,.6.22l2.49-1a7,7,0,0,0,1.63.94l.38,2.65a.5.5,0,0,0,.5.42h3.44a.5.5,0,0,0,.5-.42l.38-2.65a7,7,0,0,0,1.63-.94l2.49,1a.5.5,0,0,0,.6-.22l2-3.46a.5.5,0,0,0,.12-.61ZM12,15.5A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z"/></svg>`;
}

function iconLog() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>`;
}

function toggleDebugLog() {
  if (debugLogOpen) {
    closeDebugLog();
  } else {
    openDebugLog();
  }
}

function openDebugLog() {
  debugLogOpen = true;
  const debugOverlay = document.createElement('div');
  debugOverlay.className = 'cc-debug-overlay';
  debugOverlay.id = 'cc-debug-overlay';
  
  debugOverlay.innerHTML = `
    <div class="cc-debug-modal">
      <div class="cc-header">
        <div class="cc-title">调试日志 - Debug Log</div>
        <div class="cc-actions">
          <button class="cc-icon" id="cc-debug-close" title="关闭" aria-label="关闭">${iconClose()}</button>
        </div>
      </div>
      <div class="cc-debug-tabs">
        <div class="cc-debug-tab active" data-tab="subtitles">字幕内容</div>
        <div class="cc-debug-tab" data-tab="llm1">LLM1响应</div>
        <div class="cc-debug-tab" data-tab="llm2">LLM2响应</div>
      </div>
      <div class="cc-debug-content" id="cc-debug-content">
        ${renderDebugContent('subtitles')}
      </div>
    </div>
  `;
  
  uiRoot.appendChild(debugOverlay);
  
  debugOverlay.querySelector('#cc-debug-close').addEventListener('click', closeDebugLog);
  
  // Tab switching
  debugOverlay.querySelectorAll('.cc-debug-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab');
      debugOverlay.querySelectorAll('.cc-debug-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      debugOverlay.querySelector('#cc-debug-content').innerHTML = renderDebugContent(tabName);
    });
  });
}

function closeDebugLog() {
  debugLogOpen = false;
  const debugOverlay = document.getElementById('cc-debug-overlay');
  if (debugOverlay) {
    debugOverlay.remove();
  }
}

function renderDebugContent(tabName) {
  switch (tabName) {
    case 'subtitles':
      return `
        <div>
          <h3>字幕提取结果</h3>
          <div class="cc-small">长度: ${debugLog.subtitlesText ? debugLog.subtitlesText.length : 0} 字符</div>
          <div class="cc-debug-pre">${escapeHtml(debugLog.subtitlesText || '暂无数据')}</div>
        </div>
      `;
    case 'llm1':
      return `
        <div>
          <h3>LLM1 处理结果 (词汇提取)</h3>
          <div class="cc-small">候选词汇数量: ${debugLog.llm1Response?.items?.length || 0}</div>
          <div class="cc-debug-pre">${escapeHtml(debugLog.llm1Response ? JSON.stringify(debugLog.llm1Response, null, 2) : '暂无数据')}</div>
        </div>
      `;
    case 'llm2':
      return `
        <div>
          <h3>LLM2 处理结果 (卡片生成)</h3>
          <div class="cc-small">生成卡片数量: ${debugLog.llm2Response?.cards?.length || 0}</div>
          <div class="cc-debug-pre">${escapeHtml(debugLog.llm2Response ? JSON.stringify(debugLog.llm2Response, null, 2) : '暂无数据')}</div>
        </div>
      `;
    default:
      return '<div>暂无数据</div>';
  }
}

async function bootFlow() {
  // Load settings to determine onboarding
  const settings = await getSettings();
  if (!settings.apiKey) {
    setStep(['Setup LLM', 'Extract captions', 'Build cards'], 1);
    renderOnboarding();
    return;
  }
  // Load any saved data first
  const { videoId, title } = getYouTubeVideoInfo();
  currentState.videoId = videoId;
  currentState.title = title;
  const saved = await loadVideoData(videoId);
  if (saved && saved.cards && saved.cards.length) {
    currentState.subtitlesText = saved.subtitlesText || null;
    currentState.candidates = saved.candidates || null;
    currentState.selected = saved.selected || null;
    currentState.cards = saved.cards || null;
    // Debug log: 从缓存加载数据
    debugLog.subtitlesText = saved.subtitlesText || null;
    if (saved.candidates) {
      debugLog.llm1Response = { items: saved.candidates };
    }
    if (saved.cards) {
      debugLog.llm2Response = { cards: saved.cards };
    }
    renderLearnView();
    setStep(['Extract captions', 'Filter words', 'Build cards'], 3);
    return;
  }
  // Otherwise start fresh
  startFlow();
}

async function startFlow(forceRegenerate = false) {
  currentState.error = null;
  setStep(['Extract captions', 'Filter words', 'Build cards'], 1);
  renderProgress('Extracting captions…');
  try {
    const { videoId, title } = getYouTubeVideoInfo();
    currentState.videoId = videoId;
    currentState.title = title;
    if (!forceRegenerate) {
      const saved = await loadVideoData(videoId);
      if (saved && saved.cards?.length) {
        currentState = { ...currentState, ...saved };
        // Debug log: 从缓存加载数据
        debugLog.subtitlesText = saved.subtitlesText || null;
        if (saved.candidates) {
          debugLog.llm1Response = { items: saved.candidates };
        }
        if (saved.cards) {
          debugLog.llm2Response = { cards: saved.cards };
        }
        renderLearnView();
        setStep(['Extract captions', 'Filter words', 'Build cards'], 3);
        return;
      }
    }
    const subtitlesText = await extractCaptionsText();
    currentState.subtitlesText = subtitlesText;
    // Debug log: 记录字幕内容
    debugLog.subtitlesText = subtitlesText;
    await saveVideoData(currentState.videoId, { subtitlesText, title });
  } catch (e) {
    currentState.error = String(e?.message || e);
    renderError('Captions error', currentState.error);
    return;
  }

  // LLM #1
  setStep(['Extract captions', 'Filter words', 'Build cards'], 2);
  renderProgress('Filtering words/phrases…');
  try {
    const resp = await llmCall('first', { subtitlesText: currentState.subtitlesText, maxItems: 60 });
    currentState.candidates = resp.items || [];
    // Debug log: 记录LLM1响应
    debugLog.llm1Response = resp;
    await saveVideoData(currentState.videoId, { candidates: currentState.candidates });
  } catch (e) {
    currentState.error = String(e?.message || e);
    renderError('LLM #1 error', currentState.error);
    return;
  }

  // Selection UI
  renderSelection();
}

function setStep(steps, activeIndex) {
  const stepEl = uiRoot.querySelector('#cc-step');
  stepEl.innerHTML = `<div class="cc-progress">${steps.map((s, i) => `<div class="cc-stepchip ${i+1===activeIndex?'active':''}">${s}</div>`).join('')}</div>`;
}

function renderProgress(text) {
  const content = uiRoot.querySelector('#cc-content');
  content.innerHTML = `<div class="cc-card"><div class="cc-flex"><div class="cc-spinner"></div><div>${text}</div></div></div>`;
}

function renderError(title, err) {
  const content = uiRoot.querySelector('#cc-content');
  content.innerHTML = `<div class="cc-card"><div><b>${title}</b></div><pre>${escapeHtml(err)}</pre></div>`;
}

function renderSelection() {
  const content = uiRoot.querySelector('#cc-content');
  const items = currentState.candidates || [];
  const header = `
    <div class="cc-controls">
      <button class="cc-btn" id="cc-sel-all">Select All</button>
      <button class="cc-btn" id="cc-next">Next</button>
    </div>
  `;
  const list = `
    <div class="cc-list" id="cc-cand-list">
      ${items.map((it, idx) => `
        <div class="cc-flex"><input type="checkbox" data-idx="${idx}" ${it.selected? 'checked':''}/> <div><b>${escapeHtml(it.term)}</b> <span class="cc-small">(${escapeHtml(it.type||'word')}, freq ${it.freq ?? '-'})</span></div></div>
        <div class="cc-small"></div>
      `).join('')}
    </div>
  `;
  content.innerHTML = `<div class="cc-card"><div><b>Review and select items</b></div>${header}${list}</div>`;
  content.querySelector('#cc-sel-all').addEventListener('click', () => {
    content.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
  });
  content.querySelector('#cc-next').addEventListener('click', async () => {
    const selected = [];
    content.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.checked) {
        const idx = Number(cb.getAttribute('data-idx'));
        const it = items[idx];
        selected.push({ term: it.term, type: it.type || 'word' });
      }
    });
    currentState.selected = selected;
    await saveVideoData(currentState.videoId, { selected });
    buildCards();
  });
}

async function buildCards() {
  setStep(['Extract captions', 'Filter words', 'Build cards'], 3);
  renderProgress('Generating study cards…');
  try {
    const resp = await llmCall('second', { selected: currentState.selected });
    currentState.cards = resp.cards || [];
    // Debug log: 记录LLM2响应
    debugLog.llm2Response = resp;
    await saveVideoData(currentState.videoId, { cards: currentState.cards });
    renderLearnView();
  } catch (e) {
    currentState.error = String(e?.message || e);
    renderError('LLM #2 error', currentState.error);
  }
}

function renderLearnView() {
  const content = uiRoot.querySelector('#cc-content');
  const cards = currentState.cards || [];
  if (!cards.length) {
    content.innerHTML = '<div class="cc-card">No cards yet.</div>';
    return;
  }
  let idx = 0;
  const renderBig = () => `
    <div class="cc-card">
      <div class="cc-controls">
        <button class="cc-btn" id="cc-prev">Prev</button>
        <div class="cc-small">${idx+1} / ${cards.length}</div>
        <button class="cc-btn" id="cc-nextcard">Next</button>
        <button class="cc-btn" id="cc-togglegrid">Grid</button>
        <button class="cc-btn" id="cc-save">Save</button>
      </div>
      ${renderCardEditor(cards[idx])}
    </div>
  `;
  const renderGrid = () => `
    <div class="cc-grid">
      ${cards.map(c => `<div class="cc-card"><div><b>${escapeHtml(c.term)}</b></div><div class="cc-small">/${escapeHtml(c.ipa||'')}/ · ${escapeHtml(c.pos||'')}</div><div>${escapeHtml(c.definition||'')}</div></div>`).join('')}
    </div>
  `;
  let grid = false;
  const doRender = () => {
    content.innerHTML = grid ? renderGrid() : renderBig();
    if (!grid) {
      content.querySelector('#cc-prev').addEventListener('click', () => { idx = (idx - 1 + cards.length) % cards.length; doRender(); });
      content.querySelector('#cc-nextcard').addEventListener('click', () => { idx = (idx + 1) % cards.length; doRender(); });
      content.querySelector('#cc-togglegrid').addEventListener('click', () => { grid = true; doRender(); });
      content.querySelector('#cc-save').addEventListener('click', async () => {
        const edited = readCardEditor();
        cards[idx] = edited;
        await saveVideoData(currentState.videoId, { cards });
      });
    } else {
      // In grid mode, clicking card toggles back to big view at that index
      Array.from(content.querySelectorAll('.cc-card')).forEach((el, i) => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => { idx = i; grid = false; doRender(); });
      });
    }
  };
  doRender();
}

function renderCardEditor(card) {
  const c = { term: '', ipa: '', pos: '', definition: '', examples: [], notes: '', ...card };
  return `
    <div class="cc-flex"><label style="width:80px">Term</label><input class="cc-input" id="cc-term" value="${escapeAttr(c.term)}"/></div>
    <div class="cc-flex"><label style="width:80px">IPA</label><input class="cc-input" id="cc-ipa" value="${escapeAttr(c.ipa)}"/></div>
    <div class="cc-flex"><label style="width:80px">POS</label><input class="cc-input" id="cc-pos" value="${escapeAttr(c.pos)}"/></div>
    <div class="cc-flex"><label style="width:80px">Definition</label><input class="cc-input" id="cc-def" value="${escapeAttr(c.definition)}"/></div>
    <div class="cc-flex"><label style="width:80px">Examples</label><textarea class="cc-input" id="cc-ex" rows="3">${escapeHtml((c.examples||[]).join('\n'))}</textarea></div>
    <div class="cc-flex"><label style="width:80px">Notes</label><textarea class="cc-input" id="cc-notes" rows="2">${escapeHtml(c.notes||'')}</textarea></div>
  `;
}

function readCardEditor() {
  const term = document.getElementById('cc-term').value.trim();
  const ipa = document.getElementById('cc-ipa').value.trim();
  const pos = document.getElementById('cc-pos').value.trim();
  const definition = document.getElementById('cc-def').value.trim();
  const examples = document.getElementById('cc-ex').value.split('\n').map(s => s.trim()).filter(Boolean);
  const notes = document.getElementById('cc-notes').value.trim();
  return { term, ipa, pos, definition, examples, notes };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
function escapeAttr(s) {
  return String(s).replace(/["&<>]/g, c => ({'"':'&quot;','&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

async function deleteAllForThisVideo() {
  if (!currentState.videoId) return;
  await saveVideoData(currentState.videoId, { subtitlesText: null, candidates: null, selected: null, cards: null, title: currentState.title });
  currentState = { ...currentState, subtitlesText: null, candidates: null, selected: null, cards: null };
  // Debug log: 清空调试数据
  debugLog = {
    subtitlesText: null,
    llm1Response: null,
    llm2Response: null,
  };
  startFlow(true);
}

async function exportCSV() {
  const cards = currentState.cards || [];
  if (!cards.length) return;
  const rows = [['term', 'ipa', 'pos', 'definition', 'notes']]
    .concat(cards.map(c => [c.term||'', c.ipa||'', c.pos||'', c.definition||'', c.notes||'']))
    .map(r => r.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(','))
    .join('\r\n');
  const csv = '\ufeff' + rows; // BOM for Excel
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeTitle = (currentState.title || 'export').replace(/[\\/:*?"<>|]/g, '_');
  a.download = safeTitle + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadVideoData(videoId) {
  const key = `${CC_NS}:video:${videoId}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function saveVideoData(videoId, patch) {
  const key = `${CC_NS}:video:${videoId}`;
  const current = await loadVideoData(videoId) || {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [key]: next });
}

function getYouTubeVideoInfo() {
  const url = new URL(location.href);
  let v = url.searchParams.get('v');
  if (!v) {
    // youtu.be/ID form or shorts
    const paths = location.pathname.split('/').filter(Boolean);
    if (paths[0] === 'shorts' && paths[1]) v = paths[1];
    if (!v && location.host.includes('youtu.be')) v = paths[0];
  }
  const titleEl = document.querySelector('h1.title, h1#title, h1');
  const title = titleEl ? titleEl.textContent.trim() : document.title.replace(' - YouTube', '').trim();
  return { videoId: v, title };
}

// InnerTube POST via page main-world proxy
function ytApiPostMainWorld(endpoint, payload, opts = {}) {
  return new Promise((resolve) => {
    const id = 'yt_' + Math.random().toString(36).slice(2);
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_YT_API_RESULT' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve({ ok: !!d.ok, status: d.status || 0, contentType: d.contentType || '', json: d.json || null, text: d.text || '', error: d.error });
    };
    window.addEventListener('message', onMsg);
    try {
      window.postMessage({ type: 'CC_YT_API', id, endpoint, payload, apiKey: opts.apiKey, clientVersion: opts.clientVersion }, location.origin);
    } catch (e) {
      window.removeEventListener('message', onMsg);
      resolve({ ok: false, status: 0, contentType: '', json: null, text: '', error: String(e) });
    }
    setTimeout(() => {
      try { window.removeEventListener('message', onMsg); } catch {}
      resolve({ ok: false, status: 0, contentType: '', json: null, text: '', error: 'timeout' });
    }, 10000);
  });
}

function generateVisitorDataLite() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' ;
  let result = '';
  for (let i = 0; i < 11; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function generateSessionDataLite() {
  // Lean session: let page_inject.js fill clientVersion/visitorData from ytcfg/PR
  return {
    context: {
      client: {
        hl: 'en', gl: 'US',
        clientName: 'WEB',
      },
      user: { enableSafetyMode: false },
      request: { useSsl: true },
    },
  };
}

function extractTranscriptTokenFromNext(nextData) {
  const panels = nextData?.engagementPanels;
  if (!Array.isArray(panels)) return null;
  const panel = panels.find(p => p?.engagementPanelSectionListRenderer?.panelIdentifier === 'engagement-panel-searchable-transcript');
  if (!panel) return null;
  const content = panel.engagementPanelSectionListRenderer?.content;
  let token = content?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
    || content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params;
  if (!token && content?.sectionListRenderer?.contents?.[0]?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
    token = content.sectionListRenderer.contents[0].continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  }
  if (!token && content?.sectionListRenderer?.contents) {
    for (const item of content.sectionListRenderer.contents) {
      const menu = item?.transcriptRenderer?.footer?.transcriptFooterRenderer?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems;
      if (Array.isArray(menu) && menu.length) {
        const englishItem = menu.find(i => i?.title?.toLowerCase?.().includes('english') || i?.selected) || menu[0];
        token = englishItem?.continuation?.reloadContinuationData?.continuation;
        if (token) break;
      }
    }
  }
  return token || null;
}

function transcriptSegmentsToLines(transcriptData) {
  const segments = transcriptData?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
  if (!Array.isArray(segments)) return [];
  const lines = [];
  for (const seg of segments) {
    const r = seg?.transcriptSegmentRenderer;
    if (!r) continue;
    let text = '';
    if (r.snippet?.simpleText) text = r.snippet.simpleText;
    else if (Array.isArray(r.snippet?.runs)) text = r.snippet.runs.map(x => x.text).join('');
    else if (r.snippet?.text) text = r.snippet.text;
    text = String(text).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
  }
  return lines;
}

// ===== Quality improvements: logging + URL helpers =====
const CC_DEBUG = false; // Flip to true locally to see detailed logs
function dlog(...args) { if (CC_DEBUG) console.log(...args); }

function appendParam(url, key, value) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has(key)) u.searchParams.append(key, value);
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    if (url.includes(`${key}=`)) return url;
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

function buildUrlWithFmt(base, fmt) {
  if (!base) return '';
  return appendParam(base, 'fmt', fmt);
}

function isJsonLike(ct) {
  const c = (ct || '').toLowerCase();
  return c.includes('application/json') || c.includes('+json');
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchAndExtract(url) {
  const res = await fetchCaptionMainWorld(url);
  dlog('[CC] fetchAndExtract:', url, 'status:', res.status, 'ct:', res.contentType);
  if (!res.ok) return '';
  const ct = res.contentType || '';
  if (isJsonLike(ct)) {
    const data = safeJsonParse(res.text || '');
    const text = data ? captionsJsonToText(data) : '';
    return text || '';
  } else {
    const raw = res.text || '';
    const data = safeJsonParse(raw);
    if (data) {
      const text = captionsJsonToText(data);
      return text || '';
    }
    const vttText = captionsVttToText(raw);
    return vttText || '';
  }
}
// ===== End quality helpers =====

async function tryTranscriptViaPage(videoId) {
  try {
    await ensureInjectorLoaded();
    const session = generateSessionDataLite();
    // Directly call /next to get engagement panels
    const nextRes = await ytApiPostMainWorld('/next', { ...session, videoId });
    if (!nextRes.ok) return '';
    const nextData = nextRes.json || null;
    const token = extractTranscriptTokenFromNext(nextData);
    if (!token) return '';
    const trRes = await ytApiPostMainWorld('/get_transcript', { ...session, params: token });
    if (!trRes.ok) return '';
    const lines = transcriptSegmentsToLines(trRes.json || {});
    const text = lines.join('\n').trim();
    return text || '';
  } catch {
    return '';
  }
}

async function extractCaptionsText() {
  dlog('[CC] Starting caption extraction...');

  // Ensure our page injector is ready for all page-context fetches
  await ensureInjectorLoaded();

  // Try page-context InnerTube transcript API via injected proxy first
  try {
    const { videoId } = getYouTubeVideoInfo();
    if (videoId) {
      const txt = await tryTranscriptViaPage(videoId);
      if (txt && txt.trim()) {
        dlog('[CC] Got transcript via page InnerTube path, length:', txt.length);
        return txt;
      }
    }
  } catch (e) {
    dlog('[CC] Page InnerTube path failed:', (e && e.message) || e);
  }
  
  // Then try robust main-world player response + direct track fetch
  try {
    dlog('[CC] Attempting to get player response from main world...');
    const injected = await getPlayerResponseMainWorld();
    dlog('[CC] Player response received:', !!injected, injected ? Object.keys(injected) : 'null');
    
    let tracks = injected?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    dlog('[CC] Caption tracks found:', tracks.length, tracks.map(t => ({ lang: t.languageCode, kind: t.kind })));
    
    const isEnglish = (t) => (t.languageCode || '').toLowerCase().startsWith('en');
    const nonAsr = tracks.filter(t => isEnglish(t) && !t.kind);
    const asr = tracks.filter(t => isEnglish(t) && t.kind === 'asr');
    const pick = nonAsr[0] || asr[0];
    
    dlog('[CC] Filtered tracks - nonAsr:', nonAsr.length, 'asr:', asr.length, 'picked:', !!pick);
    
    if (pick && pick.baseUrl) {
      dlog('[CC] Using baseUrl:', pick.baseUrl);
      const base = pick.baseUrl;
      const json3Url = buildUrlWithFmt(base, 'json3');
      const srv3Url = buildUrlWithFmt(base, 'srv3');

      // Try json3 first
      try {
        const text = await fetchAndExtract(json3Url);
        dlog('[CC] json3 extracted length:', text.length);
        if (text.trim()) return text;
      } catch (e) {
        dlog('[CC] json3 fetchAndExtract failed:', e?.message || e);
      }

      // Try legacy srv3
      try {
        const text = await fetchAndExtract(srv3Url);
        dlog('[CC] srv3 extracted length:', text.length);
        if (text.trim()) return text;
      } catch (e) {
        dlog('[CC] srv3 fetchAndExtract failed:', e?.message || e);
      }

      // VTT fallback
      try {
        const vttUrl = buildUrlWithFmt(base, 'vtt');
        const text = await fetchAndExtract(vttUrl);
        dlog('[CC] vtt extracted length:', text.length);
        if (text.trim()) return text;
      } catch (e) {
        dlog('[CC] vtt fetchAndExtract failed:', e?.message || e);
      }
    }

    // No direct English track; try translating available tracks to English via tlang=en
    if (!pick && tracks.length) {
      dlog('[CC] No English track; attempting translation via tlang=en');
      for (const t of tracks) {
        if (!t.baseUrl) continue;
        const baseT = appendParam(t.baseUrl, 'tlang', 'en');
        const json3Url = buildUrlWithFmt(baseT, 'json3');
        const vttUrl = buildUrlWithFmt(baseT, 'vtt');
        try {
          const text = await fetchAndExtract(json3Url);
          if (text.trim()) return text;
        } catch (e) {
          dlog('[CC] Translated json3 failed:', e?.message || e);
        }
        try {
          const text2 = await fetchAndExtract(vttUrl);
          if (text2.trim()) return text2;
        } catch (e2) {
          dlog('[CC] Translated vtt failed:', e2?.message || e2);
        }
      }
    }
  } catch (e) {
    dlog('[CC] Player response method failed:', e.message);
    // continue to fallback
  }
  
  // Fallback timedtext endpoints
  dlog('[CC] Trying fallback timedtext endpoints...');
  const { videoId } = getYouTubeVideoInfo();
  dlog('[CC] Video ID:', videoId);
  
  if (!videoId) {
    throw new Error('Could not determine video ID from current page');
  }
  
  const tries = [
    `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}&fmt=json3`,
    `https://www.youtube.com/api/timedtext?lang=en&kind=asr&v=${encodeURIComponent(videoId)}&fmt=json3`,
    `https://www.youtube.com/api/timedtext?lang=en-US&v=${encodeURIComponent(videoId)}&fmt=json3`,
    `https://www.youtube.com/api/timedtext?lang=en-GB&v=${encodeURIComponent(videoId)}&fmt=json3`,
    `https://www.youtube.com/api/timedtext?tlang=en&v=${encodeURIComponent(videoId)}&fmt=json3`,
    `https://www.youtube.com/api/timedtext?tlang=en&v=${encodeURIComponent(videoId)}&fmt=vtt`,
    `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}&fmt=vtt`,
    `https://www.youtube.com/api/timedtext?lang=en&kind=asr&v=${encodeURIComponent(videoId)}&fmt=vtt`,
  ];
  
  for (const url of tries) {
    try {
      const text = await fetchAndExtract(url);
      dlog('[CC] Fallback extracted length:', text.length, 'for', url);
      if (text && text.trim()) return text;
    } catch (e) {
      dlog('[CC] Fallback URL failed:', url, e?.message || e);
    }
  }
  
  dlog('[CC] All caption extraction methods failed');
  throw new Error('No available English captions for this video.');
}

// Fetch caption via page main-world proxy installed by page_inject.js
function fetchCaptionMainWorld(url) {
  return new Promise((resolve) => {
    const id = 'f_' + Math.random().toString(36).slice(2);
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_FETCH_CAPTION_RESULT' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve({ ok: !!d.ok, status: d.status || 0, contentType: d.contentType || '', text: d.text || '', error: d.error });
    };
    window.addEventListener('message', onMsg);
    // Ensure injector is present (getPlayerResponseMainWorld injects it when called earlier)
    try { window.postMessage({ type: 'CC_FETCH_CAPTION', id, url }, location.origin); } catch (e) {
      window.removeEventListener('message', onMsg);
      resolve({ ok: false, status: 0, contentType: '', text: '', error: String(e) });
    }
    // Timeout safeguard
    setTimeout(() => {
      try { window.removeEventListener('message', onMsg); } catch {}
      resolve({ ok: false, status: 0, contentType: '', text: '', error: 'timeout' });
    }, 10000);
  });
}

function captionsJsonToText(json) {
  // json3/srv3 has events[].segs[].utf8
  if (!json || !Array.isArray(json.events)) return '';
  const parts = [];
  for (const ev of json.events) {
    if (!ev.segs) continue;
    const line = ev.segs.map(s => s.utf8).join('').replace(/\s+/g, ' ').trim();
    if (line) parts.push(line);
  }
  return parts.join('\n');
}

function captionsVttToText(vtt) {
  if (!vtt) return '';
  // Remove WEBVTT header and notes
  const lines = String(vtt)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  const out = [];
  let buf = [];
  const flush = () => {
    const s = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flush(); continue; }
    if (i === 0 && /^WEBVTT/i.test(line)) continue;
    if (/^NOTE(\s|$)/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // cue number
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+--\>/.test(line) || /^\d{2}:\d{2}\.\d{3}\s+--\>/.test(line)) {
      // time line, ignore
      continue;
    }
    // Strip HTML tags that sometimes appear in VTT
    const text = line.replace(/<[^>]+>/g, '').trim();
    if (text) buf.push(text);
  }
  flush();
  return out.join('\n');
}

function getPlayerResponseMainWorld() {
  return new Promise((resolve) => {
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_PLAYER_RESPONSE') return;
      window.removeEventListener('message', onMsg);
      resolve(d.payload || null);
    };
    window.addEventListener('message', onMsg);
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('page_inject.js');
    (document.head || document.documentElement).appendChild(s);
    s.addEventListener('load', () => setTimeout(() => s.remove(), 0));
  });
}

async function llmCall(role, data) {
  const resp = await chrome.runtime.sendMessage({ type: 'CC_LLM_CALL', payload: { role, data } });
  if (!resp || !resp.ok) throw new Error(resp && resp.error || 'Unknown error');
  return resp.result;
}

async function getSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'CC_GET_SETTINGS' });
  if (!resp || !resp.ok) return {};
  return resp.settings || {};
}

function renderOnboarding() {
  const content = uiRoot.querySelector('#cc-content');
  content.innerHTML = `
    <div class="cc-card">
      <div><b>First-time setup required</b></div>
      <p class="cc-small">Please configure your LLM provider, model, API key, and accent before generating cards.</p>
      <div class="cc-controls">
        <button class="cc-btn" id="cc-open-settings">Open Settings</button>
        <button class="cc-btn" id="cc-continue">I have configured</button>
      </div>
    </div>
  `;
  content.querySelector('#cc-open-settings').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CC_OPEN_OPTIONS' }));
  content.querySelector('#cc-continue').addEventListener('click', async () => {
    const s = await getSettings();
    if (!s.apiKey) {
      alert('API key is still missing. Please save settings.');
      return;
    }
    startFlow(true);
  });
}

let __cc_injectorReady = null;
function ensureInjectorLoaded() {
  if (__cc_injectorReady) return __cc_injectorReady;
  __cc_injectorReady = new Promise((resolve) => {
    try {
      // If our injector already present (cheap heuristic), resolve fast
      // We cannot directly detect from content, so just inject once; onload will fire only once
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('page_inject.js');
      s.addEventListener('load', () => resolve(true));
      (document.head || document.documentElement).appendChild(s);
      // Fallback resolve to avoid hanging if onload suppressed
      setTimeout(() => resolve(true), 300);
    } catch {
      resolve(true);
    }
  });
  return __cc_injectorReady;
}
