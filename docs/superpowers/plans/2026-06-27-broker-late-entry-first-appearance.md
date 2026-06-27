# Broker Late-Entry First Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `신규 거래원 등장` from rolling absence-window detection to side-specific first appearance after the 기준 시각, and remove the `부재 시간 (분)` setting end to end.

**Architecture:** Backend owns event detection from canonicalized broker parquet rows and returns the existing `BrokerLateEntryEvent` wire model. Frontend keeps display filtering, colors, and rendering, but removes the window setting from state, persistence, range requests, and config UI.

**Tech Stack:** Python 3 + DuckDB + FastAPI + pytest; React 18 + TypeScript + Zustand + TanStack Query + Vitest/Testing Library.

## Global Constraints

- `broker + side` is the identity; buy and sell appearances are independent.
- 기준 시각 is inclusive: `930` includes `09:30:00.000`.
- Brokers observed before 기준 시각 do not suppress post-threshold first appearances.
- Emit at most one event per `(broker, side)` per Stock-Date after 기준 시각.
- Remove `부재 시간 (분)` UI and `broker_late_entry_window_minutes` request/state surfaces.
- Do not change chart marker rendering, colors, or side-mode display filtering.

---

## File Structure

- `hoga/tables/brokers.py`: replace rolling absence-window logic with post-threshold first-appearance scanning.
- `hoga/api/bundle.py`: remove `window_minutes` and `broker_late_entry_window_minutes` plumbing.
- `hoga/api/routes.py`: remove the API query parameter and call-site argument.
- `tests/test_tables_brokers.py`: replace absence-window tests with first-appearance tests.
- `tests/test_api_range.py`: remove window parameter assertions.
- `tests/hoga/api/test_bundle.py`: update mocked call expectations if needed.
- `frontend/src/api/rangeRequest.ts`: remove option, query key slot, and query parameter.
- `frontend/src/api/range.test.tsx`: update query key and remove window request test.
- `frontend/src/state/liveIndicatorsPersistence.ts`: remove persisted field/default/normalizer.
- `frontend/src/state/liveIndicatorsPersistence.test.ts`: update persisted defaults and invalid value tests.
- `frontend/src/state/livePage.ts`: remove store field/setter and snapshot persistence of the field.
- `frontend/src/live/useLiveBundle.ts`: stop reading/threading window minutes.
- `frontend/src/live/useLiveBundle.test.tsx`: update expected options.
- `frontend/src/live/indicators/BrokerLateEntryConfig.tsx`: remove the `부재 시간 (분)` row.
- `frontend/src/live/indicators/IndicatorPanel.test.tsx`: assert the row is absent.

### Task 1: Backend First-Appearance Rule

**Files:**
- Modify: `hoga/tables/brokers.py`
- Modify: `hoga/api/bundle.py`
- Modify: `hoga/api/routes.py`
- Modify: `tests/test_tables_brokers.py`
- Modify: `tests/test_api_range.py`

**Interfaces:**
- Consumes: `query_late_entry_events(con, *, path: Path, threshold_ms: int)`.
- Produces: `BrokerLateEntryEventRow(t_ms: int, broker: str, side: BrokerSide, net: int)` once per post-threshold `(broker, side)`.

- [ ] **Step 1: Replace table tests**

In `tests/test_tables_brokers.py`, replace the old pre-threshold-as-initial-state and absence-window tests with:

```python
def test_query_late_entry_events_start_seen_history_at_threshold(
    tmp_path: Path,
) -> None:
    before = PARSERS[4](_broker_parts_named(
        ts_ms=92900000,
        seq=1,
        sell_names=["S1", "S2", "S3", "S4", "S5"],
        sell_today=[10, 10, 10, 10, 10],
        buy_names=["Dual", "B2", "B3", "B4", "B5"],
        buy_today=[50, 10, 10, 10, 10],
    ))
    at_threshold = PARSERS[4](_broker_parts_named(
        ts_ms=93000000,
        seq=2,
        sell_names=["Dual", "NewSell", "S3", "S4", "S5"],
        sell_today=[70, 30, 10, 10, 10],
        buy_names=["Dual", "NewBuy", "B3", "B4", "B5"],
        buy_today=[50, 80, 10, 10, 10],
    ))
    later = PARSERS[4](_broker_parts_named(
        ts_ms=94500000,
        seq=3,
        sell_names=["Dual", "NewSell", "LaterSell", "S4", "S5"],
        sell_today=[90, 40, 60, 10, 10],
        buy_names=["Dual", "NewBuy", "LaterBuy", "B4", "B5"],
        buy_today=[55, 90, 55, 10, 10],
    ))
    out = tmp_path / "brokers.parquet"
    write_parquet(before + at_threshold + later, out)
    con = duckdb.connect()

    events = query_late_entry_events(con, path=out, threshold_ms=93000000)

    assert [(e.t_ms, e.broker, e.side) for e in events] == [
        (93000000, "Dual", "buy"),
        (93000000, "Dual", "sell"),
        (93000000, "NewBuy", "buy"),
        (93000000, "NewSell", "sell"),
        (94500000, "LaterBuy", "buy"),
        (94500000, "LaterSell", "sell"),
    ]
```

