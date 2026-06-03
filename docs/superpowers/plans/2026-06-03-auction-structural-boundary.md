# 동시호가 경계 구조 검출 (Structural Auction Boundary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 호가비·총잔량 보조지표의 장마감 동시호가 경계를 `session_close − 10분` 시각 고정에서 "마지막 연속매매(10호가) 스냅샷" 구조 임계값으로 교체해, 실제 전환 시각(15:20:01.xx, ±초)과 무관하게 동시호가 데이터를 정확히 제외한다.

**Architecture:** 백엔드(`build_quote_ratio_slice`)와 프론트(`bucketHogaSeries`)는 둘 다 per-level 호가 데이터를 이미 보유한다. 각 경로에서 "그날 `session_close` 이전 마지막 연속매매 호가창 스냅샷"의 시각(`last_continuous_ms`)을 데이터로 산출하고, 그 이후 스냅샷을 동시호가로 본다. 대표-스냅샷 선택 기계(백엔드 2-tier `ORDER BY`, 프론트 `seenPre` 폴백)는 그대로 두고, "무엇이 동시호가인가" 판정만 시간→구조로 바꾼다. v1은 계산(데이터 레이어)만 — 표시 마스크·VI 제외·와이어 변경은 범위 밖.

**Tech Stack:** Python(DuckDB SQL, pytest), TypeScript(Vitest), 기존 `hhmmssms_to_intra_ms_sql` 시간 인코딩 헬퍼.

**Spec:** `docs/superpowers/specs/2026-06-03-auction-structural-boundary-design.md`

---

## File Structure

| File | 책임 | 변경 |
|------|------|------|
| `hoga/api/bundle.py` | 과거 날짜 호가비·총잔량 버킷 집계 | Modify — `build_quote_ratio_slice` 동시호가 판정 시간→구조, `_CLOSING_AUCTION_WINDOW_MS` 제거 |
| `tests/unit/api/test_quote_ratio_auction_decontam.py` | 위 함수 회귀 잠금 | Rewrite — fixture를 연속(10호가)/동시호가(3호가) 구조로, 지터·VI·상한·폴백 케이스 추가 |
| `frontend/src/live/bucketHogaSeries.ts` | 오늘 SSE 호가 버킷 집계 | Modify — `auctionStartMs`→`sessionCloseMs`, `isContinuousBook` + `lastContinuousMs` 구조 산출 |
| `frontend/src/live/bucketHogaSeries.test.ts` | 위 모듈 회귀 잠금 | Modify — 걸침 테스트 2개를 asks/bids 구조로 재작성 + 폴백·상한 테스트 추가 |
| `frontend/src/live/buildLiveBundle.ts` | 오늘 live 번들 배선 | Modify — `auctionStartMs` 계산 제거, `todaySession.close_ms` 직접 전달, 미사용 import 제거 |
| `docs/adr/0062-structural-auction-boundary.md` | 결정 기록 | Create |
| `docs/adr/0029-auction-mask-hide-not-zero.md` | 기존 ADR 포인터 | Modify — 2차 amendment 한 줄 |

**의존성:** Task 2 → Task 3(프론트 시그니처 변경 후 호출부 배선). Task 1(백엔드)은 Task 2/3과 독립. Task 4/5는 코드 태스크 이후.

---

## Task 1: 백엔드 — `build_quote_ratio_slice` 구조 경계

**Files:**
- Modify: `hoga/api/bundle.py:46-50` (`_CLOSING_AUCTION_WINDOW_MS` 제거), `hoga/api/bundle.py:121-192` (`build_quote_ratio_slice`)
- Test: `tests/unit/api/test_quote_ratio_auction_decontam.py` (전면 재작성)

- [ ] **Step 1: 테스트 파일을 구조 fixture + 신규 케이스로 재작성**

`tests/unit/api/test_quote_ratio_auction_decontam.py` 전체를 아래로 교체한다. 핵심 변경: `_write_snaps`가 `is_continuous` 플래그를 받아 연속(`ask_q4` 등 깊은 레벨에 잔량)/동시호가(q1~q3만) 구조를 쓴다.

