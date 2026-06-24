# Study Tabs From Saved Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/study` work like `/live` tabs: saved-view stock groups can open in the current tab by drag/drop, open in a new tab with Ctrl/Meta-click, and switch tabs with number shortcuts 1-4.

**Architecture:** Add a `/study`-specific tabs store that tracks saved study-view ids, not live codes. Keep the existing saved snapshot contract: `/study` renders only persisted snapshots and does not call live/range hooks. Reuse the existing Live tab visual pattern through a small generic tab bar component, and extend the saved-view drawer drag seam so the study page can register its own drop target.

**Tech Stack:** React 18, React Router 7, Zustand, TanStack Query, dnd-kit, Vitest, Testing Library, Vite.

## Global Constraints

- Follow `DESIGN.md`: full-bleed chart workspace, dark token colors, 32px-style tab height, teal active top accent, restrained trading-lab UI.
- Do not change backend saved-view APIs unless frontend cannot resolve the requested behavior from `listStudyViews`.
- `/study` must continue rendering saved snapshots only; no `useLiveBundle`, `useRange`, or live SSE hooks.
- If one Code has multiple saved views, the stock-name/group action opens the most recently updated save for that Code by `updated_at_ms`, then `created_at_ms` fallback.
- Ctrl/Meta-click should open a new study tab; normal saved-view row click should replace/focus the current study tab.
- Numeric shortcuts on `/study` select only tabs 1-4.
- Existing `/live` tab behavior must not regress.

---

## File Structure

- Modify: `frontend/src/state/entryDrag.ts`
  - Generalize the current live-only chart hit-test seam into route-aware drop targets while preserving `isPointOnChart()` for `/live`.
- Create: `frontend/src/state/studyTabs.ts`
  - Owns persisted `/study` tabs: `{ id, viewId, code, label, name, timeframe }`, `activeTabId`, actions for replace, new tab, focus, close, reorder, query seeding.
- Create: `frontend/src/studyViews/studyViewSelection.ts`
  - Pure helpers for choosing a representative save for a Code and formatting tab labels.
- Create: `frontend/src/tabs/ChartTabBar.tsx`
  - Generic tab UI extracted from `LiveTabBar`; accepts label/code/loading callbacks and keeps the same visual design.
- Modify: `frontend/src/live/LiveTabBar.tsx`
  - Wrap `ChartTabBar` so existing live API and tests remain stable.
- Create: `frontend/src/studyViews/StudyTabBar.tsx`
  - Thin adapter from `StudyTab[]` to `ChartTabBar`.
- Create: `frontend/src/studyViews/useStudyKeyboard.ts`
  - `/study` keyboard hook: 1-4 select tabs, reuse live shortcut ignore rules.
- Modify: `frontend/src/studyViews/StudyPage.tsx`
  - Seed/focus study tabs from `?view=`, render tab bar, register study drop target, resolve active tab to snapshot query, preserve existing chart/detail behavior.
- Modify: `frontend/src/studyViews/StudyViewsDrawer.tsx`
  - Ctrl/Meta-click stock group opens newest Code save in a new study tab; drag/drop stock group over `/study` opens newest Code save in current tab; row Ctrl/Meta-click opens that exact save in a new tab.
- Modify: `frontend/src/main.tsx`
  - Initialize study tab persistence with `initStudyTabsSync()`.
