# Force-Retry Capture Default in Settings

**Date:** 2026-05-23
**Status:** Design approved, ready for implementation plan
**Scope:** Frontend — add a persisted default for the "⚠ Force re-capture source-partial dates" toggle in the Settings page, and have `CaptureForm` initialize its local `forceRetry` from that default.

## Problem

Today the "⚠ Force re-capture source-partial dates" checkbox in `frontend/src/capture/CaptureForm.tsx:83` is per-capture local state initialized to `false`. After every successful enqueue the form resets it back to `false`. A user who *always* wants force-retry must tick the box on every single capture — a sharp edge.

This spec adds a persisted default in the global **Settings page** (`frontend/src/pages/Settings.tsx`). The `CaptureForm` checkbox stays — but its initial value, and the post-success reset value, come from the persisted default.

## Goal

- A persisted "Force re-capture source-partial dates by default" toggle in Settings page.
- `CaptureForm`'s `forceRetry` initializes from the persisted default on mount; reset-after-success returns to the default (not unconditionally to `false`).
- Storage: browser `localStorage`. No server roundtrip.
- Both UI surfaces (Settings toggle + CaptureForm checkbox) reflect the same key consistently.

## Non-Goals

- A per-symbol or per-day override. The default is global per browser profile.
- Migrating *other* CaptureForm options (e.g. range) into Settings. Force-retry only.
- Server-side persistence. localStorage is sufficient for v1.
- Real-time sync between tabs (Settings change does not propagate to a `CaptureForm` already mounted in another tab). A future `storage` event listener could add this if needed — out of scope.

## Architecture

```
                          ┌─────────────────────────────────────┐
                          │   localStorage                       │
                          │   key: 'capture.force_retry_default' │
                          │   value: 'true' | 'false'            │
                          └─────────────────────────────────────┘
                                  ▲                ▲
                  saveForceRetry  │                │  loadForceRetry
                       Default()  │                │  Default()
                                  │                │
              ┌───────────────────┴───┐    ┌──────┴──────────────────┐
              │ Settings page          │    │ CaptureForm              │
              │ "Capture defaults"     │    │ initial useState +       │
              │ section toggle         │    │ post-success reset       │
              └────────────────────────┘    └─────────────────────────┘
```

Both consumers go through a small helper module — `frontend/src/capture/forceRetryDefault.ts` — that owns the key string and the localStorage I/O. This keeps the key out of two call sites and makes the storage shape testable in isolation.

## Component Changes

### New: `frontend/src/capture/forceRetryDefault.ts`

A tiny helper with two functions and a sentinel key. Mirrors the `STORAGE_KEY` pattern in `frontend/src/pages/Capture.tsx:12` (which already uses inline localStorage for the split-pane percentage).

```typescript
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

Notes:
- The default for an unset key is `false`. Reading `null` does NOT equal `'true'`, so the function returns `false` — matching the current hardcoded `useState(false)` behaviour.
- The `try/catch` mirrors `Capture.tsx`'s defensive pattern (Safari private mode rejects setItem). The codebase's only other localStorage helper does this; we follow the same pattern.

### Modified: `frontend/src/pages/Settings.tsx`

Add a new `CaptureDefaultsSection` between `SymbolMasterSection` and the v1+1 footer:

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

The label string mirrors `CaptureForm.tsx:83` so the two surfaces use identical phrasing.

### Modified: `frontend/src/capture/CaptureForm.tsx`

Two single-line changes:

1. `useState(false)` (line 19) → `useState<boolean>(() => loadForceRetryDefault())`.
2. `setForceRetry(false)` in the `onSuccess` block (line 41) → `setForceRetry(loadForceRetryDefault())`.

Why call `loadForceRetryDefault()` again on reset rather than caching it? Two reasons:
- The user can change the Settings default while the form is open. Re-reading on reset picks up the change for the next capture.
- The function is a `localStorage.getItem` call — negligible cost.

No other edits in this file. The checkbox stays. The label stays. The `force_retry` field in the POST body still reads from local state.

## Tests

### New: `frontend/src/capture/forceRetryDefault.test.ts`

Three cases:
1. `loadForceRetryDefault` returns `false` when key absent.
2. `saveForceRetryDefault(true)` round-trips through `loadForceRetryDefault`.
3. `loadForceRetryDefault` returns `false` when localStorage throws (mock `getItem` to throw).

### Modified: `frontend/src/pages/Settings.test.tsx`

Two new cases inside the existing `describe`:
4. "Capture defaults checkbox reflects the persisted value on mount" — pre-seed localStorage to `'true'`, render, assert `data-testid="settings-force-retry-default"` is checked.
5. "Clicking the checkbox writes through to localStorage" — render with default, click, assert localStorage now has `'true'` and the checkbox state updated.

Each test clears `localStorage` in `beforeEach` to avoid leakage between cases.

### Modified: `frontend/src/capture/CaptureForm.test.tsx`

One new case in the existing `describe('CaptureForm', ...)`:
6. "Force re-capture initializes from localStorage default" — pre-seed `localStorage.setItem('capture.force_retry_default', 'true')`, mount the form, assert the checkbox is checked before any user interaction.

The existing test at line 70 (which clicks the checkbox to toggle `true`) does not need to change — the click still toggles regardless of the initial value.

Additionally, the existing "form resets after a successful Start" test should assert that the checkbox reset value matches the localStorage default. If the test currently asserts the box is unchecked after submit, that's still true under default `false`. If we want to make this airtight, add an extension to that test with the default set to `true` and assert the box returns to checked, not unchecked.

## Risks & Mitigation

- **Privacy mode / SSR**: `localStorage` access is wrapped in `try/catch`. Read failures return `false` (matching the prior default); write failures are silent. The behaviour degrades to the previous hardcoded default — no breakage.
- **Tab synchronization**: A user with two browser tabs open (Settings tab + Capture tab) won't see a Settings toggle change reflected in an already-mounted CaptureForm until they re-mount or refresh. Acceptable for v1. If it becomes a paper cut, add a `window.addEventListener('storage', ...)` in `CaptureForm` to re-read on cross-tab events.
- **Test pollution**: Both modified test files now read/write `localStorage`. Each test file already isolates state per `it`; we add `localStorage.clear()` to the existing `beforeEach` hooks so a forgotten setItem in one test does not affect the next.
- **Visual prominence**: The "⚠" prefix is preserved — this option re-captures already-collected partial data which has rate-limit / data-budget implications. The warning glyph should not be dropped from either surface.

## Rollout

Single PR. Spec → plan → execute via subagent-driven-development on this same worktree. No coordination with backend or other agents required.

## Out of Scope (별도 작업)

- The 10호가/거래원/체결 data-missing bug — still pending under `superpowers:systematic-debugging`.
- Adding additional capture-form options (rate-limit override, max-pages cap, etc.) to Settings. If new options surface, the `CaptureDefaultsSection` is the natural home and the `forceRetryDefault.ts` pattern scales.
