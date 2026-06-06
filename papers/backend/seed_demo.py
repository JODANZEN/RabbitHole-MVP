"""
Seed a polished DEMO course into the live DB so the dashboards look full on camera.
Run from repo root:  .venv/Scripts/python.exe -m papers.backend.seed_demo
Idempotent: wipes and recreates the demo course + fake students each run.
"""

import asyncio
import uuid
from datetime import datetime, timedelta

from dotenv import load_dotenv
from pathlib import Path
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

from sqlalchemy import text
from .database import get_session, init_db
from .models import (
    Course, Reading, Chunk, Profile, Enrollment, QuestionLog,
    Quiz, QuizQuestion, QuizAttempt,
)
from .embeddings import embed_texts
from .rag import chunk_text

TEACHER_ID = "d8c35f79-dada-4f7b-8937-b69fea09c7e9"           # you (teacher)
REAL_STUDENT_ID = "c80de479-f7c1-443c-a0f7-f1bab2a5e841"      # your secondary (student)
COURSE_NAME = "PHYS 201 — Thermodynamics & Optics"
JOIN_CODE = "DEMO01"

SYLLABUS = """PHYS 201 — Thermodynamics & Optics. Instructor: Dr. A. Rivera. Semester: Spring 2026.
Week 1: Temperature, heat, and the zeroth law of thermodynamics.
Week 2: Kinetic theory of gases, ideal gas law, and the equipartition of energy.
Week 3: The first law of thermodynamics, work, and internal energy.
Week 4: Entropy and the second law of thermodynamics.
Week 5: Geometric optics — reflection, refraction, mirrors and lenses.
Week 6: Wave optics — interference, the double-slit experiment, and thin films.
Week 7: Diffraction — single slit, gratings, and resolution limits."""

READING = ("Selective permeability and energy transfer notes. "
    "In an ideal gas, particles are in constant random motion and collisions are perfectly elastic. "
    "Temperature is a measure of the average kinetic energy of the particles. "
    "The first law of thermodynamics states that the change in internal energy equals heat added minus work done by the system. "
    "Entropy quantifies disorder; the second law states that the entropy of an isolated system never decreases. "
    "In wave optics, two coherent sources produce an interference pattern of bright and dark fringes. "
    "Constructive interference occurs when the path difference is an integer multiple of the wavelength.")

PROCESSED = {
    "course_name": COURSE_NAME, "instructor": "Dr. A. Rivera", "semester": "Spring 2026",
    "weeks": [
        {"week": 1, "topic": "Temperature, heat, and the zeroth law", "concepts": ["temperature", "heat", "thermal equilibrium"]},
        {"week": 2, "topic": "Kinetic theory and the ideal gas law", "concepts": ["kinetic theory", "ideal gas", "equipartition"]},
        {"week": 3, "topic": "First law of thermodynamics", "concepts": ["internal energy", "work", "heat"]},
        {"week": 4, "topic": "Entropy and the second law", "concepts": ["entropy", "second law", "irreversibility"]},
        {"week": 5, "topic": "Geometric optics: mirrors and lenses", "concepts": ["reflection", "refraction", "lenses"]},
        {"week": 6, "topic": "Wave optics: interference", "concepts": ["interference", "double slit", "thin films"]},
        {"week": 7, "topic": "Diffraction and resolution", "concepts": ["diffraction", "gratings", "resolution"]},
    ],
    "key_concepts": ["kinetic theory", "ideal gas law", "entropy", "second law of thermodynamics",
        "internal energy", "interference", "diffraction", "refraction", "thermal equilibrium", "wavelength"],
    "learning_outcomes": ["Apply the laws of thermodynamics", "Analyze interference and diffraction patterns"],
}

