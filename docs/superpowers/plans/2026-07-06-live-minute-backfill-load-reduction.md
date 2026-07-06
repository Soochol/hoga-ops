# Live Minute Backfill Load Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `/live` minute-chart historical pan load by skipping known non-trading-day KIS calls and changing past-candle fetching from expanding full-range refetches to incremental delta fetches.

**Architecture:** Keep the first fix entirely server-side in `LiveMinuteCandleBackfill`: dates known to be non-trading days become zero-candle cache entries without entering the KIS capacity scheduler. For the second fix, keep the backend response contract unchanged and make the frontend compose cached range chunks: fetch only the newly prepended date window after a leftward pan, retain prior `past-candles` chunks in memory, and expose a merged response to `useLiveBundle`.

**Tech Stack:** Python 3.14/FastAPI/pytest for backend; React 18 + TanStack Query + Vitest for frontend; no new runtime dependencies.

## Global Constraints

- Scope is limited to `past-candles` non-trading-day gating and `past-candles` full-range refetch/delta structure.
- Do not change `/api/range?mode=hoga` or `/api/range?mode=sidecar` behavior in this plan.
- Preserve `/api/live/past-candles` response shape: `{ code, from, to, venue, candles, cached_dates, fresh_dates, data_warnings, effective_sessions }`.
- Preserve current historical prepend viewport behavior in `useViewportBackfill` and `LiveChartRoot`.
- Favor existing cache and calendar helpers over new dependencies.

---

## File Structure

- Modify `hoga/live/live_candle_backfill.py`
  - Add a trading-day gate before scheduling past-date KIS minute fetches.
  - Store known-empty past dates in `PastCandlesCache` so repeated range requests do not re-check them.

- Modify `tests/unit/live/test_api.py`
  - Update weekend/non-trading past-candles tests so they assert KIS is not called for known non-trading days.

- Modify `tests/unit/live/test_live_candle_backfill.py`
  - Add direct unit coverage for `LiveMinuteCandleBackfill.collect_minute()` skipping past non-trading dates while still fetching trading dates.

- Modify `frontend/src/api/livePastCandles.ts`
  - Add pure range helpers and a hook that fetches only the missing left delta for same-code/same-venue minute history.

- Modify `frontend/src/live/useLiveBundle.ts`
  - Switch the minute path from `useLivePastCandles(code, minutePastFrom, minutePastTo, venue)` to the delta-aware hook.
  - Keep downstream candle merge logic unchanged by returning the same `LivePastCandlesResponse` shape.

- Modify `frontend/src/api/livePastCandles.test.tsx`
  - Add tests for delta request planning and merged response behavior.

- Modify `frontend/src/live/useLiveBundle.test.tsx`
  - Add a regression test that extending `historicalFromDate` fetches only the prepended window.

---

### Task 1: Skip Known Non-Trading Past Dates Before KIS Minute Fetch

**Files:**
- Modify: `hoga/live/live_candle_backfill.py`
- Modify: `tests/unit/live/test_api.py`
- Modify: `tests/unit/live/test_live_candle_backfill.py`

**Interfaces:**
- Consumes: `hoga.api.calendar.is_trading_day(date_yyyymmdd: str) -> bool | None`
- Produces: unchanged `LiveMinuteCandleBackfillResult`
- Produces: known non-trading past dates are cached via `PastCandlesCache.store_past(venue, code, date_s, [])`
- Produces: known non-trading dates are covered dates for `NXT`/`AUTO` fallback; they must not be treated as missing just because they have zero candles.

- [ ] **Step 1: Write the route-level failing test**

In `tests/unit/live/test_api.py`, replace the current weekend behavior test with this stricter version:

```python
@pytest.mark.asyncio
async def test_past_candles_weekend_skips_kis_and_returns_empty(tmp_path, monkeypatch) -> None:
    """Past weekend dates are known-empty and must not spend KIS capacity."""
    from hoga.api import calendar as cal

    class _CountingKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    monkeypatch.setattr(cal, "is_trading_day", lambda d: False if d == "20260516" else True)
    fake = _CountingKis()
    app = _past_app(tmp_path, fake)

    with TestClient(app) as c:
        r1 = c.get("/api/live/past-candles?code=005930&from=20260516&to=20260516")
        r2 = c.get("/api/live/past-candles?code=005930&from=20260516&to=20260516")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert fake.calls == []
    body = r1.json()
    assert body["candles"] == []
    assert body["cached_dates"] == ["20260516"]
    assert body["fresh_dates"] == []
    assert body["data_warnings"] == []
```

