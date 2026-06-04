// @ts-nocheck — TODO: progressively remove as this file is split into typed modules.
/**
 * RabbitHole — Content Script (entry)
 *
 * Features:
 *  - Page analysis: difficulty level, summary, key concepts, prerequisites
 *  - Dumbify: select any text → floating "🐇 Explain" button → plain-language explanation
 *  - Paper recommendations: related papers from Semantic Scholar, ranked by complexity
 *  - Research thread: cross-domain session (chrome.storage.local) tracks your learning journey
 *  - Course: syllabus-grounded analysis (see ./db)
 *
 * Panel tabs: Analysis | Papers | Thread | Course
 */

import { getActiveCourseId, setActiveCourseId } from './db';
import { signIn, signUp, signOut, getCurrentUser, getAccessToken } from './auth';

const GEMINI_API_URL     = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GROQ_API_URL       = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL         = 'llama-3.3-70b-versatile';
const GEMINI_KEY_STORAGE    = 'rabbithole_gemini_key';
const GROQ_KEY_STORAGE      = 'rabbithole_groq_key';
const PRIMARY_PROVIDER_KEY  = 'rabbithole_primary_provider'; // 'gemini' | 'groq'
const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_KEY        = 'rabbithole_session';   // key in chrome.storage.local

// ── Backend (course/RAG features) ──────────────────────────────────────
const BACKEND_URL = 'http://127.0.0.1:8000';

async function apiFetch(path, options = {}) {
  let res;
  const token = await getAccessToken();   // null when signed out
  try {
    res = await fetch(BACKEND_URL + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    throw new Error(`Can't reach the RabbitHole backend at ${BACKEND_URL}. Is it running? (cd papers && uvicorn backend.main:app)`);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); detail = j.detail || detail; } catch {}
    if (res.status === 503) detail = 'Course features need the database. Check DATABASE_URL in papers/.env.';
    throw new Error(detail);
  }
  return res.json();
}

const CourseAPI = {
  create:     (name, syllabus)     => apiFetch('/courses', { method: 'POST', body: JSON.stringify({ name, syllabus }) }),
  get:        (id)                 => apiFetch('/courses/' + id),
  list:       ()                   => apiFetch('/courses'),
  remove:     (id)                 => apiFetch('/courses/' + id, { method: 'DELETE' }),
  addReading: (id, title, text)    => apiFetch(`/courses/${id}/readings`, { method: 'POST', body: JSON.stringify({ title, text }) }),
  ask:        (id, question, history) => apiFetch(`/courses/${id}/ask`, { method: 'POST', body: JSON.stringify({ question, history }) }),
};

// ── API key helpers ────────────────────────────────────────────────────

function getApiKeys() {
  return new Promise((resolve) => {
    chrome.storage.local.get([GEMINI_KEY_STORAGE, GROQ_KEY_STORAGE, PRIMARY_PROVIDER_KEY], (r) => {
      resolve({
        gemini:  r[GEMINI_KEY_STORAGE] || '',
        groq:    r[GROQ_KEY_STORAGE]   || '',
        primary: r[PRIMARY_PROVIDER_KEY] || 'gemini',
      });
    });
  });
}

// ── LLM callers (Gemini primary → Groq fallback) ─────────────────────

function isQuotaError(status, msg) {
  return status === 429 || (msg || '').toLowerCase().includes('quota') || (msg || '').toLowerCase().includes('rate_limit');
}

