# Live Broker Late-Entry Ratio Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every recorded broker in `/live`, and add a configurable `신규 거래원 등장` marker overlay on the existing `호가비` pane for broker-side pairs first recorded at or after a user-selected HHMM threshold.

**Architecture:** Backend computes side-specific late-entry events from the resolved `brokers.parquet` for each Stock-Date and ships them on `RangeBundle`. Frontend persists the marker's enabled/time/side-mode/colors, filters/render events on the ratio pane, and uses a custom labelled primitive that adapts between full labels and compact group labels by current zoom/collision. Broker list caps are removed independently but in the same feature branch.

**Tech Stack:** Python 3 + FastAPI + Pydantic + DuckDB + PyArrow; React 18 + TypeScript + Zustand + TanStack Query + lightweight-charts v5 + Vitest/Testing Library.

## Global Constraints

- "Recorded broker" means brokers present in stored top-5 buy plus top-5 sell broker snapshots only.
- Late-entry detection is per broker-side pair: `(broker, buy)` and `(broker, sell)` are separate identities.
- 기준 시각 default is `930`; `09:30:00.000` is included.
- `brokerLateEntrySideMode` is one of `'both' | 'buy' | 'sell'`, default `'both'`.
- Buy marker default color is `#ef4444`; sell marker default color is `#3b82f6`.
- Backend returns both buy and sell late-entry events; frontend side-mode filters without refetching.
- Markers render on the existing `호가비` pane only; do not create a separate pane.
- Marker y-value follows the displayed ratio value after the same projector policy; hidden auction points produce no marker.
- Missing `brokers.parquet` is non-fatal and returns no late-entry events for that date.
- Do not infer brokers outside captured top-5/top-5 feed.

---

## File Structure

- `hoga/tables/brokers.py`: remove `query_day_series` top-10 cap; add `BrokerLateEntryEventRow` and `query_late_entry_events(...)` over canonical `(broker, side)` pairs.
- `hoga/api/models.py`: add `BrokerLateEntryEvent`; add `RangeBundle.broker_late_entries`.
- `hoga/api/bundle.py`: add `build_broker_late_entries_slice(...)`; thread events into empty/success `RangeBundle`.
- `hoga/api/routes.py`: validate `broker_late_entry_start_hhmm`; pass it to `build_range_bundle`.
- `frontend/src/api/types.ts`: mirror `BrokerLateEntryEvent` and `RangeBundle.broker_late_entries`; update broker-series comment from `≤ 10` to all recorded brokers.
- `frontend/src/api/range.ts`: add optional `brokerLateEntryStartHHMM` query/key field.
- `frontend/src/state/liveIndicatorsPersistence.ts`: add defaults and validation for enabled/start/side-mode/buy-color/sell-color.
- `frontend/src/state/livePage.ts`: expose setters and persist new fields.
- `frontend/src/live/indicators/BrokerLateEntryConfig.tsx`: new config panel for 기준 시각, 표시 방향, buy/sell colors.
- `frontend/src/live/indicators/IndicatorPanel.tsx`: add `신규 거래원 등장` under `거래원 지표`.
- `frontend/src/live/useLiveBundle.ts`: pass threshold option to `useRange` only when the marker is enabled.
- `frontend/src/sidebar/BrokerTrajectoryTable.tsx`: remove row limit slice.
- `frontend/src/live/liveSidebarAdapters.ts`: remove live broker aggregator slice.
- `frontend/src/chart/projectors/brokerLateEntryMarkers.ts`: pure frontend marker projection, side filtering, ratio y-value lookup, and adaptive grouping helpers.
- `frontend/src/chart/BrokerLateEntryMarkersPrimitive.ts`: custom primitive that draws dots, labels, and compact group labels.
- `frontend/src/chart/RangeSeriesPane.tsx`: add narrow `labelMarkers` primitive path alongside existing `markers`.
- `frontend/src/chart/projectors/ratio.ts`: include broker late-entry marker projector in `RATIO_SPEC`.

---

### Task 1: Backend Broker Queries

**Files:**
- Modify: `hoga/tables/brokers.py`
- Modify: `tests/test_tables_brokers.py`

**Interfaces:**
- Produces: `query_day_series(con, *, path) -> list[BrokerSeriesEntry]` returning all sorted brokers.
- Produces: `BrokerLateEntryEventRow(t_ms: int, broker: str, side: BrokerSide, net: int)`.
- Produces: `query_late_entry_events(con, *, path: Path, threshold_ms: int) -> list[BrokerLateEntryEventRow]`, where `threshold_ms` is native HHMMSSmmm and returned `t_ms` is native HHMMSSmmm.

- [ ] **Step 1: Write failing tests for all-broker series and side-specific late-entry events**

Add these imports and tests to `tests/test_tables_brokers.py`:

