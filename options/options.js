let __i18nDict = null;
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

const DEFAULTS = {
  provider: 'gemini',
  baseUrl: '',
  apiKey: '',
  model: 'gemini-2.5-flash',
  modelFirst: 'gemini-2.5-flash-lite-preview-06-17',
  modelSecond: 'gemini-2.5-flash',
  glossLang: 'auto',
  uiLang: 'auto'
};

let cachedModels = [];
let saveTimer = null;
let saving = false;

// Per-provider profiles persisted in storage
let PROFILES = {}; // { [provider]: { apiKey, baseUrl, modelFirst, modelSecond } }
let CURRENT_PROVIDER = 'gemini';

async function load() {
  const store = await chrome.storage.local.get(['settings', 'settingsProfiles']);
  const s = { ...DEFAULTS, ...(store.settings || {}) };

  // Migrate or init profiles
  PROFILES = store.settingsProfiles || {};
  if (!Object.keys(PROFILES).length) {
    const p = s.provider || 'gemini';
    PROFILES[p] = {
      apiKey: s.apiKey || '',
      baseUrl: s.baseUrl || '',
      modelFirst: s.modelFirst || (p === 'gemini' ? DEFAULTS.modelFirst : ''),
      modelSecond: s.modelSecond || (p === 'gemini' ? DEFAULTS.modelSecond : '')
    };
    await chrome.storage.local.set({ settingsProfiles: PROFILES });
  }

  CURRENT_PROVIDER = s.provider || 'gemini';

  // UI: provider & global options
  document.getElementById('provider').value = CURRENT_PROVIDER;
  document.getElementById('baseUrl').value = '';
  document.getElementById('apiKey').value = '';
  // UI language select
  const uiLangSel = document.getElementById('uiLang');
  if (uiLangSel) {
    let v = s.uiLang || 'auto';
    const has = Array.from(uiLangSel.options).some(o => o.value === v);
    uiLangSel.value = has ? v : 'auto';
  }

  // Accent removed: UI now shows both US/UK for English

  // GlossLang select (default from browser when 'auto')
  const glossSelEl = document.getElementById('glossLang');
  if (glossSelEl) {
    let glossValue = s.glossLang || 'auto';
    if (glossValue === 'auto') {
      const ui = (chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') ? chrome.i18n.getUILanguage() : (navigator.language || 'en');
      glossValue = mapUiToGloss(ui);
    }
    const has = Array.from(glossSelEl.options).some(o => o.value === glossValue);
    glossSelEl.value = has ? glossValue : 'en';
  }

  // Apply active provider profile (with Gemini defaults only)
  applyProfileToForm(getActiveProfile(CURRENT_PROVIDER, true));

  wireAutosave();
  wireProviderSwitch();
  wirePerModelTests();
  // re-apply i18n with override if selected
  try { await applyUiLangOverride(); } catch {}
}

function getActiveProfile(provider, withDefaults = false) {
  const p = provider || CURRENT_PROVIDER || 'gemini';
  const prof = { ...(PROFILES[p] || {}) };
  if (withDefaults && p === 'gemini') {
    if (!prof.modelFirst) prof.modelFirst = DEFAULTS.modelFirst;
    if (!prof.modelSecond) prof.modelSecond = DEFAULTS.modelSecond;
  }
  // Ensure fields
  return {
    apiKey: prof.apiKey || '',
    baseUrl: prof.baseUrl || '',
    modelFirst: prof.modelFirst || '',
    modelSecond: prof.modelSecond || ''
  };
}

function applyProfileToForm(prof) {
  document.getElementById('baseUrl').value = prof.baseUrl || '';
  document.getElementById('apiKey').value = prof.apiKey || '';
  document.getElementById('modelFirst').value = prof.modelFirst || '';
  document.getElementById('modelSecond').value = prof.modelSecond || '';
}

function collectProfileFromForm() {
  return {
    baseUrl: document.getElementById('baseUrl').value.trim(),
    apiKey: document.getElementById('apiKey').value.trim(),
    modelFirst: document.getElementById('modelFirst').value.trim(),
    modelSecond: document.getElementById('modelSecond').value.trim()
  };
}

function getFormSettings() {
  const glossSelEl2 = document.getElementById('glossLang');
  const glossLang = glossSelEl2 ? glossSelEl2.value : 'en';

  const prof = collectProfileFromForm();
  const model = prof.modelFirst || prof.modelSecond || '';
  return {
    provider: CURRENT_PROVIDER,
    baseUrl: prof.baseUrl,
    model,
    modelFirst: prof.modelFirst,
    modelSecond: prof.modelSecond,
    apiKey: prof.apiKey,
    glossLang,
    uiLang: (document.getElementById('uiLang')?.value || 'auto')
  };
}

async function save(now = false) {
  const s = getFormSettings();
  const status = document.getElementById('saveStatus');
  const doSave = async () => {
    saving = true;
    status.textContent = t('status_saving');

    // Update in-memory profile and persist profiles + flattened current settings
    PROFILES[CURRENT_PROVIDER] = { ...PROFILES[CURRENT_PROVIDER], ...collectProfileFromForm() };

    await chrome.storage.local.set({
      settingsProfiles: PROFILES,
      settings: s // keep legacy flattened for background
    });

    saving = false;
    status.textContent = t('status_saved');
    setTimeout(() => { if (!saving) status.textContent = ''; }, 1800);
  };
  if (now) return doSave();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 400);
}