- Test: `frontend/src/state/studyTabs.test.ts`
- Test: `frontend/src/studyViews/studyViewSelection.test.ts`
- Test: `frontend/src/studyViews/StudyPage.test.tsx`
- Test: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`
- Optional Test: `frontend/src/live/LiveTabBar.test.tsx` only if extraction changes markup assertions.

## Task 1: Pure Study Tab Model

**Files:**
- Create: `frontend/src/studyViews/studyViewSelection.ts`
- Test: `frontend/src/studyViews/studyViewSelection.test.ts`

**Interfaces:**
- Produces: `latestStudyViewForCode(saves: ParquetStudyView[], code: string): ParquetStudyView | null`
- Produces: `formatStudyTabLabel(save: Pick<ParquetStudyView, 'label' | 'name' | 'timeframe'>): string`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import type { ParquetStudyView } from '../api/studyViews';
import { formatStudyTabLabel, latestStudyViewForCode } from './studyViewSelection';

const base = {
  id: 'a',
  name: '장초반',
  code: '005930',
  label: '삼성전자',
  timeframe: '1m',
  snapshot_from_ms: 1,
  snapshot_to_ms: 2,
  viewport: { right_edge_ms: 2, bar_span: 120, at_live_edge: false },
  indicator_state: {
    volume_enabled: true,
    quote_totals_enabled: true,
    ratio_enabled: true,
    fill_strength_enabled: true,
    aggregation_basis: 'close',
    auction_window_mask: true,
    ratio_outlier_filter_enabled: false,
    ratio_outlier_threshold: 50,
  },
  memo: '',
  tags: [],
  provenance: { saved_from_route: '/live', data_provenance: 'live_mixed' },
  snapshot_schema_version: 1,
  snapshot_path: '',
  snapshot_size_bytes: 1,
  created_at_ms: 100,
  updated_at_ms: 100,
} satisfies ParquetStudyView;

describe('studyViewSelection', () => {
  it('selects the newest save for a code by updated_at_ms', () => {
    const older = { ...base, id: 'old', updated_at_ms: 200 };
    const newer = { ...base, id: 'new', name: '마감', updated_at_ms: 300 };
    expect(latestStudyViewForCode([older, newer], '005930')?.id).toBe('new');
  });

  it('falls back to created_at_ms when updated_at_ms ties', () => {
    const first = { ...base, id: 'first', updated_at_ms: 300, created_at_ms: 100 };
    const second = { ...base, id: 'second', updated_at_ms: 300, created_at_ms: 200 };
    expect(latestStudyViewForCode([first, second], '005930')?.id).toBe('second');
  });

  it('returns null when the code has no saved study view', () => {
    expect(latestStudyViewForCode([base], '000660')).toBeNull();
  });

  it('formats study tab labels with stock and timeframe context', () => {
    expect(formatStudyTabLabel(base)).toBe('삼성전자 · 장초반 · 1m');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd frontend && npx vitest run src/studyViews/studyViewSelection.test.ts`

Expected: FAIL because `studyViewSelection.ts` does not exist.

- [ ] **Step 3: Implement helper**

```ts
import type { ParquetStudyView } from '../api/studyViews';

export function latestStudyViewForCode(
  saves: readonly ParquetStudyView[],
  code: string,
): ParquetStudyView | null {
  const matches = saves.filter((save) => save.code === code);
  if (matches.length === 0) return null;
  return matches.slice().sort((a, b) => {
    const updated = b.updated_at_ms - a.updated_at_ms;
    if (updated !== 0) return updated;
    return b.created_at_ms - a.created_at_ms;
  })[0] ?? null;
}

export function formatStudyTabLabel(
  save: Pick<ParquetStudyView, 'label' | 'name' | 'timeframe'>,
): string {
  return `${save.label} · ${save.name} · ${save.timeframe}`;
}
```

- [ ] **Step 4: Verify**

Run: `cd frontend && npx vitest run src/studyViews/studyViewSelection.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/studyViews/studyViewSelection.ts frontend/src/studyViews/studyViewSelection.test.ts
git commit -m "feat: add study view selection helpers"
```

## Task 2: Study Tabs Store

**Files:**
- Create: `frontend/src/state/studyTabs.ts`
- Test: `frontend/src/state/studyTabs.test.ts`
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- Consumes: `ParquetStudyView`, `formatStudyTabLabel`
- Produces: `useStudyTabsStore`, `initStudyTabsSync`, `studyTabFromSave(save)`, `toStudyTabsSnapshot(state)`

- [ ] **Step 1: Write failing store tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { ParquetStudyView } from '../api/studyViews';
import { studyTabFromSave, toStudyTabsSnapshot, useStudyTabsStore } from './studyTabs';

const save = {
  id: 'view1',
  name: '장초반',
  code: '005930',
  label: '삼성전자',
  timeframe: '1m',
  snapshot_from_ms: 1,
  snapshot_to_ms: 2,
  viewport: { right_edge_ms: 2, bar_span: 120, at_live_edge: false },
  indicator_state: {
    volume_enabled: true,
    quote_totals_enabled: true,
    ratio_enabled: true,
    fill_strength_enabled: true,
    aggregation_basis: 'close',
    auction_window_mask: true,
    ratio_outlier_filter_enabled: false,
    ratio_outlier_threshold: 50,
  },
  memo: '',
  tags: [],
  provenance: { saved_from_route: '/live', data_provenance: 'live_mixed' },
  snapshot_schema_version: 1,
  snapshot_path: '',
  snapshot_size_bytes: 1,
  created_at_ms: 100,
  updated_at_ms: 200,
} satisfies ParquetStudyView;

