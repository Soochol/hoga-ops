# Replay Sidebar — Splitter & Collapse

**Date**: 2026-05-24
**Status**: Draft
**Type**: feature
**Scope**: `/replay` workarea — vertical splitter between chart and cursor sidebar (10호가 / 거래원 / 체결), plus a collapse/expand toggle for the sidebar as a whole.

## Problem

On `/replay`, the cursor sidebar — containing the 10호가 (orderbook), 거래원 (broker net), and 체결 (fill tape) cards — is fixed at `--sidebar-w` (20rem rendered, 16rem base intent) via [frontend/src/replay/Workarea.tsx:99](../../frontend/src/replay/Workarea.tsx#L99):

```tsx
<div className="grid grid-cols-[1fr_var(--sidebar-w)] gap-2 p-2 flex-1 min-h-0">
```

Two friction points:

1. **No user resize.** The user cannot trade chart width for sidebar width depending on what they're inspecting at the moment (price action vs. orderbook depth).
2. **No way to hide the sidebar.** When the user wants to focus on the chart, the three cards consume ~320px of horizontal space they cannot reclaim.

A precedent exists in [frontend/src/pages/Capture.tsx:25-108](../../frontend/src/pages/Capture.tsx#L25-L108): a working vertical splitter with localStorage persistence, 12px grab zone with a 2px visible bar, hover-to-accent, double-click reset, and MIN/MAX clamping. That code has been live for the capture page and validated; this spec generalizes it.

## Goals

- Let the user drag a vertical splitter between the chart and the cursor sidebar to resize the sidebar in real time.
- Let the user collapse the sidebar entirely so the chart fills the workarea, with a small affordance to bring it back.
- Persist both width and collapsed state across reloads (per-user, not per-tab).
- Reuse the splitter logic on both `/capture` and `/replay` via a shared component.

## Non-goals

- Horizontal splitter inside the chart (top/bottom split). Out of scope.
- Per-card collapse (10호가 alone, 거래원 alone). The user picked **whole sidebar** collapse.
- Per-tab independent layout. A single global layout for `/replay` is correct because layout is a personal workspace preference, not part of the tab's `selection` (which is what `state/tabs.ts` and the URL describe).
- Mobile / narrow-viewport responsive behavior. hoga-ops is a single-user desktop tool.
- Animating the collapse. A snap is fine and matches the rest of the app (which has no layout transitions).

## Design

### 1. New module — `frontend/src/layout/VerticalSplitter.tsx`

A reusable presentational component extracted from [Capture.tsx](../../frontend/src/pages/Capture.tsx). The component owns drag/keyboard interaction but **not** the value; the parent owns state and persistence.

```tsx
type Props = {
  // Called continuously during drag with the raw cursor X. Parent maps clientX → value
  // (it owns the container ref and the value semantics — px vs percent, axis direction).
  onDrag: (clientX: number) => void;
  onReset: () => void;
  // ARIA wiring — parent supplies semantic values.
  ariaLabel: string;
  ariaValueNow: number;
  ariaValueMin: number;
  ariaValueMax: number;
  // Keyboard nudges — parent decides step semantics.
  onNudge?: (direction: -1 | 1, magnitude: 'small' | 'large') => void;
};
```

The splitter intentionally knows **nothing** about its parent layout — it just streams cursor X and signals reset/nudge intents. This keeps it reusable for the percent-based capture pane and the px-based replay sidebar without conditionals.

Behavior:
- Render a 12px-wide grid track with a 2px visible bar centered inside (`background: var(--border)`).
- On hover, bar grows to 4px and background switches to `var(--accent)` (`transition: 0.15s`).
- `onMouseDown`: set `cursor: col-resize` + `userSelect: none` on `document.body`, register `mousemove`/`mouseup` on `window`. On `mousemove`, call `onDrag(e.clientX, containerRect)`.
- `onDoubleClick`: call `onReset()`.
- Keyboard: when the splitter has focus, `ArrowLeft`/`ArrowRight` → `onNudge(±1, 'small')`, `Shift+Arrow` or `Home`/`End` → `onNudge(±1, 'large')`, `Enter`/`Space` → `onReset()`.
- `role="separator"`, `aria-orientation="vertical"`, `aria-label`, `aria-valuenow/min/max`, `tabIndex={0}`.
- The container ref is *not* owned by the splitter — the parent passes the bounding rect on each drag (via `getBoundingClientRect()`) so the splitter does not need to know about its parent's DOM.

Migrate [Capture.tsx](../../frontend/src/pages/Capture.tsx) to use this component in the same PR so the new API is exercised by both callers. Capture continues to use percent-based widths internally; the splitter is value-agnostic.

### 2. New module — `frontend/src/state/replayLayout.ts`

Small zustand slice. Lives alongside [state/tabs.ts](../../frontend/src/state/tabs.ts) and [state/viewport.ts](../../frontend/src/state/viewport.ts).

```ts
const SIDEBAR_PX_DEFAULT = 320;   // matches --sidebar-w base intent (16rem @ 20px root = 320px)
const SIDEBAR_PX_MIN = 240;
const SIDEBAR_PX_MAX = 520;
const STORAGE_KEY = 'replay.layout';

type Persisted = { sidebarPx: number; sidebarCollapsed: boolean };

type ReplayLayoutState = Persisted & {
  setSidebarPx: (px: number) => void;     // clamped to [MIN, MAX]
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  resetSidebar: () => void;               // restores SIDEBAR_PX_DEFAULT and uncollapses
};
```

- On store init, attempt `JSON.parse(localStorage.getItem(STORAGE_KEY))`. Validate types and clamp `sidebarPx` to `[MIN, MAX]`. Any error → defaults.
- A subscriber persists the full `Persisted` snapshot to localStorage on every change. Wrap in `try/catch` (SSR / privacy mode parity with `forceRetryDefault.ts`).
- Width is **px**, not percent. Sidebar readability has absolute thresholds (font sizes, column counts in OrderbookTable) so px is the natural unit. Capture keeps percent internally; the shared splitter is unit-agnostic.

### 3. Workarea layout — modify [frontend/src/replay/Workarea.tsx:99-108](../../frontend/src/replay/Workarea.tsx#L99-L108)

Replace the static grid with a layout that responds to store state:

```tsx
const sidebarPx = useReplayLayoutStore((s) => s.sidebarPx);
const collapsed = useReplayLayoutStore((s) => s.sidebarCollapsed);
const containerRef = useRef<HTMLDivElement>(null);

const gridTemplateColumns = collapsed
  ? '1fr'
  : `1fr 12px ${sidebarPx}px`;

return (
  <div
    ref={containerRef}
    style={{ gridTemplateColumns }}
    className="grid gap-0 p-2 flex-1 min-h-0 relative"
  >
    <ChartErrorBoundary>
      <ChartStage key={…} bundle={…} axis={axis} />
    </ChartErrorBoundary>
    {!collapsed && (
      <>
        <VerticalSplitter
          ariaLabel={`사이드바 폭 조정 (현재 ${sidebarPx}px)`}
          ariaValueNow={sidebarPx}
          ariaValueMin={240}
          ariaValueMax={520}
          onDrag={(clientX) => {
            // Closure-captured containerRef — splitter doesn't know about us.
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            // chart is `1fr`, sidebar is `<sidebarPx>px`, splitter is `12px`.
            // The sidebar's left edge sits at: rect.right - sidebarPx.
            // We want sidebar's left edge = clientX + 6 (center of splitter track).
            const next = rect.right - clientX - 6;
            useReplayLayoutStore.getState().setSidebarPx(next);
          }}
          onReset={() => useReplayLayoutStore.getState().resetSidebar()}
          onNudge={(dir, mag) => {
            const step = mag === 'small' ? 8 : 40;
            useReplayLayoutStore
              .getState()
              .setSidebarPx(sidebarPx - dir * step); // -dir because shrinking sidebar = arrow right
          }}
        />
        <CursorSidebarConnected axis={axis} />
      </>
    )}
    {collapsed && <CollapsedSidebarHandle />}
  </div>
);
```

Note on the arrow-key direction: dragging the splitter **right** *shrinks* the sidebar (chart grows). For keyboard parity, `ArrowRight` shrinks the sidebar and `ArrowLeft` grows it. The `onNudge` callback's `direction` parameter is splitter-direction (+1 = right), and the parent translates to width-direction.

### 4. New module — `frontend/src/replay/CollapsedSidebarHandle.tsx`

Floating affordance shown when the sidebar is collapsed.

```tsx
export default function CollapsedSidebarHandle() {
  const expand = () => useReplayLayoutStore.getState().setSidebarCollapsed(false);
  return (
    <button
      type="button"
      onClick={expand}
      aria-label="사이드바 보이기"
      aria-expanded={false}
      aria-controls="replay-sidebar"
      className="absolute right-0 top-1/2 -translate-y-1/2 …"
      // Visual: 12px wide × 60px tall, bg-bg-card border, accent on hover, ◀ chevron
    >
      ◀
    </button>
  );
}
```

- Positioned `absolute right-0 top-1/2` inside the (now `relative`) grid container.
- Stays discoverable without occupying grid track space.
- Keyboard reachable (button, not a div).

### 5. Toolbar toggle — modify [frontend/src/replay/Toolbar.tsx](../../frontend/src/replay/Toolbar.tsx)

Add a single icon button at the right end of the toolbar that toggles the sidebar.

- When `!collapsed`: shows `▶` (hide), `aria-label="사이드바 숨기기"`, `aria-expanded={true}`.
- When `collapsed`: shows `◀` (show), `aria-label="사이드바 보이기"`, `aria-expanded={false}`.
- `aria-controls="replay-sidebar"` on both. The `id="replay-sidebar"` lives on the `<CursorSidebarConnected>` `<aside>` (add to [CursorSidebar.tsx:51](../../frontend/src/sidebar/CursorSidebar.tsx#L51)).
- Reading `collapsed` and calling `toggleSidebar()` from the store.

The Toolbar toggle and the floating handle are **two entry points** to the same action:
- Toolbar toggle: discoverable, lives next to other controls. Primary affordance.
- Floating handle: in-context reminder that the sidebar still exists. Secondary affordance, only visible when collapsed.

Both are intentional. Removing either weakens discoverability — when the sidebar is hidden, a new user scanning the workarea has no way to know it's recoverable without the floating handle; when the sidebar is visible, the Toolbar is where users expect global view controls.

### 6. Sidebar `<aside>` — modify [frontend/src/sidebar/CursorSidebar.tsx:51](../../frontend/src/sidebar/CursorSidebar.tsx#L51)

- Add `id="replay-sidebar"` to the `<aside>` for the `aria-controls` wiring.
- Remove the `w-sidebar` class. The sidebar's width is now governed by its grid track (parent's `gridTemplateColumns`), not by an intrinsic width. The `--sidebar-w` token remains as the *default* width that `state/replayLayout.ts` seeds into `SIDEBAR_PX_DEFAULT`.

### 7. DESIGN.md update

Add one paragraph under the layout section noting that:
- `--sidebar-w` is the default width seed for the `/replay` cursor sidebar.
- Runtime width is owned by `state/replayLayout.ts` (px, persisted to localStorage as `replay.layout`).
- The sidebar may be collapsed via the Toolbar toggle, in which case the chart fills the workarea and a small handle appears at the right edge.

## Data flow

```
                    ┌──────────────────────────────────────┐
                    │   localStorage: 'replay.layout'      │
                    │   { sidebarPx, sidebarCollapsed }    │
                    └──────────────┬───────────────────────┘
                                   │ (rehydrate on store create,
                                   │  persist on every change)
                                   ▼
                    ┌──────────────────────────────────────┐
                    │   useReplayLayoutStore (zustand)     │
                    └──┬──────────────┬────────────────┬───┘
                       │              │                │
                       │ subscribe    │ subscribe      │ subscribe
                       ▼              ▼                ▼
                  Workarea       Toolbar toggle   CollapsedSidebarHandle
                  (renders grid) (renders icon)   (renders only if collapsed)
                       │              │                │
                       │ setSidebarPx │ toggleSidebar  │ setSidebarCollapsed(false)
                       └──────┬───────┴────────────────┘
                              ▼
                       store.setSidebarPx (clamps to [240, 520])
                       store.setSidebarCollapsed
                       store.resetSidebar
```

## Edge cases

- **localStorage unavailable** (privacy mode, SSR): the store falls back to defaults; all writes silently fail. Matches existing pattern in [frontend/src/capture/forceRetryDefault.ts](../../frontend/src/capture/forceRetryDefault.ts).
- **Corrupt stored value** (NaN, out of range, wrong type): clamp + sanitize on load. Defaults if parse throws.
- **Viewport narrower than `SIDEBAR_PX_MIN + ~200px chart`**: not a concern for the desktop target. The chart's container has `min-h-0 min-w-0` so it tolerates being squished; in practice the user is not running this at sub-tablet widths.
- **Dragging splitter past the window edge** (mouse leaves the viewport): `mousemove` keeps firing as long as the button is held; `clientX` may go negative. The clamp in `setSidebarPx` handles this — sidebar pins to MAX (or MIN, depending on side).
- **Sidebar collapsed when Toolbar mounts**: Toolbar reads `collapsed` from the store on every render, no special-casing needed.
- **Chart resize**: `ChartStage` uses `autoSize: true` ([frontend/src/chart/ChartStage.tsx:160](../../frontend/src/chart/ChartStage.tsx#L160)) and overlays (`DayBoundaryOverlay`, `AuctionWindowOverlay`, `VolumeProfileOverlay`) use ResizeObserver. No chart-side changes needed.
- **Storage write thrash during drag**: `mousemove` fires at ~60Hz, each write hits localStorage. If profiling later shows this is a problem, throttle writes (commit on `mouseup`) — but ship without throttling first to keep code simple. Capture.tsx has shipped without throttling for months without complaint.

## Testing

New tests (Vitest + RTL):

- `frontend/src/layout/VerticalSplitter.test.tsx`
  - Renders with correct ARIA attributes.
  - `onMouseDown` followed by `mousemove`/`mouseup` calls `onDrag` with `(clientX, rect)` arguments.
  - `onDoubleClick` calls `onReset`.
  - Arrow keys call `onNudge` with `('small' | 'large')` magnitude.
  - `tab` reaches the splitter (focusable).

- `frontend/src/state/replayLayout.test.ts`
  - Defaults applied when localStorage is empty.
  - Round-trip: write px, read px back from new store instance.
  - `setSidebarPx` clamps below MIN and above MAX.
  - Corrupt JSON in localStorage → defaults (no throw).
  - `resetSidebar` restores defaults and uncollapses.

- `frontend/src/replay/Workarea.test.tsx` — extend existing tests
  - With `collapsed=false`, sidebar renders and splitter is present.
  - With `collapsed=true`, sidebar is unmounted and `CollapsedSidebarHandle` is present.
  - Clicking the handle calls `setSidebarCollapsed(false)`.
  - Splitter drag updates `sidebarPx` via the store.

- `frontend/src/replay/Toolbar.test.tsx` — extend existing tests
  - Toggle button shows correct icon and `aria-expanded` based on store state.
  - Click toggles the store.

- Migration check: existing Capture splitter tests (if any) continue to pass after migrating to `VerticalSplitter`.

## Files touched

**New:**
- `frontend/src/layout/VerticalSplitter.tsx`
- `frontend/src/layout/VerticalSplitter.test.tsx`
- `frontend/src/state/replayLayout.ts`
- `frontend/src/state/replayLayout.test.ts`
- `frontend/src/replay/CollapsedSidebarHandle.tsx`

**Modified:**
- `frontend/src/replay/Workarea.tsx` — dynamic grid, splitter integration, collapsed handle
- `frontend/src/replay/Toolbar.tsx` — add sidebar toggle button
- `frontend/src/sidebar/CursorSidebar.tsx` — add `id="replay-sidebar"`, drop `w-sidebar` class
- `frontend/src/pages/Capture.tsx` — migrate to `VerticalSplitter` component
- `frontend/src/replay/Workarea.test.tsx` — extend
- `frontend/src/replay/Toolbar.test.tsx` — extend
- `DESIGN.md` — note runtime sidebar width ownership

## Open questions

None. Decisions captured:
- Collapse unit: **whole sidebar** (user-confirmed).
- Collapsed display: **fully removed + small floating handle** (user-confirmed).
- Entry points: **Toolbar toggle + floating handle** (both, for discoverability).
- Width range: **240–520px**, default 320px.
- Persistence scope: **global** (not per-tab).
- Splitter logic location: **extracted to `frontend/src/layout/VerticalSplitter.tsx`** and migrated Capture in the same PR.
