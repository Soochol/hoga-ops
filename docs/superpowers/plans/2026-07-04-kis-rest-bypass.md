# KIS REST Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared KIS REST bypass toggle in toast and Settings so live/study charts skip KIS REST candle calls and use stored-data fallback.

**Architecture:** A persisted frontend store owns the bypass flag and failure notification timestamp. Live/study query orchestration reads that store to disable KIS candle queries and force existing `/api/range` fallback. A global toast host and Settings row share the same toggle.

**Tech Stack:** React 18, Zustand, TanStack Query, Vitest, Testing Library, FastAPI backend warning payloads.

## Global Constraints

- Do not label transport failures as "점검중"; use "KIS 연결 불가".
- The toast and Settings must control the same persisted state.
- When bypass is ON, KIS REST candle queries must be disabled.
- Reuse existing `SettingsRow` and `ToggleSwitch` UI.
- Write failing tests before production code.

---

### Task 1: Persisted Bypass Store

**Files:**
- Create: `frontend/src/state/kisRestMode.ts`
- Test: `frontend/src/state/kisRestMode.test.ts`

**Interfaces:**
- Produces: `useKisRestModeStore`, `KIS_REST_FAILURE_TOAST_COOLDOWN_MS`, `kisRestWarningIndicatesUnavailable(warning)`.

- [ ] **Step 1: Write failing tests**

Add tests for default OFF, localStorage persistence, failure timestamp cooldown, and warning classification.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd frontend && npm test -- src/state/kisRestMode.test.ts --run`

- [ ] **Step 3: Implement store**

Use the same localStorage pattern as `candleDataPreference.ts`.

- [ ] **Step 4: Run tests and verify pass**

Run: `cd frontend && npm test -- src/state/kisRestMode.test.ts --run`

### Task 2: KIS Unavailable Toast

**Files:**
- Create: `frontend/src/live/KisRestUnavailableToastHost.tsx`
- Test: `frontend/src/live/KisRestUnavailableToastHost.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useKisRestModeStore`.
- Produces: global toast mounted in `App`.

- [ ] **Step 1: Write failing tests**

Render host, trigger `notifyFailure`, assert toast text and switch toggle state; click switch and assert store updates.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd frontend && npm test -- src/live/KisRestUnavailableToastHost.test.tsx --run`

- [ ] **Step 3: Implement toast host and mount it**

Use fixed top-right styling beside existing signal toasts.

- [ ] **Step 4: Run tests and verify pass**

Run: `cd frontend && npm test -- src/live/KisRestUnavailableToastHost.test.tsx --run`

### Task 3: Settings Toggle

**Files:**
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`

**Interfaces:**
- Consumes: `useKisRestModeStore`.

- [ ] **Step 1: Write failing test**

Open data-source settings, assert `KIS API 우회` switch reflects and updates the shared store.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd frontend && npm test -- src/live/LiveSettingsSections.test.tsx --run`

- [ ] **Step 3: Add SettingsRow**

Place it near KIS candle data-source controls.

- [ ] **Step 4: Run tests and verify pass**

Run: `cd frontend && npm test -- src/live/LiveSettingsSections.test.tsx --run`

### Task 4: Query Gating and Fallback

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/studyViews/useStudyReferenceBundle.ts`
- Tests: existing focused hook tests under `frontend/src/live` and `frontend/src/studyViews`

**Interfaces:**
- Consumes: `kisRestBypassEnabled`.

- [ ] **Step 1: Write failing tests**

Assert bypass ON disables KIS candle query inputs and forces range fallback for live minute charts.

- [ ] **Step 2: Run tests and verify failure**

Run relevant Vitest files.

- [ ] **Step 3: Implement query gating and warning notification**

Disable KIS candle queries by passing null inputs when bypass is enabled; set fallback needed while bypass is enabled.

- [ ] **Step 4: Run targeted tests and build**

Run targeted Vitest files, then `cd frontend && npm run build`.
