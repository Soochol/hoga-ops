# Parquet Study Views Design

## Problem

The user repeatedly returns to the same historical chart context while studying:
same stock, same candle timeframe, same historical period, and the same zoom and
scroll position. Rebuilding that context by selecting the symbol, timeframe,
date depth, and viewport is repetitive.

This is not a market-data capture feature and not a normal `/live` chart
bookmark. The data already exists in the local hogaplay parquet corpus. The
feature saves and restores a hogaplay-parquet-only study context that opens that
corpus quickly without using KIS past-candle endpoints.

## Goals

- Let the user save the current chart study context with a name.
- Show saved views from the global right rail, below the existing Watchlist and
  Screener entries.
- Restore a saved view in a dedicated `/study` route, not through normal `/live`.
- Persist saved views in the app data directory, so browser cache deletion or a
  different browser does not lose them.
- Avoid KIS fetches, `kis_live` parquet, and live SSE buffers during study-view
  restore. Restore must use a hogaplay-parquet-only chart data path.

## Non-Goals

- No PNG/screenshot capture in the first version.
- No quiz, spaced repetition, or pattern-classification workflow.
- No cross-machine sync beyond backing up the local `data_dir`.
- No attempt to auto-collect or auto-fill missing KIS data when a saved view
  points at a sparse local corpus.
- No same-day live-buffer patching in `/study`; unpromoted today data remains
  visibly absent or partial until it exists in parquet.

## User Experience

The right rail gains a third item:

- `관심`
- `스크리너`
- `저장뷰`

Clicking `저장뷰` opens the same panel slot currently used by Watchlist and
Screener. The panel contains:

- a header, `저장 뷰`;
- a `현재 뷰 저장` action;
- an empty state when no views exist;
- saved view rows showing name, stock label/code, timeframe, and the saved right
  edge timestamp;
- row actions for rename and delete.

Clicking a saved view navigates to `/study` and replaces the current study chart
context with that view. The `/live` tab bar does not accumulate study bookmarks
as extra tabs. This keeps "working tabs" and "saved study views" separate.

The saved view panel remains a global right-rail panel, but restore semantics are
defined in terms of the `/study` route. Normal `/live` remains the live/KIS-aware
workspace; `/study` is the reproducible parquet-only workspace.

Saving is allowed from `/live` and `/study`. When saving from `/live`, the UI
must warn that normal live charts may include KIS past-candles or live buffers,
while the saved study view will reopen through hogaplay-parquet-only `/study`;
therefore unpromoted, KIS-only, or `kis_live`-source parts can look different
after restore. User-facing copy should be short: "저장 학습뷰는 hogaplay 보관
데이터만 사용합니다."

## Data Model

Server wire shape:

```ts
type ParquetStudyView = {
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  from_date: string;
  to_date: string;
  viewport: {
    right_edge_ms: number;
    bar_span: number;
    at_live_edge: boolean;
  };
  indicator_state: {
    volume_enabled: boolean;
    quote_totals_enabled: boolean;
    ratio_enabled: boolean;
    fill_strength_enabled: boolean;
    aggregation_basis: "close" | "intra_period_max";
  };
  memo: string;
  tags: string[];
  created_at_ms: number;
  updated_at_ms: number;
};
```

Write request shape:

```ts
type ParquetStudyViewWriteRequest = {
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  from_date: string;
  to_date: string;
  viewport: ParquetStudyView["viewport"];
  indicator_state: ParquetStudyView["indicator_state"];
  memo?: string;
  tags?: string[];
};
```

Validation:

- `name` is required, trimmed, and rejects whitespace-only values.
- `code` must match the existing stock code pattern.
- `timeframe` must be one of the existing live timeframes.
- `from_date` and `to_date` are required `YYYYMMDD` dates with
  `from_date <= to_date`.
- `viewport.right_edge_ms` must be finite.
- `viewport.bar_span` must be finite and positive.
- `indicator_state` captures analysis state, not visual style.
- `memo` defaults to an empty string.
- `tags` defaults to an empty list.

