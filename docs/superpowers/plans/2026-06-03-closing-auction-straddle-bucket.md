# Closing Auction Straddle-Bucket De-contamination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 호가비·총잔량 버킷의 대표 호가 스냅샷을 "버킷 내 마지막 *15:20 이전* 스냅샷 우선, 없으면 마지막 전체"로 바꿔, 15:20이 버킷 경계가 아닌 타임프레임(3m·15m·30m)의 걸침 버킷이 종가 동시호가 데이터에 오염되지 않게 한다.

**Architecture:** 두 집계 지점만 손댄다 — 백엔드 `build_quote_ratio_slice`(과거 날짜, DuckDB SQL의 `ROW_NUMBER` 정렬을 2-tier로)와 프론트 `bucketHogaSeries`(오늘 live, last-in-bucket 루프에 `seenPre` 플래그). 둘 다 `auction_start = session_close − 10min` 경계를 strict `<`로 쓴다. 체결강도·표시 마스크·토글·캔들·MA는 미변경. 양쪽 모두 인자 미전달 시 기존 동작(하위호환).

**Tech Stack:** Python 3.12 + DuckDB(읽기 SQL) + pytest/polars(백엔드 테스트), TypeScript + Vitest(프론트). 스펙: `docs/superpowers/specs/2026-06-03-closing-auction-straddle-bucket-design.md`.

---

## File Structure

- **Modify** `hoga/api/bundle.py` — `build_quote_ratio_slice`에 `session_close_ms` 인자 + 2-tier `ORDER BY`; 호출부 `build_range_bundle`에서 `meta`값 전달; 모듈 상수 1개.
- **Create** `tests/unit/api/test_quote_ratio_auction_decontam.py` — 실 `QueryEngine` + snapshots.parquet 회귀 테스트 4종.
- **Modify** `frontend/src/live/bucketHogaSeries.ts` — quote 루프에 `auctionStartMs` 인자 + `seenPre` 플래그.
- **Modify** `frontend/src/live/bucketHogaSeries.test.ts` — straddle 정화 + fully-auction fallback 테스트 2종 추가.
- **Modify** `frontend/src/live/buildLiveBundle.ts` — `auctionStartMs` 계산 후 `bucketHogaSeries`에 전달.
- **Modify** `docs/adr/0029-auction-mask-hide-not-zero.md` — 대표값 선택 정제 개정 메모.

---

## Task 1: Backend — quote_ratio 걸침 버킷 정화 (TDD)

**Files:**
- Modify: `hoga/api/bundle.py` (`build_quote_ratio_slice` 114-163; 호출부 445; 모듈 상수)
- Test: `tests/unit/api/test_quote_ratio_auction_decontam.py` (Create)

- [ ] **Step 1: 실패 테스트 작성 (straddle 정화)**

Create `tests/unit/api/test_quote_ratio_auction_decontam.py`:

```python
"""Closing-auction straddle-bucket de-contamination (2026-06-03 spec).

build_quote_ratio_slice must represent a bucket that straddles the closing
Auction Window (15:20–15:30) with its LAST pre-15:20 snapshot, not the auction
snapshot it also contains. Fully-auction buckets fall back to the last snapshot
(legacy). Half-day sessions anchor auction_start at session_close − 10min.
"""
from __future__ import annotations

import json
from pathlib import Path

import polars as pl

from hoga.api.bundle import build_quote_ratio_slice
from hoga.api.queries import QueryEngine
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms

DATE = "20260529"
CODE = "005930"
DAY_START = hhmmssms_to_unix_ms(DATE, 0)  # 00:00:00.000 KST = day start

CLOSE_FULL = 153000000  # 15:30:00.000 (full-day Regular Session close, HHMMSSmmm)
CLOSE_HALF = 123000000  # 12:30:00.000 (half-day close, HHMMSSmmm)

BUCKET_3M = 180_000
BUCKET_5M = 300_000


def _hms_unix(h: int, m: int, s: int = 0) -> int:
    """Unix ms for HH:MM:SS KST on DATE."""
    return DAY_START + ((h * 3600 + m * 60 + s) * 1000)


def _write_snaps(path: Path, snaps: list[tuple[int, int, int]]) -> None:
    """snaps: (unix_ms, bid_total, ask_total). bid_q1/ask_q1 carry the total and
    q2..q10 = 0, so the slice's SUM(bid_q1..q10) == bid_total — lets each
    snapshot have a distinct, identifiable representative value."""
    rows = []
    for unix_ms, bid_total, ask_total in snaps:
        row: dict = {"ts_ms": unix_ms_to_hhmmssms(DATE, unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"ask_p{i}"] = 101
            row[f"bid_q{i}"] = 0
            row[f"ask_q{i}"] = 0
        row["bid_q1"] = bid_total
        row["ask_q1"] = ask_total
        row["total_bid_qty"] = bid_total
        row["total_ask_qty"] = ask_total
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _engine(tmp_path: Path, snaps: list[tuple[int, int, int]], close_ms: int) -> QueryEngine:
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": "kis_live", "code": CODE, "date": DATE,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": close_ms,
        "collection_complete": True, "is_partial": False,
    }
    (code_dir / "meta.json").write_text(json.dumps(meta))
    _write_snaps(code_dir / "snapshots.parquet", snaps)
    return QueryEngine(tmp_path)


def test_straddle_bucket_uses_last_pre_auction_snapshot(tmp_path: Path) -> None:
    # 3m bucket [15:18,15:21): 15:18 & 15:19 are continuous; 15:20:30 is auction.
    snaps = [
        (_hms_unix(15, 18, 0), 11, 21),
        (_hms_unix(15, 19, 0), 12, 22),    # last pre-auction → must win
        (_hms_unix(15, 20, 30), 99, 98),   # auction → must be excluded
    ]
    engine = _engine(tmp_path, snaps, CLOSE_FULL)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=BUCKET_3M,
        source="kis_live", session_close_ms=CLOSE_FULL,
    )
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (12, 22)
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_quote_ratio_auction_decontam.py::test_straddle_bucket_uses_last_pre_auction_snapshot -v`
Expected: FAIL — `TypeError: build_quote_ratio_slice() got an unexpected keyword argument 'session_close_ms'`

- [ ] **Step 3: 구현 — 모듈 상수 추가**

`hoga/api/bundle.py`, `downsample_candles` 정의 위(46행 근처, import 블록 아래)에 모듈 상수 추가:

```python
# Closing Auction Window length — last 10 min of the Regular Session. Mirrors
# the frontend `sessionTime.AUCTION_WINDOW_LENGTH_MS` and `disk_state.
# _AUCTION_WINDOW_DURATION_MS`; kept as a local literal here to avoid importing
# a private cross-module symbol for a one-line constant.
_CLOSING_AUCTION_WINDOW_MS = 10 * 60 * 1000
```

- [ ] **Step 4: 구현 — `build_quote_ratio_slice` 시그니처 + 2-tier ORDER BY**

`hoga/api/bundle.py`의 `build_quote_ratio_slice`를 아래로 교체 (시그니처에 `session_close_ms` 추가, `intra_ms_expr` 다음에 predicate 계산, `ORDER BY` 변경):

```python
def build_quote_ratio_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int = 1000,
    source: str = "hogaplay",
    session_close_ms: int | None = None,
) -> QuoteRatio:
    # Bucket on LINEAR ms-from-midnight, not raw HHMMSSmmm. The raw encoding
    # has gaps at minute / hour boundaries, so arithmetic bucketing of HHMMSSmmm
    # produces invalid HHMMSSmmm values that decode (via hhmmssms_to_unix_ms)
    # to duplicate or out-of-order Unix-ms outputs — which lightweight-charts
    # then rejects with "asc ordered by time". See hhmmssms_to_intra_ms_sql.
    path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    if not path_obj.exists():
        # ADR-0043: promote_today writes empty records as unlink → missing file
        # is the valid "no data" state, not an error.
        return QuoteRatio(bucket_ms=bucket_ms, points=[])
    path = str(path_obj)
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    # Per-bucket representative = last *continuous-trading* snapshot. A bucket
    # straddling the closing Auction Window (e.g. a 3m bucket [15:18,15:21) on a
    # 15:30 close) must be represented by its last pre-15:20 snapshot, not the
    # 15:20+ auction book it also spans. `pre_auction_pred` is true for rows
    # strictly before auction_start; ORDER BY (pred) DESC puts those first, so
    # ROW_NUMBER rn=1 picks the last pre-auction row, falling back to the last
    # overall row when a bucket has none (fully inside the auction window —
    # left for the display Auction Mask, ADR-0029). When session_close_ms is
    # None the predicate is the constant TRUE → ORDER BY (TRUE) DESC, ts_ms DESC
    # ≡ the legacy last-in-bucket behavior (callers that don't supply a session
    # bound are unaffected).
    if session_close_ms is None:
        pre_auction_pred = "TRUE"
    else:
        auction_start_sql = (
            f"(({hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))})"
            f" - {_CLOSING_AUCTION_WINDOW_MS})"
        )
        pre_auction_pred = f"({intra_ms_expr} < {auction_start_sql})"
    rows = engine.conn.execute(
        f"""
        WITH bucketed AS (
          SELECT ts_ms,
                 (ask_q1 + ask_q2 + ask_q3 + ask_q4 + ask_q5 +
                  ask_q6 + ask_q7 + ask_q8 + ask_q9 + ask_q10) AS ask_total,
                 (bid_q1 + bid_q2 + bid_q3 + bid_q4 + bid_q5 +
                  bid_q6 + bid_q7 + bid_q8 + bid_q9 + bid_q10) AS bid_total,
                 ({intra_ms_expr} // {bucket_ms}) AS bucket,
                 ROW_NUMBER() OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                   ORDER BY ({pre_auction_pred}) DESC, ts_ms DESC
                 ) AS rn
          FROM read_parquet(?)
        )
        SELECT bucket * {bucket_ms}, bid_total, ask_total
        FROM bucketed WHERE rn = 1 ORDER BY bucket
        """,
        [path],
    ).fetchall()
    return QuoteRatio(
        bucket_ms=bucket_ms,
        points=[
            QuoteRatioPoint(
                # r[0] is bucket-aligned ms-from-midnight, not HHMMSSmmm.
                t=ms_from_midnight_to_unix_ms(date, r[0]),
                bid_total=int(r[1]),
                ask_total=int(r[2]),
            )
            for r in rows
        ],
    )
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_quote_ratio_auction_decontam.py::test_straddle_bucket_uses_last_pre_auction_snapshot -v`
Expected: PASS

- [ ] **Step 6: 호출부 배선 — `build_range_bundle`이 session_close 전달**

`hoga/api/bundle.py:445`의 호출을 교체:

```python
        qr_d = build_quote_ratio_slice(
            engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
            session_close_ms=meta["regular_session_close_ms"],
        )
