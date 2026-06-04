from pathlib import Path
from dotenv import load_dotenv

# Load papers/.env regardless of where uvicorn is launched from
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
import json
import os
from .llm_service import analyze_paper, explain_text, find_related_papers

# ─── Analysis cache ──────────────────────────────────────────────────
# Keyed by URL. Persists to disk so restarts don't re-cost API calls.
_CACHE_FILE = Path(__file__).parent.parent / "analysis_cache.json"
_analysis_cache: dict[str, dict] = {}

def _load_cache():
    if _CACHE_FILE.exists():
        try:
            with open(_CACHE_FILE) as f:
                _analysis_cache.update(json.load(f))
            print(f"[RabbitHole] Cache loaded: {len(_analysis_cache)} entries")
        except Exception as e:
            print(f"[RabbitHole] Cache load error (ignored): {e}")

def _save_cache():
    try:
        with open(_CACHE_FILE, "w") as f:
            json.dump(_analysis_cache, f, indent=2)
    except Exception as e:
        print(f"[RabbitHole] Cache save error (ignored): {e}")

_load_cache()

app = FastAPI(title="RabbitHole API", version="0.3.0")

# CORS middleware — allow the Chrome extension to call us
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── In-memory session store (dev only) ─────────────────────────────
# Structure: { session_id: { "created_at": str, "visits": [...] } }
sessions: dict[str, dict] = {}


# ─── Models ─────────────────────────────────────────────────────────

class PaperInput(BaseModel):
    title: str
    text: str
    url: Optional[str] = None
    cleaned: Optional[bool] = False
    method: Optional[str] = None


class AnalysisResponse(BaseModel):
    level: int
    level_reason: str
    summary: str
    concepts: list[str]
    prerequisite: str
    easier: str
    deeper: str
    confidence: Optional[float] = None


class ExplainInput(BaseModel):
    text: str
    context: Optional[str] = ""     # surrounding article text for better context


class ExplainResponse(BaseModel):
    explanation: str
    analogy: str
    terms: list[dict]               # [{"term": "...", "means": "..."}]
    why_matters: str


class RecommendInput(BaseModel):
    concepts: list[str]
    level: Optional[int] = 5       # current paper difficulty (1-10)
    title: Optional[str] = None
    session_concepts: Optional[List[str]] = None  # top weighted concepts from the session


class ResearchAreaInput(BaseModel):
    concepts: List[str]            # top weighted concepts from the session


class PdfUrlInput(BaseModel):
    url: str


class SessionStart(BaseModel):
    session_id: str


class VisitEvent(BaseModel):
    session_id: str
    url: str
    title: str
    timestamp: str
    event_type: str                 # "page_analyzed" | "concept_clicked"
    concept: Optional[str] = None


# ─── Analysis endpoint ───────────────────────────────────────────────

@app.post("/analyze", response_model=AnalysisResponse)
async def analyze(paper: PaperInput):
    """Analyze a scientific paper and return difficulty level and related recommendations."""
    print(f"[RabbitHole] /analyze — title='{paper.title}', "
          f"text_len={len(paper.text)}, cleaned={paper.cleaned}, url={paper.url}")

    # Check cache first — skip LLM call entirely for already-seen URLs
    cache_key = paper.url.strip().rstrip("/") if paper.url else None
    if cache_key and cache_key in _analysis_cache:
        print(f"[RabbitHole] Cache HIT — returning saved result for {cache_key}")
        return _analysis_cache[cache_key]

    try:
        result = await analyze_paper(paper.title, paper.text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Failed to parse LLM response")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Only cache real LLM results, not mock fallbacks (confidence < 0.4 = mock)
    if cache_key and result.get("confidence", 1.0) >= 0.4:
        _analysis_cache[cache_key] = result
        _save_cache()
        print(f"[RabbitHole] Cache STORED for {cache_key}")

    return result


# ─── Dumbify endpoint ────────────────────────────────────────────────

@app.post("/explain", response_model=ExplainResponse)
async def explain(body: ExplainInput):
    """Explain selected text in plain language (Dumbify feature)."""
    text = body.text.strip()
    if len(text) < 5:
        raise HTTPException(status_code=422, detail="Selected text is too short to explain")
    print(f"[RabbitHole] /explain — text_len={len(text)}")
    try:
        result = await explain_text(text, body.context or "")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Paper recommendations endpoint ─────────────────────────────────

@app.post("/recommend")
async def recommend(body: RecommendInput):
    """Find related papers from Semantic Scholar, ranked by complexity."""
    if not body.concepts:
        return {"papers": []}
    session_ctx = body.session_concepts or []
    print(f"[RabbitHole] /recommend — concepts={body.concepts[:3]}, level={body.level}, session_ctx={session_ctx[:3]}")
    try:
        papers = await find_related_papers(body.concepts, body.level or 5, session_ctx)
        return {"papers": papers}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Research area inference endpoint ──────────────────────────────

@app.post("/infer_research_area")
async def infer_research_area_endpoint(body: ResearchAreaInput):
    """Given top session concepts, infer the user's research area via LLM."""
    concepts = [c.strip() for c in body.concepts if c.strip()][:10]
    if len(concepts) < 2:
        raise HTTPException(status_code=422, detail="Need at least 2 concepts to infer a research area")
    print(f"[RabbitHole] /infer_research_area — concepts={concepts}")
    try:
        from .llm_service import infer_research_area
        result = await infer_research_area(concepts)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── PDF analysis endpoint ─────────────────────────────────────────

@app.post("/analyze_pdf_url")
async def analyze_pdf_url(body: PdfUrlInput):
    """Fetch a PDF from URL, extract text server-side, and analyze it."""
    import io
    url = body.url
    print(f"[RabbitHole] /analyze_pdf_url — url={url}")

    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail="httpx not installed")

    try:
        from pypdf import PdfReader
    except ImportError:
        raise HTTPException(status_code=500, detail="pypdf not installed — pip install pypdf")

    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch PDF: {e}")

    try:
        reader = PdfReader(io.BytesIO(resp.content))
        pages_text = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                pages_text.append(t.strip())
        text = "\n\n".join(pages_text)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse PDF: {e}")

    if len(text) < 50:
        raise HTTPException(status_code=422, detail="PDF contained too little extractable text")

    title = "PDF Document"
    if reader.metadata and reader.metadata.title:
        title = reader.metadata.title
    elif pages_text:
        for line in pages_text[0].split('\n'):
            if len(line.strip()) > 5:
                title = line.strip()[:200]
                break

    print(f"[RabbitHole] PDF extracted: title='{title}', text_len={len(text)}")

    try:
        result = await analyze_paper(title, text)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── DOCX analysis endpoint ────────────────────────────────────────

