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

// ---------------- YouTube Caption Extractor (migrated) ----------------
// Minimal HTML entity decoder (no external deps)
function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(str) {
  return String(str).replace(/<[^>]*>/g, '');
}

const INNERTUBE_CONFIG = {
  API_BASE: 'https://www.youtube.com/youtubei/v1',
  API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  CLIENT: {
    WEB: { NAME: 'WEB', VERSION: '2.20250222.10.00' },
    ANDROID: { NAME: 'ANDROID', VERSION: '19.35.36' },
  },
};

function generateVisitorData() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 11; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function generateSessionData() {
  const visitorData = generateVisitorData();
  return {
    context: {
      client: {
        hl: 'en', gl: 'US',
        clientName: INNERTUBE_CONFIG.CLIENT.WEB.NAME,
        clientVersion: INNERTUBE_CONFIG.CLIENT.WEB.VERSION,
        visitorData,
      },
      user: { enableSafetyMode: false },
      request: { useSsl: true },
    },
    visitorData,
  };
}

async function fetchInnerTube(endpoint, data) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'X-Youtube-Client-Version': INNERTUBE_CONFIG.CLIENT.WEB.VERSION,
    'X-Youtube-Client-Name': '1',
    'X-Goog-Visitor-Id': data.visitorData,
    'Origin': 'https://www.youtube.com',
    'Referer': 'https://www.youtube.com/',
  };
  const url = `${INNERTUBE_CONFIG.API_BASE}${endpoint}?key=${INNERTUBE_CONFIG.API_KEY}`;
  return await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) });
}

async function getVideoInfo(videoID) {
  const sessionData = generateSessionData();
  const payload = {
    ...sessionData,
    videoId: videoID,
    playbackContext: { contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: '-1' } },
    racyCheckOk: true,
    contentCheckOk: true,
  };
  const response = await fetchInnerTube('/player', payload);
  if (!response.ok) throw new Error(`Player API failed: ${response.status} ${response.statusText}`);
  const playerData = await response.json();

  if (playerData.playabilityStatus?.status === 'LOGIN_REQUIRED') {
    const nextPayload = { ...sessionData, videoId: videoID };
    const nextResponse = await fetchInnerTube('/next', nextPayload);
    if (!nextResponse.ok) throw new Error(`Next API failed: ${nextResponse.status} ${nextResponse.statusText}`);
    const nextData = await nextResponse.json();
    return { playerData, nextData };
  }
  return { playerData, nextData: null };
}

async function getTranscriptFromEngagementPanel(videoID, nextData) {
  if (!nextData?.engagementPanels) return [];
  const transcriptPanel = nextData.engagementPanels.find(
    (p) => p?.engagementPanelSectionListRenderer?.panelIdentifier === 'engagement-panel-searchable-transcript'
  );
  if (!transcriptPanel) return [];
  const content = transcriptPanel.engagementPanelSectionListRenderer?.content;
  let token;
  let cont = content?.continuationItemRenderer;
  if (cont?.continuationEndpoint?.continuationCommand?.token) token = cont.continuationEndpoint.continuationCommand.token;
  else if (cont?.continuationEndpoint?.getTranscriptEndpoint?.params) token = cont.continuationEndpoint.getTranscriptEndpoint.params;
  if (!token && content?.sectionListRenderer?.contents?.[0]) {
    cont = content.sectionListRenderer.contents[0]?.continuationItemRenderer;
    if (cont?.continuationEndpoint?.continuationCommand?.token) token = cont.continuationEndpoint.continuationCommand.token;
  }
  if (!token && content?.sectionListRenderer?.contents) {
    for (const item of content.sectionListRenderer.contents) {
      const footer = item?.transcriptRenderer?.footer?.transcriptFooterRenderer;
      const menu = footer?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems;
      if (menu && menu.length) {
        const englishItem = menu.find((i) => i?.title?.toLowerCase?.().includes('english') || i?.selected) || menu[0];
        token = englishItem?.continuation?.reloadContinuationData?.continuation;
        if (token) break;
      }
    }
  }
  if (!token) return [];

  const sessionData = generateSessionData();
  const transcriptPayload = { ...sessionData, params: token };
  const transcriptResponse = await fetchInnerTube('/get_transcript', transcriptPayload);
  if (!transcriptResponse.ok) throw new Error(`Transcript API failed: ${transcriptResponse.status} ${transcriptResponse.statusText}`);
  const transcriptData = await transcriptResponse.json();
  const segments = transcriptData?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const seg of segments) {
    const r = seg?.transcriptSegmentRenderer;
    if (!r) continue;
    let text = '';
    if (r.snippet?.simpleText) text = r.snippet.simpleText;
    else if (Array.isArray(r.snippet?.runs)) text = r.snippet.runs.map((x) => x.text).join('');
    else if (r.snippet?.text) text = r.snippet.text;
    text = stripTags(decodeEntities(text)).trim();
    if (!text) continue;
    const startMs = parseInt(r.startMs || '0', 10);
    const endMs = parseInt(r.endMs || '0', 10);
    out.push({ start: String(startMs / 1000), dur: String((endMs - startMs) / 1000), text });
  }
  return out;
}