Also add:

```python
def test_query_late_entry_events_emit_each_broker_side_once_after_threshold(
    tmp_path: Path,
) -> None:
    first = PARSERS[4](_broker_parts_named(
        ts_ms=93000000,
        seq=1,
        sell_names=["S1", "S2", "S3", "S4", "S5"],
        sell_today=[10, 10, 10, 10, 10],
        buy_names=["ReBuy", "NewBuy", "B3", "B4", "B5"],
        buy_today=[80, 70, 10, 10, 10],
    ))
    gone = PARSERS[4](_broker_parts_named(
        ts_ms=94000000,
        seq=2,
        sell_names=["S1", "S2", "S3", "S4", "S5"],
        sell_today=[10, 10, 10, 10, 10],
        buy_names=["Other", "NewBuy", "B3", "B4", "B5"],
        buy_today=[60, 90, 10, 10, 10],
    ))
    returned = PARSERS[4](_broker_parts_named(
        ts_ms=100000000,
        seq=3,
        sell_names=["S1", "S2", "S3", "S4", "S5"],
        sell_today=[10, 10, 10, 10, 10],
        buy_names=["ReBuy", "NewBuy", "B3", "B4", "B5"],
        buy_today=[90, 95, 10, 10, 10],
    ))
    out = tmp_path / "brokers.parquet"
    write_parquet(first + gone + returned, out)
    con = duckdb.connect()

    events = query_late_entry_events(con, path=out, threshold_ms=93000000)

    triples = [(e.t_ms, e.broker, e.side) for e in events]
    assert triples.count((93000000, "ReBuy", "buy")) == 1
    assert (100000000, "ReBuy", "buy") not in triples
    assert (94000000, "Other", "buy") in triples
```

- [ ] **Step 2: Run backend tests to verify failure**

Run:

```bash
pytest tests/test_tables_brokers.py -q
```

Expected: FAIL until `query_late_entry_events` is changed and old call signatures are removed.

- [ ] **Step 3: Implement backend rule and remove API window plumbing**

In `hoga/tables/brokers.py`, change `query_late_entry_events` to:

```python
def query_late_entry_events(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    threshold_ms: int,
) -> list[BrokerLateEntryEventRow]:
    """Return first post-threshold appearances per canonical (broker, side).

    ``threshold_ms`` and returned ``t_ms`` use the parquet-native HHMMSSmmm
    encoding. The API layer converts them to Unix ms.
    """
    from hoga.broker_names import canonical

    rows = con.execute(
        """
        SELECT
            broker,
            side,
            ts_ms,
            SUM(CASE WHEN side = 'buy' THEN qty_today ELSE -qty_today END) AS net
        FROM read_parquet(?)
        WHERE ts_ms >= ?
        GROUP BY broker, side, ts_ms
        ORDER BY ts_ms, broker, side
        """,
        [str(path), threshold_ms],
    ).fetchall()

    collapsed: dict[tuple[str, BrokerSide, int], int] = {}
    for raw_broker, raw_side, ts_ms_raw, net_raw in rows:
        broker = canonical(str(raw_broker))
        side: BrokerSide = "buy" if raw_side == "buy" else "sell"
        key = (broker, side, int(ts_ms_raw))
        collapsed[key] = collapsed.get(key, 0) + int(net_raw)

    by_ts: dict[int, dict[tuple[str, BrokerSide], int]] = {}
    for (broker, side, ts_ms), net in collapsed.items():
        by_ts.setdefault(ts_ms, {})[(broker, side)] = net

    seen: set[tuple[str, BrokerSide]] = set()
    events: list[BrokerLateEntryEventRow] = []
    for ts_ms in sorted(by_ts):
        current = by_ts[ts_ms]
        for broker, side in sorted(current):
            key = (broker, side)
            if key in seen:
                continue
            events.append(BrokerLateEntryEventRow(
                t_ms=ts_ms,
                broker=broker,
                side=side,
                net=current[key],
            ))
        seen.update(current)

    return events
```

Remove `_hhmmssms_to_midnight_ms` if it is unused.

In `hoga/api/bundle.py`, remove the `window_minutes` argument from `build_broker_late_entries_slice`, remove `broker_late_entry_window_minutes` from `build_range_bundle`, and remove `window_minutes=...` at the call site.