async function _callGemini(prompt, apiKey) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.0 },
      }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${response.status}`;
      if (isQuotaError(response.status, msg)) { const e = new Error(msg); e.isQuota = true; throw e; }
      if (response.status === 400 && msg.includes('API_KEY')) throw new Error('Invalid Gemini key. Open ⚙️ settings to update it.');
      if (response.status === 403) throw new Error('Gemini key not authorized. Enable the API at aistudio.google.com.');
      throw new Error(`Gemini: ${msg}`);
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(clean);
  } finally {
    clearTimeout(tid);
  }
}

async function _callGroq(prompt, apiKey) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0,
      }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${response.status}`;
      if (isQuotaError(response.status, msg)) { const e = new Error(msg); e.isQuota = true; throw e; }
      if (response.status === 401) throw new Error('Invalid Groq key. Open ⚙️ settings to update it.');
      throw new Error(`Groq: ${msg}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(clean);
  } finally {
    clearTimeout(tid);
  }
}

async function callLLM(prompt) {
  const { gemini, groq, primary } = await getApiKeys();
  if (!gemini && !groq) throw new Error('no_keys');

  const ordered = primary === 'groq'
    ? [{ type: 'groq', key: groq }, { type: 'gemini', key: gemini }]
    : [{ type: 'gemini', key: gemini }, { type: 'groq', key: groq }];

  const available = ordered.filter((p) => p.key);
  let lastErr;
  for (const p of available) {
    try {
      return await (p.type === 'gemini' ? _callGemini(prompt, p.key) : _callGroq(prompt, p.key));
    } catch (err) {
      lastErr = err;
      if (err.isQuota && available.indexOf(p) < available.length - 1) {
        console.debug(`[RabbitHole] ${p.type} quota hit — trying fallback`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── Prompt templates (mirrors papers/backend/prompts.py) ─────────────

function buildAnalysisPrompt(title, text, course = null) {
  const courseSection = course
    ? `\nCOURSE CONTEXT — the student is studying this material for:\n` +
      `Course: ${course.name}\n` +
      (course.processed?.semester ? `Semester: ${course.processed.semester}\n` : '') +
      `Key course concepts: ${(course.processed?.key_concepts || []).slice(0, 15).join(', ')}\n` +
      `When relevant, note connections to these course topics in your summary and concepts.\n`
    : '';
  return `You are RabbitHole, an expert academic-content analyst.${courseSection}

You MUST output ONLY valid JSON exactly matching the schema below.
Do NOT output any explanation, commentary, markdown fences, or text outside the JSON object.

──────────────────────────────────────────────
TITLE: ${title}

TEXT (pre-cleaned article content — UI/menu text has been stripped):
${text.slice(0, 120000)}
──────────────────────────────────────────────

REQUIRED OUTPUT (strict JSON, nothing else):

{
  "level": <integer 1-10>,
  "level_reason": "<one sentence explaining the rating>",
  "summary": "<2-4 sentence summary of the text's main points>",
  "concepts": ["<phrase 1>", "<phrase 2>", ... 5-7 phrases],
  "prerequisite": "<one sentence: what should the reader know first>",
  "easier": "<one sentence: a concrete recommendation for an easier starting point>",
  "deeper": "<one sentence: a concrete pointer for going deeper into the topic>",
  "confidence": <float 0.0-1.0>
}

RULES:
1. level — 1-2: everyday language; 3-4: intro textbook; 5-6: intermediate; 7-8: advanced with math/notation; 9-10: frontier research. Base on CONTENT INDICATORS (math symbols, citation density, jargon), not word count.
2. concepts — 5-7 noun phrases (2-4 words each) that MUST appear verbatim (case-insensitive) in the TEXT above. Never include UI labels, author names, or generic filler.
3. prerequisite — one concrete knowledge area (e.g. "linear algebra and matrix decomposition").
4. easier — one specific real resource (e.g. "Wikipedia article on Bayesian inference").
5. deeper — one real subfield or named topic direction.
6. confidence — 0.0-1.0 self-assessed confidence.
7. summary — 2-4 sentences about what the text actually says.

Output ONLY the JSON object. No preamble, no trailing text, no markdown fences.`;
}

function buildExplainPrompt(text) {
  return `You are RabbitHole's Dumbify engine — you make complex academic and scientific text understandable to anyone curious but non-expert.

A reader selected this text:

SELECTED TEXT:
${text.slice(0, 2000)}
──────────────────────────────────────────────

Output ONLY valid JSON matching this exact schema (no markdown, no extra text):

{
  "explanation": "<2-3 sentences in plain everyday language a curious teenager could understand>",
  "analogy": "<one vivid, concrete real-world analogy>",
  "terms": [{"term": "<technical term>", "means": "<one-sentence simple definition>"}, ...],
  "why_matters": "<one sentence on why this is significant>"
}

RULES:
1. No jargon in explanation. Define any technical word inline.
2. Analogy must be creative and specific. Use cooking, sports, everyday objects, etc.
3. terms — 2-4 key technical terms from the selection. Empty array [] if none.
4. why_matters — be motivating and concrete.

Output ONLY the JSON object.`;
}

function buildSyllabusPrompt(syllabusText) {
  return `You are parsing a university course syllabus. Extract the structure and return ONLY valid JSON — no markdown, no extra text.

SYLLABUS TEXT:
${syllabusText.slice(0, 40000)}

Return this exact schema:
{
  "course_name": "<full course name and number, e.g. ECON 301: Macroeconomics>",
  "instructor": "<professor name or empty string>",
  "semester": "<e.g. Fall 2026 or empty string>",
  "weeks": [
    {
      "week": <integer>,
      "topic": "<main topic for this week>",
      "concepts": ["<key concept 1>", "<key concept 2>"],
      "readings": ["<reading title or description>"]
    }
  ],
  "key_concepts": ["<important concept>", ...],
  "learning_outcomes": ["<outcome>", ...]
}

RULES:
- weeks: extract as many weeks as exist in the syllabus. If dates are given instead of week numbers, number them sequentially.
- key_concepts: 10-20 of the most important terms/concepts across the whole course.
- learning_outcomes: what students should be able to do by the end of the course.
- If a field has no information in the syllabus, use an empty string or empty array.
- Output ONLY the JSON object.`;
}

function buildResearchAreaPrompt(concepts) {
  const list = concepts.map((c) => `- ${c}`).join('\n');
  return `You are classifying a researcher's area of study based on the topics they have been reading.

Concepts encountered (weighted by recency and frequency):
${list}

Respond with ONLY a raw JSON object — no markdown, no explanation:
{"area":"<2-5 word field name, e.g. Quantum Machine Learning>","description":"<one sentence: what the researcher seems to be studying, mentioning 2-3 key themes>"}`;
}

// ── Semantic Scholar (free, no key needed) ────────────────────────────

function estimateComplexity(text) {
  if (!text || text.length < 30) return 5;
  const words = text.split(/\s+/);
  const longWords = words.filter((w) => w.length > 10).length;
  const hasMath = /[=∑∫∂∇σμλ]|\\frac|theorem|proof|lemma/i.test(text);
  const hasRefs = /\[\d+\]|\(et al\.?\)/i.test(text);
  let level = 4;
  if (longWords / Math.max(words.length, 1) > 0.12) level += 2;
  if (hasMath) level += 2;
  if (hasRefs) level += 1;
  return Math.max(1, Math.min(10, level));
}

async function querySemanticScholar(concepts, currentLevel, sessionConcepts = []) {
  if (!concepts || !concepts.length) return [];
  const queryPool = [...concepts];
  for (const sc of sessionConcepts) {
    if (!queryPool.includes(sc)) queryPool.push(sc);
  }
  const short = queryPool.slice(0, 2).map((c) => c.split(' ').slice(0, 3).join(' '));
  const query = encodeURIComponent(short.join(' '));
  const fields = 'title,abstract,year,externalIds,citationCount,openAccessPdf';
  try {
    const resp = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&fields=${fields}&limit=10`,
      { headers: { 'User-Agent': 'RabbitHole/0.3' } }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const papers = (data.data || []).map((paper) => {
      const ext     = paper.externalIds || {};
      const oaPdf   = (paper.openAccessPdf || {}).url || '';
      const arxivId = ext.ArXiv || '';
      const doi     = ext.DOI || '';
      const pid     = paper.paperId || '';
      const url     = oaPdf || (arxivId ? `https://arxiv.org/abs/${arxivId}` : '')
                   || (doi ? `https://doi.org/${doi}` : '')
                   || (pid ? `https://www.semanticscholar.org/paper/${pid}` : '');
      const abstract = paper.abstract || '';
      return {
        title:      paper.title || 'Untitled',
        year:       paper.year,
        complexity: estimateComplexity(abstract),
        abstract:   abstract.slice(0, 200) + (abstract.length > 200 ? '…' : ''),
        url,
        citations:  paper.citationCount || 0,
      };
    });
    papers.sort((a, b) =>
      Math.abs(a.complexity - currentLevel) - Math.abs(b.complexity - currentLevel)
      || (b.citations - a.citations)
    );
    return papers.slice(0, 6);
  } catch {
    return [];
  }
}

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
let activeCourse     = null;   // loaded once on panel open, cached in memory
let tutorMessages    = [];     // [{ role: 'user'|'tutor', text, sources? }]
let tutorBusy        = false;
let ttsEnabled       = false;  // speak tutor answers aloud
let recognizing      = false;  // mic actively listening
let recognition      = null;   // SpeechRecognition instance (lazy)

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
    const data = await callLLM(buildResearchAreaPrompt(topConcepts));

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

function setProviderToggle(panel, primary) {
  const gBtn = panel.querySelector('#rh-primary-gemini');
  const rBtn = panel.querySelector('#rh-primary-groq');
  if (!gBtn || !rBtn) return;
  const active   = 'border:1.5px solid #ff5a1f; background:#ff5a1f; color:#fff;';
  const inactive = 'border:1.5px solid #26262d; background:#141417; color:#82828c;';
  gBtn.style.cssText += primary === 'gemini' ? active : inactive;
  rBtn.style.cssText += primary === 'groq'   ? active : inactive;
  gBtn.dataset.active = String(primary === 'gemini');
  rBtn.dataset.active = String(primary === 'groq');
}

