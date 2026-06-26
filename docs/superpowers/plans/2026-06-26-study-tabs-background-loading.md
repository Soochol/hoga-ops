# Inactive Study Tab Query Warmup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a saved study view or timeframe starts loading, switching to another study tab must not cancel the previous tab's in-flight load; activated inactive study tabs should keep their query observers warm until closed.

**Architecture:** Extract pure React Query option builders for the three data requests that compose a study reference view: `/api/range`, study minute past candles, and study daily past candles. Keep `useStudyReferenceBundle` as the active-tab renderer, and add a warm-query hook that calls `useQueries(...)` for the active tab plus study tabs activated during the current browser session. Do not mount hidden `LiveChartRoot` instances.

**Tech Stack:** React 18, TypeScript, Zustand study tab store, TanStack React Query v5, Vitest + Testing Library.

## Global Constraints

- `/study` continues to render saved snapshots/reference views only; do not introduce live SSE hooks.
- The active study tab remains the only mounted `LiveChartRoot`.
- Query warmup is best-effort and cache-backed: failed inactive queries must not block active tab rendering.
- Keep query keys identical between active load and inactive warm observers so the active tab reuses cached results immediately.
- Do not add new dependencies.

---

## File Structure

- Modify: `frontend/src/api/range.ts`
  - Add `rangeBundleQueryOptions(...)`, a pure helper used by both `useRange` and warm study-tab observers.
- Modify: `frontend/src/api/range.test.tsx`
  - Verify the helper produces the same key and fetch behavior as `useRange`.
- Modify: `frontend/src/api/studyPastCandles.ts`
  - Add `studyPastCandlesQueryOptions(...)` and `studyPastDailyCandlesQueryOptions(...)`.
- Modify: `frontend/src/api/studyPastCandles.test.tsx`
  - Verify the option helpers use the same keys, enabled gates, staleTime, and API URLs.
- Create: `frontend/src/studyViews/studyReferenceQueries.ts`
  - Build the complete query option set for one `StudyViewReference`.
- Create: `frontend/src/studyViews/studyReferenceQueries.test.ts`
  - Unit-test minute vs daily query selection and indicator option propagation.
- Create: `frontend/src/studyViews/useWarmStudyReferenceTabQueries.ts`
  - Keep React Query observers mounted for the active tab plus tabs activated in the current `/study` session.
- Create: `frontend/src/studyViews/useWarmStudyReferenceTabQueries.test.tsx`
  - Verify activated inactive tabs stay observed, never-activated tabs are skipped, and closed tabs fall out.
- Modify: `frontend/src/studyViews/useStudyReferenceBundle.ts`
  - Reuse the new query option builders while preserving the existing public return shape.
- Modify: `frontend/src/studyViews/StudyPage.tsx`
  - Call `useWarmStudyReferenceTabQueries(...)` with open tabs, active tab id, activated tab ids, saved views, and per-view timeframe overrides.
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`
  - Add a regression that switching tabs while loading does not abort the previous tab's in-flight request.

---

### Task 1: Extract Range Query Options

**Files:**
- Modify: `frontend/src/api/range.ts`
- Modify: `frontend/src/api/range.test.tsx`

**Interfaces:**
- Consumes: `buildRangeBundleRequest(...)`, `rangeFreshnessOptions(...)`, `apiCall(...)`
- Produces:
  - `type RangeBundleQueryOptionsInput = RangeBundleRequestInput`
  - `function rangeBundleQueryOptions(input: RangeBundleQueryOptionsInput): UseQueryOptions<RangeBundle, Error, RangeBundle, RangeQueryKey>`

- [ ] **Step 1: Write the failing helper test**

Add to `frontend/src/api/range.test.tsx`:

```ts
import { rangeBundleQueryOptions } from './range';

it('builds reusable range query options with the same key and abortable query function', async () => {
  const options = rangeBundleQueryOptions({
    code: '005930',
    from: '20260616',
    to: '20260618',
    timeframe: '5m',
    todayKst: null,
    sourcePref: 'auto',
    options: {
      volumeDistributionBins: 12,
      tradeVolumePocBins: 12,
      volumeDistributionPriceRange: null,
    },
  });

  expect(options.enabled).toBe(true);
  expect(options.queryKey).toEqual([
    'range',
    '005930',
    '20260616',
    '20260618',
    300_000,
    undefined,
    undefined,
    null,
    12,
    undefined,
    undefined,
    12,
    'auto',
  ]);

  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchMockOrApiCallSpy).toHaveBeenCalledWith(
    '/api/range?code=005930&from=20260616&to=20260618&bucket_ms=300000&volume_distribution_bins=12&trade_volume_poc_bins=12&source_pref=auto',
    { signal },
  );
});
```

Replace `fetchMockOrApiCallSpy` with the existing `apiCall` spy variable already used in `range.test.tsx`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- --run src/api/range.test.tsx`

Expected: FAIL because `rangeBundleQueryOptions` is not exported.

- [ ] **Step 3: Implement the helper**

In `frontend/src/api/range.ts`, add imports and helper:

