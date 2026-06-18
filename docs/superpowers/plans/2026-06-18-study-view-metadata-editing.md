# Study View Metadata Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add metadata-only saved study view rename and memo editing, with a resizable memo panel that does not block chart interaction.

**Architecture:** Add a backend metadata PATCH path that updates only `study_views/saves.json`, never snapshot JSON. Mirror that in the frontend API/hooks, then build two UI surfaces: inline rename in `StudyViewsDrawer` and a non-modal, vertically resizable memo panel in `StudyPage`'s right column.

**Tech Stack:** FastAPI, Pydantic, pytest, React, TypeScript, TanStack Query, Vitest, Testing Library, Tailwind utility classes.

## Global Constraints

- Metadata edits must not regenerate or rewrite saved chart snapshot JSON.
- The metadata update path is `PATCH /api/study-views/saves/{id}/metadata`.
- `name`, when provided, is trimmed and must not be blank.
- `memo`, when provided, is trimmed consistently with existing save-dialog behavior.
- `updated_at_ms` is refreshed and the saved-view list remains sorted by newest update first.
- `StudyPage` reads selected metadata from `useStudyViews()` by matching the `view` query param; snapshot queries remain chart-content only.
- Rename commits on Enter or blur, cancels on Escape, and skips empty or unchanged values.
- The memo panel is docked in the right column above `StudyDetailPanel`, not over the chart.
- The memo panel has a visible bottom resize handle, clamps height, and persists the last height in browser local storage.
- Users can keep panning, zooming, and clicking the chart while the memo panel is open.
- Frontend UI must follow `DESIGN.md`: dark-mode tokens only, restrained trading-lab density, no decorative gradients, no chart pane resize animation, and existing border/background/text tokens for the memo panel.

---

## File Structure

- `hoga/api/models.py`: add `StudyViewMetadataUpdateRequest`.
- `hoga/api/study_views.py`: add metadata-only update helpers under the existing study-view lock.
- `hoga/api/study_view_routes.py`: expose the PATCH endpoint.
- `tests/api/test_study_views.py`: add backend contract tests for metadata-only updates.
- `frontend/src/api/studyViews.ts`: add TS metadata body type and API function.
- `frontend/src/studyViews/useStudyViews.ts`: add metadata mutation and query invalidation.
- `frontend/src/studyViews/StudyViewsDrawer.tsx`: add inline rename editing.
- `frontend/src/studyViews/StudyViewsDrawer.test.tsx`: add rename behavior tests.
- `frontend/src/studyViews/StudyMemoPanel.tsx`: create focused memo panel component, including resize/persist.
- `frontend/src/studyViews/StudyMemoPanel.test.tsx`: test memo commit, cancel, error display, and resize persistence.
- `frontend/src/studyViews/StudyPage.tsx`: mount memo panel in the right column and pass selected metadata row.
- `frontend/src/studyViews/StudyPage.test.tsx`: add memo open/edit/resize behavior tests.

---