async function renderAccountState() {
  const el = document.getElementById('rh-account');
  if (!el) return;
  const user = await getCurrentUser();

  if (user) {
    el.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;
        background:#141417; border:1px solid #26262d; border-radius:8px; padding:8px 10px;">
        <div style="min-width:0;">
          <div style="font-size:12px; font-weight:600; color:#1f9d55;">✓ Signed in</div>
          <div style="font-size:11px; color:#82828c; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(user.email)}</div>
        </div>
        <button id="rh-signout" style="font-size:11px; background:none; border:1px solid #2e2e36;
          border-radius:6px; padding:4px 10px; cursor:pointer; color:#82828c; white-space:nowrap;">Sign out</button>
      </div>`;
    el.querySelector('#rh-signout').addEventListener('click', async () => {
      await signOut();
      renderAccountState();
    });
    return;
  }

  const inputStyle = `width:100%; box-sizing:border-box; padding:7px 9px; border:1.5px solid #26262d;
    border-radius:7px; font-size:12px; outline:none; margin-bottom:6px;`;
  el.innerHTML = `
    <input id="rh-auth-email" type="email" placeholder="you@university.edu" style="${inputStyle}" />
    <input id="rh-auth-pass" type="password" placeholder="password" style="${inputStyle}" />
    <div style="display:flex; gap:6px;">
      <button id="rh-signin" style="flex:1; padding:8px; background:#ff5a1f; color:#fff; border:none;
        border-radius:7px; font-size:12px; font-weight:600; cursor:pointer;">Sign in</button>
      <button id="rh-signup" style="flex:1; padding:8px; background:#141417; color:#c9c9d0; border:1.5px solid #26262d;
        border-radius:7px; font-size:12px; font-weight:600; cursor:pointer;">Sign up</button>
    </div>
    <div id="rh-auth-status" style="font-size:11px; text-align:center; min-height:14px; margin-top:6px; color:#e53e3e;"></div>
    <p style="font-size:10px; color:#82828c; margin:4px 0 0; line-height:1.4;">
      Sign in so your tutor questions count toward your class.
    </p>`;

  const emailEl = el.querySelector('#rh-auth-email');
  const passEl  = el.querySelector('#rh-auth-pass');
  const statusEl = el.querySelector('#rh-auth-status');

  async function doAuth(mode) {
    const email = emailEl.value.trim();
    const pass  = passEl.value;
    if (!email || pass.length < 6) { statusEl.style.color = '#e53e3e'; statusEl.textContent = 'Enter email + password (6+ chars).'; return; }
    statusEl.style.color = '#888'; statusEl.textContent = '…';
    try {
      if (mode === 'signup') {
        const { needsConfirm } = await signUp(email, pass);
        if (needsConfirm) {
          statusEl.style.color = '#888';
          statusEl.textContent = 'Account made — confirm via email, then sign in.';
          return;
        }
      } else {
        await signIn(email, pass);
      }
      renderAccountState();
    } catch (err) {
      statusEl.style.color = '#e53e3e';
      statusEl.textContent = err.message;
    }
  }

  el.querySelector('#rh-signin').addEventListener('click', () => doAuth('signin'));
  el.querySelector('#rh-signup').addEventListener('click', () => doAuth('signup'));
}

function ensurePanel() {
  if (document.getElementById('rabbithole-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'rabbithole-panel';
  panel.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 2147483647;
    width: 420px; max-height: 88vh;
    background: #141417; border-radius: 12px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.22);
    overflow: hidden; display: flex; flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px; color: #f4f4f6; line-height: 1.5;
  `;

  panel.innerHTML = `
    <!-- Header -->
    <div id="rh-header" style="
      padding: 12px 16px; display: flex; align-items: center; gap: 8px;
      background: #0e0e10;
      border-radius: 12px 12px 0 0; flex-shrink: 0;
      cursor: move; user-select: none;
    ">
      <span style="font-size:16px;">🐇</span>
      <span style="font-weight:800; color:#fff; font-size:15px; flex:1; letter-spacing:-0.02em;">RabbitHole<span style="color:#ff5a1f;">.</span></span>
      <span id="rh-session-badge" style="
        display:none; font-size:10px; background:rgba(255,255,255,0.22);
        color:#fff; padding:2px 8px; border-radius:10px; white-space:nowrap;
      ">Session active</span>
      <button id="rh-settings-btn" title="Settings" style="
        background:none; border:none; color:rgba(255,255,255,0.8);
        font-size:15px; cursor:pointer; padding:0 6px 0 0; line-height:1;
      ">⚙️</button>
      <button id="rh-close" style="
        background:none; border:none; color:rgba(255,255,255,0.8);
        font-size:20px; cursor:pointer; padding:0; line-height:1;
      ">×</button>
    </div>

    <!-- Settings overlay (hidden by default) -->
    <div id="rh-settings-overlay" style="
      display:none; flex-shrink:0; padding:14px 16px;
      background:#1b1b1f; border-bottom:1px solid #26262d;
    ">
      <p style="font-size:11px; font-weight:700; color:#c9c9d0; text-transform:uppercase;
        letter-spacing:.05em; margin:0 0 8px;">Account</p>
      <div id="rh-account" style="margin-bottom:16px;"></div>

      <p style="font-size:11px; font-weight:700; color:#c9c9d0; text-transform:uppercase;
        letter-spacing:.05em; margin:0 0 10px;">API Keys</p>

      <label style="font-size:11px; color:#c9c9d0; font-weight:600;">
        Gemini <span style="font-weight:400; color:#82828c;">(<a href="https://aistudio.google.com/apikey" target="_blank" style="color:#ff5a1f; text-decoration:none;">get free key</a>)</span>
      </label>
      <div style="display:flex; gap:6px; margin:4px 0 10px;">
        <input id="rh-gemini-key-input" type="password" placeholder="AIza…"
          style="flex:1; padding:7px 9px; border:1.5px solid #26262d; border-radius:7px;
            font-size:12px; font-family:monospace; outline:none;" />
        <button id="rh-gemini-vis" style="padding:6px 9px; border:1.5px solid #26262d;
          border-radius:7px; background:#1b1b1f; cursor:pointer; font-size:12px;">👁</button>
      </div>

      <label style="font-size:11px; color:#c9c9d0; font-weight:600;">
        Groq <span style="font-weight:400; color:#82828c;">(<a href="https://console.groq.com/keys" target="_blank" style="color:#ff5a1f; text-decoration:none;">get free key</a>)</span>
      </label>
      <div style="display:flex; gap:6px; margin:4px 0 12px;">
        <input id="rh-groq-key-input" type="password" placeholder="gsk_…"
          style="flex:1; padding:7px 9px; border:1.5px solid #26262d; border-radius:7px;
            font-size:12px; font-family:monospace; outline:none;" />
        <button id="rh-groq-vis" style="padding:6px 9px; border:1.5px solid #26262d;
          border-radius:7px; background:#1b1b1f; cursor:pointer; font-size:12px;">👁</button>
      </div>

      <p style="font-size:11px; font-weight:700; color:#c9c9d0; text-transform:uppercase;
        letter-spacing:.05em; margin:0 0 6px;">Primary provider</p>
      <div style="display:flex; gap:6px; margin-bottom:12px;">
        <button id="rh-primary-gemini" data-val="gemini" style="
          flex:1; padding:7px; border:1.5px solid #ff5a1f; border-radius:7px;
          background:#ff5a1f; color:#fff; font-size:12px; font-weight:600; cursor:pointer;
        ">Gemini</button>
        <button id="rh-primary-groq" data-val="groq" style="
          flex:1; padding:7px; border:1.5px solid #26262d; border-radius:7px;
          background:#141417; color:#82828c; font-size:12px; font-weight:600; cursor:pointer;
        ">Groq</button>
      </div>

      <button id="rh-save-keys-btn" style="
        width:100%; padding:9px; background:linear-gradient(135deg,#ff5a1f,#e8480f);
        color:#fff; border:none; border-radius:7px; font-size:12px;
        font-weight:600; cursor:pointer;
      ">Save Keys</button>
      <div id="rh-keys-status" style="font-size:11px; text-align:center; min-height:14px; margin-top:6px; color:#48bb78;"></div>
    </div>

    <!-- Session bar -->
    <div id="rh-session-bar" style="
      padding:8px 16px; background:#1c1613;
      border-bottom:1px solid #26262d; flex-shrink:0;
    "></div>

    <!-- Tabs -->
    <div id="rh-tabs" style="
      display:flex; border-bottom:1px solid #26262d; flex-shrink:0;
      background:#1b1b1f;
    ">
      <button class="rh-tab-btn" data-tab="analysis" style="
        flex:1; padding:9px 4px; border:none; background:none; cursor:pointer;
        font-size:12px; font-weight:600; color:#ff5a1f;
        border-bottom:2px solid #ff5a1f;
      ">Analysis</button>
      <button class="rh-tab-btn" data-tab="papers" style="
        flex:1; padding:9px 4px; border:none; background:none; cursor:pointer;
        font-size:12px; font-weight:600; color:#82828c;
        border-bottom:2px solid transparent;
      ">Papers</button>
      <button class="rh-tab-btn" data-tab="thread" style="
        flex:1; padding:9px 4px; border:none; background:none; cursor:pointer;
        font-size:12px; font-weight:600; color:#82828c;
        border-bottom:2px solid transparent;
      ">Thread</button>
      <button class="rh-tab-btn" data-tab="course" style="
        flex:1; padding:9px 4px; border:none; background:none; cursor:pointer;
        font-size:12px; font-weight:600; color:#82828c;
        border-bottom:2px solid transparent;
      ">Course</button>
      <button class="rh-tab-btn" data-tab="tutor" style="
        flex:1; padding:9px 4px; border:none; background:none; cursor:pointer;
        font-size:12px; font-weight:600; color:#82828c;
        border-bottom:2px solid transparent;
      ">Tutor</button>
    </div>

    <!-- Content area -->
    <div id="rh-content" style="padding:16px; overflow-y:auto; flex:1; min-height:80px;">
      <p style="color:#82828c; text-align:center; margin:24px 0;">
        Click the RabbitHole icon to analyze this page.
      </p>
    </div>
  `;

  // Dark-theme inputs/scrollbars inside the panel (inline styles can't easily set these).
  const themeStyle = document.createElement('style');
  themeStyle.textContent = `
    #rabbithole-panel input, #rabbithole-panel textarea {
      background:#1b1b1f !important; color:#f4f4f6 !important; border-color:#26262d !important;
    }
    #rabbithole-panel input::placeholder, #rabbithole-panel textarea::placeholder { color:#5c5c66 !important; }
    #rabbithole-panel input:focus, #rabbithole-panel textarea:focus { border-color:#ff5a1f !important; }
    #rabbithole-panel ::-webkit-scrollbar { width:8px; height:8px; }
    #rabbithole-panel ::-webkit-scrollbar-thumb { background:#2e2e36; border-radius:4px; }
    #rabbithole-panel input[type="radio"] { accent-color:#ff5a1f; }
  `;
  panel.appendChild(themeStyle);

  document.body.appendChild(panel);

  // ── Draggable panel (grab the header to move) ──────────────────────
  (function makeDraggable() {
    const header = panel.querySelector('#rh-header');
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    header.addEventListener('mousedown', (e) => {
      // Ignore drags that start on the header buttons (gear / close)
      if (e.target.closest('button')) return;

      dragging = true;
      const rect = panel.getBoundingClientRect();
      // Switch from right-anchored to left/top-anchored so we can move freely
      startLeft = rect.left;
      startTop  = rect.top;
      startX    = e.clientX;
      startY    = e.clientY;
      panel.style.right  = 'auto';
      panel.style.left   = startLeft + 'px';
      panel.style.top    = startTop + 'px';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Keep the panel within the viewport
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const newLeft = Math.max(0, Math.min(startLeft + dx, window.innerWidth  - w));
      const newTop  = Math.max(0, Math.min(startTop  + dy, window.innerHeight - h));
      panel.style.left = newLeft + 'px';
      panel.style.top  = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
      document.body.style.userSelect = '';
    });
  })();

  // Close button
  panel.querySelector('#rh-close').addEventListener('click', () => {
    panel.style.display = 'none';
  });

  // Settings gear — toggle overlay and pre-fill saved keys
  panel.querySelector('#rh-settings-btn').addEventListener('click', async () => {
    const overlay = panel.querySelector('#rh-settings-overlay');
    const isOpen  = overlay.style.display !== 'none';
    overlay.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      const { gemini, groq, primary } = await getApiKeys();
      if (gemini) panel.querySelector('#rh-gemini-key-input').value = gemini;
      if (groq)   panel.querySelector('#rh-groq-key-input').value   = groq;
      setProviderToggle(panel, primary);
      renderAccountState();
    }
  });

  // Primary provider toggle
  panel.querySelector('#rh-primary-gemini').addEventListener('click', () => setProviderToggle(panel, 'gemini'));
  panel.querySelector('#rh-primary-groq').addEventListener('click',   () => setProviderToggle(panel, 'groq'));

  // Toggle key visibility
  panel.querySelector('#rh-gemini-vis').addEventListener('click', () => {
    const inp = panel.querySelector('#rh-gemini-key-input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  panel.querySelector('#rh-groq-vis').addEventListener('click', () => {
    const inp = panel.querySelector('#rh-groq-key-input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Save keys
  panel.querySelector('#rh-save-keys-btn').addEventListener('click', () => {
    const gemini   = panel.querySelector('#rh-gemini-key-input').value.trim();
    const groq     = panel.querySelector('#rh-groq-key-input').value.trim();
    const primary  = panel.querySelector('#rh-primary-gemini').dataset.active === 'true' ? 'gemini' : 'groq';
    const statusEl = panel.querySelector('#rh-keys-status');
    if (!gemini && !groq) { statusEl.style.color = '#e53e3e'; statusEl.textContent = 'Enter at least one key.'; return; }
    const toSave = { [PRIMARY_PROVIDER_KEY]: primary };
    if (gemini) toSave[GEMINI_KEY_STORAGE] = gemini;
    if (groq)   toSave[GROQ_KEY_STORAGE]   = groq;
    chrome.storage.local.set(toSave, () => {
      statusEl.style.color = '#48bb78';
      statusEl.textContent = '✓ Saved!';
      setTimeout(() => {
        statusEl.textContent = '';
        panel.querySelector('#rh-settings-overlay').style.display = 'none';
      }, 1500);
    });
  });

  // Tab switching
  panel.querySelectorAll('.rh-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  renderSessionBar();

  // Pre-load active course (from the backend) so it's ready when analyze is triggered
  getActiveCourseId().then(async (id) => {
    if (!id) return;
    try { activeCourse = await CourseAPI.get(id); } catch { /* backend may be down */ }
  }).catch(() => {});
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.rh-tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.style.color           = active ? '#ff5a1f' : '#aaa';
    btn.style.borderBottom    = active ? '2px solid #ff5a1f' : '2px solid transparent';
  });

  if (name === 'analysis') {
    if (lastAnalysisData) renderAnalysis(lastAnalysisData);
    else showPlaceholder('Click the RabbitHole icon to analyze this page.');
  } else if (name === 'papers') {
    renderPapersTab();
  } else if (name === 'thread') {
    renderThreadTab();
  } else if (name === 'course') {
    renderCourseTab();
  } else if (name === 'tutor') {
    renderTutorTab();
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
        <span style="font-size:12px; color:#ff5a1f; font-weight:600;">🟠 In RabbitHole</span>
        <button id="rh-end-session" style="
          font-size:11px; background:none; border:1px solid #ccc;
          border-radius:4px; padding:3px 10px; cursor:pointer; color:#82828c;
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
        background:linear-gradient(135deg,#ff5a1f 0%,#e8480f 100%);
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
    <div style="text-align:center; padding:32px 0; color:#ff5a1f;">
      <div style="font-size:28px; margin-bottom:12px;">🐇</div>
      <p style="font-weight:600; margin:0;">${escapeHtml(msg)}</p>
    </div>
  `;
}

function showError(msg) {
  console.error('[RabbitHole]', msg);
  const el = document.getElementById('rh-content');
  if (el) el.innerHTML = `
    <div style="background:#1f1314; border-left:3px solid #ef4444; padding:12px; border-radius:6px;">
      <p style="color:#b91c1c; font-size:13px; margin:0; line-height:1.5;">${escapeHtml(msg)}</p>
    </div>
  `;
}

function showPlaceholder(msg) {
  const el = document.getElementById('rh-content');
  if (el) el.innerHTML = `
    <p style="color:#82828c; text-align:center; margin:24px 0; font-size:13px;">${escapeHtml(msg)}</p>
  `;
}

// ══════════════════════════════════════════════════════════════════════
// ── Analysis ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

async function analyzeText() {
  const { gemini, groq } = await getApiKeys();
  if (!gemini && !groq) {
    showError('No API key set. Click ⚙️ in the panel header to add your Gemini or Groq key.');
    return;
  }

  try {
    const title   = extractTitle();
    const { text, method } = extractText();

    if (['pdf', 'pdf-viewer', 'docx', 'epub'].includes(method)) {
      showError('PDF/DOCX/EPUB analysis requires the self-hosted backend. For now, open the document in a viewer and analyze the page text directly.');
      return;
    }

    if (text.length < 50) {
      showError('Not enough text to analyze. Try visiting an article, or select a passage of text first.');
      return;
    }

    const data = await callLLM(buildAnalysisPrompt(title, text, activeCourse));
    lastAnalysisData = data;
    renderAnalysis(data);
    if (await isInSession()) recordVisit('page_analyzed', { level: data.level, concepts: data.concepts });
    startPaperRecommendations(data.concepts, data.level);

  } catch (error) {
    let msg = error.message;
    if (error.name === 'AbortError') msg = 'Request timed out — Gemini took too long. Try again.';
    showError(msg);
  }
}

function renderAnalysis(data) {
  const required = ['level', 'level_reason', 'summary', 'concepts', 'prerequisite', 'easier', 'deeper'];
  const missing  = required.filter((f) => !(f in data));
  if (missing.length) { showError('Unexpected response from Gemini — missing fields: ' + missing.join(', ')); return; }

  const levelColor  = getLevelColor(data.level);
  const levelLabel  = getLevelLabel(data.level);
  const concepts    = Array.isArray(data.concepts) ? data.concepts : [];

  const chipsHtml = concepts.map((c) => {
    const safe = escapeHtml(c);
    return `<span class="rh-chip" data-concept="${safe}"
      style="display:inline-block; background:#1c1613; border:1px solid #26262d;
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
      <p style="margin:0; font-size:12px; color:#c9c9d0; line-height:1.4; padding-top:5px;">
        ${escapeHtml(data.level_reason)}
      </p>
    </div>

    <!-- Summary -->
    <div style="margin-bottom:14px;">
      <p class="rh-section-label">Summary</p>
      <p style="margin:6px 0 0; font-size:13px; line-height:1.6; color:#f4f4f6;">
        ${escapeHtml(data.summary)}
      </p>
    </div>

    <!-- Concepts -->
    <div style="margin-bottom:14px;">
      <p class="rh-section-label">
        Key Concepts
        <span style="font-weight:400; text-transform:none; font-size:10px; color:#82828c; letter-spacing:0;">
          (click to explore)
        </span>
      </p>
      <div style="display:flex; flex-wrap:wrap; margin-top:6px;">${chipsHtml}</div>
    </div>

    <!-- Learning path cards -->
    ${rhCard('Prerequisite', escapeHtml(data.prerequisite), '#ff5a1f')}
    ${rhCard('Start here (easier)', escapeHtml(data.easier), '#48bb78')}
    ${rhCard('Go deeper', escapeHtml(data.deeper), '#ed8936')}

    ${data.confidence != null && data.confidence < 0.55
      ? `<p style="margin:10px 0 0; padding:7px 10px; background:#1c1a10;
           border-radius:6px; font-size:11px; color:#e6c34d;">
           ⚠️ Low confidence — the text may be too short or ambiguous for a precise analysis.
         </p>`
      : ''}
  `;

  const content = document.getElementById('rh-content');
  if (content) content.innerHTML = html;

  // Concept chip hover + click
  document.querySelectorAll('.rh-chip').forEach((chip) => {
    chip.addEventListener('mouseenter', () => { chip.style.background = '#dde1f7'; });
    chip.addEventListener('mouseleave', () => { chip.style.background = '#1c1613'; });
    chip.addEventListener('click', async () => {
      const concept = chip.getAttribute('data-concept');
      window.open(`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(concept)}`, '_blank');
      if (await isInSession()) recordVisit('concept_clicked', { concept });
    });
  });
}

function rhCard(label, body, accentColor) {
  return `
    <div style="margin-bottom:10px; padding:10px 12px; background:#1b1b1f;
      border-left:3px solid ${accentColor}; border-radius:0 6px 6px 0;">
      <p style="margin:0; font-size:10px; font-weight:700; color:${accentColor};
        text-transform:uppercase; letter-spacing:0.5px;">${label}</p>
      <p style="margin:5px 0 0; font-size:12px; color:#f4f4f6; line-height:1.5;">${body}</p>
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
    papersCache = await querySemanticScholar(concepts, level, sessionConcepts);
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

// ══════════════════════════════════════════════════════════════════════
// ── Course tab ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

async function renderCourseTab() {
  const content = document.getElementById('rh-content');
  if (!content) return;

  content.innerHTML = `<p style="color:#82828c; text-align:center; padding:24px 0;">Loading…</p>`;

  try {
    const id = await getActiveCourseId();
    if (id) {
      activeCourse = await CourseAPI.get(id);
      renderCourseLoaded(content, activeCourse);
      return;
    }
  } catch (e) {
    // active id is stale (course deleted) or backend unreachable — fall through to setup,
    // but surface a connection error so the user knows the backend may be down.
    if (String(e.message || '').includes("reach the RabbitHole backend")) {
      content.innerHTML = `<p style="color:#e53e3e; font-size:12px; padding:18px 4px; line-height:1.6;">${escapeHtml(e.message)}</p>`;
      return;
    }
    activeCourse = null;
    await setActiveCourseId(null);
  }

  await renderCourseSetupForm(content);
}

async function renderCourseSetupForm(content) {
  // Show any existing courses on the backend so the user can re-activate one.
  let existing = [];
  try { existing = (await CourseAPI.list()).courses || []; } catch { /* backend optional here */ }

  const existingHtml = existing.length ? `
    <p class="rh-section-label" style="margin-bottom:6px;">Your courses</p>
    <div style="margin-bottom:16px;">
      ${existing.map((c) => `
        <div class="rh-course-pick" data-id="${escapeHtml(c.id)}" style="
          display:flex; align-items:center; justify-content:space-between; gap:8px;
          padding:8px 10px; border:1px solid #26262d; border-radius:8px; margin-bottom:6px;
          cursor:pointer; background:#1b1b1f;">
          <span style="font-size:12px; font-weight:600; color:#f4f4f6;">🎓 ${escapeHtml(c.name)}</span>
          <span style="display:flex; gap:8px; align-items:center;">
            <span style="font-size:10px; color:#82828c;">${c.reading_count || 0} readings</span>
            <button class="rh-course-del" data-id="${escapeHtml(c.id)}" title="Delete course" style="
              background:none; border:none; color:#ff8a66; cursor:pointer; font-size:14px; padding:0 2px;">×</button>
          </span>
        </div>`).join('')}
    </div>
    <p style="font-size:11px; color:#82828c; text-align:center; margin:0 0 14px;">— or create a new one —</p>
  ` : '';

  content.innerHTML = `
    <div style="padding:4px 0;">
      ${existingHtml}
      <p style="font-size:13px; font-weight:700; color:#f4f4f6; margin-bottom:4px;">🎓 Set up your course</p>
      <p style="font-size:12px; color:#82828c; margin-bottom:14px; line-height:1.5;">
        Paste your syllabus — RabbitHole grounds every analysis and tutor answer in your actual course material.
      </p>

      <label style="font-size:11px; font-weight:600; color:#c9c9d0; text-transform:uppercase; letter-spacing:.04em;">
        Course name
      </label>
      <input id="rh-course-name" type="text" placeholder="e.g. ECON 301 — Macroeconomics"
        style="width:100%; box-sizing:border-box; margin:5px 0 12px; padding:8px 10px;
          border:1.5px solid #26262d; border-radius:8px; font-size:13px; outline:none;
          font-family:inherit;" />

      <label style="font-size:11px; font-weight:600; color:#c9c9d0; text-transform:uppercase; letter-spacing:.04em;">
        Syllabus <span style="font-weight:400; color:#82828c;">(paste the full text)</span>
      </label>
      <textarea id="rh-syllabus-text" rows="8" placeholder="Paste your course syllabus here…"
        style="width:100%; box-sizing:border-box; margin:5px 0 14px; padding:8px 10px;
          border:1.5px solid #26262d; border-radius:8px; font-size:12px; outline:none;
          font-family:inherit; resize:vertical; line-height:1.5;"></textarea>

      <button id="rh-setup-course-btn" style="
        width:100%; padding:10px; background:linear-gradient(135deg,#ff5a1f,#e8480f);
        color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:600;
        cursor:pointer;
      ">Set Up Course →</button>

      <div id="rh-course-status" style="margin-top:10px; font-size:12px; text-align:center; min-height:16px; color:#e53e3e;"></div>
    </div>
  `;

  const nameInput = content.querySelector('#rh-course-name');
  const textarea  = content.querySelector('#rh-syllabus-text');
  const btn       = content.querySelector('#rh-setup-course-btn');
  const statusEl  = content.querySelector('#rh-course-status');

  nameInput.addEventListener('focus', () => nameInput.style.borderColor = '#ff5a1f');
  nameInput.addEventListener('blur',  () => nameInput.style.borderColor = '#26262d');
  textarea.addEventListener('focus',  () => textarea.style.borderColor  = '#ff5a1f');
  textarea.addEventListener('blur',   () => textarea.style.borderColor  = '#26262d');

  // Activate an existing course
  content.querySelectorAll('.rh-course-pick').forEach((row) => {
    row.addEventListener('click', async (e) => {
      if (e.target.closest('.rh-course-del')) return;   // delete handled separately
      const id = row.dataset.id;
      try {
        activeCourse = await CourseAPI.get(id);
        await setActiveCourseId(id);
        renderCourseLoaded(content, activeCourse);
        refreshTutorTabState();
      } catch (err) { statusEl.textContent = `Error: ${err.message}`; }
    });
  });

  // Delete an existing course
  content.querySelectorAll('.rh-course-del').forEach((delBtn) => {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = delBtn.dataset.id;
      if (!confirm('Delete this course and all its readings? This cannot be undone.')) return;
      try {
        await CourseAPI.remove(id);
        const activeId = await getActiveCourseId();
        if (activeId === id) { await setActiveCourseId(null); activeCourse = null; }
        renderCourseTab();
      } catch (err) { statusEl.textContent = `Error: ${err.message}`; }
    });
  });

  btn.addEventListener('click', async () => {
    const name     = nameInput.value.trim();
    const syllabus = textarea.value.trim();

    if (!name) { statusEl.style.color = '#e53e3e'; statusEl.textContent = 'Enter a course name.'; return; }
    if (syllabus.length < 100) { statusEl.style.color = '#e53e3e'; statusEl.textContent = 'Paste more of your syllabus — need at least a few sentences.'; return; }

    btn.disabled = true;
    btn.textContent = '⏳ Processing syllabus…';
    statusEl.textContent = '';

    try {
      // Backend parses the syllabus, embeds it for RAG, and returns the course.
      const course = await CourseAPI.create(name, syllabus);
      await setActiveCourseId(course.id);
      activeCourse = course;
      renderCourseLoaded(content, course);
      refreshTutorTabState();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Set Up Course →';
      statusEl.style.color = '#e53e3e';
      statusEl.textContent = `Error: ${err.message}`;
    }
  });
}

function renderCourseLoaded(content, course) {
  const p = course.processed || {};
  const weeks = (p.weeks || []).slice(0, 14);
  const concepts = (p.key_concepts || []).slice(0, 18);

  const weeksHtml = weeks.length
    ? weeks.map((w) => `
        <div style="padding:6px 0; border-bottom:1px solid #26262d; display:flex; gap:8px; align-items:baseline;">
          <span style="font-size:11px; font-weight:700; color:#ff5a1f; white-space:nowrap; min-width:48px;">Wk ${w.week}</span>
          <span style="font-size:12px; color:#f4f4f6; line-height:1.4;">${escapeHtml(w.topic || '')}</span>
        </div>`).join('')
    : '<p style="color:#82828c; font-size:12px; margin:0;">No weekly schedule found in syllabus.</p>';

  const conceptsHtml = concepts.length
    ? concepts.map((c) => `<span style="
        display:inline-block; background:#1c1613; border:1px solid #26262d;
        padding:3px 9px; border-radius:12px; font-size:11px; color:#c9c9d0;
        margin:0 4px 4px 0;">${escapeHtml(c)}</span>`).join('')
    : '';

  content.innerHTML = `
    <div style="padding:4px 0;">
      <!-- Header -->
      <div style="margin-bottom:14px;">
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
          <div>
            <p style="font-size:13px; font-weight:700; color:#f4f4f6; margin:0 0 2px;">
              🎓 ${escapeHtml(course.name)}
            </p>
            ${p.semester ? `<p style="font-size:11px; color:#82828c; margin:0;">${escapeHtml(p.semester)}</p>` : ''}
          </div>
          <button id="rh-change-course" style="
            font-size:11px; background:none; border:1px solid #2e2e36;
            border-radius:6px; padding:3px 8px; cursor:pointer; color:#82828c;
            white-space:nowrap; flex-shrink:0;
          ">Change</button>
        </div>
        <p style="font-size:11px; color:#48bb78; font-weight:600; margin:8px 0 0;">
          ✓ Active — analyses are grounded in this course
        </p>
      </div>

      <!-- Weekly schedule -->
      <p class="rh-section-label" style="margin-bottom:6px;">Weekly schedule</p>
      <div style="margin-bottom:14px; max-height:200px; overflow-y:auto; border:1px solid #26262d; border-radius:8px; padding:0 10px;">
        ${weeksHtml}
      </div>

      ${concepts.length ? `
      <!-- Key concepts -->
      <p class="rh-section-label" style="margin-bottom:6px;">Key course concepts</p>
      <div style="margin-bottom:14px;">${conceptsHtml}</div>
      ` : ''}

      <!-- Add reading -->
      <button id="rh-add-reading-btn" style="
        width:100%; padding:9px; background:#1c1613; color:#ff5a1f;
        border:1.5px dashed rgba(255,90,31,0.45); border-radius:8px; font-size:12px;
        font-weight:600; cursor:pointer; margin-bottom:6px;
      ">+ Add a reading</button>

      <div id="rh-reading-form" style="display:none; margin-top:10px;">
        <textarea id="rh-reading-text" rows="5" placeholder="Paste the reading text here…"
          style="width:100%; box-sizing:border-box; padding:8px 10px;
            border:1.5px solid #26262d; border-radius:8px; font-size:12px;
            font-family:inherit; resize:vertical; margin-bottom:8px; outline:none;"></textarea>
        <input id="rh-reading-title" type="text" placeholder="Reading title (optional)"
          style="width:100%; box-sizing:border-box; padding:7px 10px;
            border:1.5px solid #26262d; border-radius:8px; font-size:12px;
            font-family:inherit; margin-bottom:8px; outline:none;" />
        <button id="rh-save-reading-btn" style="
          width:100%; padding:9px; background:linear-gradient(135deg,#ff5a1f,#e8480f);
          color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer;
        ">Save Reading</button>
        <div id="rh-reading-status" style="margin-top:8px; font-size:12px; text-align:center; min-height:14px;"></div>
      </div>
    </div>
  `;

  content.querySelector('#rh-change-course').addEventListener('click', async () => {
    // "Change" just deactivates — the course stays on the backend so you can switch back.
    await setActiveCourseId(null);
    activeCourse = null;
    refreshTutorTabState();
    renderCourseTab();
  });

  const addBtn     = content.querySelector('#rh-add-reading-btn');
  const readingForm = content.querySelector('#rh-reading-form');
  addBtn.addEventListener('click', () => {
    readingForm.style.display = readingForm.style.display === 'none' ? 'block' : 'none';
    addBtn.textContent = readingForm.style.display === 'none' ? '+ Add a reading' : '− Cancel';
  });

  content.querySelector('#rh-save-reading-btn').addEventListener('click', async () => {
    const text   = content.querySelector('#rh-reading-text').value.trim();
    const title  = content.querySelector('#rh-reading-title').value.trim() || 'Untitled Reading';
    const status = content.querySelector('#rh-reading-status');

    if (text.length < 50) { status.textContent = 'Paste more text — need at least a paragraph.'; return; }

    const saveBtn = content.querySelector('#rh-save-reading-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Embedding…';
    status.style.color = '#888';
    status.textContent = '';

    try {
      // Backend chunks + embeds the reading into the course corpus.
      const res = await CourseAPI.addReading(course.id, title, text);
      status.style.color = '#48bb78';
      status.textContent = `✓ Saved (${res.chunks} chunk${res.chunks === 1 ? '' : 's'} embedded)`;
      content.querySelector('#rh-reading-text').value  = '';
      content.querySelector('#rh-reading-title').value = '';
      setTimeout(() => { status.textContent = ''; saveBtn.disabled = false; saveBtn.textContent = 'Save Reading'; }, 2500);
    } catch (err) {
      status.style.color = '#e53e3e';
      status.textContent = `Error: ${err.message}`;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Reading';
    }
  });
}

// ══════════════════════════════════════════════════════════════════════
// ── Tutor tab (RAG chat grounded in the active course) ─────────────────
// ══════════════════════════════════════════════════════════════════════

/** If the Tutor tab is currently open, re-render it (e.g. after course change). */
function refreshTutorTabState() {
  if (currentTab === 'tutor') renderTutorTab();
}

async function renderTutorTab() {
  const content = document.getElementById('rh-content');
  if (!content) return;

  // Need an active course to ground answers.
  if (!activeCourse) {
    try {
      const id = await getActiveCourseId();
      if (id) activeCourse = await CourseAPI.get(id);
    } catch { /* handled below */ }
  }

  if (!activeCourse) {
    content.innerHTML = `
      <div style="text-align:center; padding:36px 12px; color:#82828c;">
        <div style="font-size:30px; margin-bottom:10px;">🎓</div>
        <p style="font-size:13px; font-weight:600; color:#c9c9d0; margin:0 0 6px;">No course selected</p>
        <p style="font-size:12px; margin:0; line-height:1.5;">
          Set up or pick a course in the <b>Course</b> tab, then come back to chat with a tutor
          that knows your material.
        </p>
      </div>`;
    return;
  }

  content.innerHTML = `
    <div style="display:flex; flex-direction:column; height:100%; min-height:380px;">
      <div style="flex-shrink:0; padding:2px 0 10px; border-bottom:1px solid #26262d; margin-bottom:10px;
        display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
        <div>
          <p style="font-size:12px; color:#ff5a1f; font-weight:700; margin:0;">🎓 ${escapeHtml(activeCourse.name)}</p>
          <p style="font-size:11px; color:#82828c; margin:2px 0 0;">Answers are grounded in your syllabus &amp; readings.</p>
        </div>
        <button id="rh-tts-toggle" title="Read answers aloud" style="
          flex-shrink:0; background:${ttsEnabled ? '#1c1613' : 'none'}; border:1px solid ${ttsEnabled ? '#ff5a1f' : '#2e2e36'};
          border-radius:6px; padding:4px 8px; cursor:pointer; font-size:13px;
          color:${ttsEnabled ? '#ff5a1f' : '#999'};">${ttsEnabled ? '🔊' : '🔇'}</button>
      </div>

      <div id="rh-tutor-messages" style="flex:1; overflow-y:auto; padding-right:2px;"></div>

      <div style="flex-shrink:0; display:flex; gap:6px; padding-top:10px; border-top:1px solid #26262d; margin-top:8px;">
        <textarea id="rh-tutor-input" rows="2" placeholder="Ask your tutor, or tap 🎤 to speak…"
          style="flex:1; box-sizing:border-box; padding:8px 10px; border:1.5px solid #26262d;
            border-radius:8px; font-size:12px; font-family:inherit; resize:none; outline:none; line-height:1.4;"></textarea>
        <div style="display:flex; flex-direction:column; gap:6px;">
          <button id="rh-tutor-mic" title="Speak your question" style="
            flex-shrink:0; width:48px; flex:1; background:#1c1613; border:1.5px solid #26262d;
            border-radius:8px; font-size:16px; cursor:pointer;">🎤</button>
          <button id="rh-tutor-send" title="Send" style="
            flex-shrink:0; width:48px; flex:1; background:linear-gradient(135deg,#ff5a1f,#e8480f);
            color:#fff; border:none; border-radius:8px; font-size:16px; cursor:pointer;">➤</button>
        </div>
      </div>
    </div>`;

  renderTutorMessages();

  const input = content.querySelector('#rh-tutor-input');
  const send  = content.querySelector('#rh-tutor-send');
  const mic   = content.querySelector('#rh-tutor-mic');
  const tts   = content.querySelector('#rh-tts-toggle');
  input.addEventListener('focus', () => input.style.borderColor = '#ff5a1f');
  input.addEventListener('blur',  () => input.style.borderColor = '#26262d');
  send.addEventListener('click', () => sendTutorMessage());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTutorMessage(); }
  });

  mic.addEventListener('click', () => toggleMic());
  if (recognizing) setMicListeningUI(true);

  tts.addEventListener('click', () => {
    ttsEnabled = !ttsEnabled;
    if (!ttsEnabled) try { window.speechSynthesis.cancel(); } catch {}
    tts.textContent       = ttsEnabled ? '🔊' : '🔇';
    tts.style.background   = ttsEnabled ? '#1c1613' : 'none';
    tts.style.borderColor  = ttsEnabled ? '#ff5a1f' : '#2e2e36';
    tts.style.color        = ttsEnabled ? '#ff5a1f' : '#999';
  });
}

// ── Voice: speech-to-text (mic) and text-to-speech (speak answers) ────

function setMicListeningUI(on) {
  const mic = document.getElementById('rh-tutor-mic');
  if (!mic) return;
  mic.textContent      = on ? '⏹' : '🎤';
  mic.style.background  = on ? '#ffe9e9' : '#1c1613';
  mic.style.borderColor = on ? '#e57373' : '#26262d';
}

function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    appendTutorNotice('Voice input isn’t supported in this browser. You can still type.');
    return;
  }
  if (recognizing) {
    try { recognition && recognition.stop(); } catch {}
    return;
  }

  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => { recognizing = true; setMicListeningUI(true); };
  recognition.onerror = (e) => {
    recognizing = false;
    setMicListeningUI(false);
    const msg = e.error === 'not-allowed' || e.error === 'service-not-allowed'
      ? 'Microphone blocked on this page. Allow mic access, or try another page.'
      : `Voice input error: ${e.error}. You can still type.`;
    appendTutorNotice(msg);
  };
  recognition.onend = () => { recognizing = false; setMicListeningUI(false); };
  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    const input = document.getElementById('rh-tutor-input');
    if (input) input.value = transcript;
    // Auto-send once we have a final result, so it feels like talking.
    if (event.results[event.results.length - 1].isFinal && transcript.trim().length > 1) {
      sendTutorMessage();
    }
  };

  try { recognition.start(); }
  catch { /* start() can throw if called twice quickly — ignore */ }
}

