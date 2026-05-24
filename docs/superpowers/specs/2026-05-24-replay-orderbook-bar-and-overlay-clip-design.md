# Replay Viewer — Orderbook Depth Bar Restoration + Chart Overlay Clip

**Date:** 2026-05-24
**Status:** Design approved, ready for plan
**Author:** brainstorm w/ user
**Scope:** Two surgical fixes on `/replay` — depth bar visibility in the 10호가 card, and a date-boundary line leak from the chart overlay layer into the sidebar.

## Problem

### P1 — 10호가 depth bars are nearly invisible

`OrderbookTable` renders a per-row depth bar behind the qty column. The current implementation paints a **flat 10% alpha** rectangle using `--tint-price-up` / `--tint-price-down`:

```tsx
// frontend/src/sidebar/OrderbookTable.tsx:71-78
<span
  className={`absolute inset-y-0 left-0 ${barClass}`}  // bg-tint-price-up | bg-tint-price-down
  style={{ width: `${widthPct}%` }}
/>
```

Against the `#0E0E14` card background the bars read as nearly black. The approved mockup (`docs/superpowers/designs/2026-05-20-replay-viewer.html` lines 379-384) renders them noticeably stronger and with a directional fade:

```css
.ob .bar      { position: absolute; top:1px; bottom:1px; right:0;
                background: linear-gradient(to left, rgba(37,99,235,0.18), rgba(37,99,235,0)); }
.ob .bar-bid  { background: linear-gradient(to left, rgba(220,38,38,0.18), rgba(220,38,38,0)); }
```

Three concrete differences vs. the live code:

| Aspect | Live | Mockup |
|---|---|---|
| Peak alpha | 0.10 | **0.18** |
| Fill | flat | **linear-gradient → 0** on the inside edge |
| Anchor | `left: 0` (bar grows from price side) | **`right: 0`** (bar grows from qty side inward) |

The mockup's intent: bars start from the qty column and fade toward the price column, communicating "this much pressure pushes in toward price."

