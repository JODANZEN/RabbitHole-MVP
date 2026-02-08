# ?? How to Test - Step by Step

## Everything is Ready. Here's Exactly What to Do:

---

## STEP 1: Install Dependencies (First Time Only)

```bash
cd papers
pip install -r requirements.txt
```

**Wait for this to complete.** It installs:
- `fastapi` — Web framework
- `uvicorn` — Server
- `pydantic` — Data validation
- `openai` — LLM integration (optional, has mock fallback)

---

## STEP 2: Start the Backend

```bash
cd papers
python backend/main.py
```

**Expected output:**
```
INFO:     Application startup complete
INFO:     Uvicorn running on http://0.0.0.0:8000
```

**Keep this terminal open.** The backend must be running for the extension to work.

---

## STEP 3: Load the Extension in Chrome

1. Open **chrome://extensions**
2. Toggle **"Developer mode"** (top-right corner)
3. Click **"Load unpacked"**
4. Navigate to: `RabbitHole-MVP/extension/`
5. Click **"Select Folder"**

**Expected result:**
- Extension appears in your list
- ?? icon appears in Chrome toolbar (top-right)
- No red errors

---

## STEP 4: Test on Wikipedia (Recommended)

1. Visit: **https://en.wikipedia.org/wiki/Artificial_intelligence**
2. Scroll to bottom-right of page
3. You should see: **?? Analyze Paper** button
4. Click it ? Panel slides open on the right
5. Click **"Analyze"** again (or just the button)
6. Panel shows: **? Analyzing... please wait**
7. **Within 5 seconds**, you'll see:
   - Level badge (e.g., "Level 7/10" in orange)
   - Summary (2 sentences about AI)
   - 3 Key Concepts (e.g., Machine Learning, Neural Networks, etc.)
   - Learning path: prerequisite, easier paper, deeper topic

---

## STEP 5: Open DevTools to See Debug Logs

1. **Press F12** (or right-click ? Inspect)
2. Go to **Console** tab
3. Look for logs starting with `[RabbitHole Papers]`

**You should see:**
```
[RabbitHole Papers] Content script loaded
[RabbitHole Papers] Creating panel...
[RabbitHole Papers] Panel created and injected
[RabbitHole Papers] Analyze button clicked
[RabbitHole Papers] Extracting text... (Using article element | 8234 chars)
[RabbitHole Papers] Calling backend: http://127.0.0.1:8000/analyze
[RabbitHole Papers] Response received: {level: 6, level_reason: "...", ...}
[RabbitHole Papers] Rendering response...
```

---

## STEP 6: Try Other Websites

All of these should work:

| Site | URL | How Text is Extracted |
|------|-----|----------------------|
| Wikipedia | https://en.wikipedia.org/ | Article body |
| arXiv | https://arxiv.org/abs/2312.10997 | Abstract |
| Medium | https://medium.com/search?q=AI | Post content |
| Dev.to | https://dev.to/ | Article text |
| Google Scholar | https://scholar.google.com/ | Abstract |
| Any Blog | https://example.com/any-article | Page text |

---

## STEP 7: Pro Tips

### Tip 1: Analyze Just One Paragraph
1. Highlight text on any page
2. Click ?? button
3. **Only your selected text** will be analyzed (faster, more focused)

### Tip 2: Test Backend Connection
1. Click ?? extension icon in toolbar
2. Click **"Test Backend"** button
3. Should show green ? + JSON response in 2 seconds

### Tip 3: Speed It Up (Use Mock Mode)
By default, the backend uses **mock mode** (no API costs):
- Instant responses (~500ms)
- Difficulty based on text length
- Perfect for UI/frontend testing

---

## What You'll See: Typical Response

