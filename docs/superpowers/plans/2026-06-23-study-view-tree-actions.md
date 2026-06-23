# Study View Tree Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the saved study views drawer so option A-style tree rows are compact and row actions move to double-click rename plus right-click delete.

**Architecture:** Keep the existing `StudyViewsDrawer` ownership model. Reuse existing rename/delete mutation state, add one local context-menu state, and adjust row markup/styles without changing API or tree ordering state.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, dnd-kit, Tailwind utility classes.

## Global Constraints

- No backend API changes.
- No changes to saved-view grouping, sorting, collapse state, or drag persistence.
- Rename starts by double-clicking the saved-view name and selects the existing name.
- Delete starts from a saved-view row context menu and still requires the existing confirmation dialog.

---

### Task 1: Drawer Interaction Tests

**Files:**
- Modify: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`

**Interfaces:**
- Consumes: Existing `StudyViewsDrawer` rendered with mocked study-view API data.
- Produces: Failing tests that require removal of inline buttons, double-click rename, and right-click delete menu.

- [ ] **Step 1: Write failing tests**

Add or update tests in `frontend/src/studyViews/StudyViewsDrawer.test.tsx` to assert:

```tsx
expect(screen.queryByRole('button', { name: /이름 수정/ })).not.toBeInTheDocument();
expect(screen.queryByRole('button', { name: /삭제$/ })).not.toBeInTheDocument();

fireEvent.doubleClick(screen.getByText('장초반 매수벽'));
const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
expect(input.value).toBe('장초반 매수벽');

fireEvent.contextMenu(screen.getByRole('button', { name: '장초반 매수벽 저장뷰 열기' }));
fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
expect(screen.getByRole('dialog', { name: '저장뷰 삭제' })).toBeInTheDocument();
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd frontend && npm test -- StudyViewsDrawer.test.tsx --run`

Expected: FAIL because inline buttons still exist, double-click is not wired, and the row context menu does not exist.

- [ ] **Step 3: Commit is deferred**

Do not commit yet; Task 2 will make the tests pass.

### Task 2: Drawer Implementation

**Files:**
- Modify: `frontend/src/studyViews/StudyViewsDrawer.tsx`
- Test: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`

**Interfaces:**
- Consumes: Existing `renameState`, `commitRename(row)`, `deleteTarget`, and `setDeleteTarget(row)`.
- Produces: Row double-click rename, selected rename input, row context menu delete, and compact option A visual hierarchy.

- [ ] **Step 1: Add row context menu state**

Add local state:

```tsx
const [rowMenu, setRowMenu] = useState<{ row: ParquetStudyView; left: number; top: number } | null>(null);
```

- [ ] **Step 2: Select rename input text**

Add a ref and effect:

```tsx
const renameInputRef = useRef<HTMLInputElement>(null);

useEffect(() => {
  if (!renameState) return;
  renameInputRef.current?.focus();
  renameInputRef.current?.select();
}, [renameState?.id]);
```

- [ ] **Step 3: Replace inline buttons**

In `renderStudyViewRow`, remove the visible `수정` and `삭제` buttons. Add `onDoubleClick` to the saved-view name element to call `startRename(row)`, and add `onContextMenu` to the row root to open `rowMenu` with `clientX/clientY`.

- [ ] **Step 4: Render delete context menu**

Render a fixed-position menu when `rowMenu` is set:

```tsx
<div role="menu" aria-label={`${rowMenu.row.name} 저장뷰 메뉴`} style={{ left: rowMenu.left, top: rowMenu.top }}>
  <button type="button" role="menuitem" onClick={() => { setDeleteTarget(rowMenu.row); setRowMenu(null); }}>
    삭제
  </button>
</div>
```

Add outside-click and Escape dismissal.

- [ ] **Step 5: Run tests**

Run: `cd frontend && npm test -- StudyViewsDrawer.test.tsx --run`

Expected: PASS.

- [ ] **Step 6: Run focused type/lint check if available**

Run whichever existing frontend validation is available in `frontend/package.json`, preferring typecheck or test scripts.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/studyViews/StudyViewsDrawer.tsx frontend/src/studyViews/StudyViewsDrawer.test.tsx
git commit -m "feat: streamline study view tree actions"
```

## Self-Review

- Spec coverage: tree visual direction, removal of inline actions, double-click rename, selected rename input, right-click delete, and confirmation dialog are covered by Task 1 and Task 2.
- Placeholder scan: no TBD/TODO/fill-later language remains.
- Type consistency: all state and handlers use existing `ParquetStudyView` and drawer-local state.