### Task 1: Backend Metadata Patch Contract

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/api/study_views.py`
- Modify: `hoga/api/study_view_routes.py`
- Test: `tests/api/test_study_views.py`

**Interfaces:**
- Produces: `StudyViewMetadataUpdateRequest(name: str | None = None, memo: str | None = None)`
- Produces: `update_save_metadata_sync(data_dir: Path, *, id: str, req: StudyViewMetadataUpdateRequest, now_ms: int) -> ParquetStudyView`
- Produces: `update_save_metadata(data_dir: Path, *, id: str, req: StudyViewMetadataUpdateRequest, now_ms: int) -> ParquetStudyView`
- Produces: `PATCH /api/study-views/saves/{save_id}/metadata`

- [ ] **Step 1: Write failing backend tests**

Append these tests to `tests/api/test_study_views.py`:

```python
def test_metadata_patch_renames_without_touching_snapshot(study_client, tmp_path, monkeypatch):
    create = study_client.post("/api/study-views/saves", json=_req(name="원래 이름", memo="old"))
    assert create.status_code == 201
    save_id = create.json()["id"]
    snapshot_path = tmp_path / "study_views" / "snapshots" / f"{save_id}.json"
    before_snapshot = snapshot_path.read_text(encoding="utf-8")
    before_mtime = snapshot_path.stat().st_mtime_ns

    monkeypatch.setattr("hoga.api.study_view_routes.time.time", lambda: 10.0)
    patch = study_client.patch(
        f"/api/study-views/saves/{save_id}/metadata",
        json={"name": "  새 이름  "},
    )

    assert patch.status_code == 200
    body = patch.json()
    assert body["name"] == "새 이름"
    assert body["memo"] == "old"
    assert body["updated_at_ms"] == 10_000
    assert snapshot_path.read_text(encoding="utf-8") == before_snapshot
    assert snapshot_path.stat().st_mtime_ns == before_mtime


def test_metadata_patch_updates_memo_without_touching_snapshot(study_client, tmp_path):
    create = study_client.post("/api/study-views/saves", json=_req(name="원래 이름", memo="old"))
    assert create.status_code == 201
    save_id = create.json()["id"]
    snapshot_path = tmp_path / "study_views" / "snapshots" / f"{save_id}.json"
    before_snapshot = snapshot_path.read_text(encoding="utf-8")

    patch = study_client.patch(
        f"/api/study-views/saves/{save_id}/metadata",
        json={"memo": "  새 메모  "},
    )

    assert patch.status_code == 200
    body = patch.json()
    assert body["name"] == "원래 이름"
    assert body["memo"] == "새 메모"
    assert snapshot_path.read_text(encoding="utf-8") == before_snapshot


def test_metadata_patch_rejects_blank_name(study_client):
    create = study_client.post("/api/study-views/saves", json=_req())
    assert create.status_code == 201
    save_id = create.json()["id"]

    patch = study_client.patch(
        f"/api/study-views/saves/{save_id}/metadata",
        json={"name": "   "},
    )

    assert patch.status_code == 422


def test_metadata_patch_missing_id_returns_404(study_client):
    patch = study_client.patch(
        "/api/study-views/saves/missing/metadata",
        json={"memo": "x"},
    )

    assert patch.status_code == 404
    assert patch.json()["detail"]["code"] == "study_view_not_found"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest tests/api/test_study_views.py::test_metadata_patch_renames_without_touching_snapshot tests/api/test_study_views.py::test_metadata_patch_updates_memo_without_touching_snapshot tests/api/test_study_views.py::test_metadata_patch_rejects_blank_name tests/api/test_study_views.py::test_metadata_patch_missing_id_returns_404 -q
