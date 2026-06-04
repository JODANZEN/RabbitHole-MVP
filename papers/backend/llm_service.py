"""
RabbitHole — LLM analysis service.

Provider priority (first available key wins):
  1. GEMINI_API_KEY  → Google Gemini 2.0 Flash  (free tier, recommended)
  2. OPENAI_API_KEY  → OpenAI gpt-4o-mini        (paid, cheap)
  3. Neither         → deterministic mock         (no API calls)

Exports:
    analyze_paper(title, text) -> dict
    explain_text(text, context) -> dict
    find_related_papers(concepts, level) -> list
"""

import asyncio
import hashlib
import json
import os
import re
from typing import Any, Dict, List

from .prompts import get_analysis_prompt, get_synthesis_prompt, get_explain_prompt

# ── constants ────────────────────────────────────────────────────────
# Modern models (Gemini 2.0 Flash, Llama 3 on Groq) have 128k-1M token contexts.
# A 200k-char paper is only ~50k tokens — fits in one call, no chunking needed.
# Only fall back to chunking for truly massive texts (>600k chars ≈ 150k tokens).
SINGLE_PASS_CHAR_LIMIT = 600_000   # raise to pass full papers in one shot
CHUNK_CHAR_LIMIT       = 100_000   # if we do chunk, make each chunk large
MAX_RETRIES            = 2
RETRY_BACKOFF_S        = 1.5

OPENAI_MODEL = "gpt-4o-mini"
GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_BASE  = "https://generativelanguage.googleapis.com/v1beta/openai/"
GROQ_MODEL   = "llama-3.3-70b-versatile"
GROQ_BASE    = "https://api.groq.com/openai/v1"


# ── provider selection ────────────────────────────────────────────────

def _get_providers() -> List[tuple]:
    """Return a list of (api_key, base_url, model, name, max_input_chars).

    max_input_chars is how much of the paper text to send to that provider.
    Scientific papers tokenise at ~2.5 chars/token (lots of equations/symbols).
    Budget = (TPM_limit - prompt_overhead) × chars_per_token

    Priority order:
      1. GEMINI_API_KEY  → Gemini 2.0 Flash   (1M token ctx, ~2M chars)
      2. GROQ_API_KEY    → Llama 3.3-70b       (12k TPM free → ~25k chars safe)
      3. OPENAI_API_KEY  → gpt-4o-mini          (128k ctx → ~400k chars)
    Returns [] → mock mode.
    """
    candidates = []
    gemini = os.getenv("GEMINI_API_KEY", "").strip()
    groq   = os.getenv("GROQ_API_KEY",   "").strip()
    openai = os.getenv("OPENAI_API_KEY", "").strip()

    if gemini and gemini.lower() != "mock":
        candidates.append((gemini, GEMINI_BASE, GEMINI_MODEL, "Gemini", 2_000_000))
    if groq and groq.lower() != "mock":
        # Free tier: 12k TPM. Prompt template ≈ 1.5k tokens → 10k tokens left.
        # Scientific text ≈ 2.5 chars/token → ~25k chars max.
        candidates.append((groq, GROQ_BASE, GROQ_MODEL, "Groq", 25_000))
    if openai and openai.lower() != "mock":
        candidates.append((openai, None, OPENAI_MODEL, "OpenAI", 400_000))

    # RABBITHOLE_PROVIDER lets you pin a specific provider during development.
    # Example: add  RABBITHOLE_PROVIDER=groq  to papers/.env to always try Groq first.
    preferred = os.getenv("RABBITHOLE_PROVIDER", "").strip().lower()
    if preferred:
        pinned   = [p for p in candidates if p[3].lower() == preferred]
        rest     = [p for p in candidates if p[3].lower() != preferred]
        candidates = pinned + rest
        if pinned:
            print(f"[RabbitHole] Dev override: {pinned[0][3]} pinned first (RABBITHOLE_PROVIDER={preferred})")
        else:
            print(f"[RabbitHole] Dev override warning: RABBITHOLE_PROVIDER={preferred!r} — no matching key found")

    return candidates


# ── public entry points ───────────────────────────────────────────────