```python
"""Closing-auction structural-boundary de-contamination (2026-06-03 spec).

build_quote_ratio_slice marks a snapshot as closing-auction by ORDERBOOK STRUCTURE
(the book collapses from 10 visible levels to 3 — ask_q4..ask_q10 / bid_q4..bid_q10
all zero), NOT by a 15:20 wall-clock threshold. `last_continuous_ms` = the last
continuous-book snapshot at/before the session close; snapshots after it are the
closing auction. The `<= session_close` bound is load-bearing (every stock shows a
post-cross book re-expansion ~15:30:14). Intraday VI single-price runs sit before
the threshold and are intentionally retained (v1 = closing-only).
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

CLOSE_FULL = 153000000  # 15:30:00.000 (full-day close, HHMMSSmmm)
CLOSE_HALF = 123000000  # 12:30:00.000 (half-day close, HHMMSSmmm)

BUCKET_3M = 180_000
BUCKET_5M = 300_000


def _hms_unix(h: int, m: int, s: int = 0) -> int:
    """Unix ms for HH:MM:SS KST on DATE."""
    return DAY_START + ((h * 3600 + m * 60 + s) * 1000)


def _write_snaps(path: Path, snaps: list[tuple[int, int, int, bool]]) -> None:
    """snaps: (unix_ms, bid_total, ask_total, is_continuous).

    SUM(bid_q1..q10) == bid_total in both cases so the slice's representative value
    is identifiable. Structural distinction:
      - continuous (10-level book): bid_q1 = total-1, bid_q4 = 1 → deep level > 0.
      - auction (3-level book): bid_q1 = total, q2..q10 = 0 → deep levels == 0.
    (totals require >= 1 for the continuous split; all test values are >= 11.)
    """
    rows = []
    for unix_ms, bid_total, ask_total, is_cont in snaps:
        row: dict = {"ts_ms": unix_ms_to_hhmmssms(DATE, unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"ask_p{i}"] = 101
            row[f"bid_q{i}"] = 0
            row[f"ask_q{i}"] = 0
        if is_cont:
            row["bid_q1"] = bid_total - 1
            row["bid_q4"] = 1
            row["ask_q1"] = ask_total - 1
            row["ask_q4"] = 1
        else:
            row["bid_q1"] = bid_total
            row["ask_q1"] = ask_total
        row["total_bid_qty"] = bid_total
        row["total_ask_qty"] = ask_total
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _engine(tmp_path: Path, snaps: list[tuple[int, int, int, bool]], close_ms: int) -> QueryEngine:
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


def _slice(engine: QueryEngine, bucket_ms: int, close_ms: int):
    return build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=bucket_ms,
        source="kis_live", session_close_ms=close_ms,
    )


def test_straddle_bucket_uses_last_continuous_snapshot(tmp_path: Path) -> None:
    # 3m bucket [15:18,15:21): 15:18 & 15:19 continuous; 15:20:30 auction (3-level).
    snaps = [
        (_hms_unix(15, 18, 0), 11, 21, True),
        (_hms_unix(15, 19, 0), 12, 22, True),    # last continuous → must win
        (_hms_unix(15, 20, 30), 99, 98, False),  # auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (12, 22)


def test_jitter_early_transition_excludes_pre_1520_auction(tmp_path: Path) -> None:
    # Auction starts BEFORE 15:20 (15:19:55). The old time-based code treated this
    # 3-level snapshot as pre-auction and let it contaminate the bucket. Structural
    # detection classifies it as auction regardless of the clock.
    snaps = [
        (_hms_unix(15, 18, 0), 11, 21, True),
        (_hms_unix(15, 19, 30), 12, 22, True),   # last continuous → must win
        (_hms_unix(15, 19, 55), 99, 98, False),  # 3-level BEFORE 15:20 → auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (12, 22)


def test_jitter_late_transition_keeps_post_1520_continuous(tmp_path: Path) -> None:
    # Auction starts AFTER 15:20 (15:20:05). The continuous snapshot at 15:20:03
    # must NOT be dropped (old time-based code would treat >=15:20 as auction).
    snaps = [
        (_hms_unix(15, 19, 0), 11, 21, True),
        (_hms_unix(15, 20, 3), 12, 22, True),    # continuous AFTER 15:20 → must win
        (_hms_unix(15, 20, 5), 99, 98, False),   # auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (12, 22)


def test_fully_auction_bucket_falls_back_to_last(tmp_path: Path) -> None:
    # A continuous snapshot at 15:19 defines the threshold; the [15:21,15:24)
    # bucket is fully auction → no continuous member → fallback to last (15:22).
    snaps = [
        (_hms_unix(15, 19, 0), 53, 63, True),    # threshold anchor (bucket [15:18,15:21))
        (_hms_unix(15, 21, 0), 31, 41, False),
        (_hms_unix(15, 22, 0), 32, 42, False),   # last auction → fallback wins
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 2
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (53, 63)
    assert (qr.points[1].bid_total, qr.points[1].ask_total) == (32, 42)


def test_clean_timeframe_unchanged_5m(tmp_path: Path) -> None:
    # 5m, all continuous — no auction in the data. Last in [15:15,15:20) = 15:19.
    snaps = [
        (_hms_unix(15, 15, 0), 51, 61, True),
        (_hms_unix(15, 18, 0), 52, 62, True),
        (_hms_unix(15, 19, 0), 53, 63, True),
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_5M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (53, 63)


def test_half_day_boundary_via_structure(tmp_path: Path) -> None:
    # Half-day 12:30 close. Structure (not a -10min offset) lands the threshold at
    # 12:19; 12:20:30 (3-level) is excluded. 3m bucket [12:18,12:21).
    snaps = [
        (_hms_unix(12, 18, 0), 71, 81, True),
        (_hms_unix(12, 19, 0), 72, 82, True),    # last continuous → wins
        (_hms_unix(12, 20, 30), 99, 98, False),  # auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_HALF), BUCKET_3M, CLOSE_HALF)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (72, 82)


def test_after_hours_continuous_excluded_by_close_bound(tmp_path: Path) -> None:
    # A post-cross book re-expansion at 15:30:14 (continuous) must NOT push the
    # threshold past the closing auction. Without the `<= close` bound,
    # last_continuous_ms would be 15:30:14 and 15:20:30 would be wrongly kept.
    snaps = [
        (_hms_unix(15, 19, 0), 11, 21, True),    # last continuous <= close → threshold
        (_hms_unix(15, 20, 30), 99, 98, False),  # auction → excluded
        (_hms_unix(15, 30, 14), 77, 88, True),   # post-cross continuous (> close)
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    # bucket [15:18,15:21) represented by 15:19 (NOT the 15:20:30 auction).
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (11, 21)


def test_intraday_vi_run_retained(tmp_path: Path) -> None:
    # v1 = closing-only. An intraday VI single-price run (3-level at 11:39/11:40)
    # sits before last_continuous_ms (~15:19) so it is classified pre-auction and
    # RETAINED (its 3-level value is kept — documented v1 trade-off).
    snaps = [
        (_hms_unix(11, 39, 0), 11, 21, False),   # VI 3-level
        (_hms_unix(11, 40, 0), 12, 22, False),   # VI 3-level (last in its bucket)
        (_hms_unix(15, 19, 0), 50, 60, True),    # continuous → threshold anchor
        (_hms_unix(15, 20, 30), 99, 98, False),  # closing auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    vi_bucket = [p for p in qr.points if p.bid_total == 12 and p.ask_total == 22]
    assert vi_bucket, "intraday VI bucket must be retained (closing-only v1)"


def test_no_continuous_snapshot_falls_back_legacy(tmp_path: Path) -> None:
    # Degenerate: every snapshot is 3-level (no continuous). last_continuous_ms is
    # undefined → legacy last-in-bucket (does NOT blank the series).
    snaps = [
        (_hms_unix(15, 21, 0), 31, 41, False),
        (_hms_unix(15, 22, 0), 32, 42, False),   # last → wins
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (32, 42)
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_quote_ratio_auction_decontam.py -v`
Expected: 다수 FAIL — 기존 시간-기반 구현이 구조 fixture(연속/동시호가)와 신규 지터 케이스를 처리하지 못해 대표값이 어긋남. (특히 `test_jitter_early_transition_*`이 (99,98)을 반환.)

