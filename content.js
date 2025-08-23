// Backend content script: caption extraction, storage, LLM calls; exposes API to UI via window.CaptiPrep.backend

// Prevent multiple initialization of content script
// Note: top-level `return` is illegal in content scripts, so avoid it.
if (window.CaptiPrepContentLoaded) {
  // Already loaded; keep definitions idempotent below.
} else {
  window.CaptiPrepContentLoaded = true;
}

// Avoid duplicate declarations when content script is injected multiple times
if (!window.CC_NS) {
  window.CC_NS = 'CCAPTIPREPS';
}
if (!window.t) {
  window.t = (k, ...subs) => (chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage(k, subs) : '') || k;
}

// ===== Debug helper =====
// Avoid duplicate const redeclare when content script is injected twice
if (!('CC_DEBUG' in window)) {
  window.CC_DEBUG = false;
}
function dlog(...args) { if (window.CC_DEBUG) console.log('[CaptiPrep]', ...args); }

// ===== Settings & LLM bridge (background) =====
async function getSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'CC_GET_SETTINGS' });
  if (!resp || !resp.ok) return {};
  return resp.settings || {};
}

async function llmCall(role, data) {
  const resp = await chrome.runtime.sendMessage({ type: 'CC_LLM_CALL', payload: { role, data } });
  if (!resp || !resp.ok) throw new Error(resp && resp.error || 'Unknown error');
  return resp.result;
}

