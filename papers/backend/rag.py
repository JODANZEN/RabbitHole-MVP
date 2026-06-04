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

import random
import string
from datetime import datetime

from .database import get_session
from .models import Course, Reading, Chunk, Profile, QuestionLog, Enrollment, Quiz, QuizQuestion
from .embeddings import embed_texts, embed_text
from .llm_service import generate_answer, process_syllabus


def _gen_join_code(session) -> str:
    """A short, unambiguous, unique join code (no 0/O/1/I)."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(random.choices(alphabet, k=6))
        if not session.query(Course).filter(Course.join_code == code).first():
            return code


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

def _create_course_row(name: str, syllabus: str, processed: dict, owner_id: Optional[str]) -> str:
    session = get_session()
    try:
        course = Course(
            name=name, syllabus=syllabus, processed=processed,
            owner_id=owner_id, join_code=_gen_join_code(session),
        )
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


def _list_courses(owner_id: Optional[str] = None) -> List[Dict[str, Any]]:
    session = get_session()
    try:
        stmt = select(Course).order_by(Course.created_at.desc())
        if owner_id:
            stmt = stmt.where(Course.owner_id == owner_id)
        rows = session.execute(stmt).scalars().all()
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

async def create_course(name: str, syllabus: str, owner_id: Optional[str] = None) -> Dict[str, Any]:
    """Process a syllabus, store the course, and embed the syllabus for RAG."""
    processed = await process_syllabus(syllabus) if syllabus.strip() else {}
    final_name = name or processed.get("course_name") or "My Course"
    course_id = await run_in_threadpool(_create_course_row, final_name, syllabus, processed, owner_id)

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


async def list_courses(owner_id: Optional[str] = None) -> List[Dict[str, Any]]:
    return await run_in_threadpool(_list_courses, owner_id)


async def delete_course(course_id: str) -> bool:
    return await run_in_threadpool(_delete_course, course_id)


# ── Profiles (web app identity) ──────────────────────────────────────

def _get_or_create_profile(user_id: str, email: str) -> Dict[str, Any]:
    session = get_session()
    try:
        p = session.get(Profile, user_id)
        if not p:
            p = Profile(id=user_id, email=email, role="")
            session.add(p)
            session.commit()
        return p.to_dict()
    finally:
        session.close()


def _set_profile(user_id: str, role: Optional[str], name: Optional[str]) -> Dict[str, Any]:
    session = get_session()
    try:
        p = session.get(Profile, user_id)
        if not p:
            p = Profile(id=user_id, role="")
            session.add(p)
        if role is not None:
            p.role = role
        if name is not None:
            p.name = name
        session.commit()
        return p.to_dict()
    finally:
        session.close()


async def get_or_create_profile(user_id: str, email: str) -> Dict[str, Any]:
    return await run_in_threadpool(_get_or_create_profile, user_id, email)


async def update_profile(user_id: str, role=None, name=None) -> Dict[str, Any]:
    return await run_in_threadpool(_set_profile, user_id, role, name)


# ── Question logging + teacher insights ──────────────────────────────

def _log_question(course_id: str, question: str, user_id: Optional[str]) -> None:
    session = get_session()
    try:
        session.add(QuestionLog(course_id=course_id, question=question, user_id=user_id))
        session.commit()
    finally:
        session.close()


def _recent_questions(course_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    session = get_session()
    try:
        rows = (
            session.execute(
                select(QuestionLog)
                .where(QuestionLog.course_id == course_id)
                .order_by(QuestionLog.created_at.desc())
                .limit(limit)
            )
            .scalars()
            .all()
        )
        return [
            {"question": r.question, "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in rows
        ]
    finally:
        session.close()


async def log_question(course_id: str, question: str, user_id: Optional[str] = None) -> None:
    try:
        await run_in_threadpool(_log_question, course_id, question, user_id)
    except Exception as e:
        print(f"[RabbitHole] question log failed (ignored): {e}")


# ── Quizzes (topic-grounded generation) ──────────────────────────────

def _save_quiz(course_id, topic, week, created_by, questions) -> str:
    session = get_session()
    try:
        quiz = Quiz(course_id=course_id, topic=topic, week=week,
                    status="draft", created_by=created_by)
        session.add(quiz)
        session.flush()
        for i, q in enumerate(questions):
            session.add(QuizQuestion(
                quiz_id=quiz.id, prompt=q.get("prompt", ""),
                options=q.get("options", []), correct_index=q.get("correct_index", 0),
                explanation=q.get("explanation", ""), position=i,
            ))
        session.commit()
        return quiz.id
    finally:
        session.close()


def _get_quiz(quiz_id: str, include_answers: bool = True) -> Optional[Dict[str, Any]]:
    session = get_session()
    try:
        quiz = session.get(Quiz, quiz_id)
        return quiz.to_dict(include_answers) if quiz else None
    finally:
        session.close()


def _list_quizzes(course_id: str, include_drafts: bool) -> List[Dict[str, Any]]:
    session = get_session()
    try:
        stmt = select(Quiz).where(Quiz.course_id == course_id)
        if not include_drafts:
            stmt = stmt.where(Quiz.status == "published")
        stmt = stmt.order_by(Quiz.created_at.desc())
        quizzes = session.execute(stmt).scalars().all()
        return [
            {"id": q.id, "topic": q.topic, "week": q.week, "status": q.status,
             "question_count": len(q.questions),
             "created_at": q.created_at.isoformat() if q.created_at else None}
            for q in quizzes
        ]
    finally:
        session.close()


async def generate_quiz(course_id: str, topic: str, week=None,
                        n: int = 5, created_by: Optional[str] = None) -> Dict[str, Any]:
    """Generate a draft quiz of n MCQs grounded in the course's material for `topic`."""
    import json
    course = await run_in_threadpool(_get_course, course_id)
    if not course:
        raise ValueError("Course not found")

    qvec = await embed_text(topic)
    hits = await run_in_threadpool(_retrieve, course_id, qvec, 8)
    material = "\n\n".join(f"[{h['title']}] {h['content']}" for h in hits) or "(limited material)"

    prompt = f"""You are writing a quiz for the course "{course['name']}", on the topic "{topic}".
Base the questions ONLY on the COURSE MATERIAL below. Do not invent facts not supported by it.

COURSE MATERIAL:
{material[:12000]}

Write {n} multiple-choice questions that test understanding of "{topic}".
Return ONLY valid JSON (no markdown):
{{"questions":[
  {{"prompt":"<question>","options":["<a>","<b>","<c>","<d>"],"correct_index":<0-3>,"explanation":"<one sentence why>"}}
]}}
Rules: exactly 4 options each; exactly one correct; vary the correct position; keep prompts concise."""

    raw = await generate_answer(prompt, temperature=0.4)
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        questions = json.loads(raw).get("questions", [])
    except Exception as e:
        raise RuntimeError(f"Quiz generation returned invalid JSON: {e}")

    # sanitize
    clean = []
    for q in questions:
        opts = q.get("options", [])
        if isinstance(opts, list) and len(opts) == 4 and q.get("prompt"):
            ci = q.get("correct_index", 0)
            ci = ci if isinstance(ci, int) and 0 <= ci <= 3 else 0
            clean.append({"prompt": q["prompt"], "options": opts,
                          "correct_index": ci, "explanation": q.get("explanation", "")})
    if not clean:
        raise RuntimeError("No valid questions were generated. Try again or add more material.")

    quiz_id = await run_in_threadpool(_save_quiz, course_id, topic, week, created_by, clean)
    return await run_in_threadpool(_get_quiz, quiz_id, True)