- [ ] **Step 3: `build_quote_ratio_slice` 구현을 구조 경계로 교체**

`hoga/api/bundle.py`에서 먼저 `_CLOSING_AUCTION_WINDOW_MS` 상수(라인 46-50의 주석+정의)를 **삭제**한다(이 함수에서만 쓰였고 더 안 씀). 그리고 `build_quote_ratio_slice`(라인 121-192)의 `intra_ms_expr = ...` 이후 ~ `rows = engine.conn.execute(...)` 직전까지(라인 141-180의 predicate 산출 블록)를 아래로 교체한다:

```python
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    # Structural closing-auction boundary (2026-06-03 spec). A snapshot is a
    # *continuous-trading book* iff it shows depth beyond level 3 (ask_q4..ask_q10
    # or bid_q4..bid_q10 > 0); the closing Auction Window collapses every book to
    # exactly 3 levels. `last_continuous_ms` = the last continuous snapshot at/before
    # the session close — everything after it is the closing auction. This replaces
    # the prior `session_close - 10min` clock boundary, which mis-sliced the tail
    # bucket when the real continuous->auction transition drifted off 15:20:00.000
    # (observed 15:20:01.xx, ±seconds per Stock-Date/code). The `<= session_close`
    # bound is load-bearing: every stock shows a post-cross book re-expansion
    # ~15:30:14 that would otherwise pull the threshold past the auction window.
    # session_close_ms None (direct callers) OR no continuous snapshot -> threshold
    # None -> TRUE predicate == legacy last-in-bucket.
    deep_book_sql = (
        "((ask_q4 + ask_q5 + ask_q6 + ask_q7 + ask_q8 + ask_q9 + ask_q10) > 0"
        " OR (bid_q4 + bid_q5 + bid_q6 + bid_q7 + bid_q8 + bid_q9 + bid_q10) > 0)"
    )
    last_continuous_ms: int | None = None
    if session_close_ms is not None:
        close_intra_sql = hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))
        row = engine.conn.execute(
            f"SELECT max({intra_ms_expr}) FROM read_parquet(?) "
            f"WHERE {deep_book_sql} AND {intra_ms_expr} <= {close_intra_sql}",
            [path],
        ).fetchone()
        if row is not None and row[0] is not None:
            last_continuous_ms = int(row[0])
    if last_continuous_ms is None:
        pre_auction_pred = "TRUE"
    else:
        pre_auction_pred = f"({intra_ms_expr} <= {last_continuous_ms})"
```

