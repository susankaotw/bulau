---
name: bulau-local-docker-ui
description: Convert this repo from Vercel dev/serverless functions to a local Docker/Node(Express) service, keep /api/answer request logic intact, upgrade index.html to Stitch-style Tailwind UI, and place the Bulao logo in the header. Use when the user asks to run locally in Docker without Vercel, to restyle the query page, or to add the Bulao logo to the page.
disable-model-invocation: true
---

# Bulau Local Docker + Stitch UI

## Scope / Constraints (must follow)

- Only modify files in the repo (no external services required to run).
- Do **not** change anything under `api/` unless the user explicitly allows it.
- Do **not** change `api/answer.js` or `api/line-webhook.js` unless the user explicitly allows it.
- Keep Docker runnable via `docker compose up --build -d`.
- Keep the query page working: it must still `POST /api/answer` and render `reply` when present.

## Quick Start Checklist

- [ ] `docker compose ps` shows the service `Up` with port `3000:3000`
- [ ] `GET /` returns `200`
- [ ] `GET /api/health` returns JSON
- [ ] Query page submits to `/api/answer` and renders a non-empty `reply` result

## Workflow

### A) Run locally in Docker without Vercel

1. Ensure the app starts with Node, not `vercel dev`.
   - `package.json` should have:
     - `scripts.start` = `node server.js`
     - `scripts.dev` = `node --watch server.js` (optional)
   - `Dockerfile` `CMD` should run `npm start`
   - `docker-compose.yml` `command` should run `npm start`

2. Provide an Express server that mounts existing function handlers.
   - Create `server.js` that:
     - `GET /` serves `index.html`
     - `ALL /api/<name>` calls `require("./api/<name>")` handler
   - Use `express.json()` so `req.body` works for POST.

3. Verify Docker.
   - Run `docker compose up --build -d`
   - Check logs: `docker compose logs --tail 80`

### B) Upgrade `index.html` to Stitch/Tailwind style without breaking API logic

1. Keep these IDs in the DOM:
   - `email`, `emailErr`, `q`, `send`, `result`
2. Keep request logic:
   - `POST /api/answer`
   - body must include:
     - `email`
     - `question`
     - `mode: '查詢'`
3. Rendering rules:
   - If response has `reply` (string, non-empty): render it.
   - Else support legacy `{ items }` and `{ answer }`.
4. Recommended Stitch-style rendering:
   - Use Tailwind CDN + theme config (colors/fonts/radius).
   - Present results in a bento grid:
     - 教材重點
     - 判斷流程
     - 對客說法
     - AI 補充說明
     - 學員溝通提醒
5. If `reply` uses headings like `【教材重點】...`:
   - Parse sections by headings and map into cards.
   - Fallback: if parsing fails, put the whole `reply` into a single card (avoid “no results” UI).

### C) Put the Bulao logo in the header

Preferred (keeps `index.html` small, no base64 blob in HTML):

1. Add a dedicated route in `server.js`:
   - `GET /logo.png` returns PNG bytes.
2. Store the logo as a base64 file (e.g. `_logo.b64`) created via `certutil -encode`.
3. In `index.html` header, add:
   - `<img src="/logo.png" ... />`

## Notes

- Avoid adding external build steps; Tailwind via CDN is acceptable for a static `index.html`.
- When using PowerShell commands in this environment, avoid `&&`; run commands separately or use `;`.