describe('studyTabs store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useStudyTabsStore.setState({ tabs: [], activeTabId: null });
  });

  it('creates a tab from a saved study view', () => {
    const tab = studyTabFromSave(save);
    expect(tab).toMatchObject({
      viewId: 'view1',
      code: '005930',
      label: '삼성전자 · 장초반 · 1m',
      timeframe: '1m',
    });
  });

  it('replaces the active tab for normal navigation', () => {
    useStudyTabsStore.getState().openSaveInActiveTab(save);
    const first = useStudyTabsStore.getState().activeTabId;
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, id: 'view2', name: '마감' });
    const state = useStudyTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(first);
    expect(state.tabs[0]).toMatchObject({ viewId: 'view2', name: '마감' });
  });

  it('opens Ctrl-click saves in a new tab', () => {
    useStudyTabsStore.getState().openSaveInActiveTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const state = useStudyTabsStore.getState();
    expect(state.tabs.map((tab) => tab.viewId)).toEqual(['view1', 'view2']);
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.viewId).toBe('view2');
  });

  it('serializes without ephemeral generated ids', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).toEqual({
      viewId: 'view1',
      code: '005930',
      label: '삼성전자 · 장초반 · 1m',
      name: '장초반',
      timeframe: '1m',
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd frontend && npx vitest run src/state/studyTabs.test.ts`

Expected: FAIL because `studyTabs.ts` does not exist.

- [ ] **Step 3: Implement store**

Implementation requirements:
- Use `nanoid(8)` like `liveTabs.ts`.
- Persist to `localStorage['study.tabs.v1']` via `attachPersistence`.
- `openSaveInActiveTab(save)` replaces active tab, or creates the first tab if none exists.
- `openSaveInNewTab(save)` always appends and focuses a new tab; duplicates are allowed.
- `focusTab(id)`, `closeTab(id)`, `reorderTabs(from, to)` mirror `liveTabs.ts`.
- `ensureQuerySeed(save)` should create/focus a tab for `?view=` on first mount without duplicating an already-open `viewId`.

- [ ] **Step 4: Initialize persistence**

Modify `frontend/src/main.tsx`:

```ts
import { initStudyTabsSync } from './state/studyTabs';

const _disposeLiveTabsSync = initLiveTabsSync();
const _disposeStudyTabsSync = initStudyTabsSync();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _disposeLiveTabsSync();
    _disposeStudyTabsSync();
  });
}
```

- [ ] **Step 5: Verify**

Run: `cd frontend && npx vitest run src/state/studyTabs.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/studyTabs.ts frontend/src/state/studyTabs.test.ts frontend/src/main.tsx
git commit -m "feat: add study tabs store"
```

## Task 3: Shared Tab Bar Component

**Files:**
- Create: `frontend/src/tabs/ChartTabBar.tsx`
- Modify: `frontend/src/live/LiveTabBar.tsx`
- Create: `frontend/src/studyViews/StudyTabBar.tsx`
- Test: existing `frontend/src/live/LiveTabBar.test.tsx`

**Interfaces:**
- Produces: `ChartTabBar<T extends { id: string; code: string; label: string }>`
- Consumes: live/study adapters.

- [ ] **Step 1: Extract generic UI without behavior changes**

Move the rendering logic from `LiveTabBar` into `ChartTabBar`. Keep:
- `MAX_RENDERED_TABS = 24`
- active `--accent` 2px top line
- active loading dot behavior
- close button behavior
- drag reorder behavior
- overflow menu only for live if `LiveTabOverflowMenu` remains live-specific

- [ ] **Step 2: Keep `LiveTabBar` as compatibility wrapper**

`LiveTabBar` should still accept the current props and format labels through `formatLiveViewLabel(t.label, t.timeframe)`.

- [ ] **Step 3: Add study adapter**

`StudyTabBar` props:

```ts
type Props = {
  tabs: StudyTab[];
  activeTabId: string | null;
  activeLoading: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onNewTab: () => void;
};
```

For `onNewTab`, use a disabled or no-op plus button only if there is no obvious save picker. Preferred v1: hide `+` on StudyTabBar because new tabs come from Ctrl/Meta-click or drop. If hiding requires too much extraction, keep the button disabled with `aria-label="저장뷰에서 새 탭 열기"` and no visible explanatory text.

- [ ] **Step 4: Verify live tests**

Run: `cd frontend && npx vitest run src/live/LiveTabBar.test.tsx src/live/LivePage.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/tabs/ChartTabBar.tsx frontend/src/live/LiveTabBar.tsx frontend/src/studyViews/StudyTabBar.tsx
git commit -m "refactor: share chart tab bar"
```

## Task 4: Study Page Tabs And Shortcuts

**Files:**
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Create: `frontend/src/studyViews/useStudyKeyboard.ts`
- Test: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: `useStudyTabsStore`, `StudyTabBar`, `useStudyViewSnapshot(activeViewId)`
- Produces: `/study` active view resolved from active study tab.

- [ ] **Step 1: Add tests for query seeding and tab switching**

Extend `StudyPage.test.tsx`:
- Rendering `/study?view=view1` seeds a study tab and renders `StudyTabBar`.
- Pressing `2` focuses the second tab when two study tabs exist.
- Pressing `5` does nothing.
- Input-focused keydown is ignored.

- [ ] **Step 2: Implement keyboard hook**

`useStudyKeyboard({ onSelectTabIndex })`:
- Import `shouldIgnoreEvent` from `../live/useLiveKeyboard`.
- Ignore Ctrl/Meta/Alt/Shift.
- Accept only `/^[1-4]$/`.
- Call `onSelectTabIndex(Number(e.key) - 1)` and `preventDefault()`.

- [ ] **Step 3: Refactor `StudyPage` to active tab id**

Implementation rules:
- Keep `const [params] = useSearchParams(); const queryViewId = params.get('view');`.
- Use `useStudyViews()` to find the `ParquetStudyView` for `queryViewId`.
- On first mount, if `queryViewId` resolves, call `ensureQuerySeed(save)`.
- If no query and tabs exist, use active tab.
- If active tab changes, navigate with `replace: true` to `/study?view=${active.viewId}` so URL stays shareable without polluting history on shortcut changes.
- Pass `activeViewId` to `useStudyViewSnapshot(activeViewId)`.
- Preserve all existing snapshot/chart/detail code by replacing `viewId` references with `activeViewId`.
- Set `viewIdentity={activeTabId ? `${activeTabId}:${activeViewId}` : activeViewId}` so same saved view opened in duplicate tabs can keep independent chart instances later if needed.

- [ ] **Step 4: Verify study page tests**

Run: `cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx`

Expected: PASS and existing "without live or range hooks" assertions still pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/useStudyKeyboard.ts frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat: add study page tabs and shortcuts"
```