`rows = engine.conn.execute(...)` 메인 쿼리 블록(라인 161-180)과 그 아래 `return QuoteRatio(...)`은 **변경하지 않는다** — `pre_auction_pred`를 그대로 소비한다.

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_quote_ratio_auction_decontam.py -v`
Expected: 9 passed.

- [ ] **Step 5: 인접 회귀 + 타입 확인**

Run: `uv run --extra dev pytest tests/unit/api -q && uv run --extra dev ruff check hoga/api/bundle.py`
Expected: 전부 PASS, ruff clean(미사용 `_CLOSING_AUCTION_WINDOW_MS` 잔존 없음).

- [ ] **Step 6: 커밋**

```bash
git add hoga/api/bundle.py tests/unit/api/test_quote_ratio_auction_decontam.py
git commit -m "fix(bundle): 호가비·총잔량 동시호가 경계를 시간→구조로 (구조 검출)

build_quote_ratio_slice가 동시호가를 15:20 시각이 아니라 호가창 구조
(4~10호가 잔량 소멸)로 판정. last_continuous_ms(<= session_close 상한,
load-bearing) 이후를 동시호가로 제외. 대표선택 2-tier ORDER BY 불변,
_CLOSING_AUCTION_WINDOW_MS 제거. 지터(15:19:55/15:20:05)·반장·VI 유지·
post-cross 상한·연속전무 폴백 회귀 잠금."
```

---

## Task 2: 프론트 — `bucketHogaSeries` 구조 검출

**Files:**
- Modify: `frontend/src/live/bucketHogaSeries.ts:1,38-66`
- Test: `frontend/src/live/bucketHogaSeries.test.ts:80-103` (걸침 2개 재작성) + 신규 케이스

- [ ] **Step 1: 걸침 테스트 2개를 구조(asks/bids)로 재작성 + 폴백·상한 테스트 추가**

`frontend/src/live/bucketHogaSeries.test.ts`의 import 줄을 유지하고, 파일 상단(import 직후)에 헬퍼를 추가한다:

```ts
import type { OrderbookLevel } from '../api/types';

// 10-level continuous book (deep levels populated).
const contLvls = (qty: number): OrderbookLevel[] =>
  Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty }));
// 3-level auction book (levels 1-3 only; 4-10 zero).
const aucLvls = (qty: number): OrderbookLevel[] =>
  Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty: i < 3 ? qty : 0 }));
