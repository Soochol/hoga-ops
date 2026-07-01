# Candles Always On Top Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global chart setting named `캔들이 항상 위` that lets `/live` and `/study` draw candle bodies above candle-pane overlays.

**Architecture:** Reuse the existing `chartPrefs` registry so the setting appears in the Settings modal's `차트` section and persists as a shared chart preference. Pass the preference into `RangeSeriesPane`; when enabled for the candle pane, create non-candle overlay series first and the candlestick primary series last so lightweight-charts paints candles on top.

**Tech Stack:** React, TypeScript, Zustand, lightweight-charts, Vitest.

## Global Constraints

- The setting is a common global chart preference shared by `/live` and `/study`.
- The UI label must be `캔들이 항상 위`.
- The setting must live under the Settings modal `차트` menu.
- Follow the existing `CHART_TOGGLES` registry pattern.

---

### Task 1: Add Preference And Draw Order

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`
- Modify: `frontend/src/chart/RangeSeriesPane.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Test: `frontend/src/chart/RangeSeriesPane.test.tsx`

**Interfaces:**
- Consumes: `useChartPrefsStore((s) => s.candleAlwaysOnTop)`
- Produces: `RangeSeriesPane` prop `candleAlwaysOnTop?: boolean`

- [x] **Step 1: Write the failing test**

Add a test that renders a candle pane with two series and verifies that `candleAlwaysOnTop` creates the secondary series before the primary candlestick series while preserving `onPrimarySeriesReady`.

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- RangeSeriesPane.test.tsx`
Expected: FAIL because `RangeSeriesPane` has no `candleAlwaysOnTop` prop and still creates series in spec order.

- [x] **Step 3: Write minimal implementation**

Add `candleAlwaysOnTop` to `CHART_TOGGLES`, wire it from `LiveChartRoot`, and make `RangeSeriesPane` use a render-order mapping only for `spec.name === 'candle'`.

- [x] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- RangeSeriesPane.test.tsx`
Expected: PASS.

- [x] **Step 5: Run focused preference tests**

Run: `cd frontend && npm test -- LiveSettingsSections.test.tsx`
Expected: PASS and the Settings modal registry renders the new chart toggle.
