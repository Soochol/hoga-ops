# /live Timeframe Toolbar UX

Date: 2026-06-22
Status: Approved for planning

## Goal

Change the `/live` timeframe control from a flat list of raw timeframe codes into a compact trading-style selector:

```text
[3분 v] [일] [주] [월]
```

The `년` control shown in the visual reference is explicitly out of scope. The live page continues to support only the existing timeframes: `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `D`, `W`, and `M`.

## Current Context

`frontend/src/live/LiveToolbar.tsx` currently renders every `LIVE_TIMEFRAMES` entry as an independent button. Clicking any button calls `useLivePageStore().setCandleTimeframe`.

The selected timeframe is mirrored into live tabs through the existing `liveTabs` synchronization path. Changing timeframe resets `historicalFromDate` and clears the active tab viewport, which should remain unchanged.

## User Experience

The toolbar should render one representative minute button plus calendar buttons:

- Minute button label: the active minute timeframe when on a minute chart, otherwise the last selected minute timeframe.
- Calendar buttons: `일`, `주`, `월`.
- No `년` button.

Use the canonical existing domain term **LiveTimeframe** for the full selector value. In this feature, call the first control the **minute selector** rather than inventing a new persisted "last-used settings" concept.

Minute button behavior:

- If the current chart is `D`, `W`, or `M`, clicking the minute button immediately switches to the remembered minute timeframe and does not open the menu.
- If the current chart is already a minute timeframe, clicking the minute button opens the minute list.
- The minute list contains `1분`, `3분`, `5분`, `10분`, `15분`, and `30분`.
- Selecting an item switches to that minute timeframe and closes the menu.

Calendar button behavior:

- Clicking `일`, `주`, or `월` immediately switches to `D`, `W`, or `M`.
- Calendar clicks close the minute list if it is open.

State machine:

```text
current: minute
  minute selector click -> open menu
  menu item click       -> set selected minute, close menu
  일/주/월 click         -> set D/W/M, close menu

current: D/W/M
  minute selector click -> set remembered minute, keep menu closed
  일/주/월 click         -> set D/W/M, keep menu closed
```

## State Model

Do not add a new persisted store field for `lastMinuteTf` in this change.

`LiveToolbar` can keep the remembered minute timeframe as local UI state:

- Initialize from `candleTimeframe` when it is a minute timeframe.
- Otherwise initialize to `1m`.
- Whenever `candleTimeframe` becomes a minute timeframe, update the remembered minute timeframe.

This preserves the important same-session behavior: `5분 -> 일봉 -> 분봉 button` returns to `5분`. After a reload on a calendar timeframe, the representative minute defaults to `1분`, which avoids expanding the persistence contract for a small toolbar preference.

## Component Boundaries

Keep the change scoped to the toolbar surface:

- `LiveToolbar` owns the minute menu open/close state and remembered minute timeframe.
- `livePage` remains the single owner of the active timeframe.
- `liveTabs` mirror behavior remains unchanged and observes the same `setCandleTimeframe` calls as before.
- Render minute options from `MINUTE_TIMEFRAMES` and calendar options from `CALENDAR_TIMEFRAMES`; do not re-split string literals from `LIVE_TIMEFRAMES` in the component.
- Reuse existing popover utilities where possible: `useDismissablePopover` for outside mousedown/Escape dismissal and `useClampedFixedPosition` if a fixed-position dropdown is needed to avoid clipping.

If the toolbar component starts to grow hard to read, extract a small `MinuteTimeframeMenu` component in the same file or sibling file. It should receive plain props: current timeframe, remembered minute timeframe, open state, and callbacks.

## Accessibility

The representative minute button has dual behavior, so its accessible label must describe the behavior that will happen on this click:

- On `D/W/M`, label it as switching back to the remembered minute timeframe.
- On a minute timeframe, label it as opening the minute selection menu.
- Use `aria-haspopup="menu"` and `aria-expanded` when the current click can open the menu.
- The dropdown should use `role="menu"` and each option should be a button or `role="menuitemradio"` with a clear accessible name.
- Escape and outside click dismissal are required, using the existing dismissable-popover contract.
- Selecting another toolbar button or a menu item must close the menu.

## Styling

Follow `DESIGN.md` and the existing live toolbar tokens:

- Use dark card/input surfaces: `--bg-card`, `--bg-input`, `--bg-input-hover`.
- Use `--accent` and `--tint-selection` only for active UI state.
- Keep the control compact and monospace-friendly.
- Match the reference shape with a small rounded active minute button and a vertical dropdown aligned below it.

## Testing

Add focused tests in `frontend/src/live/LiveToolbar.test.tsx`:

- Renders `분`, `일`, `주`, `월` controls and no `년` control.
- On a calendar timeframe, clicking the minute button switches directly to the remembered minute timeframe without showing the menu.
- On a minute timeframe, clicking the minute button opens the minute list.
- Selecting a minute option switches timeframe and closes the menu.
- Clicking `일`, `주`, or `월` switches to the corresponding calendar timeframe and closes any open minute list.
- Escape closes the minute list without changing timeframe.
- Outside mousedown closes the minute list without changing timeframe.
- The remembered minute updates after selecting a different minute, then survives `minute -> calendar -> minute button` in the same mounted toolbar session.

Existing tab mirror tests should continue to pass without modification because the toolbar still uses `setCandleTimeframe`.

## Out Of Scope

- Yearly candles or a `Y` timeframe.
- Backend API changes.
- New persisted preferences for the remembered minute timeframe.
- Changes to chart fetch, aggregation, viewport, or live tab synchronization behavior.
