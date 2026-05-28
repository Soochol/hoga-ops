# 0043 — Today Promotion: 장 중 N분 주기 jsonl→Parquet overwrite

**Status:** accepted (2026-05-28)

**Related:**
- ADR-0037 — Source별 서브폴더 layout
- ADR-0038 — Live Capture는 JSONL append + 18:00 Promotion (이 ADR이 amend함)
- ADR-0039 — Source Preference는 preference + fallback
- `docs/superpowers/specs/2026-05-28-kis-hoga-indicator-always-visible-design.md`

## Decision

Daily Promotion(ADR-0038, 18:00 KST 1회 batch)에 더해, 장 중에도 **오늘 Stock-Date 한정**으로 jsonl을 Parquet으로 변환하는 **Today Promotion**을 도입한다.

- 별도 asyncio task `start_today_promoter`가 기본 5분(env `HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S`) 주기로 활성 watchlist 종목의 오늘 jsonl을 처리한다.
- 동작은 `promote_today(data_dir, *, code)` — jsonl 전체 재읽기, 4개 Parquet 파일을 `atomic_write` 패턴(tempfile + rename)으로 overwrite, `meta.json` 갱신, **archive 이동 안 함**(jsonl은 계속 polling 중이므로 살아있어야 함).
- Daily Promotion(`promote_pending`)은 오늘 날짜를 skip하도록 가드 추가 — 두 promote 경로가 동일 jsonl을 동시에 만지지 않음.
- 자정 경과 후 어제가 된 jsonl은 다음날 18:00 Daily Promotion이 archive 이동 + 최종화. Today Promotion은 항상 오늘만.
- Kill switch: `HOGA_LIVE_TODAY_PROMOTE_ENABLED=false`로 task 비활성 → ADR-0038 단독 동작으로 회귀 가능.

## Why

ADR-0038의 "Future signal to revisit" 항목이 그대로 트리거됐다:

> `/replay에서 "오늘 날짜를 16:00~18:00 사이에 봐야 한다"는 요구가 정당화될 때 — 그 경우 Promotion 시점을 앞당기거나 hot streaming 옵션 도입.`

사용자 요구는 더 강함: 16:00~18:00뿐 아니라 **장 중(09:00~15:30) 어느 시점에서든** `/replay`와 `/live` 양쪽에서 오늘 호가 보조지표를 볼 수 있어야 함. 이 요구의 정당화:

- 분석 워크플로우 — 장 중에 KIS source의 quote_ratio / fill_strength를 확인하고 hogaplay 결과(다음날 가능)와 비교하려는 패턴.
- 서버 재시작 / 폴링 일시 정지 / 첫 진입 후 `LiveBuffer`가 채워지기 전 등의 시나리오에서 `/live`도 빈 차트로 보임 — `LiveBuffer`는 휘발성이고 historical replay 경로가 없음.
- `/replay`는 정의상 promoted Parquet만 보므로 18:00 이전엔 오늘 데이터를 못 봄 — 사용자는 두 페이지 모두에서 같은 데이터를 보길 원함.

세 가지 대안:

**A. Hot path 직접 Parquet 쓰기 (10s / 1m마다 flush)**
ADR-0038에서 거부됨. 작은 row group 양산, 파일 수 폭증, schema 마이그레이션 비용. 그대로 거부.

**B. `/api/range`가 오늘 jsonl을 직접 읽음 (on-demand 변환)**
거부 사유:
- 매 요청마다 jsonl→records 변환 + DuckDB가 Parquet을 read하던 경로와 다른 read 경로 추가 = `/api/range` 로직 분기 증가.
- 캐시 레이어 별도 필요 — invalidation 시점이 모호함.
- Read path 통일성(ADR-0038의 "Read 경로 통일") 훼손.

