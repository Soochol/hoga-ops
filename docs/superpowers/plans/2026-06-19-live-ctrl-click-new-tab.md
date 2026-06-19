# Live Ctrl Click New Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Ctrl+click and Meta+click on symbols in watchlist, screener, and heatmap surfaces to open that symbol in a new focused `/live` tab while preserving normal click behavior as active-tab replacement.

**Architecture:** Keep tab policy centralized in `useJumpToLive` and `useLiveTabsStore`. Row components translate mouse modifiers into a small `LiveOpenDisposition` intent, then `useJumpToLive` chooses `setActiveTabCode` or a new atomic `openSymbolInNewTab` store action. The new-tab action snapshots the outgoing viewport, appends a populated tab, focuses it, and projects it to `useLivePageStore` in one operation.

**Tech Stack:** React 18, React Router 7, Zustand 4, TypeScript 6, Vitest, Testing Library.

## Global Constraints

- Follow `CLAUDE.md`: browser checks use `/browse` when needed; do not use Playwright MCP tools in this repo.
- Follow `CLAUDE.md`: read `DESIGN.md` before visual or UI decisions. This change has no visual design changes.
- Preserve ADR-0069 live tab model: normal row click replaces the active tab; explicit new-tab intent creates a new tab.
- Support both Windows/Linux `ctrlKey` and macOS `metaKey`.
- Do not change capture button, heart button, context menu, drag-and-drop, or keyboard Enter/Space behavior.
- Run targeted Vitest suites and `npm run build` before completion.

---

## File Structure

- Create `frontend/src/live/liveActivation.ts`
  - Owns the `LiveOpenDisposition` type and mouse modifier translation helper.
  - Keeps Ctrl/Meta policy out of row components.
- Modify `frontend/src/state/liveTabs.ts`
  - Adds `openSymbolInNewTab(code, label?)`.
  - Updates comments that currently say clicks never create tabs.
- Modify `frontend/src/live/useJumpToLive.ts`
  - Accepts optional `{ disposition }`.
  - Routes `current-tab` to `setActiveTabCode` and `new-tab` to `openSymbolInNewTab`.
- Modify `frontend/src/live/useJumpToLive.test.tsx`
  - Locks current-tab default behavior.
  - Locks Ctrl/Meta style new-tab behavior through the hook API.
- Modify `frontend/src/screener/ResultTable.tsx`
  - Converts row mouse events to `LiveOpenDisposition`.
  - Leaves keyboard activation as current-tab.
- Modify `frontend/src/pages/Screener.test.tsx`
  - Updates live tab store mock to expose both tab actions.
  - Adds Ctrl-click regression coverage.
- Modify `frontend/src/heatmap/HeatmapBoard.tsx`, `frontend/src/heatmap/HeatmapFolder.tsx`, `frontend/src/heatmap/HeatmapRow.tsx`
  - Propagates activation disposition from heatmap row clicks.
  - Leaves row drag and context menu behavior unchanged.
- Modify `frontend/src/pages/Heatmap.test.tsx`
  - Updates live tab store mock to expose both tab actions.
  - Adds Ctrl-click regression coverage.
- Modify any other heatmap page tests that mock `../state/liveTabs`
  - `frontend/src/pages/Heatmap.rowmenu.test.tsx`
  - `frontend/src/pages/Heatmap.newgroup.test.tsx`
  - `frontend/src/pages/Heatmap.dragFreeze.test.tsx`
  - Ensure mocks include all selectors used by `useJumpToLive`.
- Modify `frontend/src/rightrail/QuoteRow.tsx`
  - Converts row mouse events to `LiveOpenDisposition`.
  - Leaves Delete and Enter/Space key behavior unchanged.
- Modify `frontend/src/watchlist/WatchlistDrawer.tsx`
  - Updates `SortableQuoteRow` and call sites to pass disposition to `onPick`.
- Modify `frontend/src/watchlist/WatchlistDrawer.test.tsx`
  - Adds Ctrl-click coverage using the real live tab/page stores.

---

### Task 1: Centralize Live Open Intent and Tab Store Behavior

**Files:**
- Create: `frontend/src/live/liveActivation.ts`
- Modify: `frontend/src/state/liveTabs.ts:61-233`
- Modify: `frontend/src/live/useJumpToLive.ts:1-17`
- Test: `frontend/src/live/useJumpToLive.test.tsx`

