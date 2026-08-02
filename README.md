# hoga-ops

Personal local-first tool to capture, store, and replay Korean stock orderbook + trade data from hogaplay.com and KIS.

See [`CONTEXT.md`](./CONTEXT.md) for the glossary, [`DESIGN.md`](./DESIGN.md) for frontend UI rules, [`CHANGELOG.md`](./CHANGELOG.md) for release history, [`docs/adr/`](./docs/adr/) for architecture decisions, and [`docs/superpowers/specs/`](./docs/superpowers/specs/) / [`docs/superpowers/plans/`](./docs/superpowers/plans/) for design specs and implementation plans.

## Access model — read this before exposing the server

**This API has no authentication.** That is a deliberate, recorded decision
([ADR-0036](./docs/adr/0036-local-deployment-no-resource-caps.md), revised by
[ADR-0134](./docs/adr/0134-tailscale-single-origin-prod.md)), not an oversight.
The security boundary is the **network**, in one of exactly two shapes:

- **Dev (default)**: loopback. `hoga serve` binds `127.0.0.1` unless told
  otherwise.
- **Prod (ADR-0134)**: a Tailscale tailnet. Bind the tailscale interface
  address only — `hoga serve --host <tailscale-ip>` — so the port is reachable
  by invited tailnet members and nobody else. Everyone (owner included) uses
  the single MagicDNS origin `http://<name>:8000`; all tailnet members are
  fully trusted (write access included).

**Never bind a public or LAN interface** (`0.0.0.0`, `192.168.*`). Anyone who
can reach the port can enqueue captures with your hogaplay cookie and KIS
quota, stop live collection mid-session (hogaplay retains only ~18h, so the
morning is then lost for good), and delete saved views and layout presets —
all without credentials.

Browser-initiated cross-origin state changes are blocked separately by
`hoga/api/origin_guard.py`, because CORS does **not** stop them: Starlette only
rejects on preflight, and several routes take no parameters at all, so a form
POST from any page reaches the handler with no preflight. That guard is not
authentication — it only stops *browsers*; `curl` and scripts pass through by
design. The allow-list is the four localhost dev origins plus whatever
`HOGA_ALLOWED_ORIGINS` (comma-separated) adds — a prod deployment lists its own
origin there. The guard deliberately does **not** infer same-origin from
`Sec-Fetch-Site` or an `Origin`==`Host` comparison: a DNS-rebinding page is a
*genuine* same-origin caller for the rebound host, so only an explicit origin
list tells the attacker's domain apart (ADR-0134).

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

**단일 워커 전제**: 이 앱은 프로세스 내 싱글턴(키움 WS 세션·일일 스케줄러·DuckDB)
구조다. uvicorn 으로 직접 띄우더라도 `--workers` 를 붙이지 말 것 — 워커마다 키움
WS 를 중복 접속해 서로를 킥하고, 일일 스케줄러가 N 중 실행된다.

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
감독자는 설계상 없으므로(ADR-0088) 조치는 프로세스 재시작이다 — 그 재시작을
자동화하는 것이 아래 워치독 타이머다(앱 밖의 감독이라 ADR-0088 과 충돌하지 않는다).

**워치독 타이머** — deep health 가 503 이면(조용히 죽은 태스크·큐 비소유 부팅)
5분 안에 재시작한다. `Restart=always` 가 못 덮는 "살아 있지만 아픈" 상태 전용:

```sh
cp deploy/hoga-ops-watchdog.{service,timer} ~/.config/systemd/user/
# hoga-ops-watchdog.service 의 WorkingDirectory·HOGA_HEALTH_URL 을 실제 값으로
# (prod 는 tailscale 주소 — 루프백으로는 안 닿는다) 고친 뒤:
systemctl --user daemon-reload && systemctl --user enable --now hoga-ops-watchdog.timer
```

deep health 는 `version`(VERSION 파일)·`queue.owned`·`disk.free_pct` 도 싣는다 —
dev/prod 2대를 curl 한 줄로 구분하고, read-only 부팅과 디스크 잠식을 같은
엔드포인트로 잡는다. 디스크는 관측 전용(503 아님 — 재시작이 디스크를 못 비운다).

**prune 게이트 확장(옵트인)** — 기본 일일 prune 은 COMPLETE 만 지운다. 확인된
업스트림 갭까지 자동 회수하려면 `.env` 에 `HOGA_PRUNE_CONFIRMED_GAPS=true`
(무인 prod 권장 — raw 는 하루 ~4GB 씩 자란다).

### 업그레이드 러닝북

```sh
git pull
uv sync --frozen                      # 네트워크가 필요한 단계를 재시작 전에 분리
cd frontend && npm ci && npx vite build && cd ..   # 프론트 서빙 시
systemctl --user restart hoga-ops
curl -s http://<주소>:8000/health | python3 -m json.tool   # version 이 새 값인지
```

롤백은 `git checkout <이전 커밋>` 후 같은 절차. 롤백으로 `.queue.json` 스키마가
구버전과 어긋나면 큐가 `.corrupt-*` 로 격리(=대기 큐 초기화)될 수 있다 — 재시작
후 인벤토리에서 대기 항목을 확인할 것.

### Prod: Tailscale 단일 origin 배포 (ADR-0134)

지인 몇 명이 외부에서 접속하는 prod 서버의 확정 형태는 **`http://<MagicDNS 이름>:8000`
하나** 다 — FastAPI 프로세스 하나가 API 와 프론트(dist)를 같이 서빙한다.

```sh
# 1) 프론트 빌드 (산출물: frontend/dist)
cd frontend && npm ci && npx vite build && cd ..

# 2) dist/config.json 을 same-origin 으로 교체 (원본 public/config.json 은 dev 용)
echo '{ "api_url": "" }' > frontend/dist/config.json
```

```sh
# .env: 배포 origin 허용 + 프론트 서빙 켜기
HOGA_ALLOWED_ORIGINS=http://<이름>:8000
HOGA_FRONTEND_DIST=/path/to/hoga-ops/frontend/dist
```

```sh
hoga serve --host <tailscale-ip> --port 8000
```

`HOGA_FRONTEND_DIST` 경로가 틀리면 기동 시점에 죽는다(오설정이 "빈 화면 404" 로
위장되지 않게 한 계약). SPA 딥링크(`/live` 직접 진입)는 index.html 로 폴백되고,
미등록 `/api` 경로와 스테일 자산 참조는 정직하게 404 다(`hoga/api/frontend_static.py`).

주소는 **바꾸지 않는 것이 원칙**이다 — 그리기·창 배치 등 화면 상태는 브라우저의
origin 단위 저장이라, 주소가 바뀌면 전원의 상태가 처음부터 다시 시작된다.

## Live index checks

`/live` representative index charts use `/api/live/index-candles` for `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `D`, `W`, and `M` candles. Index daily candles are fetched in 3-month windows and cached in memory; index minute candles cache exact repeated requests, while fetch depth is limited by the KIS source unit available for each timeframe.

With the backend running, measure index candle fetch behavior from the repo root:

```sh
node scripts/measure_index_daily_cold_fetch.mjs
HOGA_TIMEFRAMES=1m,3m,5m,10m,15m,30m node scripts/measure_index_minute_fetch_depth.mjs
```

Both scripts default to `http://127.0.0.1:8000`; override with `HOGA_API_BASE` when the API is on another port. Use `HOGA_FROM` / `HOGA_TO` to change the date range, `HOGA_STOCKS` / `HOGA_INDICES` for the daily comparison set, and `HOGA_INDEX` / `HOGA_TIMEFRAMES` for the minute-depth probe.
