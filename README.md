# hoga-ops

Personal local-first tool to capture, store, and replay Korean stock orderbook + trade data from hogaplay.com and 키움 (Kiwoom).

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
can reach the port can enqueue captures with your hogaplay cookie and broker
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

The backend exposes capture/replay APIs plus `/live` 키움-backed endpoints (KIS 는 파생 전용 — ADR-0136). The Vite frontend is wired for replay, watchlists, screeners, heatmap, and live chart workflows, including the `/live` investor trend estimate sidebar card.

## Quickstart

```sh
pip install -e .[dev]
echo "k_=...; n_=..." > .cookie   # paste from your hogaplay session
cp .env.example .env              # add 키움 keys for live market data
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

`hoga serve` 는 포그라운드 단일 프로세스다. 앱 내부 워치독(키움 WS 재연결, REST 용량
워커 자가재생성)은 **프로세스 안에서만** 동작하므로 프로세스 자체의 사망은 외부
감독자만 덮을 수 있다. 장중에 죽으면 그날 실시간 수집이 그 시점에서 끝난다.

**단일 워커 전제**: 이 앱은 프로세스 내 싱글턴(키움 WS 세션·일일 스케줄러·DuckDB)
구조다. uvicorn 으로 직접 띄우더라도 `--workers` 를 붙이지 말 것 — 워커마다 키움
WS 를 중복 접속해 서로를 킥하고, 일일 스케줄러가 N 중 실행된다.

무인 운영 최소 구성 세 가지:

1. **감독자** — 유닛과 **배포 좌표 파일**을 함께 깐다. 좌표(바인드 주소·포트)를
   따로 두는 이유는 서비스와 워치독이 같은 값을 봐야 하기 때문이다 — 두 곳에
   리터럴로 적으면 한쪽만 고쳐져 건강한 서버를 5분마다 재시작하게 된다:

   ```sh
   mkdir -p ~/.config/systemd/user ~/.config/hoga-ops
   cp deploy/hoga-ops.service ~/.config/systemd/user/
   cp deploy/hoga-ops.env.example ~/.config/hoga-ops/deploy.env
   # deploy.env 의 HOGA_BIND_HOST(prod 는 tailscale IP)와
   # 유닛의 WorkingDirectory 를 고친 뒤:
   systemctl --user daemon-reload && systemctl --user enable --now hoga-ops
   ```

   유닛은 그 주소가 인터페이스에 **올라올 때까지 기다렸다가**(최대 60초) 기동한다.
   재부팅 직후 tailscaled 보다 먼저 뜨면 바인드가 즉사하고, 5초 간격 5회 재시도가
   소진되면 유닛이 failed 로 고착해 `Restart=always` 조차 더는 돌지 않는다 —
   정전 다음 날 아침까지 서버가 죽어 있는 경로가 정확히 그것이었다.

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
   이름을 실어 준다. **실패로 세지 않는 두 부류**가 있고 둘 다 load-bearing 이다:
   설정으로 끈 기능(`not_started`)과 한 번 일하고 끝나는 one-shot 의 정상 완료
   (`completed` — 부팅 캐치업·심볼 갱신). 후자를 죽음으로 세던 판에서는 캐치업이
   끝나는 순간 deep 이 영구 503 이 되어 워치독이 건강한 서버를 5분마다 재시작했다.
   반대로 영구 루프가 정상 반환하면 그건 진짜 조용한 죽음이라 `dead` 다.

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
# WorkingDirectory 만 고치면 된다 — 주소는 위 deploy.env 를 서비스와 공유한다.
systemctl --user daemon-reload && systemctl --user enable --now hoga-ops-watchdog.timer
```

워치독은 **503(떴는데 아픔)에만 재시작한다.** 연결 자체가 안 되면(`000`) 재시작
하지 않고 시끄럽게 남긴다 — 프로세스 사망은 `Restart=always` 가 이미 붙고 있고,
주소 오설정이면 재시작은 아무것도 고치지 못한 채 장중 수집만 끊기 때문이다.
재시작할 때는 원인(deep health 응답 본문)을 journald 와 이력 파일에 남긴다:

```sh
tail ~/.local/state/hoga-ops/watchdog-restarts.log   # 시각 · 코드 · 원인 본문
```

이 이력이 없으면 "장중에 5분마다 재시작되는데 아무도 모르는" 상태가 성립한다 —
재시작 직후에는 새 프로세스라 curl 해도 건강해 보이고, 인메모리 상태는 사라진다.

deep health 는 `version`·`commit`·`queue.owned`·`disk.free_pct` 도 싣는다 —
dev/prod 2대를 curl 한 줄로 구분하고, read-only 부팅과 디스크 잠식을 같은
엔드포인트로 잡는다. 디스크는 관측 전용(503 아님 — 재시작이 디스크를 못 비운다).