A single token (`--tint-price-up/down`) is doing two jobs today — chip backgrounds (where 10% flat is correct) **and** depth bars (where it's wrong). Fixing the bars without touching chips means introducing a separate bar-specific token.

### P2 — Date-boundary lines bleed into the 10호가 card

Workarea layout:

```
Workarea  grid-cols [1fr | var(--sidebar-w)]
├─ ChartStage   relative h-full bg-bg-card
│   ├─ <div ref=containerRef> ← lightweight-charts canvas (absolute inset-0)
│   ├─ DayBoundaryOverlay    (absolute inset-0, z-10, pointer-events-none)
│   └─ AuctionWindowOverlay  (absolute inset-0, z-0,  pointer-events-none)
└─ CursorSidebar  grid-rows [2fr | 1fr | 1fr]
   ├─ 10호가  (OrderbookTable + TotalQtyBar)
   ├─ 거래원
   └─ 체결
```

`DayBoundaryOverlay` and `AuctionWindowOverlay` render 1px lines / colored bands by computing `x = chart.timeScale().timeToCoordinate(virtualMs / 1000)` and applying `transform: translateX(${x}px)` (or `left: ${x}px`).

`timeToCoordinate` returns coordinates **even for timestamps outside the currently visible logical range** — it does not return `null` for "off-screen but within data domain." When the user zooms in so that some day-boundaries are virtually present but visually off-screen, `b.x` becomes a value larger than the chart's plot width.

The overlay container is `absolute inset-0` inside `ChartStage`'s outer `<div className="relative h-full min-h-0 bg-bg-card">`. Neither node has `overflow: hidden`. So:

- The lightweight-charts **canvas** clips its own drawing at the canvas edge → off-screen candles do not appear in the sidebar.
- The overlay **DOM nodes** (1px lines, MM/DD chips, auction bands) have no clipping → they render at whatever `translateX(x)` puts them. When `x > containerWidth`, the line appears to the right of the chart, *over the sidebar's 10호가 card*.

Result: the user sees vertical dashed lines and floating MM/DD chips on top of the 10호가 area without the corresponding candles. The layout itself is correct — what's wrong is that overlays escape their stated bounds.

## Goals

1. Depth bars in the 10호가 card match the approved mockup's strength, gradient, and direction.
2. No DOM child of `ChartStage` ever visually escapes the chart cell, regardless of zoom level — at the source, not per-overlay.

## Non-goals

- No refactor of `--tint-price-up/down`. Those keep their 10% flat semantic for chips.
- No change to `BrokerNetTable`, `FillTape`, `TotalQtyBar`, or the chart pane layout.
- No changes to the virtual-axis math or `timeToCoordinate` behavior — we accept that lightweight-charts returns off-screen coordinates and clip at the boundary instead.

## Design

### Fix 1 — New bar-specific gradient tokens, used in `OrderbookTable`

**Token additions** in [frontend/src/styles/tokens.css](frontend/src/styles/tokens.css), near the existing `--tint-*` block:

```css
--bar-ask: linear-gradient(to left, rgba(37, 99, 235, 0.18), rgba(37, 99, 235, 0));   /* 2563EB @ 0.18 → 0 */
--bar-bid: linear-gradient(to left, rgba(220, 38, 38, 0.18), rgba(220, 38, 38, 0));   /* DC2626 @ 0.18 → 0 */
```

Naming follows the existing `--tint-*` family but lives in its own `--bar-*` namespace because **a `background-image` gradient is not interchangeable with a `background-color`**: the only consumer is `OrderbookTable`, so we keep the token un-tailwind-exposed and read it via `var(...)` in inline style. A new Tailwind utility class for a gradient would conflict with Tailwind's own gradient API. Plain CSS var via `style={{ background: 'var(--bar-bid)' }}` is the lowest-noise integration.

**Component change** in [frontend/src/sidebar/OrderbookTable.tsx](frontend/src/sidebar/OrderbookTable.tsx) `Row`:

```tsx
const barBg = side === 'ask' ? 'var(--bar-ask)' : 'var(--bar-bid)';
// ...
<span
  className="absolute inset-y-0 right-0"   // was: left-0 ${barClass}
  style={{ width: `${widthPct}%`, background: barBg }}
/>
```

Two changes in one line:
- `left-0` → `right-0` — anchor flips to match mockup intent.
- `bg-tint-*` className → inline `background: var(--bar-*)` — applies the gradient.

`widthPct` math is unchanged (still normalized across all 20 levels by `maxQty`).

**What is _not_ touched:**
- `--tint-price-up` / `--tint-price-down` definitions (chip backgrounds).
- `bg-tint-price-up` / `bg-tint-price-down` Tailwind utilities (still used elsewhere, e.g., `InvariantOutcomesBanner`).
- `text-price-up` / `text-price-down` (price column color).

### Fix 2 — `overflow-hidden` on the ChartStage container

Single-line change in [frontend/src/chart/ChartStage.tsx:281](frontend/src/chart/ChartStage.tsx#L281):

```tsx
- <div className="relative h-full min-h-0 bg-bg-card">
+ <div className="relative h-full min-h-0 bg-bg-card overflow-hidden">
```

Why at the ChartStage outer div, not at each overlay:

- It catches `DayBoundaryOverlay`, `AuctionWindowOverlay`, and any future overlay added inside `ChartStage` (e.g., crosshair extensions, watermark badges) by one rule — root-cause containment.
- The lightweight-charts canvas is sized to fill this exact container. Its internal axis labels, crosshair labels, and price scale all render *inside* the canvas; clipping at the container edge does not crop them.
- Border-radius is not applied to this node, so `overflow-hidden` has no rendering implication beyond the desired clip.

Per-overlay `overflow-hidden` (the considered alternative) was rejected: it requires remembering to add it on every new overlay and leaves an invisible footgun. A boundary that the user perceives as "the chart area" should be enforced once at the chart area itself.

## Risks & mitigations

- **Risk:** `overflow-hidden` accidentally clips something the chart expects to draw outside its own bounds (e.g., a floating tooltip).
  **Mitigation:** lightweight-charts renders all decorations inside its canvas — nothing currently mounts outside `containerRef`. Our two custom overlays (DayBoundary, AuctionWindow) deliberately stay within the chart area; clipping is the intended behavior. If a future feature needs to escape the chart bounds (e.g., a tooltip portaled to body), it must be portaled, not absolutely positioned inside ChartStage.

- **Risk:** Changing bar anchor from `left:0` to `right:0` flips the visual direction users may have learned.
  **Mitigation:** The mockup is the approved reference. The right-anchored gradient is more readable because the bar's strongest color sits next to the number it modulates (qty column).

- **Risk:** Inline `style={{ background: var(...) }}` bypasses Tailwind purging.
  **Mitigation:** N/A — `var(--bar-*)` resolves at the CSS layer, not Tailwind. The tokens are declared in `tokens.css` which is always loaded.

## Verification

Manual (no automated visual diff in repo today):

1. Load a multi-day range on `/replay` (e.g., 005930, 2026-05-15..2026-05-19).
2. Confirm depth bars in the 10호가 card are visible at small qty (~5% of max) and clearly distinguish ask vs. bid.
3. Confirm bars fade from the qty column toward the price column (right-anchored gradient).
4. Zoom the chart in so a date boundary is virtually off-screen to the right.
5. Confirm no vertical dashed line or MM/DD chip appears on the 10호가 card.
6. Toggle the auction-window mask on; repeat the zoom test for auction bands.

Existing unit tests (`OrderbookTable` — none today, `InvariantOutcomesBanner.test.tsx`, etc.) are unaffected. No new tests added because both fixes are visual-only and the rendering paths have no testable logic branch.

## Out of scope (logged for follow-up if desired)

- Bar saturation in light mode (no light mode in v1).
- A future Compact density toggle (`DESIGN.md` Scale Factor section) would not affect either fix — both use alpha/percent units that scale automatically.
