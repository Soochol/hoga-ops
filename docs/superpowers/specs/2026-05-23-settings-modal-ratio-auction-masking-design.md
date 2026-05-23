# Settings Modal + Ratio Pane Auction Masking

**Date**: 2026-05-23
**Status**: Approved (in-conversation; superseded by user review of this file)
**Scope**: `frontend/src/replay/SettingsModal.tsx` (new), `frontend/src/replay/Toolbar.tsx`, `frontend/src/state/tabs.ts`, `frontend/src/chart/RatioPane.tsx`

## Problem

The Replay Viewer's bid/ask imbalance ratio (호가비) goes nonsensical during the closing **Auction Window** (15:20–15:30 KST). KRX pauses continuous matching for ten minutes before the close so orders can accumulate for the single 15:30 cross; during that window `ask_total / bid_total` whips to extreme one-sided values that don't reflect continuous-trading sentiment. The spike also dominates the BaselineSeries autoscale and crushes the rest of the day's signal into a flat horizontal band.

The mirror window 15:30–16:00 (After-Hours Trading) has the same distortion in principle, but the existing `axis.contains` filter already drops those points before they reach the chart (segments end at `sessionCloseMs = 15:30`). No fix needed there.

The user wants the auction band's values **zeroed (not dropped)** so the line falls cleanly to the 0 baseline during the band, and they want the behavior **controlled by a toggle** that lives inside a new **Settings modal** — a generic settings hub that's expected to grow more controls over time.

## Goals

- Ratio line shows `value = 0` for any point with `ts_ms >= sessionOpenMs + 6h20m`, gating on a user-controlled toggle.
- Default toggle state: **ON** (auction masked by default). User decision during planning.
- Toggle scope: **per-tab** via `ChartViewPrefs` — mirrors the existing `volumeProfileMode` pattern at `frontend/src/state/tabs.ts`. New tab inherits the default.
- A Settings modal is reachable from the Replay toolbar via a gear button placed immediately right of the timeframe selector.
- Modal layout: centered fixed overlay, **left sidebar (categories) + right content (controls)**. First (and currently only) category is "차트"; first (and currently only) control is the auction-masking toggle.
- Modal closes via Escape, backdrop click, and an explicit `닫기` button.
- Toggle changes persist immediately to the store (no save button) — matches the `CursorSidebar` `volumeProfileMode` live-write pattern at `frontend/src/sidebar/CursorSidebar.tsx:42-71`.

## Non-Goals

- **No `persist` middleware** on the tabs store this round. Prefs reset on page refresh (current behavior). Cross-refresh persistence is a backlog item.
- **No global settings store** — per-tab only, consistent with existing pattern.
- **No multi-category sidebar yet** — the "차트" item is the only one. Sidebar structure is in place so future controls don't require a layout rewrite, but no placeholder "(future)" items.
- **No keyboard-driven category navigation** (arrow keys between sidebar items). Click-only this round.
- **No backend changes.** `build_quote_ratio_slice` continues to emit auction-band points; the frontend gates them.
- **No effect on Candle pane** — its existing auction muting (gray color) is unchanged and unrelated.

## Design

### Data gate (RatioPane.tsx)

Mirror `CandlePane.tsx:65`'s precedent. Inside the existing `useEffect`, after `resolveTokens`, read the per-tab `auctionZeroing` flag and gate the `value` field of each mapped point:

```ts
const AUCTION_WINDOW_OFFSET_MS = (6 * 3600 + 20 * 60) * 1000;

const activeTabId = useTabsStore((s) => s.activeTabId);
const auctionZeroing = useTabsStore((s) => s.getPrefs(activeTabId).auctionZeroing);

const data = bundle.quote_ratio.points
  .filter((p) => axis.contains(p.t))
  .map((p) => {
    const segIdx = axis.findByReal(p.t);
    const seg = axis.segments[segIdx];
    const inAuctionOrAfter = p.t >= seg.sessionOpenMs + AUCTION_WINDOW_OFFSET_MS;
    return {
      time: (axis.toVirtual(p.t) / 1000) as any,
      value: auctionZeroing && inAuctionOrAfter
        ? 0
        : quoteImbalance(p.bid_total, p.ask_total),
    };
  });
```

