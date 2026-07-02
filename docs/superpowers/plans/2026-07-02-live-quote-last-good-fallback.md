# Live Quote Last Good Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the last valid live quote change fields visible in watchlist and heatmap rows when `/api/live/quotes` briefly marks change data unavailable.

**Architecture:** Implement the fallback at the shared `useLiveQuoteOverlay` seam so watchlist, heatmap rows, sector averages, and change-rate sorting all consume the same retained quote map. Do not change row components; only `change_pct_source: 'unavailable'` responses borrow the previous change fields.

**Tech Stack:** React 18, TypeScript, TanStack Query, Vitest, Testing Library React hooks.

## Global Constraints

- Scope stays in the frontend live quote overlay.
- No backend API contract changes.
- No new dependencies.
- Preserve initial loading behavior: no quote has arrived yet still returns an empty `Map`.
- Preserve intentional null fields: a returned quote with `change_pct_source: 'hidden_pre_open'` must not be replaced by an older non-null percent.

---

### Task 1: Retain Last Good Change Fields in Live Quote Overlay

**Files:**
- Modify: `frontend/src/api/liveQuotes.test.tsx`
- Modify: `frontend/src/api/liveQuotes.ts`

**Interfaces:**
- Consumes: `useLiveQuoteOverlay(codes: string[], venue?: LiveVenueOption): LiveQuoteOverlay`
- Produces: unchanged `LiveQuoteOverlay`, with `quoteByCode` using current quotes plus last-good change-field fallback for `change_pct_source: 'unavailable'`.

- [ ] **Step 1: Write the failing test**

Add a hook test showing a normal quote response followed by an unavailable change response keeps the previous change fields for the same requested code:

```tsx
it('keeps last good change fields when a transient response marks them unavailable', async () => {
  vi.spyOn(client, 'apiCall')
    .mockResolvedValueOnce({ phase: 'open', quotes: [{ code: '005930', price: 72400, change_pct: 1.2, change_won: 100 }] })
    .mockResolvedValueOnce({ phase: 'open', quotes: [{ code: '005930', price: 72500, change_pct: null, change_won: null, change_pct_source: 'unavailable' }] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useQuoteByCode(['005930']), { wrapper });
  await waitFor(() => expect(result.current.get('005930')?.price).toBe(72400));
  await act(async () => {
    await qc.refetchQueries({ queryKey: liveQuotesQueryKey(['005930']) });
  });
  await waitFor(() => expect(result.current.get('005930')?.price).toBe(72500));
  expect(result.current.get('005930')?.change_pct).toBe(1.2);
  expect(result.current.get('005930')?.change_won).toBe(100);
});
```

Use the real query client refetch API instead of adding a production-only test method.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- src/api/liveQuotes.test.tsx --run`

Expected: FAIL because `change_pct` becomes `null` after the second successful response.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/api/liveQuotes.ts`, store the previous quote map in a React ref inside `useLiveQuoteOverlay`. On every returned quote, update that ref. Build the exposed map from the current response first; if a returned quote has `change_pct_source: 'unavailable'` and `change_pct: null`, keep the current price/OHLC but borrow the previous `change_pct` and `change_won`.

- [ ] **Step 4: Run focused tests**

Run: `npm --prefix frontend test -- src/api/liveQuotes.test.tsx --run`

Expected: PASS.

- [ ] **Step 5: Run adjacent tests**

Run: `npm --prefix frontend test -- src/api/liveQuotes.test.tsx src/watchlist/WatchlistDrawer.test.tsx src/heatmap/heat.test.ts src/heatmap/HeatmapFolder.test.tsx --run`

Expected: PASS.