def _update_quiz(quiz_id, questions, status, user_id) -> Dict[str, Any]:
    session = get_session()
    try:
        quiz = session.get(Quiz, quiz_id)
        if not quiz:
            raise ValueError("Quiz not found")
        course = session.get(Course, quiz.course_id)
        if course and course.owner_id and course.owner_id != user_id:
            raise PermissionError("Not your course")
        if questions is not None:
            for q in list(quiz.questions):
                session.delete(q)
            session.flush()
            for i, q in enumerate(questions):
                opts = q.get("options", [])
                if not q.get("prompt") or len(opts) != 4:
                    continue
                ci = q.get("correct_index", 0)
                ci = ci if isinstance(ci, int) and 0 <= ci <= 3 else 0
                session.add(QuizQuestion(
                    quiz_id=quiz.id, prompt=q["prompt"], options=opts,
                    correct_index=ci, explanation=q.get("explanation", ""), position=i))
        if status in ("draft", "published"):
            quiz.status = status
        session.commit()
        return quiz.to_dict(True)
    finally:
        session.close()


def _delete_quiz(quiz_id, user_id) -> bool:
    session = get_session()
    try:
        quiz = session.get(Quiz, quiz_id)
        if not quiz:
            return False
        course = session.get(Course, quiz.course_id)
        if course and course.owner_id and course.owner_id != user_id:
            raise PermissionError("Not your course")
        session.delete(quiz)
        session.commit()
        return True
    finally:
        session.close()


