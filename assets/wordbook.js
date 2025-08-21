// Wordbook page script (runs in extension tab)

const CC_NS = 'CCAPTIPREPS';
let __i18nDict = null;
function t(k, ...subs) {
  if (__i18nDict && __i18nDict[k]) {
    let s = __i18nDict[k];
    if (subs && subs.length) subs.forEach((v, i) => { s = s.replace(new RegExp('\\$' + (i + 1), 'g'), String(v)); });
    return s;
  }
  return (chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage(k, subs) : '') || k;
}
function applyI18nPlaceholders(root = document) {
  const getMsg = (raw) => {
    const m = /^__MSG_([A-Za-z0-9_]+)__$/.exec(raw || '');
    if (!m) return null;
    const key = m[1];
    const v = (__i18nDict && __i18nDict[key]) || ((chrome.i18n && chrome.i18n.getMessage) ? chrome.i18n.getMessage(key) : '');
    return v || null;
  };
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const all = root.querySelectorAll('*');
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
}
const KEY_VIDEOS = `${CC_NS}:video:`; // prefix
const KEY_FAV_VIDEOS = `${CC_NS}:fav:videos`;
const KEY_FAV_WORDS = `${CC_NS}:fav:words`;

const el = (sel) => document.querySelector(sel);

const state = {
  tab: 'history',
  items: [], // history: [{videoId,title,createdAt,words:[...] }]
  selected: new Set(), // for videos (videoId)
  selectedWordKeys: new Set(), // for fav words (composite key)
  favVideos: new Set(),
  favWords: [],
};

(async () => {
  try {
    const store = await chrome.storage.local.get('settings');
    let lang = (store && store.settings && store.settings.uiLang) || 'auto';
    if (lang && lang !== 'auto') {
      const url = chrome.runtime.getURL(`assets/i18n/${lang}.json`);
      const res = await fetch(url);
      if (res.ok) __i18nDict = await res.json();
    }
  } catch {}
  try { applyI18nPlaceholders(document); } catch {}
  try { if (__i18nDict && __i18nDict.wordbook_title) document.title = __i18nDict.wordbook_title; } catch {}
  init();
})();

async function init() {
  await loadFavs();
  await loadHistory();
  bindNav();
  bindToolbar();
  bindStorageListeners();
  render();
}

function bindNav() {
  document.querySelectorAll('.wb-nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      state.tab = tab;
      document.querySelectorAll('.wb-nav button').forEach(b=>b.classList.toggle('active', b===btn));
      el('#wb-current-title').textContent = btn.textContent;
      transitionPane(() => render());
    });
  });
}

function bindToolbar() {
  el('#wb-select-all').addEventListener('click', () => {
    if (state.tab === 'favWords') {
      const keys = (currentList() || []).map(wordKey);
      const all = keys.length > 0 && keys.every(k => state.selectedWordKeys.has(k));
      if (all) keys.forEach(k => state.selectedWordKeys.delete(k));
      else keys.forEach(k => state.selectedWordKeys.add(k));
      render();
      return;
    }
    const ids = currentList().map(v => v.videoId || v.id);
    const allSelected = ids.length > 0 && ids.every(id => state.selected.has(id));
    if (allSelected) ids.forEach(id => state.selected.delete(id));
    else ids.forEach(id => state.selected.add(id));
    render();
  });
  el('#wb-delete').addEventListener('click', onDelete);
  el('#wb-export').addEventListener('click', onExport);
}

function transitionPane(fn) {
  const pane = el('#wb-pane');
  pane.classList.add('enter');
  fn();
  requestAnimationFrame(()=>{
    pane.classList.add('enter-active');
    setTimeout(()=>{ pane.classList.remove('enter'); pane.classList.remove('enter-active'); }, 180);
  });
}

async function loadFavs() {
  const o1 = await chrome.storage.local.get(KEY_FAV_VIDEOS);
  const vset = Array.isArray(o1[KEY_FAV_VIDEOS]) ? new Set(o1[KEY_FAV_VIDEOS]) : new Set();
  state.favVideos = vset;
  const o2 = await chrome.storage.local.get(KEY_FAV_WORDS);
  state.favWords = Array.isArray(o2[KEY_FAV_WORDS]) ? o2[KEY_FAV_WORDS] : [];
}