```
???????????????????????????????????????
? RabbitHole Papers            ?      ?
???????????????????????????????????????
? Level 6/10 (purple badge)           ?
? Advanced topic with mathematical... ?
?                                     ?
? Summary                             ?
? Artificial intelligence is the...   ?
? The field encompasses machine...    ?
?                                     ?
? Key Concepts                        ?
? [Machine Learning] [Algorithms]     ?
? [Neural Networks]                   ?
?                                     ?
? ?? Prerequisite                     ?
? Understanding of computer science   ?
?                                     ?
? ?? Start Here (Easier)              ?
? Introduction to Computing           ?
?                                     ?
? ?? Go Deeper                        ?
? Deep Learning and NLP               ?
???????????????????????????????????????
```

---

## Color Legend

**Difficulty Level Colors:**
```
1-2: ?? Green     (Easy - Beginner level)
3-4: ?? Blue      (Moderate - High school)
5-6: ?? Purple    (Hard - Undergrad)
7-8: ?? Red       (Very Hard - Grad school)
9-10: ?? Orange   (Expert - PhD level)
```

---

## If Something Goes Wrong

### Problem: "Cannot reach backend"
```
1. Check terminal: Is `python backend/main.py` still running?
2. Try: curl http://127.0.0.1:8000/health
3. If fails: Restart backend
```

### Problem: Button doesn't appear
```
1. Check chrome://extensions ? "RabbitHole Papers" enabled?
2. Try: Refresh page (Ctrl+R)
3. Try: Restart Chrome
4. Check: DevTools Console for errors
```

### Problem: Panel appears but "Analyzing..." never finishes
```
1. Check: Backend terminal for errors
2. Look: DevTools Console for error messages
3. Try: Backend test button (click extension icon)
4. If timeout: Backend may be overloaded
```

### Problem: "Backend returned invalid JSON"
```
1. Check backend logs (where you ran python backend/main.py)
2. Is OPENAI_API_KEY valid? Or set to "mock"?
3. Try: Restart backend
```

---

## What's Working

? **Backend:** FastAPI server with `/analyze` endpoint
? **Content Script:** Extracts text from any page
? **Extension Button:** Appears on all pages
? **Panel UI:** Beautiful, responsive, shows results
? **Error Handling:** Friendly error messages
? **Mock Mode:** Works without API key (instant)
? **Real OpenAI:** Ready when you add API key
? **Debug Logs:** All actions logged to console

---

## Next Steps

1. **Follow STEPS 1-7 above** ? Start here
2. **Test on Wikipedia** ? You'll see it working
3. **Open DevTools** ? Watch the logs
4. **Try different websites** ? See text extraction
5. **Add OpenAI API Key** (optional, later)
6. **Read PAPERS_SETUP.md** (for advanced options)

---

## File Locations

**Backend:**
```
papers/
??? backend/main.py          ? FastAPI server
??? backend/llm_service.py   ? LLM + mock
??? backend/prompts.py       ? Prompts
??? requirements.txt         ? Dependencies
```

**Extension:**
```
extension/
??? manifest_papers.json     ? Extension config
??? content_papers.js        ? Page script
??? popup_papers.html        ? Popup UI
??? background.js            ? Service worker
??? PAPERS_EXTENSION_READY.md  ? This guide
```

---

## Success = You See This

1. ? ?? button on Wikipedia
2. ? Click it ? panel opens
3. ? Click again ? "? Analyzing..."
4. ? **Within 5 seconds** ? Level badge + summary + concepts
5. ? DevTools shows `[RabbitHole Papers]` logs
6. ? No red errors anywhere

**When you see all 6 of these, you're done! ??**

---

## Common Questions

**Q: Do I need an OpenAI API key?**
A: No! Mock mode is on by default. Add key later if you want real AI.

**Q: How much does it cost to test?**
A: $0 in mock mode (default). Real OpenAI is ~$0.01 per analysis.

**Q: Does it work on all websites?**
A: Yes! It extracts visible text from any page.

**Q: Can I customize the analysis?**
A: Yes! Edit `papers/backend/prompts.py` to change the prompt.

**Q: Will this affect the YouTube extension?**
A: No! The papers extension is completely separate.

---

**Ready? Go to Step 1 above! ??**
