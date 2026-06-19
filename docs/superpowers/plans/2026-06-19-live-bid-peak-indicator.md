# Live Bid Peak Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/live` "당일 매수 최대벽" indicator that mirrors the existing "당일 매도 최대벽" indicator across backend data, live state, persisted preferences, the indicator modal, and the chart overlay.

**Architecture:** Keep the existing ask-peak API and behavior stable. Add bid-peak contracts in parallel (`bid_peaks`, `bid_peak_today`) and reuse the existing segment primitive on the frontend. Share only low-risk helpers; avoid a broad generic wall-peak migration during this feature.

**Tech Stack:** Python/FastAPI/Pydantic/DuckDB/parquet backend; React/TypeScript/Zustand/Vitest/lightweight-charts frontend; pytest for backend tests.

## Global Constraints

- Preserve existing `ask_peaks` and `ask_peak_today` behavior.
- Add `bid_peaks: list[BidPeak]` to `RangeBundle`, defaulting to `[]`.
- Add `bid_peak_today` beside `ask_peak_today`; legacy payloads without it must not break the frontend.
- Bid untraded rule: below the day's low.
- Bid baseline color: `#DC2626`.
- Bid all-price/untraded color: `#F97316`.
- Minute charts only; do not render bid/ask peak overlays on `D`, `W`, or `M`.
- Master bid peak toggle is opt-in (`false` by default).
- `bidPeakShowAllPrices` defaults to `true`.
- `bidPeakIntraMax` defaults to `false`.

---

## File Structure

- `hoga/api/models.py`: add `BidPeak`; add `bid_peaks` to range bundle models.
- `hoga/api/past_indicators_cache.py`: add in-memory bid-peak cache parallel to ask-peak cache.
- `hoga/tables/snapshots.py`: add bid peak row dataclasses and bid-side query functions.
- `hoga/api/bundle.py`: add `build_bid_peak_slice`; include `bid_peaks` in `build_range_bundle`.
- `hoga/live/ask_peak_state.py`: either add `TodayBidPeakState` or extract side-aware state while preserving `TodayAskPeakState` import compatibility.
- `hoga/live/stream.py`, `hoga/live/lifecycle.py`, `hoga/live/api.py`, `hoga/api/app.py`: wire today bid peak state into live series.
- `frontend/src/api/types.ts`: add `BidPeak` and `bid_peaks`/`bid_peak_today` wire fields.
- `frontend/src/state/liveIndicatorsPersistence.ts`: add bid-peak persisted prefs and defaults.
- `frontend/src/state/livePage.ts`: add bid-peak store fields/setters/snapshot persistence.
- `frontend/src/state/chartPrefs.ts`: add bid-peak indicator-modal toggles.
- `frontend/src/live/computeDayBidPeak.ts`: add bid-side today ratchet reducer mirroring ask peak.
- `frontend/src/live/useDayBidPeaks.ts`: add bid-side hook mirroring `useDayAskPeaks`.
- `frontend/src/live/LiveBidPeakSegments.tsx`: add bid-side overlay component using `AskPeakSegmentsPrimitive`.
- `frontend/src/live/indicators/BidPeakConfig.tsx`: add indicator modal detail pane.
- `frontend/src/live/indicators/IndicatorPanel.tsx`: add "당일 매수 최대벽" category and toggle.
- `frontend/src/live/buildLiveBundle.ts`, `frontend/src/live/LiveChartRoot.tsx`: pass bid peaks through and mount the overlay.

---

### Task 1: Backend Wire Models And Cache

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/api/past_indicators_cache.py`
- Test: `tests/test_api_ask_peak_model.py`
- Test: `tests/hoga/api/test_bundle.py`

**Interfaces:**
- Produces: `class BidPeak(BaseModel)` with the same fields as `AskPeak`.
- Produces: `RangeBundle.bid_peaks: list[BidPeak] = Field(default_factory=list)`.
- Produces: `PastIndicatorsCache.has_bid_peak(code, date, source, bucket_ms) -> bool`.
- Produces: `PastIndicatorsCache.get_bid_peak(code, date, source, bucket_ms) -> BidPeak | None`.
- Produces: `PastIndicatorsCache.store_bid_peak(code, date, source, bucket_ms, peak) -> None`.

- [ ] **Step 1: Write failing model/cache tests**

Add to `tests/test_api_ask_peak_model.py`:

```python
def test_bid_peak_accepts_untraded_fields() -> None:
    from hoga.api.models import BidPeak

    peak = BidPeak(
        date="20260619",
        price=70000,
        qty=5000,
        t_ms=1,
        max_price=69900,
        max_qty=7000,
        max_t_ms=2,
        all_price=69800,
        all_qty=9000,
        all_t_ms=3,
        all_max_price=69700,
        all_max_qty=11000,
        all_max_t_ms=4,
        untraded_price=69000,
        untraded_qty=12000,
        untraded_t_ms=5,
        untraded_max_price=68900,
        untraded_max_qty=13000,
        untraded_max_t_ms=6,
    )

    assert peak.untraded_price == 69000
    assert peak.untraded_max_qty == 13000
```

Add to `tests/hoga/api/test_bundle.py` near the existing default range bundle test:

```python
def test_range_bundle_bid_peak_field_defaults_empty() -> None:
    from hoga.api.models import BidPeak, RangeBundle

    b = RangeBundle(
        code="005930",
        from_date="20260619",
        to_date="20260619",
        bucket_ms=60_000,
        segments=[],
        candles=[],
    )

    assert b.bid_peaks == []

    b2 = b.model_copy(update={"bid_peaks": [
        BidPeak(
            date="20260619",
            price=70000,
            qty=5000,
            t_ms=1,
            max_price=70000,
            max_qty=5000,
            max_t_ms=1,
        )
    ]})
    assert b2.bid_peaks[0].price == 70000