async function loadHistory() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.keys(all).filter(k => k.startsWith(KEY_VIDEOS));
  const out = [];
  for (const k of entries) {
    const data = all[k] || {};
    if (!data.cards || !data.cards.length) continue;
    const videoId = k.slice(KEY_VIDEOS.length);
    const title = safeTitle(data.title) || videoId;
    const createdAt = data.createdAt || toYYYYMMDD(new Date(data.__ts || Date.now()));
    const words = (data.selected || data.cards || []).map(it => (it.term || it)).slice(0, 30);
    out.push({ videoId, title, createdAt, words });
  }
  // group by date
  out.sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1));
  state.items = out;
}

function currentList() {
  if (state.tab === 'history') return state.items;
  if (state.tab === 'favVideos') return state.items.filter(it => state.favVideos.has(it.videoId));
  if (state.tab === 'favWords') return state.favWords; // different shape
  return [];
}

function render() {
  const pane = el('#wb-pane');
  pane.innerHTML = '';
  if (state.tab === 'favWords') {
    renderFavWords(pane);
    return;
  }
  // history / favVideos
  const groups = groupByDate(currentList());
  for (const [date, list] of groups) {
    const sec = document.createElement('div'); sec.className = 'wb-section';
    const h = document.createElement('div'); h.className = 'wb-date'; h.textContent = date; sec.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'wb-grid';
    for (const item of list) grid.appendChild(renderVideoCard(item));
    sec.appendChild(grid);
    pane.appendChild(sec);
  }
}

function groupByDate(list) {
  const map = new Map();
  for (const it of list) {
    const d = it.createdAt || toYYYYMMDD(new Date());
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(it);
  }
  return map;
}

function renderVideoCard(item) {
  const card = document.createElement('div'); card.className = 'wb-vcard';
  const id = item.videoId;
  const checked = state.selected.has(id);
  const isFav = state.favVideos.has(id);
  card.classList.toggle('selected', checked);
  card.innerHTML = `
    <div class="chk wb-icon select ${checked ? 'active' : ''}" data-act="select" aria-pressed="${checked}">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <div class="fav wb-icon ${isFav ? 'active':''}" data-act="fav">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
    </div>
    <div class="left">
      <div class="cover"><img alt="cover" data-id="${id}"/></div>
      <div class="title">${escapeHtml(item.title)}</div>
    </div>
    <div class="right">
      <div class="terms">
        ${item.words.map(w => `<div class="term-item">${escapeHtml(typeof w === 'string' ? w : (w.term || ''))}</div>`).join('')}
        <div class="fade"></div>
      </div>
    </div>
  `;
  // cover
  const img = card.querySelector('img');
  setCover(img, id);
  // clicks
  card.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'select') {
      if (checked) state.selected.delete(id); else state.selected.add(id);
      render();
      e.stopPropagation();
      return;
    }
    if (act === 'fav') {
      toggleFavVideo(id).then(()=>{ render(); });
      e.stopPropagation();
      return;
    }
    openDetail(item.videoId, item.title);
  });
  return card;
}

function renderFavWords(pane) {
  if (!state.favWords.length) { pane.innerHTML = '<div class="cc-card">' + t('wordbook_none_fav_words') + '</div>'; return; }
  const groups = groupByDateFavWords(state.favWords);
  for (const [date, list] of groups) {
    const sec = document.createElement('div'); sec.className = 'wb-section';
    const h = document.createElement('div'); h.className = 'wb-date'; h.textContent = date; sec.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'wb-card-grid';
    for (const w of list) {
      const c = document.createElement('div'); c.className = 'cc-card';
      const key = wordKey(w);
      const isSel = state.selectedWordKeys.has(key);
      c.innerHTML = `
        <div class="wb-icon chk select ${isSel ? 'active' : ''}" data-act="select"></div>
        <div><b>${escapeHtml(w.snapshot.term||'')}</b></div>
        <div class="cc-small">${escapeHtml(w.snapshot.pos||'')}</div>
        <div>${escapeHtml(w.snapshot.definition||'')}</div>`;
      const btn = c.querySelector('.chk');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
      c.style.cursor = 'pointer';
      c.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.getAttribute('data-act');
        if (act === 'select') {
          if (isSel) state.selectedWordKeys.delete(key); else state.selectedWordKeys.add(key);
          render();
          e.stopPropagation();
          return;
        }
        openDetailWordPool(list, w);
      });
      grid.appendChild(c);
    }
    sec.appendChild(grid);
    pane.appendChild(sec);
  }
}

