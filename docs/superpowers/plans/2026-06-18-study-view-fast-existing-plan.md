# Study View Fast Existing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make current self-contained study-view save/load faster without changing the user-facing storage model.

**Architecture:** Keep `/study` as a persisted JSON snapshot route, and keep detail enrichment at save/update time. The main fix is to stop re-running parquet enrichment during load, then reduce save-time enrichment cost by moving bucket selection work into DuckDB and avoiding repeated cursor joins for broker details. Add a lightweight benchmark regression test so future changes can see when the old slow path returns.

**Tech Stack:** Python 3.14, FastAPI, Pydantic v2, DuckDB, PyArrow/Parquet, pytest, existing `hoga.api.study_views` and `hoga.tables` modules.

## Global Constraints

- Preserve ADR-0077 semantics: `/study` renders the saved JSON artifact and does not refetch parquet detail during load.
- Keep existing snapshot JSON schema version at `1`.
- Do not introduce a new storage backend, external cache, database service, or frontend behavior change in this plan.
- Keep detail enrichment best-effort: missing parquet/detail data records warnings and does not reject saves.
- Use test-first discipline: write failing tests for changed behavior, and write passing characterization tests before behavior-preserving performance refactors.
- Do not edit unrelated frontend design or route behavior.

---

## File Structure

- `hoga/api/study_views.py`
  - Owns manifest/snapshot disk operations.
  - Change `load_restorable_snapshot()` so the default load path validates and returns persisted JSON without re-enriching.
  - Change `load_restorable_snapshot()` so it validates and returns persisted JSON without calling parquet enrichment for any snapshot generation.

- `tests/api/test_study_views.py`
  - Add behavior tests around load path not calling `prepare_restorable_snapshot()`.
  - Keep create/update enrichment tests intact.

- `hoga/tables/snapshots.py`
  - Optimize `query_bucket_representatives()` so DuckDB chooses the last eligible representative per requested bucket instead of loading all candidates and filtering them in Python.

- `tests/test_tables_snapshots.py`
  - Add parity and multi-bucket tests for optimized representative selection.

- `hoga/tables/brokers.py`
  - Add an optimized implementation path for `query_cumulative_details_at()` that reads broker rows once, preserves `(ts_ms, seq)` ordering, canonicalizes names, and maps each requested cursor to the latest point at or before the cursor.
  - Keep the public function signature unchanged.

- `tests/test_tables_brokers.py`
  - Add tests for duplicate cursor dedupe, same-timestamp latest seq handling, and final ordering parity.

- `tests/api/test_study_views_perf.py`
  - Create a small synthetic benchmark-style regression test for the study view load path.
  - This test should compare raw load vs restorable load behavior by call-count or bounded timing, not depend on production data.

---

### Task 1: Stop Re-Enriching Study Snapshots On Load

**Files:**
- Modify: `hoga/api/study_views.py:64-83`
- Modify: `tests/api/test_study_views.py`

**Interfaces:**
- Consumes: existing `load_snapshot(data_dir: Path, *, id: str) -> ParquetStudySnapshot`
- Produces: unchanged `load_restorable_snapshot(data_dir: Path, *, id: str) -> ParquetStudySnapshot`
- Produces: no new public or private helper; the load path always returns the persisted snapshot after validation.

- [ ] **Step 1: Write the failing load-path test**

Add this test near the existing study view load tests in `tests/api/test_study_views.py`:

```python
def test_load_restorable_snapshot_returns_persisted_enriched_snapshot_without_re_enrich(
    tmp_path, monkeypatch
):
    raw = _snapshot()
    raw["bundle"]["orderbook_buckets"] = [_orderbook_bucket(1_000)]
    raw["bundle"]["broker_buckets"] = [_broker_bucket(1_000)]
    raw["bundle"]["detail_warnings"] = [
        {
            "kind": "orderbook",
            "t": 1_000,
            "code": "005930",
            "date": "20260616",
            "message": "persisted warning",
        }
    ]
    req = ParquetStudyViewWriteRequest.model_validate(
        _req(snapshot=raw, viewport=raw["viewport"], indicator_state=raw["indicator_state"])
    )
    created = sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    assert created.snapshot_size_bytes > 0
    snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"
    sv.atomic_write_json(snapshot_path, raw)

    calls = []

    def prepare(data_dir, snapshot):
        calls.append((data_dir, snapshot.code))
        raise AssertionError("load_restorable_snapshot must not re-enrich persisted details")

    monkeypatch.setattr(sv, "prepare_restorable_snapshot", prepare)

    snap = sv.load_restorable_snapshot(tmp_path, id="view1")

    assert calls == []
    assert snap.bundle.orderbook_buckets[0].available is True
    assert snap.bundle.broker_buckets[0].available is True
    assert snap.bundle.detail_warnings[0].message == "persisted warning"
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
uv run pytest tests/api/test_study_views.py::test_load_restorable_snapshot_returns_persisted_enriched_snapshot_without_re_enrich -q
```

