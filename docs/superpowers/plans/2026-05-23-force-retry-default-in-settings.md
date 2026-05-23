# Force-Retry Capture Default in Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the "⚠ Force re-capture source-partial dates" checkbox as a Settings-page-controlled default, with `CaptureForm` initializing from (and resetting to) that default.

**Architecture:** Tiny helper module `frontend/src/capture/forceRetryDefault.ts` owns the localStorage key and I/O. Settings page reads + writes via the helper from a new `CaptureDefaultsSection`. `CaptureForm` reads via the helper for both `useState` initializer and the post-success reset path. No server changes, no store changes.

**Tech Stack:** React 18, TypeScript, Vitest + Testing Library, localStorage.

**Spec:** `docs/superpowers/specs/2026-05-23-force-retry-default-in-settings-design.md`

---

## File Structure

**Create (one new module + its test):**
- `frontend/src/capture/forceRetryDefault.ts` — exports `loadForceRetryDefault(): boolean` and `saveForceRetryDefault(value: boolean): void`. Owns `STORAGE_KEY = 'capture.force_retry_default'`.
- `frontend/src/capture/forceRetryDefault.test.ts` — unit tests for the helper.

**Modify (three files):**
- `frontend/src/pages/Settings.tsx` — add a `CaptureDefaultsSection` between `SymbolMasterSection` and the v1+1 footer; import the helper.
- `frontend/src/pages/Settings.test.tsx` — add 2 cases covering checkbox mount state and click→storage roundtrip.
- `frontend/src/capture/CaptureForm.tsx` — replace `useState(false)` with helper read, replace `setForceRetry(false)` in onSuccess with helper read.
- `frontend/src/capture/CaptureForm.test.tsx` — add 1 case asserting initial checkbox state honours localStorage; add `localStorage.clear()` to `beforeEach`.

**No other files touched.**

---

## Test Invocation Reference

```bash
cd frontend && npx vitest run src/capture/forceRetryDefault.test.ts
cd frontend && npx vitest run src/pages/Settings.test.tsx
cd frontend && npx vitest run src/capture/CaptureForm.test.tsx
cd frontend && npx vitest run                  # full suite
cd frontend && npx tsc --noEmit                # type check
```

---

## Task 1: Helper module

**Files:**
- Create: `frontend/src/capture/forceRetryDefault.ts`
- Test: `frontend/src/capture/forceRetryDefault.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `frontend/src/capture/forceRetryDefault.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadForceRetryDefault, saveForceRetryDefault } from './forceRetryDefault';

