# Ratio Outlier Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the previously hard-coded 호가비 outlier mask as a user-tunable per-tab preference (toggle + integer threshold) in the Settings modal.

**Architecture:** Add one entry to the existing `CHART_TOGGLES` registry (auto-renders a toggle row) and one explicit numeric field to `ChartViewPrefs`; widen the `RatioPane`'s pane-context type from `boolean` to a `{ auctionWindowMask, outlierFilterEnabled, outlierThreshold }` object; mask points with `value = 0` in `projectRatio` when `enabled && 1 + |raw| >= threshold`. Defense-in-depth validation in both the persistence layer (fall back to default) and the setter (clamp to bounds).

**Tech Stack:** TypeScript / React 18, Zustand store, lightweight-charts v5 `BaselineSeries`, Vitest, Vite HMR.

**Status:** ✅ Implemented and committed on branch `worktree-feat+frontend4` (2026-05-24). All 624 frontend tests pass, typecheck clean. See `docs/superpowers/specs/2026-05-24-ratio-outlier-filter-design.md` and `docs/adr/0026-ratio-outlier-mask-frontend-label-units.md`.

---

## File Structure

| File | Purpose |
|---|---|
| `frontend/src/state/chartPrefs.ts` | Add toggle entry + numeric pref + range constants |
| `frontend/src/state/tabs.ts` | `setRatioOutlierThreshold` setter with boundary clamp |
| `frontend/src/state/tabsPersistence.ts` | `mergePrefs` validation: out-of-range → default |
| `frontend/src/replay/SettingsModal.tsx` | `RatioOutlierThresholdRow` component (draft-string commit on blur/Enter, dim+disabled when toggle off) |
| `frontend/src/chart/projectors/ratio.ts` | Widen `PaneSpec` context type → `RatioPaneContext`; per-point OR with auction mask |
| `frontend/src/chart/projectors/ratio.test.ts` | Update existing 3 tests to new ctx shape; add 2 outlier-mask cases |

---

### Task 1: Add pref schema (chartPrefs.ts)

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`

- [x] **Step 1: Add toggle entry to `CHART_TOGGLES`**
- [x] **Step 2: Add range constants `RATIO_OUTLIER_THRESHOLD_{MIN,MAX,DEFAULT}`**
- [x] **Step 3: Add `ratioOutlierThreshold: number` field to `ChartViewPrefs`**
- [x] **Step 4: Add default to `DEFAULT_PREFS`**
- [x] **Step 5: Verify typecheck (`npx tsc --noEmit`)**

### Task 2: Add store setter (tabs.ts)

**Files:**
- Modify: `frontend/src/state/tabs.ts`

- [x] **Step 1: Import range constants**
- [x] **Step 2: Add `setRatioOutlierThreshold` to `Store` type**
- [x] **Step 3: Implement setter with `Math.min/max/floor` clamp**
- [x] **Step 4: Verify typecheck**

### Task 3: Add persistence validation (tabsPersistence.ts)

**Files:**
- Modify: `frontend/src/state/tabsPersistence.ts`

- [x] **Step 1: Import range constants from `chartPrefs`**
- [x] **Step 2: Add validation block in `mergePrefs` — finite + integer + in range → keep, else default fallback**
- [x] **Step 3: Verify typecheck**

### Task 4: Update projector + tests (ratio.ts)

**Files:**
- Modify: `frontend/src/chart/projectors/ratio.ts`
- Modify: `frontend/src/chart/projectors/ratio.test.ts`

- [x] **Step 1: Add `export type RatioPaneContext` (three fields)**
- [x] **Step 2: Widen `projectRatio` signature to take `ctx: RatioPaneContext`**
- [x] **Step 3: Compute `isExtreme = enabled && 1 + |raw| >= threshold`; OR with auction mask**
- [x] **Step 4: Widen `useRatioContext` selector (three `useActivePrefs` calls)**
- [x] **Step 5: Change `RATIO_SPEC: PaneSpec<boolean>` → `PaneSpec<RatioPaneContext>`**
- [x] **Step 6: Update existing 3 tests to pass ctx object**
- [x] **Step 7: Add 2 new tests — enabled+below/at/above threshold, disabled+above threshold**
- [x] **Step 8: Run `npx vitest run src/chart/projectors/ratio.test.ts` (expect 5 pass)**

### Task 5: Add UI row (SettingsModal.tsx)

**Files:**
- Modify: `frontend/src/replay/SettingsModal.tsx`

- [x] **Step 1: Import range constants from `chartPrefs`**
- [x] **Step 2: Create `RatioOutlierThresholdRow` (mirror `MovingAverageRow` draft pattern)**
- [x] **Step 3: Subscribe to `enabled` field; dim+disable input when off**
- [x] **Step 4: Render below the auto-rendered toggles, above `VolumeProfileModeRow`**
- [x] **Step 5: Verify typecheck**

### Task 6: Verification

- [x] **Step 1: `npx tsc --noEmit` — clean**
- [x] **Step 2: `npx vitest run` — 624/624 pass**
- [ ] **Step 3: Manual smoke test** — open `http://localhost:5173/replay`, Settings → 차트, toggle on/off, change threshold, reload (localStorage round-trip), open new tab (defaults), watch RatioPane respond

