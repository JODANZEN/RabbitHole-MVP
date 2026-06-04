/**
 * RabbitHole v0.3 — Content Script
 *
 * Features:
 *  - Page analysis: difficulty level, summary, key concepts, prerequisites
 *  - Dumbify: select any text → floating "🐇 Explain" button → plain-language explanation
 *  - Paper recommendations: related papers from Semantic Scholar, ranked by complexity
 *  - Research thread: cross-domain session (chrome.storage.local) tracks your learning journey
 *
 * Panel tabs: Analysis | Papers | Thread
 */

'use strict';

const BACKEND_URL        = 'http://127.0.0.1:8000';
const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_KEY        = 'rabbithole_session';   // key in chrome.storage.local

console.debug('[RabbitHole] Content script loaded');

// ══════════════════════════════════════════════════════════════════════
// ── State ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

let lastAnalysisData = null;   // most recent analysis result
let papersCache      = null;   // paper recommendations for current page
let papersLoading    = false;
let currentTab       = 'analysis';
let dumbifyBtn       = null;
let pendingSelection = '';

// ══════════════════════════════════════════════════════════════════════
// ── Extension context guard ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

/**
 * Returns false when the extension has been reloaded/updated and this
 * content script instance is now "stale". All chrome.* API calls must
 * be guarded by this check to avoid "Extension context invalidated" crashes.
 */
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════
// ── Session helpers (chrome.storage.local → cross-domain) ─────────────
// ══════════════════════════════════════════════════════════════════════

function getSession() {
  return new Promise((resolve) => {
    if (!isContextValid()) { resolve(null); return; }
    try {
      chrome.storage.local.get([SESSION_KEY], (result) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(result[SESSION_KEY] || null);
      });
    } catch { resolve(null); }
  });
}

function saveSession(session) {
  return new Promise((resolve) => {
    if (!isContextValid()) { resolve(); return; }
    try {
      chrome.storage.local.set({ [SESSION_KEY]: session }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
        resolve();
      });
    } catch { resolve(); }
  });
}

function clearSessionStorage() {
  return new Promise((resolve) => {
    if (!isContextValid()) { resolve(); return; }
    try {
      chrome.storage.local.remove([SESSION_KEY], resolve);
    } catch { resolve(); }
  });
}

async function isInSession() {
  return !!(await getSession());
}

async function startSession() {
  const sessionId = crypto.randomUUID();
  const session = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    visits: [],
    concepts: {},   // concept → frequency count (across all visits)
  };
  await saveSession(session);

  // Best-effort backend registration (session works locally even if backend is down)
  fetch(BACKEND_URL + '/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(() => {});

  return session;
}

async function recordVisit(eventType, extra = {}) {
  const session = await getSession();
  if (!session) return;

  const visit = {
    url: location.href,
    title: extractTitle(),
    timestamp: new Date().toISOString(),
    event_type: eventType,
    level: extra.level || null,
    concepts: extra.concepts || [],
    concept: extra.concept || null,   // for concept_clicked events
  };

  session.visits = session.visits || [];

  if (eventType === 'page_analyzed') {
    // Deduplicate: remove any prior entry for this exact URL so re-analyzing
    // a page updates the record rather than growing an ever-longer list.
    const thisUrl = (location.href || '').replace(/\/$/, '');
    session.visits = session.visits.filter((v) =>
      !(v.event_type === 'page_analyzed' && (v.url || '').replace(/\/$/, '') === thisUrl)
    );
    // Invalidate the cached research-area inference so it refreshes with new data.
    delete session.research_area;
    delete session.research_area_key;
  }

  session.visits.unshift(visit);                    // newest first
  if (session.visits.length > 50) session.visits.length = 50;

  // Recompute concept frequency map from scratch so counts stay consistent
  // after deduplication (prevents ghost counts from removed entries).
  session.concepts = {};
  for (const v of session.visits) {
    if (v.event_type === 'page_analyzed') {
      for (const c of (v.concepts || [])) {
        session.concepts[c] = (session.concepts[c] || 0) + 1;
      }
    }
  }

  await saveSession(session);

  // Best-effort backend sync
  fetch(BACKEND_URL + '/session/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: session.session_id,
      url: visit.url,
      title: visit.title,
      timestamp: visit.timestamp,
      event_type: eventType,
      concept: visit.concept,
    }),
  }).catch(() => {});
}

/** Returns top N concepts by raw frequency across the session. */
function getTopConcepts(session, n = 5) {
  if (!session || !session.concepts) return [];
  return Object.entries(session.concepts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([c]) => c);
}

/**
 * Compute weighted concept scores with recency decay.
 *
 * Each page-analysis visit contributes a weight that decays exponentially
 * with age (most recent = 1.0, each prior page × DECAY). Each page's
 * contribution is also normalized by its concept count so a page with 6
 * concepts doesn't crowd out a page with 2.
 *
 * Returns [[concept, score], ...] sorted by score descending.
 */
function computeWeightedConcepts(session) {
  const DECAY = 0.78;
  const pageVisits = (session.visits || [])
    .filter((v) => v.event_type === 'page_analyzed' && (v.concepts || []).length > 0);

  const scores = {};
  pageVisits.forEach((visit, idx) => {
    const weight  = Math.pow(DECAY, idx);
    const n       = visit.concepts.length;
    const perItem = weight / n;
    visit.concepts.forEach((c) => {
      scores[c] = (scores[c] || 0) + perItem;
    });
  });

  return Object.entries(scores).sort((a, b) => b[1] - a[1]);
}