## Persistence

Parquet Study Views are file-backed, not `localStorage`-backed.

Path:

```text
data_dir/study_views/saves.json
```

File shape:

```json
{
  "schema_version": 1,
  "saves": []
}
```

The implementation mirrors `hoga/api/screener_saves.py`:

- missing file returns an empty file model;
- invalid JSON, invalid shape, future schema version, or model validation errors
  quarantine the bad file as `saves.json.corrupt-<stamp>-<reason>` and return an
  empty model;
- writes use `atomic_write_json`;
- write `OSError` propagates instead of being swallowed;
- async CRUD mutations share a module-level lock.

This makes study views durable with the local data directory and consistent with
saved screener behavior.

## API

Add a study-view saves router:

- `GET /api/study-views/saves` returns the full file model
  `{ schema_version, saves }`.
- `POST /api/study-views/saves` creates a save and returns the saved object.
- `GET /api/study-views/saves/{save_id}` returns one save.
- `PUT /api/study-views/saves/{save_id}` replaces the editable fields and
  preserves `created_at_ms`.
- `DELETE /api/study-views/saves/{save_id}` deletes one save.

Missing IDs return a structured 404 equivalent to the saved screener
`save_not_found` pattern, using a study-view-specific error code.

No study-specific range endpoint is added in the first version. `/study` reads
chart data through the existing parquet-backed `GET /api/range` endpoint with
`source_pref=hogaplay` and does not call the KIS-backed live past-candle
endpoints.

For minute timeframes, `/study` calls `/api/range` with the requested minute
`bucket_ms`. For calendar timeframes (`D`, `W`, `M`), `/study` calls
`/api/range` with `bucket_ms=60000` and client-aggregates the returned parquet
1-minute candles with the existing calendar aggregation logic. Calendar study
views still render through the shared chart surface. Unlike normal `/live`,
calendar study views must also show the hoga indicator panes; the indicator
series need calendar aggregation semantics for `D`, `W`, and `M`.

Calendar indicator aggregation supports both study modes:

- close representative: the last 1-minute value inside the D/W/M bucket;
- intra-period max: the bucket-internal extreme basis for hoga indicators,
  aligned with the existing "분봉 내 최댓값 기준" preference where applicable.

The first implementation should reuse the existing indicator preference language
instead of inventing a separate study-only setting.

Saved study views persist indicator analysis state: pane visibility and the
calendar aggregation basis. Visual styling such as colors and line widths stays
global and is not snapshotted into the saved view.

## Frontend Integration

Add `frontend/src/api/studyViews.ts` with the same shape as
`savedScreeners.ts`.

Add React Query hooks:

- `useStudyViews`
- `useStudyViewMutations`

Successful create/update/delete invalidates the `['study-view-saves']` query.

`rightRail` state extends `RailPanel` from:

```ts
type RailPanel = 'watchlist' | 'screener';
```

to:

```ts
type RailPanel = 'watchlist' | 'screener' | 'savedViews';
```

The right rail renders a third item under Screener. `App.tsx` renders
`StudyViewsDrawer` when `activePanel === 'savedViews'`, and the app registers a
separate `/study` route for the parquet-only chart workspace.

The `/study` route must not use `useLiveBundle`. It uses a small study bundle
hook built on `useRange(code, from, to, rangeTimeframe)` and passes the returned
or calendar-aggregated `RangeBundle` to the shared chart rendering surface. This
is the main code-level guardrail that keeps KIS and live SSE paths out of study
views.

## Saving Flow

The save action reads the current chart state:

- active code and label;
- `candleTimeframe`;
- explicit loaded `from_date` and `to_date` for the chart data range;
- the current `TabViewport`.
- indicator analysis state: visible panes and aggregation basis.

The viewport is captured through the existing live chart viewport capture path
rather than reconstructing chart internals in the drawer. If no active code or
no viewport is available, the save action is disabled and explains that a chart
must be visible first.

