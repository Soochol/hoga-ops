# Trade Volume POC Auction Cutoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `당일 최대 매물대` use the same structural closing-auction exclusion as `연속체결 매물대 분포` for today's live calculation.

**Architecture:** Backend historical and sidecar `TradeVolumePoc` already receives `continuous_before_ms` through `build_trade_volume_poc_slice()` and `query_trade_volume_poc()`. The missing path is frontend live recomputation: derive `firstTrailingSinglePriceBookMs()` from live orderbook snapshots, pass it into `useTradeVolumePocs()`, and have `computeTradeVolumePoc()` ignore trades at/after that boundary. Keep the existing 15:20 time gate as a fallback only when no structural boundary exists.

**Tech Stack:** TypeScript, React hooks, Vitest, existing live SSE `ObSnapshot`/`TradeSnapshot` buffers.

## Global Constraints

- Do not exclude intraday VI by adding a broad "non-continuous book" filter before the final trailing single-price phase; reuse `firstTrailingSinglePriceBookMs()` semantics.
- Do not change historical/backend POC behavior except for tests that prove it already follows `continuous_before_ms`.
- Do not add new UI settings; this is a policy alignment with `연속체결 매물대 분포`.
- Keep `side === 1 || side === -1` as the trade eligibility rule.
- Keep existing range-count semantics: `당일 최대 매물대` uses `volumeDistributionRangeCount`.

---

## File Structure

- Modify `frontend/src/live/tradeVolumePoc.ts`: add a `continuousBeforeMs?: number | null` option and apply it in both distribution-bin and legacy price-band POC paths.
- Modify `frontend/src/live/useTradeVolumePoc.ts`: accept live orderbook snapshots, compute today's structural cutoff with `firstTrailingSinglePriceBookMs()`, and pass it to `computeTradeVolumePoc()`.
- Modify `frontend/src/live/LivePage.tsx`: pass the live orderbook buffer into `useTradeVolumePocs()`.
- Test `frontend/src/live/tradeVolumePoc.test.ts`: prove trades at/after structural cutoff do not affect today's POC even before fixed 15:20.
- Test `frontend/src/live/useTradeVolumePoc.test.tsx`: prove the hook derives the cutoff from live 10-level then 3-level orderbooks and excludes post-cutoff live trades.
- Optional backend regression test `tests/hoga/api/test_bundle.py`: keep existing server-side coverage that `trade_volume_pocs` uses `continuous_before_ms`; no new backend code expected.

---

### Task 1: Add Structural Cutoff Option To POC Calculator

**Files:**
- Modify: `frontend/src/live/tradeVolumePoc.ts`
- Test: `frontend/src/live/tradeVolumePoc.test.ts`

**Interfaces:**
- Consumes: existing `computeTradeVolumePoc(trades, options)`
- Produces: `computeTradeVolumePoc(trades, { continuousBeforeMs })`

- [ ] **Step 1: Write the failing calculator test**

Add this test inside `describe('computeTradeVolumePoc', ...)` in `frontend/src/live/tradeVolumePoc.test.ts`:

```ts
  it('excludes live trades at and after a structural continuous-before cutoff', () => {
    const segment = {
      date: '20260624',
      session_open_ms: atKst(9, 0),
      session_close_ms: atKst(15, 30),
      source: 'kis_live' as const,
    };

    const poc = computeTradeVolumePoc([
      trade(atKst(14, 59), 110, 20),
      trade(atKst(15, 5), 100, 1_000),
      trade(atKst(15, 6), 100, 1_000),
    ], {
      date: '20260624',
      candles: [{ ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      rangeCount: 2,
      segment,
      continuousBeforeMs: atKst(15, 5),
    });

    expectPoc(poc, {
      centerPrice: 115,
      lowPrice: 110,
      highPrice: 120,
      qty: 20,
      t_ms: atKst(14, 59),
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend
npm test -- --run src/live/tradeVolumePoc.test.ts
```

Expected: the new test fails because `continuousBeforeMs` is not part of the options type and/or the 15:05/15:06 trades are included.

- [ ] **Step 3: Implement minimal calculator change**

In `frontend/src/live/tradeVolumePoc.ts`, add the option to `computeTradeVolumePoc`:

```ts
  options: {
    bandPct?: number;
    date?: string;
    candles?: readonly Candle[];
    rangeCount?: number;
    segment?: RangeSegment;
    continuousBeforeMs?: number | null;
  } = {},
```

Then in the distribution-bin branch, directly after:

```ts
        if (tMs < options.segment.session_open_ms || tMs >= options.segment.session_close_ms) continue;
```