```

(`meta`는 같은 루프 안 445행 위 `meta = engine.get_meta(d, code, source)`로 이미 바인딩되어 있고, `meta["regular_session_close_ms"]`는 452행에서도 쓰는 int값이다.)

- [ ] **Step 7: 기존 백엔드 테스트 무회귀 확인 (기본값 경로)**

Run: `uv run --extra dev pytest tests/unit/api/test_bundle_day_window_invariant.py tests/hoga/api/test_bundle.py -q`
Expected: PASS — `test_bundle_day_window_invariant.py`는 `session_close_ms`를 안 넘기므로 `pre_auction_pred="TRUE"` 경로(기존 동작)로 그대로 통과. `test_bundle.py`는 `build_quote_ratio_slice`를 mock하므로 영향 없음.

- [ ] **Step 8: 커밋**

```bash
git add hoga/api/bundle.py tests/unit/api/test_quote_ratio_auction_decontam.py
git commit -m "fix(bundle): 호가비·총잔량 걸침 버킷을 15:20 이전 스냅샷으로 정화

build_quote_ratio_slice 의 ROW_NUMBER 정렬을 2-tier로 — pre-auction 행 우선,
없으면 마지막 전체(기존). session_close_ms None 이면 TRUE predicate 로 기존
last-in-bucket 동작 유지. build_range_bundle 이 per-date meta 의 close 를 전달."
```

---

## Task 2: Backend — fallback / clean-TF / half-day 회귀 테스트

**Files:**
- Test: `tests/unit/api/test_quote_ratio_auction_decontam.py` (Modify — Task 1 헬퍼 재사용)

Task 1에서 로직이 이미 구현됐으므로 아래 3개는 작성 즉시 통과(회귀 잠금).

- [ ] **Step 1: 3개 테스트 추가**

`tests/unit/api/test_quote_ratio_auction_decontam.py` 끝에 추가:

```python
def test_fully_auction_bucket_falls_back_to_last(tmp_path: Path) -> None:
    # 3m bucket [15:21,15:24): 모두 동시호가 → 마지막(15:22) 스냅샷 fallback.
    snaps = [
        (_hms_unix(15, 21, 0), 31, 41),
        (_hms_unix(15, 22, 0), 32, 42),    # last overall → wins
    ]
    engine = _engine(tmp_path, snaps, CLOSE_FULL)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=BUCKET_3M,
        source="kis_live", session_close_ms=CLOSE_FULL,
    )
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (32, 42)


