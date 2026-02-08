# ?? Chrome Extension Hook-Up Complete

## ? What's Ready to Test

Your papers backend is **fully hooked up** with a Chrome extension. Everything is ready to test end-to-end.

---

## ?? Files Created

### Chrome Extension (New Papers Extension)
Located in `extension/`:
- **`manifest_papers.json`** — Manifest V3 config
- **`content_papers.js`** — Content script (runs on pages, extracts text, sends to backend)
- **`popup_papers.html`** — Extension popup (shows backend status, test button)
- **`background.js`** — Service worker (minimal, MV3 required)

### Backend (Already Created)
Located in `papers/`:
- **`backend/main.py`** — FastAPI server with `/analyze` endpoint
- **`backend/llm_service.py`** — LLM + mock fallback
- **`backend/prompts.py`** — Prompt templates
- **`requirements.txt`** — Python dependencies

### Documentation (New)
- **`extension/PAPERS_SETUP.md`** — Full setup guide (12 steps)
- **`extension/QUICK_TEST_REFERENCE.md`** — Quick reference card

---

## ?? How It Works (User Flow)

```
1. User visits any webpage (Wikipedia, arXiv, Medium, etc.)
   ?
2. ?? "Analyze Paper" button appears in bottom-right corner
   ?
3. User clicks button
   ?
4. Panel slides in on the right with "Ready to analyze"
   ?
5. User clicks "Analyze" (or button itself again)
   ?
6. Panel shows "? Analyzing... please wait"
   ?
7. Content script extracts article text (or user's selection)
   ?
8. Sends JSON: { "title": "...", "text": "..." } to backend
   ?
9. Backend analyzes with LLM (or mock) ? returns analysis
   ?
10. Panel displays:
    - Difficulty level (1-10 with color badge)
    - Why that level
    - 2-sentence summary
    - 3 key concepts
    - Prerequisite knowledge
    - Easier paper to read first
    - Deeper topic to explore next
```

---

## ?? What Content Can You Test?

### ? Best Testing Websites

| Site | URL | Why It Works | Text Extracted |
|------|-----|--------------|-----------------|
| **Wikipedia** | https://en.wikipedia.org/wiki/Machine_learning | Perfect structure, long text | Article body |
| **arXiv** | https://arxiv.org/abs/2312.10997 | Academic papers, metadata | Abstract + intro |
| **Medium** | https://medium.com/@search | Modern long-form | Article text |
| **Dev.to** | https://dev.to/ | Technical articles | Post content |
| **Towards Data Science** | https://towardsdatascience.com | Data/AI articles | Article body |
| **Google Scholar** | https://scholar.google.com | Paper abstracts | Abstract text |

### ? Text Extraction Priority

When you click the button, the extension tries:

1. **Selected text** (if you highlight text, only that is analyzed)
2. **Article element** (`<article>`, `<main>`, Wikipedia container, etc.)
3. **Page body** (fallback: entire visible text)

**Pro Tip:** Highlight specific text ? click button ? only that section is analyzed.

---

## ? Quick Start (5 minutes)

### Terminal 1: Start Backend
```bash
cd papers/
pip install -r requirements.txt
python backend/main.py
```

You should see:
```
INFO:     Application startup complete
INFO:     Uvicorn running on http://0.0.0.0:8000
```

### Terminal 2: Verify Backend
```bash
curl http://127.0.0.1:8000/health
```

Expected output: `{"status":"ok"}`

### Chrome: Load Extension
1. Open **chrome://extensions**
2. Enable **"Developer mode"** (top-right toggle)
3. Click **"Load unpacked"**
4. Select **`extension/`** folder from repo
5. You'll see ?? icon in toolbar

### Test It
1. Visit https://en.wikipedia.org/wiki/Artificial_intelligence
2. Look for ?? button in bottom-right
3. Click it
4. Panel opens on right side
5. Click "Analyze" again
6. Wait 2-5 seconds
7. See result with difficulty, summary, concepts, learning path

---

## ?? Testing Scenarios

### Scenario 1: Wikipedia Article (Most Reliable)
**URL:** https://en.wikipedia.org/wiki/Machine_learning

**What to expect:**
- Text: ~8000 chars from main article
- Response Time: 2-5 seconds (backend)
- Difficulty: Usually 5-8 (intermediate-advanced)
- Summary: Accurate description of ML
- Concepts: ["Machine Learning", "Neural Networks", "Classification"]

### Scenario 2: arXiv Paper Abstract
**URL:** https://arxiv.org/abs/2312.10997

**What to expect:**
- Text: Abstract + introduction
- Response Time: 3-5 seconds
- Difficulty: 6-9 (advanced)
- Summary: Paper's contribution
- Concepts: Technical terms from paper

### Scenario 3: Selected Text (Manual Selection)
**Any page** ? Highlight paragraph ? Click button

**What to expect:**
- Only your highlighted text analyzed
- Faster response (shorter context)
- More focused analysis

### Scenario 4: Blog Post
**Any Medium/Dev.to article**

**What to expect:**
- Friendly language
- Difficulty: 3-6 (depends on topic)
- Fast extraction

### Scenario 5: Multiple Analyses
**Same page, multiple clicks**

**What to expect:**
- First: 3-5s (backend processing)
- Second+: Same timing (backend is stateless)
- Good for comparing different selections