Expected: FAIL because current `load_restorable_snapshot()` calls `prepare_restorable_snapshot()` and the monkeypatched function raises.

- [ ] **Step 3: Implement the minimal load-path change**

In `hoga/api/study_views.py`, replace `load_restorable_snapshot()` with this implementation:

```python
def load_restorable_snapshot(data_dir: Path, *, id: str) -> ParquetStudySnapshot:
    get_save_sync(data_dir, id=id)
    p = _snapshot_path(data_dir, id)
    if not p.exists():
        raise StudyViewSnapshotMissingError(id)
    try:
        return ParquetStudySnapshot.model_validate_json(p.read_text(encoding="utf-8"))
    except ValidationError as e:
        raise StudyViewSnapshotInvalidError(id) from e
```

Rationale: ADR-0077 says `/study` renders the persisted JSON artifact and does not refetch parquet detail. Legacy pre-detail snapshots remain restorable as chart snapshots; their detail arrays stay empty/unavailable instead of being repaired during load.

- [ ] **Step 4: Add a legacy no-repair test**

Add this test to `tests/api/test_study_views.py`:

```python
def test_load_restorable_snapshot_does_not_enrich_legacy_snapshot_without_detail_arrays(
    tmp_path, monkeypatch
):
    req = ParquetStudyViewWriteRequest.model_validate(_req())
    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"
    sv.atomic_write_json(snapshot_path, req.snapshot.model_dump(mode="json"))

    calls = []

    def prepare(data_dir, snapshot):
        calls.append((data_dir, snapshot.code))
        raise AssertionError("legacy study snapshot load must not repair from parquet")

    monkeypatch.setattr(sv, "prepare_restorable_snapshot", prepare)

    snap = sv.load_restorable_snapshot(tmp_path, id="view1")

    assert calls == []
    assert snap.bundle.orderbook_buckets == []
    assert snap.bundle.broker_buckets == []
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
uv run pytest tests/api/test_study_views.py::test_load_restorable_snapshot_returns_persisted_enriched_snapshot_without_re_enrich tests/api/test_study_views.py::test_load_restorable_snapshot_does_not_enrich_legacy_snapshot_without_detail_arrays -q
```

Expected: PASS.

- [ ] **Step 6: Run the existing study-view API tests**

Run:

```bash
uv run pytest tests/api/test_study_views.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/study_views.py tests/api/test_study_views.py
git commit -m "perf: avoid re-enriching saved study views on load"
```

---

### Task 2: Optimize Orderbook Bucket Representative Selection

**Files:**
- Modify: `hoga/tables/snapshots.py:591-634`
- Modify: `tests/test_tables_snapshots.py`

**Interfaces:**
- Consumes: existing `query_bucket_representatives(con, *, path: Path, buckets: list[tuple[int, int]], session_close_ms: int | None = None) -> dict[int, ApiOrderbookSnapshot]`
- Produces: same signature and return type, but implemented with a DuckDB bucket table and `ROW_NUMBER()`.

- [ ] **Step 1: Add a multi-bucket parity test**

Add this test to `tests/test_tables_snapshots.py` after the existing `query_bucket_representatives` tests:

