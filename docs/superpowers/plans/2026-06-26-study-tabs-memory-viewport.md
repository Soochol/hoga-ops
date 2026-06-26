# Study Tabs Memory Viewport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each `/study` tab's last chart viewport while the app is running, and reset that viewport on browser refresh.

**Architecture:** Add an optional in-memory `viewport` field to `StudyTab` and store it only in the Zustand store, not in the persisted localStorage snapshot. `StudyPage` captures the active chart viewport before focus/close/navigation replaces the active tab, and passes the tab viewport ahead of the saved view's original viewport when restoring.

**Tech Stack:** React, Zustand, Vitest, Testing Library, TypeScript.

## Global Constraints

- Do not persist the last-manipulated chart viewport to localStorage.
- Preserve current persisted study tab behavior for tab list, active tab, and saved view identity.
- Use the existing `TabViewport` type and `LiveChartRoot` capture/restore hooks.

---

### Task 1: Study Tab In-Memory Viewport

**Files:**
- Modify: `frontend/src/state/studyTabs.ts`
- Test: `frontend/src/state/studyTabs.test.ts`
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Test: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: `TabViewport` from `frontend/src/live/viewportAnchor.ts`
- Produces: `StudyTab.viewport?: TabViewport | null` and `StudyTabsStore.updateTabViewport(id, viewport)`

- [ ] **Step 1: Write failing store tests**

```ts
it('keeps tab viewport in memory but excludes it from the persisted snapshot', () => {
  useStudyTabsStore.getState().openSaveInNewTab(save);
  const tabId = useStudyTabsStore.getState().activeTabId!;
  useStudyTabsStore.getState().updateTabViewport(tabId, { rightEdgeMs: 9_000, barSpan: 42, atLiveEdge: false });

  expect(useStudyTabsStore.getState().tabs[0].viewport).toEqual({ rightEdgeMs: 9_000, barSpan: 42, atLiveEdge: false });
  expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).not.toHaveProperty('viewport');
});
```

- [ ] **Step 2: Run store test to verify it fails**

Run: `cd frontend && npx vitest run src/state/studyTabs.test.ts`
Expected: FAIL because `updateTabViewport` does not exist.

- [ ] **Step 3: Write failing StudyPage test**

```ts
it('captures the active study tab viewport before switching tabs and restores it on return', () => {
  // Render two study tabs, publish a captured viewport from the chart stub, click away, then click back.
  // Expect the returned tab to pass the captured viewport to LiveChartRoot.restoreViewport.
});
```

- [ ] **Step 4: Run StudyPage test to verify it fails**

Run: `cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx`
Expected: FAIL because tab focus does not save a captured viewport.

- [ ] **Step 5: Implement minimal store support**

Add `viewport?: TabViewport | null` to `StudyTab`, add `updateTabViewport`, and keep `toStudyTabsSnapshot` omitting it.

- [ ] **Step 6: Implement minimal StudyPage capture/restore wiring**

Wrap `focusTab`, `closeTab`, `openSaveInActiveTab`, and route query replacement so they call `captureViewportRef.current()` and store the result on the current active tab before switching. Pass `activeTab.viewport ?? save.viewport` to `LiveChartRoot.restoreViewport`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
cd frontend && npx vitest run src/state/studyTabs.test.ts src/studyViews/StudyPage.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Run type/build verification**

Run: `cd frontend && npm run build`
Expected: PASS.