```

Add to `tests/unit/api/test_past_indicators_cache.py` if present; otherwise add to `tests/unit/api/test_past_indicators_cache.py`:

```python
def test_bid_peak_cache_is_independent_from_ask_peak(tmp_path):
    from hoga.api.models import AskPeak, BidPeak
    from hoga.api.past_indicators_cache import PastIndicatorsCache

    cache = PastIndicatorsCache(tmp_path)
    ask = AskPeak(date="20260619", price=71000, qty=1, t_ms=1, max_price=71000, max_qty=1, max_t_ms=1)
    bid = BidPeak(date="20260619", price=70000, qty=2, t_ms=2, max_price=70000, max_qty=2, max_t_ms=2)

    cache.store_ask_peak("005930", "20260619", "hogaplay", 60_000, ask)
    cache.store_bid_peak("005930", "20260619", "hogaplay", 60_000, bid)

    assert cache.get_ask_peak("005930", "20260619", "hogaplay", 60_000) == ask
    assert cache.get_bid_peak("005930", "20260619", "hogaplay", 60_000) == bid
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py::test_range_bundle_bid_peak_field_defaults_empty tests/unit/api/test_past_indicators_cache.py -q
```

Expected: failures for missing `BidPeak`, missing `bid_peaks`, or missing bid cache methods.

- [ ] **Step 3: Implement models and cache**

In `hoga/api/models.py`, add:

```python
class BidPeak(BaseModel):
    """한 거래일 연속거래 중 단일 매수 호가단계 최대 물량·가격(Day Bid Peak).

    Mirrors ``AskPeak`` on the bid side. ``untraded_*`` fields are bid prices
    below the day's traded low.
    """
    date: str
    price: int
    qty: int
    t_ms: int
    max_price: int
    max_qty: int
    max_t_ms: int
    all_price: int | None = None
    all_qty: int | None = None
    all_t_ms: int | None = None
    all_max_price: int | None = None
    all_max_qty: int | None = None
    all_max_t_ms: int | None = None
    untraded_price: int | None = None
    untraded_qty: int | None = None
    untraded_t_ms: int | None = None
    untraded_max_price: int | None = None
    untraded_max_qty: int | None = None
    untraded_max_t_ms: int | None = None
```

Add `bid_peaks: list["BidPeak"] = []` anywhere `ask_peaks` appears on range bundle models, using `Field(default_factory=list)` if that model already uses `Field`.

In `hoga/api/past_indicators_cache.py`, add:

```python
self._mem_bid_peak: dict[tuple[str, str, str, int], "BidPeak | None"] = {}
```

and methods parallel to ask peak:

```python
def has_bid_peak(self, code: str, date: str, source: str, bucket_ms: int) -> bool:
    return (code, date, source, bucket_ms) in self._mem_bid_peak

def get_bid_peak(self, code: str, date: str, source: str, bucket_ms: int) -> "BidPeak | None":
    return self._mem_bid_peak.get((code, date, source, bucket_ms))

def store_bid_peak(
    self, code: str, date: str, source: str, bucket_ms: int, peak: "BidPeak | None"
) -> None:
    self._mem_bid_peak[(code, date, source, bucket_ms)] = peak
```

Use `TYPE_CHECKING` imports exactly as ask peak does.

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
pytest tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py::test_range_bundle_bid_peak_field_defaults_empty tests/unit/api/test_past_indicators_cache.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py hoga/api/past_indicators_cache.py tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py tests/unit/api/test_past_indicators_cache.py
git commit -m "feat(api): add bid peak wire model"
```

---

### Task 2: Snapshot Bid Peak Queries

**Files:**
- Modify: `hoga/tables/snapshots.py`
- Test: `tests/test_tables_snapshots.py`

**Interfaces:**
- Produces: `BidPeakRow` and `BidPeakDualRow`.
- Produces: `query_day_bid_peak(con, *, path, bucket_ms, session_open_ms=None, session_close_ms=None) -> BidPeakRow | None`.
- Produces: `query_day_bid_peak_dual(con, *, path, trades_path, bucket_ms, session_open_ms=None, session_close_ms=None) -> BidPeakDualRow | None`.

- [ ] **Step 1: Write failing query tests**

Add imports in `tests/test_tables_snapshots.py`:

```python
from hoga.tables.snapshots import BidPeakDualRow, BidPeakRow, query_day_bid_peak, query_day_bid_peak_dual
```

Add tests:

```python
def _ob_bp(ts_ms: int, bid_q: list[int], bid_p: list[int] | None = None) -> "Orderbook":
    """bid_q/bid_p are length 10. ask is filled deep enough to look continuous."""
    bp = tuple(bid_p or [24950 - 50 * i for i in range(10)])
    bq = tuple(bid_q)
    aq = tuple([100] * 10)
    ap = tuple([25000 + 50 * i for i in range(10)])
    z = tuple([0] * 10)
    return Orderbook(ts_ms=ts_ms, seq=1, ask_p=ap, ask_q=aq, ask_d=z,
                     bid_p=bp, bid_q=bq, bid_d=z, tot_ask=sum(aq), tot_ask_d=0,
                     tot_bid=sum(bq), tot_bid_d=0)


def test_query_day_bid_peak_basic(tmp_path) -> None:
    obs = [
        _ob_bp(90000000, [100, 5000, 30, 40, 5, 6, 7, 8, 9, 1]),
        _ob_bp(90030000, [8000, 100, 30, 40, 5, 6, 7, 8, 9, 1],
            bid_p=[70000, 69900, 69800, 69700, 69600, 69500, 69400, 69300, 69200, 69100]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    peak = query_day_bid_peak(_con_for(out), path=out, bucket_ms=60_000)

    assert peak == BidPeakRow(
        price=70000,
        qty=8000,
        intra_ms=9 * 60 * 60 * 1000 + 30_000,
        max_price=70000,
        max_qty=8000,
        max_intra_ms=9 * 60 * 60 * 1000 + 30_000,
    )
```