```ts
import type { UseQueryOptions } from '@tanstack/react-query';
```

```ts
export type RangeBundleQueryOptionsInput = RangeBundleRequestInput;

export function rangeBundleQueryOptions(
  input: RangeBundleQueryOptionsInput,
): UseQueryOptions<RangeBundle, Error, RangeBundle, RangeQueryKey> {
  const request = buildRangeBundleRequest(input);
  const { staleTime, refetchInterval } = rangeFreshnessOptions(input.to, request.todayKst);
  return {
    queryKey: request.queryKey,
    queryFn: ({ signal }) => apiCall<RangeBundle>(request.url, { signal }),
    enabled: request.enabled,
    staleTime,
    refetchInterval,
    placeholderData: (prev, previousQuery) =>
      rangePlaceholderData(prev, request.queryKey, previousQuery?.queryKey),
  };
}
```

Then replace the body of `useRange(...)` with:

```ts
  return useQuery(rangeBundleQueryOptions({
    code,
    from,
    to,
    timeframe,
    priceRange,
    todayKst,
    sourcePref,
    options,
  }));
```

- [ ] **Step 4: Run the range tests**

Run: `npm test -- --run src/api/range.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/range.ts frontend/src/api/range.test.tsx
git commit -m "refactor: extract range query options"
```

---

### Task 2: Extract Study Past Candle Query Options

**Files:**
- Modify: `frontend/src/api/studyPastCandles.ts`
- Modify: `frontend/src/api/studyPastCandles.test.tsx`

**Interfaces:**
- Produces:
  - `function studyPastCandlesQueryOptions(code, from, to, venue): UseQueryOptions<LivePastCandlesResponse, Error, LivePastCandlesResponse, readonly ['study', 'past-candles', string | null, string | null, string | null, LiveVenueOption]>`
  - `function studyPastDailyCandlesQueryOptions(code, from, to, venue): UseQueryOptions<LivePastDailyCandlesResponse, Error, LivePastDailyCandlesResponse, readonly ['study', 'past-daily-candles', string | null, string | null, string | null, LiveVenueOption]>`

- [ ] **Step 1: Write failing option-helper tests**

Add to `frontend/src/api/studyPastCandles.test.tsx`:

```ts
import {
  studyPastCandlesQueryOptions,
  studyPastDailyCandlesQueryOptions,
} from './studyPastCandles';

it('builds reusable study minute candle query options', async () => {
  const options = studyPastCandlesQueryOptions('005930', '20260616', '20260618', 'KRX');

  expect(options.enabled).toBe(true);
  expect(options.queryKey).toEqual(['study', 'past-candles', '005930', '20260616', '20260618', 'KRX']);
  expect(options.staleTime).toBe(Infinity);
  expect(options.refetchInterval).toBe(false);

  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(apiCallSpy).toHaveBeenCalledWith(
    '/api/live/past-candles?code=005930&from=20260616&to=20260618&venue=KRX',
    { signal },
  );
});

it('builds reusable study daily candle query options', async () => {
  const options = studyPastDailyCandlesQueryOptions('005930', '20260616', '20260618', 'KRX');

  expect(options.enabled).toBe(true);
  expect(options.queryKey).toEqual(['study', 'past-daily-candles', '005930', '20260616', '20260618', 'KRX']);

  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(apiCallSpy).toHaveBeenCalledWith(
    '/api/live/past-daily-candles?code=005930&from=20260616&to=20260618&venue=KRX',
    { signal },
  );
});
```

Use the existing `apiCall` spy name in this test file for `apiCallSpy`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- --run src/api/studyPastCandles.test.tsx`

Expected: FAIL because the helpers are not exported.

- [ ] **Step 3: Implement option helpers and reuse them in hooks**

In `frontend/src/api/studyPastCandles.ts`:

```ts
import type { UseQueryOptions } from '@tanstack/react-query';
```

Add:

```ts
export type StudyPastCandlesQueryKey = readonly [
  'study',
  'past-candles',
  string | null,
  string | null,
  string | null,
  LiveVenueOption,
];

export type StudyPastDailyCandlesQueryKey = readonly [
  'study',
  'past-daily-candles',
  string | null,
  string | null,
  string | null,
  LiveVenueOption,
];

