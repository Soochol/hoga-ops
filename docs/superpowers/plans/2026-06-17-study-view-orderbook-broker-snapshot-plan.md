# Study View Orderbook and Broker Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend saved study-view snapshots so `/study` hover detail can restore bucket-aligned 10-level orderbook and broker state for every saved visible candle.

**Architecture:** Keep the existing frozen snapshot model. The backend enriches a validated `ParquetStudySnapshot` during create/update by batch-reading parquet per `(Stock-Date, Source)`, then writes the enriched snapshot JSON atomically. The frontend treats the new detail arrays as optional legacy-compatible snapshot data and renders restored detail from the snapshot, not from live/parquet fetches.

**Tech Stack:** Python 3.11+, FastAPI, Pydantic v2, DuckDB/PyArrow parquet helpers, pytest, React 18, TypeScript, Vitest, lightweight-charts.

## Global Constraints

- Existing snapshot-based saved study views remain valid and loadable.
- New detail arrays are dense: when non-empty, their length and `t` values match saved `bundle.candles`.
- Orderbook detail uses the same bucket representative convention as `/api/orderbook?bucket_ms=<bucket_ms>`: last continuous-trading representative inside `[bucket_start, bucket_start + bucket_ms)`.
- Broker detail is day-to-date cumulative net at the bucket representative time, not within-bucket delta.
- Broker detail stores at most 10 brokers per bucket using the same ordering policy as the Cursor Sidebar broker card.
- Detail enrichment failures never block saving the chart snapshot; they populate structured `detail_warnings`.
- Save enrichment must batch parquet reads by `(Stock-Date, Source)`, not issue one orderbook query and one broker query per candle.
- `/study` hover detail reads from the saved snapshot; it does not call `/api/orderbook`, `/api/brokers/series`, live SSE, or `/api/range`.

---

## File Structure

- `hoga/api/models.py`: add study detail wire models and validation rules on `StudySnapshotBundle`.
- `hoga/tables/snapshots.py`: add a batch helper that returns orderbook bucket representatives keyed by native bucket start.
- `hoga/tables/brokers.py`: add a batch helper that returns top-10 cumulative broker detail keyed by native bucket start.
- `hoga/api/study_view_enrichment.py`: new backend orchestration module for grouping candles by segment/date/source, querying table helpers, and returning an enriched `ParquetStudySnapshot`.
- `hoga/api/study_views.py`: call the enrichment helper before writing create/update snapshot files.
- `tests/api/test_study_views.py`: model validation, persistence, and enrichment integration tests.
- `frontend/src/api/studyViews.ts`: mirror the new detail types.
- `frontend/src/studyViews/studySnapshotAdapter.ts`: expose orderbook/broker lookup maps and bucket resolution helpers.
- `frontend/src/studyViews/StudyDetailPanel.tsx`: new restored snapshot detail panel using existing `OrderbookTable` and broker display conventions.
- `frontend/src/studyViews/StudyPage.tsx`: render the detail panel and pass snapshot detail lookup data.
- `frontend/src/studyViews/*.test.*`: unit tests for adapter and page rendering.

---

### Task 1: Backend Snapshot Detail Models

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `tests/api/test_study_views.py`

**Interfaces:**
- Produces: `StudyOrderbookBucket`, `StudyBrokerDetail`, `StudyBrokerBucket`, `StudyDetailWarning`
- Produces: `StudySnapshotBundle.orderbook_buckets`, `.broker_buckets`, `.detail_warnings`
- Produces: `StudySegment.source` persisted on new snapshots, defaulting to `"hogaplay"` for legacy snapshots
- Produces validation invariant: non-empty detail arrays align index-wise with `StudySnapshotBundle.candles`

- [ ] **Step 1: Write failing model tests**

Add these tests near the existing `ParquetStudySnapshot` validation tests in `tests/api/test_study_views.py`:

```python
def _orderbook_bucket(t=1_000, *, available=True):
    return {
        "t": t,
        "available": available,
        "snapshot": {
            "ts_ms": t + 59_000,
            "seq": 1,
            "ask": [{"price": 70_100 + i, "qty": 10 + i} for i in range(10)],
            "bid": [{"price": 70_000 - i, "qty": 20 + i} for i in range(10)],
            "tot_ask": 145,
            "tot_bid": 245,
        } if available else None,
    }


def _broker_bucket(t=1_000, *, available=True):
    return {
        "t": t,
        "available": available,
        "brokers": [
            {"broker": "키움증권", "net": 100, "dominant_side": "buy"},
            {"broker": "JP모간", "net": -80, "dominant_side": "sell"},
        ] if available else [],
    }


def test_study_snapshot_defaults_detail_arrays_for_legacy_snapshots():
    snap = ParquetStudySnapshot.model_validate(_snapshot())

    assert snap.bundle.orderbook_buckets == []
    assert snap.bundle.broker_buckets == []
    assert snap.bundle.detail_warnings == []


def test_study_snapshot_accepts_aligned_detail_arrays():
    raw = _snapshot()
    raw["bundle"]["orderbook_buckets"] = [_orderbook_bucket(1_000)]
    raw["bundle"]["broker_buckets"] = [_broker_bucket(1_000)]
    raw["bundle"]["detail_warnings"] = [
        {"kind": "orderbook", "t": 1_000, "code": "005930", "date": "20260616", "message": "missing representative"}
    ]

    snap = ParquetStudySnapshot.model_validate(raw)

    assert snap.bundle.orderbook_buckets[0].t == 1_000
    assert snap.bundle.orderbook_buckets[0].available is True
    assert snap.bundle.broker_buckets[0].brokers[0].net == 100
    assert snap.bundle.detail_warnings[0].kind == "orderbook"


def test_study_snapshot_rejects_detail_length_mismatch():
    raw = _snapshot()
    raw["bundle"]["orderbook_buckets"] = [_orderbook_bucket(1_000), _orderbook_bucket(2_000)]

    with pytest.raises(ValidationError, match="orderbook_buckets must align"):
        ParquetStudySnapshot.model_validate(raw)


def test_study_snapshot_rejects_detail_t_mismatch():
    raw = _snapshot()
    raw["bundle"]["broker_buckets"] = [_broker_bucket(1_001)]

    with pytest.raises(ValidationError, match="broker_buckets must align"):
        ParquetStudySnapshot.model_validate(raw)


def test_study_snapshot_rejects_available_orderbook_without_snapshot():
    raw = _snapshot()
    raw["bundle"]["orderbook_buckets"] = [{"t": 1_000, "available": True, "snapshot": None}]

    with pytest.raises(ValidationError, match="available orderbook buckets require snapshot"):
        ParquetStudySnapshot.model_validate(raw)


def test_study_snapshot_rejects_available_broker_bucket_without_brokers():
    raw = _snapshot()
    raw["bundle"]["broker_buckets"] = [{"t": 1_000, "available": True, "brokers": []}]

    with pytest.raises(ValidationError, match="available broker buckets require brokers"):
        ParquetStudySnapshot.model_validate(raw)
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
uv run pytest tests/api/test_study_views.py::test_study_snapshot_defaults_detail_arrays_for_legacy_snapshots tests/api/test_study_views.py::test_study_snapshot_accepts_aligned_detail_arrays tests/api/test_study_views.py::test_study_snapshot_rejects_detail_length_mismatch tests/api/test_study_views.py::test_study_snapshot_rejects_detail_t_mismatch tests/api/test_study_views.py::test_study_snapshot_rejects_available_orderbook_without_snapshot tests/api/test_study_views.py::test_study_snapshot_rejects_available_broker_bucket_without_brokers -q
```