```python
from hoga.tables.brokers import query_late_entry_events


def test_query_day_series_returns_all_recorded_brokers(tmp_path: Path) -> None:
    rows: list[BrokerRow] = []
    for i in range(3):
        rows.extend(
            PARSERS[4](
                _broker_parts_named(
                    ts_ms=90000000 + i * 100000,
                    seq=i + 1,
                    sell_names=[f"S{i}-{j}" for j in range(5)],
                    sell_today=[100 + j for j in range(5)],
                    buy_names=[f"B{i}-{j}" for j in range(5)],
                    buy_today=[200 + j for j in range(5)],
                )
            )
        )
    out = tmp_path / "brokers.parquet"
    write_parquet(rows, out)
    con = duckdb.connect()

    entries = query_day_series(con, path=out)

    assert len(entries) == 30
    assert [abs(e.final_net) for e in entries] == sorted(
        [abs(e.final_net) for e in entries],
        reverse=True,
    )


def test_query_late_entry_events_are_side_specific_and_once(tmp_path: Path) -> None:
    before = PARSERS[4](
        _broker_parts_named(
            ts_ms=92900000,
            seq=1,
            sell_names=["S1", "S2", "S3", "S4", "S5"],
            sell_today=[10, 10, 10, 10, 10],
            buy_names=["Dual", "B2", "B3", "B4", "B5"],
            buy_today=[50, 10, 10, 10, 10],
        )
    )
    at_threshold = PARSERS[4](
        _broker_parts_named(
            ts_ms=93000000,
            seq=2,
            sell_names=["Dual", "NewSell", "S3", "S4", "S5"],
            sell_today=[70, 30, 10, 10, 10],
            buy_names=["NewBuy", "B2", "B3", "B4", "B5"],
            buy_today=[80, 10, 10, 10, 10],
        )
    )
    later = PARSERS[4](
        _broker_parts_named(
            ts_ms=94500000,
            seq=3,
            sell_names=["Dual", "NewSell", "LaterSell", "S4", "S5"],
            sell_today=[90, 40, 60, 10, 10],
            buy_names=["NewBuy", "LaterBuy", "B3", "B4", "B5"],
            buy_today=[90, 55, 10, 10, 10],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(before + at_threshold + later, out)
    con = duckdb.connect()

    events = query_late_entry_events(con, path=out, threshold_ms=93000000)

    assert [(e.t_ms, e.broker, e.side) for e in events] == [
        (93000000, "Dual", "sell"),
        (93000000, "NewBuy", "buy"),
        (93000000, "NewSell", "sell"),
        (94500000, "LaterBuy", "buy"),
        (94500000, "LaterSell", "sell"),
    ]
    assert all(e.broker != "Dual" or e.side != "buy" for e in events)
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pytest tests/test_tables_brokers.py::test_query_day_series_returns_all_recorded_brokers tests/test_tables_brokers.py::test_query_late_entry_events_are_side_specific_and_once -q
```

Expected: first test fails with `len(entries) == 10`, second fails because `query_late_entry_events` does not exist.

- [ ] **Step 3: Implement broker query changes**

In `hoga/tables/brokers.py`, update the docstring line that says "Returns at most 10" to "Returns all entries", change `return entries[:10]` to `return entries`, and add this dataclass/function below `_query_canonical_series_points`:

```python
@dataclass(frozen=True)
class BrokerLateEntryEventRow:
    t_ms: int
    broker: str
    side: BrokerSide
    net: int


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
        GROUP BY broker, side, ts_ms
        ORDER BY ts_ms, broker, side
        """,
        [str(path)],
    ).fetchall()

    pre_seen: set[tuple[str, BrokerSide]] = set()
    first_after: dict[tuple[str, BrokerSide], BrokerLateEntryEventRow] = {}
    for raw_broker, raw_side, ts_ms_raw, net_raw in rows:
        broker = canonical(str(raw_broker))
        side = "buy" if raw_side == "buy" else "sell"
        key = (broker, side)
        ts_ms = int(ts_ms_raw)
        net = int(net_raw)
        if ts_ms < threshold_ms:
            pre_seen.add(key)
            continue
        if key in pre_seen or key in first_after:
            continue
        first_after[key] = BrokerLateEntryEventRow(
            t_ms=ts_ms,
            broker=broker,
            side=side,
            net=net,
        )

    return sorted(first_after.values(), key=lambda e: (e.t_ms, e.broker, e.side))
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
pytest tests/test_tables_brokers.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/brokers.py tests/test_tables_brokers.py
git commit -m "feat: add broker late-entry table query"
```

---

### Task 2: RangeBundle Wire And API Threading

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/api/bundle.py`
- Modify: `hoga/api/routes.py`
- Modify: `tests/test_api_range.py`
- Modify: `tests/test_api_brokers_series.py`

**Interfaces:**
- Consumes: `query_late_entry_events(con, *, path, threshold_ms)`.
- Produces: `BrokerLateEntryEvent(t_ms: int, broker: str, side: Literal["buy", "sell"], net: int)`.
- Produces: `RangeBundle.broker_late_entries: list[BrokerLateEntryEvent]`.
- Produces: `/api/range?...&broker_late_entry_start_hhmm=930`.

- [ ] **Step 1: Write failing API/model tests**

In `tests/test_api_brokers_series.py`, replace the old cap assertion:

```python
# At most 10 entries.
assert len(body["brokers"]) <= 10
```

with:

```python
# All recorded broker entries are returned; no API-level top-10 cap remains.
assert len(body["brokers"]) >= 0
```

Add this test to `tests/test_api_range.py`:

```python
def test_range_accepts_broker_late_entry_threshold_and_returns_field(
    app_client: TestClient,
) -> None:
    r = app_client.get(
        "/api/range?code=003490&from=20260519&to=20260519"
        "&bucket_ms=60000&broker_late_entry_start_hhmm=930"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "broker_late_entries" in body
    assert isinstance(body["broker_late_entries"], list)
    for event in body["broker_late_entries"]:
        assert set(event) == {"t_ms", "broker", "side", "net"}
        assert event["side"] in ("buy", "sell")
        assert event["t_ms"] >= 1_577_836_800_000


def test_range_rejects_invalid_broker_late_entry_threshold(
    app_client: TestClient,
) -> None:
    r = app_client.get(
        "/api/range?code=003490&from=20260519&to=20260519"
        "&bucket_ms=60000&broker_late_entry_start_hhmm=800"
    )
    assert r.status_code == 400
    assert "broker_late_entry_start_hhmm" in r.text
```

- [ ] **Step 2: Run API tests and verify they fail**

Run:

```bash
pytest tests/test_api_range.py::test_range_accepts_broker_late_entry_threshold_and_returns_field tests/test_api_range.py::test_range_rejects_invalid_broker_late_entry_threshold -q
```

Expected: FAIL because the field/query parameter is not implemented.

- [ ] **Step 3: Add Pydantic wire model**

In `hoga/api/models.py`, add near `BrokerSeriesResponse` models or near `RangeBundle`:

```python
class BrokerLateEntryEvent(BaseModel):
    t_ms: int
    broker: str
    side: Literal["buy", "sell"]
    net: int
```

Add `BrokerLateEntryEvent` to imports in `hoga/api/bundle.py`, and add this field to `RangeBundle`:

```python
broker_late_entries: list[BrokerLateEntryEvent] = Field(default_factory=list)
```

- [ ] **Step 4: Add range bundle builder slice**

In `hoga/api/bundle.py`, import brokers table:

```python
from hoga.tables import brokers as brokers_tbl
```

Add this helper before `build_range_bundle`:

```python
def _hhmm_to_hhmmssms(value: int) -> int:
    hh = value // 100
    mm = value % 100
    if hh < 9 or hh > 15 or mm < 0 or mm > 59:
        raise ValueError("broker_late_entry_start_hhmm must be between 900 and 1520")
    if hh == 15 and mm > 20:
        raise ValueError("broker_late_entry_start_hhmm must be between 900 and 1520")
    return hh * 10_000_000 + mm * 100_000


def build_broker_late_entries_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    start_hhmm: int,
) -> list[BrokerLateEntryEvent]:
    path = engine.parquet_dir(date, code, source) / "brokers.parquet"
    if not path.exists():
        return []
    threshold_ms = _hhmm_to_hhmmssms(start_hhmm)
    return [
        BrokerLateEntryEvent(
            t_ms=hhmmssms_to_unix_ms(date, row.t_ms),
            broker=row.broker,
            side=row.side,
            net=row.net,
        )
        for row in brokers_tbl.query_late_entry_events(
            engine.conn,
            path=path,
            threshold_ms=threshold_ms,
        )
    ]
