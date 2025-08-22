// UI script: handles DOM, user interactions, and rendering. Uses backend via global CaptiPrep.backend
var __i18nDict = null;
function t(k, ...subs) {
  try {
    if (__i18nDict && __i18nDict[k]) {
      let s = __i18nDict[k];
      if (subs && subs.length) subs.forEach((v, i) => { s = s.replace(new RegExp('\\$' + (i + 1), 'g'), String(v)); });
      return s;
    }
  } catch {}
  return (chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage(k, subs) : '') || k;
}
function applyI18nPlaceholders(root) {
  try {
    const getMsg = (raw) => {
      const m = /^__MSG_([A-Za-z0-9_]+)__$/.exec(raw || '');
      if (!m) return null;
      const key = m[1];
      const v = (__i18nDict && __i18nDict[key]) || ((chrome.i18n && chrome.i18n.getMessage) ? chrome.i18n.getMessage(key) : '');
      return v || null;
    };
    const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
    const all = (root || document).querySelectorAll('*');
    all.forEach(el => {
      ATTRS.forEach(attr => {
        if (!el.hasAttribute(attr)) return;
        const raw = el.getAttribute(attr);
        const msg = getMsg(raw);
        if (msg) el.setAttribute(attr, msg);
      });
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          const raw = node.textContent && node.textContent.trim();
          const msg = getMsg(raw);
          if (msg) node.textContent = msg;
        }
      }
    });
  } catch {}
}

// Backend facade
// Avoid duplicate const redeclare when UI script is injected twice
// eslint-disable-next-line no-var
var B = (typeof B !== 'undefined' && B) || (globalThis.CaptiPrep && globalThis.CaptiPrep.backend) || {};

// Simple UI state
// Use var so re-injection doesn't throw on redeclare
var modalOpen = typeof modalOpen !== 'undefined' ? modalOpen : false;
var uiRoot = typeof uiRoot !== 'undefined' ? uiRoot : null;
var buildWatchTimer = typeof buildWatchTimer !== 'undefined' ? buildWatchTimer : null; // polling to reflect background building status
var selectWatchTimer = typeof selectWatchTimer !== 'undefined' ? selectWatchTimer : null; // polling to reflect background selecting status
var currentState = typeof currentState !== 'undefined' ? currentState : {
  videoId: null,
  title: null,
  subtitlesText: null,
  captionLang: null,
  candidates: null,
  selected: null,
  cards: null,
  error: null,
};

// 全局 UI 状态
var ccGridMode = typeof ccGridMode !== 'undefined' ? ccGridMode : false; // 是否网格视图
var ccEditMode = typeof ccEditMode !== 'undefined' ? ccEditMode : false; // 是否编辑模式（大卡片）
var currentCardIndex = typeof currentCardIndex !== 'undefined' ? currentCardIndex : 0; // 当前卡索引
// 记录由插件暂停的 video 元素，便于关闭面板时恢复播放
var __ccPausedVideos = (typeof __ccPausedVideos !== 'undefined') ? __ccPausedVideos : new Set();

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
  try { maybeShowWhatsNew(); } catch {}
  bootFlow();
}