def _fit_text(text: str, max_chars: int) -> str:
    """Trim text to max_chars while keeping the intro and conclusion.

    Keeps the first 70% and last 30% of the budget, joined by an ellipsis marker.
    This preserves the abstract/intro (most concept-dense) and the conclusion.
    """
    if len(text) <= max_chars:
        return text
    head = int(max_chars * 0.70)
    tail = max_chars - head
    return text[:head] + "\n\n[...middle section trimmed to fit token budget...]\n\n" + text[-tail:]


async def analyze_paper(title: str, text: str) -> Dict[str, Any]:
    providers = _get_providers()
    if not providers:
        print("[RabbitHole] No API key — using deterministic mock")
        return _mock_analysis(title, text)

    for api_key, base_url, model, name, max_input_chars in providers:
        fitted = _fit_text(text, max_input_chars)
        if len(fitted) < len(text):
            print(f"[RabbitHole] {name}: text trimmed {len(text):,} → {len(fitted):,} chars to fit token budget")
        try:
            print(f"[RabbitHole] Trying provider: {name}")
            if len(fitted) > SINGLE_PASS_CHAR_LIMIT:
                return await _chunked_analysis(title, fitted, api_key, base_url, model)
            return await _single_pass(title, fitted, api_key, base_url, model)
        except QuotaExhaustedError:
            print(f"[RabbitHole] {name} quota exhausted — trying next provider")
            continue
        except Exception as exc:
            print(f"[RabbitHole] {name} failed ({type(exc).__name__}: {exc}) — trying next provider")
            continue

    print("[RabbitHole] All providers exhausted — mock fallback")
    result = _mock_analysis(title, text)
    result["summary"] = (
        "⚠️ All LLM providers are rate-limited or unavailable right now. "
        "Add a Groq key (console.groq.com, free) to papers/.env as GROQ_API_KEY for a 10× higher daily limit. "
        + result["summary"]
    )
    result["confidence"] = 0.3
    return result


async def explain_text(text: str, context: str = "") -> Dict[str, Any]:
    providers = _get_providers()
    if not providers:
        return _mock_explanation(text)
    prompt = get_explain_prompt(text, context)
    for api_key, base_url, model, name, _max in providers:
        try:
            raw  = await _call_llm(prompt, api_key, base_url, model)
            data = json.loads(raw)
            data.setdefault("explanation", "")
            data.setdefault("analogy", "")
            data.setdefault("terms", [])
            data.setdefault("why_matters", "")
            return data
        except QuotaExhaustedError:
            print(f"[RabbitHole] explain_text: {name} quota exhausted — trying next")
            continue
        except Exception as exc:
            print(f"[RabbitHole] explain_text failed ({name}: {type(exc).__name__}: {exc})")
            continue
    return _mock_explanation(text)


async def infer_research_area(concepts: List[str]) -> Dict[str, Any]:
    """Given the user's top session concepts, ask the LLM to name their research area.

    Returns { "area": str, "description": str }.  Falls back gracefully when no
    API key is configured or the quota is exhausted.
    """
    providers = _get_providers()
    if not providers:
        return _mock_research_area(concepts)

    concept_list = "\n".join(f"- {c}" for c in concepts)
    prompt = (
        "You are classifying a researcher's area of study based on the topics they have been reading.\n\n"
        f"Concepts encountered (weighted by recency and frequency):\n{concept_list}\n\n"
        "Respond with ONLY a raw JSON object — no markdown, no explanation:\n"
        '{"area":"<2-5 word field name, e.g. Quantum Machine Learning>","description":"<one sentence: what the researcher seems to be studying, mentioning 2-3 key themes>"}'
    )

    for api_key, base_url, model, name, _ in providers:
        try:
            raw  = await _call_llm(prompt, api_key, base_url, model)
            data = json.loads(raw)
            data.setdefault("area", " & ".join(concepts[:2]))
            data.setdefault("description", "")
            print(f"[RabbitHole] Research area inferred: {data['area']!r}")
            return data
        except QuotaExhaustedError:
            continue
        except Exception as exc:
            print(f"[RabbitHole] infer_research_area failed ({name}): {exc}")
            continue

    return _mock_research_area(concepts)


