# Inventory Re-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a selection-aware re-capture affordance to `/inventory` that re-queues Stock-Dates whose `disk_state ≠ complete`, plus the backend ADR-0035 patch that makes the Implicit Retry path honor `phase=done + force_retry=true`.

**Architecture:** Single backend code-line change (ADR-0035) gates the entire feature — without it, every inventory re-capture is silently `already_complete`-deduped. Frontend adds one predicate (`isRecapturable`), one hook (`useInventoryRecapture`), one presentation component (`RecaptureActionBar`), and wires them into `StockDateGroupDetail`. No new API endpoints, no new SSE events. Reuses `useCaptureQueue().addItems`.

**Tech Stack:** Python 3.11+ / FastAPI / pytest (backend) · React 18 / TypeScript / Vitest / React Query / Testing Library (frontend).

**Spec:** [docs/superpowers/specs/2026-05-26-inventory-recapture-design.md](../specs/2026-05-26-inventory-recapture-design.md)
**ADR:** [docs/adr/0035-done-disk-state-aware-implicit-retry.md](../../adr/0035-done-disk-state-aware-implicit-retry.md)

---

## File Map

**Backend:**
- Modify: `hoga/api/captures.py` (one-line condition in step 3b of `enqueue_items`)
- Test: `tests/test_api_captures_queue.py` (extend the existing ADR-0033 block; rewrite the now-obsolete `test_enqueue_dedupes_against_done_complete_with_force_true`)
- Test: `tests/test_api_captures_queue.py` (new defense-in-depth test: COMPLETE disk + force_retry through the worker flow still skips)

**Frontend:**
- Modify: `frontend/src/inventory/DiskStateBadge.tsx` (add `isRecapturable` predicate next to `STATE_SEVERITY`)
- Test: `frontend/src/inventory/DiskStateBadge.test.tsx` (one new `describe('isRecapturable')` block)
- Create: `frontend/src/inventory/useInventoryRecapture.ts` (mutation wrapper + status state)
- Test: `frontend/src/inventory/useInventoryRecapture.test.tsx`
- Create: `frontend/src/inventory/RecaptureActionBar.tsx` (presentation component)
- Test: `frontend/src/inventory/RecaptureActionBar.test.tsx`
- Modify: `frontend/src/inventory/StockDateGroupDetail.tsx` (checkbox column, header bar, mutation wiring, selection state)
- Test: `frontend/src/inventory/StockDateGroupDetail.test.tsx` (extend with selection / re-capture cases)

**Docs (already committed):**
- `docs/superpowers/specs/2026-05-26-inventory-recapture-design.md`
- `docs/adr/0035-done-disk-state-aware-implicit-retry.md`
- `CONTEXT.md` (Retry entry)

---

## Task 1 — Backend: ADR-0035 dedupe patch

**Files:**
- Modify: `tests/test_api_captures_queue.py` (rewrite lines 1191-1205; add new defense-in-depth case)
- Modify: `hoga/api/captures.py:1115-1116` (one extra condition in step 3b)

### Step 1.1: Rewrite the obsolete ADR-0033 invariant test

Lines 1191-1205 of `tests/test_api_captures_queue.py` currently pin the *old* behavior — `done + force_retry=true → already_complete`. ADR-0035 flips this. Replace the test body with the new expectation (and rename for clarity). The two `failed`/`cancelled` re-enqueue tests already in the file (e.g., lines 1208-1228) are our pattern.

- [ ] **Step 1.1.1: Open `tests/test_api_captures_queue.py` and replace the existing test**

Find:

```python
def test_enqueue_dedupes_against_done_complete_with_force_true(monkeypatch, tmp_path):
    """done-phase + force_retry=true STILL dedupes as already_complete (ADR-0033 invariant)."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-d", code="005930", date="20260520", phase="done")

        r = _post_items(c, "005930", ["20260520"], force_retry=True)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["enqueued"] == []
        assert body["deduped"][0]["reason"] == "already_complete"
        # _done untouched.
        assert any(s.item_id == "old-d" for s in captures._done)
        assert len(captures._queue) == 0
```

Replace with:

```python
def test_enqueue_re_enqueues_done_with_force_true_per_adr_0035(monkeypatch, tmp_path):
    """done-phase + force_retry=true → auto re-enqueue (ADR-0035 extension).

    The inventory re-capture UI relies on this branch: a _done row of
    phase=done whose on-disk state is non-complete must be re-queueable
    via force_retry. decide_capture remains the gate for the COMPLETE
    case (see test_decide_capture_complete_skips_with_already_complete_reason
    in test_api_eligibility.py).
    """
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-d", code="005930", date="20260520",
                        phase="done", attempt=1, force_retry=False)

        r = _post_items(c, "005930", ["20260520"], force_retry=True)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        new = body["enqueued"][0]
        assert new["attempt"] == 2
        assert new["force_retry"] is True
        assert new["item_id"] != "old-d"
        assert body["deduped"] == []
        # Old done row removed; new row in _queue.
        assert all(s.item_id != "old-d" for s in captures._done)
        assert len(captures._queue) == 1
        assert captures._queue[0].attempt == 2
        assert captures._queue[0].force_retry is True
```

- [ ] **Step 1.1.2: Run the rewritten test — expect FAIL (backend not patched yet)**