The `axis.contains` filter already guarantees `findByReal` returns a valid segment index, so no defensive `if (segIdx < 0)` is needed. Reading `auctionZeroing` from inside the component via the `useTabsStore` selector causes the `useEffect` to re-run on toggle change (the selector is referenced as a dep), so the chart re-paints without a manual refresh.

### State (tabs.ts)

Extend `ChartViewPrefs` with `auctionZeroing: boolean`, default `true`. Add `setAuctionZeroing(id, enabled)` action mirroring the shape of the existing `setVolumeProfileMode`:

```ts
export type ChartViewPrefs = {
  volumeProfileMode: 'range' | 'per-day';
  auctionZeroing: boolean;
};
const DEFAULT_PREFS: ChartViewPrefs = {
  volumeProfileMode: 'range',
  auctionZeroing: true,
};
// + setAuctionZeroing(id: string, enabled: boolean): void
```

### Toolbar gear button

In `frontend/src/replay/Toolbar.tsx`, add a local `useState<boolean>(false)` for `settingsOpen` and inject one button immediately after `<TimeframeSelector />`, before the `flex-1` spacer:

```tsx
<button
  type="button"
  aria-label="설정"
  onClick={() => setSettingsOpen(true)}
  className="px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg border border-border rounded"
>
  ⚙
</button>
{settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
```

Style matches the inactive timeframe button style (`px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg`) so the gear sits naturally in the row's visual rhythm.

### SettingsModal component

New file `frontend/src/replay/SettingsModal.tsx`. Shape:

```
┌─────────────────────────────────────────────────┐
│ 설정                                          ✕ │  header  (border-b border-border, p 12/16)
├──────────────┬──────────────────────────────────┤
│              │                                  │
│ ▌ 차트       │  차트                              │  sidebar 180px, content flex-1
│              │  ──────────────────────────       │
│              │                                  │
│              │  호가비 동시호가 마스킹              │  toggle row (flex justify-between
│              │  15:20–15:30 KST 호가비를      ●─│ │   items-center py-2)
│              │  0 으로 처리합니다.                 │
├──────────────┴──────────────────────────────────┤
│                                       [ 닫기 ]  │  footer (border-t border-border)
└─────────────────────────────────────────────────┘
                modal ~640px × ~440px
                position: fixed; inset: 0; z-index: 60
                backdrop: bg-black/50
```

Detailed style tokens (all from DESIGN.md / `tokens.css`):

| Element | Style |
|---|---|
| Backdrop | `position: fixed; inset: 0; bg-black/50; flex items-center justify-center; z-[60]` |
| Modal card | `bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[640px] max-w-[90vw]` |
| Header | `flex items-center justify-between px-4 py-3 border-b border-border`, title `text-fg text-base font-medium`, close `text-fg-dim hover:text-fg` |
| Sidebar | `w-[180px] py-2 border-r border-border` |
| Sidebar item | base `px-4 py-2 text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg cursor-pointer`. Active adds `bg-bg-input text-fg font-medium border-l-2 border-accent` (mirror `replay/Tab.tsx:20`) |
| Content | `flex-1 px-5 py-4` |
| Content section heading | `text-fg text-base font-medium pb-2 mb-2 border-b border-border` |
| Toggle row | `flex items-center justify-between py-2` |
| Toggle label | title `text-fg text-sm`, description `text-fg-dim text-xs mt-0.5` |
| Switch | 36×20 px rounded-full, ON `bg-accent`, OFF `bg-bg-input-hover`. Inner slider 16×16 px `bg-fg` (or `bg-accent-fg` when ON), animated `transform: translateX(0 → 16px)` over 150ms. `aria-pressed` carries the boolean. |
| Footer | `flex justify-end px-4 py-3 border-t border-border`, close button `px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded` |

