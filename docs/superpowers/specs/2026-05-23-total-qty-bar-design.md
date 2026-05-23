# Total Quantity Bar — Design

**Date:** 2026-05-23
**Component:** `TotalQtyBar` (총잔량 바)
**Status:** Design approved, ready for implementation plan

## Goal

Add a slim horizontal 100% stack bar to the replay-viewer sidebar that shows the proportion of total ask quantity (left, blue) versus total bid quantity (right, red) at the current cursor — summed across the 10 orderbook levels per Korean HTS convention.

The bar is a spot presentation of **Quote Totals** (the canonical term defined in `CONTEXT.md` for raw `bid_total` + `ask_total` snapshot quantities). It complements the existing time-series `quote_totals` pane: that pane shows how Quote Totals evolved over the session as lines, while `TotalQtyBar` answers "at this exact cursor, who has more?" as a single instant visual.

## Placement

`CursorSidebar` is a 3-row grid of `SidebarCard` wrappers (10호가, 거래원, 체결). `TotalQtyBar` does **not** introduce a fourth card — it lives **inside the existing "10호가" card body**, beneath `OrderbookTable` and separated by a 1px `--border-strong` divider.

```
┌─ SidebarCard label="10호가" ──────────────────┐
│ header: 10호가                                │
│ body:                                         │
│   ├─ OrderbookTable (existing)                │
│   ├─ 1px --border-strong divider              │
│   └─ TotalQtyBar (new)                        │
└───────────────────────────────────────────────┘
```

Composition happens in `CursorSidebarConnected`: the existing `<OrderbookTable snapshot={…} />` is wrapped in a fragment that also includes `<TotalQtyBar … />`, and that fragment is passed as the `orderbook` slot to `CursorSidebar`. `CursorSidebar` itself stays unchanged.

Why inside the card and not a fourth card? The 10호가 card already represents "what the orderbook says at this cursor", and the aggregate total is part of the same answer at a tighter granularity. A fourth card would force a regrid (`grid-rows-[2fr_1fr_1fr]` → 4 tracks) and break the existing space allocation that was tuned for the three cards. Same domain, same card.