**prune 게이트 확장(옵트인)** — 기본 일일 prune 은 COMPLETE 만 지운다. 확인된
업스트림 갭까지 자동 회수하려면 `.env` 에 `HOGA_PRUNE_CONFIRMED_GAPS=true`.

**무인 prod 는 두 옵트인을 다 켜야 한다.** raw 실측 성장은 **거래일당 ~33GB** 다
(2026-08-03, 4일 측정 — 이전에 적혀 있던 "하루 ~4GB" 는 8배 어긋난 값이었다).
그런데 회수 쪽 실측이 더 놀랍다 — 같은 날 `hoga prune` dry-run 기준:

| 게이트 | 회수량 |
| --- | --- |
| 기본(COMPLETE 만) | **0 dirs / 0.0 GiB** — COMPLETE 클래스가 비어 있어 무동작 |
| `HOGA_PRUNE_CONFIRMED_GAPS=true` | +227 dirs / 30.9 GiB |
| `HOGA_PRUNE_EXPIRED_UNCONFIRMED=true` (ADR-0135) | +1,235 dirs / **169.0 GiB** |

두 번째 옵트인은 **되돌릴 수 없다**(그 날짜의 raw 를 다시 파싱할 권리를 영구히
포기한다 — 확정 경로가 이미 닫힌 클래스라 승인했다). 켜기 전에 dry-run 으로
대상을 먼저 볼 것:

```sh
uv run hoga prune --include-confirmed-gaps --include-expired-unconfirmed
```

이것도 성장률 자체는 줄이지 못하는 **유예**다 — `deep=1` 의 `disk.free_pct` 를
계속 볼 것.

**파생 트리는 별개 축이고 기본으로 회수된다.** `kis-past-indicators/`(지표 디스크
캐시)와 `timing/`(수집 타이밍 텔레메트리)는 parquet 에서 재계산되거나 제품 동작에
쓰이지 않으므로, 잃는 것이 재계산 시간(500~1000ms)뿐이다. 그래서 raw 처럼 옵트인을
두지 않았다 — 옵트인은 "게이트는 있는데 아무도 안 켜서 쌓인다" 를 재현한다.
보존 창은 `HOGA_DERIVED_RETENTION_DAYS`(기본 180일).

코드가 더 이상 읽지 않는 트리(`kis-past-candles/`, `_trash_*`)는 `hoga prune` 이
**항상 보고**하되 삭제는 `--include-dead-trees`(+`--execute`) 옵트인이다 —
"안 쓴다" 는 판단이고, 판단으로 지우는 것은 명시적이어야 한다.

### 백업 — 무엇이 유일본인가

데이터는 OS 와 같은 디스크에 있다. 그 디스크가 죽으면 **다시 받을 수 없는 것**이
같이 죽는다: `parquet/`(15개월치 호가·체결·거래원 — hogaplay 업스트림 보유가
~18시간이라 재수집이 성립하지 않는다), 사용자들의 `study_views/`·`watchlist.json`·
`heatmap.json`·창 프리셋, `screener/`(원주가 아카이브).

```sh
mkdir -p ~/.config/systemd/user
cp deploy/hoga-ops-backup.{service,timer} ~/.config/systemd/user/
# deploy.env 에 HOGA_BACKUP_DEST 를 적고, 대상 안에 센티널을 한 번 만든 뒤:
touch "$HOGA_BACKUP_DEST/.hoga-backup-root"
systemctl --user daemon-reload && systemctl --user enable --now hoga-ops-backup.timer
```

매일 04:00(장·일일배치 둘 다에서 먼 시각)에 `rsync -a --delete` 로 민다. 대상은
**다른 물리 디스크**여야 의미가 있다. 백업량은 약 43GB — `raw/`(301GB)와 재생성
가능한 캐시(`kis-past-indicators/`·`timing/`·`cache/`)는 제외한다. raw 를 빼도
복구는 성립한다: parquet 이 진실 소스이고 raw 는 그 파생 입력이라, 잃는 것은
그 날짜를 재파싱할 권리뿐이다(ADR-0135 가 같은 판단으로 회수를 승인했다).

센티널 파일을 요구하는 이유: 외장 디스크가 안 붙었거나 경로에 오타가 나면 rsync
가 빈 디렉터리를 정상 대상으로 보고 `--delete` 로 **백업본을 지운다**. 백업이
있다고 믿는 순간 백업이 사라지는 사고를 그 한 파일이 막는다.

복구는 반대 방향 rsync 한 번이다 — 절차는 `deploy/hoga-ops-backup.sh` 주석에.

### main 브랜치 보호

룰셋 정의는 `deploy/github-ruleset-main.json` 에 있다. 적용:

```sh
gh api -X POST repos/Soochol/hoga-ops/rulesets --input deploy/github-ruleset-main.json
```

거는 것: PR 필수(승인 0명) · 강제푸시/삭제 차단. **자동 상태 체크는 걸지 않는다** —
2026-08-06 에 CI 를 제거하면서 `frontend`·`backend`·`e2e (playwright)` required check
3개를 해제했다(경위는 `CLAUDE.md` 의 "Local verification").