**Interfaces:**
- Produces: `type LiveOpenDisposition = 'current-tab' | 'new-tab'`
- Produces: `function dispositionFromMouseEvent(e: Pick<React.MouseEvent, 'ctrlKey' | 'metaKey'>): LiveOpenDisposition`
- Produces: `useLiveTabsStore.getState().openSymbolInNewTab(code: string, label?: string): void`
- Produces: `useJumpToLive(): (code: string, label?: string, options?: { disposition?: LiveOpenDisposition }) => void`
- Consumes: existing `useLiveTabsStore.setActiveTabCode(code, label?)`
- Consumes: existing `applyTabToPage(tab)`

- [ ] **Step 1: Write the failing helper and hook tests**

Add these imports to `frontend/src/live/useJumpToLive.test.tsx`:

```tsx
import { dispositionFromMouseEvent } from './liveActivation';
```

Append these tests inside `describe('useJumpToLive', () => { ... })`:

```tsx
  it('maps Ctrl and Meta mouse events to new-tab disposition', () => {
    expect(dispositionFromMouseEvent({ ctrlKey: false, metaKey: false })).toBe('current-tab');
    expect(dispositionFromMouseEvent({ ctrlKey: true, metaKey: false })).toBe('new-tab');
    expect(dispositionFromMouseEvent({ ctrlKey: false, metaKey: true })).toBe('new-tab');
    expect(dispositionFromMouseEvent({ ctrlKey: true, metaKey: true })).toBe('new-tab');
  });

  it('new-tab disposition appends a focused populated tab and preserves the previous tab', () => {
    useLiveTabsStore.setState({
      tabs: [{
        id: 'tab-a',
        code: '000660',
        label: 'SK하이닉스',
        timeframe: '1m',
        historicalFromDate: null,
        viewport: null,
      }],
      activeTabId: 'tab-a',
    });
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null });

    const { result } = renderHook(() => useJumpToLive(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>,
    });

    result.current('005930', '삼성전자', { disposition: 'new-tab' });

    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['000660', '005930']);
    expect(tabs[1]).toMatchObject({
      code: '005930',
      label: '삼성전자',
      timeframe: '1m',
      historicalFromDate: null,
      viewport: null,
    });
    expect(activeTabId).toBe(tabs[1].id);
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });

  it('current-tab disposition keeps replacing the active tab', () => {
    useLiveTabsStore.setState({
      tabs: [{
        id: 'tab-a',
        code: '000660',
        label: 'SK하이닉스',
        timeframe: '1m',
        historicalFromDate: null,
        viewport: null,
      }],
      activeTabId: 'tab-a',
    });
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null });

    const { result } = renderHook(() => useJumpToLive(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>,
    });

    result.current('005930', '삼성전자', { disposition: 'current-tab' });

    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['005930']);
    expect(activeTabId).toBe('tab-a');
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });
```

- [ ] **Step 2: Run the hook tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/live/useJumpToLive.test.tsx
```

Expected: FAIL with an import error for `./liveActivation` or a TypeScript error that `openSymbolInNewTab` / `disposition` does not exist.

- [ ] **Step 3: Create the live activation helper**

Create `frontend/src/live/liveActivation.ts`:

```ts
export type LiveOpenDisposition = 'current-tab' | 'new-tab';

export type MouseModifierState = Pick<React.MouseEvent, 'ctrlKey' | 'metaKey'>;

export function dispositionFromMouseEvent(e: MouseModifierState): LiveOpenDisposition {
  return e.ctrlKey || e.metaKey ? 'new-tab' : 'current-tab';
}
```

- [ ] **Step 4: Add the atomic new-symbol-tab store action**

In `frontend/src/state/liveTabs.ts`, change the `TabsStore` type block to include the new action and updated comment:

```ts
type TabsStore = {
  tabs: LiveTab[];
  activeTabId: string | null;
  /** 활성 탭의 종목을 제자리 교체한다(관심종목/검색/스크리너/히트맵 일반 클릭·드롭의 공통 동작).
   *  활성 탭이 없으면(첫 진입·전체 닫힘) 이 종목으로 첫 탭을 만든다. 단일-탭 기본 모델
   *  (ADR-0069 개정): 일반 클릭은 현재 탭을 바꾸고, 명시적 새 탭 intent(Ctrl/Meta 클릭)는
   *  openSymbolInNewTab을 사용한다. 같은 코드가 다른 탭에 있어도 포커스하지 않고 현재 탭을
   *  교체한다(중복 허용). */
  setActiveTabCode: (code: string, label?: string) => void;
  /** 종목이 채워진 새 탭을 만들어 포커스한다(Ctrl/Meta+종목 클릭). 중복 탭은 허용한다. */
  openSymbolInNewTab: (code: string, label?: string) => void;
  /** 빈 탭을 만들어 포커스한다(+ 버튼). 종목 선택 전까지 빈 상태(검색 안내)를 보인다. */
  addBlankTab: () => void;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTabs: (from: number, to: number) => void;
};
```

In the Zustand store object, insert this action between `setActiveTabCode` and `addBlankTab`:

```ts
  openSymbolInNewTab: (code, label) => {
    snapshotActiveViewport();
    const tab: LiveTab = {
      id: nanoid(8),
      code,
      label: label ?? code,
      timeframe: useLivePageStore.getState().candleTimeframe,
      historicalFromDate: null,
      viewport: null,
    };
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
    applyTabToPage(tab);
  },
