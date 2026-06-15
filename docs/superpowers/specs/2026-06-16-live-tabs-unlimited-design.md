# `/live` Unlimited Tabs Design

## Context

`/live` currently limits Live tabs with `TABS_SOFT_CAP = 8` in
`frontend/src/state/liveTabs.ts`. The cap is enforced only by `addBlankTab()`;
the active tab remains the single live data subscriber through
`useLiveSeries(activeCode)`. ADR-0069 defines Live tabs as cold-swap viewers:
inactive tabs preserve view state but do not add KIS real-time subscriptions.

The 8-tab limit is therefore a UI and memory policy, not a KIS subscription
safety requirement. The desired behavior is to remove the limit entirely while
keeping tab navigation usable when many tabs are open.

## Goals

- Allow users to open any number of `/live` tabs.
- Keep the chart area height stable regardless of tab count.
- Preserve the existing single-active-tab data subscription model.
- Make 20+ open tabs navigable without relying on tiny visible tab labels.
- Keep the first implementation small and reversible.

## Non-Goals

- Do not warm-subscribe inactive tabs.
- Do not add automatic tab eviction.
- Do not persist extra runtime state beyond the existing `live.tabs.v1` fields.
- Do not introduce multi-row tabs, because that steals vertical chart space.
- Do not add per-tab close controls inside the overflow menu in the first pass.

## Design

### Store Policy

Remove the cap from the store. `addBlankTab()` should always create a focused
blank tab, snapshotting the outgoing tab viewport first as it does today.

The `TABS_SOFT_CAP` export should be removed if no longer needed. If tests or
display code need a count, they should use `tabs.length` directly.

### Tab Bar Layout

Keep `LiveTabBar` as a single-row control. Split it into:

- a horizontally scrollable tab strip,
- fixed right-side actions: new-tab button, overflow/list button, and count.

Only the tab strip scrolls. The `+` button and list access remain visible even
when the strip contains many tabs.

The count changes from `N/8 open` to `N open`. It no longer enters an error
state, because there is no cap.

When the active tab changes, the active tab element should scroll into view
inside the horizontal strip. This applies to clicking a tab, keyboard tab
selection, and selecting a tab from the overflow menu.

### Overflow Menu

Add a small `LiveTabOverflowMenu` component owned by `LiveTabBar`.

Behavior:

- The trigger is a compact icon button near the tab count.
- The menu lists all open tabs in order.
- The menu includes a text filter matching tab `label` or `code`.
- Clicking a row calls `onFocus(id)` and closes the menu.
- The active tab is visually marked in the list.
- Escape and outside click close the menu, following existing popover patterns.

The first pass should not include close buttons in the menu. Existing tab close
affordances remain the tab `x` and middle-click.

### Data Flow

The data flow remains unchanged:

1. `addBlankTab()` creates a blank active tab.
2. Search or external navigation fills the active tab through
   `setActiveTabCode()`.
3. `focusTab(id)` projects the selected tab into `useLivePageStore`.
4. `LivePage` calls `useLiveSeries(activeCode ?? '')` for the active code only.

Removing the cap does not change WebSocket/SSE subscription count.

## Error Handling

There is no over-cap error state after this change.

Malformed persisted tabs continue to be filtered by the existing `loadTabs()`
validation. If a user restores a very large persisted tab set, the UI should
remain usable through horizontal scrolling and the overflow menu.

## Testing

### Store Tests

- `addBlankTab()` can create more than 8 tabs.
- `addBlankTab()` still snapshots the outgoing viewport before appending.
- Existing close, focus, reorder, and persistence tests continue to pass.

### Component Tests

- `LiveTabBar` renders `N open` rather than `N/8 open`.
- The new-tab button is never disabled because of tab count.
- The overflow trigger renders when tabs exist.
- Selecting a tab from the overflow menu calls `onFocus(id)`.
- Filtering matches both `label` and `code`.

### Regression / E2E

- Open at least 10 tabs and verify the chart row height remains stable.
- Verify the active tab can be selected from the overflow menu.
- Verify switching tabs still restores active code and saved viewport behavior.

## Implementation Notes

- Prefer CSS overflow on the tab strip over multi-row wrapping.
- Use existing `useDismissablePopover` for the overflow menu.
- Keep tab item sizing conservative so many labels remain scannable; use
  truncation and `title` for full label visibility.
- Do not touch live data hooks unless a test exposes an actual coupling.

## Open Decisions

No open product decisions remain. The approved direction is unlimited tabs with
a horizontally scrollable strip and an overflow search/list menu.