def _mock_research_area(concepts: List[str]) -> Dict[str, Any]:
    area = " & ".join(concepts[:2]) if len(concepts) >= 2 else (concepts[0] if concepts else "General Research")
    desc = f"Exploring topics including {', '.join(concepts[:4])}." if concepts else ""
    return {"area": area, "description": desc}


# ── Course features (syllabus parsing + free-form tutor answers) ──────

async def process_syllabus(syllabus_text: str) -> Dict[str, Any]:
    """Parse a syllabus into structured JSON (weeks, key concepts, outcomes)."""
    prompt = f"""You are parsing a university course syllabus. Extract the structure and return ONLY valid JSON — no markdown, no extra text.

SYLLABUS TEXT:
{syllabus_text[:40000]}

Return this exact schema:
{{
  "course_name": "<full course name and number>",
  "instructor": "<professor name or empty string>",
  "semester": "<e.g. Fall 2026 or empty string>",
  "weeks": [
    {{"week": <int>, "topic": "<topic>", "concepts": ["<concept>"], "readings": ["<reading>"]}}
  ],
  "key_concepts": ["<concept>"],
  "learning_outcomes": ["<outcome>"]
}}

RULES:
- weeks: extract every week present; if dates are used, number sequentially.
- key_concepts: 10-20 of the most important terms across the whole course.
- learning_outcomes: what students should be able to do by the end.
- Empty string / empty array where information is missing.
- Output ONLY the JSON object."""

    providers = _get_providers()
    if not providers:
        return {"course_name": "", "instructor": "", "semester": "",
                "weeks": [], "key_concepts": [], "learning_outcomes": []}
    for api_key, base_url, model, name, _ in providers:
        try:
            raw = await _call_llm(prompt, api_key, base_url, model)
            data = json.loads(raw)
            data.setdefault("weeks", [])
            data.setdefault("key_concepts", [])
            data.setdefault("learning_outcomes", [])
            return data
        except QuotaExhaustedError:
            continue
        except Exception as exc:
            print(f"[RabbitHole] process_syllabus failed ({name}): {exc}")
            continue
    return {"course_name": "", "instructor": "", "semester": "",
            "weeks": [], "key_concepts": [], "learning_outcomes": []}


async def generate_answer(prompt: str, temperature: float = 0.3) -> str:
    """Free-form (non-JSON) completion for the tutor. Uses the provider chain."""
    from openai import AsyncOpenAI
    providers = _get_providers()
    if not providers:
        return ("No LLM provider is configured. Add a GEMINI_API_KEY or GROQ_API_KEY "
                "to papers/.env to enable the tutor.")
    for api_key, base_url, model, name, _ in providers:
        try:
            kwargs = {"api_key": api_key}
            if base_url:
                kwargs["base_url"] = base_url
            client = AsyncOpenAI(**kwargs)
            resp = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=temperature,
            )
            return resp.choices[0].message.content.strip()
        except QuotaExhaustedError:
            print(f"[RabbitHole] generate_answer: {name} quota exhausted — trying next")
            continue
        except Exception as exc:
            print(f"[RabbitHole] generate_answer failed ({name}): {exc}")
            continue
    return "All LLM providers are currently rate-limited. Please try again shortly."