```

Add `broker_late_entry_start_hhmm: int | None = None` to `build_range_bundle(...)`. Inside the per-date success loop, collect:

```python
broker_late_entries: list[BrokerLateEntryEvent] = []
```

and after `included_dates.append(d)`:

```python
if broker_late_entry_start_hhmm is not None:
    broker_late_entries.extend(
        build_broker_late_entries_slice(
            engine,
            code=code,
            date=d,
            source=source,
            start_hhmm=broker_late_entry_start_hhmm,
        )
    )
```

Add `broker_late_entries=[]` to `_empty_range_bundle`, and `broker_late_entries=broker_late_entries` to the success `RangeBundle(...)`.

- [ ] **Step 5: Thread and validate the route parameter**

In `hoga/api/routes.py`, add to `api_range(...)`:

```python
broker_late_entry_start_hhmm: int | None = Query(None),
```

Before `return build_range_bundle(...)`, validate:

```python
if broker_late_entry_start_hhmm is not None:
    hh = broker_late_entry_start_hhmm // 100
    mm = broker_late_entry_start_hhmm % 100
    if hh < 9 or hh > 15 or mm < 0 or mm > 59 or (hh == 15 and mm > 20):
        raise HTTPException(400, "broker_late_entry_start_hhmm must be between 900 and 1520")
```

Pass the value to `build_range_bundle(...)`:

```python
broker_late_entry_start_hhmm=broker_late_entry_start_hhmm,
```

- [ ] **Step 6: Run backend tests**

Run:

```bash
pytest tests/test_tables_brokers.py tests/test_api_brokers_series.py tests/test_api_range.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/models.py hoga/api/bundle.py hoga/api/routes.py tests/test_api_range.py tests/test_api_brokers_series.py
git commit -m "feat: add broker late-entry range events"
```

---

### Task 3: Frontend Types, Range Fetch, Store, And Indicator UI

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/range.ts`
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/livePage.ts`
- Create: `frontend/src/live/indicators/BrokerLateEntryConfig.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Modify: `frontend/src/live/useLiveBundle.ts`
- Test: `frontend/src/state/liveIndicatorsPersistence.test.ts`
- Test: `frontend/src/api/range.test.tsx`
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Produces: `BrokerLateEntrySideMode = 'both' | 'buy' | 'sell'`.
- Produces store fields and setters: `brokerLateEntryEnabled`, `brokerLateEntryStartHHMM`, `brokerLateEntrySideMode`, `brokerLateEntryBuyColor`, `brokerLateEntrySellColor`, `setBrokerLateEntryEnabled`, `setBrokerLateEntryStartHHMM`, `setBrokerLateEntrySideMode`, `setBrokerLateEntryStyle`.
- Produces `useRange(..., options?: { brokerLateEntryStartHHMM?: number | null; ... })`.

- [ ] **Step 1: Write failing persistence tests**

Add to `frontend/src/state/liveIndicatorsPersistence.test.ts`:

```ts
it('normalizes broker late-entry defaults and invalid persisted values', () => {
  expect(mergeLiveIndicatorPrefs(undefined)).toMatchObject({
    brokerLateEntryEnabled: false,
    brokerLateEntryStartHHMM: 930,
    brokerLateEntrySideMode: 'both',
    brokerLateEntryBuyColor: '#ef4444',
    brokerLateEntrySellColor: '#3b82f6',
  });

  expect(mergeLiveIndicatorPrefs({
    movingAverages: DEFAULT_LIVE_MAS,
    brokerLateEntryEnabled: true,
    brokerLateEntryStartHHMM: 800,
    brokerLateEntrySideMode: 'ask',
    brokerLateEntryBuyColor: 'hot',
    brokerLateEntrySellColor: '#12345g',
  })).toMatchObject({
    brokerLateEntryEnabled: true,
    brokerLateEntryStartHHMM: 930,
    brokerLateEntrySideMode: 'both',
    brokerLateEntryBuyColor: '#ef4444',
    brokerLateEntrySellColor: '#3b82f6',
  });
});
```

- [ ] **Step 2: Write failing UI/range tests**

