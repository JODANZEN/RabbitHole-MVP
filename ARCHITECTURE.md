# RabbitHole — Architecture Reference

> This document is the single source of truth for any agent or contributor adding features.
> Read it before touching code. Update it when you change anything structural.

---

## What RabbitHole Does

RabbitHole is a Chrome extension that helps researchers understand scientific content on the web. It sits on top of any page, analyzes the content with an LLM, and gives you:

- A **difficulty level** (1–10) with explanation
- A plain-language **summary**
- **Key concepts** to follow up on
- **Related paper recommendations** (Semantic Scholar)
- **Dumbify** — highlight any text → get a plain-language explanation with analogies
- A **research thread** — a cross-domain session tracking what you've been reading

---

## Repository Layout

```
RabbitHole-MVP/
├── extension/              # Chrome extension (Manifest V3)
│   ├── manifest.json       # Permissions, content scripts, background
│   ├── background.js       # Service worker: context menu, tab injection
│   ├── content.js          # Main UI logic injected into every page (~1100 lines)
│   └── popup.html/js       # Extension toolbar popup (minimal, mostly launches content.js)
│
├── papers/                 # Python FastAPI backend
│   ├── backend/
│   │   ├── main.py         # FastAPI app, all HTTP endpoints, URL cache
│   │   ├── llm_service.py  # LLM provider routing, analysis, explain, recommendations
│   │   └── prompts.py      # All LLM prompt templates
│   ├── .env                # Real secrets — NEVER committed (gitignored)
│   ├── .env.example        # Template with setup instructions
│   ├── analysis_cache.json # Persisted URL→result cache (gitignored, auto-created)
│   └── requirements.txt    # Python dependencies
│
└── ARCHITECTURE.md         # This file
```

---

## Extension Deep Dive (`extension/`)

### `manifest.json`
- Manifest V3
- Permissions: `activeTab`, `scripting`, `storage`, `contextMenus`
- `storage` is required for cross-domain session persistence (`chrome.storage.local`)
- Content script (`content.js`) runs at `document_idle` on `<all_urls>`

### `background.js` (Service Worker)
Runs persistently in the background. Responsibilities:
1. Registers the right-click "🐇 Explain with RabbitHole" context menu on install
2. Handles `chrome.contextMenus.onClicked` → sends `DUMBIFY_SELECTION` message to the active tab's content script
3. Handles the extension icon click → injects and activates content.js if needed

Key pattern — `injectAndSend(tabId, message)`: if content.js is not yet running in a tab, inject it via `chrome.scripting.executeScript`, then send the message.

### `content.js` (Main UI — injected into pages)
Everything the user sees. Key sections:

**Context validity guard** — all `chrome.*` API calls are wrapped:
```js
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}
```
This prevents "Extension context invalidated" crashes when the extension reloads while a tab is still open.

**Session storage** — uses `chrome.storage.local` (not `localStorage`). This is intentional: `localStorage` is per-domain, `chrome.storage.local` persists across all domains, which is what the research thread needs.

**Panel UI** — a floating panel with three tabs:
- `Analysis` tab — level, summary, concepts, prerequisite/easier/deeper
- `Papers` tab — related paper recommendations from Semantic Scholar
- `Thread` tab — research session: pages visited, top concepts by frequency

**Text extraction** — `extractPageText()` strips nav/header/footer/UI chrome from the DOM before sending to the backend. The `cleaned: true` flag in the API request signals this was done.

**Dumbify flow**:
1. `mouseup` listener detects text selection → shows floating "🐇 Explain" button
2. Button click → `triggerDumbify(selectedText)` → POST `/explain`
3. Result renders in the Analysis tab with explanation, analogy, key terms, and why-it-matters

**Paper recommendations flow**:
- Fires async after analysis completes (non-blocking)
- `startPaperRecommendations(concepts, level)` → POST `/recommend`
- Updates Papers tab with a count badge when results arrive

**Research thread flow**:
- Each analyzed page → POST `/session/visit` with title, URL, concepts, timestamp
- `renderThreadTab()` reads from `chrome.storage.local`, shows research focus (top concepts by frequency) and a timeline of visited pages

---

## Backend Deep Dive (`papers/backend/`)

### `main.py` — FastAPI endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/analyze` | POST | Analyze paper text → level, summary, concepts |
| `/explain` | POST | Dumbify: plain-language explanation of selected text |
| `/recommend` | POST | Related papers from Semantic Scholar (accepts `session_concepts` for session-aware blending) |
| `/analyze_pdf_url` | POST | Fetch PDF from URL, extract text, analyze |
| `/analyze_docx_url` | POST | Fetch DOCX from URL, extract text via python-docx, analyze |
| `/analyze_epub_url` | POST | Fetch EPUB from URL, extract text via ebooklib, analyze |
| `/infer_research_area` | POST | LLM-inferred research area label + description from session's top weighted concepts |
| `/session/start` | POST | Create a research session |
| `/session/visit` | POST | Record a page visit to a session |
| `/session/{id}` | GET | Retrieve session data |
| `/health` | GET | Health check |

**Analysis cache** (`analysis_cache.json`):
- Keyed by URL (normalized, trailing slash stripped)
- Loaded from disk on startup, written after each new LLM result
- Only real LLM results are cached (confidence ≥ 0.4); mock fallbacks are not stored
- This prevents re-spending API calls on papers the user has already read

### `llm_service.py` — LLM routing and analysis

**Provider chain** — `_get_providers()` returns an ordered list of `(api_key, base_url, model, name, max_input_chars)`. `analyze_paper()` and `explain_text()` iterate this list and fall through on `QuotaExhaustedError`.