```

- [ ] **Step 5: Route disposition in `useJumpToLive`**

Replace `frontend/src/live/useJumpToLive.ts` with:

```ts
import { useNavigate, useLocation } from 'react-router';
import { useLiveTabsStore } from '../state/liveTabs';
import type { LiveOpenDisposition } from './liveActivation';

type JumpToLiveOptions = {
  disposition?: LiveOpenDisposition;
};

/** 차트로 점프: 기본은 현재(활성) 탭의 종목을 바꾸고, 명시적 새 탭 intent(Ctrl/Meta 클릭)는
 *  종목이 채워진 새 탭을 만든다. /live 가 아니면 이동한다.
 *  관심종목/스크리너/히트맵 행 클릭의 공통 jump-to-chart 동작(CONTEXT.md).
 *  활성 탭이 없으면 setActiveTabCode가 첫 탭을 만든다. 활성 탭이
 *  useLivePageStore.activeCode의 단일 writer(D4). */
export function useJumpToLive() {
  const setActiveTabCode = useLiveTabsStore((s) => s.setActiveTabCode);
  const openSymbolInNewTab = useLiveTabsStore((s) => s.openSymbolInNewTab);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (code: string, label?: string, options: JumpToLiveOptions = {}) => {
    if (options.disposition === 'new-tab') openSymbolInNewTab(code, label);
    else setActiveTabCode(code, label);
    if (pathname !== '/live') navigate('/live');
  };
}
```

- [ ] **Step 6: Run the hook tests and verify they pass**

Run:

```bash
cd frontend && npx vitest run src/live/useJumpToLive.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add frontend/src/live/liveActivation.ts frontend/src/live/useJumpToLive.ts frontend/src/live/useJumpToLive.test.tsx frontend/src/state/liveTabs.ts
git commit -m "feat: support new live symbol tabs"
```

Expected: commit succeeds.

---

### Task 2: Wire Screener Ctrl/Meta Click

**Files:**
- Modify: `frontend/src/screener/ResultTable.tsx:1-53`
- Modify: `frontend/src/pages/Screener.test.tsx:31-90`

**Interfaces:**
- Consumes: `dispositionFromMouseEvent(e): LiveOpenDisposition`
- Consumes: `useJumpToLive()(code, label, { disposition })`
- Produces: Screener mouse clicks call `onActivate(code, name, { disposition })`; keyboard activation remains `onActivate(code, name)`.

- [ ] **Step 1: Write the failing screener test**

In `frontend/src/pages/Screener.test.tsx`, replace the hoisted live-tabs mock block with:

```tsx
const { setActiveTabCode, openSymbolInNewTab } = vi.hoisted(() => ({
  setActiveTabCode: vi.fn(),
  openSymbolInNewTab: vi.fn(),
}));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: {
    setActiveTabCode: typeof setActiveTabCode;
    openSymbolInNewTab: typeof openSymbolInNewTab;
  }) => unknown) => sel({ setActiveTabCode, openSymbolInNewTab }),
}));
```

Add this test after `runs scan and renders row; click sets the active tab code`:

```tsx
it('Ctrl-clicking a row opens the result in a new live tab', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await waitFor(() => screen.getByText('삼성전자'));
  fireEvent.click(screen.getByText('삼성전자'), { ctrlKey: true });
  expect(openSymbolInNewTab).toHaveBeenCalledWith('005930', '삼성전자');
  expect(setActiveTabCode).not.toHaveBeenCalled();
});
```

Add this test after the Ctrl-click test:

```tsx
it('Meta-clicking a row opens the result in a new live tab', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await waitFor(() => screen.getByText('삼성전자'));
  fireEvent.click(screen.getByText('삼성전자'), { metaKey: true });
  expect(openSymbolInNewTab).toHaveBeenCalledWith('005930', '삼성전자');
  expect(setActiveTabCode).not.toHaveBeenCalled();
});
```

Add this cleanup to the existing `afterEach`:

```tsx
afterEach(() => {
  vi.mocked(useQuoteByCode).mockReturnValue(new Map());
  setActiveTabCode.mockClear();
  openSymbolInNewTab.mockClear();
});
```

If the file already has the one-line `afterEach`, replace it with the block above.

- [ ] **Step 2: Run the screener tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/pages/Screener.test.tsx
```

