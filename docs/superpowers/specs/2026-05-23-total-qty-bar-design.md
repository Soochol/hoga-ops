# Total Quantity Bar — Design

**Date:** 2026-05-23
**Component:** `TotalQtyBar` (총잔량 바)
**Status:** Design approved, ready for implementation plan

## Goal

Add a slim horizontal 100% stack bar to the replay-viewer sidebar that shows the proportion of total ask quantity (left, blue) versus total bid quantity (right, red) at the current cursor — summed across the 10 orderbook levels per Korean HTS convention.

The bar complements the existing time-series `quote_totals` pane: that pane shows how `bid_total` / `ask_total` evolved over the session as lines, while `TotalQtyBar` answers "at this exact cursor, who has more?" as a single instant visual.

## Placement

Lives inside `CursorSidebar` as a direct sibling of `OrderbookTable`, immediately below it. Order in the sidebar:

1. `OrderbookTable`
2. **`TotalQtyBar`** (new)
3. `BrokerNetTable`
4. `FillTape`

A 1px `--border-strong` divider sits between the orderbook and the bar to mark the boundary between per-level depth and aggregate.

`TotalQtyBar` is a sibling, not a child of `OrderbookTable`. `OrderbookTable` stays a pure per-level renderer with a single `snapshot` prop; the new aggregate view is composed at the sidebar level.

## Visual

A divergent 100% stack: the total bar width is constant, and only the boundary between the ask (blue, left) and bid (red, right) regions moves.

```
┌─ Sidebar (320px) ─────────────────────────────┐
│ 52,900            2,180                       │  <- last bid row
├───────────────────────────────────────────────┤  <- 1px --border-strong
│ 12,840  ▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒  18,220            │  <- TotalQtyBar (~22px)
├───────────────────────────────────────────────┤
│ Broker Net …                                  │
```

All px values below are **base intent (1.0×)** per `DESIGN.md` conventions; default rendering at 1.25× scales them uniformly.

- Total component height: ~22px — matches one orderbook row at the same density
- Bar height: 10px (`h-2.5` = 0.625rem)
- Bar container border: 1px `--border-strong`, `--bg-subtle` background
- Bar container border-radius: 2px
- Left flank: ask total in `text-price-down` (blue), right-aligned, width sized to fit a 6-digit comma-formatted number (`min-w` token)
- Right flank: bid total in `text-price-up` (red), left-aligned, same width treatment as left
- Gap between flanks and bar: `gap-2.5` (10px)
- Center hairline: 1px `rgba(255,255,255,0.18)` between the two color regions inside the bar

### Color tokens

No new design tokens. Existing tokens only:

- Ask side fill: `rgba(37,99,235,0.55)` (inline alpha on `--price-down` base color)
- Bid side fill: `rgba(220,38,38,0.55)` (inline alpha on `--price-up` base color)
- Flank text colors: `text-price-down`, `text-price-up`
- Container chrome: `--bg-subtle`, `--border-strong`

The existing `--tint-price-up` / `--tint-price-down` tokens (10% alpha) are intentionally not used — they are calibrated as _background_ tints behind the orderbook depth bars, too weak to carry a foreground 100% stack. The 0.55 alpha is inline; if other components later need the same strength a `-strong` variant token can be added then.

### Scale dial compatibility

All sizes are rem-based per `DESIGN.md` Scale Factor rules. The component renders correctly at any `:root font-size`. The 1px borders and the inner hairline stay in px (per `DESIGN.md`: hairlines stay in px to protect anti-aliasing).

## Data

Source: the same `OrderbookSnapshot` that `OrderbookTable` already consumes from `CursorSidebar`. Both components receive the same prop, so they always agree.

Computation, client-side and memoized:

```ts
function computeTotals(snapshot: OrderbookSnapshot) {
  const askTotal = snapshot.ask.reduce((s, l) => s + l.qty, 0);
  const bidTotal = snapshot.bid.reduce((s, l) => s + l.qty, 0);
  const total = askTotal + bidTotal;
  const askPct = total > 0 ? askTotal / total : 0.5;
  const bidPct = total > 0 ? bidTotal / total : 0.5;
  return { askTotal, bidTotal, askPct, bidPct };
}
```

Why not consume `RangeBundle.quote_ratio.points`? That series is bucketed (typically 1s or 1min). The cursor lands at an exact moment that may not align with a bucket boundary, so the bucketed `bid_total` / `ask_total` would not match what `OrderbookTable` shows above. Summing the snapshot guarantees consistency with the table.

The backend definition matches: `hoga/api/bundle.py:123-125` already defines `bid_total` / `ask_total` as `q1 + q2 + … + q10`. Same semantics, different point of computation.

## Edge cases

