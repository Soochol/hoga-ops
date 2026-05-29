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
the API. Verify with `curl -s http://127.0.0.1:8000/api/events`.

Both entry points (`hoga serve` and direct uvicorn) auto-load `.env` from the repo root —
`default_app()` calls `load_env()` so the discovery is a property of the app, not the CLI.
Set `KRX_ID` / `KRX_PW` (and optionally `HOGAPLAY_COOKIE`) per `.env.example`. Symptom of
missing KRX creds: `POST /api/captures/items` with a date range returns
HTTP 503 `krx_credentials_missing`, while symbol endpoints keep responding from the disk
cache at `~/.local/share/hoga-ops/symbol-master.json` and mask the real cause.

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
