// UI script: handles DOM, user interactions, and rendering. Uses backend via global CaptiPrep.backend

// Backend facade
const B = (globalThis.CaptiPrep && globalThis.CaptiPrep.backend) || {};

// Simple UI state
let modalOpen = false;
let uiRoot = null;
let currentState = {
  videoId: null,
  title: null,
  subtitlesText: null,
  candidates: null,
  selected: null,
  cards: null,
  error: null,
};

// 全局 UI 状态
let ccGridMode = false; // 是否网格视图
let ccEditMode = false; // 是否编辑模式（大卡片）
let currentCardIndex = 0; // 当前卡索引
// 记录由插件暂停的 video 元素，便于关闭面板时恢复播放
let __ccPausedVideos = new Set();

// 入口消息（负责 UI 开关）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'CC_TOGGLE_MODAL') toggleModal();
});

function toggleModal() {
  if (modalOpen) closeModal(); else openModal();
}

async function openModal() {
  modalOpen = true;
  if (!uiRoot) await createUI();
  uiRoot.style.display = 'block';
  pauseActiveVideo();
  bootFlow();
}

function closeModal() {
  modalOpen = false;
  if (uiRoot) uiRoot.style.display = 'none';
  resumePausedVideos();
}

async function createUI() {
  uiRoot = document.createElement('div');
  uiRoot.id = 'cc-root';

  // 注入独立样式
  try {
    const href = chrome.runtime.getURL('assets/cc.css');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.documentElement.appendChild(link);
  } catch {
    try {
      const cssUrl = chrome.runtime.getURL('assets/cc.css');
      const cssText = await fetch(cssUrl).then(r => r.text());
      const style = document.createElement('style');
      style.textContent = cssText;
      document.documentElement.appendChild(style);
    } catch {}
  }

  // 加载 UI 模板
  try {
    const htmlUrl = chrome.runtime.getURL('assets/ui.html');
    const html = await fetch(htmlUrl).then(r => r.text());
    uiRoot.innerHTML = html;
  } catch {
    uiRoot.innerHTML = '<div class="cc-overlay"><div class="cc-modal"><div class="cc-body"><div id="cc-step"></div><div id="cc-content">Failed to load UI</div></div></div></div>';
  }

  document.documentElement.appendChild(uiRoot);

  // 标题左侧添加品牌图标（避免重复插入）
  try {
    const titleEl = uiRoot.querySelector('.cc-title');
    if (titleEl && !titleEl.querySelector('.cc-brand-icon')) {
      const iconUrl = chrome.runtime.getURL('icon.png');
      const span = document.createElement('span');
      span.className = 'cc-brand-icon';
      span.style.backgroundImage = `url(${iconUrl})`;
      span.setAttribute('aria-hidden', 'true');
      // 将图标放在标题文字左侧
      titleEl.insertBefore(span, titleEl.firstChild);
    }
  } catch {}
  
  // 按钮事件
  uiRoot.querySelector('#cc-close')?.addEventListener('click', closeModal);
  uiRoot.querySelector('#cc-settings')?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CC_OPEN_OPTIONS' }));
  uiRoot.querySelector('#cc-regenerate')?.addEventListener('click', () => startFlow(true));
  uiRoot.querySelector('#cc-export')?.addEventListener('click', exportCSV);
  uiRoot.querySelector('#cc-toggleview')?.addEventListener('click', () => {
    ccGridMode = !ccGridMode;
    ccEditMode = false;
    if (currentState.cards && currentState.cards.length) renderLearnView();
    updateViewToggleButton();
    updateBottomControls();
  });
  // 新增：单词本入口
  uiRoot.querySelector('#cc-wordbook')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CC_OPEN_WORDBOOK' });
  });

  // 底部控制条
  uiRoot.querySelector('#cc-b-prev')?.addEventListener('click', () => {
    const cards = currentState.cards || [];
    if (!cards.length || ccGridMode) return;
    currentCardIndex = (currentCardIndex - 1 + cards.length) % cards.length;
    ccEditMode = false;
    renderLearnView();
  });
  uiRoot.querySelector('#cc-b-next')?.addEventListener('click', () => {
    const cards = currentState.cards || [];
    if (!cards.length || ccGridMode) return;
    currentCardIndex = (currentCardIndex + 1) % cards.length;
    ccEditMode = false;
    renderLearnView();
  });
  uiRoot.querySelector('#cc-b-edit')?.addEventListener('click', () => {
    if (ccGridMode || !(currentState.cards || []).length) return;
    ccEditMode = !ccEditMode;
    renderLearnView();
  });
  uiRoot.querySelector('#cc-b-save')?.addEventListener('click', async () => {
    if (ccGridMode || !ccEditMode) return;
    const cards = currentState.cards || [];
    if (!cards.length) return;
    const edited = readCardEditor();
    cards[currentCardIndex] = edited;
    await B.saveVideoData(currentState.videoId, { cards });
    ccEditMode = false;
    renderLearnView();
  });
  // 新增：收藏当前词卡（快照）
  uiRoot.querySelector('#cc-b-fav')?.addEventListener('click', async () => {
    const cards = currentState.cards || [];
    if (!cards.length || ccGridMode) return;
    const card = cards[currentCardIndex];
    try {
      await addFavoriteWordSnapshot({
        videoId: currentState.videoId,
        title: currentState.title,
        cardIndex: currentCardIndex,
        snapshot: card
      });
      // 简易反馈
      const btn = uiRoot.querySelector('#cc-b-fav');
      if (btn) {
        btn.classList.add('cc-ok');
        setTimeout(() => btn.classList.remove('cc-ok'), 600);
      }
    } catch (e) {
      console.warn('favorite failed', e);
    }
  });

  // 键盘快捷：左右箭头
  document.addEventListener('keydown', onCcKeydown, true);
}