Expected: FAIL because `StudySnapshotBundle` has no `orderbook_buckets`, `broker_buckets`, or `detail_warnings`.

- [ ] **Step 3: Add Pydantic models**

In `hoga/api/models.py`, near the existing study snapshot point models, add:

```python
class StudyOrderbookBucket(BaseModel):
    t: int
    snapshot: ApiOrderbookSnapshot | None = None
    available: bool

    @model_validator(mode="after")
    def _available_has_snapshot(self):
        if self.available and self.snapshot is None:
            raise ValueError("available orderbook buckets require snapshot")
        return self


class StudyBrokerDetail(BaseModel):
    broker: str
    net: int
    dominant_side: Literal["buy", "sell"]


class StudyBrokerBucket(BaseModel):
    t: int
    brokers: list[StudyBrokerDetail]
    available: bool

    @model_validator(mode="after")
    def _available_has_brokers(self):
        if self.available and not self.brokers:
            raise ValueError("available broker buckets require brokers")
        return self


class StudyDetailWarning(BaseModel):
    kind: Literal["orderbook", "broker"]
    t: int | None = None
    code: str = Field(pattern=CODE_PATTERN)
    date: str | None = None
    message: str
```

Modify `StudySegment` to persist source provenance for saved snapshots:

```python
class StudySegment(BaseModel):
    date: str
    session_open_ms: int
    session_close_ms: int
    source: SourceName = "hogaplay"
```

Modify `StudySnapshotBundle` fields:

```python
class StudySnapshotBundle(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    segments: list[StudySegment]
    candles: list[StudyCandlePoint]
    quote_totals: list[StudyQuoteTotalsPoint]
    ratio: list[StudyRatioPoint]
    fill_strength: list[StudyFillStrengthPoint]
    ask_peaks: list[AskPeak] = Field(default_factory=list)
    data_warnings: list[str] = Field(default_factory=list)
    orderbook_buckets: list[StudyOrderbookBucket] = Field(default_factory=list)
    broker_buckets: list[StudyBrokerBucket] = Field(default_factory=list)
    detail_warnings: list[StudyDetailWarning] = Field(default_factory=list)
```

Extend `StudySnapshotBundle._validate_bundle()` with:

```python
        candle_ts = [p.t for p in self.candles]
        for name in ("orderbook_buckets", "broker_buckets"):
            detail = getattr(self, name)
            if not detail:
                continue
            detail_ts = [p.t for p in detail]
            if detail_ts != candle_ts:
                raise ValueError(f"{name} must align with candles by t")
```

- [ ] **Step 4: Run model tests and verify pass**

Run:

```bash
uv run pytest tests/api/test_study_views.py::test_study_snapshot_defaults_detail_arrays_for_legacy_snapshots tests/api/test_study_views.py::test_study_snapshot_accepts_aligned_detail_arrays tests/api/test_study_views.py::test_study_snapshot_rejects_detail_length_mismatch tests/api/test_study_views.py::test_study_snapshot_rejects_detail_t_mismatch tests/api/test_study_views.py::test_study_snapshot_rejects_available_orderbook_without_snapshot tests/api/test_study_views.py::test_study_snapshot_rejects_available_broker_bucket_without_brokers -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/api/test_study_views.py
git commit -m "feat: add study snapshot detail models"
```

---

### Task 2: Table-Level Batch Representative Helpers

**Files:**
- Modify: `hoga/tables/snapshots.py`
- Modify: `hoga/tables/brokers.py`
- Modify: `tests/test_tables_snapshots.py`
- Modify: `tests/test_tables_brokers.py`

**Interfaces:**
- Produces: `snapshots.query_bucket_representatives(con, *, path: Path, buckets: list[tuple[int, int]], session_close_ms: int | None = None) -> dict[int, ApiOrderbookSnapshot]`
- Produces: `brokers.query_cumulative_details_at(con, *, path: Path, t_values: list[int], limit: int = 10) -> dict[int, list[BrokerDetailRow]]`
- Produces dataclass: `BrokerDetailRow(broker: str, net: int, dominant_side: Literal["buy", "sell"])`