In `frontend/src/api/range.test.tsx`, add a test that renders `useRange` with `{ brokerLateEntryStartHHMM: 945 }` and asserts the requested URL contains `broker_late_entry_start_hhmm=945` and the query key changes. If the current test harness stubs `apiCall`, follow the existing pattern and assert on the same captured URL variable.

In `frontend/src/live/indicators/IndicatorPanel.test.tsx`, add:

```tsx
it('renders broker late-entry controls under 거래원 지표', async () => {
  render(<IndicatorPanel onClose={() => {}} />);
  await userEvent.click(screen.getByText('신규 거래원 등장'));
  expect(screen.getByText('기준 시각 (HHMM)')).toBeTruthy();
  expect(screen.getByText('표시 방향')).toBeTruthy();
  expect(screen.getByRole('button', { name: '둘다' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '매수만' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '매도만' })).toBeTruthy();
  expect(screen.getByText('매수 색상')).toBeTruthy();
  expect(screen.getByText('매도 색상')).toBeTruthy();
});
```

- [ ] **Step 3: Run frontend tests and verify they fail**

Run:

```bash
cd frontend
npm test -- --run src/state/liveIndicatorsPersistence.test.ts src/api/range.test.tsx src/live/indicators/IndicatorPanel.test.tsx
```

Expected: FAIL because the fields/UI do not exist.

- [ ] **Step 4: Add frontend wire types**

In `frontend/src/api/types.ts`, add:

```ts
export type BrokerLateEntryEvent = {
  t_ms: number;
  broker: string;
  side: 'buy' | 'sell';
  net: number;
};
```

Update `BrokerSeriesResponse.brokers` comment from `≤ 10 entries` to `all recorded brokers`.

Add to `RangeBundle`:

```ts
broker_late_entries: BrokerLateEntryEvent[];
```

- [ ] **Step 5: Add persistence fields and setters**

In `frontend/src/state/liveIndicatorsPersistence.ts`, export:

```ts
export type BrokerLateEntrySideMode = 'both' | 'buy' | 'sell';
export const BROKER_LATE_ENTRY_DEFAULT_START_HHMM = 930;
export const BROKER_LATE_ENTRY_BUY_DEFAULT_COLOR = '#ef4444';
export const BROKER_LATE_ENTRY_SELL_DEFAULT_COLOR = '#3b82f6';
```

Add fields to `PersistedIndicators`, normalize with:

```ts
function normalizeHHMM(value: unknown): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(n)) return BROKER_LATE_ENTRY_DEFAULT_START_HHMM;
  const hh = Math.floor(n / 100);
  const mm = n % 100;
  if (hh < 9 || hh > 15 || mm < 0 || mm > 59 || (hh === 15 && mm > 20)) {
    return BROKER_LATE_ENTRY_DEFAULT_START_HHMM;
  }
  return n;
}

function normalizeBrokerLateEntrySideMode(value: unknown): BrokerLateEntrySideMode {
  return value === 'buy' || value === 'sell' || value === 'both' ? value : 'both';
}
```

Include the normalized fields in `build(...)` and all fallback branches.

In `frontend/src/state/livePage.ts`, include fields in `snapshotIndicators`, add setter types, and implement:

```ts
setBrokerLateEntryEnabled: (enabled) => {
  set({ brokerLateEntryEnabled: enabled });
  persistIndicators(snapshotIndicators(get));
},
setBrokerLateEntryStartHHMM: (value) => {
  const hh = Math.floor(value / 100);
  const mm = value % 100;
  const next = hh < 9 || hh > 15 || mm < 0 || mm > 59 || (hh === 15 && mm > 20)
    ? 930
    : Math.trunc(value);
  set({ brokerLateEntryStartHHMM: next });
  persistIndicators(snapshotIndicators(get));
},
setBrokerLateEntrySideMode: (mode) => {
  if (mode !== 'both' && mode !== 'buy' && mode !== 'sell') return;
  set({ brokerLateEntrySideMode: mode });
  persistIndicators(snapshotIndicators(get));
},
setBrokerLateEntryStyle: (patch) => {
  set((s) => ({
    brokerLateEntryBuyColor: patch.buyColor ?? s.brokerLateEntryBuyColor,
    brokerLateEntrySellColor: patch.sellColor ?? s.brokerLateEntrySellColor,
  }));
  persistIndicators(snapshotIndicators(get));
},
```

- [ ] **Step 6: Add indicator UI**

Create `frontend/src/live/indicators/BrokerLateEntryConfig.tsx`:

```tsx
import { useLivePageStore, type BrokerLateEntrySideMode } from '../../state/livePage';
import { MA_COLOR_ROWS } from './MAStylePicker';

const SIDE_OPTIONS: Array<{ value: BrokerLateEntrySideMode; label: string }> = [
  { value: 'both', label: '둘다' },
  { value: 'buy', label: '매수만' },
  { value: 'sell', label: '매도만' },
];

function ColorGrid({ label, color, onChange }: { label: string; color: string; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <div aria-hidden="true" className="h-6 w-10 rounded border border-border-subtle" style={{ backgroundColor: color, borderColor: color }} />
      <div>
        <div className="text-xs text-fg-dim mb-1">{label}</div>
        <div className="flex flex-col gap-1">
          {MA_COLOR_ROWS.map((row, rowIndex) => (
            <div key={`${label}-${rowIndex}`} className="grid grid-cols-8 gap-1">
              {row.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-label={`${label} ${candidate}`}
                  aria-pressed={candidate.toLowerCase() === color.toLowerCase()}
                  className="h-5 w-5 rounded-full"
                  style={{
                    backgroundColor: candidate,
                    outline: candidate.toLowerCase() === color.toLowerCase() ? '2px solid var(--fg)' : 'none',
                    outlineOffset: 2,
                    border: '1px solid var(--border-subtle)',
                  }}
                  onClick={() => onChange(candidate)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function BrokerLateEntryConfig() {
  const start = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
  const sideMode = useLivePageStore((s) => s.brokerLateEntrySideMode);
  const buyColor = useLivePageStore((s) => s.brokerLateEntryBuyColor);
  const sellColor = useLivePageStore((s) => s.brokerLateEntrySellColor);
  const setStart = useLivePageStore((s) => s.setBrokerLateEntryStartHHMM);
  const setSideMode = useLivePageStore((s) => s.setBrokerLateEntrySideMode);
  const setStyle = useLivePageStore((s) => s.setBrokerLateEntryStyle);

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">신규 거래원 등장</h3>
      <div className="mb-3">
        <label className="flex items-center justify-between gap-3 text-sm text-fg">
          <span>기준 시각 (HHMM)</span>
          <input
            type="number"
            min={900}
            max={1520}
            step={1}
            aria-label="신규 거래원 등장 기준 시각"
            className="w-[84px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums"
            value={start}
            onChange={(event) => setStart(Number(event.currentTarget.value))}
          />
        </label>
      </div>
      <div className="mb-3">
        <div className="text-xs text-fg-dim mb-1.5">표시 방향</div>
        <div className="inline-flex rounded border border-border overflow-hidden">
          {SIDE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={sideMode === option.value}
              className={`px-3 py-1 text-sm ${sideMode === option.value ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input'}`}
              onClick={() => setSideMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <ColorGrid label="매수 색상" color={buyColor} onChange={(color) => setStyle({ buyColor: color })} />
        <ColorGrid label="매도 색상" color={sellColor} onChange={(color) => setStyle({ sellColor: color })} />
      </div>
    </div>
  );
}
```

In `IndicatorPanel.tsx`, add category id `'broker-late-entry'`, add `{ id: 'broker-late-entry', label: '신규 거래원 등장', group: 'broker' }`, wire checked/toggle to the new store fields, import and render `<BrokerLateEntryConfig />`.

- [ ] **Step 7: Thread range option from live bundle**

Update `frontend/src/api/range.ts` options type and query key:

```ts
brokerLateEntryStartHHMM?: number | null;
```

Append query string only when non-null:

```ts
const brokerLateEntryQs = options?.brokerLateEntryStartHHMM != null
  ? `&broker_late_entry_start_hhmm=${options.brokerLateEntryStartHHMM}`
  : '';
