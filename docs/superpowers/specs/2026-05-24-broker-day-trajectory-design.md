# Replay Sidebar — 거래원 당일 추이 (Broker Day-Trajectory Sparklines)

**Date**: 2026-05-24
**Status**: Approved
**Scope**: `hoga/api/routes.py`, `hoga/api/models.py`, `hoga/tables/brokers.py`, `frontend/src/api/types.ts`, `frontend/src/api/useCursor.ts`, `frontend/src/sidebar/BrokerNetTable.tsx`, `frontend/src/sidebar/CursorSidebar.tsx`

## Problem

The Replay Viewer's 거래원 sidebar card currently renders only the top-10 net brokers at the cursor's exact moment (`BrokerNetTable` consuming `useBrokersAtCursor`, which calls `GET /api/brokers?t=`). As the user moves the cursor along the chart, the list mutates — brokers appear and disappear depending on whether they happen to be in the snapshot's top-5 buy or top-5 sell at that instant.

The user wants a different reading: **stable broker identity over the trading day**, with each broker's day-long net trajectory visible alongside the cursor-moment net. The current snapshot-mutating view makes it impossible to track "JP모간's accumulation across the session" because the row vanishes the moment JP모간 drops below rank 5.

A secondary constraint shapes the design: the brokers parquet stores only top-5 buy + top-5 sell at each snapshot, so any broker that drops out of both top-5 lists mid-day has a true data gap, not a zero. The redesign must surface this honestly rather than fabricate continuity.

## Goals

- Keep the broker list **stable** across the whole Stock-Date — identity comes from full-day aggregate, not from the cursor moment.
- Show each broker's **cumulative net trajectory** for the day as an inline sparkline in the broker row.
- Keep the **per-cursor net number** the user already relies on, but redefine it as "this broker's cumulative net up to `cursorMs`" instead of "this broker's snapshot rank at `cursorMs`".
- Surface the top-5 truncation gap honestly: solid line for observed segments, dashed/dim for unobserved spans.
- Stay within the existing 320px sidebar; broker card grows modestly to absorb the added row height.
- Do not regress the 10호가 or 체결 cards.

## Non-Goals

- A user toggle between "day-anchored" (new behavior) and "cursor-anchored" (current behavior). Day-anchored becomes the only mode.
- Cross-day trajectories on multi-day Stock-Date Ranges. The sparkline always reflects the day the cursor is currently in; crossing day boundaries swaps the entire series.
- Broker rank tracking (e.g., "this broker was #2 buyer between 10:00 and 11:30"). Sparkline encodes `qty_today`, not rank.
- Pinning, filtering, or hiding individual broker rows.
- Removing the existing `GET /api/brokers?t=` endpoint. If no other consumer remains after the migration, removal is left to a follow-up.

## Design

### § 1. Data shape and backend endpoint

A new endpoint **`GET /api/brokers/series?code=&date=`** returns the entire day's broker observations in long-to-wide form, keyed by broker name.

**Wire schema** (mirrored in `frontend/src/api/types.ts` per ADR-0004):

```python
# hoga/api/models.py — to add
class BrokerSeriesPoint(BaseModel):
    ts_ms: int        # Unix epoch ms (already converted by route layer)
    qty_today: int    # cumulative through this snapshot

class BrokerSeriesEntry(BaseModel):
    broker: str
    side: Literal["buy", "sell"]   # side of this broker's last observation (effectively single-sided per day)
    final_net: int                  # signed: +qty_today if buy, -qty_today if sell, at last observation
    points: list[BrokerSeriesPoint] # ts_ms ascending; only snapshots where broker was in top-5

class BrokerSeriesResponse(BaseModel):
    date: str          # YYYYMMDD KST, echoed
    brokers: list[BrokerSeriesEntry]   # sorted by abs(final_net) desc, then final_net desc
```

**Backend implementation** (`hoga/tables/brokers.py`):

```python
def query_day_series(con: duckdb.DuckDBPyConnection, *, path: Path) -> list[BrokerSeriesEntry]:
    """One DuckDB query producing per-broker series for the whole parquet file.
    Returns entries sorted by abs(final_net) desc, final_net desc."""
```

The query strategy: select `broker, side, ts_ms, qty_today` ordered by `(broker, ts_ms)`, group in Python into entries. For each broker, `side` is the side of its last observation (in practice a broker is one-sided across a day — the data confirms this); `final_net` is `qty_today` of the last observation, signed by that side.

**Route handler** (`hoga/api/routes.py`):

```python
@router.get("/brokers/series", response_model=BrokerSeriesResponse)
def brokers_series(code: Code, date: StockDate) -> BrokerSeriesResponse:
    try:
        path = engine.parquet_dir(date, code) / "brokers.parquet"
    except StockDateNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    raw_entries = brokers_tbl.query_day_series(engine.conn, path=path)
    # Convert each point's ts_ms from HH:MM:SS.ms-encoded to Unix ms, matching
    # the /api/brokers and /api/candles handlers (see hhmmssms_to_unix_ms).
    entries = [
        e.model_copy(update={
            "points": [
                p.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, p.ts_ms)})
                for p in e.points
            ],
        })
        for e in raw_entries
    ]
    return BrokerSeriesResponse(date=date, brokers=entries)
```