```

Expected: FAIL with 404 or route-not-found for the new PATCH path.

- [ ] **Step 3: Add the request model**

In `hoga/api/models.py`, after `ParquetStudyViewWriteRequest`, add:

```python
class StudyViewMetadataUpdateRequest(BaseModel):
    name: str | None = None
    memo: str | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _strip_nonblank_name(v)

    @field_validator("memo")
    @classmethod
    def _strip_memo(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip()

    @model_validator(mode="after")
    def _has_update(self):
        if self.name is None and self.memo is None:
            raise ValueError("at least one metadata field is required")
        return self
```

- [ ] **Step 4: Add metadata-only update helpers**

In `hoga/api/study_views.py`, import `StudyViewMetadataUpdateRequest` and add below `update_save_sync`:

```python
def update_save_metadata_sync(
    data_dir: Path, *, id: str, req: StudyViewMetadataUpdateRequest, now_ms: int
) -> ParquetStudyView:
    file = load_saves(data_dir)
    for idx, old in enumerate(file.saves):
        if old.id == id:
            updates: dict[str, object] = {"updated_at_ms": now_ms}
            if req.name is not None:
                updates["name"] = req.name
            if req.memo is not None:
                updates["memo"] = req.memo
            new = old.model_copy(update=updates)
            file.saves[idx] = new
            file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
            save_saves(data_dir, file)
            return new
    raise StudyViewNotFoundError(id)
```

Add the async wrapper below `update_save`:

```python
async def update_save_metadata(
    data_dir: Path, *, id: str, req: StudyViewMetadataUpdateRequest, now_ms: int
) -> ParquetStudyView:
    async with _lock:
        return update_save_metadata_sync(data_dir, id=id, req=req, now_ms=now_ms)
```

- [ ] **Step 5: Add PATCH route**

In `hoga/api/study_view_routes.py`, import `StudyViewMetadataUpdateRequest` and add this route before the `PUT /saves/{save_id}` route:

```python
    @router.patch("/saves/{save_id}/metadata", response_model=ParquetStudyView)
    async def update_save_metadata(
        save_id: str, req: StudyViewMetadataUpdateRequest
    ) -> ParquetStudyView:
        try:
            return await study_views.update_save_metadata(
                data_dir,
                id=save_id,
                req=req,
                now_ms=int(time.time() * 1000),
            )
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e
```

- [ ] **Step 6: Run backend tests**

Run:

```bash
pytest tests/api/test_study_views.py::test_metadata_patch_renames_without_touching_snapshot tests/api/test_study_views.py::test_metadata_patch_updates_memo_without_touching_snapshot tests/api/test_study_views.py::test_metadata_patch_rejects_blank_name tests/api/test_study_views.py::test_metadata_patch_missing_id_returns_404 -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/models.py hoga/api/study_views.py hoga/api/study_view_routes.py tests/api/test_study_views.py
git commit -m "feat(api): update study view metadata"
```

---

### Task 2: Frontend Metadata API and Mutation

**Files:**
- Modify: `frontend/src/api/studyViews.ts`
- Modify: `frontend/src/studyViews/useStudyViews.ts`
- Test: `frontend/src/studyViews/useStudyViews.test.tsx`

**Interfaces:**
- Consumes: `PATCH /api/study-views/saves/{save_id}/metadata`
- Produces: `StudyViewMetadataUpdateRequest = { name?: string; memo?: string }`
- Produces: `updateStudyViewMetadata(id: string, body: StudyViewMetadataUpdateRequest): Promise<ParquetStudyView>`
- Produces: `useStudyViewMutations().updateMetadata`

- [ ] **Step 1: Write failing hook test**

Add this test to `frontend/src/studyViews/useStudyViews.test.tsx`:

```tsx
it('updates metadata and invalidates only the saves list', async () => {
  const qc = new QueryClient();
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
  const mutateAsync = vi.fn();
  vi.mocked(updateStudyViewMetadata).mockImplementation(mutateAsync);

  const { result } = renderHook(() => useStudyViewMutations(), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });

  await act(async () => {
    await result.current.updateMetadata.mutateAsync({ id: 'a', body: { name: '새 이름' } });
  });

  expect(mutateAsync).toHaveBeenCalledWith('a', { name: '새 이름' });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: STUDY_VIEW_SAVES_QUERY });
  expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: studyViewSnapshotQuery('a') });
});
```

Update the imports at the top of `frontend/src/studyViews/useStudyViews.test.tsx` to include `act` from Testing Library and `updateStudyViewMetadata` from `../api/studyViews`. Add `updateStudyViewMetadata: vi.fn(),` to the existing `vi.mock('../api/studyViews', ...)` object.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd frontend && npx vitest run src/studyViews/useStudyViews.test.tsx
```

Expected: FAIL because `updateMetadata` and `updateStudyViewMetadata` do not exist.

- [ ] **Step 3: Add API function**

In `frontend/src/api/studyViews.ts`, add:

```ts
export type StudyViewMetadataUpdateRequest = {
  name?: string;
  memo?: string;
};
```

