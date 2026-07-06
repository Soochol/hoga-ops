# Live Sidecar Delta Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/live` minute-chart sidecar requests from refetching the full visible historical range on leftward backfill; request only the newly prepended sidecar dates and merge them client-side.

**Architecture:** Keep the backend `/api/range?mode=sidecar` contract unchanged because it already accepts arbitrary date ranges. Add a frontend sidecar-specific delta query wrapper that plans `from..previous.from-1` fetches, merges immutable sidecar arrays by date/key, and serves the merged bundle once the requested range is already covered. Wire only `/live`'s `pastSidecars` query through this wrapper; leave study views, cutoff profile single-day queries, hoga mode, candles mode, and full mode untouched.

**Tech Stack:** React 18, TanStack Query v5, Vitest + Testing Library, FastAPI `/api/range` existing route.

## Global Constraints

- Do not change `/api/range` response schema or backend request parameters for this v1.
- Only apply delta behavior to `/live` minute sidecar range requests where `options.mode === 'sidecar'` and `options.volumeDistributionCutoffMs == null`.
- Delta reuse is allowed only when `code`, `to`, `timeframe`/`bucket_ms`, `source_pref`, price-range inputs, and all sidecar option gates are identical.
- If the requested `to` changes, if any sidecar option changes, if source preference changes, or if cutoff mode is active, perform the normal full request.
- Preserve React Query stale/placeholder behavior used by `useLiveBundle`'s historical-extension gate.
- Existing untracked `.tmp/` artifacts must not be staged or modified.

---

## File Structure

- Modify `frontend/src/api/range.ts`
  - Add pure sidecar delta planner and `useRangeSidecarDelta`.
  - Add deterministic `mergeRangeBundles` helpers for sidecar arrays.
  - Keep existing `useRange` behavior unchanged.
- Modify `frontend/src/live/useLiveBundle.ts`
  - Import and use `useRangeSidecarDelta` only for `pastSidecars`.
  - Keep `pastHoga` on `useRange`, because hoga points still drive the atomic prepend gate with `/api/live/past-candles`.
- Modify `frontend/src/api/range.test.tsx`
  - Unit-test planner, merge behavior, hook URL shape, and no post-merge full refetch.
- Modify `frontend/src/live/useLiveBundle.test.tsx`
  - Update range mocks to include the new sidecar hook.
  - Assert sidecar requests still receive the same options from `useLiveBundle`.
  - Add regression coverage for historical extension call shape.
- Optional docs note in `CONTEXT.md`
  - Record that live minute sidecars are client-merged delta range requests.

---

### Task 1: Add Pure Sidecar Delta Planning And Merge Helpers

**Files:**
- Modify: `frontend/src/api/range.ts`
- Test: `frontend/src/api/range.test.tsx`

**Interfaces:**
- Consumes:
  - `buildRangeBundleRequest(input: RangeBundleRequestInput): RangeBundleRequest`
  - `RangeBundle`, `RangeBundleRequestInput`, `RangeQueryKey`
- Produces:
  - `export interface RangeDeltaPlan`
  - `export function planSidecarRangeDelta(input: RangeBundleRequestInput, previous?: RangeBundle): RangeDeltaPlan`
  - `export function mergeRangeBundles(previous: RangeBundle, next: RangeBundle): RangeBundle`

- [ ] **Step 1: Write failing planner tests**

Add to `frontend/src/api/range.test.tsx`:

```ts
import {
  buildRangeBundleRequest,
  mergeRangeBundles,
  planSidecarRangeDelta,
  useRange,
  rangeBundleQueryOptions,
  rangeFreshnessOptions,
  rangePlaceholderData,
  TODAY_RANGE_REFETCH_MS,
} from './range';
```

Add tests:

```ts
describe('planSidecarRangeDelta', () => {
  const previous: RangeBundle = {
    ...fakeBundle,
    code: '005930',
    from_date: '20260629',
    to_date: '20260706',
    bucket_ms: 60_000,
  };

  it('plans only the missing left delta for compatible live sidecar ranges', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260706',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'hogaplay_first',
      options: {
        mode: 'sidecar',
        askPeaksEnabled: false,
        bidPeaksEnabled: false,
        programTradeEnabled: true,
        tradeVolumePocEnabled: true,
        volumeDistributionBins: 10,
        tradeVolumePocBins: 10,
        volumeDistributionPriceRange: { min: 303000, max: 325000 },
      },
    }, previous);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260628');
  });

  it('serves previous data without fetching when the requested range is already covered', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260629',
      to: '20260706',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'hogaplay_first',
      options: { mode: 'sidecar', volumeDistributionBins: 10 },
    }, previous);

    expect(plan.enabled).toBe(false);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe(null);
    expect(plan.requestInput.to).toBe(null);
  });

  it('falls back to full request when to-date changes', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260707',
      timeframe: '1m',
      todayKst: '20260707',
      sourcePref: 'hogaplay_first',
      options: { mode: 'sidecar', volumeDistributionBins: 10 },
    }, previous);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260707');
  });

  it('does not delta-plan cutoff sidecar profile requests', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260624',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'hogaplay_first',
      options: {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionCutoffMs: 1_772_000_001_000,
      },
    }, previous);

    expect(plan.canReusePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260624');
  });
});
```

- [ ] **Step 2: Write failing merge tests**

Add to `frontend/src/api/range.test.tsx`:

```ts
describe('mergeRangeBundles', () => {
  it('merges sidecar arrays by stable date/key and keeps chronological order', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      segments: [{ date: '20260629', session_open_ms: 1, session_close_ms: 2, source: 'hogaplay' }],
      ask_peaks: [{ date: '20260629', price: 10, qty: 1, t_ms: 1, max_price: 10, max_qty: 1, max_t_ms: 1 }],
      bid_peaks: [{ date: '20260629', price: 9, qty: 1, t_ms: 1, max_price: 9, max_qty: 1, max_t_ms: 1 }],
      broker_late_entries: [{ t_ms: 2, broker: 'NH투자증권', side: 'buy', net: 100 }],
      trade_volume_pocs: [{ date: '20260629', center_price: 10, low_price: 9, high_price: 11, qty: 1, t_ms: 1, band_pct: 0.005 }],
      volume_distributions: [{
        date: '20260629',
        range_count: 10,
        price_min: 9,
        price_max: 11,
        session_open_ms: 1,
        session_close_ms: 2,
        bins: [{ price_low: 9, price_high: 10, qty: 1 }],
      }],
      program_trade: {
        source: 'kis_program_trade',
        points: [{ t: 2, net_qty: 10, net_amount: 100, delta_qty: 10, delta_amount: 100, gap_risk: false }],
      },
    };
    const next: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260628',
      segments: [{ date: '20260624', session_open_ms: 3, session_close_ms: 4, source: 'hogaplay' }],
      ask_peaks: [{ date: '20260624', price: 8, qty: 1, t_ms: 3, max_price: 8, max_qty: 1, max_t_ms: 3 }],
      bid_peaks: [{ date: '20260624', price: 7, qty: 1, t_ms: 3, max_price: 7, max_qty: 1, max_t_ms: 3 }],
      broker_late_entries: [{ t_ms: 1, broker: 'NH투자증권', side: 'sell', net: -50 }],
      trade_volume_pocs: [{ date: '20260624', center_price: 8, low_price: 7, high_price: 9, qty: 1, t_ms: 3, band_pct: 0.005 }],
      volume_distributions: [{
        date: '20260624',
        range_count: 10,
        price_min: 7,
        price_max: 9,
        session_open_ms: 3,
        session_close_ms: 4,
        bins: [{ price_low: 7, price_high: 8, qty: 1 }],
      }],
      program_trade: {
        source: 'kis_program_trade',
        points: [{ t: 1, net_qty: 5, net_amount: 50, delta_qty: 5, delta_amount: 50, gap_risk: false }],
      },
    };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.from_date).toBe('20260624');
    expect(merged.to_date).toBe('20260706');
    expect(merged.segments.map((s) => s.date)).toEqual(['20260624', '20260629']);
    expect(merged.ask_peaks.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.bid_peaks?.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.trade_volume_pocs?.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.volume_distributions.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.broker_late_entries.map((e) => e.t_ms)).toEqual([1, 2]);
    expect(merged.program_trade?.points.map((p) => p.t)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm run test -- --run src/api/range.test.tsx
```

Expected: fail because `planSidecarRangeDelta` and `mergeRangeBundles` are not exported.

- [ ] **Step 4: Implement planner and merge helpers**