`OrderbookTable` stays a pure per-level renderer with a single `snapshot` prop; the new aggregate view is composed alongside it at the connected-sidebar level.

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
- **Closing Auction Window** (15:20:00–15:30:00): respects the per-tab `auctionWindowMask` toggle from `state/tabs.ts` (surfaced in `SettingsModal`).
  - Cursor outside the closing Auction Window OR `auctionWindowMask === false`: render normally.
  - Cursor inside the closing Auction Window AND `auctionWindowMask === true`: hide only the bar fills (keep the container chrome and the absolute qty flank numbers visible). Add a small `text-fg-dimmer` "Auction" annotation inside the empty container.

  The window check uses the existing `VirtualAxis.inClosingAuctionWindow(realMs)` predicate (`frontend/src/util/virtualAxis.ts`), the same one already powering `RatioPane`'s mask. No new helper, no extraction.

  Rationale comes straight from `CONTEXT.md`: during an Auction Window, raw snapshot quantities render continuously (they're the signal), but _derived ratios_ from those quantities read as misleading extremes and the `RatioPane` masks them. `TotalQtyBar`'s 100% stack is a ratio visualization, so it follows the same rule.

- **Opening Auction Window**: not masked. The codebase currently has no opening-auction predicate on `VirtualAxis`; existing `RatioPane` masking is also closing-only. Adding opening-auction masking is a separate, codebase-wide change (predicate first, then both `RatioPane` and `TotalQtyBar` adopt it together) and is **out of scope** for this work to keep mask behavior consistent with what's already shipped.

## Accessibility

- Wrapper element: `role="group"` with `aria-label="총잔량"`.
- Ask total span: `aria-label="매도총잔량 ${askTotal}"`.
- Bid total span: `aria-label="매수총잔량 ${bidTotal}"`.
- Bar itself is decorative — no `aria-*` attributes, screen readers receive the numeric values via the labeled spans.

## Component contract

`TotalQtyBar` is a pure presentation component. Two props:

```ts
type Props = {
  snapshot: OrderbookSnapshot | null | undefined;
  maskRatio: boolean;                  // true → hide bar fills, show "Auction" annotation; numbers always visible
};
```

The parent decides `maskRatio = auctionWindowMask && inClosingAuctionWindow(cursorMs)`. The component receives no context, no hooks beyond `useMemo` for the totals computation, and no store access. All state needed for the masking decision is folded into one boolean prop, which keeps the component trivially testable and the render path explicit.

### Wiring (where the props come from)

`CursorSidebarConnected` is where the wiring lives. It already reads cursor data via `useCursor()` and `useOrderbookAtCursor()`. To compute `maskRatio`, it needs the `VirtualAxis` (for `inClosingAuctionWindow`) and the per-tab `auctionWindowMask` pref.

Changes required to expose the axis:

- `Workarea.tsx` already constructs `axis: VirtualAxis` and passes it to `ChartStage`. Add it as a prop to `CursorSidebarConnected` too: `<CursorSidebarConnected axis={axis} />`.
- `CursorSidebarConnected` reads `auctionWindowMask` from `useTabsStore((s) => s.getPrefs(s.activeTabId).auctionWindowMask)` (same pattern as other store consumers — `ChartPrefsContext` is intentionally chart-subtree only and not available here).
- `CursorSidebarConnected` then computes `maskRatio` and passes it to `TotalQtyBar`.

The sidebar card composition stays simple:

```tsx
const orderbookContent = (
  <>
    <OrderbookTable snapshot={orderbook} />
    <TotalQtyBar snapshot={orderbook} maskRatio={maskRatio} />
  </>
);
return <CursorSidebar orderbook={orderbookContent} brokers={…} fills={…} />;
```

## Files touched

- **New**: `frontend/src/sidebar/TotalQtyBar.tsx` — component
- **New**: `frontend/src/sidebar/TotalQtyBar.test.tsx` — Vitest unit and integration tests
- **Modified**: `frontend/src/sidebar/CursorSidebar.tsx` — compose `TotalQtyBar` alongside `OrderbookTable` inside the 10호가 card; accept `axis` prop on `CursorSidebarConnected`; compute `maskRatio` from `useTabsStore` prefs and `axis.inClosingAuctionWindow(cursorMs)`
- **Modified**: `frontend/src/replay/Workarea.tsx` — pass `axis={axis}` to `<CursorSidebarConnected />`

No new helper modules. No backend changes. No API changes. No `DESIGN.md` token table changes. The existing `VirtualAxis.inClosingAuctionWindow` predicate is reused as-is.

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
3. **Mask behavior** (component-level, exercised purely through the `maskRatio` prop)
   - `maskRatio === false` → bar fills render
   - `maskRatio === true` → bar fills hidden, container chrome and flank numbers remain, "Auction" annotation present
4. **Wiring** (integration test on `CursorSidebarConnected`)
   - Active tab `auctionWindowMask=true` + cursor inside the closing Auction Window of the active segment → `TotalQtyBar` receives `maskRatio=true`
   - Active tab `auctionWindowMask=true` + cursor outside the closing Auction Window → `maskRatio=false`
   - Active tab `auctionWindowMask=false` (any cursor) → `maskRatio=false`
5. **Accessibility**
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
| Place inside the existing "10호가" `SidebarCard`, not as a fourth card | Avoids regridding the sidebar (`grid-rows-[2fr_1fr_1fr]`) that was tuned for three cards; aggregate totals are semantically the same domain as the orderbook itself. |
| Two-prop component (`snapshot`, `maskRatio`) instead of three (`snapshot`, `segment`, `auctionWindowMask`) | Parent computes the masking decision once, component stays purely presentational and trivially testable. The intermediate `inClosingAuctionWindow` check lives at the wiring layer, not inside the bar. |
| Reuse `VirtualAxis.inClosingAuctionWindow`, do not introduce a new helper module | The predicate is already extracted and tested as part of `VirtualAxis`. Pulling it into a separate `util/auctionWindow.ts` would duplicate the responsibility. |
| Closing-only mask (opening Auction Window not masked) | `VirtualAxis` exposes only `inClosingAuctionWindow`; existing `RatioPane` is also closing-only. Adding opening masking is a separate codebase-wide change (predicate first, then both panes adopt it). |