- [ ] **Step 1: Write failing snapshot batch helper test**

Add to `tests/test_tables_snapshots.py`:

```python
def test_query_bucket_representatives_returns_last_continuous_snapshot_per_bucket(tmp_path):
    import duckdb
    from hoga.tables.snapshots import Orderbook, write_parquet, query_bucket_representatives

    def ob(ts_ms: int, seq: int, *, ask0: int, bid0: int, deep: bool) -> Orderbook:
        z = tuple(0 for _ in range(10))
        ask_p = tuple(ask0 + i for i in range(10))
        bid_p = tuple(bid0 - i for i in range(10))
        if deep:
            ask_q = tuple(10 + i for i in range(10))
            bid_q = tuple(20 + i for i in range(10))
        else:
            ask_q = (1, 1, 1, *([0] * 7))
            bid_q = (1, 1, 1, *([0] * 7))
        return Orderbook(
            ts_ms=ts_ms,
            seq=seq,
            ask_p=ask_p,
            ask_q=ask_q,
            ask_d=z,
            bid_p=bid_p,
            bid_q=bid_q,
            bid_d=z,
            tot_ask=sum(ask_q),
            tot_ask_d=0,
            tot_bid=sum(bid_q),
            tot_bid_d=0,
        )

    path = tmp_path / "snapshots.parquet"
    deep_early = ob(90_000_000, 1, ask0=101, bid0=100, deep=True)
    deep_late = ob(90_000_500, 2, ask0=102, bid0=99, deep=True)
    auction = ob(90_001_000, 3, ask0=103, bid0=98, deep=False)
    write_parquet([deep_early, deep_late, auction], path)

    with duckdb.connect(":memory:") as con:
        out = query_bucket_representatives(
            con,
            path=path,
            buckets=[(90_000_000, 90_059_999)],
            session_close_ms=153000000,
        )

    assert out[90_000_000].seq == 2
    assert out[90_000_000].ask[0].price == 102
```

- [ ] **Step 2: Write failing broker batch helper test**

Add to `tests/test_tables_brokers.py`:

```python
def test_query_cumulative_details_at_returns_top10_at_each_cursor(tmp_path):
    import duckdb
    from hoga.tables.brokers import BrokerRow, write_parquet, query_cumulative_details_at

    path = tmp_path / "brokers.parquet"
    rows = [
        BrokerRow(ts_ms=90_000_000, seq=1, side="buy", rank=1, broker="키움증권", qty_today=100, qty_delta=0),
        BrokerRow(ts_ms=90_000_000, seq=1, side="sell", rank=1, broker="JP모간", qty_today=80, qty_delta=0),
        BrokerRow(ts_ms=90_060_000, seq=2, side="buy", rank=1, broker="키움증권", qty_today=120, qty_delta=0),
        BrokerRow(ts_ms=90_060_000, seq=2, side="sell", rank=1, broker="JP모간", qty_today=200, qty_delta=0),
    ]
    write_parquet(rows, path)

    with duckdb.connect(":memory:") as con:
        out = query_cumulative_details_at(con, path=path, t_values=[90_000_000, 90_060_000])

    assert [(r.broker, r.net, r.dominant_side) for r in out[90_000_000]] == [
        ("키움증권", 100, "buy"),
        ("JP모간", -80, "sell"),
    ]
    assert out[90_060_000][0].broker == "JP모간"
    assert out[90_060_000][0].net == -200
    assert out[90_060_000][0].dominant_side == "sell"
```

- [ ] **Step 3: Run helper tests and verify failure**

Run:

```bash
uv run pytest tests/test_tables_snapshots.py::test_query_bucket_representatives_returns_last_continuous_snapshot_per_bucket tests/test_tables_brokers.py::test_query_cumulative_details_at_returns_top10_at_each_cursor -q
```

Expected: FAIL because the helper functions do not exist.

- [ ] **Step 4: Implement snapshot batch helper**

In `hoga/tables/snapshots.py`, add a batch helper that scans `snapshots.parquet` once for the native range covering all requested buckets:

```python
def query_bucket_representatives(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    buckets: list[tuple[int, int]],
    session_close_ms: int | None = None,
) -> dict[int, ApiOrderbookSnapshot]:
    """Return last continuous-trading representative snapshots keyed by lo_native."""
    if not buckets:
        return {}
    min_lo = min(lo for lo, _hi in buckets)
    max_hi = max(hi for _lo, hi in buckets)
    rows = con.execute(
        f"""
        SELECT {_SELECT}
        FROM read_parquet(?)
        WHERE ts_ms BETWEEN ? AND ?
        ORDER BY ts_ms ASC, seq ASC
        """,
        [str(path), min_lo, max_hi],
    ).fetchall()

    candidates = [_row_to_api_snapshot(r) for r in rows]
    out: dict[int, ApiOrderbookSnapshot] = {}
    for lo_native, hi_native in buckets:
        eligible = [
            s for s in candidates
            if lo_native <= s.ts_ms <= hi_native
            and _is_continuous_snapshot(s, session_close_ms=session_close_ms)
        ]
        if eligible:
            out[int(lo_native)] = eligible[-1]
    return out
```

If `hoga/tables/snapshots.py` does not already expose a reusable continuous-trading predicate, extract the existing predicate used by `query_bucket_representative` into a private `_is_continuous_snapshot(snapshot, *, session_close_ms)` helper and use it from both paths so `/api/orderbook?bucket_ms=` and saved-view enrichment cannot drift.

- [ ] **Step 5: Implement broker batch helper**

