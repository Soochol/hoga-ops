# Live Tab → Page Projection Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "the active Live Tab's view-state IS the page's view-state" a single deep, tested seam — replace the order-dependent 3-setter `applyTabToPage` + the defensive `applyingTab` module guard with one atomic `projectActiveView` write.

**Architecture:** Today `applyTabToPage(tab)` pushes a tab onto `useLivePageStore` by calling `setActiveCode` → `setCandleTimeframe` → `extendHistoricalRange` in an exact order, because the first two silently reset `historicalFromDate` to `null` (livePage.ts:283,289) and the third must run last to restore it. That ordering invariant is undocumented-in-code-except-a-comment and **untested** (a setter reorder corrupts pan silently with green tests). A module-global `applyingTab` flag exists only to suppress the 2–3 redundant tab-array rewrites those intermediate setter-fires would trigger in the page→tab mirror; its own comment certifies it is "NOT loop-prevention" and "not required for correctness". We add one atomic `projectActiveView({code, timeframe, historicalFromDate})` setter to the page store (one `set`, one `persist`, no resets to survive), point `applyTabToPage` at it, and then **delete the guard** — because a single atomic write makes the mirror fire at most once, idempotently (it writes the active tab's own values back into the active tab). Net: the ordering footgun cannot exist, the defensive flag dissolves, and the projection gets a direct test.

**Tech Stack:** TypeScript, Zustand (`create`), Vitest + jsdom. No new dependencies.

**Invariants preserved (ADR-0052 / ADR-0069 — do NOT change):** `useLivePageStore.activeCode` stays a *stored* value (not derived); the active tab remains its single writer (via `applyTabToPage` → `projectActiveView`). This plan hides the sync *mechanism*; it does not touch the storage or single-writer decisions.

**Out of this plan's scope:** the `drawings` store's independent `setActiveCode` mirror (`useDrawingHost.ts:64`) — a differently-shaped satellite, tracked as a separate candidate. Do not touch it here.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `frontend/src/state/livePage.ts` | Modify | Add `ActiveViewProjection` type + `projectActiveView` atomic setter. The individual `setActiveCode`/`setCandleTimeframe`/`extendHistoricalRange` setters STAY (still used by the toolbar/pan/search/tests). |
| `frontend/src/state/liveTabs.ts` | Modify | Rewrite `applyTabToPage` to call `projectActiveView`; delete `applyingTab` + `setApplyingTab` + their comment; remove the `if (applyingTab) return;` line in the `initLiveTabsSync` mirror. |
| `frontend/src/state/livePage.test.ts` | Modify | Unit tests for `projectActiveView` (atomic set, persist, invalid-tf fallback). |
| `frontend/src/state/liveTabs.test.ts` | Modify | Tests: pan survives projection (ordering-independence), mirror still works after guard removal, tab-switch stays idempotent. |

**Commit-hook note (this repo):** A commit hook flags `&&`-chained or heredoc `git commit`. Run `git add` and `git commit` as **separate** Bash invocations. If a `git commit -m "..."` is still blocked, write the message to a file and use `git commit -F <file>` (see memory `hoga-ops-block-no-verify-commit-hook`). End commit bodies with the project trailer if your tooling requires it.

---

### Task 1: Add the atomic `projectActiveView` setter to the page store

**Files:**
- Modify: `frontend/src/state/livePage.ts` (type `Store` ~line 105-119; setters block ~line 282-303)
- Test: `frontend/src/state/livePage.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/state/livePage.test.ts` (inside the existing top-level `describe`, after the `setActiveCode` test):

```ts
  it('projectActiveView sets code + timeframe + historicalFromDate atomically and persists', () => {
    useLivePageStore.getState().projectActiveView({
      code: '005930', timeframe: '5m', historicalFromDate: '20260601',
    });
    const s = useLivePageStore.getState();
    expect(s.activeCode).toBe('005930');
    expect(s.candleTimeframe).toBe('5m');
    expect(s.historicalFromDate).toBe('20260601');
    // persisted under the page storage key (same key the other setters use)
    const raw = JSON.parse(localStorage.getItem('live.page.v1') ?? '{}');
    expect(raw.activeCode).toBe('005930');
    expect(raw.candleTimeframe).toBe('5m');
    expect(raw.historicalFromDate).toBe('20260601');
  });

  it('projectActiveView with a null pan clears historicalFromDate (no leftover from a prior code)', () => {
    useLivePageStore.getState().projectActiveView({ code: 'A', timeframe: '1m', historicalFromDate: '20260101' });
    useLivePageStore.getState().projectActiveView({ code: 'B', timeframe: '1m', historicalFromDate: null });
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('projectActiveView falls back to the current timeframe when given an invalid one', () => {
    useLivePageStore.getState().setCandleTimeframe('5m');
    // @ts-expect-error — deliberately invalid timeframe to test the clamp
    useLivePageStore.getState().projectActiveView({ code: 'A', timeframe: 'NOPE', historicalFromDate: null });
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(useLivePageStore.getState().activeCode).toBe('A');
  });
```

Confirm the test file resets state per test. If the existing `beforeEach` does not clear `localStorage` + reset the store, add at the top of the file's `beforeEach`:

```ts
  localStorage.clear();
  useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/state/livePage.test.ts`
Expected: FAIL — `projectActiveView is not a function`.

- [ ] **Step 3: Add the type and the setter**

In `frontend/src/state/livePage.ts`, export a projection type near the top-level types (just above the `type Store = ...` block at line 105):

```ts
/** The full active-view tuple the page renders. Written atomically by the active
 *  Live Tab (applyTabToPage → projectActiveView) so there is no setter ordering to
 *  get wrong (setActiveCode/setCandleTimeframe each reset historicalFromDate; an
 *  atomic write has nothing to reset-then-restore). */
export type ActiveViewProjection = {
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
};
```

Add to the `Store` type (line 105-119 block), next to the other setters:

```ts
  projectActiveView: (view: ActiveViewProjection) => void;
```

Add the implementation in the setters block (place it directly above `setActiveCode` at line 282):

```ts
  projectActiveView: ({ code, timeframe, historicalFromDate }) => {
    // One atomic write — no reset-then-restore. tf is clamped like setCandleTimeframe
    // (belt-and-suspenders; tabs already carry validated timeframes).
    const tf = LIVE_TIMEFRAMES.includes(timeframe) ? timeframe : get().candleTimeframe;
    const next = { activeCode: code, candleTimeframe: tf, historicalFromDate };
    set(next);
    persist({ ...get(), ...next });
  },
```

(`LIVE_TIMEFRAMES` is already imported/used by `setCandleTimeframe` at line 288 — no new import.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/state/livePage.test.ts`
Expected: PASS (all `projectActiveView` tests green; pre-existing tests unaffected).

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/state/livePage.ts src/state/livePage.test.ts
```
```bash
git commit -m "feat(live): add atomic projectActiveView setter to page store"
```

---

### Task 2: Point `applyTabToPage` at the atomic write and delete the `applyingTab` guard

**Why these two changes are one task:** the guard suppressed the 2–3 mirror fires the OLD 3-setter `applyTabToPage` caused. The atomic `projectActiveView` is a SINGLE `set`, so the mirror fires at most once — and idempotently, because `activeTabId` is already the tab being projected, so the mirror writes that tab's own `timeframe`/`historicalFromDate` back into itself. Removing the guard is only safe **after** the atomic rewrite. Do them together.

**Files:**
- Modify: `frontend/src/state/liveTabs.ts` (guard + comment lines 32-42; `applyTabToPage` lines 44-58; mirror line 221)
- Test: `frontend/src/state/liveTabs.test.ts`

- [ ] **Step 1: Write the failing/guarding tests**

Add to `frontend/src/state/liveTabs.test.ts`. Put the first test in the `describe('useLiveTabsStore', ...)` block (it uses the file's existing `openTab` helper + `beforeEach` reset):

```ts
  it('switching to a tab projects its code+timeframe+pan onto the page in one shot (pan survives)', () => {
    openTab('005930', '삼성전자');
    // give the active tab a non-default timeframe + pan, then switch away and back
    useLiveTabsStore.setState((st) => ({
      tabs: st.tabs.map((t) => (t.id === st.activeTabId ? { ...t, timeframe: '5m', historicalFromDate: '20260601' } : t)),
    }));
    const tabA = useLiveTabsStore.getState().activeTabId!;
    openTab('000660', 'SK하이닉스'); // switch to B
    useLiveTabsStore.getState().focusTab(tabA); // back to A
    const page = useLivePageStore.getState();
    expect(page.activeCode).toBe('005930');
    expect(page.candleTimeframe).toBe('5m');
    expect(page.historicalFromDate).toBe('20260601'); // pan survived the projection (no reset leak)
  });
```

Add the second test in the `describe('liveTabs ↔ page mirror', ...)` block (it runs with `initLiveTabsSync` active, like its siblings):

```ts
  it('projecting a tab is idempotent on the active tab and does not churn its fields (mirror works without the guard)', () => {
    openTab('005930', '삼성전자');
    useLivePageStore.getState().setCandleTimeframe('5m'); // mirror → tab A.timeframe = 5m
    const before = useLiveTabsStore.getState().tabs[0];
    useLiveTabsStore.getState().focusTab(before.id); // re-project the SAME active tab
    const after = useLiveTabsStore.getState().tabs[0];
    expect(after.timeframe).toBe('5m');               // unchanged
    expect(after.historicalFromDate).toBe(before.historicalFromDate);
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
  });
```

- [ ] **Step 2: Run the tests to verify the first fails (or both pass pre-change, which is fine)**

Run: `cd frontend && npx vitest run src/state/liveTabs.test.ts`
Expected: the new "pan survives" test PASSES even today (current code already restores pan via the ordered setters); the idempotence test PASSES today too. These are **regression guards** for the refactor — they lock in behavior BEFORE you change the implementation. If either fails now, stop and investigate before refactoring.

- [ ] **Step 3: Delete the guard and its comment**

In `frontend/src/state/liveTabs.ts`, delete lines 32-42 (the `// Module guard:` comment block, `let applyingTab = false;`, and `function setApplyingTab(v: boolean): void { applyingTab = v; }`).

- [ ] **Step 4: Rewrite `applyTabToPage` to use the atomic write**

Replace the entire `applyTabToPage` function (currently lines 44-58) with:

```ts
/** Project the active Live Tab's view-state onto the page in one atomic write.
 *  The active tab is the single writer of useLivePageStore.activeCode (ADR-0052/0069);
 *  projectActiveView sets code+timeframe+pan together so there is no setter ordering
 *  to get wrong. tab=null (last tab closed) clears the code and pan, keeping the
 *  current timeframe. */
export function applyTabToPage(tab: LiveTab | null): void {
  const page = useLivePageStore.getState();
  page.projectActiveView({
    code: tab?.code ?? null,
    timeframe: tab?.timeframe ?? page.candleTimeframe,
    historicalFromDate: tab?.historicalFromDate ?? null,
  });
}
```

Add the import for the type at the top of `liveTabs.ts` — change the existing livePage import (line 3) to include `ActiveViewProjection` is NOT required (we don't reference the type name here), so leave imports as-is. Verify `useLivePageStore` is already imported (it is, line 3).

- [ ] **Step 5: Remove the guard check in the mirror**

In `initLiveTabsSync`, delete the line `if (applyingTab) return;` (currently line 221). Update the adjacent comment block (lines 216-219) so it no longer references the guard:

```ts
  // page→tab mirror: user-initiated tf/pan changes flow into the active tab.
  // The early-return on unchanged tf+hfd skips indicator-only page changes
  // (MA/volume toggles fire this unselectored subscribe) AND makes the projection's
  // own atomic write a no-op here when the active tab already holds those values.
  const unsubMirror = useLivePageStore.subscribe((state, prev) => {
    if (state.candleTimeframe === prev.candleTimeframe && state.historicalFromDate === prev.historicalFromDate) return;
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    if (!activeTabId) return;
    useLiveTabsStore.setState({
      tabs: tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, timeframe: state.candleTimeframe, historicalFromDate: state.historicalFromDate }
          : t,
      ),
    });
  });
```

- [ ] **Step 6: Run the liveTabs tests**

Run: `cd frontend && npx vitest run src/state/liveTabs.test.ts`
Expected: PASS — all existing tests (mirror, switching, persistence, idempotence) plus the two new guard tests. The mirror tests prove the page→tab sync still works without the guard.

- [ ] **Step 7: Typecheck (catches the now-unused guard removal)**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Expected: exit 0. If it reports `applyingTab`/`setApplyingTab` is undefined somewhere, you missed a reference — grep `grep -n "applyingTab\|setApplyingTab" src/state/liveTabs.ts` should return nothing.

- [ ] **Step 8: Commit**

```bash
cd frontend && git add src/state/liveTabs.ts src/state/liveTabs.test.ts
```
```bash
git commit -m "refactor(live): project active tab via atomic write, drop applyingTab guard"
```

---

### Task 3: Full-suite + build regression gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: all test files pass (baseline before this plan: 202 files / 1745 tests). Pay special attention to: `src/state/liveTabs.test.ts`, `src/state/livePage.test.ts`, `src/live/LivePage.test.tsx`, and any test that previously relied on the mirror behavior. Zero failures.

- [ ] **Step 2: Production build**

Run: `cd frontend && npm run build`
Expected: `tsc -b` + `vite build` succeed (the pre-existing >500kB chunk-size warning is unrelated and acceptable).

- [ ] **Step 3: Browser smoke (mechanism changed in the hot path)**

The projection now runs on every tab switch / watchlist click. Verify in-browser per `CLAUDE.md` (use `/browse`, set up the worktree vite proxy per memory `hoga-ops-worktree-browser-verify-cors`): load `/live`, click two different watchlist rows, switch tabs, change the timeframe on one tab and confirm it restores when you switch back. Expected: no console errors; each tab restores its own code + timeframe + pan. Revert the temp proxy/config edits afterward.

- [ ] **Step 4: Commit (if Step 3 required any doc note)**

If the browser smoke surfaced nothing, no commit is needed here. If you updated a doc comment, commit it:

```bash
cd frontend && git add -A
```
```bash
git commit -m "docs(live): note atomic projection in tab-sync comments"
```

---

## NOT in scope (deferred, with rationale)

- **Extracting the projection into its own module file** (`liveTabProjection.ts`): `applyTabToPage` + the mirror already co-habit `liveTabs.ts` (its natural home); a new file risks a `liveTabs ↔ livePage` import cycle for no locality gain beyond what the atomic write + test already buy. Deferred unless `liveTabs.ts` grows unwieldy.
- **The `drawings` store's `setActiveCode` satellite mirror** (`useDrawingHost.ts:64`): a differently-shaped second mirror of `activeCode`. Consolidating the two mirrors is a separate candidate ("name the per-Code satellite-mirror pattern") and may be over-abstraction — out of scope here.
- **Deriving `activeCode`** instead of storing it: rejected by ADR-0052/0069 (15 read sites + invariant change). Not reopened.

## Failure modes (per new codepath)

- **`projectActiveView` forgets/ misorders a field** → page renders a stale view. *Covered:* Task 1's atomic-set test asserts all three fields; there is no order to misorder. User would see the wrong chart (not silent in tests).
- **Mirror feedback loop after guard removal** → infinite re-render. *Cannot occur:* the mirror writes to `useLiveTabsStore`, which does not trigger `useLivePageStore.subscribe` (store separation — the guard's own comment certified this). *Covered:* Task 2 idempotence test + full-suite gate.
- **Redundant tab-array churn** (the thing the guard suppressed) → extra tab-bar re-render per projection. *Acceptable:* atomic write reduces it to at most one idempotent re-render; not user-visible.

## Self-Review

1. **Spec coverage:** atomic write (Task 1) ✓ · `applyTabToPage` rewrite (Task 2 Step 4) ✓ · guard deletion (Task 2 Steps 3,5) ✓ · projection test (Task 1 + Task 2 Step 1) ✓ · regression gate (Task 3) ✓ · ADR invariants preserved (header + NOT-in-scope) ✓.
2. **Placeholder scan:** no TBD/TODO; every code step shows full code; commands have expected output. ✓
3. **Type consistency:** `ActiveViewProjection {code, timeframe, historicalFromDate}` defined in Task 1 and consumed by `applyTabToPage` in Task 2 with matching field names; `projectActiveView` signature identical in both. ✓