Interaction:

- **Escape** — `document.addEventListener('keydown', ...)` registered while the modal is mounted, removed on cleanup. Mirrors `frontend/src/capture/SymbolSearch.tsx:117` and `frontend/src/replay/StockCombobox.tsx:71`.
- **Backdrop click** — onClick on the backdrop element (outside the card) calls `onClose`. Card's `onClick` stops propagation so clicks inside don't dismiss.
- **Close button (header ✕ and footer 닫기)** — both call `onClose`.
- **Toggle change** — calls `useTabsStore.setAuctionZeroing(activeTabId, !current)` immediately. No "save" / "apply" button.
- **No focus trap this round.** Sufficient for v1; revisit if a screen-reader audit demands it.

### Z-index audit

- `z-10`: in-chart overlays (`DayBoundaryOverlay`).
- `z-50`: dropdowns (`DateRangePicker`, `StockCombobox`, `SymbolSearch`).
- `z-60`: modal (this work). Higher than dropdowns so a dropdown that happens to be open when the gear is clicked doesn't poke through.

## Testing

- **Unit (RatioPane)** — extend `frontend/tests/component/RatioPane.test.tsx`. Add a case mirroring the existing "drops pre-open auction points" test (around lines 46–77): fixture with one normal-band point and one auction-band point, mock `useTabsStore` to return `{ auctionZeroing: true }`, assert the auction point's `value === 0` and the normal point's `value` matches `quoteImbalance(...)`. Add a second case with `auctionZeroing: false` to verify the gate honors OFF.
- **Unit (SettingsModal)** — new file `frontend/src/replay/SettingsModal.test.tsx`. Cover: renders when open, calls `onClose` on Escape / backdrop click / close button, toggle change invokes the store action with the correct args, toggle's `aria-pressed` reflects the store state.
- **Unit (Toolbar)** — extend `frontend/src/replay/Toolbar.test.tsx` if it exists, else create one focused on the new button. Assert the gear button is present, clicking it shows the modal (queried by `role="dialog"` or the `설정` text), closing the modal hides it.
- **Type check** — `cd frontend && npx tsc -b` clean.
- **Visual (`browse` skill)** — load `/replay?tabs=003490:20260519:20260520:1m&active=0`, click the gear, confirm:
  - Modal centers on screen with "차트" sidebar item active and the auction-zeroing toggle reading ON.
  - Ratio pane's 15:20–15:30 spike (previously dominating the autoscale) is gone — the line drops flat to the 0 baseline at the end of each day.
  - Toggle to OFF: the spike reappears, confirming the gate works in both directions.
  - Escape, backdrop click, and 닫기 button all close the modal.

## Risks

- **`useEffect` dep on `auctionZeroing`** — adding the new selector value to the existing `useEffect` deps array will cause one extra re-mount of the BaselineSeries when the toggle flips. Acceptable: the user expects a visible change on toggle, and the cleanup/unmount path is already exercised on bundle/axis changes.
- **`activeTabId` may not be set during first render** — `getPrefs` falls back to `DEFAULT_PREFS` (which has `auctionZeroing: true`), so the default behavior is masked. No null-guard needed in RatioPane.
- **Modal accessibility** — no focus trap means Tab key can wander out of the modal. Acceptable for v1; if a screen-reader user files a complaint, add `react-focus-lock` or equivalent in a follow-up.
- **Refresh resets prefs** — by design (no `persist` middleware). Spec calls this out so the user isn't surprised.

## Out of Scope (Backlog)

- `persist` middleware on the tabs store (cross-refresh persistence).
- Global (cross-tab) settings.
- Focus trap inside the modal.
- Keyboard navigation between sidebar items.
- Backend opt-in to drop auction points (would change the protocol; not worth the complexity for a frontend visual concern).
- A separate setting for the 15:30–16:00 after-hours band (already filtered out today).
