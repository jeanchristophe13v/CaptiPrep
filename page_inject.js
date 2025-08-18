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
    if (!d || d.type !== 'CC_FETCH_CAPTION' || !d.url || !d.id) return;
    try {
      const res = await fetch(d.url, { credentials: 'include' });
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      window.postMessage({ type: 'CC_FETCH_CAPTION_RESULT', id: d.id, ok: !!res.ok, status: res.status, contentType: ct, text }, '*');
    } catch (e) {
      try { window.postMessage({ type: 'CC_FETCH_CAPTION_RESULT', id: d.id, ok: false, status: 0, contentType: '', text: '', error: String(e) }, '*'); } catch {}
    }
  });
})();