/**
 * Ask the backend to infer a human-readable research area from the session's
 * top weighted concepts. Result is cached inside the session object so the
 * LLM is only called when the concept set meaningfully changes.
 *
 * Returns { area, description } or null on error / too little data.
 */
async function inferResearchArea(session) {
  const weighted = computeWeightedConcepts(session);
  if (weighted.length < 3) return null;             // not enough data yet

  const topConcepts = weighted.slice(0, 8).map(([c]) => c);
  const cacheKey    = topConcepts.join('|');

  if (session.research_area && session.research_area_key === cacheKey) {
    return session.research_area;                   // still fresh
  }

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(BACKEND_URL + '/infer_research_area', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concepts: topConcepts }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!response.ok) return null;
    const data = await response.json();

    // Cache so we don't re-call the LLM on every tab switch
    session.research_area     = data;
    session.research_area_key = cacheKey;
    await saveSession(session);
    return data;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// ── Text extraction ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const CHROME_SELECTORS = [
  'nav', 'header', 'footer', 'aside', 'noscript',
  '.sidebar', '.nav', '.menu', '.breadcrumb',
  '.site-header', '.site-footer', '.toc', '.navbox',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '#rabbithole-panel', '#rh-dumbify-btn',
  '[class*="cookie"]', '[class*="Cookie"]',
  '[class*="share"]', '[class*="Share"]',
  '[class*="social"]', '[class*="Social"]',
  '[class*="comment"]', '[class*="Comment"]',
  '[class*="modal"]', '[class*="Modal"]',
  '[class*="popup"]', '[class*="Popup"]',
  '[class*="banner"]', '[class*="Banner"]',
  '[class*="newsletter"]', '[class*="Newsletter"]',
  '[class*="subscribe"]', '[class*="Subscribe"]',
  '[id*="cookie"]', '[id*="modal"]', '[id*="popup"]',
].join(', ');

const UI_NOISE_RE = /\b(enter rabbithole|analyzing|analyze paper|session active|click to explore|end session|rabbithole)\b/gi;

const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','is',
  'it','this','that','with','as','by','from','are','was','were','be',
  'has','have','had','do','does','did','will','would','can','could',
  'not','no','so','if','then','than','up','out','about','into','over',
  'after','before','between','under','above','below','all','each',
  'every','both','few','more','most','other','some','such','only',
]);

// ══════════════════════════════════════════════════════════════════════
// ── Format detection ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

/** True if the given href points to a raw PDF file. */
function _isPdfHref(href) {
  try { return /\.pdf(\?.*)?$/i.test(new URL(href).pathname); } catch { return false; }
}

/** True if the current page is a PDF — either by URL extension or because
 *  Chrome's native viewer is rendering it (document.contentType check handles
 *  URLs like arxiv.org/pdf/2603.24688 that have no .pdf extension). */
function isPdfPage() {
  if (_isPdfHref(location.href)) return true;
  try { if (document.contentType === 'application/pdf') return true; } catch { /* ignore */ }
  return false;
}

/** True if the URL is a .docx file. */
function isDocxPage() {
  try { return /\.docx(\?.*)?$/i.test(new URL(location.href).pathname); } catch { return false; }
}

/** True if the URL is a .epub file. */
function isEpubPage() {
  try { return /\.epub(\?.*)?$/i.test(new URL(location.href).pathname); } catch { return false; }
}

/**
 * Checks for PDF-in-viewer scenarios (Google Docs Viewer, PDF.js viewer,
 * embedded <embed>/<iframe>). Returns the real PDF URL or null.
 */