Default priority:
1. **Gemini 2.0 Flash** — 1,500 req/day free, 1M token context, best quality
2. **Groq (llama-3.3-70b-versatile)** — 14,400 req/day free, 128k ctx, fast
3. **OpenAI gpt-4o-mini** — paid, no daily limit

**Dev override**: set `RABBITHOLE_PROVIDER=groq` in `.env` to pin a specific provider first during development.

**Text fitting** — `_fit_text(text, max_chars)`: keeps the first 70% + last 30% of the budget to cover abstract/intro and conclusion. Used to fit papers into Groq's 12k TPM free-tier limit (25k chars max).

**Single-pass vs chunked**:
- Papers ≤ 600k chars → `_single_pass()` — one LLM call, full text
- Papers > 600k chars → `_chunked_analysis()` — samples first/middle/last chunk, sequential with 4s delay, then synthesis call
- 600k chars ≈ 150k tokens — effectively all real papers use single-pass

**Quota exhaustion detection** (`_is_quota_exhausted()`): distinguishes daily quota errors (`RESOURCE_EXHAUSTED`, "daily limit") from per-minute throttling. Quota errors bail immediately; throttle errors wait and retry once.

**Concept filtering** — `_is_noise_concept()` filters:
- Institution/venue words (university, journal, arxiv…)
- Common first names
- `Firstname Lastname` / `F. Lastname` person patterns
- Address/street words (avenue, street, north, south…)
- All-caps short tokens, purely numeric, too-short strings
- UI labels from the extension itself

### `prompts.py` — LLM prompt templates

- `get_analysis_prompt(title, text)` — main paper analysis, returns strict JSON with level/summary/concepts/prerequisite/easier/deeper/confidence
- `get_synthesis_prompt(title, chunk_results)` — merges per-chunk analyses into one final result
- `get_explain_prompt(text, context)` — Dumbify explanation with analogy, terms, why-it-matters

All prompts instruct the model to return **only** raw JSON with no markdown fences.

---

## Data Flow: Full Page Analysis

```
User visits arxiv paper
       ↓
content.js: extractPageText() → strips DOM chrome → ~100k chars
       ↓
POST /analyze  { title, text, url, cleaned: true }
       ↓
main.py: check analysis_cache[url] → HIT? return immediately
       ↓  (MISS)
llm_service.analyze_paper()
  → _fit_text(text, provider.max_chars)
  → _single_pass() → _call_llm() → Gemini/Groq/OpenAI
  → _parse_and_validate() → _postprocess_concepts() → verify_and_filter_concepts()
       ↓
main.py: cache result, return JSON
       ↓
content.js: render Analysis tab (level, summary, concepts)
       ↓  (async, non-blocking)
POST /recommend  { concepts, level }
  → find_related_papers() → Semantic Scholar API
  → sort by |complexity - current_level|
  → update Papers tab badge + render cards
       ↓  (async, after analysis)
POST /session/visit  { session_id, url, title, concepts, timestamp }
  → server stores in memory sessions dict
  → content.js renderThreadTab() updates Thread tab from chrome.storage.local
```

---

## How to Add a New Content Source

The backend is source-agnostic — it just needs `(title, text)`. The heavy lifting is getting clean text into those fields.

### PDF Support (already implemented)
`/analyze_pdf_url` endpoint: receives a URL, fetches the PDF with `httpx`, extracts text with `pypdf`, calls `analyze_paper(title, text)`. The content script detects PDF viewer pages and sends the PDF URL to this endpoint instead of the normal `/analyze` endpoint.

### YouTube Videos (future)
1. In `content.js`: detect `window.location.hostname === 'www.youtube.com'`
2. Extract the video transcript via YouTube's transcript API or `ytInitialData` in the page's DOM
3. POST to `/analyze` with `{ title: document.title, text: transcript, url: ... }`
4. No backend changes needed — the analyze pipeline is already text-agnostic

### Any New Web Source
Same pattern as YouTube: detect the domain in `content.js`, extract the meaningful text with a domain-specific scraper, pass it to `/analyze`. The backend doesn't care about the source.

---

## Environment Variables (`papers/.env`)

| Variable | Purpose | Required |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini 2.0 Flash (free: 1,500/day) | Recommended |
| `GROQ_API_KEY` | Groq Llama 3.3-70b (free: 14,400/day) | Recommended backup |
| `OPENAI_API_KEY` | OpenAI gpt-4o-mini (paid) | Optional |
| `RABBITHOLE_PROVIDER` | Dev override: `gemini`, `groq`, or `openai` | Dev only |
| `BACKEND_HOST` | Uvicorn host (default `0.0.0.0`) | Optional |
| `BACKEND_PORT` | Uvicorn port (default `8000`) | Optional |

If no keys are set, the backend runs in **mock mode** — returns heuristic analysis with no API calls, useful for UI development.

---

## Key Design Decisions

**Why `chrome.storage.local` not `localStorage`?**
`localStorage` is partitioned by domain — a session started on `arxiv.org` would be invisible on `nature.com`. `chrome.storage.local` is shared across all domains for the same extension.

**Why not stream the LLM response?**
The analysis result is a structured JSON object. Streaming partial JSON is painful to parse. The full response is small enough (~500 tokens) that latency is acceptable.

**Why Gemini over OpenAI as default?**
Free tier, and the 1M token context means full papers fit in a single call. GPT-4o-mini's 128k context is technically sufficient but the per-token cost adds up quickly during development.

**Why cache by URL and not by content hash?**
URL is available immediately before any text extraction. A content hash would require extracting the text first (expensive). The assumption is that a given arxiv/DOI URL always resolves to the same paper.

**Why confidence < 0.4 means "don't cache"?**
Mock results have confidence ≈ 0.3 (set explicitly). Real LLM results for a decent-length paper are ≥ 0.6. The 0.4 threshold ensures only genuine LLM analyses are persisted.