async def find_related_papers(concepts: List[str], current_level: int = 5,
                              session_concepts: List[str] = None) -> List[Dict[str, Any]]:
    if not concepts:
        return []

    # Build a richer query by blending current-page concepts with up to 2 session
    # concepts that aren't already represented — this steers Semantic Scholar toward
    # the user's broader research area, not just the single paper they're reading.
    query_pool = list(concepts)
    for sc in (session_concepts or []):
        if sc not in query_pool:
            query_pool.append(sc)

    # Keep top 2 for the actual query string (Semantic Scholar works best with short queries)
    short_concepts = [" ".join(c.split()[:3]) for c in query_pool[:2]]
    query = " ".join(short_concepts)
    print(f"[RabbitHole] Semantic Scholar query: '{query}'")
    try:
        import httpx
        fields = "title,abstract,year,externalIds,citationCount,openAccessPdf"
        url = (
            "https://api.semanticscholar.org/graph/v1/paper/search"
            f"?query={_url_encode(query)}&fields={fields}&limit=10"
        )
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url, headers={"User-Agent": "RabbitHole/0.3"})
            if resp.status_code == 429:
                print("[RabbitHole] Semantic Scholar rate-limited — skipping recommendations")
                return []
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        print(f"[RabbitHole] Semantic Scholar error: {e}")
        return []

    papers = []
    for paper in data.get("data", []):
        title    = paper.get("title") or "Untitled"
        abstract = paper.get("abstract") or ""
        year     = paper.get("year")
        citations = paper.get("citationCount", 0)
        ext      = paper.get("externalIds") or {}
        oa_pdf   = (paper.get("openAccessPdf") or {}).get("url", "")
        arxiv_id = ext.get("ArXiv", "")
        doi      = ext.get("DOI", "")
        paper_id = paper.get("paperId", "")

        if oa_pdf:        paper_url = oa_pdf
        elif arxiv_id:    paper_url = f"https://arxiv.org/abs/{arxiv_id}"
        elif doi:         paper_url = f"https://doi.org/{doi}"
        elif paper_id:    paper_url = f"https://www.semanticscholar.org/paper/{paper_id}"
        else:             paper_url = ""

        complexity = _estimate_complexity(abstract)
        papers.append({
            "title":      title,
            "year":       year,
            "complexity": complexity,
            "abstract":   abstract[:200] + ("…" if len(abstract) > 200 else ""),
            "url":        paper_url,
            "citations":  citations,
        })

    papers.sort(key=lambda p: (abs(p["complexity"] - current_level), -(p["citations"] or 0)))
    return papers[:6]


# ── single-pass + chunked analysis ──────────────────────────────────

async def _single_pass(title, text, api_key, base_url, model):
    prompt = get_analysis_prompt(title, text)
    raw    = await _call_llm(prompt, api_key, base_url, model)
    return _parse_and_validate(raw, source_text=text)


def _split_chunks(text: str) -> List[str]:
    paragraphs = re.split(r'\n{2,}', text)
    chunks, current = [], ""
    for para in paragraphs:
        if len(current) + len(para) + 2 > CHUNK_CHAR_LIMIT and current:
            chunks.append(current.strip()); current = para
        else:
            current = (current + "\n\n" + para) if current else para
    if current.strip(): chunks.append(current.strip())
    final = []
    for ch in chunks:
        if len(ch) > CHUNK_CHAR_LIMIT * 1.5:
            for i in range(0, len(ch), CHUNK_CHAR_LIMIT): final.append(ch[i:i+CHUNK_CHAR_LIMIT])
        else: final.append(ch)
    return final


async def _chunked_analysis(title, text, api_key, base_url, model):
    chunks = _split_chunks(text)
    total  = len(chunks)
    print(f"[RabbitHole] {total} chunks — sampling 3 (intro / body / conclusion)")

    # Pick at most 3 representative chunks: first, middle, last.
    # This keeps us well within Gemini's 15 req/min free tier.
    if total <= 3:
        sampled = chunks
    else:
        mid = total // 2
        sampled = [chunks[0], chunks[mid], chunks[-1]]

    # Process SEQUENTIALLY with a delay between calls to respect rate limits.
    # Gemini free tier: 15 req/min → 4 s between calls is safe.
    INTER_CHUNK_DELAY = 4.0  # seconds
    results = []
    for i, chunk in enumerate(sampled):
        if i > 0:
            await asyncio.sleep(INTER_CHUNK_DELAY)
        try:
            r = await _single_pass(title, chunk, api_key, base_url, model)
            results.append(r)
        except QuotaExhaustedError:
            # Daily quota gone — no point trying more chunks, let caller fall back
            raise
        except Exception as e:
            print(f"[RabbitHole] Chunk {i+1}/{len(sampled)} failed: {type(e).__name__}: {e}")

    if not results: return _mock_analysis(title, text)
    if len(results) == 1: return results[0]
    prompt = get_synthesis_prompt(title, results)
    raw = await _call_llm(prompt, api_key, base_url, model)
    return _parse_and_validate(raw, source_text=text)


# ── LLM call ────────────────────────────────────────────────────────