function appendTutorNotice(text) {
  tutorMessages.push({ role: 'tutor', text: `ℹ️ ${text}`, sources: [] });
  renderTutorMessages();
}

function speakAnswer(text) {
  if (!ttsEnabled || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
  } catch { /* TTS is best-effort */ }
}

function renderTutorMessages() {
  const box = document.getElementById('rh-tutor-messages');
  if (!box) return;

  if (!tutorMessages.length && !tutorBusy) {
    box.innerHTML = `
      <p style="color:#82828c; font-size:12px; text-align:center; padding:24px 8px; line-height:1.6;">
        Try: <i>"Explain this week's main idea like I'm five"</i> or
        <i>"How does today's reading connect to last week?"</i>
      </p>`;
    return;
  }

  const bubbles = tutorMessages.map((m) => {
    if (m.role === 'user') {
      return `<div style="display:flex; justify-content:flex-end; margin-bottom:10px;">
        <div style="max-width:80%; background:#ff5a1f; color:#fff; padding:8px 11px;
          border-radius:12px 12px 2px 12px; font-size:12px; line-height:1.5;">${escapeHtml(m.text)}</div>
      </div>`;
    }
    const sources = (m.sources && m.sources.length)
      ? `<div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:4px;">
          ${m.sources.map((s) => `<span style="font-size:10px; background:#1c1613; color:#82828c; border:1px solid #26262d; padding:2px 7px; border-radius:10px;">📄 ${escapeHtml(s.title)}</span>`).join('')}
        </div>`
      : '';
    return `<div style="display:flex; justify-content:flex-start; margin-bottom:10px;">
      <div style="max-width:88%;">
        <div style="background:#1c1613; color:#f4f4f6; padding:9px 12px; border-radius:12px 12px 12px 2px;
          font-size:12px; line-height:1.6; white-space:pre-wrap;">${escapeHtml(m.text)}</div>
        ${sources}
      </div>
    </div>`;
  }).join('');

  const thinking = tutorBusy
    ? `<div style="display:flex; justify-content:flex-start; margin-bottom:10px;">
        <div style="background:#1c1613; color:#82828c; padding:9px 12px; border-radius:12px;
          font-size:12px;">💭 thinking…</div></div>`
    : '';

  box.innerHTML = bubbles + thinking;
  box.scrollTop = box.scrollHeight;
}

