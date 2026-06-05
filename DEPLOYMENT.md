# RabbitHole — Deployment

Three pieces: **backend** (Render), **web app** (Vercel/Netlify), **extension** (Chrome Web Store).
The database (Supabase) is already hosted — nothing to do there.

## 1. Backend → Render
1. Push this repo to GitHub (done).
2. Render → **New → Blueprint** → connect the repo. It reads `render.yaml`.
3. After it provisions, open the service → **Environment** → set the secret vars
   (these mirror your local `papers/.env`):
   - `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY` (optional)
   - `DATABASE_URL` (your Supabase **Session Pooler** URI)
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`
   - (optional) `ALLOWED_ORIGINS=https://your-web-app.vercel.app`
4. Deploy. Your API is now at `https://rabbithole-api.onrender.com` (or similar).
   Test: open `…/health` → should return `{"status":"ok", ...}`.

> Free tier sleeps after inactivity; first request after idle takes ~30s to wake.

## 2. Web app → Vercel
1. Vercel → **New Project** → import the repo → **Root Directory: `web`**.
2. Build: `npm run build` · Output: `dist`.
3. Environment variables:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (from `web/.env`)
   - `VITE_BACKEND_URL=https://rabbithole-api.onrender.com`
4. Deploy → you get `https://rabbithole.vercel.app`.

## 3. Extension → Chrome Web Store
1. In `extension/.env` set `VITE_BACKEND_URL=https://rabbithole-api.onrender.com`, then `npm run build`.
2. Zip the **`extension/dist`** folder.
3. Chrome Web Store Developer Dashboard ($5 one-time) → **New item** → upload the zip → fill listing → submit for review.
   - For testers before review: share the zip; they Load unpacked from `dist/`.

## Order
Backend first → set `VITE_BACKEND_URL` in both web + extension to that URL → deploy them.
