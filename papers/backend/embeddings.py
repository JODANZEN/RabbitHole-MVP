"""
RabbitHole — text embeddings via Gemini's native REST API.

Uses text-embedding-004 (768-dim, free tier). We hit the native
batchEmbedContents endpoint with httpx rather than the OpenAI-compat layer,
since the native endpoint's batching and dimensions are well-documented and stable.
"""

import os
from typing import List

import httpx

EMBED_MODEL = "text-embedding-004"
_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
# Gemini caps batchEmbedContents at 100 requests per call.
_BATCH_SIZE = 100


def _api_key() -> str:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key or key.lower() == "mock":
        raise RuntimeError(
            "GEMINI_API_KEY is required for embeddings. Add it to papers/.env"
        )
    return key


async def embed_texts(texts: List[str]) -> List[List[float]]:
    """Embed a list of texts, returning one 768-float vector per input (in order)."""
    if not texts:
        return []
    key = _api_key()
    url = f"{_BASE}/{EMBED_MODEL}:batchEmbedContents?key={key}"
    out: List[List[float]] = []

    async with httpx.AsyncClient(timeout=60.0) as client:
        for start in range(0, len(texts), _BATCH_SIZE):
            batch = texts[start : start + _BATCH_SIZE]
            payload = {
                "requests": [
                    {
                        "model": f"models/{EMBED_MODEL}",
                        "content": {"parts": [{"text": t}]},
                    }
                    for t in batch
                ]
            }
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("embeddings", []):
                out.append(item.get("values", []))

    if len(out) != len(texts):
        raise RuntimeError(
            f"Embedding count mismatch: got {len(out)} for {len(texts)} inputs"
        )
    return out


async def embed_text(text: str) -> List[float]:
    return (await embed_texts([text]))[0]
