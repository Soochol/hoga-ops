# Live Resizable Workarea Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `/live`'s toolbar into the chart panel, remove the empty toolbar-width gap above 10호가, and add persisted splitters for Chart Panel width and Live Detail Panel card heights.

**Architecture:** Add a focused `liveLayout` store for `/live` workarea dimensions, then refactor `LiveWorkarea` so `LiveToolbar + LiveChartRoot` form a left Chart Panel and `LiveSidebar` becomes the right Live Detail Panel. Width resizing is stored in pixels; card heights are stored as weights and rendered through a stable four-card vertical stack.

**Tech Stack:** React, TypeScript, Zustand, Vitest, React Testing Library, lightweight-charts autosize, Vite.

## Global Constraints

- `/live` workarea layout only. Backend data, chart indicator pane heights, and indicator calculations stay unchanged.
- Do not resize internal `lightweight-charts` panes.
- Do not add per-symbol, per-timeframe, or per-tab layout persistence.
- Do not add card reordering.
- Do not change `/study`.
- Do not add a mobile drawer/collapse mode in v1.
- Representative Index charts hide the Live Detail Panel and preserve saved layout dimensions for the next stock Code.
- Live Tabs must not change Live Detail Panel width or card heights.
- Card order is fixed: 10호가, 프로그램 순매수, 거래원, Live Investor Estimate Card.
- Card height persistence uses relative weights, not absolute pixels.
- Live Detail Panel width persistence uses pixels with runtime viewport clamps.
- Watchlist/Screener row drops target Chart Panel, including toolbar; splitter and Live Detail Panel are not drop targets.

---

## File Structure

- Create `frontend/src/state/liveLayout.ts`
  - Owns `live.layout.v1` persistence, defaults, validation, setters, and clamp helpers.
- Create `frontend/src/state/liveLayout.test.ts`
  - Tests validation, width clamps, card weight updates, and corrupt storage fallback.
- Create `frontend/src/live/LiveDetailPanel.tsx`
  - Renders the four right-side cards in fixed order with horizontal splitters.
- Create `frontend/src/live/LiveDetailPanel.test.tsx`
  - Tests card order, stable slots, height weight updates, and splitter semantics.
- Modify `frontend/src/live/LiveSidebar.tsx`
  - Keep data derivation, delegate card shell rendering to `LiveDetailPanel`.
- Modify `frontend/src/live/LiveSidebar.test.tsx`
  - Update assertions from old nested `CursorSidebar` layout to Live Detail Panel layout.
- Modify `frontend/src/live/LiveWorkarea.tsx`
  - Accept toolbar props, render Chart Panel, vertical splitter, index exception, and narrowed drop target.
- Modify `frontend/src/live/LiveWorkarea.test.tsx`
  - Test toolbar-in-chart-panel, Live Detail Panel placement, index hiding, width splitter, and Chart Panel drop target.
- Modify `frontend/src/live/LivePage.tsx`
  - Remove top-level `LiveToolbar` grid row and pass toolbar actions into `LiveWorkarea`.
- Modify `frontend/src/live/LivePage.test.tsx`
  - Update shell tests for the new `LiveWorkarea` contract.

---

### Task 1: Add `liveLayout` Store

**Files:**
- Create: `frontend/src/state/liveLayout.ts`
- Test: `frontend/src/state/liveLayout.test.ts`

**Interfaces:**
- Produces:
  - `LIVE_LAYOUT_STORAGE_KEY = 'live.layout.v1'`
  - `DEFAULT_RIGHT_PANEL_WIDTH_PX = 400`
  - `DEFAULT_CARD_WEIGHTS = { orderbook: 48, program: 13, brokers: 24, investor: 15 }`
  - `LIVE_DETAIL_MIN_WIDTH_PX = 320`
  - `CHART_MIN_WIDTH_PX = 640`
  - `clampRightPanelWidth(widthPx: number, workareaWidthPx: number): number`
  - `clampCardWeights(weights: Partial<LiveCardWeights>): LiveCardWeights`
  - `resizeAdjacentWeights(weights, upperKey, lowerKey, deltaPx, panelHeightPx): LiveCardWeights`
  - `useLiveLayoutStore`
