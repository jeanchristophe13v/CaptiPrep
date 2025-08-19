// Content script: injects UI, extracts YouTube captions, orchestrates LLM flow

const CC_NS = 'CCAPTIPREPS';

// Simple state
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
  // 打开时自动暂停页面上所有正在播放的视频
  pauseActiveVideo();
  bootFlow();
}

function closeModal() {
  modalOpen = false;
  if (uiRoot) uiRoot.style.display = 'none';
  // 恢复播放之前被我们暂停的视频
  resumePausedVideos();
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
            <button class="cc-icon" id="cc-settings" title="Settings" aria-label="Settings">${iconSettings()}</button>
            <button class="cc-icon" id="cc-close" title="Close" aria-label="Close">${iconClose()}</button>
          </div>
        </div>
        <div class="cc-body">
          <div id="cc-step"></div>
          <div id="cc-content"></div>
        </div>
        <!-- 右侧垂直悬浮按钮（删除已移除） -->
        <div class="cc-fab" aria-label="Actions">
          <button class="cc-fab-btn" id="cc-toggleview" title="Toggle view" aria-label="Toggle view">${iconGrid()}</button>
          <button class="cc-fab-btn" id="cc-regenerate" title="Regenerate" aria-label="Regenerate">${iconRefresh()}</button>
          <button class="cc-fab-btn" id="cc-export" title="Export CSV" aria-label="Export CSV">${iconExport()}</button>
        </div>
        <div id="cc-card-counter" class="cc-card-counter"></div>
        <!-- 底部全局控制条：左(上一页) | 中(编辑/保存) | 右(下一页) -->
        <div class="cc-bottom-controls" id="cc-bottom-controls">
          <div class="cc-bc-left">
            <button class="cc-mini-btn" id="cc-b-prev" aria-label="Previous" title="Previous">${iconLeft()}</button>
          </div>
          <div class="cc-bc-center">
            <button class="cc-mini-btn" id="cc-b-edit" aria-label="Edit" title="Edit">${iconEdit()}</button>
            <button class="cc-mini-btn" id="cc-b-save" aria-label="Save" title="Save" disabled>${iconSave()}</button>
          </div>
          <div class="cc-bc-right">
            <button class="cc-mini-btn" id="cc-b-next" aria-label="Next" title="Next">${iconRight()}</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(uiRoot);

  uiRoot.querySelector('#cc-close').addEventListener('click', closeModal);
  uiRoot.querySelector('#cc-settings').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CC_OPEN_OPTIONS' }));
  uiRoot.querySelector('#cc-regenerate').addEventListener('click', () => startFlow(true));
  uiRoot.querySelector('#cc-export').addEventListener('click', exportCSV);
  uiRoot.querySelector('#cc-toggleview').addEventListener('click', () => {
    ccGridMode = !ccGridMode;
    ccEditMode = false; // 切换视图时退出编辑
    if (currentState.cards && currentState.cards.length) renderLearnView();
    updateViewToggleButton();
    updateBottomControls();
  });

  // 底部控制条事件（在全局绑定一次）
  uiRoot.querySelector('#cc-b-prev').addEventListener('click', () => {
    const cards = currentState.cards || [];
    if (!cards.length || ccGridMode) return;
    currentCardIndex = (currentCardIndex - 1 + cards.length) % cards.length;
    ccEditMode = false;
    renderLearnView();
  });
  uiRoot.querySelector('#cc-b-next').addEventListener('click', () => {
    const cards = currentState.cards || [];
    if (!cards.length || ccGridMode) return;
    currentCardIndex = (currentCardIndex + 1) % cards.length;
    ccEditMode = false;
    renderLearnView();
  });
  uiRoot.querySelector('#cc-b-edit').addEventListener('click', () => {
    if (ccGridMode || !(currentState.cards || []).length) return;
    ccEditMode = !ccEditMode;
    renderLearnView();
  });
  uiRoot.querySelector('#cc-b-save').addEventListener('click', async () => {
    if (ccGridMode || !ccEditMode) return;
    const cards = currentState.cards || [];
    if (!cards.length) return;
    const edited = readCardEditor();
    cards[currentCardIndex] = edited;
    await saveVideoData(currentState.videoId, { cards });
    ccEditMode = false;
    renderLearnView();
  });

  // 键盘快捷键：左右箭头切换卡片（捕获阶段，避免影响原页面）
  document.addEventListener('keydown', onCcKeydown, true);
}

