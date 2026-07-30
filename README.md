# hoga-ops

Personal local-first tool to capture, store, and replay Korean stock orderbook + trade data from hogaplay.com and KIS.

See [`CONTEXT.md`](./CONTEXT.md) for the glossary, [`DESIGN.md`](./DESIGN.md) for frontend UI rules, [`CHANGELOG.md`](./CHANGELOG.md) for release history, [`docs/adr/`](./docs/adr/) for architecture decisions, and [`docs/superpowers/specs/`](./docs/superpowers/specs/) / [`docs/superpowers/plans/`](./docs/superpowers/plans/) for design specs and implementation plans.

## Access model — read this before exposing the server

**This API has no authentication.** That is a deliberate, recorded decision
([ADR-0036](./docs/adr/0036-local-deployment-no-resource-caps.md): hoga-ops is a
**local single-user tool**), not an oversight. The security boundary is the
loopback bind: `hoga serve` hardcodes `host="127.0.0.1"` and deliberately exposes
no `--host` option.

**Do not bind it to a non-loopback address.** Anyone who can reach the port can
enqueue captures with your hogaplay cookie and KIS quota, stop live collection
mid-session (hogaplay retains only ~18h, so the morning is then lost for good),
and delete saved views and layout presets — all without credentials.

Browser-initiated cross-origin state changes are blocked separately by
`hoga/api/origin_guard.py`, because CORS does **not** stop them: Starlette only
rejects on preflight, and several routes take no parameters at all, so a form
POST from any page reaches the handler with no preflight. That guard is not
authentication — it only stops *browsers*; `curl` and scripts pass through by
design.

## Current status

The backend exposes capture/replay APIs plus `/live` KIS-backed endpoints. The Vite frontend is wired for replay, watchlists, screeners, heatmap, and live chart workflows, including the `/live` investor trend estimate sidebar card.

## Quickstart

```sh
pip install -e .[dev]
echo "k_=...; n_=..." > .cookie   # paste from your hogaplay session
cp .env.example .env              # add KIS keys for live market data
hoga collect --code 003490 --date 20260519
hoga parse   --code 003490 --date 20260519
hoga serve
```

For frontend development:

```sh
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
cd frontend
npm install
npm run dev
```

## 운영: 프로세스 감독과 헬스 체크

`hoga serve` 는 포그라운드 단일 프로세스다. 앱 내부 워치독(키움 WS 재연결, KIS 용량
워커 자가재생성)은 **프로세스 안에서만** 동작하므로 프로세스 자체의 사망은 외부
감독자만 덮을 수 있다. 장중에 죽으면 그날 실시간 수집이 그 시점에서 끝난다.

무인 운영 최소 구성 세 가지:

1. **감독자** — `deploy/hoga-ops.service` 를 `~/.config/systemd/user/` 에 복사하고
   `WorkingDirectory` 를 체크아웃 경로로 고친 뒤:

   ```sh
   systemctl --user daemon-reload && systemctl --user enable --now hoga-ops
   ```

2. **자동 시작 스위치** — `.env` 에 아래 둘을 켠다. 감독자가 프로세스를 되살려도
   이 값이 off 면 **수집은 재개되지 않는다**(UI 에서 직접 시작할 때까지 멈춤):

   ```sh
   HOGA_LIVE_STARTUP_ENABLED=true
   HOGA_STARTUP_CATCHUP_ENABLED=true
   ```

3. **헬스 체크** — 두 엔드포인트의 질문이 다르다:

   | 엔드포인트 | 질문 | 실패 조건 |
   | --- | --- | --- |
   | `GET /health` | 프로세스가 응답하나 (liveness) | 무응답 |
   | `GET /health?deep=1` | 배경 작업이 돌고 있나 (readiness) | 조용히 죽은 태스크가 있으면 503 |

   얕은 쪽은 배경 태스크가 전멸해도 200 이다 — 감독자가 그것만 물면 "살아 있지만
   아무 일도 안 하는" 프로세스를 방치한다. deep 은 `dead_tasks` 에 죽은 태스크
   이름을 실어 준다. 설정으로 끈 기능(`not_started`)은 실패로 세지 않으므로
   무한 재시작을 유발하지 않는다.

   ```sh
   curl -s http://127.0.0.1:8000/health?deep=1 | python -m json.tool
   ```

배경 작업이 죽으면 프론트엔드에도 토스트가 뜬다(어느 페이지에서든). 자동 재시작
감독자는 설계상 없으므로(ADR-0088) 조치는 프로세스 재시작이다.

## Live index checks

`/live` representative index charts use `/api/live/index-candles` for `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `D`, `W`, and `M` candles. Index daily candles are fetched in 3-month windows and cached in memory; index minute candles cache exact repeated requests, while fetch depth is limited by the KIS source unit available for each timeframe.

With the backend running, measure index candle fetch behavior from the repo root:

```sh
node scripts/measure_index_daily_cold_fetch.mjs
HOGA_TIMEFRAMES=1m,3m,5m,10m,15m,30m node scripts/measure_index_minute_fetch_depth.mjs
```

Both scripts default to `http://127.0.0.1:8000`; override with `HOGA_API_BASE` when the API is on another port. Use `HOGA_FROM` / `HOGA_TO` to change the date range, `HOGA_STOCKS` / `HOGA_INDICES` for the daily comparison set, and `HOGA_INDEX` / `HOGA_TIMEFRAMES` for the minute-depth probe.