Then add:

```ts
export const updateStudyViewMetadata = (id: string, body: StudyViewMetadataUpdateRequest) =>
  apiCall<ParquetStudyView>(`/api/study-views/saves/${id}/metadata`, { method: 'PATCH', ...json(body) });
```

- [ ] **Step 4: Add mutation**

In `frontend/src/studyViews/useStudyViews.ts`, import `updateStudyViewMetadata` and `StudyViewMetadataUpdateRequest`. Add to the returned object:

```ts
    updateMetadata: useMutation({
      mutationFn: ({ id, body }: { id: string; body: StudyViewMetadataUpdateRequest }) =>
        updateStudyViewMetadata(id, body),
      onSuccess: invalidate,
    }),
```

- [ ] **Step 5: Run frontend hook test**

Run:

```bash
cd frontend && npx vitest run src/studyViews/useStudyViews.test.tsx
```

Expected: PASS for `useStudyViews.test.tsx`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/studyViews.ts frontend/src/studyViews/useStudyViews.ts frontend/src/studyViews/useStudyViews.test.tsx
git commit -m "feat(frontend): add study view metadata mutation"
```

---

### Task 3: Saved View List Inline Rename

**Files:**
- Modify: `frontend/src/studyViews/StudyViewsDrawer.tsx`
- Modify: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`

**Interfaces:**
- Consumes: `useStudyViewMutations().updateMetadata.mutate({ id, body: { name } }, opts?)`
- Produces: inline rename behavior in saved view rows.

- [ ] **Step 1: Update test mock**

In `frontend/src/studyViews/StudyViewsDrawer.test.tsx`, add:

```ts
const updateMetadataMutate = vi.fn();
```

Reset it in `beforeEach()`:

```ts
updateMetadataMutate.mockReset();
```

Return it from the existing `useStudyViewMutations` mock:

```ts
updateMetadata: { mutate: updateMetadataMutate, isPending: false, error: null },
```

- [ ] **Step 2: Write failing rename tests**

Append:

```tsx
it('renames a saved view on double-click and Enter', async () => {
  renderDrawer('/study?view=a');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.type(input, '새 이름{Enter}');

  expect(updateMetadataMutate).toHaveBeenCalledWith(
    { id: 'a', body: { name: '새 이름' } },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});


it('commits saved view rename on blur', async () => {
  renderDrawer('/study?view=a');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.type(input, '블러 저장');
  input.blur();

  await waitFor(() => expect(updateMetadataMutate).toHaveBeenCalledWith(
    { id: 'a', body: { name: '블러 저장' } },
    expect.any(Object),
  ));
});


it('cancels saved view rename on Escape', async () => {
  renderDrawer('/study?view=a');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.type(input, '취소할 이름');
  await userEvent.keyboard('{Escape}');

  expect(updateMetadataMutate).not.toHaveBeenCalled();
  expect(screen.getByText('급등 이후')).toBeTruthy();
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyViewsDrawer.test.tsx
```

Expected: FAIL because inline rename UI does not exist.

- [ ] **Step 4: Implement rename state and commit helper**

In `StudyViewsDrawer.tsx`, add state near `deleteTarget`:

```tsx
  const [renameState, setRenameState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const renameCommittingRef = useRef(false);
```

Add helpers before `confirmDelete`:

```tsx
  const startRename = (row: ParquetStudyView) => {
    setRenameState({ id: row.id, value: row.name, error: null });
  };

  const cancelRename = () => {
    renameCommittingRef.current = false;
    setRenameState(null);
  };

  const commitRename = (row: ParquetStudyView) => {
    if (!renameState || renameState.id !== row.id || renameCommittingRef.current) return;
    const name = renameState.value.trim();
    if (!name || name === row.name) {
      cancelRename();
      return;
    }
    renameCommittingRef.current = true;
    mutations.updateMetadata.mutate(
      { id: row.id, body: { name } },
      {
        onSuccess: () => cancelRename(),
        onError: (error) => {
          renameCommittingRef.current = false;
          setRenameState((current) => current?.id === row.id
            ? { ...current, error: error instanceof Error ? error.message : '이름 변경에 실패했습니다.' }
            : current);
        },
      },
    );
  };
```