Expected: FAIL because `ResultTable` still calls `onActivate(code, name)` without forwarding disposition.

- [ ] **Step 3: Update `ResultTable` props and mouse handling**

In `frontend/src/screener/ResultTable.tsx`, add the import:

```tsx
import { dispositionFromMouseEvent, type LiveOpenDisposition } from '../live/liveActivation';
```

Change the props interface to:

```tsx
interface Props {
  /** Live Quote 가 이미 머지된 결과 행(useScreenerRowsLive). 표시만 하면 된다. */
  rows: ScreenerRowLive[];
  onActivate: (code: string, name?: string, options?: { disposition?: LiveOpenDisposition }) => void;
  onCapture: (code: string) => void;
}
```

Change the row click handler from:

```tsx
onClick={() => onActivate(r.code, r.name)} onKeyDown={onKeyDown}
```

to:

```tsx
onClick={(e) => onActivate(r.code, r.name, { disposition: dispositionFromMouseEvent(e) })} onKeyDown={onKeyDown}
```

Keep the keyboard handler exactly as:

```tsx
const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(r.code, r.name); }
};
```

- [ ] **Step 4: Run the screener tests and verify they pass**

Run:

```bash
cd frontend && npx vitest run src/pages/Screener.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add frontend/src/screener/ResultTable.tsx frontend/src/pages/Screener.test.tsx
git commit -m "feat: open screener symbols in new live tabs"
```

Expected: commit succeeds.

---

### Task 3: Wire Heatmap Ctrl/Meta Click

**Files:**
- Modify: `frontend/src/heatmap/HeatmapBoard.tsx:1-69`
- Modify: `frontend/src/heatmap/HeatmapFolder.tsx:1-154`
- Modify: `frontend/src/heatmap/HeatmapRow.tsx:1-75`
- Modify: `frontend/src/pages/Heatmap.test.tsx:42-95`
- Modify: `frontend/src/pages/Heatmap.rowmenu.test.tsx`
- Modify: `frontend/src/pages/Heatmap.newgroup.test.tsx`
- Modify: `frontend/src/pages/Heatmap.dragFreeze.test.tsx`

**Interfaces:**
- Consumes: `dispositionFromMouseEvent(e): LiveOpenDisposition`
- Consumes: `onPick(code, name, { disposition })`
- Produces: Heatmap mouse clicks pass `new-tab` for Ctrl/Meta and `current-tab` otherwise.

- [ ] **Step 1: Write the failing heatmap page test**

In `frontend/src/pages/Heatmap.test.tsx`, replace the live-tabs mock with:

```tsx
const { setActiveTabCode, openSymbolInNewTab } = vi.hoisted(() => ({
  setActiveTabCode: vi.fn(),
  openSymbolInNewTab: vi.fn(),
}));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: {
    setActiveTabCode: typeof setActiveTabCode;
    openSymbolInNewTab: typeof openSymbolInNewTab;
  }) => unknown) => sel({ setActiveTabCode, openSymbolInNewTab }),
}));
```

In that file's `beforeEach`, add:

```tsx
  setActiveTabCode.mockClear();
  openSymbolInNewTab.mockClear();
```

Add this test after `행 클릭 → 종목 탭 open-or-focus(jump-to-live)`:

```tsx
it('Ctrl-clicking a heatmap row opens a new live tab', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'), { ctrlKey: true });
  expect(openSymbolInNewTab).toHaveBeenCalledWith('005930', '삼성전자');
  expect(setActiveTabCode).not.toHaveBeenCalled();
});
```

Add this test after the Ctrl-click test:

```tsx
it('Meta-clicking a heatmap row opens a new live tab', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'), { metaKey: true });
  expect(openSymbolInNewTab).toHaveBeenCalledWith('005930', '삼성전자');
  expect(setActiveTabCode).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the heatmap test and verify it fails**

Run:

```bash
cd frontend && npx vitest run src/pages/Heatmap.test.tsx
```

Expected: FAIL because heatmap rows still call `onPick(code, name)` without disposition.

- [ ] **Step 3: Update heatmap prop types**

In `frontend/src/heatmap/HeatmapBoard.tsx`, add:

```tsx
import type { LiveOpenDisposition } from '../live/liveActivation';
```

Change the `onPick` prop to:

```tsx
  onPick: (code: string, name?: string, options?: { disposition?: LiveOpenDisposition }) => void;
```

In `frontend/src/heatmap/HeatmapFolder.tsx`, add:

```tsx
import type { LiveOpenDisposition } from '../live/liveActivation';
```

Change the `onPick` prop to:

```tsx
  onPick: (code: string, name?: string, options?: { disposition?: LiveOpenDisposition }) => void;
```

Change `SortableHeatmapRow` props to:

```tsx
function SortableHeatmapRow(props: {
  code: string; name: string; price: number | null; pct: number | null;
  open?: number | null; high?: number | null; low?: number | null;
  onPick: (options?: { disposition?: LiveOpenDisposition }) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
```

In the draggable row map, change:

```tsx
onPick={() => onPick(e.code, e.name)}
```

to:

```tsx
onPick={(options) => onPick(e.code, e.name, options)}
```

In the non-draggable row map, change:

```tsx
onClick={() => onPick(e.code, e.name)}
```

to:

```tsx
onClick={(options) => onPick(e.code, e.name, options)}
```

- [ ] **Step 4: Update `HeatmapRow` mouse handling**

In `frontend/src/heatmap/HeatmapRow.tsx`, add:

```tsx
import { dispositionFromMouseEvent, type LiveOpenDisposition } from '../live/liveActivation';
```

Change `HeatmapRowProps.onClick` to:

```tsx
  onClick: (options?: { disposition?: LiveOpenDisposition }) => void;
```

Change the root click handler from:

```tsx
      onClick={onClick}
```

to:

```tsx
      onClick={(e) => onClick({ disposition: dispositionFromMouseEvent(e) })}
```

Keep the keyboard handler current-tab by changing it to:

```tsx
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
```

This is the same behavior as before for keyboard users.

- [ ] **Step 5: Update other heatmap test mocks**

In each file below, ensure the `../state/liveTabs` mock exposes both selectors:

`frontend/src/pages/Heatmap.rowmenu.test.tsx`

```tsx
const { setActiveTabCode, openSymbolInNewTab } = vi.hoisted(() => ({
  setActiveTabCode: vi.fn(),
  openSymbolInNewTab: vi.fn(),
}));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: {
    setActiveTabCode: typeof setActiveTabCode;
    openSymbolInNewTab: typeof openSymbolInNewTab;
  }) => unknown) => sel({ setActiveTabCode, openSymbolInNewTab }),
}));
```

`frontend/src/pages/Heatmap.newgroup.test.tsx`

```tsx
const { setActiveTabCode, openSymbolInNewTab } = vi.hoisted(() => ({
  setActiveTabCode: vi.fn(),
  openSymbolInNewTab: vi.fn(),
}));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: {
    setActiveTabCode: typeof setActiveTabCode;
    openSymbolInNewTab: typeof openSymbolInNewTab;
  }) => unknown) => sel({ setActiveTabCode, openSymbolInNewTab }),
}));
```

`frontend/src/pages/Heatmap.dragFreeze.test.tsx`

```tsx
const { setActiveTabCode, openSymbolInNewTab } = vi.hoisted(() => ({
  setActiveTabCode: vi.fn(),
  openSymbolInNewTab: vi.fn(),
}));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: {
    setActiveTabCode: typeof setActiveTabCode;
    openSymbolInNewTab: typeof openSymbolInNewTab;
  }) => unknown) => sel({ setActiveTabCode, openSymbolInNewTab }),
}));
```

- [ ] **Step 6: Run heatmap tests and verify they pass**

Run:

```bash
cd frontend && npx vitest run src/pages/Heatmap.test.tsx src/pages/Heatmap.rowmenu.test.tsx src/pages/Heatmap.newgroup.test.tsx src/pages/Heatmap.dragFreeze.test.tsx src/heatmap/HeatmapRow.test.tsx src/heatmap/HeatmapFolder.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add frontend/src/heatmap/HeatmapBoard.tsx frontend/src/heatmap/HeatmapFolder.tsx frontend/src/heatmap/HeatmapRow.tsx frontend/src/pages/Heatmap.test.tsx frontend/src/pages/Heatmap.rowmenu.test.tsx frontend/src/pages/Heatmap.newgroup.test.tsx frontend/src/pages/Heatmap.dragFreeze.test.tsx
git commit -m "feat: open heatmap symbols in new live tabs"
```

Expected: commit succeeds.

---

### Task 4: Wire Watchlist Ctrl/Meta Click

**Files:**
- Modify: `frontend/src/rightrail/QuoteRow.tsx:1-101`
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx:260-360`
- Modify: `frontend/src/watchlist/WatchlistDrawer.test.tsx:1-90`
- Test: `frontend/src/rightrail/QuoteRow.test.tsx`

