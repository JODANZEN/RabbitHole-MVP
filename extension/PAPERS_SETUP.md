# RabbitHole Papers - Chrome Extension Setup Guide

## Quick Start (5 minutes)

### 1. **Start the Backend**
```bash
cd papers/
pip install -r requirements.txt
python backend/main.py
```

**Expected output:**
```
INFO:     Application startup complete
INFO:     Uvicorn running on http://0.0.0.0:8000
```

Verify it works:
```bash
curl http://127.0.0.1:8000/health
# Should return: {"status": "ok"}
```

---

### 2. **Load the Extension in Chrome**

1. Open **chrome://extensions/** in your browser
2. Enable **"Developer mode"** (toggle in top-right corner)
3. Click **"Load unpacked"**
4. Select the **`extension/`** folder from this repo
5. You should see the extension loaded with icon ??

**Important:** Use `manifest_papers.json` as the manifest (Chrome will auto-detect it if named correctly, or rename it to `manifest.json` temporarily).

---

### 3. **Test on Different Content Types**

The extension works on **any page with text**, optimized for:

#### **A. Wikipedia (Best for Testing)**
- **URL:** https://en.wikipedia.org/wiki/Machine_learning
- **What happens:**
  1. Click ?? button (bottom-right of page)
  2. Panel opens on the right side
  3. Text from the main article is extracted automatically
  4. Backend analyzes it and returns:
     - Difficulty level (1-10 with color badge)
     - Why it's at that level
     - 2-sentence summary
     - 3 key concepts
     - Prerequisite knowledge needed
     - Easier related paper to read first
     - Deeper topic to explore next

#### **B. arXiv (Academic Papers)**
- **URL:** https://arxiv.org/abs/2312.10997
- **What happens:**
  - Abstract + introduction are extracted
  - Real academic paper difficulty assessment
  - Great for testing LLM with technical content

#### **C. Medium Articles**
- **URL:** https://medium.com/@any-article
- **What happens:**
  - Long-form content extraction
  - Tests with modern writing styles

#### **D. Google Scholar**
- **URL:** https://scholar.google.com/
- **What happens:**
  - Works on paper abstracts

#### **E. Any Web Page**
- The extension runs on `*://*/*` so it works on **ANY website**
- Click the button and it extracts visible text
- Great for testing on blog posts, documentation, etc.

---

## How Text Extraction Works

The extension tries (in order):

1. **Selected text** — If you highlight text on a page and click analyze, it uses your selection
2. **Article element** — Looks for `<article>`, `<main>`, or `role="main"` (Wikipedia/arXiv)
3. **Body text** — Falls back to entire page text

**To analyze just one section:**
- Highlight the text you want to analyze
- Click ?? button
- Only your selection is sent to the backend

---

## Testing Checklist

### ? Step 1: Backend Running
```bash
[ ] Backend running on http://127.0.0.1:8000
[ ] Health check: curl http://127.0.0.1:8000/health ? {"status": "ok"}
```

### ? Step 2: Extension Loaded
```bash
[ ] Extension visible in chrome://extensions
[ ] Icon appears in toolbar
[ ] No red errors in extension detail page
```

### ? Step 3: Test on Wikipedia
```bash
[ ] Go to https://en.wikipedia.org/wiki/Artificial_intelligence
[ ] Click ?? button
[ ] Panel opens with "Ready to analyze"
[ ] Click button again
[ ] Panel shows "? Analyzing..."
[ ] Within 5 seconds, see:
    ? Level badge (e.g., "Level 7/10")
    ? Color-coded (red=hard, green=easy)
    ? Level reason (e.g., "Advanced topic with heavy math")
    ? Summary (2 sentences)
    ? 3 concepts (e.g., ["Neural Networks", "Machine Learning", "Algorithms"])
    ? Learning path with prerequisite, easier, deeper
```

### ? Step 4: Check DevTools Logs
```bash
[ ] Press F12 or Cmd+Option+I
[ ] Go to Console tab
[ ] Look for "[RabbitHole Papers]" logs:
    - "Content script loaded"
    - "Extracting text..."
    - "Calling backend: http://127.0.0.1:8000/analyze"
    - "Response received: {...}"
[ ] No red errors
```

### ? Step 5: Test Popup
```bash
[ ] Click extension icon (??) in toolbar
[ ] Popup shows backend URL and test button
[ ] Click "Test Backend" button
[ ] Within 2 seconds, see green ? and raw JSON response
```