```python
def test_query_bucket_representatives_matches_single_query_for_multiple_buckets(
    tmp_path: Path,
) -> None:
    from hoga.tables.snapshots import query_bucket_representative, query_bucket_representatives

    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),
        _ob(ts_ms=90_010_000, seq=2, ask_q=(11, 21, 31, 41), bid_q=(6, 6, 6, 6)),
        _ob(ts_ms=90_060_100, seq=3, ask_q=(12, 22, 32, 42), bid_q=(7, 7, 7, 7)),
        _ob(ts_ms=90_070_000, seq=4, ask_q=(99, 98, 97), bid_q=(8, 8, 8)),
        _ob(ts_ms=90_120_100, seq=5, ask_q=(13, 23, 33, 43), bid_q=(9, 9, 9, 9)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    buckets = [
        (90_000_000, 90_059_999),
        (90_060_000, 90_119_999),
        (90_120_000, 90_179_999),
    ]

    with duckdb.connect(":memory:") as con:
        single = {
            lo: query_bucket_representative(
                con,
                path=out,
                lo_native=lo,
                hi_native=hi,
                session_close_ms=153_000_000,
            )
            for lo, hi in buckets
        }
        batch = query_bucket_representatives(
            con,
            path=out,
            buckets=buckets,
            session_close_ms=153_000_000,
        )

    assert {lo: snap.seq for lo, snap in batch.items()} == {
        lo: snap.seq for lo, snap in single.items() if snap is not None
    }
```

- [ ] **Step 2: Run the test before implementation**

Run:

```bash
uv run pytest tests/test_tables_snapshots.py::test_query_bucket_representatives_matches_single_query_for_multiple_buckets -q
```

Expected: PASS on behavior. This is a characterization test that guards the refactor.

- [ ] **Step 3: Rewrite `query_bucket_representatives()` to push bucket matching into SQL**

Replace the body of `query_bucket_representatives()` in `hoga/tables/snapshots.py` with:

```python
    if not buckets:
        return {}
    last_continuous_ms = _last_continuous_intra_ms(
        con, path=path, session_close_ms=session_close_ms
    )
    bucket_los = [int(lo) for lo, _hi in buckets]
    bucket_his = [int(hi) for _lo, hi in buckets]
    min_lo = min(bucket_los)
    max_hi = max(bucket_his)
    continuous_pred = _continuous_representative_pred_sql(
        intra_ms_expr="intra_ms",
        last_continuous_ms=last_continuous_ms,
    )
    rows = con.execute(
        f"""
        WITH buckets AS (
          SELECT
            UNNEST(?::BIGINT[]) AS lo_native,
            UNNEST(?::BIGINT[]) AS hi_native
        ),
        candidates AS (
          SELECT
            b.lo_native,
            s.*,
            {hhmmssms_to_intra_ms_sql("s.ts_ms")} AS intra_ms
          FROM buckets b
          JOIN read_parquet(?) s
            ON s.ts_ms BETWEEN b.lo_native AND b.hi_native
          WHERE s.ts_ms BETWEEN ? AND ?
        ),
        eligible AS (
          SELECT *
          FROM candidates
          WHERE {continuous_pred}
        ),
        ranked AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY lo_native
              ORDER BY ts_ms DESC, seq DESC
            ) AS rn
          FROM eligible
        )
        SELECT lo_native, {_SELECT}
        FROM ranked
        WHERE rn = 1
        ORDER BY lo_native
        """,
        [bucket_los, bucket_his, str(path), min_lo, max_hi],
    ).fetchall()

    out: dict[int, ApiOrderbookSnapshot] = {}
    for row in rows:
        lo_native = int(row[0])
        out[lo_native] = _row_to_api_snapshot(row[1:])
    return out
```

`hoga/tables/snapshots.py` already imports `hhmmssms_to_intra_ms_sql`; keep that import and use that existing helper name in the SQL snippet.

- [ ] **Step 4: Run snapshot table tests**

Run:

```bash
uv run pytest tests/test_tables_snapshots.py::test_query_bucket_representatives_prefer_last_continuous_book_over_later_shallow_row tests/test_tables_snapshots.py::test_query_bucket_representatives_omit_fully_auction_bucket tests/test_tables_snapshots.py::test_query_bucket_representatives_no_session_close_keep_deep_and_omit_fully_shallow tests/test_tables_snapshots.py::test_query_bucket_representative_and_batch_share_seq_tiebreak tests/test_tables_snapshots.py::test_query_bucket_representatives_matches_single_query_for_multiple_buckets -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -m "perf: select study orderbook representatives in duckdb"
```