function closeModal() {
  modalOpen = false;
  if (uiRoot) uiRoot.style.display = 'none';
  resumePausedVideos();
  // stop background polling when panel is closed
  try { if (buildWatchTimer) { clearInterval(buildWatchTimer); buildWatchTimer = null; } } catch {}
  try { if (selectWatchTimer) { clearInterval(selectWatchTimer); selectWatchTimer = null; } } catch {}
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

  // 加载 UI 模板 + 语言字典
  try {
    const htmlUrl = chrome.runtime.getURL('assets/ui.html');
    const html = await fetch(htmlUrl).then(r => r.text());
    uiRoot.innerHTML = html;
    try {
      const store = await chrome.storage.local.get('settings');
      let uiLang = (store && store.settings && store.settings.uiLang) || 'auto';
      if (uiLang && uiLang !== 'auto') {
        const url = chrome.runtime.getURL(`assets/i18n/${uiLang}.json`);
        const res = await fetch(url);
        if (res.ok) __i18nDict = await res.json();
      }
    } catch {}
    applyI18nPlaceholders(uiRoot);
  } catch {
    uiRoot.innerHTML = '<div class="cc-overlay"><div class="cc-modal"><div class="cc-body"><div id="cc-step"></div><div id="cc-content">' + t('state_failed_load_ui') + '</div></div></div></div>';
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
    blurActiveMiniButtons();
    renderLearnView();
  });
  uiRoot.querySelector('#cc-b-next')?.addEventListener('click', () => {
    const cards = currentState.cards || [];
    if (!cards.length || ccGridMode) return;
    currentCardIndex = (currentCardIndex + 1) % cards.length;
    ccEditMode = false;
    blurActiveMiniButtons();
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
    try {
      const added = await toggleFavoriteCurrentCard();
      const btn = uiRoot.querySelector('#cc-b-fav');
      if (btn) {
        btn.classList.toggle('active', added);
        if (added) { btn.classList.add('cc-ok'); setTimeout(() => btn.classList.remove('cc-ok'), 600); }
        // 清除按钮焦点，避免 hover message 持续
        btn.blur();
      }
    } catch (e) {
      console.warn('favorite toggle failed', e);
    }
  });

  // 键盘快捷：左右箭头
  document.addEventListener('keydown', onCcKeydown, true);
}

// ===== "What's New" (更新提示) =====
async function maybeShowWhatsNew() {
  try {
    const man = chrome.runtime.getManifest();
    const ver = (man && man.version) || '';
    if (!ver) return;
    const { cc_whatsnew_seen } = await chrome.storage.local.get(['cc_whatsnew_seen']);
    if (cc_whatsnew_seen === ver) return; // 本版本已经看过
    const changelog = await loadChangelogForVersion(ver);
    showWhatsNewOverlay(ver, changelog);
  } catch (e) {
    // silent
  }
}

