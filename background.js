// Background service worker (MV3, ESM)

// Default settings
const DEFAULT_SETTINGS = {
  provider: 'gemini',
  baseUrl: '', // will derive by provider
  apiKey: '',
  model: 'gemini-2.5-flash',
  // New: allow different models per role (fallback to `model`)
  modelFirst: 'gemini-2.5-flash-lite-preview-06-17',
  modelSecond: 'gemini-2.5-flash',
  accent: 'us', // 'us' or 'uk'
  // New: definition/notes language for cards ('en' | 'zh')
  glossLang: 'en'
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(next) {
  await chrome.storage.local.set({ settings: next });
}

// Ensure defaults exist once installed
chrome.runtime.onInstalled.addListener(async (details) => {
  const s = await getSettings();
  await setSettings(s);
  // Only open options page on first install, not on every update/reload
  if (details.reason === 'install' && !s.apiKey) {
    try { await chrome.runtime.openOptionsPage(); } catch (e) {}
  }
});

// Open modal in the active tab when the action is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'CC_TOGGLE_MODAL' });
  } catch (e) {
    // Content script may not be injected for this tab state; try to inject then send
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'CC_TOGGLE_MODAL' });
    } catch (err) {
      console.error('Failed to open modal:', err);
    }
  }
});

// Generic LLM call routing
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'CC_LLM_CALL') {
    (async () => {
      try {
        const result = await handleLLMCall(msg.payload);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true; // keep channel open for async
  }
  if (msg && msg.type === 'CC_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        console.warn('openOptionsPage failed:', chrome.runtime.lastError.message);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg && msg.type === 'CC_GET_SETTINGS') {
    (async () => {
      const s = await getSettings();
      sendResponse({ ok: true, settings: s });
    })();
    return true;
  }
  if (msg && msg.type === 'CC_TEST_LLM') {
    (async () => {
      try {
        const override = msg.override || {};
        const settings = { ...(await getSettings()), ...override };
        const { provider, baseUrl, apiKey } = settings;
        if (!apiKey) throw new Error('API key missing');
        // Prefer modelFirst > model > modelSecond for test
        const model = override.model || settings.modelFirst || settings.model || settings.modelSecond;
        const text = await callProvider({ provider, baseUrl, apiKey, model, prompt: 'Return this exact JSON: {"ok":true}', temperature: 0, topP: 1 });
        let ok = false;
        try {
          const jsonStr = extractJson(text);
          const parsed = JSON.parse(jsonStr);
          ok = parsed && parsed.ok === true;
        } catch {}
        if (!ok) throw new Error('Unexpected response: ' + (text || '(empty)'));
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'CC_LIST_MODELS') {
    (async () => {
      try {
        const override = msg.override || {};
        const s = await getSettings();
        const provider = (override.provider || s.provider || '').toLowerCase();
        const baseUrl = (override.baseUrl ?? s.baseUrl ?? '').trim();
        const apiKey = (override.apiKey ?? s.apiKey ?? '').trim();
        const list = await listModels({ provider, baseUrl, apiKey });
        sendResponse({ ok: true, models: list });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});

async function handleLLMCall(payload) {
  const settings = await getSettings();
  const { role, data } = payload; // role: 'first'|'second'

  const { provider, baseUrl, apiKey, accent, glossLang } = settings;
  if (!apiKey) throw new Error('Missing API key in settings');

  const prompts = buildPrompts(role, data, { accent, glossLang });

  // Choose model per role with fallback
  const model = role === 'first'
    ? (settings.modelFirst || settings.model)
    : (settings.modelSecond || settings.model);

  // Sampling per role
  const temperature = role === 'first' ? 0 : 0.6;
  const topP = 1;

  const text = await callProvider({ provider, baseUrl, apiKey, model, prompt: prompts.prompt, temperature, topP });
  // Expect JSON in text; try to parse
  let parsed;
  try {
    const jsonStr = extractJson(text);
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('LLM returned non-JSON or invalid JSON. Raw: ' + truncate(text, 800));
  }
  return parsed;
}

function buildPrompts(role, data, opts) {
  const { accent, glossLang } = (opts || {});
  if (role === 'first') {
    const { subtitlesText, maxItems = 60 } = data;
    const system = `You are an expert English vocabulary curator for learners with intermediate+ proficiency. Remove trivial or banal items.`;
    const user = `Task: From the transcript below, extract high-value words and short expressions that are worth deliberate study. Exclude trivial/basic examples such as: apple, orange, banana, I don't know, you know, good morning, how are you, thanks, hello.

Return JSON strictly with this shape:
{
  "items": [ { "term": string, "type": "word"|"phrase", "freq": number } ]
}
Rules:
- Rank by usefulness/frequency in this specific transcript, not general corpora.
- Avoid overly-rare named entities unless broadly useful.
- Prefer multi-word expressions if they are idiomatic or hard to translate.
- freq is a rough integer frequency count or weight.
- Limit items to about ${maxItems}.

Transcript (English, lightly noisy, do minimal normalization to understand):\n\n${subtitlesText}`;
    return { prompt: composeChat(system, user) };
  } else if (role === 'second') {
    const { selected } = data;
    const accentLabel = accent === 'uk' ? 'British' : 'American';
    const glossLabel = glossLang === 'zh' ? 'Chinese' : 'English';
    const system = `You are a concise English lexicographer. Output clean IPA and succinct meanings.`;

    // Always require two example pairs: English + Chinese translation
    const exampleRule = `Provide exactly 2 example PAIRS per item. For each pair, output a SINGLE STRING value with TWO lines separated by a newline ("\n"):
  line 1: an English sentence (natural, common)
  line 2: the concise Chinese translation of line 1
Do not add bullets, numbering, labels, or extra notes.`;

    const defRule = (glossLang === 'zh')
      ? `Write the "definition" and "notes" in Chinese.`
      : `Write the "definition" and "notes" in English.`;

    const user = `Task: For each item, produce phonetic transcription (IPA, ${accentLabel}), part of speech (in English), a short learner-friendly definition, example sentence(s), and a brief note for meme/culture/common confusions if relevant. Keep it compact.

${defRule}
${exampleRule}

Return JSON strictly with this shape:
{
  "cards": [ {
    "term": string,
    "ipa": string,            // IPA (${accentLabel})
    "pos": string,            // e.g., noun, verb, adj. (in English)
    "definition": string,     // concise learner definition (${glossLabel})
    "examples": string[],     // exactly 2 strings; each string contains two lines: English then Chinese
    "notes": string           // may be empty (${glossLabel})
  } ]
}

Additional formatting rules:
- Output raw JSON only (no Markdown fences).
- Do not use list markers (-, *, 1.) inside strings.
- Keep IPA clean without slashes.

Items:\n${selected.map((t, i) => `${i + 1}. ${t.term}`).join('\n')}`;
    return { prompt: composeChat(system, user) };
  }
  throw new Error('Unknown role');
}

function composeChat(system, user) {
  // Provider adapters will wrap into their specific schema. Here we merge as a single text.
  return `SYSTEM:\n${system}\n\nUSER:\n${user}`;
}

async function callProvider({ provider, baseUrl, apiKey, model, prompt, temperature, topP }) {
  const p = provider.toLowerCase();
  if (p === 'gemini' || p === 'google') {
    const url = (baseUrl && baseUrl.trim()) || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [ { role: 'user', parts: [ { text: prompt } ] } ],
      generationConfig: {
        temperature: typeof temperature === 'number' ? temperature : undefined,
        topP: typeof topP === 'number' ? topP : undefined
      }
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n')) || '';
    return text;
  }
  if (p === 'openai' || p === 'openai-compatible') {
    const url = (baseUrl && baseUrl.trim()) || 'https://api.openai.com/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: prompt }
        ],
        temperature: typeof temperature === 'number' ? temperature : undefined,
        top_p: typeof topP === 'number' ? topP : undefined
      })
    });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
  if (p === 'claude' || p === 'anthropic') {
    const url = (baseUrl && baseUrl.trim()) || 'https://api.anthropic.com/v1/messages';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature: typeof temperature === 'number' ? temperature : undefined,
        top_p: typeof topP === 'number' ? topP : undefined,
        messages: [ { role: 'user', content: prompt } ]
      })
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const content = data.content?.[0]?.text || '';
    return content;
  }
  if (p === 'openrouter') {
    const url = (baseUrl && baseUrl.trim()) || 'https://openrouter.ai/api/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [ { role: 'user', content: prompt } ],
        temperature: typeof temperature === 'number' ? temperature : undefined,
        top_p: typeof topP === 'number' ? topP : undefined
      })
    });
    if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
  throw new Error('Unsupported provider: ' + provider);
}