In `hoga/tables/brokers.py`, add:

```python
@dataclass(frozen=True)
class BrokerDetailRow:
    broker: str
    net: int
    dominant_side: BrokerSide


def query_cumulative_details_at(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    t_values: list[int],
    limit: int = 10,
) -> dict[int, list[BrokerDetailRow]]:
    """Top broker cumulative net at each native cursor timestamp.

    The result mirrors Cursor Sidebar ordering: abs(net) desc, then net desc.
    """
    from hoga.broker_names import canonical

    if not t_values:
        return {}
    uniq = sorted({int(t) for t in t_values})
    rows = con.execute(
        """
        SELECT
            t.cursor_ts,
            p.broker,
            p.ts_ms,
            SUM(CASE WHEN p.side = 'buy' THEN p.qty_today ELSE -p.qty_today END) AS net
        FROM (SELECT UNNEST(?::BIGINT[]) AS cursor_ts) AS t
        JOIN read_parquet(?) AS p
          ON p.ts_ms <= t.cursor_ts
        GROUP BY t.cursor_ts, p.broker, p.ts_ms
        ORDER BY t.cursor_ts, p.broker, p.ts_ms
        """,
        [uniq, str(path)],
    ).fetchall()

    latest: dict[tuple[int, str], tuple[int, int]] = {}
    for cursor_ts, raw_broker, ts_ms, net in rows:
        key = (int(cursor_ts), canonical(raw_broker))
        prev = latest.get(key)
        if prev is None or int(ts_ms) >= prev[0]:
            latest[key] = (int(ts_ms), int(net))

    grouped: dict[int, list[BrokerDetailRow]] = {t: [] for t in uniq}
    for (cursor_ts, broker), (_ts_ms, net) in latest.items():
        grouped[cursor_ts].append(
            BrokerDetailRow(
                broker=broker,
                net=net,
                dominant_side="buy" if net >= 0 else "sell",
            )
        )
    for cursor_ts, details in grouped.items():
        details.sort(key=lambda r: (-abs(r.net), -r.net))
        grouped[cursor_ts] = details[:limit]
    return grouped
```

- [ ] **Step 6: Run helper tests and verify pass**

Run:

```bash
uv run pytest tests/test_tables_snapshots.py::test_query_bucket_representatives_returns_last_continuous_snapshot_per_bucket tests/test_tables_brokers.py::test_query_cumulative_details_at_returns_top10_at_each_cursor -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hoga/tables/snapshots.py hoga/tables/brokers.py tests/test_tables_snapshots.py tests/test_tables_brokers.py
git commit -m "feat: add study detail parquet helpers"
```

---

### Task 3: Backend Study Snapshot Enrichment

**Files:**
- Create: `hoga/api/study_view_enrichment.py`
- Modify: `hoga/api/study_views.py`
- Modify: `tests/api/test_study_views.py`

**Interfaces:**
- Consumes: Task 1 models on `ParquetStudySnapshot`
- Consumes: Task 2 helpers `snapshots.query_bucket_representatives`, `brokers.query_cumulative_details_at`
- Produces: `enrich_snapshot_with_details(data_dir: Path, snapshot: ParquetStudySnapshot) -> ParquetStudySnapshot`
- Produces: create/update persistence always writes enriched snapshot when possible

- [ ] **Step 1: Write failing persistence enrichment test**

Add to `tests/api/test_study_views.py`:

```python
def test_study_views_create_enriches_snapshot_detail_buckets(tmp_path):
    from hoga.tables.snapshots import Orderbook, write_parquet as write_snapshots
    from hoga.tables.brokers import BrokerRow, write_parquet as write_brokers

    z = tuple(0 for _ in range(10))
    ask_p = tuple(70100 + i for i in range(10))
    ask_q = tuple(10 + i for i in range(10))
    bid_p = tuple(70000 - i for i in range(10))
    bid_q = tuple(20 + i for i in range(10))
    date = "20260616"
    code = "005930"
    source_dir = tmp_path / "parquet" / date / code / "hogaplay"
    source_dir.mkdir(parents=True)
    (source_dir / "meta.json").write_text(json.dumps({
        "code": code,
        "date": date,
        "source": "hogaplay",
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }), encoding="utf-8")
    write_snapshots([
        Orderbook(
            ts_ms=90_000_500,
            seq=1,
            ask_p=ask_p,
            ask_q=ask_q,
            ask_d=z,
            bid_p=bid_p,
            bid_q=bid_q,
            bid_d=z,
            tot_ask=sum(ask_q),
            tot_ask_d=0,
            tot_bid=sum(bid_q),
            tot_bid_d=0,
        )
    ], source_dir / "snapshots.parquet")
    write_brokers([
        BrokerRow(ts_ms=90_000_500, seq=1, side="buy", rank=1, broker="키움증권", qty_today=100, qty_delta=0),
        BrokerRow(ts_ms=90_000_500, seq=1, side="sell", rank=1, broker="JP모간", qty_today=80, qty_delta=0),
    ], source_dir / "brokers.parquet")

    unix_bucket = 1_779_926_400_000  # 2026-06-16 09:00:00 KST
    raw = _req()
    raw["snapshot_from_ms"] = unix_bucket
    raw["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["segments"] = [{
        "date": date,
        "session_open_ms": unix_bucket,
        "session_close_ms": unix_bucket + 23_400_000,
        "source": "hogaplay",
    }]
    raw["snapshot"]["bundle"]["candles"] = [
        {"t": unix_bucket, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}
    ]
    req = ParquetStudyViewWriteRequest.model_validate(raw)

    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    snap = sv.load_snapshot(tmp_path, id="view1")

    assert snap.bundle.orderbook_buckets[0].t == unix_bucket
    assert snap.bundle.orderbook_buckets[0].available is True
    assert snap.bundle.orderbook_buckets[0].snapshot is not None
    assert snap.bundle.broker_buckets[0].available is True
    assert snap.bundle.broker_buckets[0].brokers[0].broker == "키움증권"
    assert snap.bundle.detail_warnings == []
```

