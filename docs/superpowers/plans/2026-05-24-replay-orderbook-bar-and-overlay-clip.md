# Replay Orderbook Bar + Overlay Clip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 10호가 depth bars visible per the approved mockup, and stop chart overlay lines (date boundaries, auction bands) from bleeding into the 10호가 sidebar card.

**Architecture:** Two surgical edits on the replay viewer. (1) Introduce `--bar-ask` / `--bar-bid` gradient tokens (0.18 → 0 alpha) and consume them inline in `OrderbookTable` with a right-anchored bar. (2) Add `overflow-hidden` to the `ChartStage` outer relative div so absolutely-positioned overlay children cannot escape the chart cell regardless of zoom.

**Tech Stack:** React 18 + TypeScript, Tailwind v3, lightweight-charts v5, Vitest. CSS tokens live in `frontend/src/styles/tokens.css`.

**Spec:** [docs/superpowers/specs/2026-05-24-replay-orderbook-bar-and-overlay-clip-design.md](../specs/2026-05-24-replay-orderbook-bar-and-overlay-clip-design.md)

---

## File Map

| File | Action | Why |
|---|---|---|
| `frontend/src/styles/tokens.css` | Modify (add 2 lines in hand-written tint block) | Source-of-truth for new `--bar-ask` / `--bar-bid` gradients |
| `frontend/src/sidebar/OrderbookTable.tsx` | Modify (`Row` component bar span) | Apply gradients inline, flip anchor from `left:0` to `right:0` |
| `frontend/src/chart/ChartStage.tsx` | Modify (outer relative div className) | Add `overflow-hidden` so overlay DOM children are clipped to the chart cell |

No new files, no test files (visual-only changes; existing manual verification covers them — see spec §Verification).

---

## Task 1: Add `--bar-ask` / `--bar-bid` gradient tokens

**Files:**
- Modify: `frontend/src/styles/tokens.css` — append two lines inside the hand-written "Tint backgrounds" block (above the `BEGIN AUTO-GENERATED` marker)

- [ ] **Step 1: Edit `tokens.css` to add the two gradient tokens**

Open `frontend/src/styles/tokens.css`. Locate the existing tint block (lines 62-72 today, ending with `--tint-auction-window`). Insert these two declarations after `--tint-auction-window:` and **before** the `BEGIN AUTO-GENERATED` comment:

```css
  /* Depth bar fills for OrderbookTable. Distinct from --tint-price-up/down
     (chip backgrounds @ 10% flat) because depth bars need stronger peak
     visibility and a directional fade per the 2026-05-20 approved mockup
     (docs/superpowers/designs/2026-05-20-replay-viewer.html lines 379-384).
     Anchored from the qty column inward — bar grows toward the price side. */
  --bar-ask: linear-gradient(to left, rgba(37, 99, 235, 0.18), rgba(37, 99, 235, 0));   /* 2563EB @ 0.18 → 0 */
  --bar-bid: linear-gradient(to left, rgba(220, 38, 38, 0.18), rgba(220, 38, 38, 0));   /* DC2626 @ 0.18 → 0 */
```

- [ ] **Step 2: Verify the file still parses and the existing token system is intact**

Run:
```bash
cd frontend && npx tsc -b --noEmit 2>&1 | head -20
```
Expected: no output (clean), or unrelated errors from elsewhere in the tree. CSS is not type-checked but this confirms we haven't broken any imports.

Also run the token generator to make sure the AUTO block is still respected (it should only regenerate text below the marker):
```bash
cd frontend && npm run gen:tokens
git diff frontend/src/styles/tokens.css
```
Expected: `git diff` shows ONLY the two new `--bar-*` lines + the comment block we added. No lines below the `BEGIN AUTO-GENERATED` marker should change.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/tokens.css
git commit -m "feat(frontend/tokens): add --bar-ask/--bar-bid gradient tokens for orderbook depth bars"
```

---

## Task 2: Apply gradient tokens in `OrderbookTable` with right-anchored bars

**Files:**
- Modify: `frontend/src/sidebar/OrderbookTable.tsx` — `Row` component, lines 55-81

- [ ] **Step 1: Edit the `Row` component to use the new tokens and right-anchor**

Open `frontend/src/sidebar/OrderbookTable.tsx`. Locate the `Row` function (lines 55-81). The current body computes `barClass` and renders an absolutely-positioned span anchored left.

Replace this block:

```tsx
function Row({
  side,
  price,
  qty,
  maxQty,
}: {
  side: 'ask' | 'bid';
  price: number;
  qty: number;
  maxQty: number;
}) {
  const widthPct = maxQty > 0 ? (qty / maxQty) * 100 : 0;
  const barClass   = side === 'ask' ? 'bg-tint-price-down' : 'bg-tint-price-up';
  const priceColor = side === 'ask' ? 'text-price-down'    : 'text-price-up';
  // Depth bar extends from the left on the qty side; spec §5.1 shows depth
  // bars rendered behind the qty column.
  return (
    <div className="relative grid grid-cols-[1fr_1fr] gap-3 px-2.5 py-0.5">
      <span
        className={`absolute inset-y-0 left-0 ${barClass}`}
        style={{ width: `${widthPct}%` }}
      />
      <span className={`relative text-right ${priceColor}`}>{price.toLocaleString('ko-KR')}</span>
      <span className="relative text-right text-fg-dim">{qty.toLocaleString('ko-KR')}</span>
    </div>
  );
}
```

With this:

```tsx
function Row({
  side,
  price,
  qty,
  maxQty,
}: {
  side: 'ask' | 'bid';
  price: number;
  qty: number;
  maxQty: number;
}) {
  const widthPct = maxQty > 0 ? (qty / maxQty) * 100 : 0;
  const barBg     = side === 'ask' ? 'var(--bar-ask)' : 'var(--bar-bid)';
  const priceColor = side === 'ask' ? 'text-price-down' : 'text-price-up';
  // Depth bar grows from the qty column (right) inward, with a 0.18 → 0
  // gradient fade. Matches the 2026-05-20 approved mockup
  // (docs/superpowers/designs/2026-05-20-replay-viewer.html lines 379-384).
  return (
    <div className="relative grid grid-cols-[1fr_1fr] gap-3 px-2.5 py-0.5">
      <span
        className="absolute inset-y-0 right-0"
        style={{ width: `${widthPct}%`, background: barBg }}
      />
      <span className={`relative text-right ${priceColor}`}>{price.toLocaleString('ko-KR')}</span>
      <span className="relative text-right text-fg-dim">{qty.toLocaleString('ko-KR')}</span>
    </div>
  );
}
```

Changes in this diff:
- `barClass` (Tailwind utility) → `barBg` (CSS variable string).
- `<span>` className lost `${barClass}`, gained nothing on Tailwind side; gained inline `background: barBg` on the style object.
- Anchor flipped: `left-0` → `right-0`.
- Stale comment about "extends from the left" replaced with the new intent + mockup reference.

- [ ] **Step 2: Run the typechecker and the sidebar's existing tests**

```bash
cd frontend && npx tsc -b --noEmit
```
Expected: clean (no new errors).

```bash
cd frontend && npx vitest run src/sidebar
```
Expected: PASS — `TotalQtyBar.test.tsx` is the only test in `sidebar/`; it doesn't touch `OrderbookTable` but confirms the sidebar tree still mounts. If it was passing before this change, it should still pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/sidebar/OrderbookTable.tsx
git commit -m "feat(frontend/replay): restore depth bar visibility in 10호가 — gradient tokens + right anchor"
```

