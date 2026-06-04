# RabbitHole Extension (TypeScript + Vite)

The extension is now a TypeScript project bundled with [Vite](https://vitejs.dev/)
and [CRXJS](https://crxjs.dev/).

## Setup (once)

```bash
cd extension
npm install
```

Requires Node.js 18+ (we use the LTS).

## Build

```bash
npm run build        # type-check (tsc) + bundle → extension/dist/
npm run typecheck    # type-check only, no build
npm run dev          # Vite dev server with hot-reload (see below)
```

## Load in Chrome

1. Run `npm run build`
2. Go to `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select the **`extension/dist`** folder (NOT `extension/`)

After code changes: `npm run build`, then hit the reload ↻ on the extension card,
**and hard-refresh the web page** (`Ctrl+Shift+R`) so the new content script loads.

> `npm run dev` gives hot-reload during development — load `dist/` once while it runs
> and most changes apply without a manual rebuild.

## Project structure

```
extension/
├── src/
│   ├── manifest.ts          # MV3 manifest (typed, generates dist/manifest.json)
│   ├── background.ts        # service worker: icon click + Dumbify context menu
│   └── content/
│       ├── index.ts         # main content script (panel UI, analysis, dumbify)
│       └── db.ts            # IndexedDB wrapper (courses + readings), typed
├── dist/                    # build output — load THIS in Chrome (git-ignored)
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Settings (API keys)

Keys live in the in-panel ⚙️ settings (click the 🐇 toolbar icon to open the panel,
then the gear). Add a Gemini key (free) and/or a Groq key, and pick which is primary.

## Migration note

`src/content/index.ts` currently has `// @ts-nocheck` at the top — a deliberate,
temporary escape hatch from the JS→TS port. We remove it incrementally as the file
is split into typed modules. `db.ts`, `background.ts`, and `manifest.ts` are fully typed.