def test_clean_timeframe_unchanged_5m(tmp_path: Path) -> None:
    # 5m: 15:20 은 버킷 경계 → [15:15,15:20) 는 전부 pre-auction. 마지막=15:19.
    snaps = [
        (_hms_unix(15, 15, 0), 51, 61),
        (_hms_unix(15, 18, 0), 52, 62),
        (_hms_unix(15, 19, 0), 53, 63),    # last in [15:15,15:20)
    ]
    engine = _engine(tmp_path, snaps, CLOSE_FULL)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=BUCKET_5M,
        source="kis_live", session_close_ms=CLOSE_FULL,
    )
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (53, 63)


def test_half_day_anchors_auction_start_at_close_minus_10min(tmp_path: Path) -> None:
    # Half-day 12:30 마감 → auction_start = 12:20. 3m bucket [12:18,12:21).
    snaps = [
        (_hms_unix(12, 18, 0), 71, 81),
        (_hms_unix(12, 19, 0), 72, 82),    # last pre-auction (< 12:20) → wins
        (_hms_unix(12, 20, 30), 99, 98),   # auction → excluded
    ]
    engine = _engine(tmp_path, snaps, CLOSE_HALF)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=BUCKET_3M,
        source="kis_live", session_close_ms=CLOSE_HALF,
    )
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (72, 82)
```

- [ ] **Step 2: 실행 → 통과 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_quote_ratio_auction_decontam.py -v`
Expected: 4 passed (Task 1의 1개 + 신규 3개)

- [ ] **Step 3: 커밋**

```bash
git add tests/unit/api/test_quote_ratio_auction_decontam.py
git commit -m "test(bundle): 걸침 버킷 fallback·clean-TF·half-day 회귀 잠금"
```

---

## Task 3: Frontend — bucketHogaSeries seenPre 정화 (TDD)

**Files:**
- Modify: `frontend/src/live/bucketHogaSeries.ts` (38-72)
- Test: `frontend/src/live/bucketHogaSeries.test.ts`

작업 디렉토리: `cd frontend` (vitest/tsc는 frontend에서 실행).

- [ ] **Step 1: 실패 테스트 작성 (straddle 정화 + fully-auction fallback)**

`frontend/src/live/bucketHogaSeries.test.ts`의 마지막 `it(...)` 다음, `});`(describe 닫기) 직전에 추가:

```ts
  it('Quote Totals de-contaminates a bucket straddling the auction window', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET; // 3m 버킷 시작
    const auctionStartMs = base + 120_000;   // "15:20" 경계
    const ob = [
      { t_ms: base, total_ask_qty: 21, total_bid_qty: 11 },             // pre
      { t_ms: base + 60_000, total_ask_qty: 22, total_bid_qty: 12 },    // 마지막 pre → 정화값
      { t_ms: base + 150_000, total_ask_qty: 98, total_bid_qty: 99 },   // auction → 제외
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, auctionStartMs);
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 22, bid_total: 12 }]);
  });

  it('Quote Totals falls back to last snapshot for a fully-auction bucket', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const auctionStartMs = base + 120_000;        // "15:20"
    const ob = [
      { t_ms: base + 180_000, total_ask_qty: 41, total_bid_qty: 31 },   // [15:21,15:24) auction
      { t_ms: base + 240_000, total_ask_qty: 42, total_bid_qty: 32 },   // 마지막 auction → fallback
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, auctionStartMs);
    expect(quoteRatioPoints).toEqual([{ t: base + 180_000, ask_total: 42, bid_total: 32 }]);
  });
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd frontend && npx vitest run src/live/bucketHogaSeries.test.ts`
Expected: FAIL — straddle 케이스가 `{ ask_total: 98, bid_total: 99 }`(마지막 = 오염값)를 반환해 `22/12` 기대와 불일치. (4번째 인자 `auctionStartMs`는 현재 무시됨.)

- [ ] **Step 3: 구현 — auctionStartMs 인자 + seenPre 플래그**

`frontend/src/live/bucketHogaSeries.ts`의 `bucketHogaSeries` 시그니처와 quote 루프를 교체 (FillStrength 루프·시그니처 나머지는 그대로):