function groupByDateFavWords(list) {
  const map = new Map();
  for (const it of list) {
    const d = toYYYYMMDD(new Date(it.savedAt || Date.now()));
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(it);
  }
  return map;
}

async function toggleFavVideo(videoId) {
  const list = Array.from(state.favVideos);
  const idx = list.indexOf(videoId);
  if (idx >= 0) list.splice(idx,1); else list.push(videoId);
  await chrome.storage.local.set({ [KEY_FAV_VIDEOS]: list });
  state.favVideos = new Set(list);
}

async function onDelete() {
  if (state.tab === 'favWords') {
    const keys = new Set(state.selectedWordKeys);
    if (!keys.size) return;
    const list = state.favWords.filter(w => !keys.has(wordKey(w)));
    await chrome.storage.local.set({ [KEY_FAV_WORDS]: list });
    state.selectedWordKeys.clear();
    state.favWords = list;
    render();
    return;
  }
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  const all = await chrome.storage.local.get(null);
  for (const id of ids) {
    const key = KEY_VIDEOS + id;
    await chrome.storage.local.remove(key);
  }
  state.selected.clear();
  await loadHistory();
  render();
}

async function onExport() {
  // When on favorite-words tab, export the selected words' snapshots
  if (state.tab === 'favWords') {
    const selectedSet = new Set(state.selectedWordKeys);
    const chosen = state.favWords.filter(w => selectedSet.has(wordKey(w)));
    if (!chosen.length) return;
    const cards = chosen.map(w => w.snapshot).filter(Boolean);
    if (!cards.length) return;
    exportCSV(cards, `${t('export_favorites_prefix')}-${toYYYYMMDD(new Date())}`);
    return;
  }
  // Otherwise export selected videos
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  const all = await chrome.storage.local.get(null);
  for (const id of ids) {
    const data = all[KEY_VIDEOS + id];
    if (!data || !data.cards || !data.cards.length) continue;
    exportCSV(data.cards, data.title || id);
  }
}

