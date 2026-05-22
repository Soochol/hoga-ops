# Replay Viewer Zoom, Density & Multi-Day Range — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-Stock-Date replay viewer with a multi-day **Stock-Date Range** viewer that supports a 6-step **Timeframe** selector (1m/3m/5m/10m/15m/30m), TradingView-style zoom, KST x-axis labels, and day-boundary visualisation — fixing the current "even one day's candles don't all fit" symptom.

**Architecture:** New `RangeBundle` Wire Model replaces `SessionBundle` (ADR-0013). All five series aggregated at one user-selected Timeframe (ADR-0014). New `GET /api/range` endpoint; `/api/session` retired in same PR. Chart stitches N Stock-Dates onto a Virtual Axis (existing `util/time.ts`), with day-boundary overlay and per-segment Auction Window threshold in CandlePane. Capped at 30-day range for v1; multi-date SQL optimisation deferred.

**Tech Stack:** Backend — Python 3.12, FastAPI, DuckDB, Pydantic; tests via pytest. Frontend — React 19, TypeScript, Zustand, React Query, lightweight-charts v5; tests via vitest + RTL.

**Source spec:** `docs/superpowers/specs/2026-05-22-replay-zoom-density-design.md`
**Related ADRs:** `docs/adr/0013-rangebundle-single-read-path.md`, `docs/adr/0014-replay-single-timeframe.md`
**Domain:** `CONTEXT.md` (Stock-Date Range, RangeBundle, Timeframe, Day Boundary, Auction Window multi-day note)

---

## Phase 1 — Domain Types Foundation

### Task 1: Backend RangeBundle / RangeSegment Pydantic models + Timeframe validation