- [ ] **Step 5: Replace row name rendering**

Inside `rows.map`, replace the name `<div className="text-sm font-medium truncate">{row.name}</div>` with:

```tsx
                {renameState?.id === row.id ? (
                  <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      aria-label="저장뷰 이름 수정"
                      autoFocus
                      value={renameState.value}
                      onChange={(e) => setRenameState({ ...renameState, value: e.target.value, error: null })}
                      onBlur={() => commitRename(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename(row);
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      className="w-full rounded border bg-bg-input px-1 py-0.5 text-sm font-medium"
                    />
                    {renameState.error && <div className="text-xs text-red-500">{renameState.error}</div>}
                  </div>
                ) : (
                  <div
                    className="truncate text-sm font-medium"
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      startRename(row);
                    }}
                  >
                    {row.name}
                  </div>
                )}
```

- [ ] **Step 6: Run drawer tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyViewsDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/studyViews/StudyViewsDrawer.tsx frontend/src/studyViews/StudyViewsDrawer.test.tsx
git commit -m "feat(frontend): rename study views inline"
```

---

### Task 4: Resizable Memo Panel Component

**Files:**
- Create: `frontend/src/studyViews/StudyMemoPanel.tsx`
- Create: `frontend/src/studyViews/StudyMemoPanel.test.tsx`

**Interfaces:**
- Consumes: `memo: string`
- Consumes: `onCommit(memo: string) => void`
- Produces: `StudyMemoPanel` React component.
- Produces: local storage key `study.memoPanel.height.v1`.

- [ ] **Step 1: Write failing memo panel unit tests**

Create `frontend/src/studyViews/StudyMemoPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { StudyMemoPanel } from './StudyMemoPanel';

beforeEach(() => {
  localStorage.clear();
});

it('commits trimmed memo edits with the save button', async () => {
  const onCommit = vi.fn();
  render(<StudyMemoPanel memo="old" isSaving={false} errorMessage={null} onClose={vi.fn()} onCommit={onCommit} />);
  const memo = screen.getByLabelText('저장뷰 메모') as HTMLTextAreaElement;
  await userEvent.clear(memo);
  await userEvent.type(memo, ' 새 메모 ');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  expect(onCommit).toHaveBeenCalledWith('새 메모');
});


it('cancels the draft and closes on Escape', async () => {
  const onClose = vi.fn();
  const onCommit = vi.fn();
  render(<StudyMemoPanel memo="old" isSaving={false} errorMessage={null} onClose={onClose} onCommit={onCommit} />);
  const memo = screen.getByLabelText('저장뷰 메모') as HTMLTextAreaElement;
  await userEvent.clear(memo);
  await userEvent.type(memo, 'draft');
  await userEvent.keyboard('{Escape}');

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onCommit).not.toHaveBeenCalled();
});


it('renders save errors inline', () => {
  render(<StudyMemoPanel memo="" isSaving={false} errorMessage="메모 저장 실패" onClose={vi.fn()} onCommit={vi.fn()} />);

  expect(screen.getByText('메모 저장 실패')).toBeTruthy();
});


it('persists resized memo panel height', () => {
  render(<StudyMemoPanel memo="" isSaving={false} errorMessage={null} onClose={vi.fn()} onCommit={vi.fn()} />);

  const panel = screen.getByTestId('study-memo-panel');
  const handle = screen.getByRole('separator', { name: '메모 크기 조절' });

  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 200 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 280 });
  fireEvent.pointerUp(handle, { pointerId: 1 });

  expect(Number(localStorage.getItem('study.memoPanel.height.v1'))).toBeGreaterThan(280);
  expect(panel).toHaveStyle({ height: `${localStorage.getItem('study.memoPanel.height.v1')}px` });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyMemoPanel.test.tsx