class QuotaExhaustedError(Exception):
    """Raised when the API daily quota is gone — retrying is pointless."""


def _is_quota_exhausted(exc: Exception) -> bool:
    """Distinguish daily-quota errors (don't retry) from per-minute throttles (may retry)."""
    try:
        body = getattr(exc, "body", None) or {}
        msg  = str(body.get("message", "") or "").lower()
        code = str(body.get("code",    "") or "").lower()
        status = str(getattr(exc, "status_code", "") or "")
        text = (msg + " " + code + " " + str(exc)).lower()
        # Gemini quota exhausted → RESOURCE_EXHAUSTED / "quota" / "daily limit"
        if any(k in text for k in ("resource_exhausted", "quota", "daily limit",
                                    "dailylimit", "exceeded your", "billing")):
            return True
    except Exception:
        pass
    return False


def _parse_retry_after(exc: Exception) -> float:
    """Extract retry delay (seconds) from a RateLimitError, or return a safe default."""
    try:
        headers = getattr(exc, "response", None) and exc.response.headers or {}
        if "retry-after" in headers:
            return float(headers["retry-after"])
        body = getattr(exc, "body", None) or {}
        msg  = str(body.get("message", "") or "")
        m = re.search(r'retryDelay["\s:]+(\d+)', msg)
        if m: return float(m.group(1))
    except Exception:
        pass
    return 15.0  # per-minute throttle — 15 s is usually enough


async def _call_llm(prompt: str, api_key: str, base_url: str | None, model: str) -> str:
    from openai import AsyncOpenAI, RateLimitError
    kwargs = {"api_key": api_key}
    if base_url: kwargs["base_url"] = base_url
    client = AsyncOpenAI(**kwargs)
    last_error = None
    rate_limit_hits = 0

    for attempt in range(1, MAX_RETRIES + 2):
        try:
            print(f"[RabbitHole] LLM attempt {attempt} (model={model})")
            resp = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )
            raw = resp.choices[0].message.content.strip()
            if raw.startswith("{"): return raw
            extracted = _extract_json_block(raw)
            if extracted: return extracted
            raise json.JSONDecodeError("not JSON", raw, 0)
        except RateLimitError as e:
            last_error = e
            if _is_quota_exhausted(e):
                print("[RabbitHole] Daily quota exhausted — bailing out immediately")
                raise QuotaExhaustedError("Gemini daily quota exhausted") from e
            rate_limit_hits += 1
            if rate_limit_hits >= 2:
                # Two back-to-back 429s → quota is gone, stop wasting time
                print("[RabbitHole] Two consecutive 429s — treating as quota exhausted")
                raise QuotaExhaustedError("Repeated 429 — quota likely exhausted") from e
            delay = _parse_retry_after(e)
            print(f"[RabbitHole] 429 rate-limited — waiting {delay:.0f}s before retry")
            await asyncio.sleep(delay)
            continue
        except json.JSONDecodeError as e:
            last_error = e
        except Exception as e:
            last_error = e
            print(f"[RabbitHole] LLM error: {type(e).__name__}: {e}")
        if attempt <= MAX_RETRIES:
            await asyncio.sleep(RETRY_BACKOFF_S * (2 ** (attempt - 1)))

    # Recovery pass — ask the model to wrap JSON in a code fence
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt +
                "\n\nWrap your JSON in ```json ... ``` this time."}],
            temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        return _extract_json_block(raw) or raw
    except Exception as e:
        print(f"[RabbitHole] Recovery failed: {e}")

    raise last_error or RuntimeError("LLM calls exhausted")


def _extract_json_block(text: str) -> str | None:
    m = re.search(r'```(?:json)?\s*\n?(\{.*?\})\s*\n?```', text, re.DOTALL)
    return m.group(1).strip() if m else None


# ── concept post-processing ──────────────────────────────────────────

REQUIRED_KEYS = {"level", "level_reason", "summary", "concepts",
                 "prerequisite", "easier", "deeper"}