**Interfaces:**
- Consumes: `dispositionFromMouseEvent(e): LiveOpenDisposition`
- Consumes: `onPick(options?: { disposition?: LiveOpenDisposition })`
- Produces: Watchlist row mouse clicks pass Ctrl/Meta new-tab disposition through `useJumpToLive`.

- [ ] **Step 1: Write the failing watchlist integration test**

In `frontend/src/watchlist/WatchlistDrawer.test.tsx`, add:

```tsx
import { useLiveTabsStore } from '../state/liveTabs';
```

In `beforeEach`, add this after `useLivePageStore.setState(...)`:

```tsx
    useLiveTabsStore.setState({ tabs: [], activeTabId: null });
```

Add this test after `clicking a row sets activeCode and navigates to /live when elsewhere`:

```tsx
  it('Ctrl-clicking a row opens the symbol in a new focused live tab', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    useLiveTabsStore.setState({
      tabs: [{
        id: 'tab-a',
        code: '000660',
        label: 'SK하이닉스',
        timeframe: '1m',
        historicalFromDate: null,
        viewport: null,
      }],
      activeTabId: 'tab-a',
    });
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    fireEvent.click(screen.getByText('삼성전자'), { ctrlKey: true });

    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['000660', '005930']);
    expect(tabs[1]).toMatchObject({ code: '005930', label: '삼성전자' });
    expect(activeTabId).toBe(tabs[1].id);
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });
```

Add this test after the Ctrl-click test:

```tsx
  it('Meta-clicking a row opens the symbol in a new focused live tab', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    useLiveTabsStore.setState({
      tabs: [{
        id: 'tab-a',
        code: '000660',
        label: 'SK하이닉스',
        timeframe: '1m',
        historicalFromDate: null,
        viewport: null,
      }],
      activeTabId: 'tab-a',
    });
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    fireEvent.click(screen.getByText('삼성전자'), { metaKey: true });

    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['000660', '005930']);
    expect(tabs[1]).toMatchObject({ code: '005930', label: '삼성전자' });
    expect(activeTabId).toBe(tabs[1].id);
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });
```

- [ ] **Step 2: Run watchlist tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx
```

Expected: FAIL because watchlist row click still calls `onPick()` without disposition.

- [ ] **Step 3: Update `QuoteRow` click typing**

In `frontend/src/rightrail/QuoteRow.tsx`, add:

```tsx
import { dispositionFromMouseEvent, type LiveOpenDisposition } from '../live/liveActivation';
```

Change `QuoteRowProps.onClick` to:

```tsx
  onClick: (options?: { disposition?: LiveOpenDisposition }) => void;
```

Change the row click handler from:

```tsx
      onClick={onClick}
```

to:

```tsx
      onClick={(e) => onClick({ disposition: dispositionFromMouseEvent(e) })}
```

Keep the keyboard path current-tab by leaving this line as:

```tsx
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
```

- [ ] **Step 4: Update `WatchlistDrawer` propagation**

In `frontend/src/watchlist/WatchlistDrawer.tsx`, add:

```tsx
import type { LiveOpenDisposition } from '../live/liveActivation';
```

Change `SortableQuoteRow` props:

```tsx
  onPick: (options?: { disposition?: LiveOpenDisposition }) => void;
```

Change the `SortableQuoteRow` call site from:

```tsx
                          onPick={() => onPick(entry.code, entry.name)}
