# Indicator Pane Timeframe Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/live` and `/study` shared indicator pane profiles so pane ON/OFF settings can differ for minute, daily, weekly, and monthly timeframes without saving indicator state in study views.

**Architecture:** Add a small pure profile module that resolves legacy flat indicator toggles plus optional timeframe overrides into pane toggles. Persist profile overrides inside existing `live.indicators.v1`, then rewire chart, indicator panel, and pane legend consumers to use the active timeframe profile while keeping existing data-availability gates.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Testing Library, localStorage persistence.

## Global Constraints

- `/live` and `/study` share one **공용 지표 셋업 (Shared Indicator Setup)**.
- Do not add `indicator_state` to study view schema, save payloads, or API tests.
- Group all minute frames (`1m`, `3m`, `5m`, `10m`, `15m`, `30m`) into one `minute` profile.
- Profile only pane ON/OFF in v1: volume, quote totals, ratio, fill strength, program trade, foreign net, institution net.
- Exclude MA, Daily MA, POC, volume distribution, colors, styles, and behavior knobs from timeframe profiles.
- `/live` D/W/M hoga data gate wins even when D/W/M hoga profile toggles are on.
- Pane Legend close writes to the currently viewed timeframe profile.
- Legacy flat settings remain as fallback; profile overrides are additive.

---

## File Structure

- Create `frontend/src/live/indicators/indicatorPaneProfiles.ts`
  - Pure profile key, defaults, validation, legacy fallback, and pane toggle resolution helpers.
  - Uses only `import type` from `state/livePage` and `state/liveIndicatorsPersistence` to avoid runtime cycles.
- Create `frontend/src/live/indicators/indicatorPaneProfiles.test.ts`
  - Unit coverage for minute grouping, fallback, overrides, corrupt payloads, and data gates.
- Modify `frontend/src/state/liveIndicatorsPersistence.ts`
  - Add `panePrefsByTimeframe` to `PersistedIndicators`.
  - Normalize partial profile payloads and preserve only known profile/toggle keys.
- Modify `frontend/src/state/liveIndicatorsPersistence.test.ts`
  - Cover default, legacy fallback shape, valid partial profile persistence, and invalid profile cleanup.
- Modify `frontend/src/state/livePage.ts`
  - Snapshot/persist `panePrefsByTimeframe`.
  - Add `setPanePrefForTimeframe(timeframe, key, enabled)`.
  - Update existing pane setters to continue writing flat legacy toggles only for backward compatibility.
- Modify `frontend/src/live/paneSpecsForTimeframe.ts`
  - Keep current data gates; use resolved `PaneToggles` as input.
- Modify `frontend/src/live/LiveChartRoot.tsx`
  - Read resolved pane toggles for `timeframe`.
  - Keep `paneTogglesOverride` as an override seam, merging it last.
  - Pass active toggles to `PaneLegendOverlay`.
- Modify `frontend/src/live/PaneLegendOverlay.tsx` and `frontend/src/live/legendRows.ts`
  - Legend rows use resolved profile toggles.
  - Close buttons write profile-specific pane prefs.
- Modify `frontend/src/live/indicators/IndicatorPanel.tsx`
  - Accept `timeframe`.
  - Add profile selector `분봉 | 일봉 | 주봉 | 월봉`.
  - Pane categories read/write selected profile; non-profile categories remain global.
- Modify `frontend/src/live/LivePage.tsx` and `frontend/src/studyViews/StudyPage.tsx`
  - Pass current timeframe into `IndicatorPanel`.
  - Preserve `/study` save behavior with no indicator state.
- Modify relevant tests:
  - `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`
  - `frontend/src/live/PaneLegendOverlay.test.tsx`
  - `frontend/src/live/indicators/IndicatorPanel.test.tsx`
  - `frontend/src/studyViews/StudyPage.test.tsx`
  - `frontend/src/live/LivePage.test.tsx`

---

### Task 1: Pure Profile Module

**Files:**
- Create: `frontend/src/live/indicators/indicatorPaneProfiles.ts`
- Create: `frontend/src/live/indicators/indicatorPaneProfiles.test.ts`

**Interfaces:**
- Consumes: `LiveTimeframe`, `PersistedIndicators`, `PaneToggles`
- Produces:
  - `IndicatorPaneProfileKey`
  - `IndicatorPanePrefs`
  - `PanePrefKey`
  - `IndicatorPanePrefsByTimeframe`
  - `profileKeyForTimeframe(tf: LiveTimeframe): IndicatorPaneProfileKey`
  - `normalizePanePrefsByTimeframe(raw: unknown): Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorPanePrefs>>>`
  - `legacyPanePrefsFromIndicators(indicators: PersistedIndicators): IndicatorPanePrefs`
  - `panePrefsForTimeframe(indicators: PersistedIndicators, timeframe: LiveTimeframe): IndicatorPanePrefs`
  - `resolvePaneTogglesForTimeframe(input: { indicators: PersistedIndicators; timeframe: LiveTimeframe; forceHogaPanes?: boolean; hogaPanes?: boolean; override?: Partial<PaneToggles> }): PaneToggles`