Add a dual/untraded test:

```python
def test_query_day_bid_peak_dual_populates_below_low_untraded(tmp_path) -> None:
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    snapshots = tmp_path / "snapshots.parquet"
    trades = tmp_path / "trades.parquet"
    obs = [
        _ob_bp(90000000, [1000, 9000, 30, 40, 5, 6, 7, 8, 9, 1],
            bid_p=[70000, 69000, 68900, 68800, 68700, 68600, 68500, 68400, 68300, 68200]),
        _ob_bp(90100000, [5000, 100, 12000, 40, 5, 6, 7, 8, 9, 1],
            bid_p=[70000, 69000, 68900, 68800, 68700, 68600, 68500, 68400, 68300, 68200]),
    ]
    tr = Trade(
        ts_ms=90050000, seq=1, price=70000, change_pct=0, qty=1, side=1,
        cum_vol=1, cum_trades=1, low_so_far=70000, high_so_far=70000,
        net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
    )
    write_parquet(obs, snapshots)
    trades_write_parquet([tr], trades)

    peak = query_day_bid_peak_dual(_con_for(snapshots), path=snapshots, trades_path=trades, bucket_ms=60_000)

    assert peak == BidPeakDualRow(
        price=70000,
        qty=5000,
        intra_ms=9 * 60 * 60 * 1000 + 100_000,
        max_price=70000,
        max_qty=5000,
        max_intra_ms=9 * 60 * 60 * 1000 + 100_000,
        all_price=68900,
        all_qty=12000,
        all_intra_ms=9 * 60 * 60 * 1000 + 100_000,
        all_max_price=68900,
        all_max_qty=12000,
        all_max_intra_ms=9 * 60 * 60 * 1000 + 100_000,
        untraded_price=68900,
        untraded_qty=12000,
        untraded_intra_ms=9 * 60 * 60 * 1000 + 100_000,
        untraded_max_price=68900,
        untraded_max_qty=12000,
        untraded_max_intra_ms=9 * 60 * 60 * 1000 + 100_000,
    )
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest tests/test_tables_snapshots.py -k "bid_peak" -q
```

Expected: import or name errors for bid peak query functions/classes.

- [ ] **Step 3: Implement bid query functions**

In `hoga/tables/snapshots.py`, add dataclasses matching `AskPeakRow` and `AskPeakDualRow` with bid-side docstrings.

Implement `query_day_bid_peak` by copying `query_day_ask_peak` and changing `level_union`:

```python
def level_union(src: str) -> str:
    return " UNION ALL ".join(
        f"SELECT bid_p{i} AS price, bid_q{i} AS qty, {intra} AS intra_ms "
        f"FROM {src} WHERE bid_q{i} > 0"
        for i in range(1, ORDERBOOK_LEVELS + 1)
    )
```

Implement `query_day_bid_peak_dual` by copying `query_day_ask_peak_dual`, changing `level_union` to bid columns, changing `day_high` to `day_low`, and using:

```python
day_low AS (
  SELECT min(price) AS price FROM read_parquet(?) WHERE side IN (1, -1) AND price > 0
)
```

The mode filter must be:

```python
if mode == "traded":
    filter_sql = "WHERE price IN (SELECT price FROM traded_prices)"
elif mode == "untraded":
    filter_sql = "WHERE price < (SELECT price FROM day_low)"
elif mode == "all":
    filter_sql = ""
else:
    raise ValueError(f"unknown bid peak pick mode: {mode}")
```

Keep all continuous-book/session predicates and ordering identical to ask peak.

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
pytest tests/test_tables_snapshots.py -k "bid_peak or ask_peak" -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -m "feat(tables): query day bid peak"
```

---

### Task 3: Backend Range Bundle Bid Peaks

**Files:**
- Modify: `hoga/api/bundle.py`
- Test: `tests/hoga/api/test_bundle.py`
- Test: `tests/unit/api/test_wire_schema_contract.py`

**Interfaces:**
- Consumes: `snapshots_tbl.query_day_bid_peak(...)` and `query_day_bid_peak_dual(...)`.
- Produces: `build_bid_peak_slice(engine, *, code, date, bucket_ms, source="hogaplay", session_open_ms=None, session_close_ms=None, cache=None, today_kst=None) -> BidPeak | None`.
- Produces: `RangeBundle.bid_peaks` populated by `build_range_bundle`.

- [ ] **Step 1: Write failing bundle tests**

Add to `tests/hoga/api/test_bundle.py`:

```python
def test_build_bid_peak_slice_wires_untraded_peak(tmp_path) -> None:
    from hoga.api.bundle import build_bid_peak_slice

    from unittest.mock import MagicMock
    import duckdb
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    z = tuple([0] * 10)
    ap = tuple(70100 + 50 * i for i in range(10))
    aq = tuple([100] * 10)
    bp = (70000, 69000, 68900, 68800, 68700, 68600, 68500, 68400, 68300, 68200)
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=ap, ask_q=aq, ask_d=z,
        bid_p=bp, bid_q=(5000, 9000, 12000, 40, 5, 6, 7, 8, 9, 1), bid_d=z,
        tot_ask=sum(aq), tot_ask_d=0, tot_bid=26076, tot_bid_d=0,
    )
    tr = Trade(
        ts_ms=90050000, seq=1, price=70000, change_pct=0, qty=1, side=1,
        cum_vol=1, cum_trades=1, low_so_far=70000, high_so_far=70000,
        net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
    )
    snapshots_write_parquet([ob], tmp_path / "snapshots.parquet")
    trades_write_parquet([tr], tmp_path / "trades.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()

    p = build_bid_peak_slice(
        eng,
        code="005930",
        date="20260619",
        bucket_ms=60_000,
        source="hogaplay",
        session_open_ms=90000000,
        session_close_ms=153000000,
        cache=None,
        today_kst="20260620",
    )

    assert p is not None
    assert p.price == 70000
    assert p.qty == 5000
    assert p.untraded_price == 68900
    assert p.untraded_qty == 12000
```

Add a range-bundle assertion beside the existing ask peak range-bundle tests:

```python
def test_build_range_bundle_includes_bid_peaks(monkeypatch, tmp_path) -> None:
    import contextlib
    import duckdb
    from unittest.mock import patch
    import hoga.api.bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import BidPeak, VolumeProfile

    FIXTURE_DATE = "20260613"
    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: FIXTURE_DATE)
    eng = _engine_with_meta_for_dates([FIXTURE_DATE])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()
    eng.indicators_cache = None
    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=True) + [
        patch.object(
            bundle_mod,
            "build_bid_peak_slice",
            return_value=BidPeak(
                date=FIXTURE_DATE,
                price=70000,
                qty=5000,
                t_ms=1,
                max_price=70000,
                max_qty=5000,
                max_t_ms=1,
            ),
        ),
        patch.object(
            bundle_mod,
            "build_volume_profile_range",
            return_value=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[]),
        ),
    ]
    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        bundle = build_range_bundle(
            eng,
            code="005930",
            from_date=FIXTURE_DATE,
            to_date=FIXTURE_DATE,
            bucket_ms=60_000,
        )
    assert len(bundle.bid_peaks) == 1
    assert bundle.bid_peaks[0].price == 70000
    assert bundle.bid_peaks[0].qty == 5000
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest tests/hoga/api/test_bundle.py -k "bid_peak" -q
```

Expected: missing `build_bid_peak_slice` or missing `bid_peaks`.

- [ ] **Step 3: Implement bundle builder**

In `hoga/api/bundle.py`, import `BidPeak` and add:

```python
def build_bid_peak_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str = "hogaplay",
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
    cache: PastIndicatorsCache | None = None,
    today_kst: str | None = None,
) -> "BidPeak | None":
    cacheable = cache is not None and today_kst is not None and date != today_kst
    if cacheable and cache.has_bid_peak(code, date, source, bucket_ms):  # type: ignore[union-attr]
        return cache.get_bid_peak(code, date, source, bucket_ms)  # type: ignore[union-attr]
    peak = _compute_bid_peak(
        engine, code=code, date=date, source=source, bucket_ms=bucket_ms,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )
    if cacheable:
        cache.store_bid_peak(code, date, source, bucket_ms, peak)  # type: ignore[union-attr]
    return peak
