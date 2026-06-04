"""
RabbitHole — auth dependency.

We don't manage passwords ourselves. The web app logs in via Supabase Auth and
sends the user's access token. We validate it by asking Supabase who the token
belongs to (GET /auth/v1/user). Simple, and no JWT secret / RLS to misconfigure.
"""

import os
from typing import Optional

import httpx
from fastapi import Header, HTTPException

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "").strip()


def auth_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_ANON_KEY)


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """Resolve the Supabase user from the Bearer token, or raise 401."""
    if not auth_configured():
        raise HTTPException(503, "Auth not configured (set SUPABASE_URL and SUPABASE_ANON_KEY)")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{SUPABASE_URL}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY},
            )
    except Exception as e:
        raise HTTPException(502, f"Auth check failed: {e}")

    if resp.status_code != 200:
        raise HTTPException(401, "Invalid or expired session")
    return resp.json()  # { id, email, ... }


async def get_optional_user(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    """Like get_current_user but returns None instead of raising when there's no
    valid token. Used by endpoints the unauthenticated extension also calls."""
    if not authorization or not auth_configured():
        return None
    try:
        return await get_current_user(authorization)
    except HTTPException:
        return None
