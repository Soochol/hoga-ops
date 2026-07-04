# Peak Wall Visible Time Cutoff — Design

**Date**: 2026-07-04
**Status**: Draft
**Scope**: `hoga/api/models.py`, `hoga/api/bundle.py`, `hoga/tables/snapshots.py`, `frontend/src/api/types.ts`, `frontend/src/live/indicators/AskPeakConfig.tsx`, `frontend/src/live/indicators/BidPeakConfig.tsx`, `frontend/src/state/chartPrefs.ts`, `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/useDayAskPeaks.ts`, `frontend/src/live/useDayBidPeaks.ts`, `frontend/src/live/LiveAskPeakSegments.tsx`, `frontend/src/live/LiveBidPeakSegments.tsx`

## Problem

The `당일 매도 최대벽` and `당일 매수 최대벽` indicators currently show the day's peak wall using the current full calculation state. When a user scrolls a minute chart to an earlier intraday point, the displayed peak can reflect a later wall that was not yet known at the latest visible candle.

Users need separate option toggles for ask and bid peak walls:

- Off by default, preserving the current behavior.
- On means calculate the daily peak wall as of the latest date/time visible to the user on the minute chart.
- The rule must work both for today's live/장중 session and for historical days.

## Invariants

- **Peak wall indicators are minute-only**: Ask/bid peak wall overlays are meaningful only on minute/hoga chart contexts. Calendar timeframes do not acquire a new peak-wall behavior. 근거: `AskPeakConfig.tsx`, `BidPeakConfig.tsx`, `LiveChartRoot.tsx`.
- **Default behavior is unchanged**: Existing users keep the current full-day/current-state peak wall calculation unless they explicitly enable the new toggle. 근거: `chartPrefs.ts` toggle defaults.
- **Ask and bid settings remain independent**: 매도 최대벽 and 매수 최대벽 have separate enablement and style state, and this change must preserve separate cutoff toggles. 근거: existing `askPeak*` and `bidPeak*` prefs.
- **Cutoff is based on visible candle time, not cursor hover**: The calculation anchor is the rightmost visible candle's `ts_ms`, so moving the mouse does not change peak-wall state. 근거: user request says "사용자에게 보이는 최신 날짜/시각".
- **Future candidates are excluded when cutoff is enabled**: For a selected cutoff time, any orderbook/trade/peak candidate with `t_ms > cutoffMs` must not affect the displayed daily ask/bid peak.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Peak wall indicators are minute-only | preserves | The toggles can render in the existing indicator detail panes, but their effect is only available when the chart has minute candle visibility. |
| Default behavior is unchanged | preserves | New toggles default to `false`. Existing calculation paths run when disabled. |
| Ask and bid settings remain independent | preserves | Add separate `askPeakVisibleTimeCutoff` and `bidPeakVisibleTimeCutoff` boolean preference keys. |
| Cutoff is based on visible candle time, not cursor hover | preserves | `LiveChartRoot` derives cutoff from visible logical range plus candle times, independent of crosshair state. |
| Future candidates are excluded when cutoff is enabled | preserves | Hook/projector filtering rejects candidates after cutoff before ranking/selecting peaks. |

## Goals

- Add one separate toggle to `당일 매도 최대벽` settings and one to `당일 매수 최대벽` settings.
- Default both toggles to off.
- When enabled on today's live chart, calculate today's peak wall only from candidates at or before the rightmost visible minute candle.
- When enabled on a historical day, calculate that historical day's peak wall only from candidates at or before the rightmost visible minute candle for that day.
- Apply the same meaning on `/live` and `/study`, because both surfaces share the chart root and indicator preferences.
- Ensure both ask and bid historical calculations have enough timestamped ranked candidates to recompute the winner before the cutoff.
- Preserve current behavior exactly when disabled.
- Add focused tests for UI, prefs, today cutoff behavior, and historical cutoff behavior.

## Non-Goals

