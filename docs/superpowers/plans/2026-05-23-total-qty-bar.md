# TotalQtyBar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slim 100% stack divergent bar showing 매도 (left, blue) vs 매수 (right, red) total quantity at the current cursor, inside the existing "10호가" sidebar card, beneath `OrderbookTable`.

**Architecture:** A pure presentation component (`TotalQtyBar`) reads `OrderbookSnapshot.tot_ask` / `tot_bid` and renders a 10px bar with flanking numeric totals. The closing-auction-window masking decision is computed by the parent (`CursorSidebarConnected`) using the existing `VirtualAxis.inClosingAuctionWindow` predicate and the per-tab `auctionWindowMask` pref, then passed in as a single boolean prop.

**Tech Stack:** React 18, TypeScript, Tailwind CSS (`bg-bg-subtle`, `border-strong`, `text-price-up/down` tokens), Vitest + React Testing Library, Zustand (`useTabsStore`), `lightweight-charts` (unaffected).

---

## File Structure

- **New** `frontend/src/sidebar/TotalQtyBar.tsx` — pure presentation component + exported `computeTotals` helper.
- **New** `frontend/src/sidebar/TotalQtyBar.test.tsx` — Vitest unit tests for `computeTotals` and component render.
- **Modified** `frontend/src/sidebar/CursorSidebar.tsx` — `CursorSidebarConnected` accepts `axis` prop, computes `maskRatio`, composes `TotalQtyBar` alongside `OrderbookTable` in the 10호가 card body.
- **Modified** `frontend/src/replay/Workarea.tsx` — pass `axis` to `<CursorSidebarConnected />`.

No backend changes. No new design tokens. No new utility modules.

---

## Task 1: Pure `computeTotals` helper (TDD)

**Files:**
- Create: `frontend/src/sidebar/TotalQtyBar.tsx`
- Create: `frontend/src/sidebar/TotalQtyBar.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/sidebar/TotalQtyBar.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { computeTotals } from './TotalQtyBar';
import type { OrderbookSnapshot } from '../api/types';

function snap(totAsk: number, totBid: number): OrderbookSnapshot {
  return {
    ts_ms: 0,
    seq: 0,
    ask: Array.from({ length: 10 }, () => ({ price: 0, qty: 0 })),
    bid: Array.from({ length: 10 }, () => ({ price: 0, qty: 0 })),
    tot_ask: totAsk,
    tot_bid: totBid,
  };
}

describe('computeTotals', () => {
  it('returns wire totals and proportional percentages', () => {
    const r = computeTotals(snap(12_840, 18_220));
    expect(r.askTotal).toBe(12_840);
    expect(r.bidTotal).toBe(18_220);
    expect(r.askPct).toBeCloseTo(12_840 / 31_060, 5);
    expect(r.bidPct).toBeCloseTo(18_220 / 31_060, 5);
  });

  it('returns 0.5/0.5 split when both totals are zero (divide-by-zero guard)', () => {
    const r = computeTotals(snap(0, 0));
    expect(r.askTotal).toBe(0);
    expect(r.bidTotal).toBe(0);
    expect(r.askPct).toBe(0.5);
    expect(r.bidPct).toBe(0.5);
  });

  it('returns 0/1 when only bid is present', () => {
    const r = computeTotals(snap(0, 100));
    expect(r.askPct).toBe(0);
    expect(r.bidPct).toBe(1);
  });

  it('returns 1/0 when only ask is present', () => {
    const r = computeTotals(snap(100, 0));
    expect(r.askPct).toBe(1);
    expect(r.bidPct).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/sidebar/TotalQtyBar.test.tsx`
Expected: FAIL — `computeTotals` is not exported from `TotalQtyBar`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/sidebar/TotalQtyBar.tsx`:

```tsx
import type { OrderbookSnapshot } from '../api/types';

export type Totals = {
  askTotal: number;
  bidTotal: number;
  askPct: number;
  bidPct: number;
};

