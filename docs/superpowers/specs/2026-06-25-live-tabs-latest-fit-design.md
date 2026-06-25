# Live Tabs Latest-Fit Design

## Goal

`/live` tab switches should always reopen the selected tab at the latest candle view. Tabs should keep only the instrument identity and candle timeframe state. They should no longer preserve the previous chart zoom, scroll position, or historical scrollback location.

## Current Behavior

Each `LiveTab` stores `instrument`, `code`, `label`, `timeframe`, `historicalFromDate`, and `viewport`. `LiveChartRoot` captures the chart viewport on range changes and on tab switch-away, then `LivePage` passes the active tab viewport back as `restoreViewport` when returning to the tab. This restores the old chart position and zoom.

## Desired Behavior

On every tab focus, the active tab should project its instrument and timeframe into `useLivePageStore`, but chart position should reset to the chart's default latest-candle fitting behavior.

The tab should continue to preserve:

- instrument/code/label
- selected timeframe, including minute frames and `D`/`W`/`M`

The tab should stop preserving:

- `viewport`
- `historicalFromDate`
- zoom and horizontal scroll position

## Design

Use the smallest behavioral change first: keep the persisted `viewport` field tolerated for backward compatibility, but stop writing and reading it in the `/live` tab path.

`focusTab`, `addBlankTab`, and `openSymbolInNewTab` should no longer snapshot the outgoing viewport. `LivePage` should not pass an active tab viewport to `LiveWorkarea`/`LiveChartRoot`. `LiveChartRoot`'s live viewport persistence should be disabled for the `/live` page, while retaining its capture callback for study-view save flows.

`projectTabToActiveView` should project `historicalFromDate: null` on tab focus, so returning to a tab requests the default range and lets the chart fit to the recent candles. `mirrorPageViewToActiveTab` should continue mirroring timeframe changes to the active tab, but should not mirror pan-driven `historicalFromDate` into tabs.

## Data Compatibility

Existing `live.tabs.v2` records may contain `viewport` and `historicalFromDate`. Loading should continue to tolerate those fields, but the active projection should ignore them. A future cleanup can remove the fields from the persisted schema after the behavior has settled.

## Testing

Update tab store tests to assert that focusing a tab does not snapshot viewport and projects `historicalFromDate: null`.

Update Live page/chart tests to assert that no active tab viewport is passed into `LiveChartRoot` and that the chart follows the default latest-candle initial view after tab switches.

