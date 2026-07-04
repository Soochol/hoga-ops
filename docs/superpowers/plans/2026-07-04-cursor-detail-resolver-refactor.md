# Cursor Detail Resolver Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/live` and `/study` share one cursor-detail resolver so the 10호가 and 거래원 cards interpret `cursorMs`, loading, and no-data states identically while keeping page-specific data sources separate.

**Architecture:** Introduce a small pure adapter layer under `frontend/src/sidebar/` that converts cursor state plus page-specific inputs into card props. `/live` keeps its SSE latest scope, orderbook buffer fallback, auction mask, and live-tail volume distribution. `/study` keeps saved `RangeBundle` behavior, but stops using `isCursorActive` as a data truth and uses the same cursor-detail rules as `/live`.

**Tech Stack:** React 18, TypeScript, Vitest, Zustand, existing `useLiveCursorStore`, `useLiveOrderbookAtCursor`, `useLiveBrokersAtCursor`, `OrderbookTable`, `BrokerTrajectoryTable`, `TotalQtyBar`.

## Global Constraints

- Preserve ADR-0044: cursor spot fetchers in `frontend/src/api/useLiveCursor.ts` remain parquet REST only and must not import SSE / LiveBuffer modules.
- Preserve `undefined = loading`, `null = no data`, object/array = renderable data for sidebar cards.
- Preserve `/live` SSE orderbook fallback only in the `/live` composition layer; do not add SSE fallback to `/study`.
- Keep card rendering components dumb: `OrderbookTable`, `BrokerTrajectoryTable`, and `TotalQtyBar` receive already-resolved props for 10호가/거래원.
- Do not rename `useLiveCursorStore` in this PR. It is already shared by `LiveChartRoot`, `/live`, and `/study`; renaming it to `useChartCursorStore` is a follow-up cleanup, not required for the flicker-class structural fix.
- Use TDD for every behavior change. New production code requires a failing test first.
- Avoid broad layout or visual refactors. This plan is about data-state composition, not panel styling.

---

## File Structure

- Create: `frontend/src/sidebar/cursorDetailResolver.ts`
  - Pure functions and types for shared cursor-detail state: cursor scope, orderbook card props, broker card props.
  - No React hooks. No Zustand. No API calls. No SSE imports.
- Create: `frontend/src/sidebar/cursorDetailResolver.test.ts`
  - Unit tests for common semantics shared by `/live` and `/study`.
- Modify: `frontend/src/studyViews/StudyReferenceDetailPanel.tsx`
  - Use `cursorDetailResolver` for `detailCursorMs`, orderbook card snapshot, and broker card props.
  - Remove `isCursorActive` prop from data decisions.
- Modify: `frontend/src/studyViews/StudyPage.tsx`
  - Remove `isCursorActive` state and `onCursorActiveChange={setIsCursorActive}` wiring if no remaining consumer exists.
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`
  - Update tests that currently drive `onCursorActiveChange`; use `useLiveCursorStore.setCursor()` as the source of truth.
- Modify: `frontend/src/live/LiveSidebar.tsx`
  - Use `cursorDetailResolver` for `isSpot`, orderbook card snapshot, broker card props, and available hint inputs.
  - Keep live-only computations in `LiveSidebar`: latest SSE projection, orderbook buffer fallback, auction mask, live-tail volume distribution, program, and investor cards.
- Modify: `frontend/src/live/LiveSidebar.test.tsx`
  - Keep existing behavior coverage but assert through the shared resolver outcomes where useful.
- Optional docs update: `CONTEXT.md`
  - Do not add `Cursor Detail Resolver` as a standalone glossary term. It is an implementation boundary, not a domain concept.
  - If docs are updated, add one sentence to the existing **Cursor Sidebar** entry explaining that a resolver normalizes shared card-state semantics.

---

### Task 1: Add Shared Cursor Detail Resolver

**Files:**
- Create: `frontend/src/sidebar/cursorDetailResolver.ts`
- Create: `frontend/src/sidebar/cursorDetailResolver.test.ts`

**Interfaces:**
- Produces:
  - `resolveCursorDetailScope(args): CursorDetailScope`
  - `resolveOrderbookCardSnapshot(args): OrderbookSnapshot | null | undefined`
  - `resolveBrokerCardProps(args): { series: BrokerSeriesEntry[] | null | undefined; cursorMs: number | null }`
  - `type CursorDetailScope = { kind: 'inactive'; cursorMs: null; minuteTimeframe: null } | { kind: 'minute-cursor'; cursorMs: number; minuteTimeframe: MinuteTimeframe }`
- Consumes:
  - `OrderbookSnapshot`, `BrokerSeriesEntry` from `frontend/src/api/types.ts`
  - `MinuteTimeframe`, `isMinuteTimeframe` from `frontend/src/state/livePage.ts`

- [x] **Step 1: Write failing tests for cursor scope semantics**

Create `frontend/src/sidebar/cursorDetailResolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BrokerSeriesEntry, OrderbookSnapshot } from '../api/types';
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from './cursorDetailResolver';