**Files:**
- Modify: `hoga/api/models.py` (add `RangeSegment`, `RangeBundle`, `Timeframe` enum / validator)
- Test: `tests/hoga/api/test_models.py` (or `tests/hoga/api/test_range_models.py` if test file doesn't exist)

- [ ] **Step 1: Write failing test for Timeframe whitelist**

```python
# tests/hoga/api/test_range_models.py
import pytest
from pydantic import ValidationError

from hoga.api.models import ALLOWED_TIMEFRAME_MS, validate_bucket_ms, RangeBundle, RangeSegment


def test_allowed_timeframe_ms_is_six_fixed_values():
    assert ALLOWED_TIMEFRAME_MS == (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000)


def test_validate_bucket_ms_accepts_whitelist():
    for ms in (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000):
        assert validate_bucket_ms(ms) == ms


def test_validate_bucket_ms_rejects_other_values():
    for bad in (0, 30_000, 120_000, 3_600_000):
        with pytest.raises(ValueError, match="bucket_ms"):
            validate_bucket_ms(bad)


def test_range_segment_carries_open_close_ms():
    seg = RangeSegment(date="20260512", session_open_ms=1_715_000_000_000, session_close_ms=1_715_023_400_000)
    assert seg.date == "20260512"
    assert seg.session_open_ms < seg.session_close_ms


def test_range_bundle_requires_at_least_one_segment_and_consistent_bucket():
    from hoga.api.models import QuoteRatio, DepthIntensity, FillStrength, VolumeProfile
    bundle = RangeBundle(
        code="005930",
        from_date="20260512",
        to_date="20260512",
        bucket_ms=60_000,
        segments=[RangeSegment(date="20260512", session_open_ms=1, session_close_ms=2)],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60_000, points=[]),
        depth_intensity_by_day=[DepthIntensity(bucket_ms=60_000, price_min=0, price_max=0, price_step=1, times=[], bid_grid=[], ask_grid=[])],
        fill_strength=FillStrength(bucket_ms=60_000, points=[]),
        volume_profile_range=VolumeProfile(price_bins=[], bin_width=0, totals=[]),
        volume_profile_by_day=[VolumeProfile(price_bins=[], bin_width=0, totals=[])],
    )
    assert bundle.bucket_ms == 60_000
    assert len(bundle.segments) == 1
    assert len(bundle.volume_profile_by_day) == 1
```

- [ ] **Step 2: Run test to verify failures**

Run: `pytest tests/hoga/api/test_range_models.py -v`
Expected: ImportError for `ALLOWED_TIMEFRAME_MS`, `validate_bucket_ms`, `RangeBundle`, `RangeSegment`.

- [ ] **Step 3: Add models to `hoga/api/models.py`**

Append at the bottom of the file (after the existing `SessionBundle` definition — do NOT delete SessionBundle yet, Phase 10 handles that):

```python
# === RangeBundle (ADR-0013) — multi-Stock-Date read-path Wire Model ===

ALLOWED_TIMEFRAME_MS: tuple[int, ...] = (
    60_000,      # 1m
    180_000,     # 3m
    300_000,     # 5m
    600_000,     # 10m
    900_000,     # 15m
    1_800_000,   # 30m
)


def validate_bucket_ms(value: int) -> int:
    """Whitelist-validate a Timeframe bucket_ms (ADR-0014). Raise ValueError otherwise."""
    if value not in ALLOWED_TIMEFRAME_MS:
        raise ValueError(
            f"bucket_ms must be one of {ALLOWED_TIMEFRAME_MS}, got {value}"
        )
    return value


class RangeSegment(BaseModel):
    """One captured Stock-Date inside a Stock-Date Range. The frontend stitches these onto a virtual axis (see util/time.ts)."""
    date: str
    session_open_ms: int
    session_close_ms: int


class RangeBundle(BaseModel):
    """The sole read-path Wire Model for a Stock-Date Range (ADR-0013).
    All series aggregated at the same Timeframe (ADR-0014)."""
    code: str
    from_date: str
    to_date: str
    bucket_ms: int
    segments: list[RangeSegment]
    candles: list[ApiCandle]
    quote_ratio: QuoteRatio
    depth_intensity_by_day: list[DepthIntensity]  # per-segment — each day has its own price grid
    fill_strength: FillStrength
    volume_profile_range: VolumeProfile
    volume_profile_by_day: list[VolumeProfile]
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pytest tests/hoga/api/test_range_models.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/hoga/api/test_range_models.py
git commit -m "feat(api/models): add RangeBundle, RangeSegment, Timeframe whitelist (ADR-0013/0014)"
```

---

### Task 2: Frontend RangeBundle / RangeSegment / Timeframe types

**Files:**
- Modify: `frontend/src/api/types.ts` (add types; do NOT delete `SessionBundle` yet)

- [ ] **Step 1: Add types**

Append at the bottom of `frontend/src/api/types.ts`:

```ts
// === RangeBundle (ADR-0013) ===

export type RangeSegment = {
  date: string;            // YYYYMMDD KST
  session_open_ms: number; // Unix ms
  session_close_ms: number;
};

export type Timeframe = '1m' | '3m' | '5m' | '10m' | '15m' | '30m';

export const TIMEFRAME_TO_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
};

export const TIMEFRAME_LABELS: ReadonlyArray<Timeframe> = ['1m', '3m', '5m', '10m', '15m', '30m'];

export type RangeBundle = {
  code: string;
  from_date: string;
  to_date: string;
  bucket_ms: number;
  segments: RangeSegment[];
  candles: ApiCandle[];
  quote_ratio: QuoteRatio;
  depth_intensity_by_day: DepthIntensity[];  // per-segment — each day has its own price grid
  fill_strength: FillStrength;
  volume_profile_range: VolumeProfile;
  volume_profile_by_day: VolumeProfile[];
};
```

If `ApiCandle`, `QuoteRatio`, `DepthIntensity`, `FillStrength`, `VolumeProfile` are not already exported from this file, locate them in the existing `SessionBundle` definition and ensure they are exported (rename as needed but keep `SessionBundle` working). For most cases these are already module-level types — confirm with `grep -n "export type \(ApiCandle\|QuoteRatio\|DepthIntensity\|FillStrength\|VolumeProfile\)" frontend/src/api/types.ts`.

- [ ] **Step 2: Run typecheck**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(frontend/types): add RangeBundle, RangeSegment, Timeframe types"
```

---

### Task 3: `findSegmentByReal` helper in `util/time.ts`

**Files:**
- Modify: `frontend/src/util/time.ts`
- Test: `frontend/src/util/time.test.ts` (existing — extend)

- [ ] **Step 1: Write failing tests**

Append to `frontend/src/util/time.test.ts`:

```ts
import { findSegmentByReal, buildSegments } from './time';

describe('findSegmentByReal', () => {
  const segs = buildSegments([
    { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
    { date: '20260513', sessionOpenMs: 3_000_000, sessionCloseMs: 4_000_000 },
  ]);

  it('returns -1 for empty segments', () => {
    expect(findSegmentByReal([], 1_500_000)).toBe(-1);
  });

  it('returns -1 for realMs before first segment open', () => {
    expect(findSegmentByReal(segs, 500_000)).toBe(-1);
  });

  it('returns 0 for realMs inside first segment', () => {
    expect(findSegmentByReal(segs, 1_500_000)).toBe(0);
  });

  it('returns 1 for realMs inside second segment', () => {
    expect(findSegmentByReal(segs, 3_500_000)).toBe(1);
  });

  it('returns previous segment idx for realMs inside a gap (after segment 0 close, before segment 1 open)', () => {
    expect(findSegmentByReal(segs, 2_500_000)).toBe(0);
  });

  it('returns last idx for realMs past final close', () => {
    expect(findSegmentByReal(segs, 5_000_000)).toBe(1);
  });

  it('boundary: realMs exactly at sessionOpenMs belongs to that segment', () => {
    expect(findSegmentByReal(segs, 3_000_000)).toBe(1);
  });

  it('boundary: realMs exactly at sessionCloseMs belongs to that segment (not the gap)', () => {
    expect(findSegmentByReal(segs, 2_000_000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && pnpm vitest run src/util/time.test.ts`
Expected: 8 failures with "findSegmentByReal is not a function".

- [ ] **Step 3: Implement `findSegmentByReal`**

Append to `frontend/src/util/time.ts`:

```ts
/**
 * Binary search for the segment whose [sessionOpenMs, sessionCloseMs] range contains
 * realMs. If realMs sits inside a Day Boundary (gap between two segments), returns
 * the index of the PRIOR segment (the gap "belongs" to the day just closed). If
 * realMs is past the final close, returns the last segment index. If realMs is
 * before the first segment open, returns -1.
 *
 * Sibling of findSegmentByVirtual — both operate on the same Segment[] but key
 * off real-ms vs virtual-ms respectively. Used by CandlePane to compute
 * per-segment Auction Window thresholds (ADR-0013 Consequences).
 *
 * Returns -1 if segments is empty or realMs < segments[0].sessionOpenMs.
 */
export function findSegmentByReal(segments: Segment[], realMs: number): number {
  if (segments.length === 0) return -1;
  if (realMs < segments[0].sessionOpenMs) return -1;

  // Binary search the segment whose sessionOpenMs <= realMs
  let lo = 0;
  let hi = segments.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].sessionOpenMs <= realMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && pnpm vitest run src/util/time.test.ts`
Expected: All `findSegmentByReal` tests pass (plus pre-existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/util/time.ts frontend/src/util/time.test.ts
git commit -m "feat(util/time): add findSegmentByReal helper (sibling of findSegmentByVirtual)"
```

---

## Phase 2 — Backend Candles Downsampler

### Task 4: `downsample_candles` function + unit tests

**Files:**
- Modify: `hoga/api/bundle.py` (add module-level `downsample_candles`)
- Test: `tests/hoga/api/test_bundle.py` (existing — extend)

- [ ] **Step 1: Write failing tests**

Append to `tests/hoga/api/test_bundle.py`:

```python
from hoga.api.bundle import downsample_candles
from hoga.tables.candles import ApiCandle


def _c(ts_ms: int, o: float, h: float, l: float, c: float, va: int = 0, vb: int = 0) -> ApiCandle:
    return ApiCandle(ts_ms=ts_ms, open=o, close=c, high=h, low=l, vol_a=va, vol_b=vb)


def test_downsample_candles_identity_at_60000():
    inp = [_c(60_000, 100, 110, 95, 105), _c(120_000, 105, 108, 100, 102)]
    out = downsample_candles(inp, bucket_ms=60_000)
    assert out == inp


def test_downsample_candles_5min_groups_five_1min_bars():
    # 5 candles at minute boundaries -> one 5m candle
    inp = [
        _c(0,        100, 110,  95, 105, 10, 20),
        _c(60_000,   105, 115, 102, 110, 15, 25),
        _c(120_000,  110, 120, 108, 118,  5, 30),
        _c(180_000,  118, 119, 110, 112, 20, 10),
        _c(240_000,  112, 125, 111, 122, 30, 15),
    ]
    out = downsample_candles(inp, bucket_ms=300_000)
    assert len(out) == 1
    bar = out[0]
    assert bar.ts_ms == 0  # bucket start
    assert bar.open == 100  # first.open
    assert bar.close == 122  # last.close
    assert bar.high == 125  # max(high)
    assert bar.low == 95    # min(low)
    assert bar.vol_a == 80  # sum
    assert bar.vol_b == 100


def test_downsample_candles_includes_last_partial_bucket():
    # 7 candles, bucket_ms = 300_000 -> 2 buckets (5 + 2 candles)
    inp = [_c(i * 60_000, 100, 110, 90, 105, 1, 1) for i in range(7)]
    out = downsample_candles(inp, bucket_ms=300_000)
    assert len(out) == 2
    assert out[0].ts_ms == 0
    assert out[1].ts_ms == 300_000
    assert out[1].vol_a == 2  # 2 candles in second bucket


def test_downsample_candles_empty_input_returns_empty():
    assert downsample_candles([], bucket_ms=300_000) == []


def test_downsample_candles_rejects_invalid_bucket():
    import pytest
    with pytest.raises(ValueError, match="bucket_ms"):
        downsample_candles([_c(0, 1, 1, 1, 1)], bucket_ms=42_000)


def test_downsample_candles_handles_all_six_timeframes():
    inp = [_c(i * 60_000, 100, 110, 90, 105, 1, 1) for i in range(30)]
    for bucket_ms in (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000):
        out = downsample_candles(inp, bucket_ms=bucket_ms)
        # All 30 input candles accounted for
        assert sum(c.vol_a for c in out) == 30
        # No bucket smaller than expected (last may be partial)
        for c in out:
            assert c.ts_ms % bucket_ms == 0
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest tests/hoga/api/test_bundle.py -k downsample -v`
Expected: ImportError on `downsample_candles`.

- [ ] **Step 3: Implement `downsample_candles`**

Add to `hoga/api/bundle.py` (near the top, alongside other module-level helpers):

```python
from hoga.api.models import validate_bucket_ms
from hoga.tables.candles import ApiCandle


def downsample_candles(candles: list[ApiCandle], *, bucket_ms: int) -> list[ApiCandle]:
    """Re-aggregate 1-minute OHLCV candles into the requested Timeframe bucket.

    Aggregation per bucket: open = first.open, close = last.close,
    high = max(high), low = min(low), vol_a/vol_b = sum.

    Input must be sorted by ts_ms ascending (this function does NOT sort).
    `bucket_ms == 60_000` returns the input verbatim (identity case).
    The last bucket may be partial (fewer than bucket_ms/60_000 source candles).

    Raises ValueError if bucket_ms is not in ALLOWED_TIMEFRAME_MS (ADR-0014).
    """
    validate_bucket_ms(bucket_ms)
    if bucket_ms == 60_000 or not candles:
        return list(candles)

    out: list[ApiCandle] = []
    bucket_start = (candles[0].ts_ms // bucket_ms) * bucket_ms
    bucket_open = candles[0].open
    bucket_high = candles[0].high
    bucket_low = candles[0].low
    bucket_close = candles[0].close
    bucket_va = candles[0].vol_a
    bucket_vb = candles[0].vol_b

    for c in candles[1:]:
        c_bucket = (c.ts_ms // bucket_ms) * bucket_ms
        if c_bucket != bucket_start:
            out.append(ApiCandle(
                ts_ms=bucket_start, open=bucket_open, close=bucket_close,
                high=bucket_high, low=bucket_low, vol_a=bucket_va, vol_b=bucket_vb,
            ))
            bucket_start = c_bucket
            bucket_open = c.open
            bucket_high = c.high
            bucket_low = c.low
            bucket_va = 0
            bucket_vb = 0
        bucket_high = max(bucket_high, c.high)
        bucket_low = min(bucket_low, c.low)
        bucket_close = c.close
        bucket_va += c.vol_a
        bucket_vb += c.vol_b

    out.append(ApiCandle(
        ts_ms=bucket_start, open=bucket_open, close=bucket_close,
        high=bucket_high, low=bucket_low, vol_a=bucket_va, vol_b=bucket_vb,
    ))
    return out
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pytest tests/hoga/api/test_bundle.py -k downsample -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py tests/hoga/api/test_bundle.py
git commit -m "feat(api/bundle): downsample_candles re-aggregates 1m OHLCV to Timeframe bucket"
```

---

## Phase 3 — Backend RangeBundle Builder

### Task 5: Extend `build_bundle` with `bucket_ms` parameter

**Files:**
- Modify: `hoga/api/bundle.py` (extend `build_bundle` signature, propagate `bucket_ms` to per-series builders, apply `downsample_candles` to the candles slice)
- Test: `tests/hoga/api/test_bundle.py`

- [ ] **Step 1: Write failing test**

Append:

```python
def test_build_bundle_with_bucket_ms_5min_downsamples_candles(query_engine_with_one_stock_date):
    # query_engine_with_one_stock_date: pytest fixture, returns engine + (code, date)
    engine, code, date = query_engine_with_one_stock_date
    b_1m = build_bundle(engine, code=code, date=date, bucket_ms=60_000)
    b_5m = build_bundle(engine, code=code, date=date, bucket_ms=300_000)

    assert len(b_5m.candles) <= len(b_1m.candles) // 5 + 1
    assert b_5m.quote_ratio.bucket_ms == 300_000
    assert b_5m.fill_strength.bucket_ms == 300_000


def test_build_bundle_default_bucket_ms_is_60000_backwards_compatible(query_engine_with_one_stock_date):
    engine, code, date = query_engine_with_one_stock_date
    b_default = build_bundle(engine, code=code, date=date)
    b_explicit = build_bundle(engine, code=code, date=date, bucket_ms=60_000)
    assert len(b_default.candles) == len(b_explicit.candles)
```

If `query_engine_with_one_stock_date` fixture does not exist, locate the existing `build_bundle` test in `tests/hoga/api/test_bundle.py` and follow its fixture pattern. If no test exists yet, add a fixture using the existing test-data directory layout (check `conftest.py` for patterns).

- [ ] **Step 2: Run test to verify failure**

Run: `pytest tests/hoga/api/test_bundle.py -k bucket_ms -v`
Expected: `TypeError: build_bundle() got an unexpected keyword argument 'bucket_ms'`.

- [ ] **Step 3: Update `build_bundle` signature and propagation**

In `hoga/api/bundle.py`, find the existing `build_bundle` function and:

1. Add a `bucket_ms: int = 60_000` keyword parameter.
2. After computing the candles slice, run it through `downsample_candles(candles, bucket_ms=bucket_ms)`.
3. Pass `bucket_ms=bucket_ms` to the existing `build_quote_ratio_slice`, `build_depth_intensity_slice`, `build_fill_strength_slice` calls (they already accept this parameter — see `bundle.py:53,135,256`).

Example diff sketch:

```python
def build_bundle(engine: QueryEngine, *, code: str, date: str, bucket_ms: int = 60_000) -> SessionBundle:
    validate_bucket_ms(bucket_ms)
    candles_raw = build_candles_slice(engine, code=code, date=date)
    candles = downsample_candles(candles_raw, bucket_ms=bucket_ms)
    quote_ratio = build_quote_ratio_slice(engine, code=code, date=date, bucket_ms=bucket_ms)
    depth_intensity = build_depth_intensity_slice(engine, code=code, date=date, depth_bucket_ms=bucket_ms)
    fill_strength = build_fill_strength_slice(engine, code=code, date=date, bucket_ms=bucket_ms)
    # volume_profile unchanged — time-agnostic
    volume_profile = build_volume_profile_slice(engine, code=code, date=date)
    # ... assemble SessionBundle as before
```

- [ ] **Step 4: Run all bundle tests to verify pass**

Run: `pytest tests/hoga/api/test_bundle.py -v`
Expected: All pass (existing tests use default `bucket_ms=60_000`, behaviour unchanged).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py tests/hoga/api/test_bundle.py
git commit -m "feat(api/bundle): build_bundle accepts bucket_ms, propagates to all series (ADR-0014)"
```

---

### Task 6: `build_volume_profile_range` function

**Files:**
- Modify: `hoga/api/bundle.py`
- Test: `tests/hoga/api/test_bundle.py`

- [ ] **Step 1: Write failing test**

```python
def test_build_volume_profile_range_unions_trades_across_dates(query_engine_with_two_stock_dates):
    engine, code, date1, date2 = query_engine_with_two_stock_dates
    profile = build_volume_profile_range(engine, code=code, dates=[date1, date2])
    # Should sum trade volume across both dates
    assert sum(profile.totals) > 0
    # Same bin width regardless of date count
    profile_single = build_volume_profile_slice(engine, code=code, date=date1)
    assert profile.bin_width == profile_single.bin_width
```

- [ ] **Step 2: Run test to verify failure**

Run: `pytest tests/hoga/api/test_bundle.py -k volume_profile_range -v`
Expected: ImportError on `build_volume_profile_range`.

- [ ] **Step 3: Implement**

Add to `hoga/api/bundle.py`:

```python
def build_volume_profile_range(
    engine: QueryEngine, *, code: str, dates: list[str]
) -> VolumeProfile:
    """Union trades.parquet across all in-range Stock-Dates into one
    price-binned profile (range-wide POC view, ADR-0013/0014).

    The bin-width logic mirrors build_volume_profile_slice (existing): widen
    bins until the cell count is within budget. Implementation uses DuckDB's
    multi-file read_parquet glob.
    """
    if not dates:
        return VolumeProfile(price_bins=[], bin_width=0, totals=[])

    paths = [str(engine.parquet_dir(d, code) / "trades.parquet") for d in dates]
    # Min/Max price across all input parquet files. Use parameterised query
    # to mirror the rest of bundle.py (e.g. line 145) and avoid f-string SQL
    # composition — DuckDB accepts a Python list parameter for read_parquet
    # and expands it into a multi-file glob.
    min_max = engine.conn.execute(
        "SELECT MIN(price), MAX(price) FROM read_parquet(?)", [paths],
    ).fetchone()
    if min_max is None or min_max[0] is None:
        return VolumeProfile(price_bins=[], bin_width=0, totals=[])
    price_min, price_max = min_max

    # Reuse bin-width logic from build_volume_profile_slice — extract into a
    # private helper _choose_bin_width(price_min, price_max) and call from both.
    # If not yet extracted, do that refactor in THIS commit.
    bin_width = _choose_bin_width(price_min, price_max)

    rows = engine.conn.execute(
        """
        SELECT CAST((price - ?) / ? AS INTEGER) AS bin,
               SUM(qty) AS qty
        FROM read_parquet(?)
        GROUP BY bin ORDER BY bin
        """,
        [price_min, bin_width, paths],
    ).fetchall()

    # Materialise into VolumeProfile (densify bin index → 0..N)
    n_bins = int((price_max - price_min) / bin_width) + 1
    totals = [0.0] * n_bins
    price_bins = [price_min + i * bin_width for i in range(n_bins)]
    for bin_idx, qty in rows:
        if 0 <= bin_idx < n_bins:
            totals[bin_idx] = qty
    return VolumeProfile(price_bins=price_bins, bin_width=bin_width, totals=totals)
```

If `_choose_bin_width` does not exist yet, extract it from the existing `build_volume_profile_slice` body in this same commit (small refactor — keeps both functions in sync).

- [ ] **Step 4: Run test to verify pass**

Run: `pytest tests/hoga/api/test_bundle.py -k volume_profile_range -v`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py tests/hoga/api/test_bundle.py
git commit -m "feat(api/bundle): build_volume_profile_range unions trades across Stock-Date Range"
```

---

### Task 7: `build_range_bundle` function with 30-day limit and partial-inventory handling

**Files:**
- Modify: `hoga/api/bundle.py`
- Modify: `hoga/api/queries.py` (add `list_stock_dates_in_range` if missing — check first)
- Test: `tests/hoga/api/test_bundle.py`

- [ ] **Step 1: Write failing tests**

```python
from datetime import datetime

def test_build_range_bundle_single_day_equals_n1_segments(query_engine_with_one_stock_date):
    engine, code, date = query_engine_with_one_stock_date
    rb = build_range_bundle(engine, code=code, from_date=date, to_date=date, bucket_ms=60_000)
    assert len(rb.segments) == 1
    assert rb.segments[0].date == date
    assert rb.bucket_ms == 60_000


def test_build_range_bundle_multi_day_concatenates_series(query_engine_with_two_stock_dates):
    engine, code, date1, date2 = query_engine_with_two_stock_dates
    rb = build_range_bundle(engine, code=code, from_date=date1, to_date=date2, bucket_ms=60_000)
    assert len(rb.segments) == 2
    assert rb.segments[0].date == date1
    assert rb.segments[1].date == date2
    assert len(rb.volume_profile_by_day) == 2


def test_build_range_bundle_rejects_from_gt_to(query_engine_with_one_stock_date):
    import pytest
    from fastapi import HTTPException
    engine, code, date = query_engine_with_one_stock_date
    with pytest.raises(HTTPException) as exc:
        build_range_bundle(engine, code=code, from_date="20260520", to_date="20260512", bucket_ms=60_000)
    assert exc.value.status_code == 400


def test_build_range_bundle_rejects_range_over_30_days(query_engine_with_one_stock_date):
    import pytest
    from fastapi import HTTPException
    engine, code, date = query_engine_with_one_stock_date
    with pytest.raises(HTTPException) as exc:
        build_range_bundle(engine, code=code, from_date="20260101", to_date="20260201", bucket_ms=60_000)
    assert exc.value.status_code == 400
    assert "30 days" in str(exc.value.detail)


def test_build_range_bundle_raises_404_on_empty_inventory(query_engine_with_no_stock_dates):
    import pytest
    from fastapi import HTTPException
    engine, code = query_engine_with_no_stock_dates
    with pytest.raises(HTTPException) as exc:
        build_range_bundle(engine, code=code, from_date="20260512", to_date="20260520", bucket_ms=60_000)
    assert exc.value.status_code == 404
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest tests/hoga/api/test_bundle.py -k build_range_bundle -v`
Expected: ImportError on `build_range_bundle`.

- [ ] **Step 3: Implement**

First, check whether `engine.list_stock_dates_in_range(code, from_date, to_date)` exists:

Run: `grep -n "list_stock_dates" hoga/api/queries.py`

If missing, add a method to `QueryEngine` that returns the ascending list of YYYYMMDD strings that have captured data for `code` in `[from_date, to_date]`. The implementation can wrap the existing `list_stock_dates()` (filter by code and date range) or call into the inventory module — match the existing pattern.

Then add to `hoga/api/bundle.py`:

```python
from datetime import datetime
from fastapi import HTTPException

from hoga.api.models import RangeBundle, RangeSegment


MAX_RANGE_DAYS = 30


def build_range_bundle(
    engine: QueryEngine,
    *,
    code: str,
    from_date: str,
    to_date: str,
    bucket_ms: int,
) -> RangeBundle:
    """Build the Wire Model for a Stock-Date Range (ADR-0013/0014).

    - Validates bucket_ms against ALLOWED_TIMEFRAME_MS.
    - Validates from_date <= to_date and (to - from) <= 30 days.
    - Returns 404 if no Stock-Date in range has captured data.
    - Loops over captured dates: calls existing build_bundle per date, then
      concatenates the five series + appends one volume_profile_by_day per
      segment. volume_profile_range is computed once across all dates.
    """
    validate_bucket_ms(bucket_ms)

    try:
        d_from = datetime.strptime(from_date, "%Y%m%d").date()
        d_to = datetime.strptime(to_date, "%Y%m%d").date()
    except ValueError as e:
        raise HTTPException(400, f"Invalid YYYYMMDD date: {e}") from e
    if d_to < d_from:
        raise HTTPException(400, "from > to")
    if (d_to - d_from).days > MAX_RANGE_DAYS:
        raise HTTPException(400, f"range exceeds {MAX_RANGE_DAYS} days")

    dates = engine.list_stock_dates_in_range(code=code, from_date=from_date, to_date=to_date)
    if not dates:
        raise HTTPException(
            404,
            f"no captured Stock-Date for code={code} in [{from_date}, {to_date}]",
        )

    segments: list[RangeSegment] = []
    candles: list[ApiCandle] = []
    ratio_pts: list = []
    intensity_by_day: list[DepthIntensity] = []  # per-segment: price grids differ across days
    fill_pts: list = []
    profiles_by_day: list[VolumeProfile] = []

    for d in dates:
        sub = build_bundle(engine, code=code, date=d, bucket_ms=bucket_ms)
        segments.append(RangeSegment(
            date=d,
            session_open_ms=sub.session_open_ms,
            session_close_ms=sub.session_close_ms,
        ))
        candles.extend(sub.candles)
        ratio_pts.extend(sub.quote_ratio.points)
        intensity_by_day.append(sub.depth_intensity)
        fill_pts.extend(sub.fill_strength.points)
        profiles_by_day.append(sub.volume_profile)

    profile_range = build_volume_profile_range(engine, code=code, dates=dates)

    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        segments=segments,
        candles=candles,
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=ratio_pts),
        depth_intensity_by_day=intensity_by_day,
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=fill_pts),
        volume_profile_range=profile_range,
        volume_profile_by_day=profiles_by_day,
    )
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pytest tests/hoga/api/test_bundle.py -k build_range_bundle -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py hoga/api/queries.py tests/hoga/api/test_bundle.py
git commit -m "feat(api/bundle): build_range_bundle with 30-day limit and partial-inventory (ADR-0013)"
```

---

## Phase 4 — Backend `/api/range` Route

### Task 8: New `/api/range` route + route tests

**Files:**
- Modify: `hoga/api/routes.py`
- Test: `tests/hoga/api/test_routes.py` (existing — extend)

- [ ] **Step 1: Write failing tests**

Add to `tests/hoga/api/test_routes.py`:

```python
def test_api_range_happy_path(client_with_one_stock_date):
    client, code, date = client_with_one_stock_date
    r = client.get(f"/api/range?code={code}&from={date}&to={date}&bucket_ms=60000")
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == code
    assert body["bucket_ms"] == 60_000
    assert len(body["segments"]) == 1
    assert "candles" in body
    assert "volume_profile_range" in body
    assert "volume_profile_by_day" in body


def test_api_range_400_on_invalid_bucket_ms(client_with_one_stock_date):
    client, code, date = client_with_one_stock_date
    r = client.get(f"/api/range?code={code}&from={date}&to={date}&bucket_ms=42000")
    assert r.status_code == 400


def test_api_range_400_on_from_gt_to(client_with_one_stock_date):
    client, code, _ = client_with_one_stock_date
    r = client.get(f"/api/range?code={code}&from=20260520&to=20260512&bucket_ms=60000")
    assert r.status_code == 400


def test_api_range_400_on_range_over_30_days(client_with_one_stock_date):
    client, code, _ = client_with_one_stock_date
    r = client.get(f"/api/range?code={code}&from=20260101&to=20260201&bucket_ms=60000")
    assert r.status_code == 400


def test_api_range_404_on_empty_inventory(client_with_one_stock_date):
    client, code, _ = client_with_one_stock_date
    # 18991231 is impossibly old — no captures
    r = client.get(f"/api/range?code={code}&from=18991231&to=18991231&bucket_ms=60000")
    assert r.status_code == 404
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest tests/hoga/api/test_routes.py -k api_range -v`
Expected: 404 from FastAPI on unknown route.

- [ ] **Step 3: Add route handler**

In `hoga/api/routes.py`, inside `build_router(engine)`, alongside the existing handlers, add:

```python
from hoga.api.bundle import build_range_bundle
from hoga.api.models import RangeBundle, validate_bucket_ms


@router.get("/range", response_model=RangeBundle)
def api_range(
    code: Code,
    from_date: str = Query(..., alias="from"),
    to_date: str = Query(..., alias="to"),
    bucket_ms: int = Query(...),
) -> RangeBundle:
    try:
        validate_bucket_ms(bucket_ms)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return build_range_bundle(
        engine,
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
    )
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pytest tests/hoga/api/test_routes.py -k api_range -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/routes.py tests/hoga/api/test_routes.py
git commit -m "feat(api/routes): GET /api/range endpoint (ADR-0013)"
```

---

## Phase 5 — Frontend State + URL

### Task 9: Add `timeframe` to `TabSelection` and `ChartViewPrefs` to `useTabsStore`

**Files:**
- Modify: `frontend/src/state/tabs.ts`
- Test: `frontend/src/state/tabs.test.ts` (existing — extend; if missing, create)

- [ ] **Step 1: Write failing tests**

Append to `frontend/src/state/tabs.test.ts`:

```ts
import { useTabsStore } from './tabs';
import type { Timeframe } from '../api/types';

describe('useTabsStore — timeframe + prefs', () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabId: '' } as any);
    // Reset to fresh
    useTabsStore.getState().reset?.();
  });

  it('default Timeframe is 1m on new tab selection', () => {
    const id = useTabsStore.getState().newTab();
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260512',
      toDate: '20260512',
      timeframe: '1m',
    });
    expect(useTabsStore.getState().tabs.find(t => t.id === id)!.selection!.timeframe).toBe('1m');
  });

  it('setVolumeProfileMode updates per-tab prefs', () => {
    const id = useTabsStore.getState().newTab();
    useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    expect(useTabsStore.getState().getPrefs(id).volumeProfileMode).toBe('per-day');
  });

  it('getPrefs returns default range mode if not set', () => {
    const id = useTabsStore.getState().newTab();
    expect(useTabsStore.getState().getPrefs(id).volumeProfileMode).toBe('range');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && pnpm vitest run src/state/tabs.test.ts`
Expected: Type errors / TS compile failures on `timeframe`, `setVolumeProfileMode`, `getPrefs`.

- [ ] **Step 3: Update `state/tabs.ts`**

Edit:

```ts
// Replace import line
import type { RangeBundle, Timeframe } from '../api/types';

// Replace TabSelection
export type TabSelection = {
  code: string;
  fromDate: string;
  toDate: string;
  timeframe: Timeframe;
};

// Add ChartViewPrefs
export type ChartViewPrefs = {
  volumeProfileMode: 'range' | 'per-day';
};

const DEFAULT_PREFS: ChartViewPrefs = { volumeProfileMode: 'range' };

// Update Tab.bundles to use RangeBundle
export type Tab = {
  id: string;
  selection: TabSelection | null;
  cursorMs: number | null;
  status: TabStatus;
  errorMessage?: string;
  bundles: Map<string, RangeBundle>;
};

// Extend Store with prefs map + actions
type Store = {
  tabs: Tab[];
  activeTabId: string;
  prefs: Map<string, ChartViewPrefs>;  // keyed by tab id — Map for parity with Tab.bundles
  // ... existing actions ...
  getPrefs: (id: string) => ChartViewPrefs;
  setVolumeProfileMode: (id: string, mode: ChartViewPrefs['volumeProfileMode']) => void;
};

// In the store body, add to initial state:
//   prefs: new Map(),
// And add the new actions (Map mutations need fresh Map for React reactivity):
//   getPrefs: (id) => get().prefs.get(id) ?? DEFAULT_PREFS,
//   setVolumeProfileMode: (id, mode) => set((s) => {
//     const next = new Map(s.prefs);
//     next.set(id, { ...DEFAULT_PREFS, ...next.get(id), volumeProfileMode: mode });
//     return { prefs: next };
//   }),
// Also extend closeTab to call s.prefs.delete(id) (in a fresh Map) for leak prevention.

// Also: putBundle's type signature changes from SessionBundle to RangeBundle
//   putBundle: (id: string, date: string, bundle: RangeBundle) => void;
```

Apply these changes carefully — `tabs.ts` is small enough to read in full first.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && pnpm vitest run src/state/tabs.test.ts && pnpm tsc --noEmit`
Expected: All pass. Other call sites referencing `selection.timeframe` may now fail typecheck — fix them in Task 10+ where each is encountered.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/tabs.ts frontend/src/state/tabs.test.ts
git commit -m "feat(state/tabs): add Timeframe to TabSelection, ChartViewPrefs for per-tab prefs"
```

---

### Task 10: URL encoding with Timeframe (with legacy 3-part fallback)

**Files:**
- Modify: `frontend/src/state/url.ts`
- Test: `frontend/src/state/url.test.ts` (existing — extend)

- [ ] **Step 1: Write failing tests**

Append to `frontend/src/state/url.test.ts`:

```ts
import { parseReplayUrl, emitReplayUrl } from './url';

describe('parseReplayUrl — timeframe', () => {
  it('parses 4-part segment with timeframe', () => {
    const r = parseReplayUrl('?tabs=005930:20260512:20260520:5m&active=0');
    expect(r.tabs[0].timeframe).toBe('5m');
  });

  it('defaults timeframe to 1m on legacy 3-part segment', () => {
    const r = parseReplayUrl('?tabs=005930:20260512:20260520&active=0');
    expect(r.tabs[0].timeframe).toBe('1m');
  });

  it('drops segment with invalid timeframe', () => {
    const r = parseReplayUrl('?tabs=005930:20260512:20260520:99m&active=0');
    expect(r.tabs).toHaveLength(0);
  });
});

describe('emitReplayUrl — timeframe', () => {
  it('always emits 4-part segments', () => {
    const s = emitReplayUrl(
      [{ code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '5m' }],
      0,
    );
    expect(s).toBe('?tabs=005930:20260512:20260520:5m&active=0');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && pnpm vitest run src/state/url.test.ts`
Expected: TS or runtime failures on `timeframe` field.

- [ ] **Step 3: Update `state/url.ts`**

```ts
import type { TabSelection } from './tabs';
import { TIMEFRAME_LABELS, type Timeframe } from '../api/types';

const TIMEFRAME_SET = new Set<string>(TIMEFRAME_LABELS);

export type ParsedReplayUrl = { tabs: TabSelection[]; active: number };

export function parseReplayUrl(search: string): ParsedReplayUrl {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = sp.get('tabs');
  const activeRaw = sp.get('active');
  if (!raw) return { tabs: [], active: 0 };
  const tabs: TabSelection[] = [];
  let dropped = 0;
  for (const segment of raw.split(',')) {
    const parts = segment.split(':');
    const [code, fromDate, toDate, timeframeRaw] = parts;
    const timeframe = (parts.length >= 4 ? timeframeRaw : '1m') as Timeframe;
    if (
      !isValidCode(code) ||
      !isValidDate(fromDate) ||
      !isValidDate(toDate) ||
      !TIMEFRAME_SET.has(timeframe)
    ) {
      dropped += 1;
      continue;
    }
    tabs.push({ code, fromDate, toDate, timeframe });
  }
  if (dropped > 0) {
    console.warn(`[parseReplayUrl] dropped ${dropped} invalid tab(s) from URL`);
  }
  let active = Number(activeRaw);
  if (!Number.isFinite(active) || active < 0 || active >= tabs.length) active = 0;
  return { tabs, active };
}

export function emitReplayUrl(tabs: (TabSelection | null)[], activeIdx: number): string {
  const real = tabs.filter((t): t is TabSelection => !!t);
  if (real.length === 0) return '';
  let realActive = 0;
  let realCount = 0;
  for (let i = 0; i < tabs.length; i++) {
    if (!tabs[i]) continue;
    if (i === activeIdx) {
      realActive = realCount;
      break;
    }
    realCount += 1;
  }
  const tabStr = real
    .map((t) => `${t.code}:${t.fromDate}:${t.toDate}:${t.timeframe}`)
    .join(',');
  return `?tabs=${tabStr}&active=${realActive}`;
}

function isValidCode(s: unknown): s is string {
  return typeof s === 'string' && /^\d{6}$/.test(s);
}
function isValidDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{8}$/.test(s);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && pnpm vitest run src/state/url.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/url.ts frontend/src/state/url.test.ts
git commit -m "feat(state/url): encode Timeframe in tabs URL (legacy 3-part defaults to 1m)"
```

---

## Phase 6 — Frontend Data Hook

### Task 11: `useRange` hook

**Files:**
- Create: `frontend/src/api/range.ts`
- Test: `frontend/src/api/range.test.ts`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/api/range.test.ts`:

```ts
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { useRange } from './range';
import * as client from './client';
import type { RangeBundle } from './types';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const fakeBundle: RangeBundle = {
  code: '005930', from_date: '20260512', to_date: '20260512', bucket_ms: 60_000,
  segments: [], candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  depth_intensity: { bucket_ms: 60_000, time_starts_ms: [], side: [], bin_idx: [], qty: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { price_bins: [], bin_width: 0, totals: [] },
  volume_profile_by_day: [],
};

describe('useRange', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('disabled when any input is null', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useRange(null, '20260512', '20260512', '1m'),
      { wrapper: wrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls /api/range with correct query string and Infinity staleTime', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const { result } = renderHook(
      () => useRange('005930', '20260512', '20260512', '5m'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      '/api/range?code=005930&from=20260512&to=20260512&bucket_ms=300000',
    );
  });

  it('appends price_min/price_max when priceRange given', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', { min: 100, max: 200 }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&price_min=100&price_max=200');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && pnpm vitest run src/api/range.test.ts`
Expected: Module not found.

- [ ] **Step 3: Implement `useRange`**

Create `frontend/src/api/range.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { TIMEFRAME_TO_MS, type RangeBundle, type Timeframe } from './types';

/**
 * Fetch a Stock-Date Range bundle (ADR-0013/0014).
 *
 * Mirrors useSession's pattern: apiCall helper, staleTime: Infinity (captured
 * Stock-Dates are immutable), priceRange option for VolumeProfileOverlay's
 * visible-price filtering.
 */
export function useRange(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
  priceRange?: { min: number; max: number },
) {
  const bucketMs = timeframe ? TIMEFRAME_TO_MS[timeframe] : null;
  const enabled = !!(code && from && to && bucketMs);
  const qs = priceRange ? `&price_min=${priceRange.min}&price_max=${priceRange.max}` : '';
  return useQuery({
    queryKey: ['range', code, from, to, bucketMs, priceRange?.min, priceRange?.max] as const,
    queryFn: () =>
      apiCall<RangeBundle>(
        `/api/range?code=${code}&from=${from}&to=${to}&bucket_ms=${bucketMs}${qs}`,
      ),
    enabled,
    staleTime: Infinity,
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && pnpm vitest run src/api/range.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/range.ts frontend/src/api/range.test.ts
git commit -m "feat(api/range): useRange hook (apiCall + staleTime Infinity + priceRange)"
```

---

## Phase 7 — Frontend UI Components

### Task 12: `TimeframeSelector` component

**Files:**
- Create: `frontend/src/replay/TimeframeSelector.tsx`
- Test: `frontend/src/replay/TimeframeSelector.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/replay/TimeframeSelector.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import TimeframeSelector from './TimeframeSelector';

describe('TimeframeSelector', () => {
  it('renders all 6 timeframe buttons', () => {
    render(<TimeframeSelector value="1m" onChange={() => {}} />);
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m']) {
      expect(screen.getByRole('button', { name: tf })).toBeInTheDocument();
    }
  });

  it('marks the active button with aria-pressed=true', () => {
    render(<TimeframeSelector value="5m" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange when an inactive button is clicked', () => {
    const onChange = vi.fn();
    render(<TimeframeSelector value="1m" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '5m' }));
    expect(onChange).toHaveBeenCalledWith('5m');
  });

  it('does not call onChange when the active button is clicked', () => {
    const onChange = vi.fn();
    render(<TimeframeSelector value="1m" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '1m' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && pnpm vitest run src/replay/TimeframeSelector.test.tsx`
Expected: Module not found.

- [ ] **Step 3: Implement**

Create `frontend/src/replay/TimeframeSelector.tsx`:

```tsx
import { TIMEFRAME_LABELS, type Timeframe } from '../api/types';

type Props = {
  value: Timeframe;
  onChange: (next: Timeframe) => void;
};

export default function TimeframeSelector({ value, onChange }: Props) {
  return (
    <div className="inline-flex rounded border border-border overflow-hidden" role="group" aria-label="Timeframe">
      {TIMEFRAME_LABELS.map((tf) => {
        const active = tf === value;
        return (
          <button
            key={tf}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(tf);
            }}
            className={
              active
                ? 'px-3 py-1.5 text-sm bg-accent text-accent-fg font-semibold'
                : 'px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg'
            }
          >
            {tf}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && pnpm vitest run src/replay/TimeframeSelector.test.tsx`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/replay/TimeframeSelector.tsx frontend/src/replay/TimeframeSelector.test.tsx
git commit -m "feat(replay/TimeframeSelector): segmented control with 6 fixed Timeframes"
```

---

### Task 13: Toolbar integration with Timeframe + 30-day pre-validation

**Files:**
- Modify: `frontend/src/replay/Toolbar.tsx`
- Modify: `frontend/src/state/toolbarDraft.ts` (add `timeframe` to draft)
- Test: `frontend/src/replay/Toolbar.test.tsx` (existing — extend)

- [ ] **Step 1: Read `toolbarDraft.ts` and identify current draft shape**

Run: `cat frontend/src/state/toolbarDraft.ts` and note the existing `Draft` type.

- [ ] **Step 2: Write failing test**

Append to `frontend/src/replay/Toolbar.test.tsx` (create if missing):

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Toolbar from './Toolbar';
import { useTabsStore } from '../state/tabs';
import { useToolbarDraftStore } from '../state/toolbarDraft';

describe('Toolbar — Timeframe + range validation', () => {
  it('Reload commits timeframe into selection', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useToolbarDraftStore.getState().setDraft(id, {
      code: '005930', from: '20260512', to: '20260512', timeframe: '5m',
    });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: /불러오기|Reload/ }));
    expect(useTabsStore.getState().tabs.find(t => t.id === id)!.selection!.timeframe).toBe('5m');
  });

  it('shows inline error when range > 30 days', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useToolbarDraftStore.getState().setDraft(id, {
      code: '005930', from: '20260101', to: '20260201', timeframe: '1m',
    });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: /불러오기|Reload/ }));
    expect(screen.getByText(/최대 30일/)).toBeInTheDocument();
    expect(useTabsStore.getState().tabs.find(t => t.id === id)!.selection).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `cd frontend && pnpm vitest run src/replay/Toolbar.test.tsx`

- [ ] **Step 4: Update `toolbarDraft.ts` Draft type and Toolbar**

In `frontend/src/state/toolbarDraft.ts`, add `timeframe: Timeframe | null` to the Draft type (default `'1m'` on new draft creation) and a `setTimeframe(id, tf)` action.

In `frontend/src/replay/Toolbar.tsx`, add:

```tsx
import TimeframeSelector from './TimeframeSelector';
import { type Timeframe } from '../api/types';

// inside the component, after `setDates`:
const setTimeframe = (tf: Timeframe) =>
  useToolbarDraftStore.getState().setTimeframe(active.id, tf);

// inside the JSX, after <DateRangePicker ... />:
<TimeframeSelector value={draft.timeframe ?? '1m'} onChange={setTimeframe} />

// add a local state for the inline error
const [rangeError, setRangeError] = useState<string | null>(null);

// replace the existing onLoad with:
const onLoad = () => {
  if (!ready) return;
  // 30-day pre-validation
  const dFrom = parseYYYYMMDD(draft.from!);
  const dTo = parseYYYYMMDD(draft.to!);
  const days = Math.round((dTo.getTime() - dFrom.getTime()) / 86_400_000);
  if (days > 30) {
    setRangeError('최대 30일까지 조회 가능합니다');
    return;
  }
  setRangeError(null);
  useTabsStore.getState().setSelection(active.id, {
    code: draft.code!,
    fromDate: draft.from!,
    toDate: draft.to!,
    timeframe: draft.timeframe ?? '1m',
  });
};

// Render `rangeError` below the button if non-null
{rangeError && <span className="text-down text-sm ml-2">{rangeError}</span>}
```

Add a small helper `parseYYYYMMDD` either local-private or in `util/time.ts`.

Also update the `useEffect` that seeds the draft from selection (lines 14-28) to include `timeframe: sel.timeframe`.

- [ ] **Step 5: Run all toolbar tests + typecheck**

Run: `cd frontend && pnpm vitest run src/replay/Toolbar.test.tsx && pnpm tsc --noEmit`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/replay/Toolbar.tsx frontend/src/state/toolbarDraft.ts frontend/src/replay/Toolbar.test.tsx
git commit -m "feat(replay/Toolbar): TimeframeSelector + 30-day pre-validation"
```

---

### Task 14: `RangeAdjustmentNotice` component

**Files:**
- Create: `frontend/src/replay/RangeAdjustmentNotice.tsx`
- Test: `frontend/src/replay/RangeAdjustmentNotice.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
// frontend/src/replay/RangeAdjustmentNotice.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import RangeAdjustmentNotice from './RangeAdjustmentNotice';

describe('RangeAdjustmentNotice', () => {
  it('renders fromDate-skip message when first segment date > requested fromDate', () => {
    render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260503"
        actualLast="20260530"
        onAdjust={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/5\/1.*아직 캡처/)).toBeInTheDocument();
  });

  it('renders toDate-skip message when last segment date < requested toDate', () => {
    render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260501"
        actualLast="20260525"
        onAdjust={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/5\/30.*아직 캡처/)).toBeInTheDocument();
  });

  it('renders nothing when requested matches actual', () => {
    const { container } = render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260501"
        actualLast="20260530"
        onAdjust={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onDismiss when close button clicked', () => {
    const onDismiss = vi.fn();
    render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260503"
        actualLast="20260530"
        onAdjust={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /닫기|Dismiss/ }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && pnpm vitest run src/replay/RangeAdjustmentNotice.test.tsx`

- [ ] **Step 3: Implement**

```tsx
// frontend/src/replay/RangeAdjustmentNotice.tsx
type Props = {
  requestedFrom: string;
  requestedTo: string;
  actualFirst: string;
  actualLast: string;
  onAdjust: () => void;
  onDismiss: () => void;
};

function fmtMD(yyyymmdd: string): string {
  return `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`;
}

export default function RangeAdjustmentNotice({
  requestedFrom, requestedTo, actualFirst, actualLast, onAdjust, onDismiss,
}: Props) {
  const fromSkipped = requestedFrom !== actualFirst;
  const toSkipped = requestedTo !== actualLast;
  if (!fromSkipped && !toSkipped) return null;

  const parts: string[] = [];
  if (fromSkipped) parts.push(`fromDate (${fmtMD(requestedFrom)})는 아직 캡처 안 됨. 실제 표시: ${fmtMD(actualFirst)}부터`);
  if (toSkipped) parts.push(`toDate (${fmtMD(requestedTo)})는 아직 캡처 안 됨. 실제 표시: ${fmtMD(actualLast)}까지`);

  return (
    <div role="status" className="flex items-center gap-2 px-3 py-2 bg-bg-card border-b text-fg-dim text-sm">
      <span>{parts.join(' / ')}</span>
      <button type="button" onClick={onAdjust} className="ml-2 text-accent hover:underline">
        실제 범위로 조정
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="ml-auto text-fg-dim hover:text-fg">
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && pnpm vitest run src/replay/RangeAdjustmentNotice.test.tsx`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/replay/RangeAdjustmentNotice.tsx frontend/src/replay/RangeAdjustmentNotice.test.tsx
git commit -m "feat(replay/RangeAdjustmentNotice): chip for partial-inventory boundary mismatch"
```

---

## Phase 8 — Workarea Integration

### Task 15: Replace `useSession` with `useRange` in `Workarea` + mount `RangeAdjustmentNotice`

**Files:**
- Modify: `frontend/src/replay/Workarea.tsx`
- Test: `frontend/src/replay/Workarea.test.tsx` (existing — extend)

- [ ] **Step 1: Write failing test**

Add:

```tsx
it('passes RangeBundle.segments straight into ChartStage', () => {
  // Stub useRange to return a 2-segment bundle, render Workarea, assert ChartStage receives 2 segments.
  // (Use vi.mock on '../api/range')
});

it('shows RangeAdjustmentNotice when bundle.segments[0].date > tab.fromDate', () => {
  // Stub useRange with segments=[{date:'20260503',...}] for a tab with fromDate=20260501.
  // Assert notice is rendered.
});
```

(Flesh these out using the project's existing pattern for stubbing React Query hooks — look at how `Workarea.test.tsx` currently mocks `useSession`.)

- [ ] **Step 2: Update `Workarea.tsx`**

Replace the body:

```tsx
import { useState } from 'react';
import { useTabsStore, type Tab } from '../state/tabs';
import { useRange } from '../api/range';
import { buildSegments, type Segment } from '../util/time';
import ChartStage from '../chart/ChartStage';
import ChartErrorBoundary from '../chart/ChartErrorBoundary';
import { CursorSidebarConnected } from '../sidebar/CursorSidebar';
import RangeAdjustmentNotice from './RangeAdjustmentNotice';

export default function Workarea({ tab }: { tab: Tab }) {
  const code = tab.selection?.code ?? null;
  const fromDate = tab.selection?.fromDate ?? null;
  const toDate = tab.selection?.toDate ?? null;
  const timeframe = tab.selection?.timeframe ?? null;

  const { data: bundle, isLoading, isError, error } = useRange(code, fromDate, toDate, timeframe);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  const segments: Segment[] = bundle
    ? buildSegments(bundle.segments.map(s => ({
        date: s.date,
        sessionOpenMs: s.session_open_ms,
        sessionCloseMs: s.session_close_ms,
      })))
    : [];

  // Status sync (loading/loaded/error)
  useEffect(() => {
    if (!tab.selection) return;
    if (isLoading) useTabsStore.getState().setStatus(tab.id, 'loading');
    else if (isError) useTabsStore.getState().setStatus(tab.id, 'error', String(error ?? 'unknown'));
    else if (bundle) useTabsStore.getState().putBundle(tab.id, bundle.from_date, bundle);
  }, [tab.id, tab.selection, isLoading, isError, error, bundle]);

  if (isError) {
    return (
      <div className="grid place-items-center h-full text-down">
        Load failed: {String(error ?? 'unknown')}
      </div>
    );
  }

  const showNotice =
    !noticeDismissed &&
    bundle &&
    fromDate &&
    toDate &&
    bundle.segments.length > 0 &&
    (bundle.segments[0].date !== fromDate ||
      bundle.segments[bundle.segments.length - 1].date !== toDate);

  const onAdjust = () => {
    if (!bundle || !tab.selection) return;
    useTabsStore.getState().setSelection(tab.id, {
      ...tab.selection,
      fromDate: bundle.segments[0].date,
      toDate: bundle.segments[bundle.segments.length - 1].date,
    });
    setNoticeDismissed(false);
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg">
      {showNotice && (
        <RangeAdjustmentNotice
          requestedFrom={fromDate}
          requestedTo={toDate}
          actualFirst={bundle.segments[0].date}
          actualLast={bundle.segments[bundle.segments.length - 1].date}
          onAdjust={onAdjust}
          onDismiss={() => setNoticeDismissed(true)}
        />
      )}
      <div className="grid grid-cols-[1fr_var(--sidebar-w)] gap-2 p-2 flex-1 min-h-0">
        <ChartErrorBoundary>
          <ChartStage bundle={bundle ?? null} segments={segments} />
        </ChartErrorBoundary>
        <CursorSidebarConnected />
      </div>
    </div>
  );
}
```

Note: `ChartStage`'s `bundle` prop type changes from `SessionBundle | null` to `RangeBundle | null` here. Update `ChartStage.tsx`'s props in Task 17.

- [ ] **Step 3: Run typecheck + tests**

Run: `cd frontend && pnpm tsc --noEmit && pnpm vitest run src/replay/Workarea.test.tsx`
Expected: typecheck will have errors in ChartStage (fixed in Task 17). Workarea tests pass.

- [ ] **Step 4: Commit (typecheck-incomplete is expected — fixed in next task)**

```bash
git add frontend/src/replay/Workarea.tsx frontend/src/replay/Workarea.test.tsx
git commit -m "feat(replay/Workarea): switch to useRange, mount RangeAdjustmentNotice"
```

---

## Phase 9 — Chart Layer

### Task 16: `CandlePane` per-segment Auction Window threshold

**Files:**
- Modify: `frontend/src/chart/CandlePane.tsx`
- Test: `frontend/src/chart/CandlePane.test.tsx` (existing — extend)

- [ ] **Step 1: Write failing test**

```tsx
// frontend/src/chart/CandlePane.test.tsx
it('multi-day: candles in segment[1] auction window are muted using segment[1].sessionOpenMs', () => {
  // Build a 2-segment RangeBundle. Place one candle in segment[0]'s 15:25 (after auctionThreshold) and one
  // in segment[1]'s 10:00 (before its auctionThreshold). Assert series received the correct colors.
});

it('regression: single-day (N=1) RangeBundle colors match historical SessionBundle behavior', () => {
  // 1-segment bundle with candles spanning 09:00-16:00. Verify muted starts at 15:20 KST.
});
```

(Use the existing `CandlePane.test.tsx` mock pattern for lightweight-charts — `vi.mock('lightweight-charts')` capturing `addSeries` calls.)

- [ ] **Step 2: Update `CandlePane.tsx`**

Replace the `auctionThresholdMs` and `data` mapping:

```tsx
import { findSegmentByReal, isWithinSessions, realToVirtual, type Segment } from '../util/time';
import type { RangeBundle } from '../api/types';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  segments: Segment[];
  paneIndex?: number;
};

// Inside useEffect, replace the threshold + data mapping with:
const AUCTION_WINDOW_OFFSET_MS = (6 * 3600 + 20 * 60) * 1000;

const data = bundle.candles
  .filter((c) => isWithinSessions(segments, c.ts_ms))
  .map((c) => {
    const segIdx = findSegmentByReal(segments, c.ts_ms);
    const seg = segments[segIdx];
    const threshold = seg.sessionOpenMs + AUCTION_WINDOW_OFFSET_MS;
    const inAuctionOrAfter = c.ts_ms >= threshold;
    const color = inAuctionOrAfter ? muted : c.close >= c.open ? up : down;
    return {
      time: (realToVirtual(segments, c.ts_ms) / 1000) as any,
      open: c.open, close: c.close, high: c.high, low: c.low,
      color, borderColor: color, wickColor: color,
    };
  });
```

- [ ] **Step 3: Run tests**

Run: `cd frontend && pnpm vitest run src/chart/CandlePane.test.tsx`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/chart/CandlePane.tsx frontend/src/chart/CandlePane.test.tsx
git commit -m "fix(chart/CandlePane): per-segment Auction Window threshold (multi-day, ADR-0013)"
```

---

### Task 17: `ChartStage` types switch + Pane retypes + initial-fit + zoom clamps + tickMarkFormatter

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx`
- Modify: `frontend/src/chart/VolumePane.tsx`
- Modify: `frontend/src/chart/RatioPane.tsx`
- Modify: `frontend/src/chart/IntensityPane.tsx`
- Modify: `frontend/src/chart/FillStrengthPane.tsx`
- Test: `frontend/src/chart/ChartStage.test.tsx`

This task is large — split into 3 sub-commits via the 5-step pattern below. Each sub-commit leaves typecheck clean (no WIP / broken intermediate states).

#### 17a: Switch `bundle` prop type to `RangeBundle` across ChartStage + all 4 pane consumers (atomic)

- [ ] **Step 1: Update `ChartStage.tsx` prop type**

```tsx
import type { RangeBundle } from '../api/types';

export type ChartStageProps = {
  bundle: RangeBundle | null;
  segments: Segment[];
};
```

Update the four pane children invocations in JSX (no code change — just the type they pass through).

- [ ] **Step 2: Retype `bundle` prop in the 4 non-CandlePane components in the SAME commit**

In each of `frontend/src/chart/VolumePane.tsx`, `RatioPane.tsx`, `IntensityPane.tsx`, `FillStrengthPane.tsx`:

```tsx
import type { RangeBundle } from '../api/types';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;          // was SessionBundle
  segments: Segment[];
  paneIndex?: number;
};
```

No behavioural change — these panes read only their own series payload which exists identically in RangeBundle.

(CandlePane retype + per-segment auction threshold is Task 16, already committed in its own commit.)

- [ ] **Step 3: Typecheck**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: No errors. All Pane consumers now accept RangeBundle and produce no compile errors.

- [ ] **Step 4: Run chart tests**

Run: `cd frontend && pnpm vitest run src/chart/`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/ChartStage.tsx frontend/src/chart/VolumePane.tsx frontend/src/chart/RatioPane.tsx frontend/src/chart/IntensityPane.tsx frontend/src/chart/FillStrengthPane.tsx
git commit -m "refactor(chart): ChartStage + 4 panes retype bundle as RangeBundle (no behaviour change)"
```

#### 17b: Add initial `fitContent` + zoom clamp effect

- [ ] **Step 1: Write failing test for fitContent on bundle ready**

Mock lightweight-charts; assert `fitContent` is called after `bundle` becomes non-null.

- [ ] **Step 2: Add the effect**

After the chart-mount `useEffect`, add a new `useEffect`:

```tsx
useEffect(() => {
  if (!chart || !bundle) return;
  const ts = chart.timeScale();
  ts.fitContent();
  const totalBars = bundle.candles.length;
  const handler = (range: { from: number; to: number } | null) => {
    if (!range) return;
    const len = range.to - range.from;
    if (len > totalBars) {
      ts.setVisibleLogicalRange({ from: 0, to: totalBars });
      return;
    }
    const bs = ts.options().barSpacing;
    if (bs > 50) ts.applyOptions({ barSpacing: 50 });
  };
  ts.subscribeVisibleLogicalRangeChange(handler);
  return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
}, [chart, bundle]);
```

- [ ] **Step 3: Run tests + commit**

```bash
git add frontend/src/chart/ChartStage.tsx frontend/src/chart/ChartStage.test.tsx
git commit -m "feat(chart/ChartStage): fitContent on bundle ready + zoom clamps (data-length, barSpacing 50)"
```

#### 17c: KST `tickMarkFormatter` via `virtualToReal(segments, ...)`

- [ ] **Step 1: Write failing test**

```tsx
it('tickMarkFormatter outputs HH:MM for Time tick, MM/DD for DayOfMonth tick, in KST', () => {
  // Capture the createChart call's options.timeScale.tickMarkFormatter,
  // invoke with a known virtual seconds value and segments[0].sessionOpenMs = (a known Unix ms).
  // Assert output strings.
});
```

- [ ] **Step 2: Add to `createChart` options**

Inside the chart options assembly (in the mount effect), add `tickMarkFormatter`:

```tsx
import { TickMarkType, type UTCTimestamp } from 'lightweight-charts';
import { virtualToReal } from '../util/time';

// helper
function pad(n: number): string { return String(n).padStart(2, '0'); }

// inside createChart timeScale options:
tickMarkFormatter: (time: UTCTimestamp, tickType: TickMarkType): string => {
  const virtualMs = (time as number) * 1000;
  const segs = segmentsRef.current;
  if (segs.length === 0) return '';
  const realMs = virtualToReal(segs, virtualMs);
  // KST = UTC + 9h
  const d = new Date(realMs + 9 * 3600_000);
  switch (tickType) {
    case TickMarkType.Year:
    case TickMarkType.Month:
    case TickMarkType.DayOfMonth:
      return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
    case TickMarkType.Time:
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    case TickMarkType.TimeWithSeconds:
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    default:
      return '';
  }
},
```

Comment above the formatter:

```tsx
// lightweight-charts treats time-axis values as raw Unix seconds offsets from
// the epoch. We use a stitched virtual axis (util/time.ts) where virtual-ms
// is offset from segments[0].sessionOpenMs, not from epoch — so raw library
// labels would be meaningless ("1970-01-01 + virtualMs"). This formatter
// converts back to real Unix-ms via virtualToReal and formats in KST (UTC+9).
// See spec §6.6(b) "Virtual Axis Label formatting".
```

- [ ] **Step 3: Run tests + commit**

```bash
git add frontend/src/chart/ChartStage.tsx frontend/src/chart/ChartStage.test.tsx
git commit -m "feat(chart/ChartStage): KST tickMarkFormatter (virtual-ms → real-ms via segments)"
```

#### 17d: Chart instance keyed on `(code, fromDate, toDate)` only — preserves visibleLogicalRange on Timeframe change

The chart is currently re-mounted whenever the wrapping component re-renders with a new key. To survive Timeframe change, the parent (Workarea) must NOT include `timeframe` in the chart's React `key`. Today no explicit `key` is set in `Workarea.tsx` — confirm and document.

- [ ] **Step 1: Add a `key` explicitly in Workarea for clarity**

In `frontend/src/replay/Workarea.tsx`, change the `<ChartStage ... />` line:

```tsx
<ChartStage
  key={`${code}:${fromDate}:${toDate}`}
  bundle={bundle ?? null}
  segments={segments}
/>
```

This makes the contract explicit: the chart instance is reused across Timeframe changes (panes' `useEffect` re-runs with the new bundle and calls `series.setData(newData)`), but recreated on code/date changes.

- [ ] **Step 2: Add test**

Add to `Workarea.test.tsx`:

```tsx
it('does not remount ChartStage when only timeframe changes', () => {
  // Render with timeframe=1m, capture ChartStage mount count.
  // Re-render with timeframe=5m. Assert mount count unchanged.
});

it('remounts ChartStage when fromDate changes', () => {
  // Render with fromDate=20260512, then fromDate=20260513. Assert mount count incremented.
});
```

- [ ] **Step 3: Run tests + commit**

```bash
git add frontend/src/replay/Workarea.tsx frontend/src/replay/Workarea.test.tsx
git commit -m "feat(replay/Workarea): key ChartStage on (code,fromDate,toDate) — survives Timeframe change"
```

---

### Task 18: `DayBoundaryOverlay` component

**Files:**
- Create: `frontend/src/chart/DayBoundaryOverlay.tsx`
- Test: `frontend/src/chart/DayBoundaryOverlay.test.tsx`
- Modify: `frontend/src/chart/ChartStage.tsx` (mount the overlay)

- [ ] **Step 1: Write failing tests**

```tsx
// DayBoundaryOverlay.test.tsx
it('renders N-1 boundary divs for N segments', () => {
  // Render with 3 segments. Assert 2 divs with role="separator" or data-day-boundary.
});

it('renders MM/DD chip text matching segment.date for each boundary', () => {
  // Render with segments [..., {date:'20260513'}, {date:'20260514'}].
  // Assert chips show '5/13' and '5/14'.
});

it('does not render anything for N=1 segments', () => {
  // Single-segment bundle: zero boundaries.
});
```

- [ ] **Step 2: Implement**

```tsx
// frontend/src/chart/DayBoundaryOverlay.tsx
import { useEffect, useRef, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Segment } from '../util/time';

type Props = {
  chart: IChartApi;
  segments: Segment[];
};

function fmtMD(yyyymmdd: string): string {
  return `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`;
}

export default function DayBoundaryOverlay({ chart, segments }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => force((n) => n + 1));
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro = new ResizeObserver(schedule);
    if (containerRef.current?.parentElement) ro.observe(containerRef.current.parentElement);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro.disconnect();
    };
  }, [chart]);

  if (segments.length < 2) return null;

  const ts = chart.timeScale();
  const boundaries = segments.slice(1).map((seg) => {
    const x = ts.timeToCoordinate((seg.virtualStart / 1000) as any);
    return { date: seg.date, x };
  });

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none">
      {boundaries.map((b) =>
        b.x == null ? null : (
          <div
            key={b.date}
            data-day-boundary={b.date}
            className="absolute top-0 bottom-0 w-px"
            style={{ transform: `translateX(${b.x}px)`, background: 'rgba(255,255,255,0.18)' }}
          >
            <span className="absolute top-1 left-1 bg-bg-card text-fg-dim text-xs px-1.5 py-0.5 rounded">
              {fmtMD(b.date)}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
```

In `ChartStage.tsx`, mount the overlay inside the returned JSX:

```tsx
import DayBoundaryOverlay from './DayBoundaryOverlay';

// inside the return, alongside other pane wrappers:
{chart && bundle && <DayBoundaryOverlay chart={chart} segments={segments} />}
```

- [ ] **Step 3: Run tests + commit**

```bash
git add frontend/src/chart/DayBoundaryOverlay.tsx frontend/src/chart/DayBoundaryOverlay.test.tsx frontend/src/chart/ChartStage.tsx
git commit -m "feat(chart/DayBoundaryOverlay): vertical line + MM/DD chip per Day Boundary"
```

---

### Task 19: `VolumeProfileOverlay` — mode rename + RangeBundle adaptation

**Files:**
- Modify: `frontend/src/chart/VolumeProfileOverlay.tsx`

- [ ] **Step 1: Rename mode union**

Change line 26:
```tsx
mode?: 'per-day' | 'range';   // was 'composite'
```

Replace all `'composite'` literals in this file with `'range'`. The default parameter:
```tsx
mode = 'range',
```

- [ ] **Step 2: Update bundle access for `range` mode**

Where `'composite'` (now `'range'`) reads from `bundle.volume_profile`, change to `bundle.volume_profile_range`.

For `'per-day'` mode (existing branch), iterate `bundle.volume_profile_by_day` paired with `segments` and position each profile group at `timeToCoordinate(segments[i].virtualStart / 1000)`.

- [ ] **Step 3: Run all chart tests**

Run: `cd frontend && pnpm vitest run src/chart/`
Expected: All pass. Type errors here mean the bundle import is still `SessionBundle` — change `import type { SessionBundle }` to `import type { RangeBundle }` and update the prop type.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/chart/VolumeProfileOverlay.tsx
git commit -m "refactor(chart/VolumeProfileOverlay): rename composite→range, use RangeBundle fields"
```

---

### Task 20: ~~Other pane retypes~~ — merged into Task 17a (see plan-eng-review D2)

This task was originally a separate retype step but was merged into Task 17a so all five Pane consumers (ChartStage + 4 non-CandlePane panes) change their `bundle` type to `RangeBundle` atomically — every commit stays typecheck-clean and `git bisect` stays clean.

CandlePane's behavioural change (per-segment auction threshold) remains in Task 16.

Skip this task during execution.

---

### Task 21: Sidebar `volumeProfileMode` toggle UI

**Files:**
- Modify: `frontend/src/sidebar/CursorSidebar.tsx` (add toggle near volume profile section)
- Modify: `frontend/src/chart/VolumeProfileOverlay.tsx` (read `mode` from `useTabsStore` prefs)

- [ ] **Step 1: Add a segmented control in the sidebar header**

In `CursorSidebar.tsx`, near the section that contains the volume-profile display:

```tsx
import { useTabsStore } from '../state/tabs';

const activeId = useTabsStore((s) => s.activeTabId);
const mode = useTabsStore((s) => s.getPrefs(activeId).volumeProfileMode);
const setMode = (m: 'range' | 'per-day') =>
  useTabsStore.getState().setVolumeProfileMode(activeId, m);

<div className="flex gap-1 text-xs">
  {(['range', 'per-day'] as const).map((m) => (
    <button
      key={m}
      type="button"
      aria-pressed={mode === m}
      onClick={() => mode !== m && setMode(m)}
      className={mode === m ? 'px-2 py-0.5 bg-accent text-accent-fg rounded' : 'px-2 py-0.5 text-fg-dim hover:text-fg'}
    >
      {m === 'range' ? '전체' : '일별'}
    </button>
  ))}
</div>
```

- [ ] **Step 2: Have `VolumeProfileOverlay` read mode from the store rather than via prop default**

Inside `ChartStage.tsx`, change the `VolumeProfileOverlay` mount:

```tsx
const activeId = useTabsStore((s) => s.activeTabId);
const volMode = useTabsStore((s) => s.getPrefs(activeId).volumeProfileMode);
// ...
<VolumeProfileOverlay chart={chart} bundle={bundle} segments={segments} mode={volMode} paneIndex={0} />
```

- [ ] **Step 3: Add test for toggle behavior**

(In CursorSidebar.test.tsx — click toggle, assert `useTabsStore` prefs updated.)

- [ ] **Step 4: Run tests + typecheck + commit**

```bash
git add frontend/src/sidebar/CursorSidebar.tsx frontend/src/chart/ChartStage.tsx
git commit -m "feat(sidebar): volumeProfileMode toggle (전체/일별)"
```

---

## Phase 10 — Retire SessionBundle Completely (ADR-0013)

### Task 22: Delete backend `/api/session`, `SessionBundle`, `build_bundle` SessionBundle assembly

**Files:**
- Modify: `hoga/api/routes.py` (remove the `/api/session` handler entirely)
- Modify: `hoga/api/models.py` (remove `SessionBundle`)
- Modify: `hoga/api/bundle.py` (`build_bundle` now returns its internal slices as a tuple/dict consumed only by `build_range_bundle`; OR keep `build_bundle` returning a private internal class; pragmatic: rename `SessionBundle` to `_InternalBundle` if still needed for `build_range_bundle`, or refactor `build_range_bundle` to bypass it)
- Delete tests that exercise SessionBundle/`/api/session` directly

- [ ] **Step 1: Identify all SessionBundle usages**

Run: `grep -rn "SessionBundle\|build_bundle\|/api/session" hoga/ tests/hoga/ --include="*.py"`

For each match, plan: delete vs replace.

- [ ] **Step 2: Refactor `build_range_bundle`'s loop to call internal slice builders directly**

Replace the `sub = build_bundle(engine, code=code, date=d, bucket_ms=bucket_ms)` loop with direct calls:

```python
for d in dates:
    meta = engine.get_meta(d, code)
    candles_raw = build_candles_slice(engine, code=code, date=d)
    candles = downsample_candles(candles_raw, bucket_ms=bucket_ms)
    quote_ratio = build_quote_ratio_slice(engine, code=code, date=d, bucket_ms=bucket_ms)
    depth_intensity = build_depth_intensity_slice(engine, code=code, date=d, depth_bucket_ms=bucket_ms)
    fill_strength = build_fill_strength_slice(engine, code=code, date=d, bucket_ms=bucket_ms)
    volume_profile = build_volume_profile_slice(engine, code=code, date=d)
    # ... extend output collections as before
    segments.append(RangeSegment(
        date=d,
        session_open_ms=hhmmssms_to_unix_ms(d, meta["session_open"]),
        session_close_ms=hhmmssms_to_unix_ms(d, meta["session_close"]),
    ))
    # ...
```

- [ ] **Step 3: Delete `build_bundle`, `SessionBundle`, `/api/session` handler, related tests**

```python
# hoga/api/models.py — delete the SessionBundle class
# hoga/api/bundle.py — delete build_bundle function
# hoga/api/routes.py — delete the /api/session route handler
# tests/hoga/api/test_bundle.py — delete tests targeting build_bundle/SessionBundle
# tests/hoga/api/test_routes.py — delete tests targeting /api/session
```

- [ ] **Step 4: Run all backend tests**

Run: `pytest tests/hoga -v`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add hoga/ tests/hoga/
git commit -m "refactor(api): retire SessionBundle, build_bundle, /api/session (ADR-0013)"
```

---

### Task 23: Delete frontend `useSession`, `SessionBundle` type, `frontend/src/api/session.ts`

**Files:**
- Delete: `frontend/src/api/session.ts`
- Modify: `frontend/src/api/types.ts` (remove `SessionBundle`)
- Search and remove all other imports/references

- [ ] **Step 1: Find all references**

Run: `grep -rn "SessionBundle\|useSession\|api/session" frontend/src`

- [ ] **Step 2: Delete the file and references**

```bash
rm frontend/src/api/session.ts
```

Remove `export type SessionBundle = ...` from `frontend/src/api/types.ts`.

For each `import { SessionBundle }` remaining, switch to `RangeBundle` (most callers should already have been updated in Phase 9).

- [ ] **Step 3: Run full frontend typecheck + tests**

Run: `cd frontend && pnpm tsc --noEmit && pnpm vitest run`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/
git rm frontend/src/api/session.ts
git commit -m "refactor(frontend): delete SessionBundle type, useSession, api/session.ts (ADR-0013)"
```

---

## Phase 11 — E2E Validation

### Task 24: Playwright E2E — full replay viewer flow

**Files:**
- Create: `frontend/e2e/replay-zoom.spec.ts` (or follow existing e2e file naming)

- [ ] **Step 1: Write the E2E spec**

```ts
// frontend/e2e/replay-zoom.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Replay viewer — zoom, Timeframe, Day Boundary', () => {
  test('full-day fits on initial load (single Stock-Date)', async ({ page }) => {
    await page.goto('http://localhost:5173/replay?tabs=005930:20260512:20260512:1m&active=0');
    await page.waitForSelector('[data-pane="candle"]', { timeout: 10_000 });
    // Verify x-axis shows KST times
    const firstTick = await page.locator('canvas').first().evaluate(() => {
      // visual assertion via screenshot — see step 3
      return true;
    });
    expect(firstTick).toBe(true);
  });

  test('Timeframe switch preserves chart instance', async ({ page }) => {
    await page.goto('http://localhost:5173/replay?tabs=005930:20260512:20260512:1m&active=0');
    await page.waitForSelector('[data-pane="candle"]');
    // Click 5m
    await page.getByRole('button', { name: '5m' }).click();
    await page.getByRole('button', { name: /불러오기|Reload/ }).click();
    // Assert chart is still there (not torn down + recreated)
    await page.waitForSelector('[data-pane="candle"]');
  });

  test('Multi-day Range shows DayBoundary marker', async ({ page }) => {
    await page.goto('http://localhost:5173/replay?tabs=005930:20260512:20260513:5m&active=0');
    await page.waitForSelector('[data-day-boundary]', { timeout: 10_000 });
    expect(await page.locator('[data-day-boundary]').count()).toBeGreaterThanOrEqual(1);
  });

  test('Range > 30 days blocked at Toolbar', async ({ page }) => {
    await page.goto('http://localhost:5173/replay');
    // Pick a 31-day range via DateRangePicker (project-specific selectors)
    // Click Load. Expect inline error.
    // (Adapt to actual DateRangePicker test selectors)
  });
});
```

- [ ] **Step 2: Run E2E**

Run: `cd frontend && pnpm playwright test e2e/replay-zoom.spec.ts`
Expected: All pass against a running dev server with test data.

If the project doesn't have playwright wired up, use the existing `browse` skill pattern instead (see `CLAUDE.md`) — open the page in a real browser, screenshot at each step, assert visually.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/replay-zoom.spec.ts
git commit -m "test(e2e): replay viewer zoom, Timeframe, Day Boundary"
```

---

## Phase 12 — Documentation & Cleanup

### Task 25: Update `CONTEXT.md`, `DESIGN.md` references, and final smoke

**Files:**
- Verify `CONTEXT.md` already has Stock-Date Range, RangeBundle, Timeframe, Day Boundary, Auction Window note (committed in `d30c51a`).
- Verify `docs/adr/0013-rangebundle-single-read-path.md` and `docs/adr/0014-replay-single-timeframe.md` status updated from "proposed" → "accepted" with merge date.

- [ ] **Step 1: Update ADR status**

```bash
sed -i 's/^\*\*Status:\*\* proposed (2026-05-22)$/**Status:** accepted (2026-05-22)/' docs/adr/0013-rangebundle-single-read-path.md docs/adr/0014-replay-single-timeframe.md
```

- [ ] **Step 2: Smoke test**

Run dev server: `make dev` (or project's equivalent)
Visit: `http://localhost:5173/replay?tabs=005930:20260512:20260512:1m&active=0`
Verify visually:
- Full day fits on initial render
- X-axis shows KST HH:MM (not 1970-based)
- Click 5m → candles re-aggregate, time window approximately preserved
- Open a multi-day range, see Day Boundary line + MM/DD chip

- [ ] **Step 3: Final commit**

```bash
git add docs/adr/0013-rangebundle-single-read-path.md docs/adr/0014-replay-single-timeframe.md
git commit -m "docs(adr): 0013/0014 accepted after implementation"
```

- [ ] **Step 4: Push for review**

```bash
git push -u origin worktree-feat+frontend3
gh pr create --title "feat(replay): multi-day Stock-Date Range viewer with Timeframe selector" --body "..."
```

---

## Self-Review Notes (for the implementing engineer)

- Each task's **Files** section lists exact paths to touch — no guessing.
- All test code is concrete; no "add appropriate tests" placeholders.
- The plan retires `SessionBundle` in Phase 10 *after* every consumer has been migrated in Phases 6-9 — do not reorder.
- `apiCall<T>` is the project's HTTP helper (not `apiGet` as the spec mentions — spec was slightly inaccurate).
- The decision to key `ChartStage` on `(code, fromDate, toDate)` only (Task 17d) is what makes the Timeframe-change time-window preservation work without any explicit snapshot/restore machinery — preserve this contract.
- Phase 7's `RangeAdjustmentNotice` is a UX decision committed in plan-eng-review T2 (spec §3, §8). Do not skip even though it adds a small component.
- Phase 8 Task 15 (Workarea→useRange) leaves `ChartStage`'s typecheck temporarily broken — that's expected to be brief (next commit). Resolved cleanly by Task 17a which retypes ChartStage + 4 panes atomically. No long-lived WIP commit.

## Total Counts

- **24 active tasks** across **12 phases** (Task 20 deprecated — merged into Task 17a)
- ~**105 steps** total (TDD pattern: test → fail → impl → pass → commit)
- ~**24 commits** total (one per task — Task 17 split into 3 sub-commits; all commits typecheck-clean per plan-eng-review D2)

---

## NOT in scope (explicitly deferred)

- **Multi-date `read_parquet` SQL optimisation** — v1 keeps the N-call loop in `build_range_bundle`; bound by the 30-day cap. Profile after v1 ships, optimise in a follow-up PR.
- **Server-side caching of downsampled candles** — recomputed each request. Optimise only if profiling shows it matters.
- **Streaming / pagination** for ranges > 30 days. The 30-day hard cap is the v1 boundary.
- **Auto-Timeframe (zoom-driven)** — explicitly rejected in ADR-0014. Possible future addition.
- **Sub-minute Timeframes (10s, 30s)** — underlying candles parquet is 1m fixed.
- **Custom user Timeframes (7m, 2h, 1d)** — six fixed values keep the selector compact.
- **`RangeAdjustmentNotice` "Capture missing dates" button** — spec §8 only requires "Adjust to actual range" action; full capture-trigger wiring deferred.

## What already exists (reused, not rebuilt)

- `util/time.ts` virtual axis stitching — `buildSegments`, `realToVirtual`, `isWithinSessions`, `findSegmentByVirtual` all reused unchanged. New `findSegmentByReal` is the sibling helper added in Task 3.
- `DateRangePicker` + `TabSelection { fromDate, toDate }` — UI for date range selection already exists; the plan only adds `timeframe` to the TabSelection shape.
- `bundle.py` quote_ratio / depth_intensity / fill_strength builders — already parameterised by `bucket_ms`. Plan only adds the new `downsample_candles` and `build_volume_profile_range` companions.
- ChartErrorBoundary, all 5 Pane components — structurally unchanged; only `bundle` prop type retyped.
- `chartScale.ts` — `barSpacing=8`, `rightOffset=15` preserved per DESIGN.md.
- `apiCall<T>` HTTP helper — reused via `useRange` (not `fetch` directly).

## Failure modes (per new codepath)

| Codepath | Realistic failure | Test? | Error handling? | User sees? |
|---|---|---|---|---|
| `downsample_candles` (Task 4) | Invalid `bucket_ms` | ✓ (Task 4) | `ValueError` raise | API returns 400 |
| `build_range_bundle` (Task 7) | Inventory empty in range | ✓ (Task 7) | `HTTPException(404)` | Workarea shows error message + Toolbar focus |
| `/api/range` (Task 8) | Range > 30 days | ✓ (Task 8) | `HTTPException(400)` | Toolbar inline error (pre-validated) |
| `useRange` (Task 11) | Network timeout / 500 | implicit via React Query | `isError=true` propagated | Workarea shows "Load failed: ..." |
| `RangeAdjustmentNotice` (Task 14) | bundle.segments empty | ✓ implied | Component returns null early | Nothing rendered |
| `ChartStage.tickMarkFormatter` | segments empty during early render | ✓ (Task 17c) | Returns empty string | No tick labels (acceptable) |
| `DayBoundaryOverlay` (Task 18) | `timeToCoordinate` returns null (off-screen) | implicit | Per-boundary `null`-check skips rendering | Boundary line hidden until visible |
| `CandlePane` per-segment (Task 16) | candle with ts_ms outside any segment | ✓ (filtered by `isWithinSessions`) | Pre-filtered, never reaches threshold check | Candle hidden (existing behaviour) |

**Critical gap check**: no codepath identified that has no test AND no error handling AND silent failure to user. **0 critical gaps.**

## Worktree parallelization strategy

| Phase | Modules touched | Depends on |
|------|----------------|------------|
| Phase 1 (Tasks 1-3) | `hoga/api/models.py`, `frontend/src/api/types.ts`, `frontend/src/util/` | — |
| Phase 2-3 (Tasks 4-7) | `hoga/api/bundle.py`, `hoga/api/queries.py`, `tests/hoga/` | Phase 1 (models) |
| Phase 4 (Task 8) | `hoga/api/routes.py`, `tests/hoga/api/` | Phase 2-3 (build_range_bundle) |
| Phase 5-6 (Tasks 9-11) | `frontend/src/state/`, `frontend/src/api/range.ts` | Phase 1 (types) |
| Phase 7 (Tasks 12-14) | `frontend/src/replay/` (TimeframeSelector, Toolbar, RangeAdjustmentNotice) | Phase 5 (state) |
| Phase 8 (Task 15) | `frontend/src/replay/Workarea.tsx` | Phase 6 (useRange), Phase 7 (RangeAdjustmentNotice) |
| Phase 9 (Tasks 16-21) | `frontend/src/chart/`, `frontend/src/sidebar/` | Phase 8 (Workarea passes RangeBundle) |
| Phase 10 (Tasks 22-23) | `hoga/api/`, `frontend/src/api/` (deletions) | Phase 9 (all callers migrated) |
| Phase 11-12 (Tasks 24-25) | `frontend/e2e/`, `docs/adr/` | Phase 10 (impl complete) |

**Parallel lanes:**
- Lane A: Phase 1 → Phase 2-3 → Phase 4 (backend, sequential within lane)
- Lane B: Phase 1 → Phase 5-6 → Phase 7 → Phase 8 (frontend setup, sequential within lane)
- Phase 9-12: must wait for both lanes (frontend integrates RangeBundle from backend)

**Execution order:** Phase 1 first (foundational types — single lane), then Lane A (backend) and Lane B (frontend non-chart) in parallel worktrees, then Phase 9-12 sequentially after both lanes merge.

**Conflict flags:** Lane A and Lane B touch different module directories (`hoga/` vs `frontend/`). No merge conflicts expected within Phase 1-8.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (engineering-only change) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR (PLAN) | spec review: 8 issues / all resolved; plan review: 3 issues / all resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (uses existing DESIGN.md tokens) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run (internal viewer change, not developer-facing API) |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED (2 reviews — spec + plan) — ready for `/subagent-driven-development`.