function onCcKeydown(e) {
  if (!modalOpen) return;
  const k = e.key;
  if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  const t = e.target;
  const tag = (t && t.tagName ? t.tagName.toLowerCase() : '');
  const isEditable = (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable));
  if (isEditable) return;
  const cards = currentState.cards || [];
  if (!cards.length || ccGridMode) return;
  e.preventDefault();
  e.stopPropagation();
  if (k === 'ArrowLeft') currentCardIndex = (currentCardIndex - 1 + cards.length) % cards.length;
  else currentCardIndex = (currentCardIndex + 1) % cards.length;
  ccEditMode = false;
  renderLearnView();
}

async function bootFlow() {
  const settings = await B.getSettings();
  if (!settings.apiKey) {
    setStep(['Setup LLM', 'Extract captions', 'Build cards'], 1);
    renderOnboarding();
    return;
  }
  const { videoId, title } = B.getYouTubeVideoInfo();
  currentState.videoId = videoId;
  currentState.title = title;
  const saved = await B.loadVideoData(videoId);
  if (saved && saved.cards && saved.cards.length) {
    currentState.subtitlesText = saved.subtitlesText || null;
    currentState.candidates = saved.candidates || null;
    currentState.selected = saved.selected || null;
    currentState.cards = saved.cards || null;
    renderLearnView();
    setStep(['Extract captions', 'Filter words', 'Build cards'], 3);
    return;
  }
  startFlow();
}