- No backend API change.
- No new network request on scroll/zoom.
- No change to the meaning of "체결가격 기준 최대벽", "미체결 포함 최대벽", rank limit, or visible-area highlight styling.
- No cursor-hover-based peak recalculation.
- No change to calendar timeframe overlays.

## Design

### Preferences and UI

Add two `indicator-modal` chart toggles in `chartPrefs.ts`:

- `askPeakVisibleTimeCutoff`, label `보이는 최신 봉 기준`, default `false`.
- `bidPeakVisibleTimeCutoff`, label `보이는 최신 봉 기준`, default `false`.

The description should say that the indicator is calculated only up to the timestamp of the rightmost visible minute candle. This keeps it distinct from `보이는 영역 최대벽`, which is a visible-range styling/highlight concept rather than the calculation time basis.

Render each in its own detail config:

- `AskPeakConfig` includes `askPeakVisibleTimeCutoff`.
- `BidPeakConfig` includes `bidPeakVisibleTimeCutoff`.

The UI uses existing `IndicatorPrefRows`, so styling, persistence semantics, and test patterns match the nearby intra-bar and all-price toggles.

### Visible Cutoff Derivation

`LiveChartRoot` already owns the chart instance, virtual axis, visible range, and candle `ts_ms` array. It should derive an optional `visibleCutoffMs` when:

- The current timeframe is a minute timeframe.
- The relevant ask or bid cutoff toggle is enabled.
- There is at least one visible candle.

The cutoff is the `ts_ms` of the rightmost candle whose virtual/logical position is inside the current visible range. If the visible range extends into right-offset whitespace, use the latest loaded candle. If the viewport is before all loaded candles, cutoff is `null` and the peak overlay should have no cutoff effect until candles become visible.

This value should be stable state, updated from chart visible-range changes and from candle data changes. It is not based on crosshair hover.

### Data Flow

Pass the cutoff to ask and bid peak calculation paths separately:

- If `askPeakVisibleTimeCutoff` is false, `useDayAskPeaks` and related all-price/visible ranking logic receive `null`.
- If true, ask calculations receive `visibleCutoffMs`.
- Bid follows the same pattern with `bidPeakVisibleTimeCutoff`.

Where an overlay/projector consumes precomputed `dayAskPeaks` or `dayBidPeaks`, the selected candidates must already respect the cutoff. Rendering should not merely hide future segments after a full-day maximum has already been selected.

The behavior applies on both `/live` and `/study`. `LiveChartRoot` should own visible cutoff derivation so both routes inherit the same rightmost-visible-candle basis. If a legacy study snapshot lacks timestamped ranked candidates for the cutoff date, omit that cutoff-date line instead of falling back to a full-day value.

When enabled for one side, the cutoff applies to every candidate family rendered by that side:

- Baseline `체결가격 기준 최대벽`.
- Optional `미체결 포함 최대벽`.
- Visible-area ranking/highlight candidates such as `보이는 영역 최대벽`.

Do not mix full-day and cutoff-limited peak candidates within the same ask or bid indicator. A side's rendered lines must share one time basis.

For historical days, both sides need timestamped ranked candidates:

- Ask can use existing `traded_peaks`/ranked candidate shapes.
- Bid must grow an equivalent timestamped candidate list if the current wire shape only provides a single selected bid peak.
- Cutoff mode selects from candidates with `t_ms <= visibleCutoffMs`; if no candidate remains for the cutoff date, that day's cutoff-driven line is omitted rather than falling back to a full-day peak.

### Today and Historical Days

The cutoff timestamp carries its own KST trading date. Candidate filtering is date-aware:

- For today's live session, live `ob` and `trade` snapshots with `t_ms > cutoffMs` are ignored before ratchet/ranking. REST today seeds are included only if their `t_ms <= cutoffMs`.
- For historical days, historical peak candidates/ranked candidates are filtered by `t_ms <= cutoffMs` when their `date` equals the cutoff date.
- Days before the cutoff date can keep their full-day peak values because they are entirely visible in the past relative to the rightmost visible candle.
- Days after the cutoff date are excluded from cutoff-driven peak output.
- If the cutoff date has no candidate at or before the cutoff, no peak wall is drawn for that date in cutoff mode.

