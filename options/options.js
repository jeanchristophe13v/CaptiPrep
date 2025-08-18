const DEFAULTS = {
  provider: 'gemini',
  baseUrl: '',
  apiKey: '',
  model: 'gemini-2.5-flash',
  accent: 'us'
};

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  document.getElementById('provider').value = s.provider;
  document.getElementById('baseUrl').value = s.baseUrl || '';
  document.getElementById('model').value = s.model || '';
  document.getElementById('apiKey').value = s.apiKey || '';
  document.getElementById('accent').value = s.accent || 'us';
}

async function save() {
  const s = {
    provider: document.getElementById('provider').value,
    baseUrl: document.getElementById('baseUrl').value.trim(),
    model: document.getElementById('model').value.trim(),
    apiKey: document.getElementById('apiKey').value.trim(),
    accent: document.getElementById('accent').value
  };
  await chrome.storage.local.set({ settings: s });
  const el = document.getElementById('status');
  el.textContent = 'Saved';
  setTimeout(() => el.textContent = '', 1500);
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('test').addEventListener('click', test);
});

async function test() {
  const override = {
    provider: document.getElementById('provider').value,
    baseUrl: document.getElementById('baseUrl').value.trim(),
    model: document.getElementById('model').value.trim(),
    apiKey: document.getElementById('apiKey').value.trim(),
  };
  const status = document.getElementById('status');
  status.textContent = 'Testing…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CC_TEST_LLM', override });
    if (res && res.ok) {
      status.textContent = 'Test OK';
    } else {
      status.textContent = 'Test failed: ' + (res && res.error || 'Unknown');
    }
  } catch (e) {
    status.textContent = 'Test error: ' + (e && e.message || e);
  }
  setTimeout(() => status.textContent = '', 3000);
}