- Consumed by:
  - Task 2 `LiveDetailPanel`
  - Task 3 `LiveWorkarea`

- [ ] **Step 1: Write failing tests for storage validation and width clamp**

Add `frontend/src/state/liveLayout.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('liveLayout store helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('falls back to defaults when storage is corrupt', async () => {
    localStorage.setItem('live.layout.v1', JSON.stringify({
      rightPanelWidthPx: -10,
      rightCardWeights: {
        orderbook: Number.NaN,
        program: 'bad',
        brokers: Infinity,
        investor: -1,
      },
    }));

    const { useLiveLayoutStore, DEFAULT_RIGHT_PANEL_WIDTH_PX, DEFAULT_CARD_WEIGHTS } =
      await import('./liveLayout');

    expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(DEFAULT_RIGHT_PANEL_WIDTH_PX);
    expect(useLiveLayoutStore.getState().rightCardWeights).toEqual(DEFAULT_CARD_WEIGHTS);
  });

  it('clamps detail width against current workarea width', async () => {
    const { clampRightPanelWidth } = await import('./liveLayout');

    expect(clampRightPanelWidth(500, 2000)).toBe(500);
    expect(clampRightPanelWidth(100, 2000)).toBe(320);
    expect(clampRightPanelWidth(1200, 2000)).toBe(900);
    expect(clampRightPanelWidth(600, 850)).toBe(320);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd frontend && npx vitest run src/state/liveLayout.test.ts`

Expected: FAIL with module-not-found for `./liveLayout`.

- [ ] **Step 3: Implement the store and helpers**

Create `frontend/src/state/liveLayout.ts`:

```ts
import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

export const LIVE_LAYOUT_STORAGE_KEY = 'live.layout.v1';
export const DEFAULT_RIGHT_PANEL_WIDTH_PX = 400;
export const LIVE_DETAIL_MIN_WIDTH_PX = 320;
export const CHART_MIN_WIDTH_PX = 640;
export const RIGHT_PANEL_MAX_FRACTION = 0.45;

export type LiveCardKey = 'orderbook' | 'program' | 'brokers' | 'investor';
export type LiveCardWeights = Record<LiveCardKey, number>;

export const DEFAULT_CARD_WEIGHTS: LiveCardWeights = {
  orderbook: 48,
  program: 13,
  brokers: 24,
  investor: 15,
};

export const LIVE_CARD_MIN_HEIGHT_PX: Record<LiveCardKey, number> = {
  orderbook: 260,
  program: 96,
  brokers: 160,
  investor: 120,
};

type Persisted = {
  rightPanelWidthPx: number;
  rightCardWeights: LiveCardWeights;
};

type Store = Persisted & {
  setRightPanelWidthPx: (widthPx: number) => void;
  setRightCardWeights: (weights: LiveCardWeights) => void;
};

function finitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function clampRightPanelWidth(widthPx: number, workareaWidthPx: number): number {
  const safeWorkarea = Number.isFinite(workareaWidthPx) && workareaWidthPx > 0 ? workareaWidthPx : 0;
  if (safeWorkarea <= 0) return DEFAULT_RIGHT_PANEL_WIDTH_PX;
  const maxByFraction = Math.floor(safeWorkarea * RIGHT_PANEL_MAX_FRACTION);
  const maxByChart = Math.max(LIVE_DETAIL_MIN_WIDTH_PX, safeWorkarea - CHART_MIN_WIDTH_PX);
  const max = Math.max(LIVE_DETAIL_MIN_WIDTH_PX, Math.min(maxByFraction, maxByChart));
  const safeWidth = finitePositiveNumber(widthPx) ? widthPx : DEFAULT_RIGHT_PANEL_WIDTH_PX;
  return Math.min(max, Math.max(LIVE_DETAIL_MIN_WIDTH_PX, Math.round(safeWidth)));
}

export function clampCardWeights(weights: Partial<LiveCardWeights>): LiveCardWeights {
  const next: LiveCardWeights = { ...DEFAULT_CARD_WEIGHTS };
  for (const key of Object.keys(DEFAULT_CARD_WEIGHTS) as LiveCardKey[]) {
    const value = weights[key];
    if (finitePositiveNumber(value)) next[key] = value;
  }
  return next;
}

export function resizeAdjacentWeights(
  weights: LiveCardWeights,
  upperKey: LiveCardKey,
  lowerKey: LiveCardKey,
  deltaPx: number,
  panelHeightPx: number,
): LiveCardWeights {
  if (!Number.isFinite(deltaPx) || !Number.isFinite(panelHeightPx) || panelHeightPx <= 0) return weights;
  const total = weights[upperKey] + weights[lowerKey];
  if (total <= 0) return weights;
  const deltaWeight = (deltaPx / panelHeightPx) * 100;
  const minUpper = (LIVE_CARD_MIN_HEIGHT_PX[upperKey] / panelHeightPx) * 100;
  const minLower = (LIVE_CARD_MIN_HEIGHT_PX[lowerKey] / panelHeightPx) * 100;
  const upper = Math.max(minUpper, Math.min(total - minLower, weights[upperKey] + deltaWeight));
  const lower = total - upper;
  return { ...weights, [upperKey]: upper, [lowerKey]: lower };
}

function readStorage(): Partial<Persisted> {
  const parsed = readJsonObject(LIVE_LAYOUT_STORAGE_KEY);
  const next: Partial<Persisted> = {};
  if (finitePositiveNumber(parsed.rightPanelWidthPx)) {
    next.rightPanelWidthPx = parsed.rightPanelWidthPx;
  }
  if (parsed.rightCardWeights && typeof parsed.rightCardWeights === 'object') {
    next.rightCardWeights = clampCardWeights(parsed.rightCardWeights as Partial<LiveCardWeights>);
  }
  return next;
}

function persist(state: Persisted): void {
  persistJson(LIVE_LAYOUT_STORAGE_KEY, state);
}

const hydrated = readStorage();

export const useLiveLayoutStore = create<Store>((set) => ({
  rightPanelWidthPx: DEFAULT_RIGHT_PANEL_WIDTH_PX,
  rightCardWeights: DEFAULT_CARD_WEIGHTS,
  ...hydrated,
  setRightPanelWidthPx: (widthPx) => {
    set((state) => {
      const next = { rightPanelWidthPx: widthPx, rightCardWeights: state.rightCardWeights };
      persist(next);
      return { rightPanelWidthPx: widthPx };
    });
  },
  setRightCardWeights: (weights) => {
    set((state) => {
      const next = { rightPanelWidthPx: state.rightPanelWidthPx, rightCardWeights: clampCardWeights(weights) };
      persist(next);
      return { rightCardWeights: next.rightCardWeights };
    });
  },
}));
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `cd frontend && npx vitest run src/state/liveLayout.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/liveLayout.ts frontend/src/state/liveLayout.test.ts
git commit -m "feat(live): add layout preference store"
```

---

### Task 2: Build Live Detail Panel Stack

**Files:**
- Create: `frontend/src/live/LiveDetailPanel.tsx`
- Test: `frontend/src/live/LiveDetailPanel.test.tsx`
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Modify: `frontend/src/live/LiveSidebar.test.tsx`

**Interfaces:**
- Consumes:
  - `useLiveLayoutStore`
  - `resizeAdjacentWeights`
- Produces:
  - `LiveDetailPanel({ orderbook, program, brokers, investor }: Props)`
  - Test IDs: `live-detail-panel`, `live-detail-card-orderbook`, `live-detail-card-program`, `live-detail-card-brokers`, `live-detail-card-investor`, `live-detail-resizer-*`

- [ ] **Step 1: Write failing Live Detail Panel tests**

Create `frontend/src/live/LiveDetailPanel.test.tsx`:

```tsx
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LiveDetailPanel } from './LiveDetailPanel';
import { useLiveLayoutStore, DEFAULT_CARD_WEIGHTS } from '../state/liveLayout';

