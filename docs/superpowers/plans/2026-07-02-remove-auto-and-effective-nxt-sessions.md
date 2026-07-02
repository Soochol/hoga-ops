# Remove AUTO and Effective NXT Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove the AUTO venue option and make NXT/UN minute charts use KRX-width sessions on dates where the selected venue falls back to KRX, while preserving extended 08:00-20:00 sessions for dates with actual NXT/UN candle support.

**Architecture:** The backend `/api/live/past-candles` minute response becomes the source of truth for date-level candle venue provenance via `effective_sessions`. The frontend builds chart segments from those effective sessions instead of assuming every NXT/UN request is extended for every date. AUTO is removed from both the public frontend venue model and backend live venue policy.

**Tech Stack:** Python FastAPI backend, pytest, React/TypeScript frontend, Zustand, TanStack Query, Vitest, lightweight-charts virtual axis.

## Global Constraints

- Do not change daily `D/W/M` candle rendering beyond removing AUTO as a selectable/accepted venue.
- Keep explicit `NXT` and `UN` supported.
- Keep KRX live HOGA/orderbook behavior unchanged; this plan only fixes candle-derived chart session width and removes AUTO.
- Do not parse `minute_fallback_to_krx` warning text in the frontend for behavior.
- Preserve backwards-compatible response consumption by making new frontend fields optional.

---

## File Structure

- Modify `hoga/live/kis_venue.py`: remove AUTO policy helpers and keep only concrete live venues `KRX`, `NXT`, `UN`.
- Modify `hoga/live/live_candle_backfill.py`: add date-level `effective_sessions` to minute backfill output and mark fallback dates as KRX sessions.
- Modify `hoga/live/api.py`: continue returning `/past-candles` output, now including `effective_sessions`; reject `venue=AUTO`.
- Modify `tests/unit/live/test_kis_venue.py`: remove AUTO helper tests and add parse rejection coverage.
- Modify `tests/unit/live/test_api.py`: update past-candles, past-daily, and quote route tests for AUTO removal and effective session metadata.
- Modify `frontend/src/state/liveVenue.ts`: remove AUTO from user-facing venue options and labels.
- Modify `frontend/src/live/liveVenuePolicy.ts`: remove AUTO logic and add helpers for effective sessions.
- Modify `frontend/src/api/livePastCandles.ts`: add optional `effective_sessions` response type.
- Modify `frontend/src/api/livePastDailyCandles.ts`: remove AUTO type expectations if present.
- Modify `frontend/src/live/useLiveBundle.ts`: use backend `effective_sessions` for minute chart session bounds.
- Modify `frontend/src/studyViews/studyReferenceBundleModel.ts`: accept effective sessions for reference minute charts.
- Modify `frontend/src/studyViews/useStudyReferenceBundle.ts`: pass minute candle effective sessions through.
- Modify frontend tests under `frontend/src/**`: remove AUTO assertions and add NXT fallback session assertions.

---

### Task 1: Backend Effective Minute Sessions

**Files:**
- Modify: `hoga/live/live_candle_backfill.py`
- Test: `tests/unit/live/test_api.py`

**Interfaces:**
- Produces: `LiveMinuteCandleBackfillResult.effective_sessions: list[dict]`
- Produces: response field `effective_sessions: [{ date: string, venue: "KRX" | "NXT" | "UN", open_ms: int, close_ms: int }]`
- Consumes: `hoga.live.kis_venue.session_window_hhmmss(venue)`

- [x] **Step 1: Write failing backend tests for effective sessions**

Add assertions to `test_past_candles_non_krx_empty_falls_back_to_krx`:

```python
    assert body["effective_sessions"] == [
        {
            "date": "20260518",
            "venue": "KRX",
            "open_ms": ts(9, 0),
            "close_ms": ts(15, 30),
        }
    ]
```

Add assertions to `test_past_candles_integrated_uses_single_kis_un_call`:

```python
    assert body["effective_sessions"] == [
        {
            "date": "20260518",
            "venue": "UN",
            "open_ms": ts(8, 0),
            "close_ms": ts(20, 0),
        }
    ]
```