Add to `frontend/src/api/range.ts` after `rangeBundleQueryOptions`:

```ts
export interface RangeDeltaPlan {
  enabled: boolean;
  requestInput: RangeBundleRequestInput;
  canReusePrevious: boolean;
  servePrevious: boolean;
  identity: string;
}

function addDays(yyyymmdd: string, days: number): string {
  const d = new Date(Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  ));
  d.setUTCDate(d.getUTCDate() + days);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function sidecarIdentity(input: RangeBundleRequestInput): string {
  const request = buildRangeBundleRequest(input);
  const key = [...request.queryKey];
  key[2] = null;
  return JSON.stringify(key);
}

export function planSidecarRangeDelta(
  input: RangeBundleRequestInput,
  previous?: RangeBundle,
): RangeDeltaPlan {
  const identity = sidecarIdentity(input);
  const request = buildRangeBundleRequest(input);
  const options = input.options ?? {};
  const fullInput = { ...input };
  if (
    !request.enabled ||
    options.mode !== 'sidecar' ||
    options.volumeDistributionCutoffMs != null ||
    !input.code ||
    !input.from ||
    !input.to
  ) {
    return {
      enabled: request.enabled,
      requestInput: fullInput,
      canReusePrevious: false,
      servePrevious: false,
      identity,
    };
  }

  const previousInput: RangeBundleRequestInput | undefined = previous
    ? { ...input, from: previous.from_date, to: previous.to_date }
    : undefined;
  const sameIdentity = !!(
    previous &&
    previous.code === input.code &&
    previous.to_date === input.to &&
    previousInput &&
    sidecarIdentity(previousInput) === identity
  );

  if (sameIdentity && previous.from_date <= input.from) {
    return {
      enabled: false,
      requestInput: { ...input, from: null, to: null },
      canReusePrevious: false,
      servePrevious: true,
      identity,
    };
  }

  if (sameIdentity && input.from < previous.from_date) {
    return {
      enabled: true,
      requestInput: { ...input, from: input.from, to: addDays(previous.from_date, -1) },
      canReusePrevious: true,
      servePrevious: true,
      identity,
    };
  }

  return {
    enabled: true,
    requestInput: fullInput,
    canReusePrevious: false,
    servePrevious: false,
    identity,
  };
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string, compare: (a: T, b: T) => number): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);
  return Array.from(byKey.values()).sort(compare);
}

export function mergeRangeBundles(previous: RangeBundle, next: RangeBundle): RangeBundle {
  return {
    ...next,
    from_date: previous.from_date < next.from_date ? previous.from_date : next.from_date,
    to_date: previous.to_date > next.to_date ? previous.to_date : next.to_date,
    segments: uniqueBy(
      [...previous.segments, ...next.segments],
      (s) => s.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    candles: uniqueBy(
      [...previous.candles, ...next.candles],
      (c) => String(c.ts_ms),
      (a, b) => a.ts_ms - b.ts_ms,
    ),
    quote_ratio: {
      bucket_ms: next.quote_ratio.bucket_ms,
      points: uniqueBy(
        [...previous.quote_ratio.points, ...next.quote_ratio.points],
        (p) => String(p.t),
        (a, b) => a.t - b.t,
      ),
    },
    fill_strength: {
      bucket_ms: next.fill_strength.bucket_ms,
      points: uniqueBy(
        [...previous.fill_strength.points, ...next.fill_strength.points],
        (p) => String(p.t),
        (a, b) => a.t - b.t,
      ),
    },
    ask_peaks: uniqueBy(
      [...previous.ask_peaks, ...next.ask_peaks],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    bid_peaks: uniqueBy(
      [...(previous.bid_peaks ?? []), ...(next.bid_peaks ?? [])],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    broker_late_entries: uniqueBy(
      [...previous.broker_late_entries, ...next.broker_late_entries],
      (e) => `${e.t_ms}|${e.broker}|${e.side}`,
      (a, b) => a.t_ms - b.t_ms,
    ),
    trade_volume_pocs: uniqueBy(
      [...(previous.trade_volume_pocs ?? []), ...(next.trade_volume_pocs ?? [])],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    volume_distributions: uniqueBy(
      [...previous.volume_distributions, ...next.volume_distributions],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    program_trade: {
      source: next.program_trade?.source ?? previous.program_trade?.source,
      points: uniqueBy(
        [...(previous.program_trade?.points ?? []), ...(next.program_trade?.points ?? [])],
        (p) => String(p.t),
        (a, b) => a.t - b.t,
      ),
    },
    excluded_dates: uniqueBy(
      [...(previous.excluded_dates ?? []), ...(next.excluded_dates ?? [])],
      (d) => d.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    data_warnings: uniqueBy(
      [...(previous.data_warnings ?? []), ...(next.data_warnings ?? [])],
      (d) => d.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
  };
}
```