describe('LiveDetailPanel', () => {
  beforeEach(() => {
    useLiveLayoutStore.setState({
      rightPanelWidthPx: 400,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
    });
  });

  it('renders the four fixed slots in order', () => {
    render(
      <LiveDetailPanel
        orderbook={<div>orderbook</div>}
        program={<div>program</div>}
        brokers={<div>brokers</div>}
        investor={<div>investor</div>}
      />,
    );

    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    const program = screen.getByTestId('live-detail-card-program');
    const brokers = screen.getByTestId('live-detail-card-brokers');
    const investor = screen.getByTestId('live-detail-card-investor');
    expect(orderbook.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(program.compareDocumentPosition(brokers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(brokers.compareDocumentPosition(investor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('exposes splitter semantics for adjacent cards', () => {
    render(
      <LiveDetailPanel
        orderbook={<div />}
        program={<div />}
        brokers={<div />}
        investor={<div />}
      />,
    );

    expect(screen.getByRole('separator', { name: '10호가 / 프로그램 순매수 크기 조절' })).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.getByRole('separator', { name: '프로그램 순매수 / 거래원 크기 조절' })).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.getByRole('separator', { name: '거래원 / 잠정투자자 크기 조절' })).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('keeps every slot mounted when content is empty', () => {
    render(<LiveDetailPanel orderbook={null} program={null} brokers={null} investor={null} />);

    expect(screen.getByTestId('live-detail-card-orderbook')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-program')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-brokers')).toBeInTheDocument();
    expect(screen.getByTestId('live-detail-card-investor')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd frontend && npx vitest run src/live/LiveDetailPanel.test.tsx`

Expected: FAIL with module-not-found for `./LiveDetailPanel`.

- [ ] **Step 3: Implement `LiveDetailPanel`**

Create `frontend/src/live/LiveDetailPanel.tsx`:

```tsx
import { type ReactNode, useRef } from 'react';
import {
  type LiveCardKey,
  LIVE_CARD_MIN_HEIGHT_PX,
  resizeAdjacentWeights,
  useLiveLayoutStore,
} from '../state/liveLayout';

type Props = {
  orderbook: ReactNode;
  program: ReactNode;
  brokers: ReactNode;
  investor: ReactNode;
};

type CardDef = {
  key: LiveCardKey;
  label: string;
  testId: string;
  content: ReactNode;
};

const PAIRS: Array<{ upper: LiveCardKey; lower: LiveCardKey; label: string }> = [
  { upper: 'orderbook', lower: 'program', label: '10호가 / 프로그램 순매수 크기 조절' },
  { upper: 'program', lower: 'brokers', label: '프로그램 순매수 / 거래원 크기 조절' },
  { upper: 'brokers', lower: 'investor', label: '거래원 / 잠정투자자 크기 조절' },
];

export function LiveDetailPanel({ orderbook, program, brokers, investor }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const weights = useLiveLayoutStore((s) => s.rightCardWeights);
  const setWeights = useLiveLayoutStore((s) => s.setRightCardWeights);
  const cards: CardDef[] = [
    { key: 'orderbook', label: '10호가', testId: 'live-detail-card-orderbook', content: orderbook },
    { key: 'program', label: '프로그램', testId: 'live-detail-card-program', content: program },
    { key: 'brokers', label: '거래원', testId: 'live-detail-card-brokers', content: brokers },
    { key: 'investor', label: '잠정투자자', testId: 'live-detail-card-investor', content: investor },
  ];

  const beginResize = (upper: LiveCardKey, lower: LiveCardKey) => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startWeights = useLiveLayoutStore.getState().rightCardWeights;
    const panelHeight = panelRef.current?.clientHeight ?? 0;
    const target = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      const next = resizeAdjacentWeights(startWeights, upper, lower, moveEvent.clientY - startY, panelHeight);
      useLiveLayoutStore.setState({ rightCardWeights: next });
    };
    const up = (upEvent: PointerEvent) => {
      target.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWeights(useLiveLayoutStore.getState().rightCardWeights);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside
      ref={panelRef}
      data-testid="live-detail-panel"
      className="h-full min-h-0 bg-bg p-[var(--space-sm)]"
      style={{
        display: 'grid',
        gridTemplateRows: cards.map((card) => `minmax(${LIVE_CARD_MIN_HEIGHT_PX[card.key]}px, ${weights[card.key]}fr)`).join(' 8px '),
        gap: 0,
      }}
    >
      {cards.map((card, index) => (
        <div key={card.key} style={{ display: 'contents' }}>
          <section
            data-testid={card.testId}
            data-card={card.key}
            className="flex flex-col min-h-0 bg-bg-card border rounded overflow-hidden"
          >
            <header className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
              {card.label}
            </header>
            <div className="flex-1 min-h-0 overflow-auto">{card.content}</div>
          </section>
          {index < PAIRS.length && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={PAIRS[index].label}
              data-testid={`live-detail-resizer-${PAIRS[index].upper}-${PAIRS[index].lower}`}
              onPointerDown={beginResize(PAIRS[index].upper, PAIRS[index].lower)}
              style={{ cursor: 'row-resize', minHeight: 8, display: 'grid', placeItems: 'center' }}
            >
              <div aria-hidden style={{ height: 1, width: '100%', background: 'var(--border)' }} />
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
```

- [ ] **Step 4: Wire `LiveSidebar` to `LiveDetailPanel`**

In `frontend/src/live/LiveSidebar.tsx`, replace the `<CursorSidebar ... />` and trailing `<InvestorTrendEstimateCard />` render with:

```tsx
        <LiveDetailPanel
          orderbook={
            <>
              {showAvailableHint && (
                <div
                  data-testid="orderbook-available-hint"
                  style={{
                    padding: 'var(--space-xs) var(--space-md)',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--fg-dimmer)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  다음 가용: {formatTime(spotAvailableFrom!)}
                </div>
              )}
              <OrderbookTable snapshot={orderbookForCard} />
              <TotalQtyBar snapshot={orderbookForCard} maskRatio={maskRatio} />
            </>
          }
          program={
            <ProgramTradeSummaryCard
              series={programTrade}
              cursorMs={isSpot ? cursorMs : null}
            />
          }
          brokers={
            <BrokerTrajectoryTable series={brokerSeriesForCard} cursorMs={brokerCursorMs} />
          }
          investor={<InvestorTrendEstimateCard query={investorTrendEstimate} />}
        />
```

Also remove the `CursorSidebar` import and add:

```ts
import { LiveDetailPanel } from './LiveDetailPanel';
```

- [ ] **Step 5: Run sidebar tests**

Run: `cd frontend && npx vitest run src/live/LiveDetailPanel.test.tsx src/live/LiveSidebar.test.tsx`

Expected: PASS. If `LiveSidebar.test.tsx` still looks for `card-*` test IDs, update it to the new `live-detail-card-*` IDs while keeping coverage of order and program summary content.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/LiveDetailPanel.tsx frontend/src/live/LiveDetailPanel.test.tsx frontend/src/live/LiveSidebar.tsx frontend/src/live/LiveSidebar.test.tsx
git commit -m "feat(live): render resizable detail panel stack"
```

---

### Task 3: Move Toolbar Into Chart Panel and Add Vertical Splitter

**Files:**
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/live/LiveWorkarea.test.tsx`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LivePage.test.tsx`

**Interfaces:**
- Consumes:
  - `LiveToolbar` props from `LivePage`
  - `useLiveLayoutStore.rightPanelWidthPx`
  - `clampRightPanelWidth`
- Produces:
  - `LiveWorkarea` props: `onOpenIndicators`, `onOpenSettings`, `studySaveControl`
  - Test IDs: `live-chart-panel`, `live-workarea-splitter`

- [ ] **Step 1: Write failing `LiveWorkarea` layout tests**

Append to `frontend/src/live/LiveWorkarea.test.tsx`:

```tsx
it('renders toolbar inside the chart panel and sidebar beside it', () => {
  render(
    <LiveWorkarea
      activeCode="005930"
      bundle={INDEX_BUNDLE}
      clampEngaged={false}
      isPastCandlesLoading={false}
      isExtending={false}
      live={LIVE}
      onOpenIndicators={vi.fn()}
      onOpenSettings={vi.fn()}
      studySaveControl={<button type="button">save</button>}
    />,
  );

  const chartPanel = screen.getByTestId('live-chart-panel');
  expect(chartPanel).toContainElement(screen.getByTestId('live-toolbar'));
  expect(screen.getByTestId('live-workarea-splitter')).toHaveAttribute('aria-orientation', 'vertical');
  expect(screen.getByTestId('sidebar-stub')).toBeInTheDocument();
});

it('hides the Live Detail Panel for representative index charts', () => {
  useLivePageStore.setState({ candleTimeframe: 'D' });
  render(
    <LiveWorkarea
      activeCode="index:KOSPI"
      activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
      bundle={INDEX_BUNDLE_WITH_LAST_CANDLE}
      clampEngaged={false}
      isPastCandlesLoading={false}
      isExtending={false}
      live={LIVE}
      onOpenIndicators={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );

  expect(screen.queryByTestId('sidebar-stub')).toBeNull();
  expect(screen.queryByTestId('live-workarea-splitter')).toBeNull();
  expect(screen.getByTestId('live-chart-panel')).toBeInTheDocument();
});
```

- [ ] **Step 2: Update `LiveWorkarea` props and render `ChartPanel`**

In `frontend/src/live/LiveWorkarea.tsx`, add imports:

```ts
import { type ReactNode } from 'react';
import { LiveToolbar } from './LiveToolbar';
import { clampRightPanelWidth, useLiveLayoutStore } from '../state/liveLayout';
```

Extend `Props`:

```ts
  onOpenIndicators?: () => void;
  onOpenSettings?: () => void;
  studySaveControl?: ReactNode;
```

Inside `LiveWorkarea`, read layout state:

```ts
  const rightPanelWidthPx = useLiveLayoutStore((s) => s.rightPanelWidthPx);
  const setRightPanelWidthPx = useLiveLayoutStore((s) => s.setRightPanelWidthPx);
  const isIndexInstrument = activeInstrument?.kind === 'index';
```

Replace the active-code JSX body with this structure:

```tsx
          <div
            data-testid="live-chart-panel"
            ref={chartPanelRef}
            style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            {onOpenIndicators && onOpenSettings && (
              <LiveToolbar
                onOpenIndicators={onOpenIndicators}
                onOpenSettings={onOpenSettings}
                studySaveControl={studySaveControl}
              />
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <LiveChartRoot
                code={activeCode}
                timeframe={timeframe}
                venue={venue}
                bundle={bundle}
                chartBundle={chartBundle}
                clampEngaged={clampEngaged}
                isPastCandlesLoading={isPastCandlesLoading}
                isExtending={isExtending}
                pastDataWarnings={pastDataWarnings}
                restoreViewport={restoreViewport}
                viewIdentity={viewIdentity ?? undefined}
                dayAskPeaks={dayAskPeaks}
                todayAllPriceAskPeak={todayAllPriceAskPeak}
                dayBidPeaks={dayBidPeaks}
                todayAllPriceBidPeak={todayAllPriceBidPeak}
                todayKst={todayKst}
                tradeVolumePocs={tradeVolumePocs}
                paneTogglesOverride={paneTogglesOverride}
                onViewportCaptureReady={onViewportCaptureReady}
                onCandleBasisHover={rankingAllowed ? handleCandleBasisHover : undefined}
                onCandleBasisClick={rankingAllowed ? handleCandleBasisClick : undefined}
              />
            </div>
            {rankingAllowed && (
              <IndexSectorRankingPane
                basisDate={rankingBasis.date}
                basisMode={rankingBasis.mode}
                ranking={rankingQuery.data}
                isLoading={rankingQuery.isLoading}
                error={rankingQuery.error}
                onClearDatePin={() => rankingDispatch({ type: 'clear_date_pin' })}
                onOpenStock={handleOpenStock}
              />
            )}
          </div>
          {!isIndexInstrument && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="차트 / 상세 패널 크기 조절"
                data-testid="live-workarea-splitter"
                style={{ width: 6, cursor: 'col-resize', display: 'grid', placeItems: 'center' }}
              >
                <div aria-hidden style={{ width: 1, height: '100%', background: 'var(--border)' }} />
              </div>
              <div
                role="complementary"
                aria-label="Live Detail Panel"
                style={{
                  width: rightPanelWidthPx,
                  flexShrink: 0,
                  borderLeft: '1px solid var(--border)',
                }}
              >
                <LiveSidebar
                  code={activeCode}
                  live={live}
                  programTrade={(chartBundle ?? bundle)?.program_trade ?? null}
                />
              </div>
            </>
          )}
```

Use a `chartPanelRef` for the drop target. Replace the existing workarea-wide hit test with chart-panel rect hit testing:

```ts
  const chartPanelRef = useRef<HTMLDivElement>(null);
```

In the `hitTest`, use `chartPanelRef.current` instead of `workareaRef.current`.

- [ ] **Step 3: Add vertical pointer drag behavior**

In `LiveWorkarea`, add the pointer handler:

```ts
  const beginWidthResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const workarea = workareaRef.current;
    if (!workarea) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = useLiveLayoutStore.getState().rightPanelWidthPx;
    const workareaWidth = workarea.clientWidth;
    const target = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      const next = clampRightPanelWidth(startWidth - (moveEvent.clientX - startX), workareaWidth);
      useLiveLayoutStore.setState({ rightPanelWidthPx: next });
    };
    const up = (upEvent: PointerEvent) => {
      target.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setRightPanelWidthPx(useLiveLayoutStore.getState().rightPanelWidthPx);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [setRightPanelWidthPx]);
```

Attach it to `live-workarea-splitter`:

```tsx
onPointerDown={beginWidthResize}
```

- [ ] **Step 4: Move `LiveToolbar` out of `LivePage` grid**

In `frontend/src/live/LivePage.tsx`:

1. Remove `LiveToolbar` from the top-level JSX.
2. Change `gridTemplateRows` from:

```ts
'var(--h-live-header) 40px auto var(--h-pricestrip) var(--h-toolbar) minmax(0, 1fr)'
```

to:

```ts
'var(--h-live-header) 40px auto var(--h-pricestrip) minmax(0, 1fr)'
```

3. Pass toolbar props into `LiveWorkarea`:

```tsx
        onOpenIndicators={() => setIndicatorPanelOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        studySaveControl={<LiveStudyViewSaveButton />}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
cd frontend
npx vitest run src/live/LiveWorkarea.test.tsx src/live/LivePage.test.tsx
```

Expected: PASS after updating mocks for the new `LiveWorkarea` props.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/LiveWorkarea.tsx frontend/src/live/LiveWorkarea.test.tsx frontend/src/live/LivePage.tsx frontend/src/live/LivePage.test.tsx
git commit -m "feat(live): move toolbar into resizable chart panel"
```

---

### Task 4: Polish Splitter Behavior and Layout Regression Tests

**Files:**
- Modify: `frontend/src/live/LiveWorkarea.test.tsx`
- Modify: `frontend/src/live/LiveDetailPanel.test.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/live/LiveDetailPanel.tsx`

**Interfaces:**
- Consumes:
  - `live-workarea-splitter`
  - `live-detail-resizer-*`
- Produces:
  - Verified pointer drag updates store during drag and persists on pointerup.
  - Verified separator labels and no text-selection leakage.

- [ ] **Step 1: Add pointer drag tests for vertical splitter**

Append to `frontend/src/live/LiveWorkarea.test.tsx`:

```tsx
it('dragging the vertical splitter updates the live layout width', () => {
  useLiveLayoutStore.setState({ rightPanelWidthPx: 400 });
  render(
    <LiveWorkarea
      activeCode="005930"
      bundle={INDEX_BUNDLE}
      clampEngaged={false}
      isPastCandlesLoading={false}
      isExtending={false}
      live={LIVE}
      onOpenIndicators={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
  Object.defineProperty(screen.getByTestId('live-workarea'), 'clientWidth', { configurable: true, value: 1600 });

  fireEvent.pointerDown(screen.getByTestId('live-workarea-splitter'), { pointerId: 1, clientX: 1200 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 1100 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 1100 });

  expect(useLiveLayoutStore.getState().rightPanelWidthPx).toBe(500);
});
```

Add imports:

```ts
import { useLiveLayoutStore } from '../state/liveLayout';
```

- [ ] **Step 2: Add pointer drag tests for horizontal splitter**

Append to `frontend/src/live/LiveDetailPanel.test.tsx`:

```tsx
it('dragging a horizontal splitter transfers weight to the adjacent card', () => {
  useLiveLayoutStore.setState({
    rightPanelWidthPx: 400,
    rightCardWeights: { orderbook: 48, program: 13, brokers: 24, investor: 15 },
  });
  render(
    <LiveDetailPanel
      orderbook={<div />}
      program={<div />}
      brokers={<div />}
      investor={<div />}
    />,
  );
  Object.defineProperty(screen.getByTestId('live-detail-panel'), 'clientHeight', { configurable: true, value: 1000 });

  fireEvent.pointerDown(screen.getByTestId('live-detail-resizer-orderbook-program'), { pointerId: 1, clientY: 500 });
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 550 });
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 550 });

  expect(useLiveLayoutStore.getState().rightCardWeights.orderbook).toBeGreaterThan(48);
  expect(useLiveLayoutStore.getState().rightCardWeights.program).toBeLessThan(13);
});
```

- [ ] **Step 3: Fix pointer capture in jsdom tests if needed**

If jsdom elements lack pointer-capture methods, add this setup near the tests that drag:

```ts
beforeEach(() => {
  Element.prototype.setPointerCapture ??= function () {};
  Element.prototype.releasePointerCapture ??= function () {};
});
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd frontend
npx vitest run src/state/liveLayout.test.ts src/live/LiveDetailPanel.test.tsx src/live/LiveWorkarea.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveWorkarea.tsx frontend/src/live/LiveWorkarea.test.tsx frontend/src/live/LiveDetailPanel.tsx frontend/src/live/LiveDetailPanel.test.tsx
git commit -m "test(live): cover workarea splitter interactions"
```

---

### Task 5: Final Verification and Browser QA

**Files:**
- Inspect: `frontend/src/live/LiveWorkarea.tsx`
- Inspect: `frontend/src/live/LiveDetailPanel.tsx`
- Inspect: `frontend/src/live/LiveSidebar.tsx`
- Inspect: `frontend/src/state/liveLayout.ts`
- No new product files expected.

**Interfaces:**
- Consumes:
  - All previous tasks.
- Produces:
  - Verified nonblank chart after width resize.
  - Verified red empty area removed.
  - Verified representative index hides Live Detail Panel.

- [ ] **Step 1: Run complete focused suite**

Run:

```bash
cd frontend
npx vitest run \
  src/state/liveLayout.test.ts \
  src/live/LiveDetailPanel.test.tsx \
  src/live/LiveSidebar.test.tsx \
  src/live/LiveWorkarea.test.tsx \
  src/live/LivePage.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
cd frontend
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Start dev server**

Run:

```bash
cd frontend
npm run dev -- --host 127.0.0.1
```

Expected: Vite prints a local URL, usually `http://127.0.0.1:5173/`. Leave the server running for browser QA.

- [ ] **Step 4: Browser QA**

Open `/live` in Playwright or the in-app browser.

Verify:
- The toolbar appears only above the chart panel.
- The red empty area above 10호가 is gone.
- 10호가 starts beside the toolbar row.
- Dragging the vertical splitter changes chart/detail width.
- The chart remains nonblank after splitter drag.
- Dragging horizontal splitters changes Live Detail Panel card heights.
- Refresh preserves the chosen width/height weights.
- Representative Index tabs hide the Live Detail Panel and restore it when returning to a stock Code.

- [ ] **Step 5: Commit any QA fixes**

If QA required fixes:

```bash
git add frontend/src/live frontend/src/state
git commit -m "fix(live): polish resizable workarea layout"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

- **Spec coverage:** Tasks cover the Chart Panel ownership change, Live Detail Panel term, vertical splitter, horizontal splitters, stable card slots, stock-only panel visibility, global `/live` layout persistence, corrupt storage fallback, drop-target narrowing, and browser QA.
- **Placeholder scan:** No `TBD`, `TODO`, or "similar to" steps remain. Every task lists concrete file paths, test code, commands, and expected outcomes.
- **Type consistency:** `LiveCardWeights`, `rightCardWeights`, `rightPanelWidthPx`, `LiveDetailPanel`, and `live.layout.v1` are introduced in Task 1/2 and reused consistently later.
