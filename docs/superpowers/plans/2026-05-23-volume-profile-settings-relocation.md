# Volume Profile Settings Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 전체/일별 Volume Profile mode toggle from `CursorSidebar`'s header slot into `SettingsModal`'s "차트" category, and drop the now-empty header slot from the sidebar.

**Architecture:** Pure UI-surface relocation. The `useTabsStore` slice (`volumeProfileMode`, `setVolumeProfileMode`, `DEFAULT_PREFS`) and the `VolumeProfileOverlay` consumer are NOT touched. We add a `VolumeProfileModeRow` segmented control inside `SettingsModal.tsx`, remove the `VolumeProfileModeToggle` and `header` prop from `CursorSidebar.tsx`, and adjust two test files.

**Tech Stack:** React 18, Zustand, TypeScript, Vitest + Testing Library, Tailwind.

**Spec:** `docs/superpowers/specs/2026-05-23-volume-profile-settings-relocation-design.md`

---

## File Structure

**Modify (two source files):**
- `frontend/src/replay/SettingsModal.tsx` — add `VolumeProfileModeRow` (inline component) and render it inside the "차트" category body, below the `CHART_TOGGLES.map(...)` block.
- `frontend/src/sidebar/CursorSidebar.tsx` — delete `VolumeProfileModeToggle` function, drop `header?` prop from dumb `CursorSidebar`, remove `header={...}` from `CursorSidebarConnected`, simplify grid to single 3-row variant, prune unused `useTabsStore` import.

**Modify (two test files):**
- `frontend/src/replay/SettingsModal.test.tsx` — add 2 cases for the new Volume Profile segment control.
- `frontend/tests/component/CursorSidebar.test.tsx` — add 1 regression case asserting the header row is absent.

**No new files.** Both changes live in the existing component files to mirror the `ToggleRow` / `MovingAverageRow` pattern already established in the codebase.

---

## Test Invocation Reference

Both test files run under Vitest in `frontend/`:

```bash
cd frontend && npx vitest run src/replay/SettingsModal.test.tsx
cd frontend && npx vitest run tests/component/CursorSidebar.test.tsx
```

Full file-scoped runs only — single-test `-t` filters work too but file scope is fine and matches existing patterns.

---

## Task 1: Add `VolumeProfileModeRow` to `SettingsModal`

**Files:**
- Modify: `frontend/src/replay/SettingsModal.tsx`
- Test: `frontend/src/replay/SettingsModal.test.tsx`

This task adds the new control. The old sidebar toggle still exists; we remove it in Task 2. This ordering ensures a working state at every step.

- [ ] **Step 1.1: Write the first failing test — segment reflects current `volumeProfileMode`**

Append this case to `frontend/src/replay/SettingsModal.test.tsx` (inside the existing `describe('SettingsModal', ...)` block, after the final `it(...)`):

```typescript
  it('Volume Profile segment reflects current prefs.volumeProfileMode via aria-pressed', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    const seg = screen.getByTestId('settings-volume-profile-mode');
    const fullBtn = seg.querySelector('button[aria-label="전체"]') as HTMLButtonElement;
    const perDayBtn = seg.querySelector('button[aria-label="일별"]') as HTMLButtonElement;
    expect(fullBtn.getAttribute('aria-pressed')).toBe('true');
    expect(perDayBtn.getAttribute('aria-pressed')).toBe('false');
  });
```

- [ ] **Step 1.2: Run the test, verify it fails**

```bash
cd frontend && npx vitest run src/replay/SettingsModal.test.tsx -t "Volume Profile segment reflects"
```

Expected: FAIL — `Unable to find an element by: [data-testid="settings-volume-profile-mode"]`.

- [ ] **Step 1.3: Write the second failing test — segment click calls `setVolumeProfileMode`**

Append immediately after the previous test:

```typescript
  it('Volume Profile segment click writes per-day to the store and updates aria-pressed', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    const seg = screen.getByTestId('settings-volume-profile-mode');
    const perDayBtn = seg.querySelector('button[aria-label="일별"]') as HTMLButtonElement;
    fireEvent.click(perDayBtn);

    const activeId = useTabsStore.getState().activeTabId;
    expect(useTabsStore.getState().getPrefs(activeId).volumeProfileMode).toBe('per-day');

    const segAfter = screen.getByTestId('settings-volume-profile-mode');
    expect(segAfter.querySelector('button[aria-label="일별"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(segAfter.querySelector('button[aria-label="전체"]')!.getAttribute('aria-pressed')).toBe('false');
  });
```

- [ ] **Step 1.4: Run both new tests, verify they fail**

```bash
cd frontend && npx vitest run src/replay/SettingsModal.test.tsx -t "Volume Profile"
```

Expected: BOTH FAIL with `Unable to find an element by: [data-testid="settings-volume-profile-mode"]`.

- [ ] **Step 1.5: Implement `VolumeProfileModeRow` in `SettingsModal.tsx`**

Open `frontend/src/replay/SettingsModal.tsx`. Add the new component above the existing `export default function SettingsModal(...)` (i.e., after `ToggleRow`'s closing brace on line 52, before line 54's documentation comment).

```typescript
/** Segmented control row for the per-tab `volumeProfileMode` preference.
 *  Visually parallels `ToggleRow` (left label + right control). The two
 *  buttons render as a small inline segment — same active/inactive token
 *  pair previously used by the sidebar VolumeProfileModeToggle. */
function VolumeProfileModeRow() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const mode = useTabsStore((s) => s.getPrefs(activeTabId).volumeProfileMode);
  const setMode = useTabsStore((s) => s.setVolumeProfileMode);
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">Volume Profile</div>
        <div className="text-fg-dim text-xs mt-0.5">전체 기간 합산 / 날짜별 분리</div>
      </div>
      <div
        role="group"
        aria-label="Volume Profile"
        data-testid="settings-volume-profile-mode"
        className="flex items-center gap-1 text-xs"
      >
        {(['range', 'per-day'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-label={m === 'range' ? '전체' : '일별'}
            aria-pressed={mode === m}
            onClick={() => {
              if (mode !== m) setMode(activeTabId, m);
            }}
            className={
              mode === m
                ? 'px-2 py-0.5 bg-accent text-accent-fg rounded'
                : 'px-2 py-0.5 text-fg-dim hover:text-fg'
            }
          >
            {m === 'range' ? '전체' : '일별'}
          </button>
        ))}
      </div>
    </div>
  );
}
```

Then mount it inside the "차트" category body. Find the existing block (around line 132–150):

```typescript
{category === 'chart' && (
  <>
    <h3 className="text-fg text-base font-medium pb-2 mb-2 border-b border-border">
      차트
    </h3>
    {CHART_TOGGLES.map((toggle) => {
      const key: ChartToggleKey = toggle.key;
      return (
        <ToggleRow
          key={key}
          label={toggle.label}
          description={toggle.description}
          checked={prefs[key]}
          onToggle={() => setToggle(activeTabId, key, !prefs[key])}
        />
      );
    })}
  </>
)}
```

Replace it with:

```typescript
{category === 'chart' && (
  <>
    <h3 className="text-fg text-base font-medium pb-2 mb-2 border-b border-border">
      차트
    </h3>
    {CHART_TOGGLES.map((toggle) => {
      const key: ChartToggleKey = toggle.key;
      return (
        <ToggleRow
          key={key}
          label={toggle.label}
          description={toggle.description}
          checked={prefs[key]}
          onToggle={() => setToggle(activeTabId, key, !prefs[key])}
        />
      );
    })}
    <VolumeProfileModeRow />
  </>
)}
```

No other edits in this file.

- [ ] **Step 1.6: Run the Volume Profile tests, verify they pass**

```bash
cd frontend && npx vitest run src/replay/SettingsModal.test.tsx -t "Volume Profile"
```

Expected: BOTH PASS.

- [ ] **Step 1.7: Run the whole SettingsModal test file, verify nothing else broke**

```bash
cd frontend && npx vitest run src/replay/SettingsModal.test.tsx
```

Expected: ALL PASS (the 7 pre-existing tests + the 2 new ones).

