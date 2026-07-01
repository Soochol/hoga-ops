# Pinned Chart Tabs Design

## Goal

Add a pin control to chart tabs on `/live` and `/study` so important tabs can be protected while the user opens, replaces, and closes other tabs.

## Behavior

- Each tab has a pinned/unpinned state.
- Clicking the pin icon toggles the state for that tab.
- Pinned tabs are displayed before unpinned tabs in the tab bar.
- Pinned tabs keep their relative order with other pinned tabs. Unpinned tabs keep their relative order with other unpinned tabs.
- Pinned tabs cannot be closed from the tab close button or middle-click close.
- If the active `/live` tab is pinned and the user performs a normal symbol open action that would replace the active tab, the app opens or replaces an unpinned tab instead of overwriting the pinned tab.
- Explicit new-tab actions still create a new unpinned tab.
- Unpinning a tab makes it behave like a normal tab again.
- Pinned state persists across page reloads for both `/live` and `/study`.

## UI

- Use a compact pin icon inside each tab, near the label and before the close button.
- The icon is always discoverable enough to toggle, but visually quiet.
- Pinned state uses the existing UI accent token. Unpinned state uses dim foreground.
- The close control is hidden or disabled for pinned tabs to prevent accidental closure.
- The implementation stays inside the existing `ChartTabBar` visual language: 32px tab height, small icon controls, no new colors, no new decorative chrome.

## Architecture

- Extend the shared tab-like shape consumed by `ChartTabBar` with optional `pinned`.
- Add an optional `onTogglePin(id)` prop to `ChartTabBar`.
- Add `toggleTabPinned(id)` actions to `useLiveTabsStore` and `useStudyTabsStore`.
- Persist `pinned` in each store snapshot. Missing values from older localStorage snapshots hydrate as `false`.
- Keep pin ordering in the stores, not only the UI, so overflow menus, snapshots, and tab indices agree.
- Reorder behavior should not allow dragging tabs across the pinned/unpinned boundary. Dragging within the same group is allowed.

## Live Tab Replacement Rule

When `setActiveTabInstrument` is called and the active tab is pinned:

- If an unpinned tab exists, replace the first unpinned tab after the pinned block and focus it.
- If no unpinned tab exists, create a new unpinned tab and focus it.
- The pinned tab remains unchanged.

This preserves the current single-click flow without letting a protected tab be overwritten.

## Study Scope

Study tabs get pin/unpin, pinned ordering, close protection, drag-boundary protection, and persistence. Study saved-view open behavior should mirror the same protection where `openSaveInActiveTab` would otherwise replace a pinned active tab.

## Testing

- Store tests cover persistence, toggle behavior, ordering, close protection, drag-boundary handling, and pinned active replacement behavior.
- Tab bar tests cover pin button rendering, toggle callback, pinned close protection, and drag boundary behavior.
- Existing Live/Study page tests should continue to pass with older test fixtures that omit `pinned`.