When the viewport spans more than one Stock-Date, the rightmost visible candle's Stock-Date is the only cutoff date. Earlier visible dates keep full-day values; later dates are excluded. Do not apply the cutoff date's clock time to earlier Stock-Dates.

This preserves "as of the latest visible date/time" across both live and historical navigation.

### Error Handling

- If cutoff is enabled but no visible candle time can be derived, keep the current rendered result stable and do not throw.
- If candidate arrays do not include enough timestamped rank data for a historical day, do not invent a synthetic timestamp and do not silently show the full-day peak as if it were cutoff-correct. Extend the candidate data shape or omit that cutoff-date line.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Ask config toggle renders | Open `당일 매도 최대벽` config | `settings-toggle-askPeakVisibleTimeCutoff` is present and defaults off |
| Bid config toggle renders | Open `당일 매수 최대벽` config | `settings-toggle-bidPeakVisibleTimeCutoff` is present and defaults off |
| Ask today cutoff ignores future live snapshots | Seed/live snapshots before and after cutoff | selected ask peak comes from `t_ms <= cutoffMs` |
| Bid today cutoff ignores future live snapshots | Seed/live snapshots before and after cutoff | selected bid peak comes from `t_ms <= cutoffMs` |
| Historical cutoff ignores future same-day candidates | Historical ranked candidates include larger future wall | selected peak/rank excludes candidate after cutoff |
| Historical cutoff with no earlier candidate | Cutoff-date candidates all occur after cutoff | no line is drawn for that date in cutoff mode |
| Bid historical cutoff uses ranked candidates | Bid candidates include earlier smaller wall and later larger wall | selected bid peak comes from the earlier candidate |
| Cutoff applies to all line families | Baseline and untraded candidates disagree after cutoff | every rendered ask/bid line is selected from `t_ms <= cutoffMs` |
| Multi-date viewport cutoff date | Visible range spans two Stock-Dates | earlier date keeps full-day peak; rightmost date is cutoff-limited; later dates are omitted |
| Study route uses same basis | `/study` chart has cutoff toggle enabled | peak walls follow the rightmost visible candle basis just like `/live` |
| Disabled toggle preserves current behavior | Same inputs with cutoff disabled | larger future/current-state candidate is still selected |

**Invariant regression tests**:

- Default behavior unchanged: existing ask/bid peak tests continue to pass with new toggle defaults.
- Ask/bid independence: toggling ask cutoff does not set bid cutoff, and vice versa.
- Cutoff source: derived cutoff follows visible range's right edge, not crosshair hover.

### Manual verification

- On `/live`, select a stock with minute data and enable only `당일 매도 최대벽` → `보이는 최신 봉 기준`.
- Scroll today/장중 chart left so the latest visible candle is earlier than the latest live candle. Confirm the ask peak wall reflects only data up to that visible candle.
- Repeat with `당일 매수 최대벽`.
- Scroll into a past day and confirm each enabled side recalculates as of that past day's rightmost visible candle.
- Open a `/study` view and confirm the same cutoff behavior applies when the toggle is enabled.
- Disable both toggles and confirm the previous full/current behavior returns.

## Risks / Open questions

- Historical all-rank support depends on how much timestamped candidate data the frontend already receives. If only a single full-day peak is available for an older backend shape, cutoff cannot reconstruct earlier lower-ranked states without additional candidate data.
- Updating cutoff on every visible-range change may cause extra React state churn. Debounce is not planned initially; rely on cheap numeric state updates and existing chart event cadence.

## Out of Scope (Backlog)

- Backend endpoint for exact "peak as of timestamp" queries.
- A shared "visible time basis" control that applies to all hoga indicators.
- Per-tab persistence of the cutoff toggle separate from the existing chart prefs model.