describe('forceRetryDefault', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('loadForceRetryDefault returns false when key is absent', () => {
    expect(loadForceRetryDefault()).toBe(false);
  });

  it('saveForceRetryDefault(true) round-trips through loadForceRetryDefault', () => {
    saveForceRetryDefault(true);
    expect(loadForceRetryDefault()).toBe(true);
  });

  it('saveForceRetryDefault(false) round-trips and overrides a previous true', () => {
    saveForceRetryDefault(true);
    saveForceRetryDefault(false);
    expect(loadForceRetryDefault()).toBe(false);
  });

  it('loadForceRetryDefault returns false when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadForceRetryDefault()).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run, verify failure**

```bash
cd frontend && npx vitest run src/capture/forceRetryDefault.test.ts
```

Expected: FAIL — `Cannot find module './forceRetryDefault'`.

- [ ] **Step 1.3: Implement the helper**

Create `frontend/src/capture/forceRetryDefault.ts`:

```typescript
/**
 * Persisted default for the CaptureForm's "Force re-capture source-partial
 * dates" checkbox. Backed by a single localStorage entry; both the Settings
 * page and CaptureForm consume the helper to keep the key string out of
 * call sites.
 */
const STORAGE_KEY = 'capture.force_retry_default';

export function loadForceRetryDefault(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveForceRetryDefault(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* SSR / privacy mode — silently drop the write */
  }
}
```

- [ ] **Step 1.4: Run, verify all 4 pass**

```bash
cd frontend && npx vitest run src/capture/forceRetryDefault.test.ts
```

Expected: 4/4 PASS.

- [ ] **Step 1.5: Commit**

```bash
git add frontend/src/capture/forceRetryDefault.ts frontend/src/capture/forceRetryDefault.test.ts
git commit -m "$(cat <<'EOF'
feat(capture): add forceRetryDefault localStorage helper

Wraps a single 'capture.force_retry_default' boolean for the Settings
page and CaptureForm to share. Defaults to false on unset key, on read
failure, and on write failure (privacy mode / SSR).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Settings page section

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`
- Test: `frontend/src/pages/Settings.test.tsx`

- [ ] **Step 2.1: Add `localStorage.clear()` to the existing `beforeEach`**

Open `frontend/src/pages/Settings.test.tsx`. The current `beforeEach` block (lines 17-19) only calls `vi.restoreAllMocks()`. Update it to:

```typescript
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });
```

- [ ] **Step 2.2: Write the failing test — checkbox reflects persisted value**

Append to `frontend/src/pages/Settings.test.tsx` at the end of the existing `describe` block (just before the closing `});`):

```typescript
  it('Capture defaults checkbox reflects the persisted localStorage value on mount', async () => {
    localStorage.setItem('capture.force_retry_default', 'true');
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<Settings />);

    const cb = await screen.findByTestId('settings-force-retry-default');
    expect((cb as HTMLInputElement).checked).toBe(true);
  });

  it('Clicking the Capture defaults checkbox writes through to localStorage and updates UI', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<Settings />);

    const cb = await screen.findByTestId('settings-force-retry-default');
    expect((cb as HTMLInputElement).checked).toBe(false);
    expect(localStorage.getItem('capture.force_retry_default')).toBeNull();

    cb.click();

    expect((cb as HTMLInputElement).checked).toBe(true);
    expect(localStorage.getItem('capture.force_retry_default')).toBe('true');
  });
```

- [ ] **Step 2.3: Run, verify failure**

```bash
cd frontend && npx vitest run src/pages/Settings.test.tsx -t "Capture defaults"
```

Expected: BOTH FAIL — `Unable to find an element by: [data-testid="settings-force-retry-default"]`.

- [ ] **Step 2.4: Implement `CaptureDefaultsSection` in `Settings.tsx`**

Open `frontend/src/pages/Settings.tsx`.

**(a) Add the helper import at the top:**

```typescript
import { loadForceRetryDefault, saveForceRetryDefault } from '../capture/forceRetryDefault';
```

Place it after the existing `../api/upstream-hints` import (line 6 area). Keep `useState` already imported (line 1).

**(b) Add `CaptureDefaultsSection` below `SymbolMasterSection`** (after the existing `function SymbolMasterSection() { ... }` block, before the `function Row(...)` helper). Use exactly this code:

```typescript
function CaptureDefaultsSection() {
  const [forceRetryDefault, setForceRetryDefault] = useState<boolean>(
    () => loadForceRetryDefault(),
  );
  const onToggle = () => {
    const next = !forceRetryDefault;
    setForceRetryDefault(next);
    saveForceRetryDefault(next);
  };
  return (
    <section className="space-y-2 pt-4 border-t border-border">
      <h3 className="text-sm font-semibold">Capture defaults</h3>
      <label className="flex gap-2 items-center text-sm text-fg">
        <input
          type="checkbox"
          checked={forceRetryDefault}
          onChange={onToggle}
          data-testid="settings-force-retry-default"
        />
        <span>⚠ Force re-capture source-partial dates</span>
      </label>
      <p className="text-xs text-fg-dimmer">
        새 캡처를 시작할 때 이 옵션이 기본으로 켜집니다. 캡처 폼에서 매번 토글할 수 있습니다.
      </p>
    </section>
  );
}
```

**(c) Mount it inside the main `Settings()` JSX**, immediately after `<SymbolMasterSection />`:

```typescript
      <SymbolMasterSection />
      <CaptureDefaultsSection />
      <p className="text-xs text-fg-dimmer pt-4">
```

- [ ] **Step 2.5: Run the new tests, verify they pass**

```bash
cd frontend && npx vitest run src/pages/Settings.test.tsx -t "Capture defaults"
```

Expected: BOTH PASS.

- [ ] **Step 2.6: Run the full Settings.test.tsx, verify nothing regressed**

```bash
cd frontend && npx vitest run src/pages/Settings.test.tsx
```

Expected: ALL PASS (5 pre-existing + 2 new = 7).

- [ ] **Step 2.7: Commit**

```bash
git add frontend/src/pages/Settings.tsx frontend/src/pages/Settings.test.tsx
git commit -m "$(cat <<'EOF'
feat(pages/Settings): expose Force re-capture default

Adds a "Capture defaults" section to the Settings page with a single
checkbox that persists the force-retry default to localStorage via the
forceRetryDefault helper. CaptureForm will pick this up in the next
commit.

testid: settings-force-retry-default

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: CaptureForm consumes the default

**Files:**
- Modify: `frontend/src/capture/CaptureForm.tsx`
- Test: `frontend/src/capture/CaptureForm.test.tsx`

- [ ] **Step 3.1: Add `localStorage.clear()` to CaptureForm.test.tsx's `beforeEach`**

Open `frontend/src/capture/CaptureForm.test.tsx`. The current `beforeEach` (line 39) is one line: `vi.restoreAllMocks();`. Replace it with:

```typescript
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
```

- [ ] **Step 3.2: Write the failing test — initial checkbox honours localStorage**

Append a new case inside the existing `describe('CaptureForm', ...)` block (just before the closing `});`):

```typescript
  it('Force re-capture checkbox initializes from the localStorage default', async () => {
    localStorage.setItem('capture.force_retry_default', 'true');
    const { qc } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));

    const cb = screen.getByLabelText(/Force re-capture/i) as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });
```

- [ ] **Step 3.3: Run, verify failure**

```bash
cd frontend && npx vitest run src/capture/CaptureForm.test.tsx -t "Force re-capture checkbox initializes"
```

Expected: FAIL — checkbox starts unchecked because `useState(false)` ignores localStorage.

- [ ] **Step 3.4: Update CaptureForm.tsx**

Open `frontend/src/capture/CaptureForm.tsx`.

**(a) Add the import** (near the top, after `../api/types`):

```typescript
import { loadForceRetryDefault } from './forceRetryDefault';
```

**(b) Replace line 19** (`const [forceRetry, setForceRetry] = useState(false);`) with:

```typescript
  const [forceRetry, setForceRetry] = useState<boolean>(() => loadForceRetryDefault());
```

**(c) Replace the post-success reset in the onSuccess handler** (the line `setForceRetry(false);` around line 41) with:

```typescript
          setForceRetry(loadForceRetryDefault());
```

Why re-read on reset rather than reusing the initial value? The user can change the Settings default while the form is open; re-reading on reset picks up the change for the next capture. The localStorage read is negligible.

**No other edits.** Do not touch the checkbox JSX, label text, or the `force_retry` field in the POST body.

- [ ] **Step 3.5: Run the new test, verify it passes**

```bash
cd frontend && npx vitest run src/capture/CaptureForm.test.tsx -t "Force re-capture checkbox initializes"
```

Expected: PASS.

- [ ] **Step 3.6: Run the full CaptureForm.test.tsx, verify pre-existing tests still pass**

```bash
cd frontend && npx vitest run src/capture/CaptureForm.test.tsx
```

Expected: ALL PASS (existing tests + 1 new).

If the existing "form resets after a successful Start" test breaks, **STOP** and read carefully. It may be incidentally relying on the old `setForceRetry(false)` reset behaviour while a localStorage value is leaking from a sibling test. The `localStorage.clear()` we added in Step 3.1 should prevent that, but if it doesn't, ensure the test does not pre-seed `capture.force_retry_default` before clicking Start.

- [ ] **Step 3.7: Run the whole frontend suite**

```bash
cd frontend && npx vitest run
```

Expected: ALL PASS. Nothing outside the touched files should change.

- [ ] **Step 3.8: TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3.9: Commit**

```bash
git add frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureForm.test.tsx
git commit -m "$(cat <<'EOF'
feat(capture/Form): consume forceRetryDefault on mount + reset

Force re-capture checkbox now initializes from
loadForceRetryDefault() and the post-success reset returns to the
current default (re-read so a Settings change in another tab takes
effect on the next capture). Per-capture toggling still works
exactly as before.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: End-to-end verification

**Files:** None modified.

- [ ] **Step 4.1: Run the dev server**

```bash
cd frontend && npm run dev
```

Open `<URL>/settings`.

- [ ] **Step 4.2: Confirm the new section**

Below "Symbol Master", a new section titled "Capture defaults" with one checkbox `⚠ Force re-capture source-partial dates` and a Korean sub-text. Unchecked by default (fresh browser).

- [ ] **Step 4.3: Toggle on, verify persistence**

Click the checkbox — it should immediately become checked. Refresh the page; the checkbox remains checked.

- [ ] **Step 4.4: Navigate to /capture, verify CaptureForm picks up the default**

Navigate to `<URL>/capture`. The Options checkbox should already be checked (because the default is now `true`).

- [ ] **Step 4.5: Toggle the CaptureForm checkbox to false, submit a capture, verify reset returns to true**

Uncheck it for this one capture. Pick a symbol + range, click Start. After the form resets, the checkbox should be **checked again** (returning to the Settings default), NOT unchecked.

- [ ] **Step 4.6: Go back to /settings, toggle the default off, return to /capture**

Re-uncheck the Settings checkbox. Navigate back to /capture. Submit another (or re-mount the page). The CaptureForm checkbox should now reset to unchecked after success.

- [ ] **Step 4.7: Stop the dev server**

Ctrl-C.

---

## Self-Review Checklist

**Spec coverage** — each spec requirement maps to a task:

- `forceRetryDefault.ts` helper module — Task 1.
- "Capture defaults" Settings section — Task 2.
- `CaptureForm` initial value + reset behavior — Task 3.
- 3 helper unit tests — Task 1 Steps 1.1-1.4.
- 2 Settings tests — Task 2 Steps 2.2-2.6.
- 1 CaptureForm test + `beforeEach` augmentation — Task 3 Steps 3.1-3.6.

**Placeholder scan:** none. Each step has either exact code or a runnable command with an expected outcome.

**Type consistency:** `loadForceRetryDefault(): boolean` and `saveForceRetryDefault(value: boolean): void` are used identically in Settings.tsx and CaptureForm.tsx. The `useState<boolean>(() => loadForceRetryDefault())` form lazily initializes (no re-read on every render) — same pattern as Capture.tsx already uses.

**Ordering invariant:** Task 1 must land before Task 2 (Settings imports the helper). Task 2 should land before Task 3 (so users see the Settings UI as the controlling surface before CaptureForm starts honoring it). Each commit leaves the repo in a green test state.

**Out of scope confirmed:**
- The 10호가/거래원/체결 data-missing bug — still deferred to `superpowers:systematic-debugging`.
- Cross-tab storage event listener — explicitly deferred per spec.