async function startFlow(forceRegenerate = false) {
  currentState = { ...currentState, candidates: null, selected: null, cards: null, error: null };
  setStep(['Extract captions', 'Filter words', 'Build cards'], 1);
  renderProgress('Extracting captions…');
  try {
    const { videoId, title } = B.getYouTubeVideoInfo();
    currentState.videoId = videoId;
    currentState.title = title;
    if (!forceRegenerate) {
      const saved = await B.loadVideoData(videoId);
      if (saved && saved.cards?.length) {
        currentState = { ...currentState, ...saved };
        renderLearnView();
        setStep(['Extract captions', 'Filter words', 'Build cards'], 3);
        return;
      }
    }
    const subtitlesText = await B.extractCaptionsText();
    currentState.subtitlesText = subtitlesText;
    const createdAt = formatDateYYYYMMDD(new Date());
    await B.saveVideoData(currentState.videoId, { subtitlesText, title, createdAt });
  } catch (e) {
    currentState.error = String(e?.message || e);
    renderError('Captions error', currentState.error);
    return;
  }

  setStep(['Extract captions', 'Filter words', 'Build cards'], 2);
  renderProgress('Filtering words/phrases…');
  try {
    const resp = await B.llmCall('first', { subtitlesText: currentState.subtitlesText, maxItems: 60 });
    currentState.candidates = resp.items || [];
    await B.saveVideoData(currentState.videoId, { candidates: currentState.candidates });
  } catch (e) {
    currentState.error = String(e?.message || e);
    renderError('LLM #1 error', currentState.error);
    return;
  }

  renderSelection();
}

function setStep(steps, activeIndex) {
  const stepEl = uiRoot.querySelector('#cc-step');
  const canClickFilter = activeIndex === 3;
  const canClickBuild = activeIndex === 2 && (currentState.cards && currentState.cards.length);
  const inner = [
    `<div class="cc-stepchip ${1===activeIndex?'active':''}">${steps[0]}</div>`,
    `<div class="cc-step-arrow">${iconArrow()}</div>`,
    `<div class="cc-stepchip ${2===activeIndex?'active':''} ${canClickFilter ? 'clickable' : ''}" id="cc-step-filter">${steps[1]}</div>`,
    `<div class="cc-step-arrow">${iconArrow()}</div>`,
    `<div class="cc-stepchip ${3===activeIndex?'active':''} ${canClickBuild ? 'clickable' : ''}" id="cc-step-build">${steps[2]}</div>`
  ].join('');
  stepEl.innerHTML = `<div class="cc-progress">${inner}</div>`;

  if (canClickFilter) {
    const el = stepEl.querySelector('#cc-step-filter');
    if (el) el.addEventListener('click', () => { setStep(steps, 2); renderSelection(); });
  }
  if (canClickBuild) {
    const el2 = stepEl.querySelector('#cc-step-build');
    if (el2) el2.addEventListener('click', () => { setStep(steps, 3); renderLearnView(); });
  }
}

function updateViewToggleButton() {
  const btn = uiRoot && uiRoot.querySelector('#cc-toggleview');
  if (!btn) return;
  if (ccGridMode) {
    btn.innerHTML = iconCard();
    btn.setAttribute('aria-label', 'Card view');
    btn.setAttribute('title', 'Card view');
  } else {
    btn.innerHTML = iconGrid();
    btn.setAttribute('aria-label', 'Grid view');
    btn.setAttribute('title', 'Grid view');
  }
}

function updateBottomControls() {
  const ctr = uiRoot && uiRoot.querySelector('#cc-bottom-controls');
  const counter = uiRoot && uiRoot.querySelector('#cc-card-counter');
  if (!ctr || !counter) return;
  // 仅在“Build cards”阶段（学习视图的大卡片渲染时）显示底部按钮
  const content = uiRoot && uiRoot.querySelector('#cc-content');
  const inBuildView = !!(content && content.querySelector('.cc-card.cc-large'));
  const hasCards = !!(currentState.cards && currentState.cards.length);
  if (!hasCards || ccGridMode || !inBuildView) {
    ctr.style.display = 'none';
    counter.style.display = 'none';
    return;
  }
  ctr.style.display = 'flex';
  counter.style.display = 'block';
  counter.textContent = `${currentCardIndex + 1} / ${currentState.cards.length}`;
  const saveBtn = ctr.querySelector('#cc-b-save');
  if (saveBtn) saveBtn.disabled = !ccEditMode;
}