export function studyPastCandlesQueryOptions(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
): UseQueryOptions<LivePastCandlesResponse, Error, LivePastCandlesResponse, StudyPastCandlesQueryKey> {
  const enabled = !!(code && from && to && from <= to);
  return {
    queryKey: ['study', 'past-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: STUDY_PAST_CANDLES_STALE_TIME,
    refetchInterval: false,
    placeholderData: (prev) => (prev && prev.code === code && (prev.venue ?? 'KRX') === venue ? prev : undefined),
  };
}

export function studyPastDailyCandlesQueryOptions(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
): UseQueryOptions<LivePastDailyCandlesResponse, Error, LivePastDailyCandlesResponse, StudyPastDailyCandlesQueryKey> {
  const enabled = !!(code && from && to && from <= to);
  return {
    queryKey: ['study', 'past-daily-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastDailyCandlesResponse>(
        `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: STUDY_PAST_CANDLES_STALE_TIME,
    refetchInterval: false,
    placeholderData: (prev) => (prev && prev.code === code && (prev.venue ?? 'KRX') === venue ? prev : undefined),
  };
}
```

Replace hook bodies:

```ts
  return useQuery(studyPastCandlesQueryOptions(code, from, to, venue));
```

```ts
  return useQuery(studyPastDailyCandlesQueryOptions(code, from, to, venue));
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/api/studyPastCandles.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/studyPastCandles.ts frontend/src/api/studyPastCandles.test.tsx
git commit -m "refactor: extract study candle query options"
```

---

### Task 3: Build Study Reference Query Specs

**Files:**
- Create: `frontend/src/studyViews/studyReferenceQueries.ts`
- Create: `frontend/src/studyViews/studyReferenceQueries.test.ts`

**Interfaces:**
- Consumes:
  - `studyReferenceQueryInputs(save)`
  - `rangeBundleQueryOptions(...)`
  - `studyPastCandlesQueryOptions(...)`
  - `studyPastDailyCandlesQueryOptions(...)`
- Produces:
  - `type StudyReferenceQuerySettings`
  - `function studyReferenceRangeOptions(save, settings)`
  - `function studyReferenceMinuteCandlesOptions(save, settings)`
  - `function studyReferenceDailyCandlesOptions(save, settings)`
  - `function studyReferenceQueryOptions(save, settings)`

- [ ] **Step 1: Write the test**

Create `frontend/src/studyViews/studyReferenceQueries.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { studyReferenceQueryOptions } from './studyReferenceQueries';

const save: StudyViewReference = {
  schema_version: 2,
  id: 'view-ref',
  name: '돌파 복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

describe('studyReferenceQueryOptions', () => {
  it('builds range and minute candle options for minute study views', () => {
    const options = studyReferenceQueryOptions(save, {
      venue: 'KRX',
      sourcePref: 'auto',
      volumeDistributionEnabled: true,
      tradeVolumePocEnabled: true,
      volumeDistributionRangeCount: 12,
    });

    expect(options.range.enabled).toBe(true);
    expect(options.range.queryKey[0]).toBe('range');
    expect(options.minuteCandles.enabled).toBe(true);
    expect(options.minuteCandles.queryKey).toEqual(['study', 'past-candles', '005930', '20260616', '20260618', 'KRX']);
    expect(options.dailyCandles.enabled).toBe(false);
  });

  it('builds daily candle options and disables range for daily study views', () => {
    const options = studyReferenceQueryOptions({ ...save, timeframe: 'D' }, {
      venue: 'KRX',
      sourcePref: 'auto',
      volumeDistributionEnabled: true,
      tradeVolumePocEnabled: true,
      volumeDistributionRangeCount: 12,
    });

    expect(options.range.enabled).toBe(false);
    expect(options.minuteCandles.enabled).toBe(false);
    expect(options.dailyCandles.enabled).toBe(true);
    expect(options.dailyCandles.queryKey).toEqual(['study', 'past-daily-candles', '005930', '20260616', '20260618', 'KRX']);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- --run src/studyViews/studyReferenceQueries.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the query spec module**

Create `frontend/src/studyViews/studyReferenceQueries.ts`:

```ts
import type { StudyViewReference } from '../api/studyViews';
import { rangeBundleQueryOptions } from '../api/range';
import {
  studyPastCandlesQueryOptions,
  studyPastDailyCandlesQueryOptions,
} from '../api/studyPastCandles';
import type { SourcePreference } from '../state/sourcePreference';
import type { LiveVenueOption } from '../state/liveVenue';
import { studyReferenceQueryInputs } from './studyReferenceBundleModel';

export type StudyReferenceQuerySettings = {
  venue: LiveVenueOption;
  sourcePref: SourcePreference;
  volumeDistributionEnabled: boolean;
  tradeVolumePocEnabled: boolean;
  volumeDistributionRangeCount: number;
};

export function studyReferenceRangeOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  const inputs = studyReferenceQueryInputs(save);
  return rangeBundleQueryOptions({
    code: inputs.range.code,
    from: inputs.range.from,
    to: inputs.range.to,
    timeframe: inputs.range.timeframe,
    todayKst: null,
    sourcePref: settings.sourcePref,
    options: {
      volumeDistributionBins: settings.volumeDistributionEnabled ? settings.volumeDistributionRangeCount : null,
      tradeVolumePocBins: settings.tradeVolumePocEnabled ? settings.volumeDistributionRangeCount : null,
      volumeDistributionPriceRange: null,
    },
  });
}

export function studyReferenceMinuteCandlesOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  const inputs = studyReferenceQueryInputs(save);
  return studyPastCandlesQueryOptions(
    inputs.minuteCandles.code,
    inputs.minuteCandles.from,
    inputs.minuteCandles.to,
    settings.venue,
  );
}

export function studyReferenceDailyCandlesOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  const inputs = studyReferenceQueryInputs(save);
  return studyPastDailyCandlesQueryOptions(
    inputs.dailyCandles.code,
    inputs.dailyCandles.from,
    inputs.dailyCandles.to,
    settings.venue,
  );
}

export function studyReferenceQueryOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  return {
    range: studyReferenceRangeOptions(save, settings),
    minuteCandles: studyReferenceMinuteCandlesOptions(save, settings),
    dailyCandles: studyReferenceDailyCandlesOptions(save, settings),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- --run src/studyViews/studyReferenceQueries.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/studyViews/studyReferenceQueries.ts frontend/src/studyViews/studyReferenceQueries.test.ts
git commit -m "feat: describe study reference queries"
```

---

### Task 4: Reuse Query Specs in Active Study Hook

**Files:**
- Modify: `frontend/src/studyViews/useStudyReferenceBundle.ts`
- Modify: `frontend/src/studyViews/useStudyReferenceBundle.test.tsx`

**Interfaces:**
- Consumes: `studyReferenceQueryOptions(save, settings)`
- Preserves: `useStudyReferenceBundle(save)` return shape.

- [ ] **Step 1: Update the test expectations to cover shared specs**

In `frontend/src/studyViews/useStudyReferenceBundle.test.tsx`, keep the existing tests and add:

```ts
it('passes disabled daily query inputs for minute views through the shared query specs', () => {
  renderHook(() => useStudyReferenceBundle(save));

  expect(useStudyPastDailyCandlesMock).toHaveBeenCalledWith(null, null, null, 'KRX');
});
```

- [ ] **Step 2: Run the hook test**

Run: `npm test -- --run src/studyViews/useStudyReferenceBundle.test.tsx`

Expected: PASS before implementation or FAIL only if the venue default differs; do not proceed until the expected current behavior is understood.

- [ ] **Step 3: Refactor the hook**

In `frontend/src/studyViews/useStudyReferenceBundle.ts`, import:

```ts
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { studyReferenceQueryOptions } from './studyReferenceQueries';
```

Inside the hook, add:

```ts
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const queryOptions = studyReferenceQueryOptions(save, {
    venue,
    sourcePref,
    tradeVolumePocEnabled,
    volumeDistributionEnabled,
    volumeDistributionRangeCount,
  });
```

Then replace direct input arguments with query option keys:

```ts
  const past = useRange(
    inputs.range.code,
    inputs.range.from,
    inputs.range.to,
    inputs.range.timeframe,
    undefined,
    null,
    {
      volumeDistributionBins: volumeDistributionEnabled ? volumeDistributionRangeCount : null,
      tradeVolumePocBins: tradeVolumePocEnabled ? volumeDistributionRangeCount : null,
      volumeDistributionPriceRange: null,
    },
  );
```

with either `useQuery(queryOptions.range)` or keep `useRange(...)`. Keeping `useRange(...)` is acceptable after `useRange` itself delegates to `rangeBundleQueryOptions(...)`; that keeps active and warm observer paths on the same query-key builder.

Use:

```ts
  const past = useQuery(queryOptions.range);
  const minuteCandles = useQuery(queryOptions.minuteCandles);
  const dailyCandles = useQuery(queryOptions.dailyCandles);
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run src/studyViews/useStudyReferenceBundle.test.tsx src/studyViews/studyReferenceQueries.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/studyViews/useStudyReferenceBundle.ts frontend/src/studyViews/useStudyReferenceBundle.test.tsx
git commit -m "refactor: reuse study reference query specs"
```

---

### Task 5: Add Background Prefetch Hook

> Superseded by the GSTACK REVIEW REPORT below and the implemented revision: use `frontend/src/studyViews/useWarmStudyReferenceTabQueries.ts` with mounted `useQueries` observers instead of `queryClient.prefetchQuery(...)`.

**Files:**
- Create: `frontend/src/studyViews/usePrefetchStudyReferenceTabs.ts`
- Create: `frontend/src/studyViews/usePrefetchStudyReferenceTabs.test.tsx`

**Interfaces:**
- Consumes:
  - `StudyTab[]`
  - `activeTabId`
  - saved `StudyViewReference[]`
  - per-view timeframe overrides
  - `studyReferenceQueryOptions(...)`
- Produces:
  - `function usePrefetchStudyReferenceTabs(args: UsePrefetchStudyReferenceTabsArgs): void`

- [ ] **Step 1: Write the failing hook test**

Create `frontend/src/studyViews/usePrefetchStudyReferenceTabs.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { StudyTab } from '../state/studyTabs';
import { usePrefetchStudyReferenceTabs } from './usePrefetchStudyReferenceTabs';

vi.mock('../api/client', () => ({
  apiCall: vi.fn(async (url: string) => {
    if (url.startsWith('/api/range')) {
      return {
        code: '005930',
        from_date: '20260616',
        to_date: '20260618',
        bucket_ms: 300000,
        segments: [],
        candles: [],
        quote_ratio: { bucket_ms: 300000, points: [] },
        fill_strength: { bucket_ms: 300000, points: [] },
        volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
        volume_profile_by_day: [],
        volume_distributions: [],
        investorPoints: [],
        ask_peaks: [],
        bid_peaks: [],
        broker_late_entries: [],
        program_trade: { points: [], source: 'kis_program_trade' },
        trade_volume_pocs: [],
      };
    }
    return { code: '005930', venue: 'KRX', candles: [], data_warnings: [] };
  }),
}));

import { apiCall } from '../api/client';

const save: StudyViewReference = {
  schema_version: 2,
  id: 'view-ref',
  name: '돌파 복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('usePrefetchStudyReferenceTabs', () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockClear();
  });

  it('prefetches inactive study tab queries and skips the active tab', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tabs: StudyTab[] = [
      { id: 'active', viewId: 'active-view', code: '000660', label: 'active', name: 'active', timeframe: '5m' },
      { id: 'inactive', viewId: 'view-ref', code: '005930', label: 'inactive', name: 'inactive', timeframe: '5m' },
    ];

    renderHook(() => usePrefetchStudyReferenceTabs({
      tabs,
      activeTabId: 'active',
      saves: [save],
      viewTimeframes: {},
    }), { wrapper: wrapper(client) });

    await waitFor(() => {
      expect(apiCall).toHaveBeenCalledWith(expect.stringContaining('/api/range?code=005930'), expect.any(Object));
      expect(apiCall).toHaveBeenCalledWith(expect.stringContaining('/api/live/past-candles?code=005930'), expect.any(Object));
    });
    expect(vi.mocked(apiCall).mock.calls.some(([url]) => String(url).includes('000660'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- --run src/studyViews/usePrefetchStudyReferenceTabs.test.tsx`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement the hook**

Create `frontend/src/studyViews/usePrefetchStudyReferenceTabs.ts`:

```ts
import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { StudyViewReference } from '../api/studyViews';
import type { StudyTab } from '../state/studyTabs';
import type { LiveTimeframe } from '../state/livePage';
import { useLivePageStore } from '../state/livePage';
import { useLiveVenueStore } from '../state/liveVenue';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { referenceStudyView } from './studyViewVariant';
import { studyReferenceQueryOptions } from './studyReferenceQueries';

export type UsePrefetchStudyReferenceTabsArgs = {
  tabs: StudyTab[];
  activeTabId: string | null;
  saves: StudyViewReference[];
  viewTimeframes: Record<string, LiveTimeframe>;
};

export function usePrefetchStudyReferenceTabs({
  tabs,
  activeTabId,
  saves,
  viewTimeframes,
}: UsePrefetchStudyReferenceTabsArgs): void {
  const queryClient = useQueryClient();
  const venue = useLiveVenueStore((s) => s.venue);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);

  const inactiveSaves = useMemo(() => {
    const byId = new Map(saves.map((save) => [save.id, save]));
    return tabs
      .filter((tab) => tab.id !== activeTabId)
      .map((tab) => {
        const save = referenceStudyView(byId.get(tab.viewId) ?? null);
        if (!save) return null;
        const timeframe = viewTimeframes[save.id] ?? save.timeframe;
        return { ...save, timeframe };
      })
      .filter((save): save is StudyViewReference => save !== null);
  }, [activeTabId, saves, tabs, viewTimeframes]);

  useEffect(() => {
    if (inactiveSaves.length === 0) return;
    const settings = {
      venue,
      sourcePref,
      tradeVolumePocEnabled,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    };

    for (const save of inactiveSaves) {
      const options = studyReferenceQueryOptions(save, settings);
      for (const queryOptions of [options.range, options.minuteCandles, options.dailyCandles]) {
        if (!queryOptions.enabled) continue;
        void queryClient.prefetchQuery(queryOptions).catch(() => undefined);
      }
    }
  }, [
    inactiveSaves,
    queryClient,
    sourcePref,
    tradeVolumePocEnabled,
    venue,
    volumeDistributionEnabled,
    volumeDistributionRangeCount,
  ]);
}
```

- [ ] **Step 4: Run the hook test**

Run: `npm test -- --run src/studyViews/usePrefetchStudyReferenceTabs.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/studyViews/usePrefetchStudyReferenceTabs.ts frontend/src/studyViews/usePrefetchStudyReferenceTabs.test.tsx
git commit -m "feat: prefetch inactive study tabs"
```

---

### Task 6: Wire Background Prefetch Into StudyPage

> Superseded by the GSTACK REVIEW REPORT below and the implemented revision: wire `useWarmStudyReferenceTabQueries(...)`, track session-activated tab ids in memory, and pass per-tab statuses to `StudyTabBar`.

**Files:**
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: `usePrefetchStudyReferenceTabs(...)`
- Preserves: current visible loading behavior and clickable tab bar.

- [ ] **Step 1: Mock the hook in StudyPage tests**

In `frontend/src/studyViews/StudyPage.test.tsx`, add to `vi.hoisted`:

```ts
  usePrefetchStudyReferenceTabsMock: vi.fn(),
```

Add mock:

```ts
vi.mock('./usePrefetchStudyReferenceTabs', () => ({
  usePrefetchStudyReferenceTabs: usePrefetchStudyReferenceTabsMock,
}));
```

Add to `beforeEach`:

```ts
  usePrefetchStudyReferenceTabsMock.mockClear();
```

- [ ] **Step 2: Write the StudyPage wiring test**

Add to `StudyPage.test.tsx`:

```ts
it('starts background prefetching for open inactive study tabs', () => {
  useStudyTabsStore.setState({
    tabs: [
      {
        id: 'tab-a',
        viewId: 'view-ref',
        code: '005930',
        label: '삼성전자 · 돌파 복기 · 5m',
        name: '돌파 복기',
        timeframe: '5m',
      },
      {
        id: 'tab-b',
        viewId: 'view-second',
        code: '000660',
        label: 'SK하이닉스 · 눌림 복기 · 5m',
        name: '눌림 복기',
        timeframe: '5m',
      },
    ],
    activeTabId: 'tab-a',
  });

  renderPage('/study?view=view-ref');

  expect(usePrefetchStudyReferenceTabsMock).toHaveBeenCalledWith(expect.objectContaining({
    activeTabId: 'tab-a',
    saves: [referenceSave, secondReferenceSave],
  }));
  expect(usePrefetchStudyReferenceTabsMock.mock.calls[0][0].tabs).toHaveLength(2);
});
```

- [ ] **Step 3: Run StudyPage test and verify failure**

Run: `npm test -- --run src/studyViews/StudyPage.test.tsx`

Expected: FAIL because `StudyPage` does not call the hook yet.

- [ ] **Step 4: Wire the hook**

In `frontend/src/studyViews/StudyPage.tsx`, import:

```ts
import { usePrefetchStudyReferenceTabs } from './usePrefetchStudyReferenceTabs';
```

After `useStudyKeyboard(...)`, call:

```ts
  usePrefetchStudyReferenceTabs({
    tabs,
    activeTabId,
    saves: savesQuery.data?.saves ?? [],
    viewTimeframes,
  });
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- --run src/studyViews/StudyPage.test.tsx src/studyViews/usePrefetchStudyReferenceTabs.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat: keep study tabs loading in background"
```

---

### Task 7: Final Verification

**Files:**
- No new files.

**Interfaces:**
- Verifies all previous tasks.

- [ ] **Step 1: Run focused study and API tests**

Run:

```bash
npm test -- --run \
  src/api/range.test.tsx \
  src/api/studyPastCandles.test.tsx \
  src/studyViews/studyReferenceQueries.test.ts \
  src/studyViews/useStudyReferenceBundle.test.tsx \
  src/studyViews/usePrefetchStudyReferenceTabs.test.tsx \
  src/studyViews/StudyPage.test.tsx
```

Expected: all listed test files pass.

- [ ] **Step 2: Run frontend build**

Run:

```bash
npm run build
```

Expected: `tsc -b && vite build` exits 0. Vite may print the existing large chunk warning.

- [ ] **Step 3: Manual QA**

Run:

```bash
npm run dev
```

Manual steps:

1. Open `/study`.
2. Click a saved view that takes noticeable time to load.
3. Immediately click another open study tab.
4. Watch Network: requests for the first tab continue instead of being aborted.
5. Return to the first tab: if its requests completed, the chart renders from cache without restarting all fetches.
6. Change timeframe on one tab and switch away: the new timeframe requests continue and are cached for return.

- [ ] **Step 4: Commit final verification notes if any test fixtures changed**

Only commit if files changed during verification:

```bash
git status --short
git add <changed-files>
git commit -m "test: verify study tab background loading"
```

---

## Self-Review

- Spec coverage: The plan keeps tabs clickable, prevents active-tab-only cancellation from being the only load path, uses mounted React Query warm observers for activated inactive tabs, and preserves active chart mounting behavior.
- Placeholder scan: No implementation step contains `TBD`, vague "handle edge cases", or undefined later-task interfaces.
- Type consistency: `StudyReferenceQuerySettings`, `studyReferenceQueryOptions`, and `useWarmStudyReferenceTabQueries` names are consistent in the implemented revision.

## GSTACK REVIEW REPORT

| Run | Status | Findings |
|---|---|---|
| grill-with-docs + plan-eng-review | DONE_WITH_CONCERNS | 4 material plan changes recommended before implementation |

### Findings

`[P1] (confidence: 9/10) docs/superpowers/plans/2026-06-26-study-tabs-background-loading.md:7 — Fire-and-forget prefetch does not satisfy the stated "must not cancel previous in-flight load" requirement.`

Motivating lines:
- Plan architecture says: `add a background prefetch hook that calls queryClient.prefetchQuery(...)`
- Existing query functions consume React Query's AbortSignal: `frontend/src/api/range.ts:96` passes `apiCall<RangeBundle>(request.url, { signal })`
- Existing study candle queries also consume it: `frontend/src/api/studyPastCandles.ts:27` passes `{ signal }`

Recommendation: Replace `usePrefetchStudyReferenceTabs` with mounted warm query observers using `useQueries`. Keep observers mounted for warmed study-tab query keys so switching active tabs never creates a zero-observer gap that aborts the previous request.

`[P1] (confidence: 8/10) docs/superpowers/plans/2026-06-26-study-tabs-background-loading.md:48 — The plan warms every inactive open tab, which can create accidental request fanout.`

Motivating line:
- Plan file says: `Prefetch inactive open study tabs in the background.`

Recommendation: Warm only tabs that have been activated in this browser session, plus the current active tab. This matches the user story: "I started loading A, moved to B, A should continue." It does not silently start loading never-opened tabs.

`[P2] (confidence: 8/10) docs/superpowers/plans/2026-06-26-study-tabs-background-loading.md:1 — "Background Loading" conflicts with existing domain language around background KIS roles.`

Motivating line:
- `CONTEXT.md` uses **background** for KIS REST account routing: foreground chart fetches vs background pollers/quotes/screener.

Recommendation: Rename the feature to **Inactive Study Tab Query Warmup** / **비활성 학습 탭 쿼리 워밍**. Avoid "background" as a standalone noun in this plan.

`[P2] (confidence: 8/10) docs/superpowers/plans/2026-06-26-study-tabs-background-loading.md:361 — The plan lacks a regression test proving "not aborted after tab switch."`

Motivating lines:
- Manual QA says to watch Network for requests continuing, but automated tests only verify prefetch calls.
- Existing fetch layer forwards `RequestInit` directly to `fetch`: `frontend/src/api/client.ts:57` uses `fetch(await apiUrl(path), init)`.

Recommendation: Add a hook/page regression test with deferred API promises and inspect the first tab's `AbortSignal.aborted === false` after switching tabs.

### Optimal Answers To Grilling Questions

1. **Name:** Use **Inactive Study Tab Query Warmup**, not "Background Loading". This avoids collision with KIS background account routing and says exactly what the feature does.
2. **Core mechanism:** Use `useQueries` warm observers, not `queryClient.prefetchQuery`. `prefetchQuery` is good for "fetch before needed"; mounted observers are the right tool for "do not abort when the active component changes."
3. **Warm scope:** Warm the active tab and tabs activated during the current `/study` session. Do not warm every restored/open tab by default.
4. **Observer continuity:** Include the active tab in the warm observer set. That creates overlap before and after focus changes, avoiding a zero-observer cancellation window.
5. **Cleanup:** Remove warmed entries when a tab closes or its saved view is deleted. Do not persist the warmed set to localStorage.
6. **Status UI:** Extend the tab bar status contract to optionally support per-tab status (`idle | loading | ready | error`) while keeping `/live` behavior unchanged by default. This makes parallel loading visible instead of mysterious.
7. **Inactive errors:** Cache inactive query errors and show an error status on that tab; render the full error state only when the user focuses it.
8. **Current settings:** Warm queries must use current Source Preference, venue, and `/live` indicator settings. Query keys already encode the meaningful request options, so setting changes naturally produce fresh query keys.
9. **Legacy/v1 posture:** Keep using `referenceStudyView(...)` guards even though `StudyViewListRow` is currently v2-only. It protects the separate `/study` route contract if legacy rows re-enter the frontend model.
10. **Docs:** Do not create an ADR. This is reversible UI/query behavior, not a hard-to-reverse architecture decision. Update the plan terminology only; `CONTEXT.md` does not need a new domain term unless the UI copy exposes it.
11. **Concurrency cap:** No numeric cap for v1. Because only user-activated open tabs warm, request count tracks explicit user navigation. Add a TODO only if real use shows users activating many tabs rapidly.
12. **Tests:** Add unit tests for query option reuse, hook tests for warmed observer membership, and a StudyPage regression proving the first tab's signal is not aborted after switching.

### What Already Exists

- `useStudyReferenceBundle(save)` already composes the three required data reads for an active **복기뷰**.
- `buildRangeBundleRequest(...)` already centralizes `/api/range` URL and query-key construction.
- `studyReferenceQueryInputs(save)` already knows minute vs calendar query selection.
- `useStudyTabsStore` already owns tab identity, close/focus/reorder, and in-memory viewport.
- `ChartTabBar` already renders a status dot, but its API is active-only; it can be widened compatibly.

### NOT In Scope

- Hidden mounted `LiveChartRoot` instances: rejected because chart DOM/canvas keepalive is a larger memory and resize problem.
- Server-side background jobs: not needed; this is browser cache/query observer behavior.
- New KIS role routing: not needed and would collide with the existing foreground/background account split.
- Persistent warm state: rejected because warm queries are runtime convenience, not saved study-view state.
- Global `/live` tab keep-alive: separate TODO exists and has much larger blast radius.

### Test Coverage Diagram

```text
CODE PATHS                                             USER FLOWS
[+] range query options                                [+] Load A, switch to B while A pending
  ├── [★★★ required] key/url/signal parity                ├── [GAP] A signal remains non-aborted
  └── [★★★ required] disabled/null inputs                 └── [GAP] B starts while A continues
[+] study candle query options                         [+] Change timeframe, switch away
  ├── [★★★ required] minute key/url/signal                ├── [GAP] new timeframe query keeps warming
  └── [★★★ required] daily key/url/signal                 └── [GAP] return uses cache if complete
[+] warmed study tab observers                         [+] Close/delete tab
  ├── [★★★ required] active + activated tabs observed     ├── [GAP] closed tab stops warming
  ├── [★★★ required] never-activated tabs skipped         └── [GAP] deleted save removes warm entry
  └── [★★★ required] inactive error becomes tab status
```

### Failure Modes

- Active tab switches while previous query is pending: covered by new abort-signal regression; user should see both tabs capable of completing.
- User rapidly activates many tabs: not capped in v1; browser/React Query concurrency handles it, and only user-activated tabs warm.
- Inactive query fails: should set tab error status and render full error on focus.
- Source/indicator settings change mid-load: new query keys should start new warm queries; old cache remains harmless.
- Save is deleted while warmed: hook must prune closed/deleted view ids.

### Worktree Parallelization

Sequential implementation is recommended. The core tasks share `frontend/src/api` and `frontend/src/studyViews`, and the main architectural correction changes the same hook/page surfaces.

### Implementation Tasks

- [ ] **T1 (P1, human: ~1h / CC: ~15min)** — Query architecture — Replace `prefetchQuery` plan with `useQueries` warm observers.
  - Surfaced by: Architecture review — prefetch does not guarantee non-abort when existing query consumes AbortSignal.
  - Files: `frontend/src/studyViews/useWarmStudyReferenceTabQueries.ts`, `frontend/src/studyViews/useStudyReferenceBundle.ts`, `frontend/src/studyViews/StudyPage.tsx`
  - Verify: deferred-promise abort regression in `StudyPage.test.tsx`.
- [ ] **T2 (P1, human: ~45min / CC: ~10min)** — Warm scope — Track activated study tabs and prune warm entries on close/delete.
  - Surfaced by: Performance review — warming every inactive restored tab can overfetch.
  - Files: `frontend/src/studyViews/StudyPage.tsx`, `frontend/src/studyViews/useWarmStudyReferenceTabQueries.ts`
  - Verify: hook test proves never-activated tab is skipped and closed tab is removed.
- [ ] **T3 (P2, human: ~45min / CC: ~10min)** — Tab UX — Add optional per-tab query status to `ChartTabBar`.
  - Surfaced by: Code quality/test review — inactive loading/error is otherwise silent.
  - Files: `frontend/src/tabs/ChartTabBar.tsx`, `frontend/src/studyViews/StudyTabBar.tsx`, `frontend/src/studyViews/StudyPage.test.tsx`
  - Verify: tab status tests for loading and error, plus existing live tab tests unchanged.
- [ ] **T4 (P2, human: ~20min / CC: ~5min)** — Plan terminology — Rename to Inactive Study Tab Query Warmup.
  - Surfaced by: grill-with-docs glossary check — "background" conflicts with KIS role language.
  - Files: `docs/superpowers/plans/2026-06-26-study-tabs-background-loading.md`
  - Verify: no ambiguous standalone "background loading" wording remains.

### Architecture Deepening Review

Reviewed with `improve-codebase-architecture` candidates, then filtered through `plan-eng-review` for scope, blast radius, tests, and performance. Only work that improves this specific `/study` loading change is eligible for this plan.

| Candidate | Decision | Reason |
|---|---|---|
| 복기뷰 Load Plan Module | **Reflect as optional P2 cleanup** | `useStudyReferenceBundle(...)` and `useWarmStudyReferenceTabQueries(...)` now share the same business rule but still compose it through different Interfaces. A small cleanup can make the active hook consume `studyReferenceQueryOptions(...)`, giving active and warm paths one query-plan Module. |
| Study Tab Session State Module | **Defer** | `StudyPage.tsx` is large, but extracting tab session state is not required to keep loading alive across tab switches. This would be a broader page-structure refactor with higher churn than the user-facing bug needs. |
| Chart Tab Status Adapter | **Do not expand now** | The current optional `tabStatus` prop is enough. A deeper status Adapter would be premature until `/live` or another caller also needs per-tab status semantics. |
| Study View Variant Module cleanup | **Defer** | `studyViewVariant.ts` is shallow, but changing the legacy/reference posture is unrelated to loading continuity. Keep the guard until a separate v1/v2 cleanup decision is made. |

Additional scoped task:

- [x] **T5 (P2, human: ~45min / CC: ~10min)** — 복기뷰 Load Plan — Make the active view hook reuse the same query-plan Module as warm observers.
  - Surfaced by: Architecture deepening review — active and inactive 복기뷰 loading paths currently duplicate query composition knowledge.
  - Files: `frontend/src/studyViews/useStudyReferenceBundle.ts`, `frontend/src/studyViews/studyReferenceQueries.ts`, `frontend/src/studyViews/useStudyReferenceBundle.test.tsx`
  - Verify: existing focused study tests still pass, and active hook tests prove range/minute/daily query selection is unchanged.

VERDICT: REVISE BEFORE IMPLEMENTATION. The user goal is right, but the current `prefetchQuery` architecture is the wrong primitive for non-cancellation. Use mounted warm observers via `useQueries`, warm only activated tabs, and add an abort-signal regression test.

NO UNRESOLVED DECISIONS