function exportCSV(cards, title) {
  const rows = [['term', 'ipa', 'pos', 'definition', 'notes', 'examples']]
    .concat(cards.map(c => [
      c.term||'', c.ipa||'', c.pos||'', c.definition||'', c.notes||'', (c.examples||[]).join('\n\n')
    ]))
    .map(r => r.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(','))
    .join('\r\n');
  const blob = new Blob(['\ufeff' + rows], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = sanitize(title) + '.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

async function openDetail(videoId, title) {
  const key = KEY_VIDEOS + videoId;
  const o = await chrome.storage.local.get(key);
  const data = o[key] || {};
  const cards = data.cards || [];
  const overlay = el('#wb-overlay');
  const grid = el('#wb-card-grid');
  // reset any previous big card and ensure cover/grid visible
  const body = el('.wb-m-body');
  const prevBig = body.querySelector('.cc-card.cc-large');
  if (prevBig) prevBig.remove();
  el('.wb-m-cover').style.display = '';
  grid.style.display = '';
  el('#wb-m-title').textContent = title;
  const img = el('#wb-m-img'); setCover(img, videoId);
  overlay.style.display = 'flex';
  grid.innerHTML = '';
  for (let i=0;i<cards.length;i++) {
    const c = cards[i];
    const card = document.createElement('div'); card.className = 'cc-card';
    card.innerHTML = `<div><b>${escapeHtml(c.term||'')}</b></div>
      <div class="cc-small">${escapeHtml(c.pos||'')}</div>
      <div>${escapeHtml(c.definition||'')}</div>`;
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openCardModal(cards, i, { videoId, title }));
    grid.appendChild(card);
  }
  bindOverlayBasicClose();
  setActiveKeyNav({ close: closeOverlay, fav: () => { const b = el('#wb-fav-word'); if (b) b.click(); } });
}

function bindOverlayBasicClose() {
  const overlay = el('#wb-overlay');
  const close = el('#wb-close');
  const modal = overlay.querySelector('.wb-modal');
  function onBg(e){ if (!modal.contains(e.target)) closeOverlay(); }
  overlay.addEventListener('mousedown', onBg, { once:true });
  close.addEventListener('click', closeOverlay, { once:true });
}

function closeOverlay(){
  el('#wb-overlay').style.display = 'none';
  el('#wb-bottom').style.display = 'none';
  const body = el('.wb-m-body');
  const big = body && body.querySelector('.cc-card.cc-large');
  if (big) big.remove();
  // restore cover and grid visibility for next open
  const cover = el('.wb-m-cover'); if (cover) cover.style.display = '';
  const grid = el('#wb-card-grid'); if (grid) grid.style.display = '';
  setActiveKeyNav(null);
}

// Second overlay: dedicated word-card modal above video detail
function openCardModal(cards, startIdx, ctx) {
  const overlay = el('#wb-overlay-card');
  const body = overlay.querySelector('.wb-m-body');
  const big = el('#wb2-big');
  const bottom = el('#wb2-bottom');
  let idx = startIdx;
  let edit = false;
  function render() {
    el('#wb2-m-title').textContent = cards[idx]?.term || ctx.title || '';
    overlay.style.display = 'flex';
    big.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'cc-card cc-large';
    container.innerHTML = edit ? renderCardEditor(cards[idx]) : renderCardView(cards[idx]);
    big.appendChild(container);
    bottom.style.display = 'flex';
    // buttons
    el('#wb2-prev').onclick = () => { try{document.activeElement.blur();}catch{} idx = (idx - 1 + cards.length) % cards.length; edit=false; render(); };
    el('#wb2-next').onclick = () => { try{document.activeElement.blur();}catch{} idx = (idx + 1) % cards.length; edit=false; render(); };
    el('#wb2-edit').onclick = () => { try{document.activeElement.blur();}catch{} edit = !edit; render(); };
    el('#wb2-save').onclick = async () => {
      if (!edit) return;
      const edited = readCardEditor();
      cards[idx] = edited;
      await saveCardsForVideo(ctx.videoId, cards);
      edit = false; render();
    };
    el('#wb2-save').disabled = !edit;
    // favorite toggle + active state
    updateFavActive('#wb2-fav-word', ctx.videoId, idx);
    el('#wb2-fav-word').onclick = async () => {
      try{document.activeElement.blur();}catch{}
      const added = await toggleFavoriteWord({ videoId: ctx.videoId, title: ctx.title, cardIndex: idx, snapshot: cards[idx] });
      const btn = el('#wb2-fav-word');
      if (btn) {
        btn.classList.toggle('active', added);
        if (added) { btn.classList.add('cc-ok'); setTimeout(()=>btn.classList.remove('cc-ok'), 600); }
      }
    };
    setActiveKeyNav({
      prev: () => el('#wb2-prev').onclick(),
      next: () => el('#wb2-next').onclick(),
      close: closeCardOverlay,
      fav: () => { const b = el('#wb2-fav-word'); if (b) b.click(); }
    });
  }
  // close behaviors
  const modal = overlay.querySelector('.wb-modal');
  function onBg(e){ if (!modal.contains(e.target)) closeCardOverlay(); }
  overlay.addEventListener('mousedown', onBg, { once:true });
  el('#wb2-close').onclick = closeCardOverlay;
  render();
}

function closeCardOverlay(){
  const overlay = el('#wb-overlay-card');
  overlay.style.display = 'none';
  const bottom = el('#wb2-bottom'); if (bottom) bottom.style.display = 'none';
  const big = el('#wb2-big'); if (big) big.innerHTML = '';
  // restore ESC handling for underlying video overlay if visible
  const baseVisible = el('#wb-overlay') && el('#wb-overlay').style.display === 'flex';
  setActiveKeyNav(baseVisible ? { close: closeOverlay } : null);
}

function openDetailWordPool(pool, current) {
  const overlay = el('#wb-overlay');
  const body = overlay.querySelector('.wb-m-body');
  const bottom = el('#wb-bottom');
  let idx = pool.indexOf(current);
  let edit = false;
  overlay.style.display = 'flex';
  // set title and cover from current
  el('#wb-m-title').textContent = current.title || current.snapshot?.term || '';
  setCover(el('#wb-m-img'), current.videoId);
  // Hide cover and grid for word-detail preview to avoid visual contamination
  el('.wb-m-cover').style.display = 'none';
  el('#wb-card-grid').style.display = 'none';
  function render() {
    let container = body.querySelector('.cc-card.cc-large');
    if (!container) { container = document.createElement('div'); container.className = 'cc-card cc-large'; body.insertBefore(container, body.firstChild); }
    const card = pool[idx].snapshot;
    container.innerHTML = edit ? renderCardEditor(card) : renderCardView(card);
    bottom.style.display = 'flex';
    el('#wb-prev').onclick = () => { try{document.activeElement.blur();}catch{} idx = (idx - 1 + pool.length) % pool.length; edit=false; render(); };
    el('#wb-next').onclick = () => { try{document.activeElement.blur();}catch{} idx = (idx + 1) % pool.length; edit=false; render(); };
    el('#wb-edit').onclick = () => { try{document.activeElement.blur();}catch{} edit = !edit; render(); };
    el('#wb-save').onclick = async () => {
      if (!edit) return;
      const edited = readCardEditor();
      // update snapshot in storage
      pool[idx].snapshot = edited;
      await chrome.storage.local.set({ [KEY_FAV_WORDS]: pool });
      edit = false; render();
    };
    el('#wb-save').disabled = !edit;
    updateFavActive('#wb-fav-word', pool[idx].videoId, pool[idx].cardIndex);
    el('#wb-fav-word').onclick = async () => {
      const item = pool[idx];
      try{document.activeElement.blur();}catch{}
      const added = await toggleFavoriteWord({ videoId: item.videoId, title: item.title, cardIndex: item.cardIndex, snapshot: item.snapshot });
      const btn = el('#wb-fav-word');
      if (btn) {
        btn.classList.toggle('active', added);
        if (added) { btn.classList.add('cc-ok'); setTimeout(()=>btn.classList.remove('cc-ok'), 600); }
      }
    };
    setActiveKeyNav({
      prev: () => el('#wb-prev').onclick(),
      next: () => el('#wb-next').onclick(),
      close: closeOverlay,
      fav: () => { const b = el('#wb-fav-word'); if (b) b.click(); }
    });
  }
  bindOverlayBasicClose();
  render();
}

function setCover(imgEl, videoId) {
  const max = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/maxresdefault.jpg`;
  const hq = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
  imgEl.src = max;
  imgEl.onerror = () => { if (imgEl.src !== hq) imgEl.src = hq; };
}

function toYYYYMMDD(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
function sanitize(s){ return String(s||'export').replace(/[\\/:*?"<>|]/g, '_'); }
function safeTitle(t){ const s = String(t||'').trim(); if (!s || s.toLowerCase()==='(untitled)' || s.toLowerCase()==='untitled') return ''; return s; }
function escapeHtml(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function wordKey(w){
  // Use savedAt + videoId + cardIndex as stable composite key
  return `${w.savedAt || ''}|${w.videoId || ''}|${w.cardIndex ?? ''}`;
}

function bindStorageListeners(){
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (KEY_FAV_WORDS in changes) {
      const nv = changes[KEY_FAV_WORDS].newValue;
      state.favWords = Array.isArray(nv) ? nv : [];
      // drop selections that no longer exist
      const valid = new Set(state.favWords.map(wordKey));
      state.selectedWordKeys.forEach(k => { if (!valid.has(k)) state.selectedWordKeys.delete(k); });
      if (state.tab === 'favWords') render();
    }
    if (KEY_FAV_VIDEOS in changes) {
      const nv = changes[KEY_FAV_VIDEOS].newValue;
      state.favVideos = new Set(Array.isArray(nv) ? nv : []);
      if (state.tab !== 'favWords') render();
    }
  });
}

// Shared big card renderer/editor (minimal duplication of ui.js)
function renderCardView(card) {
  const c = { term: '', ipa: '', pos: '', definition: '', examples: [], notes: '', ...card };
  const ipa = (c.ipa||'').replace(/^\/+|\/+$/g, '');
  const ex = (c.examples||[]).slice(0,2).map(raw => {
    const lines = String(raw).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const en = lines[0]||''; const zh = lines[1]||'';
    return `<blockquote><div>${escapeHtml(en)}</div>${zh?`<div class="cc-small">${escapeHtml(zh)}</div>`:''}</blockquote>`;
  }).join('');
  return `
    <div class="cc-view">
      <div class="term">${escapeHtml(c.term)}</div>
      <div class="meta">${ipa?`/${escapeHtml(ipa)}/`:''} ${c.pos?`· ${escapeHtml(c.pos)}`:''}</div>
      <div class="definition">${escapeHtml(c.definition||'')}</div>
      ${ex?`<div class="examples-quote">${ex}</div>`:''}
      ${c.notes?`<div class="notes">${escapeHtml(c.notes)}</div>`:''}
    </div>`;
}
function renderCardEditor(card){
  const c = { term:'', ipa:'', pos:'', definition:'', examples:[], notes:'', ...card };
  return `
    <div class="cc-editor">
      <label>Term</label><input class="cc-input" id="cc-term" value="${escapeAttr(c.term)}"/>
      <label>IPA</label><input class="cc-input" id="cc-ipa" value="${escapeAttr(c.ipa)}"/>
      <label>POS</label><input class="cc-input" id="cc-pos" value="${escapeAttr(c.pos)}"/>
      <label>Definition</label><input class="cc-input" id="cc-def" value="${escapeAttr(c.definition)}"/>
      <label>Examples</label><textarea class="cc-input ex" id="cc-ex" rows="6">${escapeHtml((c.examples||[]).join('\n\n'))}</textarea>
      <label>Notes</label><textarea class="cc-input notes" id="cc-notes" rows="4">${escapeHtml(c.notes||'')}</textarea>
    </div>`;
}
function readCardEditor(){
  const term = document.getElementById('cc-term').value.trim();
  const ipa = document.getElementById('cc-ipa').value.trim();
  const pos = document.getElementById('cc-pos').value.trim();
  const definition = document.getElementById('cc-def').value.trim();
  const raw = document.getElementById('cc-ex').value;
  const examples = raw.split(/\r?\n\s*\r?\n/).map(b=>b.replace(/\s+$/,'').replace(/^\s+/,'')).filter(Boolean);
  const notes = document.getElementById('cc-notes').value.trim();
  return { term, ipa, pos, definition, examples, notes };
}
function escapeAttr(s){ return String(s).replace(/["&<>]/g, c => ({'"':'&quot;','&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

async function saveCardsForVideo(videoId, cards){
  const key = KEY_VIDEOS + videoId;
  const o = await chrome.storage.local.get(key);
  const cur = o[key] || {};
  await chrome.storage.local.set({ [key]: { ...cur, cards } });
}

async function addFavoriteWordSnapshot({ videoId, title, cardIndex, snapshot }){
  const o = await chrome.storage.local.get(KEY_FAV_WORDS);
  const list = Array.isArray(o[KEY_FAV_WORDS]) ? o[KEY_FAV_WORDS] : [];
  list.push({ videoId, title, cardIndex, snapshot, savedAt: new Date().toISOString() });
  await chrome.storage.local.set({ [KEY_FAV_WORDS]: list });
}

async function isWordFavorited(videoId, cardIndex){
  const o = await chrome.storage.local.get(KEY_FAV_WORDS);
  const list = Array.isArray(o[KEY_FAV_WORDS]) ? o[KEY_FAV_WORDS] : [];
  return list.some(it => it && it.videoId === videoId && it.cardIndex === cardIndex);
}

async function toggleFavoriteWord({ videoId, title, cardIndex, snapshot }){
  const o = await chrome.storage.local.get(KEY_FAV_WORDS);
  let list = Array.isArray(o[KEY_FAV_WORDS]) ? o[KEY_FAV_WORDS] : [];
  const exists = list.some(it => it && it.videoId === videoId && it.cardIndex === cardIndex);
  if (exists) {
    list = list.filter(it => !(it && it.videoId === videoId && it.cardIndex === cardIndex));
    await chrome.storage.local.set({ [KEY_FAV_WORDS]: list });
    return false;
  } else {
    list.push({ videoId, title, cardIndex, snapshot, savedAt: new Date().toISOString() });
    await chrome.storage.local.set({ [KEY_FAV_WORDS]: list });
    return true;
  }
}

async function updateFavActive(sel, videoId, cardIndex){
  const btn = el(sel);
  if (!btn) return;
  const active = await isWordFavorited(videoId, cardIndex);
  btn.classList.toggle('active', !!active);
}

// Keyboard navigation (Left/Right) and Escape to close
let __activeKeyNav = null;
function setActiveKeyNav(nav){ __activeKeyNav = nav; }
document.addEventListener('keydown', (e) => {
  if (!__activeKeyNav) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === 'Escape') { e.preventDefault(); __activeKeyNav.close && __activeKeyNav.close(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); __activeKeyNav.prev && __activeKeyNav.prev(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); __activeKeyNav.next && __activeKeyNav.next(); return; }
  if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); __activeKeyNav.fav && __activeKeyNav.fav(); return; }
});