function showCenterOverlay(text) {
  const modal = uiRoot && uiRoot.querySelector('.cc-modal');
  if (!modal) return;
  let ov = modal.querySelector('.cc-center-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'cc-center-overlay';
    ov.innerHTML = `<div class="cc-center"><div class="cc-spinner"></div><div class="cc-center-text"></div></div>`;
    modal.appendChild(ov);
  }
  const t = ov.querySelector('.cc-center-text');
  if (t) t.textContent = text || '';
  ov.style.display = 'flex';
}
function hideCenterOverlay() {
  const modal = uiRoot && uiRoot.querySelector('.cc-modal');
  if (!modal) return;
  const ov = modal.querySelector('.cc-center-overlay');
  if (ov) ov.style.display = 'none';
}

function renderProgress(text) {
  const content = uiRoot.querySelector('#cc-content');
  content.innerHTML = '';
  showCenterOverlay(text);
  updateBottomControls();
}

function renderError(title, err) {
  hideCenterOverlay();
  const content = uiRoot.querySelector('#cc-content');
  content.innerHTML = `<div class="cc-card"><div><b>${title}</b></div><pre>${escapeHtml(err)}</pre></div>`;
  updateBottomControls();
}

function renderSelection() {
  hideCenterOverlay();
  const content = uiRoot.querySelector('#cc-content');
  const items = currentState.candidates || [];
  const toolbar = `
    <div class="cc-toolbar">
      <div class="cc-toolbar-title">Review and select items</div>
      <div class="cc-toolbar-actions">
        <button class="cc-btn-white" id="cc-sel-all" aria-label="Select all">Select All</button>
        <button class="cc-btn-white" id="cc-next" aria-label="Next">Next</button>
      </div>
    </div>
  `;
  const list = `
    <div class="cc-list" id="cc-cand-list">
      ${items.map((it, idx) => `
        <label class="cc-cand-item">
          <input type="checkbox" id="cc-cb-${idx}" data-idx="${idx}" ${it.selected? 'checked':''}/>
          <div><b>${escapeHtml(it.term)}</b> <span class="cc-small">(${escapeHtml(it.type||'word')}, freq ${it.freq ?? '-'})</span></div>
        </label>
      `).join('')}
    </div>
  `;
  content.innerHTML = `<div class="cc-card cc-select">${toolbar}${list}</div>`;
  updateBottomControls();

  const updateSelBtn = () => {
    const boxes = Array.from(content.querySelectorAll('input[type="checkbox"]'));
    const allChecked = boxes.length > 0 && boxes.every(cb => cb.checked);
    const btn = content.querySelector('#cc-sel-all');
    if (btn) btn.textContent = allChecked ? 'Unselect All' : 'Select All';
  };

  content.querySelector('#cc-sel-all')?.addEventListener('click', () => {
    const boxes = Array.from(content.querySelectorAll('input[type="checkbox"]'));
    const allChecked = boxes.length > 0 && boxes.every(cb => cb.checked);
    boxes.forEach(cb => cb.checked = !allChecked);
    updateSelBtn();
  });
  content.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', updateSelBtn));
  updateSelBtn();

  content.querySelector('#cc-next')?.addEventListener('click', async () => {
    const selected = [];
    content.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.checked) {
        const idx = Number(cb.getAttribute('data-idx'));
        const it = items[idx];
        selected.push({ term: it.term, type: it.type || 'word' });
      }
    });
    currentState.selected = selected;
    await B.saveVideoData(currentState.videoId, { selected });
    buildCards();
  });
}

async function buildCards() {
  setStep(['Extract captions', 'Filter words', 'Build cards'], 3);
  renderProgress('Generating study cards…');
  try {
    const resp = await B.llmCall('second', { selected: currentState.selected });
    currentState.cards = resp.cards || [];
    // 初次生成写入 createdAt（如果尚未存在）
    const saved = await B.loadVideoData(currentState.videoId) || {};
    const createdAt = saved.createdAt || formatDateYYYYMMDD(new Date());
    await B.saveVideoData(currentState.videoId, { cards: currentState.cards, createdAt });
    renderLearnView();
  } catch (e) {
    currentState.error = String(e?.message || e);
    renderError('LLM #2 error', currentState.error);
  }
}