```

Add `_compute_bid_peak(...)` parallel to `_compute_ask_peak(...)`, calling `snapshots_tbl.query_day_bid_peak_dual` when `trades.parquet` exists and `snapshots_tbl.query_day_bid_peak` otherwise. Map fields to `BidPeak` exactly as ask peak maps fields to `AskPeak`.

In `build_range_bundle`, add:

```python
bid_peaks: list[BidPeak] = []
```

Inside the per-date loop after `ap_d`, compute:

```python
bp_d = build_bid_peak_slice(
    engine, code=code, date=d, bucket_ms=bucket_ms, source=source,
    session_open_ms=norm_meta["regular_session_open_ms"],
    session_close_ms=meta["regular_session_close_ms"],
    cache=indicators_cache, today_kst=today_kst,
)
```

Append when non-null and return:

```python
bid_peaks=bid_peaks,
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
pytest tests/hoga/api/test_bundle.py -k "bid_peak or ask_peak" -q
pytest tests/unit/api/test_wire_schema_contract.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py tests/hoga/api/test_bundle.py tests/unit/api/test_wire_schema_contract.py
git commit -m "feat(api): include bid peaks in range bundle"
```

---

### Task 4: Live Today Bid Peak Backend

**Files:**
- Modify: `hoga/live/ask_peak_state.py`
- Modify: `hoga/live/stream.py`
- Modify: `hoga/live/lifecycle.py`
- Modify: `hoga/live/api.py`
- Modify: `hoga/api/app.py`
- Test: `tests/unit/live/test_ask_peak_state.py`
- Test: `tests/unit/live/test_stream.py`
- Test: `tests/unit/live/test_lifecycle.py`
- Test: `tests/unit/live/test_api.py`

**Interfaces:**
- Produces: `TodayBidPeakState` with `ingest_trade`, `ingest_orderbook(t_ms, bids)`, and `snapshot`.
- Produces: `stream.bid_peak_snapshot(code) -> dict | None`.
- Produces: `lifecycle.get_today_bid_peak(code) -> dict | None`.
- Produces: `/api/live/series` JSON field `bid_peak_today`.

- [ ] **Step 1: Write failing live-state tests**

Add to `tests/unit/live/test_ask_peak_state.py`:

```python
def test_today_bid_peak_tracks_traded_and_all_bid_peaks():
    from hoga.live.ask_peak_state import TodayBidPeakState

    state = TodayBidPeakState()
    state.ingest_orderbook(
        t_ms=1,
        bids=[
            {"price": 70000, "qty": 1000},
            {"price": 69000, "qty": 9000},
        ],
    )
    state.ingest_trade(price=70000, side=1)
    state.ingest_orderbook(
        t_ms=2,
        bids=[
            {"price": 70000, "qty": 5000},
            {"price": 68900, "qty": 12000},
        ],
    )

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [70000],
        "traded_price": 70000,
        "traded_qty": 5000,
        "traded_t_ms": 2,
        "all_price": 68900,
        "all_qty": 12000,
        "all_t_ms": 2,
    }
```

Add stream/API tests parallel to existing ask peak tests:

```python
async def test_on_tick_updates_today_bid_peak_state(tmp_path):
    stream = _make_stream(tmp_path, active_codes={"005930"})
    now = _kst_ms(9, 1)

    await stream.on_tick(_trade_tick(now, price=70000, side=1))
    await stream.on_tick(_bid_peak_ob_tick(now + 5_000))

    assert stream.bid_peak_snapshot("005930") == {
        "date": "20260619",
        "coverage": "partial",
        "traded_prices": [70000],
        "traded_price": 70000,
        "traded_qty": 5000,
        "traded_t_ms": now + 5_000,
        "all_price": 68900,
        "all_qty": 12000,
        "all_t_ms": now + 5_000,
    }