add:

```ts
        if (options.continuousBeforeMs != null && tMs >= options.continuousBeforeMs) continue;
```

In the legacy price-band branch, directly after:

```ts
      if (!isRegularContinuousTrade(tMs)) continue;
```

add:

```ts
      if (options.continuousBeforeMs != null && tMs >= options.continuousBeforeMs) continue;
```

- [ ] **Step 4: Run calculator tests**

Run:

```bash
cd frontend
npm test -- --run src/live/tradeVolumePoc.test.ts
```

Expected: all `tradeVolumePoc` tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/tradeVolumePoc.ts frontend/src/live/tradeVolumePoc.test.ts
git commit -m "fix: apply structural cutoff to live trade volume poc"
```

---

### Task 2: Derive And Pass Today's Live Structural Cutoff

**Files:**
- Modify: `frontend/src/live/useTradeVolumePoc.ts`
- Test: `frontend/src/live/useTradeVolumePoc.test.tsx`

**Interfaces:**
- Consumes: `firstTrailingSinglePriceBookMs(snapshots, sessionCloseMs): number | null` from `frontend/src/live/continuousTradeVolumeDistribution.ts`
- Produces: `useTradeVolumePocs(trades, seeds, todayKst, code, candles, segments, orderbooks?)`

- [ ] **Step 1: Write the failing hook test**

Add imports in `frontend/src/live/useTradeVolumePoc.test.tsx`:

```ts
import type { ObSnapshot } from './bucketHogaSeries';
```

Add these helpers near `atKst()`:

```ts
function book(t_ms: number, continuous: boolean): ObSnapshot {
  const levels = Array.from({ length: 10 }, (_, index) => ({
    price: 100 + index,
    qty: continuous || index < 3 ? 1 : 0,
  }));
  return {
    t_ms,
    total_ask_qty: 10,
    total_bid_qty: 10,
    asks: levels,
    bids: levels,
  };
}
```

Add this test inside `describe('useTradeVolumePocs', ...)`:

```ts
  it('excludes today live trades at and after the first trailing single-price orderbook', () => {
    useLivePageStore.setState({
      tradeVolumePocBandPct: 0.005,
      volumeDistributionRangeCount: 2,
    });

    const { result } = renderHook(() => useTradeVolumePocs(
      [
        { t_ms: atKst(14, 59), trades: [{ t_ms: atKst(14, 59), price: 110, qty: 20, side: 1 }] },
        { t_ms: atKst(15, 5), trades: [{ t_ms: atKst(15, 5), price: 100, qty: 1_000, side: 1 }] },
      ],
      [],
      '20260625',
      '005930',
      [{ ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      [{ date: '20260625', session_open_ms: atKst(9, 0), session_close_ms: atKst(15, 30), source: 'kis_live' }],
      [
        book(atKst(14, 59), true),
        book(atKst(15, 5), false),
      ],
    ));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      date: '20260625',
      lowPrice: 110,
      highPrice: 120,
      qty: 20,
      t_ms: atKst(14, 59),
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend
npm test -- --run src/live/useTradeVolumePoc.test.tsx
```

Expected: TypeScript/test failure because `useTradeVolumePocs` does not accept the orderbook argument yet, or assertion failure because the 15:05 trade is included.

- [ ] **Step 3: Implement hook change**

In `frontend/src/live/useTradeVolumePoc.ts`, update imports:

```ts
import { firstTrailingSinglePriceBookMs } from './continuousTradeVolumeDistribution';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
```

Update the function signature:

```ts
export function useTradeVolumePocs(
  trades: readonly TradeSnapshot[],
  seeds: readonly TradeVolumePocWire[],
  todayKst: string,
  code: string | null,
  candles: readonly Candle[] = [],
  segments: readonly RangeSegment[] = [],
  orderbooks: readonly ObSnapshot[] = [],
): TradeVolumePoc[] {
```

Inside the main `useMemo`, after `const todaySegment = ...`, add:

```ts
    const todayContinuousBeforeMs = todaySegment
      ? firstTrailingSinglePriceBookMs(orderbooks, todaySegment.session_close_ms)
      : null;
```

Then pass it to both today live calls:

```ts
      ? computeTradeVolumePoc(trades, {
        date: todayKst,
        bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT,
        candles: todayCandles,
        rangeCount,
        segment: todaySegment,
        continuousBeforeMs: todayContinuousBeforeMs,
      })
      : computeTradeVolumePoc(trades, {
        date: todayKst,
        bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT,
        continuousBeforeMs: todayContinuousBeforeMs,
      });
```

Add `orderbooks` to the dependency list:

```ts
  }, [trades, seeds, todayKst, code, candles, segments, rangeCount, candleFallbacks, orderbooks]);
```

- [ ] **Step 4: Run hook tests**

Run:

```bash
cd frontend
npm test -- --run src/live/useTradeVolumePoc.test.tsx src/live/tradeVolumePoc.test.ts
```

Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/useTradeVolumePoc.ts frontend/src/live/useTradeVolumePoc.test.tsx
git commit -m "fix: derive live poc auction cutoff from orderbook structure"
```

---

### Task 3: Wire Live Orderbooks From LivePage

**Files:**
- Modify: `frontend/src/live/LivePage.tsx`
- Test: existing `frontend/src/live/LivePage.test.tsx` if mocks require signature updates

**Interfaces:**
- Consumes: updated `useTradeVolumePocs(..., orderbooks)`
- Produces: live page passes the same `ob` buffer used by `연속체결 매물대 분포`

- [ ] **Step 1: Update the call site**

In `frontend/src/live/LivePage.tsx`, find the current call:

```ts
  const tradeVolumePocs = useTradeVolumePocs(
    trade,
    (chartBundle ?? bundle)?.trade_volume_pocs ?? [],
    todayKst,
    stockCode,
    activeBundle?.candles ?? [],
    activeBundle?.segments ?? [],
  );
```

Change it to:

```ts
  const tradeVolumePocs = useTradeVolumePocs(
    trade,
    (chartBundle ?? bundle)?.trade_volume_pocs ?? [],
    todayKst,
    stockCode,
    activeBundle?.candles ?? [],
    activeBundle?.segments ?? [],
    ob,
  );
```

- [ ] **Step 2: Run affected tests**

Run:

```bash
cd frontend
npm test -- --run src/live/LivePage.test.tsx src/live/useTradeVolumePoc.test.tsx src/live/tradeVolumePoc.test.ts
```

Expected: tests pass. If `LivePage.test.tsx` mocks `useTradeVolumePocs` with strict arity, update only that mock to accept the seventh argument and ignore it.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/live/LivePage.tsx frontend/src/live/LivePage.test.tsx
git commit -m "fix: pass live orderbook cutoff context to trade volume poc"
```

---

### Task 4: Final Verification And Release Metadata

**Files:**
- Modify: `VERSION`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: all previous code changes
- Produces: release entry for the shipped fix

- [ ] **Step 1: Run final frontend tests**

Run:

```bash
cd frontend
npm test -- --run src/live/tradeVolumePoc.test.ts src/live/useTradeVolumePoc.test.tsx src/live/continuousTradeVolumeDistribution.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run backend guard tests**

Run:

```bash
uv run --extra dev pytest tests/test_tables_trades.py -k "trade_volume_poc" -q
uv run --extra dev pytest tests/hoga/api/test_bundle.py -k "continuous_before_cutoff or false_early_single_price_cutoff" -q
```

Expected: selected backend POC and structural cutoff tests pass.

- [ ] **Step 3: Run production build**

Run:

```bash
cd frontend
npm run build
```

Expected: TypeScript build and Vite build pass. Existing chunk-size warning is acceptable.

- [ ] **Step 4: Bump version and changelog**

If current `VERSION` is `0.12.9.3`, update `VERSION` to:

```text
0.12.9.4
```

Add this entry at the top of `CHANGELOG.md`:

```md
## [0.12.9.4] - 2026-06-27

### Fixed
- **당일 최대 매물대 동시호가 제외 기준 통일**: 오늘 live 계산도 연속체결 매물대 분포와 같은 호가 구조 기반 cutoff를 사용해, 마감 동시호가 체결이 당일 최대 매물대 구간을 뒤집지 않도록 했다.
```

- [ ] **Step 5: Commit release metadata**

```bash
git add VERSION CHANGELOG.md
git commit -m "chore: release 0.12.9.4"
```

---

## Self-Review

1. Spec coverage: The plan covers the requested same-policy application for `당일 최대 매물대`, specifically the missing today live path. Backend behavior is verified but not rewritten because it already uses `continuous_before_ms`.
2. Placeholder scan: No task contains TBD/TODO/fill-later placeholders. Each task has exact files, code snippets, commands, and expected results.
3. Type consistency: `continuousBeforeMs?: number | null` is introduced once in `computeTradeVolumePoc` and passed from `useTradeVolumePocs`; `orderbooks: readonly ObSnapshot[] = []` is the seventh hook parameter and is wired from `LivePage.tsx`.
