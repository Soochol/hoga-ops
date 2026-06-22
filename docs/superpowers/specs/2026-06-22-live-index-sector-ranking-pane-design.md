# /live Index Sector Ranking Pane Design

**Date:** 2026-06-22  
**Status:** approved for implementation planning  
**Scope:** `/live` index instruments only

## Context

`/live` now supports index instruments such as KOSPI and KOSDAQ. Index charts do not use the stock-only hoga panes, so the lower chart area has room for a market-context view. The heatmap is an independent store (`/api/heatmap`, ADR-0068) and already groups stocks into user-owned sector folders with current quote percentages.

The feature should answer this workflow:

> While reviewing an index candle, show which heatmap sectors led that date and which stocks led inside the selected sector.

## Decision

Add an index-only lower split pane to `/live`.

When the active instrument is an index, the chart workarea shows a **Sector Ranking Pane** below the index candle/volume chart. It is hidden for stock instruments. The pane has two columns:

- Left: heatmap sector ranking, sorted by average change percentage descending.
- Right: stock ranking for the active sector, sorted by change percentage descending.

The pane follows the chart cursor by default, but users can pin both the date and the sector.

## UX Behavior

### Date Source

- Hovering an index candle sets a temporary basis date.
- Clicking an index candle pins that basis date.
- While a date is pinned, hovering other candles does not change the sector or stock rankings.
- Clicking the pinned candle again, pressing `Esc`, or using a small unpin control clears the date pin.
- If no candle is hovered or pinned, the pane uses the latest available date.
- When the pointer moves from the chart into the sector pane, the last valid basis date remains stable so the pane does not flicker while the user moves down to inspect it.

The pane header displays the current basis, for example:

`2026/06/19 기준 · 날짜 고정`

or:

`2026/06/19 기준 · hover`

### Sector Selection

- For a new basis date, the default active sector is the rank 1 sector.
- Hovering a sector row previews that sector's stock ranking on the right.
- Clicking a sector row pins that sector selection.
- Clicking the pinned sector row again clears the sector pin.
- When sector hover ends, the right column returns to the pinned sector. If no sector is pinned, it returns to the rank 1 sector.
- If a pinned sector exists on the next basis date, keep the same sector selected. If that sector has no data, fall back to rank 1.

The active sector row uses the UI accent as selection state, not price color. Sector and stock change values use KRX price colors.

### Stock Ranking

- Stock ranking is descending by `change_pct`.
- No secondary sort control is needed for MVP.
- Stocks with missing `change_pct` appear at the bottom.
- Clicking a stock opens that stock in `/live` using the existing live tab activation behavior.

## Layout

The pane is part of the chart workarea, not the existing right sidebar. It should be implemented as a DOM sibling below the index chart region inside the `/live` workarea, not as a Lightweight Charts pane or `RangeSeriesPane` indicator. This keeps chart-pane lifecycle and the index market-context UI separate.

Recommended proportions:

- Candle/volume chart remains the primary visual region.
- Sector pane height is fixed or stretch-limited so it does not collapse the chart, roughly 180-240px at default density.
- Left column uses about one third of the pane width.
- Right column uses the remaining width and can render stock rows in one or two columns depending on available width.

The lower pane must not depend on the existing right sidebar. Any current index-sidebar behavior can be left unchanged during the first implementation pass. For stock instruments, the current `/live` layout remains unchanged.

## Data Model

The pane requires a date-keyed heatmap daily-change view:

- `HeatmapResponse`: folders and entries from `/api/heatmap`.
- Per-stock daily change data for the selected basis date.
- Derived sector groups from heatmap folders.
- Sector average = average of finite stock `change_pct` values in that folder.
- Stock ranking = folder entries sorted by finite `change_pct` descending, missing values last.

MVP universe is the **current heatmap entries**, not the full market. Historical ranking is interpreted as "how the currently configured heatmap sectors performed on this date." If the user later adds, removes, or moves heatmap entries:

- Added stocks participate in past-date rankings after their date-keyed daily data exists in the corpus.
- Removed stocks disappear from the pane because the pane follows the current heatmap list.
- Moved stocks are recalculated under their current folder on the next render.
- The feature does not attempt to reconstruct the heatmap membership that existed on the historical date.

The implementation should not couple heatmap edits to watchlist or live subscription side effects. ADR-0068 remains intact.

Historical basis dates must not silently use latest live quotes. Historical rankings should be computed from the existing Screener EOD daily corpus (`daily_adjusted.parquet`) by comparing the selected date's adjusted close with each code's previous available adjusted close. If no honest date-aware daily source is available in the first implementation pass, the pane should be disabled for historical dates with an explicit "daily ranking unavailable" state rather than showing latest data under a past-date label.

Latest quotes are valid only when the basis is the latest available trading date. During the current session, `/api/live/quotes` may be used for the latest-date current view; once the user pins or hovers a past date, the pane must switch to date-keyed daily data.

## Data Source Strategy

Preferred backend shape:

- Add one server-side ranking endpoint for the pane, for example `GET /api/live/index-sector-rankings?date=YYYYMMDD`.
- The endpoint reads current heatmap folders and entries, then joins those codes against the Screener daily adjusted corpus for the requested date and each code's previous trading close.
- The endpoint returns sector rankings, stock rankings, missing-data markers, and source metadata such as `source: "daily_adjusted"` or `source: "latest_live_quote"`.
- The frontend should not issue one `/api/live/past-daily-candles` request per heatmap code on hover.
- Hover should refetch only when the resolved KST basis date changes, not on every pointer movement.

Fallbacks:

- If the Screener corpus is not seeded, historical dates show a corpus-unavailable state. The implementation should not perform a large KIS fanout from the interactive hover path.
- Added heatmap codes can show missing values until their daily corpus rows exist.
- If latest-date live quotes are unavailable, the latest-date pane can fall back to daily adjusted data for the most recent completed trading day.

## Timeframe Policy

The pane's ranking metric is daily `change_pct`, not bar-over-bar candle tooltip math.

- Enable for index `D` and minute LiveTimeframes. Basis = the candle's KST trading date.
- For minute candles, multiple candles from the same trading date resolve to the same ranking data.
- For `W` and `M`, hide or disable the pane in MVP unless period-return ranking is intentionally added. Showing a single daily ranking under a weekly/monthly candle would be misleading.

## Components

Suggested frontend units:

- `IndexSectorRankingPane`: renders the lower split pane and owns hover/selection presentation.
- `useIndexSectorRanking`: consumes server ranking data and resolves active sector or stock list presentation.
- `useIndexSectorCursorBasis`: owns temporary hover basis, pinned date, and pane-entry stability.
- `SectorRankingList`: left column; supports hover preview, click pin, click-again unpin.
- `SectorStockRankingList`: right column; opens stock live tabs on click.

`LiveWorkarea` should gate this feature by instrument capability or active instrument kind. `LiveChartRoot` may need to expose candle hover/click basis events for index charts without overloading `CandleTooltip`.

## Data Flow

1. `LivePage` knows the active instrument and index bundle.
2. `LiveChartRoot` publishes index candle hover and click events as real `ts_ms` or KST date.
3. `LiveWorkarea` or a child state hook resolves the current basis date:
   - pinned date wins;
   - otherwise last valid hover date;
   - otherwise latest available date.
4. `IndexSectorRankingPane` fetches ranking data for the basis date from the server-side ranking endpoint.
5. It resolves the active sector from rank 1, hover preview, or sector pin.
6. It renders stock rankings for the active or previewed sector.

## Error And Empty States

- No heatmap folders or entries: show a compact empty message in the pane.
- Screener daily corpus unavailable for a historical basis date: show an explicit "daily ranking unavailable" state.
- No daily data for some codes on the basis date: show sectors with missing values last and a clear unavailable label for those rows.
- All sectors missing change percentages: show the heatmap sector list with neutral values and no misleading ordering claim.
- Fetch error: keep the chart usable and show an inline pane error with retry.
- Pinned sector removed from heatmap: clear the sector pin and fall back to rank 1.

## Accessibility

- Sector rows are buttons.
- `Enter`/`Space` pin or unpin the focused sector.
- `Esc` clears date pin first, then sector pin if no date is pinned.
- The pane header exposes the current basis date and pin state as text.
- Selection state is visible through accent border/background and text, not color alone.

## Testing

Unit tests:

- Daily change percentage uses selected adjusted close vs previous available adjusted close.
- Sector average excludes missing/non-finite percentages.
- Sector ranking is descending, missing sectors last.
- Stock ranking is descending, missing stocks last.
- Historical basis dates do not call or display `/api/live/quotes` values.
- `W`/`M` index timeframes do not show a misleading daily ranking.
- Pinned date ignores subsequent hover basis changes.
- Clicking the pinned candle clears the date pin.
- Sector hover previews without overwriting the pinned sector.
- Clicking the pinned sector clears the sector pin.
- Pinned sector survives date changes when present, otherwise falls back to rank 1.

Component tests:

- Index instrument renders the pane.
- Stock instrument does not render the pane.
- `W`/`M` index timeframe renders the disabled or hidden state.
- Pane entry from chart hover preserves the last basis date.
- Stock row click uses existing live tab open behavior.
- Empty/error states render without crashing the chart.

Browser QA:

- Hover index candles and verify both sector and stock rankings update.
- Click a candle, hover other candles, and verify rankings remain pinned.
- Hover sector rank 2 and verify right-side stocks preview rank 2.
- Click sector rank 2, move pointer away, and verify rank 2 remains selected.
- Click selected sector again and verify the right side returns to rank 1.
- Confirm stock `/live` charts are visually unchanged.
- Confirm a historical pinned date remains historical after latest live quote polling.

## Out Of Scope

- Secondary stock sort controls such as volume or trading value.
- Editing heatmap folders or entries from the sector pane.
- Adding the pane to stock charts.
- Changing heatmap storage or watchlist subscription behavior.
- Replacing the existing candle tooltip.
- Reconstructing the heatmap folder membership that existed on a historical date.
- Weekly or monthly sector period-return rankings.