async function loadChangelogForVersion(ver) {
  try {
    const url = chrome.runtime.getURL('assets/CHANGELOG.md');
    const text = await fetch(url).then(r => r.ok ? r.text() : '');
    if (!text) return '';
    // Try to extract section for current version, headings like: ## v1.2.3 or ## 1.2.3
    const lines = text.split(/\r?\n/);
    // Regex-based parse for the current version heading
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reStart = new RegExp(`^##\s*v?${esc(ver)}`);
    let i = lines.findIndex(l => reStart.test(l));
    if (i === -1) {
      // Take the first section after the first heading
      i = lines.findIndex(l => /^##\s+/.test(l));
    }
    if (i === -1) return lines.slice(0, 20).join('\n');
    let j = i + 1;
    while (j < lines.length && !/^##\s+/.test(lines[j])) j++;
    return lines.slice(i + 1, j).join('\n').trim();
  } catch { return ''; }
}

function showWhatsNewOverlay(ver, mdText) {
  const modal = uiRoot && uiRoot.querySelector('.cc-modal');
  if (!modal) return;
  let ov = modal.querySelector('.cc-update-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'cc-update-overlay';
    ov.innerHTML = `
      <div class="cc-update" role="dialog" aria-modal="true" aria-label="' + t('whats_new_aria') + '">
        <div class="cc-update-header">
          <div class="cc-update-title" id="cc-update-title"></div>
          <button class="cc-mini-btn" id="cc-update-close" aria-label="' + t('action_close') + '" title="' + t('action_close') + '">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="cc-update-body">
          <div class="cc-card cc-update-card">
            <div class="cc-update-content" id="cc-update-content"></div>
          </div>
        </div>
        <div class="cc-update-bottom">
          <button class="cc-btn-white" id="cc-update-dismiss">' + t('whats_new_dismiss') + '</button>
        </div>
      </div>`;
    modal.appendChild(ov);
  }
  const titleEl = ov.querySelector('#cc-update-title');
  if (titleEl) titleEl.textContent = t('whats_new_header', ver);
  const cEl = ov.querySelector('#cc-update-content');
  cEl.innerHTML = renderMarkdownSimple(mdText || '');
  // Wire events
  const hideOnly = () => { ov.style.display = 'none'; };
  const dismiss = async () => {
    try {
      const man = chrome.runtime.getManifest();
      const verNow = (man && man.version) || ver;
      await chrome.storage.local.set({ cc_whatsnew_seen: verNow });
    } catch {}
    ov.style.display = 'none';
  };
  ov.querySelector('#cc-update-close')?.addEventListener('click', hideOnly, { once: true });
  ov.querySelector('#cc-update-dismiss')?.addEventListener('click', dismiss, { once: true });
  ov.style.display = 'flex';
}

function renderMarkdownSimple(md) {
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    if (!line.trim()) { out.push(''); continue; }
    // Bullet
    if (/^\s*[-*]\s+/.test(line)) {
      const text = esc(line.replace(/^\s*[-*]\s+/, ''));
      out.push(`<li>${text}</li>`);
      continue;
    }
    // Heading -> bold
    if (/^\s*#+\s+/.test(line)) {
      const t = esc(line.replace(/^\s*#+\s+/, ''));
      out.push(`<div><b>${t}</b></div>`);
      continue;
    }
    out.push(`<div>${esc(line)}</div>`);
  }
  // Wrap consecutive <li> into <ul>
  const html = out.join('\n');
  const wrapped = html.replace(/(?:\n|^)(<li>[^]*?<\/li>)(?=(?:\n(?!<li>)|$))/g, (m) => `<ul>${m.trim()}</ul>`);
  return wrapped;
}

function onCcKeydown(e) {
  if (!modalOpen) return;
  const k = e.key;
  if (k === 'Escape') {
    const t = e.target;
    const tag = (t && t.tagName ? t.tagName.toLowerCase() : '');
    const isEditable = (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable));
    if (isEditable) return;
    e.preventDefault();
    e.stopPropagation();
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch {}
    closeModal();
    return;
  }
  // Space toggles favorite on current card (when not editing inputs)
  if (k === ' ' || k === 'Spacebar' || e.code === 'Space') {
    const t2 = e.target;
    const tag2 = (t2 && t2.tagName ? t2.tagName.toLowerCase() : '');
    const isEditable2 = (tag2 === 'input' || tag2 === 'textarea' || (t2 && t2.isContentEditable));
    if (isEditable2) return;
    const cards = currentState.cards || [];
    if (!cards.length || ccGridMode) return;
    e.preventDefault();
    e.stopPropagation();
    try { const btn = uiRoot && uiRoot.querySelector('#cc-b-fav'); if (btn) btn.click(); } catch {}
    return;
  }
  if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  const t = e.target;
  const tag = (t && t.tagName ? t.tagName.toLowerCase() : '');
  const isEditable = (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable));
  if (isEditable) return;
  const cards = currentState.cards || [];
  if (!cards.length || ccGridMode) return;
  e.preventDefault();
  e.stopPropagation();
  blurActiveMiniButtons();
  if (k === 'ArrowLeft') currentCardIndex = (currentCardIndex - 1 + cards.length) % cards.length;
  else currentCardIndex = (currentCardIndex + 1) % cards.length;
  ccEditMode = false;
  renderLearnView();
}

async function bootFlow() {
  const settings = await B.getSettings();
  if (!settings.apiKey) {
    setStep([t('steps_setup'), t('steps_extract'), t('steps_build')], 1);
    renderOnboarding();
    return;
  }
  const { videoId, title } = B.getYouTubeVideoInfo();
  currentState.videoId = videoId;
  currentState.title = title;
  const saved = await B.loadVideoData(videoId);
  if (saved && saved.cards && saved.cards.length) {
    currentState.subtitlesText = saved.subtitlesText || null;
    currentState.captionLang = saved.captionLang || null;
    currentState.candidates = saved.candidates || null;
    currentState.selected = saved.selected || null;
    currentState.cards = saved.cards || null;
    renderLearnView();
    setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 3);
    return;
  }
  // If background is currently building, keep UI in syncing state instead of restarting the pipeline
  if (saved && saved.building && (saved.selected && saved.selected.length)) {
    currentState.subtitlesText = saved.subtitlesText || null;
    currentState.captionLang = saved.captionLang || null;
    currentState.candidates = saved.candidates || null;
    currentState.selected = saved.selected || null;
    setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 3);
    renderProgress(t('progress_generating'));
    startBuildWatcher();
    return;
  }
  startFlow();
}

