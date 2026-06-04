"""
RabbitHole — SQLAlchemy models.

A Course owns Readings and Chunks. Chunks carry the embeddings used for RAG
retrieval (pgvector). Syllabus text is also chunked + embedded (source='syllabus')
so the tutor can ground answers in the syllabus itself.
"""

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, ForeignKey, JSON
from sqlalchemy.orm import relationship
from pgvector.sqlalchemy import Vector

from .database import Base

# Gemini text-embedding-004 returns 768-dimensional vectors.
EMBED_DIM = 768


def _uuid() -> str:
    return str(uuid.uuid4())


class Course(Base):
    __tablename__ = "courses"

    id = Column(String, primary_key=True, default=_uuid)
    name = Column(String, nullable=False)
    syllabus = Column(Text, default="")
    processed = Column(JSON, default=dict)  # weeks, key_concepts, learning_outcomes
    created_at = Column(DateTime, default=datetime.utcnow)

    readings = relationship(
        "Reading", back_populates="course", cascade="all, delete-orphan"
    )
    chunks = relationship(
        "Chunk", back_populates="course", cascade="all, delete-orphan"
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "syllabus": self.syllabus,
            "processed": self.processed or {},
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "reading_count": len(self.readings),
        }


class Reading(Base):
    __tablename__ = "readings"

    id = Column(String, primary_key=True, default=_uuid)
    course_id = Column(String, ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    title = Column(String, default="Untitled Reading")
    saved_at = Column(DateTime, default=datetime.utcnow)

    course = relationship("Course", back_populates="readings")
    chunks = relationship(
        "Chunk", back_populates="reading", cascade="all, delete-orphan"
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "course_id": self.course_id,
            "title": self.title,
            "saved_at": self.saved_at.isoformat() if self.saved_at else None,
            "chunk_count": len(self.chunks),
        }


class Chunk(Base):
    __tablename__ = "chunks"

    id = Column(String, primary_key=True, default=_uuid)
    course_id = Column(String, ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    reading_id = Column(
        String, ForeignKey("readings.id", ondelete="CASCADE"), nullable=True
    )
    source = Column(String, default="reading")  # 'syllabus' | 'reading'
    title = Column(String, default="")           # human label for citations
    content = Column(Text, nullable=False)
    embedding = Column(Vector(EMBED_DIM))

    course = relationship("Course", back_populates="chunks")
    reading = relationship("Reading", back_populates="chunks")
