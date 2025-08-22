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
    const system = `You are an expert vocabulary curator. Focus strictly on the specified source language (source: ${langHint}).`;

    const langGate = (() => {
      const s = normalizeLang(langHint);
      if (s === 'en') return `Only include ENGLISH words/phrases. Ignore transliterations or borrowings from other languages. Terms must be A–Z letters (with apostrophes/hyphens allowed).`;
      if (s === 'ja') return `Only include JAPANESE terms. Prefer items containing kana (ひらがな/カタカナ). Do NOT include Chinese Pinyin or romaji-only as "term"; keep original script.`;
      if (s === 'zh_CN' || s === 'zh_TW') return `Only include CHINESE terms. Keep "term" in Han characters (and necessary separators). Do NOT include Japanese-specific kana or romaji.`;
      if (s === 'ko') return `Only include KOREAN terms (Hangul). Do NOT include romaja as the "term".`;
      return `Only include terms clearly in the source language.`;
    })();

    const user = `Task: From the transcript below, extract high-value words and short expressions in the ORIGINAL transcript language. Keep "term" EXACTLY as it appears in the transcript (original writing). Exclude trivial/basic items (e.g., greetings, fillers, very common object words).

Return JSON strictly with this shape:
{
  "items": [ { "term": string, "type": "word"|"phrase", "freq": number } ]
}
Rules:
- Only include a term if the exact string occurs in the transcript. For Latin scripts, match case-insensitively and as a whole word/phrase; for CJK/KO, substring match.
- Rank by usefulness/frequency in THIS transcript, not general corpora.
- Avoid overly-rare named entities unless broadly useful.
- Prefer multi-word expressions if idiomatic or hard to translate.
- Merge inflections/variants into one lemma when obvious.
- freq is a rough integer count/weight.
- Limit items to about ${maxItems}.
- Language gate: ${langGate}
- If uncertain, return an empty list rather than guessing.

Transcript (language: ${langHint}; may be lightly noisy):\n\n${subtitlesText}`;
    return { prompt: composeChat(system, user) };
  } else if (role === 'second') {
    const { selected, captionLang } = data;
    const accentLabel = accent === 'uk' ? 'British' : 'American';
    const srcLang = normalizeLang(captionLang);
    const gloss = normalizeLang(glossLang);
    const glossLabel = humanLabelForLang(gloss);
    const srcLabel = humanLabelForLang(srcLang);
    const pronGuide = pronunciationGuide(srcLang, accentLabel);

    const system = `You are a concise lexicographer. Produce accurate pronunciation and succinct meanings.`;

    // Simplify examples to reduce hallucination: always 2 lines (source, translation)
    const exampleRule = `Provide exactly 2 example PAIRS per item. For each pair, output a SINGLE STRING with TWO lines separated by a newline ("\n"):
  line 1: a natural sentence in ${srcLabel}
  line 2: its concise ${glossLabel} translation
No bullets, numbering, or extra notes.`;

    const defRule = (gloss === 'zh_CN' || gloss === 'zh_TW')
      ? `Write the "definition" and "notes" in Chinese (${gloss === 'zh_TW' ? 'Traditional' : 'Simplified'}).`
      : `Write the "definition" and "notes" in ${glossLabel}.`;

    const ipaRule = `For pronunciation fields: ${pronGuide}`;
    const accentNote = (srcLang === 'en') ? `Use ${accentLabel} pronunciation.` : `Do NOT include English accent notes for non-English.`;

    const posRule = (gloss === 'zh_CN' || gloss === 'zh_TW')
      ? 'Use POS in Chinese, e.g., 名词/动词/形容词/副词/短语/惯用语/助词/连词/叹词/敬语/形式体/感叹等。Do not output English labels like "Verb".'
      : `Use POS in ${glossLabel}; do not output English labels when ${glossLabel} is not English.`;

    const critical = `Critical constraints:
- All pronunciation fields must reflect the SOURCE language (${srcLabel}), NOT the gloss language. Never romanize Chinese for Japanese terms; e.g., "季節" must be "kisetsu", not Chinese Pinyin.
- If the script overlaps across languages (e.g., Han characters in Japanese), infer reading from the SOURCE language only.
- For English source: include both US and UK variants.
- Keep outputs compact and clean; no brackets, slashes, or extra commentary in fields.`;

    // Evidence context: up to two transcript lines per item, when available
    const ctx = Array.isArray(data && data.context) ? data.context : [];
    const evidence = ctx.length ? `\nEvidence from transcript (use to disambiguate meaning; do not quote verbatim in output):\n` + ctx.map((c, i) => {
      const lines = Array.isArray(c.lines) ? c.lines : [];
      const head = `${i + 1}. ${c.term}`;
      return head + (lines.length ? `\n- ${lines.join('\n- ')}` : '\n- (no match)');
    }).join('\n') + '\n' : '';

    const user = `Task: For each item, produce pronunciation (fields), part of speech (in the CHOSEN GLOSS LANGUAGE), a short learner-friendly definition anchored to the provided evidence (if any), two example pairs, and a brief note for common confusions/culture if relevant. Keep it compact.

${defRule}
${exampleRule}
${ipaRule}
${accentNote}
${posRule}
${critical}
${evidence}

Return JSON strictly with this shape and cardinality (exactly one card per input item, same order; do not add or drop items). Always include "ipa"; if source is English, also include both "ipa_us" and "ipa_uk":
{
  "cards": [ {
    "term": string,
    "ipa": string,            // pronunciation: see rules (for English, match the primary accent)
    "ipa_us": string,         // optional; required when source is English
    "ipa_uk": string,         // optional; required when source is English
    "pos": string,            // part-of-speech label in ${glossLabel}
    "definition": string,     // concise learner definition (${glossLabel})
    "examples": string[],     // exactly 2 strings; each has 2 lines as specified above
    "notes": string           // may be empty (${glossLabel})
  } ]
}

Additional formatting rules:
- Output raw JSON only (no Markdown fences).
- Do not use list markers (-, *, 1.) inside strings.
- Keep pronunciation clean: no slashes or brackets.

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
    return `IPA (broad). No slashes/brackets. Include ${accentLabel} variant. Keep only primary stress (ˈ).`;
  }
  if (s === 'zh_CN' || s === 'zh_TW') {
    return 'Hanyu Pinyin with tone marks (e.g., mā, má, mǎ, mà). No tone numbers. No IPA. Tone mark placement priority a > o > e > i > u > ü (choose the highest-ranked vowel in the syllable, e.g., shui → shuǐ). Use ü (not v).';
  }
  if (s === 'ja') {
    return 'Hepburn with macrons for long vowels: おう/おお → ō, うう → ū; keep ei as ei (e.g., sensei). Do NOT use ā/ī/ē. Use precomposed ō (U+014D)/Ō (U+014C), ū (U+016B)/Ū (U+016A). No IPA. No dashes or kana long mark (ー).';
  }
  if (s === 'ko') {
    return 'Revised Romanization of Korean (RR). ㅓ=eo, ㅗ=o, ㅡ=eu, ㅜ=u, ㅐ=ae, ㅔ=e; final ㄹ as l, syllable-initial/intervocalic ㄹ as r. No diacritics, no apostrophes, no IPA.';
  }
  if (s === 'ru') {
    return 'IPA (broad), Moscow standard. Mark stress. Use palatalization ʲ (e.g., /nʲ tʲ sʲ/). You may minimize unstressed vowel reduction, but keep readability. No slashes/brackets.';
  }
  if (s === 'fr') {
    return 'IPA (broad), Metropolitan French. Include nasal vowels (ɑ̃ ɔ̃ ɛ̃ œ̃) and uvular ʁ. Do NOT mark stress. Liaison optional. No slashes/brackets.';
  }
  if (s === 'de') {
    return 'IPA (broad), Standard German. Mark long vowels with ː when needed. Include y, ø, œ; ich/ach as ç/x. No slashes/brackets.';
  }
  if (s === 'es') {
    return 'IPA (learner-friendly), neutral seseo baseline. r/rr as ɾ/r. x as x (use [h] in many dialects, but keep x for consistency). No slashes/brackets.';
  }
  return 'Use the standard romanization or IPA customary for the language; clean text without slashes/brackets.';
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
    if (!text || !items.length) return parsed;
    const lang = normalizeLang(captionLang);
    const isLatin = ['en','fr','de','es','ru'].includes(lang);
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const contains = (term) => {
      if (!term) return false;
      if (isLatin) {
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i');
        return lines.some(l => re.test(l));
      }
      return lines.some(l => l.includes(term));
    };
    const filtered = items.filter(it => contains(String(it.term || '').trim()));
    // Optional: cap length again and sort by provided freq desc
    filtered.sort((a, b) => (b.freq || 0) - (a.freq || 0));
    out.items = typeof maxItems === 'number' ? filtered.slice(0, maxItems) : filtered;
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
    out.cards = cards.map((c) => {
      const cc = { ...c };
      // POS localization fallback for Chinese
      if (isZh && cc.pos) {
        const key = lower(cc.pos).replace(/\./g, '').trim();
        let mapped = null;
        for (const k in posMapCN) {
          if (key === k) { mapped = posMapCN[k]; break; }
        }
        if (mapped) cc.pos = (gloss === 'zh_TW') ? (posMapTW[mapped] || mapped) : mapped;
      }
      // Ensure English has both US/UK fields and pick primary in ipa
      if (normalizeLang(srcLang) === 'en') {
        const us = map(cc.ipa_us);
        const uk = map(cc.ipa_uk);
        if (!cc.ipa && (us || uk)) {
          cc.ipa = (accent === 'uk') ? (uk || us) : (us || uk);
        }
      }
      // Trim strings
      ['term','ipa','ipa_us','ipa_uk','pos','definition','notes'].forEach(f => { if (cc[f]) cc[f] = map(cc[f]); });
      if (Array.isArray(cc.examples)) cc.examples = cc.examples.map(x => map(x)).slice(0, 2);
      else cc.examples = [];
      return cc;
    });
    return out;
  } catch {
    return parsed;
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
  // Try to find the first {...} or [{...}] JSON block
  const match = text.match(/[\{\[][\s\S]*[\}\]]/);
  return match ? match[0] : text;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