// 键盘事件处理：仅在模态打开且为大卡视图时生效；在输入框/文本域内不触发
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

  if (k === 'ArrowLeft') {
    currentCardIndex = (currentCardIndex - 1 + cards.length) % cards.length;
  } else {
    currentCardIndex = (currentCardIndex + 1) % cards.length;
  }
  ccEditMode = false;
  renderLearnView();
}

function getStyles() {
  return `
    #cc-root { position: fixed; inset: 0; z-index: 2147483647; display:none; }
    .cc-overlay { position: absolute; inset:0; background: rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; }
    .cc-modal { position: relative; overflow: visible; width: min(960px, 96vw); height: min(680px, 92vh); background:#fff; color:#000; border:3px solid #000; box-shadow: 8px 8px #000; display:flex; flex-direction:column; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .cc-header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:3px solid #000; background: #f5f5f5; }
    .cc-title { font-weight: 800; letter-spacing: 1px; font-size:20px; }
    .cc-actions { display:flex; gap:12px; }
    /* 顶部图标：白底圆形 + 悬浮标签 */
    .cc-icon { position:relative; background:#fff; color:#000; border:2px solid #000; width:34px; height:34px; border-radius:50%; display:grid; place-items:center; cursor:pointer; box-shadow: 2px 2px #000; }
    .cc-icon:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px #000; }
    .cc-icon::after { content: attr(aria-label); position:absolute; top:42px; left:50%; transform: translateX(-50%); background:#fff; color:#000; border:2px solid #000; padding:4px 8px; box-shadow: 2px 2px #000; white-space: nowrap; opacity:0; pointer-events:none; transition: opacity .12s ease-in-out; font-size:12px; }
    .cc-icon:hover::after, .cc-icon:focus-visible::after { opacity:1; }

    .cc-body { flex:1; overflow:auto; padding:12px 12px 84px; background: repeating-linear-gradient(45deg, #fafafa, #fafafa 2px, #f0f0f0 2px, #f0f0f0 4px); font-size:15px; }

    /* Steps: evenly distributed with arrows */
    .cc-progress { display:grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items:center; gap:12px; margin-bottom:12px; }
    .cc-stepchip { padding:8px 10px; border:2px solid #000; background:#fff; text-align:center; font-weight:700; }
    .cc-stepchip.active { background:#000; color:#fff; }
    .cc-stepchip.clickable { cursor: pointer; }
    .cc-step-arrow { display:grid; place-items:center; color:#000; opacity:0.8; }

    /* Cards & inputs */
    .cc-card { position: relative; border:2px solid #000; padding:40px 32px 40px; background:#fff; margin-bottom:12px; }
    .cc-card.cc-large { padding:48px 36px; max-height: calc(100% - 120px); overflow:auto; }
    /* 选择页卡片：去掉顶部内边距，避免 sticky 工具条上方出现缝隙 */
    .cc-card.cc-select { padding-top: 0; }
    .cc-small { color:#333; font-size:13px; }
    .cc-input { padding:8px 10px; border:2px solid #000; width: 100%; }

    /* 选择页顶部工具条（白底固定） */
    /* 抵消滚动容器 .cc-body 的 12px 顶部内边距，避免工具条上方露出列表 */
    .cc-toolbar { position: sticky; top: -12px; z-index: 3; background:#fff; border-bottom:2px solid #000; padding: calc(14px + 12px) 12px 14px; display:flex; align-items:center; justify-content:space-between; gap:12px; margin-left: -32px; margin-right: -32px; padding-left: 32px; padding-right: 32px; }
    .cc-toolbar-title { font-weight:800; }
    .cc-btn-white { background:#fff; color:#000; border:2px solid #000; padding:8px 12px; cursor:pointer; box-shadow: 2px 2px #000; }
    .cc-btn-white:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px #000; }

    /* 选择列表更疏朗 - 整行可点击 */
    .cc-list { display:block; margin-top:12px; }
    .cc-cand-item { display:flex; gap:10px; align-items:flex-start; padding:10px 8px; cursor:pointer; }
    .cc-cand-item + .cc-cand-item { border-top:1px dashed #ddd; }

    /* Editor grid layout */
    .cc-editor { display:grid; grid-template-columns: 120px 1fr; gap:14px 18px; align-items:start; }
    .cc-editor label { font-weight:700; }
    .cc-editor textarea { min-height: 160px; resize: vertical; }
    .cc-editor .ex { min-height: 200px; }
    .cc-editor .notes { min-height: 140px; }

    /* View (Anki 风格更大更松) */
    .cc-view .term { font-size: 36px; font-weight: 900; letter-spacing:.5px; margin-bottom: 8px; }
    .cc-view .meta { margin-top:0; color:#111; font-size:16px; margin-bottom: 24px; }
    .cc-view .definition { margin-top:0; font-size:18px; line-height:1.7; }
    .cc-view .examples { margin-top:24px; font-size:16px; }
    .cc-view .examples li { margin-left: 20px; list-style: disc; }
    .cc-view .notes { margin-top:20px; color:#333; font-style: italic; font-size:14px; }

    /* Grid view */
    .cc-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:12px; }

    /* 进度卡片（原样式保留以兼容老逻辑，但不再用于新加载方式） */
    .cc-loading { min-height: 160px; display:flex; align-items:center; }

    /* Card bottom floating controls（旧版，保留不再使用） */
    .cc-card-controls { position:absolute; left:50%; bottom:16px; transform: translateX(-50%); display:flex; gap:12px; align-items:center; }
    .cc-mini-btn { position:relative; width:46px; height:46px; border-radius:50%; background:#fff; color:#000; border:3px solid #000; display:grid; place-items:center; cursor:pointer; box-shadow: 3px 3px #000; }
    .cc-mini-btn:disabled { opacity: .45; cursor: not-allowed; }
    .cc-mini-btn:hover:not(:disabled) { transform: translate(-1px, -1px); box-shadow: 5px 5px #000; }
    .cc-mini-btn::after { content: attr(aria-label); position:absolute; bottom:54px; left:50%; transform: translateX(-50%); background:#fff; color:#000; border:2px solid #000; padding:4px 8px; box-shadow: 2px 2px #000; white-space: nowrap; opacity:0; pointer-events:none; transition: opacity .12s ease-in-out; font-size:12px; }
    .cc-mini-btn:hover::after, .cc-mini-btn:focus-visible::after { opacity:1; }

    .cc-card-counter {
      position: absolute;
      left: 50%;
      bottom: 72px; /* Adjust this value to position the counter above the controls */
      transform: translateX(-50%);
      font-size: 14px;
      color: #555;
      z-index: 6;
      display: none; /* Initially hidden */
    }

    /* Floating actions (右侧) */
    .cc-fab { position:absolute; right:-64px; top:50%; transform: translateY(-50%); display:flex; flex-direction:column; gap:12px; }
    .cc-fab-btn { position:relative; width:48px; height:48px; border-radius:50%; background:#fff; color:#000; border:3px solid #000; display:grid; place-items:center; cursor:pointer; box-shadow: 4px 4px #000; }
    .cc-fab-btn:hover { transform: translate(-1px, -1px); box-shadow: 6px 6px #000; }
    /* 悬浮标签移到按钮右侧 */
    .cc-fab-btn::after { content: attr(aria-label); position:absolute; left:56px; top:50%; transform: translateY(-50%); background:#fff; color:#000; border:2px solid #000; padding:4px 8px; box-shadow: 2px 2px #000; white-space: nowrap; opacity:0; pointer-events:none; transition: opacity .12s ease-in-out; }
    .cc-fab-btn:hover::after, .cc-fab-btn:focus-visible::after { opacity:1; }

    .cc-flex { display:flex; gap:8px; align-items:center; }
    .cc-spinner { width: 18px; height: 18px; border: 3px solid #000; border-right-color: transparent; border-radius: 50%; animation: ccspin 0.8s linear infinite; }
    @keyframes ccspin { to { transform: rotate(360deg); } }

    /* Loading 居中覆盖在整个模态框 */
    .cc-center-overlay { position:absolute; inset:0; display:none; align-items:center; justify-content:center; pointer-events:none; }
    .cc-center-overlay .cc-center { display:flex; align-items:center; gap:10px; font-size:15px; }
    .cc-center-overlay .cc-spinner { width:16px; height:16px; border-width:2px; }

    /* 全局底部控制条：整体居中四按钮组 */
    .cc-bottom-controls { position:absolute; left:50%; bottom:12px; transform: translateX(-50%); display:none; align-items:center; justify-content:center; gap:12px; z-index:5; }
    .cc-bc-left, .cc-bc-center, .cc-bc-right { display:flex; align-items:center; gap:12px; }

    /* Loading card：紧凑美观覆盖（保留以兼容旧渲染） */
    .cc-card.cc-loading { padding: 14px 16px; }
    .cc-loading { min-height: 0; display:flex; align-items:center; gap:10px; }
    .cc-card.cc-loading .cc-spinner { width:14px; height:14px; border-width:2px; }
  `;
}