def _grade_attempt(quiz_id, student_id, answers) -> Dict[str, Any]:
    session = get_session()
    try:
        quiz = session.get(Quiz, quiz_id)
        if not quiz:
            raise ValueError("Quiz not found")
        qs = quiz.questions  # ordered by position
        total = len(qs)
        score = 0
        results = []
        for i, q in enumerate(qs):
            your = answers[i] if i < len(answers) else -1
            ok = your == q.correct_index
            if ok:
                score += 1
            results.append({
                "prompt": q.prompt, "options": q.options or [],
                "your_index": your, "correct_index": q.correct_index,
                "explanation": q.explanation, "correct": ok,
            })
        session.add(QuizAttempt(
            quiz_id=quiz.id, course_id=quiz.course_id, student_id=student_id,
            topic=quiz.topic, score=score, total=total, answers=answers))
        session.commit()
        return {"score": score, "total": total, "topic": quiz.topic, "results": results}
    finally:
        session.close()


async def grade_attempt(quiz_id, student_id, answers) -> Dict[str, Any]:
    return await run_in_threadpool(_grade_attempt, quiz_id, student_id, answers)


async def update_quiz(quiz_id, questions, status, user_id) -> Dict[str, Any]:
    return await run_in_threadpool(_update_quiz, quiz_id, questions, status, user_id)


async def delete_quiz(quiz_id, user_id) -> bool:
    return await run_in_threadpool(_delete_quiz, quiz_id, user_id)


async def list_quizzes(course_id: str, include_drafts: bool) -> List[Dict[str, Any]]:
    return await run_in_threadpool(_list_quizzes, course_id, include_drafts)


async def get_quiz(quiz_id: str, include_answers: bool = True) -> Optional[Dict[str, Any]]:
    return await run_in_threadpool(_get_quiz, quiz_id, include_answers)


# ── Enrollment (request → accept) ────────────────────────────────────

def _enroll(student_id: str, join_code: str) -> Dict[str, Any]:
    session = get_session()
    try:
        course = session.query(Course).filter(
            Course.join_code == join_code.strip().upper()
        ).first()
        if not course:
            raise ValueError("No class found with that join code.")
        existing = session.query(Enrollment).filter(
            Enrollment.course_id == course.id, Enrollment.student_id == student_id
        ).first()
        if existing:
            status = existing.status
        else:
            session.add(Enrollment(course_id=course.id, student_id=student_id, status="pending"))
            session.commit()
            status = "pending"
        return {"status": status, "course": {"id": course.id, "name": course.name}}
    finally:
        session.close()


def _my_enrollments(student_id: str) -> List[Dict[str, Any]]:
    session = get_session()
    try:
        rows = (
            session.query(Enrollment, Course)
            .join(Course, Course.id == Enrollment.course_id)
            .filter(Enrollment.student_id == student_id)
            .order_by(Enrollment.requested_at.desc())
            .all()
        )
        return [
            {"enrollment_id": e.id, "status": e.status,
             "course": {"id": c.id, "name": c.name, "reading_count": len(c.readings)}}
            for e, c in rows
        ]
    finally:
        session.close()