- [ ] **Step 1.8: Commit**

```bash
git add frontend/src/replay/SettingsModal.tsx frontend/src/replay/SettingsModal.test.tsx
git commit -m "$(cat <<'EOF'
feat(replay/Settings): add Volume Profile mode segment under 차트 category

Adds a small inline VolumeProfileModeRow that mirrors the existing
ToggleRow pattern (left label + right control) and writes through
useTabsStore.setVolumeProfileMode. The sidebar's VolumeProfileModeToggle
is removed in the follow-up commit; both controls coexist briefly so each
commit leaves the repo in a working state.

testid: settings-volume-profile-mode (Settings-scoped, control-shape
neutral, per the spec's grilling notes).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Remove `VolumeProfileModeToggle` from `CursorSidebar`

**Files:**
- Modify: `frontend/src/sidebar/CursorSidebar.tsx`
- Test: `frontend/tests/component/CursorSidebar.test.tsx`

- [ ] **Step 2.1: Write the failing regression test**

Open `frontend/tests/component/CursorSidebar.test.tsx`. Append a new case inside the existing `describe('CursorSidebar', ...)` block (after the `'renders injected children…'` test):

```typescript
  it('renders without a Volume Profile mode toggle (header row removed)', () => {
    render(<CursorSidebar />);
    // The old sidebar header hosted a VolumeProfileModeToggle keyed by this
    // testid. After the relocation it lives in SettingsModal; assert the
    // sidebar never re-introduces it. (Spec §"Tests / 신규 케이스 3".)
    expect(screen.queryByTestId('volume-profile-mode-toggle')).toBeNull();
  });
```

- [ ] **Step 2.2: Run the test, verify it fails**

```bash
cd frontend && npx vitest run tests/component/CursorSidebar.test.tsx -t "header row removed"
```

Expected: FAIL — `expect(received).toBeNull()` because `<CursorSidebar />` (the dumb default export) does NOT currently render the toggle on its own (the toggle is mounted by `CursorSidebarConnected`).

**Wait — re-read the test:** the dumb default export takes the toggle through `header` prop; without it, the toggle isn't rendered. So this test would already pass against `master`. That's incorrect for TDD purposes.

Adjust: the regression we want to lock in is that `CursorSidebarConnected` (which has the toggle today) no longer renders it after Task 2 lands. Replace the case body:

```typescript
  it('CursorSidebarConnected renders without a Volume Profile mode toggle', async () => {
    const { CursorSidebarConnected } = await import('../../src/sidebar/CursorSidebar');
    render(<CursorSidebarConnected />);
    expect(screen.queryByTestId('volume-profile-mode-toggle')).toBeNull();
  });
```

And add the import at the top if not already present — only the dynamic import inside the test is needed (keeps the existing default-export import unchanged).

- [ ] **Step 2.3: Run the test, verify it FAILS (this time meaningfully)**

```bash
cd frontend && npx vitest run tests/component/CursorSidebar.test.tsx -t "CursorSidebarConnected renders without"
```

Expected: FAIL — `expect(received).toBeNull()` because `CursorSidebarConnected` currently mounts `<VolumeProfileModeToggle />` with `data-testid="volume-profile-mode-toggle"`.

If the test passes here, **stop** — the assertion isn't proving what we think. Re-check that `CursorSidebarConnected` is the imported symbol and that the testid string matches what's in `CursorSidebar.tsx` today.

- [ ] **Step 2.4: Delete `VolumeProfileModeToggle` and the `header` slot from `CursorSidebar.tsx`**

Open `frontend/src/sidebar/CursorSidebar.tsx`. Make four edits:

**(a) Remove the `useTabsStore` import on line 10** — after this change the file no longer references the store. Drop the line:

```typescript
import { useTabsStore } from '../state/tabs';
```

**(b) Replace the `Props` type (lines 12–18) with the slim version:**

```typescript
type Props = {
  orderbook?: ReactNode;
  brokers?: ReactNode;
  fills?: ReactNode;
};
```

**(c) Replace the entire `CursorSidebarConnected` function (lines 20–40), the `VolumeProfileModeToggle` function (lines 42–71), and the dumb `CursorSidebar` default export header (line 73)** with the version below. This rewrites lines 20 through 94 of the original file.

```typescript
/**
 * Connected variant that pulls live cursor-keyed data from `useCursor` and
 * renders the 3 sidebar cards. Used by ReplayViewer; the dumb
 * `CursorSidebar` below remains exported for testability.
 *
 * The per-tab `volumeProfileMode` toggle previously lived in this
 * sidebar's header slot — it was relocated to the Settings modal's "차트"
 * category by the 2026-05-23 Volume Profile Settings Relocation work.
 */