async function startFlow(forceRegenerate = false) {
  currentState = { ...currentState, candidates: null, selected: null, cards: null, error: null };
  setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 1);
  renderProgress(t('steps_extract') + '…');
  try {
    const { videoId, title } = B.getYouTubeVideoInfo();
    currentState.videoId = videoId;
    currentState.title = title;
    if (!forceRegenerate) {
      const saved = await B.loadVideoData(videoId);
      if (saved && saved.cards?.length) {
        currentState = { ...currentState, ...saved };
        renderLearnView();
        setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 3);
        return;
      }
      // If previously started building, don't redo captions/selection; just reflect progress
      if (saved && saved.building && (saved.selected && saved.selected.length)) {
        currentState.subtitlesText = saved.subtitlesText || null;
        currentState.candidates = saved.candidates || null;
        currentState.selected = saved.selected || null;
        setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 3);
        renderProgress(t('progress_generating'));
        startBuildWatcher();
        return;
      }
      // If candidates already exist and user hasn't selected yet, go directly to selection UI
      if (saved && Array.isArray(saved.candidates) && saved.candidates.length && (!saved.selected || !saved.selected.length)) {
        currentState.subtitlesText = saved.subtitlesText || null;
        currentState.captionLang = saved.captionLang || null;
        currentState.candidates = saved.candidates || [];
        setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 2);
        renderSelection();
        return;
      }
      // If selecting is in progress, show filtering progress and watch for completion
      if (saved && saved.selecting && saved.subtitlesText) {
        currentState.subtitlesText = saved.subtitlesText;
        currentState.captionLang = saved.captionLang || null;
        setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 2);
        renderProgress(t('progress_filtering'));
        startSelectWatcher();
        return;
      }
      // If subtitles already extracted, skip extraction and continue to filtering
      if (saved && saved.subtitlesText) {
        currentState.subtitlesText = saved.subtitlesText;
        currentState.captionLang = saved.captionLang || null;
        setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 2);
        renderProgress(t('progress_filtering'));
        await B.saveVideoData(currentState.videoId, { selecting: true });
        try {
          const sampled = sampleTranscript(currentState.subtitlesText, 12000);
          const resp = await B.llmCall('first', { subtitlesText: sampled, captionLang: currentState.captionLang, maxItems: 60 });
          currentState.candidates = resp.items || [];
          await B.saveVideoData(currentState.videoId, { candidates: currentState.candidates, selecting: false });
        } catch (e) {
          await B.saveVideoData(currentState.videoId, { selecting: false });
          throw e;
        }
        hideCenterOverlay();
        renderSelection();
        return;
      }
    }
    const cap = await B.extractCaptionsText();
    if (typeof cap === 'string') {
      currentState.subtitlesText = cap;
      currentState.captionLang = null;
    } else {
      currentState.subtitlesText = cap && cap.text || '';
      currentState.captionLang = cap && cap.lang || null;
    }
    const createdAt = formatDateYYYYMMDD(new Date());
    await B.saveVideoData(currentState.videoId, { subtitlesText: currentState.subtitlesText, captionLang: currentState.captionLang, title, createdAt });
  } catch (e) {
    currentState.error = String(e?.message || e);
    renderError(t('error_captions'), currentState.error);
    return;
  }

  setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 2);
  renderProgress(t('progress_filtering'));
  try {
    await B.saveVideoData(currentState.videoId, { selecting: true });
    const sampled = sampleTranscript(currentState.subtitlesText, 12000);
    const resp = await B.llmCall('first', { subtitlesText: sampled, captionLang: currentState.captionLang, maxItems: 60 });
    currentState.candidates = resp.items || [];
    await B.saveVideoData(currentState.videoId, { candidates: currentState.candidates, selecting: false });
  } catch (e) {
    currentState.error = String(e?.message || e);
    try { await B.saveVideoData(currentState.videoId, { selecting: false }); } catch {}
    renderError(t('error_llm1'), currentState.error);
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
    btn.setAttribute('aria-label', t('action_card_view'));
    btn.setAttribute('title', t('action_card_view'));
  } else {
    btn.innerHTML = iconGrid();
    btn.setAttribute('aria-label', t('action_grid_view'));
    btn.setAttribute('title', t('action_grid_view'));
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
  // update favorite button active state
  updateFavButtonActive();
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
      <div class="cc-toolbar-title">${t('select_title')}</div>
      <div class="cc-toolbar-actions">
        <button class="cc-btn-white" id="cc-sel-all" aria-label="${t('select_all')}">${t('select_all')}</button>
        <button class="cc-btn-white" id="cc-next" aria-label="${t('next')}">${t('next')}</button>
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
    if (btn) btn.textContent = allChecked ? t('unselect_all') : t('select_all');
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
  setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 3);
  renderProgress(t('progress_generating'));
  try {
    // mark background building so UI can resume progress on reopen
    await B.saveVideoData(currentState.videoId, { building: true });
    const context = buildContextForSelected(currentState.subtitlesText, currentState.selected, currentState.captionLang, 2);
    const resp = await B.llmCall('second', { selected: currentState.selected, captionLang: currentState.captionLang, context });
    currentState.cards = resp.cards || [];
    // 初次生成写入 createdAt（如果尚未存在）
    const saved = await B.loadVideoData(currentState.videoId) || {};
    const createdAt = saved.createdAt || formatDateYYYYMMDD(new Date());
    await B.saveVideoData(currentState.videoId, { cards: currentState.cards, createdAt, building: false });
    renderLearnView();
  } catch (e) {
    currentState.error = String(e?.message || e);
    try { await B.saveVideoData(currentState.videoId, { building: false }); } catch {}
    renderError(t('error_llm2'), currentState.error);
  }
}

