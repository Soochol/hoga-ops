# Adaptive TradingView-style x-axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/live` minute chart's x-axis auto-switch tick tiers by zoom level (month → day → time, TradingView-style), by fixing weight computation at the chart library's official extension point.

**Architecture:** Subclass lightweight-charts' `defaultHorzScaleBehavior()` and override `fillWeightsForPoints` so tick weights are computed from **real KST dates** (via `axisRef.current.toReal`) instead of the gap-compressed virtual-1970 calendar. Switch `createChart` → `createChartEx` to inject the behavior. Simplify `tickMarkFormatter` to trust the now-correct `tickType`, and remove the DayBoundaryOverlay MM/DD chip (the axis owns dates now). The override uses only public fields (`originalTime` read, `timeWeight` write) so it survives production minification.

**Tech Stack:** React, TypeScript, lightweight-charts 5.2.0, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-30-adaptive-x-axis-design.md`

---

## File Structure

- **Create** `frontend/src/util/kstHorzScaleBehavior.ts` — the behavior subclass + weight ladder. One responsibility: map virtual-axis points to real-KST tick weights. Depends on `lightweight-charts` (`defaultHorzScaleBehavior`) and `VirtualAxis`.
- **Create** `frontend/src/util/kstHorzScaleBehavior.test.ts` — unit tests for weight assignment at month/day/intraday boundaries.
- **Modify** `frontend/src/live/LiveChartRoot.tsx` — `createChartEx` injection + `tickMarkFormatter` simplification.
- **Modify** `frontend/src/live/LiveChartRoot.test.tsx` — rewrite the x-axis tickMarkFormatter suite (old behavior was the workaround being removed); fix the mock + capture index for `createChartEx`.
- **Modify** `frontend/src/chart/DayBoundaryOverlay.tsx` — remove MM/DD chip span, keep the dashed vertical line.

> **Concurrent-agent safety (project memory):** This worktree may have other agents active. Before EVERY commit, run `git status --porcelain` and `git add` ONLY the exact files this plan touches. Never `git add -A` / `git add .`. There is currently an untracked `docs/superpowers/specs/2026-05-30-live-symbol-search-design.md` from another session — do not stage it.

---

## Task 1: KST horizontal-scale behavior (the core)

**Files:**
- Create: `frontend/src/util/kstHorzScaleBehavior.ts`
- Test: `frontend/src/util/kstHorzScaleBehavior.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/util/kstHorzScaleBehavior.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createVirtualAxis, type VirtualAxis } from './virtualAxis';
import { createKstHorzScaleBehavior } from './kstHorzScaleBehavior';

// KST 09:00 == UTC 00:00. Date.UTC(2026, 4, 27) => 2026-05-27 09:00 KST.
const SESSION_LEN = 6.5 * 3600 * 1000;
const open = (m: number, d: number) => Date.UTC(2026, m, d, 0, 0, 0);

// Four sessions: 5/27, 5/28, 5/29 (Fri), 6/1 (Mon — weekend skipped). The
// 5/29→6/1 step is the month boundary; 5/27→5/28 and 5/28→5/29 are day
// boundaries.
const RAW = [
  { date: '20260527', sessionOpenMs: open(4, 27), sessionCloseMs: open(4, 27) + SESSION_LEN },
  { date: '20260528', sessionOpenMs: open(4, 28), sessionCloseMs: open(4, 28) + SESSION_LEN },
  { date: '20260529', sessionOpenMs: open(4, 29), sessionCloseMs: open(4, 29) + SESSION_LEN },
  { date: '20260601', sessionOpenMs: open(5, 1), sessionCloseMs: open(5, 1) + SESSION_LEN },
];

// A point as lightweight-charts hands it to fillWeightsForPoints: only
// `originalTime` (the virtual seconds we fed as candle `time`) is read; we
// assert on the `timeWeight` the behavior writes back.
function point(axis: VirtualAxis, realMs: number) {
  return { originalTime: axis.toVirtual(realMs) / 1000, timeWeight: -1 };
}

// MutableRef shim — the factory only reads `.current`.
function ref<T>(value: T) {
  return { current: value };
}