`from_date` and `to_date` store the loaded data range, not just the visible
viewport. The data range rebuilds the chart and indicator context; the saved
viewport restores the exact zoom/scroll position inside that range.

When the save action runs from `/live`, it still writes a Parquet Study View, not
a live chart bookmark. The write request should include enough range state to
open `/study`; it must not imply that KIS-backed candles are persisted.
For `/live`, `from_date` is the current loaded historical start date (the active
tab's `historicalFromDate` or the initial seeded range), and `to_date` is the
current KST today. The save action does not preflight parquet availability or
shrink the range to existing local data.

Default name suggestion is simple and deterministic:

```text
삼성전자 5분봉 2026.05.20
```

The first version exposes `name` and `memo` editing. `tags` remain in the file
model for future classification, but no tag UI or filtering ships in this
version.

## Restore Flow

Restoring a saved view replaces the current study chart context:

1. Navigate to `/study`.
2. Store the active study context fields from the saved view: `code`, `label`,
   `timeframe`, `from_date`, `to_date`, and `viewport`.
3. Render the chart through a parquet-only study data path, then let
   `LiveChartRoot` receive the saved `restoreViewport` prop and apply the
   existing viewport restore logic.

No KIS past-candle path, `kis_live` parquet source, live SSE stream, or
today-live buffer is enabled during study-view restore. If the local hogaplay
parquet corpus cannot satisfy the restored period, the study view shows the
missing or partial local data state rather than filling the gap from KIS,
`kis_live`, or memory.

After restore, `/study` may extend its local parquet range when the user pans
left. That exploration changes only the current study session state. The saved
Parquet Study View is not mutated unless the user explicitly saves changes or
overwrites the view.

## Error Handling

- Study views query failure shows a compact error state in the drawer with a
  retry action.
- Create/update/delete mutation failures surface inline and do not optimistically
  remove existing rows.
- Corrupt `saves.json` is quarantined server-side and the UI sees an empty list.
- A saved view with a viewport that no longer maps onto the rebuilt chart axis
  falls back to the existing default chart viewport behavior.
- If a saved view points at today before promotion has written parquet, `/study`
  shows the promoted portion only and labels the missing tail as local data not
  yet available.

## Testing

Backend:

- model round-trip and validation for `ParquetStudyView`,
  `ParquetStudyViewWriteRequest`, and file model;
- file persistence missing-file, corrupt JSON, bad shape, future version,
  schema-validation quarantine;
- `OSError` propagation on write;
- CRUD route happy path;
- route 404 behavior for missing IDs.

Frontend:

- `rightRail` accepts and persists `savedViews`, and rejects malformed panel
  values;
- `RightRail` renders the third item and toggles the saved-view panel;
- `StudyViewsDrawer` renders loading, empty, error, and list states;
- save action is disabled without active chart viewport;
- saving from `/live` shows the parquet-only restore warning;
- create/delete invalidate the query;
- clicking a saved view navigates to `/study` and replaces the active study
  context rather than creating a `/live` tab;
- restore uses the parquet-only study data path and passes the saved viewport
  through to `LiveChartRoot` via the existing restore prop path;
- restore never starts `useLiveBundle`, `useLiveSeries`, `useLivePastCandles`,
  or `useLivePastDailyCandles`;
- `/study` fetches chart data through `useRange` only, always with
  `source_pref=hogaplay`;
- D/W/M study views fetch 1-minute parquet via `/api/range` and aggregate
  calendar candles client-side; they do not call `/api/live/past-daily-candles`;
- D/W/M study views keep the hoga indicator panes visible and aggregate their
  parquet-backed series into the calendar timeframe;
- extending the `/study` range does not mutate the saved view until explicit
  overwrite.

## UI Details

The right-rail item uses a small app-local bookmark icon consistent with
`HeartIcon` and `FunnelIcon` unless the project already has an equivalent icon at
implementation time. Rows use compact text only: no thumbnails in the first
version.