### ? Step 6: Try Different Pages
```bash
[ ] arXiv: https://arxiv.org/abs/2312.10997
[ ] Medium: https://medium.com/search?q=AI
[ ] Any blog or doc page
[ ] All should work the same way
```

---

## Troubleshooting

### Problem: "Cannot reach backend at http://127.0.0.1:8000"

**Cause:** Backend not running or wrong address

**Fix:**
1. Check backend is running: `python papers/backend/main.py`
2. Verify URL: open http://127.0.0.1:8000/health in browser
3. If using different port, edit `content_papers.js` line 6:
   ```javascript
   const BACKEND_URL = 'http://127.0.0.1:8001'; // change 8000 to your port
   ```

### Problem: "CORS error" in DevTools console

**Cause:** Backend CORS not enabled (but you have it enabled)

**Fix:**
1. Check `papers/backend/main.py` has CORSMiddleware:
   ```python
   from fastapi.middleware.cors import CORSMiddleware
   app.add_middleware(
       CORSMiddleware,
       allow_origins=["*"],
       allow_methods=["*"],
       allow_headers=["*"],
   )
   ```
2. Restart backend: `Ctrl+C` then `python backend/main.py`

### Problem: "Backend returned invalid JSON"

**Cause:** Backend error or LLM API key issue

**Fix:**
1. Check backend logs for errors
2. Try mock mode (no OpenAI key needed):
   - Don't set OPENAI_API_KEY in `.env`
   - Backend will use mock responses
3. Or: Set `OPENAI_API_KEY=mock` in `papers/.env`

### Problem: Extension doesn't show button on page

**Cause:** Extension not loaded or disabled

**Fix:**
1. Go to chrome://extensions/
2. Search for "RabbitHole Papers"
3. Toggle it ON (switch should be blue)
4. Refresh the page (Ctrl+R or Cmd+R)

### Problem: Button appears but clicking does nothing

**Cause:** Content script not injected

**Fix:**
1. Open DevTools (F12)
2. Look for "[RabbitHole Papers]" logs
3. If not there, extension may not have loaded
4. Try: Unload + reload extension in chrome://extensions

### Problem: Panel appears but loading never finishes

**Cause:** Backend timeout (slow response or not responding)

**Fix:**
1. Check backend is actually running
2. Try popup test first (button in top-right)
3. Check OpenAI API key is valid
4. Look for errors in backend terminal

---

## Testing with Mock Data (No API Key Needed)

The backend has a **mock mode** for development:

**Option A: Don't set API key**
```bash
# In papers/.env, leave this empty or don't create the file
OPENAI_API_KEY=
```

**Option B: Explicitly use mock**
```bash
# In papers/.env
OPENAI_API_KEY=mock
```

With mock mode:
- ? Frontend works completely
- ? No API costs
- ? Instant responses (~500ms)
- ? Difficulty levels based on text length (not AI)

---

## Testing with Real OpenAI API

1. Get API key from https://platform.openai.com/api-keys
2. Add to `papers/.env`:
   ```bash
   OPENAI_API_KEY=sk-...your-key-here...
   ```
3. Restart backend
4. Use extension normally
5. First request takes 5-10s (API latency), rest faster

---

## File Reference

```
extension/
??? manifest_papers.json      ? Manifest for papers extension
??? content_papers.js         ? Content script (runs on pages)
??? popup_papers.html         ? Popup UI (extension icon click)
??? background.js             ? Service worker
??? (original YouTube files...) ? Unchanged
```

```
papers/
??? backend/
?   ??? main.py              ? FastAPI server
?   ??? llm_service.py       ? LLM + mock logic
?   ??? prompts.py           ? Prompt template
??? index.html               ? Standalone web UI
??? requirements.txt         ? Dependencies
??? .env.example             ? Config template
??? README.md                ? Docs
```

---

## Next Steps

Once everything works:

1. **Test on many pages** to see how difficulty varies
2. **Check DevTools logs** to understand extraction behavior
3. **Customize prompts** in `papers/backend/prompts.py` for better results
4. **Use real OpenAI API** for production-grade analysis
5. **Customize colors/UI** in `content_papers.js` to match your style

---

## Questions?

Check:
1. Backend logs (terminal where you ran `python backend/main.py`)
2. Browser console (DevTools ? Console tab)
3. Extension logs in chrome://extensions/ ? Details ? Inspect views
