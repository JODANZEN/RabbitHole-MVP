"""
RabbitHole — database layer (SQLAlchemy + Postgres/pgvector).

Reads DATABASE_URL from the environment (Supabase connection string).
Models are DB-agnostic SQLAlchemy, so swapping Postgres later is a config change.
"""

import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base, Session

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

# SQLAlchemy + psycopg2 understands the plain `postgresql://` scheme Supabase gives.
engine = (
    create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
    if DATABASE_URL
    else None
)

SessionLocal = (
    sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, class_=Session)
    if engine
    else None
)

Base = declarative_base()


def db_configured() -> bool:
    return engine is not None


def get_session() -> Session:
    if SessionLocal is None:
        raise RuntimeError(
            "DATABASE_URL is not set. Add your Supabase connection string to papers/.env"
        )
    return SessionLocal()


def init_db() -> None:
    """Enable pgvector and create tables. Safe to call repeatedly (idempotent)."""
    if engine is None:
        print("[RabbitHole] DATABASE_URL not set — skipping DB init (course features disabled)")
        return
    # Import models so they register on Base before create_all.
    from . import models  # noqa: F401

    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.create_all(engine)
    # Idempotent migrations for columns added to pre-existing tables.
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE courses ADD COLUMN IF NOT EXISTS owner_id varchar"))
        conn.execute(text("ALTER TABLE courses ADD COLUMN IF NOT EXISTS join_code varchar"))
    print("[RabbitHole] Database ready (pgvector enabled, tables created)")