- [ ] **Step 2: Write failing non-fatal warning test**

Add:

```python
def test_study_views_create_detail_enrichment_missing_parquet_is_non_fatal(tmp_path):
    req = ParquetStudyViewWriteRequest.model_validate(_req())

    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    snap = sv.load_snapshot(tmp_path, id="view1")

    assert snap.code == "005930"
    assert snap.bundle.orderbook_buckets == [
        {"t": 1_000, "snapshot": None, "available": False}
    ] or snap.bundle.orderbook_buckets[0].available is False
    assert any(w.kind in {"orderbook", "broker"} for w in snap.bundle.detail_warnings)
```

When implementing, prefer the second assertion form below so the model instance is used:

```python
    assert snap.bundle.orderbook_buckets[0].t == 1_000
    assert snap.bundle.orderbook_buckets[0].available is False
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/api/test_study_views.py::test_study_views_create_enriches_snapshot_detail_buckets tests/api/test_study_views.py::test_study_views_create_detail_enrichment_missing_parquet_is_non_fatal -q
```

Expected: FAIL because enrichment is not wired.

- [ ] **Step 4: Create enrichment module**

Create `hoga/api/study_view_enrichment.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from hoga.api.models import (
    ParquetStudySnapshot,
    StudyBrokerBucket,
    StudyBrokerDetail,
    StudyDetailWarning,
    StudyOrderbookBucket,
)
from hoga.api.queries import QueryEngine
from hoga.api.sources import SourceName
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms
from hoga.tables import brokers as brokers_tbl
from hoga.tables import snapshots as snapshots_tbl


@dataclass(frozen=True)
class _Bucket:
    t: int
    date: str
    source: SourceName
    lo_native: int
    hi_native: int


def enrich_snapshot_with_details(data_dir: Path, snapshot: ParquetStudySnapshot) -> ParquetStudySnapshot:
    engine = QueryEngine(data_dir)
    bucket_ms = _bucket_ms(snapshot.timeframe)
    buckets, warnings = _resolve_buckets(snapshot, bucket_ms)

    orderbook_by_t: dict[int, StudyOrderbookBucket] = {}
    broker_by_t: dict[int, StudyBrokerBucket] = {}

    grouped: dict[tuple[str, SourceName], list[_Bucket]] = {}
    for b in buckets:
        grouped.setdefault((b.date, b.source), []).append(b)

    for (date, source), group in grouped.items():
        try:
            code_dir = engine.parquet_dir(date, snapshot.code, source)
        except Exception:
            for b in group:
                warnings.append(StudyDetailWarning(kind="orderbook", t=b.t, code=snapshot.code, date=date, message=f"parquet source missing: {source}"))
                warnings.append(StudyDetailWarning(kind="broker", t=b.t, code=snapshot.code, date=date, message=f"parquet source missing: {source}"))
            continue
        orderbook_by_t.update(_load_orderbooks(engine, code_dir, snapshot.code, date, source, group, warnings))
        broker_by_t.update(_load_brokers(engine, code_dir, snapshot.code, date, group, warnings))

    orderbook_buckets = [
        orderbook_by_t.get(c.t, StudyOrderbookBucket(t=c.t, snapshot=None, available=False))
        for c in snapshot.bundle.candles
    ]
    broker_buckets = [
        broker_by_t.get(c.t, StudyBrokerBucket(t=c.t, brokers=[], available=False))
        for c in snapshot.bundle.candles
    ]
    enriched_bundle = snapshot.bundle.model_copy(update={
        "orderbook_buckets": orderbook_buckets,
        "broker_buckets": broker_buckets,
        "detail_warnings": [*snapshot.bundle.detail_warnings, *warnings],
    })
    return snapshot.model_copy(update={"bundle": enriched_bundle})


def _bucket_ms(timeframe: str) -> int:
    mapping = {
        "1m": 60_000,
        "3m": 180_000,
        "5m": 300_000,
        "10m": 600_000,
        "15m": 900_000,
        "30m": 1_800_000,
        "D": 86_400_000,
        "W": 7 * 86_400_000,
        "M": 31 * 86_400_000,
    }
    return mapping.get(timeframe, 60_000)
```

Then add `_resolve_buckets`, `_load_orderbooks`, and `_load_brokers` in the same file:

```python
def _resolve_buckets(snapshot: ParquetStudySnapshot, bucket_ms: int) -> tuple[list[_Bucket], list[StudyDetailWarning]]:
    warnings: list[StudyDetailWarning] = []
    out: list[_Bucket] = []
    for c in snapshot.bundle.candles:
        seg = next(
            (s for s in snapshot.bundle.segments if s.session_open_ms <= c.t <= s.session_close_ms),
            None,
        )
        if seg is None:
            warnings.append(StudyDetailWarning(kind="orderbook", t=c.t, code=snapshot.code, date=None, message="saved candle has no matching segment"))
            warnings.append(StudyDetailWarning(kind="broker", t=c.t, code=snapshot.code, date=None, message="saved candle has no matching segment"))
            continue
        date = seg.date
        try:
            lo_native = unix_ms_to_hhmmssms(date, c.t)
            hi_native = unix_ms_to_hhmmssms(date, c.t + bucket_ms - 1)
        except ValueError:
            warnings.append(StudyDetailWarning(kind="orderbook", t=c.t, code=snapshot.code, date=date, message="could not convert saved candle time to native time"))
            warnings.append(StudyDetailWarning(kind="broker", t=c.t, code=snapshot.code, date=date, message="could not convert saved candle time to native time"))
            continue
        out.append(_Bucket(t=c.t, date=date, source=seg.source, lo_native=lo_native, hi_native=hi_native))
    return out, warnings


def _load_orderbooks(
    engine: QueryEngine,
    code_dir: Path,
    code: str,
    date: str,
    source: SourceName,
    buckets: list[_Bucket],
    warnings: list[StudyDetailWarning],
) -> dict[int, StudyOrderbookBucket]:
    path = code_dir / "snapshots.parquet"
    if not path.exists():
        for b in buckets:
            warnings.append(StudyDetailWarning(kind="orderbook", t=b.t, code=code, date=date, message="snapshots.parquet missing"))
        return {}
    try:
        meta = engine.get_meta(date, code, source)
        reps = snapshots_tbl.query_bucket_representatives(
            engine.conn,
            path=path,
            buckets=[(b.lo_native, b.hi_native) for b in buckets],
            session_close_ms=meta.get("regular_session_close_ms"),
        )
    except Exception as e:
        for b in buckets:
            warnings.append(StudyDetailWarning(kind="orderbook", t=b.t, code=code, date=date, message=f"orderbook enrichment failed: {e}"))
        return {}

    out: dict[int, StudyOrderbookBucket] = {}
    by_lo = {b.lo_native: b for b in buckets}
    for lo_native, snap in reps.items():
        b = by_lo.get(lo_native)
        if b is None:
            continue
        out[b.t] = StudyOrderbookBucket(
            t=b.t,
            snapshot=snap.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, snap.ts_ms)}),
            available=True,
        )
    return out


def _load_brokers(
    engine: QueryEngine,
    code_dir: Path,
    code: str,
    date: str,
    buckets: list[_Bucket],
    warnings: list[StudyDetailWarning],
) -> dict[int, StudyBrokerBucket]:
    path = code_dir / "brokers.parquet"
    if not path.exists():
        for b in buckets:
            warnings.append(StudyDetailWarning(kind="broker", t=b.t, code=code, date=date, message="brokers.parquet missing"))
        return {}
    try:
        details = brokers_tbl.query_cumulative_details_at(
            engine.conn,
            path=path,
            t_values=[b.hi_native for b in buckets],
        )
    except Exception as e:
        for b in buckets:
            warnings.append(StudyDetailWarning(kind="broker", t=b.t, code=code, date=date, message=f"broker enrichment failed: {e}"))
        return {}

    out: dict[int, StudyBrokerBucket] = {}
    by_hi = {b.hi_native: b for b in buckets}
    for hi_native, rows in details.items():
        b = by_hi.get(hi_native)
        if b is None or not rows:
            continue
        out[b.t] = StudyBrokerBucket(
            t=b.t,
            available=True,
            brokers=[
                StudyBrokerDetail(broker=r.broker, net=r.net, dominant_side=r.dominant_side)
                for r in rows
            ],
        )
    return out
```

- [ ] **Step 5: Wire enrichment into create/update**

Modify `hoga/api/study_views.py`:

```python
from hoga.api.study_view_enrichment import enrich_snapshot_with_details
```

In `create_save_sync`, before `atomic_write_json(snapshot_path, ...)`:

```python
    enriched_snapshot = enrich_snapshot_with_details(data_dir, req.snapshot)
    req = req.model_copy(update={"snapshot": enriched_snapshot})
```

In `update_save_sync`, before writing the staged snapshot:

```python
            enriched_snapshot = enrich_snapshot_with_details(data_dir, req.snapshot)
            req = req.model_copy(update={"snapshot": enriched_snapshot})
```

- [ ] **Step 6: Run enrichment tests**

Run:

```bash
uv run pytest tests/api/test_study_views.py::test_study_views_create_enriches_snapshot_detail_buckets tests/api/test_study_views.py::test_study_views_create_detail_enrichment_missing_parquet_is_non_fatal -q
```

Expected: PASS.

- [ ] **Step 7: Run study view route regression tests**

Run:

```bash
uv run pytest tests/api/test_study_views.py -q
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hoga/api/study_view_enrichment.py hoga/api/study_views.py tests/api/test_study_views.py
git commit -m "feat: enrich study snapshots with detail buckets"
```

---

### Task 4: Frontend Types and Snapshot Detail Adapter

**Files:**
- Modify: `frontend/src/api/studyViews.ts`
- Modify: `frontend/src/studyViews/studySnapshotAdapter.ts`
- Modify: `frontend/src/studyViews/studySnapshotAdapter.test.ts`

**Interfaces:**
- Produces TS types: `StudyOrderbookBucket`, `StudyBrokerDetail`, `StudyBrokerBucket`, `StudyDetailWarning`
- Produces: `StudySnapshotDetailInput`
- Produces: `studySnapshotDetails(snapshot: StudySnapshotBundle): StudySnapshotDetailInput`
- Produces: `bucketStartForCursor(candles: { ts_ms: number }[], bucketMs: number, cursorMs: number): number | null`

- [ ] **Step 1: Write failing adapter tests**

Add to `frontend/src/studyViews/studySnapshotAdapter.test.ts`:

```ts
import { bucketStartForCursor, studySnapshotDetails } from './studySnapshotAdapter';

it('builds orderbook and broker lookup maps from saved detail buckets', () => {
  const s = snapshot({
    orderbook_buckets: [{
      t: 1000,
      available: true,
      snapshot: {
        ts_ms: 1999,
        seq: 1,
        ask: Array.from({ length: 10 }, (_, i) => ({ price: 101 + i, qty: 10 + i })),
        bid: Array.from({ length: 10 }, (_, i) => ({ price: 100 - i, qty: 20 + i })),
        tot_ask: 145,
        tot_bid: 245,
      },
    }],
    broker_buckets: [{
      t: 1000,
      available: true,
      brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
    }],
    detail_warnings: [{ kind: 'broker', t: 1000, code: '005930', date: '20260616', message: 'partial broker detail' }],
  } as Partial<StudySnapshotBundle>);

  const details = studySnapshotDetails(s);

  expect(details.orderbookByBucketStart.get(1000)?.snapshot?.seq).toBe(1);
  expect(details.brokersByBucketStart.get(1000)?.brokers[0].net).toBe(100);
  expect(details.detailWarnings[0].message).toBe('partial broker detail');
});

it('resolves cursor time by containing bucket, not nearest bucket', () => {
  const candles = [{ ts_ms: 1000 }, { ts_ms: 2000 }, { ts_ms: 3000 }];

  expect(bucketStartForCursor(candles, 1000, 1999)).toBe(1000);
  expect(bucketStartForCursor(candles, 1000, 2000)).toBe(2000);
  expect(bucketStartForCursor(candles, 1000, 999)).toBeNull();
});
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run:

```bash
cd frontend && npm test -- --run src/studyViews/studySnapshotAdapter.test.ts
```

If `npm test` is not defined, run:

```bash
cd frontend && npx vitest run src/studyViews/studySnapshotAdapter.test.ts
```

Expected: FAIL because types/functions do not exist.

- [ ] **Step 3: Add frontend wire types**

In `frontend/src/api/studyViews.ts`, import needed shared types:

```ts
import type { AskPeak, OrderbookSnapshot } from './types';
```

Replace the existing `AskPeak` import line if needed.

Add:

```ts
export type StudyOrderbookBucket = {
  t: number;
  snapshot: OrderbookSnapshot | null;
  available: boolean;
};

export type StudyBrokerDetail = {
  broker: string;
  net: number;
  dominant_side: 'buy' | 'sell';
};

export type StudyBrokerBucket = {
  t: number;
  brokers: StudyBrokerDetail[];
  available: boolean;
};

export type StudyDetailWarning = {
  kind: 'orderbook' | 'broker';
  t: number | null;
  code: string;
  date: string | null;
  message: string;
};
```

Replace the existing `segments` field and extend `StudySnapshotBundle` with optional detail fields:

```ts
  segments: { date: string; session_open_ms: number; session_close_ms: number; source?: string }[];
  orderbook_buckets?: StudyOrderbookBucket[];
  broker_buckets?: StudyBrokerBucket[];
  detail_warnings?: StudyDetailWarning[];
```

- [ ] **Step 4: Add adapter helpers**

In `frontend/src/studyViews/studySnapshotAdapter.ts`, update imports:

```ts
import type {
  StudyBrokerBucket,
  StudyDetailWarning,
  StudyOrderbookBucket,
  StudySnapshotBundle,
} from '../api/studyViews';
```

Add exported types and functions:

```ts
export type StudySnapshotDetailInput = {
  orderbookByBucketStart: Map<number, StudyOrderbookBucket>;
  brokersByBucketStart: Map<number, StudyBrokerBucket>;
  detailWarnings: StudyDetailWarning[];
};

export function studySnapshotDetails(snapshot: StudySnapshotBundle): StudySnapshotDetailInput {
  return {
    orderbookByBucketStart: new Map((snapshot.orderbook_buckets ?? []).map((b) => [b.t, b])),
    brokersByBucketStart: new Map((snapshot.broker_buckets ?? []).map((b) => [b.t, b])),
    detailWarnings: snapshot.detail_warnings ?? [],
  };
}

export function bucketStartForCursor(
  candles: Array<{ ts_ms: number }>,
  bucketMs: number,
  cursorMs: number,
): number | null {
  for (const c of candles) {
    if (c.ts_ms <= cursorMs && cursorMs < c.ts_ms + bucketMs) return c.ts_ms;
  }
  return null;
}
```

- [ ] **Step 5: Run adapter tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/studySnapshotAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/studyViews.ts frontend/src/studyViews/studySnapshotAdapter.ts frontend/src/studyViews/studySnapshotAdapter.test.ts
git commit -m "feat: adapt study snapshot detail data"
```

---

### Task 5: Study Page Restored Detail UI

**Files:**
- Create: `frontend/src/studyViews/StudyDetailPanel.tsx`
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: Task 4 `StudySnapshotDetailInput`, `bucketStartForCursor`
- Produces: `StudyDetailPanel({ details, candles, bucketMs, cursorMs })`
- Displays existing `OrderbookTable`
- Displays broker detail rows using `StudyBrokerBucket.brokers`

- [ ] **Step 1: Write failing StudyPage detail test**

Add to `frontend/src/studyViews/StudyPage.test.tsx`:

```ts
it('renders saved orderbook and broker detail from snapshot without cursor fetch hooks', () => {
  const enriched: ParquetStudySnapshot = {
    ...snapshot,
    timeframe: '1m',
    bucket_kind: '1m',
    bundle: {
      ...snapshot.bundle,
      timeframe: '1m',
      orderbook_buckets: [{
        t: 1_000,
        available: true,
        snapshot: {
          ts_ms: 1_999,
          seq: 7,
          ask: Array.from({ length: 10 }, (_, i) => ({ price: 71_000 + i, qty: 10 + i })),
          bid: Array.from({ length: 10 }, (_, i) => ({ price: 70_900 - i, qty: 20 + i })),
          tot_ask: 145,
          tot_bid: 245,
        },
      }],
      broker_buckets: [{
        t: 1_000,
        available: true,
        brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
      }],
      detail_warnings: [],
    },
  };
  useStudyViewSnapshotMock.mockReturnValue({
    data: enriched,
    isLoading: false,
    isError: false,
  });

  renderAt('/study?view=view1');

  expect(screen.getByTestId('study-detail-panel')).toBeTruthy();
  expect(screen.getByText('10호가')).toBeTruthy();
  expect(screen.getByText('거래원')).toBeTruthy();
  expect(screen.getByText('키움')).toBeTruthy();
  expect(screen.getByText('+100')).toBeTruthy();
  expect(useLiveBundle).not.toHaveBeenCalled();
  expect(useRange).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run StudyPage test and verify failure**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx
```