```bash
uv run pytest tests/test_api_captures_queue.py::test_enqueue_re_enqueues_done_with_force_true_per_adr_0035 -v
```

Expected: FAIL — assertion mismatch on `body["enqueued"]` (current code still returns `[]` + `already_complete`).

### Step 1.2: Add defense-in-depth test (eligibility layer is the new last gate)

The ADR-0035 safety claim is "`decide_capture` still skips COMPLETE." There's already a test in `test_api_eligibility.py:29` (`test_decide_capture_complete_skips_with_already_complete_reason`) — verify it asserts `force_retry=False`. Add a sibling that asserts the same for `force_retry=True`.

- [ ] **Step 1.2.1: Append a new test to `tests/test_api_eligibility.py`** (after `test_decide_capture_complete_skips_with_already_complete_reason` near line 35)

```python
def test_decide_capture_complete_skips_even_with_force_retry_per_adr_0035(tmp_path: Path) -> None:
    """ADR-0035 relaxes the enqueue dedupe to let done+force_retry through.
    decide_capture must remain the last gate against accidental overwrite of
    a COMPLETE Stock-Date — without this gate, the relaxed enqueue branch
    would destroy good data.
    """
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=False)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=True,
    )
    assert decision == CaptureDecision(skip_reason="already_complete", resume=False)
```

- [ ] **Step 1.2.2: Run the new eligibility test — expect PASS already**

```bash
uv run pytest tests/test_api_eligibility.py::test_decide_capture_complete_skips_even_with_force_retry_per_adr_0035 -v
```

