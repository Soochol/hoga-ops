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
$B js "(() => { const c = window.__liveChart; const r = c?.timeScale().getVisibleLogicalRange(); return { href: location.href, dpr: devicePixelRatio, zoom: visualViewport?.scale, range: r, span: r && r.to - r.from, width: c?.timeScale().width(), timeScale: c?.options().timeScale, page: localStorage.getItem('live.page.v1') }; })()"
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
  the `localStorage` key `live.page.v1`, and the current active timeframe.
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

## CI and local verification

`.github/workflows/ci.yml` gates every PR. Run the **same commands locally** — CI runs
nothing you can't reproduce:

```bash
cd frontend && npm run typecheck && npx vitest run && npx vite build
```

```bash
uv run --extra dev ruff check . && uv run --extra dev pytest -q -m 'not wallclock'
```

Notes:

- `npm run typecheck` covers **three** TypeScript projects: `tsc -b` (app + vite config),
  `tsconfig.test.json` (`tests/unit`, `tests/component`), and `tsconfig.e2e.json`
  (Playwright specs). They are separate because the environments have different globals —
  putting e2e's `types: ["node"]` on the app project changes `setTimeout`'s return type
  from `number` to `NodeJS.Timeout` and invents errors in `src/`. `npx tsc -b` alone does
  **not** check `frontend/tests/`.
- Run vitest from `frontend/`, never the repo root — the root resolves a different vitest
  that runs without jsdom and reports a full suite of false `document is not defined`
  failures.
- `@pytest.mark.wallclock` marks the backend tests that depend on elapsed time. They run
  locally by default; CI runs them in a separate non-blocking job because they measure
  scheduling jitter, not behavior. Before adding a new one, try to express the property
  deterministically (call counts) instead — that's what PR #516 did for the frontend.
- `ruff check` is gated as of 2026-07-30. It was 2,056 violations before: config tuning
  (`ruff.toml`) took it to 662, safe autofix to 314, and real fixes (E402 import blockers,
  B905 explicit `strict=`) plus reasoned `noqa` sealing to 0. **Nothing was disabled in
  `hoga/`** — the relaxations are in `tests/` and thresholds, and each carries a comment
  explaining why. `ruff format` is NOT gated (it would reformat 345 files).
- `RUF100` (dead `# noqa`) and `BLE` (blind `except`) joined `select` right after. Two
  things follow from that pair, and both bite if you don't know them:
  - **`lint.external` in `ruff.toml` is load-bearing — do not delete it.** It lists codes
    (`S102`, `S310`, `T201`, `ARG001`, `ANN001`) whose families are outside `select`.
    Without it RUF100 calls their `noqa` dead and **autofix erases the whole comment,
    reason text included**. Add to that list whenever you write a `noqa` for an unselected
    rule; do not silence RUF100 itself.
  - `BLE001` does **not** fire when the handler re-raises or logs with
    `logging.exception()` / `exc_info=True`. So a `# noqa: BLE001` on a well-handled
    `except Exception` is dead weight, and RUF100 will say so. Fix the handler, don't
    annotate it.
- Playwright e2e는 **2026-07-30부터 게이트**다(`17 passed / 2 skipped`). 로컬에서도
  돈다 — `playwright.config.ts`가 CI 밖에서는 시스템 Chrome(`channel: 'chrome'`)을 쓴다
  (Ubuntu 26.04는 Playwright가 번들 chromium 설치를 거부한다). 반복 실행 전에는 e2e
  전용 서버·데이터를 반드시 초기화한다 — 포트 8765·5174를 kill하고 **실제로 비워질
  때까지 기다린 뒤** `rm -rf /tmp/hoga-e2e-data`. 안 그러면 이전 실행의 캡처 큐 행이
  남아 개수 단언이 엉킨다. **사용자 개발 서버(5173·8000)는 절대 건드리지 말 것.**
  `workers: 1`은 필수다 — 캡처 큐·페이크 실패 카운터·디스크 픽스처가 백엔드 전역이라
  병렬이면 서로의 상태를 센다.

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

**dev 무자격 관례 (ADR-0134 · #989)**: dev/prod 서버 분리 후 실자격증명은 prod `.env`
에만 둔다. dev·워크트리는 키를 비워 두는 것이 기본이다 — 키가 비면 키움/KIS 경로가
자동 휴면하고, 검색·과거 데이터·프론트 개발·페이크 캡처는 전부 동작한다. 같은 키를
dev 에서 병행 사용하면 **머신이 달라도** 키움 WS 킥 전쟁·KIS 유량 합산 초과가 난다.
워크트리에 `.env` 가 없으면 메인 체크아웃 것을 상속한다(`hoga/env.py` 가 경고 로그를
1회 남긴다) — 상속을 원치 않으면 워크트리에 빈 `.env` 를 둔다.
Symbol search uses the static KIS `.mst` files — no credentials required.
거래일 조회는 KIS Open API를 사용합니다. 자격증명이 없으면 **범위 캡처 enqueue 는
평일 기준으로 담고 응답에 `warning: kis_credentials_missing` 을 실어 보냅니다**
(2026-07-31, UI 에 "평일 기준으로 담았습니다" 알림). 휴장일이 섞이면 그 날짜는 업스트림
빈 응답 → ADR-0021 센티넬로 끝납니다.

**일시 장애(`kis_holiday_fetch_failed`)는 폴백하지 않고 503 으로 실패**합니다 — 그때는
잠시 후 재시도가 옳은 안내이고, 추측한 날짜 목록으로 진행할 이유가 없습니다.
(이전 판은 "자격증명이 없으면 평일 폴백 · 캡처 동작에 영향 없음" 이라고 적었지만
실측하니 enqueue 가 503 으로 죽어 **캡처를 아예 걸 수 없었습니다** — 그래서 고쳤습니다.)
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
