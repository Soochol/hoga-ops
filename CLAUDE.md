# CLAUDE.md

Project-specific guidance for Claude Code working in this repo.

## Agent skills

### Issue tracker

Issues live in GitHub (`Soochol/hoga-ops`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map 1:1 to label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Browser automation

For any browser-driven check — opening a page, clicking, inspecting DOM/console/network,
screenshots, dogfooding a flow — use the `/browse` skill (gstack headless Chromium daemon
at `~/.claude/skills/gstack/browse/dist/browse`). Do **not** use the `playwright` MCP tools
(`mcp__plugin_playwright_playwright__*`) in this repo. Rationale: `/browse` keeps a single
persistent session (cookies, tabs, login state survive across calls), is ~100ms per command
after the initial ~3s spawn, and ships with project-scoped commands (`snapshot -i`, `text`,
`network`, `js`, `console --errors`) that the playwright tools don't have. Playwright's
per-call browser spawn also doubles run time on tight QA loops.

Quick reference:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live   # navigate
$B text                              # page text (untrusted-wrapped)
$B console --errors                  # JS errors only
$B network                           # all requests with timings
$B js "document.title"               # inline JS evaluation
$B snapshot -i                       # interactive elements with @e refs
```

See `~/.claude/skills/gstack/browse/SKILL.md` for the full command list.

### `/live` daily candle body issue

If daily (`D`) candles on `http://localhost:5173/live` appear as long wicks with almost no
body, do not assume the problem is only the saved viewport span. Debug it with `/browse`
and collect the actual chart numbers first:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B js "(() => { const c = window.__liveChart; const r = c?.timeScale().getVisibleLogicalRange(); return { href: location.href, dpr: devicePixelRatio, zoom: visualViewport?.scale, range: r, span: r && r.to - r.from, width: c?.timeScale().width(), timeScale: c?.options().timeScale, tabs: localStorage.getItem('live.tabs.v1'), page: localStorage.getItem('live.page.v1') }; })()"
$B screenshot /tmp/live-daily.png
```

Root cause confirmed in PR #141: `D` previously used `fitContent()` against a long daily
history, which could push lightweight-charts to the effective `minBarSpacing` floor and
collapse candle body width. The fix keeps daily candles on an adaptive visible logical
range instead of fitting the whole history. When changing this area, check candle body
legibility in pixels, not just logical span.

Useful sanity checks:

- A very large visible span (hundreds to 1000+) with a narrow chart usually means daily
  candles are being over-compressed.
- Compare `timeScale().width()`, visible logical span, `devicePixelRatio`, browser zoom,
  `localStorage` keys `live.tabs.v1` / `live.page.v1`, and the current active timeframe.
- Verify `D`, `W`, and `M` pane policy together; do not patch only `barSpan` without
  checking `barSpacing`, `minBarSpacing`, `rightOffset`, data count, and saved viewport
  restoration.
- Run `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx` and
  `cd frontend && npm run build` after changes.

If the in-app browser or `/browse` looks correct but the user's desktop Chrome still looks
wrong, suspect Chrome profile state before changing code. Refresh does not clear local
site state. Ask the user to clear site data for both `localhost:5173` and `127.0.0.1:5173`,
reset zoom with `Ctrl+0`, and retry in an incognito window. Console cleanup snippet:

```js
localStorage.clear();
sessionStorage.clear();
indexedDB.databases?.().then((dbs) => dbs.forEach((db) => indexedDB.deleteDatabase(db.name)));
caches?.keys?.().then((keys) => keys.forEach((key) => caches.delete(key)));
location.reload();
```

## Design System

Always read `DESIGN.md` at the repo root before making any visual or UI decisions in the frontend.
All font choices, colors, spacing, border radii, motion, and aesthetic direction are defined there.
Do not deviate without explicit user approval.

The approved visual reference is `docs/superpowers/designs/2026-05-20-replay-viewer.html` —
open it in a browser to see the design system rendered with realistic dummy data.

When reviewing frontend code, flag anything that doesn't match `DESIGN.md` (off-token colors,
hardcoded spacing values, non-system fonts, decorative elements not sanctioned by the system).

## Dev servers (hot reload)

Run both servers in the background so edits reload without manual restarts.

**Backend** — `hoga serve` hardcodes `reload=False`, so invoke uvicorn directly:

```bash
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

`--factory` is required (`default_app` returns the FastAPI instance). `--reload-dir hoga`
scopes the watcher to the backend package so editing `frontend/` or `docs/` doesn't bounce
the API. Verify with `curl -s http://127.0.0.1:8000/health` (expects `{"status":"ok"}`).

Both entry points (`hoga serve` and direct uvicorn) auto-load `.env` from the repo root —
`default_app()` calls `load_env()` so the discovery is a property of the app, not the CLI.
Set `KIS_APP_KEY` / `KIS_APP_SECRET` (and optionally `HOGAPLAY_COOKIE`) per `.env.example`.
Symbol search uses the static KIS `.mst` files — no credentials required.
거래일 조회는 KIS Open API를 사용하며, 자격증명이 없으면 `kis_holiday_fetch_failed`가
기록되고 평일 폴백으로 전환됩니다 (캡처 동작에 영향 없음).
`/live` 실시간 스트림(KIS WebSocket)은 `KIS_APP_KEY`/`KIS_APP_SECRET` 미설정 시 오프라인으로 시작하며
프론트엔드에 "KIS 자격증명이 설정되지 않았습니다" 배너를 표시합니다.

**Frontend** — Vite's HMR is on by default:

```bash
cd frontend && npm install   # first run in a new worktree only
npm run dev                   # serves http://localhost:5173
```

A fresh worktree starts with empty `node_modules`; if `vite: not found` appears, run
`npm install` once. Do not add `--host` unless you intentionally want LAN exposure.

**VS Code task runner** — `.vscode/tasks.json` exposes three labels: `Backend: dev (hot
reload)`, `Frontend: dev (HMR)`, and the compound `Dev: backend + frontend` (parallel).
Run via `Tasks: Run Task` (⇧⌘P) or the Task Runner side panel; each task gets a dedicated
terminal in the `dev` group, and the background `problemMatcher`s settle once uvicorn
prints `Application startup complete.` and Vite prints `ready in`.
