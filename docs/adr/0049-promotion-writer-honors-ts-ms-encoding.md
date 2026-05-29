# 0049 — Promotion writer가 parquet `ts_ms` HHMMSSmmm 인코딩을 보전한다

**Status:** accepted (2026-05-29)

**Related:**
- ADR-0003 — Api 경계는 Unix epoch ms (UTC); Parquet은 native 인코딩 유지
- ADR-0010 — Series-builder SQL은 HHMMSSmmm을 linear ms-from-midnight으로 디코딩한 후 bucketing
- ADR-0037 — Source별 서브폴더 layout
- ADR-0038 — Live Capture는 JSONL append + 17:00 Promotion
- ADR-0043 — Today Promotion (장 중 5분 주기 jsonl→Parquet overwrite)
- ADR-0044 — `/live` hover spot은 parquet에서 읽음 (LiveBuffer 아님)
- `docs/superpowers/specs/2026-05-29-kis-live-ts-ms-encoding-design.md`

## Decision

**Promotion**(Daily 및 Today 양 variant)이 `snapshots.parquet` / `trades.parquet` / `brokers.parquet`에 쓰는 `ts_ms` 컬럼은 **HHMMSSmmm packed-decimal** 인코딩이다. **Live Snapshot의 `t_ms`(Unix epoch ms, ADR-0003)는 Promotion 시점에 `unix_ms_to_hhmmssms(date, t_ms)`로 변환되어 저장된다.** 컬럼 이름과 인코딩이 일치하는 것은 reader 측의 가정과의 정합 조건이다.

구체적으로 `hoga/live/promote.py::_parse_jsonl_to_records`에서:
- `kind="ob"` 행의 `t_ms` → `ts_ms` 컬럼 (snapshots.parquet)
- `kind="trade"` 행의 `tr["t_ms"]` → `ts_ms` 컬럼 (trades.parquet)
- `kind="broker"` 행의 `t_ms` → `BrokerRow.ts_ms` (brokers.parquet)

세 곳 모두 동일한 변환을 거친다. `_build_meta`가 쓰는 `regular_session_open_ms` / `regular_session_close_ms`는 이미 HHMMSSmmm 상수(09:00:00.000 = 90000000)로, 이 결정과 정합.

## Why

세 가지 대안:

**A. Writer-side normalization (이번 ADR이 명문화)** ← 채택

근거:
- **하나의 column-name = encoding invariant 유지.** Parquet의 `ts_ms` 컬럼은 source(hogaplay / kis_live)와 무관하게 HHMMSSmmm. ADR-0010의 series-builder 규약(`hhmmssms_to_intra_ms_sql("ts_ms")`)이 source 분기 없이 작동.
- **Reader 단일성.** `build_quote_ratio_slice` / `build_fill_strength_slice` / `snapshots.query_at` (WHERE ts_ms <= ?) / `/api/orderbook` / `/api/brokers/series` 어느 reader도 source별 분기를 갖지 않는다 — 분기 부채가 5+ 곳에 누적되는 길을 회피.
- **Schema 안정.** `hoga/tables/snapshots.py:77` 등의 schema 정의 (`pa.field("ts_ms", pa.int64())`)는 변하지 않는다. 컬럼 rename으로 인한 wire/migration 비용 없음.
- **forensic value는 jsonl이 보유.** ADR-0038은 raw JSONL을 archive로 이동 (Daily Promotion) 또는 살려둠 (Today Promotion). 원본 Unix ms는 항상 JSONL에서 복구 가능 — Parquet은 분석/조회용 파생물이므로 인코딩 정규화의 의미가 있다.

**B. Reader-side branching (source별 분기)**

거부 사유:
- `ts_ms`의 인코딩을 source에 따라 다르게 해석. 영향 reader: `build_quote_ratio_slice`, `build_fill_strength_slice`, `/api/orderbook`, `/api/brokers/series`, `snapshots.query_at` — 최소 5곳에 `if source == "kis_live"` 분기 도입.
- ADR-0010의 단일 SQL 패턴 ("series builders MUST decode HHMMSSmmm to linear ms-from-midnight FIRST")이 source별로 갈라짐.
- `/api/queries.py:159-165`의 Inventory가 이미 같은 분기 부채로 kis_live source를 통째로 제외하는 우회로를 갖고 있다 — 분기 누적이 시간이 지날수록 source 차별 대우를 굳히는 패턴이 관찰됨.
- 새 reader가 추가될 때마다 분기를 까먹고 누락할 회귀 위험.

**C. 컬럼 rename → kis_live는 `t_ms` (Unix ms), hogaplay는 `ts_ms` (HHMMSSmmm)**