---

### Task 3: Optimize Broker Detail Cursor Mapping

**Files:**
- Modify: `hoga/tables/brokers.py:219-278`
- Modify: `tests/test_tables_brokers.py`

**Interfaces:**
- Consumes: existing `query_cumulative_details_at(con, *, path: Path, t_values: list[int], limit: int = 10) -> dict[int, list[BrokerDetailRow]]`
- Produces: same public signature and return type.
- Internal behavior remains: final full-day order decides broker order; each cursor shows latest net at or before the cursor; if multiple rows share `ts_ms`, the highest `seq` wins; canonical aliases collapse.

- [ ] **Step 1: Add duplicate cursor and before-first-row tests**

Add this test to `tests/test_tables_brokers.py` near the existing `query_cumulative_details_at` tests:

```python
def test_query_cumulative_details_at_dedupes_cursors_and_returns_empty_before_first_row(
    tmp_path: Path,
) -> None:
    from hoga.tables.brokers import BrokerRow, query_cumulative_details_at, write_parquet

    path = tmp_path / "brokers.parquet"
    rows = [
        BrokerRow(ts_ms=90_000_000, seq=1, side="buy", rank=1, broker="키움증권", qty_today=100, qty_delta=0),
        BrokerRow(ts_ms=90_060_000, seq=2, side="buy", rank=1, broker="키움증권", qty_today=150, qty_delta=0),
    ]
    write_parquet(rows, path)

    with duckdb.connect(":memory:") as con:
        out = query_cumulative_details_at(
            con,
            path=path,
            t_values=[89_999_999, 90_060_000, 90_060_000],
        )

    assert out[89_999_999] == []
    assert [(r.broker, r.net, r.dominant_side) for r in out[90_060_000]] == [
        ("키움증권", 150, "buy")
    ]
    assert sorted(out.keys()) == [89_999_999, 90_060_000]
```

- [ ] **Step 2: Run the test before implementation**

Run:

```bash
uv run pytest tests/test_tables_brokers.py::test_query_cumulative_details_at_dedupes_cursors_and_returns_empty_before_first_row -q
```

Expected: PASS on behavior. This guards the public contract during optimization.

- [ ] **Step 3: Replace cursor join implementation with one-pass point mapping**

Replace the body of `query_cumulative_details_at()` in `hoga/tables/brokers.py` with:

```python
    from bisect import bisect_right

    from hoga.broker_names import canonical

    if not t_values:
        return {}
    uniq = sorted({int(t) for t in t_values})
    final_order = _final_broker_order(con, path=path, limit=limit)
    final_rank = {broker: idx for idx, broker in enumerate(final_order)}
    if not final_order:
        return {t: [] for t in uniq}

    rows = con.execute(
        """
        SELECT
            broker,
            ts_ms,
            seq,
            SUM(CASE WHEN side = 'buy' THEN qty_today ELSE -qty_today END) AS net
        FROM read_parquet(?)
        GROUP BY broker, ts_ms, seq
        ORDER BY broker, ts_ms, seq
        """,
        [str(path)],
    ).fetchall()

    collapsed: dict[tuple[str, int, int], int] = {}
    for raw_broker, ts_ms, seq, net in rows:
        key = (canonical(raw_broker), int(ts_ms), int(seq))
        collapsed[key] = collapsed.get(key, 0) + int(net)

    by_broker: dict[str, list[tuple[int, int, int]]] = {}
    for (broker, ts_ms, seq), net in sorted(collapsed.items()):
        if broker not in final_rank:
            continue
        by_broker.setdefault(broker, []).append((ts_ms, seq, net))

    indexed: dict[str, tuple[list[tuple[int, int]], list[int]]] = {}
    for broker in final_order:
        points = by_broker.get(broker, [])
        indexed[broker] = (
            [(ts_ms, seq) for ts_ms, seq, _net in points],
            [net for _ts_ms, _seq, net in points],
        )

    grouped: dict[int, list[BrokerDetailRow]] = {t: [] for t in uniq}
    max_seq = 2**31 - 1
    for cursor_ts in uniq:
        details: list[BrokerDetailRow] = []
        for broker in final_order:
            keys, nets = indexed[broker]
            idx = bisect_right(keys, (cursor_ts, max_seq)) - 1
            if idx < 0:
                continue
            net = nets[idx]
            details.append(
                BrokerDetailRow(
                    broker=broker,
                    net=net,
                    dominant_side="buy" if net >= 0 else "sell",
                )
            )
        details.sort(key=lambda r: final_rank[r.broker])
        grouped[cursor_ts] = details
    return grouped
```