Empty days return `BrokerSeriesResponse(date=..., brokers=[])`; no special envelope.

### § 2. Frontend data access

A new hook **`useBrokerSeriesForDay()`** is added to `frontend/src/api/useCursor.ts`:

```ts
export function useBrokerSeriesForDay(): BrokerSeriesEntry[] | null | undefined {
  const { tabId, code, date } = useCursor();
  const key = code && date ? `${tabId}|brs|${code}|${date}` : null;
  const { data } = useSpot(key, () =>
    apiGet<BrokerSeriesResponse>(
      `/api/brokers/series?code=${code}&date=${date}`,
    ).then((r) => r.brokers),
  );
  return data;   // undefined = loading, null = empty/no-data, T = data
}
```

Cache key intentionally omits `cursorMs` — the series is day-scoped, so moving the cursor within a day reuses the cached response. Crossing day boundaries (which `useCursor` already exposes via the derived `date` field) swaps the cache entry naturally.

The existing `useBrokersAtCursor()` becomes unused by the sidebar after this change and may be deleted (left in place by this spec since no other caller has been audited; cleanup belongs to a follow-up).

### § 3. Broker list synthesis

The displayed list is **top 10 by `abs(final_net)`** from the response, in the order the response already provides. The list identity is therefore stable for the duration of one Stock-Date — moving the cursor does not change which 10 brokers appear, only the right-column net value and the position of the cursor marker inside each sparkline.

**Per-row cursor-moment net** is derived client-side from the series:

```ts
function netAtCursor(entry: BrokerSeriesEntry, cursorMs: number | null): number {
  if (cursorMs == null) return 0;
  // Binary-search points for the last ts_ms <= cursorMs.
  // Returns 0 if the broker has not appeared yet by cursorMs (dim styling).
  // Otherwise returns qty_today signed by entry.side.
}
```

