# ?? Quick Test Reference Card

## 30-Second Setup

```bash
# Terminal 1: Start Backend
cd papers/
pip install -r requirements.txt
python backend/main.py

# Terminal 2: Or just verify health
curl http://127.0.0.1:8000/health
```

Then:
1. Go to chrome://extensions
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select `extension/` folder
5. Visit any webpage
6. Click ?? button (bottom-right)

---

## What Content Can You Test?

| Content | URL | How It Works | Best For |
|---------|-----|--------------|----------|
| **Wikipedia** | https://en.wikipedia.org/wiki/Machine_learning | Click button ? extracts article text ? shows level/summary | ? **BEST** - Consistent extraction |
| **arXiv** | https://arxiv.org/abs/2312.10997 | Extracts abstract ? academic difficulty | ? **GOOD** - Real papers |
| **Medium** | https://medium.com/@search | Extracts article body ? shows readability | ? **GOOD** - Long content |
| **Google Scholar** | https://scholar.google.com/ | Extracts abstracts ? paper analysis | ? **GOOD** |
| **Any Blog** | https://example.com/any-post | Extracts visible text ? analysis | ? Works anywhere |
| **Selected Text** | Any page | Highlight text + click button ? analyzes selection | ? **PRO TIP** |

---

## What You'll See (Typical Response)

```
?? Level 7/10 (orange badge) ??????????????
? Intermediate topic with some math       ?
???????????????????????????????????????????
? Summary                                 ?
? This paper introduces X. It shows how.. ?
???????????????????????????????????????????
? Key Concepts                            ?
? [Concept 1] [Concept 2] [Concept 3]     ?
???????????????????????????????????????????
? ?? Prerequisite                         ?
? Linear algebra fundamentals             ?
???????????????????????????????????????????
? ?? Start Here (Easier)                  ?
? Introduction to Neural Networks         ?
???????????????????????????????????????????
? ?? Go Deeper                            ?
? Advanced Deep Learning Techniques       ?
???????????????????????????????????????????
```

**Level Colors:**
- ?? 1-2: Beginner  
- ?? 3-4: Intermediate  
- ?? 5-6: Advanced  
- ?? 7-8: Hard  
- ?? 9-10: Expert

---

## DevTools Logs to Expect

Open DevTools (F12) ? Console, you should see:

```
[RabbitHole Papers] Content script loaded
[RabbitHole Papers] Creating panel...
[RabbitHole Papers] Panel created and injected
[RabbitHole Papers] Analyze button clicked
[RabbitHole Papers] Extracting text... (or: Using selected text)
[RabbitHole Papers] Calling backend: http://127.0.0.1:8000/analyze
[RabbitHole Papers] Response received: {level: 7, ...}
[RabbitHole Papers] Rendering response...
```

---

## If Something Goes Wrong

| Error | Fix |
|-------|-----|
| "Cannot reach backend" | Run `python papers/backend/main.py` |
| "CORS error" | Restart backend after checking CORS middleware |
| "Invalid JSON" | Check backend logs for errors |
| Button doesn't appear | Refresh page (Ctrl+R) |
| No debug logs in console | Check extension is enabled in chrome://extensions |

---

## Test with Pop-Up

1. Click extension icon (??) in toolbar
2. Click "?? Test Backend" button
3. Should see green ? + raw JSON response in 2 seconds

If that fails, the extension can't reach backend.

---

## Modes

### Mock Mode (Default - No API Cost)
- No OPENAI_API_KEY set
- Instant responses (~500ms)
- Difficulty based on text length
- Perfect for UI/UX testing

### Real OpenAI Mode
- Set `OPENAI_API_KEY=sk-...` in `papers/.env`
- 5-10s first request (API latency)
- GPT-4 Turbo analysis
- Production quality

---

## Files Modified/Created

? **New Extension Files:**
- `extension/manifest_papers.json` ? Manifest V3
- `extension/content_papers.js` ? Content script
- `extension/popup_papers.html` ? Popup UI
- `extension/background.js` ? Service worker
- `extension/PAPERS_SETUP.md` ? Full setup guide (this repo)
- `extension/QUICK_TEST_REFERENCE.md` ? This file

? **Papers Backend (Already created):**
- `papers/backend/main.py`
- `papers/backend/llm_service.py`
- `papers/backend/prompts.py`
- `papers/requirements.txt`
- `papers/index.html` (standalone web UI)
- `papers/README.md`

? **Unchanged (YouTube extension):**
- Everything in `extension/manifest.json`, `extension/content.js` (original)

---

## Minimal Example Test

**Step 1: Backend ready?**
```bash
curl -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"title": "Test", "text": "Machine learning is a field of AI that enables computers to learn from data."}'
```

Expected: Returns JSON with `level`, `summary`, `concepts`, etc.

**Step 2: Extension loaded?**
- chrome://extensions ? Search "RabbitHole Papers" ? Should be there

**Step 3: On a real page?**
- Visit https://en.wikipedia.org/wiki/Artificial_intelligence
- ?? button appears ? Click it ? Panel shows within 5s

---

## Success Criteria

? You're ready when:
- Backend responds to `/health` endpoint
- Extension loads in chrome://extensions (no errors)
- ?? button appears on Wikipedia
- Clicking button shows "? Analyzing..."
- Within 5s: Panel shows level, summary, concepts, learning path
- DevTools Console has `[RabbitHole Papers]` debug logs
- No red errors anywhere