Important: do not reuse `_query_canonical_series_points()` here; it collapses by `(broker, ts_ms)` and drops `seq`, while this detail endpoint must preserve latest-`seq` semantics within one timestamp.

- [ ] **Step 4: Run broker detail tests**

Run:

```bash
uv run pytest tests/test_tables_brokers.py::test_query_cumulative_details_at_returns_top10_at_each_cursor tests/test_tables_brokers.py::test_query_cumulative_details_at_keeps_final_day_order_at_earlier_cursor tests/test_tables_brokers.py::test_query_cumulative_details_at_collapses_canonical_aliases_at_latest_ts tests/test_tables_brokers.py::test_query_cumulative_details_at_uses_latest_seq_within_same_ts_ms tests/test_tables_brokers.py::test_query_cumulative_details_at_dedupes_cursors_and_returns_empty_before_first_row -q
```

Expected: PASS.

- [ ] **Step 5: Run study-view enrichment test**

Run:

```bash
uv run pytest tests/api/test_study_views.py::test_study_views_create_enriches_snapshot_detail_buckets -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/tables/brokers.py tests/test_tables_brokers.py
git commit -m "perf: map study broker details without cursor joins"
```

---

### Task 4: Add Study View Load Performance Regression Coverage

**Files:**
- Create: `tests/api/test_study_views_perf.py`

**Interfaces:**
- Consumes: `sv.create_save_sync(...)`, `sv.load_restorable_snapshot(...)`, `ParquetStudyViewWriteRequest.model_validate(...)`
- Produces: a regression test that proves normal restorable load does not call enrichment for an already enriched snapshot.

- [ ] **Step 1: Create the performance regression test file**

Create `tests/api/test_study_views_perf.py` with:

```python
from hoga.api import study_views as sv
from hoga.api.models import ParquetStudyViewWriteRequest


def _snapshot_with_dense_details(bar_count: int = 200):
    candles = [
        {
            "t": 1_000 + i * 60_000,
            "open": 100 + i,
            "high": 101 + i,
            "low": 99 + i,
            "close": 100 + i,
            "volume": 1_000 + i,
        }
        for i in range(bar_count)
    ]
    return {
        "schema_version": 1,
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "1m",
        "snapshot_from_ms": candles[0]["t"],
        "snapshot_to_ms": candles[-1]["t"],
        "bucket_kind": "1m",
        "viewport": {
            "right_edge_ms": candles[-1]["t"],
            "bar_span": bar_count,
            "at_live_edge": False,
        },
        "indicator_state": {
            "volume_enabled": True,
            "quote_totals_enabled": True,
            "ratio_enabled": True,
            "fill_strength_enabled": True,
            "aggregation_basis": "close",
            "auction_window_mask": True,
            "ratio_outlier_filter_enabled": True,
            "ratio_outlier_threshold": 50,
        },
        "provenance": {"saved_from_route": "/live", "data_provenance": "live_mixed"},
        "bundle": {
            "code": "005930",
            "timeframe": "1m",
            "snapshot_from_ms": candles[0]["t"],
            "snapshot_to_ms": candles[-1]["t"],
            "segments": [
                {
                    "date": "20260616",
                    "session_open_ms": candles[0]["t"],
                    "session_close_ms": candles[-1]["t"],
                    "source": "hogaplay",
                }
            ],
            "candles": candles,
            "quote_totals": [
                {"t": c["t"], "bid_total": 100, "ask_total": 90, "visible": True}
                for c in candles
            ],
            "ratio": [{"t": c["t"], "value": 0.1, "visible": True} for c in candles],
            "fill_strength": [
                {"t": c["t"], "buy_qty": 5, "sell_qty": 4, "visible": True}
                for c in candles
            ],
            "ask_peaks": [],
            "data_warnings": [],
            "orderbook_buckets": [
                {
                    "t": c["t"],
                    "available": False,
                    "snapshot": None,
                }
                for c in candles
            ],
            "broker_buckets": [
                {
                    "t": c["t"],
                    "available": False,
                    "brokers": [],
                }
                for c in candles
            ],
            "detail_warnings": [],
        },
        "captured_at_ms": 3_000,
    }


def _request_for(snapshot):
    return {
        "name": "삼성전자 1분봉 저장뷰",
        "code": snapshot["code"],
        "label": snapshot["label"],
        "timeframe": snapshot["timeframe"],
        "snapshot_from_ms": snapshot["snapshot_from_ms"],
        "snapshot_to_ms": snapshot["snapshot_to_ms"],
        "viewport": snapshot["viewport"],
        "indicator_state": snapshot["indicator_state"],
        "snapshot": snapshot,
        "provenance": snapshot["provenance"],
    }


def test_restorable_load_for_enriched_snapshot_is_json_only(tmp_path, monkeypatch):
    snapshot = _snapshot_with_dense_details(bar_count=200)
    req = ParquetStudyViewWriteRequest.model_validate(_request_for(snapshot))
    snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"

    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    sv.atomic_write_json(snapshot_path, req.snapshot.model_dump(mode="json"))
    persisted_size = len(snapshot_path.read_text(encoding="utf-8"))
    assert persisted_size > 10_000

    def prepare(data_dir, loaded_snapshot):
        raise AssertionError(
            "enriched study snapshot load must not touch parquet enrichment"
        )

    monkeypatch.setattr(sv, "prepare_restorable_snapshot", prepare)

    loaded = sv.load_restorable_snapshot(tmp_path, id="view1")

    assert len(loaded.bundle.candles) == 200
    assert len(loaded.bundle.orderbook_buckets) == 200
    assert len(loaded.bundle.broker_buckets) == 200
```