async function sendTutorMessage() {
  const input = document.getElementById('rh-tutor-input');
  if (!input || tutorBusy || !activeCourse) return;
  const q = input.value.trim();
  if (q.length < 2) return;

  input.value = '';
  // Snapshot the recent conversation BEFORE adding the new question.
  const history = tutorMessages.slice(-6).map((m) => ({ role: m.role, text: m.text }));
  tutorMessages.push({ role: 'user', text: q });
  tutorBusy = true;
  renderTutorMessages();

  try {
    const res = await CourseAPI.ask(activeCourse.id, q, history);
    const answer = res.answer || '(no answer)';
    tutorMessages.push({ role: 'tutor', text: answer, sources: res.sources || [] });
    speakAnswer(answer);
  } catch (err) {
    tutorMessages.push({ role: 'tutor', text: `⚠️ ${err.message}`, sources: [] });
  } finally {
    tutorBusy = false;
    renderTutorMessages();
  }
}

function renderPapersTab() {
  const content = document.getElementById('rh-content');
  if (!content) return;

  if (papersLoading) {
    content.innerHTML = `
      <div style="text-align:center; padding:32px 0; color:#ff5a1f;">
        <div style="font-size:24px; margin-bottom:10px;">🔍</div>
        <p style="font-weight:600; margin:0;">Searching Semantic Scholar…</p>
      </div>
    `;
    return;
  }

  if (!papersCache) {
    content.innerHTML = `
      <p style="color:#82828c; text-align:center; margin:24px 0;">
        Analyze a page first to get related paper recommendations.
      </p>
    `;
    return;
  }

  if (!papersCache.length) {
    content.innerHTML = `
      <p style="color:#82828c; text-align:center; margin:24px 0;">
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
    <p style="margin-top:12px; font-size:10px; color:#82828c; text-align:center;">
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
    <div style="margin-bottom:12px; padding:12px; background:#1b1b1f;
      border-radius:8px; border:1px solid #2e2e36;">
      <div style="display:flex; align-items:flex-start; gap:8px; margin-bottom:6px;">
        <span style="
          background:${levelColor}; color:#fff; font-size:10px; font-weight:700;
          padding:2px 7px; border-radius:10px; flex-shrink:0; margin-top:1px;
        ">L${paper.complexity || '?'}</span>
        <div style="flex:1; min-width:0;">
          ${url
            ? `<a href="${url}" target="_blank" rel="noopener"
                style="font-weight:600; color:#ff5a1f; font-size:12px;
                  text-decoration:none; word-break:break-word;">${title}</a>`
            : `<span style="font-weight:600; font-size:12px;">${title}</span>`}
          <p style="margin:2px 0 0; font-size:11px; color:#82828c;">${year}${cites}</p>
        </div>
      </div>
      ${abstract
        ? `<p style="margin:0; font-size:11px; color:#c9c9d0; line-height:1.5;">
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
    background: linear-gradient(135deg,#ff5a1f 0%,#e8480f 100%);
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
  const { gemini, groq } = await getApiKeys();

  ensurePanel();
  const panel = document.getElementById('rabbithole-panel');
  panel.style.display = 'flex';
  switchTab('analysis');

  if (!gemini && !groq) {
    showError('No API key set. Click ⚙️ in the panel header to add your Gemini or Groq key.');
    return;
  }

  showLoading('Explaining in plain terms…');

  try {
    const data = await callLLM(buildExplainPrompt(text));
    renderDumbifyResult(data, text);
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'Request timed out.' : error.message;
    showError(msg);
  }
}

function renderDumbifyResult(data, originalText) {
  const content = document.getElementById('rh-content');
  if (!content) return;

  const snippet  = originalText.slice(0, 140);
  const ellipsis = originalText.length > 140 ? '…' : '';

  const termsHtml = (data.terms || []).map((t) => `
    <div style="padding:7px 10px; background:#1b1b1f; border-radius:6px; margin-bottom:5px;">
      <span style="font-weight:700; color:#ff5a1f; font-size:12px;">${escapeHtml(t.term || '')}</span>
      <span style="color:#c9c9d0; font-size:12px;"> — ${escapeHtml(t.means || '')}</span>
    </div>
  `).join('');

  content.innerHTML = `
    <!-- Quote -->
    <div style="margin-bottom:14px; padding:10px 12px; background:#1c1613;
      border-radius:8px; border-left:3px solid #ff5a1f;">
      <p style="margin:0; font-size:11px; color:#82828c; font-style:italic; line-height:1.5;">
        "${escapeHtml(snippet)}${escapeHtml(ellipsis)}"
      </p>
    </div>

    <!-- Plain explanation -->
    <div style="margin-bottom:14px;">
      <p class="rh-section-label">In plain terms</p>
      <p style="margin:6px 0 0; font-size:13px; line-height:1.6; color:#f4f4f6;">
        ${escapeHtml(data.explanation || '')}
      </p>
    </div>

    <!-- Analogy -->
    ${data.analogy ? `
    <div style="margin-bottom:14px; padding:10px 12px; background:#1c1a10;
      border-radius:8px; border-left:3px solid #f6cc46;">
      <p style="margin:0 0 4px; font-size:10px; font-weight:700; color:#e6c34d;
        text-transform:uppercase; letter-spacing:0.5px;">Think of it like…</p>
      <p style="margin:0; font-size:13px; line-height:1.5; color:#c9c9d0;">
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
    <div style="margin-bottom:14px; padding:10px 12px; background:#121d16;
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
      border:1px solid #2e2e36; border-radius:6px; font-size:12px;
      color:#82828c; cursor:pointer;
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
      <div style="text-align:center; padding:24px 0; color:#82828c;">
        <div style="font-size:32px; margin-bottom:10px;">🕳️</div>
        <p style="font-weight:600; margin:0 0 8px; color:#c9c9d0;">No active session</p>
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
          <span style="font-size:11px; color:#f4f4f6; font-weight:600; flex:1;">${escapeHtml(c)}</span>
          <span style="font-size:10px; color:#82828c;">${pct}%</span>
        </div>
        <div style="height:3px; background:#26262d; border-radius:2px;">
          <div style="height:3px; width:${pct}%; background:linear-gradient(90deg,#ff5a1f,#e8480f);
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
      ? `<em style="color:#82828c;">Explored: ${escapeHtml(v.concept || '')}</em>`
      : escapeHtml(v.title || v.url || 'Unknown page');

    return `
      <div style="margin-bottom:8px; padding:9px 11px; background:#1b1b1f;
        border-radius:8px; border:1px solid #2e2e36;">
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:2px;">
          ${levelBadge}
          <span style="font-size:12px; font-weight:600; color:#f4f4f6; overflow:hidden;
            white-space:nowrap; text-overflow:ellipsis; flex:1;" title="${escapeHtml(v.url || '')}">
            ${titleDisplay}
          </span>
          ${ts ? `<span style="font-size:10px; color:#82828c; flex-shrink:0;">${ts}</span>` : ''}
        </div>
        ${concepts ? `<p style="margin:0; font-size:10px; color:#82828c; padding-left:${v.level ? '44px' : '0'};">${concepts}</p>` : ''}
      </div>`;
  }).join('');

  // ── Initial render (area label is a placeholder while we call the LLM) ─
  const cachedArea = session.research_area;
  const areaLabel  = cachedArea?.area        || (topWeighted.length ? topWeighted.slice(0, 2).map(([c]) => c).join(' & ') : 'General research');
  const areaDesc   = cachedArea?.description || '';

  content.innerHTML = `
    <!-- Research focus card -->
    <div id="rh-focus-card" style="margin-bottom:14px; padding:12px 14px;
      background:linear-gradient(135deg,#1b1b1f,#e8f4ff); border-radius:10px;">
      <p style="margin:0 0 2px; font-size:10px; font-weight:700; color:#ff5a1f;
        text-transform:uppercase; letter-spacing:0.5px;">Research focus</p>
      <p id="rh-focus-area" style="margin:0 0 4px; font-size:14px; font-weight:700; color:#f4f4f6;">
        ${escapeHtml(areaLabel)}
      </p>
      <p id="rh-focus-desc" style="margin:0 0 10px; font-size:11px; color:#c9c9d0; line-height:1.5;">
        ${escapeHtml(areaDesc)}
      </p>
      ${conceptChipsHtml
        ? `<div style="margin-top:8px;">${conceptChipsHtml}</div>`
        : ''}
      <p style="margin:10px 0 0; font-size:10px; color:#82828c;">
        ${pageVisits.length} page${pageVisits.length !== 1 ? 's' : ''} analyzed · ${weighted.length} concept${weighted.length !== 1 ? 's' : ''} tracked
      </p>
    </div>

    <!-- Visit timeline -->
    <p class="rh-section-label" style="margin-bottom:8px;">Recent pages</p>
    ${visitCards || `<p style="color:#82828c; font-size:12px; margin:0;">No pages analyzed yet.</p>`}
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
  return palette[Math.round(level)] || '#ff5a1f';
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
      color: #ff5a1f;
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