```

Expected: FAIL because `StudyMemoPanel` does not exist.

- [ ] **Step 3: Create `StudyMemoPanel.tsx`**

Create:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

const HEIGHT_STORAGE_KEY = 'study.memoPanel.height.v1';
const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 520;

function clampHeight(value: number) {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function readStoredHeight() {
  const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
  const value = raw ? Number(raw) : DEFAULT_HEIGHT;
  return Number.isFinite(value) ? clampHeight(value) : DEFAULT_HEIGHT;
}

export type StudyMemoPanelProps = {
  memo: string;
  isSaving: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onCommit: (memo: string) => void;
};

export function StudyMemoPanel({ memo, isSaving, errorMessage, onClose, onCommit }: StudyMemoPanelProps) {
  const [draft, setDraft] = useState(memo);
  const [height, setHeight] = useState(readStoredHeight);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    setDraft(memo);
  }, [memo]);

  const commit = () => {
    const next = draft.trim();
    if (next !== memo) onCommit(next);
  };

  const beginResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startHeight: height };
  };

  const moveResize = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const next = clampHeight(dragRef.current.startHeight + (e.clientY - dragRef.current.startY));
    setHeight(next);
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(next));
  };

  const endResize = () => {
    dragRef.current = null;
  };

  return (
    <section
      data-testid="study-memo-panel"
      className="flex shrink-0 flex-col border-b border-[var(--border)] bg-[var(--bg)]"
      style={{ height }}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">메모</h2>
        <button type="button" onClick={onClose} className="rounded border px-2 py-1 text-xs">닫기</button>
      </div>
      <textarea
        aria-label="저장뷰 메모"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(memo);
            onClose();
          }
        }}
        placeholder="메모 없음"
        className="mx-3 min-h-0 flex-1 resize-none rounded border bg-bg-input p-2 text-sm"
      />
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-fg-dim">
        <span>{errorMessage ?? (isSaving ? '저장 중...' : '저장됨')}</span>
        <button type="button" disabled={isSaving} onClick={commit} className="rounded border px-2 py-1 disabled:opacity-50">저장</button>
      </div>
      <div
        role="separator"
        aria-label="메모 크기 조절"
        aria-orientation="horizontal"
        tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        className="h-2 cursor-row-resize border-t border-[var(--border)] bg-bg-input-hover"
      />
    </section>
  );
}
```

- [ ] **Step 4: Run memo panel tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyMemoPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit component only**

```bash
git add frontend/src/studyViews/StudyMemoPanel.tsx frontend/src/studyViews/StudyMemoPanel.test.tsx
git commit -m "feat(frontend): add resizable study memo panel"
```

---

### Task 5: Mount Memo Panel on Study Page

**Files:**
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: `StudyMemoPanel`
- Consumes: `useStudyViews().data.saves`
- Consumes: `useStudyViewMutations().updateMetadata`
- Produces: docked memo panel in right study column.

- [ ] **Step 1: Add selected metadata and mutation in `StudyPage`**

First update `frontend/src/studyViews/StudyPage.test.tsx` mocks:

```tsx
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
```

Extend the hoisted mocks:

```tsx
const { useStudyViewSnapshotMock, useStudyViewsMock, useStudyViewMutationsMock, liveChartRootMock, useLiveBundleMock, useRangeMock } = vi.hoisted(() => ({
  useStudyViewSnapshotMock: vi.fn(),
  useStudyViewsMock: vi.fn(),
  useStudyViewMutationsMock: vi.fn(),
  liveChartRootMock: vi.fn(),
  useLiveBundleMock: vi.fn(),
  useRangeMock: vi.fn(),
}));
```