Add assertions to `test_past_candles_non_krx_partial_range_fills_empty_dates_from_krx`:

```python
    assert body["effective_sessions"] == [
        {"date": "20260518", "venue": "KRX", "open_ms": ts("20260518", 0).t_ms, "close_ms": ts("20260518", 0).t_ms + 23_400_000},
        {"date": "20260519", "venue": "KRX", "open_ms": ts("20260519", 0).t_ms, "close_ms": ts("20260519", 0).t_ms + 23_400_000},
        {"date": "20260520", "venue": "NXT", "open_ms": ts("20260520", 0).t_ms - 3_600_000, "close_ms": ts("20260520", 0).t_ms + 39_600_000},
    ]
```

If the existing local helper `ts(date_s, close)` makes the above expression awkward, add this helper inside the test:

```python
    def at(date_s: str, hh: int, mm: int) -> int:
        y, m, d = int(date_s[:4]), int(date_s[4:6]), int(date_s[6:8])
        return int(datetime.datetime(y, m, d, hh, mm, tzinfo=kst).timestamp() * 1000)
```

Then use:

```python
    assert body["effective_sessions"] == [
        {"date": "20260518", "venue": "KRX", "open_ms": at("20260518", 9, 0), "close_ms": at("20260518", 15, 30)},
        {"date": "20260519", "venue": "KRX", "open_ms": at("20260519", 9, 0), "close_ms": at("20260519", 15, 30)},
        {"date": "20260520", "venue": "NXT", "open_ms": at("20260520", 8, 0), "close_ms": at("20260520", 20, 0)},
    ]
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/live/test_api.py::test_past_candles_non_krx_empty_falls_back_to_krx tests/unit/live/test_api.py::test_past_candles_integrated_uses_single_kis_un_call tests/unit/live/test_api.py::test_past_candles_non_krx_partial_range_fills_empty_dates_from_krx -q
```

Expected: FAIL with `KeyError: 'effective_sessions'`.

- [x] **Step 3: Implement effective session metadata**

In `hoga/live/live_candle_backfill.py`, update the import:

```python
from hoga.live.kis_venue import (
    KisVenue,
    LiveVenuePolicy,
    merge_auto_minute_bars,
    session_window_hhmmss,
)
```

Add the dataclass field and dump:

```python
@dataclass(frozen=True)
class LiveMinuteCandleBackfillResult:
    candles: list[dict]
    cached_dates: list[str]
    fresh_dates: list[str]
    data_warnings: list[dict]
    effective_sessions: list[dict]

    def model_dump(self) -> dict:
        return {
            "candles": self.candles,
            "cached_dates": self.cached_dates,
            "fresh_dates": self.fresh_dates,
            "data_warnings": self.data_warnings,
            "effective_sessions": self.effective_sessions,
        }
```

Add helpers near `_date_from_t_ms`:

```python
def _session_bound_ms(date_s: str, hhmmss: str) -> int:
    return int(
        datetime(
            int(date_s[:4]),
            int(date_s[4:6]),
            int(date_s[6:8]),
            int(hhmmss[:2]),
            int(hhmmss[2:4]),
            int(hhmmss[4:6]),
            tzinfo=_KST,
        ).timestamp() * 1000
    )


def _effective_session(date_s: str, venue: KisVenue) -> dict:
    open_hhmmss, close_hhmmss = session_window_hhmmss(venue)
    return {
        "date": date_s,
        "venue": venue,
        "open_ms": _session_bound_ms(date_s, open_hhmmss),
        "close_ms": _session_bound_ms(date_s, close_hhmmss),
    }


def _effective_sessions_for_candles(candles: list[dict], venue: KisVenue) -> list[dict]:
    return [_effective_session(date_s, venue) for date_s in sorted(_dates_for_candles(candles))]


def _merge_effective_sessions(
    primary: list[dict],
    fallback: list[dict],
    *,
    fallback_dates: set[str],
) -> list[dict]:
    by_date = {str(row["date"]): row for row in primary if str(row.get("date", "")) not in fallback_dates}
    for row in fallback:
        date_s = str(row.get("date", ""))
        if date_s in fallback_dates:
            by_date[date_s] = row
    return [by_date[date_s] for date_s in sorted(by_date)]
```