## Task 5: Study Drop Target Seam

**Files:**
- Modify: `frontend/src/state/entryDrag.ts`
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Test: `frontend/src/state/entryDrag.test.ts` or existing nearest drag test file.

**Interfaces:**
- Produces: `registerStudyTarget`, `isPointOnStudy`, while `registerChartTarget` and `isPointOnChart` continue to work.

- [ ] **Step 1: Write seam tests**

Test:
- A registered live target makes `isPointOnChart(point)` true.
- A registered study target makes `isPointOnStudy(point)` true.
- Clearing one target does not clear the other.

- [ ] **Step 2: Implement route-aware targets**

Keep the current public functions and add study equivalents:

```ts
type DropTargetKind = 'liveChart' | 'studyPage';
type DropTargetMap = Partial<Record<DropTargetKind, ChartHitTest>>;
```

Store shape:
- `targets: DropTargetMap`
- Existing `hitTestChart` may remain as a derived compatibility field, or be replaced internally while preserving `registerChartTarget`, `clearChartTarget`, and `isPointOnChart`.
- Add `registerStudyTarget(hitTest)`, `clearStudyTarget(hitTest)`, `isPointOnStudy(point)`.

- [ ] **Step 3: Register StudyPage target**

In `StudyPage`, wrap the chart/detail grid in a `ref`, register a hit test while mounted:
- hit if point is inside the page/chart workarea rect.
- expose an overlay when `useEntryDragStore((s) => s.overStudy)` is true, or reuse `overChart` only if the naming is generalized to `overDropTarget`.

Design:
- Use same restrained overlay as live drop target.
- Copy should be short: `여기에 놓아 학습뷰 열기`.
- No large card, no gradient, no decorative effects.

- [ ] **Step 4: Verify seam tests**

Run: `cd frontend && npx vitest run src/state/entryDrag.test.ts src/studyViews/StudyPage.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/entryDrag.ts frontend/src/state/entryDrag.test.ts frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat: add study page drop target"
```

## Task 6: Saved Views Drawer Ctrl-Click And Drag