const cont = (t: number, a: number, b: number) => ({
  t_ms: t, total_ask_qty: a, total_bid_qty: b, asks: contLvls(a), bids: contLvls(b),
});
const auc = (t: number, a: number, b: number) => ({
  t_ms: t, total_ask_qty: a, total_bid_qty: b, asks: aucLvls(a), bids: aucLvls(b),
});
```

그리고 기존 두 테스트(라인 80-103, `de-contaminates a bucket straddling…` / `falls back to last snapshot for a fully-auction bucket`)를 아래 네 테스트로 **교체**한다:

```ts
  it('de-contaminates a straddle bucket via structure (last continuous wins)', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 600_000;
    const ob = [
      cont(base, 21, 11),
      cont(base + 60_000, 22, 12),      // last continuous → 정화값
      auc(base + 150_000, 98, 99),      // auction (3-level) → 제외
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 22, bid_total: 12 }]);
  });

  it('falls back to last snapshot for a fully-auction bucket', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 600_000;
    const ob = [
      cont(base + 60_000, 50, 60),      // continuous → defines lastContinuous
      auc(base + 180_000, 41, 31),      // [base+3m,..) auction
      auc(base + 240_000, 42, 32),      // 마지막 auction → fallback
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 50, bid_total: 60 },
      { t: base + 180_000, ask_total: 42, bid_total: 32 },
    ]);
  });

  it('a post-close continuous book does not extend the boundary (close bound)', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 70_000;          // close inside the bucket
    const ob = [
      cont(base, 11, 21),                          // continuous <= close → threshold
      auc(base + 60_000, 98, 99),                  // auction <= close → excluded
      cont(base + 90_000, 77, 88),                 // post-close continuous (> close)
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    // bucket represented by the base continuous, NOT the 60_000 auction.
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 11, bid_total: 21 }]);
  });

  it('treats totals-only snapshots (no asks/bids) as continuous → legacy last-in-bucket', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const ob = [
      { t_ms: base, total_ask_qty: 21, total_bid_qty: 11 },
      { t_ms: base + 60_000, total_ask_qty: 22, total_bid_qty: 12 },
      { t_ms: base + 150_000, total_ask_qty: 98, total_bid_qty: 99 },
    ];
    // No asks/bids + default sessionCloseMs(+Infinity) → all continuous →
    // lastContinuous = last t_ms → legacy last-in-bucket.
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET);
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 98, bid_total: 99 }]);
  });
```

(라인 5-78의 totals-only 테스트 5개는 그대로 둔다 — 보수적 폴백으로 legacy 동작을 계속 검증한다.)

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd frontend && npx vitest run src/live/bucketHogaSeries.test.ts`
Expected: FAIL — `bucketHogaSeries`가 아직 `auctionStartMs`(시간)로 동작하고 `sessionCloseMs`/구조 검출이 없어 새 케이스가 어긋남. (`isContinuousBook` 미정의는 아님 — 구현이 totals만 봐서 구조 케이스 오답.)

- [ ] **Step 3: `bucketHogaSeries` 구조 검출 구현**

`frontend/src/live/bucketHogaSeries.ts`의 import(라인 1)에 `OrderbookLevel`이 이미 포함돼 있다(확인). 함수 시그니처(라인 38-43)와 quote 블록(라인 46-66)을 아래로 교체한다. `isContinuousBook` 헬퍼를 함수 위에 추가:

```ts
/** A live OB snapshot is a *continuous-trading book* iff it shows depth beyond
 * level 3 (asks[3..] or bids[3..] qty > 0). The closing auction collapses every
 * book to exactly 3 levels. If neither asks nor bids rode along (minute-chart
 * totals-only path) we cannot tell structurally → treat as continuous so the
 * series falls back to legacy last-in-bucket (no spurious masking). */
function isContinuousBook(s: ObSnapshot): boolean {
  const hasDeep = (lv: OrderbookLevel[] | undefined): boolean =>
    !!lv && lv.slice(3).some((l) => l.qty > 0);
  if (!s.asks && !s.bids) return true;
  return hasDeep(s.asks) || hasDeep(s.bids);
}

export function bucketHogaSeries(
  ob: readonly ObSnapshot[],
  trade: readonly TradeSnapshot[],
  bucketMs: number,
  sessionCloseMs: number = Number.POSITIVE_INFINITY,
): { quoteRatioPoints: QuoteRatioPoint[]; fillStrengthPoints: FillStrengthPoint[] } {
  if (bucketMs <= 0) throw new Error(`bucketMs must be positive, got ${bucketMs}`);

  const obSorted = [...ob].sort((a, b) => a.t_ms - b.t_ms);

  // Structural closing-auction boundary (2026-06-03 spec). `lastContinuousMs` =
  // the last continuous-book snapshot at/before the session close; snapshots after
  // it are the closing auction. The `<= sessionCloseMs` bound is load-bearing — a
  // post-cross book re-expansion would otherwise push the boundary past the
  // auction. None found → +Infinity (no cutoff = every snapshot pre-auction =
  // legacy last-in-bucket).
  let lastContinuousMs = Number.NEGATIVE_INFINITY;
  for (const s of obSorted) {
    if (s.t_ms <= sessionCloseMs && isContinuousBook(s)) lastContinuousMs = s.t_ms;
  }
  if (lastContinuousMs === Number.NEGATIVE_INFINITY) {
    lastContinuousMs = Number.POSITIVE_INFINITY;
  }

  // Quote Totals — last *continuous-trading* snapshot in bucket. Straddle buckets
  // prefer the last pre-auction (<= lastContinuousMs) snapshot; fully-auction
  // buckets fall back to the last auction snapshot (seenPre stays empty).
  const quoteByBucket = new Map<number, QuoteRatioPoint>();
  const seenPre = new Set<number>();
  for (const s of obSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    const point = { t, ask_total: s.total_ask_qty, bid_total: s.total_bid_qty };
    if (s.t_ms <= lastContinuousMs) {
      quoteByBucket.set(t, point); // pre-auction: 마지막이 덮어씀
      seenPre.add(t);
    } else if (!seenPre.has(t)) {
      quoteByBucket.set(t, point); // auction: pre 없을 때만, 마지막 auction이 덮어씀
    }
  }
  const quoteRatioPoints = Array.from(quoteByBucket.values()).sort((a, b) => a.t - b.t);
```