In every `LiveMinuteCandleBackfillResult(...)` construction, add `effective_sessions`.

For `_collect_for_venue` final return:

```python
        return LiveMinuteCandleBackfillResult(
            candles=candles_all,
            cached_dates=cached_dates,
            fresh_dates=fresh_dates,
            data_warnings=warnings,
            effective_sessions=_effective_sessions_for_candles(candles_all, venue),
        )
```

For the explicit non-KRX fallback branch with fallback candles:

```python
            return LiveMinuteCandleBackfillResult(
                candles=_merge_minute_fallback(
                    primary_out.candles,
                    fallback_candles,
                    fallback_dates=missing_set,
                ),
                cached_dates=cached_dates,
                fresh_dates=fresh_dates,
                data_warnings=primary_out.data_warnings + fallback_warnings + [
                    _minute_fallback_to_krx_warning(policy, sorted(used_fallback_dates))
                ],
                effective_sessions=_merge_effective_sessions(
                    primary_out.effective_sessions,
                    [
                        row
                        for fallback_out in fallback_outs
                        for row in fallback_out.effective_sessions
                    ],
                    fallback_dates=used_fallback_dates,
                ),
            )
```

For early returns without fallback candles:

```python
                return LiveMinuteCandleBackfillResult(
                    candles=primary_out.candles,
                    cached_dates=primary_out.cached_dates,
                    fresh_dates=primary_out.fresh_dates,
                    data_warnings=primary_out.data_warnings + fallback_warnings,
                    effective_sessions=primary_out.effective_sessions,
                )
```

For the current AUTO branch, add:

```python
                effective_sessions=_merge_effective_sessions(
                    krx_out.effective_sessions,
                    nxt_out.effective_sessions,
                    fallback_dates={row["date"] for row in nxt_out.effective_sessions},
                ),
```

This AUTO line is temporary because Task 2 removes AUTO.

- [x] **Step 4: Run tests to verify pass**

Run:

```bash
uv run pytest tests/unit/live/test_api.py::test_past_candles_non_krx_empty_falls_back_to_krx tests/unit/live/test_api.py::test_past_candles_integrated_uses_single_kis_un_call tests/unit/live/test_api.py::test_past_candles_non_krx_partial_range_fills_empty_dates_from_krx -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add hoga/live/live_candle_backfill.py tests/unit/live/test_api.py
git commit -m "feat: expose effective minute candle sessions"
```

---

### Task 2: Remove AUTO from Backend Live Venue Policy

**Files:**
- Modify: `hoga/live/kis_venue.py`
- Modify: `hoga/live/live_candle_backfill.py`
- Modify: `hoga/live/live_daily_candle_backfill.py`
- Modify: `hoga/live/api.py`
- Test: `tests/unit/live/test_kis_venue.py`
- Test: `tests/unit/live/test_api.py`
- Test: `tests/unit/live/test_live_quotes_route.py`

**Interfaces:**
- Produces: `LiveVenuePolicy = Literal["KRX", "NXT", "UN"]`
- Produces: `parse_live_venue_policy("AUTO")` raises `ValueError("venue must be one of KRX, NXT, UN")`
- Removes: `auto_minute_venue_for_hhmmss`, `merge_auto_minute_bars`, `daily_venue_for_policy`, `quote_venue_for_policy` AUTO behavior, `AUTO_DAILY_USES_INTEGRATED_WARNING`

- [x] **Step 1: Write failing AUTO rejection tests**

In `tests/unit/live/test_kis_venue.py`, replace AUTO acceptance tests with:

```python
def test_parse_live_venue_policy_rejects_auto() -> None:
    with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
        parse_live_venue_policy("AUTO")
```

Update imports to include `parse_live_venue_policy` and remove imports for deleted AUTO helpers.

In `tests/unit/live/test_api.py`, replace `test_past_candles_auto_merges_krx_regular_and_nxt_extended` with:

```python
def test_past_candles_rejects_auto_venue(tmp_path) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=AUTO")

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"
```

Replace `test_past_daily_auto_uses_integrated_venue_with_warning` with:

```python
def test_past_daily_rejects_auto_venue(tmp_path) -> None:
    fake = _FakeDailyKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105&venue=AUTO")

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"
```

In `tests/unit/live/test_live_quotes_route.py`, replace AUTO quote routing tests with:

```python
def test_quotes_route_rejects_auto_venue(tmp_path):
    r = TestClient(_app(tmp_path)).get("/api/live/quotes", params={"codes": "005930", "venue": "AUTO"})

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_api.py::test_past_candles_rejects_auto_venue tests/unit/live/test_api.py::test_past_daily_rejects_auto_venue tests/unit/live/test_live_quotes_route.py::test_quotes_route_rejects_auto_venue -q
```

Expected: FAIL because AUTO is still accepted and AUTO helper imports still exist.

- [x] **Step 3: Remove AUTO backend implementation**

In `hoga/live/kis_venue.py`, set:

```python
LiveVenuePolicy = Literal["KRX", "NXT", "UN"]
```

Replace `parse_live_venue_policy` with:

```python
def parse_live_venue_policy(value: str | None) -> LiveVenuePolicy:
    if value is None or value == "":
        return "KRX"
    if value in ("KRX", "NXT", "UN"):
        return cast(LiveVenuePolicy, value)
    raise ValueError("venue must be one of KRX, NXT, UN")
```

Replace `daily_venue_for_policy` with a direct parser helper or remove it. If keeping it for call-site clarity:

```python
def daily_venue_for_policy(policy: LiveVenuePolicy) -> KisVenue:
    return parse_kis_venue(policy)
```

Replace `quote_venue_for_policy` with:

```python
def quote_venue_for_policy(policy: LiveVenuePolicy, _now: datetime) -> KisVenue:
    return parse_kis_venue(policy)
```

Delete:

```python
AUTO_DAILY_USES_INTEGRATED_WARNING
auto_minute_venue_for_hhmmss
merge_auto_minute_bars
```

In `hoga/live/live_candle_backfill.py`, remove the `if policy == "AUTO":` branch and remove `merge_auto_minute_bars` import.

In `hoga/live/live_daily_candle_backfill.py`, remove AUTO warning logic. Keep explicit non-KRX daily fallback behavior:

```python
        venue = daily_venue_for_policy(policy)
        result = await self._collect_daily_for_venue(...)
```

There should be no branch checking `policy == "AUTO"`.

- [x] **Step 4: Run backend venue tests**

Run:

```bash
uv run pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_api.py::test_past_candles_rejects_auto_venue tests/unit/live/test_api.py::test_past_daily_rejects_auto_venue tests/unit/live/test_live_quotes_route.py::test_quotes_route_rejects_auto_venue -q
```

Expected: PASS.

- [x] **Step 5: Search for backend AUTO references**

Run:

```bash
rg -n "AUTO|auto_minute|merge_auto|auto_daily_uses_integrated" hoga tests/unit/live -S
```

Expected: only historical docs or test names unrelated to live venue remain. No imports or executable code paths should reference AUTO.

- [x] **Step 6: Commit**

```bash
git add hoga/live/kis_venue.py hoga/live/live_candle_backfill.py hoga/live/live_daily_candle_backfill.py hoga/live/api.py tests/unit/live/test_kis_venue.py tests/unit/live/test_api.py tests/unit/live/test_live_quotes_route.py
git commit -m "refactor: remove auto live venue policy"
```

---

### Task 3: Frontend Remove AUTO Venue Option