- [ ] **Step 2: Run the new regression test**

Run:

```bash
uv run pytest tests/api/test_study_views_perf.py -q
```

Expected: PASS after Task 1. If this fails because `create_save_sync()` enriches the request before the test overwrites the snapshot, inspect the failure: the final `sv.atomic_write_json(...)` line must leave the dense snapshot in place before loading.

- [ ] **Step 3: Run the full relevant backend test set**

Run:

```bash
uv run pytest tests/api/test_study_views.py tests/api/test_study_views_perf.py tests/test_tables_snapshots.py tests/test_tables_brokers.py -q
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/api/test_study_views_perf.py
git commit -m "test: guard study view load fast path"
```

---

### Task 5: Validate End-To-End Save/Load Timing Locally

**Files:**
- No production file changes.
- Optional temporary script: `/tmp/study_view_perf_probe.py`; delete it before finishing.

**Interfaces:**
- Consumes: final code from Tasks 1-4.
- Produces: measured before/after-style numbers for the final PR or handoff.

- [ ] **Step 1: Create a temporary probe**

Write this temporary file to `/tmp/study_view_perf_probe.py`:

```python
import json
import tempfile
import time
from pathlib import Path

from hoga.api import study_views as sv
from hoga.api.models import ParquetStudyViewWriteRequest


def build_req(n: int) -> ParquetStudyViewWriteRequest:
    candles = [
        {
            "t": 1_000 + i * 60_000,
            "open": 100 + i,
            "high": 101 + i,
            "low": 99 + i,
            "close": 100 + i,
            "volume": 1_000 + i,
        }
        for i in range(n)
    ]
    snapshot = {
        "schema_version": 1,
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "1m",
        "snapshot_from_ms": candles[0]["t"],
        "snapshot_to_ms": candles[-1]["t"],
        "bucket_kind": "1m",
        "viewport": {
            "right_edge_ms": candles[-1]["t"],
            "bar_span": n,
            "at_live_edge": False,
        },
        "indicator_state": {
            "volume_enabled": True,
            "quote_totals_enabled": True,
            "ratio_enabled": True,
            "fill_strength_enabled": True,
            "aggregation_basis": "close",
            "auction_window_mask": True,
            "ratio_outlier_filter_enabled": True,
            "ratio_outlier_threshold": 50,
        },
        "provenance": {"saved_from_route": "/live", "data_provenance": "live_mixed"},
        "bundle": {
            "code": "005930",
            "timeframe": "1m",
            "snapshot_from_ms": candles[0]["t"],
            "snapshot_to_ms": candles[-1]["t"],
            "segments": [
                {
                    "date": "20260616",
                    "session_open_ms": candles[0]["t"],
                    "session_close_ms": candles[-1]["t"],
                    "source": "hogaplay",
                }
            ],
            "candles": candles,
            "quote_totals": [
                {"t": c["t"], "bid_total": 100, "ask_total": 90, "visible": True}
                for c in candles
            ],
            "ratio": [{"t": c["t"], "value": 0.1, "visible": True} for c in candles],
            "fill_strength": [
                {"t": c["t"], "buy_qty": 5, "sell_qty": 4, "visible": True}
                for c in candles
            ],
            "ask_peaks": [],
            "data_warnings": [],
            "orderbook_buckets": [
                {"t": c["t"], "available": False, "snapshot": None}
                for c in candles
            ],
            "broker_buckets": [
                {"t": c["t"], "available": False, "brokers": []}
                for c in candles
            ],
            "detail_warnings": [],
        },
        "captured_at_ms": 3_000,
    }
    return ParquetStudyViewWriteRequest.model_validate(
        {
            "name": "삼성전자 1분봉 저장뷰",
            "code": snapshot["code"],
            "label": snapshot["label"],
            "timeframe": snapshot["timeframe"],
            "snapshot_from_ms": snapshot["snapshot_from_ms"],
            "snapshot_to_ms": snapshot["snapshot_to_ms"],
            "viewport": snapshot["viewport"],
            "indicator_state": snapshot["indicator_state"],
            "snapshot": snapshot,
            "provenance": snapshot["provenance"],
        }
    )


for n in (50, 200, 390):
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        req = build_req(n)
        sv.create_save_sync(root, req=req, id="view1", now_ms=10)
        sv.atomic_write_json(
            root / "study_views" / "snapshots" / "view1.json",
            req.snapshot.model_dump(mode="json"),
        )
        t0 = time.perf_counter()
        snap = sv.load_restorable_snapshot(root, id="view1")
        elapsed_ms = (time.perf_counter() - t0) * 1000
        print(
            json.dumps(
                {
                    "bars": n,
                    "load_restorable_ms": round(elapsed_ms, 2),
                    "candles": len(snap.bundle.candles),
                    "details": len(snap.bundle.orderbook_buckets),
                },
                ensure_ascii=False,
            )
        )
```

