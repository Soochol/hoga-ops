# Live Peak Wall Trailing Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place today/live peak-wall labels in the right empty chart padding, attached to each line's endpoint instead of a fixed pane-right lane.

**Architecture:** Extend the docked label payload with `time1` so the label primitive can convert the live segment endpoint to an x-coordinate. Keep drawing inside `PeakWallDockedLabelsPrimitive`, but compute candidate `xRight` from `timeToCoordinate(time1) + label width + gap` and hide labels that would not fit in the right padding.

**Tech Stack:** TypeScript, lightweight-charts primitives, Vitest.

## Global Constraints

- Labels must not draw over candles.
- Labels must stay in the right empty chart padding area.
- Labels remain hidden when the live segment is outside the visible range.
- Historical inline labels keep existing behavior.
- Ask and bid labels use the same helper path.

---

### Task 1: Trailing Label Candidate Placement

**Files:**
- Modify: `frontend/src/chart/AskPeakSegmentsPrimitive.ts`
- Modify: `frontend/src/chart/PeakWallDockedLabelsPrimitive.ts`
- Test: `frontend/src/chart/PeakWallDockedLabelsPrimitive.test.ts`
- Test: `frontend/src/chart/AskPeakSegmentsPrimitive.test.ts`

**Interfaces:**
- Consumes: `PeakWallDockedLabelInput` with `time1: Time`
- Produces: `peakWallDockedLabelCandidates(labels, priceToY, timeToX, paneRight, measureText)`

- [x] **Step 1: Write failing tests**

Add tests proving a label sits after `time1` when enough right padding exists and is hidden when it would overlap the candle area or overflow the pane.

- [x] **Step 2: Run red test**

Run: `cd frontend && npm test -- PeakWallDockedLabelsPrimitive.test.ts AskPeakSegmentsPrimitive.test.ts`

Expected: fail until the helper accepts `time1` and endpoint-based x placement.

- [x] **Step 3: Implement minimal placement**

Add `time1` to `PeakWallDockedLabel`, map it from live segments, and compute label `xRight` using the segment endpoint plus a small gap.

- [x] **Step 4: Verify**

Run:

```bash
cd frontend && npm test -- AskPeakSegmentsPrimitive.test.ts PeakWallDockedLabelsPrimitive.test.ts LiveAskPeakSegments.test.tsx LiveChartRoot.paneToggles.test.tsx
cd frontend && npm run build
```

- [x] **Step 5: Commit**

Commit message: `fix: attach live peak labels to line ends`