export function computeTotals(snapshot: OrderbookSnapshot): Totals {
  const askTotal = snapshot.tot_ask;
  const bidTotal = snapshot.tot_bid;
  const total = askTotal + bidTotal;
  const askPct = total > 0 ? askTotal / total : 0.5;
  const bidPct = total > 0 ? bidTotal / total : 0.5;
  return { askTotal, bidTotal, askPct, bidPct };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/sidebar/TotalQtyBar.test.tsx`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/sidebar/TotalQtyBar.tsx frontend/src/sidebar/TotalQtyBar.test.tsx
git commit -m "feat(sidebar): computeTotals helper for TotalQtyBar"
```

---

## Task 2: `TotalQtyBar` null/undefined render (TDD)

**Files:**
- Modify: `frontend/src/sidebar/TotalQtyBar.tsx`
- Modify: `frontend/src/sidebar/TotalQtyBar.test.tsx`

- [ ] **Step 1: Add the failing tests**

Append to `frontend/src/sidebar/TotalQtyBar.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import TotalQtyBar from './TotalQtyBar';

describe('TotalQtyBar — empty states', () => {
  it('renders nothing when snapshot is undefined (loading)', () => {
    const { container } = render(<TotalQtyBar snapshot={undefined} maskRatio={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when snapshot is null (no data)', () => {
    const { container } = render(<TotalQtyBar snapshot={null} maskRatio={false} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/sidebar/TotalQtyBar.test.tsx`
Expected: FAIL — `TotalQtyBar` default export does not exist.

- [ ] **Step 3: Implement minimal component**

Append to `frontend/src/sidebar/TotalQtyBar.tsx`:

```tsx
type Props = {
  snapshot: OrderbookSnapshot | null | undefined;
  maskRatio: boolean;
};

export default function TotalQtyBar({ snapshot, maskRatio }: Props) {
  if (snapshot == null) return null;
  return <div data-testid="total-qty-bar" />;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/sidebar/TotalQtyBar.test.tsx`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/sidebar/TotalQtyBar.tsx frontend/src/sidebar/TotalQtyBar.test.tsx
git commit -m "feat(sidebar): TotalQtyBar renders null when snapshot absent"
```

---

## Task 3: `TotalQtyBar` normal render with flank numbers and bar (TDD)

**Files:**
- Modify: `frontend/src/sidebar/TotalQtyBar.tsx`
- Modify: `frontend/src/sidebar/TotalQtyBar.test.tsx`

- [ ] **Step 1: Add failing tests**

Append to `frontend/src/sidebar/TotalQtyBar.test.tsx`:

```tsx
describe('TotalQtyBar — normal render', () => {
  it('shows formatted ask total on the left and bid total on the right with KRX colors', () => {
    const { getByText, getByRole } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={false} />,
    );
    const ask = getByText('12,840');
    const bid = getByText('18,220');
    expect(ask.className).toMatch(/text-price-down/);
    expect(bid.className).toMatch(/text-price-up/);
    const group = getByRole('group', { name: '총잔량' });
    expect(group).toContainElement(ask);
    expect(group).toContainElement(bid);
  });

  it('sets the bar fill grid-template-columns to the computed ratio', () => {
    const { container } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={false} />,
    );
    const fill = container.querySelector('[data-testid="total-qty-bar-fill"]') as HTMLElement;
    expect(fill.style.gridTemplateColumns).toBe('12840fr 18220fr');
  });

  it('aria-labels each flank with its semantic meaning', () => {
    const { getByLabelText } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={false} />,
    );
    expect(getByLabelText('매도총잔량 12,840')).toBeInTheDocument();
    expect(getByLabelText('매수총잔량 18,220')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/sidebar/TotalQtyBar.test.tsx`
Expected: FAIL — the placeholder `<div data-testid="total-qty-bar" />` has none of the expected structure.

- [ ] **Step 3: Implement the full render**

Replace the placeholder return in `frontend/src/sidebar/TotalQtyBar.tsx` with the full markup. The complete file should now be:

```tsx
import { useMemo } from 'react';
import type { OrderbookSnapshot } from '../api/types';

export type Totals = {
  askTotal: number;
  bidTotal: number;
  askPct: number;
  bidPct: number;
};

export function computeTotals(snapshot: OrderbookSnapshot): Totals {
  const askTotal = snapshot.tot_ask;
  const bidTotal = snapshot.tot_bid;
  const total = askTotal + bidTotal;
  const askPct = total > 0 ? askTotal / total : 0.5;
  const bidPct = total > 0 ? bidTotal / total : 0.5;
  return { askTotal, bidTotal, askPct, bidPct };
}

type Props = {
  snapshot: OrderbookSnapshot | null | undefined;
  maskRatio: boolean;
};

const ASK_FILL = 'rgba(37, 99, 235, 0.55)';   // --price-down @ 0.55 alpha
const BID_FILL = 'rgba(220, 38, 38, 0.55)';   // --price-up @ 0.55 alpha
const HAIRLINE = 'rgba(255, 255, 255, 0.18)';

export default function TotalQtyBar({ snapshot, maskRatio }: Props) {
  const totals = useMemo(() => (snapshot ? computeTotals(snapshot) : null), [snapshot]);
  if (snapshot == null || totals == null) return null;

  const { askTotal, bidTotal } = totals;
  const askStr = askTotal.toLocaleString('ko-KR');
  const bidStr = bidTotal.toLocaleString('ko-KR');

  return (
    <div
      role="group"
      aria-label="총잔량"
      className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 px-2.5 py-1 font-mono text-sm tabular-nums border-t border-border-strong"
    >
      <span
        aria-label={`매도총잔량 ${askStr}`}
        className="text-right text-price-down"
      >
        {askStr}
      </span>
      <div
        className="h-2.5 rounded-sm border border-border-strong bg-bg-subtle overflow-hidden"
      >
        {maskRatio ? (
          <div
            data-testid="total-qty-bar-masked"
            className="h-full flex items-center justify-center text-fg-dimmer text-xs uppercase tracking-wider"
          >
            Auction
          </div>
        ) : (
          <div
            data-testid="total-qty-bar-fill"
            className="grid h-full"
            style={{ gridTemplateColumns: `${askTotal}fr ${bidTotal}fr` }}
          >
            <div style={{ background: ASK_FILL, borderRight: `1px solid ${HAIRLINE}` }} />
            <div style={{ background: BID_FILL }} />
          </div>
        )}
      </div>
      <span
        aria-label={`매수총잔량 ${bidStr}`}
        className="text-left text-price-up"
      >
        {bidStr}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/sidebar/TotalQtyBar.test.tsx`
Expected: PASS — all 9 tests (4 helper + 2 empty + 3 normal) green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/sidebar/TotalQtyBar.tsx frontend/src/sidebar/TotalQtyBar.test.tsx
git commit -m "feat(sidebar): TotalQtyBar full render with flank totals and stack bar"
```

---

## Task 4: `TotalQtyBar` mask behavior (TDD)

**Files:**
- Modify: `frontend/src/sidebar/TotalQtyBar.test.tsx`

The implementation already handles `maskRatio` from Task 3 (the conditional inside the bar container). This task just locks the behavior with tests.

- [ ] **Step 1: Add tests**

Append to `frontend/src/sidebar/TotalQtyBar.test.tsx`:

```tsx
describe('TotalQtyBar — masking', () => {
  it('shows bar fill when maskRatio=false', () => {
    const { queryByTestId } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={false} />,
    );
    expect(queryByTestId('total-qty-bar-fill')).not.toBeNull();
    expect(queryByTestId('total-qty-bar-masked')).toBeNull();
  });

  it('hides bar fill and shows "Auction" annotation when maskRatio=true', () => {
    const { queryByTestId, getByText } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={true} />,
    );
    expect(queryByTestId('total-qty-bar-fill')).toBeNull();
    expect(queryByTestId('total-qty-bar-masked')).not.toBeNull();
    expect(getByText('Auction')).toBeInTheDocument();
  });

  it('keeps flank numbers visible when maskRatio=true', () => {
    const { getByText } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={true} />,
    );
    expect(getByText('12,840')).toBeInTheDocument();
    expect(getByText('18,220')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass immediately**

Run: `cd frontend && npx vitest run src/sidebar/TotalQtyBar.test.tsx`
Expected: PASS — all 12 tests green (no implementation change; this task just locks existing behavior).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/sidebar/TotalQtyBar.test.tsx
git commit -m "test(sidebar): lock TotalQtyBar mask behavior"
```

---

## Task 5: Wire `axis` prop through `CursorSidebarConnected`

**Files:**
- Modify: `frontend/src/sidebar/CursorSidebar.tsx`
- Modify: `frontend/src/replay/Workarea.tsx`

- [ ] **Step 1: Update `Workarea.tsx` to pass `axis`**

In `frontend/src/replay/Workarea.tsx`, locate the line that renders `<CursorSidebarConnected />` (around line 100) and change it to:

```tsx
<CursorSidebarConnected axis={axis} />
```

`axis` is the same `VirtualAxis` instance already constructed via `useMemo` higher up in the function (line 29) and passed to `<ChartStage axis={axis} … />`.

- [ ] **Step 2: Update `CursorSidebar.tsx` to accept and use `axis`**

Modify the `CursorSidebarConnected` function in `frontend/src/sidebar/CursorSidebar.tsx`. The new version should be:

```tsx
import { useMemo, type ReactNode } from 'react';
import OrderbookTable from './OrderbookTable';
import BrokerNetTable from './BrokerNetTable';
import FillTape from './FillTape';
import TotalQtyBar from './TotalQtyBar';
import {
  useOrderbookAtCursor,
  useBrokersAtCursor,
  useTradesAroundCursor,
  useCursor,
} from '../api/useCursor';
import { useTabsStore } from '../state/tabs';
import type { VirtualAxis } from '../util/virtualAxis';

type Props = {
  orderbook?: ReactNode;
  brokers?: ReactNode;
  fills?: ReactNode;
};

export function CursorSidebarConnected({ axis }: { axis: VirtualAxis }) {
  const orderbook = useOrderbookAtCursor();
  const brokers = useBrokersAtCursor();
  const trades = useTradesAroundCursor();
  const { cursorMs } = useCursor();
  const auctionWindowMask = useTabsStore((s) => s.getPrefs(s.activeTabId).auctionWindowMask);

  const maskRatio = useMemo(() => {
    if (!auctionWindowMask) return false;
    if (cursorMs == null || !Number.isFinite(cursorMs)) return false;
    return axis.inClosingAuctionWindow(cursorMs);
  }, [auctionWindowMask, cursorMs, axis]);

  return (
    <CursorSidebar
      orderbook={
        <>
          <OrderbookTable snapshot={orderbook} />
          <TotalQtyBar snapshot={orderbook} maskRatio={maskRatio} />
        </>
      }
      brokers={<BrokerNetTable brokers={brokers} />}
      fills={<FillTape trades={trades} />}
    />
  );
}

export default function CursorSidebar({ orderbook, brokers, fills }: Props) {
  return (
    <aside className="grid grid-rows-[2fr_1fr_1fr] gap-2 p-2 bg-bg w-sidebar h-full min-h-0">
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="거래원" testId="card-brokers">
        {brokers ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="체결" testId="card-fills">
        {fills ?? <Placeholder />}
      </SidebarCard>
    </aside>
  );
}

function SidebarCard({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-card={testId.replace(/^card-/, '')}
      className="flex flex-col min-h-0 bg-bg-card border rounded overflow-hidden"
    >
      <header className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
        {label}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

function Placeholder() {
  return <div className="grid place-items-center h-full text-fg-dimmer text-xs">—</div>;
}
```

Changes from the previous version:
1. Import `TotalQtyBar`, `useCursor`, `useTabsStore`, `VirtualAxis`, `useMemo`.
2. `CursorSidebarConnected` now takes `{ axis: VirtualAxis }` instead of zero props.
3. Reads `cursorMs` and `auctionWindowMask`, derives `maskRatio`.
4. The `orderbook` slot is now a fragment containing `OrderbookTable` followed by `TotalQtyBar`.

- [ ] **Step 3: Run typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors. (If `useCursor` is not currently exported by name, add it to the named exports in `frontend/src/api/useCursor.ts` — it's already declared `export function useCursor` per line 29 of that file, so the import should resolve directly.)

- [ ] **Step 4: Run the full test suite to catch regressions**

Run: `cd frontend && npx vitest run`
Expected: All tests pass (including the 12 from Tasks 1-4).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/sidebar/CursorSidebar.tsx frontend/src/replay/Workarea.tsx
git commit -m "feat(sidebar): wire TotalQtyBar into CursorSidebarConnected with maskRatio"
```

---

## Task 6: Manual browser verification

**Files:** None modified; this is the live-app gate.

- [ ] **Step 1: Start the dev server**

Run the existing dev command (from project root, in a separate terminal):

```bash
cd frontend && npm run dev
```

Expected: Vite dev server starts and prints a local URL (typically `http://localhost:5173`).

- [ ] **Step 2: Verify the bar is visible at mid-session**

In a browser:
1. Open the replay viewer
2. Load a known Stock-Date (e.g. `005930` on a recent business day)
3. Move the cursor to a mid-session time (e.g. 11:00)
4. Confirm the "10호가" card shows: orderbook table → 1px divider → `TotalQtyBar` with two numbers and a colored bar
5. Confirm 매도 (blue) is on the LEFT and 매수 (red) is on the RIGHT
6. Verify the bar's split ratio visually matches the two numbers (e.g. if 매도 is half of 매수, the blue segment should be about ⅓ of the total bar width)

- [ ] **Step 3: Verify closing-auction masking**

1. Move the cursor to a time inside `[15:20:00, 15:30:00]` KST
2. With Settings modal `auctionWindowMask=true` (the default): the bar fills should disappear and an "Auction" label should appear in the bar slot; the two flank numbers stay visible
3. Open the Settings modal, toggle `auctionWindowMask=false`: the bar fills come back

- [ ] **Step 4: Verify scale-dial compatibility**

In DevTools, set `:root { font-size: 16px }` (1.0× base intent) and confirm the component still renders correctly — slimmer overall, but layout intact. Reset to `20px` (default 1.25×) and confirm comfortable density.

- [ ] **Step 5: Run typecheck and full test suite one more time**

Run:

```bash
cd frontend && npx tsc --noEmit && npx vitest run
```

Expected: Both pass cleanly.

- [ ] **Step 6: Final commit (only if any tweaks were needed during manual verification)**

If steps 2-4 required code changes, commit them with a descriptive message. Otherwise, skip.

---

## Spec coverage check

- Goal (proportion of 매도 vs 매수 at cursor): Tasks 1, 3
- Placement inside 10호가 card: Task 5
- 100% stack with flank numbers: Task 3
- KRX color convention (blue=매도 left, red=매수 right): Task 3
- 10px bar height, rem-based sizing: Task 3 (`h-2.5`)
- Inline 0.55 alpha, no new tokens: Task 3 (constants in component)
- Data source `tot_ask` / `tot_bid` from wire: Task 1
- Empty states (`null` / `undefined` snapshot): Task 2
- Zero-totals divide-by-zero guard: Task 1
- Closing-Auction-Window masking via `VirtualAxis.inClosingAuctionWindow`: Task 5
- `maskRatio` is single boolean prop: Task 3, locked by Task 4
- Accessibility (`role="group"`, `aria-label` on flanks): Task 3
- Manual verification: Task 6

No spec requirement left without a task.