function startBuildWatcher() {
  try { if (buildWatchTimer) { clearInterval(buildWatchTimer); buildWatchTimer = null; } } catch {}
  buildWatchTimer = setInterval(async () => {
    if (!modalOpen) return; // if closed, we will clear on close
    try {
      const saved = await B.loadVideoData(currentState.videoId);
      if (saved && saved.cards && saved.cards.length) {
        clearInterval(buildWatchTimer);
        buildWatchTimer = null;
        currentState.cards = saved.cards;
        renderLearnView();
        setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 3);
      }
    } catch {}
  }, 1500);
}

function startSelectWatcher() {
  try { if (selectWatchTimer) { clearInterval(selectWatchTimer); selectWatchTimer = null; } } catch {}
  selectWatchTimer = setInterval(async () => {
    if (!modalOpen) return;
    try {
      const saved = await B.loadVideoData(currentState.videoId);
      if (saved && Array.isArray(saved.candidates) && saved.candidates.length) {
        clearInterval(selectWatchTimer);
        selectWatchTimer = null;
        currentState.candidates = saved.candidates;
        hideCenterOverlay();
        setStep([t('steps_extract'), t('steps_filter'), t('steps_build')], 2);
        renderSelection();
      }
    } catch {}
  }, 1200);
}

function renderLearnView() {
  hideCenterOverlay();
  const content = uiRoot.querySelector('#cc-content');
  const cards = currentState.cards || [];
  if (!cards.length) {
    content.innerHTML = '<div class="cc-card">' + t('empty_no_cards') + '</div>';
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
        const pron = formatPronunciationMeta(c, currentState.captionLang);
        const meta = [pron, c.pos ? escapeHtml(c.pos) : '']
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
    updateFavButtonActive();
  };

  doRender();
}

