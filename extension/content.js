// content.js — Rabbithole UI: scrape and analyze visible transcript
(function() {
  const BTN_ID = 'rabbithole-btn';
  const PANEL_ID = 'rabbithole-panel';
  const PANEL_BODY_ID = PANEL_ID + '-body';

  // -- Utility helpers --
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // Opens the transcript sidebar on YouTube (if available)
  async function openTranscriptPanel() {
    // Attempt to find and click the transcript button if not already open
    // YouTube changes its DOM often
    const transcriptBtn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent && /(transcript|show transcript)/i.test(b.textContent));
    if (transcriptBtn && transcriptBtn.offsetParent !== null) {
      transcriptBtn.click();
      await sleep(350); // wait for UI
    }
    // YouTube auto-expands transcript on new UI
    // Just in case, scroll sidebar into view
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[section-identifier="engagement-panel-searchable-transcript"]');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(200);
  }

  // Returns transcript lines as text from the DOM, or null if not available
  function readTranscriptFromDOM() {
    // Modern YouTube UI
    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[section-identifier="engagement-panel-searchable-transcript"]'
    );
    if (!panel || panel.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') return null;
    // Find transcript items
    const items = panel.querySelectorAll('ytd-transcript-segment-renderer');
    if (!items.length) return null;
    return Array.from(items).map(item => {
      const span = item.querySelector('span');
      return span ? span.textContent : '';
    }).join(' ').replace(/\s+/g, ' ').trim();
  }

  // Main orchestrator: ensures transcript panel is open and tries to extract transcript.
  async function getTranscriptText() {
    await openTranscriptPanel();
    // Try for up to ~2s if loading
    for (let i = 0; i < 10; ++i) {
      const txt = readTranscriptFromDOM();
      if (txt && txt.length > 60) return txt;
      await sleep(200);
    }
    return null;
  }

  // UI setup logic -- same as before
  function makeButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.innerText = 'Rabbithole';
    btn.style.cssText = `
      padding:6px 10px;
      margin-left:8px;
      background:#ff6f61;
      color:white;
      border:none;
      border-radius:6px;
      font-weight:600;
      cursor:pointer;
      box-shadow:0 2px 6px rgba(0,0,0,0.12);
    `;
    btn.addEventListener('click', onButtonClick);
    return btn;
  }

  function makePanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: absolute;
      z-index: 999999;
      top: 10px;
      right: 10px;
      width: 360px;
      max-height: 60vh;
      overflow:auto;
      background: white;
      border-radius: 8px;
      padding:12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      display:none;
      font-family: system-ui, Arial;
      color: #111;
    `;
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <strong>Rabbithole</strong>
      <button id="${PANEL_ID}-close" style="background:none;border:none;cursor:pointer;font-size:16px">✕</button>
    </div>
    <div id="${PANEL_BODY_ID}">Loading...</div>
    <div style="margin-top:8px"><button id="${PANEL_ID}-save" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;cursor:pointer">Save to thread</button></div>`;
    return panel;
  }

  function injectUI() {
    // remove existing
    const existingBtn = document.getElementById(BTN_ID);
    if (existingBtn) existingBtn.remove();
    const existingPanel = document.getElementById(PANEL_ID);
    if (existingPanel) existingPanel.remove();

    let container = document.querySelector('#container #title') || document.querySelector('#above-the-fold') || document.querySelector('#top-level-buttons-computed') || document.querySelector('#info-contents');
    if (!container) container = document.querySelector('ytd-watch-flexy') || document.body;

    const btn = makeButton();
    try { container.appendChild(btn); } catch (e) { document.body.appendChild(btn); }
    const panel = makePanel();
    document.body.appendChild(panel);
    document.getElementById(`${PANEL_ID}-close`).addEventListener('click', () => {
      panel.style.display = 'none';
    });
    document.getElementById(`${PANEL_ID}-save`).addEventListener('click', () => {
      chrome.storage.local.get({ thread: [] }, (res) => {
        const ctx = getYouTubeWatchContext();
        const thread = res.thread || [];
        thread.unshift({ videoId: ctx.videoId, title: ctx.title, channel: ctx.channel, addedAt: Date.now() });
        chrome.storage.local.set({ thread }, () => {
          alert('Saved to thread ✅');
        });
      });
    });
  }

  // Extracts video/page context (url, title, channel).
  function getYouTubeWatchContext() {
    try {
      const url = new URL(window.location.href);
      const videoId = url.searchParams.get("v");
      if (!videoId) return { status: "no_video" };
      const titleEl = document.querySelector('h1.title') || document.querySelector('h1') || document.querySelector('h1.ytd-watch-metadata');
      const channelEl = document.querySelector('ytd-channel-name a') || document.querySelector('#text-container.ytd-channel-name a');
      return {
        status: "ok",
        videoId,
        title: titleEl ? titleEl.innerText.trim() : '',
        channel: channelEl ? channelEl.innerText.trim() : ''
      };
    } catch (err) {
      return { status: 'error', message: String(err) };
    }
  }

  // Handler for Rabbithole button click
  async function onButtonClick(ev) {
    const panel = document.getElementById(PANEL_ID);
    panel.style.display = 'block';
    panel.style.top = (window.scrollY + 20) + 'px';
    const body = document.getElementById(PANEL_BODY_ID);
    body.innerText = 'Detecting transcript...';
    const ctx = getYouTubeWatchContext();
    if (!ctx || ctx.status !== 'ok') {
      body.innerText = 'No video detected on this page.';
      return;
    }
    // -- Get transcript from DOM --
    let transcriptText = await getTranscriptText();
    if (!transcriptText) {
      body.innerHTML = `<div>No transcript found on the page.<br/><button id="${PANEL_BODY_ID}-retry" style="margin-top:10px;">Retry</button></div>`;
      document.getElementById(`${PANEL_BODY_ID}-retry`).onclick = onButtonClick;
      return;
    }
    // -- POST to backend /analyze --
    try {
      body.innerText = 'Analyzing (AI)...';
      const base = 'http://localhost:3000';
      const anRes = await fetch(base + '/analyze', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ videoId: ctx.videoId, title: ctx.title, transcript: transcriptText })
      });
      const analysis = await anRes.json();
      if (!anRes.ok || analysis.error) {
        body.innerHTML = `<div>Error analyzing:<br/>${(analysis.error||'Unknown error')}</div>`;
        return;
      }
      body.innerHTML = `<div><strong>Level:</strong> ${analysis.level} / 10 <div style="opacity:.8;font-size:12px">${analysis.level_reason || ''}</div></div>
        <hr/>
        <div><strong>Summary</strong><div>${analysis.summary}</div></div>
        <div style="margin-top:8px"><strong>Concepts</strong><ul>${(analysis.concepts||[]).map(c=>`<li>${c}</li>`).join('')}</ul></div>
        <div><strong>Prerequisite:</strong> ${analysis.prerequisite}</div>
        <div style="margin-top:8px"><strong>Try easier:</strong> ${analysis.easier}</div>
        <div><strong>Go deeper:</strong> ${analysis.deeper}</div>`;
    } catch (err) {
      body.innerHTML = `<div>Error contacting backend:<br>${(err.message||err)}</div>`;
    }
  }

  // SPA navigation detection for re-injecting UI
  let lastUrl = location.href;
  function detectUrlChange() {
    const cur = location.href;
    if (cur !== lastUrl) {
      lastUrl = cur;
      setTimeout(injectUI, 700);
    }
  }
  const _pushState = history.pushState;
  history.pushState = function() {
    _pushState.apply(this, arguments);
    detectUrlChange();
  };
  window.addEventListener('popstate', detectUrlChange);
  const observer = new MutationObserver(() => {
    if (document.querySelector('ytd-watch-flexy') || location.href.includes('watch?v=')) {
      injectUI();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(injectUI, 1200);
})();