```

Include it in the `queryKey` and URL.

In `frontend/src/live/useLiveBundle.ts`, read:

```ts
const brokerLateEntryEnabled = useLivePageStore((s) => s.brokerLateEntryEnabled);
const brokerLateEntryStartHHMM = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
```

Pass to `useRange` options:

```ts
brokerLateEntryStartHHMM: brokerLateEntryEnabled ? brokerLateEntryStartHHMM : null,
```

- [ ] **Step 8: Run frontend tests**

Run:

```bash
cd frontend
npm test -- --run src/state/liveIndicatorsPersistence.test.ts src/api/range.test.tsx src/live/indicators/IndicatorPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/range.ts frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/livePage.ts frontend/src/live/indicators/BrokerLateEntryConfig.tsx frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/useLiveBundle.ts frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/api/range.test.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "feat: add broker late-entry indicator settings"
```

---

### Task 4: Remove Frontend Broker Row Caps

**Files:**
- Modify: `frontend/src/sidebar/BrokerTrajectoryTable.tsx`
- Modify: `frontend/src/live/liveSidebarAdapters.ts`
- Modify: `frontend/src/sidebar/BrokerTrajectoryTable.test.tsx`
- Modify: `frontend/src/live/liveSidebarAdapters.test.ts`

**Interfaces:**
- Consumes: `BrokerSeriesEntry[]` sorted by backend or live aggregation.
- Produces: all recorded broker rows with unchanged ordering.

- [ ] **Step 1: Write failing frontend cap tests**

In `frontend/src/sidebar/BrokerTrajectoryTable.test.tsx`, add or update a test:

```tsx
it('renders more than ten broker rows', () => {
  const series = Array.from({ length: 12 }, (_, i) => ({
    broker: `Broker${i}`,
    final_net: 100 - i,
    dominant_side: 'buy' as const,
    points: [{ ts_ms: Date.UTC(2026, 0, 2, 1, 0, 0) + i * 1000, net: 100 - i }],
  }));
  render(<BrokerTrajectoryTable series={series} cursorMs={null} />);
  expect(screen.getAllByTestId('broker-row')).toHaveLength(12);
});
```

In `frontend/src/live/liveSidebarAdapters.test.ts`, add:

```ts
it('aggregateBrokerSeries returns more than ten broker identities', () => {
  const broker = Array.from({ length: 12 }, (_, i) => ({
    t_ms: 1_800_000_000_000 + i,
    buy_top: [{ name: `Broker${i}`, qty: 100 + i }],
    sell_top: [],
  }));
  expect(aggregateBrokerSeries(broker)).toHaveLength(12);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd frontend
npm test -- --run src/sidebar/BrokerTrajectoryTable.test.tsx src/live/liveSidebarAdapters.test.ts
```

Expected: FAIL with only 10 rows/entries.

- [ ] **Step 3: Remove caps**

In `BrokerTrajectoryTable.tsx`, delete `BROKER_TRAJECTORY_ROW_LIMIT` and replace:

```ts
(series?.slice(0, BROKER_TRAJECTORY_ROW_LIMIT) ?? [])
```

with:

```ts
(series ?? [])
```

In `liveSidebarAdapters.ts`, update the docstring to say "returns all recorded broker identities" and replace:

```ts
return entries.slice(0, 10);
```

with:

```ts
return entries;
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd frontend
npm test -- --run src/sidebar/BrokerTrajectoryTable.test.tsx src/live/liveSidebarAdapters.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/sidebar/BrokerTrajectoryTable.tsx frontend/src/live/liveSidebarAdapters.ts frontend/src/sidebar/BrokerTrajectoryTable.test.tsx frontend/src/live/liveSidebarAdapters.test.ts
git commit -m "feat: show all recorded brokers"
```

---

### Task 5: Ratio Marker Projection Helpers

**Files:**
- Create: `frontend/src/chart/projectors/brokerLateEntryMarkers.ts`
- Create: `frontend/src/chart/projectors/brokerLateEntryMarkers.test.ts`

**Interfaces:**
- Consumes: `RangeBundle.broker_late_entries`, `quote_ratio.points`, `VirtualAxis`, `RatioPaneContext`.
- Produces: `BrokerLateEntryMarkerPoint[]` for the primitive.
- Produces: `layoutBrokerLateEntryLabels(...)` for adaptive full/group label decisions.

- [ ] **Step 1: Write failing projector tests**

Create `frontend/src/chart/projectors/brokerLateEntryMarkers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RangeBundle } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';
import {
  projectBrokerLateEntryMarkers,
  layoutBrokerLateEntryLabels,
} from './brokerLateEntryMarkers';

function bundle(): RangeBundle {
  return {
    code: '005930',
    from_date: '20260626',
    to_date: '20260626',
    bucket_ms: 60000,
    segments: [],
    candles: [],
    quote_ratio: {
      bucket_ms: 60000,
      points: [
        { t: 1_800_000_000_000, bid_total: 200, ask_total: 100, bid_max: 200, ask_max: 100, imb_max_bid: 200, imb_max_ask: 100 },
        { t: 1_800_000_060_000, bid_total: 100, ask_total: 300, bid_max: 100, ask_max: 300, imb_max_bid: 100, imb_max_ask: 300 },
      ],
    },
    fill_strength: { bucket_ms: 60000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [
      { t_ms: 1_800_000_000_000, broker: '삼성증권', side: 'buy', net: 10 },
      { t_ms: 1_800_000_060_000, broker: '키움증권', side: 'sell', net: -20 },
    ],
  };
}

describe('broker late-entry marker projection', () => {
  it('filters by side mode and applies side colors', () => {
    const axis = createVirtualAxis([{ date: '20260626', sessionOpenMs: 1_800_000_000_000, sessionCloseMs: 1_800_030_000_000 }]);
    const markers = projectBrokerLateEntryMarkers(bundle(), axis, {
      auctionWindowMask: false,
      outlierFilterEnabled: false,
      outlierThreshold: 10,
      sideMode: 'buy',
      buyColor: '#ef4444',
      sellColor: '#3b82f6',
    });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ broker: '삼성증권', side: 'buy', color: '#ef4444' });
  });

  it('uses nearest earlier displayed ratio value in same session', () => {
    const b = bundle();
    b.broker_late_entries = [{ t_ms: 1_800_000_090_000, broker: '후발증권', side: 'sell', net: -5 }];
    const axis = createVirtualAxis([{ date: '20260626', sessionOpenMs: 1_800_000_000_000, sessionCloseMs: 1_800_030_000_000 }]);
    const markers = projectBrokerLateEntryMarkers(b, axis, {
      auctionWindowMask: false,
      outlierFilterEnabled: false,
      outlierThreshold: 10,
      sideMode: 'both',
      buyColor: '#ef4444',
      sellColor: '#3b82f6',
    });
    expect(markers).toHaveLength(1);
    expect(markers[0].price).toBeLessThan(0);
  });

  it('groups colliding labels and expands when boxes no longer collide', () => {
    const markers = [
      { time: 1 as any, price: 0, broker: '삼성증권', label: '삼성', side: 'buy' as const, color: '#ef4444' },
      { time: 1 as any, price: 0, broker: '키움증권', label: '키움', side: 'buy' as const, color: '#ef4444' },
      { time: 1 as any, price: 0, broker: '미래에셋증권', label: '미래', side: 'buy' as const, color: '#ef4444' },
    ];
    expect(layoutBrokerLateEntryLabels(markers, { minHorizontalGapPx: 4, estimateLabelWidthPx: () => 30 }).groups[0].label).toBe('삼성 +2');
    expect(layoutBrokerLateEntryLabels(markers, { minHorizontalGapPx: 100, forceFull: true, estimateLabelWidthPx: () => 30 }).groups).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd frontend
npm test -- --run src/chart/projectors/brokerLateEntryMarkers.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement projection helper**

Create `frontend/src/chart/projectors/brokerLateEntryMarkers.ts`:

```ts
import type { Time, UTCTimestamp } from 'lightweight-charts';
import type { BrokerLateEntryEvent, QuoteRatioPoint, RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { quoteImbalance } from '../../util/imbalance';
import { brokerDisplayShort } from '../../sidebar/brokerDisplayNames';
import { isAuctionHidden } from '../util/auctionHide';
import type { BrokerLateEntrySideMode } from '../../state/liveIndicatorsPersistence';
import type { RatioPaneContext } from './ratio';

export type BrokerLateEntryMarkerPoint = {
  time: Time;
  price: number;
  broker: string;
  label: string;
  side: 'buy' | 'sell';
  color: string;
};

export type BrokerLateEntryMarkerContext = RatioPaneContext & {
  sideMode: BrokerLateEntrySideMode;
  buyColor: string;
  sellColor: string;
};

function sideAllowed(side: 'buy' | 'sell', mode: BrokerLateEntrySideMode): boolean {
  return mode === 'both' || mode === side;
}

function displayedRatioValue(p: QuoteRatioPoint, ctx: RatioPaneContext): number {
  const raw = ctx.intraMax
    ? quoteImbalance(p.imb_max_bid, p.imb_max_ask)
    : quoteImbalance(p.bid_total, p.ask_total);
  return ctx.outlierFilterEnabled && 1 + Math.abs(raw) >= ctx.outlierThreshold ? 0 : raw;
}

function findDisplayedRatioPoint(
  points: readonly QuoteRatioPoint[],
  event: BrokerLateEntryEvent,
  axis: VirtualAxis,
  ctx: RatioPaneContext,
): QuoteRatioPoint | null {
  let best: QuoteRatioPoint | null = null;
  for (const p of points) {
    if (p.t > event.t_ms) break;
    if (!axis.contains(p.t)) continue;
    if (isAuctionHidden(axis, ctx.auctionWindowMask, p.t)) continue;
    best = p;
  }
  return best;
}

export function projectBrokerLateEntryMarkers(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: BrokerLateEntryMarkerContext,
): BrokerLateEntryMarkerPoint[] {
  const points = bundle.quote_ratio.points;
  const out: BrokerLateEntryMarkerPoint[] = [];
  for (const event of bundle.broker_late_entries ?? []) {
    if (!sideAllowed(event.side, ctx.sideMode)) continue;
    if (!axis.contains(event.t_ms)) continue;
    const ratioPoint = findDisplayedRatioPoint(points, event, axis, ctx);
    if (!ratioPoint) continue;
    out.push({
      time: (axis.toVirtual(event.t_ms) / 1000) as UTCTimestamp,
      price: displayedRatioValue(ratioPoint, ctx),
      broker: event.broker,
      label: brokerDisplayShort(event.broker),
      side: event.side,
      color: event.side === 'buy' ? ctx.buyColor : ctx.sellColor,
    });
  }
  return out;
}

export type LabelLayoutGroup = {
  markers: BrokerLateEntryMarkerPoint[];
  label: string;
  side: 'buy' | 'sell' | 'mixed';
  color: string;
};

export function layoutBrokerLateEntryLabels(
  markers: readonly BrokerLateEntryMarkerPoint[],
  opts: {
    minHorizontalGapPx: number;
    estimateLabelWidthPx: (label: string) => number;
    forceFull?: boolean;
  },
): { groups: LabelLayoutGroup[] } {
  if (opts.forceFull) {
    return {
      groups: markers.map((m) => ({ markers: [m], label: m.label, side: m.side, color: m.color })),
    };
  }
  const byTime = new Map<Time, BrokerLateEntryMarkerPoint[]>();
  for (const m of markers) byTime.set(m.time, [...(byTime.get(m.time) ?? []), m]);
  const groups: LabelLayoutGroup[] = [];
  for (const cluster of byTime.values()) {
    if (cluster.length <= 1) {
      const m = cluster[0];
      groups.push({ markers: [m], label: m.label, side: m.side, color: m.color });
      continue;
    }
    const totalWidth = cluster.reduce((sum, m) => sum + opts.estimateLabelWidthPx(m.label) + opts.minHorizontalGapPx, 0);
    if (totalWidth <= 120) {
      for (const m of cluster) groups.push({ markers: [m], label: m.label, side: m.side, color: m.color });
      continue;
    }
    const first = cluster.slice().sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label, 'ko-KR'))[0];
    const sides = new Set(cluster.map((m) => m.side));
    groups.push({
      markers: cluster,
      label: `${first.label} +${cluster.length - 1}`,
      side: sides.size === 1 ? first.side : 'mixed',
      color: sides.size === 1 ? first.color : 'var(--fg-dim)',
    });
  }
  return { groups };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd frontend
npm test -- --run src/chart/projectors/brokerLateEntryMarkers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/projectors/brokerLateEntryMarkers.ts frontend/src/chart/projectors/brokerLateEntryMarkers.test.ts
git commit -m "feat: project broker late-entry ratio markers"
```

---

### Task 6: Labelled Marker Primitive And Ratio Integration

**Files:**
- Create: `frontend/src/chart/BrokerLateEntryMarkersPrimitive.ts`
- Modify: `frontend/src/chart/RangeSeriesPane.tsx`
- Modify: `frontend/src/chart/projectors/ratio.ts`
- Test: `frontend/src/chart/RangeSeriesPane.test.tsx`
- Test: `frontend/src/chart/projectors/ratio.test.ts`

**Interfaces:**
- Consumes: `BrokerLateEntryMarkerPoint[]`.
- Produces: `labelMarkers?: (bundle, axis, ctx) => BrokerLateEntryMarkerPoint[]` on `SeriesSpec`.
- Produces: ratio pane labelled marker overlay with adaptive grouping inside primitive draw.

- [ ] **Step 1: Write failing integration tests**

In `frontend/src/chart/projectors/ratio.test.ts`, add a test that imports `RATIO_SPEC`, creates a minimal `RangeBundle` with one `broker_late_entries` item and one `quote_ratio` point, passes a context containing side mode/colors, and asserts:

```ts
const markers = RATIO_SPEC.series[0].labelMarkers?.(bundle, axis, {
  auctionWindowMask: false,
  outlierFilterEnabled: false,
  outlierThreshold: 10,
  intraMax: false,
  brokerLateEntryEnabled: true,
  brokerLateEntrySideMode: 'both',
  brokerLateEntryBuyColor: '#ef4444',
  brokerLateEntrySellColor: '#3b82f6',
});
expect(markers?.[0]).toMatchObject({ broker: '삼성증권', side: 'buy', color: '#ef4444' });
```

In `frontend/src/chart/RangeSeriesPane.test.tsx`, add a lifecycle test following the existing primitive attachment test pattern. Assert that a series spec with `labelMarkers` calls `attachPrimitive` on mount and `detachPrimitive` on unmount.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd frontend
npm test -- --run src/chart/projectors/ratio.test.ts src/chart/RangeSeriesPane.test.tsx
```

Expected: FAIL because `labelMarkers` and primitive do not exist.

- [ ] **Step 3: Implement primitive**

Create `frontend/src/chart/BrokerLateEntryMarkersPrimitive.ts` based on `SurgeMarkersPrimitive.ts`. The implementation should:

```ts
export class BrokerLateEntryMarkersPrimitive implements ISeriesPrimitive<Time> {
  setMarkers(markers: readonly BrokerLateEntryMarkerPoint[]): void;
}
```

Draw rules:

- For each marker, compute `x = chart.timeScale().timeToCoordinate(marker.time)` and `y = series.priceToCoordinate(marker.price)`.
- Draw dot radius `3px` at `(x, y)`.
- Estimate label width with `ctx.measureText(label).width + 10`.
- Use `layoutBrokerLateEntryLabels(...)` to get full/group labels. Pass `forceFull: false`; grouping is recomputed each draw from current coordinates.
- For full labels at same x, stack at `LABEL_OFFSET_Y - i * 14`.
- For grouped labels, use label `삼성 +N`.
- For mixed groups, draw a neutral chip and two tiny side accent dots using buy/sell colors from the group's markers.

Keep the attached/detached/update methods identical in shape to `SurgeMarkersPrimitive`.

- [ ] **Step 4: Extend RangeSeriesPane**

In `frontend/src/chart/RangeSeriesPane.tsx`, import `BrokerLateEntryMarkersPrimitive` and `BrokerLateEntryMarkerPoint`. Add to `SeriesSpec`:

```ts
labelMarkers?: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => BrokerLateEntryMarkerPoint[];
```

Add `labelMarkersRef` parallel to `markersRef`, attach/detach it in the lifecycle effect, and update it in the data effect:

```ts
if (s.labelMarkers) labelMarkersRef.current[i]?.setMarkers(s.labelMarkers(bundle, axis, ctx));
```

- [ ] **Step 5: Extend ratio context and spec**

In `frontend/src/chart/projectors/ratio.ts`, add store fields to `RatioPaneContext`:

```ts
brokerLateEntryEnabled: boolean;
brokerLateEntrySideMode: BrokerLateEntrySideMode;
brokerLateEntryBuyColor: string;
brokerLateEntrySellColor: string;
```

Update `useRatioContext` to read them from `useLivePageStore` or combine stores with a stable selector. If combining with `useActivePrefs`, keep returned object stable with `useShallow`.

Add to the primary ratio series:

```ts
labelMarkers: (bundle, axis, ctx) => (
  ctx.brokerLateEntryEnabled
    ? projectBrokerLateEntryMarkers(bundle, axis, {
        auctionWindowMask: ctx.auctionWindowMask,
        outlierFilterEnabled: ctx.outlierFilterEnabled,
        outlierThreshold: ctx.outlierThreshold,
        intraMax: ctx.intraMax,
        sideMode: ctx.brokerLateEntrySideMode,
        buyColor: ctx.brokerLateEntryBuyColor,
        sellColor: ctx.brokerLateEntrySellColor,
      })
    : []
),
```

- [ ] **Step 6: Run frontend tests and typecheck**

Run:

```bash
cd frontend
npm test -- --run src/chart/projectors/brokerLateEntryMarkers.test.ts src/chart/projectors/ratio.test.ts src/chart/RangeSeriesPane.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/chart/BrokerLateEntryMarkersPrimitive.ts frontend/src/chart/RangeSeriesPane.tsx frontend/src/chart/projectors/ratio.ts frontend/src/chart/RangeSeriesPane.test.tsx frontend/src/chart/projectors/ratio.test.ts
git commit -m "feat: render broker late-entry ratio labels"
```

---

### Task 7: End-To-End Verification And Polish

**Files:**
- Modify only files already listed in Tasks 1-6 if their focused tests expose integration failures.
- Do not add new feature surface in this task.

**Interfaces:**
- Consumes all previous task outputs.
- Produces verified, buildable feature branch.

- [ ] **Step 1: Run backend focused suite**

Run:

```bash
pytest tests/test_tables_brokers.py tests/test_api_brokers_series.py tests/test_api_range.py tests/unit/api/test_bundle_source.py tests/unit/api/test_bundle_source_aware.py -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend focused suite**

Run:

```bash
cd frontend
npm test -- --run \
  src/state/liveIndicatorsPersistence.test.ts \
  src/state/livePage.test.ts \
  src/api/range.test.tsx \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/live/useLiveBundle.test.tsx \
  src/sidebar/BrokerTrajectoryTable.test.tsx \
  src/live/liveSidebarAdapters.test.ts \
  src/chart/projectors/brokerLateEntryMarkers.test.ts \
  src/chart/projectors/ratio.test.ts \
  src/chart/RangeSeriesPane.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Build frontend**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS.

- [ ] **Step 4: Optional local browser smoke**

Run the app the same way this repo normally runs it. If no server is already running, use:

```bash
cd frontend
npm run dev -- --host 127.0.0.1
```

Open `/live`, enable `호가비` and `신규 거래원 등장`, set `930`, switch `둘다/매수만/매도만`, and zoom the ratio pane. Expected: broker labels appear on `호가비`, side filtering changes instantly, zoom-out groups labels, zoom-in restores individual labels.

- [ ] **Step 5: Commit any verification fixes**

If Step 1-4 required fixes:

```bash
git add hoga/tables/brokers.py hoga/api/models.py hoga/api/bundle.py hoga/api/routes.py frontend/src/api/types.ts frontend/src/api/range.ts frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/livePage.ts frontend/src/live/useLiveBundle.ts frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/BrokerLateEntryConfig.tsx frontend/src/sidebar/BrokerTrajectoryTable.tsx frontend/src/live/liveSidebarAdapters.ts frontend/src/chart/projectors/brokerLateEntryMarkers.ts frontend/src/chart/BrokerLateEntryMarkersPrimitive.ts frontend/src/chart/RangeSeriesPane.tsx frontend/src/chart/projectors/ratio.ts
git commit -m "fix: polish broker late-entry marker integration"
```

If no fixes were needed, do not create an empty commit.