export function CursorSidebarConnected() {
  const orderbook = useOrderbookAtCursor();
  const brokers = useBrokersAtCursor();
  const trades = useTradesAroundCursor();
  return (
    <CursorSidebar
      orderbook={<OrderbookTable snapshot={orderbook} />}
      brokers={<BrokerNetTable brokers={brokers} />}
      fills={<FillTape trades={trades} />}
    />
  );
}

export default function CursorSidebar({ orderbook, brokers, fills }: Props) {
  return (
    <aside className="grid grid-rows-[2fr_1fr_1fr] gap-2 p-2 bg-bg w-sidebar h-full min-h-0">
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="거래원" testId="card-brokers">
        {brokers ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="체결" testId="card-fills">
        {fills ?? <Placeholder />}
      </SidebarCard>
    </aside>
  );
}
```

**(d) Confirm the helper functions below are untouched** — `SidebarCard` (lines 96–117) and `Placeholder` (lines 119–121) remain exactly as they were.

After this edit, the file's structure should be:
1. Imports (no `useTabsStore`).
2. `Props` type — three optional ReactNode fields.
3. `CursorSidebarConnected` function.
4. Default `CursorSidebar` function.
5. `SidebarCard` helper.
6. `Placeholder` helper.

- [ ] **Step 2.5: Run the regression test, verify it passes**

```bash
cd frontend && npx vitest run tests/component/CursorSidebar.test.tsx -t "CursorSidebarConnected renders without"
```

Expected: PASS.

- [ ] **Step 2.6: Run the full `CursorSidebar.test.tsx`, verify the two pre-existing cases still pass**

```bash
cd frontend && npx vitest run tests/component/CursorSidebar.test.tsx
```

Expected: ALL PASS (the 2 pre-existing tests + the 1 new regression test).

- [ ] **Step 2.7: Run the broader frontend test suite to catch any unforeseen consumer**

```bash
cd frontend && npx vitest run
```

Expected: ALL PASS. The store/overlay slice is untouched, so `tabs.test.ts` and `VolumeProfileOverlay.test.tsx` must remain green. `Workarea.test.tsx` mocks `CursorSidebar` so it should not care either.

If a test outside the two we touched fails, **stop and read the failure**. The most likely culprit is a stale reference to `header` in a test snapshot or in a comment-driven test name; fix in-place but flag in the commit message.

- [ ] **Step 2.8: TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors. `useTabsStore` was the only sidebar consumer of the store; its removal must leave the rest of `CursorSidebar.tsx` clean.

- [ ] **Step 2.9: Commit**

```bash
git add frontend/src/sidebar/CursorSidebar.tsx frontend/tests/component/CursorSidebar.test.tsx
git commit -m "$(cat <<'EOF'
refactor(sidebar): drop Volume Profile mode toggle + header slot

The 전체/일별 segment moved to SettingsModal's "차트" category in the
prior commit. Remove the inline VolumeProfileModeToggle, the `header`
prop on the dumb CursorSidebar, and the now-unused useTabsStore import.
Grid simplifies to a single 3-row variant.

Regression: CursorSidebar.test.tsx asserts CursorSidebarConnected no
longer renders [data-testid="volume-profile-mode-toggle"], so future
edits cannot silently re-mount the sidebar toggle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: End-to-end verification

**Files:** None modified.

This task confirms the integration works in a running app. No commit is produced unless a follow-up edit becomes necessary.

- [ ] **Step 3.1: Run the dev server**

```bash
cd frontend && npm run dev
```

Note the printed URL (typically `http://localhost:5173`).

- [ ] **Step 3.2: Open the replay page**

Navigate to `<URL>/replay` in a browser. Confirm:

1. The right-hand sidebar shows **only** the three cards (10호가 / 거래원 / 체결) — no row above them.
2. The cards' relative heights match the previous layout (top card taller than the other two — `2fr 1fr 1fr`).

- [ ] **Step 3.3: Open the Settings modal, confirm the new control**

Click the gear icon (or whichever opens Settings on this page). In the "차트" category body, scroll to the bottom. Confirm:

1. A row labeled "Volume Profile" appears below the last `CHART_TOGGLES` row.
2. The sub-text reads "전체 기간 합산 / 날짜별 분리".
3. The right side shows two buttons "전체 | 일별". "전체" is active by default (filled accent background).

- [ ] **Step 3.4: Toggle the segment, confirm the chart reacts**

Click "일별". Confirm:

1. The active button immediately switches to "일별".
2. The chart's Volume Profile overlay re-paints — in `per-day` mode you should see one profile per Stock-Date segment (anchored to the right ~30% of each segment) rather than a single profile across the whole range. (This requires a selected stock + date range with ≥1 segment.)

Click "전체" again. Confirm the chart returns to a single profile spanning the whole range.

- [ ] **Step 3.5: Close the modal and confirm persistence**

Close Settings (Escape, backdrop, ✕, or 닫기). Re-open Settings. Confirm the segment still reflects the last chosen mode for the active tab.

Switch tabs (if multiple tabs are open) and re-open Settings; confirm each tab carries its own mode (per-tab prefs are intentional — same behavior as the prior sidebar toggle).

- [ ] **Step 3.6: Stop the dev server**

Ctrl-C the `npm run dev` process. No new commit needed.

If any of steps 3.2–3.5 fail, file the symptom precisely and return to the affected task (1 or 2) — do not paper over with a follow-up "fix" commit. The Task-1 and Task-2 unit tests should have caught any structural regression; a visual failure here usually indicates a Tailwind class typo or a missed import.

---

## Self-Review Checklist

**Spec coverage** — every section of `docs/superpowers/specs/2026-05-23-volume-profile-settings-relocation-design.md`:

- "Architecture (변경 없음)" — Task 1 + Task 2 leave store/overlay untouched.
- "Component Changes / CursorSidebar.tsx" — Task 2 Steps 2.4(a)–(d).
- "Component Changes / SettingsModal.tsx" — Task 1 Step 1.5.
- "시각 배치" — Task 1 Step 1.5 mounts row below `CHART_TOGGLES.map(...)`.
- "Tests / 신규 케이스" (SettingsModal × 2) — Task 1 Steps 1.1, 1.3.
- "Tests / 신규 케이스" (CursorSidebar regression) — Task 2 Step 2.1.
- "Tests / 무관" — confirmed in Task 2 Step 2.7 (full suite run).
- "Risks & Mitigation / grid 비율" — Task 2 Step 2.4(c) uses `2fr_1fr_1fr` directly.
- "Risks & Mitigation / 발견성" — out of scope by design (spec).
- "Risks & Mitigation / testid 교체" — covered by Task 1's new testid + Task 2's regression test.
- "Rollout" — two commits inside this plan.
- "Out of Scope" — captures plan does not touch 10호가/거래원/체결 data bug.

**Placeholder scan:** none. Every step has either exact code or an exact command + expected outcome.

**Type consistency:** `VolumeProfileModeRow` (Task 1) uses no exported types — internal to `SettingsModal.tsx`. The store types (`ChartViewPrefs`, `setVolumeProfileMode`) are read from `useTabsStore` exactly as the existing `VolumeProfileModeToggle` reads them. The `Props` type rename (Task 2) drops one field without renaming others.

**Ordering invariant:** Task 1 lands first → both controls coexist briefly → Task 2 removes the old. Each commit leaves the app functional. Task 3 verifies end-to-end after both commits land.