- [ ] **Step 2: Run the route-level test and confirm it fails**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_api.py::test_past_candles_weekend_skips_kis_and_returns_empty -q
```

Expected: FAIL because current past weekend behavior calls KIS and records the date as `fresh_dates`.

- [ ] **Step 3: Write direct backfill failing test for mixed trading/non-trading range**

Append this test to `tests/unit/live/test_live_candle_backfill.py`:

```python
@pytest.mark.asyncio
async def test_collect_minute_skips_known_non_trading_past_dates(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    monkeypatch.setattr(
        cal,
        "is_trading_day",
        lambda d: False if d == "20260517" else True,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 17),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert kis.calls == [("005930", "20260518", "KRX", True)]
    assert scheduler.calls == [
        {
            "key": ("live-candle-backfill", "minute", "KRX", "005930", "20260518"),
            "endpoint": "past-minute",
            "priority": "user_visible",
            "cooldown_scope": "KRX",
        }
    ]
    assert result.cached_dates == ["20260517"]
    assert result.fresh_dates == ["20260518"]
    assert len(result.candles) == 1
    assert result.data_warnings == []
```

- [ ] **Step 4: Run the direct backfill test and confirm it fails**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py::test_collect_minute_skips_known_non_trading_past_dates -q
```

Expected: FAIL because both dates currently enter the pending fetch path.

- [ ] **Step 5: Implement the non-trading gate**

In `hoga/live/live_candle_backfill.py`, import the calendar module:

```python
from hoga.api import calendar as trading_calendar
```

In `_collect_for_venue()`, inside the first `for date_s in _date_iter(frm, too):` loop, replace the pending decision block with:

```python
        for date_s in _date_iter(frm, too):
            if date_s >= today_s:
                continue
            bars = self._cache.get_past(venue, code, date_s)
            if bars is not None:
                rows[date_s] = bars
                cached_dates.append(date_s)
                continue

            trading_day = trading_calendar.is_trading_day(date_s)
            if trading_day is False:
                empty: list[dict] = []
                self._cache.store_past(venue, code, date_s, empty)
                rows[date_s] = empty
                cached_dates.append(date_s)
                continue

            pending.append(date_s)
```

Do not gate when `is_trading_day()` returns `None`; keep the current permissive behavior and fetch KIS so a calendar outage does not make live history falsely empty.

- [ ] **Step 6: Add NXT fallback regression test**

Append this test to `tests/unit/live/test_live_candle_backfill.py`:

```python
@pytest.mark.asyncio
async def test_collect_minute_treats_non_trading_empty_as_covered_for_fallback(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    monkeypatch.setattr(cal, "is_trading_day", lambda d: False)

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 17),
        too=dt.date(2026, 5, 17),
        today_d=dt.date(2026, 6, 1),
        policy="NXT",
    )

    assert kis.calls == []
    assert scheduler.calls == []
    assert result.candles == []
    assert result.cached_dates == ["20260517"]
    assert result.fresh_dates == []
    assert result.data_warnings == []
```

- [ ] **Step 7: Run the NXT fallback regression and confirm it fails**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py::test_collect_minute_treats_non_trading_empty_as_covered_for_fallback -q
```

Expected: FAIL until `collect_minute(policy != "KRX")` treats `cached_dates` as covered, not just dates with candles.

- [ ] **Step 8: Implement covered-date missing calculation for venue fallback**

In `hoga/live/live_candle_backfill.py`, update the `policy != "KRX"` branch in `collect_minute()`:

```python
            dates = list(_date_iter(frm, too))
            primary_dates = _dates_for_candles(primary_out.candles)
            warning_dates = _fallback_blocking_warning_dates(primary_out.data_warnings)
            covered_dates = primary_dates | set(primary_out.cached_dates) | warning_dates
            missing_dates = [
                date_s
                for date_s in dates
                if date_s not in covered_dates
            ]
```

This makes zero-candle non-trading dates covered for fallback purposes while preserving fallback for true NXT no-data on a trading day.

- [ ] **Step 9: Run backend focused tests**

Run:

```bash
uv run --extra dev pytest \
  tests/unit/live/test_api.py::test_past_candles_weekend_skips_kis_and_returns_empty \
  tests/unit/live/test_live_candle_backfill.py::test_collect_minute_skips_known_non_trading_past_dates \
  tests/unit/live/test_live_candle_backfill.py::test_collect_minute_treats_non_trading_empty_as_covered_for_fallback \
  tests/unit/live/test_api.py::test_minute_today_weekend_skips_kis_and_negative_caches \
  -q
```

Expected: PASS.

- [ ] **Step 10: Run broader live API tests**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py tests/unit/live/test_api.py -q
```

Expected: PASS.

- [ ] **Step 11: Commit Task 1**

```bash
git add hoga/live/live_candle_backfill.py tests/unit/live/test_api.py tests/unit/live/test_live_candle_backfill.py
git commit -m "fix: skip non-trading past minute candle fetches"
```

---

### Task 2: Fetch Only the Past-Candles Delta on Historical Pan

**Files:**
- Modify: `frontend/src/api/livePastCandles.ts`
- Create or modify: `frontend/src/api/livePastCandles.test.tsx`
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Consumes: `LivePastCandlesResponse`
- Produces: `planPastCandlesDelta(previous, requested) -> { requestFrom, requestTo, canReusePrevious }`
- Produces: `mergePastCandleResponses(previous, next, requestedFrom, requestedTo, code, venue) -> LivePastCandlesResponse`
- Produces: `useLivePastCandlesDelta(code, from, to, venue)` with the same externally consumed query fields used by `useLiveBundle`

- [ ] **Step 1: Write pure helper tests**

Create or update `frontend/src/api/livePastCandles.test.tsx` with:

```ts
import { describe, expect, it } from 'vitest';
import {
  mergePastCandleResponses,
  planPastCandlesDelta,
  type LivePastCandlesResponse,
} from './livePastCandles';

function response(partial: Partial<LivePastCandlesResponse>): LivePastCandlesResponse {
  return {
    code: '005930',
    from: '20260624',
    to: '20260706',
    venue: 'KRX',
    candles: [],
    cached_dates: [],
    fresh_dates: [],
    data_warnings: [],
    effective_sessions: [],
    ...partial,
  };
}

describe('planPastCandlesDelta', () => {
  it('requests the full range when there is no previous response', () => {
    expect(planPastCandlesDelta(null, {
      code: '005930',
      from: '20260619',
      to: '20260706',
      venue: 'KRX',
    })).toEqual({
      requestFrom: '20260619',
      requestTo: '20260706',
      canReusePrevious: false,
    });
  });

  it('requests only the left delta for same code, venue, and to date', () => {
    const previous = response({ from: '20260624', to: '20260706' });
    expect(planPastCandlesDelta(previous, {
      code: '005930',
      from: '20260619',
      to: '20260706',
      venue: 'KRX',
    })).toEqual({
      requestFrom: '20260619',
      requestTo: '20260623',
      canReusePrevious: true,
    });
  });

  it('requests the full range when code changes', () => {
    const previous = response({ code: '000660', from: '20260624', to: '20260706' });
    expect(planPastCandlesDelta(previous, {
      code: '005930',
      from: '20260619',
      to: '20260706',
      venue: 'KRX',
    })).toEqual({
      requestFrom: '20260619',
      requestTo: '20260706',
      canReusePrevious: false,
    });
  });
});

describe('mergePastCandleResponses', () => {
  it('prepends delta candles and keeps dates unique and sorted', () => {
    const previous = response({
      from: '20260624',
      to: '20260706',
      candles: [{ t_ms: 30, open: 3, high: 3, low: 3, close: 3, volume: 3 }],
      cached_dates: ['20260624'],
      fresh_dates: ['20260625'],
      effective_sessions: [{ date: '20260624', venue: 'KRX', open_ms: 1, close_ms: 2 }],
    });
    const delta = response({
      from: '20260619',
      to: '20260623',
      candles: [{ t_ms: 10, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      cached_dates: ['20260619'],
      fresh_dates: ['20260620'],
      effective_sessions: [{ date: '20260619', venue: 'KRX', open_ms: 3, close_ms: 4 }],
    });

    expect(mergePastCandleResponses(previous, delta, '20260619', '20260706', '005930', 'KRX')).toEqual({
      code: '005930',
      from: '20260619',
      to: '20260706',
      venue: 'KRX',
      candles: [
        { t_ms: 10, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { t_ms: 30, open: 3, high: 3, low: 3, close: 3, volume: 3 },
      ],
      cached_dates: ['20260619', '20260624'],
      fresh_dates: ['20260620', '20260625'],
      data_warnings: [],
      effective_sessions: [
        { date: '20260619', venue: 'KRX', open_ms: 3, close_ms: 4 },
        { date: '20260624', venue: 'KRX', open_ms: 1, close_ms: 2 },
      ],
    });
  });
});
```

- [ ] **Step 2: Run helper tests and confirm they fail**

Run:

```bash
cd frontend
npm run test -- --run src/api/livePastCandles.test.tsx
```

Expected: FAIL because `planPastCandlesDelta` and `mergePastCandleResponses` do not exist.

- [ ] **Step 3: Implement date helper and delta planner**

In `frontend/src/api/livePastCandles.ts`, add:

```ts
function parseYyyymmdd(value: string): Date {
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
}

function formatYyyymmdd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function addDays(value: string, days: number): string {
  const date = parseYyyymmdd(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatYyyymmdd(date);
}

export function planPastCandlesDelta(
  previous: LivePastCandlesResponse | null | undefined,
  requested: { code: string; from: string; to: string; venue: LiveVenueOption },
): { requestFrom: string; requestTo: string; canReusePrevious: boolean } {
  if (
    previous &&
    previous.code === requested.code &&
    (previous.venue ?? 'KRX') === requested.venue &&
    previous.to === requested.to &&
    requested.from < previous.from &&
    requested.to >= previous.from
  ) {
    return {
      requestFrom: requested.from,
      requestTo: addDays(previous.from, -1),
      canReusePrevious: true,
    };
  }
  return {
    requestFrom: requested.from,
    requestTo: requested.to,
    canReusePrevious: false,
  };
}
```

- [ ] **Step 4: Implement merge helper**

In `frontend/src/api/livePastCandles.ts`, add:

```ts
function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function sortCandles(candles: readonly LivePastCandle[]): LivePastCandle[] {
  return [...candles].sort((a, b) => a.t_ms - b.t_ms);
}

export function mergePastCandleResponses(
  previous: LivePastCandlesResponse,
  next: LivePastCandlesResponse,
  requestedFrom: string,
  requestedTo: string,
  code: string,
  venue: LiveVenueOption,
): LivePastCandlesResponse {
  return {
    code,
    from: requestedFrom,
    to: requestedTo,
    venue,
    candles: sortCandles([...next.candles, ...previous.candles]),
    cached_dates: uniqueSorted([...next.cached_dates, ...previous.cached_dates]),
    fresh_dates: uniqueSorted([...next.fresh_dates, ...previous.fresh_dates]),
    data_warnings: [...next.data_warnings, ...previous.data_warnings],
    effective_sessions: uniqueSessionsByDate([...(next.effective_sessions ?? []), ...(previous.effective_sessions ?? [])]),
  };
}

function uniqueSessionsByDate(sessions: readonly LiveEffectiveSession[]): LiveEffectiveSession[] {
  const byDate = new Map<string, LiveEffectiveSession>();
  for (const session of sessions) byDate.set(session.date, session);
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
```

- [ ] **Step 5: Run helper tests and confirm they pass**

Run:

```bash
cd frontend
npm run test -- --run src/api/livePastCandles.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Implement `useLivePastCandlesDelta` hook**

In `frontend/src/api/livePastCandles.ts`, add a hook that preserves the same consumer surface as `useLivePastCandles`:

```ts
import { useEffect, useMemo, useRef } from 'react';
```

Then append:

```ts
export function useLivePastCandlesDelta(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  const mergedRef = useRef<LivePastCandlesResponse | null>(null);
  const enabled = !!(code && from && to && from <= to);
  const requested = enabled ? { code, from, to, venue } as const : null;
  const plan = useMemo(
    () => requested
      ? planPastCandlesDelta(mergedRef.current, requested)
      : { requestFrom: null, requestTo: null, canReusePrevious: false },
    [requested?.code, requested?.from, requested?.to, requested?.venue],
  );

  const query = useLivePastCandles(
    enabled ? code : null,
    enabled ? plan.requestFrom : null,
    enabled ? plan.requestTo : null,
    venue,
  );

  useEffect(() => {
    if (!enabled || !requested || !query.data) return;
    mergedRef.current = plan.canReusePrevious && mergedRef.current
      ? mergePastCandleResponses(mergedRef.current, query.data, requested.from, requested.to, requested.code, requested.venue)
      : query.data;
  }, [enabled, requested, plan.canReusePrevious, query.data]);

  const mergedData = enabled ? mergedRef.current ?? query.data : undefined;
  return {
    ...query,
    data: mergedData,
    isPlaceholderData: query.isPlaceholderData,
  };
}
```

If TypeScript complains about optional literal narrowing for `requested`, replace the `requested` object with explicit `requestedCode`, `requestedFrom`, `requestedTo`, and `requestedVenue` constants.

- [ ] **Step 7: Switch `useLiveBundle` minute path to the delta hook**

In `frontend/src/live/useLiveBundle.ts`, change the import:

```ts
import { useLivePastCandlesDelta } from '../api/livePastCandles';
```

Then change:

```ts
  const pastCandlesQuery = useLivePastCandles(
```

to:

```ts
  const pastCandlesQuery = useLivePastCandlesDelta(
```

Keep all arguments the same.

- [ ] **Step 8: Add a `useLiveBundle` regression test for delta URLs**

In `frontend/src/live/useLiveBundle.test.tsx`, add a test with the existing fetch/mock harness used in that file. The assertion must prove that after initial load `20260624..20260706`, changing page state to `historicalFromDate='20260619'` causes the past-candles URL to contain `from=20260619&to=20260623`, not `from=20260619&to=20260706`.

The expected URL assertion should be:

```ts
expect(pastCandleUrls).toContain('/api/live/past-candles?code=005930&from=20260619&to=20260623&venue=KRX');
expect(pastCandleUrls).not.toContain('/api/live/past-candles?code=005930&from=20260619&to=20260706&venue=KRX');
```

- [ ] **Step 9: Run frontend focused tests**

Run:

```bash
cd frontend
npm run test -- --run src/api/livePastCandles.test.tsx src/live/useLiveBundle.test.tsx src/live/LiveChartRoot.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Run frontend build**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS.

- [ ] **Step 11: Browser verification with gstack browse**

Start servers:

```bash
HOGA_PERF_DEBUG=1 HOGA_LIVE_STARTUP_ENABLED=false uv run --extra dev uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
cd frontend && VITE_HOGA_PERF_DEBUG=1 npm run dev -- --host 127.0.0.1 --port 5174
```

Use browse in this workspace:

```bash
GSTACK_CHROMIUM_PATH=/usr/bin/google-chrome /home/dev/.claude/skills/gstack/browse/dist/browse --headed goto 'http://127.0.0.1:5174/live?code=005930'
GSTACK_CHROMIUM_PATH=/usr/bin/google-chrome /home/dev/.claude/skills/gstack/browse/dist/browse --headed wait --networkidle
GSTACK_CHROMIUM_PATH=/usr/bin/google-chrome /home/dev/.claude/skills/gstack/browse/dist/browse --headed console --clear
GSTACK_CHROMIUM_PATH=/usr/bin/google-chrome /home/dev/.claude/skills/gstack/browse/dist/browse --headed network --clear
GSTACK_CHROMIUM_PATH=/usr/bin/google-chrome /home/dev/.claude/skills/gstack/browse/dist/browse --headed js "(() => { const ts = window.__liveChart.timeScale(); ts.setVisibleLogicalRange({ from: -120, to: 300 }); return ts.getVisibleLogicalRange(); })()"
sleep 5
GSTACK_CHROMIUM_PATH=/usr/bin/google-chrome /home/dev/.claude/skills/gstack/browse/dist/browse --headed network
```

Expected network evidence after one left pan:

```text
GET /api/live/past-candles?code=005930&from=<new-left>&to=<day-before-old-left>&venue=KRX
```

Not expected:

```text
GET /api/live/past-candles?code=005930&from=<new-left>&to=20260706&venue=KRX
```

- [ ] **Step 12: Commit Task 2**

```bash
git add frontend/src/api/livePastCandles.ts frontend/src/api/livePastCandles.test.tsx frontend/src/live/useLiveBundle.ts frontend/src/live/useLiveBundle.test.tsx
git commit -m "fix: fetch live past candles incrementally"
```

---

## Self-Review

- Spec coverage: The plan covers only the two requested items: non-trading-day past-candles gating and past-candles delta fetch. It intentionally excludes sidecar caching and `/api/range` delta work.
- Placeholder scan: No task relies on "TBD" behavior. Each task names files, commands, and expected outcomes.
- Type consistency: The frontend helper names used by later steps are defined in Task 2 before use: `planPastCandlesDelta`, `mergePastCandleResponses`, and `useLivePastCandlesDelta`.
