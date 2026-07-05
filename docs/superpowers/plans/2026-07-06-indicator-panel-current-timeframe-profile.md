# Indicator Panel Current Timeframe Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the manual `분봉 / 일봉 / 주봉 / 월봉` selector from the indicator settings panel while keeping timeframe-specific pane settings driven by the chart currently being viewed.

**Architecture:** Keep the existing `panePrefsByTimeframe` persistence, `profileKeyForTimeframe`, and `panePrefsForTimeframe` resolver. Change only `IndicatorPanel` so pane checkboxes read/write the `timeframe` prop directly, and update tests to prove no manual profile selector remains. `/live`, `/study`, chart root, and legend close behavior continue using the shared profile model already implemented.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Testing Library.

## Global Constraints

- `/live` and `/study` share one 공용 지표 셋업.
- Keep separate pane profiles for `minute`, `D`, `W`, and `M`.
- Do not render a `분봉 / 일봉 / 주봉 / 월봉` profile selector inside `IndicatorPanel`.
- Pane categories write to the profile for the currently viewed chart timeframe.
- Minute frames `1m`, `3m`, `5m`, `10m`, `15m`, and `30m` all write to the `minute` profile.
- Do not add study-view `indicator_state`.
- Do not change MA, Daily MA, peak wall, volume distribution, color/style, or behavior knob persistence.

---

## File Structure

- Modify `frontend/src/live/indicators/IndicatorPanel.test.tsx`
  - Replace selector-focused tests with current-timeframe tests.
  - Assert selector buttons are absent.
  - Assert rerendering with a different `timeframe` changes checkbox state and write target.
- Modify `frontend/src/live/indicators/IndicatorPanel.tsx`
  - Remove `profileKeyForTimeframe`, `IndicatorPaneProfileKey`, and selector option imports/usages.
  - Remove `selectedProfile` local state and sync effect.
  - Remove the selector toolbar markup.
  - Use `panePrefsForTimeframe(paneIndicators, timeframe)` directly.
  - Use `setPanePrefForTimeframe(timeframe, paneKey, nextValue)` directly.
- Run focused frontend tests and build.

---

### Task 1: Update IndicatorPanel Tests

**Files:**
- Modify: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Consumes:
  - `IndicatorPanel` prop: `timeframe: LiveTimeframe`
  - store field: `panePrefsByTimeframe`
  - store method: `setPanePrefForTimeframe(timeframe, paneKey, enabled)`
- Produces:
  - Test coverage that requires implicit current-timeframe profile editing and forbids the selector UI.

- [ ] **Step 1: Replace selector-focused tests with current-timeframe behavior tests**

In `frontend/src/live/indicators/IndicatorPanel.test.tsx`, replace these three tests:

```ts
it('defaults selected pane profile to the active chart timeframe', () => {
  useLivePageStore.setState({
    volumeEnabled: true,
    panePrefsByTimeframe: {
      D: { volumeEnabled: false },
    },
  });

  renderPanel({ timeframe: 'D' });

  expect(screen.getByRole('button', { name: '일봉' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'false');
});

it('syncs the selected pane profile when the chart timeframe prop changes', () => {
  useLivePageStore.setState({
    volumeEnabled: true,
    panePrefsByTimeframe: {
      D: { volumeEnabled: false },
    },
  });

  const view = renderPanel({ timeframe: '1m' });
  expect(screen.getByRole('button', { name: '분봉' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'true');

  view.rerender(<IndicatorPanel onClose={() => {}} timeframe="D" />);

  expect(screen.getByRole('button', { name: '일봉' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'false');
});

it('edits only the selected pane profile for pane categories', async () => {
  useLivePageStore.setState({
    volumeEnabled: true,
    panePrefsByTimeframe: {},
  });

  renderPanel({ timeframe: '1m' });

  await userEvent.click(screen.getByRole('button', { name: '일봉' }));
  await userEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

  expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBe(false);
  expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.volumeEnabled).toBeUndefined();
  expect(useLivePageStore.getState().volumeEnabled).toBe(true);
});
```

with:

```ts
it('does not render a manual pane profile selector', () => {
  renderPanel({ timeframe: 'D' });

  expect(screen.queryByRole('button', { name: '분봉' })).toBeNull();
  expect(screen.queryByRole('button', { name: '일봉' })).toBeNull();
  expect(screen.queryByRole('button', { name: '주봉' })).toBeNull();
  expect(screen.queryByRole('button', { name: '월봉' })).toBeNull();
  expect(screen.queryByLabelText('시간봉별 pane profile')).toBeNull();
});

it('reads pane checkbox state from the current chart timeframe profile', () => {
  useLivePageStore.setState({
    volumeEnabled: true,
    panePrefsByTimeframe: {
      D: { volumeEnabled: false },
      W: { volumeEnabled: true },
    },
  });

  const view = renderPanel({ timeframe: 'D' });
  expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'false');

  view.rerender(<IndicatorPanel onClose={() => {}} timeframe="W" />);
  expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'true');
});

it('writes pane category changes to the current chart timeframe profile only', () => {
  useLivePageStore.setState({
    volumeEnabled: true,
    panePrefsByTimeframe: {},
  });

  renderPanel({ timeframe: 'D' });

  fireEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

  expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBe(false);
  expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.volumeEnabled).toBeUndefined();
  expect(useLivePageStore.getState().volumeEnabled).toBe(true);
});

it('uses the minute profile for every minute chart timeframe', () => {
  useLivePageStore.setState({
    volumeEnabled: true,
    panePrefsByTimeframe: {},
  });

  renderPanel({ timeframe: '3m' });

  fireEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

  expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.volumeEnabled).toBe(false);
  expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm --prefix frontend test -- --run src/live/indicators/IndicatorPanel.test.tsx
```

Expected: FAIL because the current `IndicatorPanel` still renders the `시간봉별 pane profile` toolbar and allows manual `일봉` selection.

- [ ] **Step 3: Keep the failing test uncommitted for the implementation task**

Run:

```bash
git status --short
```

Expected: `frontend/src/live/indicators/IndicatorPanel.test.tsx` is modified. Do not commit this red state; Task 2 commits the test and implementation together after the focused test passes.

---

### Task 2: Remove Manual Profile Selection From IndicatorPanel

**Files:**
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`

**Interfaces:**
- Consumes:
  - `panePrefsForTimeframe(paneIndicators, timeframe)`
  - `setPanePrefForTimeframe(timeframe, paneKey, enabled)`
- Produces:
  - `IndicatorPanel` with no profile selector UI.
  - Pane category checkboxes bound to the current `timeframe` prop.

- [ ] **Step 1: Remove selector-specific imports and constants**

In `frontend/src/live/indicators/IndicatorPanel.tsx`, change:

```ts
import {
  panePrefsForTimeframe,
  profileKeyForTimeframe,
  type IndicatorPaneProfileKey,
  type PanePrefKey,
  type PanePrefsIndicatorSource,
} from './indicatorPaneProfiles';
```

to:

```ts
import {
  panePrefsForTimeframe,
  type PanePrefKey,
  type PanePrefsIndicatorSource,
} from './indicatorPaneProfiles';
```

Delete:

```ts
const PROFILE_SELECTOR_OPTIONS: ReadonlyArray<{
  key: IndicatorPaneProfileKey;
  label: string;
}> = [
  { key: 'minute', label: '분봉' },
  { key: 'D', label: '일봉' },
  { key: 'W', label: '주봉' },
  { key: 'M', label: '월봉' },
];
```

- [ ] **Step 2: Remove selected profile state**

Delete:

```ts
const [selectedProfile, setSelectedProfile] = useState<IndicatorPaneProfileKey>(
  () => profileKeyForTimeframe(timeframe),
);

useEffect(() => {
  setSelectedProfile(profileKeyForTimeframe(timeframe));
}, [timeframe]);
```

Keep the existing selected category state:

```ts
const [selected, setSelected] = useState<CategoryId>('moving-average');
```

- [ ] **Step 3: Bind pane prefs directly to the current timeframe prop**

Replace:

```ts
const selectedProfileTimeframe: LiveTimeframe =
  selectedProfile === 'minute' ? '1m' : selectedProfile;