- [ ] **Step 1: Write failing tests for profile grouping, fallback, and overrides**

Add `frontend/src/live/indicators/indicatorPaneProfiles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeLiveIndicatorPrefs } from '../../state/liveIndicatorsPersistence';
import {
  legacyPanePrefsFromIndicators,
  normalizePanePrefsByTimeframe,
  panePrefsForTimeframe,
  profileKeyForTimeframe,
  resolvePaneTogglesForTimeframe,
} from './indicatorPaneProfiles';

describe('indicatorPaneProfiles', () => {
  it('groups all minute timeframes into one minute profile', () => {
    expect(profileKeyForTimeframe('1m')).toBe('minute');
    expect(profileKeyForTimeframe('3m')).toBe('minute');
    expect(profileKeyForTimeframe('30m')).toBe('minute');
    expect(profileKeyForTimeframe('D')).toBe('D');
    expect(profileKeyForTimeframe('W')).toBe('W');
    expect(profileKeyForTimeframe('M')).toBe('M');
  });

  it('builds legacy pane prefs from flat persisted indicator fields', () => {
    const indicators = mergeLiveIndicatorPrefs({
      volumeEnabled: false,
      ratioEnabled: false,
      foreignNetEnabled: true,
    });

    expect(legacyPanePrefsFromIndicators(indicators)).toEqual({
      volumeEnabled: false,
      quoteTotalsEnabled: true,
      ratioEnabled: false,
      fillStrengthEnabled: true,
      programTradeEnabled: true,
      foreignNetEnabled: true,
      institutionNetEnabled: false,
    });
  });

  it('uses legacy fallback for profiles without overrides', () => {
    const indicators = mergeLiveIndicatorPrefs({
      volumeEnabled: false,
      ratioEnabled: false,
    });

    expect(panePrefsForTimeframe(indicators, 'D')).toMatchObject({
      volumeEnabled: false,
      ratioEnabled: false,
    });
  });

  it('applies only the selected profile override', () => {
    const indicators = mergeLiveIndicatorPrefs({
      ratioEnabled: true,
      panePrefsByTimeframe: {
        D: { ratioEnabled: false },
      },
    });

    expect(panePrefsForTimeframe(indicators, 'D').ratioEnabled).toBe(false);
    expect(panePrefsForTimeframe(indicators, 'W').ratioEnabled).toBe(true);
    expect(panePrefsForTimeframe(indicators, '1m').ratioEnabled).toBe(true);
  });

  it('drops unknown profile keys and non-boolean pane values', () => {
    expect(normalizePanePrefsByTimeframe({
      D: { volumeEnabled: false, ratioEnabled: 'no' },
      '2m': { volumeEnabled: true },
      minute: { quoteTotalsEnabled: true, unknownEnabled: false },
    })).toEqual({
      D: { volumeEnabled: false },
      minute: { quoteTotalsEnabled: true },
    });
  });

  it('resolves pane toggles with data gate flags threaded through', () => {
    const indicators = mergeLiveIndicatorPrefs({
      panePrefsByTimeframe: {
        D: {
          volumeEnabled: false,
          ratioEnabled: true,
          foreignNetEnabled: true,
        },
      },
    });

    expect(resolvePaneTogglesForTimeframe({
      indicators,
      timeframe: 'D',
      forceHogaPanes: true,
      hogaPanes: true,
    })).toMatchObject({
      volumeEnabled: false,
      ratioEnabled: true,
      foreignNet: true,
      institutionNet: false,
      forceHogaPanes: true,
      hogaPanes: true,
    });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- --run src/live/indicators/indicatorPaneProfiles.test.ts
```

Expected: FAIL with a module resolution error for `./indicatorPaneProfiles`.

- [ ] **Step 3: Implement the pure profile module**

Create `frontend/src/live/indicators/indicatorPaneProfiles.ts`:

```ts
import type { LiveTimeframe } from '../../state/livePage';
import type { PersistedIndicators } from '../../state/liveIndicatorsPersistence';
import type { PaneToggles } from '../paneSpecsForTimeframe';

export type IndicatorPaneProfileKey = 'minute' | 'D' | 'W' | 'M';

export type IndicatorPanePrefs = {
  volumeEnabled: boolean;
  quoteTotalsEnabled: boolean;
  ratioEnabled: boolean;
  fillStrengthEnabled: boolean;
  programTradeEnabled: boolean;
  foreignNetEnabled: boolean;
  institutionNetEnabled: boolean;
};

export type PanePrefKey = keyof IndicatorPanePrefs;

export type IndicatorPanePrefsByTimeframe =
  Record<IndicatorPaneProfileKey, IndicatorPanePrefs>;

export type PersistedPanePrefsByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorPanePrefs>>>;

export const INDICATOR_PANE_PROFILE_KEYS: readonly IndicatorPaneProfileKey[] =
  ['minute', 'D', 'W', 'M'] as const;

export const INDICATOR_PANE_PREF_KEYS: readonly PanePrefKey[] = [
  'volumeEnabled',
  'quoteTotalsEnabled',
  'ratioEnabled',
  'fillStrengthEnabled',
  'programTradeEnabled',
  'foreignNetEnabled',
  'institutionNetEnabled',
] as const;

const PROFILE_KEY_SET = new Set<string>(INDICATOR_PANE_PROFILE_KEYS);
const PANE_PREF_KEY_SET = new Set<string>(INDICATOR_PANE_PREF_KEYS);

function isProfileKey(value: string): value is IndicatorPaneProfileKey {
  return PROFILE_KEY_SET.has(value);
}

function isPanePrefKey(value: string): value is PanePrefKey {
  return PANE_PREF_KEY_SET.has(value);
}

export function profileKeyForTimeframe(tf: LiveTimeframe): IndicatorPaneProfileKey {
  return tf === 'D' || tf === 'W' || tf === 'M' ? tf : 'minute';
}

export function normalizePanePrefsByTimeframe(raw: unknown): PersistedPanePrefsByTimeframe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const normalized: PersistedPanePrefsByTimeframe = {};
  for (const [profileKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProfileKey(profileKey)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const profile: Partial<IndicatorPanePrefs> = {};
    for (const [paneKey, paneValue] of Object.entries(value as Record<string, unknown>)) {
      if (!isPanePrefKey(paneKey)) continue;
      if (typeof paneValue !== 'boolean') continue;
      profile[paneKey] = paneValue;
    }
    if (Object.keys(profile).length > 0) normalized[profileKey] = profile;
  }
  return normalized;
}

export function legacyPanePrefsFromIndicators(indicators: PersistedIndicators): IndicatorPanePrefs {
  return {
    volumeEnabled: indicators.volumeEnabled,
    quoteTotalsEnabled: indicators.quoteTotalsEnabled,
    ratioEnabled: indicators.ratioEnabled,
    fillStrengthEnabled: indicators.fillStrengthEnabled,
    programTradeEnabled: indicators.programTradeEnabled,
    foreignNetEnabled: indicators.foreignNetEnabled,
    institutionNetEnabled: indicators.institutionNetEnabled,
  };
}

export function panePrefsForTimeframe(
  indicators: PersistedIndicators,
  timeframe: LiveTimeframe,
): IndicatorPanePrefs {
  const legacy = legacyPanePrefsFromIndicators(indicators);
  const profileKey = profileKeyForTimeframe(timeframe);
  return {
    ...legacy,
    ...(indicators.panePrefsByTimeframe?.[profileKey] ?? {}),
  };
}

export function resolvePaneTogglesForTimeframe(input: {
  indicators: PersistedIndicators;
  timeframe: LiveTimeframe;
  forceHogaPanes?: boolean;
  hogaPanes?: boolean;
  override?: Partial<PaneToggles>;
}): PaneToggles {
  const prefs = panePrefsForTimeframe(input.indicators, input.timeframe);
  return {
    foreignNet: prefs.foreignNetEnabled,
    institutionNet: prefs.institutionNetEnabled,
    volumeEnabled: prefs.volumeEnabled,
    quoteTotalsEnabled: prefs.quoteTotalsEnabled,
    ratioEnabled: prefs.ratioEnabled,
    fillStrengthEnabled: prefs.fillStrengthEnabled,
    programTradeEnabled: prefs.programTradeEnabled,
    hogaPanes: input.hogaPanes,
    forceHogaPanes: input.forceHogaPanes,
    ...input.override,
  };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
npm test -- --run src/live/indicators/indicatorPaneProfiles.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/indicatorPaneProfiles.ts frontend/src/live/indicators/indicatorPaneProfiles.test.ts
git commit -m "feat: add indicator pane profile resolver"
```

---

### Task 2: Persist Profile Overrides