// ===== Local storage by video =====
async function loadVideoData(videoId) {
  const key = `${window.CC_NS}:video:${videoId}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function saveVideoData(videoId, patch) {
  const key = `${window.CC_NS}:video:${videoId}`;
  const current = await loadVideoData(videoId) || {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [key]: next });
}

// ===== YouTube page info =====
function getYouTubeVideoInfo() {
  const url = new URL(location.href);
  let v = url.searchParams.get('v');
  if (!v) {
    const paths = location.pathname.split('/').filter(Boolean);
    if (paths[0] === 'shorts' && paths[1]) v = paths[1];
    if (!v && location.host.includes('youtu.be')) v = paths[0];
  }
  // Robust title detection: prefer visible H1 first (meta can lag on SPA navigation)
  const bad = (s) => !s || /^(untitled|\(untitled\)|youtube)$/i.test(String(s).trim());
  const pick = (...vals) => vals.find(t => !bad(t) && String(t).trim());

  // Visible title in the watch page
  const h1New = document.querySelector('ytd-watch-metadata h1 yt-formatted-string')?.textContent?.trim();
  const h1Old = document.querySelector('h1.title, h1#title, h1')?.textContent?.trim();

  // Meta tags (can be stale briefly during SPA navigation)
  const metaOg = document.querySelector('meta[property="og:title"]')?.content?.trim();
  const metaTw = document.querySelector('meta[name="twitter:title"]')?.content?.trim();
  const metaItem = document.querySelector('meta[itemprop="name"]')?.content?.trim();

  // Document title fallback
  let dt = document.title || '';
  if (dt.endsWith(' - YouTube')) dt = dt.replace(/ - YouTube$/,'').trim();

  // Prefer H1 -> meta -> document.title
  const title = pick(h1New, h1Old, metaOg, metaTw, metaItem, dt) || '';
  return { videoId: v, title };
}

// ===== Main-world helpers (via page_inject.js) =====
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

// Use window property to avoid redeclaration error
if (!window.__cc_injectorReady) {
  window.__cc_injectorReady = null;
}

function ensureInjectorLoaded() {
  if (window.__cc_injectorReady) return window.__cc_injectorReady;
  window.__cc_injectorReady = new Promise((resolve) => {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('page_inject.js');
      s.addEventListener('load', () => resolve(true));
      (document.head || document.documentElement).appendChild(s);
      setTimeout(() => resolve(true), 300);
    } catch {
      resolve(true);
    }
  });
  return window.__cc_injectorReady;
}

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
    try { window.postMessage({ type: 'CC_FETCH_CAPTION', id, url }, location.origin); } catch (e) {
      window.removeEventListener('message', onMsg);
      resolve({ ok: false, status: 0, contentType: '', text: '', error: String(e) });
    }
    setTimeout(() => {
      try { window.removeEventListener('message', onMsg); } catch {}
      resolve({ ok: false, status: 0, contentType: '', text: '', error: 'timeout' });
    }, 10000);
  });
}

function getSelectedCaptionTrackMainWorld() {
  return new Promise((resolve) => {
    const id = 'sel_' + Math.random().toString(36).slice(2);
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.type !== 'CC_SELECTED_CC' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve((d.ok && d.track) ? d.track : null);
    };
    window.addEventListener('message', onMsg);
    try { window.postMessage({ type: 'CC_GET_SELECTED_CC', id }, location.origin); } catch (e) {
      window.removeEventListener('message', onMsg);
      resolve(null);
    }
    setTimeout(() => {
      try { window.removeEventListener('message', onMsg); } catch {}
      resolve(null);
    }, 3000);
  });
}

// ===== Caption extraction pipeline =====
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
function buildUrlWithFmt(base, fmt) { if (!base) return ''; return appendParam(base, 'fmt', fmt); }
function isJsonLike(ct) { const c = (ct || '').toLowerCase(); return c.includes('application/json') || c.includes('+json'); }
function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }

function captionsJsonToText(json) {
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
  const lines = String(vtt).replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = []; let buf = [];
  const flush = () => { const s = buf.join(' ').replace(/\s+/g, ' ').trim(); if (s) out.push(s); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flush(); continue; }
    if (i === 0 && /^WEBVTT/i.test(line)) continue;
    if (/^NOTE(\s|$)/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+--\>/.test(line) || /^\d{2}:\d{2}\.\d{3}\s+--\>/.test(line)) continue;
    const text = line.replace(/<[^>]+>/g, '').trim();
    if (text) buf.push(text);
  }
  flush();
  return out.join('\n');
}

async function fetchAndExtract(url) {
  const res = await fetchCaptionMainWorld(url);
  dlog('fetchAndExtract:', url, 'status:', res.status, 'ct:', res.contentType);
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
        // Prefer currently selected language; otherwise the first entry as YouTube's default
        const chosen = menu.find(i => i?.selected) || menu[0];
        token = chosen?.continuation?.reloadContinuationData?.continuation;
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
    const r = seg?.transcriptSegmentRenderer; if (!r) continue;
    let text = '';
    if (r.snippet?.simpleText) text = r.snippet.simpleText;
    else if (Array.isArray(r.snippet?.runs)) text = r.snippet.runs.map(x => x.text).join('');
    else if (r.snippet?.text) text = r.snippet.text;
    text = String(text).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
  }
  return lines;
}

function chooseDefaultTrack(tracks, selected) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const safeTracks = tracks.filter(t => !/[?&]tlang=/.test(String(t.baseUrl || '')));
  const pool = safeTracks.length ? safeTracks : tracks;

  // If user selected a non-translation track (e.g., auto-generated in the native language), honor it by language and kind
  const isTranslatedSel = !!(selected && selected.translationLanguage);
  if (selected && !isTranslatedSel) {
    const lang = selected.languageCode || selected.lang || '';
    const kind = (selected.kind || '').toLowerCase();
    // Exact vssId match
    if (selected.vssId) {
      const byVss = pool.find(t => t.vssId === selected.vssId);
      if (byVss) return byVss;
    }
    // Prefer same language + same kind
    if (lang) {
      const byLangKind = pool.find(t => (t.languageCode === lang) && ((t.kind || '').toLowerCase() === kind));
      if (byLangKind) return byLangKind;
      // Then any with same language
      const byLang = pool.find(t => t.languageCode === lang);
      if (byLang) return byLang;
    }
  }

  // If selection is a translation, avoid using it; pick the first sane non-translation track (usually the source CC)
  const nonAsrFirst = pool.find(t => !t.kind || t.kind !== 'asr');
  return nonAsrFirst || pool[0] || null;
}

async function tryTranscriptViaPage(videoId) {
  try {
    await ensureInjectorLoaded();
    const session = { context: { client: { hl: 'en', gl: 'US', clientName: 'WEB' }, user: { enableSafetyMode: false }, request: { useSsl: true } } };
    const nextRes = await ytApiPostMainWorld('/next', { ...session, videoId });
    if (!nextRes.ok) return '';
    const nextData = nextRes.json || null;
    // IMPORTANT: the transcript panel may default to auto-translated language based on previous videos.
    // We do NOT want translated transcripts. We’ll still read a token, but only use it as a fallback
    // and prefer captionTracks fetch path for original captions.
    // Disable transcript panel fallback to avoid auto-translation bleed-through.
    // Keeping the code for potential future gated use, but returning empty to skip this path.
    const text = '';
    // Try to infer language from currently selected CC, falling back to available tracks
    let lang = 'und';
    try {
      const injected = await getPlayerResponseMainWorld();
      const tracks = injected?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const selected = await getSelectedCaptionTrackMainWorld();
      const pick = chooseDefaultTrack(tracks, selected);
      if (pick && pick.languageCode) lang = pick.languageCode;
    } catch {}
    if (text) return { text, lang };
    return '';
  } catch { return ''; }
}

async function extractCaptionsText() {
  dlog('Starting caption extraction');
  await ensureInjectorLoaded();

  // 1) Prefer direct captionTracks fetch (original captions), to avoid auto-translated transcript bleed
  try {
    const injected = await getPlayerResponseMainWorld();
    const tracks = injected?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const selected = await getSelectedCaptionTrackMainWorld();
    const pick = chooseDefaultTrack(tracks, selected);
    if (pick && pick.baseUrl) {
      const base = pick.baseUrl;
      const finalLang = pick.languageCode || 'und';
      for (const fmt of ['json3','srv3','vtt']) {
        try {
          const text = await fetchAndExtract(buildUrlWithFmt(base, fmt));
          if (text && text.trim()) return { text, lang: finalLang };
        } catch {}
      }
    }
  } catch (e) { dlog('Player response method failed:', e?.message || e); }

  // 2) Fallback: call InnerTube /player for a fresh playerResponse (often includes captionTracks when the initial snapshot lacks them)
  try {
    const { videoId } = getYouTubeVideoInfo();
    if (videoId) {
      const session = { context: { client: { hl: 'en', gl: 'US', clientName: 'WEB' }, user: { enableSafetyMode: false }, request: { useSsl: true } } };
      const prRes = await ytApiPostMainWorld('/player', { ...session, videoId });
      if (prRes && prRes.ok) {
        const pr = prRes.json || null;
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const selected = await getSelectedCaptionTrackMainWorld();
        const pick = chooseDefaultTrack(tracks, selected);
        if (pick && pick.baseUrl) {
          const base = pick.baseUrl;
          const finalLang = pick.languageCode || 'und';
          for (const fmt of ['json3','srv3','vtt']) {
            try {
              const text = await fetchAndExtract(buildUrlWithFmt(base, fmt));
              if (text && text.trim()) return { text, lang: finalLang };
            } catch {}
          }
        }
      } else {
        dlog('InnerTube /player fallback failed:', prRes && prRes.status, prRes && prRes.error);
      }
    }
  } catch (e) { dlog('InnerTube /player fallback error:', e?.message || e); }

  const { videoId } = getYouTubeVideoInfo();
  if (!videoId) throw new Error(window.t('error_no_video'));
  throw new Error(window.t('error_no_captions'));
}

// ===== Expose backend to UI =====
(function expose() {
  const backend = {
    getSettings,
    llmCall,
    loadVideoData,
    saveVideoData,
    getYouTubeVideoInfo,
    extractCaptionsText,
    // Expose current selected caption track (from page context)
    async getSelectedCaptionTrack() {
      try {
        await ensureInjectorLoaded();
        const raw = await getSelectedCaptionTrackMainWorld();
        if (!raw) return null;
        // Normalize translationLanguage to a code string if possible
        let tl = '';
        try {
          const t = raw.translationLanguage;
          tl = typeof t === 'string' ? t : (t && (t.languageCode || t.lang || '')) || '';
        } catch {}
        return {
          languageCode: raw.languageCode || raw.lang || '',
          vssId: raw.vssId || '',
          kind: raw.kind || '',
          translationLanguage: tl,
          name: raw.name || ''
        };
      } catch { return null; }
    },
  };
  globalThis.CaptiPrep = Object.assign(globalThis.CaptiPrep || {}, { backend });
  dlog('Backend exposed');
})();
