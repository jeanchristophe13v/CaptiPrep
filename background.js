// Background service worker (MV3, ESM)

// Default settings
const DEFAULT_SETTINGS = {
  provider: 'gemini',
  baseUrl: '', // will derive by provider
  apiKey: '',
  model: 'gemini-2.5-flash',
  // New: allow different models per role (fallback to `model`)
  modelFirst: 'gemini-2.5-flash-lite',
  modelSecond: 'gemini-2.5-flash',
  accent: 'us', // 'us' or 'uk'
  // New: definition/notes language for cards. 'auto' follows browser language on first run.
  // Supported: 'en','zh_CN','zh_TW','ja','ko','ru','fr','de','es'
  glossLang: 'auto',
  // UI language override: 'auto' | 'en' | 'zh_CN'
  uiLang: 'auto'
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
  try { await cleanupStorage(); } catch {}
  // Only open options page on first install, not on every update/reload
  if (details.reason === 'install' && !s.apiKey) {
    try { await chrome.runtime.openOptionsPage(); } catch (e) {}
  }
});

// Also clean on service worker startup
try {
  chrome.runtime.onStartup.addListener(async () => {
    try { await cleanupStorage(); } catch {}
  });
} catch {}

async function cleanupStorage() {
  try {
    const all = await chrome.storage.local.get(null);
    const badKeys = Object.keys(all || {}).filter(k => k === 'CCAPTIPREPS:video:' || k === 'CCAPTIPREPS:video:null' || k === 'CCAPTIPREPS:video:undefined');
    if (badKeys.length) {
      await chrome.storage.local.remove(badKeys);
    }
  } catch {}
}