async function listModels({ provider, baseUrl, apiKey }) {
  const p = (provider || '').toLowerCase();
  if (p === 'openai' || p === 'openai-compatible') {
    const url = (baseUrl && baseUrl.trim()) || 'https://api.openai.com/v1/models';
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`OpenAI list models error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const ids = (data.data || []).map(m => m.id).filter(Boolean);
    return ids;
  }
  if (p === 'claude' || p === 'anthropic') {
    const url = (baseUrl && baseUrl.trim()) || 'https://api.anthropic.com/v1/models';
    const res = await fetch(url, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw new Error(`Anthropic list models error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const ids = (data.data || []).map(m => m.id || m.name || m.slug).filter(Boolean);
    return ids;
  }
  if (p === 'openrouter') {
    const url = (baseUrl && baseUrl.trim()) || 'https://openrouter.ai/api/v1/models';
    const headers = { };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`OpenRouter list models error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const ids = (data.data || []).map(m => m.id || m.name || m.slug).filter(Boolean);
    return ids;
  }
  if (p === 'gemini' || p === 'google') {
    const base = (baseUrl && baseUrl.trim()) || 'https://generativelanguage.googleapis.com/v1beta/models';
    const url = apiKey ? `${base}?key=${encodeURIComponent(apiKey)}` : base;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gemini list models error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const names = (data.models || []).map(m => m.name).filter(Boolean);
    // Normalize: strip leading 'models/' to match generateContent path piece we expect
    const ids = names.map(n => n.replace(/^models\//, ''));
    return ids;
  }
  throw new Error('Unsupported provider for model listing: ' + provider);
}

function extractJson(text) {
  // Try to find the first {...} or [{...}] JSON block
  const match = text.match(/[\{\[][\s\S]*[\}\]]/);
  return match ? match[0] : text;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