function iconClose() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
}
function iconSettings() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 3.3l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.26 1.3.73 1.77.47.47 1.11.73 1.77.73h.09a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
}
function iconArrow() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5l7 7-7 7"/></svg>`;
}
function iconRefresh() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2-9.94"/></svg>`;
}
function iconTrash() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`;
}
function iconExport() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 8 12 3 17 8"/><path d="M21 21H3v-4a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v4z"/></svg>`;
}
function iconGrid() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
}
function iconCard() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="10" x2="17" y2="10"/></svg>`;
}
function iconLeft() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
}
function iconRight() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
}
function iconEdit() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
}
function iconSave() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
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
    renderLearnView();
    setStep(['Extract captions', 'Filter words', 'Build cards'], 3);
    return;
  }
  // Otherwise start fresh
  startFlow();
}

async function startFlow(forceRegenerate = false) {
  // 开新流程前清掉上一视频的中间态与卡片，避免底部按钮误显
  currentState = { ...currentState, candidates: null, selected: null, cards: null, error: null };
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
        renderLearnView();
        setStep(['Extract captions', 'Filter words', 'Build cards'], 3);
        return;
      }
    }
    const subtitlesText = await extractCaptionsText();
    currentState.subtitlesText = subtitlesText;
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
  const canClickFilter = activeIndex === 3; // 在生成卡片阶段允许返回筛选
  const canClickBuild = activeIndex === 2 && (currentState.cards && currentState.cards.length); // 在筛选阶段允许回到已有卡片
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

// 底部控制条状态同步
function updateBottomControls() {
  const ctr = uiRoot && uiRoot.querySelector('#cc-bottom-controls');
  const counter = uiRoot && uiRoot.querySelector('#cc-card-counter');
  if (!ctr || !counter) return;
  const hasCards = !!(currentState.cards && currentState.cards.length);
  if (!hasCards || ccGridMode) {
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

// 居中 Loading 覆盖层
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
  updateBottomControls(); // 加载阶段隐藏底部按钮
}

function renderError(title, err) {
  hideCenterOverlay();
  const content = uiRoot.querySelector('#cc-content');
  content.innerHTML = `<div class="cc-card"><div><b>${title}</b></div><pre>${escapeHtml(err)}</pre></div>`;
  updateBottomControls(); // 出错时隐藏底部按钮
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
  updateBottomControls(); // 选择阶段隐藏底部按钮

  const updateSelBtn = () => {
    const boxes = Array.from(content.querySelectorAll('input[type="checkbox"]'));
    const allChecked = boxes.length > 0 && boxes.every(cb => cb.checked);
    const btn = content.querySelector('#cc-sel-all');
    if (btn) btn.textContent = allChecked ? 'Unselect All' : 'Select All';
  };

  content.querySelector('#cc-sel-all').addEventListener('click', () => {
    const boxes = Array.from(content.querySelectorAll('input[type="checkbox"]'));
    const allChecked = boxes.length > 0 && boxes.every(cb => cb.checked);
    boxes.forEach(cb => cb.checked = !allChecked);
    updateSelBtn();
  });
  content.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', updateSelBtn));
  updateSelBtn();

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
    await saveVideoData(currentState.videoId, { cards: currentState.cards });
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

  // 局部渲染器
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
    if (!ccGridMode) {
      // 大卡视图下，底部控制条可用
    } else {
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
  const ex = (c.examples || []).map(e => `<li>${escapeHtml(e)}</li>`).join('');
  return `
    <div class="cc-view">
      <div class="term">${escapeHtml(c.term)}</div>
      <div class="meta">${ipa ? `/${escapeHtml(ipa)}/` : ''} ${c.pos ? `· ${escapeHtml(c.pos)}` : ''}</div>
      <div class="definition">${escapeHtml(c.definition||'')}</div>
      ${ex ? `<ul class="examples">${ex}</ul>` : ''}
      ${c.notes ? `<div class="notes">${escapeHtml(c.notes)}</div>` : ''}
    </div>
  `;
}

function renderCardEditor(card) {
  const c = { term: '', ipa: '', pos: '', definition: '', examples: [], notes: '', ...card };
  return `
    <div class="cc-editor">
      <label>Term</label><input class="cc-input" id="cc-term" value="${escapeAttr(c.term)}"/>
      <label>IPA</label><input class="cc-input" id="cc-ipa" value="${escapeAttr(c.ipa)}"/>
      <label>POS</label><input class="cc-input" id="cc-pos" value="${escapeAttr(c.pos)}"/>
      <label>Definition</label><input class="cc-input" id="cc-def" value="${escapeAttr(c.definition)}"/>
      <label>Examples</label><textarea class="cc-input ex" id="cc-ex" rows="6">${escapeHtml((c.examples||[]).join('\n'))}</textarea>
      <label>Notes</label><textarea class="cc-input notes" id="cc-notes" rows="4">${escapeHtml(c.notes||'')}</textarea>
    </div>
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

// 统一 IPA 展示：剔除两端多余斜杠，只保留内容，由视图负责包裹 /content/
function formatIpa(s) {
  if (!s) return '';
  const t = String(s).trim();
  return t.replace(/^\/+|\/+$/g, '');
}

async function deleteAllForThisVideo() {
  if (!currentState.videoId) return;
  await saveVideoData(currentState.videoId, { subtitlesText: null, candidates: null, selected: null, cards: null, title: currentState.title });
  currentState = { ...currentState, subtitlesText: null, candidates: null, selected: null, cards: null };
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
  updateBottomControls();
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

// 尝试暂停当前页面上的视频（YouTube/HTML5）
function pauseActiveVideo() {
  try {
    const vids = document.querySelectorAll('video');
    vids.forEach(v => {
      try {
        if (!v.paused) {
          v.pause();
          __ccPausedVideos.add(v);
        }
      } catch {}
    });
  } catch {}
}

function resumePausedVideos() {
  try {
    __ccPausedVideos.forEach(v => {
      try { v.play(); } catch {}
    });
  } catch {}
  __ccPausedVideos.clear();
}