Expected: PASS (`decide_capture` already behaves this way; the test pins the behavior so any future regression of [eligibility.py:76-77](../../../hoga/api/eligibility.py#L76-L77) is caught).

### Step 1.3: Apply the one-line ADR-0035 patch to captures.py

- [ ] **Step 1.3.1: Edit `hoga/api/captures.py:1115-1116`**

Find:

```python
            # Step 3b: ADR-0033 _done dedupe — branch by phase + force_retry.
            if pair in done_index:
                idx, old = done_index[pair]
                if (old.phase in ("failed", "cancelled")
                        or (old.phase == "skipped" and req.force_retry)):
```

Replace with:

```python
            # Step 3b: ADR-0033 + ADR-0035 _done dedupe — branch by phase + force_retry.
            # done + force_retry → re-enqueue; decide_capture still skips COMPLETE
            # disk state at worker time (eligibility.py), so accidental complete
            # overwrites stay impossible — see ADR-0035 Rationale.
            if pair in done_index:
                idx, old = done_index[pair]
                if (old.phase in ("failed", "cancelled")
                        or (old.phase == "skipped" and req.force_retry)
                        or (old.phase == "done" and req.force_retry)):
```

- [ ] **Step 1.3.2: Re-run the rewritten test — expect PASS**

```bash
uv run pytest tests/test_api_captures_queue.py::test_enqueue_re_enqueues_done_with_force_true_per_adr_0035 -v
```

Expected: PASS.

- [ ] **Step 1.3.3: Run the entire ADR-0033 dedupe block to confirm no regression**

```bash
uv run pytest tests/test_api_captures_queue.py -v -k "done" 
```

Expected: all pass. Pay attention to `test_enqueue_dedupes_against_done_complete_with_force_false` — that one must still pass (the `force_retry=False` path is unchanged).

- [ ] **Step 1.3.4: Run the eligibility test file in full**

```bash
uv run pytest tests/test_api_eligibility.py -v
```

Expected: all pass.

### Step 1.4: Commit backend changes

- [ ] **Step 1.4.1: Stage and commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py tests/test_api_eligibility.py
git commit -m "$(cat <<'EOF'
feat(captures): ADR-0035 — done + force_retry=true → auto re-enqueue

Extends ADR-0033's _done dedupe to let inventory-driven re-capture
through. decide_capture (eligibility.py:76-77) remains the gate for
COMPLETE disk state, so accidental overwrites stay impossible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Frontend: `isRecapturable` predicate

**Files:**
- Modify: `frontend/src/inventory/DiskStateBadge.tsx`
- Modify: `frontend/src/inventory/DiskStateBadge.test.tsx`

### Step 2.1: Write the failing test

- [ ] **Step 2.1.1: Append a new `describe` block to `frontend/src/inventory/DiskStateBadge.test.tsx`**

```ts
import { isRecapturable } from './DiskStateBadge';

describe('isRecapturable', () => {
  it('returns false for complete', () => {
    expect(isRecapturable('complete')).toBe(false);
  });
  it('returns true for source_partial', () => {
    expect(isRecapturable('source_partial')).toBe(true);
  });
  it('returns true for client_incomplete', () => {
    expect(isRecapturable('client_incomplete')).toBe(true);
  });
  it('returns true for invalid', () => {
    expect(isRecapturable('invalid')).toBe(true);
  });
});
```

(Add the `isRecapturable` name to the existing `import` from `./DiskStateBadge` rather than creating a second import line.)

- [ ] **Step 2.1.2: Run the test — expect FAIL**

```bash
cd frontend && npx vitest run src/inventory/DiskStateBadge.test.tsx
```

Expected: FAIL — `isRecapturable is not a function` or TS compile error.

### Step 2.2: Implement the predicate

- [ ] **Step 2.2.1: Add to `frontend/src/inventory/DiskStateBadge.tsx`**

After the `STATE_SEVERITY` export (around line 20), insert:

```ts
/** A captured Stock-Date is recapturable when its DiskState is anything other
 *  than complete. Surfaced as the checkbox-eligibility gate in the Inventory
 *  detail table. Backend policy (eligibility.py:76-77) skips COMPLETE even
 *  with force_retry=true, so allowing complete rows here would only produce
 *  SSE noise (per ADR-0035). */
export function isRecapturable(state: DiskStateValue): boolean {
  return state !== 'complete';
}
```

- [ ] **Step 2.2.2: Run the test — expect PASS**

```bash
cd frontend && npx vitest run src/inventory/DiskStateBadge.test.tsx
```

Expected: PASS (all four cases).

### Step 2.3: Commit

- [ ] **Step 2.3.1: Stage and commit**

```bash
git add frontend/src/inventory/DiskStateBadge.tsx frontend/src/inventory/DiskStateBadge.test.tsx
git commit -m "feat(inventory): isRecapturable predicate for non-complete DiskStates

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Frontend: `useInventoryRecapture` hook

**Files:**
- Create: `frontend/src/inventory/useInventoryRecapture.ts`
- Create: `frontend/src/inventory/useInventoryRecapture.test.tsx`

### Step 3.1: Write failing tests

- [ ] **Step 3.1.1: Create `frontend/src/inventory/useInventoryRecapture.test.tsx`**

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useInventoryRecapture } from './useInventoryRecapture';

// SSE stub — useCaptureQueue subscribes on mount; jsdom has no EventSource.
vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function setupFetch(addItemsResp: unknown = { enqueued: [{}], deduped: [] }, status = 201) {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
    const s = String(url);
    if (s.includes('/api/captures/items') && !s.includes('/retry')) {
      return { ok: status < 400, status, json: async () => addItemsResp } as Response;
    }
    if (s.includes('/api/captures/queue')) {
      return { ok: true, status: 200, json: async () => ({
        active: [], queued: [], done: [], paused: false, max_concurrent: 3,
      })} as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('useInventoryRecapture', () => {
  it('sends force_retry=true and the given dates', async () => {
    const fetchMock = setupFetch();
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

    await act(async () => { await result.current.recapture('005930', ['20260520', '20260521']); });

    const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/captures/items'));
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ code: '005930', dates: ['20260520', '20260521'], force_retry: true });
  });

  it('sets success status with enqueued + skipped counts', async () => {
    setupFetch({
      enqueued: [{ item_id: 'a' }, { item_id: 'b' }],
      deduped: [{ code: '005930', date: '20260520', reason: 'already_in_queue' }],
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

    await act(async () => { await result.current.recapture('005930', ['20260520', '20260521', '20260522']); });

    await waitFor(() => {
      expect(result.current.status).toEqual({ kind: 'success', enqueued: 2, skipped: 1 });
    });
  });

  it('auto-clears success status after 4 seconds', async () => {
    vi.useFakeTimers();
    setupFetch({ enqueued: [{ item_id: 'a' }], deduped: [] });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

    await act(async () => { await result.current.recapture('005930', ['20260520']); });
    await waitFor(() => { expect(result.current.status?.kind).toBe('success'); });

    act(() => { vi.advanceTimersByTime(4000); });
    expect(result.current.status).toBeNull();
  });

  it('sets error status on API failure and does NOT auto-clear', async () => {
    vi.useFakeTimers();
    setupFetch({ detail: { code: 'krx_credentials_missing', message: 'no creds' } }, 503);
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

    await act(async () => {
      try { await result.current.recapture('005930', ['20260520']); }
      catch { /* mutation rethrows; we read status, not the thrown value */ }
    });

    await waitFor(() => { expect(result.current.status?.kind).toBe('error'); });
    act(() => { vi.advanceTimersByTime(60_000); });
    // Errors persist; should still be the same error.
    expect(result.current.status?.kind).toBe('error');
  });
});
```

- [ ] **Step 3.1.2: Run — expect FAIL (module does not exist yet)**

```bash
cd frontend && npx vitest run src/inventory/useInventoryRecapture.test.tsx
```

Expected: FAIL — cannot resolve `./useInventoryRecapture`.

### Step 3.2: Implement the hook

- [ ] **Step 3.2.1: Create `frontend/src/inventory/useInventoryRecapture.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCaptureQueue } from '../capture/useCaptureQueue';
import type { ApiError } from '../api/client';
import type { EnqueueResponse, UpstreamCode } from '../api/types';
import { enqueueErrorHints } from '../api/upstream-hints';
import type { ReactNode } from 'react';

export type RecaptureStatus =
  | { kind: 'success'; enqueued: number; skipped: number }
  | { kind: 'error'; message: ReactNode };

const SUCCESS_AUTOCLEAR_MS = 4_000;

export function useInventoryRecapture() {
  const { addItems } = useCaptureQueue();
  const [status, setStatus] = useState<RecaptureStatus | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSuccessTimer = useCallback(() => {
    if (successTimerRef.current !== null) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSuccessTimer, [clearSuccessTimer]);

  const recapture = useCallback(
    async (code: string, dates: string[]): Promise<void> => {
      if (dates.length === 0) return;
      clearSuccessTimer();
      try {
        const resp: EnqueueResponse = await addItems.mutateAsync({
          code,
          dates,
          force_retry: true,
        });
        setStatus({
          kind: 'success',
          enqueued: resp.enqueued.length,
          skipped: resp.deduped.length,
        });
        successTimerRef.current = setTimeout(() => {
          setStatus(null);
          successTimerRef.current = null;
        }, SUCCESS_AUTOCLEAR_MS);
      } catch (err) {
        const apiErr = err as ApiError;
        const code = apiErr.code;
        const message: ReactNode =
          code && code in enqueueErrorHints
            ? enqueueErrorHints[code as UpstreamCode]
            : err instanceof Error
              ? err.message
              : 'Failed to enqueue re-capture';
        setStatus({ kind: 'error', message });
      }
    },
    [addItems, clearSuccessTimer],
  );

  return { recapture, status, isPending: addItems.isPending };
}
```

- [ ] **Step 3.2.2: Run tests — expect PASS**

```bash
cd frontend && npx vitest run src/inventory/useInventoryRecapture.test.tsx
```

Expected: all four tests PASS.

### Step 3.3: Commit

- [ ] **Step 3.3.1: Stage and commit**

```bash
git add frontend/src/inventory/useInventoryRecapture.ts frontend/src/inventory/useInventoryRecapture.test.tsx
git commit -m "feat(inventory): useInventoryRecapture hook wraps addItems with force_retry=true

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Frontend: `RecaptureActionBar` component

**Files:**
- Create: `frontend/src/inventory/RecaptureActionBar.tsx`
- Create: `frontend/src/inventory/RecaptureActionBar.test.tsx`

### Step 4.1: Write failing tests

- [ ] **Step 4.1.1: Create `frontend/src/inventory/RecaptureActionBar.test.tsx`**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecaptureActionBar } from './RecaptureActionBar';

describe('RecaptureActionBar', () => {
  it('renders nothing when recapturableCount is 0', () => {
    const { container } = render(
      <RecaptureActionBar
        recapturableCount={0}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={null}
        isPending={false}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows "Re-capture all incomplete (N)" when no selection but recapturable rows exist', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={null}
        isPending={false}
      />,
    );
    expect(screen.getByRole('button', { name: /Re-capture all incomplete \(3\)/i })).toBeTruthy();
  });

  it('calls onRecaptureAll when "Re-capture all incomplete" clicked', () => {
    const onAll = vi.fn();
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={onAll}
        onClearSelection={() => {}}
        status={null}
        isPending={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Re-capture all incomplete/i }));
    expect(onAll).toHaveBeenCalledTimes(1);
  });

  it('shows selection mode "K selected · Re-capture · Clear" when selectedCount > 0', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={2}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={null}
        isPending={false}
      />,
    );
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^.*Re-capture$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Clear/i })).toBeTruthy();
  });

  it('calls onRecaptureSelected and onClearSelection from selection mode', () => {
    const onSel = vi.fn();
    const onClear = vi.fn();
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={2}
        onRecaptureSelected={onSel}
        onRecaptureAll={() => {}}
        onClearSelection={onClear}
        status={null}
        isPending={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^.*Re-capture$/i }));
    expect(onSel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('disables the primary action while isPending is true', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={2}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={null}
        isPending={true}
      />,
    );
    const btn = screen.getByRole('button', { name: /^.*Re-capture$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('renders success status', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={{ kind: 'success', enqueued: 2, skipped: 1 }}
        isPending={false}
      />,
    );
    expect(screen.getByText(/Queued 2 capture/)).toBeTruthy();
    expect(screen.getByText(/1 skipped/)).toBeTruthy();
  });

  it('renders error status', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={{ kind: 'error', message: 'something broke' }}
        isPending={false}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('something broke');
  });
});
```

- [ ] **Step 4.1.2: Run — expect FAIL**

```bash
cd frontend && npx vitest run src/inventory/RecaptureActionBar.test.tsx
```

Expected: FAIL — module does not exist.

### Step 4.2: Implement the component

- [ ] **Step 4.2.1: Create `frontend/src/inventory/RecaptureActionBar.tsx`**

```tsx
import type { ReactNode } from 'react';

export type RecaptureStatus =
  | { kind: 'success'; enqueued: number; skipped: number }
  | { kind: 'error'; message: ReactNode };

type Props = {
  recapturableCount: number;
  selectedCount: number;
  onRecaptureSelected: () => void;
  onRecaptureAll: () => void;
  onClearSelection: () => void;
  status: RecaptureStatus | null;
  isPending: boolean;
};

export function RecaptureActionBar({
  recapturableCount,
  selectedCount,
  onRecaptureSelected,
  onRecaptureAll,
  onClearSelection,
  status,
  isPending,
}: Props) {
  if (recapturableCount === 0 && status === null) return null;

  const inSelectionMode = selectedCount > 0;

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-3">
        {inSelectionMode ? (
          <>
            <span className="text-fg-dim font-mono tabular-nums">
              {selectedCount} selected
            </span>
            <button
              type="button"
              disabled={isPending}
              onClick={onRecaptureSelected}
              style={{
                background: isPending ? 'var(--bg-input)' : 'var(--accent)',
                color: isPending ? 'var(--fg-dimmer)' : 'var(--bg)',
              }}
              className="border-none rounded-md px-2.5 py-1 font-semibold cursor-pointer disabled:cursor-not-allowed"
            >
              ▶ Re-capture
            </button>
            <button
              type="button"
              onClick={onClearSelection}
              className="text-fg-dim hover:text-fg cursor-pointer bg-transparent border-none"
            >
              Clear
            </button>
          </>
        ) : recapturableCount > 0 ? (
          <button
            type="button"
            disabled={isPending}
            title="source partial · client incomplete · invalid"
            onClick={onRecaptureAll}
            className="text-fg-dim hover:text-fg cursor-pointer bg-transparent border-none disabled:cursor-not-allowed"
          >
            Re-capture all incomplete ({recapturableCount})
          </button>
        ) : null}
      </div>
      {status?.kind === 'success' && (
        <div className="text-fg-dim font-mono tabular-nums">
          Queued {status.enqueued} capture{status.enqueued === 1 ? '' : 's'}
          {status.skipped > 0 && ` (${status.skipped} skipped)`}
        </div>
      )}
      {status?.kind === 'error' && (
        <div role="alert" style={{ color: 'var(--error)' }}>
          {status.message}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4.2.2: Run tests — expect PASS**

```bash
cd frontend && npx vitest run src/inventory/RecaptureActionBar.test.tsx
```

Expected: all eight tests PASS.

### Step 4.3: Commit

- [ ] **Step 4.3.1: Stage and commit**

```bash
git add frontend/src/inventory/RecaptureActionBar.tsx frontend/src/inventory/RecaptureActionBar.test.tsx
git commit -m "feat(inventory): RecaptureActionBar — three-state bar (idle/selection/status)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Frontend: Wire `StockDateGroupDetail`

**Files:**
- Modify: `frontend/src/inventory/StockDateGroupDetail.tsx`
- Modify: `frontend/src/inventory/StockDateGroupDetail.test.tsx`

### Step 5.1: Inspect the existing test file to understand its scaffolding

- [ ] **Step 5.1.1: Read the file to identify how rows are rendered and how mocking is currently set up**

```bash
cat frontend/src/inventory/StockDateGroupDetail.test.tsx
```

Note the existing `render(...)` patterns, the row fixtures (likely a `StockDate` factory), and whether `useNavigate` / `useTabsStore` are mocked. The new tests will reuse that scaffolding.

### Step 5.2: Write the failing test cases

- [ ] **Step 5.2.1: Append the following block to `frontend/src/inventory/StockDateGroupDetail.test.tsx`**

(If the existing file imports `vi`, `describe`, `it`, `expect`, `render`, `screen`, `fireEvent` and a `mkRow` / `StockDate` factory, reuse them. Otherwise replicate them inline at the top of the new block. The fixtures below assume the existing file already has a `mkRow(opts)` helper — if not, define one above the new describe block.)

```tsx
// If mkRow doesn't already exist, add this at module scope:
function mkRow(o: Partial<StockDate> & { date: string; disk_state: DiskStateValue }): StockDate {
  return {
    code: '005930', name: '삼성전자',
    regular_session_open_ms: 0, regular_session_close_ms: 0,
    data_window_first_ms: 0, data_window_last_ms: 0,
    price_min: 0, price_max: 0, captured_at: Date.parse('2026-05-01T00:00:00+09:00'),
    total_volume: 0, pages_collected: 0, file_size_bytes: 0,
    today_open: 0, today_high: 0, today_low: 0, today_close: 0,
    ...o,
  };
}

describe('StockDateGroupDetail — re-capture', () => {
  const mockNavigate = vi.fn();
  vi.mock('react-router', async (orig) => ({
    ...(await orig<typeof import('react-router')>()),
    useNavigate: () => mockNavigate,
  }));

  beforeEach(() => { mockNavigate.mockClear(); vi.restoreAllMocks(); });

  function setup(rows: StockDate[], addItemsResp: unknown = { enqueued: [{ item_id: 'x' }], deduped: [] }) {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
      const s = String(url);
      if (s.includes('/api/captures/items') && !s.includes('/retry')) {
        return { ok: true, status: 201, json: async () => addItemsResp } as Response;
      }
      if (s.includes('/api/captures/queue')) {
        return { ok: true, status: 200, json: async () => ({
          active: [], queued: [], done: [], paused: false, max_concurrent: 3,
        })} as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return { qc };
  }

  it('does not render a checkbox for complete rows', () => {
    const { qc } = setup([
      mkRow({ date: '20260520', disk_state: 'complete' }),
      mkRow({ date: '20260521', disk_state: 'source_partial' }),
    ]);
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <StockDateGroupDetail rows={[
            mkRow({ date: '20260520', disk_state: 'complete' }),
            mkRow({ date: '20260521', disk_state: 'source_partial' }),
          ]} selectedCode="005930" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(1);  // only source_partial row
  });

  it('clicking a checkbox does not navigate to /replay', async () => {
    const { qc } = setup([mkRow({ date: '20260520', disk_state: 'source_partial' })]);
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <StockDateGroupDetail rows={[mkRow({ date: '20260520', disk_state: 'source_partial' })]} selectedCode="005930" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows "Re-capture all incomplete (2)" when 2 abnormal rows and none selected', () => {
    const rows = [
      mkRow({ date: '20260520', disk_state: 'source_partial' }),
      mkRow({ date: '20260521', disk_state: 'client_incomplete' }),
      mkRow({ date: '20260522', disk_state: 'complete' }),
    ];
    const { qc } = setup(rows);
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><StockDateGroupDetail rows={rows} selectedCode="005930" /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: /Re-capture all incomplete \(2\)/i })).toBeTruthy();
  });

  it('clicking "Re-capture all incomplete" posts force_retry=true with both abnormal dates', async () => {
    const rows = [
      mkRow({ date: '20260520', disk_state: 'source_partial' }),
      mkRow({ date: '20260521', disk_state: 'invalid' }),
      mkRow({ date: '20260522', disk_state: 'complete' }),
    ];
    const { qc } = setup(rows);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><StockDateGroupDetail rows={rows} selectedCode="005930" /></MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Re-capture all incomplete/i }));
    await waitFor(() => {
      const post = (fetchMock.mock.calls).find((c) =>
        String(c[0]).includes('/api/captures/items') &&
        (c[1] as RequestInit)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body).toEqual({
        code: '005930',
        dates: ['20260520', '20260521'],
        force_retry: true,
      });
    });
  });

  it('selecting 1 checkbox and clicking ▶ Re-capture posts that date', async () => {
    const rows = [
      mkRow({ date: '20260520', disk_state: 'source_partial' }),
      mkRow({ date: '20260521', disk_state: 'client_incomplete' }),
    ];
    const { qc } = setup(rows);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><StockDateGroupDetail rows={rows} selectedCode="005930" /></MemoryRouter>
      </QueryClientProvider>,
    );
    const [cb1] = screen.getAllByRole('checkbox');
    fireEvent.click(cb1);
    fireEvent.click(screen.getByRole('button', { name: /^.*▶ Re-capture/i }));
    await waitFor(() => {
      const post = (fetchMock.mock.calls).find((c) =>
        String(c[0]).includes('/api/captures/items') &&
        (c[1] as RequestInit)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.dates.length).toBe(1);
      expect(body.force_retry).toBe(true);
    });
  });

  it('selection clears when selectedCode changes', () => {
    const rowsA = [mkRow({ date: '20260520', disk_state: 'source_partial', code: '005930' })];
    const rowsB = [mkRow({ date: '20260601', disk_state: 'source_partial', code: '000660' })];
    const { qc } = setup(rowsA);
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><StockDateGroupDetail rows={rowsA} selectedCode="005930" /></MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByText(/1 selected/)).toBeTruthy();

    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter><StockDateGroupDetail rows={rowsB} selectedCode="000660" /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/selected/)).toBeNull();
  });
});
```

(Use `import { MemoryRouter } from 'react-router';` and `import { waitFor } from '@testing-library/react';` and `import { QueryClient, QueryClientProvider } from '@tanstack/react-query';` if not already imported in the existing file.)

- [ ] **Step 5.2.2: Run — expect FAIL**

```bash
cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx
```

Expected: FAIL — checkbox column doesn't exist; bar doesn't render; mutations not wired.

### Step 5.3: Modify the component

- [ ] **Step 5.3.1: Edit `frontend/src/inventory/StockDateGroupDetail.tsx`**

Replace the entire file with:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { StockDate } from '../api/types';
import { useTabsStore } from '../state/tabs';
import { useStockDateGroups } from './useStockDateGroups';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';
import { DiskStateBadge, isRecapturable } from './DiskStateBadge';
import { sortDates, nextSortState, type SortKey, type SortState } from './sortDates';
import { useInventoryRecapture } from './useInventoryRecapture';
import { RecaptureActionBar } from './RecaptureActionBar';

type Props = {
  rows: StockDate[];
  selectedCode: string | null;
};

export function StockDateGroupDetail({ rows, selectedCode }: Props) {
  const navigate = useNavigate();
  const groups = useStockDateGroups(rows, '');
  const group = useMemo(() => {
    if (selectedCode === null) return null;
    return groups.find(g => g.code === selectedCode) ?? groups[0] ?? null;
  }, [groups, selectedCode]);

  const [sort, setSort] = useState<SortState>(null);
  const sortedDates = useMemo(
    () => (group ? sortDates(group.dates, sort) : []),
    [group, sort],
  );

  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  // Reset selection when the active Code changes (the dates set is meaningful only
  // within one StockDateGroup).
  useEffect(() => { setSelectedDates(new Set()); }, [selectedCode]);

  // Prune selection entries whose row no longer satisfies isRecapturable
  // (SSE may have flipped a row to 'complete' or removed it entirely).
  const recapturableDateSet = useMemo(
    () => new Set(sortedDates.filter(r => isRecapturable(r.disk_state)).map(r => r.date)),
    [sortedDates],
  );
  useEffect(() => {
    setSelectedDates(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const d of prev) {
        if (recapturableDateSet.has(d)) next.add(d);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [recapturableDateSet]);

  const { recapture, status, isPending } = useInventoryRecapture();

  if (group === null) {
    return (
      <section className="bg-bg-card border rounded-lg p-md text-fg-dim">
        종목을 선택하세요
      </section>
    );
  }

  const totalVolume = group.dates.reduce((s, d) => s + d.total_volume, 0);
  const recapturableCount = recapturableDateSet.size;

  const onRowClick = (r: StockDate) => {
    const tabId = useTabsStore.getState().newTab();
    useTabsStore.getState().setSelection(tabId, {
      code: r.code,
      fromDate: r.date,
      toDate: r.date,
      timeframe: '1m',
    });
    navigate('/replay');
  };

  const onSort = (column: SortKey) => setSort(prev => nextSortState(prev, column));

  const toggleSelection = (date: string) => {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const handleRecaptureSelected = async () => {
    await recapture(group.code, [...selectedDates]);
    setSelectedDates(new Set());
  };
  const handleRecaptureAll = async () => {
    await recapture(group.code, [...recapturableDateSet]);
  };
  const handleClearSelection = () => setSelectedDates(new Set());

  return (
    <section className="bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-hidden">
      <header className="px-4 py-3 border-b flex items-baseline justify-between gap-4">
        <h2 className="text-md font-semibold shrink-0">
          <span className="text-accent font-mono">{group.code}</span>{' '}
          <span className="text-fg">{group.name}</span>
        </h2>
        <div className="flex flex-col items-end gap-1 min-w-0">
          <span className="text-xs text-fg-dim font-mono tabular-nums">
            {group.dates.length} dates · {fmtVolume(totalVolume)} vol · {fmtSize(group.totalSizeBytes)}
          </span>
          <RecaptureActionBar
            recapturableCount={recapturableCount}
            selectedCount={selectedDates.size}
            onRecaptureSelected={handleRecaptureSelected}
            onRecaptureAll={handleRecaptureAll}
            onClearSelection={handleClearSelection}
            status={status}
            isPending={isPending}
          />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse font-mono text-sm tabular-nums">
          <thead className="bg-bg-subtle sticky top-0">
            <tr>
              <th className="px-2 py-2 border-b w-8" aria-label="select" />
              <SortableTh column="state"    sort={sort} onSort={onSort}>State</SortableTh>
              <SortableTh column="date"     sort={sort} onSort={onSort}>Date</SortableTh>
              <SortableTh column="captured" sort={sort} onSort={onSort}>Captured</SortableTh>
              <SortableTh column="volume"   sort={sort} onSort={onSort} right>Volume</SortableTh>
              <SortableTh column="pages"    sort={sort} onSort={onSort} right>Pages</SortableTh>
              <SortableTh column="size"     sort={sort} onSort={onSort} right>Size</SortableTh>
              <SortableTh column="ohlc"     sort={sort} onSort={onSort} right title="종가 기준 정렬">OHLC</SortableTh>
            </tr>
          </thead>
          <tbody>
            {sortedDates.map((r) => {
              const recap = isRecapturable(r.disk_state);
              return (
                <tr
                  key={`${r.code}-${r.date}`}
                  onClick={() => onRowClick(r)}
                  className="border-b hover:bg-bg-input-hover cursor-pointer"
                >
                  <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                    {recap ? (
                      <input
                        type="checkbox"
                        aria-label={`select ${r.date}`}
                        checked={selectedDates.has(r.date)}
                        onChange={() => toggleSelection(r.date)}
                      />
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-center"><DiskStateBadge state={r.disk_state} /></td>
                  <td className="px-3 py-1.5">{fmtDate(r.date)}</td>
                  <td className="px-3 py-1.5 text-fg-dim">{fmtTime(r.captured_at)}</td>
                  <td className="px-3 py-1.5 text-right">{r.total_volume.toLocaleString('ko-KR')}</td>
                  <td className="px-3 py-1.5 text-right text-fg-dim">{r.pages_collected}</td>
                  <td className="px-3 py-1.5 text-right text-fg-dim">{fmtSize(r.file_size_bytes)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtOHLC(r.today_open, r.today_close)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type SortableThProps = {
  column: SortKey;
  sort: SortState;
  onSort: (column: SortKey) => void;
  right?: boolean;
  title?: string;
  children: React.ReactNode;
};

function SortableTh({ column, sort, onSort, right, title, children }: SortableThProps) {
  const active = sort?.key === column;
  const dir = active ? sort.dir : null;
  const ariaSort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  const indicator = dir === 'desc' ? '▼' : dir === 'asc' ? '▲' : '▾';
  const indicatorClass = active ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-30';
  const labelClass = active ? 'text-fg' : 'text-fg-dimmer';

  return (
    <th
      aria-sort={ariaSort}
      className={`px-3 py-2 border-b text-xs uppercase tracking-wider font-semibold ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      <button
        type="button"
        title={title}
        onClick={() => onSort(column)}
        className={`group inline-flex items-center gap-1 select-none ${labelClass} ${
          right ? 'flex-row-reverse' : 'flex-row'
        }`}
      >
        <span>{children}</span>
        <span className={`font-mono ${indicatorClass}`} aria-hidden="true">
          {indicator}
        </span>
      </button>
    </th>
  );
}
```

- [ ] **Step 5.3.2: Run the file's tests — expect PASS**

```bash
cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx
```

Expected: all new tests PASS; existing tests still PASS.

- [ ] **Step 5.3.3: Run the full inventory test suite**

```bash
cd frontend && npx vitest run src/inventory
```

Expected: all PASS.

### Step 5.4: Commit

- [ ] **Step 5.4.1: Stage and commit**

```bash
git add frontend/src/inventory/StockDateGroupDetail.tsx frontend/src/inventory/StockDateGroupDetail.test.tsx
git commit -m "feat(inventory): selected/bulk re-capture in StockDateGroupDetail

Wires isRecapturable, useInventoryRecapture, and RecaptureActionBar into
the detail panel: checkbox column for non-complete rows, header action
bar with idle/selection states, selection lifecycle tied to selectedCode
and SSE-driven row pruning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Integration smoke + push

**Files:** none modified — verification only.

### Step 6.1: Run the full test suites

- [ ] **Step 6.1.1: Backend**

```bash
uv run pytest tests/test_api_captures_queue.py tests/test_api_eligibility.py -v
```

Expected: all PASS.

- [ ] **Step 6.1.2: Frontend**

```bash
cd frontend && npx vitest run
```

Expected: all PASS.

- [ ] **Step 6.1.3: Type check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

### Step 6.2: Manual smoke test (per CLAUDE.md `Dev servers`)

- [ ] **Step 6.2.1: Start backend + frontend dev servers**

In separate terminals (or via the `Dev: backend + frontend` VS Code task):

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

```bash
cd frontend && npm run dev
```

- [ ] **Step 6.2.2: Verify the flow against a known `source_partial` Stock-Date**

1. Open <http://localhost:5173/inventory>.
2. Pick a Code in the left list whose dot indicates a non-complete state. Identify a row with `disk_state = source_partial`.
3. Confirm the row has a checkbox; complete rows in the same group have no checkbox.
4. Click the row's checkbox — confirm the bar switches to `1 selected · [▶ Re-capture] [Clear]` and that the click did NOT navigate to /replay.
5. Click `▶ Re-capture`. Confirm:
   - Inline success message `Queued 1 capture` (or "with 0 skipped" omitted) appears.
   - Within a few seconds, the row disappears (SSE `inventory_removed`).
   - When the capture finishes, the row reappears (`inventory_added`) — possibly still `source_partial` if upstream is still partial. That's correct behavior; the user retries again if upstream improves.
6. Select another Code; confirm the previous selection is cleared.
7. From the original Code, click `Re-capture all incomplete (N)` (no selection). Confirm the bulk path posts force_retry=true and queues all abnormal rows.

- [ ] **Step 6.2.3: Stop the dev servers**

Press `Ctrl-C` in each terminal.

### Step 6.3: Final commit + push (only after manual verification)

- [ ] **Step 6.3.1: Verify nothing dangling**

```bash
git status
```

Expected: clean working tree.

- [ ] **Step 6.3.2: Push the branch**

```bash
git push -u origin HEAD
```

(Do NOT create the PR yet — the user may want to run `/improve-codebase-architecture` first per their roadmap.)

---

## Self-Review

**Spec coverage** —

| Spec section | Task |
|---|---|
| Backend ADR-0035 patch | Task 1 |
| `isRecapturable` predicate in `DiskStateBadge.tsx` | Task 2 |
| `useInventoryRecapture` hook (status, auto-clear, error-persist) | Task 3 |
| `RecaptureActionBar` component (three states + isPending + status) | Task 4 |
| Checkbox column gated by `isRecapturable` | Task 5 (Step 5.3.1) |
| `e.stopPropagation()` on checkbox to preserve /replay nav | Task 5 (Step 5.3.1, td `onClick`) |
| Header action bar in `StockDateGroupDetail` | Task 5 (Step 5.3.1, `<RecaptureActionBar />` in header) |
| Selection state reset on `selectedCode` change | Task 5 (Step 5.3.1, first `useEffect`) |
| SSE-driven prune (state flips to complete or row removed) | Task 5 (Step 5.3.1, second `useEffect`) |
| Always send `force_retry: true` | Task 3 (`recapture` body) + Task 5 tests pin it |
| Inline success/error feedback under header | Task 4 (status slots) + Task 5 (wired) |
| Manual smoke | Task 6 |

**Placeholder scan** — no `TBD`, no `TODO`, no "implement similar to". All code blocks complete.

**Type consistency** —
- `RecaptureStatus` defined identically in `useInventoryRecapture.ts` (Task 3) and `RecaptureActionBar.tsx` (Task 4). To avoid drift, the bar's `RecaptureStatus` import is intentional — if the hook's status union changes, the bar's prop must change too. The duplication is acceptable at this scale; consolidating into a single `inventory/recapture-status.ts` is a candidate for the post-implementation `/improve-codebase-architecture` pass.
- `isRecapturable(state: DiskStateValue)` signature consistent across Task 2 definition and Task 5 usage.
- `recapture(code: string, dates: string[]): Promise<void>` consistent across Task 3 definition, Task 5 callbacks.
- `addItems.mutateAsync({ code, dates, force_retry: true })` — request shape matches `EnqueueRequest` ([api/types.ts:270](../../../frontend/src/api/types.ts#L270)).