fill 루프(라인 68-85)와 `return`은 **변경하지 않는다**. (헬퍼 추가로 `OrderbookLevel` import가 값이 아닌 타입으로 쓰이는지 확인 — 이미 `import type` 이면 그대로.)

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cd frontend && npx vitest run src/live/bucketHogaSeries.test.ts`
Expected: 모든 테스트 PASS(기존 5 + 신규 4).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/bucketHogaSeries.ts frontend/src/live/bucketHogaSeries.test.ts
git commit -m "fix(live): bucketHogaSeries 동시호가 경계를 구조 검출로

auctionStartMs(시간) → sessionCloseMs(연속 검색 상한). 각 ob 스냅샷의
asks/bids로 isContinuousBook 판정, lastContinuousMs(<= close 상한) 이후를
동시호가로 제외. asks/bids 부재 시 보수적 연속 폴백(legacy). seenPre 폴백 불변."
```

---

## Task 3: 프론트 — `buildLiveBundle` 배선

**Files:**
- Modify: `frontend/src/live/buildLiveBundle.ts:12` (미사용 import 제거), `:79-84` (계산 제거·직접 전달)

- [ ] **Step 1: `buildLiveBundle` 호출부 교체**

`frontend/src/live/buildLiveBundle.ts`에서 라인 12의 import를 **삭제**한다:

```ts
import { AUCTION_WINDOW_LENGTH_MS } from '../util/sessionTime';
```

그리고 라인 79-84(주석 + `auctionStartMs` 계산 + 호출)를 아래로 교체한다:

```ts
  // Today's straddle/auction buckets must not pull the closing-auction (3-level)
  // book into 호가비·총잔량. bucketHogaSeries detects the auction structurally
  // (book collapse) per ob snapshot's asks/bids and excludes everything after the
  // last continuous-book snapshot at/before close. today's close is the upper
  // bound for that search (load-bearing — 2026-06-03 structural-boundary spec).
  // Known limitation: close_ms falls back to 15:30 on half-days, so the today-live
  // half-day tail stays uncleaned; backend (past dates) uses the exact per-date close.
  const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs, todaySession.close_ms);
```

- [ ] **Step 2: 타입체크 + 회귀 테스트**

Run: `cd frontend && npx tsc -b && npx vitest run src/live/buildLiveBundle.test.ts src/live/bucketHogaSeries.test.ts`
Expected: tsc clean(미사용 import 없음), 모든 테스트 PASS. (buildLiveBundle.test.ts의 sseOb는 totals-only라 보수적 폴백 → 동작 불변.)

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/live/buildLiveBundle.ts
git commit -m "fix(live): buildLiveBundle이 구조 검출에 today close_ms 전달

auctionStartMs(close−10분) 계산 제거, todaySession.close_ms를 연속 검색
상한으로 직접 전달. 미사용 AUCTION_WINDOW_LENGTH_MS import 제거."
```

---

## Task 4: ADR + 기존 ADR 포인터

**Files:**
- Create: `docs/adr/0062-structural-auction-boundary.md`
- Modify: `docs/adr/0029-auction-mask-hide-not-zero.md` (말미에 2차 amendment 한 줄)

- [ ] **Step 1: ADR-0062 작성**

`docs/adr/0062-structural-auction-boundary.md`를 생성한다:

```markdown
# 0062 — Closing-auction boundary is detected by orderbook structure, not the 15:20 clock

