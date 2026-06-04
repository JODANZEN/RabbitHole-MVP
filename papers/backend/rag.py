"""
RabbitHole — RAG pipeline.

Ingest: text → paragraph-aware chunks → Gemini embeddings → stored in Postgres (pgvector).
Ask:    question → embed → pgvector cosine-distance retrieval (per course) → grounded answer.

DB calls are synchronous SQLAlchemy run in a threadpool so the async event loop
(which handles the embedding/LLM HTTP calls) is never blocked.
"""

from typing import List, Dict, Any, Optional

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select, delete

from .database import get_session
from .models import Course, Reading, Chunk
from .embeddings import embed_texts, embed_text
from .llm_service import generate_answer, process_syllabus


# ── Chunking ─────────────────────────────────────────────────────────

def chunk_text(text: str, max_chars: int = 1200, overlap: int = 150) -> List[str]:
    """Split text into overlapping, paragraph-aware chunks for embedding."""
    text = (text or "").strip()
    if not text:
        return []

    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    chunks: List[str] = []
    current = ""

    for para in paragraphs:
        if len(current) + len(para) + 1 <= max_chars:
            current = f"{current}\n{para}" if current else para
        else:
            if current:
                chunks.append(current)
            # If a single paragraph is huge, hard-split it.
            if len(para) > max_chars:
                for i in range(0, len(para), max_chars - overlap):
                    chunks.append(para[i : i + max_chars])
                current = ""
            else:
                current = para
    if current:
        chunks.append(current)

    # Add a little overlap between consecutive chunks for context continuity.
    if overlap > 0 and len(chunks) > 1:
        overlapped = [chunks[0]]
        for prev, cur in zip(chunks, chunks[1:]):
            tail = prev[-overlap:]
            overlapped.append(f"{tail}\n{cur}")
        chunks = overlapped

    return chunks


# ── Sync DB helpers (run in threadpool) ──────────────────────────────

def _create_course_row(name: str, syllabus: str, processed: dict) -> str:
    session = get_session()
    try:
        course = Course(name=name, syllabus=syllabus, processed=processed)
        session.add(course)
        session.commit()
        return course.id
    finally:
        session.close()


def _store_chunks(course_id: str, reading_id: Optional[str], source: str,
                  title: str, contents: List[str], vectors: List[List[float]]) -> int:
    session = get_session()
    try:
        for content, vec in zip(contents, vectors):
            session.add(Chunk(
                course_id=course_id, reading_id=reading_id, source=source,
                title=title, content=content, embedding=vec,
            ))
        session.commit()
        return len(contents)
    finally:
        session.close()


def _create_reading_row(course_id: str, title: str) -> str:
    session = get_session()
    try:
        reading = Reading(course_id=course_id, title=title)
        session.add(reading)
        session.commit()
        return reading.id
    finally:
        session.close()


def _retrieve(course_id: str, qvec: List[float], k: int) -> List[Dict[str, Any]]:
    session = get_session()
    try:
        stmt = (
            select(Chunk)
            .where(Chunk.course_id == course_id)
            .order_by(Chunk.embedding.cosine_distance(qvec))
            .limit(k)
        )
        rows = session.execute(stmt).scalars().all()
        return [
            {"title": c.title or c.source, "source": c.source, "content": c.content}
            for c in rows
        ]
    finally:
        session.close()


def _get_course(course_id: str) -> Optional[Dict[str, Any]]:
    session = get_session()
    try:
        course = session.get(Course, course_id)
        if not course:
            return None
        out = course.to_dict()
        out["readings"] = [r.to_dict() for r in course.readings]
        return out
    finally:
        session.close()


def _list_courses() -> List[Dict[str, Any]]:
    session = get_session()
    try:
        rows = session.execute(select(Course).order_by(Course.created_at.desc())).scalars().all()
        return [c.to_dict() for c in rows]
    finally:
        session.close()


def _delete_course(course_id: str) -> bool:
    session = get_session()
    try:
        course = session.get(Course, course_id)
        if not course:
            return False
        session.delete(course)  # cascades to readings + chunks
        session.commit()
        return True
    finally:
        session.close()