**Files:**
- Modify: `frontend/src/state/liveVenue.ts`
- Modify: `frontend/src/live/liveVenuePolicy.ts`
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Modify: `frontend/src/api/livePastDailyCandles.test.tsx`
- Modify: `frontend/src/api/livePastCandles.test.tsx`
- Modify: `frontend/src/api/liveQuotes.test.tsx`
- Modify: `frontend/src/live/liveVenuePolicy.test.ts`
- Modify: `frontend/src/state/liveVenue.test.ts`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Produces: `LiveVenueOption = "KRX" | "NXT" | "UN"`
- Produces: UI venue labels `KRX`, `NXT`, `통합`
- Removes: frontend selectable/typed `AUTO`

- [x] **Step 1: Write failing frontend tests for AUTO removal**

In `frontend/src/state/liveVenue.test.ts`, replace the AUTO hydration test with:

```ts
it('ignores persisted AUTO venue during hydration', () => {
  localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'AUTO' }));
  useLiveVenueStore.setState({ venue: 'KRX' });
  useLiveVenueStore.getState().hydrateFromStorage();
  expect(useLiveVenueStore.getState().venue).toBe('KRX');
});
```

In `frontend/src/live/liveVenuePolicy.test.ts`, remove AUTO from the extended venue loop:

```ts
  it('uses the extended minute window for NXT and integrated', () => {
    for (const venue of ['NXT', 'UN'] as const) {
      expect(liveVenueSessionBoundsMs('20260518', venue)).toEqual({
        open_ms: MON_OPEN_MS - HOUR,
        close_ms: MON_OPEN_MS + 11 * HOUR,
      });
      expect(initialVisibleMinuteBarsFor('1m', venue)).toBe(300);
      expect(liveVenueKeepsHogaKrx(venue)).toBe(true);
    }
  });
```

Delete assertions using `liveVenueAllowsKrxTradeOverlay('AUTO', ...)`.

In `frontend/src/live/useLiveBundle.test.tsx`, delete the test named:

```ts
it('D/W/M: AUTO daily integrated fallback warning을 pastDataWarnings로 노출', ...)
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/state/liveVenue.test.ts src/live/liveVenuePolicy.test.ts src/live/useLiveBundle.test.tsx
```

Expected: FAIL because source still includes AUTO and test imports may reference deleted expectations.

- [x] **Step 3: Remove AUTO from frontend state and policy**

In `frontend/src/state/liveVenue.ts`, change:

```ts
export const LIVE_VENUE_OPTIONS = ['KRX', 'NXT', 'UN'] as const;
```

Change labels:

```ts
export const LIVE_VENUE_LABELS: Record<LiveVenueOption, string> = {
  KRX: 'KRX',
  NXT: 'NXT',
  UN: '통합',
};
```

In `frontend/src/live/liveVenuePolicy.ts`, remove AUTO checks:

```ts
export function liveVenueAllowsKrxTradeOverlay(venue: LiveVenueOption, _tMs: number): boolean {
  return venue === 'KRX';
}
```

Ensure `liveVenueUsesExtendedMinuteWindow(venue)` still returns `venue !== 'KRX'`.

In `frontend/src/live/LiveSettingsSections.tsx`, no custom AUTO removal should be needed if it maps over `LIVE_VENUE_OPTIONS`. If there is explicit AUTO copy, delete that branch.

- [x] **Step 4: Update API hook tests that mention AUTO**

In `frontend/src/api/livePastDailyCandles.test.tsx`, replace AUTO venue cases with `UN` or remove them. For example:

```ts
it('threads venue through the daily URL and query cache key', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
  const { rerender } = renderHook(
    ({ venue }: { venue: 'KRX' | 'UN' }) => useLivePastDailyCandles('005930', '20240101', '20240105', venue),
    { wrapper: wrap(qc), initialProps: { venue: 'KRX' } },
  );

  rerender({ venue: 'UN' });
  expect(spy.mock.calls[1][0]).toContain('venue=UN');
});
```

Search and replace frontend test-only AUTO type unions:

```bash
rg -n "AUTO" frontend/src -S
```

Remove or rewrite each remaining executable AUTO reference.

- [x] **Step 5: Run frontend tests**

Run:

```bash
cd frontend && npx vitest run src/state/liveVenue.test.ts src/live/liveVenuePolicy.test.ts src/api/livePastCandles.test.tsx src/api/livePastDailyCandles.test.tsx src/api/liveQuotes.test.tsx src/live/useLiveBundle.test.tsx
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add frontend/src/state/liveVenue.ts frontend/src/live/liveVenuePolicy.ts frontend/src/live/LiveSettingsSections.tsx frontend/src/api/livePastDailyCandles.test.tsx frontend/src/api/livePastCandles.test.tsx frontend/src/api/liveQuotes.test.tsx frontend/src/live/liveVenuePolicy.test.ts frontend/src/state/liveVenue.test.ts frontend/src/live/useLiveBundle.test.tsx
git commit -m "refactor: remove auto venue from frontend"
```

---

### Task 4: Frontend Consume Effective Sessions for Chart Axis

**Files:**
- Modify: `frontend/src/api/livePastCandles.ts`
- Modify: `frontend/src/live/liveVenuePolicy.ts`
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/studyViews/studyReferenceBundleModel.ts`
- Modify: `frontend/src/studyViews/useStudyReferenceBundle.ts`
- Test: `frontend/src/live/useLiveBundle.test.tsx`
- Test: `frontend/src/studyViews/studyReferenceBundleModel.test.ts`

**Interfaces:**
- Consumes: `LivePastCandlesResponse.effective_sessions?: LiveEffectiveSession[]`
- Produces: `sessionBoundsForDate(date)` returns KRX bounds for fallback dates and extended bounds for actual NXT/UN dates.

- [x] **Step 1: Add frontend types and failing live bundle test**

In `frontend/src/api/livePastCandles.ts`, add:

```ts
export interface LiveEffectiveSession {
  date: string;
  venue: LiveVenueOption;
  open_ms: number;
  close_ms: number;
}
```

Add to `LivePastCandlesResponse`:

```ts
  effective_sessions?: LiveEffectiveSession[];
```

Update the `candlesMock` object in `frontend/src/live/useLiveBundle.test.tsx`:

```ts
const candlesMock = {
  candles: [DEFAULT_CANDLE] as Array<typeof DEFAULT_CANDLE>,
  isPlaceholderData: false,
  isFetching: false,
  warnings: [] as Array<{ date?: string; reason: string; msg: string }>,
  effectiveSessions: [] as Array<{ date: string; venue: 'KRX' | 'NXT' | 'UN'; open_ms: number; close_ms: number }>,
};
```

Include it in mocked data:

```ts
    effective_sessions: candlesMock.effectiveSessions,
```

Add a test near the existing NXT session test:

```ts
it('NXT minute venue narrows fallback dates to KRX effective sessions', () => {
  candlesMock.effectiveSessions = [
    {
      date: '20260527',
      venue: 'KRX',
      open_ms: 1779840000000,
      close_ms: 1779863400000,
    },
  ];

  const { result } = renderHook(
    () => useLiveBundle('005930', '1m', '20260527', liveFixture, { venue: 'NXT' }),
    { wrapper },
  );

  const seg = result.current.chartBundle!.segments[0];
  expect(seg.session_open_ms).toBe(1779840000000);
  expect(seg.session_close_ms).toBe(1779863400000);
});
```

Update `beforeEach` to reset:

```ts
    candlesMock.effectiveSessions = [];
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
cd frontend && npx vitest run src/live/useLiveBundle.test.tsx -t "narrows fallback dates"
```

Expected: FAIL because `useLiveBundle` ignores `effective_sessions`.

- [x] **Step 3: Add effective session helper**

In `frontend/src/live/liveVenuePolicy.ts`, import the type:

```ts
import type { LiveEffectiveSession } from '../api/livePastCandles';
```

Add:

```ts
export function effectiveSessionBoundsByDate(
  effectiveSessions: readonly LiveEffectiveSession[] | undefined,
): Map<string, { open_ms: number; close_ms: number }> {
  const out = new Map<string, { open_ms: number; close_ms: number }>();
  for (const session of effectiveSessions ?? []) {
    if (
      typeof session.date === 'string' &&
      Number.isFinite(session.open_ms) &&
      Number.isFinite(session.close_ms) &&
      session.open_ms < session.close_ms
    ) {
      out.set(session.date, { open_ms: session.open_ms, close_ms: session.close_ms });
    }
  }
  return out;
}
```

- [x] **Step 4: Use effective sessions in `useLiveBundle`**

In `frontend/src/live/useLiveBundle.ts`, import:

```ts
  effectiveSessionBoundsByDate,