**Status:** accepted (2026-06-03)

## Decision

The closing **Auction Window** boundary that gates 호가비·**Quote Totals** bucket
representative selection is detected from **orderbook structure**, not a
`session_close − 10min` wall-clock threshold. A snapshot is *continuous-trading*
iff its book shows depth beyond level 3 (`ask_q4..ask_q10` or `bid_q4..bid_q10`
> 0); the closing auction collapses every book to exactly 3 levels. The boundary
is `last_continuous_ms` — the last continuous snapshot at/before the session close
— and any snapshot after it is the closing auction.

Applies to both read paths: `build_quote_ratio_slice` (past Stock-Dates) computes
`last_continuous_ms` from `snapshots.parquet`; `bucketHogaSeries` (today live)
computes it from the SSE ob buffer's `asks`/`bids`. The representative-selection
machinery (backend 2-tier `ORDER BY (pre_auction) DESC, ts DESC`; frontend
`seenPre` fallback) is unchanged — only the definition of "pre-auction" moved from
time to structure.

The `<= session_close` upper bound on the `last_continuous_ms` search is
load-bearing: every captured stock shows a post-cross book re-expansion (~15:30:14)
that, unbounded, would pull the threshold past the auction window and leak the
auction back in.

Scope (v1): closing auction only, calculation layer only. Intraday **VI**
single-price runs sit before the threshold and are retained. The display Auction
Mask stays time-based; the wire contract is unchanged.

## Why

The prior boundary (`session_close − 10min` = 15:20:00.000, ADR-0029 amendment
2026-06-03) assumed the continuous→auction transition happens exactly at 15:20.
It does not: across the captured corpus the transition lands at 15:20:01.xx and
drifts ±seconds per Stock-Date/code. A fixed-time boundary therefore mis-slices
the tail bucket in both directions — a 3-level snapshot timestamped 15:19:55 was
treated as continuous (contaminating the bucket), and a continuous snapshot at
15:20:03 was treated as auction (dropping real data). This was the user-reported
"1분봉에서도 안 됨 / 동시호가가 새어들어옴".

The orderbook structure marks the transition exactly and time-independently. Cross-
stock verification: the continuous→auction transition is a clean monotonic step
(0/368 stocks show a continuous book re-appearing inside the auction after it
starts), and every intraday 3-level run is a sustained VI single-price period
(all runs length ≥10, zero singleton flickers) — never a thin continuous book —
so structure never misclassifies genuine continuous trading. See the
**Single-Price Book Signature** entry in CONTEXT.md.

## Alternatives considered

**Keep the time boundary, widen the window.** Rejected — any fixed offset still
mis-slices when the real transition drifts, and a wider window drops legitimate
late-continuous data.

**Pure structural (mask every 3-level snapshot, incl. intraday VI).** Deferred,
not rejected — it is simpler (no threshold, no `session_close` bound) and matches
"any single-price = no indicator", but masking intraday VI buckets requires a
structural marker to reach the projector (a wire field) and a mid-session
line-gap rendering decision (ADR-0029's transparent-color trick assumes the
day-end). Tracked as the v2 "모든 단일가 제외" follow-up in the spec.

**Carry `is_auction` on the wire now.** Deferred — v1's contamination fix needs
only calculation-layer changes; the closing auction is already time-bounded for
the existing display mask. The wire field is required only for the v2 VI work.

## Consequences

- `_CLOSING_AUCTION_WINDOW_MS` removed from `bundle.py`; `AUCTION_WINDOW_LENGTH_MS`
  no longer used by `buildLiveBundle` (still used by `sessionTime`/overlays).
- `build_quote_ratio_slice` runs one extra aggregate scan to derive the threshold.
- Half-day (12:30 close) past Stock-Dates are handled with no `−10min` offset.
  The frontend today-live half-day tail remains uncleaned (15:30 fallback close_ms
  loosens the load-bearing bound) — an inherited limitation, root-fixed when the
  backend sends today's real `close_ms`.
- The display Auction Mask boundary stays time-based in v1, so calc and the cosmetic
  band can disagree by the boundary minute — re-anchoring the band to the structural
  boundary is the deferred display task.