Expected: FAIL because `StudyDetailPanel` does not exist/render.

- [ ] **Step 3: Create StudyDetailPanel**

Create `frontend/src/studyViews/StudyDetailPanel.tsx`:

```tsx
import { useMemo } from 'react';
import OrderbookTable from '../sidebar/OrderbookTable';
import { brokerDisplayShort } from '../sidebar/brokerDisplayNames';
import type { StudyBrokerBucket } from '../api/studyViews';
import type { StudySnapshotDetailInput } from './studySnapshotAdapter';
import { bucketStartForCursor } from './studySnapshotAdapter';

type CandlePoint = { ts_ms: number };

type Props = {
  details: StudySnapshotDetailInput;
  candles: CandlePoint[];
  bucketMs: number;
  cursorMs: number | null;
};

export function StudyDetailPanel({ details, candles, bucketMs, cursorMs }: Props) {
  const bucketStart = useMemo(() => {
    if (candles.length === 0) return null;
    if (cursorMs == null) return candles[candles.length - 1]?.ts_ms ?? null;
    return bucketStartForCursor(candles, bucketMs, cursorMs);
  }, [bucketMs, candles, cursorMs]);

  const orderbook = bucketStart == null ? undefined : details.orderbookByBucketStart.get(bucketStart);
  const brokers = bucketStart == null ? undefined : details.brokersByBucketStart.get(bucketStart);
  const snapshot = orderbook?.available ? orderbook.snapshot : null;

  return (
    <aside data-testid="study-detail-panel" className="h-full min-w-[260px] overflow-auto border-l bg-bg-card">
      <section>
        <h2 className="border-b px-3 py-2 text-sm font-semibold">10호가</h2>
        <OrderbookTable snapshot={snapshot} />
      </section>
      <section>
        <h2 className="border-y px-3 py-2 text-sm font-semibold">거래원</h2>
        <BrokerDetailRows bucket={brokers} />
      </section>
      {details.detailWarnings.length > 0 && (
        <section className="border-t px-3 py-2 text-xs text-fg-dim">
          {details.detailWarnings[0].message}
        </section>
      )}
    </aside>
  );
}

function BrokerDetailRows({ bucket }: { bucket: StudyBrokerBucket | undefined }) {
  if (!bucket || !bucket.available || bucket.brokers.length === 0) {
    return <div className="grid place-items-center p-3 text-xs text-fg-dimmer">거래원 정보 없음</div>;
  }
  return (
    <div className="font-mono text-sm tabular-nums divide-y divide-border-strong">
      {bucket.brokers.slice(0, 10).map((b) => (
        <div key={b.broker} data-testid="study-broker-row" className="grid grid-cols-[70px_1fr] gap-2 px-2.5 py-0.5">
          <span className="truncate" title={b.broker}>{brokerDisplayShort(b.broker)}</span>
          <span className={b.net > 0 ? 'text-price-up text-right' : b.net < 0 ? 'text-price-down text-right' : 'text-fg-dimmer text-right'}>
            {b.net > 0 ? '+' : ''}{b.net.toLocaleString('ko-KR')}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Render StudyDetailPanel from StudyPage**

Modify `frontend/src/studyViews/StudyPage.tsx` imports:

```ts
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { bucketSeconds } from '../state/livePage';
import { StudyDetailPanel } from './StudyDetailPanel';
import { studySnapshotBundleToChartInput, studySnapshotDetails } from './studySnapshotAdapter';
```

Replace the existing `studySnapshotBundleToChartInput` import if needed.

Inside `StudyPage`, add:

```ts
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const details = useMemo(
    () => snapshot ? studySnapshotDetails(snapshot.bundle) : null,
    [snapshot],
  );
  const bucketMs = snapshot ? (bucketSeconds(snapshot.timeframe) ?? 60) * 1000 : 60_000;
```

Update the success render so the existing `LiveChartRoot` JSX node is wrapped with `<div className="grid min-h-0 grid-cols-[minmax(0,1fr)_280px]">`. Do not change any existing `LiveChartRoot` props. Immediately after the existing `LiveChartRoot` node, add:

```tsx
        {details && chartInput && (
          <StudyDetailPanel
            details={details}
            candles={chartInput.bundle.candles}
            bucketMs={bucketMs}
            cursorMs={cursorMs}
          />
        )}
```

Keep every existing `LiveChartRoot` prop unchanged.

- [ ] **Step 5: Run StudyPage tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run focused frontend tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx src/studyViews/studySnapshotAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/studyViews/StudyDetailPanel.tsx frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat: show saved study detail buckets"
```

---

### Task 6: Final Verification

**Files:**
- Modify only if a prior task left a failing test or type error.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified implementation ready for review.

- [ ] **Step 1: Run backend study and table tests**

Run:

```bash
uv run pytest tests/api/test_study_views.py tests/test_tables_snapshots.py tests/test_tables_brokers.py -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend study tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx src/studyViews/studySnapshotAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run type/build check**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only implementation/test files from this plan are modified; no generated or unrelated files are present.

- [ ] **Step 5: Commit final fixes if any**

If Step 1-4 required small fixes, commit them:

```bash
git add <changed-files>
git commit -m "fix: verify study view detail snapshots"
```

If no fixes were needed, do not create an empty commit.