```

Add after `defaultKrxSession`:

```ts
  const effectiveSessionByDate = useMemo(
    () => effectiveSessionBoundsByDate(pastCandlesQuery.data?.effective_sessions),
    [pastCandlesQuery.data?.effective_sessions],
  );
```

Replace `todayChartSession` with:

```ts
  const todayChartSession = useMemo(
    () => {
      if (!isMinute) return defaultKrxSession;
      const effective = effectiveSessionByDate.get(todayKstYyyymmdd);
      if (effective) return effective;
      return liveVenueUsesExtendedMinuteWindow(venue)
        ? liveVenueSessionBoundsMs(todayKstYyyymmdd, venue)
        : defaultKrxSession;
    },
    [defaultKrxSession, effectiveSessionByDate, isMinute, todayKstYyyymmdd, venue],
  );
```

Replace `sessionBoundsForDate` with:

```ts
  const sessionBoundsForDate = useMemo(
    () =>
      isMinute
        ? (yyyymmdd: string) =>
            effectiveSessionByDate.get(yyyymmdd) ??
            (liveVenueUsesExtendedMinuteWindow(venue)
              ? liveVenueSessionBoundsMs(yyyymmdd, venue)
              : {
                  open_ms: regularSessionOpenMs(yyyymmdd),
                  close_ms: regularSessionCloseMs(yyyymmdd),
                })
        : undefined,
    [effectiveSessionByDate, isMinute, venue],
  );
```

This keeps NXT-supported dates extended when the backend reports NXT/UN sessions, and narrows fallback dates to KRX when the backend reports KRX sessions.

- [x] **Step 5: Run live bundle tests**

Run:

```bash
cd frontend && npx vitest run src/live/useLiveBundle.test.tsx
```

Expected: PASS.

- [x] **Step 6: Thread effective sessions through study reference bundles**

In `frontend/src/studyViews/studyReferenceBundleModel.ts`, import:

```ts
import type { LiveEffectiveSession } from '../api/livePastCandles';
import { effectiveSessionBoundsByDate, liveVenueSessionBoundsMs, liveVenueUsesExtendedMinuteWindow } from '../live/liveVenuePolicy';
```

Add parameter:

```ts
  minuteEffectiveSessions?: readonly LiveEffectiveSession[];
```

Use it:

```ts
  const effectiveSessionByDate = effectiveSessionBoundsByDate(minuteEffectiveSessions);
  const sessionForDate = inputs.isMinute
    ? (yyyymmdd: string) =>
        effectiveSessionByDate.get(yyyymmdd) ??
        (liveVenueUsesExtendedMinuteWindow(venue)
          ? liveVenueSessionBoundsMs(yyyymmdd, venue)
          : {
              open_ms: regularSessionOpenMs(yyyymmdd),
              close_ms: regularSessionCloseMs(yyyymmdd),
            })
    : undefined;
```

In `frontend/src/studyViews/useStudyReferenceBundle.ts`, pass:

```ts
      minuteEffectiveSessions: minuteCandles.data?.effective_sessions ?? [],
