/**
 * RabbitHole - Content Script
 * Extracts article/paper text and sends to local FastAPI backend for analysis.
 * Activated when the user clicks the extension icon.
 */

const BACKEND_URL = 'http://127.0.0.1:8000';
const REQUEST_TIMEOUT_MS = 30000;

console.debug('[RabbitHole] Content script loaded');

/**
 * Extract visible article text from the page.
 * Priority: selected text > article element > body text
 */
function extractText() {
  console.debug('[RabbitHole] Extracting text...');

  const selection = window.getSelection().toString().trim();
  if (selection.length > 100) {
    console.debug('[RabbitHole] Using selected text (' + selection.length + ' chars)');
    return selection;
  }

  const article =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('[role="main"]') ||
    document.querySelector('.mw-parser-output') || // Wikipedia
    document.querySelector('.arxiv'); // arXiv

  if (article) {
    const text = article.innerText.trim();
    if (text.length > 50) {
      console.debug('[RabbitHole] Using article element (' + text.length + ' chars)');
      return text;
    }
  }

  const text = document.body.innerText.trim();
  console.debug('[RabbitHole] Using body text (' + text.length + ' chars)');
  return text;
}

/**
 * Extract page title
 */
function extractTitle() {
  const h1 = document.querySelector('h1');
  if (h1) return h1.innerText.trim();

  const titleTag = document.querySelector('title');
  if (titleTag) return titleTag.innerText.trim();

  return document.domain;
}

/**
 * Ensure the panel exists in the DOM, create it if not
 */