function getPdfViewerUrl() {
  try {
    const url = new URL(location.href);

    // Google Docs Viewer: docs.google.com/viewer?url=<pdf_url>
    //                 or: docs.google.com/gview?url=<pdf_url>
    if (
      url.hostname === 'docs.google.com' &&
      (url.pathname.startsWith('/viewer') || url.pathname.startsWith('/gview'))
    ) {
      const pdfUrl = url.searchParams.get('url');
      if (pdfUrl) return pdfUrl;
    }

    // PDF.js-style viewer: viewer.html?file=<pdf_url>
    const fileParam = url.searchParams.get('file');
    if (fileParam && _isPdfHref(fileParam)) return fileParam;

    // Embedded PDF via <embed type="application/pdf"> (Chrome native viewer,
    // src may not have .pdf extension) or <iframe src="...pdf">
    const embedded = document.querySelector('embed[type="application/pdf"], embed[src*=".pdf"], iframe[src*=".pdf"]');
    if (embedded) {
      const src = embedded.getAttribute('src') || '';
      if (src) {
        return src.startsWith('http') ? src : new URL(src, location.href).href;
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/**
 * Returns the detected document format for the current page, or null for plain HTML.
 * Shape: { format: 'pdf' | 'pdf-viewer' | 'docx' | 'epub', url: string } | null
 */
function getPageFormat() {
  if (isPdfPage())   return { format: 'pdf',        url: location.href };
  if (isDocxPage())  return { format: 'docx',       url: location.href };
  if (isEpubPage())  return { format: 'epub',       url: location.href };
  const viewerUrl = getPdfViewerUrl();
  if (viewerUrl)     return { format: 'pdf-viewer', url: viewerUrl };
  return null;
}

function extractText() {
  // Non-HTML document formats are handled server-side; return a sentinel.
  const fmt = getPageFormat();
  if (fmt) return { text: '', method: fmt.format, documentUrl: fmt.url };

  const selection = window.getSelection().toString().trim();
  if (selection.length > 100) {
    return { text: cleanText(selection), method: 'selection' };
  }

  const articleSelectors = [
    'article', '.mw-parser-output', '[role="article"]',
    '.article-body', '.post-content', '.entry-content',
    '.prose', 'main', '[role="main"]', '.arxiv',
  ];

  let root = null;
  for (const sel of articleSelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 200) { root = el; break; }
  }

  const source = root || document.body;
  const clone  = source.cloneNode(true);
  clone.querySelectorAll(CHROME_SELECTORS).forEach((el) => el.remove());
  clone.querySelectorAll('button, [role="button"], .btn').forEach((el) => {
    if (UI_NOISE_RE.test(el.textContent)) el.remove();
  });

  const raw    = clone.innerText.trim();
  const method = root ? 'selector' : 'fallback';
  return { text: cleanText(raw), method };
}

function cleanText(raw) {
  let lines = raw.split('\n');
  lines = lines.map((l) => l.replace(UI_NOISE_RE, '').trim());
  lines = lines.filter((l) => {
    if (!l) return false;
    if (l.length >= 20) return true;
    return /[.,;:!?]/.test(l);
  });
  lines = lines.filter((l) => {
    const words = l.split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    if (words.length <= 3 && l === l.toUpperCase() && !/\d/.test(l)) return false;
    const stopCount = words.filter((w) => STOPWORDS.has(w.toLowerCase())).length;
    if (words.length >= 3 && stopCount / words.length > 0.6 && l.length < 60) return false;
    return true;
  });
  lines = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle() {
  return (
    document.querySelector('h1')?.innerText.trim() ||
    document.querySelector('title')?.innerText.trim() ||
    document.domain
  );
}

// ══════════════════════════════════════════════════════════════════════
// ── Panel UI ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

function ensurePanel() {
  if (document.getElementById('rabbithole-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'rabbithole-panel';
  panel.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 2147483647;
    width: 420px; max-height: 88vh;
    background: #fff; border-radius: 12px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.22);
    overflow: hidden; display: flex; flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px; color: #333; line-height: 1.5;
  `;

  panel.innerHTML = `
    <!-- Header -->
    <div id="rh-header" style="
      padding: 12px 16px; display: flex; align-items: center; gap: 8px;
      background: linear-gradient(135deg,#667eea 0%,#764ba2 100%);
      border-radius: 12px 12px 0 0; flex-shrink: 0;
    ">
      <span style="font-size:16px;">🐇</span>
      <span style="font-weight:700; color:#fff; font-size:15px; flex:1;">RabbitHole</span>
      <span id="rh-session-badge" style="
        display:none; font-size:10px; background:rgba(255,255,255,0.22);
        color:#fff; padding:2px 8px; border-radius:10px; white-space:nowrap;
      ">Session active</span>
      <button id="rh-close" style="
        background:none; border:none; color:rgba(255,255,255,0.8);
        font-size:20px; cursor:pointer; padding:0; line-height:1;
      ">×</button>
    </div>

    <!-- Session bar -->
    <div id="rh-session-bar" style="
      padding:8px 16px; background:#f8f7ff;
      border-bottom:1px solid #e8e5f5; flex-shrink:0;
    "></div>

    <!-- Tabs -->
    <div id="rh-tabs" style="
      display:flex; border-bottom:1px solid #e8e5f5; flex-shrink:0;
      background:#fafafa;
    ">
      <button class="rh-tab-btn" data-tab="analysis" style="
        flex:1; padding:9px 4px; border:none; background:none; cursor:pointer;
        font-size:12px; font-weight:600; color:#667eea;
        border-bottom:2px solid #667eea;
      ">Analysis</button>
      <button class="rh-tab-btn" data-tab="papers" style="
        flex:1; padding:9px 4px; border:none; background:none; cursor:pointer;
        font-size:12px; font-weight:600; color:#aaa;
        border-bottom:2px solid transparent;
      ">Papers</button>
      <button class="rh-tab-btn" data-tab="thread" style="
        flex:1; padding:9px 4px; border:none; background:none; cursor:pointer;
        font-size:12px; font-weight:600; color:#aaa;
        border-bottom:2px solid transparent;
      ">Thread</button>
    </div>

    <!-- Content area -->
    <div id="rh-content" style="padding:16px; overflow-y:auto; flex:1; min-height:80px;">
      <p style="color:#999; text-align:center; margin:24px 0;">
        Click the RabbitHole icon to analyze this page.
      </p>
    </div>
  `;

  document.body.appendChild(panel);

  // Close button
  panel.querySelector('#rh-close').addEventListener('click', () => {
    panel.style.display = 'none';
  });

  // Tab switching
  panel.querySelectorAll('.rh-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  renderSessionBar();
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.rh-tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.style.color           = active ? '#667eea' : '#aaa';
    btn.style.borderBottom    = active ? '2px solid #667eea' : '2px solid transparent';
  });

  if (name === 'analysis') {
    if (lastAnalysisData) renderAnalysis(lastAnalysisData);
    else showPlaceholder('Click the RabbitHole icon to analyze this page.');
  } else if (name === 'papers') {
    renderPapersTab();
  } else if (name === 'thread') {
    renderThreadTab();
  }
}

async function renderSessionBar() {
  const bar   = document.getElementById('rh-session-bar');
  const badge = document.getElementById('rh-session-badge');
  if (!bar) return;

  const session = await getSession();
  if (session) {
    bar.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <span style="font-size:12px; color:#667eea; font-weight:600;">🟣 In Rabbithole</span>
        <button id="rh-end-session" style="
          font-size:11px; background:none; border:1px solid #ccc;
          border-radius:4px; padding:3px 10px; cursor:pointer; color:#888;
        ">End session</button>
      </div>
    `;
    if (badge) { badge.textContent = 'Session active'; badge.style.display = 'inline'; }

    document.getElementById('rh-end-session').addEventListener('click', async () => {
      await clearSessionStorage();
      renderSessionBar();
      // Refresh thread tab if active
      if (currentTab === 'thread') renderThreadTab();
    });
  } else {
    bar.innerHTML = `
      <button id="rh-enter-session" style="
        width:100%; padding:8px; border:none; border-radius:6px; cursor:pointer;
        font-size:13px; font-weight:600; color:#fff;
        background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
      ">Enter Rabbithole</button>
    `;
    if (badge) badge.style.display = 'none';

    document.getElementById('rh-enter-session').addEventListener('click', async () => {
      await startSession();
      renderSessionBar();
      if (lastAnalysisData) {
        recordVisit('page_analyzed', {
          level: lastAnalysisData.level,
          concepts: lastAnalysisData.concepts,
        });
      }
    });
  }
}

// ── Loading / Error / Placeholder ────────────────────────────────────

function showLoading(msg = 'Analyzing… please wait') {
  const el = document.getElementById('rh-content');
  if (el) el.innerHTML = `
    <div style="text-align:center; padding:32px 0; color:#667eea;">
      <div style="font-size:28px; margin-bottom:12px;">🐇</div>
      <p style="font-weight:600; margin:0;">${escapeHtml(msg)}</p>
    </div>
  `;
}

function showError(msg) {
  console.error('[RabbitHole]', msg);
  const el = document.getElementById('rh-content');
  if (el) el.innerHTML = `
    <div style="background:#fef2f2; border-left:3px solid #ef4444; padding:12px; border-radius:6px;">
      <p style="color:#b91c1c; font-size:13px; margin:0; line-height:1.5;">${escapeHtml(msg)}</p>
    </div>
  `;
}

function showPlaceholder(msg) {
  const el = document.getElementById('rh-content');
  if (el) el.innerHTML = `
    <p style="color:#999; text-align:center; margin:24px 0; font-size:13px;">${escapeHtml(msg)}</p>
  `;
}

// ══════════════════════════════════════════════════════════════════════
// ── Analysis ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

async function analyzeText() {
  try {
    const title   = extractTitle();
    const { text, method, documentUrl } = extractText();

    // ── Non-HTML document formats (PDF, PDF-viewer, DOCX, EPUB) ──
    const FORMAT_CONFIG = {
      'pdf':        { label: 'Extracting PDF text…',          endpoint: '/analyze_pdf_url'  },
      'pdf-viewer': { label: 'Extracting PDF text…',          endpoint: '/analyze_pdf_url'  },
      'docx':       { label: 'Extracting Word document text…', endpoint: '/analyze_docx_url' },
      'epub':       { label: 'Extracting EPUB text…',          endpoint: '/analyze_epub_url' },
    };

    if (FORMAT_CONFIG[method]) {
      const { label, endpoint } = FORMAT_CONFIG[method];
      // documentUrl is set for pdf-viewer; otherwise use the page URL
      const targetUrl = documentUrl || location.href;

      showLoading(label);
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(BACKEND_URL + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (!response.ok) {
        const err = await response.text();
        const fmtName = method === 'pdf' || method === 'pdf-viewer' ? 'PDF'
                      : method === 'docx' ? 'DOCX' : 'EPUB';
        showError(`${fmtName} analysis failed: HTTP ${response.status}. ${err}`);
        return;
      }
      const data = await response.json();
      lastAnalysisData = data;
      renderAnalysis(data);
      if (await isInSession()) recordVisit('page_analyzed', { level: data.level, concepts: data.concepts });
      startPaperRecommendations(data.concepts, data.level);
      return;
    }

    if (text.length < 50) {
      showError('Not enough text to analyze. Try visiting an article, or select a passage of text first.');
      return;
    }

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(BACKEND_URL + '/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text, url: location.href, cleaned: true, method }),
      signal: controller.signal,
    });
    clearTimeout(tid);

    if (!response.ok) {
      const err = await response.text();
      showError(`Backend error: HTTP ${response.status}. Is the backend running at ${BACKEND_URL}?`);
      return;
    }

    const data = await response.json();
    lastAnalysisData = data;
    renderAnalysis(data);
    if (await isInSession()) recordVisit('page_analyzed', { level: data.level, concepts: data.concepts });

    // Kick off paper recommendations in background
    startPaperRecommendations(data.concepts, data.level);

  } catch (error) {
    let msg = error.message;
    if (error.name === 'AbortError')              msg = 'Request timed out after 30s. Is the backend responding?';
    else if (error instanceof SyntaxError)        msg = 'Backend returned invalid JSON. Check server logs.';
    else if (msg.includes('Failed to fetch'))     msg = `Cannot reach backend at ${BACKEND_URL}. Make sure it is running.`;
    showError(msg);
  }
}

function renderAnalysis(data) {
  const required = ['level', 'level_reason', 'summary', 'concepts', 'prerequisite', 'easier', 'deeper'];
  const missing  = required.filter((f) => !(f in data));
  if (missing.length) { showError('Backend response missing fields: ' + missing.join(', ')); return; }

  const levelColor  = getLevelColor(data.level);
  const levelLabel  = getLevelLabel(data.level);
  const concepts    = Array.isArray(data.concepts) ? data.concepts : [];

  const chipsHtml = concepts.map((c) => {
    const safe = escapeHtml(c);
    return `<span class="rh-chip" data-concept="${safe}"
      style="display:inline-block; background:#eef0fb; border:1px solid #d4d8f0;
        padding:4px 10px; border-radius:14px; margin:0 4px 4px 0; font-size:12px;
        cursor:pointer; white-space:nowrap;">${safe}</span>`;
  }).join('');

  const html = `
    <!-- Difficulty badge -->
    <div style="margin-bottom:14px; display:flex; align-items:flex-start; gap:10px;">
      <div style="
        background:${levelColor}; color:#fff; font-weight:700; font-size:14px;
        padding:6px 14px; border-radius:8px; white-space:nowrap; flex-shrink:0;
      ">Level ${data.level}/10</div>
      <p style="margin:0; font-size:12px; color:#666; line-height:1.4; padding-top:5px;">
        ${escapeHtml(data.level_reason)}
      </p>
    </div>

    <!-- Summary -->
    <div style="margin-bottom:14px;">
      <p class="rh-section-label">Summary</p>
      <p style="margin:6px 0 0; font-size:13px; line-height:1.6; color:#333;">
        ${escapeHtml(data.summary)}
      </p>
    </div>

    <!-- Concepts -->
    <div style="margin-bottom:14px;">
      <p class="rh-section-label">
        Key Concepts
        <span style="font-weight:400; text-transform:none; font-size:10px; color:#aaa; letter-spacing:0;">
          (click to explore)
        </span>
      </p>
      <div style="display:flex; flex-wrap:wrap; margin-top:6px;">${chipsHtml}</div>
    </div>

    <!-- Learning path cards -->
    ${rhCard('Prerequisite', escapeHtml(data.prerequisite), '#667eea')}
    ${rhCard('Start here (easier)', escapeHtml(data.easier), '#48bb78')}
    ${rhCard('Go deeper', escapeHtml(data.deeper), '#ed8936')}

    ${data.confidence != null && data.confidence < 0.55
      ? `<p style="margin:10px 0 0; padding:7px 10px; background:#fff8e1;
           border-radius:6px; font-size:11px; color:#a07800;">
           ⚠️ Low confidence — the text may be too short or ambiguous for a precise analysis.
         </p>`
      : ''}
  `;

  const content = document.getElementById('rh-content');
  if (content) content.innerHTML = html;

  // Concept chip hover + click
  document.querySelectorAll('.rh-chip').forEach((chip) => {
    chip.addEventListener('mouseenter', () => { chip.style.background = '#dde1f7'; });
    chip.addEventListener('mouseleave', () => { chip.style.background = '#eef0fb'; });
    chip.addEventListener('click', async () => {
      const concept = chip.getAttribute('data-concept');
      window.open(`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(concept)}`, '_blank');
      if (await isInSession()) recordVisit('concept_clicked', { concept });
    });
  });
}

function rhCard(label, body, accentColor) {
  return `
    <div style="margin-bottom:10px; padding:10px 12px; background:#f9f8ff;
      border-left:3px solid ${accentColor}; border-radius:0 6px 6px 0;">
      <p style="margin:0; font-size:10px; font-weight:700; color:${accentColor};
        text-transform:uppercase; letter-spacing:0.5px;">${label}</p>
      <p style="margin:5px 0 0; font-size:12px; color:#444; line-height:1.5;">${body}</p>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════
// ── Paper Recommendations ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

async function startPaperRecommendations(concepts, level) {
  papersCache   = null;
  papersLoading = true;

  // Pull top session-wide concepts (excluding ones already in current page)
  // so the backend can widen the Semantic Scholar query toward the user's
  // broader research area, not just the single paper they're looking at now.
  let sessionConcepts = [];
  try {
    const session = await getSession();
    if (session) {
      sessionConcepts = computeWeightedConcepts(session)
        .slice(0, 5)
        .map(([c]) => c)
        .filter((c) => !concepts.includes(c));   // don't duplicate current-page concepts
    }
  } catch { /* ignore — recommendations still work without session context */ }

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(BACKEND_URL + '/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concepts, level, session_concepts: sessionConcepts }),
      signal: controller.signal,
    });
    clearTimeout(tid);

    if (response.ok) {
      const data = await response.json();
      papersCache = data.papers || [];
    } else {
      papersCache = [];
    }
  } catch {
    papersCache = [];
  }

  papersLoading = false;

  // If user is already on the Papers tab, refresh it
  if (currentTab === 'papers') renderPapersTab();

  // Update tab label to show count
  const papersTab = document.querySelector('.rh-tab-btn[data-tab="papers"]');
  if (papersTab && papersCache && papersCache.length) {
    papersTab.textContent = `Papers (${papersCache.length})`;
  }
}

function renderPapersTab() {
  const content = document.getElementById('rh-content');
  if (!content) return;

  if (papersLoading) {
    content.innerHTML = `
      <div style="text-align:center; padding:32px 0; color:#667eea;">
        <div style="font-size:24px; margin-bottom:10px;">🔍</div>
        <p style="font-weight:600; margin:0;">Searching Semantic Scholar…</p>
      </div>
    `;
    return;
  }

  if (!papersCache) {
    content.innerHTML = `
      <p style="color:#999; text-align:center; margin:24px 0;">
        Analyze a page first to get related paper recommendations.
      </p>
    `;
    return;
  }

  if (!papersCache.length) {
    content.innerHTML = `
      <p style="color:#999; text-align:center; margin:24px 0;">
        No related papers found. Try analyzing a more specific article.
      </p>
    `;
    return;
  }

  const papers = papersCache;
  const html = `
    <p class="rh-section-label" style="margin-bottom:10px;">
      Related Papers — ranked by complexity match
    </p>
    ${papers.map((p) => renderPaperCard(p)).join('')}
    <p style="margin-top:12px; font-size:10px; color:#ccc; text-align:center;">
      Powered by Semantic Scholar
    </p>
  `;
  content.innerHTML = html;
}

function renderPaperCard(paper) {
  const levelColor = getLevelColor(paper.complexity || 5);
  const title = escapeHtml(paper.title || 'Untitled');
  const year  = paper.year ? `${paper.year} · ` : '';
  const cites = paper.citations ? `${paper.citations} citations` : '';
  const abstract = paper.abstract ? escapeHtml(paper.abstract) : '';
  const url   = paper.url || '';

  return `
    <div style="margin-bottom:12px; padding:12px; background:#f9f8ff;
      border-radius:8px; border:1px solid #eee;">
      <div style="display:flex; align-items:flex-start; gap:8px; margin-bottom:6px;">
        <span style="
          background:${levelColor}; color:#fff; font-size:10px; font-weight:700;
          padding:2px 7px; border-radius:10px; flex-shrink:0; margin-top:1px;
        ">L${paper.complexity || '?'}</span>
        <div style="flex:1; min-width:0;">
          ${url
            ? `<a href="${url}" target="_blank" rel="noopener"
                style="font-weight:600; color:#667eea; font-size:12px;
                  text-decoration:none; word-break:break-word;">${title}</a>`
            : `<span style="font-weight:600; font-size:12px;">${title}</span>`}
          <p style="margin:2px 0 0; font-size:11px; color:#aaa;">${year}${cites}</p>
        </div>
      </div>
      ${abstract
        ? `<p style="margin:0; font-size:11px; color:#555; line-height:1.5;">
             ${abstract}
           </p>`
        : ''}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════
// ── Dumbify ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

function setupDumbifyButton() {
  if (document.getElementById('rh-dumbify-btn')) return;

  dumbifyBtn = document.createElement('button');
  dumbifyBtn.id = 'rh-dumbify-btn';
  dumbifyBtn.innerHTML = '🐇 Explain';
  dumbifyBtn.style.cssText = `
    position: fixed; z-index: 2147483646;
    background: linear-gradient(135deg,#667eea 0%,#764ba2 100%);
    color: #fff; border: none; border-radius: 20px;
    padding: 6px 16px; font-size: 12px; font-weight: 700;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    cursor: pointer; box-shadow: 0 3px 14px rgba(102,126,234,0.45);
    display: none; white-space: nowrap; user-select: none;
    transform: translateX(-50%);
    transition: opacity 0.15s, transform 0.15s;
  `;

  dumbifyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = pendingSelection;
    hideDumbifyButton();
    if (text.length >= 5) triggerDumbify(text);
  });

  document.body.appendChild(dumbifyBtn);
}

function showDumbifyButton() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) { hideDumbifyButton(); return; }

  const text = selection.toString().trim();
  if (text.length < 10) { hideDumbifyButton(); return; }

  // Don't show if selection is inside our panel
  try {
    const range     = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const panel     = document.getElementById('rabbithole-panel');
    if (panel && panel.contains(container instanceof Element ? container : container.parentElement)) {
      hideDumbifyButton(); return;
    }

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { hideDumbifyButton(); return; }

    pendingSelection = text;

    if (!dumbifyBtn) setupDumbifyButton();
    dumbifyBtn.style.display = 'block';
    dumbifyBtn.style.left    = Math.max(60, Math.min(rect.left + rect.width / 2, window.innerWidth - 60)) + 'px';
    dumbifyBtn.style.top     = Math.max(8, rect.top - 44) + 'px';
  } catch { hideDumbifyButton(); }
}

function hideDumbifyButton() {
  if (dumbifyBtn) dumbifyBtn.style.display = 'none';
  pendingSelection = '';
}

async function triggerDumbify(text) {
  ensurePanel();
  const panel = document.getElementById('rabbithole-panel');
  panel.style.display = 'flex';

  // Switch to analysis tab to show dumbify result
  switchTab('analysis');
  showLoading('Explaining in plain terms…');

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(BACKEND_URL + '/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, context: '' }),
      signal: controller.signal,
    });
    clearTimeout(tid);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    renderDumbifyResult(data, text);
  } catch (error) {
    const msg = error.name === 'AbortError'
      ? 'Request timed out.'
      : `Dumbify failed: ${error.message}. Is the backend running?`;
    showError(msg);
  }
}

function renderDumbifyResult(data, originalText) {
  const content = document.getElementById('rh-content');
  if (!content) return;

  const snippet  = originalText.slice(0, 140);
  const ellipsis = originalText.length > 140 ? '…' : '';

  const termsHtml = (data.terms || []).map((t) => `
    <div style="padding:7px 10px; background:#f0eeff; border-radius:6px; margin-bottom:5px;">
      <span style="font-weight:700; color:#667eea; font-size:12px;">${escapeHtml(t.term || '')}</span>
      <span style="color:#555; font-size:12px;"> — ${escapeHtml(t.means || '')}</span>
    </div>
  `).join('');

  content.innerHTML = `
    <!-- Quote -->
    <div style="margin-bottom:14px; padding:10px 12px; background:#f8f7ff;
      border-radius:8px; border-left:3px solid #667eea;">
      <p style="margin:0; font-size:11px; color:#888; font-style:italic; line-height:1.5;">
        "${escapeHtml(snippet)}${escapeHtml(ellipsis)}"
      </p>
    </div>

    <!-- Plain explanation -->
    <div style="margin-bottom:14px;">
      <p class="rh-section-label">In plain terms</p>
      <p style="margin:6px 0 0; font-size:13px; line-height:1.6; color:#333;">
        ${escapeHtml(data.explanation || '')}
      </p>
    </div>

    <!-- Analogy -->
    ${data.analogy ? `
    <div style="margin-bottom:14px; padding:10px 12px; background:#fffbea;
      border-radius:8px; border-left:3px solid #f6cc46;">
      <p style="margin:0 0 4px; font-size:10px; font-weight:700; color:#a07800;
        text-transform:uppercase; letter-spacing:0.5px;">Think of it like…</p>
      <p style="margin:0; font-size:13px; line-height:1.5; color:#555;">
        ${escapeHtml(data.analogy)}
      </p>
    </div>` : ''}

    <!-- Terms -->
    ${termsHtml ? `
    <div style="margin-bottom:14px;">
      <p class="rh-section-label">Key terms</p>
      <div style="margin-top:6px;">${termsHtml}</div>
    </div>` : ''}

    <!-- Why it matters -->
    ${data.why_matters ? `
    <div style="margin-bottom:14px; padding:10px 12px; background:#f0fff4;
      border-radius:8px; border-left:3px solid #48bb78;">
      <p style="margin:0 0 4px; font-size:10px; font-weight:700; color:#276749;
        text-transform:uppercase; letter-spacing:0.5px;">Why it matters</p>
      <p style="margin:0; font-size:13px; line-height:1.5; color:#2d6a4f;">
        ${escapeHtml(data.why_matters)}
      </p>
    </div>` : ''}

    <!-- Back button -->
    <button id="rh-back-analysis" style="
      margin-top:4px; width:100%; padding:8px; background:none;
      border:1px solid #ddd; border-radius:6px; font-size:12px;
      color:#888; cursor:pointer;
    ">← Back to analysis</button>
  `;

  document.getElementById('rh-back-analysis').addEventListener('click', () => {
    if (lastAnalysisData) renderAnalysis(lastAnalysisData);
    else showPlaceholder('Click the RabbitHole icon to analyze a page.');
  });
}

// ══════════════════════════════════════════════════════════════════════
// ── Research Thread ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

async function renderThreadTab() {
  const content = document.getElementById('rh-content');
  if (!content) return;

  const session = await getSession();

  if (!session) {
    content.innerHTML = `
      <div style="text-align:center; padding:24px 0; color:#999;">
        <div style="font-size:32px; margin-bottom:10px;">🕳️</div>
        <p style="font-weight:600; margin:0 0 8px; color:#555;">No active session</p>
        <p style="margin:0; font-size:12px; line-height:1.5;">
          Click "Enter Rabbithole" to start tracking your research journey across the web.
        </p>
      </div>
    `;
    return;
  }

  const visits     = session.visits || [];
  const pageVisits = visits.filter((v) => v.event_type === 'page_analyzed');

  // ── Weighted concepts (recency-decayed, normalized per page) ────────
  const weighted    = computeWeightedConcepts(session);   // [[concept, score], ...]
  const topWeighted = weighted.slice(0, 8);
  const maxScore    = topWeighted[0]?.[1] || 1;

  // ── Concept chips with proportional weight bars ─────────────────────
  const conceptChipsHtml = topWeighted.map(([c, score]) => {
    const pct = Math.round((score / maxScore) * 100);
    return `
      <div style="margin-bottom:6px;">
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:2px;">
          <span style="font-size:11px; color:#444; font-weight:600; flex:1;">${escapeHtml(c)}</span>
          <span style="font-size:10px; color:#aaa;">${pct}%</span>
        </div>
        <div style="height:3px; background:#e8e5f5; border-radius:2px;">
          <div style="height:3px; width:${pct}%; background:linear-gradient(90deg,#667eea,#764ba2);
            border-radius:2px; transition:width 0.4s;"></div>
        </div>
      </div>`;
  }).join('');

  // ── Visit timeline cards ─────────────────────────────────────────────
  const visitCards = visits.slice(0, 15).map((v) => {
    const levelColor = v.level ? getLevelColor(v.level) : '#ccc';
    const levelBadge = v.level
      ? `<span style="background:${levelColor}; color:#fff; font-size:9px;
           font-weight:700; padding:1px 6px; border-radius:8px; margin-right:4px; flex-shrink:0;">
           L${v.level}
         </span>`
      : '';
    const concepts    = (v.concepts || []).slice(0, 3).map(escapeHtml).join(', ');
    const ts          = v.timestamp ? new Date(v.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
    const titleDisplay = v.event_type === 'concept_clicked'
      ? `<em style="color:#888;">Explored: ${escapeHtml(v.concept || '')}</em>`
      : escapeHtml(v.title || v.url || 'Unknown page');

    return `
      <div style="margin-bottom:8px; padding:9px 11px; background:#f9f8ff;
        border-radius:8px; border:1px solid #eee;">
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:2px;">
          ${levelBadge}
          <span style="font-size:12px; font-weight:600; color:#333; overflow:hidden;
            white-space:nowrap; text-overflow:ellipsis; flex:1;" title="${escapeHtml(v.url || '')}">
            ${titleDisplay}
          </span>
          ${ts ? `<span style="font-size:10px; color:#ccc; flex-shrink:0;">${ts}</span>` : ''}
        </div>
        ${concepts ? `<p style="margin:0; font-size:10px; color:#aaa; padding-left:${v.level ? '44px' : '0'};">${concepts}</p>` : ''}
      </div>`;
  }).join('');

  // ── Initial render (area label is a placeholder while we call the LLM) ─
  const cachedArea = session.research_area;
  const areaLabel  = cachedArea?.area        || (topWeighted.length ? topWeighted.slice(0, 2).map(([c]) => c).join(' & ') : 'General research');
  const areaDesc   = cachedArea?.description || '';

  content.innerHTML = `
    <!-- Research focus card -->
    <div id="rh-focus-card" style="margin-bottom:14px; padding:12px 14px;
      background:linear-gradient(135deg,#f0eeff,#e8f4ff); border-radius:10px;">
      <p style="margin:0 0 2px; font-size:10px; font-weight:700; color:#667eea;
        text-transform:uppercase; letter-spacing:0.5px;">Research focus</p>
      <p id="rh-focus-area" style="margin:0 0 4px; font-size:14px; font-weight:700; color:#333;">
        ${escapeHtml(areaLabel)}
      </p>
      <p id="rh-focus-desc" style="margin:0 0 10px; font-size:11px; color:#666; line-height:1.5;">
        ${escapeHtml(areaDesc)}
      </p>
      ${conceptChipsHtml
        ? `<div style="margin-top:8px;">${conceptChipsHtml}</div>`
        : ''}
      <p style="margin:10px 0 0; font-size:10px; color:#aaa;">
        ${pageVisits.length} page${pageVisits.length !== 1 ? 's' : ''} analyzed · ${weighted.length} concept${weighted.length !== 1 ? 's' : ''} tracked
      </p>
    </div>

    <!-- Visit timeline -->
    <p class="rh-section-label" style="margin-bottom:8px;">Recent pages</p>
    ${visitCards || `<p style="color:#bbb; font-size:12px; margin:0;">No pages analyzed yet.</p>`}
  `;

  // ── Async: call LLM to infer a proper research area label ───────────
  // Only fires when we have ≥ 3 weighted concepts and a fresh result isn't cached.
  if (weighted.length >= 3) {
    inferResearchArea(session).then((area) => {
      if (!area) return;
      const areaEl = document.getElementById('rh-focus-area');
      const descEl = document.getElementById('rh-focus-desc');
      if (areaEl) areaEl.textContent = area.area || areaLabel;
      if (descEl) descEl.textContent = area.description || '';
    });
  }
}

// ══════════════════════════════════════════════════════════════════════
// ── Utilities ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

function getLevelColor(level) {
  const palette = {
    1:'#22c55e', 2:'#16a34a', 3:'#3b82f6', 4:'#2563eb',
    5:'#8b5cf6', 6:'#7c3aed', 7:'#f59e0b', 8:'#d97706',
    9:'#ef4444', 10:'#dc2626',
  };
  return palette[Math.round(level)] || '#667eea';
}

function getLevelLabel(level) {
  if (level <= 2) return 'Beginner';
  if (level <= 4) return 'Introductory';
  if (level <= 6) return 'Intermediate';
  if (level <= 8) return 'Advanced';
  return 'Expert';
}

function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Inject the shared section-label style once
(function injectStyles() {
  if (document.getElementById('rh-styles')) return;
  const style = document.createElement('style');
  style.id = 'rh-styles';
  style.textContent = `
    .rh-section-label {
      margin: 0 0 4px;
      font-size: 10px;
      font-weight: 700;
      color: #667eea;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    #rh-dumbify-btn:hover { opacity: 0.9; }
  `;
  document.head.appendChild(style);
})();

// ══════════════════════════════════════════════════════════════════════
// ── Global selection listener (Dumbify float button) ────────────────────
// ══════════════════════════════════════════════════════════════════════

setupDumbifyButton();

document.addEventListener('mouseup', (e) => {
  if (dumbifyBtn && dumbifyBtn.contains(e.target)) return;
  setTimeout(showDumbifyButton, 60);   // small delay so selection settles
});

document.addEventListener('keyup', () => {
  setTimeout(showDumbifyButton, 60);
});

document.addEventListener('mousedown', (e) => {
  if (dumbifyBtn && dumbifyBtn.contains(e.target)) return;
  hideDumbifyButton();
});

document.addEventListener('selectionchange', () => {
  const s = window.getSelection();
  if (!s || s.isCollapsed) hideDumbifyButton();
});

// ══════════════════════════════════════════════════════════════════════
// ── Message listener ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Guard: if the extension was reloaded, this context is stale — ignore silently
  if (!isContextValid()) return;

  if (message.type === 'ANALYZE_PAGE') {
    ensurePanel();
    const panel = document.getElementById('rabbithole-panel');
    panel.style.display = 'flex';
    switchTab('analysis');
    showLoading();
    analyzeText();
    sendResponse({ ok: true });
  }

  if (message.type === 'DUMBIFY_SELECTION') {
    const text = (message.text || '').trim();
    if (text.length >= 5) triggerDumbify(text);
    sendResponse({ ok: true });
  }
});

console.debug('[RabbitHole] v0.3 ready');
