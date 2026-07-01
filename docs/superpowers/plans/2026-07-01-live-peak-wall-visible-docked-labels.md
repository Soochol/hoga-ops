# Live Peak Wall Visible Docked Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide today/live docked peak-wall labels when their source segment is outside the current chart viewport.

**Architecture:** Keep the primitive drawing unchanged. Add a pure filter in `AskPeakSegmentsPrimitive.ts` so the React overlay can pass the current visible range when converting ask/bid segments into docked labels.

**Tech Stack:** React, TypeScript, lightweight-charts, Vitest.

## Global Constraints

- Only today/live docked labels are affected.
- Historical inline labels keep existing behavior.
- Ask and bid docked labels use the same helper.
- Null visible range preserves current output.

---

### Task 1: Visible-Range Filter For Docked Labels

**Files:**
- Modify: `frontend/src/chart/AskPeakSegmentsPrimitive.ts`
- Test: `frontend/src/chart/AskPeakSegmentsPrimitive.test.ts`
- Modify: `frontend/src/live/LivePeakWallDockedLabels.tsx`

**Interfaces:**
- Consumes: `AskPeakSegment` and `IRange<Time> | null`
- Produces: `livePeakWallDockedLabelsFromSegments(segments, visibleRange?)`

- [x] **Step 1: Write failing tests**

Add tests proving live docked labels are visible only while the segment overlaps the visible range, and remain visible when the range is null.

- [x] **Step 2: Run red test**

Run: `cd frontend && npm test -- AskPeakSegmentsPrimitive.test.ts`

Expected: fail because `livePeakWallDockedLabelsFromSegments` does not accept or apply visible range filtering.

- [x] **Step 3: Implement minimal filter**

Add a small overlap helper in `AskPeakSegmentsPrimitive.ts`, make `visibleRange` optional, and keep null-range behavior unchanged.

- [x] **Step 4: Wire React overlay**

Pass `visibleRange` from `LivePeakWallDockedLabels.tsx` into both ask and bid calls to `livePeakWallDockedLabelsFromSegments`.

- [x] **Step 5: Verify**

Run:

```bash
cd frontend && npm test -- AskPeakSegmentsPrimitive.test.ts PeakWallDockedLabelsPrimitive.test.ts LiveAskPeakSegments.test.tsx LiveChartRoot.paneToggles.test.tsx
cd frontend && npm run build
```

- [x] **Step 6: Commit**

Commit message: `fix: hide live peak labels outside viewport`