This intentionally differs from the current `computeNet` ([BrokerNetTable.tsx:48-58](frontend/src/sidebar/BrokerNetTable.tsx#L48-L58)), which summed across all entries in a single snapshot. The new computation is per-broker, per-cursor — no cross-broker aggregation.

### § 4. Sparkline rendering

Each broker row uses a CSS grid `grid-cols-[60px_1fr_80px]` for `[name | sparkline | net]`. The sparkline cell is rendered as an inline SVG, ~60px wide × 16px tall, with the broker's `side` color from `DESIGN.md`:

- side `buy` → `--price-up` (`#DC2626`)
- side `sell` → `--price-down` (`#2563EB`)

**Y-axis**: per-row independent, `[0, max(qty_today across points)]`. This is essential — absolute volumes differ ~100× between top-volume brokers (KB증권 type) and mid-pack brokers, so a shared Y axis collapses smaller brokers to a flat line. The sparkline communicates **trajectory shape**; the right-column number carries magnitude.

**Time axis**: `[ts_first_observation_of_day, ts_last_observation_of_day]` across **all** brokers in the response — common time domain so every broker's cursor marker aligns at the same screen X. (Per-broker time domains would let cursor markers desync visually.)

**Data gaps** (top-5 truncation): if two consecutive points in `entry.points` are separated by more than one "expected" snapshot interval, the segment between them is drawn as a **dashed, dim** line:

```ts
const GAP_THRESHOLD_MS = 30_000;  // generous — broker snapshots are sub-second on active stocks
// for each consecutive pair (p[i], p[i+1]):
//   solid if p[i+1].ts_ms - p[i].ts_ms <= GAP_THRESHOLD_MS
//   dashed (stroke-dasharray="1.5,1.5", opacity=0.4) otherwise
```

A dashed segment connects directly from `(p[i].ts_ms, p[i].qty_today)` to `(p[i+1].ts_ms, p[i+1].qty_today)` — same straight-line interpolation as a solid segment, but visually marked as estimated. No special endpoint markers (circles, ticks) — the dash pattern carries the signal.

**Cursor marker**: a vertical `--accent` (`#14B8A6`) 0.6px line with `stroke-dasharray="1,1"`, positioned at `(cursorMs - tsFirst) / (tsLast - tsFirst) * width`. If `cursorMs` is outside `[tsFirst, tsLast]` (e.g., pre-market or post-close), the marker is hidden.

No zero baseline is drawn — sparklines are always non-negative monotone-ish (cumulative `qty_today`) so a zero line carries no information.

### § 5. Component changes

**`frontend/src/sidebar/BrokerNetTable.tsx`** is renamed and rewritten as **`BrokerTrajectoryTable.tsx`**.

```tsx
type Props = {
  series: BrokerSeriesEntry[] | null | undefined;
  cursorMs: number | null;
};

export default function BrokerTrajectoryTable({ series, cursorMs }: Props) {
  // Loading / empty states reuse the existing text:
  //   undefined → "커서 위치 로딩 중…"
  //   null or [] → "거래원 정보 없음"
  // Otherwise render top 10 with <BrokerRow entry={...} cursorMs={...} />.
}

function Sparkline({ entry, cursorMs }: { entry: BrokerSeriesEntry; cursorMs: number | null }) {
  // Pure SVG; no external chart lib. ~40 lines.
}
```

The file remains a sidebar-local concern; no new directory.

**`frontend/src/sidebar/CursorSidebar.tsx`** — `CursorSidebarConnected` swaps `useBrokersAtCursor()` for `useBrokerSeriesForDay()` + `useCursor()`:

```tsx
const series = useBrokerSeriesForDay();
const cursorMs = useCursor().cursorMs;
// ...
brokers={<BrokerTrajectoryTable series={series} cursorMs={cursorMs} />}
```

### § 6. Sidebar grid

`CursorSidebar`'s aside changes from `grid-rows-[2fr_1fr_1fr]` to `grid-rows-[2fr_1.4fr_1fr]`. The 10호가 card keeps its 2fr share; 거래원 grows ~40% to host 10 rows comfortably with the added sparkline vertical breathing room; 체결 compresses proportionally but retains the "체결 흐름" reading the card label promises (the fill tape stays scrollable). Final ratio may be nudged after a visual pass; the only invariant is "거래원 must fit 10 rows without internal scrolling at default density".

No changes to `--sidebar-w` or the outer Workarea grid.

## Testing

- **Backend unit (`tests/api/test_routes_brokers_series.py`)**: hits `/api/brokers/series` against a fixture parquet with three brokers — one that stays in top-5 all day (continuous points), one that drops out mid-day and returns (gap in points list), one that appears only late in the session. Asserts ordering by `abs(final_net)`, correct `side` derivation, and that `points` only contains observed snapshots (no synthetic forward-fill).
- **Backend unit (`tests/tables/test_brokers_query_day_series.py`)**: the pure DuckDB-level query against a hand-built parquet, independent of FastAPI.
- **Frontend hook (`frontend/src/api/useBrokerSeriesForDay.test.tsx`)**: cache-key isolation per `(tabId, code, date)`; verify cursor changes within a day do not trigger refetch.
- **Frontend component (`frontend/src/sidebar/BrokerTrajectoryTable.test.tsx`)**:
  - Loading / empty / populated render states.
  - `netAtCursor` returns 0 (dim) when cursor precedes broker's first observation; returns signed `qty_today` of the last point ≤ cursor otherwise.
  - Sparkline emits at least one `<polyline>` with `stroke-dasharray` set when a gap exceeds `GAP_THRESHOLD_MS`.
  - Sparkline cursor line is rendered only when `cursorMs` lies within `[tsFirst, tsLast]`.
- **Visual (`browse` skill)**: open `/replay`, load a multi-day populated symbol, sweep the cursor across the day, screenshot before/after the swap. Confirm row identity stays stable, sparklines visibly update only their cursor marker, and dashed segments appear on the right brokers.

## Risks

- **`useBrokersAtCursor` removal not enforced**: if a future consumer reintroduces the cursor-snapshot endpoint expectation, the two paradigms could coexist confusingly. Mitigation is a code-search audit before deleting the hook; left to a follow-up since this spec focuses on the new view.
- **Gap-rendering false signal on illiquid stocks**: on names with low broker turnover, nearly every segment may be dashed, making the sparkline visually noisy. Acceptable for v1 — the signal is honest. A potential follow-up: tune `GAP_THRESHOLD_MS` per-symbol or render gaps only when they exceed N% of the day's range.
- **DuckDB query cost on long sessions**: a full-day broker series across all 10 brokers × ~thousands of snapshots is still tens of thousands of rows — well within DuckDB's wheelhouse for a single parquet scan, but worth profiling on the largest historical day. If hot enough to matter, add a `LIMIT` clause keyed to the top-10-by-final-net brokers via a subquery.
- **`computeNet` deletion breaks tests**: the existing `BrokerNetTable.test.tsx` (if any) covers the per-snapshot aggregation. Those tests are removed alongside the rename; new tests cover the new semantics.

## Out of Scope (Backlog)

- A toggle restoring the old cursor-anchored broker list (mode switch).
- Trajectory tooltips (hover a sparkline point to read exact ts_ms + qty_today).
- Rank-trajectory mode (sparkline plots rank 1-5 over time instead of qty_today).
- Multi-day overlay (e.g., five-day sparkline strips across a Stock-Date Range).
- Removing the legacy `/api/brokers?t=` endpoint and `useBrokersAtCursor` hook after consumer audit.
- Per-symbol `GAP_THRESHOLD_MS` tuning.