function renderLearnView() {
  hideCenterOverlay();
  const content = uiRoot.querySelector('#cc-content');
  const cards = currentState.cards || [];
  if (!cards.length) {
    content.innerHTML = '<div class="cc-card">No cards yet.</div>';
    updateBottomControls();
    return;
  }

  const renderBig = () => `
    <div class="cc-card cc-large">
      ${ccEditMode ? renderCardEditor(cards[currentCardIndex]) : renderCardView(cards[currentCardIndex])}
    </div>
  `;

  const renderGrid = () => `
    <div class="cc-grid">
      ${cards.map(c => {
        const ipa = formatIpa(c.ipa || '');
        const meta = [ipa ? `/${escapeHtml(ipa)}/` : '', c.pos ? escapeHtml(c.pos) : '']
          .filter(Boolean)
          .join(' · ');
        return `
          <div class="cc-card">
            <div><b>${escapeHtml(c.term)}</b></div>
            ${meta ? `<div class=\"cc-small\">${meta}</div>` : ''}
            <div>${escapeHtml(c.definition || '')}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  const doRender = () => {
    content.innerHTML = ccGridMode ? renderGrid() : renderBig();
    if (ccGridMode) {
      Array.from(content.querySelectorAll('.cc-card')).forEach((el, i) => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => { currentCardIndex = i; ccGridMode = false; ccEditMode = false; updateViewToggleButton(); doRender(); });
      });
    }
    updateViewToggleButton();
    updateBottomControls();
  };

  doRender();
}

function renderCardView(card) {
  const c = { term: '', ipa: '', pos: '', definition: '', examples: [], notes: '', ...card };
  const ipa = formatIpa(c.ipa);
  const examplesHtml = renderExamplesQuote(c.examples || []);
  return `
    <div class="cc-view">
      <div class="term">${escapeHtml(c.term)}</div>
      <div class="meta">${ipa ? `/${escapeHtml(ipa)}/` : ''} ${c.pos ? `· ${escapeHtml(c.pos)}` : ''}</div>
      <div class="definition">${escapeHtml(c.definition||'')}</div>
      ${examplesHtml}
      ${c.notes ? `<div class="notes">${escapeHtml(c.notes)}</div>` : ''}
    </div>
  `;
}

function renderExamplesQuote(list) {
  if (!list || !list.length) return '';
  const blocks = list.slice(0, 2).map(raw => {
    const lines = String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const en = lines[0] || '';
    const zh = lines[1] || '';
    return `<blockquote><div>${escapeHtml(en)}</div>${zh ? `<div class="cc-small">${escapeHtml(zh)}</div>` : ''}</blockquote>`;
  }).join('');
  return `<div class="examples-quote">${blocks}</div>`;
}

function renderCardEditor(card) {
  const c = { term: '', ipa: '', pos: '', definition: '', examples: [], notes: '', ...card };
  return `
    <div class="cc-editor">
      <label>Term</label><input class="cc-input" id="cc-term" value="${escapeAttr(c.term)}"/>
      <label>IPA</label><input class="cc-input" id="cc-ipa" value="${escapeAttr(c.ipa)}"/>
      <label>POS</label><input class="cc-input" id="cc-pos" value="${escapeAttr(c.pos)}"/>
      <label>Definition</label><input class="cc-input" id="cc-def" value="${escapeAttr(c.definition)}"/>
      <label>Examples</label><textarea class="cc-input ex" id="cc-ex" rows="6">${escapeHtml((c.examples||[]).join('\n\n'))}</textarea>
      <label>Notes</label><textarea class="cc-input notes" id="cc-notes" rows="4">${escapeHtml(c.notes||'')}</textarea>
    </div>
  `;
}