**Files:**
- Modify: `frontend/src/studyViews/StudyViewsDrawer.tsx`
- Test: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`

**Interfaces:**
- Consumes: `latestStudyViewForCode`, `useStudyTabsStore`, `isPointOnStudy`, `dropPoint`
- Produces: stock group Ctrl/Meta-click new-tab behavior and drag-to-study behavior.

- [ ] **Step 1: Add failing drawer tests**

Cases:
- Ctrl-click group header for 삼성전자 calls `openSaveInNewTab(newestSamsungSave)` and navigates `/study?view=<id>`.
- Normal group header click still toggles collapse.
- Ctrl-click row opens exact row in a new tab.
- Dragging group header over study target opens newest Code save in active study tab and does not reorder groups.
- Dragging group header outside study target still reorders groups.

- [ ] **Step 2: Implement Ctrl/Meta-click**

In group header `onClick`:
- If `event.ctrlKey || event.metaKey`, prevent collapse.
- Resolve `latestStudyViewForCode(data.saves, group.code)`.
- Call `useStudyTabsStore.getState().openSaveInNewTab(save)`.
- `navigate(`/study?view=${save.id}`)`.
- If no save is found, no-op because the group itself exists only from saves.

In row click:
- If Ctrl/Meta, cancel pending delayed navigation.
- Open that exact row in new tab and navigate to it.
- Otherwise preserve delayed single-click behavior for rename double-click.

- [ ] **Step 3: Implement drag-to-study for stock group**

Current group drag is used for group reordering. Extend `handleDragEnd`:
- If active type is `group` and `isPointOnStudy(dropPoint(event))`, resolve the newest save for that group key/code.
- Call `openSaveInActiveTab(save)` and `navigate(`/study?view=${save.id}`)`.
- Return before `reorderGroup`.
- Outside the study target, keep existing `reorderGroup`.

- [ ] **Step 4: Maintain current saved-view tree behavior**

Make sure:
- Row drag/reorder still works.
- Group collapse still works.
- Rename double-click still cancels pending navigation.
- Delete-current-view still navigates `/study` and closes/adjusts the active tab if the deleted save is open. If closing all open matching tabs is too much for v1, remove only the active deleted tab and leave stale inactive tabs to be pruned by the next tab focus.

- [ ] **Step 5: Verify drawer tests**

Run: `cd frontend && npx vitest run src/studyViews/StudyViewsDrawer.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/studyViews/StudyViewsDrawer.tsx frontend/src/studyViews/StudyViewsDrawer.test.tsx
git commit -m "feat: open study tabs from saved views"
```

## Task 7: Integration Verification

**Files:**
- Modify only if tests expose regressions.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
cd frontend && npx vitest run \
  src/state/studyTabs.test.ts \
  src/studyViews/studyViewSelection.test.ts \
  src/studyViews/StudyPage.test.tsx \
  src/studyViews/StudyViewsDrawer.test.tsx \
  src/live/LiveTabBar.test.tsx \
  src/live/useLiveKeyboard.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run: `cd frontend && npm run build`

Expected: TypeScript and Vite build pass.

- [ ] **Step 3: Browser QA with repo browse tool**

Start dev servers if not already running:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
cd frontend && npm run dev
```

Manual checks:
- Open `http://localhost:5173/study`.
- Open Right Rail 저장뷰.
- Ctrl-click a stock-name group: a new study tab appears and becomes active.
- Press `1`, `2`, `3`, `4`: only existing first four tabs activate.
- Drag a stock-name group over the `/study` chart area: current tab changes to that Code's newest saved view.
- Drag a stock-name group inside the drawer, outside the study page: group reorder still works.
- Existing saved-view row click opens the exact row.
- `/live` tabs still switch and reorder.

- [ ] **Step 4: Check console**

Run:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B console --errors
```

Expected: no new frontend errors.

- [ ] **Step 5: Commit final fixes**

```bash
git status --short
git add frontend/src docs/superpowers/plans/2026-06-24-study-tabs-from-saved-views.md
git commit -m "test: verify study tabs workflow"
```

## Self-Review

- Spec coverage:
  - Study page like live page tabs: Tasks 2-4.
  - Drag stock name from saved views to study page: Tasks 5-6.
  - Show that stock's study view: Tasks 1 and 6 choose newest saved view for Code.
  - Shortcuts 1,2,3,4: Task 4.
  - Ctrl + stock-name click opens new tab: Task 6.
- Placeholder scan: no TBD/TODO steps; every behavior has a target file and verification path.
- Type consistency:
  - `ParquetStudyView.id` becomes `StudyTab.viewId`.
  - `openSaveInActiveTab` replaces current tab; `openSaveInNewTab` appends.
  - `latestStudyViewForCode` is the only representative-save policy.