거부 사유:
- Schema 분기. `hoga/tables/snapshots.py`의 entity/wire model이 source별로 갈라짐 → ADR-0006 (single-module per table)의 패턴 훼손.
- 모든 reader가 source별로 다른 컬럼명을 select. B보다 더 분기 표면이 큼.
- Inventory의 우회로 ([queries.py:159-165](../../hoga/api/queries.py))를 영구화. 옵션 A는 그 우회로를 제거할 수 있는 길을 연다.

## Trade-off accepted

- **자정 race**: `t_ms`의 KST 일자가 promotion `date` 인자와 어긋나는 row는 `unix_ms_to_hhmmssms`의 `ValueError`로 자연 검출, 해당 row skip + warn. 정상 운영에서는 `today_kst` 고정 ([promote.py:172](../../hoga/live/promote.py)) + market-hours 가드가 1차 방어이므로 발생하지 않아야 함. 발생 시 silently 잘못된 timestamp를 쓰는 것보다 row drop이 안전.
- **소급 데이터 복구 비용**: 이 ADR 이전에 promoted된 kis_live Parquet은 모두 Unix ms를 `ts_ms`에 담고 있어 reader가 잘못 디코딩 (2046년 timestamp 발생). 일회성 재-promote 스크립트로 회복. JSONL 원본이 보전되어 있어 데이터 손실 없음.
- **인코딩 변환 비용**: 사이클당 수백 row × 단순 산술. Today Promotion 5분 주기에서 측정 영향 무시 가능.

## Invariants introduced

1. **Promotion writer encoding invariant**: `_parse_jsonl_to_records`가 만드는 `snapshots` / `trades` / `broker_rows` 컬렉션의 `ts_ms` 필드는 모두 HHMMSSmmm packed-decimal이다. JSONL의 raw Unix ms를 `unix_ms_to_hhmmssms(date, t_ms)`로 변환 없이 그대로 저장하면 위반.

   위반 시: `/api/range`의 `quote_ratio.points[*].t` / `fill_strength.points[*].t`가 day-window를 벗어난 timestamp(2046년대)로 반환되어 frontend VirtualAxis가 모두 필터링, hoga panes가 빈 차트로 표시.

2. **자정 race row drop**: `unix_ms_to_hhmmssms`가 `ValueError`(day-window 밖)를 던지면 해당 row는 promoted Parquet에 포함되지 않고 `live.promote.midnight_race_skip` warning을 남긴다. silently 잘못된 timestamp를 채우는 것을 금지.

## Reader-side defense-in-depth

옵션 A가 wins이지만, frontend의 `buildLiveBundle.ts`는 추가로 sanity clip을 둔다 ([spec §3](../superpowers/specs/2026-05-29-kis-live-ts-ms-encoding-design.md)): `pastMaxQrT = Math.min(rawPastMaxQrT, todaySession.close_ms + 30 * 60 * 1000)`. 천장은 **Live Session 끝(close_ms + 30min, After-Hours Trading 포함)** — `close_ms` 단독으로 자르면 매일 15:30–16:00 KST After-Hours 데이터의 dedup boundary가 무력화된다. 이는 backend 인코딩 회귀가 다시 발생해도 SSE 라이브 머지(`incrementalQR.filter(p => p.t > pastMaxQrT)`)가 차단되지 않게 하는 독립 방어막. 본 ADR의 writer 결정과 직교 — defense-in-depth.

## Why not enforce via Parquet schema?

PyArrow / Polars schema에 "HHMMSSmmm 범위 (0 ≤ ts_ms < 240_000_000)" 같은 constraint를 걸 수는 없다. Parquet 표준이 column-level value range 제약을 제공하지 않음. 대안은 writer 단의 assertion (`assert 0 <= ts_ms < 240_000_000`) — 본 ADR의 invariant 1을 코드로 lock-down하는 방식. 회귀 가드로 spec §4의 "build_quote_ratio_slice가 day-window 안의 t만 반환한다"는 통합 테스트가 같은 역할을 하므로 writer assertion은 redundant — 회귀 테스트에 일임.

## Future signal to revisit

- 다른 source (예: KIS WebSocket streaming, alternative broker API)가 추가되어 또 다른 인코딩 변환이 필요할 때 — 본 ADR의 "writer가 invariant를 honor"하는 패턴이 가이드.
- Inventory의 kis_live 제외 우회로 ([queries.py:159-165](../../hoga/api/queries.py))를 통합할 때 — 이 ADR이 통합의 전제 조건을 만족.
- Parquet schema가 column-level constraint를 지원하게 진화할 때 — writer assertion / runtime invariant 가드를 schema로 끌어올림.
