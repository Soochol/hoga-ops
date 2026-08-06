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

## Local verification

**CI 는 2026-08-06 에 제거됐다** (`.github/workflows/ci.yml` 삭제 + main ruleset 의
required status checks 3개 해제). 이유는 품질 판단이 아니라 처리량이었다 — 병행 세션이
6개까지 늘면서 PR 당 4 job × 6 = 24 job 이 GitHub 호스티드 러너를 두고 경쟁했고,
처리량(시간당 ~11 job)이 요구량에 못 미쳐 큐가 줄지 않았다. 각 run 에서 마지막까지
남은 job(주로 `backend`)이 러너를 못 받은 채 `timeout-minutes` 에 걸려 취소되기를
반복했다 — 실측: 70분간 실제 실행된 13 job 중 `backend` 는 **0건**. 모든 세션의 PR 이
동시에 막혔다.

**따라서 머지 전 검증은 이제 전적으로 로컬 수동 실행이다.** 아무도 대신 돌려주지
않으므로 PR 을 열기 전에 아래를 직접 통과시킨다:

```bash
cd frontend && npm run typecheck && npx vitest run && npx vite build
```

```bash
uv run --extra dev ruff check . && uv run --extra dev pytest -q -m 'not wallclock'
```

**로컬 실행으로 대체되지 않는 것이 하나 있다.** CI 의 `pull_request` 트리거는 PR 브랜치가
아니라 **base 와 합친 머지 커밋**을 체크아웃했다. 그래서 "각자는 초록인데 합치면 깨지는"
교차 PR 충돌이 머지 **전에** 드러났다(#734 가 그 사고였다). 내 워크트리에서 돌리는
검증은 원리적으로 이걸 볼 수 없다. 병행 세션이 많을수록 위험이 커지므로, 같은 파일을
건드리는 PR 이 떠 있는지 확인하고 **머지 직전 `git fetch origin main` 후 재검증**한다.

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
  locally by default — 위 `-m 'not wallclock'` 명령은 이들을 뺀다. 스케줄링 지터를
  재는 것이라 간헐 실패가 정상이므로, 실패해도 머지를 막을 근거로 삼지 않는다(CI 가
  있던 시절에도 별도 non-blocking 잡이었다). Before adding a new one, try to express the
  property deterministically (call counts) instead — that's what PR #516 did for the frontend.
- `ruff check` 는 **0 violations 를 유지한다**(2026-07-30 정리 완료, 그전엔 2,056건).
  이제 이를 강제하는 자동 게이트가 없으므로 위 백엔드 명령을 직접 돌려서 지킨다.
  정리 경위: config tuning
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
- Playwright e2e는 **PR 전에 로컬에서 직접 돌린다**(2026-08-04 실측 `24 passed`, 46.9s).
  2026-07-30 부터 CI 게이트였으나 CI 제거와 함께 수동 절차가 됐다 — 프론트를 만졌으면
  건너뛰지 말 것. `playwright.config.ts`가 CI 밖에서는 시스템 Chrome
  (`channel: 'chrome'`)을 쓴다 (Ubuntu 26.04는 Playwright가 번들 chromium 설치를
  거부한다). 반복 실행 전에는 e2e 전용 서버·데이터를 반드시 초기화한다 — 포트
  8765·5174를 kill하고 **실제로 비워질 때까지 기다린 뒤** `rm -rf /tmp/hoga-e2e-data`.
  안 그러면 이전 실행의 캡처 큐 행이 남아 개수 단언이 엉킨다. **사용자 개발 서버
  (5173·8000)는 절대 건드리지 말 것.** `workers: 1`은 필수다 — 캡처 큐·페이크 실패
  카운터·디스크 픽스처가 백엔드 전역이라 병렬이면 서로의 상태를 센다.
- **e2e 백엔드는 무자격으로 돈다 — `webServer.env`의 빈 자격증명을 지우지 말 것**
  (#1088). `HOGA_DATA_DIR`은 **데이터만** 격리하고 `.env`는 격리하지 않는다. 워크트리엔
  `.env`가 없어 메인 체크아웃 것을 상속하므로, 그전까지 e2e 백엔드는 **사용자 dev
  서버와 같은 실앱키**로 토큰을 발급했다. 토큰 캐시는 data_dir 아래라 분리돼 있고 위
  초기화 절차가 `rm -rf`를 요구하니 **매 기동이 캐시 미스**다 — 그 발급이 새 토큰을
  찍으면 벤더가 이전 토큰을 죽인다. 결과: 병행 세션이 각자 워크트리에서 e2e를 돌리면
  사용자 dev 서버는 **아무것도 안 했는데** `/live` 과거 캔들만 조용히 멎는다
  (`8005:Token이 유효하지 않습니다`). 스펙이 타는 백엔드 경로는 `/api/test/*` ·
  `/api/watchlist*` · `/api/ws` 뿐이라 자격증명이 애초에 필요 없다. 빈 문자열이 먹는
  근거 두 가지: `_resolve_env_creds`가 `if not app_key or not app_secret` → None이고,
  `load_dotenv(override=False)`는 truthiness가 아니라 **존재 여부**로 판단해 빈 값이
  `.env`를 막는다. 새 벤더 자격증명을 추가하면 **이 목록에도 추가**한다.

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
the API. **`--workers` 는 절대 붙이지 말 것** — 프로세스 내 싱글턴(키움 WS 세션·
스케줄러·DuckDB) 구조라 워커마다 키움 WS 중복 접속(킥 전쟁)·스케줄러 N중 실행이
난다(#998, README 운영 절). Verify with `curl -s http://127.0.0.1:8000/health`
(expects `{"status":"ok","version":...}`).

Both entry points (`hoga serve` and direct uvicorn) auto-load `.env` from the repo root —
`default_app()` calls `load_env()` so the discovery is a property of the app, not the CLI.
Set `KIS_APP_KEY` / `KIS_APP_SECRET` (and optionally `HOGAPLAY_COOKIE`) per `.env.example`.

**dev 무자격 관례 (ADR-0134 · #989)**: dev/prod 서버 분리 후 실자격증명은 prod `.env`
에만 둔다. dev·워크트리는 키를 비워 두는 것이 기본이다 — 키가 비면 키움/KIS 경로가
자동 휴면하고, 검색·과거 데이터·프론트 개발·페이크 캡처는 전부 동작한다. 같은 키를
dev 에서 병행 사용하면 **머신이 달라도** 키움 WS 킥 전쟁·KIS 유량 합산 초과가 난다.
워크트리에 `.env` 가 없으면 메인 체크아웃 것을 상속한다(`hoga/env.py` 가 경고 로그를
1회 남긴다) — 상속을 원치 않으면 워크트리에 빈 `.env` 를 둔다.
피해는 유량에서 그치지 않는다: **같은 앱키로 토큰을 새로 발급하면 벤더가 이전 토큰을
죽인다**(#1088 실측). 죽은 토큰은 `expires_dt` 가 한참 남아 있어 만료 검사를 통과하므로,
피해자는 조용히 멎는다. 그래서 **자격증명을 쥐는 프로세스를 늘리지 않는 것**이 이 관례의
핵심이고, e2e 백엔드도 같은 이유로 무자격이다(위 CI 절).
**브로커 분담 (ADR-0136 · #1046)**: 실시간 WS·폴링 REST 는 **전부 키움**이다.
KIS 는 **파생(KOSPI200 옵션 심리 패널 · ADR-0135) 전용**으로 남았다 — 키움 REST
337개 TR 에 파생 TR 이 0건이라 옮길 수 없었다.

- **종목 검색**: 키움 `ka10099`. 커밋된 시드 스냅샷(`hoga/api/kiwoom_master_seed.json`)
  이 있어 **자격증명 없이도 검색이 산다**. 최신화만 런타임이 한다.
- **거래일 달력**: 커밋된 정적 시드(`hoga/api/trading_days_seed.txt`, 키움 `ka20006`
  역산). **조회 경로에 벤더가 없어 자격증명 없이도 정확하다.** 시드 범위 밖은
  `None`(모름)이고, 스케줄러가 오버레이를 하루씩 민다.
  - 범위 캡처는 커버리지 안은 정확한 거래일, **그 뒤 꼬리만 평일 근사** + 경고다
    (경계에서 자른다 — 전 구간 차단도 전 구간 근사도 아니다).
- **`/live` 실시간 스트림**: 키움 WS. `KIWOOM_APP_KEY`/`KIWOOM_APP_SECRET` 미설정 시
  오프라인으로 시작한다.
- **KIS 키**: 없으면 **옵션 심리 패널만** 빈다. 나머지는 전부 정상이다.

**Frontend** — Vite's HMR is on by default:

```bash
cd frontend && npm install   # first run in a new worktree only
npm run dev                   # serves http://localhost:5173
```

A fresh worktree starts with empty `node_modules`; if `vite: not found` appears, run
`npm install` once. Do not add `--host` unless you intentionally want LAN exposure.

**프론트 버전 필드는 `0.0.0` 고정** — 리포 버전의 유일 진실은 루트 `VERSION` 파일이다
(#1001 에서 `frontend/package.json` 의 버전 관리를 의도적으로 포기했다). 따라서
`frontend/package-lock.json` 의 `version` 2곳(최상위 · `packages[""]`)도 **`0.0.0` 이어야
한다**. 어긋나면 `npm install` 이 lockfile 을 package.json 쪽으로 조용히 되돌려서 모든
워크트리에 유령 `M frontend/package-lock.json` 이 뜨고, 그게 커밋되면 값이 다시 갈린다.
`npm ci` 는 이 불일치를 **경고도 에러도 내지 않는다** — 의존성 그래프만 검증하고 최상위
`version` 은 비교하지 않는다(실측). 즉 CI 가 잡아 주지 않으니 릴리스 버전을 프론트
package.json/lock 에 다시 스탬프하지 말 것.

**VS Code task runner** — `.vscode/tasks.json` exposes three labels: `Backend: dev (hot
reload)`, `Frontend: dev (HMR)`, and the compound `Dev: backend + frontend` (parallel).
Run via `Tasks: Run Task` (⇧⌘P) or the Task Runner side panel; each task gets a dedicated
terminal in the `dev` group, and the background `problemMatcher`s settle once uvicorn
prints `Application startup complete.` and Vite prints `ready in`.