// Open modal in the active tab when the action is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'CC_TOGGLE_MODAL' });
  } catch (e) {
    // Content scripts may not be injected yet (e.g., initial load). Inject both UI and backend.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js', 'ui.js'] });
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
  if (msg && msg.type === 'CC_OPEN_WORDBOOK') {
    (async () => {
      try {
        const url = chrome.runtime.getURL('assets/wordbook.html');
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
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

  const { provider, baseUrl, apiKey, accent } = settings;
  const glossLang = resolveGlossLang(settings.glossLang, settings.uiLang);
  if (!apiKey) throw new Error('Missing API key in settings');

  const prompts = buildPrompts(role, data, { accent, glossLang });

  // Choose model per role with fallback
  const model = role === 'first'
    ? (settings.modelFirst || settings.model)
    : (settings.modelSecond || settings.model);

  // Sampling per role
  // Lower temperature to reduce hallucination in definition/example stage
  const temperature = role === 'first' ? 0 : 0.0;
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
  // Post-processing
  if (role === 'first') {
    try {
      parsed = postProcessCandidates(parsed, data && data.subtitlesText, data && data.captionLang, data && data.maxItems);
    } catch (e) { /* ignore */ }
  } else if (role === 'second') {
    try {
      const srcLang = normalizeLang(data && data.captionLang);
      const gloss = resolveGlossLang((await getSettings()).glossLang, (await getSettings()).uiLang);
      parsed = postProcessCards(parsed, srcLang, gloss, (await getSettings()).accent);
      // Align to requested ordering to avoid stray or missing items
      const want = Array.isArray(data && data.selected) ? data.selected : [];
      parsed = alignCardsToSelected(parsed, want, srcLang);
    } catch (e) {
      // best-effort; ignore
    }
  }
  return parsed;
}

function buildPrompts(role, data, opts) {
  const { accent, glossLang } = (opts || {});
  if (role === 'first') {
    const { subtitlesText, captionLang, maxItems = 60 } = data;
    const langHint = captionLang && typeof captionLang === 'string' && captionLang.trim() ? captionLang : 'auto-detect';
    const system = `You are an expert segmenter and vocabulary curator. Work only within the detected source language (source: ${langHint}). Extract learnable units that maximize pedagogical value for a learner.`;

    const langGate = (() => {
      const s = normalizeLang(langHint);
      if (s === 'en') return `Keep ENGLISH originals only. Do not output transliterations. Allow apostrophes/hyphens.`;
      if (s === 'ja') return `Keep JAPANESE originals only. Use the exact surface form from the transcript (kanji/kana mix). Do not output romaji as term. Do not exclude kanji-only items if they are common words.`;
      if (s === 'zh_CN' || s === 'zh_TW') return `Keep CHINESE originals only (Han characters). Mixed strings with Latin digits are allowed if the core is Chinese. Never output pinyin as term.`;
      if (s === 'ko') return `Keep KOREAN originals only (Hangul). Never output romanization as term.`;
      if (s === 'ru') return `Keep RUSSIAN originals only (Cyrillic). Do not output Latin transliteration.`;
      if (s === 'fr' || s === 'de' || s === 'es') return `Keep originals in that language/script. Exclude English words/brand names unless widely lexicalized; keep native diacritics (é, ä, ñ, ß).`;
      return `Only include terms clearly in the source language.`;
    })();

    const user = `Task: From the transcript below, extract high-value WORDS and short PHRASES strictly in the ORIGINAL transcript language. Set "term" to the exact SURFACE string as it appears in the transcript. Exclude fillers, interjections, bare function words, and trivial greetings.

Return JSON strictly with this shape:
{
  "items": [ { "term": string, "type": "word"|"phrase", "freq": number } ]
}
Selection rules:
- Evidence: Include a term only if the exact string occurs in the transcript. For Latin/Cyrillic scripts, match case-insensitively on whole word/phrase boundaries; for CJK/Korean, substring match is acceptable.
- Utility ranking: Rank by teaching value within THIS transcript: semantic density > idiomaticity/collocation > local frequency. Avoid very rare named entities unless broadly useful.
- Multiword expressions: Prefer if idiomatic or hard to translate literally.
- Morphology: Do NOT rewrite to lemmas in output. Keep surface form in "term". Internally, you may consider lemma for ranking but NOT for output.
- Stop items: Avoid common fillers/backchannels and bare function words. Examples — en: uh/um/like/you know; ja: えっと/あの/まあ; ko: 어/음/그냥/막; ru: ну/типа/как бы; fr: euh/bah/ben/du coup; de: äh/ähm/also; es: eh/pues/bueno/o sea; zh: 嗯/啊/就是/然后。 Only include them if part of a fixed expression with content.
- Cross-language noise: Exclude brand names, gamer tags, hashtags, model numbers, timestamps, and English borrowings unless they are widely lexicalized in the source language.
- freq is a rough integer count/weight in this transcript.
- Limit items to about ${maxItems}.
- Language gate: ${langGate}
- If uncertain, return an empty list rather than guessing.

Transcript (language: ${langHint}; may be lightly noisy):\n\n${subtitlesText}`;
    return { prompt: composeChat(system, user) };
  } else if (role === 'second') {
    const { selected, captionLang } = data;
    const accentLabel = accent === 'uk' ? 'British' : 'American';
    // Infer source language from selected terms to avoid cross-language contamination
    let srcLang = normalizeLang(captionLang);
    try {
      const inferred = inferLangFromSelected(selected);
      if (inferred && inferred !== 'und') srcLang = inferred;
    } catch {}
    const gloss = normalizeLang(glossLang);
    const glossLabel = humanLabelForLang(gloss);
    const srcLabel = humanLabelForLang(srcLang);
    const pronGuide = pronunciationGuide(srcLang, accentLabel);
    const readGuide = readingGuide(srcLang);

    const system = `You are a multilingual lexicographer. Produce accurate, compact learner cards with source-true pronunciation and meanings constrained by context.`;

    // Examples: unify to 2 lines for all languages (no pronunciation line in examples)
    const exampleRule = `Provide exactly 2 example PAIRS per item. For each pair, output a SINGLE STRING with TWO lines ("\\n"):
  line 1: a natural sentence in ${srcLabel}
  line 2: its concise ${glossLabel} translation
Do NOT include a pronunciation/reading line in examples.`;

    const defRule = (gloss === 'zh_CN' || gloss === 'zh_TW')
      ? `Write the "definition" and "notes" in Chinese (${gloss === 'zh_TW' ? 'Traditional' : 'Simplified'}).`
      : `Write the "definition" and "notes" in ${glossLabel}.`;

    // Updated pronunciation rules for each language
    const ipaRule = `Pronunciation fields:
- "reading": ${readGuide}
- "ipa": ${pronGuide}
Language-specific fill rules:
- Chinese: provide "reading" (Pinyin); leave "ipa" empty.
- Japanese: provide "reading" (kana + NHK pitch); leave "ipa" empty.
- Korean: provide "reading" (Revised Romanization); leave "ipa" empty.
- English: leave "reading" empty; provide both "ipa_us" and "ipa_uk".
- Russian/French/German/Spanish: leave "reading" empty; provide "ipa".`;
    const accentNote = (srcLang === 'en') ? `Include both US and UK variants ("ipa_us" and "ipa_uk"). Set "ipa" to match primary variant.` : `Do NOT include English accent notes for non-English.`;

    const posRule = (gloss === 'zh_CN' || gloss === 'zh_TW')
      ? 'Use POS in Chinese（名词/动词/形容词/副词/短语/惯用语/助词/连词/叹词/敬语等）。名词可在 POS 或 notes 标明性别/可数性；动词可在 notes 标明变位特性/体。'
      : `Use POS in ${glossLabel}. Keep POS concise. Add gender/case/valency in notes if needed.`;

    const critical = `Critical constraints:
- Ground the chosen sense in the provided evidence (if any). Do NOT output an unrelated sense; if truly ambiguous, leave a minimal definition and add "insufficient_context" to notes.
- All pronunciation fields must reflect the SOURCE language (${srcLabel}), NOT the gloss language. When scripts overlap (e.g., Han characters in Japanese), use the reading of the SOURCE language only.
- For English source: include both US and UK variants as separate fields.
- Examples must be written in ${srcLabel} ONLY. Do not mix other languages or transliterations in examples.
- Keep outputs compact and clean; no list markers, brackets, or slashes inside fields.`;

    // Evidence context: up to two transcript lines per item, when available
    const ctx = Array.isArray(data && data.context) ? data.context : [];
    const evidence = ctx.length ? `\nEvidence from transcript (use to disambiguate meaning; do not quote verbatim in output):\n` + ctx.map((c, i) => {
      const lines = Array.isArray(c.lines) ? c.lines : [];
      const head = `${i + 1}. ${c.term}`;
      return head + (lines.length ? `\n- ${lines.join('\n- ')}` : '\n- (no match)');
    }).join('\n') + '\n' : '';

    const user = `Task: For each input item, produce source-true pronunciation (use "reading" for kana/Hangul/Pinyin languages; include "ipa" where customary — include for Korean), a POS label in the chosen gloss language, a short learner-friendly definition constrained by the evidence, exactly two example pairs, and a brief note for key grammar/culture/pitfalls if relevant. Provide a small "grammar" object when relevant (e.g., gender/plural for DE/FR/ES; aspect for RU; separability for DE; politeness/lemma for JA/KO).

${defRule}
${exampleRule}
${ipaRule}
${accentNote}
${posRule}

Notes guidelines:
- Korean: Include grammar notes (honorifics, irregular verbs, sound changes), usage patterns, or cultural context when relevant. Only mention standard pronunciation (표준발음) if there are notable sound changes or irregular pronunciations.
- Spanish: Beyond gender/number, include usage registers (formal/informal), regional variations, idioms, false friends, or cultural context when helpful.
- All languages: Focus on learner-relevant information that aids comprehension and proper usage.

${critical}
${evidence}

Return JSON strictly with this shape and cardinality (one card per input item, same order; do not add or drop items). For English, include both "ipa_us" and "ipa_uk" and set "ipa" to match the primary accent. For Chinese/Japanese/Korean, fill "reading" and leave "ipa" empty. For Russian/French/German/Spanish, leave "reading" empty and fill "ipa".
{
  "cards": [ {
    "term": string,
    "reading": string,        // native reading when applicable (kana+pitch/RR/Pinyin); else empty
    "ipa": string,            // pronunciation string per language rules; empty for CJK/Korean
    "ipa_us": string,         // required when source is English; otherwise empty or omitted
    "ipa_uk": string,         // required when source is English; otherwise empty or omitted
    "pos": string,            // POS label in ${glossLabel}
    "definition": string,     // concise learner definition (${glossLabel}) aligned to evidence
    "examples": string[],     // exactly 2 strings; each with TWO lines (src + translation); NO pronunciation line
    "notes": string,          // may be empty (${glossLabel}); include key inflection/usage notes
    "grammar": object         // optional structured hints (gender/plural/aspect/separable/politeness/etc.)
  } ]
}

Formatting rules:
- Output raw JSON only (no Markdown fences).
- Do not use list markers (-, *, 1.) inside strings.
- Keep pronunciation clean: no surrounding slashes. Square brackets are allowed only for Japanese pitch numbers in readings (e.g., [0]).

Items:\n${selected.map((t, i) => `${i + 1}. ${t.term}`).join('\n')}`;
    return { prompt: composeChat(system, user) };
  }
  throw new Error('Unknown role');
}

function composeChat(system, user) {
  // Provider adapters will wrap into their specific schema. Here we merge as a single text.
  return `SYSTEM:\n${system}\n\nUSER:\n${user}`;
}

function resolveGlossLang(glossLang, uiLang) {
  const g = (glossLang || '').trim();
  if (g && g !== 'auto') return normalizeLang(g);
  const ui = (uiLang && uiLang !== 'auto') ? uiLang : (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function' ? chrome.i18n.getUILanguage() : 'en');
  // Map browser UI to gloss language
  const norm = normalizeLang(ui);
  if (norm === 'zh_CN' || norm === 'zh_TW' || norm === 'en') return norm;
  return 'en';
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

function humanLabelForLang(norm) {
  switch (norm) {
    case 'en': return 'English';
    case 'zh_CN': return 'Chinese(Simplified)';
    case 'zh_TW': return 'Chinese(Traditional)';
    case 'ja': return 'Japanese';
    case 'ko': return 'Korean';
    case 'ru': return 'Russian';
    case 'fr': return 'French';
    case 'de': return 'German';
    case 'es': return 'Spanish';
    default: return norm || 'Unknown';
  }
}

function pronunciationGuide(srcLang, accentLabel) {
  const s = normalizeLang(srcLang);
  if (s === 'en') {
    return `IPA (broad). No slashes/brackets. Provide both US and UK variants; mark primary stress (ˈ).`;
  }
  if (s === 'zh_CN' || s === 'zh_TW') {
    return 'Leave "ipa" field empty. Chinese uses Pinyin in "reading" field only.';
  }
  if (s === 'ja') {
    return 'Leave "ipa" field empty. Japanese uses kana with NHK pitch accent in "reading" field only.';
  }
  if (s === 'ko') {
    return 'Leave "ipa" field empty. Korean uses Revised Romanization in "reading" field only.';
  }
  if (s === 'ru') {
    return 'IPA (broad), Moscow standard. Mark stress. Use palatalization ʲ (e.g., nʲ tʲ sʲ). Ensure ё is correctly represented in the source term. No slashes/brackets.';
  }
  if (s === 'fr') {
    return 'IPA (broad), Metropolitan French. Include nasal vowels (ɑ̃ ɔ̃ ɛ̃ œ̃) and uvular ʁ. Do NOT mark stress. Liaison optional. No slashes/brackets.';
  }
  if (s === 'de') {
    return 'IPA (broad), Standard German. Mark long vowels with ː when needed. Include y, ø, œ; ich/ach as ç/x. No slashes/brackets.';
  }
  if (s === 'es') {
    return 'IPA (broad), neutral seseo baseline. Mark stress. No slashes/brackets.';
  }
  return 'Use the standard romanization or IPA customary for the language; clean text without slashes/brackets.';
}

function readingGuide(srcLang) {
  const s = normalizeLang(srcLang);
  if (s === 'ja') return 'Use full kana reading (かな／カナ) with NHK-style pitch accent number in square brackets, e.g., あめ [0]. Do not use romaji as the main reading.';
  if (s === 'ko') return 'Use Revised Romanization (RR) strictly. 시=si, 스=seu. Never mix IPA or other romanization systems.';
  if (s === 'zh_CN' || s === 'zh_TW') return 'Use Hanyu Pinyin with tone marks (mā/má/mǎ/mà). No tone numbers; use ü. Mark common sandhi in notes if necessary.';
  if (s === 'ru' || s === 'fr' || s === 'de') return 'Leave reading field empty; use IPA in the ipa field.';
  if (s === 'es') return 'Leave reading field empty; use IPA in the ipa field.';
  if (s === 'en') return 'Leave reading field empty; use IPA in us/uk variants.';
  return 'Use the language-appropriate native reading when it exists; otherwise leave empty.';
}

function alignCardsToSelected(parsed, selected, srcLang) {
  try {
    const out = { ...parsed };
    const want = Array.isArray(selected) ? selected.map(s => String(s.term || '').trim()) : [];
    const got = Array.isArray(parsed.cards) ? parsed.cards : [];
    const isLatin = ['en','fr','de','es','ru'].includes(normalizeLang(srcLang));
    const norm = (s) => isLatin ? String(s || '').toLowerCase().trim() : String(s || '').trim();
    const map = new Map();
    for (const c of got) { const k = norm(c.term); if (k) { if (!map.has(k)) map.set(k, c); } }
    const aligned = [];
    for (const term of want) {
      const k = norm(term);
      const found = map.get(k);
      if (found) { aligned.push(found); }
      else { aligned.push({ term, ipa: '', ipa_us: '', ipa_uk: '', pos: '', definition: '', examples: [], notes: 'insufficient_context' }); }
    }
    out.cards = aligned;
    return out;
  } catch { return parsed; }
}

function postProcessCandidates(parsed, subtitlesText, captionLang, maxItems) {
  try {
    const out = { ...parsed };
    const items = Array.isArray(out.items) ? out.items : [];
    const text = String(subtitlesText || '');
    const lang = normalizeLang(captionLang);
    if (!text) return parsed;
    if (!items.length) {
      // Build naive candidates directly from transcript to avoid empty selection UI
      const naive = buildNaiveCandidatesFromTranscript(text, lang, maxItems);
      if (naive && naive.length) return { items: naive };
      return parsed;
    }
    
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const fullText = lines.join(' ');
    const contains = (rawTerm) => {
      const term = String(rawTerm || '').trim();
      if (!term) return false;
      // For CJK/Hangul, substring is acceptable across the whole transcript
      if (lang === 'ja' || lang === 'ko' || lang === 'zh_CN' || lang === 'zh_TW') {
        return fullText.includes(term);
      }
      // For Latin/Cyrillic scripts: use Unicode-aware word boundary surrogate
      try {
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Treat letters/marks/digits/'/- as part of words; negative class around the term
        const re = new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}'-])${esc}([^\\p{L}\\p{M}\\p{N}'-]|$)`, 'iu');
        return re.test(fullText);
      } catch {
        // Fallback: case-insensitive substring on the fused text
        return fullText.toLowerCase().includes(term.toLowerCase());
      }
    };

    // Script gate: drop items whose script clearly does not match the source language
    const hasAny = (re, s) => re.test(s);
    const scriptOk = (t) => {
      const s = String(t || '').trim();
      if (!s) return false;
      switch (lang) {
        case 'ja':
          // Require at least one Hiragana/Katakana or CJK
          return hasAny(/[\u3040-\u30FF\u4E00-\u9FFF]/u, s);
        case 'ko':
          // Require at least one Hangul
          return hasAny(/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/u, s);
        case 'zh_CN':
        case 'zh_TW':
          // Require at least one Han character
          return hasAny(/[\u4E00-\u9FFF]/u, s);
        case 'ru':
          // Require at least one Cyrillic
          return hasAny(/[\u0400-\u04FF]/u, s);
        default:
          // Latin-script languages (en/fr/de/es) pass
          return true;
      }
    };

    // Basic stopword/filtering to reduce filler noise per language
    const stop = buildStoplist(lang);
    const isStop = (t) => {
      const s = String(t || '').trim();
      if (!s) return true;
      // Drop terms that are mostly digits/punct
      const alnum = s.replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
      if (!alnum) return true;
      const digitRatio = (s.replace(/[^0-9]/g, '').length) / s.length;
      if (digitRatio > 0.5) return true;
      const key = s.toLowerCase();
      return stop.has(key);
    };

    const filtered = items
      .filter(it => contains(String(it.term || '').trim()))
      .filter(it => !isStop(it.term))
      .filter(it => scriptOk(it.term));
    // Optional: cap length again and sort by provided freq desc
    filtered.sort((a, b) => (b.freq || 0) - (a.freq || 0));
    let finalList = typeof maxItems === 'number' ? filtered.slice(0, maxItems) : filtered;

    // Fallback: if filtering wipes out everything (e.g., model lemmatized/rewrote terms), degrade constraints to avoid empty UI
    if (!finalList.length) {
      const looseContains = (rawTerm) => {
        const term = String(rawTerm || '').trim();
        if (!term) return false;
        try {
          return fullText.toLowerCase().includes(term.toLowerCase());
        } catch { return false; }
      };
      const minimal = items
        .filter(it => looseContains(String(it.term || '')))
        .filter(it => !isStop(it.term))
        .filter(it => scriptOk(it.term));
      minimal.sort((a, b) => (b.freq || 0) - (a.freq || 0));
      finalList = typeof maxItems === 'number' ? minimal.slice(0, maxItems) : minimal;
    }

    // Last resort: if still empty, take top-N raw items with sane characters
    if (!finalList.length) {
      const sane = (s) => /[\p{L}\p{M}]/u.test(String(s || ''));
      const basic = items.filter(it => sane(it.term)).slice(0, Math.max(10, Math.min(40, maxItems || 40)));
      finalList = basic;
    }

    out.items = finalList;
    return out;
  } catch { return parsed; }
}

function postProcessCards(parsed, srcLang, gloss, accent) {
  try {
    const out = { ...parsed };
    const cards = Array.isArray(out.cards) ? out.cards : [];
    const isZh = (gloss === 'zh_CN' || gloss === 'zh_TW');
    const map = (s) => String(s || '').trim();
    const lower = (s) => map(s).toLowerCase();
    const posMapCN = {
      'noun': '名词', 'n.': '名词',
      'verb': '动词', 'v.': '动词', 'auxiliary verb': '助动词', 'aux.': '助动词',
      'adjective': '形容词', 'adj.': '形容词',
      'adverb': '副词', 'adv.': '副词',
      'pronoun': '代词', 'pron.': '代词',
      'preposition': '介词', 'prep.': '介词',
      'conjunction': '连词', 'conj.': '连词',
      'interjection': '叹词', 'int.': '叹词',
      'particle': '助词', 'postposition': '助词', 'classifier': '量词',
      'determiner': '限定词', 'article': '冠词',
      'phrase': '短语', 'idiom': '惯用语', 'expression': '表达',
      'honorific': '敬语'
    };
    const posMapTW = {
      '名词': '名詞', '动词': '動詞', '形容词': '形容詞', '副词': '副詞', '代词': '代名詞', '介词': '介系詞', '连词': '連接詞', '叹词': '感嘆詞', '助词': '助詞', '量词': '量詞', '限定词': '限定詞', '冠词': '冠詞', '短语': '片語', '惯用语': '慣用語', '表达': '表達', '敬语': '敬語', '助动词': '助動詞'
    };
    const lang = normalizeLang(srcLang);
    out.cards = cards.map((c) => {
      const cc = { ...c };
      // Sanitize and normalize expected fields
      if (!cc.reading) cc.reading = '';
      // Drop redundant reading when identical to term for languages where reading often equals surface form
      try {
        const lang2 = normalizeLang(srcLang);
        const map2 = (s) => String(s || '').trim();
        if ((lang2 === 'ko' || lang2 === 'ja' || lang2 === 'zh_CN' || lang2 === 'zh_TW') && map2(cc.reading) && map2(cc.term) && map2(cc.reading) === map2(cc.term)) {
          cc.reading = '';
        }
      } catch {}
      // POS localization fallback for Chinese
      if (isZh && cc.pos) {
        const key = lower(cc.pos).replace(/\./g, '').trim();
        let mapped = null;
        for (const k in posMapCN) {
          if (key === k) { mapped = posMapCN[k]; break; }
        }
        if (mapped) cc.pos = (gloss === 'zh_TW') ? (posMapTW[mapped] || mapped) : mapped;
      }
      // Ensure English has both US/UK fields and force primary accent into ipa
      if (lang === 'en') {
        const us = map(cc.ipa_us);
        const uk = map(cc.ipa_uk);
        cc.ipa = us || uk; // Remove accent preference logic
      }
      // For Korean: ensure ipa is empty
      if (lang === 'ko') {
        cc.ipa = ''; // Force empty for Korean
        // Let model decide whether to include standard pronunciation or other notes
      }
      // For Chinese and Japanese: ensure ipa is empty
      if (lang === 'zh_CN' || lang === 'zh_TW' || lang === 'ja') {
        cc.ipa = '';
      }
      // Trim strings
      ['term','reading','ipa','ipa_us','ipa_uk','pos','definition','notes'].forEach(f => { if (cc[f]) cc[f] = map(cc[f]); });
      // Normalize examples: always 2 lines per block (src + translation); drop any pronunciation line
      cc.examples = normalizeExamples(cc.examples, lang);
      return cc;
    });
    return out;
  } catch {
    return parsed;
  }
}

function normalizeExamples(examples, srcLang) {
  try {
    const list = Array.isArray(examples) ? examples : [];
    const norm = list.slice(0, 2).map(raw => {
      const lines = String(raw || '').split(/\r?\n/).map(s => s.replace(/^\s*[-*\d\.)\u2022\u00B7]?\s*/, '')).map(s => s.trim()).filter(Boolean);
      const l1 = lines[0] || '';
      const l2 = lines[1] || '';
      // Force exactly two lines when possible; ignore any extra lines
      return [l1, l2].filter(Boolean).join('\n');
    });
    return norm;
  } catch { return Array.isArray(examples) ? examples.slice(0, 2) : []; }
}

function inferLangFromSelected(selected) {
  try {
    const list = Array.isArray(selected) ? selected : [];
    if (!list.length) return 'und';
    const terms = list.map(it => String((it && it.term) || '').trim()).filter(Boolean).join(' ');
    if (!terms) return 'und';
    const has = (re) => re.test(terms);
    if (/[\u3040-\u30FF]/u.test(terms) || /[\u30A0-\u30FF]/u.test(terms)) return 'ja';
    if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/u.test(terms)) return 'ko';
    if (/[\u4E00-\u9FFF]/u.test(terms)) return 'zh_CN'; // default to Simplified for UI
    if (/[\u0400-\u04FF]/u.test(terms)) return 'ru';
    // Latin-based: try to guess among es/fr/de/en via diacritics/signatures
    const lower = terms.toLowerCase();
    if (/[ñáéíóúü]/i.test(terms)) return 'es';
    if (/[éèêëàâîïôùûç]/i.test(terms)) return 'fr';
    if (/[äöüß]/i.test(terms)) return 'de';
    // If contains many English function words, lean en
    const enSignals = ['the','and','of','to','in','for','on','with','as'];
    let hits = 0; for (const w of enSignals) { if (lower.includes(` ${w} `)) hits++; }
    if (hits >= 2) return 'en';
    // Default Latin -> es as a safe learner bias when diacritics include á/í/ó/ú
    if (/[áíóú]/i.test(terms)) return 'es';
    return 'en';
  } catch { return 'und'; }
}

function buildNaiveCandidatesFromTranscript(text, lang, maxItems = 60) {
  try {
    const s = String(text || '');
    if (!s.trim()) return [];
    const L = normalizeLang(lang);
    const freq = new Map();
    const push = (tok) => {
      const t = String(tok || '').trim();
      if (!t) return;
      const k = (L === 'en' || L === 'fr' || L === 'de' || L === 'es' || L === 'ru') ? t.toLowerCase() : t;
      freq.set(k, (freq.get(k) || 0) + 1);
    };
    if (L === 'ja') {
      const m = s.match(/[\u3040-\u30FF\u4E00-\u9FFF]+/gu) || [];
      m.filter(x => x.length >= 2 && x.length <= 8).forEach(push);
    } else if (L === 'ko') {
      const m = s.match(/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]+/gu) || [];
      m.filter(x => x.length >= 2 && x.length <= 10).forEach(push);
    } else if (L === 'zh_CN' || L === 'zh_TW') {
      const m = s.match(/[\u4E00-\u9FFF]+/gu) || [];
      m.filter(x => x.length >= 2 && x.length <= 8).forEach(push);
    } else if (L === 'ru') {
      const m = s.match(/[\u0400-\u04FF]+/gu) || [];
      m.filter(x => x.length >= 3).forEach(push);
    } else {
      const m = s.match(/[\p{L}\p{M}][\p{L}\p{M}'-]*/gu) || [];
      m.filter(x => x.length >= 3).forEach(push);
    }
    // Build items sorted by frequency
    const items = Array.from(freq.entries())
      .map(([term, count]) => ({ term, type: 'word', freq: count }))
      .sort((a, b) => (b.freq || 0) - (a.freq || 0));
    return items.slice(0, Math.max(10, Math.min(80, maxItems || 60)));
  } catch { return []; }
}

function buildStoplist(lang) {
  const L = (s) => new Set(s.map(x => x.toLowerCase()));
  switch (normalizeLang(lang)) {
    case 'en': return L(['uh','um','er','ah','oh','like','you know','i mean','kind of','sort of','okay','ok','so','well']);
    case 'ja': return L(['えっと','ええと','あの','その','まぁ','まあ','うん','あぁ','はい']);
    case 'ko': return L(['어','음','그냥','막','뭐지','저기','그러니까','근데','아니','자','응']);
    case 'ru': return L(['ну','типа','как бы','ээ','эм','блин','ладно','короче']);
    case 'fr': return L(['euh','bah','ben','du coup','genre','en fait','bref','voilà']);
    case 'de': return L(['äh','ähm','halt','eben','so','naja','also','ja','nee','doch']);
    case 'es': return L(['eh','este','pues','bueno','o sea','vale','ya','entonces']);
    case 'zh_CN':
    case 'zh_TW': return L(['嗯','啊','这个','那個','那个','這個','就是','然后','然後','吧','呃','嘛']);
    default: return L([]);
  }
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
  const raw = String(text || '');

  // Helper: balanced JSON block finder starting at first { or [
  function findBalancedJsonBlock(s) {
    const str = String(s || '');
    let start = str.search(/[\{\[]/);
    if (start < 0) return null;
    let depthObj = 0, depthArr = 0;
    let inStr = false, quote = '', esc = false;
    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === quote) { inStr = false; continue; }
        continue;
      }
      if (ch === '"' || ch === '\'' ) { inStr = true; quote = ch; continue; }
      if (ch === '{') depthObj++;
      else if (ch === '}') depthObj--;
      else if (ch === '[') depthArr++;
      else if (ch === ']') depthArr--;
      if (depthObj < 0 || depthArr < 0) return null; // invalid
      if (depthObj === 0 && depthArr === 0 && i > start) {
        return str.slice(start, i + 1);
      }
    }
    return null;
  }

  // 1) Collect candidates from code fences first
  const candidates = [];
  const fenceRe = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(raw))) {
    const inside = String(m[1] || '').trim();
    if (inside) candidates.push(inside);
  }

  // 2) Also consider the whole raw text
  candidates.push(raw.trim());

  // 3) For each candidate, try direct parse, then balanced block parse
  for (const cand of candidates) {
    // Direct parse
    try {
      const obj = JSON.parse(cand);
      if (obj && (obj.cards || obj.items)) return cand;
      // If it parses but without keys, still return as last resort
    } catch {}
    // Balanced block from the candidate
    const block = findBalancedJsonBlock(cand);
    if (block) {
      try {
        const obj = JSON.parse(block);
        if (obj && (obj.cards || obj.items)) return block;
      } catch {}
    }
  }
  // 4) Final fallback: naive first {...} or [{...}] match from raw
  const naive = raw.match(/[\{\[][\s\S]*[\}\]]/);
  return naive ? naive[0] : raw;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
