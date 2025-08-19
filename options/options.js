const DEFAULTS = {
  provider: 'gemini',
  baseUrl: '',
  apiKey: '',
  model: 'gemini-2.5-flash',
  modelFirst: 'gemini-2.5-flash',
  modelSecond: 'gemini-2.5-flash',
  accent: 'us',
  glossLang: 'en'
};

let cachedModels = [];
let saveTimer = null;
let saving = false;

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  if (!s.modelFirst) s.modelFirst = s.model;
  if (!s.modelSecond) s.modelSecond = s.model;

  document.getElementById('provider').value = s.provider;
  document.getElementById('baseUrl').value = s.baseUrl || '';
  document.getElementById('apiKey').value = s.apiKey || '';
  // Accent radios
  const radios = document.querySelectorAll('input[name="accent"]');
  let set = false; radios.forEach(r => { if (r.value === (s.accent || 'us')) { r.checked = true; set = true; } });
  if (!set) { const us = document.querySelector('input[name="accent"][value="us"]'); if (us) us.checked = true; }

  // GlossLang radios
  const glossRadios = document.querySelectorAll('input[name="glossLang"]');
  let gset = false; glossRadios.forEach(r => { if (r.value === (s.glossLang || 'en')) { r.checked = true; gset = true; } });
  if (!gset) { const en = document.querySelector('input[name="glossLang"][value="en"]'); if (en) en.checked = true; }

  document.getElementById('modelFirst').value = s.modelFirst || '';
  document.getElementById('modelSecond').value = s.modelSecond || '';

  wireAutosave();
}

function getFormSettings() {
  const radios = document.querySelectorAll('input[name="accent"]:checked');
  const accent = radios.length ? radios[0].value : 'us';
  const glossSel = document.querySelectorAll('input[name="glossLang"]:checked');
  const glossLang = glossSel.length ? glossSel[0].value : 'en';
  return {
    provider: document.getElementById('provider').value,
    baseUrl: document.getElementById('baseUrl').value.trim(),
    model: document.getElementById('modelFirst').value.trim() || document.getElementById('modelSecond').value.trim(),
    modelFirst: document.getElementById('modelFirst').value.trim(),
    modelSecond: document.getElementById('modelSecond').value.trim(),
    apiKey: document.getElementById('apiKey').value.trim(),
    accent,
    glossLang
  };
}

async function save(now = false) {
  const s = getFormSettings();
  const status = document.getElementById('saveStatus');
  const doSave = async () => {
    saving = true;
    status.textContent = 'Saving…';
    await chrome.storage.local.set({ settings: s });
    saving = false;
    status.textContent = 'Saved ✅';
    setTimeout(() => { if (!saving) status.textContent = ''; }, 1800);
  };
  if (now) return doSave();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 400);
}

function wireAutosave() {
  const ids = ['provider','baseUrl','apiKey','modelFirst','modelSecond'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, () => save(false));
  });
  // Accent radios
  document.querySelectorAll('input[name="accent"]').forEach(r => r.addEventListener('change', () => save(false)));
  // GlossLang radios
  document.querySelectorAll('input[name="glossLang"]').forEach(r => r.addEventListener('change', () => save(false)));
}

function flashStatus(msg) {
  const el = document.getElementById('saveStatus');
  el.textContent = msg;
  setTimeout(() => el.textContent = '', 2000);
}

async function fetchModels() {
  const { provider, baseUrl, apiKey } = getFormSettings();
  flashStatus('Fetching models…');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CC_LIST_MODELS', override: { provider, baseUrl, apiKey } });
    if (!resp || !resp.ok) throw new Error(resp && resp.error || 'Unknown error');
    cachedModels = Array.from(new Set((resp.models || []).filter(Boolean)));
    flashStatus(`Loaded ${cachedModels.length} models`);
  } catch (e) {
    flashStatus('Fetch models failed: ' + (e && e.message || e));
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
  flashStatus('Testing…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CC_TEST_LLM', override: { provider, baseUrl, model: modelValue, apiKey } });
    if (res && res.ok) flashStatus('Test OK'); else flashStatus('Test failed: ' + (res && res.error || 'Unknown'));
  } catch (e) {
    flashStatus('Test error: ' + (e && e.message || e));
  }
}

function wirePerModelTests() {
  document.getElementById('testFirst')?.addEventListener('click', () => testModel(document.getElementById('modelFirst').value.trim()));
  document.getElementById('testSecond')?.addEventListener('click', () => testModel(document.getElementById('modelSecond').value.trim()));
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  document.getElementById('save')?.addEventListener('click', () => save(true));
  document.getElementById('fetchModels')?.addEventListener('click', fetchModels);
  attachSuggest('modelFirst', 'modelFirstSuggest');
  attachSuggest('modelSecond', 'modelSecondSuggest');
  wirePerModelTests();
});