# Words that mark an institution, venue, or organizational entity
INSTITUTION_WORDS = {
    'university', 'universities', 'institute', 'institution', 'department',
    'laboratory', 'lab', 'labs', 'college', 'school', 'faculty',
    'center', 'centre', 'foundation', 'clinic', 'hospital',
    'corporation', 'corp', 'inc', 'ltd', 'company',
    'journal', 'arxiv', 'preprint', 'proceedings', 'conference',
    'workshop', 'symposium', 'academy', 'society', 'press',
    'publisher', 'publishers', 'review', 'letters', 'communications',
    'annals', 'bulletin', 'transactions',
}

# Common first names used in academia to detect "Author Name" patterns
COMMON_FIRST_NAMES = {
    'john', 'james', 'robert', 'michael', 'william', 'david', 'richard',
    'joseph', 'thomas', 'charles', 'christopher', 'daniel', 'matthew',
    'anthony', 'mark', 'donald', 'steven', 'paul', 'andrew', 'joshua',
    'mary', 'patricia', 'jennifer', 'linda', 'barbara', 'elizabeth',
    'susan', 'jessica', 'sarah', 'karen', 'lisa', 'nancy', 'margaret',
    'wei', 'lei', 'yang', 'zhang', 'wang', 'liu', 'chen', 'li',
    'jun', 'yu', 'xiao', 'ming', 'jian', 'tao', 'bin', 'feng',
    'ali', 'omar', 'ahmed', 'hassan', 'ibrahim', 'mohammad',
    'jan', 'peter', 'hans', 'stefan', 'thomas', 'martin', 'christian',
}

# Street / address words that sometimes appear in paper headers (affiliation blocks)
ADDRESS_WORDS = {
    'avenue', 'ave', 'street', 'st', 'road', 'rd', 'boulevard', 'blvd',
    'drive', 'dr', 'lane', 'ln', 'court', 'ct', 'place', 'pl', 'way',
    'highway', 'hwy', 'parkway', 'pkwy', 'terrace', 'circle', 'cir',
    'north', 'south', 'east', 'west', 'suite', 'floor', 'building',
}

# Pattern: "Firstname Lastname" or "F. Lastname" or "Lastname, F."
_PERSON_RE = re.compile(
    r'^[A-Z][a-z]{1,14}\.?\s+[A-Z][a-z]{2,20}$'   # John Smith / J. Smith
    r'|^[A-Z][a-z]{2,20},\s+[A-Z]\.?$'             # Smith, J.
)

# UI / extension noise to suppress
CONCEPT_BLOCKLIST = {
    "enter rabbithole", "analyzing", "rabbit hole", "analyze",
    "session active", "click to explore", "end session", "rabbithole",
    "analyze paper", "core concept", "key topic", "in rabbithole",
    "test backend", "backend url", "debug info", "et al",
}


def _is_noise_concept(phrase: str) -> bool:
    """Return True if the phrase looks like a name, institution, venue, or UI noise."""
    p = phrase.strip()
    pl = p.lower()

    # Blocklist check
    if pl in CONCEPT_BLOCKLIST:
        return True
    if any(pl.startswith(b) for b in CONCEPT_BLOCKLIST):
        return True

    # Placeholder patterns like "Core Concept 1"
    if re.match(r'^(core concept|key topic)\s*\d*$', pl, re.I):
        return True

    words = p.split()

    # Institution word present anywhere in the phrase
    if any(w.lower().rstrip('s') in INSTITUTION_WORDS or w.lower() in INSTITUTION_WORDS
           for w in words):
        return True

    # Address / street word present → affiliation line fragment
    if any(w.lower() in ADDRESS_WORDS for w in words):
        return True

    # Person-name pattern
    if _PERSON_RE.match(p):
        return True
    # First word is a very common first name → likely a person reference
    if words and words[0].lower() in COMMON_FIRST_NAMES:
        return True

    # Purely numeric
    if p.replace(" ", "").replace(".", "").isdigit():
        return True

    # Very short
    if len(p) < 3:
        return True

    # All-caps short token (likely an abbreviation used as a label)
    if len(words) == 1 and p.isupper() and len(p) <= 4:
        return True

    return False