```ts
export function bucketHogaSeries(
  ob: readonly ObSnapshot[],
  trade: readonly TradeSnapshot[],
  bucketMs: number,
  auctionStartMs: number = Number.POSITIVE_INFINITY,
): { quoteRatioPoints: QuoteRatioPoint[]; fillStrengthPoints: FillStrengthPoint[] } {
  if (bucketMs <= 0) throw new Error(`bucketMs must be positive, got ${bucketMs}`);

  // Quote Totals — last *continuous-trading* snapshot in bucket. A bucket that
  // straddles the closing Auction Window (e.g. a 3m bucket [15:18,15:21)) must
  // NOT be represented by its 15:20+ auction snapshot. Prefer the last
  // pre-auction snapshot; fall back to the last overall only when the bucket
  // has no pre-auction snapshot (fully inside the auction window — left to the
  // display Auction Mask, ADR-0029). `auctionStartMs` defaults to +Infinity =
  // "no cutoff" → every snapshot is pre-auction → legacy last-in-bucket.
  const obSorted = [...ob].sort((a, b) => a.t_ms - b.t_ms);
  const quoteByBucket = new Map<number, QuoteRatioPoint>();
  const seenPre = new Set<number>();
  for (const s of obSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    const point = { t, ask_total: s.total_ask_qty, bid_total: s.total_bid_qty };
    if (s.t_ms < auctionStartMs) {
      quoteByBucket.set(t, point); // pre-auction: 마지막이 덮어씀
      seenPre.add(t);
    } else if (!seenPre.has(t)) {
      quoteByBucket.set(t, point); // auction: pre 없을 때만, 마지막 auction이 덮어씀
    }
  }
  const quoteRatioPoints = Array.from(quoteByBucket.values()).sort((a, b) => a.t - b.t);
```

(`obSorted`가 오름차순이라 한 버킷에서 pre 스냅샷이 auction보다 먼저 처리됨 → pre가 들어오면 `seenPre`가 서고, 이후 auction은 skip된다. pre가 없는 버킷은 auction이 계속 덮어써 마지막 auction이 남는다.)

- [ ] **Step 4: 테스트 실행 → 통과 확인 (신규 + 기존 무회귀)**

Run: `cd frontend && npx vitest run src/live/bucketHogaSeries.test.ts`
Expected: PASS — 신규 2개 통과 + 기존 5개(인자 3개 호출, 기본값 +Infinity로 기존 동작) 통과.

- [ ] **Step 5: 타입 체크**

Run: `cd frontend && npx tsc -b`
Expected: 에러 없음 (4번째 인자는 optional이라 기존 호출부 안전).

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/live/bucketHogaSeries.ts frontend/src/live/bucketHogaSeries.test.ts
git commit -m "fix(bucketHogaSeries): 호가비·총잔량 걸침 버킷 seenPre 정화

quote 루프에 auctionStartMs(기본 +Infinity=무컷오프) + seenPre 플래그 —
pre-auction 마지막 우선, fully-auction 버킷은 마지막 auction fallback."
```

---

## Task 4: Frontend — buildLiveBundle 배선

**Files:**
- Modify: `frontend/src/live/buildLiveBundle.ts` (import + 78행 호출)

오늘 live의 SSE 버킷이 실제 `auctionStartMs`를 받도록 배선. 일자별 단일 세션이라 today 경계 하나면 충분.

- [ ] **Step 1: import 추가**

`frontend/src/live/buildLiveBundle.ts` 상단 import 블록(`./liveDateTime` import 근처)에 추가:

```ts
import { AUCTION_WINDOW_LENGTH_MS } from '../util/sessionTime';
```

- [ ] **Step 2: 호출부 교체**

`frontend/src/live/buildLiveBundle.ts:78`의

```ts
  const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs);
```

를 아래로 교체:

```ts
  // Today's straddle bucket (3m/15m/30m) must not pull the 15:20+ closing-
  // auction book into its 호가비·총잔량 value. session bound is today's
  // close − 10min. (Known limitation: today's close_ms falls back to 15:30 on
  // half-days — see the 2026-06-03 spec Risks; backend handles past dates.)
  const auctionStartMs = todaySession.close_ms - AUCTION_WINDOW_LENGTH_MS;
  const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs, auctionStartMs);
```

(`todaySession`은 41-51행에서 `input`으로부터 구조분해되어 있고 `todaySession.close_ms`는 68행에서도 쓰인다.)

- [ ] **Step 3: 타입 체크 + 프론트 회귀**

Run: `cd frontend && npx tsc -b && npx vitest run src/live/`
Expected: PASS — 타입 에러 없음, live 디렉토리 테스트 무회귀.

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/live/buildLiveBundle.ts
git commit -m "fix(buildLiveBundle): 오늘 SSE 호가 버킷에 동시호가 컷오프 전달"
```

