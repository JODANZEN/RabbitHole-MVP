# RabbitHole Web (dashboards)

React + Vite + TypeScript. Supabase Auth for login; all data via the FastAPI backend.

## Setup

```bash
cd web
npm install
cp .env.example .env   # then fill VITE_SUPABASE_ANON_KEY
```

`web/.env`:
- `VITE_SUPABASE_URL` — your Supabase project URL (already filled)
- `VITE_SUPABASE_ANON_KEY` — Supabase → Project Settings → API → anon/public key
- `VITE_BACKEND_URL` — defaults to `http://127.0.0.1:8000`

The same Supabase URL + anon key must also be in `papers/.env` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`)
so the backend can validate login tokens.

## Run

```bash
npm run dev      # http://localhost:5174
```

The backend must be running too (`uvicorn papers.backend.main:app` from the repo root).

## What's here
- **Login / sign up** (Supabase Auth, email + password)
- **Onboarding** — pick a role: student or teacher
- **Teacher dashboard** — your courses → per-course *insights*: LLM-clustered "where the class is struggling" themes + recent student questions (from the tutor's question log)
- **Student dashboard** — available courses + (coming) teacher feedback & resources

## Structure
```
web/src/
├── lib/supabase.ts     # Supabase client
├── lib/api.ts          # typed fetch to FastAPI (attaches the auth token)
├── auth/AuthContext.tsx# session + profile (role)
├── components/Header.tsx
└── pages/              # Login, Onboarding, Teacher/Student dashboards, CourseInsights
```