**따라서 지금 main 을 지키는 건 사람과 에이전트의 규율뿐이다.** 이 리포는 에이전트가
병렬 워크트리에서 `gh pr merge` 를 부르는 운영이라, 머지 전에 로컬 검증을 실제로
돌렸는지가 유일한 방어다. 스테일 베이스 머지가 main 에 착지한 기능을 revert 한 전례가
있다(clean ≠ up-to-date) — `git fetch origin main` 후 재검증을 빠뜨리지 말 것.

체크를 되살리려면 위 JSON 에 `required_status_checks` 규칙을 다시 넣고 워크플로를
복구한다. 룰셋 통째로 걷어내려면 `gh api repos/Soochol/hoga-ops/rulesets` 로 id 를
찾아 `gh api -X DELETE .../rulesets/<id>`.

### 업그레이드 러닝북

```sh
git pull
git rev-parse --short HEAD            # 방금 받은 커밋 — 아래 검증의 기대값
uv sync --frozen                      # 네트워크가 필요한 단계를 재시작 전에 분리
cd frontend && npm ci && npx vite build && cd ..   # 프론트 서빙 시
systemctl --user restart hoga-ops
curl -s http://<주소>:8000/health | python3 -m json.tool   # commit 이 위 값과 같은지
```

**판정은 `commit` 으로 한다.** `version`(VERSION 파일)은 사람이 릴리스 때 올리는
값이라 갱신을 빠뜨리면 항상 같은 문자열이 되어, restart 실패·구프로세스 잔존·
`git pull` 누락이 성공과 구분되지 않는다. `commit` 은 기동한 프로세스가 자기
체크아웃에서 읽은 값이라 그 실패들이 전부 드러난다.

롤백은 `git checkout <이전 커밋>` 후 같은 절차. 롤백으로 `.queue.json` 스키마가
구버전과 어긋나면 큐가 `.corrupt-*` 로 격리(=대기 큐 초기화)될 수 있다 — 재시작
후 인벤토리에서 대기 항목을 확인할 것.

### Prod: Tailscale 단일 origin 배포 (ADR-0134)

지인 몇 명이 외부에서 접속하는 prod 서버의 확정 형태는 **`http://<MagicDNS 이름>:8000`
하나** 다 — FastAPI 프로세스 하나가 API 와 프론트(dist)를 같이 서빙한다.

```sh
# 프론트 빌드 (산출물: frontend/dist)
cd frontend && npm ci && npx vite build && cd ..
```

빌드 산출물에 손댈 것은 없다. `dist/config.json` 은 dev 값(`http://localhost:8000`)
으로 빌드되지만, `HOGA_FRONTEND_DIST` 서빙이 켜져 있으면 **서버가 `/config.json` 을
직접 응답**해(`api_url: ""` = same-origin) 그 파일을 덮는다. 예전 절차에는 빌드 후
이 파일을 손으로 고치는 단계가 있었는데, 업그레이드 러닝북이 재빌드만 하고 그
손질을 빠뜨려 접속자 전원의 브라우저가 자기 PC 의 8000 포트로 API 를 쏘는 사고
경로였다 — 절차로 지키던 불변식을 서버가 만들게 해서 그 단계를 없앴다.

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

**prod 노드의 키 만료를 꺼 둘 것.** tailscale 노드 키는 기본 180일이면 만료되고,
그러면 서버가 tailnet 에서 떨어져 나간다. 그 상태에서는 바인드 주소 자체가
사라지므로 워치독이 5분마다 재시작을 시도해도 아무것도 낫지 않는다(재시작으로
고쳐지는 부류가 아니다). 관리 콘솔에서 해당 머신의 *Disable key expiry* 를 켜거나
`tailscale up --advertise-tags=...` 로 태그 노드로 등록한다 — 무인 서버에서 180일
뒤 조용히 죽는 타이머를 남겨 두지 않는다.

## Live index checks

`/live` representative index charts use `/api/live/index-candles` for `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `D`, `W`, and `M` candles. Index daily candles are fetched in 3-month windows and cached in memory; index minute candles cache exact repeated requests, while fetch depth is limited by the 키움 source unit available for each timeframe.

With the backend running, measure index candle fetch behavior from the repo root:

```sh
node scripts/measure_index_daily_cold_fetch.mjs
HOGA_TIMEFRAMES=1m,3m,5m,10m,15m,30m node scripts/measure_index_minute_fetch_depth.mjs
```

Both scripts default to `http://127.0.0.1:8000`; override with `HOGA_API_BASE` when the API is on another port. Use `HOGA_FROM` / `HOGA_TO` to change the date range, `HOGA_STOCKS` / `HOGA_INDICES` for the daily comparison set, and `HOGA_INDEX` / `HOGA_TIMEFRAMES` for the minute-depth probe.
