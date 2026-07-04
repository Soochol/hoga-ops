# Task 6 Report

## Status

Implemented Task 6 frontend ownership changes for KIS REST bypass. The settings panel and the unavailability toast now read and mutate backend live settings instead of treating localStorage or the zustand store as bypass truth.

## Changed files

- `frontend/src/api/liveSettings.ts`
- `frontend/src/api/liveStatus.ts`
- `frontend/src/state/kisRestMode.ts`
- `frontend/src/live/KisRestUnavailableToastHost.tsx`
- `frontend/src/live/LiveSettingsSections.tsx`
- `frontend/src/api/liveSettings.test.ts`
- `frontend/src/state/kisRestMode.test.ts`
- `frontend/src/live/KisRestUnavailableToastHost.test.tsx`
- `frontend/src/live/LiveSettingsSections.test.tsx`
- `frontend/src/live/LiveSettingsModal.test.tsx`
- `frontend/src/live/liveStatusProjection.test.ts`

## What changed

- Added `kis_rest_bypass_enabled` to `LiveSettings` and made `patchLiveSettings` accept partial patches, including bypass-only patches.
- Added `kis_rest_bypass_enabled` to the `LiveStatus` wire type to match backend status payloads.
- Removed bypass truth and persistence ownership from `useKisRestModeStore`; it now keeps only failure/toast timing.
- Added one-way legacy migration helpers for `chart.kisRestMode.v1`.
- Rewired `KisRestUnavailableToastHost` to:
  - read backend settings via the shared query cache,
  - patch backend settings when toggled,
  - migrate legacy local bypass state once,
  - render `KIS REST 우회 중` while bypass is enabled.
- Rewired `LiveSettingsSections` to use backend settings for the bypass toggle while keeping storage-policy patches scoped to changed backend fields.
- Updated focused frontend tests to cover backend-owned toggle flow and legacy migration.
- Applied small adjacent test/type updates required by the new wire fields.

## Verification

- Red phase:
  - `cd frontend && npm test -- --run src/api/liveSettings.test.ts src/state/kisRestMode.test.ts src/live/KisRestUnavailableToastHost.test.tsx src/live/LiveSettingsSections.test.tsx`
  - Result: failed as expected before implementation (`readLegacyKisRestBypass` missing, toast/settings still using store truth).

- Green phase:
  - `cd frontend && npm test -- --run src/api/liveSettings.test.ts src/state/kisRestMode.test.ts src/live/KisRestUnavailableToastHost.test.tsx src/live/LiveSettingsSections.test.tsx`
  - Result: `4 passed, 28 passed`

- Nearby impacted tests:
  - `cd frontend && npm test -- --run src/live/useLiveBundle.test.tsx src/studyViews/useStudyReferenceBundle.test.tsx`
  - Result: `2 passed, 48 passed`

- Final verification slice:
  - `cd frontend && npm test -- --run src/api/liveSettings.test.ts src/state/kisRestMode.test.ts src/live/KisRestUnavailableToastHost.test.tsx src/live/LiveSettingsSections.test.tsx src/live/useLiveBundle.test.tsx src/studyViews/useStudyReferenceBundle.test.tsx`
  - Result: `6 passed, 76 passed`

- Build check:
  - `cd frontend && npm run build`
  - Result: fails in `src/live/useLiveBundle.ts` and `src/studyViews/useStudyReferenceBundle.ts` because those Task 7 hooks still reference `useKisRestModeStore(...kisRestBypassEnabled)`.

## Commit

- Commit hash: `c588b0c578ca364f57ad9c764981a3db865fcbb8`
- Commit message: `feat: make KIS REST bypass backend-owned in UI`

## Concerns

- No open concerns from the Task 6 review fixes after the build-verification rerun.

## Review Fixes

- Fixed the compile break by moving `useLiveBundle` and `useStudyReferenceBundle` off the removed store-owned bypass field and onto backend live settings via `useLiveSettings().data?.kis_rest_bypass_enabled ?? false`.
- Updated the affected hook tests to seed backend-owned live settings instead of seeding removed zustand state.
- Fixed legacy migration durability in `KisRestUnavailableToastHost` so local legacy state is marked migrated only after a successful backend PATCH.
- Added a focused regression test proving failed PATCH does not clear `chart.kisRestMode.v1` and does not mark migration complete.

### Review fix verification

- `cd frontend && npm test -- --run src/api/liveSettings.test.ts src/state/kisRestMode.test.ts src/live/KisRestUnavailableToastHost.test.tsx src/live/LiveSettingsSections.test.tsx`
  - Result: `4 passed, 29 passed`
- `cd frontend && npm test -- --run src/live/useLiveBundle.test.tsx src/studyViews/useStudyReferenceBundle.test.tsx`
  - Result: `2 passed, 48 passed`
- `cd frontend && npm run build`
  - Result: success
