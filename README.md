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
   이름을 실어 준다. **실패로 세지 않는 두 상태**가 있고 둘 다 무한 재시작을 막는
   장치다: 설정으로 끈 기능은 `not_started`, 일회성 부팅 태스크
   (`symbols-boot-refresh`·`watchlist-catchup`)의 정상 완료는 `completed` 다.
   후자를 죽음으로 읽으면 정상 부팅이 곧 영구 503 이 된다.

   ```sh
   curl -s http://127.0.0.1:8000/health?deep=1 | python -m json.tool
   ```

4. **deep health 감독 타이머** — 배경 태스크가 조용히 죽으면 프로세스는 살아 있으므로
   `Restart=always` 가 못 잡는다(ADR-0088: 부활 경로는 프로세스 재시작뿐). 위 503 을
   실제 재시작으로 잇는 것이 `deploy/hoga-ops-health.{sh,service,timer}` 다:

   ```sh
   chmod +x deploy/hoga-ops-health.sh
   cp deploy/hoga-ops-health.{service,timer} ~/.config/systemd/user/
   # ExecStart 를 실제 체크아웃 경로로 고친 뒤:
   systemctl --user daemon-reload
   systemctl --user enable --now hoga-ops-health.timer
   ```

   60초마다 판정한다. 무응답(프로세스 다운)에는 관여하지 않는다 — 그건
   `Restart=always` 의 영역이고, 겹치면 기동 중인 프로세스를 이중으로 걷어찬다.
   재시작은 10분에 한 번으로 제한한다(`HOGA_HEALTH_HOLDOFF_S`): 재시작 직후 또 503
   이면 결정적 장애라 반복해도 소용없으므로 로그만 남기고 사람을 기다린다.

   ```sh
   journalctl --user -u hoga-ops-health --since today   # 감독 동작 이력
   systemctl --user list-timers                         # 타이머 스케줄
   ```

배경 작업이 죽으면 프론트엔드에도 토스트가 뜬다(어느 페이지에서든). 앱 안에는 자동
재시작 감독자가 없으므로(ADR-0088) 조치는 프로세스 재시작이고, 위 4번이 그 조치를
자동화한 것이다.

## 백업

**왜 필요한가.** 로컬 디스크가 이 앱의 유일한 DB 인데 상류 재취득 창이 극히 짧다 —
hogaplay 는 ~18시간만 보유하고 실시간 WS 틱은 재요청 대상이 아니다. 게다가 원본은
스스로 지워진다: raw 는 3일(ADR-0075), `_archive` JSONL 은 7일 뒤 삭제된다. 즉
promoted parquet 이 유일 사본이 되는 시점이 정상 운영 중에 반드시 오고, 그때 디스크가
죽으면 복구 경로가 없다.

```sh
export HOGA_BACKUP_DEST=/mnt/backup/hoga-ops   # 반드시 **다른 물리 디스크**
uv run hoga backup           # 담는다
uv run hoga backup-verify    # 실제로 열어 복원 가능한지 확인한다
```

목적지는 두 갈래다. 실패 양상이 다르기 때문이다:

| 경로 | 담는 것 | 방식 | 이유 |
| --- | --- | --- | --- |
| `state/` | 관심종목·저장뷰·프리셋·스크리너 저장·알림 설정·`symbol-master.json` | 날짜별 tar 스냅샷(기본 14세대) | 여기서 흔한 사고는 디스크 고장이 아니라 **오삭제·손상**이다. `versioned_json_file` 은 깨진 파일을 격리하고 빈 문서를 반환하므로, 미러였다면 그 빈 문서가 정상본을 덮는다 |
| `market/` | `parquet/`·`screener/`·`research/` | 덧쓰기 전용 미러 | 파티션이 불변이라 새 파일만 복사하면 하루치 비용이다. **목적지에서 절대 지우지 않는다** — 원본의 prune 이 백업으로 전파되면 백업이 아니다 |

- `--include-raw` / `--include-live` 로 raw TSV·실시간 JSONL 도 담는다. 용량이
  지배적이라(raw 실측 351GB) 기본 제외이며, 어차피 보존창(3일·7일) 안에만 존재한다.
- **자격증명(`.local/*token*.json`)과 DuckDB 스필은 절대 담지 않는다.** 백업본이
  유출되면 실전투자 앱키가 함께 나가기 때문이다.
- 출력의 첫 줄이 `<원본> → <목적지>` 다. `HOGA_DATA_DIR` 를 빠뜨리고 엉뚱한 디렉토리를
  담는 사고를 눈으로 잡으라고 넣었다.

자동화는 `deploy/hoga-ops-backup.{service,timer}` 다. 매일 18:30 에 백업 후 **곧바로
검증까지** 돌린다(검증하지 않은 백업은 백업이 아니고, 별도 타이머로 미루면 아무도 안
본다). 17:00 일일 런 뒤라 parquet 이 확정되고 JSONL append 도 멎은 사본을 얻는다.

```sh
cp deploy/hoga-ops-backup.{service,timer} ~/.config/systemd/user/
# WorkingDirectory 와 HOGA_BACKUP_DEST 를 실제 값으로 고친 뒤:
systemctl --user daemon-reload
systemctl --user enable --now hoga-ops-backup.timer
systemctl --user start hoga-ops-backup.service   # 첫 실행은 전량 복사라 오래 걸린다
```

`Persistent=true` 라 그 시각에 노트북이 꺼져 있었으면 다음 부팅 직후 따라잡는다.
시스템 시간대가 KST 가 아니면 타이머의 `OnCalendar` 를 고칠 것.

## Live index checks

`/live` representative index charts use `/api/live/index-candles` for `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `D`, `W`, and `M` candles. Index daily candles are fetched in 3-month windows and cached in memory; index minute candles cache exact repeated requests, while fetch depth is limited by the KIS source unit available for each timeframe.

With the backend running, measure index candle fetch behavior from the repo root:

```sh
node scripts/measure_index_daily_cold_fetch.mjs
HOGA_TIMEFRAMES=1m,3m,5m,10m,15m,30m node scripts/measure_index_minute_fetch_depth.mjs
```

Both scripts default to `http://127.0.0.1:8000`; override with `HOGA_API_BASE` when the API is on another port. Use `HOGA_FROM` / `HOGA_TO` to change the date range, `HOGA_STOCKS` / `HOGA_INDICES` for the daily comparison set, and `HOGA_INDEX` / `HOGA_TIMEFRAMES` for the minute-depth probe.
