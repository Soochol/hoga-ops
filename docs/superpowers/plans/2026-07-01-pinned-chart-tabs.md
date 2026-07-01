# Pinned Chart Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add protected pinned tabs to `/live` and `/study` chart workspaces.

**Architecture:** Store pinned state on each Live/Study tab, keep pinned tabs ordered before normal tabs in each store, and expose a shared pin toggle through `ChartTabBar`. Live and Study pages pass their store actions into their existing tab bar wrappers.

**Tech Stack:** React, TypeScript, Zustand, Vite/Vitest, Testing Library, existing design tokens from `DESIGN.md`.

## Global Constraints

- `/live` and `/study` use the same visible tab behavior through `frontend/src/tabs/ChartTabBar.tsx`.
- Pinned tabs are protected from close and from active-tab replacement flows.
- Pinned tabs persist across reloads; older localStorage snapshots without `pinned` hydrate as unpinned.
- UI uses existing tokens only: `--accent`, `--fg-dim`, `--fg-dimmer`, `--bg-card`, `--bg-input`, `--bg-input-hover`, `--border`.
- Tab chrome remains within the existing 32px tab height and small icon control style.

---

## File Structure

- `frontend/src/state/liveTabs.ts`: add `pinned`, `toggleTabPinned`, pin-aware ordering, close protection, drag boundary protection, and active pinned replacement behavior.
- `frontend/src/state/studyTabs.ts`: add the same tab-level pinned behavior and study saved-view replacement protection.
- `frontend/src/tabs/ChartTabBar.tsx`: render pin controls and enforce close/drag constraints in the shared UI.
- `frontend/src/live/LiveTabBar.tsx`: pass `onTogglePin` to the shared tab bar.
- `frontend/src/studyViews/StudyTabBar.tsx`: pass `onTogglePin` to the shared tab bar.
- `frontend/src/live/LiveTabOverflowMenu.tsx`: prevent closing pinned tabs from the overflow menu and show the pinned state quietly.
- `frontend/src/state/liveTabs.test.ts`: cover Live store semantics.
- `frontend/src/state/studyTabs.test.ts`: cover Study store semantics.
- `frontend/src/live/LiveTabBar.test.tsx`: cover shared rendered behavior through the Live wrapper.

---

### Task 1: Live Store Pinned Semantics

**Files:**
- Modify: `frontend/src/state/liveTabs.ts`
- Test: `frontend/src/state/liveTabs.test.ts`

**Interfaces:**
- Produces: `LiveTab.pinned?: boolean`
- Produces: `TabsStore.toggleTabPinned(id: string): void`
- Produces: pin-aware `setActiveTabInstrument`, `closeTab`, `reorderTabs`, `toTabsSnapshot`, and `loadTabs`

- [ ] **Step 1: Write failing store tests**

Add tests covering:

```ts
it('persists pinned state in live tab snapshots', () => {
  const s = useLiveTabsStore.getState();
  s.openSymbolInNewTab('005930', '삼성전자');
  const id = useLiveTabsStore.getState().activeTabId!;
  useLiveTabsStore.getState().toggleTabPinned(id);
  expect(toTabsSnapshot(useLiveTabsStore.getState()).tabs[0]).toMatchObject({
    code: '005930',
    pinned: true,
  });
});

it('keeps pinned live tabs before unpinned tabs when toggled', () => {
  const s = useLiveTabsStore.getState();
  s.openSymbolInNewTab('A00001', 'A');
  s.openSymbolInNewTab('B00002', 'B');
  s.openSymbolInNewTab('C00003', 'C');
  const b = useLiveTabsStore.getState().tabs[1].id;
  useLiveTabsStore.getState().toggleTabPinned(b);
  expect(useLiveTabsStore.getState().tabs.map((t) => [t.code, Boolean(t.pinned)])).toEqual([
    ['B00002', true],
    ['A00001', false],
    ['C00003', false],
  ]);
});

it('does not close pinned live tabs', () => {
  const s = useLiveTabsStore.getState();
  s.openSymbolInNewTab('005930', '삼성전자');
  const id = useLiveTabsStore.getState().activeTabId!;
  s.toggleTabPinned(id);
  s.closeTab(id);
  expect(useLiveTabsStore.getState().tabs).toHaveLength(1);
  expect(useLiveTabsStore.getState().tabs[0].id).toBe(id);
});

it('does not drag live tabs across the pinned boundary', () => {
  const s = useLiveTabsStore.getState();
  s.openSymbolInNewTab('A00001', 'A');
  s.openSymbolInNewTab('B00002', 'B');
  s.openSymbolInNewTab('C00003', 'C');
  const a = useLiveTabsStore.getState().tabs[0].id;
  s.toggleTabPinned(a);
  s.reorderTabs(0, 2);
  expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(['A00001', 'B00002', 'C00003']);
});

it('replaces an unpinned live tab when the active tab is pinned', () => {
  const s = useLiveTabsStore.getState();
  s.openSymbolInNewTab('005930', '삼성전자');
  const pinnedId = useLiveTabsStore.getState().activeTabId!;
  s.toggleTabPinned(pinnedId);
  s.setActiveTabCode('000660', 'SK하이닉스');
  expect(useLiveTabsStore.getState().tabs.map((t) => [t.code, Boolean(t.pinned)])).toEqual([
    ['005930', true],
    ['000660', false],
  ]);
  expect(useLiveTabsStore.getState().activeTabId).not.toBe(pinnedId);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && npx vitest run src/state/liveTabs.test.ts`

