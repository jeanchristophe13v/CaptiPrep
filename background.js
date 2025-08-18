// Background service worker (MV3, ESM)

// Default settings
const DEFAULT_SETTINGS = {
  provider: 'gemini',
  baseUrl: '', // will derive by provider
  apiKey: '',
  model: 'gemini-2.5-flash',
  accent: 'us' // 'us' or 'uk'
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
        const { provider, baseUrl, apiKey, model } = settings;
        if (!apiKey) throw new Error('API key missing');
        const text = await callProvider({ provider, baseUrl, apiKey, model, prompt: 'Return this exact JSON: {"ok":true}' });
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
});

async function handleLLMCall(payload) {
  const settings = await getSettings();
  const { role, data } = payload; // role: 'first'|'second'

  const { provider, baseUrl, apiKey, model, accent } = settings;
  if (!apiKey) throw new Error('Missing API key in settings');

  const prompts = buildPrompts(role, data, accent);

  const text = await callProvider({ provider, baseUrl, apiKey, model, prompt: prompts.prompt });
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

function buildPrompts(role, data, accent) {
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
    const system = `You are a concise English lexicographer. Output clean IPA and succinct meanings.`;
    const user = `Task: For each item, produce phonetic transcription (IPA, ${accentLabel}), part of speech, a short learner-friendly definition, 1-2 example sentences (prefer common, you may adapt from everyday usage), and a brief note for meme/culture/common confusions if relevant. Keep it compact.

Return JSON strictly with this shape:
{
  "cards": [ {
    "term": string,
    "ipa": string,            // IPA (${accentLabel})
    "pos": string,            // e.g., noun, verb, adj.
    "definition": string,     // concise learner definition
    "examples": string[],     // 1-2 examples
    "notes": string           // may be empty
  } ]
}

Items:\n${selected.map((t, i) => `${i + 1}. ${t.term}`).join('\n')}`;
    return { prompt: composeChat(system, user) };
  }
  throw new Error('Unknown role');
}

function composeChat(system, user) {
  // Provider adapters will wrap into their specific schema. Here we merge as a single text.
  return `SYSTEM:\n${system}\n\nUSER:\n${user}`;
}

async function callProvider({ provider, baseUrl, apiKey, model, prompt }) {
  const p = provider.toLowerCase();
  if (p === 'gemini' || p === 'google') {
    const url = (baseUrl && baseUrl.trim()) || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [ { role: 'user', parts: [ { text: prompt } ] } ]
      })
    });
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n')) || '';
    return text;
  }
  if (p === 'openai') {
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
        ]
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
        messages: [ { role: 'user', content: prompt } ]
      })
    });
    if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
  throw new Error('Unsupported provider: ' + provider);
}

function extractJson(text) {
  // Try to find the first {...} or [{...}] JSON block
  const match = text.match(/[\{\[][\s\S]*[\}\]]/);
  return match ? match[0] : text;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
