# /live Timeframe Keyboard Shortcuts

Date: 2026-06-22
Status: Approved for planning

## Goal

Add `/live` keyboard shortcuts for switching the chart timeframe:

- `Shift+1`: switch to the currently remembered minute timeframe.
- `Shift+2`: switch to daily (`D`, 일봉).
- `Shift+3`: switch to weekly (`W`, 주봉).
- `Shift+4`: switch to monthly (`M`, 월봉).

`Shift+1` must behave like clicking the compact minute selector from the
timeframe toolbar. If the active chart is already a minute timeframe, it keeps
that minute timeframe. If the active chart is `D`, `W`, or `M`, it returns to
the last selected minute timeframe, for example `10m -> D -> Shift+1` returns
to `10m`.

## Current Context

The live page already has a central keyboard hook:

- `frontend/src/live/useLiveKeyboard.ts`
- mounted from `frontend/src/live/LivePage.tsx`

Existing shortcuts include:

- `j` / `k` for watchlist traversal callbacks.
- `[` / `]` for previous and next live tab.
- plain `1` through `9` for direct live-tab selection.
- `w` for the watchlist panel.
- `Escape` for closing an open right-rail panel when no dialog or menu owns it.

The timeframe toolbar lives in `frontend/src/live/LiveToolbar.tsx`. It already
uses a compact minute selector plus `일`, `주`, and `월` buttons. The toolbar's
current remembered minute is local component state, which was sufficient when
only the toolbar needed it.

This shortcut feature creates a second caller for the same concept. Keeping
separate remembered-minute state in the toolbar and keyboard path would drift.

## User Experience

Shortcut behavior:

```text
Shift+1 -> remembered minute timeframe
Shift+2 -> D
Shift+3 -> W
Shift+4 -> M
```

Examples:

- Current timeframe `10m`; press `Shift+1`; timeframe remains `10m`.
- Current timeframe `10m`; press `Shift+2`; timeframe becomes `D`.
- Current timeframe `D`; press `Shift+1`; timeframe becomes `10m`.
- Current timeframe `W`; press `Shift+4`; timeframe becomes `M`.

The shortcuts must not fire while the user is typing into stock search, text
inputs, selects, textareas, contenteditable elements, or any element inside
`data-prevent-shortcuts`.

Plain numeric keys continue to select tabs. `Shift+1` through `Shift+4` are
timeframe shortcuts only; plain `1` through `4` remain tab shortcuts.

`Ctrl`, `Meta`, and `Alt` modified events remain browser/app reserved and are
ignored by this feature, even when `Shift` is also held.

## State Model

Add a shared `lastMinuteTimeframe` field to `useLivePageStore`.

```ts
lastMinuteTimeframe: MinuteTimeframe;
```

Default value: `1m`.

Update rules:

- When `setCandleTimeframe(next)` receives a minute timeframe, set both
  `candleTimeframe: next` and `lastMinuteTimeframe: next`.
- When `setCandleTimeframe(next)` receives `D`, `W`, or `M`, set
  `candleTimeframe: next` and preserve `lastMinuteTimeframe`.
- When hydrating older persisted state without `lastMinuteTimeframe`, derive it
  from `candleTimeframe` if that value is a minute timeframe; otherwise fall
  back to `1m`.
- `projectActiveView` may receive calendar timeframes during tab switching. It
  should update `lastMinuteTimeframe` only when the projected timeframe is a
  minute timeframe.

Persistence:

- Persist `lastMinuteTimeframe` in `live.page.v1` so a reload on `D`, `W`, or
  `M` can still return to the user's last minute selection with `Shift+1`.
- Validate stored values defensively against `MINUTE_TIMEFRAMES`.
- This explicitly revises the toolbar-only design in
  `2026-06-22-live-timeframe-toolbar-design.md`, which avoided adding persisted
  remembered-minute state. That was correct before keyboard shortcuts existed;
  the shared keyboard and toolbar contract now needs one source of truth.

## Component Boundaries

`useLivePageStore` owns:

- active timeframe
- last remembered minute timeframe
- validation and persistence of both values

`LiveToolbar` owns:

- minute menu open/close state
- menu positioning
- click behavior

`LiveToolbar` no longer owns a private remembered-minute state. It reads
`lastMinuteTimeframe` from `useLivePageStore`. Its minute selector click
behavior remains the same:

- on a minute chart, open/close the menu
- on a calendar chart, call `setCandleTimeframe(lastMinuteTimeframe)`

`useLiveKeyboard` owns:

- shortcut event filtering
- mapping `Shift+1` through `Shift+4` into caller callbacks

`LivePage` wires the keyboard callback to store actions:

- `Shift+1`: `setCandleTimeframe(lastMinuteTimeframe)`
- `Shift+2`: `setCandleTimeframe('D')`
- `Shift+3`: `setCandleTimeframe('W')`
- `Shift+4`: `setCandleTimeframe('M')`

This keeps the keyboard hook decoupled from Zustand while matching the current
tab callback pattern in `LivePage`.

## Shortcut Matching

Update `useLiveKeyboard` so modifier handling is explicit:

- Ignore events with `metaKey`, `ctrlKey`, or `altKey`.
- If `shiftKey` is true, match only `1`, `2`, `3`, and `4` for timeframe
  shortcuts, then prevent default.
- If `shiftKey` is true for any other key, do not run plain-key shortcuts.
- If `shiftKey` is false, keep existing behavior for `j`, `k`, `[`, `]`, `w`,
  `Escape`, and plain `1` through `9` tab selection.

This prevents `Shift+1` from also selecting tab index `0`.

## Live Tabs Interaction

The existing live tab mirror should continue to work through
`setCandleTimeframe` and `projectActiveView`.

Changing timeframe with a keyboard shortcut has the same effect as clicking the
toolbar:

- active tab timeframe is updated by the existing page-to-tab mirror
- `historicalFromDate` resets
- saved viewport is invalidated on user-initiated timeframe changes
- tab switching can still restore its own timeframe without being interpreted
  as a user shortcut

`lastMinuteTimeframe` is a page-level preference, not a per-tab field. A user
who selects `10m`, moves through calendar timeframes or tabs, and presses
`Shift+1` returns to `10m`. This matches the user's requested "currently set
minute timeframe" behavior and avoids expanding the live-tab snapshot schema.

## Testing

Add focused tests.

`frontend/src/live/useLiveKeyboard.test.tsx`:

- `Shift+1` calls the timeframe shortcut callback with the minute slot.
- `Shift+2`, `Shift+3`, and `Shift+4` call the callback for `D`, `W`, and `M`.
- plain `1` still calls tab selection, not timeframe selection.
- `Shift+1` does not select a tab.
- input focus suppresses `Shift+1`.
- `Ctrl+Shift+1`, `Meta+Shift+1`, and `Alt+Shift+1` are ignored.

`frontend/src/state/livePage.test.ts`:

- minute timeframe changes update `lastMinuteTimeframe`.
- calendar timeframe changes preserve `lastMinuteTimeframe`.
- persisted `lastMinuteTimeframe` hydrates when valid.
- invalid or missing persisted `lastMinuteTimeframe` falls back safely.

`frontend/src/live/LiveToolbar.test.tsx`:

- from `D`, clicking the minute selector returns to store
  `lastMinuteTimeframe`, not private component state.
- selecting a minute option updates both `candleTimeframe` and
  `lastMinuteTimeframe`.

Optional integration coverage in `frontend/src/live/LivePage.test.tsx`:

- pressing `Shift+1` from `D` after `10m` was selected returns to `10m`.
- pressing `Shift+2/3/4` sets `D/W/M`.

## Out Of Scope

- Yearly candles or a `Y` timeframe.
- Backend API changes.
- New visible UI labels for shortcuts.
- Changing the existing tab shortcuts.
- Per-tab remembered-minute state.
- Changes to chart fetching, aggregation, or indicator behavior.