Update the `./useStudyViews` mock:

```tsx
vi.mock('./useStudyViews', () => ({
  useStudyViewSnapshot: useStudyViewSnapshotMock,
  useStudyViews: useStudyViewsMock,
  useStudyViewMutations: useStudyViewMutationsMock,
}));
```

In `beforeEach`, add:

```tsx
useStudyViewsMock.mockReturnValue({ data: { schema_version: 1, saves: [{ id: 'view1', memo: 'old memo' }] } });
useStudyViewMutationsMock.mockReturnValue({
  updateMetadata: { mutate: vi.fn(), isPending: false, error: null },
});
```

Then add failing integration tests:

```tsx
it('opens a docked memo panel and commits memo edits', async () => {
  const updateMetadataMutate = vi.fn((_vars, opts) => opts.onSuccess?.());
  useStudyViewMutationsMock.mockReturnValue({
    updateMetadata: { mutate: updateMetadataMutate, isPending: false, error: null },
  });
  useStudyViewSnapshotMock.mockReturnValue({ data: snapshot, isLoading: false, isError: false });
  renderAt('/study?view=view1');

  await userEvent.click(screen.getByRole('button', { name: '메모' }));
  const panel = screen.getByTestId('study-memo-panel');
  const memo = screen.getByLabelText('저장뷰 메모') as HTMLTextAreaElement;
  await userEvent.clear(memo);
  await userEvent.type(memo, '새 메모');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  expect(panel.closest('aside')).toBeTruthy();
  expect(screen.getByTestId('live-chart-root-stub')).toBeTruthy();
  expect(updateMetadataMutate).toHaveBeenCalledWith(
    { id: 'view1', body: { memo: '새 메모' } },
    expect.objectContaining({ onError: expect.any(Function) }),
  );
});


it('keeps the memo panel open when memo blur commits after chart click', async () => {
  const updateMetadataMutate = vi.fn();
  useStudyViewMutationsMock.mockReturnValue({
    updateMetadata: { mutate: updateMetadataMutate, isPending: false, error: null },
  });
  useStudyViewSnapshotMock.mockReturnValue({ data: snapshot, isLoading: false, isError: false });
  renderAt('/study?view=view1');

  await userEvent.click(screen.getByRole('button', { name: '메모' }));
  const memo = screen.getByLabelText('저장뷰 메모') as HTMLTextAreaElement;
  await userEvent.clear(memo);
  await userEvent.type(memo, '차트 보면서 메모');
  fireEvent.blur(memo);
  fireEvent.click(screen.getByTestId('live-chart-root-stub'));

  expect(updateMetadataMutate).toHaveBeenCalledWith(
    { id: 'view1', body: { memo: '차트 보면서 메모' } },
    expect.any(Object),
  );
  expect(screen.getByTestId('study-memo-panel')).toBeTruthy();
});
```

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx
```

Expected: FAIL because `StudyPage` does not use `useStudyViews`, `useStudyViewMutations`, or `StudyMemoPanel` yet.

Modify imports:

```tsx
import { StudyMemoPanel } from './StudyMemoPanel';
import { useStudyViewMutations, useStudyViews, useStudyViewSnapshot } from './useStudyViews';
```

Add inside `StudyPage`:

```tsx
  const savesQuery = useStudyViews();
  const mutations = useStudyViewMutations();
  const [isMemoOpen, setIsMemoOpen] = useState(false);
  const [memoError, setMemoError] = useState<string | null>(null);
  const selectedSave = useMemo(
    () => savesQuery.data?.saves.find((row) => row.id === viewId) ?? null,
    [savesQuery.data?.saves, viewId],
  );
```

Add:

```tsx
  const commitMemo = useCallback((memo: string) => {
    if (!viewId || memo === (selectedSave?.memo ?? '')) return;
    setMemoError(null);
    mutations.updateMetadata.mutate(
      { id: viewId, body: { memo } },
      {
        onError: (error) => setMemoError(error instanceof Error ? error.message : '메모 저장에 실패했습니다.'),
      },
    );
  }, [mutations.updateMetadata, selectedSave?.memo, viewId]);