In `hoga/api/routes.py`, remove:

```python
broker_late_entry_window_minutes: int = Query(30, ge=1, le=240),
```

and remove the argument when calling `build_range_bundle`.

- [ ] **Step 4: Update API tests**

In `tests/test_api_range.py`, remove default fixture arguments and tests that assert `broker_late_entry_window_minutes` is threaded or rejected. Keep the start-HHMM and enabled/disabled tests.

- [ ] **Step 5: Run backend verification**

Run:

```bash
pytest tests/test_tables_brokers.py tests/test_api_range.py tests/hoga/api/test_bundle.py -q
```

Expected: PASS.

### Task 2: Frontend Window Setting Removal

**Files:**
- Modify: `frontend/src/api/rangeRequest.ts`
- Modify: `frontend/src/api/range.test.tsx`
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/liveIndicatorsPersistence.test.ts`
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`
- Modify: `frontend/src/live/indicators/BrokerLateEntryConfig.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Consumes: `brokerLateEntryStartHHMM`, `brokerLateEntrySideMode`, `brokerLateEntryBuyColor`, `brokerLateEntrySellColor`.
- Produces: no `brokerLateEntryWindowMinutes` field in persisted state or range request options.

- [ ] **Step 1: Update frontend tests**

Update `frontend/src/api/range.test.tsx` so query keys no longer include the window slot and URLs no longer contain `broker_late_entry_window_minutes`. Remove the test named `threads broker_late_entry_window_minutes into query string and query key`.

Update `frontend/src/live/indicators/IndicatorPanel.test.tsx` to assert:

```ts
expect(screen.queryByText('부재 시간 (분)')).toBeNull();
```

Update persistence and live-bundle tests by removing `brokerLateEntryWindowMinutes` from expected objects.

- [ ] **Step 2: Run frontend tests to verify failure**

Run:

```bash
cd frontend && npm test -- --run src/api/range.test.tsx src/state/liveIndicatorsPersistence.test.ts src/live/useLiveBundle.test.tsx src/live/indicators/IndicatorPanel.test.tsx
```

Expected: FAIL until the implementation is updated.

- [ ] **Step 3: Remove range request option and query key slot**

In `frontend/src/api/rangeRequest.ts`, remove `brokerLateEntryWindowMinutes` from `RangeRequestOptions`, `RangeQueryKey`, `buildRangeBundleRequest`, and `PLACEHOLDER_COMPATIBLE_KEY_INDICES`. The query key after `brokerLateEntryStartHHMM` should move directly to `volumeDistributionBins`.

- [ ] **Step 4: Remove persisted/store field**

In `frontend/src/state/liveIndicatorsPersistence.ts`, remove `BROKER_LATE_ENTRY_DEFAULT_WINDOW_MINUTES`, `brokerLateEntryWindowMinutes`, and `normalizeBrokerLateEntryWindowMinutes`. Do not read or return this field from `mergeLiveIndicatorPrefs`.

In `frontend/src/state/livePage.ts`, remove the setter type, snapshot field, normalizer, and `setBrokerLateEntryWindowMinutes`.

- [ ] **Step 5: Remove UI and useLiveBundle plumbing**

In `frontend/src/live/indicators/BrokerLateEntryConfig.tsx`, remove the `windowMinutes` selector, setter selector, and the full `부재 시간 (분)` input block.

In `frontend/src/live/useLiveBundle.ts`, remove the field from argument types, store selectors, query option construction, and memo dependencies.

- [ ] **Step 6: Run frontend verification**

Run:

```bash
cd frontend && npm test -- --run src/api/range.test.tsx src/state/liveIndicatorsPersistence.test.ts src/live/useLiveBundle.test.tsx src/live/indicators/IndicatorPanel.test.tsx
```

Expected: PASS.

### Task 3: Final Cross-Check

**Files:**
- All modified files.

**Interfaces:**
- Produces: a clean implementation matching `docs/superpowers/specs/2026-06-27-broker-late-entry-first-appearance-design.md`.

- [ ] **Step 1: Search for removed surfaces**

Run:

```bash
rg -n "broker_late_entry_window_minutes|brokerLateEntryWindowMinutes|부재 시간|absence_window_ms|BROKER_LATE_ENTRY_DEFAULT_WINDOW_MINUTES" hoga frontend tests
```

Expected: no matches.

- [ ] **Step 2: Run combined targeted verification**

Run:

```bash
pytest tests/test_tables_brokers.py tests/test_api_range.py tests/hoga/api/test_bundle.py -q
cd frontend && npm test -- --run src/api/range.test.tsx src/state/liveIndicatorsPersistence.test.ts src/live/useLiveBundle.test.tsx src/live/indicators/IndicatorPanel.test.tsx
```

Expected: PASS.