---

## Task 5: ADR 개정 + 전체 스위트 검증

**Files:**
- Modify: `docs/adr/0029-auction-mask-hide-not-zero.md`

- [ ] **Step 1: ADR-0029 개정 메모 추가**

`docs/adr/0029-auction-mask-hide-not-zero.md` 파일 맨 끝에 추가:

```markdown

## Amendment — 2026-06-03 (호가비·총잔량 걸침 버킷 정화)

ADR-0029의 Auction Mask는 *표시 레이어*(시작이 [15:20,15:30]에 든 점을
숨김)다. 15:20이 버킷 경계가 아닌 타임프레임(3m·15m·30m)에서는 15:20을 가로지르는
**걸침 버킷**(예: 3m `[15:18,15:21)`)이 마스크를 빠져나가면서, last-in-bucket
대표값이 15:20+ 동시호가 호가창을 끌어들이는 *데이터 레이어* 오염이 있었다.

수정(2026-06-03 spec): 호가비·총잔량의 버킷 대표 스냅샷 선택을 **"버킷 내 마지막
15:20 이전(연속거래) 스냅샷 우선, 없으면 마지막 전체"**로 정제했다
(`build_quote_ratio_slice` 2-tier `ORDER BY`, `bucketHogaSeries` `seenPre`).
- 표시 마스크의 hide 동작·`auctionWindowMask` 토글 의미는 **불변**. 완전-동시호가
  버킷(시작 ≥ 15:20)은 대표값 그대로라 토글이 계속 표시/숨김을 제어한다(토글 OFF
  시 동시호가 호가창 여전히 드러남 — 계약 유지).
- 체결강도는 미변경(매수/매도 합산이 `side=±1`만 집계 → 동시호가 면역).
- 경계는 `session_close − 10min`(strict `<`), per-Stock-Date(half-day 안전).
참조: `docs/superpowers/specs/2026-06-03-closing-auction-straddle-bucket-design.md`.
```

- [ ] **Step 2: 백엔드 전체 슬라이스/번들 스위트 검증**

Run: `uv run --extra dev pytest tests/unit/api/ tests/hoga/api/ -q`
Expected: PASS (무회귀).

- [ ] **Step 3: 프론트 전체 검증**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: PASS. (참고: `npm run lint`은 레포 기존 부채로 실패할 수 있음 — 게이트 아님. 변경 파일 한정으로만 보려면 `npx eslint src/live/bucketHogaSeries.ts src/live/buildLiveBundle.ts`.)

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/0029-auction-mask-hide-not-zero.md
git commit -m "docs(adr-0029): 호가비·총잔량 걸침 버킷 정화 개정 메모"
```

---

## Manual Verification (구현 후)

`/live`에서 호가 데이터가 있는 종목을 **3m**으로 보고 마감 부근으로 스크롤:

- 토글 ON(기본): 호가비·총잔량이 15:18 버킷까지 보이고, 그 값이 15:20 동시호가가
  아니라 15:19 직전 호가창을 반영(이전엔 마감 직전 값이 한쪽으로 튀었다).
- **5m**으로 바꿔 동일 구간 → 변화 없음(무회귀).
- 토글 OFF → 완전-동시호가 버킷(15:21 등)이 다시 보임(토글 정상).
- 체결강도 pane은 ON/OFF·타임프레임 모두 변화 없음.

dev 서버: 백엔드 `uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga`, 프론트 `cd frontend && npm run dev`.

---

## Spec Coverage (planner self-review)

- Design §백엔드 2-tier ORDER BY → Task 1 Step 4.
- Design §프론트 seenPre → Task 3 Step 3.
- Design §핵심 규칙(pre 우선 / fully-auction fallback) → Task 1·3 테스트로 양쪽 잠금.
- Testing 표 6행(백엔드 straddle/fallback/clean-5m/half-day, 프론트 straddle/fallback) → Task 1·2·3.
- Testing "프론트 fill 무회귀" → Task 3 Step 4(기존 fill 테스트 그대로 통과).
- Invariant "Half-Day 안전성(백엔드)" 회귀 테스트 → Task 2 half-day 케이스.
- Non-Goal(체결강도·마스크·토글·MA·캔들 미변경) → 어떤 Task도 손대지 않음.
- ADR impact → Task 5.
- Known limitation(프론트 half-day) → Task 4 Step 2 주석 + spec Risks.