function renderCardView(card) {
  const c = { term: '', ipa: '', pos: '', definition: '', examples: [], notes: '', ...card };
  const pron = formatPronunciationMeta(c, currentState.captionLang);
  const examplesHtml = renderExamplesQuoteEx(c.examples || []);
  return `
    <div class="cc-view">
      <div class="term">${escapeHtml(c.term)}</div>
      <div class="meta">${pron ? `${pron}` : ''} ${c.pos ? `· ${escapeHtml(c.pos)}` : ''}</div>
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
      <label>${t('card_field_term')}</label><input class="cc-input" id="cc-term" value="${escapeAttr(c.term)}"/>
      <label>${t('card_field_ipa')}</label><input class="cc-input" id="cc-ipa" value="${escapeAttr(c.ipa)}"/>
      <label>${t('card_field_pos')}</label><input class="cc-input" id="cc-pos" value="${escapeAttr(c.pos)}"/>
      <label>${t('card_field_definition')}</label><input class="cc-input" id="cc-def" value="${escapeAttr(c.definition)}"/>
      <label>${t('card_field_examples')}</label><textarea class="cc-input ex" id="cc-ex" rows="6">${escapeHtml((c.examples||[]).join('\n\n'))}</textarea>
      <label>${t('card_field_notes')}</label><textarea class="cc-input notes" id="cc-notes" rows="4">${escapeHtml(c.notes||'')}</textarea>
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

function normalizeLang(code) {
  if (!code) return 'und';
  const c = String(code).toLowerCase().replace('_','-');
  if (c.startsWith('en')) return 'en';
  if (c.startsWith('zh-cn') || c === 'zh-hans' || c === 'zh') return 'zh_CN';
  if (c.startsWith('zh-tw') || c === 'zh-hant') return 'zh_TW';
  if (c.startsWith('ja')) return 'ja';
  if (c.startsWith('ko')) return 'ko';
  if (c.startsWith('ru')) return 'ru';
  if (c.startsWith('fr')) return 'fr';
  if (c.startsWith('de')) return 'de';
  if (c.startsWith('es')) return 'es';
  return c;
}

function formatPronunciation(raw, captionLang) {
  const v = (raw || '').trim();
  if (!v) return '';
  const clean = formatIpa(v);
  const lang = normalizeLang(captionLang);
  // Add slashes for IPA languages; keep raw for zh/ja/ko and unknowns
  if (lang === 'en' || lang === 'ru' || lang === 'fr' || lang === 'de' || lang === 'es') {
    return '/' + escapeHtml(clean) + '/';
  }
  return escapeHtml(clean);
}

// For English, show both US/UK if available; otherwise fall back to single ipa.
function formatPronunciationMeta(card, captionLang) {
  const lang = normalizeLang(captionLang);
  if (lang === 'en') {
    const us = (card.ipa_us || '').trim();
    const uk = (card.ipa_uk || '').trim();
    const parts = [];
    if (us) parts.push('US: ' + '/' + escapeHtml(formatIpa(us)) + '/');
    if (uk) parts.push('UK: ' + '/' + escapeHtml(formatIpa(uk)) + '/');
    if (parts.length) return parts.join(' · ');
    return formatPronunciation(card.ipa || '', captionLang);
  }
  return formatPronunciation(card.ipa || '', captionLang);
}

// Enhanced examples renderer supporting pronunciation line for non-English sources
function renderExamplesQuoteEx(list) {
  if (!list || !list.length) return '';
  const srcLang = normalizeLang(currentState.captionLang);
  const blocks = list.slice(0, 2).map(raw => {
    const lines = String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const l1 = lines[0] || '';
    if (srcLang !== 'en') {
      const l2 = lines[1] || '';
      const l3 = lines[2] || '';
      return `<blockquote><div>${escapeHtml(l1)}</div>${l2 ? `<div class="cc-small">${escapeHtml(l2)}</div>` : ''}${l3 ? `<div class="cc-small">${escapeHtml(l3)}</div>` : ''}</blockquote>`;
    }
    const l2 = lines[1] || '';
    return `<blockquote><div>${escapeHtml(l1)}</div>${l2 ? `<div class="cc-small">${escapeHtml(l2)}</div>` : ''}</blockquote>`;
  }).join('');
  return `<div class="examples-quote">${blocks}</div>`;
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
  const rows = [['term', 'ipa', 'ipa_us', 'ipa_uk', 'pos', 'definition', 'notes', 'examples']]
    .concat(cards.map(c => {
      const examples = (c.examples || []).join('\n\n');
      return [c.term||'', c.ipa||'', c.ipa_us||'', c.ipa_uk||'', c.pos||'', c.definition||'', c.notes||'', examples];
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

// Sample a long transcript to a target character budget by uniform line downsampling
function sampleTranscript(text, targetChars = 12000) {
  try {
    if (!text || text.length <= targetChars) return text || '';
    const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return String(text).slice(0, targetChars);
    // Compute stride to roughly meet budget
    const avgLen = Math.max(1, Math.floor((text.length / lines.length)));
    const approxKeep = Math.max(1, Math.floor(targetChars / avgLen));
    const stride = Math.max(1, Math.ceil(lines.length / approxKeep));
    const sampled = [];
    for (let i = 0; i < lines.length; i += stride) sampled.push(lines[i]);
    // Ensure we at least include head/tail
    if (sampled[0] !== lines[0]) sampled.unshift(lines[0]);
    if (sampled[sampled.length - 1] !== lines[lines.length - 1]) sampled.push(lines[lines.length - 1]);
    let out = sampled.join('\n');
    if (out.length > targetChars) out = out.slice(0, targetChars);
    return out;
  } catch {
    return String(text || '').slice(0, targetChars);
  }
}

// Build brief transcript evidence for each selected term to guide definitions
function buildContextForSelected(text, selected, captionLang, maxPerTerm = 2) {
  try {
    const list = Array.isArray(selected) ? selected : [];
    const raw = String(text || '');
    if (!raw || !list.length) return [];
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const lang = normalizeLang(captionLang);
    const isLatin = (lang === 'en' || lang === 'fr' || lang === 'de' || lang === 'es' || lang === 'ru');
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const clip = (line, term) => {
      const s = String(line);
      if (s.length <= 160) return s;
      let idx = -1;
      try { idx = s.toLowerCase().indexOf(String(term || '').toLowerCase()); } catch {}
      if (idx < 0) idx = Math.floor(s.length / 2);
      const start = Math.max(0, idx - 60);
      const end = Math.min(s.length, start + 160);
      const head = start > 0 ? '…' : '';
      const tail = end < s.length ? '…' : '';
      return head + s.slice(start, end).trim() + tail;
    };
    return list.map(it => {
      const term = String(it && it.term || '').trim();
      if (!term) return { term, lines: [] };
      let re = null;
      if (isLatin) re = new RegExp(`(^|[^A-Za-z0-9])${esc(term)}([^A-Za-z0-9]|$)`, 'i');
      const hits = [];
      for (const ln of lines) {
        if (hits.length >= maxPerTerm) break;
        const ok = isLatin ? re.test(ln) : ln.includes(term);
        if (ok) hits.push(clip(ln, term));
      }
      return { term, lines: hits };
    });
  } catch { return []; }
}

function renderOnboarding() {
  const content = uiRoot.querySelector('#cc-content');
  content.innerHTML = `
    <div class="cc-card">
      <div class="cc-setup-title"><b>${t('onboarding_title')}</b></div>
      <p class="cc-small cc-setup-desc">${t('onboarding_desc')}</p>
      <div class="cc-controls">
        <button class="cc-btn-white" id="cc-open-settings">${t('onboarding_open_settings')}</button>
        <button class="cc-btn-white" id="cc-continue">${t('onboarding_continue')}</button>
      </div>
    </div>
  `;
  updateBottomControls();
  content.querySelector('#cc-open-settings')?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CC_OPEN_OPTIONS' }));
  content.querySelector('#cc-continue')?.addEventListener('click', async () => {
    const s = await B.getSettings();
    if (!s.apiKey) {
      alert(t('alert_missing_api_key'));
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

async function toggleFavoriteCurrentCard() {
  const key = 'CCAPTIPREPS:fav:words';
  const data = await chrome.storage.local.get(key);
  let list = Array.isArray(data[key]) ? data[key] : [];
  const exists = list.some(it => it && it.videoId === currentState.videoId && it.cardIndex === currentCardIndex);
  if (exists) {
    list = list.filter(it => !(it && it.videoId === currentState.videoId && it.cardIndex === currentCardIndex));
    await chrome.storage.local.set({ [key]: list });
    return false;
  } else {
    const snapshot = (currentState.cards || [])[currentCardIndex];
    const item = { videoId: currentState.videoId, title: currentState.title, cardIndex: currentCardIndex, snapshot, savedAt: new Date().toISOString() };
    list.push(item);
    await chrome.storage.local.set({ [key]: list });
    return true;
  }
}

function blurActiveMiniButtons(){
  try {
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('cc-mini-btn')) active.blur();
  } catch {}
}

async function updateFavButtonActive() {
  try {
    const btn = uiRoot && uiRoot.querySelector('#cc-b-fav');
    if (!btn || ccGridMode || !(currentState.cards || []).length) return;
    const key = 'CCAPTIPREPS:fav:words';
    const data = await chrome.storage.local.get(key);
    const list = Array.isArray(data[key]) ? data[key] : [];
    const isFav = list.some(it => it && it.videoId === currentState.videoId && it.cardIndex === currentCardIndex);
    btn.classList.toggle('active', !!isFav);
  } catch {}
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