- **`snapshot === undefined`** (loading): render `null`. `OrderbookTable` already shows "커서 위치 로딩 중…" above, no need to duplicate state.
- **`snapshot === null`** (no data at cursor): render `null`. Same reasoning.
- **`askTotal === 0 && bidTotal === 0`**: render the container with both flank numbers showing `0` and an empty bar (no color fills, only `--bg-subtle` background and `--border-strong` border). This is a guard for a near-impossible state.
- **One side zero**: handled naturally by the 100% stack — the non-zero side fills the full bar width.
- **Extreme ratios (e.g. 1:99)**: the minority side remains visible as a thin colored segment inside the bar. At a 320px sidebar with ~200px bar width, even 1% renders as ~2px — still detectable.
- **Auction Window**: respects the per-tab `auctionWindowMask` setting from `SettingsModal`.
  - Cursor outside Auction Window OR `auctionWindowMask === false`: render normally.
  - Cursor inside Auction Window AND `auctionWindowMask === true`: hide only the bar fills (keep the container chrome and the absolute qty flank numbers visible). Add a small `text-fg-dimmer` "Auction" annotation inside the empty container.

  Rationale comes straight from `CONTEXT.md`: during an Auction Window, raw snapshot quantities render continuously (they're the signal), but _derived ratios_ from those quantities read as misleading extremes and the `RatioPane` masks them. `TotalQtyBar`'s 100% stack is a ratio visualization, so it follows the same rule.

If the Auction Window helper is currently inlined inside `frontend/src/chart/projectors/ratio.ts`, extract it to a shared module (e.g. `frontend/src/util/auctionWindow.ts`) and import it from both call sites. If it's already shared, just reuse.

## Accessibility

- Wrapper element: `role="group"` with `aria-label="총잔량"`.
- Ask total span: `aria-label="매도총잔량 ${askTotal}"`.
- Bid total span: `aria-label="매수총잔량 ${bidTotal}"`.
- Bar itself is decorative — no `aria-*` attributes, screen readers receive the numeric values via the labeled spans.

## Component contract

`TotalQtyBar` is a pure presentation component. Three props, all resolved by `CursorSidebar`:

```ts
type Props = {
  snapshot: OrderbookSnapshot | null | undefined;
  segment: BundleSegment | null;        // active segment from RangeBundle, carries session_open_ms / session_close_ms
  auctionWindowMask: boolean;            // from ChartPrefsContext / SettingsModal, per-tab
};
```

The component receives no context, no hooks beyond `useMemo` for the totals computation, and no router or store access. All state needed for the Auction Window decision is passed in, which keeps the component trivially testable and the render path explicit.

`CursorSidebar` is responsible for wiring `segment` and `auctionWindowMask` from its existing sources alongside the already-wired `snapshot`.

## Files touched

- **New**: `frontend/src/sidebar/TotalQtyBar.tsx` — component
- **New**: `frontend/src/sidebar/TotalQtyBar.test.tsx` — Vitest unit and integration tests
- **Modified**: `frontend/src/sidebar/CursorSidebar.tsx` — insert `TotalQtyBar` after `OrderbookTable` with the divider
- **Possibly modified**: `frontend/src/chart/projectors/ratio.ts` — extract Auction Window helper if inlined; new file `frontend/src/util/auctionWindow.ts` if extraction is needed

No backend changes. No API changes. No `DESIGN.md` token table changes.

## Test plan

Vitest, alongside the existing sidebar test patterns.

1. **`computeTotals` pure function**
   - Normal snapshot: returns sums matching backend's `bid_total` / `ask_total` definition
   - Both sides zero: `askPct = bidPct = 0.5` (guard against divide-by-zero)
   - One side zero: other side gets `1.0`
2. **Component render**
   - `snapshot === undefined` → renders `null`
   - `snapshot === null` → renders `null`
   - Normal snapshot → left flank shows ask total in `text-price-down`, right flank shows bid total in `text-price-up`, bar grid-template-columns matches the computed ratio
   - Extreme ratio (1:99) → grid-template-columns reflects the ratio precisely
3. **Auction Window integration**
   - Cursor outside Auction Window + mask=true → bar fills render
   - Cursor inside Auction Window + mask=true → bar fills hidden, container chrome and flank numbers remain, "Auction" annotation present
   - Cursor inside Auction Window + mask=false → bar fills render normally
4. **Accessibility**
   - `role="group"` with `aria-label="총잔량"` present on wrapper
   - Both flank spans carry the expected `aria-label`

## Non-goals

Out of scope for this work, listed so the implementation plan does not drift:

- No transition or animation on data change. `DESIGN.md` Motion section: "numbers snap, no tween — analysts want exact values not gradients."
- No hover tooltip. The two flank numbers already carry the absolute values.
- No time-series sparkline above the bar. The existing `quote_totals` pane fulfills that role.
- No user-configurable depth (always 10 levels). The wire shape (`ApiOrderbookSnapshot.ask` and `.bid` arrays of length 10) fixes this.
- No light-mode styling. `DESIGN.md` v1 is dark-only.
- No new design tokens. The 0.55 alpha is inline; tokenize later if a second component needs the same strength.

## Definition of done

- `npm run test` passes
- `npm run typecheck` passes
- Browser verification: bar appears below the orderbook at the chosen sidebar position, updates as the cursor moves, masks correctly when the Auction Window toggle in `SettingsModal` flips, and reads the expected numbers at three sampled cursor positions (mid-session, opening auction, closing auction).

## Decisions log

| Decision | Rationale |
|---|---|
| 100% stack (option B) over shared-max divergent (option A) | User selected B. The bar always fills its width; the divider moves. Absolute quantities are carried by the flank numbers, ratio is carried by the bar. Role separation between bar and numbers. |
| Place below `OrderbookTable` (option C), not above or inside the spread divider | Matches Korean HTS convention where total quantities appear as a footer summary after the 10-level table. |
| Sibling in `CursorSidebar`, not child of `OrderbookTable` | Keeps `OrderbookTable` a pure per-level renderer; composition lives at the sidebar level. |
| Sum the `OrderbookSnapshot` client-side instead of consuming `quote_ratio.points` | The snapshot is the exact cursor moment; `quote_ratio.points` is bucketed and may not align with the cursor. |
| Inline 0.55 alpha, no new tokens | Existing `--tint-price-*` tokens at 10% alpha are too weak for a foreground 100% stack; new tokens would expand the system surface for one use. YAGNI until a second component needs the same strength. |
| Respect `auctionWindowMask` toggle | `CONTEXT.md`: derived ratios are masked during Auction Windows; `TotalQtyBar` is a ratio visualization, so it follows the same rule. |
