# Screener Saved-List UX (inline edit + confirm modals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the screener saved-list native `window.prompt`/`window.confirm` with inline name editing (create/rename) + a shared center confirm modal (overwrite/delete), fix the 조건 추가 dropdown to close on outside-click, start the builder empty, and drop the condition-row collapse toggle.

**Architecture:** All changes are in `frontend/src/screener/` + `frontend/src/pages/Screener.tsx`. A new presentational `ConfirmModal` (center modal, copies the existing `LiveSettingsModal` pattern) handles overwrite/delete; a small `suggestSaveName` pure helper supplies `새조건N` names; `SavedScreenerList` gains inline-edit state and renders the modal; `ConditionBuilder` adopts the existing `useDismissablePopover` hook + `position: fixed` anchoring. The parent `Screener` still owns the save anchor/dirty state — its callbacks (`onBeginSave`/`onAnchorChange`) are wired exactly as before so all save-anchor safety semantics are preserved.

**Tech Stack:** React 18 + TypeScript, Tailwind (token classes), `@tanstack/react-query` (mutations via `useSaveMutations`), Vitest + `@testing-library/react` (jsdom, `tests/setup.ts` provides jest-dom matchers).

**Spec:** `docs/superpowers/specs/2026-06-01-screener-popover-redesign-design.md`