```

to:

```tsx
                          onPick={(options) => onPick(entry.code, entry.name, options)}
```

Do not change this drag-drop chart behavior:

```tsx
      onPick(d?.code ?? parseEntrySortableId(String(ev.active.id)).code, d?.name);
```

That path should remain current-tab because drag-to-chart means replace the displayed chart.

- [ ] **Step 5: Run quote row and watchlist tests**

Run:

```bash
cd frontend && npx vitest run src/rightrail/QuoteRow.test.tsx src/watchlist/WatchlistDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/src/rightrail/QuoteRow.tsx frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat: open watchlist symbols in new live tabs"
```

Expected: commit succeeds.

---

### Task 5: Full Verification and Contract Cleanup

**Files:**
- Modify if needed: `frontend/src/state/liveTabs.ts`
- Modify if needed: `frontend/src/live/useJumpToLive.ts`
- No new source files beyond Task 1.

**Interfaces:**
- Consumes: all previous task interfaces.
- Produces: verified behavior across all symbol surfaces and clean TypeScript build.

- [ ] **Step 1: Search for stale tab-policy comments**

Run:

```bash
rg -n "새 탭을 열지|클릭은 현재 탭|open-or-focus|setActiveTabCode\\(|useJumpToLive\\(" frontend/src docs/adr/0069-live-multi-tab-reintroduction.md
```

Expected: output may include implementation and tests. Comments that state all clicks never create tabs must be updated to say normal clicks replace the active tab and Ctrl/Meta clicks create new tabs.

- [ ] **Step 2: Update stale comments if found**

Use this wording for any stale comment in `frontend/src/state/liveTabs.ts` or `frontend/src/live/useJumpToLive.ts`:

```ts
// 일반 종목 클릭은 현재 탭을 교체하고, Ctrl/Meta+종목 클릭은 종목이 채워진 새 탭을 만든다.
// drag-to-chart는 명시적 차트 교체 동작이므로 현재 탭 교체를 유지한다.
```

If the search only finds test names that still describe normal click behavior, leave them when the test itself remains correct.

- [ ] **Step 3: Run targeted regression tests**

Run:

```bash
cd frontend && npx vitest run \
  src/live/useJumpToLive.test.tsx \
  src/pages/Screener.test.tsx \
  src/pages/Heatmap.test.tsx \
  src/pages/Heatmap.rowmenu.test.tsx \
  src/pages/Heatmap.newgroup.test.tsx \
  src/pages/Heatmap.dragFreeze.test.tsx \
  src/heatmap/HeatmapRow.test.tsx \
  src/heatmap/HeatmapFolder.test.tsx \
  src/rightrail/QuoteRow.test.tsx \
  src/watchlist/WatchlistDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run the frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS. TypeScript must not report incompatible `onClick` or `onPick` signatures.

- [ ] **Step 5: Inspect the final diff**

Run:

```bash
git diff --stat HEAD~4..HEAD
git diff HEAD~4..HEAD -- frontend/src/live frontend/src/state/liveTabs.ts frontend/src/screener frontend/src/heatmap frontend/src/pages frontend/src/rightrail frontend/src/watchlist
```

Expected: diff is limited to live tab intent handling, symbol-row event plumbing, and tests. No visual styling, capture, watchlist API, screener API, or heatmap data mutations changed.

- [ ] **Step 6: Commit final cleanup if Step 2 changed files**

If Step 2 edited comments, run:

```bash
git add frontend/src/state/liveTabs.ts frontend/src/live/useJumpToLive.ts
git commit -m "docs: clarify live tab click policy"
```

Expected: commit succeeds if files changed. If no files changed, skip this commit.

---

## Self-Review

**Spec coverage:** The plan covers 관심종목 via `QuoteRow` and `WatchlistDrawer`, 스크리너 via `ResultTable`, 히트맵 via `HeatmapRow`/`HeatmapFolder`/`HeatmapBoard`, and central live tab behavior via `useJumpToLive` and `liveTabs`.

**Placeholder scan:** The plan contains exact file paths, exact test code, exact implementation snippets, and exact commands. It does not rely on unspecified follow-up work.

**Type consistency:** `LiveOpenDisposition`, `dispositionFromMouseEvent`, `openSymbolInNewTab`, and the `{ disposition?: LiveOpenDisposition }` option shape are introduced in Task 1 and reused unchanged in Tasks 2 through 5.