async function getSubtitlesFromCaptions(videoID, playerData, lang = 'en') {
  const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) return [];
  const pick =
    tracks.find((t) => t.vssId === `.${lang}`) ||
    tracks.find((t) => t.vssId === `a.${lang}`) ||
    tracks.find((t) => (t.vssId || '').includes(`.${lang}`)) ||
    tracks[0];
  if (!pick?.baseUrl) return [];
  const captionUrl = pick.baseUrl.replace('&fmt=srv3', '');
  const res = await fetch(captionUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `https://www.youtube.com/watch?v=${videoID}`,
    },
  });
  if (!res.ok) throw new Error(`Caption fetch failed: ${res.status}`);
  const xml = await res.text();
  if (!xml.trim() || !xml.includes('<text')) throw new Error('Caption content is empty or invalid');
  const startRegex = /start="([\d.]+)"/;
  const durRegex = /dur="([\d.]+)"/;
  return extractSubtitlesFromXML(xml, startRegex, durRegex);
}

function extractSubtitlesFromXML(transcript, startRegex, durRegex) {
  return String(transcript)
    .replace('<?xml version="1.0" encoding="utf-8" ?><transcript>', '')
    .replace('</transcript>', '')
    .split('</text>')
    .filter((line) => line && line.trim())
    .reduce((acc, line) => {
      const startResult = startRegex.exec(line);
      const durResult = durRegex.exec(line);
      if (!startResult || !durResult) return acc;
      const start = startResult[1];
      const dur = durResult[1];
      const htmlText = line
        .replace(/<text.+>/, '')
        .replace(/&amp;/gi, '&')
        .replace(/<\/?[^>]+(>|$)/g, '');
      const text = stripTags(decodeEntities(htmlText));
      acc.push({ start, dur, text });
      return acc;
    }, []);
}

async function YT_getVideoDetails({ videoID, lang = 'en' }) {
  const { playerData, nextData } = await getVideoInfo(videoID);
  const vd = playerData?.videoDetails || {};
  let title = vd.title ||
    nextData?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[0]?.videoPrimaryInfoRenderer?.title?.runs?.[0]?.text ||
    nextData?.metadata?.videoMetadataRenderer?.title?.simpleText ||
    nextData?.videoDetails?.title || 'No title found';
  let description = vd.shortDescription ||
    nextData?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[1]?.videoSecondaryInfoRenderer?.description?.runs?.map((r) => r.text).join('') ||
    ((() => {
      const primary = nextData?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[0]?.videoPrimaryInfoRenderer;
      if (primary?.description?.runs) return primary.description.runs.map((r) => r.text).join('');
      return null;
    })()) ||
    nextData?.metadata?.videoMetadataRenderer?.description?.simpleText ||
    nextData?.videoDetails?.shortDescription || 'No description found';

  let subtitles = [];
  if (nextData) {
    try { subtitles = await getTranscriptFromEngagementPanel(videoID, nextData); } catch {}
  }
  if (!subtitles.length) {
    try { subtitles = await getSubtitlesFromCaptions(videoID, playerData, lang); } catch {}
  }
  return { title, description, subtitles };
}

async function YT_getSubtitles({ videoID, lang = 'en' }) {
  const { playerData, nextData } = await getVideoInfo(videoID);
  if (nextData) {
    try {
      const subs = await getTranscriptFromEngagementPanel(videoID, nextData);
      if (subs.length) return subs;
    } catch {}
  }
  return await getSubtitlesFromCaptions(videoID, playerData, lang);
}

// Message bridge for content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'CC_GET_SUBTITLES') {
    (async () => {
      try {
        const subtitles = await YT_getSubtitles({ videoID: msg.videoID, lang: msg.lang || 'en' });
        sendResponse({ ok: true, subtitles });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'CC_GET_VIDEO_DETAILS') {
    (async () => {
      try {
        const videoDetails = await YT_getVideoDetails({ videoID: msg.videoID, lang: msg.lang || 'en' });
        sendResponse({ ok: true, videoDetails });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});
// ---------------------------------------------------------------------