Reference: `docs/superpowers/specs/2026-06-03-auction-structural-boundary-design.md`.
```

- [ ] **Step 2: ADR-0029 말미에 2차 amendment 포인터 추가**

`docs/adr/0029-auction-mask-hide-not-zero.md` 파일 맨 끝에 아래를 덧붙인다:

```markdown

## Amendment — 2026-06-03 #2 (동시호가 경계 시간→구조)

호가비·총잔량의 *버킷 대표 선택* 동시호가 경계를 `session_close − 10min` 시각에서
**호가창 구조**(4호가 이상 잔량 소멸 = `last_continuous_ms` 이후)로 정제했다. 실제
연속→동시호가 전환이 15:20 정각이 아니라 15:20:01.xx(±초)로 흔들려, 시각 경계가
tail 버킷을 양방향으로 오분류하던 것을 해소. 표시 마스크의 hide 동작·토글 의미는
불변(v1, 계산 레이어). 결정 상세는 ADR-0062. 참조:
`docs/superpowers/specs/2026-06-03-auction-structural-boundary-design.md`.
```

- [ ] **Step 3: 커밋**

```bash
git add docs/adr/0062-structural-auction-boundary.md docs/adr/0029-auction-mask-hide-not-zero.md
git commit -m "docs(adr): 0062 동시호가 경계 구조 검출 + 0029 2차 amendment 포인터"
```

---

## Task 5: 전체 게이트 + 수동 검증

**Files:** 없음(검증만)

- [ ] **Step 1: 백엔드 전체 + 프론트 게이트**

Run:
```bash
uv run --extra dev pytest tests/unit/api -q
cd frontend && npx tsc -b && npx vitest run src/live/ src/chart/
```
Expected: 전부 PASS, tsc clean. (변경 범위가 호가비·총잔량 경로라 `src/live`·`src/chart` 스코프로 충분; 전체 vitest는 시간 허용 시.)

- [ ] **Step 2: 변경 파일 eslint(스코프)**

Run: `cd frontend && npx eslint src/live/bucketHogaSeries.ts src/live/buildLiveBundle.ts`
Expected: 0 errors. (레포 전역 `npm run lint`은 기존 부채로 실패하므로 변경 파일만 스코프.)

- [ ] **Step 3: 수동 검증 (/live, dev 서버 필요)**

CLAUDE.md의 dev 서버 2개 기동 후 `/live`에서 호가 데이터 있는 종목을 연다:

- 3m으로 마감 부근 스크롤: 호가비·총잔량이 15:18 버킷까지 표시되고, 그 값이 15:20
  동시호가가 아니라 **실제 마지막 연속(15:20:00.x 직전) 호가창**을 반영(이전엔 경계
  지터로 튀던 값).
- 1m으로 전환 → 15:19/15:20 버킷이 오염 없이 깨끗.
- 5m → 변화 없음(무회귀).
- 체결강도 pane: ON/OFF·전 TF 변화 없음.

`★ 확인 포인트`: 동시호가 진입이 15:20 정각이 아닌 날(대부분)에도 마지막 연속
호가창에서 깔끔히 끊김. (DESIGN.md 기준 시각 토큰/스타일은 미변경.)

- [ ] **Step 4: 완료 — finishing-a-development-branch 로 정리**

테스트·타입·수동 검증 통과 후 `superpowers:finishing-a-development-branch`로 머지/PR
경로 결정. VERSION·CHANGELOG bump은 ship 단계에서 처리(직전 릴리스 컨벤션).

---

## Self-Review 결과

- **Spec coverage:** 백엔드 구조 경계(Task 1), 프론트 구조 경계(Task 2), 배선(Task 3),
  표시 재앵커·VI·`is_auction` 와이어는 spec의 Out-of-Scope(v2) → 플랜에서 의도적 제외.
  체결강도 미변경(면역) — Task로 없음이 정상. 반장 한계·load-bearing 상한·지터 양방향·
  VI 유지·연속전무 폴백·after-hours 상한 = Task 1 테스트로 전부 커버. 프론트 폴백·상한
  = Task 2 테스트로 커버.
- **Placeholder scan:** 모든 코드 스텝에 실제 코드/명령/기대출력. 플레이스홀더 없음.
- **Type consistency:** `last_continuous_ms`(py int|None) / `lastContinuousMs`(ts number),
  `isContinuousBook`(ts) / `deep_book_sql`(py SQL) 일관. `bucketHogaSeries(ob,trade,bucketMs,
  sessionCloseMs)` 시그니처가 Task 2 정의 ↔ Task 3 호출부 일치. `_write_snaps` 4-tuple이
  모든 테스트 호출과 일치.