function wireAutosave() {
  const ids = ['provider','baseUrl','apiKey','modelFirst','modelSecond','uiLang','glossLang'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, async () => {
      if (id === 'uiLang') {
        try { await applyUiLangOverride(); } catch {}
        await save(false);
      } else {
        await save(false);
      }
    });
  });
  // Accent removed
}

function wireProviderSwitch() {
  const sel = document.getElementById('provider');
  if (!sel) return;
  sel.addEventListener('change', async () => {
    CURRENT_PROVIDER = sel.value;
    // When switching, apply stored profile; Gemini gets defaults if empty
    applyProfileToForm(getActiveProfile(CURRENT_PROVIDER, true));
    // Save provider selection immediately (profiles unchanged yet)
    await save(true);
  });
}

function flashStatus(msg) {
  const el = document.getElementById('saveStatus');
  el.textContent = msg;
  setTimeout(() => el.textContent = '', 2000);
}

async function fetchModels() {
  const { provider, baseUrl, apiKey } = getFormSettings();
  flashStatus(t('status_fetching_models'));
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CC_LIST_MODELS', override: { provider, baseUrl, apiKey } });
    if (!resp || !resp.ok) throw new Error(resp && resp.error || 'Unknown error');
    cachedModels = Array.from(new Set((resp.models || []).filter(Boolean)));
    flashStatus(t('status_loaded_models', String(cachedModels.length)));
  } catch (e) {
    flashStatus(t('status_fetch_models_failed', (e && e.message) || String(e)));
  }
}

function attachSuggest(inputId, suggestId) {
  const input = document.getElementById(inputId);
  const sug = document.getElementById(suggestId);
  let activeIdx = -1;

  const close = () => { sug.hidden = true; sug.innerHTML = ''; activeIdx = -1; };
  const open = () => { if (sug.innerHTML) sug.hidden = false; };
  const render = (list) => {
    if (!list || !list.length) { close(); return; }
    sug.innerHTML = list.map((m, i) => `<div class="item${i===activeIdx?' active':''}" data-i="${i}">${m}</div>`).join('');
    open();
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    const list = !q ? cachedModels.slice(0, 50) : cachedModels.filter(m => m.toLowerCase().includes(q)).slice(0, 50);
    render(list);
  };

  input.addEventListener('focus', filter);
  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (sug.hidden) return;
    const items = Array.from(sug.querySelectorAll('.item'));
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(items.length - 1, activeIdx + 1); items.forEach((n,i)=>n.classList.toggle('active', i===activeIdx)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); items.forEach((n,i)=>n.classList.toggle('active', i===activeIdx)); return; }
    if (e.key === 'Enter') {
      if (activeIdx >= 0 && items[activeIdx]) { input.value = items[activeIdx].textContent; }
      close();
      save(false);
      return;
    }
    if (e.key === 'Escape') { close(); return; }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  sug.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    input.value = item.textContent;
    close();
    save(false);
  });
}

async function testModel(modelValue) {
  const { provider, baseUrl, apiKey } = getFormSettings();
  flashStatus(t('status_testing'));
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CC_TEST_LLM', override: { provider, baseUrl, model: modelValue, apiKey } });
    if (res && res.ok) flashStatus(t('status_test_ok')); else flashStatus(t('status_test_failed', (res && res.error) || 'Unknown'));
  } catch (e) {
    flashStatus(t('status_test_error', (e && e.message) || String(e)));
  }
}

function wirePerModelTests() {
  document.getElementById('testFirst')?.addEventListener('click', () => testModel(document.getElementById('modelFirst').value.trim()));
  document.getElementById('testSecond')?.addEventListener('click', () => testModel(document.getElementById('modelSecond').value.trim()));
}