const selectedPanePrefs = panePrefsForTimeframe(paneIndicators, selectedProfileTimeframe);
```

with:

```ts
const selectedPanePrefs = panePrefsForTimeframe(paneIndicators, timeframe);
```

Replace:

```ts
return () => setPanePrefForTimeframe(
  selectedProfileTimeframe,
  paneKey,
  !selectedPanePrefs[paneKey],
);
```

with:

```ts
return () => setPanePrefForTimeframe(
  timeframe,
  paneKey,
  !selectedPanePrefs[paneKey],
);
```

- [ ] **Step 4: Remove selector toolbar markup and collapse shell rows**

Replace the shell class:

```tsx
className="grid max-h-[min(820px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
```

with:

```tsx
className="grid max-h-[min(820px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
```

Delete the selector block:

```tsx
<div className="flex items-center gap-1 border-b border-border px-4 py-2" aria-label="시간봉별 pane profile">
  {PROFILE_SELECTOR_OPTIONS.map(({ key, label }) => (
    <button
      key={key}
      type="button"
      aria-pressed={selectedProfile === key}
      onClick={() => setSelectedProfile(key)}
      className={`rounded-md px-2.5 py-1 text-xs ${
        selectedProfile === key
          ? 'bg-accent text-bg'
          : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover hover:text-fg'
      }`}
    >
      {label}
    </button>
  ))}
</div>
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
npm --prefix frontend test -- --run src/live/indicators/IndicatorPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the passing test and implementation together**

Run:

```bash
git add frontend/src/live/indicators/IndicatorPanel.test.tsx frontend/src/live/indicators/IndicatorPanel.tsx
git commit -m "fix(live): edit pane profiles from current timeframe"
```

Expected: commit succeeds with the test and implementation files staged.

---

### Task 3: Integration Verification

**Files:**
- Test only:
  - `frontend/src/live/indicators/IndicatorPanel.test.tsx`
  - `frontend/src/live/LivePage.test.tsx`
  - `frontend/src/studyViews/StudyPage.test.tsx`
  - `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`
  - `frontend/src/live/PaneLegendOverlay.test.tsx`

**Interfaces:**
- Consumes:
  - `/live` passes active timeframe into `IndicatorPanel`.
  - `/study` passes active saved-view timeframe into `IndicatorPanel`.
  - `PaneLegendOverlay` writes close actions to the current timeframe profile.
- Produces:
  - Verification that the UX-only change does not regress shared live/study pane profile behavior.

- [ ] **Step 1: Run the focused integration test set**

Run:

```bash
npm --prefix frontend test -- --run \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/live/LivePage.test.tsx \
  src/studyViews/StudyPage.test.tsx \
  src/live/LiveChartRoot.paneToggles.test.tsx \
  src/live/PaneLegendOverlay.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the frontend build**

Run:

```bash
npm --prefix frontend run build
```

Expected: PASS.

- [ ] **Step 3: Check for accidental extra changes**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intentional files are modified, or no changes remain if Tasks 1 and 2 were committed.

- [ ] **Step 4: Commit verification notes if any tracked docs changed**

If no files changed during verification, do not create a commit. If a test snapshot or documentation file changed intentionally, commit it:

```bash
git add <changed-file>
git commit -m "chore(live): verify current timeframe pane profile flow"
```

Expected: no commit is needed for a normal run.

---

## Self-Review

- Spec coverage: The plan removes the manual selector, keeps existing profile persistence, writes pane categories to the current timeframe profile, preserves live/study shared settings, and adds tests for selector absence, D/W target writes, minute grouping, and prop-driven profile changes.
- Placeholder scan: No placeholder markers or open-ended implementation steps remain.
- Type consistency: The plan uses existing names `panePrefsForTimeframe`, `setPanePrefForTimeframe`, `timeframe`, `panePrefsByTimeframe`, and `LiveTimeframe` consistently with the current codebase.