def _postprocess_concepts(concepts: List[str]) -> List[str]:
    cleaned = []
    for c in concepts:
        c = " ".join(c.split()).strip()
        if _is_noise_concept(c):
            continue
        cleaned.append(c.title())

    # Dedup: prefer longer, more specific phrases
    seen: List[str] = []
    deduped: List[str] = []
    for c in cleaned:
        norm = c.lower()
        if any(norm in k for k in seen):
            continue                   # already covered by a longer kept phrase
        # Remove shorter previously kept concepts that are substrings of this one
        kept_new, deduped_new = [], []
        for k, d in zip(seen, deduped):
            if k not in norm: kept_new.append(k); deduped_new.append(d)
        seen    = kept_new + [norm]
        deduped = deduped_new + [c]

    return deduped[:6]


def verify_and_filter_concepts(concepts: List[str], source_text: str) -> List[str]:
    text_lower = source_text.lower()
    verified, dropped = [], []
    for c in concepts:
        cl = c.lower()
        found = cl in text_lower or cl.rstrip('s') in text_lower or (cl + 's') in text_lower
        (verified if found else dropped).append(c)
    if dropped:
        print(f"[RabbitHole] Concepts not found in text: {dropped}")
    if not verified:
        print("[RabbitHole] All concepts dropped — using bigrams")
        verified = _extract_bigrams(source_text)[:4]
    return verified[:6]


def _extract_bigrams(text: str) -> List[str]:
    words = re.findall(r'[a-zA-Z]{3,}', text.lower())
    stop = {
        'the','and','for','are','but','not','you','all','can','had','her','was','one',
        'our','out','has','its','let','say','she','too','use','way','who','did','get',
        'him','his','how','may','new','now','old','see','two','any','few','got','own',
        'per','via','been','from','have','into','just','like','made','many','much',
        'must','next','only','over','some','such','take','than','that','them','then',
        'they','this','also','come','each','find','here','know','last','long','make',
        'more','most','need','part','same','show','side','tell','very','want','well',
        'will','with','about','after','being','could','first','found','given','going',
        'great','known','large','might','never','other','place','point','right','shall',
        'since','small','state','still','their','there','these','thing','think','those',
        'three','under','using','where','which','while','world','would','years','before',
        'called','through','between','another','because','during','without',
    }
    filtered = [w for w in words if w not in stop and len(w) > 3]
    from collections import Counter
    bigrams = Counter()
    for i in range(len(filtered) - 1):
        bigrams[filtered[i] + ' ' + filtered[i+1]] += 1
    return [bg.title() for bg, _ in bigrams.most_common(6)]


def _parse_and_validate(raw: str, source_text: str = "") -> Dict[str, Any]:
    data = json.loads(raw)
    missing = REQUIRED_KEYS - set(data.keys())
    if missing: raise ValueError(f"Missing keys: {missing}")

    data["level"]       = max(1, min(10, int(data["level"])))
    data["level_reason"] = str(data["level_reason"])
    data["summary"]     = str(data["summary"])
    data["prerequisite"] = _truncate_sentences(str(data["prerequisite"]), 2)
    data["easier"]      = _truncate_sentences(str(data["easier"]), 2)
    data["deeper"]      = _truncate_sentences(str(data["deeper"]), 2)

    if not isinstance(data["concepts"], list):
        data["concepts"] = [str(data["concepts"])]

    concepts = _postprocess_concepts([str(c) for c in data["concepts"]])
    if source_text:
        concepts = verify_and_filter_concepts(concepts, source_text)
    data["concepts"] = concepts

    conf = data.get("confidence")
    data["confidence"] = max(0.0, min(1.0, float(conf))) if conf is not None else 0.8

    print(f"[RabbitHole] Concepts: {data['concepts']}")
    return data


def _truncate_sentences(text: str, n: int) -> str:
    return " ".join(re.split(r'(?<=[.!?])\s+', text.strip())[:n])


# ── complexity estimator ─────────────────────────────────────────────

def _estimate_complexity(text: str) -> int:
    if not text or len(text) < 30: return 5
    words = text.split()
    long_words = sum(1 for w in words if len(w) > 10)
    has_math = bool(re.search(r'[=∑∫∂∇σμλ]|\\frac|theorem|proof|lemma', text, re.I))
    has_refs = bool(re.search(r'\[\d+\]|\(et al\.?\)', text))
    level = 4
    if long_words / max(len(words), 1) > 0.12: level += 2
    if has_math: level += 2
    if has_refs: level += 1
    return max(1, min(10, level))