function readCardEditor() {
  const term = document.getElementById('cc-term').value.trim();
  const ipa = document.getElementById('cc-ipa').value.trim();
  const pos = document.getElementById('cc-pos').value.trim();
  const definition = document.getElementById('cc-def').value.trim();
  const raw = document.getElementById('cc-ex').value;
  // Split examples by blank lines to keep English+Chinese together
  const examples = raw
    .split(/\r?\n\s*\r?\n/) // blocks separated by blank line
    .map(b => b.replace(/\s+$/,'').replace(/^\s+/,'')).filter(Boolean);
  const notes = document.getElementById('cc-notes').value.trim();
  return { term, ipa, pos, definition, examples, notes };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
function escapeAttr(s) {
  return String(s).replace(/["&<>]/g, c => ({'"':'&quot;','&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
function formatIpa(s) {
  if (!s) return '';
  const t = String(s).trim();
  return t.replace(/^\/+|\/+$/g, '');
}

async function deleteAllForThisVideo() {
  if (!currentState.videoId) return;
  await B.saveVideoData(currentState.videoId, { subtitlesText: null, candidates: null, selected: null, cards: null, title: currentState.title });
  currentState = { ...currentState, subtitlesText: null, candidates: null, selected: null, cards: null };
  startFlow(true);
}

async function exportCSV() {
  const cards = currentState.cards || [];
  if (!cards.length) return;
  const rows = [['term', 'ipa', 'pos', 'definition', 'notes', 'examples']]
    .concat(cards.map(c => {
      const examples = (c.examples || []).join('\n\n');
      return [c.term||'', c.ipa||'', c.pos||'', c.definition||'', c.notes||'', examples];
    }))
    .map(r => r.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(','))
    .join('\r\n');
  const csv = '\ufeff' + rows;
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
  updateBottomControls();
  content.querySelector('#cc-open-settings')?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CC_OPEN_OPTIONS' }));
  content.querySelector('#cc-continue')?.addEventListener('click', async () => {
    const s = await B.getSettings();
    if (!s.apiKey) {
      alert('API key is still missing. Please save settings.');
      return;
    }
    startFlow(true);
  });
}

function pauseActiveVideo() {
  try {
    const vids = document.querySelectorAll('video');
    vids.forEach(v => {
      try { if (!v.paused) { v.pause(); __ccPausedVideos.add(v); } } catch {}
    });
  } catch {}
}
function resumePausedVideos() {
  try { __ccPausedVideos.forEach(v => { try { v.play(); } catch {} }); } catch {}
  __ccPausedVideos.clear();
}

function formatDateYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// Favorites storage helpers (word snapshots)
async function addFavoriteWordSnapshot({ videoId, title, cardIndex, snapshot }) {
  try {
    const key = 'CCAPTIPREPS:fav:words';
    const data = await chrome.storage.local.get(key);
    const list = Array.isArray(data[key]) ? data[key] : [];
    const savedAt = new Date().toISOString();
    const item = { videoId, title, cardIndex, snapshot, savedAt };
    list.push(item);
    await chrome.storage.local.set({ [key]: list });
    return true;
  } catch (e) { throw e; }
}

// Icons
function iconClose(){return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`}
function iconSettings(){return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 3.3l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.26 1.3.73 1.77.47.47 1.11.73 1.77.73h.09a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`}
function iconArrow(){return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5l7 7-7 7"/></svg>`}
function iconRefresh(){return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2-9.94"/></svg>`}
function iconTrash(){return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`}
function iconExport(){return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 8 12 3 17 8"/><path d="M21 21H3v-4a4 4 0 0 1 4-4h10a4 4 0  0 1 4 4v4z"/></svg>`}
function iconGrid(){return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`}
function iconCard(){return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="10" x2="17" y2="10"/></svg>`}
function iconLeft(){return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`}
function iconRight(){return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`}
function iconEdit(){return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`}
function iconSave(){return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`}