QUIZZES = [
    {"topic": "Kinetic theory and the ideal gas law", "week": 2, "questions": [
        {"prompt": "In kinetic theory, temperature is a measure of what?", "options": ["The total mass of the gas", "The average kinetic energy of particles", "The color of the gas", "The container volume"], "correct_index": 1, "explanation": "Temperature reflects the average kinetic energy of the particles."},
        {"prompt": "Kinetic theory primarily models which kind of gas?", "options": ["Real gases", "Ideal gases", "Liquids", "Plasmas"], "correct_index": 1, "explanation": "It assumes ideal-gas behavior with elastic collisions."},
        {"prompt": "Collisions between ideal gas particles are assumed to be:", "options": ["Perfectly inelastic", "Perfectly elastic", "Always sticky", "Random in energy loss"], "correct_index": 1, "explanation": "Ideal collisions conserve kinetic energy (elastic)."},
        {"prompt": "The ideal gas law relates pressure, volume, and:", "options": ["Color", "Temperature", "Mass density only", "Viscosity"], "correct_index": 1, "explanation": "PV = nRT relates pressure, volume, and temperature."},
    ]},
    {"topic": "Wave optics: interference", "week": 6, "questions": [
        {"prompt": "In a double-slit experiment, bright fringes occur when the path difference is:", "options": ["A half-integer multiple of the wavelength", "An integer multiple of the wavelength", "Zero only", "Independent of wavelength"], "correct_index": 1, "explanation": "Constructive interference: path difference = mλ."},
        {"prompt": "Two sources that maintain a constant phase relationship are called:", "options": ["Incoherent", "Coherent", "Diffuse", "Polarized"], "correct_index": 1, "explanation": "Coherent sources produce stable interference patterns."},
        {"prompt": "Thin-film colors are caused by:", "options": ["Diffraction gratings", "Interference of reflected waves", "Total internal reflection", "Blackbody radiation"], "correct_index": 1, "explanation": "Reflections off the two surfaces interfere."},
        {"prompt": "Destructive interference produces:", "options": ["Bright fringes", "Dark fringes", "More energy", "A rainbow"], "correct_index": 1, "explanation": "Out-of-phase waves cancel → dark fringes."},
    ]},
]

STUDENTS = [
    ("Maria Gomez",  "maria@demo.rabbithole",  [4, 3]),   # strong
    ("Alex Chen",    "alex@demo.rabbithole",   [3, 1]),   # weak optics
    ("Sam Patel",    "sam@demo.rabbithole",    [2, 1]),   # at risk
    ("Priya Sharma", "priya@demo.rabbithole",  [4, 4]),   # top
    ("Liam O'Brien", "liam@demo.rabbithole",   [1, 2]),   # at risk
    ("Noah Kim",     "noah@demo.rabbithole",   [3, 2]),   # mid
]

QUESTIONS_ASKED = [
    "Can you explain entropy in simple terms?",
    "Why is the second law about disorder?",
    "I'm confused about the double slit experiment",
    "How does interference create dark fringes?",
    "What's the difference between heat and temperature?",
    "Explain the ideal gas law please",
    "Why are collisions elastic in kinetic theory?",
    "How do thin films make colors?",
    "What is internal energy exactly?",
    "Can you explain diffraction gratings?",
    "Why does entropy always increase?",
    "What makes two light sources coherent?",
]


def _uid():
    return str(uuid.uuid4())