def _url_encode(text: str) -> str:
    from urllib.parse import quote
    return quote(text)


# ── mock responses ───────────────────────────────────────────────────

def _mock_analysis(title: str, text: str) -> Dict[str, Any]:
    print("[RabbitHole] Generating mock analysis (no API key configured)")
    words = text.split()
    wc    = len(words)
    long_words = sum(1 for w in words if len(w) > 10)
    has_math = bool(re.search(r'[=∑∫∂∇σμλ]|\\frac|\\sum|equation|theorem|proof', text, re.I))
    has_refs = bool(re.search(r'\[\d+\]|\(et al\.?\)', text))
    jargon   = long_words / max(wc, 1)

    level = 3
    if jargon > 0.12:   level += 2
    if has_math:         level += 2
    if has_refs:         level += 1
    if wc > 5000:        level += 1
    level = max(1, min(10, level))

    # Extract multi-word capitalized phrases but skip ones that look like names/institutions
    multi_re = re.compile(r'\b([A-Z][a-z]{2,}(?:\s+[A-Za-z][a-z]{2,}){1,3})\b')
    raw_candidates = list(dict.fromkeys(multi_re.findall(text)))
    # Also grab hyphenated technical terms
    hyph_re = re.compile(r'\b([a-z]{3,}-[a-z]{3,}(?:-[a-z]{3,})?)\b')
    raw_candidates.extend(list(dict.fromkeys(hyph_re.findall(text))))

    # Filter noise immediately
    candidates = [c for c in raw_candidates if not _is_noise_concept(c)]

    if len(candidates) < 5:
        long_w = [w.strip(".,;:()[]\"'") for w in words
                  if len(w) > 8 and w[0].isalpha() and not _is_noise_concept(w)
                  and w.lower() not in {'therefore','otherwise','something','everything',
                                        'according','throughout','important','different',
                                        'following','including'}]
        candidates.extend(list(dict.fromkeys(long_w)))

    concepts = _postprocess_concepts(candidates) or ["General Overview"]

    h   = int(hashlib.md5(title.encode()).hexdigest(), 16)
    idx = h % 3

    reasons = []
    if has_math: reasons.append("mathematical notation present")
    if has_refs: reasons.append("academic citations detected")
    if jargon > 0.12: reasons.append(f"high jargon density ({jargon:.0%})")
    reasons.append(f"{wc} words")

    return {
        "level":        level,
        "level_reason": f"Level {level}/10 — " + ", ".join(reasons) + ".",
        "summary": [
            f"This text examines {title.lower()}, presenting core arguments and evidence.",
            f"An overview of {title.lower()}, covering main claims and their implications.",
            f"The article explores {title.lower()}, synthesising key findings in the field.",
        ][idx],
        "concepts":     concepts,
        "prerequisite": [
            "Familiarity with foundational terminology in this field.",
            "A basic understanding of the field's core principles.",
            "Introductory-level knowledge of the subject matter.",
        ][idx],
        "easier": [
            f"Search for 'Introduction to {concepts[0]}' for a gentler starting point.",
            f"Read a Wikipedia overview of {concepts[0]} before tackling this text.",
            f"Look for a beginner-friendly tutorial covering {concepts[0]}.",
        ][idx],
        "deeper": [
            f"Explore advanced treatments of {concepts[-1]} in review papers or textbooks.",
            f"Follow citations in the text to find deeper analyses of {concepts[-1]}.",
            f"Search for recent survey papers on {concepts[-1]} for cutting-edge perspectives.",
        ][idx],
        "confidence": round(0.35 + min(wc / 10_000, 0.3), 2),
    }


def _mock_explanation(text: str) -> Dict[str, Any]:
    return {
        "explanation": (
            "This is running in mock mode — no API key is configured. "
            "Add a free Gemini key (https://aistudio.google.com) to papers/.env "
            "to get real plain-language explanations."
        ),
        "analogy": "Think of it like a library card — once you have one (the API key), you get access to everything.",
        "terms": [],
        "why_matters": "Real explanations help you understand any concept instantly, in plain language.",
    }