```

Add a test in `frontend/src/studyViews/studyReferenceBundleModel.test.ts`:

```ts
it('uses effective KRX sessions for NXT fallback study reference minute charts', () => {
  const past = pastBundle();
  const model = buildStudyReferenceBundleModel({
    save: { ...save, range: { ...save.range, from_ms: 0, to_ms: Date.UTC(2026, 5, 16, 6, 30) } },
    venue: 'NXT',
    pastBundle: past,
    minuteCandles: [
      { t_ms: Date.UTC(2026, 5, 16, 0, 0), open: 1, high: 2, low: 1, close: 2, volume: 10 },
    ],
    dailyCandles: [],
    minuteEffectiveSessions: [
      {
        date: '20260616',
        venue: 'KRX',
        open_ms: Date.UTC(2026, 5, 16, 0, 0),
        close_ms: Date.UTC(2026, 5, 16, 6, 30),
      },
    ],
  });

  expect(model.chartBundle?.segments.find((s) => s.date === '20260616')).toMatchObject({
    session_open_ms: Date.UTC(2026, 5, 16, 0, 0),
    session_close_ms: Date.UTC(2026, 5, 16, 6, 30),
  });
});
```

- [x] **Step 7: Run study tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/studyReferenceBundleModel.test.ts src/studyViews/useStudyReferenceBundle.test.tsx
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add frontend/src/api/livePastCandles.ts frontend/src/live/liveVenuePolicy.ts frontend/src/live/useLiveBundle.ts frontend/src/studyViews/studyReferenceBundleModel.ts frontend/src/studyViews/useStudyReferenceBundle.ts frontend/src/live/useLiveBundle.test.tsx frontend/src/studyViews/studyReferenceBundleModel.test.ts
git commit -m "fix: use effective venue sessions for minute chart axes"
```

---

### Task 5: Final Verification and Cleanup

**Files:**
- Modify only if previous tasks missed stale references.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: repo with no executable AUTO venue support and correct NXT/UN fallback chart sessions.

- [x] **Step 1: Search stale AUTO references**

Run:

```bash
rg -n "AUTO|auto_minute|merge_auto|auto_daily_uses_integrated" hoga frontend/src tests -S
```

Expected: no executable references. Historical markdown references are acceptable only if they are clearly old plans or changelog text. If `frontend/src` or `hoga` still contains AUTO runtime code, remove it and run the nearest tests again.

- [x] **Step 2: Run targeted backend suite**

Run:

```bash
uv run pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_api.py tests/unit/live/test_live_quotes_route.py -q
```

Expected: PASS.

- [x] **Step 3: Run targeted frontend suite**

Run:

```bash
cd frontend && npx vitest run src/state/liveVenue.test.ts src/live/liveVenuePolicy.test.ts src/live/useLiveBundle.test.tsx src/studyViews/studyReferenceBundleModel.test.ts src/studyViews/useStudyReferenceBundle.test.tsx src/api/livePastCandles.test.tsx src/api/livePastDailyCandles.test.tsx src/api/liveQuotes.test.tsx
```

Expected: PASS.

- [x] **Step 4: Run build checks**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

Run:

```bash
uv run pyright
```

Expected: PASS, or no new errors if this repository has pre-existing pyright failures. Capture the exact output in the final implementation note.

- [x] **Step 5: Manual smoke check**

Start servers if they are not already running:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

```bash
cd frontend && npm run dev
```

Open `/live`, choose `NXT`, and verify:

```text
NXT-supported symbol/date: x-axis spans 08:00-20:00 and extended candles render where data exists.
NXT-fallback symbol/date: x-axis spans 09:00-15:30, with no empty 08:00-09:00 or post-15:30 area.
Venue selector: KRX, NXT, 통합 only. AUTO is absent.
```

- [x] **Step 6: Commit final cleanup**

If cleanup changes were needed:

```bash
git add hoga frontend/src tests
git commit -m "test: verify venue session behavior"
```

If no cleanup changes were needed, do not create an empty commit.

---

## Self-Review

**Spec coverage:** AUTO removal is covered by Tasks 2 and 3. The original NXT unsupported-symbol empty-area behavior is covered by Tasks 1 and 4 through backend effective sessions and frontend axis selection. NXT-supported behavior is preserved because actual NXT/UN effective sessions remain 08:00-20:00.

**Placeholder scan:** This plan contains no `TBD`, `TODO`, `implement later`, or unspecified test steps. Each task includes exact files, commands, and expected outcomes.

**Type consistency:** Backend field name is `effective_sessions`. Frontend type is `LiveEffectiveSession`. Consumer functions use `{ open_ms, close_ms }` consistently, matching existing `liveVenueSessionBoundsMs` shape.