@app.post("/analyze_docx_url")
async def analyze_docx_url(body: PdfUrlInput):
    """Fetch a DOCX from URL, extract text server-side, and analyze it."""
    import io
    url = body.url
    print(f"[RabbitHole] /analyze_docx_url — url={url}")

    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail="httpx not installed")

    try:
        import docx as docx_lib
    except ImportError:
        raise HTTPException(status_code=500, detail="python-docx not installed — pip install python-docx")

    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch DOCX: {e}")

    try:
        doc = docx_lib.Document(io.BytesIO(resp.content))
        paragraphs = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
        text = "\n\n".join(paragraphs)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse DOCX: {e}")

    if len(text) < 50:
        raise HTTPException(status_code=422, detail="DOCX contained too little extractable text")

    title = "Word Document"
    try:
        cp = doc.core_properties
        if cp.title:
            title = cp.title
        elif paragraphs:
            title = paragraphs[0][:200]
    except Exception:
        if paragraphs:
            title = paragraphs[0][:200]

    print(f"[RabbitHole] DOCX extracted: title='{title}', text_len={len(text)}")

    try:
        result = await analyze_paper(title, text)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── EPUB analysis endpoint ─────────────────────────────────────────

@app.post("/analyze_epub_url")
async def analyze_epub_url(body: PdfUrlInput):
    """Fetch an EPUB from URL, extract text server-side, and analyze it."""
    import io
    from html.parser import HTMLParser
    url = body.url
    print(f"[RabbitHole] /analyze_epub_url — url={url}")

    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail="httpx not installed")

    try:
        import ebooklib
        from ebooklib import epub as epub_lib
    except ImportError:
        raise HTTPException(status_code=500, detail="ebooklib not installed — pip install ebooklib")

    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch EPUB: {e}")

    class _HtmlStripper(HTMLParser):
        """Minimal HTML → plain-text extractor."""
        def __init__(self):
            super().__init__()
            self.parts: list[str] = []

        def handle_data(self, data: str):
            stripped = data.strip()
            if stripped:
                self.parts.append(stripped)

        def get_text(self) -> str:
            return " ".join(self.parts)

    try:
        book = epub_lib.read_epub(io.BytesIO(resp.content))
        chunks: list[str] = []
        for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
            stripper = _HtmlStripper()
            stripper.feed(item.get_content().decode("utf-8", errors="replace"))
            chunk = stripper.get_text()
            if len(chunk) > 20:
                chunks.append(chunk)
        text = "\n\n".join(chunks)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse EPUB: {e}")

    if len(text) < 50:
        raise HTTPException(status_code=422, detail="EPUB contained too little extractable text")

    title = "EPUB Document"
    try:
        meta = book.get_metadata("DC", "title")
        if meta:
            title = meta[0][0]
    except Exception:
        pass

    print(f"[RabbitHole] EPUB extracted: title='{title}', text_len={len(text)}")

    try:
        result = await analyze_paper(title, text)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Session endpoints ──────────────────────────────────────────────

@app.post("/session/start")
async def session_start(body: SessionStart):
    sid = body.session_id
    if sid in sessions:
        return {"status": "exists", "session_id": sid}
    sessions[sid] = {
        "created_at": datetime.utcnow().isoformat(),
        "visits": [],
    }
    print(f"[RabbitHole] Session started: {sid}")
    return {"status": "created", "session_id": sid}


@app.post("/session/visit")
async def session_visit(visit: VisitEvent):
    sid = visit.session_id
    if sid not in sessions:
        sessions[sid] = {
            "created_at": datetime.utcnow().isoformat(),
            "visits": [],
        }
    sessions[sid]["visits"].append(visit.model_dump())
    print(f"[RabbitHole] Visit recorded ({visit.event_type}): {visit.title}")
    return {"status": "recorded", "visit_count": len(sessions[sid]["visits"])}


@app.get("/session/{session_id}")
async def session_get(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session_id": session_id, **sessions[session_id]}


# ─── Health ─────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.3.0"}


if __name__ == "__main__":
    import uvicorn
    host = os.getenv("BACKEND_HOST", "0.0.0.0")
    port = int(os.getenv("BACKEND_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)