Expected: FAIL because `toggleTabPinned` and `pinned` snapshot behavior do not exist.

- [ ] **Step 3: Implement Live store behavior**

In `liveTabs.ts`:

```ts
export type LiveTab = {
  id: string;
  instrument?: LiveInstrument | null;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  viewport?: TabViewport | null;
  pinned?: boolean;
};
```

Add helpers:

```ts
function orderPinnedFirst<T extends { pinned?: boolean }>(tabs: T[]): T[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

function samePinGroup(a: { pinned?: boolean }, b: { pinned?: boolean }): boolean {
  return Boolean(a.pinned) === Boolean(b.pinned);
}
```

Add `pinned` to snapshots, hydrate missing values as `false`, add `toggleTabPinned`, guard `closeTab`, guard `reorderTabs`, and in `setActiveTabInstrument` create/replace an unpinned tab when the active tab is pinned.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npx vitest run src/state/liveTabs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/liveTabs.ts frontend/src/state/liveTabs.test.ts
git commit -m "feat: add pinned live tab state"
```

---

### Task 2: Study Store Pinned Semantics

**Files:**
- Modify: `frontend/src/state/studyTabs.ts`
- Test: `frontend/src/state/studyTabs.test.ts`

**Interfaces:**
- Produces: `StudyTab.pinned?: boolean`
- Produces: `StudyTabsStore.toggleTabPinned(id: string): void`
- Produces: pin-aware `openSaveInActiveTab`, `closeTab`, `closeTabsByViewId`, `reorderTabs`, and `toStudyTabsSnapshot`

- [ ] **Step 1: Write failing store tests**

Add tests covering:

```ts
it('persists pinned state in study tab snapshots', () => {
  useStudyTabsStore.getState().openSaveInNewTab(save);
  const id = useStudyTabsStore.getState().activeTabId!;
  useStudyTabsStore.getState().toggleTabPinned(id);
  expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).toMatchObject({
    viewId: save.id,
    pinned: true,
  });
});

it('keeps pinned study tabs before unpinned tabs when toggled', () => {
  useStudyTabsStore.getState().openSaveInNewTab(save);
  useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
  const second = useStudyTabsStore.getState().tabs[1].id;
  useStudyTabsStore.getState().toggleTabPinned(second);
  expect(useStudyTabsStore.getState().tabs.map((t) => [t.viewId, Boolean(t.pinned)])).toEqual([
    ['view2', true],
    ['view1', false],
  ]);
});

it('does not close pinned study tabs', () => {
  useStudyTabsStore.getState().openSaveInNewTab(save);
  const id = useStudyTabsStore.getState().activeTabId!;
  useStudyTabsStore.getState().toggleTabPinned(id);
  useStudyTabsStore.getState().closeTab(id);
  expect(useStudyTabsStore.getState().tabs).toHaveLength(1);
});