**Files:**
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/liveIndicatorsPersistence.test.ts`

**Interfaces:**
- Consumes: `normalizePanePrefsByTimeframe`, `PersistedPanePrefsByTimeframe`
- Produces: `PersistedIndicators.panePrefsByTimeframe`

- [ ] **Step 1: Write failing persistence tests**

Update `frontend/src/state/liveIndicatorsPersistence.test.ts` default expected object by adding:

```ts
panePrefsByTimeframe: {},
```

Add tests inside `describe('mergeLiveIndicatorPrefs — 호가 토글', () => { ... })`:

```ts
  it('panePrefsByTimeframe defaults to an empty override map', () => {
    expect(mergeLiveIndicatorPrefs(undefined).panePrefsByTimeframe).toEqual({});
  });

  it('preserves valid partial pane timeframe profiles', () => {
    const m = mergeLiveIndicatorPrefs({
      panePrefsByTimeframe: {
        minute: { ratioEnabled: false },
        D: { volumeEnabled: false, foreignNetEnabled: true },
      },
    });
    expect(m.panePrefsByTimeframe).toEqual({
      minute: { ratioEnabled: false },
      D: { volumeEnabled: false, foreignNetEnabled: true },
    });
  });

  it('drops invalid pane profile payload pieces', () => {
    const m = mergeLiveIndicatorPrefs({
      panePrefsByTimeframe: {
        minute: { ratioEnabled: 'false', fillStrengthEnabled: true },
        Q: { volumeEnabled: false },
        W: ['bad'],
      },
    } as never);
    expect(m.panePrefsByTimeframe).toEqual({
      minute: { fillStrengthEnabled: true },
    });
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- --run src/state/liveIndicatorsPersistence.test.ts
```

Expected: FAIL because `panePrefsByTimeframe` is missing from merged prefs.

- [ ] **Step 3: Add profile field and normalization to persistence**

Modify `frontend/src/state/liveIndicatorsPersistence.ts`:

```ts
import {
  normalizePanePrefsByTimeframe,
  type PersistedPanePrefsByTimeframe,
} from '../live/indicators/indicatorPaneProfiles';
```

Add to `PersistedIndicators`:

```ts
  /** Shared live/study pane on/off overrides by timeframe profile. Empty = legacy flat fields are fallback. */
  panePrefsByTimeframe: PersistedPanePrefsByTimeframe;
```

Inside `mergeLiveIndicatorPrefs`, after `obj` is defined and before `build`, add:

```ts
  const panePrefsByTimeframe = normalizePanePrefsByTimeframe(obj?.panePrefsByTimeframe);
```

Inside `build(...)` return object, add:

```ts
    panePrefsByTimeframe,
```

- [ ] **Step 4: Run persistence tests**

Run:

```bash
npm test -- --run src/state/liveIndicatorsPersistence.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/liveIndicatorsPersistence.test.ts
git commit -m "feat: persist indicator pane profiles"
```

---

### Task 3: Store Setter And Snapshot Wiring

**Files:**
- Modify: `frontend/src/state/livePage.ts`
- Test: existing persistence tests plus store behavior through component tests in later tasks

**Interfaces:**
- Consumes: `PanePrefKey`, `profileKeyForTimeframe`, `normalizePanePrefsByTimeframe`
- Produces: `setPanePrefForTimeframe(timeframe: LiveTimeframe, key: PanePrefKey, enabled: boolean): void`

- [ ] **Step 1: Add store interface and snapshot field**

Modify imports in `frontend/src/state/livePage.ts`:

```ts
import {
  normalizePanePrefsByTimeframe,
  profileKeyForTimeframe,
  type PanePrefKey,
} from '../live/indicators/indicatorPaneProfiles';
```

Add to `Store`:

```ts
  setPanePrefForTimeframe: (timeframe: LiveTimeframe, key: PanePrefKey, enabled: boolean) => void;
```

Add to `snapshotIndicators(get)` return:

```ts
    panePrefsByTimeframe: s.panePrefsByTimeframe,
```

- [ ] **Step 2: Implement profile setter**

Add this store action near the pane toggle setters:

```ts
  setPanePrefForTimeframe: (timeframe, key, enabled) => {
    const profileKey = profileKeyForTimeframe(timeframe);
    const current = normalizePanePrefsByTimeframe(get().panePrefsByTimeframe);
    const next = {
      ...current,
      [profileKey]: {
        ...(current[profileKey] ?? {}),
        [key]: enabled,
      },
    };
    set({ panePrefsByTimeframe: next });
    persistIndicators(snapshotIndicators(get));
  },
```

Keep existing `setVolumeEnabled`, `setQuoteTotalsEnabled`, `setRatioEnabled`, `setFillStrengthEnabled`, `setProgramTradeEnabled`, `setForeignNetEnabled`, and `setInstitutionNetEnabled` in place. They remain legacy/global setters for compatibility until all direct callers are migrated.

- [ ] **Step 3: Run typecheck/build**

Run:

```bash
npm run build
```

Expected: PASS. If TypeScript complains about object spread type widening, annotate `next` as `PersistedPanePrefsByTimeframe` and import that type.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/state/livePage.ts
git commit -m "feat: add pane profile store setter"
```

---

### Task 4: Chart Pane Resolution

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`

**Interfaces:**
- Consumes: `resolvePaneTogglesForTimeframe`
- Produces: `activePaneToggles` passed to `paneSpecsForTimeframe` and `PaneLegendOverlay`

- [ ] **Step 1: Write failing tests for profile-aware chart mounts**

In `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`, update `beforeEach` baseline to include:

```ts
      panePrefsByTimeframe: {},
```

Add tests:

```ts
  it('uses the active timeframe pane profile instead of flat legacy fields', () => {
    useLivePageStore.setState({
      ratioEnabled: true,
      panePrefsByTimeframe: {
        minute: { ratioEnabled: false },
      },
    });
    renderAt('1m');
    expect(mounted).not.toContain('ratio');
    expect(mounted).toContain('quote-totals');
  });

  it('keeps /live D hoga panes gated even when the D profile enables them', () => {
    useLivePageStore.setState({
      panePrefsByTimeframe: {
        D: { quoteTotalsEnabled: true, ratioEnabled: true, fillStrengthEnabled: true },
      },
    });
    renderAt('D');
    expect(mounted).toEqual(['candle', 'volume']);
  });

  it('allows forced study-style D hoga panes from the D profile', () => {
    useLivePageStore.setState({
      panePrefsByTimeframe: {
        D: { ratioEnabled: true, quoteTotalsEnabled: false, fillStrengthEnabled: false },
      },
    });
    renderAt('D', { forceHogaPanes: true });
    expect(mounted).toEqual(['candle', 'volume', 'ratio', 'program-trade']);
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- --run src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected: FAIL because `LiveChartRoot` still reads flat fields.

- [ ] **Step 3: Use resolved pane toggles in `LiveChartRoot`**

Modify imports:

```ts
import { resolvePaneTogglesForTimeframe } from './indicators/indicatorPaneProfiles';
```

Replace direct store selectors for pane fields with one selector:

```ts
  const indicatorPrefs = useLivePageStore((s) => ({
    movingAverages: s.movingAverages,
    movingAverageEnabled: s.movingAverageEnabled,
    movingAverageHidden: s.movingAverageHidden,
    volumeEnabled: s.volumeEnabled,
    quoteTotalsEnabled: s.quoteTotalsEnabled,
    ratioEnabled: s.ratioEnabled,
    fillStrengthEnabled: s.fillStrengthEnabled,
    programTradeEnabled: s.programTradeEnabled,
    foreignNetEnabled: s.foreignNetEnabled,
    institutionNetEnabled: s.institutionNetEnabled,
    panePrefsByTimeframe: s.panePrefsByTimeframe,
  }));
```

Compute active toggles before `paneSpecsForTimeframe` is called:

```ts
  const activePaneToggles = useMemo(() => resolvePaneTogglesForTimeframe({
    indicators: indicatorPrefs,
    timeframe,
    forceHogaPanes,
    hogaPanes: paneTogglesOverride?.hogaPanes,
    override: paneTogglesOverride,
  }), [indicatorPrefs, timeframe, forceHogaPanes, paneTogglesOverride]);
```

Replace the `paneSpecsForTimeframe(...)` call with:

```ts
  const paneSpecs = useMemo(
    () => paneSpecsForTimeframe(timeframe, activePaneToggles),
    [timeframe, activePaneToggles],
  );
```

If existing code builds an inline object for `paneSpecsForTimeframe`, remove that object and use `activePaneToggles`.

- [ ] **Step 4: Pass active toggles to PaneLegendOverlay**

Update the render of `PaneLegendOverlay` in `LiveChartRoot` to include:

```tsx
<PaneLegendOverlay
  chart={chart}
  timeframe={timeframe}
  paneSeries={paneSeries}
  paneToggles={activePaneToggles}
  dataEpoch={cb}
/>
```

Task 5 will add the `paneToggles` prop to `PaneLegendOverlay`.

- [ ] **Step 5: Run chart tests**

Run:

```bash
npm test -- --run src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected: PASS after Task 5 prop typing is available; if run before Task 5, TypeScript can fail on the missing prop type.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.paneToggles.test.tsx
git commit -m "feat: resolve panes from timeframe profiles"
```

---

### Task 5: Pane Legend Uses Active Profile

**Files:**
- Modify: `frontend/src/live/PaneLegendOverlay.tsx`
- Modify: `frontend/src/live/legendRows.ts`
- Modify: `frontend/src/live/PaneLegendOverlay.test.tsx`

**Interfaces:**
- Consumes: `PaneToggles`, `setPanePrefForTimeframe`
- Produces: legend close writes active timeframe profile

- [ ] **Step 1: Write failing legend tests**

Add to `frontend/src/live/PaneLegendOverlay.test.tsx`:

```ts
  it('volume close writes the active timeframe profile', async () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      panePrefsByTimeframe: {},
    });
    renderOverlay({ timeframe: 'D', paneToggles: { foreignNet: false, institutionNet: false, volumeEnabled: true } });

    await userEvent.click(screen.getByLabelText('거래량 지표 끄기'));

    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('foreign close writes D profile investor toggle', async () => {
    useLivePageStore.setState({
      foreignNetEnabled: true,
      panePrefsByTimeframe: { D: { foreignNetEnabled: true } },
    });
    renderOverlay({
      timeframe: 'D',
      paneToggles: { foreignNet: true, institutionNet: false, volumeEnabled: false },
    });

    await userEvent.click(screen.getByLabelText('외국인 순매수량 지표 끄기'));

    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.foreignNetEnabled).toBe(false);
    expect(useLivePageStore.getState().foreignNetEnabled).toBe(true);
  });
```

If the local test helper has a different name than `renderOverlay`, update the call to the existing helper and pass `paneToggles`.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- --run src/live/PaneLegendOverlay.test.tsx
```

Expected: FAIL because close buttons still write flat store fields.

- [ ] **Step 3: Thread active pane toggles through legend rows**

Modify `frontend/src/live/PaneLegendOverlay.tsx` imports:

```ts
import type { PaneToggles } from './paneSpecsForTimeframe';
```

Add prop:

```ts
  paneToggles: PaneToggles;
```

Remove direct store selectors:

```ts
  const volumeEnabled = useLivePageStore((s) => s.volumeEnabled);
  const foreignNetEnabled = useLivePageStore((s) => s.foreignNetEnabled);
  const institutionNetEnabled = useLivePageStore((s) => s.institutionNetEnabled);
```

Use props in `buildLegendRows`:

```ts
    volumeEnabled: paneToggles.volumeEnabled !== false,
    foreignNetEnabled: paneToggles.foreignNet,
    institutionNetEnabled: paneToggles.institutionNet,
```

- [ ] **Step 4: Make close buttons write the current profile**

Replace `SingleLegendRow` setters with profile setter:

```ts
function SingleLegendRow({
  row,
  timeframe,
}: {
  row: Exclude<LegendRow, { paneId: 'candle' }>;
  timeframe: LiveTimeframe;
}) {
  const setPanePrefForTimeframe = useLivePageStore((s) => s.setPanePrefForTimeframe);
  const turnOff = () => {
    switch (row.paneId) {
      case 'volume':
        setPanePrefForTimeframe(timeframe, 'volumeEnabled', false);
        break;
      case 'investor-foreign':
        setPanePrefForTimeframe(timeframe, 'foreignNetEnabled', false);
        break;
      case 'investor-institution':
        setPanePrefForTimeframe(timeframe, 'institutionNetEnabled', false);
        break;
      default: {
        const _exhaustive: never = row;
        void _exhaustive;
      }
    }
  };
  return (
    <>
      <span style={{ color: 'var(--fg-dim)' }}>{row.label}</span>
      <ValueCell value={row.value} />
      <HoverIcon label={`${row.label} 지표 끄기`} restColor="var(--fg-dimmer)" onClick={turnOff}>
        <CloseGlyph />
      </HoverIcon>
    </>
  );
}
```

Update row render:

```tsx
<SingleLegendRow key={row.paneId} row={row} timeframe={timeframe} />
```

- [ ] **Step 5: Run legend tests**

Run:

```bash
npm test -- --run src/live/PaneLegendOverlay.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/PaneLegendOverlay.tsx frontend/src/live/legendRows.ts frontend/src/live/PaneLegendOverlay.test.tsx
git commit -m "feat: make pane legend close profile-aware"
```

---

### Task 6: Indicator Panel Profile Selector

**Files:**
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.test.tsx`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Modify: `frontend/src/live/LivePage.test.tsx`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: `timeframe`, `panePrefsForTimeframe`, `profileKeyForTimeframe`, `setPanePrefForTimeframe`
- Produces: profile selector and profile-specific checkbox behavior

- [ ] **Step 1: Write failing panel tests**

In `frontend/src/live/indicators/IndicatorPanel.test.tsx`, add:

```ts
  it('defaults selected pane profile to the active chart timeframe', () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      panePrefsByTimeframe: {
        D: { volumeEnabled: false },
      },
    });
    render(<IndicatorPanel onClose={() => {}} timeframe="D" />);

    expect(screen.getByRole('button', { name: '일봉' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'false');
  });

  it('edits only the selected pane profile for pane categories', async () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      panePrefsByTimeframe: {},
    });
    render(<IndicatorPanel onClose={() => {}} timeframe="1m" />);

    await userEvent.click(screen.getByRole('button', { name: '일봉' }));
    await userEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.volumeEnabled).toBeUndefined();
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- --run src/live/indicators/IndicatorPanel.test.tsx
```

Expected: FAIL because `IndicatorPanel` does not accept `timeframe` and has no profile selector.

- [ ] **Step 3: Add timeframe prop and selector state**

Modify `IndicatorPanel` imports:

```ts
import {
  profileKeyForTimeframe,
  panePrefsForTimeframe,
  type IndicatorPaneProfileKey,
  type PanePrefKey,
} from './indicatorPaneProfiles';
import type { LiveTimeframe } from '../../state/livePage';
```

Modify props:

```ts
type Props = {
  onClose: () => void;
  capabilities?: LiveInstrumentCapabilities;
  timeframe: LiveTimeframe;
};
```

Inside component:

```ts
  const [selectedProfile, setSelectedProfile] = useState<IndicatorPaneProfileKey>(
    () => profileKeyForTimeframe(timeframe),
  );
  const panePrefsByTimeframe = useLivePageStore((s) => s.panePrefsByTimeframe);
  const setPanePrefForTimeframe = useLivePageStore((s) => s.setPanePrefForTimeframe);
```

Build a synthetic indicator snapshot for profile reads:

```ts
  const paneIndicators = {
    movingAverages: [],
    movingAverageEnabled: true,
    foreignNetEnabled: foreignNet,
    institutionNetEnabled: institutionNet,
    volumeEnabled,
    movingAverageHidden: false,
    quoteTotalsEnabled: quoteTotals,
    ratioEnabled: ratio,
    fillStrengthEnabled: fillStrength,
    programTradeEnabled: programTrade,
    panePrefsByTimeframe,
  } as Parameters<typeof panePrefsForTimeframe>[0];
```

Use a helper timeframe per profile:

```ts
  const selectedProfileTimeframe: LiveTimeframe =
    selectedProfile === 'minute' ? '1m' : selectedProfile;
  const selectedPanePrefs = panePrefsForTimeframe(paneIndicators, selectedProfileTimeframe);
```

If TypeScript rejects the partial object, replace it by selecting all fields needed by `PersistedIndicators` from the store in one selector.

- [ ] **Step 4: Add segmented control UI**

Insert below the modal title bar and above the main grid:

```tsx
        <div className="flex items-center gap-1 border-b border-border px-4 py-2" aria-label="시간봉별 pane profile">
          {[
            ['minute', '분봉'],
            ['D', '일봉'],
            ['W', '주봉'],
            ['M', '월봉'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={selectedProfile === key}
              onClick={() => setSelectedProfile(key as IndicatorPaneProfileKey)}
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

Change shell grid rows from:

```tsx
className="grid max-h-[min(820px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
```

to:

```tsx
className="grid max-h-[min(820px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
```

- [ ] **Step 5: Route pane category checkboxes through selected profile**

Add:

```ts
  const PANE_CATEGORY_TO_KEY: Partial<Record<CategoryId, PanePrefKey>> = {
    volume: 'volumeEnabled',
    'quote-totals': 'quoteTotalsEnabled',
    ratio: 'ratioEnabled',
    'fill-strength': 'fillStrengthEnabled',
    'program-trade': 'programTradeEnabled',
    'foreign-net': 'foreignNetEnabled',
    'institution-net': 'institutionNetEnabled',
  };
```

At the top of `checkedFor`:

```ts
    const paneKey = PANE_CATEGORY_TO_KEY[id];
    if (paneKey) return selectedPanePrefs[paneKey];
```

At the top of `toggleFor`:

```ts
    const paneKey = PANE_CATEGORY_TO_KEY[id];
    if (paneKey) {
      return () => setPanePrefForTimeframe(
        selectedProfileTimeframe,
        paneKey,
        !selectedPanePrefs[paneKey],
      );
    }
```

Leave MA, Daily MA, ask/bid peak, POC, volume distribution, broker late entry global.

- [ ] **Step 6: Pass timeframe at call sites**

In `frontend/src/live/LivePage.tsx`:

```tsx
        <IndicatorPanel
          onClose={() => setIndicatorPanelOpen(false)}
          capabilities={capabilities}
          timeframe={timeframe}
        />
```

In every `IndicatorPanel` render in `frontend/src/studyViews/StudyPage.tsx`, pass the active study timeframe:

```tsx
<IndicatorPanel onClose={() => setIndicatorPanelOpen(false)} timeframe={activeViewModel?.save.timeframe ?? '1m'} />
```

If a render is outside `activeViewModel` scope but has `selectedSave`, use:

```tsx
timeframe={selectedSave?.timeframe ?? '1m'}
```

Update test mocks that declare `IndicatorPanel` props to include optional `timeframe?: LiveTimeframe`.

- [ ] **Step 7: Run panel and route tests**

Run:

```bash
npm test -- --run \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/live/LivePage.test.tsx \
  src/studyViews/StudyPage.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx frontend/src/live/LivePage.tsx frontend/src/studyViews/StudyPage.tsx frontend/src/live/LivePage.test.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat: add timeframe profile controls to indicator panel"
```

---

### Task 7: Study Save Guardrails And Documentation

**Files:**
- Modify: `frontend/src/studyViews/LiveStudyViewSaveButton.test.tsx`
- Modify: `frontend/src/studyViews/studySaveCommand.test.ts`
- Modify: `tests/api/test_study_views.py`
- Modify: `docs/superpowers/specs/2026-07-05-indicator-pane-timeframe-profiles-design.md`

**Interfaces:**
- Consumes: existing study save payload tests
- Produces: explicit regression guard that profile prefs do not enter saved study views

- [ ] **Step 1: Strengthen study no-indicator-state tests**

In `frontend/src/studyViews/studySaveCommand.test.ts`, where the request body is asserted, add:

```ts
    expect('indicator_state' in command!.request).toBe(false);
    expect('panePrefsByTimeframe' in command!.request).toBe(false);
```

In `frontend/src/studyViews/LiveStudyViewSaveButton.test.tsx`, add:

```ts
  expect('indicator_state' in body).toBe(false);
  expect('panePrefsByTimeframe' in body).toBe(false);
```

In `tests/api/test_study_views.py`, add next to the existing assertion:

```py
    assert "panePrefsByTimeframe" not in created
```

- [ ] **Step 2: Run study tests**

Run:

```bash
npm test -- --run \
  src/studyViews/studySaveCommand.test.ts \
  src/studyViews/LiveStudyViewSaveButton.test.tsx
pytest tests/api/test_study_views.py -q
```

Expected: PASS.

- [ ] **Step 3: Update spec status**

Modify `docs/superpowers/specs/2026-07-05-indicator-pane-timeframe-profiles-design.md`:

```md
**Status**: Approved for implementation
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/studyViews/LiveStudyViewSaveButton.test.tsx frontend/src/studyViews/studySaveCommand.test.ts tests/api/test_study_views.py docs/superpowers/specs/2026-07-05-indicator-pane-timeframe-profiles-design.md
git commit -m "test: guard study views from indicator pane state"
```

---

### Task 8: Full Verification

**Files:**
- No source files unless verification exposes failures

**Interfaces:**
- Consumes: all prior task outputs
- Produces: green focused suite and build

- [ ] **Step 1: Run focused frontend tests**

Run:

```bash
npm test -- --run \
  src/live/indicators/indicatorPaneProfiles.test.ts \
  src/state/liveIndicatorsPersistence.test.ts \
  src/live/LiveChartRoot.paneToggles.test.tsx \
  src/live/PaneLegendOverlay.test.tsx \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/live/LivePage.test.tsx \
  src/studyViews/StudyPage.test.tsx \
  src/studyViews/studySaveCommand.test.ts \
  src/studyViews/LiveStudyViewSaveButton.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run backend study API test**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual verification checklist**

Use a local dev server if this project normally requires it:

```bash
npm run dev
```

Verify:

- Open `/live` on a stock in `1m`; open Indicator Panel; turn `호가비` off under `분봉`; confirm ratio pane disappears.
- Switch to `D`; turn `거래량` off under `일봉`; confirm volume disappears but hoga panes do not appear on `/live` D.
- Switch back to `1m`; confirm volume and other minute panes are unchanged.
- Open a `/study` daily saved view; confirm it follows the current `일봉` profile and not any saved indicator state.
- In `/study` daily, close `거래량` from Pane Legend; confirm `/live` daily also has volume off and `/live` minute remains unchanged.

- [ ] **Step 5: Commit verification-only fixes if any**

If verification required fixes:

```bash
git add frontend/src/live frontend/src/state frontend/src/studyViews tests/api docs/superpowers/specs/2026-07-05-indicator-pane-timeframe-profiles-design.md
git commit -m "fix: stabilize indicator pane profiles"
```

If no fixes were needed, do not create an empty commit.