describe('createKstHorzScaleBehavior — fillWeightsForPoints', () => {
  const axis = createVirtualAxis(RAW);
  const behavior = createKstHorzScaleBehavior(ref(axis));

  it('assigns Month weight (60) across a real KST month boundary', () => {
    const pts = [
      point(axis, open(4, 29)), // 5/29 09:00
      point(axis, open(5, 1)),  // 6/1 09:00  ← month changes
    ];
    behavior.fillWeightsForPoints(pts as never, 0);
    expect(pts[1].timeWeight).toBe(60);
  });

  it('assigns Day weight (50) across a real KST day boundary', () => {
    const pts = [
      point(axis, open(4, 27)), // 5/27 09:00
      point(axis, open(4, 28)), // 5/28 09:00 ← day changes, same month
    ];
    behavior.fillWeightsForPoints(pts as never, 0);
    expect(pts[1].timeWeight).toBe(50);
  });

  it('assigns Minute1 weight (20) within a session', () => {
    const pts = [
      point(axis, open(4, 27)),              // 5/27 09:00
      point(axis, open(4, 27) + 60_000),     // 5/27 09:01 ← 1-minute step
    ];
    behavior.fillWeightsForPoints(pts as never, 0);
    expect(pts[1].timeWeight).toBe(20);
  });

  it('falls back to the base behavior when the axis is empty (loading)', () => {
    const emptyBehavior = createKstHorzScaleBehavior(ref(createVirtualAxis([])));
    const pts = [
      { originalTime: 0, timeWeight: -1 },
      { originalTime: 60, timeWeight: -1 },
    ];
    // Must not throw and must overwrite the sentinel via the base impl.
    emptyBehavior.fillWeightsForPoints(pts as never, 0);
    expect(pts[1].timeWeight).not.toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/util/kstHorzScaleBehavior.test.ts`
Expected: FAIL — `Failed to resolve import "./kstHorzScaleBehavior"` (module not created yet).

- [ ] **Step 3: Write the implementation**

Create `frontend/src/util/kstHorzScaleBehavior.ts`:

```ts
import { defaultHorzScaleBehavior } from 'lightweight-charts';
import type { MutableRefObject } from 'react';
import type { VirtualAxis } from './virtualAxis';

const KST_OFFSET_MS = 9 * 3600_000;

/**
 * Mirror of lightweight-charts' TickMarkWeight ladder, ascending by divisor.
 * Calendar tiers (Year/Month/Day) are handled separately by getUTC* equality;
 * these intraday tiers compare `Math.floor(getTime() / divisor)`. We feed a
 * KST-shifted Date, so the floor buckets align to KST hour/minute edges.
 */
const INTRADAY: ReadonlyArray<{ divisorMs: number; weight: number }> = [
  { divisorMs: 1000, weight: 10 }, // Second
  { divisorMs: 60_000, weight: 20 }, // Minute1
  { divisorMs: 300_000, weight: 21 }, // Minute5
  { divisorMs: 1_800_000, weight: 22 }, // Minute30
  { divisorMs: 3_600_000, weight: 30 }, // Hour1
  { divisorMs: 10_800_000, weight: 31 }, // Hour3
  { divisorMs: 21_600_000, weight: 32 }, // Hour6
  { divisorMs: 43_200_000, weight: 33 }, // Hour12
];

/** Port of lightweight-charts' `weightByTime`, but over real KST dates. */
function weightByKstDate(cur: Date, prev: Date): number {
  if (cur.getUTCFullYear() !== prev.getUTCFullYear()) return 70; // Year
  if (cur.getUTCMonth() !== prev.getUTCMonth()) return 60; // Month
  if (cur.getUTCDate() !== prev.getUTCDate()) return 50; // Day
  for (let i = INTRADAY.length - 1; i >= 0; i--) {
    const d = INTRADAY[i].divisorMs;
    if (Math.floor(prev.getTime() / d) !== Math.floor(cur.getTime() / d)) {
      return INTRADAY[i].weight;
    }
  }
  return 0; // LessThanSecond
}

/**
 * A horizontal-scale behavior whose tick weights follow the REAL KST calendar
 * instead of the gap-compressed virtual-1970 calendar the library would infer
 * from our virtual-second candle times. This revives native zoom-adaptive tier
 * selection (month → day → time) on the Virtual Axis.
 *
 * Load-bearing constraint: reads ONLY the public `originalTime` field (= the
 * virtual seconds we fed as candle `time`) and writes ONLY the public
 * `timeWeight` field. Internal fields are minified (`_internal_timestamp` →
 * `.Sf` in the production bundle), so touching them would break `vite build`.
 */
export function createKstHorzScaleBehavior(axisRef: MutableRefObject<VirtualAxis>) {
  const Base = defaultHorzScaleBehavior();
  class KstHorzScaleBehavior extends Base {
    // Loose signature: base wants `readonly Mutable<TimeScalePoint>[]` but
    // `Mutable` isn't exported and `TimeScalePoint.timeWeight` is readonly in
    // the public typings. `readonly unknown[]` is wider (contravariant-OK) and
    // we cast internally to the minimal shape we actually use.
    fillWeightsForPoints(points: readonly unknown[], startIndex: number): void {
      const axis = axisRef.current;
      // Loading: no segments yet → defer to the library's default weights so
      // nothing crashes before the real axis arrives.
      if (axis.segments.length === 0) {
        super.fillWeightsForPoints(points as never, startIndex);
        return;
      }
      const pts = points as Array<{ readonly originalTime: unknown; timeWeight: number }>;
      const kst = (p: { readonly originalTime: unknown }): Date =>
        new Date(axis.toReal((p.originalTime as number) * 1000) + KST_OFFSET_MS);

      const begin = Math.max(startIndex, 1);
      for (let i = begin; i < pts.length; i++) {
        pts[i].timeWeight = weightByKstDate(kst(pts[i]), kst(pts[i - 1]));
      }
      // R4: points[0] has no predecessor. Estimate its tier from the NEXT
      // point's real-KST delta (symmetric) rather than the library's
      // virtual-space average, which is meaningless under gap compression.
      if (startIndex === 0 && pts.length >= 2) {
        pts[0].timeWeight = weightByKstDate(kst(pts[1]), kst(pts[0]));
      }
    }
  }
  return new KstHorzScaleBehavior();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/util/kstHorzScaleBehavior.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors. (If `extends Base` complains about the construct signature, the override compiles because `defaultHorzScaleBehavior()` returns `new () => IHorzScaleBehavior<Time>`.)

- [ ] **Step 6: Commit**

```bash
git status --porcelain   # confirm only the two new files are staged below
git add frontend/src/util/kstHorzScaleBehavior.ts frontend/src/util/kstHorzScaleBehavior.test.ts
git commit -m "$(cat <<'EOF'
feat(livechart): KST horizontal-scale behavior for adaptive x-axis weights

Subclass defaultHorzScaleBehavior and override fillWeightsForPoints to
compute tick weights from real KST dates (via axisRef.toReal) instead of
the virtual-1970 calendar. Public fields only (originalTime/timeWeight)
so it survives prod minification.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Inject the behavior + simplify tickMarkFormatter

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (imports ~line 2-8; `createChart` call line 192; `tickMarkFormatter` lines 224-263; `setChart(c)` line 268)
- Modify: `frontend/src/live/LiveChartRoot.test.tsx` (mock lines 21-59; x-axis suite lines 699-768)

- [ ] **Step 1: Rewrite the failing test (x-axis suite)**

In `frontend/src/live/LiveChartRoot.test.tsx`, the existing suite encodes the OLD workaround ("minute axis is always HH:MM"). Replace the entire block from line 699 (`// ----` comment above `describe('LiveChartRoot x-axis tickMarkFormatter'`) through the closing `});` at line 768 with:

```tsx
// ---------------------------------------------------------------------------
// x-axis tickMarkFormatter — adaptive tiers (2026-05-30 redesign)
//
// The chart now injects a KST horizontal-scale behavior (createChartEx) whose
// weights follow the real KST calendar, so lightweight-charts assigns the
// correct TickMarkType at real boundaries. tickMarkFormatter therefore TRUSTS
// tickType: Month→"N월", DayOfMonth→day, Time→HH:MM. Calendar (D/W/M) suppress
// the intraday Time tiers (daily bars are all anchored to 09:00).
//
// Seam: capture tickMarkFormatter from the createChartEx options (3rd arg).
describe('LiveChartRoot x-axis tickMarkFormatter', () => {
  beforeEach(() => {
    vi.mocked(createChartEx).mockClear();
  });

  function captureTickFormatter(timeframe: 'D' | '1m') {
    render(
      <LiveChartRoot
        code="005930"
        timeframe={timeframe}
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    // createChartEx(container, behavior, options) — options is the 3rd arg.
    const opts = vi.mocked(createChartEx).mock.calls[0][2] as {
      timeScale: { tickMarkFormatter: (t: number, k: TickMarkType) => string };
    };
    return opts.timeScale.tickMarkFormatter;
  }

  // virtual second 43201 = segment[1].virtualStart (23401s) + 5.5h (19800s)
  // → real today 14:30 KST (mid-session).
  const MID_SESSION_SEC = 43201;
  // virtual second 0 = segment[0] open = 2026-05-27 09:00 KST.
  const FIRST_OPEN_SEC = 0;

  it('1m: Time tick renders HH:MM', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(MID_SESSION_SEC, TickMarkType.Time)).toBe('14:30');
  });

  it('1m: DayOfMonth tick renders the day number', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.DayOfMonth)).toBe('27');
  });

  it('1m: Month tick renders "N월"', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.Month)).toBe('5월');
  });

  it('D (calendar): DayOfMonth tick keeps its day number', () => {
    const fmt = captureTickFormatter('D');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.DayOfMonth)).toBe('27');
  });

  it('D (calendar): Time tick is suppressed (empty)', () => {
    const fmt = captureTickFormatter('D');
    expect(fmt(MID_SESSION_SEC, TickMarkType.Time)).toBe('');
  });
});
```

- [ ] **Step 2: Update the mock to expose `createChartEx`**

In `frontend/src/live/LiveChartRoot.test.tsx`, the `vi.mock('lightweight-charts', ...)` factory (lines 21-59) currently mocks `createChart`. Change the import on line 18 and the factory so `createChartEx` is the mocked constructor.

Change line 18 from:
```tsx
import { createChart, TickMarkType } from 'lightweight-charts';
```
to:
```tsx
import { createChartEx, TickMarkType } from 'lightweight-charts';
```

In the mock factory (lines 23-58), rename the mocked function key from `createChart:` to `createChartEx:` (the returned chart-object shape stays identical). The opening becomes:
```tsx
  return {
    ...mod,
    createChartEx: vi.fn(() => ({
      addSeries: vi.fn(() => ({
```
Everything inside the returned object (addSeries, timeScale, panes, remove, etc.) is unchanged.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx -t "x-axis tickMarkFormatter"`
Expected: FAIL — `createChartEx` mock has no calls (component still calls `createChart`), so `mock.calls[0]` is undefined.

- [ ] **Step 4: Switch the component to `createChartEx` + inject behavior**

In `frontend/src/live/LiveChartRoot.tsx`, update the import block (lines 2-8) from:
```tsx
import {
  createChart,
  TickMarkType,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
```
to:
```tsx
import {
  createChartEx,
  TickMarkType,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { createKstHorzScaleBehavior } from '../util/kstHorzScaleBehavior';
```

Change the chart construction (line 192) from:
```tsx
    const c = createChart(el, {
```
to:
```tsx
    const c = createChartEx(el, createKstHorzScaleBehavior(axisRef), {
```

Change `setChart(c);` (line 268) to:
```tsx
    setChart(c as IChartApi);
```

> Why the cast: `createChartEx` returns `IChartApiBase<Time>`; `IChartApi` adds only an `applyOptions` overload we never call on the chart. The runtime object is identical to `createChart`'s. The 12 components typed `chart: IChartApi` need no change.

- [ ] **Step 5: Simplify the tickMarkFormatter**

In `frontend/src/live/LiveChartRoot.tsx`, replace the `tickMarkFormatter` body (lines 224-263, the whole `switch (tickType)` block and its comment) with the version below. The KST conversion lines at the top are unchanged; only the per-tick-type logic changes.

```tsx
        tickMarkFormatter: (time: UTCTimestamp, tickType: TickMarkType): string => {
          const virtualMs = (time as number) * 1000;
          const a = axisRef.current;
          if (a.segments.length === 0) return '';
          const realMs = a.toReal(virtualMs);
          const d = new Date(realMs + 9 * 3600_000);
          const calendar = isCalendarTimeframe(timeframeRef.current);
          // Weights now follow the real KST calendar (see kstHorzScaleBehavior),
          // so tickType is trustworthy: month boundaries get Month, day
          // boundaries get DayOfMonth, intraday gets Time. We just format.
          // Calendar (D/W/M) bars are all anchored to 09:00 KST, so their
          // intraday Time tiers carry no meaning and are suppressed.
          const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
          switch (tickType) {
            case TickMarkType.Year:
              return `'${String(d.getUTCFullYear()).slice(-2)}`;
            case TickMarkType.Month:
              return `${d.getUTCMonth() + 1}월`;
            case TickMarkType.DayOfMonth:
              return `${d.getUTCDate()}`;
            case TickMarkType.Time:
              return calendar ? '' : hhmm;
            case TickMarkType.TimeWithSeconds:
              return calendar ? '' : `${hhmm}:${pad(d.getUTCSeconds())}`;
            default:
              return '';
          }
        },
```

- [ ] **Step 6: Run the x-axis suite to verify it passes**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx -t "x-axis tickMarkFormatter"`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the FULL LiveChartRoot suite (catch mock-rename fallout)**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx`
Expected: PASS. If other suites in this file reference `createChart` mock calls (e.g. the initial-view suite via `buildChartMockWithStableTS`), update those `vi.mocked(createChart)` → `vi.mocked(createChartEx)` references too. Search the file: `grep -n "createChart" src/live/LiveChartRoot.test.tsx` and resolve each.

- [ ] **Step 8: Typecheck**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git status --porcelain
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx
git commit -m "$(cat <<'EOF'
feat(livechart): adaptive x-axis via createChartEx + KST behavior

Inject createKstHorzScaleBehavior so tick tiers follow the real KST
calendar, then simplify tickMarkFormatter to trust tickType
(Month→"N월", DayOfMonth→day, Time→HH:MM). Removes the af6966f
"minute axis is always HH:MM" workaround. Calendar timeframes still
suppress the intraday Time tiers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Remove the DayBoundaryOverlay MM/DD chip

**Files:**
- Modify: `frontend/src/chart/DayBoundaryOverlay.tsx`

The axis now owns dates, so the chip is redundant. Keep the dashed vertical line and the `data-day-boundary` attribute (used for debugging/tests). There is no `DayBoundaryOverlay.test.tsx`, so no test rewrite is needed.

- [ ] **Step 1: Remove the chip span**

In `frontend/src/chart/DayBoundaryOverlay.tsx`, delete the `<span>` chip (lines 71-73):

```tsx
            <span className="absolute top-1 left-1 bg-bg-card text-fg-dim text-xs px-1.5 py-0.5 rounded">
              {fmtMD(b.date)}
            </span>
```

The boundary `<div>` becomes self-closing content-free:

```tsx
          <div
            key={b.date}
            data-day-boundary={b.date}
            className="absolute top-0 bottom-0 w-px"
            style={{
              transform: `translateX(${b.x as number}px)`,
              backgroundImage: `repeating-linear-gradient(to bottom, ${boundary} 0 3px, transparent 3px 6px)`,
            }}
          />
```

- [ ] **Step 2: Remove the now-unused `fmtMD` helper**

Delete lines 13-15:

```tsx
function fmtMD(yyyymmdd: string): string {
  return `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`;
}
```

- [ ] **Step 3: Typecheck + lint (catch unused imports/vars)**

Run: `cd frontend && npx tsc -b --noEmit && npx eslint src/chart/DayBoundaryOverlay.tsx`
Expected: no errors. If `resolveTokens`/`TOKEN_SPEC`/`boundary` are still used by the line's `backgroundImage`, they stay; only `fmtMD` should have become unused.

- [ ] **Step 4: Commit**

```bash
git status --porcelain
git add frontend/src/chart/DayBoundaryOverlay.tsx
git commit -m "$(cat <<'EOF'
refactor(livechart): drop Day Boundary MM/DD chip — axis owns dates now

The adaptive x-axis renders date/month labels at real session
boundaries, so the chip is redundant. Keep the dashed vertical line.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Integration verification (R1 spike, build, manual)

**Files:** none (verification only). This task validates the spec's open risks against the running app.

- [ ] **Step 1: R1 de-risking spike — instrument the override**

Temporarily add a log to `frontend/src/util/kstHorzScaleBehavior.ts` inside `fillWeightsForPoints`, right after `const pts = points as ...`:

```ts
      // TEMP R1 probe — remove before final commit.
      console.log('[kst-weights]', { startIndex, len: pts.length,
        first: pts[0]?.originalTime, last: pts[pts.length - 1]?.originalTime });
```

- [ ] **Step 2: Start dev servers**

Backend (per CLAUDE.md "Dev servers"):
```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```
Frontend:
```bash
cd frontend && npm run dev
```

- [ ] **Step 3: Observe startIndex on lazy-fetch**

Using `/browse` (set `B=/home/dev/.claude/skills/gstack/browse/dist/browse`):
```bash
$B goto http://localhost:5173/live
$B console            # watch [kst-weights] logs
```
Scroll the chart left past the leftmost loaded candle to trigger the lazy-fetch extension. Read the logs:
- If every `[kst-weights]` has `startIndex: 0` → full recompute always; "stale weight" (R1) cannot occur. Proceed.
- If a log shows `startIndex > 0` after an extension AND earlier ticks keep stale labels → apply the R1 fix: in `fillWeightsForPoints`, ignore the incoming `startIndex` and always recompute from index 1 (change `const begin = Math.max(startIndex, 1)` to `const begin = 1`, and run the points[0] block whenever `pts.length >= 2`). Re-verify.

Record the observed behavior in the commit message of Step 8.

- [ ] **Step 4: Visual check — minute chart adaptive tiers**

```bash
$B goto http://localhost:5173/live
$B console --errors        # expect none
```
Confirm by inspecting the chart (`$B snapshot -i` / screenshot):
- Default zoom: time labels (`09:30`…) within the session, a day number at each day boundary, `N월` at month boundaries.
- Wheel zoom OUT: time labels thin out, leaving day/month labels (tier transition).
- Wheel zoom IN: time labels return.
- The dashed vertical day-boundary lines remain; the MM/DD chip is gone.

- [ ] **Step 5: (REQUIRED GATE — R3) D/W/M timeframes**

Switch to D, then W, then M. For each:
- Date/month labels render; no spurious `09:00` time label appears.
- Zoom adaptation (day ↔ month) works.
- Toggle timeframe back and forth several times — labels are correct immediately (no 1-frame stale, R2).

- [ ] **Step 6: Live + lazy-fetch + layout regression**

- With a live WebSocket tick streaming (ADR-0053 single WS), axis labels stay stable as candles append.
- After a lazy-fetch extension, date/month labels sit at the correct boundaries.
- Right price-scale width and bar spacing look unchanged from before the `createChartEx` switch.

- [ ] **Step 7: Remove the probe + run the full test suite**

Delete the TEMP R1 probe from Step 1.
Run: `cd frontend && npx vitest run`
Expected: PASS (whole frontend suite).

- [ ] **Step 8: Production-build verification (proves minification safety)**

```bash
cd frontend && npm run build && npm run preview
```
Then point `/browse` at the preview URL (printed by `npm run preview`, typically `http://localhost:4173/live`) and repeat Steps 4-5. This exercises the **minified** bundle where `_internal_timestamp` → `.Sf`; because the override only touches public `originalTime`/`timeWeight`, the adaptive labels must render identically to dev. `$B console --errors` must be empty.

- [ ] **Step 9: Commit (probe removal, if the file changed)**

```bash
git status --porcelain
git add frontend/src/util/kstHorzScaleBehavior.ts
git commit -m "$(cat <<'EOF'
chore(livechart): remove R1 weight probe after verification

Verified: <fill in — "lazy-fetch calls fillWeightsForPoints with
startIndex 0 (full recompute)" OR "applied startIndex-ignore fix">.
Production build (minified bundle) renders adaptive labels correctly.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Adaptive month/day/time tiers → Task 1 (weights) + Task 2 (formatter). ✓
- createChartEx injection + IChartApi cast → Task 2 Steps 4. ✓
- Remove af6966f workaround → Task 2 Step 5. ✓
- DayBoundaryOverlay: keep line, drop chip → Task 3. ✓
- Public-field-only / prod minification safety → Task 1 impl + Task 4 Step 8 (build verify). ✓
- R1 stale weight → Task 4 Step 3 (spike + conditional fix). ✓
- R2 axisRef timing → Task 4 Step 5. ✓
- R3 calendar gate → Task 4 Step 5 (required gate). ✓
- R4 first-point heuristic → Task 1 impl (symmetric next-point estimate). ✓
- Unit tests (month/day/intraday/calendar) → Task 1 + Task 2 suites. ✓
- Regression test rewrite → Task 2 Step 1. ✓

**Type consistency:** `createKstHorzScaleBehavior(axisRef)` — same name in Task 1 (def), Task 2 (import + call). `fillWeightsForPoints(points, startIndex)` matches the library member. `axisRef` is the existing `MutableRefObject<VirtualAxis>` at LiveChartRoot.tsx:96. `weightByKstDate` is module-private (Task 1 only). Formatter returns `'5월'`/`'27'`/`'14:30'`/`''` — test assertions in Task 2 match exactly.

**Placeholder scan:** No TBD/TODO. The only fill-in is Task 4 Step 9's commit message, which records the empirically-observed R1 outcome (intentional — the result isn't known until the spike runs).