---

## Task 3: Clip overlays at the ChartStage boundary

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx` — line 281, single-class addition

- [ ] **Step 1: Add `overflow-hidden` to the outer container**

Open `frontend/src/chart/ChartStage.tsx`. Locate the return statement at line 280:

```tsx
  return (
    <div className="relative h-full min-h-0 bg-bg-card">
      <div ref={containerRef} className="absolute inset-0" />
```

Change line 281 to:

```tsx
  return (
    <div className="relative h-full min-h-0 bg-bg-card overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />
```

Only `overflow-hidden` is added; no other change to that file.

- [ ] **Step 2: Verify the typechecker and the chart-adjacent tests still pass**

```bash
cd frontend && npx tsc -b --noEmit
```
Expected: clean.

```bash
cd frontend && npx vitest run
```
Expected: PASS — the full suite. We're touching layout only; no behavioral test depends on `ChartStage`'s outer div's overflow property.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/chart/ChartStage.tsx
git commit -m "fix(frontend/chart): clip ChartStage so day-boundary lines stop bleeding into 10호가 sidebar"
```

---

## Task 4: Manual visual verification on `/replay`

This task has no code — it's the verification the spec lists in §Verification. The dev servers are already running per `CLAUDE.md` (Vite HMR + uvicorn `--reload`), so all three previous commits should already be live in the browser.

- [ ] **Step 1: Confirm dev servers are running**

```bash
curl -s -o /dev/null -w "frontend=%{http_code}\n" http://localhost:5173/replay
curl -s -o /dev/null -w "backend=%{http_code}\n" http://127.0.0.1:8000/api/events
```
Expected: `frontend=200`, `backend=200`. If backend returns anything else, see `CLAUDE.md` § "Dev servers" for the `uv run uvicorn` command.

- [ ] **Step 2: Load a multi-day range and visually verify the depth bars**

Open `http://localhost:5173/replay` in a browser. Pick a symbol that already has captured data (check `Inventory` page or `~/.local/share/hoga-ops/symbol-master.json` if needed). Pick a fromDate / toDate that span at least 2 trading days. Click `데이터 불러오기`.

Verify in the 10호가 card (top-right):
- Bars are clearly visible at small `widthPct` (e.g., ~5% of max).
- Ask rows (top half) carry the blue (`#2563EB`) gradient; bid rows (bottom half) carry the red (`#DC2626`) gradient.
- Each bar fades from its peak alpha on the right (qty column) toward zero on the left (price column).

- [ ] **Step 3: Zoom in on the chart and verify no leakage**

Use the chart's scroll-wheel to zoom in so that at least one day-boundary is virtually present but visually off-screen to the right.

Verify in the 10호가 area (and the 거래원 / 체결 cards below):
- No vertical dashed line appears anywhere in the sidebar.
- No floating MM/DD chip appears anywhere in the sidebar.
- The chart's right edge cleanly transitions to the sidebar's left edge with only the workarea's `gap-2` between them.

- [ ] **Step 4: Repeat with the auction-window mask toggled on**

Open the Settings modal (gear icon in the Toolbar). Find the "Auction window mask" toggle under "차트" and enable it. Verify the closing-auction band renders inside the chart and does not bleed into the sidebar at any zoom level.

- [ ] **Step 5: If everything looks correct, mark the plan done**

No further commit needed — the three preceding commits are the deliverable. If any step fails, file a follow-up against the spec (likely an edge case we missed).

---

## Self-Review Notes

- **Spec coverage:** Both spec goals (G1 depth bar visibility, G2 overlay containment) map 1:1 to Tasks 1+2 and Task 3 respectively. Spec Risks & mitigations are inherited from the spec, not duplicated here.
- **Placeholders:** None — every step shows the exact code or command.
- **Type consistency:** `barBg` is a `string` (CSS var reference); `widthPct` math identical to before. `Row` props unchanged.
- **No new tests:** explicitly per spec — visual-only fix, no testable logic branch.