async def main():
    init_db()
    s = get_session()

    # 1) wipe any prior demo course + fake students
    old = s.execute(text("SELECT id FROM courses WHERE name = :n"), {"n": COURSE_NAME}).fetchall()
    for (cid,) in old:
        s.execute(text("DELETE FROM courses WHERE id = :i"), {"i": cid})  # cascades
    s.execute(text("DELETE FROM profiles WHERE email LIKE '%@demo.rabbithole'"))
    s.commit()

    # 2) course owned by you
    course = Course(id=_uid(), name=COURSE_NAME, syllabus=SYLLABUS, processed=PROCESSED)
    s.add(course); s.flush()
    s.execute(text("UPDATE courses SET owner_id = :o, join_code = :j WHERE id = :i"),
              {"o": TEACHER_ID, "j": JOIN_CODE, "i": course.id})

    # 3) embed syllabus + a reading
    syl_chunks = chunk_text(SYLLABUS)
    reading = Reading(id=_uid(), course_id=course.id, title="Course notes: energy & waves")
    s.add(reading)
    read_chunks = chunk_text(READING)
    all_chunks = [("syllabus", "Syllabus", c) for c in syl_chunks] + \
                 [("reading", reading.title, c) for c in read_chunks]
    vectors = await embed_texts([c[2] for c in all_chunks])
    for (src, title, content), vec in zip(all_chunks, vectors):
        s.add(Chunk(id=_uid(), course_id=course.id,
                    reading_id=reading.id if src == "reading" else None,
                    source=src, title=title, content=content, embedding=vec))

    # 4) published quizzes
    quiz_objs = []
    for q in QUIZZES:
        quiz = Quiz(id=_uid(), course_id=course.id, topic=q["topic"], week=q["week"],
                    status="published", created_by=TEACHER_ID)
        s.add(quiz); s.flush()
        for i, qq in enumerate(q["questions"]):
            s.add(QuizQuestion(id=_uid(), quiz_id=quiz.id, prompt=qq["prompt"],
                               options=qq["options"], correct_index=qq["correct_index"],
                               explanation=qq["explanation"], position=i))
        quiz_objs.append(quiz)

    # 5) students (fake) + your real student, enrolled + attempts over several days
    def add_student(sid, name, email, scores):
        s.merge(Profile(id=sid, email=email, name=name, role="student"))
        s.merge(Enrollment(id=_uid(), course_id=course.id, student_id=sid,
                           status="active", decided_at=datetime.utcnow()))
        for qi, quiz in enumerate(quiz_objs):
            total = len(quiz.questions) if quiz.questions else 4
            sc = scores[qi]
            day = [4, 2][qi]  # quiz1 earlier, quiz2 more recent → a visible trend
            s.add(QuizAttempt(id=_uid(), quiz_id=quiz.id, course_id=course.id,
                              student_id=sid, topic=quiz.topic, score=sc, total=total,
                              answers=[0] * total,
                              created_at=datetime.utcnow() - timedelta(days=day, hours=qi)))

    for name, email, scores in STUDENTS:
        add_student(_uid(), name, email, scores)

    # Real student: a flattering, IMPROVING profile for the demo (upward trend line).
    s.merge(Profile(id=REAL_STUDENT_ID, email="jdsn2101secundario@gmail.com",
                    name="You (student)", role="student"))
    s.merge(Enrollment(id=_uid(), course_id=course.id, student_id=REAL_STUDENT_ID,
                       status="active", decided_at=datetime.utcnow()))
    q_thermo, q_optics = quiz_objs[0], quiz_objs[1]
    # (quiz, score/4, days_ago) — climbs 50→75→75→75→100→100; optics stays the weaker topic
    real_attempts = [
        (q_optics, 2, 6), (q_optics, 3, 5), (q_thermo, 3, 4),
        (q_optics, 3, 3), (q_thermo, 4, 2), (q_thermo, 4, 1),
    ]
    for quiz, sc, days in real_attempts:
        total = len(quiz.questions) if quiz.questions else 4
        s.add(QuizAttempt(id=_uid(), quiz_id=quiz.id, course_id=course.id,
                          student_id=REAL_STUDENT_ID, topic=quiz.topic, score=sc, total=total,
                          answers=[0] * total,
                          created_at=datetime.utcnow() - timedelta(days=days)))

    # 6) tutor questions → recent + most-confused
    for i, q in enumerate(QUESTIONS_ASKED):
        s.add(QuestionLog(id=_uid(), course_id=course.id, user_id=None, question=q,
                          created_at=datetime.utcnow() - timedelta(days=i % 4, hours=i)))

    s.commit()
    s.close()
    print(f"[done] Seeded '{COURSE_NAME}' (join code {JOIN_CODE})")
    print(f"  owner=you, {len(STUDENTS)+1} students enrolled, {len(quiz_objs)} quizzes, "
          f"{(len(STUDENTS)+1)*len(quiz_objs)} attempts, {len(QUESTIONS_ASKED)} tutor questions")


if __name__ == "__main__":
    asyncio.run(main())