it('opens an unpinned study tab when active pinned tab would be replaced', () => {
  useStudyTabsStore.getState().openSaveInNewTab(save);
  const pinnedId = useStudyTabsStore.getState().activeTabId!;
  useStudyTabsStore.getState().toggleTabPinned(pinnedId);
  useStudyTabsStore.getState().openSaveInActiveTab({ ...save, id: 'view2', name: '마감' });
  expect(useStudyTabsStore.getState().tabs.map((t) => [t.viewId, Boolean(t.pinned)])).toEqual([
    ['view1', true],
    ['view2', false],
  ]);
  expect(useStudyTabsStore.getState().activeTabId).not.toBe(pinnedId);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && npx vitest run src/state/studyTabs.test.ts`

Expected: FAIL because `toggleTabPinned` and pinned persistence do not exist.

- [ ] **Step 3: Implement Study store behavior**

In `studyTabs.ts`, add `pinned?: boolean`, snapshot persistence, hydration default, `toggleTabPinned`, close guards, drag guards, and pinned-active replacement protection in `openSaveInActiveTab`.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npx vitest run src/state/studyTabs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/studyTabs.ts frontend/src/state/studyTabs.test.ts
git commit -m "feat: add pinned study tab state"
```

---

### Task 3: Shared Tab Bar Pin UI

**Files:**
- Modify: `frontend/src/tabs/ChartTabBar.tsx`
- Modify: `frontend/src/live/LiveTabBar.tsx`
- Modify: `frontend/src/studyViews/StudyTabBar.tsx`
- Modify: `frontend/src/live/LiveTabOverflowMenu.tsx`
- Test: `frontend/src/live/LiveTabBar.test.tsx`

**Interfaces:**
- Consumes: `tab.pinned?: boolean`
- Consumes: `onTogglePin?: (id: string) => void`
- Produces: accessible pin buttons with Korean labels

- [ ] **Step 1: Write failing UI tests**

Add tests covering:

```tsx
it('toggles a tab pin from the tab bar', () => {
  const onTogglePin = vi.fn();
  setup({ onTogglePin });
  fireEvent.click(screen.getByLabelText('삼성전자 1분봉 고정'));
  expect(onTogglePin).toHaveBeenCalledWith('a');
});

it('does not render a close button for pinned tabs', () => {
  setup({
    tabs: [{ ...tabs[0], pinned: true }],
    activeTabId: 'a',
  });
  expect(screen.getByLabelText('삼성전자 1분봉 고정 해제')).toBeInTheDocument();
  expect(screen.queryByLabelText('005930 닫기')).toBeNull();
});

it('does not middle-click close a pinned tab', () => {
  const onClose = vi.fn();
  setup({
    tabs: [{ ...tabs[0], pinned: true }],
    activeTabId: 'a',
    onClose,
  });
  fireEvent.mouseDown(screen.getByText('삼성전자 1분봉').closest('[data-tab-id]')!, { button: 1 });
  expect(onClose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && npx vitest run src/live/LiveTabBar.test.tsx`

Expected: FAIL because `onTogglePin` and pin buttons do not exist.

- [ ] **Step 3: Implement shared UI**

In `ChartTabBar.tsx`, extend `ChartTabLike` and props:

```ts
type ChartTabLike = {
  id: string;
  code: string;
  label: string;
  pinned?: boolean;
};

type Props<T extends ChartTabLike> = {
  tabs: T[];
  activeTabId: string | null;
  activeLoading: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  renderLabel: (tab: T) => string;
  newTabButton?: NewTabButtonProps | null;
  trailingActions?: ReactNode;
  tabCountLabel?: (count: number) => string;
  tablistAriaLabel?: string;
  tabStatus?: (tab: T, active: boolean) => ChartTabStatus;
  onTogglePin?: (id: string) => void;
};
```

Render a small pin button when `onTogglePin` exists. Use an inline SVG pin if no icon library is present in this file. Stop propagation on click and set labels to `${displayLabel} 고정` and `${displayLabel} 고정 해제`.

In close and middle-click handlers, return early when `tab.pinned` is true.

Pass `onTogglePin` through `LiveTabBar` and `StudyTabBar`.

In `LiveTabOverflowMenu`, show a small pin indicator and suppress close for pinned tabs.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npx vitest run src/live/LiveTabBar.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/tabs/ChartTabBar.tsx frontend/src/live/LiveTabBar.tsx frontend/src/studyViews/StudyTabBar.tsx frontend/src/live/LiveTabOverflowMenu.tsx frontend/src/live/LiveTabBar.test.tsx
git commit -m "feat: add chart tab pin controls"
```

---

### Task 4: Wire Pages And Verify

**Files:**
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Test: existing affected route tests.

**Interfaces:**
- Consumes: `toggleTabPinned` from both stores.

- [ ] **Step 1: Find wrapper call sites**

Run: `rg -n "LiveTabBar|StudyTabBar" frontend/src`

Expected: `frontend/src/live/LivePage.tsx:343` and `frontend/src/studyViews/StudyPage.tsx:464` are the page call sites that need `onTogglePin`.

- [ ] **Step 2: Pass store actions from pages**

In `frontend/src/live/LivePage.tsx`, select the action from the store:

```tsx
const toggleLiveTabPinned = useLiveTabsStore((s) => s.toggleTabPinned);
```

Then pass it to `LiveTabBar`:

```tsx
<LiveTabBar
  tabs={tabs}
  activeTabId={activeTabId}
  activeLoading={isPastCandlesLoading}
  onFocus={focusLiveTab}
  onClose={closeLiveTab}
  onReorder={reorderTabs}
  onTogglePin={toggleLiveTabPinned}
  onNewTab={() => { addLiveBlankTab(); focusLiveSearch(); }}
/>
```

In `frontend/src/studyViews/StudyPage.tsx`, select the action from the store:

```tsx
const toggleStudyTabPinned = useStudyTabsStore((s) => s.toggleTabPinned);
```

Then pass it to `StudyTabBar`:

```tsx
<StudyTabBar
  tabs={tabs}
  activeTabId={activeTabId}
  activeLoading={isStudyPageLoading}
  tabStatuses={warmTabStatuses}
  onFocus={handleFocusTab}
  onClose={handleCloseTab}
  onReorder={reorderTabs}
  onTogglePin={toggleStudyTabPinned}
  onNewTab={() => {}}
/>
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
cd frontend
npx vitest run src/state/liveTabs.test.ts src/state/studyTabs.test.ts src/live/LiveTabBar.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run broader build check**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: wire pinned chart tabs"
```