```

- [ ] **Step 2: Add header button**

Change the header to `justify-between` and add:

```tsx
        <button
          type="button"
          onClick={() => setIsMemoOpen((value) => !value)}
          className="shrink-0 rounded border px-2 py-1 text-xs"
        >
          메모
        </button>
```

- [ ] **Step 3: Mount panel above detail panel**

Change the right column from direct `StudyDetailPanel` rendering to:

```tsx
        <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l border-[var(--border)]">
          {isMemoOpen && selectedSave && (
            <StudyMemoPanel
              memo={selectedSave.memo}
              isSaving={mutations.updateMetadata.isPending}
              errorMessage={memoError}
              onClose={() => setIsMemoOpen(false)}
              onCommit={commitMemo}
            />
          )}
          {details && chartInput && (
            <StudyDetailPanel
              details={details}
              candles={chartInput.bundle.candles}
              segments={chartInput.bundle.segments}
              bucketMs={bucketMs}
              cursorMs={isCursorActive ? cursorMs : null}
            />
          )}
        </aside>
```

Ensure the outer grid remains `grid-cols-[minmax(0,1fr)_280px]` and `LiveChartRoot` remains the first grid child, so the memo panel never overlays the chart.

- [ ] **Step 4: Run StudyPage tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run focused frontend suite**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyViewsDrawer.test.tsx src/studyViews/StudyPage.test.tsx src/studyViews/useStudyViews.test.tsx src/studyViews/StudyMemoPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat(frontend): edit study view memo"
```

---

### Task 6: Final Verification

**Files:**
- Modify only if tests reveal a defect in prior task files.

**Interfaces:**
- Consumes all prior task outputs.
- Produces verified metadata editing feature.

- [ ] **Step 1: Run backend focused tests**

```bash
pytest tests/api/test_study_views.py -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend focused tests**

```bash
cd frontend && npx vitest run src/studyViews/StudyViewsDrawer.test.tsx src/studyViews/StudyPage.test.tsx src/studyViews/useStudyViews.test.tsx src/studyViews/StudyMemoPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run frontend build for typecheck**

`frontend/package.json` has no `test` or `typecheck` script. The existing build script runs `tsc -b && vite build`, so run:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual browser QA**

Start the backend from the repo root:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

Start the frontend in a second terminal:

```bash
cd frontend && npm run dev
```

Open `http://localhost:5173/study?view=<existing-save-id>` and verify:

```text
1. Open /study?view=<existing-save-id>.
2. Click 메모.
3. Pan and zoom the chart while the memo panel remains open.
4. Type memo text, click the chart, confirm blur saves and the panel stays open.
5. Drag the memo panel bottom handle taller and shorter.
6. Reload /study?view=<same-id>, confirm the last memo panel height is restored.
7. Open the saved views drawer, double-click a saved view name, rename with Enter.
8. Rename another saved view by double-clicking, editing, and clicking elsewhere.
9. Confirm Escape cancels a rename.
```

Expected: all behavior matches the spec.

- [ ] **Step 5: Commit any verification fixes**

If changes were required, stage the exact files changed by the fixes:

```bash
git add hoga/api/models.py hoga/api/study_views.py hoga/api/study_view_routes.py tests/api/test_study_views.py frontend/src/api/studyViews.ts frontend/src/studyViews/useStudyViews.ts frontend/src/studyViews/StudyViewsDrawer.tsx frontend/src/studyViews/StudyViewsDrawer.test.tsx frontend/src/studyViews/StudyMemoPanel.tsx frontend/src/studyViews/StudyMemoPanel.test.tsx frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "fix: polish study view metadata editing"
```

If no changes were required, do not create an empty commit.