- [ ] **Step 2: Run the probe**

Run:

```bash
uv run python /tmp/study_view_perf_probe.py
```

Expected: each line prints JSON. A healthy result should have `load_restorable_ms` close to raw JSON validation time, usually tens of milliseconds for 390 bars on this local setup, not hundreds of milliseconds.

- [ ] **Step 3: Remove the temporary probe**

Run:

```bash
rm /tmp/study_view_perf_probe.py
```

Expected: file is removed.

- [ ] **Step 4: Run final verification**

Run:

```bash
uv run pytest tests/api/test_study_views.py tests/api/test_study_views_perf.py tests/test_tables_snapshots.py tests/test_tables_brokers.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit final measurement note if needed**

If no tracked files changed during this task, do not create a commit. If you add a short note to an existing PR description or changelog in a later workflow, include the measured numbers there.

---

## Self-Review

- Spec coverage: This plan addresses the requested “existing 방식에서 빠르게” path only. It avoids period-reference redesign and new storage architecture.
- Load-path cause: Task 1 removes duplicate parquet enrichment during `GET /api/study-views/saves/{id}/snapshot`; legacy pre-detail snapshots stay JSON-only with empty/unavailable detail arrays.
- Save-path cause: Tasks 2 and 3 reduce the current parquet enrichment cost without changing storage semantics.
- Regression coverage: Task 4 prevents the slow load path from silently returning.
- Verification: Task 5 gives local timing evidence and focused backend tests.
- Placeholder scan: No task uses placeholder implementation text; each code-changing step includes concrete code.
- Type consistency: Public signatures remain unchanged for `load_restorable_snapshot()`, `query_bucket_representatives()`, and `query_cumulative_details_at()`.