- [ ] **Step 5: Run tests to verify pass**

Run:

```bash
npm run test -- --run src/api/range.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/range.ts frontend/src/api/range.test.tsx
git commit -m "test(live): cover sidecar range delta planning"
```

---

### Task 2: Add `useRangeSidecarDelta` Hook

**Files:**
- Modify: `frontend/src/api/range.ts`
- Test: `frontend/src/api/range.test.tsx`

**Interfaces:**
- Consumes:
  - `planSidecarRangeDelta(input, previous)`
  - `mergeRangeBundles(previous, next)`
  - `rangeFreshnessOptions(to, todayKst)`
- Produces:
  - `export function useRangeSidecarDelta(...)` with the same call shape as `useRange`.

- [ ] **Step 1: Write failing hook regression test**

Add to `frontend/src/api/range.test.tsx` imports:

```ts
import {
  buildRangeBundleRequest,
  mergeRangeBundles,
  planSidecarRangeDelta,
  useRange,
  useRangeSidecarDelta,
  rangeBundleQueryOptions,
  rangeFreshnessOptions,
  rangePlaceholderData,
  TODAY_RANGE_REFETCH_MS,
} from './range';
```

Add test:

```ts
it('useRangeSidecarDelta fetches only missing left sidecar dates and does not full-refetch after merge', async () => {
  const first: RangeBundle = {
    ...fakeBundle,
    code: '005930',
    from_date: '20260629',
    to_date: '20260706',
    bucket_ms: 60_000,
    volume_distributions: [{ date: '20260629', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
  };
  const delta: RangeBundle = {
    ...fakeBundle,
    code: '005930',
    from_date: '20260624',
    to_date: '20260628',
    bucket_ms: 60_000,
    volume_distributions: [{ date: '20260624', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
  };
  const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
    Promise.resolve(String(url).includes('from=20260624&to=20260628') ? delta : first),
  );
  const wrapper = makeWrapper();
  const { result, rerender } = renderHook(
    ({ from }: { from: string }) =>
      useRangeSidecarDelta('005930', from, '20260706', '1m', undefined, '20260706', {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionPriceRange: { min: 303000, max: 325000 },
      }, 'hogaplay_first'),
    { wrapper, initialProps: { from: '20260629' } },
  );

  await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));
  rerender({ from: '20260624' });

  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(spy.mock.calls[1][0]).toBe(
    '/api/range?code=005930&from=20260624&to=20260628&bucket_ms=60000'
      + '&volume_distribution_bins=10'
      + '&volume_distribution_price_min=303000&volume_distribution_price_max=325000'
      + '&source_pref=hogaplay_first&mode=sidecar',
  );
  await waitFor(() => expect(result.current.data?.from_date).toBe('20260624'));
  expect(result.current.data?.to_date).toBe('20260706');
  expect(result.current.data?.volume_distributions.map((d) => d.date)).toEqual(['20260624', '20260629']);
  await new Promise((r) => setTimeout(r, 30));
  expect(spy).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm run test -- --run src/api/range.test.tsx
```

Expected: fail because `useRangeSidecarDelta` is not exported.

- [ ] **Step 3: Implement `useRangeSidecarDelta`**

Add to `frontend/src/api/range.ts` after `useRange`:

```ts
export function useRangeSidecarDelta(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
  priceRange?: { min: number; max: number },
  todayKst?: string | null,
  options?: RangeRequestOptions,
  sourcePrefOverride?: SourcePreference,
) {
  const storedSourcePref: SourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  const sourcePref = sourcePrefOverride ?? storedSourcePref;
  const mergedRef = useRef<{ identity: string; data: RangeBundle } | null>(null);
  const baseInput = useMemo<RangeBundleRequestInput>(
    () => ({ code, from, to, timeframe, priceRange, todayKst, sourcePref, options }),
    [code, from, to, timeframe, priceRange, todayKst, sourcePref, options],
  );
  const previous = mergedRef.current?.identity === sidecarIdentity(baseInput)
    ? mergedRef.current.data
    : undefined;
  const plan = useMemo(
    () => planSidecarRangeDelta(baseInput, previous),
    [baseInput, previous],
  );
  const request = buildRangeBundleRequest(plan.requestInput);
  const { staleTime, refetchInterval } = rangeFreshnessOptions(to, request.todayKst);

  const query = useQuery<RangeBundle, Error, RangeBundle, RangeQueryKey>({
    queryKey: request.queryKey,
    queryFn: ({ signal }) => apiCall<RangeBundle>(request.url, { signal }),
    enabled: plan.enabled,
    staleTime,
    refetchInterval,
    placeholderData: (prev, previousQuery) =>
      rangePlaceholderData(prev, request.queryKey, previousQuery?.queryKey),
  });

  const data = useMemo(() => {
    if (plan.servePrevious && previous && !query.data) return previous;
    if (!query.data) return undefined;
    if (query.isPlaceholderData) return previous;
    if (plan.canReusePrevious && previous) return mergeRangeBundles(previous, query.data);
    return query.data;
  }, [plan.canReusePrevious, plan.servePrevious, previous, query.data, query.isPlaceholderData]);

  if (data && !query.isPlaceholderData) {
    mergedRef.current = { identity: plan.identity, data };
  }

  return { ...query, data };
}
```

Also add `useMemo` and `useRef` import:

```ts
import { useMemo, useRef } from 'react';
```

- [ ] **Step 4: Run hook tests**

Run:

```bash
npm run test -- --run src/api/range.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/range.ts frontend/src/api/range.test.tsx
git commit -m "feat(live): add sidecar delta range hook"
```

---

### Task 3: Wire Live Sidecars Through The Delta Hook

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Test: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Consumes:
  - `useRangeSidecarDelta` from `../api/range`
- Produces:
  - `/live` sidecar historical extension requests call `useRangeSidecarDelta(...)` instead of `useRange(...)`.

- [ ] **Step 1: Update live bundle range mock**

In `frontend/src/live/useLiveBundle.test.tsx`, replace the range mock block with:

```ts
const rangeMock = { isPlaceholderData: false, isFetching: false };
const useRangeSpy = vi.fn<(...args: unknown[]) => any>(() => ({
  data: null,
  isLoading: false,
  error: null,
  isPlaceholderData: rangeMock.isPlaceholderData,
  isFetching: rangeMock.isFetching,
}));
const useRangeSidecarDeltaSpy = vi.fn<(...args: unknown[]) => any>(() => ({
  data: null,
  isLoading: false,
  error: null,
  isPlaceholderData: rangeMock.isPlaceholderData,
  isFetching: rangeMock.isFetching,
}));
vi.mock('../api/range', () => ({
  useRange: (...args: unknown[]) => useRangeSpy(...args as []),
  useRangeSidecarDelta: (...args: unknown[]) => useRangeSidecarDeltaSpy(...args as []),
}));
```

In `beforeEach`, clear both spies:

```ts
useRangeSpy.mockClear();
useRangeSidecarDeltaSpy.mockClear();
```

- [ ] **Step 2: Update existing sidecar call expectations**

In the test `loads hoga panes and overlay sidecars through separate lightweight range requests`, keep the `useRangeSpy` expectation for `mode: 'hoga'`, and change the sidecar expectation to:

```ts
expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
  '005930',
  '20260520',
  '20260527',
  '1m',
  undefined,
  '20260527',
  expect.objectContaining({
    mode: 'sidecar',
    askPeaksEnabled: false,
    bidPeaksEnabled: false,
    programTradeEnabled: true,
    tradeVolumePocEnabled: true,
    brokerLateEntriesEnabled: false,
    brokerLateEntryStartHHMM: null,
    volumeDistributionBins: 10,
    tradeVolumePocBins: 10,
    volumeDistributionPriceRange: { min: 69900, max: 70100 },
  }),
);
```

Apply the same change to tests that currently assert a `mode: 'sidecar'` call through `useRangeSpy`.

- [ ] **Step 3: Add live wiring regression test**

Add to `frontend/src/live/useLiveBundle.test.tsx`:

```ts
it('routes live sidecars through the delta range hook', () => {
  renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });

  expect(useRangeSpy).toHaveBeenCalledWith(
    '005930',
    '20260520',
    '20260527',
    '1m',
    undefined,
    '20260527',
    { mode: 'hoga' },
  );
  expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
    '005930',
    '20260520',
    '20260527',
    '1m',
    undefined,
    '20260527',
    expect.objectContaining({ mode: 'sidecar' }),
  );
});
```

- [ ] **Step 4: Implement import and hook swap**

In `frontend/src/live/useLiveBundle.ts`, change the import:

```ts
import { useRange, useRangeSidecarDelta } from '../api/range';
```

Replace the sidecar query:

```ts
const pastSidecars = useRangeSidecarDelta(
  sidecarEnabled ? rangePlan.code : null,
  sidecarEnabled ? rangePlan.from : null,
  sidecarEnabled ? rangePlan.to : null,
  sidecarEnabled ? rangePlan.timeframe : null,
  undefined,
  sidecarEnabled ? rangePlan.todayKst : null,
  sidecarRangeOptions,
);
```

- [ ] **Step 5: Run live bundle tests**

Run:

```bash
npm run test -- --run src/live/useLiveBundle.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/useLiveBundle.ts frontend/src/live/useLiveBundle.test.tsx
git commit -m "fix(live): use delta range hook for sidecars"
```

---

### Task 4: Browser Verification And Docs Note

**Files:**
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes:
  - `/live?code=005930`
  - `useLivePageStore.getState().extendHistoricalRange(...)`
- Produces:
  - Browser evidence that sidecar no longer full-refetches on historical extension.

- [ ] **Step 1: Add context note**

Append under the existing live candle/range context in `CONTEXT.md`:

```md
- `live sidecar delta`: `/live` minute sidecar overlays (`/api/range mode=sidecar`) use client-side left-delta fetch + merge. A historical extension from `20260629..20260706` to `20260624..20260706` should request sidecar `20260624..20260628`, not full `20260624..20260706`. Cutoff sidecar profile queries remain single-date full requests.
```

- [ ] **Step 2: Run focused test suite**

Run:

```bash
npm run test -- --run src/api/range.test.tsx src/live/useLiveBundle.test.tsx
npm run build
```

Expected: both commands pass.

- [ ] **Step 3: Start local servers**

Run backend:

```bash
HOGA_PERF_DEBUG=1 HOGA_LIVE_STARTUP_ENABLED=false uv run --extra dev uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

Run frontend on an allowed CORS origin:

```bash
cd frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

If `5173` is busy, use `5174`; both are allowed by `hoga/api/app.py`.

- [ ] **Step 4: Browser-check sidecar request shape**

Open:

```text
http://127.0.0.1:5173/live?code=005930
```

Using Playwright or `/browse`, run in page context:

```js
async () => {
  const mod = await import('/src/state/livePage.ts');
  mod.useLivePageStore.getState().resetHistoricalRange();
  await new Promise((r) => setTimeout(r, 5000));
  mod.useLivePageStore.getState().extendHistoricalRange('20260624');
  await new Promise((r) => setTimeout(r, 8000));
  return mod.useLivePageStore.getState().historicalFromDate;
}
```

Inspect network requests filtered by `mode=sidecar`.

Expected:

```text
Initial sidecar:
/api/range?...from=20260629&to=20260706...&mode=sidecar

Extension sidecar:
/api/range?...from=20260624&to=20260628...&mode=sidecar

Not present after extension:
/api/range?...from=20260624&to=20260706...&mode=sidecar
```

- [ ] **Step 5: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(live): document sidecar delta range behavior"
```

---

## Self-Review

- Spec coverage: The plan addresses the observed browser issue: `/api/range mode=sidecar` full-range refetch on leftward historical extension. It does not change backend internals because the endpoint already supports arbitrary smaller ranges.
- Placeholder scan: No `TBD`, `TODO`, or unnamed future work remains in the tasks.
- Type consistency: `RangeBundleRequestInput`, `RangeBundle`, `RangeDeltaPlan`, `planSidecarRangeDelta`, `mergeRangeBundles`, and `useRangeSidecarDelta` are named consistently across tasks.
- Risk: The main risk is over-merging sidecar data when options change. The identity rule explicitly includes query-key fields except `from`, so option/source/to changes fall back to full requests.
