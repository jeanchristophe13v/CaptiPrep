(() => {
  function post(pr, error) {
    try {
      window.postMessage({ type: 'CC_PLAYER_RESPONSE', payload: pr || null, error: error ? String(error) : undefined }, '*');
    } catch (e) {
      try { window.postMessage({ type: 'CC_PLAYER_RESPONSE', payload: null, error: String(e) }, '*'); } catch {}
    }
  }
  function readPR() {
    try {
      // Try multiple sources for player response
      let pr = window.ytInitialPlayerResponse;
      if (!pr && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
        const args = window.ytplayer.config.args;
        if (args.player_response) {
          try {
            pr = JSON.parse(args.player_response);
          } catch {}
        }
      }
      // Also try from ytPlayerConfig if available
      if (!pr && window.ytPlayerConfig && window.ytPlayerConfig.args && window.ytPlayerConfig.args.player_response) {
        try {
          pr = JSON.parse(window.ytPlayerConfig.args.player_response);
        } catch {}
      }
      return pr;
    } catch (e) {
      return null;
    }
  }

  // NEW: helpers to read InnerTube runtime config from the page safely
  function getYtCfgValue(key) {
    try {
      const ytcfg = window.ytcfg;
      if (ytcfg && typeof ytcfg.get === 'function') {
        const v = ytcfg.get(key);
        if (v !== undefined && v !== null && v !== '') return v;
      }
      const data = ytcfg && (ytcfg.data_ || ytcfg.data);
      if (data && data[key] !== undefined) return data[key];
    } catch {}
    return undefined;
  }
  function getInnerTubeDefaults() {
    const pr = readPR();
    const apiKey = getYtCfgValue('INNERTUBE_API_KEY');
    const clientVersion = getYtCfgValue('INNERTUBE_CLIENT_VERSION');
    const visitorData = getYtCfgValue('VISITOR_DATA') || (pr && pr.responseContext && pr.responseContext.visitorData) || undefined;
    return { apiKey, clientVersion, visitorData };
  }
  
  // Try immediate read first
  const immediate = readPR();
  if (immediate) {
    post(immediate);
  } else {
    // If not available, poll for it
    const start = Date.now();
    const timeoutMs = 8000; // wait up to 8s (increased)
    const int = setInterval(() => {
      const pr = readPR();
      if (pr) {
        clearInterval(int);
        post(pr);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(int);
        post(null, 'Timed out waiting for ytInitialPlayerResponse');
      }
    }, 150); // check more frequently
  }

  // Caption fetch proxy: allow content script to fetch via page context
  window.addEventListener('message', async (event) => {
    const d = event && event.data;
    if (!d) return;

    // Existing caption fetch (GET)
    if (d.type === 'CC_FETCH_CAPTION' && d.url && d.id) {
      try {
        const res = await fetch(d.url, { credentials: 'include' });
        const ct = res.headers.get('content-type') || '';
        const text = await res.text();
        window.postMessage({ type: 'CC_FETCH_CAPTION_RESULT', id: d.id, ok: !!res.ok, status: res.status, contentType: ct, text }, '*');
      } catch (e) {
        try { window.postMessage({ type: 'CC_FETCH_CAPTION_RESULT', id: d.id, ok: false, status: 0, contentType: '', text: '', error: String(e) }, '*'); } catch {}
      }
      return;
    }

    // NEW: InnerTube POST proxy (player/next/get_transcript)
    if (d.type === 'CC_YT_API' && d.id && d.endpoint && d.payload) {
      try {
        const API_BASE = 'https://www.youtube.com/youtubei/v1';
        const { apiKey: pageApiKey, clientVersion: pageClientVersion, visitorData: pageVisitorData } = getInnerTubeDefaults();
        const API_KEY = d.apiKey || pageApiKey;
        if (!API_KEY) {
          try { window.postMessage({ type: 'CC_YT_API_RESULT', id: d.id, ok: false, status: 0, contentType: '', json: null, text: '', error: 'No INNERTUBE_API_KEY available' }, '*'); } catch {}
          return;
        }
        const url = `${API_BASE}${d.endpoint}?key=${API_KEY}`;
        const headers = {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'X-Youtube-Client-Name': '1', // WEB
        };
        const cv = d.clientVersion || pageClientVersion;
        if (cv) headers['X-Youtube-Client-Version'] = cv;
        const visitorId = (d.payload && (d.payload.visitorData || (d.payload.context && d.payload.context.client && d.payload.context.client.visitorData))) || pageVisitorData;
        if (visitorId) headers['X-Goog-Visitor-Id'] = visitorId;

        // Normalize payload to include clientName/clientVersion/visitorData when missing
        let payload;
        try { payload = JSON.parse(JSON.stringify(d.payload)); } catch { payload = d.payload || {}; }
        if (!payload.context) payload.context = {};
        if (!payload.context.client) payload.context.client = {};
        if (!payload.context.client.clientName) payload.context.client.clientName = 'WEB';
        if (cv && !payload.context.client.clientVersion) payload.context.client.clientVersion = cv;
        const pv = visitorId;
        if (pv) {
          if (!payload.visitorData) payload.visitorData = pv;
          if (!payload.context.client.visitorData) payload.context.client.visitorData = pv;
        }

        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), credentials: 'include' });
        const ct = res.headers.get('content-type') || '';
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch {}
        window.postMessage({ type: 'CC_YT_API_RESULT', id: d.id, ok: !!res.ok, status: res.status, contentType: ct, json, text }, '*');
      } catch (e) {
        try { window.postMessage({ type: 'CC_YT_API_RESULT', id: d.id, ok: false, status: 0, contentType: '', json: null, text: '', error: String(e) }, '*'); } catch {}
      }
      return;
    }
  });
})();