```

Add `_bid_peak_ob_tick` beside `_ask_peak_ob_tick` in `tests/unit/live/test_stream.py`:

```python
def _bid_peak_ob_tick(t_ms):
    return WsTick(
        code="005930",
        t_ms=t_ms,
        kind=SnapshotKind.OB,
        payload={
            "asks": [{"price": 70100 + i * 50, "qty": 100} for i in range(10)],
            "bids": [
                {"price": 70000, "qty": 5000},
                {"price": 68900, "qty": 12000},
                *[{"price": 68800 - i * 50, "qty": 100} for i in range(8)],
            ],
        },
    )
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest tests/unit/live/test_ask_peak_state.py tests/unit/live/test_stream.py -k "bid_peak" -q
```

Expected: missing `TodayBidPeakState` or `bid_peak_snapshot`.

- [ ] **Step 3: Implement live bid state and API wiring**

In `hoga/live/ask_peak_state.py`, add:

```python
@dataclass
class TodayBidPeakState:
    traded_prices: set[int] = field(default_factory=set)
    observed_price_peaks: dict[int, Peak] = field(default_factory=dict)
    traded_peak: Peak | None = None
    all_peak: Peak | None = None
    coverage: Literal["full", "partial"] = "partial"

    def ingest_trade(self, *, price: int, side: int) -> None:
        if side in (1, -1):
            self.traded_prices.add(price)
            observed = self.observed_price_peaks.get(price)
            if observed is not None:
                self.traded_peak = _larger_peak(
                    self.traded_peak,
                    price=observed.price,
                    qty=observed.qty,
                    t_ms=observed.t_ms,
                )

    def ingest_orderbook(self, *, t_ms: int, bids: Sequence[Mapping[str, int]]) -> None:
        for bid in bids:
            price = _positive_int(bid.get("price"))
            qty = _positive_int(bid.get("qty"))
            if price is None or qty is None:
                continue
            self.observed_price_peaks[price] = _larger_peak(
                self.observed_price_peaks.get(price),
                price=price,
                qty=qty,
                t_ms=t_ms,
            )
            self.all_peak = _larger_peak(self.all_peak, price=price, qty=qty, t_ms=t_ms)
            if price in self.traded_prices:
                self.traded_peak = _larger_peak(self.traded_peak, price=price, qty=qty, t_ms=t_ms)

    def snapshot(self) -> dict | None:
        if self.all_peak is None:
            return None
        traded = self.traded_peak
        all_peak = self.all_peak
        return {
            "coverage": self.coverage,
            "traded_prices": sorted(self.traded_prices),
            "traded_price": traded.price if traded is not None else None,
            "traded_qty": traded.qty if traded is not None else None,
            "traded_t_ms": traded.t_ms if traded is not None else None,
            "all_price": all_peak.price,
            "all_qty": all_peak.qty,
            "all_t_ms": all_peak.t_ms,
        }
```

In `hoga/live/stream.py`, add `_bid_peak_by_code`, reset/drop helpers, `bid_peak_snapshot`, optional `seed_bid_peak_from_live_file`, and in `_ingest_ask_peak` either rename to `_ingest_wall_peaks` or add bid logic:

```python
self._bid_peak_state(tick.code).ingest_orderbook(
    t_ms=tick.t_ms,
    bids=valid_bids,
)
```

Keep ask logic unchanged.

In `hoga/live/lifecycle.py`, add `get_today_bid_peak` parallel to `get_today_ask_peak`.

In `hoga/live/api.py`, add a `get_today_bid_peak` callable argument and response field:

```python
"bid_peak_today": (
    get_today_bid_peak(code) if get_today_bid_peak is not None else None
),
```

In `hoga/api/app.py`, pass `live_get_today_bid_peak`.

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
pytest tests/unit/live/test_ask_peak_state.py tests/unit/live/test_stream.py tests/unit/live/test_lifecycle.py tests/unit/live/test_api.py -k "peak" -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/ask_peak_state.py hoga/live/stream.py hoga/live/lifecycle.py hoga/live/api.py hoga/api/app.py tests/unit/live/test_ask_peak_state.py tests/unit/live/test_stream.py tests/unit/live/test_lifecycle.py tests/unit/live/test_api.py
git commit -m "feat(live): publish today bid peak"
```

---