# ── Async orchestrators ──────────────────────────────────────────────

async def create_course(name: str, syllabus: str) -> Dict[str, Any]:
    """Process a syllabus, store the course, and embed the syllabus for RAG."""
    processed = await process_syllabus(syllabus) if syllabus.strip() else {}
    final_name = name or processed.get("course_name") or "My Course"
    course_id = await run_in_threadpool(_create_course_row, final_name, syllabus, processed)

    if syllabus.strip():
        chunks = chunk_text(syllabus)
        if chunks:
            vectors = await embed_texts(chunks)
            await run_in_threadpool(
                _store_chunks, course_id, None, "syllabus", "Syllabus", chunks, vectors
            )
    return await run_in_threadpool(_get_course, course_id)


async def ingest_reading(course_id: str, title: str, text: str) -> Dict[str, Any]:
    """Chunk + embed a reading and attach it to the course."""
    reading_id = await run_in_threadpool(_create_reading_row, course_id, title)
    chunks = chunk_text(text)
    stored = 0
    if chunks:
        vectors = await embed_texts(chunks)
        stored = await run_in_threadpool(
            _store_chunks, course_id, reading_id, "reading", title, chunks, vectors
        )
    return {"reading_id": reading_id, "title": title, "chunks": stored}


async def answer_question(course_id: str, question: str, k: int = 6,
                          history: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
    """Retrieve the most relevant course chunks and answer grounded in them.

    `history` is the recent conversation [{role: 'user'|'tutor', text}], used so the
    tutor can resolve follow-ups like "explain that more" or "i meant the course".
    """
    course = await run_in_threadpool(_get_course, course_id)
    if not course:
        raise ValueError("Course not found")

    # Embed the question together with a little recent context so retrieval
    # follows the thread of the conversation, not just the latest words.
    recent_user = " ".join(
        m.get("text", "") for m in (history or [])[-4:] if m.get("role") == "user"
    )
    qvec = await embed_text((recent_user + " " + question).strip())
    hits = await run_in_threadpool(_retrieve, course_id, qvec, k)

    if hits:
        context = "\n\n".join(
            f"[{i + 1}] ({h['title']})\n{h['content']}" for i, h in enumerate(hits)
        )
    else:
        context = "(no course material has been added yet)"

    history_block = ""
    if history:
        lines = []
        for m in history[-6:]:
            who = "Student" if m.get("role") == "user" else "Tutor"
            txt = (m.get("text") or "").strip()
            if txt:
                lines.append(f"{who}: {txt}")
        if lines:
            history_block = "CONVERSATION SO FAR:\n" + "\n".join(lines) + "\n\n"

    prompt = f"""You are RabbitHole, a sharp, friendly tutor for the course "{course['name']}".

Use the conversation so far to understand follow-up questions (e.g. "the course", "that topic").
Ground your answer in the COURSE MATERIAL excerpts below when they are relevant.

Rules:
- Be direct and concise. Answer the question, then stop.
- Do NOT pad with encouragement, disclaimers, or "I'm here to help" filler.
- Only cite a source (e.g. a week or reading) if it ACTUALLY appears in the excerpts. Never invent week numbers or reading titles.
- If the material doesn't cover it, answer briefly from general knowledge without a long apology.

{history_block}COURSE MATERIAL:
{context}

STUDENT QUESTION: {question}

Answer:"""

    answer = await generate_answer(prompt)
    sources = []
    seen = set()
    for h in hits:
        if h["title"] not in seen:
            sources.append({"title": h["title"], "source": h["source"]})
            seen.add(h["title"])
    return {"answer": answer, "sources": sources}


# ── Thin sync wrappers exposed to the API for read/list/delete ───────

async def get_course(course_id: str) -> Optional[Dict[str, Any]]:
    return await run_in_threadpool(_get_course, course_id)


async def list_courses() -> List[Dict[str, Any]]:
    return await run_in_threadpool(_list_courses)


async def delete_course(course_id: str) -> bool:
    return await run_in_threadpool(_delete_course, course_id)