**C. Today Promotion: 별도 asyncio task가 N분 주기로 오늘 Parquet을 overwrite** ← 채택
근거:
- **ADR-0038 hot-path invariant 유지**: KIS poller의 `LiveSnapshotWriter`는 여전히 jsonl만 씀. `pyarrow` / `polars`는 hot path import 그대로 금지. Today Promotion은 별도 asyncio task로 cold-ish 백그라운드.
- **Read 경로 통일 유지**: `/api/range`는 변경 없이 Parquet만 읽음. Today Promotion이 Parquet을 채우면 자연스럽게 cover.
- **idempotent 패턴 재사용**: `promote_one`과 같은 jsonl→records 변환 로직(`_parse_jsonl_to_records`로 추출)을 공유. 다른 점은 overwrite + no-archive-move 두 가지.
- **단순한 동시성 모델**: 단일 asyncio task의 직렬 sleep 루프. 동시 promote 구조적 불가능. writer/promoter race는 jsonl line-level append 원자성 + 마지막 torn line skip으로 해결 (ADR-0038 패턴 그대로).
- **Daily Promotion과 명확히 분리**: `promote_pending`이 오늘 날짜 skip 가드 1줄로 두 경로가 같은 jsonl을 만지지 않음 보장. 자정 race(23:59:58 Today Promotion + 00:00:01 Daily Promotion)는 `shutil.move` 원자성으로 안전.

## Trade-off accepted

- **디스크 IO 증가**: 5분 주기 × 활성 N종목 × jsonl 크기(평균 14MB → Parquet 압축 후 ~수 MB). N=10이면 시간당 ~30~170MB. 현재 단일 사용자 로컬 도구 환경(SSD)에선 무난. Future signal — N≥30종목 또는 디스크 IO가 cycle_lag_ms에 보이는 시점에 주기 늘리기 또는 incremental append로 재검토.
- **Parquet 파일 수 증가 안 함**: overwrite 패턴이라 같은 4개 파일을 매번 갱신 — 작은 row group 양산 문제(ADR-0038의 거부 사유 A)는 발생 안 함.
- **Today Promotion 실패가 Daily Promotion으로 흡수됨**: Today task가 어떤 이유로 종일 못 돌더라도 18:00 `promote_pending`이 정상 처리. 사용자에게 보이는 영향은 "그날 장 중 오늘 데이터 안 보임" — `LiveBuffer` + SSE는 영향 없음.

## Invariant maintained

ADR-0038의 invariant는 그대로 유효:

> Live Capture hot path는 Parquet writer를 import하지 않는다. `hoga/live/writer.py`의 import에 `pyarrow.parquet` / `polars`가 등장하면 위반.

Today Promotion은 `hoga/live/promote.py`(jsonl writer와 분리된 모듈)에서 동작 — hot path 외부. 위반 아님.

## Invariants introduced

1. **책임 분리(date-disjoint)**: Today Promotion은 오늘 Stock-Date만 처리한다. `promote_today`가 어제 이전 날짜의 jsonl을 만지면 Daily Promotion과 충돌. `promote_pending`은 오늘 날짜를 skip한다 — 두 경로의 책임 분리가 일방향이어야 함(Today는 today only, Daily는 today 제외).
2. **Candles 미생성**: Today Promotion이 만드는 Parquet은 `snapshots.parquet` / `trades.parquet` / `brokers.parquet` 셋뿐. `candles.parquet`은 ADR-0040의 **Live Candle Backfill**(별도 캐시 경로)이 담당하므로 절대 만들지 않는다. `promote_today`가 candles.parquet을 만들면 ADR-0040의 캐시 분리 의도와 충돌.

위반 시:
- Invariant 1 위반 → 두 task가 같은 (date, code)의 jsonl을 만져 archive 이동 race / parquet 중복 write 발생 가능.
- Invariant 2 위반 → Live Candle Backfill 캐시(`~/.local/share/hoga-ops/kis-past-candles/`)와 `parquet/{date}/{code}/kis_live/candles.parquet` 두 source가 같은 candle 데이터를 갖게 되어 read path가 어느 쪽을 신뢰해야 할지 모호해짐.

## Why not stream-to-Parquet via PyArrow ParquetWriter? (ADR-0038에서 이미 거부)

ADR-0038의 거부 근거가 그대로 유효 — close() 전 crash 시 file footer 미작성, 동시 read 안전성 비보장. 본 ADR은 그 거부를 뒤집지 않음.

## Future signal to revisit

- N≥30종목으로 확대되어 5분 주기 overwrite의 디스크 IO가 `cycle_lag_ms` 측정에 보이기 시작할 때 — incremental append(jsonl 마지막 offset 추적 + 새 records만 Parquet에 append) 또는 주기 늘리기.
- "Today Promotion 직후 새로고침해도 차트가 최신이 아닌" 사용자 시그널 발생 시 — 주기를 1분으로 줄이거나 polling cycle 종료 신호(post-publish 콜백)에 trigger 추가.
- Daily Promotion이 archive 이동을 자동화하는 대신 사용자 명시적 동의 후 이동하는 정책이 필요해질 때.