### Task 5: Frontend State, Types, And Live Bid Peak Hook

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/state/chartPrefs.ts`
- Create: `frontend/src/live/computeDayBidPeak.ts`
- Create: `frontend/src/live/useDayBidPeaks.ts`
- Modify: `frontend/src/live/buildLiveBundle.ts`
- Test: `frontend/src/state/liveIndicatorsPersistence.test.ts`
- Test: `frontend/src/state/chartPrefs.test.ts`
- Test: `frontend/src/live/computeDayAskPeak.test.ts`
- Test: `frontend/src/live/buildLiveBundle.test.ts`

**Interfaces:**
- Produces frontend `BidPeak` type with the same shape as `AskPeak`.
- Produces `RangeBundle.bid_peaks?: BidPeak[]`.
- Produces `LiveSeriesResponse.bid_peak_today?: LiveTodayBidPeak | null`.
- Produces `useDayBidPeaks(ob, trade, seeds, todayKst, code, todayBidPeak, todayCandles) -> BidPeak[]`.

- [ ] **Step 1: Write failing frontend state/type tests**

In `frontend/src/state/liveIndicatorsPersistence.test.ts`, add:

```typescript
it('bid peak prefs default to opt-in false with KRX buy colors', () => {
  const merged = mergeLiveIndicatorPrefs(undefined);
  expect(merged.bidPeakEnabled).toBe(false);
  expect(merged.bidPeakColor).toBe('#DC2626');
  expect(merged.bidPeakLineWidth).toBe(2);
  expect(merged.bidPeakAllPriceColor).toBe('#F97316');
  expect(merged.bidPeakAllPriceLineWidth).toBe(1);
});
```

In `frontend/src/state/chartPrefs.test.ts`, add:

```typescript
describe('bid peak toggles', () => {
  it('defaults and belongs to the indicator modal', () => {
    const intra = CHART_TOGGLES.find((t) => t.key === 'bidPeakIntraMax');
    const allPrices = CHART_TOGGLES.find((t) => t.key === 'bidPeakShowAllPrices');

    expect(intra?.default).toBe(false);
    expect(categoryOf(intra!)).toBe('indicator-modal');
    expect(allPrices?.default).toBe(true);
    expect(allPrices?.label).toBe('미체결 최대 매수벽 표시');
    expect(categoryOf(allPrices!)).toBe('indicator-modal');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/chartPrefs.test.ts
```

Expected: missing bid fields/toggles.

- [ ] **Step 3: Implement prefs and chart toggles**

In `frontend/src/state/liveIndicatorsPersistence.ts`, add constants:

```typescript
export const BID_PEAK_DEFAULT_COLOR = '#DC2626';
export const BID_PEAK_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 2;
export const BID_PEAK_ALL_PRICE_DEFAULT_COLOR = '#F97316';
export const BID_PEAK_ALL_PRICE_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 1;
```

Add fields to `PersistedIndicators`, merge validation, and the `build(...)` return object.

In `frontend/src/state/livePage.ts`, add fields to `snapshotIndicators`, store type, and setters:

```typescript
setBidPeakEnabled: (enabled: boolean) => void;
setBidPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
setBidPeakAllPriceStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
```

Implement setters parallel to ask peak.

In `frontend/src/state/chartPrefs.ts`, add:

```typescript
{
  key: 'bidPeakIntraMax',
  label: '분봉 내 최댓값 기준',
  description:
    '분봉 종가 호가창 대신 분봉 내 순간 최대 매수벽까지 포함해 당일 최대벽을 찾습니다(과거 거래일에만 효과 — 오늘은 항상 실시간 최댓값).',
  default: false,
  category: 'indicator-modal',
},
{
  key: 'bidPeakShowAllPrices',
  label: '미체결 최대 매수벽 표시',
  description: '당일 저가보다 아래에 있는 미체결 추정 매수벽 수량이 체결가격 기준 최대벽 수량보다 클 때만 두 라인을 함께 표시합니다.',
  default: true,
  category: 'indicator-modal',
},
```

- [ ] **Step 4: Add bid peak types and bundle pass-through**

In `frontend/src/api/types.ts`, add:

```typescript
export type BidPeak = AskPeak;
```

Add `bid_peaks?: BidPeak[]` to `RangeBundle`.

In `frontend/src/api/liveSeries.ts`, add:

```typescript
export type LiveTodayBidPeak = LiveTodayAskPeak;
```

and add this field to `LiveSeriesResponse`:

```typescript
bid_peak_today: LiveTodayBidPeak | null;
```

In `frontend/src/live/buildLiveBundle.ts`, return:

```typescript
bid_peaks: pastBundle?.bid_peaks ?? [],
```

Update test fixture bundles with `bid_peaks: []` only where strict type errors require it.

- [ ] **Step 5: Add bid day reducer and hook**

Create `frontend/src/live/computeDayBidPeak.ts` by mirroring `computeDayAskPeak.ts`, changing bid naming and using `ob.bids` in the fold.

The exported functions must be:

```typescript
export type DayPeak = { price: number; qty: number; t_ms: number };
export type RatchetState = { peak: DayPeak | null; tradingDay: number; lastTMs: number };
export const FRESH_RATCHET: RatchetState = { peak: null, tradingDay: -1, lastTMs: -1 };
export function foldBidPeak(...): RatchetState;
export function reduceDayBidPeak(...): RatchetState;
```

Create `frontend/src/live/useDayBidPeaks.ts` by mirroring `useDayAskPeaks.ts`, with:

- `buildTodayTradedBidPeak`
- `buildTodayCandleRangeBidPeak`
- `observeBidPricePeaks`
- `bestTradedObservedPeak`
- `useDayBidPeaks`

The candle-range predicate must still use `price >= candle.low && price <= candle.high` for baseline eligibility.

- [ ] **Step 6: Run tests to verify pass**

Run:

```bash
cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/chartPrefs.test.ts src/live/buildLiveBundle.test.ts
cd frontend && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/livePage.ts frontend/src/state/chartPrefs.ts frontend/src/live/computeDayBidPeak.ts frontend/src/live/useDayBidPeaks.ts frontend/src/live/buildLiveBundle.ts frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/state/chartPrefs.test.ts frontend/src/live/buildLiveBundle.test.ts
git commit -m "feat(frontend): add bid peak state and hook"
```

---

### Task 6: Frontend Bid Peak Overlay

**Files:**
- Create: `frontend/src/live/LiveBidPeakSegments.tsx`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Test: `frontend/src/live/LiveAskPeakSegments.test.tsx`
- Test: `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`

**Interfaces:**
- Consumes: `BidPeak`, `useDayBidPeaks`, `bidPeakEnabled`, `bidPeakIntraMax`, `bidPeakShowAllPrices`.
- Produces: `buildBidPeakOverlaySegments(...) -> AskPeakSegment[]`.
- Produces: `<LiveBidPeakSegments ... />`.

- [ ] **Step 1: Write failing overlay tests**

Add to `frontend/src/live/LiveAskPeakSegments.test.tsx` or create `LiveBidPeakSegments.test.tsx`:

```typescript
it('buildBidPeakOverlaySegments renders untraded line only when larger than baseline', () => {
  const segments = [{ date: '20260619', session_open_ms: 1_000, session_close_ms: 2_000, source: 'kis_live' as const }];
  const candles = [{ ts_ms: 1_500, open: 70000, high: 70100, low: 69900, close: 70050, vol_a: 0, vol_b: 0 }];
  const axis = { toVirtual: (ms: number) => ms } as any;
  const peaks = [{
    date: '20260619',
    price: 70000,
    qty: 5000,
    t_ms: 1_500,
    max_price: 70000,
    max_qty: 5000,
    max_t_ms: 1_500,
    untraded_price: 69000,
    untraded_qty: 12000,
    untraded_t_ms: 1_500,
    untraded_max_price: 69000,
    untraded_max_qty: 12000,
    untraded_max_t_ms: 1_500,
  }];

  const out = buildBidPeakOverlaySegments({
    dayBidPeaks: peaks,
    todayAllPriceBidPeak: null,
    segments,
    candles,
    axis,
    todayKst: '20260619',
    baselineStyle: { color: '#DC2626', lineWidth: 2 },
    allPriceStyle: { color: '#F97316', lineWidth: 1 },
    intraMax: false,
    showAllPrices: true,
  });

  expect(out).toHaveLength(2);
  expect(out[0].price).toBe(70000);
  expect(out[1].price).toBe(69000);
});
```

In `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`, mock `LiveBidPeakSegments` like ask peak and assert minute-only mount:

```typescript
vi.mock('./LiveBidPeakSegments', () => ({
  default: () => {
    bidPeakMounts.push('mounted');
    return null;
  },
}));

it('1m mounts bid peak overlay, calendar does not', () => {
  renderAt('1m');
  expect(bidPeakMounts).toHaveLength(1);
  bidPeakMounts.length = 0;
  renderAt('D');
  expect(bidPeakMounts).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected: missing `LiveBidPeakSegments` and `buildBidPeakOverlaySegments`.

- [ ] **Step 3: Implement `LiveBidPeakSegments.tsx`**

Copy `LiveAskPeakSegments.tsx` to `LiveBidPeakSegments.tsx` and rename:

- `buildAskPeakSegments` -> `buildBidPeakSegments`
- `buildAskPeakOverlaySegments` -> `buildBidPeakOverlaySegments`
- `dayAskPeaks` -> `dayBidPeaks`
- `todayAllPriceAskPeak` -> `todayAllPriceBidPeak`
- store fields from `askPeak*` to `bidPeak*`
- prefs from `askPeakIntraMax`/`askPeakShowAllPrices` to `bidPeakIntraMax`/`bidPeakShowAllPrices`

Keep `AskPeakSegmentsPrimitive` as the renderer; the primitive is side-neutral despite its current name.

- [ ] **Step 4: Wire `LivePage`, `LiveWorkarea`, and `LiveChartRoot`**

In `frontend/src/live/LivePage.tsx`, import:

```typescript
import { useDayBidPeaks, useTodayAllPriceBidPeak } from './useDayBidPeaks';
```

Beside the ask-peak block, add:

```typescript
const bidPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
const bidPeakTrade = isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS;
const bidPeakSeeds = (chartBundle ?? bundle)?.bid_peaks ?? EMPTY_BID_PEAKS;
const bidPeakCandles = isMinuteTimeframe(timeframe) ? ((chartBundle ?? bundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
const dayBidPeaks = useDayBidPeaks(
  bidPeakOb,
  bidPeakTrade,
  bidPeakSeeds,
  today,
  activeCode,
  live.initial?.bid_peak_today ?? null,
  bidPeakCandles,
);
const todayAllPriceBidPeak = useTodayAllPriceBidPeak(
  bidPeakOb,
  bidPeakSeeds,
  today,
  activeCode,
  live.initial?.bid_peak_today ?? null,
);
```

Add `const EMPTY_BID_PEAKS: readonly BidPeak[] = [];` near `EMPTY_ASK_PEAKS`.

Pass the new props to `LiveWorkarea`:

```tsx
dayBidPeaks={dayBidPeaks}
todayAllPriceBidPeak={todayAllPriceBidPeak}
```

In `frontend/src/live/LiveWorkarea.tsx`, add props:

```typescript
dayBidPeaks?: readonly BidPeak[];
todayAllPriceBidPeak?: BidPeak | null;
```

and pass them to `LiveChartRoot`.

In `frontend/src/live/LiveChartRoot.tsx`, import `BidPeak` and `LiveBidPeakSegments`, add an `EMPTY_BID_PEAKS` default, add props:

```typescript
dayBidPeaks?: readonly BidPeak[];
todayAllPriceBidPeak?: BidPeak | null;
```

Under the existing `<LiveAskPeakSegments />` minute-only block, add:

```tsx
<LiveBidPeakSegments
  paneSeries={paneSeries}
  axis={axis}
  dayBidPeaks={dayBidPeaks}
  todayAllPriceBidPeak={todayAllPriceBidPeak}
  segments={cb.segments}
  candles={cb.candles}
  todayKst={todayKst}
/>
```

- [ ] **Step 5: Run tests to verify pass**

Run:

```bash
cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx src/live/LiveChartRoot.paneToggles.test.tsx
cd frontend && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/LiveBidPeakSegments.tsx frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveAskPeakSegments.test.tsx frontend/src/live/LiveChartRoot.paneToggles.test.tsx
git commit -m "feat(live): render bid peak overlay"
```

---

### Task 7: Indicator Modal Bid Peak UI

**Files:**
- Create: `frontend/src/live/indicators/BidPeakConfig.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx`
- Test: `frontend/src/live/indicators/IntraMaxConfigRows.test.tsx`

**Interfaces:**
- Consumes: `bidPeakEnabled`, `setBidPeakEnabled`, `setBidPeakStyle`, `setBidPeakAllPriceStyle`.
- Produces: `BidPeakConfig` detail pane.
- Produces: indicator category `당일 매수 최대벽`.

- [ ] **Step 1: Write failing UI tests**

Add to `frontend/src/live/indicators/IndicatorPanel.test.tsx`:

```typescript
it('당일 매수 최대벽 카테고리 토글', () => {
  useLivePageStore.setState({ bidPeakEnabled: false });
  render(<IndicatorPanel onClose={() => {}} />);
  const cb = screen.getByRole('checkbox', { name: '당일 매수 최대벽' });
  fireEvent.click(cb);
  expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
});

it('매수 최대벽 선택 시 스타일 pane과 토글 표시', () => {
  render(<IndicatorPanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '당일 매수 최대벽' }));
  expect(screen.getByRole('button', { name: '체결가격 기준 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '미체결 포함 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByTestId('settings-toggle-bidPeakIntraMax')).toBeTruthy();
  expect(screen.getByTestId('settings-toggle-bidPeakShowAllPrices')).toBeTruthy();
});
```

Add to `frontend/src/live/indicators/IntraMaxConfigRows.test.tsx`:

```typescript
it('BidPeakConfig에 bidPeakIntraMax 토글', () => {
  render(<BidPeakConfig />);
  expect(screen.getByTestId('settings-toggle-bidPeakIntraMax')).toBeTruthy();
});

it('BidPeakConfig에 bidPeakShowAllPrices 토글', () => {
  render(<BidPeakConfig />);
  expect(screen.getByTestId('settings-toggle-bidPeakShowAllPrices')).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/live/indicators/IndicatorPanel.test.tsx src/live/indicators/IntraMaxConfigRows.test.tsx
```

Expected: missing bid category/config.

- [ ] **Step 3: Implement `BidPeakConfig`**

Create `frontend/src/live/indicators/BidPeakConfig.tsx`:

```tsx
import { useLivePageStore } from '../../state/livePage';
import MAStylePicker from './MAStylePicker';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

export default function BidPeakConfig() {
  const color = useLivePageStore((s) => s.bidPeakColor);
  const lineWidth = useLivePageStore((s) => s.bidPeakLineWidth);
  const allPriceColor = useLivePageStore((s) => s.bidPeakAllPriceColor);
  const allPriceLineWidth = useLivePageStore((s) => s.bidPeakAllPriceLineWidth);
  const setStyle = useLivePageStore((s) => s.setBidPeakStyle);
  const setAllPriceStyle = useLivePageStore((s) => s.setBidPeakAllPriceStyle);
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        당일 매수 최대벽 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        차트에 보이는 거래일마다, 그 날 매수 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼
        수평선을 그립니다. 미체결 포함 최대벽은 체결가격 기준 최대벽보다 물량이 클 때만 함께 표시됩니다.
        분봉 차트에서만 표시됩니다.
      </p>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">체결가격 기준 최대벽</span>
          <MAStylePicker color={color} lineWidth={lineWidth} onChange={setStyle} label="체결가격 기준 최대벽" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">미체결 포함 최대벽</span>
          <MAStylePicker
            color={allPriceColor}
            lineWidth={allPriceLineWidth}
            onChange={setAllPriceStyle}
            label="미체결 포함 최대벽"
          />
        </div>
      </div>
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['bidPeakIntraMax', 'bidPeakShowAllPrices']} />
    </div>
  );
}
```

- [ ] **Step 4: Wire `IndicatorPanel`**

In `frontend/src/live/indicators/IndicatorPanel.tsx`:

- import `BidPeakConfig`
- add `'bid-peak'` to `CategoryId`
- add `{ id: 'bid-peak', label: '당일 매수 최대벽', group: 'hoga' }`
- read `bidPeakEnabled` and `setBidPeakEnabled`
- add switch cases in `checkedFor` and `toggleFor`
- render `{selected === 'bid-peak' && <BidPeakConfig />}`

- [ ] **Step 5: Run tests to verify pass**

Run:

```bash
cd frontend && npx vitest run src/live/indicators/IndicatorPanel.test.tsx src/live/indicators/IntraMaxConfigRows.test.tsx
cd frontend && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/indicators/BidPeakConfig.tsx frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx frontend/src/live/indicators/IntraMaxConfigRows.test.tsx
git commit -m "feat(live): add bid peak indicator controls"
```

---

### Task 8: Full Verification And Release Notes

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified end-to-end bid peak indicator.

- [ ] **Step 1: Run backend targeted tests**

Run:

```bash
pytest tests/test_tables_snapshots.py -k "bid_peak or ask_peak" -q
pytest tests/hoga/api/test_bundle.py -k "bid_peak or ask_peak" -q
pytest tests/unit/live/test_ask_peak_state.py tests/unit/live/test_stream.py tests/unit/live/test_lifecycle.py tests/unit/live/test_api.py -k "peak" -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend targeted tests**

Run:

```bash
cd frontend && npx vitest run \
  src/state/liveIndicatorsPersistence.test.ts \
  src/state/chartPrefs.test.ts \
  src/live/LiveAskPeakSegments.test.tsx \
  src/live/LiveChartRoot.paneToggles.test.tsx \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/live/indicators/IntraMaxConfigRows.test.tsx \
  src/live/buildLiveBundle.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run type/build checks**

Run:

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 4: Add changelog entry**

Add to the top unreleased section of `CHANGELOG.md`:

```markdown
- **/live 당일 매수 최대벽 지표 추가**: 기존 당일 매도 최대벽과 동일한 구조로 매수 10호가 기준 최대벽을
  표시한다. 체결가격 기준 최대벽과 미체결 포함 최대벽(당일 저가 아래 매수벽이 baseline보다 큰 경우)을
  지원하며, 「지표」 모달에서 마스터 토글·분봉 내 최댓값 기준·미체결 표시 토글과 선 스타일을 설정할 수 있다.
```

- [ ] **Step 5: Run final status**

Run:

```bash
git status --short
```

Expected: only intended files modified.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: note live bid peak indicator"
```
