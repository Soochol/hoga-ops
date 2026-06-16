# Saved Chart Views Design

## Problem

The user repeatedly returns to the same historical chart context while studying:
same stock, same candle timeframe, same historical period, and the same zoom and
scroll position. Rebuilding that context by selecting the symbol, timeframe,
date depth, and viewport is repetitive.

This is not a market-data capture feature. The data already exists in the local
parquet corpus. The feature saves and restores the chart view state that opens
that corpus quickly.

## Goals

- Let the user save the current `/live` chart view with a name.
- Show saved views from the global right rail, below the existing Watchlist and
  Screener entries.
- Restore a saved view by replacing the current live tab, not by opening a new
  tab.
- Persist saved views in the app data directory, so browser cache deletion or a
  different browser does not lose them.
- Avoid adding any new KIS fetch path. Restore uses the existing `/live` local
  parquet-backed data flow.

## Non-Goals

- No PNG/screenshot capture in the first version.
- No quiz, spaced repetition, or pattern-classification workflow.
- No cross-machine sync beyond backing up the local `data_dir`.
- No attempt to auto-collect missing KIS data when a saved view points at a
  sparse local corpus.

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

Clicking a saved view replaces the current live tab with that view. The tab bar
does not accumulate study bookmarks as extra tabs. This keeps "working tabs" and
"saved study views" separate.

If the user is not on `/live`, clicking a saved view navigates to `/live` and
then applies the view to the active tab. The saved view panel itself can remain a
global right-rail panel, but restore semantics are defined in terms of the live
page state.

## Data Model

Server wire shape:

```ts
type SavedChartView = {
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  historical_from_date: string | null;
  viewport: {
    right_edge_ms: number;
    bar_span: number;
    at_live_edge: boolean;
  };
  memo: string;
  tags: string[];
  created_at_ms: number;
  updated_at_ms: number;
};
```

Write request shape:

```ts
type ChartViewSaveWriteRequest = {
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  historical_from_date: string | null;
  viewport: SavedChartView["viewport"];
  memo?: string;
  tags?: string[];
};
```

Validation:

- `name` is required, trimmed, and rejects whitespace-only values.
- `code` must match the existing stock code pattern.
- `timeframe` must be one of the existing live timeframes.
- `viewport.right_edge_ms` must be finite.
- `viewport.bar_span` must be finite and positive.
- `memo` defaults to an empty string.
- `tags` defaults to an empty list.

## Persistence

Saved chart views are file-backed, not `localStorage`-backed.

Path:

```text
data_dir/chart_views/saves.json
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

This makes saved views durable with the local data directory and consistent with
saved screener behavior.

## API

Add a chart-view saves router:

- `GET /api/chart-views/saves` returns the full file model
  `{ schema_version, saves }`.
- `POST /api/chart-views/saves` creates a save and returns the saved object.
- `GET /api/chart-views/saves/{save_id}` returns one save.
- `PUT /api/chart-views/saves/{save_id}` replaces the editable fields and
  preserves `created_at_ms`.
- `DELETE /api/chart-views/saves/{save_id}` deletes one save.

Missing IDs return a structured 404 equivalent to the saved screener
`save_not_found` pattern, using a chart-view-specific error code.

## Frontend Integration

Add `frontend/src/api/savedChartViews.ts` with the same shape as
`savedScreeners.ts`.

Add React Query hooks:

- `useSavedChartViews`
- `useSavedChartViewMutations`

Successful create/update/delete invalidates the `['chart-view-saves']` query.

`rightRail` state extends `RailPanel` from:

```ts
type RailPanel = 'watchlist' | 'screener';
```

to:

```ts
type RailPanel = 'watchlist' | 'screener' | 'savedViews';
```

The right rail renders a third item under Screener. `App.tsx` renders
`SavedChartViewsDrawer` when `activePanel === 'savedViews'`.

## Saving Flow

The save action reads the current live page state:

- active code and label;
- `candleTimeframe`;
- `historicalFromDate`;
- the current `TabViewport`.

The viewport is captured through the existing live chart viewport capture path
rather than reconstructing chart internals in the drawer. If no active code or
no viewport is available, the save action is disabled and explains that a chart
must be visible first.

Default name suggestion is simple and deterministic:

```text
삼성전자 5분봉 2026.05.20
```

The first version exposes `name` and `memo` editing. `tags` remain in the file
model for future classification, but no tag UI or filtering ships in this
version.

## Restore Flow

Restoring a saved view replaces the current live tab:

1. If not already on `/live`, navigate to `/live`.
2. Ensure a live tab exists. If none exists, create one.
3. Replace the active tab fields with the saved view's `code`, `label`,
   `timeframe`, `historicalFromDate`, and `viewport`.
4. Project the active tab to `useLivePageStore` with the existing atomic
   `projectActiveView` path.
5. Let `LiveChartRoot` receive the saved `restoreViewport` prop and apply the
   existing viewport restore logic.

No new KIS data path is introduced. If the local parquet corpus cannot satisfy
the restored period, the current `/live` partial-data behavior remains
authoritative.

## Error Handling

- Saved views query failure shows a compact error state in the drawer with a
  retry action.
- Create/update/delete mutation failures surface inline and do not optimistically
  remove existing rows.
- Corrupt `saves.json` is quarantined server-side and the UI sees an empty list.
- A saved view with a viewport that no longer maps onto the rebuilt chart axis
  falls back to the existing default chart viewport behavior.

## Testing

Backend:

- model round-trip and validation for `SavedChartView`,
  `ChartViewSaveWriteRequest`, and file model;
- file persistence missing-file, corrupt JSON, bad shape, future version,
  schema-validation quarantine;
- `OSError` propagation on write;
- CRUD route happy path;
- route 404 behavior for missing IDs.

Frontend:

- `rightRail` accepts and persists `savedViews`, and rejects malformed panel
  values;
- `RightRail` renders the third item and toggles the saved-view panel;
- `SavedChartViewsDrawer` renders loading, empty, error, and list states;
- save action is disabled without active chart viewport;
- create/delete invalidate the query;
- clicking a saved view replaces the active live tab rather than creating a new
  one;
- restore passes the saved viewport through to `LiveChartRoot` via the existing
  restore prop path.

## UI Details

The right-rail item uses a small app-local bookmark icon consistent with
`HeartIcon` and `FunnelIcon` unless the project already has an equivalent icon at
implementation time. Rows use compact text only: no thumbnails in the first
version.