function updateApiKeyIcon() {
  const input = document.getElementById('apiKey');
  const icon = document.getElementById('apiKeyEye');
  if (!input || !icon) return;
  const show = input.type === 'password'; // hidden -> show eye open
  const path = icon.querySelector('path');
  if (!path) return;
  const EYE_OPEN = "M12 5c-5 0-9 4-10 7 1 3 5 7 10 7s9-4 10-7c-1-3-5-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z";
  const EYE_OFF = "M3 4.27 4.28 3 21 19.72 19.73 21l-2.25-2.25C15.9 19.24 14 20 12 20 7 20 3 16 2 13c.46-1.39 1.57-3.06 3.14-4.55L3 6.73 4.27 5.5 6.1 7.33A11.9 11.9 0 0 1 12 6c5 0 9 4 10 7-.44 1.33-1.47 2.94-2.95 4.42L15.5 13.9A5 5 0 0 0 10.1 8.5L7.73 6.12 6.5 7.35l2.15 2.15A5 5 0 0 0 8 12a5 5 0 0 0 5 5c.5 0 .98-.07 1.43-.21l1.57 1.57L15.73 19 3 6.27V4.27z";
  path.setAttribute('d', show ? EYE_OPEN : EYE_OFF);
  icon.removeAttribute('title'); // no hover label
  icon.setAttribute('aria-label', show ? t('options_show_api_key') : t('options_hide_api_key'));
}

function wireApiKeyToggle() {
  const input = document.getElementById('apiKey');
  const icon = document.getElementById('apiKeyEye');
  if (!input || !icon) return;
  updateApiKeyIcon();
  const toggle = (e) => {
    if (e) e.preventDefault();
    input.type = input.type === 'password' ? 'text' : 'password';
    updateApiKeyIcon();
  };
  // Prevent focus on mouse/touch to avoid persistent blue ring
  icon.addEventListener('pointerdown', (e) => { try { e.preventDefault(); } catch {} });
  icon.addEventListener('mousedown', (e) => { try { e.preventDefault(); } catch {} });
  icon.addEventListener('click', toggle);
  icon.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') toggle(e);
  });
}

function applyI18nPlaceholders(root = document, dict) {
  const getMsg = (raw) => {
    const m = /^__MSG_([A-Za-z0-9_]+)__$/.exec(raw || '');
    if (!m) return null;
    const key = m[1];
    let v = null;
    if (dict && dict[key]) v = dict[key];
    else v = (chrome.i18n && chrome.i18n.getMessage) ? chrome.i18n.getMessage(key) : '';
    return v || null;
  };
  const byKey = (key) => {
    if (!key) return '';
    if (dict && dict[key]) return dict[key];
    return (chrome.i18n && chrome.i18n.getMessage) ? chrome.i18n.getMessage(key) : '';
  };
  // Attributes
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const all = root.querySelectorAll('*');
  all.forEach(el => {
    ATTRS.forEach(attr => {
      if (!el.hasAttribute(attr)) return;
      const raw = el.getAttribute(attr);
      const msg = getMsg(raw);
      if (msg) el.setAttribute(attr, msg);
    });
    // data-i18n -> textContent
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = byKey(key) || el.textContent;
    // data-i18n-* for common attrs
    ['placeholder','title','aria-label'].forEach(a=>{
      const k2 = el.getAttribute('data-i18n-' + a);
      if (k2) el.setAttribute(a, byKey(k2) || el.getAttribute(a) || '');
    });
    // Text nodes: replace when node text is a single MSG token
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent && node.textContent.trim();
        const msg = getMsg(raw);
        if (msg) node.textContent = msg;
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  try { applyI18nPlaceholders(document); } catch {}
  load();
  document.getElementById('save')?.addEventListener('click', () => save(true));
  document.getElementById('fetchModels')?.addEventListener('click', fetchModels);
  attachSuggest('modelFirst', 'modelFirstSuggest');
  attachSuggest('modelSecond', 'modelSecondSuggest');
  wirePerModelTests();
  wireApiKeyToggle();
});

async function loadDict(lang) {
  if (!lang || lang === 'auto') return null;
  const url = chrome.runtime.getURL(`assets/i18n/${lang}.json`);
  try { const res = await fetch(url); if (!res.ok) return null; return await res.json(); } catch { return null; }
}

async function applyUiLangOverride() {
  const sel = document.getElementById('uiLang');
  let lang = sel ? sel.value : 'auto';
  const dict = await loadDict(lang);
  // Re-run placeholder replacement with override dictionary
  __i18nDict = dict || null;
  try { applyI18nPlaceholders(document, dict); } catch {}
  try { if (dict && dict.options_title) document.title = dict.options_title; } catch {}
  // Re-sync API key toggle label after i18n replacement
  try { updateApiKeyIcon(); } catch {}
}

function mapUiToGloss(uiLang) {
  const c = String(uiLang || '').toLowerCase();
  if (c.startsWith('en')) return 'en';
  if (c.startsWith('zh-cn') || c === 'zh-hans' || c === 'zh') return 'zh_CN';
  if (c.startsWith('zh-tw') || c === 'zh-hant') return 'zh_TW';
  if (c.startsWith('ja')) return 'ja';
  if (c.startsWith('ko')) return 'ko';
  if (c.startsWith('ru')) return 'ru';
  if (c.startsWith('fr')) return 'fr';
  if (c.startsWith('de')) return 'de';
  if (c.startsWith('es')) return 'es';
  return 'en';
}
