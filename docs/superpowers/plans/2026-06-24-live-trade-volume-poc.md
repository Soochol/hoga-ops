# Live Trade Volume POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show regular-session most-traded price areas on the minute live chart with selectable automatic +/-0.5% or +/-1% price bands.

**Architecture:** Add a pure reducer that accumulates live trade quantity by price and selects the strongest tick-adjusted band for the selected percentage. Feed that model into a candle-pane overlay primitive, with indicator-panel controls following the existing live indicator preference pattern. Backend range bundles include historical candidates for both supported percentages so past charts update without a refetch.

**Tech Stack:** React, TypeScript, lightweight-charts primitives, Vitest.

## Global Constraints

- Use regular continuous-trading trade events only; exclude auction/special trades.
- Band width is automatic: center price +/-0.5% by default, selectable to +/-1%, adjusted outward to KRX stock ticks.
- Default indicator state is enabled unless the persisted preference is explicitly false.
- Add tests before production behavior changes.

---

### Task 1: Pure POC Reducer

**Files:**
- Create: `frontend/src/live/tradeVolumePoc.ts`
- Test: `frontend/src/live/tradeVolumePoc.test.ts`

**Interfaces:**
- Produces: `computeTradeVolumePoc(trades, options?): TradeVolumePoc | null`
- Produces: `krxStockTickSize(price): number`

- [x] Write tests for regular-trade filtering, +/-0.5% and +/-1% tick-adjusted band boundaries, and tie preservation.
- [x] Run `npm test -- tradeVolumePoc.test.ts` and verify the tests fail because the module is missing.
- [x] Implement the reducer and KRX tick helpers.
- [x] Run `npm test -- tradeVolumePoc.test.ts` and verify the tests pass.

### Task 2: Live Hook and Overlay

**Files:**
- Create: `frontend/src/live/useTradeVolumePoc.ts`
- Create: `frontend/src/live/TradeVolumePocOverlay.tsx`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Test: focused component or root tests for propagation and primitive attachment.

**Interfaces:**
- Consumes: `computeTradeVolumePoc`
- Produces: chart overlay attached to the candle series.

- [x] Write failing tests for hook reset on symbol/day and overlay segment rendering.
- [x] Implement hook and overlay with a dedicated lightweight-charts primitive.
- [x] Run the focused tests.

### Task 3: Indicator UI Toggle

**Files:**
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Test: existing indicator panel and persistence tests.

**Interfaces:**
- Produces: `tradeVolumePocEnabled` persisted active preference.
- Produces: `tradeVolumePocBandPct` persisted band preference.

- [x] Write failing tests that the indicator panel includes `당일 최다거래대`.
- [x] Add default-on preference, panel row, and +/-0.5% / +/-1% segmented control.
- [x] Run focused UI/state tests.

### Task 4: Verification

- [x] Run focused frontend tests touched by the change.
- [x] Run TypeScript check or the repo's frontend validation command if available.
- [x] Summarize files changed and any remaining gaps.