def _course_roster(course_id: str, owner_id: str) -> Dict[str, Any]:
    session = get_session()
    try:
        course = session.get(Course, course_id)
        if not course:
            raise ValueError("Course not found")
        if course.owner_id != owner_id:
            raise PermissionError("Not your course")
        rows = (
            session.query(Enrollment, Profile)
            .outerjoin(Profile, Profile.id == Enrollment.student_id)
            .filter(Enrollment.course_id == course_id)
            .order_by(Enrollment.requested_at.desc())
            .all()
        )
        members = []
        for e, p in rows:
            members.append({
                "enrollment_id": e.id,
                "status": e.status,
                "student": {
                    "id": e.student_id,
                    "name": (p.name if p else "") or (p.email if p else "") or "Unknown",
                    "email": p.email if p else "",
                },
                "requested_at": e.requested_at.isoformat() if e.requested_at else None,
            })
        return {
            "course": {"id": course.id, "name": course.name, "join_code": course.join_code},
            "pending": [m for m in members if m["status"] == "pending"],
            "active": [m for m in members if m["status"] == "active"],
        }
    finally:
        session.close()


def _decide_enrollment(enrollment_id: str, status: str, teacher_id: str) -> Dict[str, Any]:
    session = get_session()
    try:
        e = session.get(Enrollment, enrollment_id)
        if not e:
            raise ValueError("Enrollment not found")
        course = session.get(Course, e.course_id)
        if not course or course.owner_id != teacher_id:
            raise PermissionError("Not your course")
        e.status = status
        e.decided_at = datetime.utcnow()
        session.commit()
        return {"enrollment_id": e.id, "status": e.status}
    finally:
        session.close()


async def enroll(student_id: str, join_code: str) -> Dict[str, Any]:
    return await run_in_threadpool(_enroll, student_id, join_code)


async def my_enrollments(student_id: str) -> List[Dict[str, Any]]:
    return await run_in_threadpool(_my_enrollments, student_id)


async def course_roster(course_id: str, owner_id: str) -> Dict[str, Any]:
    return await run_in_threadpool(_course_roster, course_id, owner_id)


async def decide_enrollment(enrollment_id: str, status: str, teacher_id: str) -> Dict[str, Any]:
    return await run_in_threadpool(_decide_enrollment, enrollment_id, status, teacher_id)


MASTERY_THRESHOLD = 60   # below this % a student is "at risk" / a topic is weak


def _pct(sc: int, tot: int) -> int:
    return round(100 * sc / tot) if tot else 0


def _course_quiz_stats(course_id: str) -> Dict[str, Any]:
    from collections import defaultdict
    session = get_session()
    try:
        attempts = session.execute(
            select(QuizAttempt).where(QuizAttempt.course_id == course_id)
            .order_by(QuizAttempt.created_at)
        ).scalars().all()
        active = session.execute(
            select(Enrollment).where(Enrollment.course_id == course_id,
                                     Enrollment.status == "active")
        ).scalars().all()
        active_ids = {e.student_id for e in active}

        sids = {a.student_id for a in attempts}
        profs = {}
        if sids:
            profs = {p.id: p for p in session.execute(
                select(Profile).where(Profile.id.in_(sids))).scalars().all()}

        per_student = defaultdict(lambda: [0, 0])
        per_topic = defaultdict(lambda: [0, 0])
        per_day = defaultdict(lambda: [0, 0])
        for a in attempts:
            per_student[a.student_id][0] += a.score; per_student[a.student_id][1] += a.total
            per_topic[a.topic][0] += a.score; per_topic[a.topic][1] += a.total
            day = a.created_at.strftime("%b %d") if a.created_at else "—"
            per_day[day][0] += a.score; per_day[day][1] += a.total

        total_sc = sum(v[0] for v in per_student.values())
        total_tot = sum(v[1] for v in per_student.values())

        students = []
        for sid, (sc, tot) in per_student.items():
            p = profs.get(sid)
            pc = _pct(sc, tot)
            students.append({
                "name": (p.name or p.email) if p else "Student",
                "pct": pc, "at_risk": pc < MASTERY_THRESHOLD,
            })
        students.sort(key=lambda s: s["pct"])

        topic_mastery = sorted(
            [{"topic": t, "pct": _pct(sc, tot)} for t, (sc, tot) in per_topic.items()],
            key=lambda x: x["pct"],
        )
        over_time = [{"period": d, "pct": _pct(sc, tot)}
                     for d, (sc, tot) in per_day.items()]

        return {
            "comprehension": _pct(total_sc, total_tot),
            "student_count": len(active_ids),
            "attempted_count": len(per_student),
            "at_risk": sum(1 for s in students if s["at_risk"]),
            "attempt_count": len(attempts),
            "per_student": students,
            "topic_mastery": topic_mastery,
            "over_time": over_time,
        }
    finally:
        session.close()


