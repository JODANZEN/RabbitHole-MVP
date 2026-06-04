"""
RabbitHole — text embeddings via Gemini's native REST API.

Uses gemini-embedding-001 (the current GA embedding model). That model exposes
:embedContent (one text per call), so we embed concurrently in bounded batches
rather than relying on a sync inline-batch endpoint.

We request 768-dim output (outputDimensionality) to match the pgvector column.
Cosine distance is scale-invariant, so truncated (un-normalized) dims are fine for ranking.
"""

import asyncio
import os
from typing import List

import httpx

EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768
_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
# How many embedContent calls to run concurrently (stays under free-tier RPM).
_CONCURRENCY = 16


def _api_key() -> str:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key or key.lower() == "mock":
        raise RuntimeError(
            "GEMINI_API_KEY is required for embeddings. Add it to papers/.env"
        )
    return key


async def _embed_one(client: httpx.AsyncClient, url: str, text: str) -> List[float]:
    payload = {
        "model": f"models/{EMBED_MODEL}",
        "content": {"parts": [{"text": text}]},
        "outputDimensionality": EMBED_DIM,
    }
    resp = await client.post(url, json=payload)
    resp.raise_for_status()
    return resp.json()["embedding"]["values"]


async def embed_texts(texts: List[str]) -> List[List[float]]:
    """Embed a list of texts, returning one 768-float vector per input (in order)."""
    if not texts:
        return []
    key = _api_key()
    url = f"{_BASE}/{EMBED_MODEL}:embedContent?key={key}"
    out: List[List[float]] = []

    async with httpx.AsyncClient(timeout=60.0) as client:
        for start in range(0, len(texts), _CONCURRENCY):
            batch = texts[start : start + _CONCURRENCY]
            vecs = await asyncio.gather(
                *(_embed_one(client, url, t) for t in batch)
            )
            out.extend(vecs)

    if len(out) != len(texts):
        raise RuntimeError(
            f"Embedding count mismatch: got {len(out)} for {len(texts)} inputs"
        )
    return out


async def embed_text(text: str) -> List[float]:
    return (await embed_texts([text]))[0]