---

## ?? How to Debug

### Open DevTools (F12 or Cmd+Option+I)

### Console Tab
Look for `[RabbitHole Papers]` logs:
```
? Content script loaded
? Creating panel...
? Panel created and injected
? Analyze button clicked
? Extracting text... (Using article element | 5234 chars)
? Calling backend: http://127.0.0.1:8000/analyze
? Response received: {level: 7, level_reason: "...", ...}
? Rendering response...
```

### If No Logs?
1. Check extension is enabled: chrome://extensions ? toggle ON
2. Refresh page: Ctrl+R
3. Try a different page (Wikipedia if all else fails)

### If Error Logs?
Common ones:
```
? "Cannot reach backend at http://127.0.0.1:8000"
   ? Backend not running? Start it: python papers/backend/main.py

? "Backend returned invalid JSON"
   ? OpenAI error or bad response? Check backend terminal logs

? "Request timed out after 30s"
   ? Backend is slow? Check OpenAI API quota or switch to mock mode
```

### Test Button in Popup
1. Click ?? extension icon (toolbar)
2. Click "?? Test Backend" button
3. Should show green ? within 2 seconds
4. If fails: Backend not running or wrong URL

---

## ?? What You'll See

### The Panel Layout

```
???????????????????????????????????????
? RabbitHole Papers            ?      ?
???????????????????????????????????????
?                                     ?
? ?? Level 7/10 (orange) ??????????  ?
? ? Advanced topic with heavy math  ?  ?
? ???????????????????????????????????  ?
?                                     ?
? Summary                             ?
? This paper introduces neural nets.. ?
?                                     ?
? Key Concepts                        ?
? [Neural Networks] [Math] [Algo]     ?
?                                     ?
? ?? Prerequisite                     ?
? Linear algebra fundamentals         ?
?                                     ?
? ?? Start Here (Easier)              ?
? Intro to Machine Learning           ?
?                                     ?
? ?? Go Deeper                        ?
? Advanced Deep Learning              ?
?                                     ?
???????????????????????????????????????
```

**Level Color Coding:**
- ?? **1-2:** Easy (Beginner)
- ?? **3-4:** Moderate (Intermediate)
- ?? **5-6:** Hard (Advanced)
- ?? **7-8:** Very Hard (Expert)
- ?? **9-10:** Expert (PhD Level)

---

## ?? Configuration

### Backend URL
Default: `http://127.0.0.1:8000`

If you need to change it:
- Edit `extension/content_papers.js` line 6:
  ```javascript
  const BACKEND_URL = 'http://YOUR_IP:PORT';
  ```
- Then reload extension in chrome://extensions

### OpenAI API (Optional)
**Default:** Mock mode (instant, no API cost)

**To use real OpenAI:**
1. Get key: https://platform.openai.com/api-keys
2. Create `papers/.env`:
   ```
   OPENAI_API_KEY=sk-...
   ```
3. Restart backend
4. First request takes 5-10s, then cached responses

---

## ?? Troubleshooting

### Issue: "Cannot reach backend"
```
? Is backend running?
  python papers/backend/main.py
? Does health check work?
  curl http://127.0.0.1:8000/health
? Is URL correct?
  Check BACKEND_URL in content_papers.js
```

### Issue: "CORS error" (even though we enabled it)
```
? Restart backend (new processes inherit CORS)
? Check CORSMiddleware in papers/backend/main.py
? Ensure allow_origins=["*"]
```

### Issue: Button doesn't appear
```
? Extension loaded? chrome://extensions ? toggle ON
? Page supported? Try Wikipedia first
? Refresh page? Ctrl+R
? Check logs? DevTools Console ? [RabbitHole Papers] missing?
```

### Issue: Panel appears but nothing happens
```
? Check DevTools for errors
? Backend running? Terminal should show request logs
? Try popup test first (button in toolbar)
```

### Issue: Response is always "Level 2-3"
```
? You're in mock mode (no API key set)
? To use real OpenAI: Add OPENAI_API_KEY to papers/.env
? Or keep mock mode for testing, upgrade later
```

---

## ?? Expected Performance

| Action | Time |
|--------|------|
| Button click ? panel open | ~100ms |
| Extract text | ~50ms |
| Send request to backend | ~20ms |
| Backend processing (mock) | ~500ms |
| Backend processing (OpenAI) | 3-8s |
| Render response | ~50ms |
| **Total (mock)** | **~1-2s** |
| **Total (OpenAI)** | **3-10s** |

---

## ?? Success Checklist

- [ ] Backend running: `python papers/backend/main.py`
- [ ] Health check works: `curl http://127.0.0.1:8000/health`
- [ ] Extension loaded in chrome://extensions
- [ ] ?? button appears on Wikipedia
- [ ] Click button ? panel opens
- [ ] Click again ? "? Analyzing..."
- [ ] Within 5s: Level badge appears
- [ ] See summary, concepts, learning path
- [ ] DevTools Console has `[RabbitHole Papers]` logs
- [ ] No red errors

---

## ?? Full Documentation

For complete setup, troubleshooting, and advanced config:
? See **`extension/PAPERS_SETUP.md`**

For quick reference:
? See **`extension/QUICK_TEST_REFERENCE.md`**

---

**You're all set! Go test it on Wikipedia. ??**