const snapshot: OrderbookSnapshot = {
  ts_ms: 1_000,
  seq: 1,
  ask: Array.from({ length: 10 }, (_, index) => ({ price: 70_100 + index, qty: 10 + index })),
  bid: Array.from({ length: 10 }, (_, index) => ({ price: 70_000 - index, qty: 20 + index })),
  tot_ask: 145,
  tot_bid: 245,
};

const brokers: BrokerSeriesEntry[] = [{
  broker: '키움증권',
  final_net: 1_200,
  dominant_side: 'buy',
  points: [{ ts_ms: 1_000, net: 1_200 }],
}];

describe('cursorDetailResolver', () => {
  it('enters cursor scope only when cursorMs and minute timeframe are both present', () => {
    expect(resolveCursorDetailScope({ cursorMs: 1_000, timeframe: '5m' })).toEqual({
      kind: 'minute-cursor',
      cursorMs: 1_000,
      minuteTimeframe: '5m',
    });
    expect(resolveCursorDetailScope({ cursorMs: null, timeframe: '5m' })).toEqual({
      kind: 'inactive',
      cursorMs: null,
      minuteTimeframe: null,
    });
    expect(resolveCursorDetailScope({ cursorMs: 1_000, timeframe: 'D' })).toEqual({
      kind: 'inactive',
      cursorMs: null,
      minuteTimeframe: null,
    });
  });

  it('preserves loading versus no-data for cursor orderbook scope', () => {
    const scope = resolveCursorDetailScope({ cursorMs: 1_000, timeframe: '5m' });

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: undefined,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: null,
    })).toBeUndefined();

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: null,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: null,
    })).toBeNull();

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: snapshot,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: null,
    })).toBe(snapshot);
  });

  it('uses inactive orderbook only while inactive', () => {
    const scope = resolveCursorDetailScope({ cursorMs: null, timeframe: '5m' });

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: undefined,
      inactiveSnapshot: snapshot,
      bufferFallbackSnapshot: null,
    })).toBe(snapshot);
  });

  it('uses live buffer fallback only when cursor spot explicitly returned null', () => {
    const scope = resolveCursorDetailScope({ cursorMs: 1_000, timeframe: '5m' });

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: null,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: snapshot,
    })).toBe(snapshot);

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: undefined,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: snapshot,
    })).toBeUndefined();
  });

  it('returns cursor broker props in cursor scope and inactive broker props while inactive', () => {
    const cursorScope = resolveCursorDetailScope({ cursorMs: 1_000, timeframe: '5m' });
    expect(resolveBrokerCardProps({
      scope: cursorScope,
      spotSeries: undefined,
      inactiveSeries: [],
      inactiveCursorMs: 9_000,
    })).toEqual({ series: undefined, cursorMs: 1_000 });

    const inactiveScope = resolveCursorDetailScope({ cursorMs: null, timeframe: '5m' });
    expect(resolveBrokerCardProps({
      scope: inactiveScope,
      spotSeries: undefined,
      inactiveSeries: brokers,
      inactiveCursorMs: 9_000,
    })).toEqual({ series: brokers, cursorMs: 9_000 });
  });
});
```

- [x] **Step 2: Run the tests and verify RED**

Run:

```bash
cd frontend
npm test -- cursorDetailResolver.test.ts --run
```

Expected: FAIL because `./cursorDetailResolver` does not exist.

- [x] **Step 3: Implement the pure adapter**

Create `frontend/src/sidebar/cursorDetailResolver.ts`:

```ts
import type { BrokerSeriesEntry, OrderbookSnapshot } from '../api/types';
import { isMinuteTimeframe, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';

export type CursorDetailScope =
  | { kind: 'inactive'; cursorMs: null; minuteTimeframe: null }
  | { kind: 'minute-cursor'; cursorMs: number; minuteTimeframe: MinuteTimeframe };

export function resolveCursorDetailScope({
  cursorMs,
  timeframe,
}: {
  cursorMs: number | null;
  timeframe: LiveTimeframe | null;
}): CursorDetailScope {
  if (cursorMs !== null && timeframe !== null && isMinuteTimeframe(timeframe)) {
    return { kind: 'minute-cursor', cursorMs, minuteTimeframe: timeframe };
  }
  return { kind: 'inactive', cursorMs: null, minuteTimeframe: null };
}

export function resolveOrderbookCardSnapshot({
  scope,
  spotSnapshot,
  inactiveSnapshot,
  bufferFallbackSnapshot,
}: {
  scope: CursorDetailScope;
  spotSnapshot: OrderbookSnapshot | null | undefined;
  inactiveSnapshot: OrderbookSnapshot | null;
  bufferFallbackSnapshot: OrderbookSnapshot | null;
}): OrderbookSnapshot | null | undefined {
  if (scope.kind === 'inactive') return inactiveSnapshot;
  if (spotSnapshot === undefined) return undefined;
  return spotSnapshot ?? bufferFallbackSnapshot;
}

export function resolveBrokerCardProps({
  scope,
  spotSeries,
  inactiveSeries,
  inactiveCursorMs,
}: {
  scope: CursorDetailScope;
  spotSeries: BrokerSeriesEntry[] | null | undefined;
  inactiveSeries: BrokerSeriesEntry[] | null | undefined;
  inactiveCursorMs: number | null;
}): { series: BrokerSeriesEntry[] | null | undefined; cursorMs: number | null } {
  if (scope.kind === 'minute-cursor') {
    return { series: spotSeries, cursorMs: scope.cursorMs };
  }
  return { series: inactiveSeries, cursorMs: inactiveCursorMs };
}
```

- [x] **Step 4: Run tests and verify GREEN**

Run:

```bash
cd frontend
npm test -- cursorDetailResolver.test.ts --run
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add frontend/src/sidebar/cursorDetailResolver.ts frontend/src/sidebar/cursorDetailResolver.test.ts
git commit -m "refactor(sidebar): add cursor detail resolver"
```

---

### Task 2: Refactor Study Detail To Use Cursor Resolver

**Files:**
- Modify: `frontend/src/studyViews/StudyReferenceDetailPanel.tsx`
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes:
  - `resolveCursorDetailScope`
  - `resolveOrderbookCardSnapshot`
  - `resolveBrokerCardProps`
- Produces:
  - `StudyReferenceDetailPanel` no longer accepts `isCursorActive`.
  - `StudyPage` no longer stores cursor activity solely for detail cards.

- [x] **Step 1: Write/update failing study tests**

In `frontend/src/studyViews/StudyPage.test.tsx`, add a wiring test that fails against the current code because `StudyPage` still passes `onCursorActiveChange` into `LiveChartRoot`:

```ts
it('does not wire transient cursor active callbacks into study detail state', () => {
  renderPage('/study?view=view-ref');

  expect(liveChartRootMock.mock.calls[0][0].onCursorActiveChange).toBeUndefined();
});
```

Then keep/update the behavior test so `cursorMs` alone is the data truth:

```ts
it('keeps study cursor indicators visible while cursor remains set without relying on active callbacks', () => {
  useLiveOrderbookAtCursorMock.mockReturnValue(undefined);
  useLiveBrokersAtCursorMock.mockReturnValue(undefined);
  useLiveCursorStore.getState().setCursor(HOVER_MS);

  renderPage('/study?view=view-ref');

  const orderbookCard = screen.getByTestId('study-detail-card-orderbook');
  const brokersCard = screen.getByTestId('study-detail-card-brokers');
  expect(within(orderbookCard).getByText('커서 위치 로딩 중…')).toBeTruthy();
  expect(within(orderbookCard).queryByText('호가 데이터 없음')).toBeNull();
  expect(within(brokersCard).getByText('커서 위치 로딩 중…')).toBeTruthy();
  expect(within(brokersCard).queryByText('거래원 정보 없음')).toBeNull();
});
```

Also update existing tests that call `props.onCursorActiveChange?.(true)` so they only set `useLiveCursorStore.getState().setCursor(HOVER_MS)`.

- [x] **Step 2: Run study tests and verify RED**

Run:

```bash
cd frontend
npm test -- StudyPage.test.tsx --run -t "does not wire transient cursor active callbacks"
```

Expected before production changes: FAIL because `LiveChartRoot` still receives `onCursorActiveChange` from `StudyPage`.

- [x] **Step 3: Update `StudyReferenceDetailPanel`**

Change props:

```ts
type Props = {
  save: StudyViewReference;
  bundle: RangeBundle;
};
```

Import the resolver:

```ts
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from '../sidebar/cursorDetailResolver';
```

Replace cursor derivation:

```ts
const cursorScope = resolveCursorDetailScope({
  cursorMs,
  timeframe: save.timeframe,
});
const detailCursorMs = cursorScope.kind === 'minute-cursor' ? cursorScope.cursorMs : null;
const minuteTimeframe = cursorScope.kind === 'minute-cursor'
  ? cursorScope.minuteTimeframe
  : isMinuteTimeframe(save.timeframe)
    ? save.timeframe
    : null;
```

Resolve card props:

```ts
const orderbookSnapshot = resolveOrderbookCardSnapshot({
  scope: cursorScope,
  spotSnapshot: spotOrderbook?.snapshot,
  inactiveSnapshot: null,
  bufferFallbackSnapshot: null,
});
const brokerCard = resolveBrokerCardProps({
  scope: cursorScope,
  spotSeries: spotBrokers,
  inactiveSeries: null,
  inactiveCursorMs: null,
});
```

Render:

```tsx
<OrderbookTable snapshot={orderbookSnapshot} />
<TotalQtyBar snapshot={orderbookSnapshot} maskRatio={false} />
<BrokerTrajectoryTable series={brokerCard.series} cursorMs={brokerCard.cursorMs} />
```

- [x] **Step 4: Remove `isCursorActive` from `StudyPage`**

In `frontend/src/studyViews/StudyPage.tsx`:

Remove:

```ts
const [isCursorActive, setIsCursorActive] = useState(false);
```

Remove:

```ts
useEffect(() => {
  setIsCursorActive(false);
}, [activeViewId]);
```

Remove from `LiveChartRoot` props:

```tsx
onCursorActiveChange={setIsCursorActive}
```

Update `StudyReferenceDetailPanel` usage:

```tsx
<StudyReferenceDetailPanel
  save={activeViewModel.save}
  bundle={activeViewModel.bundle}
/>
```

- [x] **Step 5: Run tests and verify GREEN**

Run:

```bash
cd frontend
npm test -- StudyPage.test.tsx --run
npm test -- cursorDetailResolver.test.ts --run
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add frontend/src/studyViews/StudyReferenceDetailPanel.tsx frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "refactor(study): use shared cursor detail resolver"
```

---

### Task 3: Refactor Live Sidebar To Use Cursor Resolver

**Files:**
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Modify: `frontend/src/live/LiveSidebar.test.tsx`
- Test: `frontend/src/sidebar/cursorDetailResolver.test.ts`

**Interfaces:**
- Consumes:
  - `resolveCursorDetailScope`
  - `resolveOrderbookCardSnapshot`
  - `resolveBrokerCardProps`
- Preserves:
  - `orderbookSnapshotAtCursor` stays in `frontend/src/live/liveSidebarAdapters.ts`
  - `showAvailableHint` still only appears when spot orderbook returned `snapshot: null`, no buffer fallback exists, and `available_from` is present.

- [x] **Step 1: Add a resolver test for live D timeframe behavior**

In `frontend/src/sidebar/cursorDetailResolver.test.ts`, add:

```ts
it('keeps calendar timeframe cursor out of cursor detail mode', () => {
  const scope = resolveCursorDetailScope({ cursorMs: 1_000, timeframe: 'D' });

  expect(resolveOrderbookCardSnapshot({
    scope,
    spotSnapshot: undefined,
    inactiveSnapshot: snapshot,
    bufferFallbackSnapshot: null,
  })).toBe(snapshot);
});
```

- [x] **Step 2: Run resolver test and verify it passes or reveals missing behavior**

Run:

```bash
cd frontend
npm test -- cursorDetailResolver.test.ts --run
```

Expected: PASS if Task 1 implemented calendar gating correctly.

- [x] **Step 3: Refactor `LiveSidebar` cursor scope and orderbook props**

In `frontend/src/live/LiveSidebar.tsx`, import:

```ts
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from '../sidebar/cursorDetailResolver';
```

Replace:

```ts
const isSpot = cursorMs !== null && isMinuteTimeframe(timeframe);
```

with:

```ts
const cursorScope = resolveCursorDetailScope({ cursorMs, timeframe });
const isSpot = cursorScope.kind === 'minute-cursor';
```

Keep `spotTimeframe` hook gating, but derive it from the resolver:

```ts
const spotTimeframe: MinuteTimeframe | null =
  cursorScope.kind === 'minute-cursor'
    ? cursorScope.minuteTimeframe
    : timeframe && isMinuteTimeframe(timeframe)
      ? timeframe
      : null;
```

Replace `orderbookForCard`:

```ts
const orderbookForCard = resolveOrderbookCardSnapshot({
  scope: cursorScope,
  spotSnapshot: spotSnap,
  inactiveSnapshot: latestOrderbook,
  bufferFallbackSnapshot: bufferSnap,
});
```

- [x] **Step 4: Refactor `LiveSidebar` broker props**

Replace:

```ts
const brokerSeriesForCard = isSpot
  ? spotBrokers
  : (broker.length === 0 ? undefined : latestBrokerSeries);
const brokerCursorMs = isSpot ? (cursorMs ?? inactiveBrokerCursorMs) : inactiveBrokerCursorMs;
```

with:

```ts
const inactiveBrokerSeriesForCard = broker.length === 0 ? undefined : latestBrokerSeries;
const brokerCard = resolveBrokerCardProps({
  scope: cursorScope,
  spotSeries: spotBrokers,
  inactiveSeries: inactiveBrokerSeriesForCard,
  inactiveCursorMs: inactiveBrokerCursorMs,
});
const brokerCursorMs = brokerCard.cursorMs;
```

Render:

```tsx
<BrokerTrajectoryTable series={brokerCard.series} cursorMs={brokerCard.cursorMs} />
```

- [x] **Step 5: Keep available hint behavior explicit**

Keep:

```ts
const showAvailableHint =
  isSpot &&
  spotOrderbook !== undefined &&
  spotSnap === null &&
  bufferSnap === null &&
  spotAvailableFrom !== null;
```

Do not move `showAvailableHint` into the shared resolver in this task. It is live-specific because it depends on live buffer fallback.

- [x] **Step 6: Run live tests**

Run:

```bash
cd frontend
npm test -- LiveSidebar.test.tsx --run
npm test -- cursorDetailResolver.test.ts --run
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add frontend/src/live/LiveSidebar.tsx frontend/src/live/LiveSidebar.test.tsx frontend/src/sidebar/cursorDetailResolver.test.ts
git commit -m "refactor(live): use shared cursor detail resolver"
```

---

### Deferred Follow-Up: Volume/Program Cursor Helpers

Do not include this in the first structural PR. 매물대 and 프로그램 share some cursor inputs, but their page-specific semantics are broader than 10호가/거래원:

- `/live` can merge live-tail trades and recompute today volume distribution.
- `/study` uses saved `RangeBundle` / persisted profiles and should not accidentally inherit live-tail semantics.
- Program cursor semantics are simple, but they are not part of the reported 10호가/거래원 flicker class.

Revisit only after the 10호가/거래원 resolver lands cleanly. A follow-up may add narrow helpers such as `resolveCursorDate` or `resolveProgramCursorMs`, but that should be a separate PR with its own tests.

---

### Deferred Follow-Up: Rename `useLiveCursorStore`

Do not include this in the first structural PR. The current store name is live-biased, but the store is already the `LiveChartRoot` cursor publication channel consumed by both `/live` and `/study`.

Recommended follow-up:

- Rename `frontend/src/live/useLiveCursorStore.ts` to a neutral name such as `frontend/src/live/useChartCursorStore.ts` or `frontend/src/chart/useChartCursorStore.ts`.
- Update imports in a separate mechanical PR.
- Keep behavior unchanged and verify with `useLiveCursorStore.test.ts`, `LiveChartRoot.test.tsx -t "crosshair"`, `LiveSidebar.test.tsx`, and `StudyPage.test.tsx`.

Reason for deferral: it creates broad import churn and does not change the data-state semantics that caused the flicker.

---

### Task 5: Final Verification And Documentation

**Files:**
- Optional Modify: `CONTEXT.md`
- Verify: no unexpected production behavior changes.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: branch ready for PR.

- [x] **Step 1: Optional documentation update**

If the implementation adds `cursorDetailResolver.ts`, do not create a standalone `Cursor Detail Resolver` glossary entry. Add only this short sentence to the existing `CONTEXT.md` **Cursor Sidebar** terminology:

```md
Cursor-aware card state is normalized by `frontend/src/sidebar/cursorDetailResolver.ts`: it owns shared `cursorMs`/loading/no-data semantics for `/live` and `/study`, while each page still owns its data sources and layout.
```

- [x] **Step 2: Run full targeted verification**

Run:

```bash
cd frontend
npm test -- cursorDetailResolver.test.ts --run
npm test -- StudyPage.test.tsx --run
npm test -- LiveSidebar.test.tsx --run
npm test -- LiveChartRoot.test.tsx --run -t "crosshair"
npm run build
cd ..
git diff --check
```

Expected:
- `cursorDetailResolver.test.ts`: all tests pass.
- `StudyPage.test.tsx`: all tests pass.
- `LiveSidebar.test.tsx`: all tests pass.
- `LiveChartRoot.test.tsx -t "crosshair"`: all selected tests pass. Existing jsdom canvas `getContext` warnings are acceptable if tests exit 0.
- `npm run build`: exits 0.
- `git diff --check`: exits 0.

- [x] **Step 3: Inspect dependency boundaries**

Run:

```bash
rg -n "liveSeries|useLiveSeries|liveSnapshotBuffer|EventSource|ws" frontend/src/sidebar/cursorDetailResolver.ts frontend/src/api/useLiveCursor.ts
```

Expected: no matches. This preserves ADR-0044 fetcher/resolver boundaries.

- [x] **Step 4: Commit documentation if changed**

```bash
git add CONTEXT.md
git commit -m "docs: note shared cursor detail resolver"
```

Skip this commit if `CONTEXT.md` was not changed.

- [x] **Step 5: Prepare PR**

```bash
git status --short
git log --oneline origin/main..HEAD
```

Expected:
- Worktree clean.
- Commits show Task 1-3, plus optional docs commit.

PR summary should say:

```md
## Summary
- add shared cursor detail resolver for live/study card-state semantics
- remove StudyPage detail dependency on transient cursor active callbacks
- refactor LiveSidebar to use the same orderbook/broker cursor-state resolver while preserving live-only SSE fallback

## Verification
- npm test -- cursorDetailResolver.test.ts --run
- npm test -- StudyPage.test.tsx --run
- npm test -- LiveSidebar.test.tsx --run
- npm test -- LiveChartRoot.test.tsx --run -t "crosshair"
- npm run build
- git diff --check
```

---

## Self-Review

- Spec coverage: The plan covers shared cursor semantics, study `isCursorActive` removal, live adapter use, live-only fallback preservation, and targeted verification.
- Placeholder scan: No steps use TBD/TODO/fill-in language. Every code-changing task includes exact paths, snippets, commands, and expected outcomes.
- Type consistency: `CursorDetailScope`, `resolveCursorDetailScope`, `resolveOrderbookCardSnapshot`, and `resolveBrokerCardProps` are introduced before later tasks consume them.
- Scope control: The plan intentionally does not merge live/study panel layouts, does not alter `useLiveCursor` fetchers, and does not introduce new dependencies.