function ensurePanel() {
  if (document.getElementById('rabbithole-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'rabbithole-panel';
  panel.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    z-index: 99999;
    width: 420px;
    max-height: 85vh;
    background: white;
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    overflow-y: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  panel.innerHTML = `
    <div style="padding: 14px 16px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 10px 10px 0 0;">
      <h3 style="margin: 0; font-size: 15px; color: #fff; font-weight: 700;">RabbitHole</h3>
      <button id="rabbithole-close" style="background: none; border: none; font-size: 18px; cursor: pointer; color: rgba(255,255,255,0.8); padding: 0; width: 24px; height: 24px; line-height: 24px;">✕</button>
    </div>
    <div id="rabbithole-content" style="padding: 16px; min-height: 80px;">
      <p style="color: #999; text-align: center; margin: 0;">Analyzing...</p>
    </div>
  `;

  document.body.appendChild(panel);

  document.getElementById('rabbithole-close').addEventListener('click', () => {
    panel.style.display = 'none';
  });
}

/**
 * Show loading state in the panel
 */
function showLoading() {
  const content = document.getElementById('rabbithole-content');
  if (content) {
    content.innerHTML = '<p style="color: #667eea; text-align: center; font-weight: 600; margin: 0;">Analyzing... please wait</p>';
  }
}

/**
 * Show error message in the panel
 */
function showError(message) {
  console.error('[RabbitHole] Error:', message);
  const content = document.getElementById('rabbithole-content');
  if (content) {
    content.innerHTML = `
      <div style="background: #fadbd8; border-left: 3px solid #e74c3c; padding: 10px; border-radius: 4px;">
        <p style="color: #e74c3c; font-size: 13px; line-height: 1.5; margin: 0;">${escapeHtml(message)}</p>
      </div>
    `;
  }
}

/**
 * Call the backend and analyze the page text
 */
async function analyzeText() {
  try {
    const title = extractTitle();
    const text = extractText();

    if (text.length < 50) {
      showError('Not enough text to analyze. Please visit an article or select a longer passage.');
      return;
    }

    console.debug('[RabbitHole] Calling backend:', BACKEND_URL + '/analyze', {
      title,
      textLength: text.length,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(BACKEND_URL + '/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[RabbitHole] HTTP ' + response.status + ':', errorText);
      showError('Backend error: HTTP ' + response.status + '. Is the backend running at ' + BACKEND_URL + '?');
      return;
    }

    const data = await response.json();
    console.debug('[RabbitHole] Response received:', data);
    renderResponse(data);
  } catch (error) {
    console.error('[RabbitHole] Error:', error);
    let message = error.message;

    if (error.name === 'AbortError') {
      message = 'Request timed out after 30s. Is the backend responding?';
    } else if (error instanceof SyntaxError) {
      message = 'Backend returned invalid JSON. Check server logs.';
    } else if (error.message.indexOf('Failed to fetch') !== -1) {
      message = 'Cannot reach backend at ' + BACKEND_URL + '. Make sure it is running.';
    }

    showError(message);
  }
}

/**
 * Render the analysis response into the panel
 */
function renderResponse(data) {
  const required = ['level', 'level_reason', 'summary', 'concepts', 'prerequisite', 'easier', 'deeper'];
  const missing = required.filter((f) => !(f in data));

  if (missing.length > 0) {
    showError('Backend response missing fields: ' + missing.join(', '));
    return;
  }

  const levelColor = getLevelColor(data.level);
  const concepts = Array.isArray(data.concepts) ? data.concepts : [];
  const conceptsHtml = concepts
    .map(
      (c) =>
        '<span style="background: #f0f0f0; padding: 5px 10px; border-radius: 4px; margin: 0 6px 6px 0; font-size: 12px; display: inline-block;">' +
        escapeHtml(c) +
        '</span>'
    )
    .join('');

  const html = `
    <div style="margin-bottom: 16px;">
      <div style="display: inline-block; background: ${levelColor}; color: white; padding: 6px 12px; border-radius: 6px; font-weight: 600; font-size: 13px;">Level ${data.level}/10</div>
      <p style="margin: 8px 0 0 0; font-size: 12px; color: #666; line-height: 1.4;">${escapeHtml(data.level_reason)}</p>
    </div>

    <div style="margin-bottom: 14px;">
      <p style="margin: 0; font-size: 11px; color: #667eea; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Summary</p>
      <p style="margin: 6px 0 0 0; font-size: 13px; line-height: 1.5; color: #333;">${escapeHtml(data.summary)}</p>
    </div>

    <div style="margin-bottom: 14px;">
      <p style="margin: 0; font-size: 11px; color: #667eea; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Key Concepts</p>
      <div style="margin: 6px 0 0 0; display: flex; flex-wrap: wrap;">${conceptsHtml}</div>
    </div>

    <div style="margin-bottom: 12px; padding: 10px; background: #f9f9f9; border-left: 3px solid #667eea; border-radius: 4px;">
      <p style="margin: 0; font-size: 11px; color: #667eea; font-weight: 600;">Prerequisite</p>
      <p style="margin: 6px 0 0 0; font-size: 12px; color: #333;">${escapeHtml(data.prerequisite)}</p>
    </div>

    <div style="margin-bottom: 12px; padding: 10px; background: #f9f9f9; border-left: 3px solid #667eea; border-radius: 4px;">
      <p style="margin: 0; font-size: 11px; color: #667eea; font-weight: 600;">Start Here (Easier)</p>
      <p style="margin: 6px 0 0 0; font-size: 12px; color: #333;">${escapeHtml(data.easier)}</p>
    </div>

    <div style="padding: 10px; background: #f9f9f9; border-left: 3px solid #667eea; border-radius: 4px;">
      <p style="margin: 0; font-size: 11px; color: #667eea; font-weight: 600;">Go Deeper</p>
      <p style="margin: 6px 0 0 0; font-size: 12px; color: #333;">${escapeHtml(data.deeper)}</p>
    </div>

    ${data.confidence ? '<p style="margin: 10px 0 0 0; font-size: 11px; color: #999;">Confidence: ' + (data.confidence * 100).toFixed(0) + '%</p>' : ''}
  `;

  document.getElementById('rabbithole-content').innerHTML = html;
}

/**
 * Get color for difficulty level
 */
function getLevelColor(level) {
  const colors = {
    1: '#2ecc71', 2: '#27ae60', 3: '#3498db', 4: '#2980b9',
    5: '#9b59b6', 6: '#8e44ad', 7: '#e74c3c', 8: '#c0392b',
    9: '#d35400', 10: '#a93226',
  };
  return colors[level] || '#667eea';
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Listen for the ANALYZE_PAGE message from background.js (triggered by icon click)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_PAGE') {
    console.debug('[RabbitHole] Analyze triggered via icon click');
    ensurePanel();
    const panel = document.getElementById('rabbithole-panel');
    panel.style.display = 'block';
    showLoading();
    analyzeText();
    sendResponse({ ok: true });
  }
});

console.debug('[RabbitHole] Ready');