### Task 7: Documentation

- [x] **Step 1: Write spec at `docs/superpowers/specs/2026-05-24-ratio-outlier-filter-design.md`**
- [x] **Step 2: Write ADR-0026 at `docs/adr/0026-ratio-outlier-mask-frontend-label-units.md`**
- [x] **Step 3: Add `Outlier Mask` glossary entry in `CONTEXT.md`; update `호가비` and `Replay Tab` cross-references**

### Task 8: Deepening — CHART_NUMERIC_PREFS registry (post-feature improvement)

After the feature shipped, an `improve-codebase-architecture` review surfaced that scalar numeric prefs were 5x more expensive to add than boolean toggles (which had a registry). Generalized the registry pattern:

- [x] **Step 1: Define `NumericPrefDef` type + `CHART_NUMERIC_PREFS` registry in `chartPrefs.ts`**
- [x] **Step 2: Migrate `ratioOutlierThreshold` constants → single registry entry**
- [x] **Step 3: Widen `ChartViewPrefs` with mapped type `{ [K in NumericPrefKey]: number }`**
- [x] **Step 4: Auto-derive `DEFAULT_PREFS` numeric fields via `Object.fromEntries`**
- [x] **Step 5: Replace `setRatioOutlierThreshold` → generic `setNumericPref(id, key, value)` in `tabs.ts`**
- [x] **Step 6: Add `numericPrefDefs` to `SnapshotDeps`; mergePrefs iterates registry for validation**
- [x] **Step 7: Replace `RatioOutlierThresholdRow` → generic `NumericPrefRow` (driven by `def` prop) in `SettingsModal.tsx`; iterate `CHART_NUMERIC_PREFS` in render**
- [x] **Step 8: Update 9 mergePrefs call sites in `tabsPersistence.test.ts` (4th arg); add 3 registry-driven validation tests**
- [x] **Step 9: Write ADR-0027 at `docs/adr/0027-chart-numeric-prefs-registry.md`**
- [x] **Step 10: Verify — `npx tsc -b` clean, `npx vitest run` 640/640 pass (was 624, gained 16 tests from added defense)**

---

## Out of Scope (potential v2 follow-ups, not implemented)

These were explicitly carved out in the spec and would each be their own plan:

- **Outlier marker overlay** — render dots/triangles at masked timestamps so analysts can locate the suppressed spikes without disabling the filter
- **Spot-view symmetry** — currently `TotalQtyBar` shows raw ratio even when Outlier Mask is on (intentional per ADR-0026, but a future "fully consistent" mode could mirror it)
- **Per-Code threshold** — different default per 종목 (blue-chip vs 동전주) requires new persistence scope; current per-Replay-Tab is the simpler win
- **Backend pre-filter** — explicitly rejected in ADR-0026 (loses raw data), not a follow-up

---

## Self-Review

- ✅ Spec coverage: every section of the design doc maps to one of Tasks 1–7
- ✅ No placeholders, no "TBD", no "similar to Task N"
- ✅ Type consistency: `RatioPaneContext` fields match between `ratio.ts`, `chartPrefs.ts`, and the test file