**Conventions for every task:**
- Run tests from the `frontend/` directory: `npx vitest run <path>`.
- Type-check the whole frontend with `npx tsc -b` (this is the typecheck half of the `build` script).
- Commit messages follow the repo convention and end with the `Co-Authored-By` trailer (the harness adds it). Stage only the files named in the task (`git add <paths>`), never `git add -A` — a concurrent agent may be active on this branch.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/pages/Screener.tsx` | Screener page shell + save anchor/dirty owner | Modify (empty initial builder, drop `makeLeaf` import) |
| `frontend/src/screener/ConditionRow.tsx` | One condition row (label + summary + ParamForm) | Modify (remove collapse toggle → always render ParamForm) |
| `frontend/src/screener/ConditionRow.test.tsx` | ConditionRow unit test | Create |
| `frontend/src/screener/suggestName.ts` | Pure `새조건N` name suggester | Create |
| `frontend/src/screener/suggestName.test.ts` | suggestName unit test | Create |
| `frontend/src/screener/ConfirmModal.tsx` | Presentational center confirm modal (shared by overwrite/delete) | Create |
| `frontend/src/screener/ConfirmModal.test.tsx` | ConfirmModal unit test | Create |
| `frontend/src/screener/SavedScreenerList.tsx` | Saved list: load/create/rename/overwrite/delete | Modify (inline edit + ConfirmModal; remove prompt/confirm) |
| `frontend/src/screener/SavedScreenerList.test.tsx` | Saved list tests | Modify (drive inline input + modal) |
| `frontend/src/pages/Screener.test.tsx` | Screener page tests | Modify (race test drives inline input) |
| `frontend/src/screener/ConditionBuilder.tsx` | Condition builder + 조건 추가 menu | Modify (dismissable + fixed positioning + canon style) |
| `frontend/src/screener/ConditionBuilder.test.tsx` | ConditionBuilder tests | Modify (add outside-click close test) |

---

## Task 1: Empty initial builder

**Files:**
- Modify: `frontend/src/pages/Screener.tsx` (line 14 import, line 21 initial state)
- Test: `frontend/src/pages/Screener.test.tsx` (add one test)

- [ ] **Step 1: Add a failing test** — append to `frontend/src/pages/Screener.test.tsx` (after the last `it(...)`, before the final `});` is not needed since tests are top-level `it`s; add at end of file):

```tsx
it('starts with an empty builder (no default 신고가 condition)', async () => {
  renderPage();
  // The seed condition used to render a 신고가 row with a 펼치기/접기 caret.
  // With an empty builder there is no condition row and no AND label.
  expect(screen.queryByText('신고가')).not.toBeInTheDocument();
  expect(screen.queryByText('모두 충족 · AND')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `npx vitest run src/pages/Screener.test.tsx -t "empty builder"`
Expected: FAIL — `신고가` is found (the seed renders one).

- [ ] **Step 3: Make the builder start empty** — in `frontend/src/pages/Screener.tsx`, change line 21 from:

```tsx
  const [conditions, setConditions] = useState<ConditionLeaf[]>(() => [makeLeaf('new_high')]);
```

to:

```tsx
  const [conditions, setConditions] = useState<ConditionLeaf[]>(() => []);
```

- [ ] **Step 4: Remove the now-unused `makeLeaf` import** — in `frontend/src/pages/Screener.tsx`, line 14 is:

```tsx
import { makeLeaf } from '../screener/catalog';
```

Delete that entire line (it is the only use of `makeLeaf` in this file).

- [ ] **Step 5: Run the new test + the whole Screener test file, verify PASS**

Run: `npx vitest run src/pages/Screener.test.tsx`
Expected: PASS (all tests, including the existing scan/load/anchor tests).

- [ ] **Step 6: Type-check**

Run: `npx tsc -b`
Expected: no errors (no unused-import error for `makeLeaf`).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Screener.tsx frontend/src/pages/Screener.test.tsx
git commit -m "feat(screener-fe): start builder empty (drop new_high seed)"
```

---

## Task 2: Remove the condition-row collapse toggle

**Files:**
- Modify: `frontend/src/screener/ConditionRow.tsx` (full rewrite — remove `open` state + caret)
- Test: `frontend/src/screener/ConditionRow.test.tsx` (Create)

- [ ] **Step 1: Write the failing test** — create `frontend/src/screener/ConditionRow.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConditionRow } from './ConditionRow';
import type { ConditionLeaf } from '../api/screener';

const leaf: ConditionLeaf = { id: 'x', type: 'new_high', params: { lookback: 200, period: 500 } };

describe('ConditionRow', () => {
  it('renders the ParamForm immediately with no collapse caret', () => {
    render(<ConditionRow leaf={leaf} onChange={vi.fn()} onRemove={vi.fn()} />);
    // ParamForm (BreakoutForm) inputs are visible without expanding.
    expect(screen.getByLabelText('lookback (N)')).toBeInTheDocument();
    expect(screen.getByLabelText('period (M)')).toBeInTheDocument();
    // The old toggle is gone.
    expect(screen.queryByRole('button', { name: '펼치기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '접기' })).not.toBeInTheDocument();
    // The remove button stays.
    expect(screen.getByRole('button', { name: '조건 제거' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `npx vitest run src/screener/ConditionRow.test.tsx`
Expected: FAIL — `lookback (N)` is not found (ParamForm is hidden behind the collapsed `open=false` state).

- [ ] **Step 3: Rewrite `ConditionRow.tsx`** — replace the entire contents of `frontend/src/screener/ConditionRow.tsx` with:

```tsx
import type { ConditionLeaf } from '../api/screener';
import { CONDITION_CATALOG } from './catalog';

export function ConditionRow({ leaf, onChange, onRemove }: {
  leaf: ConditionLeaf; onChange: (next: ConditionLeaf) => void; onRemove: () => void;
}) {
  const entry = CONDITION_CATALOG[leaf.type];
  const ParamForm = entry.ParamForm;
  return (
    <div className="border border-border bg-bg-subtle rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span className="text-sm font-medium">{entry.label}</span>
        <span className="font-mono text-xs text-fg-dim">{entry.summarize(leaf.params)}</span>
        <button type="button" aria-label="조건 제거" onClick={onRemove}
          className="ml-auto text-fg-dimmer hover:text-fg bg-transparent border-none cursor-pointer leading-none">×</button>
      </div>
      <div className="px-2.5 pb-2.5">
        <ParamForm params={leaf.params} onChange={(params: ConditionLeaf['params']) => onChange({ ...leaf, params } as ConditionLeaf)} />
      </div>
    </div>
  );
}
```

(Removed: the `useState` import, the `open` state, the ▾/▸ caret button, and the `{open && (...)}` conditional — the ParamForm now always renders.)

- [ ] **Step 4: Run the test, verify PASS**

Run: `npx vitest run src/screener/ConditionRow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run ConditionBuilder tests (consumer) to confirm no regression**

Run: `npx vitest run src/screener/ConditionBuilder.test.tsx`
Expected: PASS (existing tests only assert labels/menu, unaffected).

- [ ] **Step 6: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/screener/ConditionRow.tsx frontend/src/screener/ConditionRow.test.tsx
git commit -m "feat(screener-fe): always show condition detail (remove collapse toggle)"
```

---

## Task 3: `suggestSaveName` helper

**Files:**
- Create: `frontend/src/screener/suggestName.ts`
- Test: `frontend/src/screener/suggestName.test.ts`

- [ ] **Step 1: Write the failing test** — create `frontend/src/screener/suggestName.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { suggestSaveName } from './suggestName';

describe('suggestSaveName', () => {
  it('returns 새조건1 when there are no names', () => {
    expect(suggestSaveName([])).toBe('새조건1');
  });
  it('ignores unrelated names', () => {
    expect(suggestSaveName(['급등주', '눌림목'])).toBe('새조건1');
  });
  it('fills the smallest gap in 새조건N', () => {
    expect(suggestSaveName(['새조건1', '새조건3'])).toBe('새조건2');
  });
  it('continues past a contiguous run', () => {
    expect(suggestSaveName(['새조건1', '새조건2'])).toBe('새조건3');
  });
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `npx vitest run src/screener/suggestName.test.ts`
Expected: FAIL — cannot resolve `./suggestName` (module does not exist).

- [ ] **Step 3: Create `suggestName.ts`** — create `frontend/src/screener/suggestName.ts`:

```ts
// Suggests a default saved-screener name of the form 새조건N, where N is the
// smallest positive integer not already used by an existing 새조건N name. This
// keeps the suggestion deterministic even if the user manually names a save
// "새조건5".
export function suggestSaveName(existingNames: string[]): string {
  const used = new Set<number>();
  for (const name of existingNames) {
    const m = /^새조건(\d+)$/.exec(name);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `새조건${n}`;
}
```

- [ ] **Step 4: Run the test, verify PASS**

Run: `npx vitest run src/screener/suggestName.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screener/suggestName.ts frontend/src/screener/suggestName.test.ts
git commit -m "feat(screener-fe): add suggestSaveName (새조건N) helper"
```

---

## Task 4: `ConfirmModal` component

**Files:**
- Create: `frontend/src/screener/ConfirmModal.tsx`
- Test: `frontend/src/screener/ConfirmModal.test.tsx`

- [ ] **Step 1: Write the failing test** — create `frontend/src/screener/ConfirmModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmModal } from './ConfirmModal';

const mount = (over: Partial<React.ComponentProps<typeof ConfirmModal>> = {}) => {
  const props = {
    message: '"급등주" 삭제?',
    confirmLabel: '삭제',
    tone: 'destructive' as const,
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<ConfirmModal {...props} />);
  return props;
};

describe('ConfirmModal', () => {
  it('renders the message and confirm label', () => {
    mount();
    expect(screen.getByText('"급등주" 삭제?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '삭제' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '취소' })).toBeInTheDocument();
  });

  it('calls onConfirm (not onClose) when the confirm button is clicked', () => {
    const { onConfirm, onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when 취소 is clicked', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked', () => {
    const { onClose, onConfirm } = mount();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onClose on Escape', () => {
    const { onClose } = mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `npx vitest run src/screener/ConfirmModal.test.tsx`
Expected: FAIL — cannot resolve `./ConfirmModal`.

- [ ] **Step 3: Create `ConfirmModal.tsx`** — create `frontend/src/screener/ConfirmModal.tsx`:

```tsx
import { useEffect, type ReactNode } from 'react';

// Presentational center confirm modal. Mirrors the LiveSettingsModal /
// IndicatorPanel pattern (backdrop + Escape useEffect; no useDismissablePopover).
// Holds NO mutation/anchor logic — the parent's onConfirm does that.
export function ConfirmModal({ message, confirmLabel, tone, onConfirm, onClose }: {
  message: ReactNode;
  confirmLabel: string;
  tone: 'primary' | 'destructive';
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[360px] max-w-[90vw] flex flex-col">
        <div className="px-4 py-4 text-sm text-fg leading-relaxed">{message}</div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">취소</button>
          <button type="button" onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded font-semibold"
            style={tone === 'destructive'
              ? { background: 'var(--error)', color: '#fff' }
              : { background: 'var(--accent)', color: 'var(--accent-fg)' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify PASS**

Run: `npx vitest run src/screener/ConfirmModal.test.tsx`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screener/ConfirmModal.tsx frontend/src/screener/ConfirmModal.test.tsx
git commit -m "feat(screener-fe): add shared ConfirmModal (center confirm dialog)"
```

---

## Task 5: SavedScreenerList — inline edit (create/rename) + confirm modals (overwrite/delete)

This rewrites `SavedScreenerList.tsx` and its test, and updates the one Screener.test race test that drove create through `window.prompt`. All save-anchor safety semantics are preserved (synchronous `onBeginSave`; rename carries the save's own conditions; confirm messages name the target; delete clears the anchor only when the deleted row was the anchor).

**Files:**
- Modify: `frontend/src/screener/SavedScreenerList.tsx` (full rewrite)
- Modify: `frontend/src/screener/SavedScreenerList.test.tsx` (full rewrite)
- Modify: `frontend/src/pages/Screener.test.tsx` (race test, ~lines 85–105)

- [ ] **Step 1: Rewrite the test file** — replace the entire contents of `frontend/src/screener/SavedScreenerList.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SavedScreenerList } from './SavedScreenerList';

// Saved screener with its OWN conditions/universe, deliberately DISTINCT from
// the live-builder state the tests pass in — so a rename that wrongly forwarded
// the builder (the ✎ data-loss bug) is unambiguously visible.
const SAVED_CONDS = [{ id: 'orig', type: 'new_high', params: { lookback: 200, period: 500 } }];
const SAVED_UNIVERSE = { markets: ['KOSPI'] };
vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [
    { id: 's1', name: '급등주', conditions: SAVED_CONDS, universe: SAVED_UNIVERSE, created_at_ms: 1, updated_at_ms: 1 },
    { id: 's2', name: '눌림목', conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1 }] })),
  createSave: vi.fn(() => Promise.resolve({ id: 's-new', name: '새이름', conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2 })),
  updateSave: vi.fn(() => Promise.resolve({})),
  deleteSave: vi.fn(() => Promise.resolve()),
}));
import * as api from '../api/savedScreeners';
import type { ConditionLeaf } from '../api/screener';

const BUILDER = {
  conditions: [{ id: 'b', type: 'trade_value', params: { min_eok: 99 } }] as ConditionLeaf[],
  universe: { exclude_etf: true },
};
const FILL = 'bg-[rgba(20,184,166,0.14)]';            // teal fill = exact match
const BAR = 'shadow-[inset_2px_0_0_var(--accent)]';   // anchor bar

type Props = React.ComponentProps<typeof SavedScreenerList>;
const mount = (over: Partial<Props> = {}) => {
  const props: Props = {
    current: { conditions: [], universe: {} },
    anchorId: null, dirty: false, onLoad: vi.fn(), onBeginSave: vi.fn(), onAnchorChange: vi.fn(),
    ...over,
  };
  render(<QueryClientProvider client={new QueryClient()}><SavedScreenerList {...props} /></QueryClientProvider>);
  return props;
};
const rowOf = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe('SavedScreenerList', () => {
  it('renders saved names and loads (no scan) on click', async () => {
    const { onLoad } = mount();
    fireEvent.click(await screen.findByText('급등주'));
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('creates a new save via inline edit (＋ → type → blur)', async () => {
    mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '새이름' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.createSave).toHaveBeenCalledWith(expect.objectContaining({ name: '새이름' })));
  });

  it('re-anchors to the newly created save, signalling save-start first', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '새이름' } });
    fireEvent.blur(input);
    expect(onBeginSave).toHaveBeenCalled();
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith('s-new'));
  });

  it('create with an empty name does nothing', async () => {
    const { onBeginSave } = mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '   ' } });   // whitespace only
    fireEvent.blur(input);
    expect(api.createSave).not.toHaveBeenCalled();
    expect(onBeginSave).not.toHaveBeenCalled();
  });

  it('create cancels on Escape (no save)', async () => {
    mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(api.createSave).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('조건검색 이름')).not.toBeInTheDocument();
  });

  it('rename changes ONLY the name, keeps the save\'s own conditions/universe, and does NOT re-anchor', async () => {
    const { onAnchorChange } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '이름변경' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '새이름' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.updateSave).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updateSave).mock.calls[0];
    expect(id).toBe('s1');
    expect(body.name).toBe('새이름');
    expect(body.conditions).toEqual(SAVED_CONDS);        // save's own, NOT BUILDER.conditions
    expect(body.universe).toEqual(SAVED_UNIVERSE);
    expect(onAnchorChange).not.toHaveBeenCalled();
  });

  it('rename reverts on Escape (no update)', async () => {
    mount();
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '이름변경' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '바뀐이름' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(api.updateSave).not.toHaveBeenCalled();
    expect(screen.getByText('급등주')).toBeInTheDocument();
  });

  it('overwrite saves the live builder onto the save (keeps name, re-anchors) after a target-naming confirm', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '현재 조건으로 덮어쓰기' }));
    // Modal names the target, then we confirm.
    expect(screen.getByRole('dialog')).toHaveTextContent('급등주');
    fireEvent.click(screen.getByRole('button', { name: '덮어쓰기' }));
    expect(onBeginSave).toHaveBeenCalled();
    await waitFor(() => expect(api.updateSave).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updateSave).mock.calls[0];
    expect(id).toBe('s1');
    expect(body.name).toBe('급등주');                     // keeps the save's name
    expect(body.conditions).toEqual(BUILDER.conditions);  // intentional: live builder
    expect(body.universe).toEqual(BUILDER.universe);
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith('s1'));
  });

  it('overwrite does nothing when the modal is dismissed', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '현재 조건으로 덮어쓰기' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(api.updateSave).not.toHaveBeenCalled();
    expect(onBeginSave).not.toHaveBeenCalled();
    expect(onAnchorChange).not.toHaveBeenCalled();
  });

  it('anchored row is clean-highlighted (teal fill, no 수정됨) when not dirty', async () => {
    mount({ anchorId: 's1', dirty: false });
    await screen.findByText('급등주');
    expect(rowOf('급등주').className).toContain(FILL);
    expect(screen.queryByText('수정됨')).not.toBeInTheDocument();
  });

  it('anchored row shows 수정됨 and drops the fill (bar only) when dirty', async () => {
    mount({ anchorId: 's1', dirty: true });
    await screen.findByText('급등주');
    expect(screen.getByText('수정됨')).toBeInTheDocument();
    expect(rowOf('급등주').className).not.toContain(FILL);
    expect(rowOf('급등주').className).toContain(BAR);
  });

  it('delete clears the anchor when the deleted row was the anchor', async () => {
    const { onAnchorChange } = mount({ anchorId: 's1' });
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '삭제' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));   // modal confirm (scope to dialog: the row glyph is also named 삭제)
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith(null));
  });

  it('delete keeps the anchor when a different row is deleted', async () => {
    const { onAnchorChange } = mount({ anchorId: 's1' });
    await screen.findByText('눌림목');
    fireEvent.click(within(rowOf('눌림목')).getByRole('button', { name: '삭제' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));   // modal confirm (scope to dialog)
    await waitFor(() => expect(api.deleteSave).toHaveBeenCalledWith('s2'));
    expect(onAnchorChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `npx vitest run src/screener/SavedScreenerList.test.tsx`
Expected: FAIL — there is no `조건검색 이름` input / no `dialog` modal yet (current component uses `window.prompt`/`window.confirm`).

- [ ] **Step 3: Rewrite `SavedScreenerList.tsx`** — replace the entire contents of `frontend/src/screener/SavedScreenerList.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';
import { useSavedScreeners, useSaveMutations } from './useSavedScreeners';
import { ConfirmModal } from './ConfirmModal';
import { suggestSaveName } from './suggestName';

interface Current { conditions: ConditionLeaf[]; universe: ScreenerUniverse }

type Editing =
  | { mode: 'create'; initial: string }
  | { mode: 'rename'; id: string; initial: string }
  | null;
type Confirm =
  | { kind: 'overwrite'; save: SavedScreener }
  | { kind: 'delete'; save: SavedScreener }
  | null;

// Inline name editor. Owns its own draft text so per-keystroke typing does not
// re-render the whole list, and a single-fire guard prevents the Enter→blur
// double commit (Enter blurs the input, which would otherwise commit twice).
function NameRowInput({ initial, onCommit, onCancel }: {
  initial: string; onCommit: (name: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value); else onCancel();
  };
  return (
    <input ref={ref} autoFocus aria-label="조건검색 이름" value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); ref.current?.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); ref.current?.blur(); }
      }}
      className="flex-1 min-w-0 bg-bg-input border border-border rounded-lg text-fg px-2 py-1 text-sm" />
  );
}

export function SavedScreenerList({ current, anchorId, dirty, onLoad, onBeginSave, onAnchorChange }: {
  current: Current; anchorId: string | null; dirty: boolean;
  onLoad: (s: SavedScreener) => void; onBeginSave: () => void; onAnchorChange: (id: string | null) => void;
}) {
  const { data } = useSavedScreeners();
  const { create, update, remove } = useSaveMutations();
  const saves = data?.saves ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const bodyFromBuilder = (name: string) => ({ name, conditions: current.conditions, universe: current.universe });

  // create re-anchors to the new save; rename never re-anchors and must carry
  // the SAVE's own conditions/universe (forwarding the live builder is the ✎
  // data-loss bug). onBeginSave fires synchronously at dispatch so the parent
  // can snapshot its edit generation.
  const commitCreate = (raw: string) => {
    const name = raw.trim();
    if (name) { onBeginSave(); create.mutate(bodyFromBuilder(name), { onSuccess: (created) => onAnchorChange(created.id) }); }
    setEditing(null);
  };
  const commitRename = (s: SavedScreener, raw: string) => {
    const name = raw.trim();
    if (name && name !== s.name) update.mutate({ id: s.id, body: { name, conditions: s.conditions, universe: s.universe } });
    setEditing(null);
  };

  // Overwrite/delete go through the shared center ConfirmModal. The confirm
  // message NAMES the target so "load A → 덮어쓰기 on B" can't silently clobber
  // the wrong save. All mutation + anchor logic lives here, not in the modal.
  const runConfirm = () => {
    if (!confirm) return;
    const s = confirm.save;
    if (confirm.kind === 'overwrite') {
      onBeginSave();
      update.mutate({ id: s.id, body: bodyFromBuilder(s.name) }, { onSuccess: () => onAnchorChange(s.id) });
    } else {
      remove.mutate(s.id, { onSuccess: () => { if (s.id === anchorId) onAnchorChange(null); } });
    }
    setConfirm(null);
  };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">저장한 조건검색</span>
        <button type="button" aria-label="새로 저장"
          onClick={() => setEditing({ mode: 'create', initial: suggestSaveName(saves.map((s) => s.name)) })}
          className="ml-auto w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">＋</button>
      </div>
      <div className="flex flex-col gap-1">
        {editing?.mode === 'create' && (
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-bg-input">
            <NameRowInput initial={editing.initial} onCommit={commitCreate} onCancel={() => setEditing(null)} />
          </div>
        )}
        {saves.map((s) => {
          // anchor+clean → teal fill + bar; anchor+dirty → bar only + 수정됨.
          const isAnchor = s.id === anchorId;
          const clean = isAnchor && !dirty;
          const isRenaming = editing?.mode === 'rename' && editing.id === s.id;
          return (
            <div key={s.id} role="button" tabIndex={0}
              onClick={() => { if (!isRenaming) onLoad(s); }}
              onKeyDown={(e) => { if (!isRenaming && (e.key === 'Enter' || e.key === ' ')) onLoad(s); }}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-md text-sm cursor-pointer ${
                clean ? 'bg-[rgba(20,184,166,0.14)] text-fg shadow-[inset_2px_0_0_var(--accent)]'
                  : isAnchor ? 'bg-bg-input text-fg shadow-[inset_2px_0_0_var(--accent)]'
                    : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
              {isRenaming ? (
                <NameRowInput initial={editing.initial} onCommit={(name) => commitRename(s, name)} onCancel={() => setEditing(null)} />
              ) : (
                <span className="truncate flex-1">{s.name}</span>
              )}
              {isAnchor && dirty && !isRenaming && <span className="shrink-0 text-[10px] tracking-[0.04em] text-fg-dimmer">수정됨</span>}
              {!isRenaming && (<>
                <button type="button" aria-label="현재 조건으로 덮어쓰기" onClick={(e) => { e.stopPropagation(); setConfirm({ kind: 'overwrite', save: s }); }}
                  className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">⤓</button>
                <button type="button" aria-label="이름변경" onClick={(e) => { e.stopPropagation(); setEditing({ mode: 'rename', id: s.id, initial: s.name }); }}
                  className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">✎</button>
                <button type="button" aria-label="삭제" onClick={(e) => { e.stopPropagation(); setConfirm({ kind: 'delete', save: s }); }}
                  className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">🗑</button>
              </>)}
            </div>
          );
        })}
        {saves.length === 0 && editing?.mode !== 'create' && (
          <div className="text-fg-dimmer text-xs px-1 py-2">저장된 조건검색이 없습니다. ＋ 로 현재 조건을 저장하세요.</div>
        )}
      </div>

      {confirm && (
        <ConfirmModal
          message={confirm.kind === 'overwrite'
            ? `"${confirm.save.name}"을(를) 현재 빌더 조건으로 덮어쓸까요?`
            : `"${confirm.save.name}" 삭제?`}
          confirmLabel={confirm.kind === 'overwrite' ? '덮어쓰기' : '삭제'}
          tone={confirm.kind === 'overwrite' ? 'primary' : 'destructive'}
          onConfirm={runConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Update the Screener race test** — in `frontend/src/pages/Screener.test.tsx`, the test titled `does not lie "clean" when the builder is edited while a create is in flight (C4 race)` currently drives create through `window.prompt`. Replace its body. The test currently reads (lines ~85–105):

```tsx
it('does not lie "clean" when the builder is edited while a create is in flight (C4 race)', async () => {
  // The false-clean the adversarial pass found: on a slow save, an edit landing
  // mid-flight must keep the freshly-anchored row 수정됨, never reset it to clean.
  let resolveCreate!: (v: SavedScreener) => void;
  const created: SavedScreener = { id: 'new1', name: '레이스', conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2 };
  vi.mocked(createSave).mockImplementationOnce(() => new Promise<SavedScreener>((r) => { resolveCreate = r; }));
  vi.mocked(listSaves).mockResolvedValue({ schema_version: 1, saves: [created] });
  vi.spyOn(window, 'prompt').mockReturnValue('레이스');

  renderPage();
  await screen.findByLabelText('ETF 제외');
  fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));  // onBeginSave snapshots the edit gen
  fireEvent.click(screen.getByLabelText('ETF 제외'));                   // edit DURING the in-flight create (bumps gen)
  await waitFor(() => expect(createSave).toHaveBeenCalled());           // mutationFn runs on a microtask
  resolveCreate(created);                                               // create resolves now

  // The new row anchors but the mid-flight edit must win: 수정됨, not a clean fill.
  expect(await screen.findByText('수정됨')).toBeInTheDocument();
  expect(screen.getByText('레이스').closest('[role="button"]')!.className)
    .not.toContain('bg-[rgba(20,184,166,0.14)]');
});
```

Replace it with (drive the inline input instead of `window.prompt`):

```tsx
it('does not lie "clean" when the builder is edited while a create is in flight (C4 race)', async () => {
  // The false-clean the adversarial pass found: on a slow save, an edit landing
  // mid-flight must keep the freshly-anchored row 수정됨, never reset it to clean.
  let resolveCreate!: (v: SavedScreener) => void;
  const created: SavedScreener = { id: 'new1', name: '레이스', conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2 };
  vi.mocked(createSave).mockImplementationOnce(() => new Promise<SavedScreener>((r) => { resolveCreate = r; }));
  vi.mocked(listSaves).mockResolvedValue({ schema_version: 1, saves: [created] });

  renderPage();
  await screen.findByLabelText('ETF 제외');
  fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));  // open inline editor
  const input = screen.getByLabelText('조건검색 이름');
  fireEvent.change(input, { target: { value: '레이스' } });
  fireEvent.blur(input);                                               // commit → onBeginSave snapshots the edit gen + create.mutate
  fireEvent.click(screen.getByLabelText('ETF 제외'));                   // edit DURING the in-flight create (bumps gen)
  await waitFor(() => expect(createSave).toHaveBeenCalled());          // mutationFn runs on a microtask
  resolveCreate(created);                                              // create resolves now

  // The new row anchors but the mid-flight edit must win: 수정됨, not a clean fill.
  expect(await screen.findByText('수정됨')).toBeInTheDocument();
  expect(screen.getByText('레이스').closest('[role="button"]')!.className)
    .not.toContain('bg-[rgba(20,184,166,0.14)]');
});
```

(The only change is removing the `window.prompt` spy and driving the `조건검색 이름` input + blur.)

- [ ] **Step 5: Run the affected test files, verify PASS**

Run: `npx vitest run src/screener/SavedScreenerList.test.tsx src/pages/Screener.test.tsx`
Expected: PASS (all tests in both files).

- [ ] **Step 6: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/screener/SavedScreenerList.tsx frontend/src/screener/SavedScreenerList.test.tsx frontend/src/pages/Screener.test.tsx
git commit -m "feat(screener-fe): inline-edit create/rename + ConfirmModal overwrite/delete"
```

---

## Task 6: ConditionBuilder — dropdown closes on outside click + fixed positioning

**Files:**
- Modify: `frontend/src/screener/ConditionBuilder.tsx` (menu: dismissable + fixed + canon style)
- Modify: `frontend/src/screener/ConditionBuilder.test.tsx` (add outside-click close test)

- [ ] **Step 1: Add the failing test** — append this test inside the existing `describe('ConditionBuilder', () => { ... })` block in `frontend/src/screener/ConditionBuilder.test.tsx` (before the closing `});` of the describe):

```tsx
  it('closes the menu on outside mousedown', () => {
    render(<ConditionBuilder {...base} onConditionsChange={vi.fn()} onUniverseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    expect(screen.getByRole('menuitem', { name: /신고가$/ })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menuitem', { name: /신고가$/ })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `npx vitest run src/screener/ConditionBuilder.test.tsx -t "outside mousedown"`
Expected: FAIL — after the outside mousedown the menuitem is still present (current menu has no outside-click dismissal).

- [ ] **Step 3: Rewrite `ConditionBuilder.tsx`** — replace the entire contents of `frontend/src/screener/ConditionBuilder.tsx` with:

```tsx
import { useRef, useState } from 'react';
import type { ConditionLeaf, ConditionType, ScreenerUniverse } from '../api/screener';
import { CONDITION_CATALOG, CONDITION_ORDER, makeLeaf } from './catalog';
import { ConditionRow } from './ConditionRow';
import { SectionLabel } from './paramForms';
import { useDismissablePopover } from '../util/useDismissablePopover';

const MARKETS = ['KOSPI', 'KOSDAQ'] as const;

export function ConditionBuilder({ conditions, universe, onConditionsChange, onUniverseChange }: {
  conditions: ConditionLeaf[]; universe: ScreenerUniverse;
  onConditionsChange: (c: ConditionLeaf[]) => void; onUniverseChange: (u: ScreenerUniverse) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Outside-mousedown / Escape dismissal. The wrapper (button + fixed menu) is
  // the anchor, so a click on the trigger toggles without the global handler
  // immediately closing it.
  useDismissablePopover(menuOpen, wrapRef, () => setMenuOpen(false));

  // The menu is position:fixed (anchored via getBoundingClientRect) so the
  // card's overflow-auto does not clip it.
  const toggleMenu = () => {
    setMenuOpen((o) => {
      const next = !o;
      if (next && btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
      return next;
    });
  };
  const add = (t: ConditionType) => { onConditionsChange([...conditions, makeLeaf(t)]); setMenuOpen(false); };
  const replace = (id: string, next: ConditionLeaf) => onConditionsChange(conditions.map((c) => c.id === id ? next : c));
  const remove = (id: string) => onConditionsChange(conditions.filter((c) => c.id !== id));

  const markets = universe.markets ?? [];
  const toggleMarket = (m: (typeof MARKETS)[number]) => {
    const next = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    onUniverseChange({ ...universe, markets: next.length ? next : undefined });
  };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      <div ref={wrapRef} className="relative">
        <button ref={btnRef} type="button" aria-label="조건 추가" aria-expanded={menuOpen} onClick={toggleMenu}
          className="w-full border border-dashed border-border-strong rounded-md text-fg-dim text-sm py-2 hover:bg-bg-input-hover">
          ＋ 조건 추가 ▾
        </button>
        {menuOpen && anchorRect && (
          <ul role="menu"
            className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] overflow-hidden z-50"
            style={{ position: 'fixed', top: anchorRect.bottom + 4, left: anchorRect.left, width: anchorRect.width }}>
            {CONDITION_ORDER.map((t) => (
              <li key={t}><button type="button" role="menuitem" aria-label={CONDITION_CATALOG[t].label} onClick={() => add(t)}
                className="w-full text-left px-3 py-2 text-sm text-fg hover:bg-bg-input-hover">{CONDITION_CATALOG[t].label}</button></li>
            ))}
          </ul>
        )}
      </div>

      {conditions.length > 0 && (
        <div className="text-[10px] tracking-[0.06em] text-fg-dimmer text-center">모두 충족 · AND</div>
      )}
      {conditions.map((leaf) => (
        <ConditionRow key={leaf.id} leaf={leaf} onChange={(n) => replace(leaf.id, n)} onRemove={() => remove(leaf.id)} />
      ))}

      <div className="mt-auto pt-md border-t flex flex-col gap-sm">
        <SectionLabel>전역 사전필터</SectionLabel>
        <div className="flex gap-px p-[2px] bg-bg-input rounded-md w-fit">
          {MARKETS.map((m) => {
            const active = markets.includes(m);
            return <button key={m} type="button" aria-label={m} aria-pressed={active} onClick={() => toggleMarket(m)}
              className={`px-2.5 py-[0.15rem] rounded-sm font-mono text-xs transition-colors ${active ? 'bg-accent text-accent-fg' : 'text-fg-dim hover:bg-bg-input-hover'}`}>{m}</button>;
          })}
        </div>
        <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
          <input type="checkbox" checked={!!universe.exclude_etf}
            onChange={(e) => onUniverseChange({ ...universe, exclude_etf: e.target.checked || undefined })}
            className="accent-[var(--accent)]" />ETF 제외</label>
        <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
          <input type="checkbox" checked={!!universe.exclude_halted}
            onChange={(e) => onUniverseChange({ ...universe, exclude_halted: e.target.checked || undefined })}
            className="accent-[var(--accent)]" />거래정지 제외</label>
      </div>
    </div>
  );
}
```

(Changes vs current: import `useRef` + `useDismissablePopover`; add `anchorRect`/`wrapRef`/`btnRef` + `toggleMenu`; the `<div>` wrapping the button gets `ref={wrapRef}`; the button gets `ref={btnRef}` and `onClick={toggleMenu}`; the `<ul>` switches from `absolute z-10 mt-1 w-full bg-bg-subtle ... rounded-md shadow-lg` to the canon `bg-bg-card border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] z-50` with `position: fixed` + anchorRect coords, gated on `menuOpen && anchorRect`.)

- [ ] **Step 4: Run the test file, verify PASS**

Run: `npx vitest run src/screener/ConditionBuilder.test.tsx`
Expected: PASS — the new outside-click test plus the existing "adds a condition", "repeated same-type", "toggles a market" tests (clicking a `menuitem` is an inside-mousedown, so it still selects).

- [ ] **Step 5: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screener/ConditionBuilder.tsx frontend/src/screener/ConditionBuilder.test.tsx
git commit -m "fix(screener-fe): close 조건 추가 menu on outside click; fixed positioning + canon style"
```

---

## Final verification

- [ ] **Run the whole screener + page test surface**

Run: `npx vitest run src/screener src/pages/Screener.test.tsx`
Expected: PASS (suggestName, ConditionRow, ConfirmModal, SavedScreenerList, ConditionBuilder, Screener).

- [ ] **Type-check the whole frontend**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Lint (optional but matches repo)**

Run: `npx eslint src/screener src/pages/Screener.tsx`
Expected: no errors.

---

## Spec coverage map

| Spec change | Task |
|---|---|
| 변경 2 — empty initial builder | Task 1 |
| 변경 3 — always-show condition detail | Task 2 |
| 변경 1 — create/rename inline edit | Task 5 (+ suggestName Task 3) |
| 변경 1 — overwrite/delete confirm modal | Task 5 (+ ConfirmModal Task 4) |
| 변경 1 — preserved safety semantics | Task 5 (onBeginSave sync, rename own-conds, target-named confirm, delete anchor) |
| 변경 4 — 조건 추가 outside-click close + fixed positioning + canon style | Task 6 |
| Test rewrites (prompt/confirm → inline/modal) | Tasks 2, 5, 6 |