def _student_progress(course_id: str, student_id: str) -> Dict[str, Any]:
    from collections import defaultdict
    session = get_session()
    try:
        course = session.get(Course, course_id)
        attempts = session.execute(
            select(QuizAttempt).where(QuizAttempt.course_id == course_id,
                                      QuizAttempt.student_id == student_id)
            .order_by(QuizAttempt.created_at)
        ).scalars().all()

        per_topic = defaultdict(lambda: [0, 0])
        per_day = defaultdict(lambda: [0, 0])
        tsc = ttot = 0
        for a in attempts:
            per_topic[a.topic][0] += a.score; per_topic[a.topic][1] += a.total
            day = a.created_at.strftime("%b %d") if a.created_at else "—"
            per_day[day][0] += a.score; per_day[day][1] += a.total
            tsc += a.score; ttot += a.total

        topic_mastery = sorted(
            [{"topic": t, "pct": _pct(sc, tot)} for t, (sc, tot) in per_topic.items()],
            key=lambda x: x["pct"],
        )
        over_time = [{"period": d, "pct": _pct(sc, tot)} for d, (sc, tot) in per_day.items()]
        weakest = topic_mastery[0] if topic_mastery else None

        return {
            "course": {"id": course_id, "name": course.name if course else ""},
            "comprehension": _pct(tsc, ttot),
            "attempt_count": len(attempts),
            "topic_mastery": topic_mastery,
            "over_time": over_time,
            "weakest_topic": weakest,
        }
    finally:
        session.close()


async def student_progress(course_id: str, student_id: str) -> Dict[str, Any]:
    return await run_in_threadpool(_student_progress, course_id, student_id)


async def course_insights(course_id: str) -> Dict[str, Any]:
    """Aggregate recent student questions into 'where the class is struggling' themes."""
    course = await run_in_threadpool(_get_course, course_id)
    if not course:
        raise ValueError("Course not found")
    questions = await run_in_threadpool(_recent_questions, course_id, 100)

    themes: List[Dict[str, Any]] = []
    if len(questions) >= 3:
        joined = "\n".join(f"- {q['question']}" for q in questions[:60])
        prompt = f"""You are analyzing the questions students asked an AI tutor for the course "{course['name']}".
Identify the 3-6 topics students seem to struggle with most, based on what they ask about.

STUDENT QUESTIONS:
{joined}

Return ONLY valid JSON — no markdown:
{{"themes":[{{"topic":"<short topic name>","why":"<one phrase on what they're confused about>","count":<approx number of related questions>}}]}}"""
        try:
            import json
            raw = await generate_answer(prompt, temperature=0.2)
            raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            themes = json.loads(raw).get("themes", [])
        except Exception as e:
            print(f"[RabbitHole] insights theme extraction failed: {e}")

    stats = await run_in_threadpool(_course_quiz_stats, course_id)
    return {
        "course": {"id": course["id"], "name": course["name"]},
        "question_count": len(questions),
        "recent": questions[:25],
        "themes": themes,
        **stats,
    }
