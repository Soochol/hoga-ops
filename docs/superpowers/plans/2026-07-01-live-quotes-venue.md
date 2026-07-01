# Live Quotes Venue Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Watchlist, Heatmap, Screener, Live Status Bar, current price line, and browser title quote overlays follow the selected KIS Venue (`KRX`, `NXT`, `UN`, `AUTO`) so NXT pre-open displays NXT quotes instead of KRX-only quotes.

**Architecture:** Keep a single user setting: `useLiveVenueStore.venue` remains the authority for KIS Venue. Thread that value through the shared quote overlay seam (`frontend/src/api/liveQuotes.ts` -> `GET /api/live/quotes`) and resolve it on the backend before calling KIS `intstock-multprice`. Do not create a separate quote venue preference; quote venue and candle venue are one display contract, while hoga/WS panes remain explicitly KRX.

**Tech Stack:** FastAPI, Pydantic, Python KIS client, React, Zustand, TanStack Query, Vitest, pytest.

## Global Constraints

- Do not rename `SourcePreference`; KIS Venue is not Source Preference.
- Do not alter `/api/range`, parquet source selection, or `useSourcePreferenceStore`.
- Preserve graceful quote behavior: `/api/live/quotes` must never 500 because KIS quote fetch fails.
- Preserve existing KRX default behavior when no `venue` query parameter is supplied.
- `AUTO` quote policy is time-based: Regular Session (`09:00:00` through `15:30:00`) uses `KRX`; extended minutes outside that range use `NXT`.
- `UN` quote policy maps directly to KIS integrated venue `UN`.
- Hoga panes, KIS WS live data, and collection status remain KRX-oriented unless a later NXT WS design explicitly changes them.

---

## Structural Review

The current split is clean for candles but incomplete for quotes:

- `frontend/src/state/liveVenue.ts` owns `KRX | NXT | UN | AUTO`.
- `/live` passes that venue into `useLiveBundle`, `LiveStatusBar`, and `LiveWorkarea`.
- Watchlist, Heatmap, Screener, Live Status Bar, current price line, and browser title all consume the shared quote overlay in `frontend/src/api/liveQuotes.ts`.
- `frontend/src/api/liveQuotes.ts` currently keys and fetches quotes only by code set.
- `hoga/live/api.py` `/quotes` currently accepts only `codes`.
- `hoga/live/kis_client.py` `fetch_multi_price()` currently builds all `FID_COND_MRKT_DIV_CODE_N` fields with KRX `"J"`.
- `hoga/live/kis_venue.py` already owns the venue mapping: `KRX -> J`, `NXT -> NX`, `UN -> UN`.

Recommended decision: extend the existing quote seam with KIS Venue. This keeps all quote consumers aligned without touching each panel independently.

Options considered:

- **Option A: Thread selected KIS Venue through shared quote seam.** Low UI churn, strong consistency, follows existing candle venue policy. Recommended.
- **Option B: Add a separate quote venue setting.** More explicit, but creates two visible settings that can disagree and increases mental load.
- **Option C: Only special-case NXT pre-open in panels.** Smallest apparent patch, but duplicates policy and leaves `UN`/`AUTO` inconsistent.

## File Structure

- Modify `hoga/live/kis_venue.py`: add quote-specific policy resolution helper.
- Modify `hoga/live/kis_client.py`: allow `fetch_multi_price(codes, venue=...)`; pass venue into numbered market params.
- Modify `hoga/live/api.py`: accept `venue` on `/api/live/quotes`, compute venue-aware phase, include venue in scheduler key/cooldown scope, call `fetch_and_gate(..., venue=...)`.
- Modify `tests/unit/live/test_kis_venue.py`: cover quote venue policy.
- Modify `tests/unit/live/test_kis_multi_price.py`: cover KRX/NXT/UN params and chunking.
- Modify `tests/unit/live/test_live_quote_fetcher.py`: cover `LiveQuoteFetcher` passing venue through open/closed paths.
- Modify `tests/unit/live/test_live_quotes_route.py`: cover `venue` query validation, AUTO phase, and backward-compatible default.
- Modify `frontend/src/api/liveQuotes.ts`: accept optional venue; include it in query key and URL.
- Modify `frontend/src/api/liveQuotes.test.tsx`: cover query key and URL venue threading.
- Modify `frontend/src/watchlist/WatchlistDrawer.tsx`: call `useQuoteByCode(codes, liveVenue)`.
- Modify `frontend/src/pages/Heatmap.tsx`: call `useLiveQuoteOverlay(codes, liveVenue)`.
- Modify `frontend/src/screener/useScreenerRowsLive.ts`: call `useQuoteByCode(codes, liveVenue)`.
- Modify `frontend/src/live/LiveStatusBar.tsx`: call `useQuoteByCode([activeCode], venue)`.
- Modify `frontend/src/live/LiveCurrentPriceLine.tsx`: call `useQuoteByCode([code], liveVenue)`.
- Modify `frontend/src/util/useDocumentTitle.ts`: call `useQuoteByCode([code], liveVenue)`.
- Modify targeted tests for those consumers where existing cache keys or mocks assume the old signature.
- Modify `CONTEXT.md` and `CHANGELOG.md`: document quote venue alignment.

---

### Task 1: Backend Venue Policy For Quotes

**Files:**
- Modify: `hoga/live/kis_venue.py`
- Modify: `tests/unit/live/test_kis_venue.py`
- Modify: `hoga/live/kis_client.py`
- Modify: `tests/unit/live/test_kis_multi_price.py`

**Interfaces:**
- Produces: `quote_venue_for_policy(policy: LiveVenuePolicy, now: datetime) -> KisVenue`
- Produces: `KisClient.fetch_multi_price(self, codes: list[str], *, venue: KisVenue = "KRX") -> list[KisQuote]`
- Produces: `_build_multi_price_params(codes_chunk: list[str], venue: KisVenue = "KRX") -> dict[str, str]`
- Consumes: `kis_venue_div(venue: KisVenue) -> str`

- [ ] **Step 1: Write failing venue policy tests**

Add to `tests/unit/live/test_kis_venue.py`:

```python
from datetime import datetime

from hoga.live.kis_venue import KIS_KST, quote_venue_for_policy


def test_quote_venue_for_policy_maps_explicit_values() -> None:
    now = datetime(2026, 7, 1, 8, 30, tzinfo=KIS_KST)

    assert quote_venue_for_policy("KRX", now) == "KRX"
    assert quote_venue_for_policy("NXT", now) == "NXT"
    assert quote_venue_for_policy("UN", now) == "UN"


def test_quote_venue_for_policy_auto_uses_nxt_outside_regular_and_krx_inside() -> None:
    assert quote_venue_for_policy("AUTO", datetime(2026, 7, 1, 8, 30, tzinfo=KIS_KST)) == "NXT"
    assert quote_venue_for_policy("AUTO", datetime(2026, 7, 1, 9, 0, tzinfo=KIS_KST)) == "KRX"
    assert quote_venue_for_policy("AUTO", datetime(2026, 7, 1, 15, 30, tzinfo=KIS_KST)) == "KRX"
    assert quote_venue_for_policy("AUTO", datetime(2026, 7, 1, 15, 31, tzinfo=KIS_KST)) == "NXT"
```

- [ ] **Step 2: Run policy tests and verify failure**

Run:

```bash
pytest tests/unit/live/test_kis_venue.py::test_quote_venue_for_policy_maps_explicit_values tests/unit/live/test_kis_venue.py::test_quote_venue_for_policy_auto_uses_nxt_outside_regular_and_krx_inside -q
```

Expected: FAIL with `ImportError` or missing `quote_venue_for_policy`.

- [ ] **Step 3: Implement quote venue policy helper**

Add to `hoga/live/kis_venue.py` near `daily_venue_for_policy`:

```python
def quote_venue_for_policy(policy: LiveVenuePolicy, now: datetime) -> KisVenue:
    """Return the concrete KIS Venue for quote overlay requests.

    AUTO mirrors minute-candle ownership: KRX owns the Regular Session and NXT
    owns extended quote display outside it.
    """
    if policy != "AUTO":
        return policy
    hhmmss = now.astimezone(KIS_KST).strftime("%H%M%S")
    return auto_minute_venue_for_hhmmss(hhmmss)
```

- [ ] **Step 4: Run policy tests and verify pass**

Run:

```bash
pytest tests/unit/live/test_kis_venue.py::test_quote_venue_for_policy_maps_explicit_values tests/unit/live/test_kis_venue.py::test_quote_venue_for_policy_auto_uses_nxt_outside_regular_and_krx_inside -q
```

Expected: PASS.

- [ ] **Step 5: Write failing KIS multi-price venue tests**

Modify `tests/unit/live/test_kis_multi_price.py`:

```python
def test_build_multi_price_params_uses_selected_venue() -> None:
    p = _build_multi_price_params(["005930", "000660"], venue="NXT")
    assert p["FID_COND_MRKT_DIV_CODE_1"] == "NX"
    assert p["FID_COND_MRKT_DIV_CODE_2"] == "NX"

    integrated = _build_multi_price_params(["005930"], venue="UN")
    assert integrated["FID_COND_MRKT_DIV_CODE_1"] == "UN"
```

Add one assertion to `test_fetch_multi_price_chunks_over_30()` after `assert len(calls) == 2`:

```python
    assert all(call["FID_COND_MRKT_DIV_CODE_1"] == "J" for call in calls)
```

Add a new async test:

```python
@pytest.mark.asyncio
async def test_fetch_multi_price_threads_selected_venue() -> None:
    calls: list[dict] = []

    async def fake_get(*, path, tr_id, params):
        calls.append(params)
        return {"output": [
            {"inter_shrn_iscd": "005930", "inter2_prpr": "100", "prdy_ctrt": "1.00", "prdy_vrss_sign": "2"}
        ]}

    quotes = await _fetch_multi_price(fake_get, ["005930"], venue="NXT")

    assert quotes[0].code == "005930"
    assert calls[0]["FID_COND_MRKT_DIV_CODE_1"] == "NX"
```

- [ ] **Step 6: Run multi-price tests and verify failure**

Run:

```bash
pytest tests/unit/live/test_kis_multi_price.py::test_build_multi_price_params_uses_selected_venue tests/unit/live/test_kis_multi_price.py::test_fetch_multi_price_threads_selected_venue -q
```

Expected: FAIL because `_build_multi_price_params` and `_fetch_multi_price` do not accept `venue`.

- [ ] **Step 7: Implement KIS multi-price venue threading**

Modify imports in `hoga/live/kis_client.py`:

```python
from hoga.live.kis_venue import KisVenue, kis_venue_div, previous_empty_page_anchor_hhmmss
```

Change `_build_multi_price_params`:

```python
def _build_multi_price_params(codes_chunk: list[str], *, venue: KisVenue = "KRX") -> dict[str, str]:
    """FID_COND_MRKT_DIV_CODE_N / FID_INPUT_ISCD_N (N=1..30) numbered params."""
    market_div = kis_venue_div(venue)
    params: dict[str, str] = {}
    for n, c in enumerate(codes_chunk, start=1):
        params[f"FID_COND_MRKT_DIV_CODE_{n}"] = market_div
        params[f"FID_INPUT_ISCD_{n}"] = c
    return params
```

Change `KisClient.fetch_multi_price`:

```python
    async def fetch_multi_price(self, codes: list[str], *, venue: KisVenue = "KRX") -> list[KisQuote]:
        """관심종목/스크리너 결과 코드들의 현재가+등락률 (intstock-multprice)."""
        return await _fetch_multi_price(
            lambda *, path, tr_id, params: self._get(path=path, tr_id=tr_id, params=params),
            codes,
            venue=venue,
        )
```

Change `_fetch_multi_price`:

```python
async def _fetch_multi_price(get, codes: list[str], *, venue: KisVenue = "KRX") -> list["KisQuote"]:
    """get: async (*, path, tr_id, params)->dict (KisClient._get 와 동일 시그니처)."""
    chunks = [codes[i:i + _MULTI_PRICE_CHUNK] for i in range(0, len(codes), _MULTI_PRICE_CHUNK)]
    bodies = await asyncio.gather(*(
        get(
            path="/uapi/domestic-stock/v1/quotations/intstock-multprice",
            tr_id="FHKST11300006",
            params=_build_multi_price_params(chunk, venue=venue),
        )
        for chunk in chunks
    ))
```

Keep the existing parsing body after `bodies` unchanged.

- [ ] **Step 8: Run KIS venue and multi-price tests**

Run:

```bash
pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_kis_multi_price.py -q
```

Expected: PASS.

- [ ] **Step 9: Commit backend client seam**

Run:

```bash
git add hoga/live/kis_venue.py hoga/live/kis_client.py tests/unit/live/test_kis_venue.py tests/unit/live/test_kis_multi_price.py
git commit -m "feat: support venue-aware KIS quote requests"
```

Expected: commit succeeds.

---

### Task 2: Backend `/api/live/quotes` Venue Contract

**Files:**
- Modify: `hoga/live/api.py`
- Modify: `tests/unit/live/test_live_quote_fetcher.py`
- Modify: `tests/unit/live/test_live_quotes_route.py`

**Interfaces:**
- Consumes: `parse_live_venue_policy(value: str | None) -> LiveVenuePolicy`
- Consumes: `quote_venue_for_policy(policy: LiveVenuePolicy, now: datetime) -> KisVenue`
- Produces: `/api/live/quotes?codes=005930&venue=NXT`
- Produces: `_quote_phase(now: datetime, venue_policy: LiveVenuePolicy = "KRX") -> Literal["pre_open", "open", "closed"]`
- Produces: `LiveQuoteFetcher.fetch_and_gate(kis, code_list, phase, *, today=None, venue="KRX")`

- [ ] **Step 1: Write failing fetcher venue tests**

Modify `_FakeKis` in `tests/unit/live/test_live_quote_fetcher.py`:

```python
class _FakeKis:
    """fetch_multi_price 만 흉내 — codes 교집합 반환, 호출 수 기록, fail 시 raise."""
    def __init__(self, quotes: list[KisQuote], *, fail: bool = False) -> None:
        self._quotes = quotes
        self.calls = 0
        self.venues: list[str] = []
        self._fail = fail

    async def fetch_multi_price(self, codes: list[str], *, venue: str = "KRX") -> list[KisQuote]:
        self.calls += 1
        self.venues.append(venue)
        if self._fail:
            raise RuntimeError("kis down")
        want = set(codes)
        return [q for q in self._quotes if q.code in want]
```

Add tests:

```python
async def test_open_threads_quote_venue() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis(Q)

    await f.fetch_and_gate(kis, ["005930"], "open", venue="NXT")  # type: ignore[arg-type]

    assert kis.venues == ["NXT"]


async def test_closed_cold_fetch_threads_quote_venue() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis(Q)

    await f.fetch_and_gate(kis, ["005930"], "closed", venue="UN")  # type: ignore[arg-type]

    assert kis.venues == ["UN"]
```

- [ ] **Step 2: Run fetcher tests and verify failure**

Run:

```bash
pytest tests/unit/live/test_live_quote_fetcher.py::test_open_threads_quote_venue tests/unit/live/test_live_quote_fetcher.py::test_closed_cold_fetch_threads_quote_venue -q
```

Expected: FAIL because `fetch_and_gate()` does not accept `venue`.

- [ ] **Step 3: Implement fetcher venue parameter**

Modify `LiveQuoteFetcher.fetch_and_gate` in `hoga/live/api.py`:

```python
    async def fetch_and_gate(
        self,
        kis: KisClient,
        code_list: list[str],
        phase: str,
        today: date | None = None,
        *,
        venue: KisVenue = "KRX",
    ) -> list[LiveQuote]:
```

Change both fetch calls:

```python
                    for q in await kis.fetch_multi_price(code_list, venue=venue):
```

```python
            quotes = await kis.fetch_multi_price(code_list, venue=venue)
```

- [ ] **Step 4: Run fetcher tests and verify pass**

Run:

```bash
pytest tests/unit/live/test_live_quote_fetcher.py -q
```

Expected: PASS.

- [ ] **Step 5: Write failing route and phase tests**

Modify imports in `tests/unit/live/test_live_quotes_route.py` as needed:

```python
from hoga.live.api import build_router, _quote_phase, _KST
```

Modify `_FakeKis`:

```python
class _FakeKis:
    def __init__(self, quotes):
        self._quotes = quotes
        self.venues: list[str] = []

    async def fetch_multi_price(self, codes, *, venue="KRX"):
        self.venues.append(venue)
        return self._quotes
```

Add tests:

```python
def test_quote_phase_auto_treats_nxt_preopen_as_open() -> None:
    assert _quote_phase(datetime(2026, 7, 1, 8, 30, tzinfo=_KST), "AUTO") == "open"
    assert _quote_phase(datetime(2026, 7, 1, 8, 30, tzinfo=_KST), "NXT") == "open"
    assert _quote_phase(datetime(2026, 7, 1, 8, 30, tzinfo=_KST), "UN") == "open"
    assert _quote_phase(datetime(2026, 7, 1, 8, 30, tzinfo=_KST), "KRX") == "closed"


def test_quotes_route_threads_explicit_nxt_venue(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake = _FakeKis(QUOTES)
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "NXT"})

    assert r.status_code == 200
    assert fake.venues == ["NXT"]


def test_quotes_route_auto_uses_nxt_before_regular_session(monkeypatch, tmp_path) -> None:
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2026, 7, 1, 8, 30, tzinfo=tz)

    monkeypatch.setattr(live_api, "datetime", _FixedDatetime)
    fake = _FakeKis(QUOTES)
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "AUTO"})

    assert r.status_code == 200
    assert r.json()["phase"] == "open"
    assert fake.venues == ["NXT"]


def test_quotes_route_rejects_invalid_venue(tmp_path) -> None:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "BAD"})

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"
```

Update old monkeypatch lambdas in `tests/unit/live/test_live_quotes_route.py` to accept the new optional argument:

```python
monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
```

- [ ] **Step 6: Run route tests and verify failure**

Run:

```bash
pytest tests/unit/live/test_live_quotes_route.py::test_quote_phase_auto_treats_nxt_preopen_as_open tests/unit/live/test_live_quotes_route.py::test_quotes_route_threads_explicit_nxt_venue tests/unit/live/test_live_quotes_route.py::test_quotes_route_auto_uses_nxt_before_regular_session tests/unit/live/test_live_quotes_route.py::test_quotes_route_rejects_invalid_venue -q
```

Expected: FAIL because route and phase do not accept venue yet.

- [ ] **Step 7: Implement route contract**

Modify imports in `hoga/live/api.py`:

```python
from hoga.live.kis_venue import (
    KisVenue,
    parse_live_venue_policy,
    quote_venue_for_policy,
)
```

Change `_quote_phase` signature and body:

```python
def _quote_phase(
    now: datetime,
    venue_policy: LiveVenuePolicy = "KRX",
) -> Literal["pre_open", "open", "closed"]:
    if now.weekday() >= 5:
        return "closed"
    t = now.time()
    if venue_policy in ("NXT", "UN", "AUTO"):
        if t < time(8, 0) or t >= time(20, 0):
            return "closed"
        return "pre_open" if venue_policy == "KRX" and t < time(9, 0) else "open"
    if t < time(8, 50) or t >= time(16, 0):
        return "closed"
    return "pre_open" if t < time(9, 0) else "open"
```

Then simplify the impossible branch if desired:

```python
    if venue_policy in ("NXT", "UN", "AUTO"):
        if t < time(8, 0) or t >= time(20, 0):
            return "closed"
        return "open"
```

Change the route:

```python
    @router.get("/quotes", response_model=LiveQuotesResponse)
    async def _get_quotes(
        codes: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> LiveQuotesResponse:
        now = datetime.now(_KST)
        try:
            venue_policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": "invalid_venue", "msg": str(e)}) from e
        quote_venue = quote_venue_for_policy(venue_policy, now)
        phase = _quote_phase(now, venue_policy)
        code_list = [c for c in codes.split(",") if _CODE_RE.match(c)]
```

Change scheduler key and cooldown scope:

```python
                        key=("quotes", quote_venue, tuple(sorted(code_list)), phase),
                        cooldown_scope=f"quotes:{quote_venue}",
```

Pass venue to fetcher:

```python
                        fetch_fn=lambda kis: _quote_fetcher.fetch_and_gate(
                            kis,
                            code_list,
                            phase,
                            today=now.date(),
                            venue=quote_venue,
                        ),
```

- [ ] **Step 8: Run backend quote tests**

Run:

```bash
pytest tests/unit/live/test_live_quote_fetcher.py tests/unit/live/test_live_quotes_route.py tests/unit/live/test_kis_venue.py tests/unit/live/test_kis_multi_price.py -q
```

Expected: PASS.

- [ ] **Step 9: Commit backend route contract**

Run:

```bash
git add hoga/live/api.py tests/unit/live/test_live_quote_fetcher.py tests/unit/live/test_live_quotes_route.py
git commit -m "feat: make live quotes venue-aware"
```

Expected: commit succeeds.

---

### Task 3: Frontend Quote Hook Venue Threading

**Files:**
- Modify: `frontend/src/api/liveQuotes.ts`
- Modify: `frontend/src/api/liveQuotes.test.tsx`

**Interfaces:**
- Produces: `getQuotes(codes: string[], venue?: LiveVenueOption): Promise<LiveQuotesResponse>`
- Produces: `liveQuotesQueryKey(codes: string[], venue?: LiveVenueOption): readonly ['live-quotes', string, LiveVenueOption]`
- Produces: `useQuotes(codes: string[], venue?: LiveVenueOption)`
- Produces: `useLiveQuoteOverlay(codes: string[], venue?: LiveVenueOption)`
- Produces: `useQuoteByCode(codes: string[], venue?: LiveVenueOption)`

- [ ] **Step 1: Write failing hook tests**

Modify imports in `frontend/src/api/liveQuotes.test.tsx`:

```ts
import { getQuotes, useQuoteByCode, useLiveQuoteOverlay, quotesRefetchInterval, liveQuotesQueryKey } from './liveQuotes';
```

Add tests:

```ts
it('threads venue into getQuotes URL', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce({ phase: 'open', quotes: [] });

  await getQuotes(['005930', '000660'], 'NXT');

  expect(spy).toHaveBeenCalledWith('/api/live/quotes?codes=005930,000660&venue=NXT');
});

it('defaults getQuotes venue to KRX for backward-compatible callers', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce({ phase: 'open', quotes: [] });

  await getQuotes(['005930']);

  expect(spy).toHaveBeenCalledWith('/api/live/quotes?codes=005930&venue=KRX');
});

it('includes venue in the query key so KRX and NXT quotes do not share cache', () => {
  expect(liveQuotesQueryKey(['000660', '005930'], 'KRX')).toEqual(['live-quotes', '000660,005930', 'KRX']);
  expect(liveQuotesQueryKey(['000660', '005930'], 'NXT')).toEqual(['live-quotes', '000660,005930', 'NXT']);
});
```

Add to `describe('useQuoteByCode')`:

```ts
  it('passes venue from useQuoteByCode into the query URL', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [{ code: '005930', price: 72400, change_pct: 1.2, change_won: 100 }],
    });

    const { result } = renderHook(() => useQuoteByCode(['005930'], 'NXT'), { wrapper: wrap() });

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(spy).toHaveBeenCalledWith('/api/live/quotes?codes=005930&venue=NXT');
  });
```

- [ ] **Step 2: Run hook tests and verify failure**

Run:

```bash
cd frontend && npx vitest run src/api/liveQuotes.test.tsx
```

Expected: FAIL because the hook does not accept or key by venue.

- [ ] **Step 3: Implement frontend hook venue threading**

Modify `frontend/src/api/liveQuotes.ts`:

```ts
import type { LiveVenueOption } from '../state/liveVenue';
```

Change functions:

```ts
export function getQuotes(codes: string[], venue: LiveVenueOption = 'KRX'): Promise<LiveQuotesResponse> {
  const params = new URLSearchParams({ codes: codes.join(','), venue });
  return apiCall<LiveQuotesResponse>(`/api/live/quotes?${params.toString()}`);
}

export function liveQuotesQueryKey(
  codes: string[],
  venue: LiveVenueOption = 'KRX',
): readonly ['live-quotes', string, LiveVenueOption] {
  return ['live-quotes', [...codes].sort().join(','), venue] as const;
}

export function useQuotes(codes: string[], venue: LiveVenueOption = 'KRX') {
  return useQuery({
    queryKey: liveQuotesQueryKey(codes, venue),
    queryFn: () => getQuotes(codes, venue),
    enabled: codes.length > 0,
    staleTime: 10_000,
    refetchInterval: (q) => quotesRefetchInterval(q.state.data?.phase),
    placeholderData: (prev) => prev,
  });
}

export function useLiveQuoteOverlay(codes: string[], venue: LiveVenueOption = 'KRX'): LiveQuoteOverlay {
  const q = useQuotes(codes, venue);
  const quoteByCode = useMemo(
    () => new Map<string, LiveQuote>((q.data?.quotes ?? []).map((x) => [x.code, x])),
    [q.data],
  );
  return { quoteByCode, phase: q.data?.phase, dataUpdatedAt: q.dataUpdatedAt };
}

export function useQuoteByCode(codes: string[], venue: LiveVenueOption = 'KRX'): Map<string, LiveQuote> {
  return useLiveQuoteOverlay(codes, venue).quoteByCode;
}
```

- [ ] **Step 4: Update tests that seed query keys directly**

Search:

```bash
rg -n "\\['live-quotes'" frontend/src
```

Update direct query data seeds from:

```ts
qc.setQueryData(['live-quotes', props.activeCode], {
  phase: 'open',
  quotes: [{ code: props.activeCode, ...quote }],
});
```

to:

```ts
qc.setQueryData(['live-quotes', props.activeCode, props.venue ?? 'KRX'], {
  phase: 'open',
  quotes: [{ code: props.activeCode, ...quote }],
});
```

If a seed uses sorted multi-code keys, preserve the sorted code string and add `'KRX'`.

- [ ] **Step 5: Run frontend hook tests**

Run:

```bash
cd frontend && npx vitest run src/api/liveQuotes.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit frontend quote seam**

Run:

```bash
git add frontend/src/api/liveQuotes.ts frontend/src/api/liveQuotes.test.tsx frontend/src/live/LiveStatusBar.test.tsx
git commit -m "feat: key live quote cache by venue"
```

Expected: commit succeeds.

---

### Task 4: Wire Selected Venue Into All Quote Consumers

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Modify: `frontend/src/pages/Heatmap.tsx`
- Modify: `frontend/src/screener/useScreenerRowsLive.ts`
- Modify: `frontend/src/live/LiveStatusBar.tsx`
- Modify: `frontend/src/live/LiveCurrentPriceLine.tsx`
- Modify: `frontend/src/util/useDocumentTitle.ts`
- Modify: consumer tests with mocks/spies as needed.

**Interfaces:**
- Consumes: `useLiveVenueStore((s) => s.venue)`
- Consumes: `useQuoteByCode(codes, venue)`
- Consumes: `useLiveQuoteOverlay(codes, venue)`

- [ ] **Step 1: Write failing consumer tests**

Add to `frontend/src/screener/useScreenerRowsLive.test.tsx`:

```ts
import { useLiveVenueStore } from '../state/liveVenue';

it('passes selected KIS venue to the shared quote hook', () => {
  useLiveVenueStore.setState({ venue: 'NXT' });
  const spy = vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map());

  renderHook(() => useScreenerRowsLive(ROWS));

  expect(spy).toHaveBeenCalledWith(['005930', '000660'], 'NXT');
});
```

Add a focused status bar test to `frontend/src/live/LiveStatusBar.test.tsx`:

```ts
import * as liveQuotes from '../api/liveQuotes';

it('passes selected venue to live quote lookup', () => {
  const spy = vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map());

  renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE, venue: 'NXT' });

  expect(spy).toHaveBeenCalledWith(['005930'], 'NXT');
});
```

For Heatmap, add to `frontend/src/pages/Heatmap.test.tsx` or the nearest existing Heatmap test that mocks `useLiveQuoteOverlay`:

```ts
import { useLiveVenueStore } from '../state/liveVenue';

it('passes selected venue to heatmap quote overlay', () => {
  useLiveVenueStore.setState({ venue: 'UN' });
  render(<Heatmap />);
  expect(vi.mocked(useLiveQuoteOverlay)).toHaveBeenCalledWith(expect.any(Array), 'UN');
});
```

For Watchlist, add to `frontend/src/watchlist/WatchlistDrawer.test.tsx`:

```ts
import { useLiveVenueStore } from '../state/liveVenue';
import * as liveQuotes from '../api/liveQuotes';

it('passes selected venue to watchlist quote lookup', async () => {
  useLiveVenueStore.setState({ venue: 'NXT' });
  const spy = vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map());

  renderDrawerWithWatchlistEntries([{ code: '005930', name: '삼성전자' }]);

  expect(spy).toHaveBeenCalledWith(['005930'], 'NXT');
});
```

If the helper name differs, use the existing render helper in that test file and keep the assertion identical.

- [ ] **Step 2: Run consumer tests and verify failure**

Run:

```bash
cd frontend && npx vitest run src/screener/useScreenerRowsLive.test.tsx src/live/LiveStatusBar.test.tsx src/pages/Heatmap.test.tsx src/watchlist/WatchlistDrawer.test.tsx
```

Expected: FAIL for new venue assertions.

- [ ] **Step 3: Wire venue in Screener rows**

Modify `frontend/src/screener/useScreenerRowsLive.ts`:

```ts
import { useLiveVenueStore } from '../state/liveVenue';
```

Inside `useScreenerRowsLive`:

```ts
  const venue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(codes, venue);
```

- [ ] **Step 4: Wire venue in Watchlist drawer**

Modify `frontend/src/watchlist/WatchlistDrawer.tsx`:

```ts
import { useLiveVenueStore } from '../state/liveVenue';
```

Inside `WatchlistDrawer` near quote lookup:

```ts
  const liveVenue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(codes, liveVenue);
```

- [ ] **Step 5: Wire venue in Heatmap**

Modify `frontend/src/pages/Heatmap.tsx`:

```ts
import { useLiveVenueStore } from '../state/liveVenue';
```

Inside `Heatmap`:

```ts
  const liveVenue = useLiveVenueStore((s) => s.venue);
  const { quoteByCode, phase, dataUpdatedAt } = useLiveQuoteOverlay(codes, liveVenue);
```

- [ ] **Step 6: Wire venue in Live Status Bar**

`LiveStatusBar` already receives `venue`; change quote lookup in `frontend/src/live/LiveStatusBar.tsx`:

```ts
  const quoteByCode = useQuoteByCode(activeCode ? [activeCode] : [], venue);
```

- [ ] **Step 7: Wire venue in current price line and document title**

Modify `frontend/src/live/LiveCurrentPriceLine.tsx`:

```ts
import { useLiveVenueStore } from '../state/liveVenue';
```

Inside the component:

```ts
  const venue = useLiveVenueStore((s) => s.venue);
  const quote = useQuoteByCode(code ? [code] : [], venue).get(code ?? '');
```

Modify `frontend/src/util/useDocumentTitle.ts`:

```ts
import { useLiveVenueStore } from '../state/liveVenue';
```

Inside the hook:

```ts
  const venue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(trimmed ? [trimmed] : [], venue);
```

- [ ] **Step 8: Update mocks for new hook signature**

Search:

```bash
rg -n "useQuoteByCode\\(|useLiveQuoteOverlay\\(" frontend/src --glob '*test*'
```

For tests that only mock return values, no behavior change is needed. For tests asserting calls, update expected calls to include venue. For tests seeding React Query directly, use the new key shape from Task 3.

- [ ] **Step 9: Run consumer tests**

Run:

```bash
cd frontend && npx vitest run src/screener/useScreenerRowsLive.test.tsx src/live/LiveStatusBar.test.tsx src/pages/Heatmap.test.tsx src/watchlist/WatchlistDrawer.test.tsx src/live/LiveCurrentPriceLine.test.tsx src/util/useDocumentTitle.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Commit consumer wiring**

Run:

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/pages/Heatmap.tsx frontend/src/screener/useScreenerRowsLive.ts frontend/src/live/LiveStatusBar.tsx frontend/src/live/LiveCurrentPriceLine.tsx frontend/src/util/useDocumentTitle.ts frontend/src/**/*test*
git commit -m "feat: align quote consumers with selected venue"
```

Expected: commit succeeds.

---

### Task 5: Documentation And Full Verification

**Files:**
- Modify: `CONTEXT.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: implemented backend and frontend venue-aware quote behavior.
- Produces: documented user-facing contract for KIS Venue quote overlays.

- [ ] **Step 1: Update domain docs**

Modify `CONTEXT.md` in the `Live Quote` section to add:

```markdown
The quote overlay is **KIS Venue-aware**. The frontend sends the selected
`LiveVenueOption` from `useLiveVenueStore` to `/api/live/quotes`; the backend
maps `KRX -> J`, `NXT -> NX`, `UN -> UN`, and `AUTO` to KRX during Regular
Session (`09:00:00` through `15:30:00`) and NXT during the extended windows.
This aligns Watchlist, Heatmap, Screener, Live Status Bar, current price line,
and browser title with the selected KIS candle venue. Hoga panes and KIS WS
live data remain KRX-oriented.
```

Modify the `KIS Venue` section to add:

```markdown
The selected venue also controls `/api/live/quotes` display overlays. This is
still not Source Preference: it changes which KIS venue endpoint is queried,
not which stored parquet Source wins.
```

- [ ] **Step 2: Update changelog**

Add to top of `CHANGELOG.md`:

```markdown
- **NXT/통합 quote 오버레이 정렬**: 설정 > 데이터소스의 KIS 캔들 거래소 선택을
  `/api/live/quotes`에도 전달해 관심종목, 히트맵, 스크리너, 상태바, 현재가 선,
  브라우저 제목이 KRX 고정이 아니라 선택한 KIS Venue 기준으로 표시되게 했다.
  `AUTO`는 정규장 KRX, 장전·장후 확장 구간 NXT를 사용하며, 호가/WS 패널은 기존처럼
  KRX 기준임을 유지한다.
```

- [ ] **Step 3: Run targeted backend tests**

Run:

```bash
pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_kis_multi_price.py tests/unit/live/test_live_quote_fetcher.py tests/unit/live/test_live_quotes_route.py -q
```

Expected: PASS.

- [ ] **Step 4: Run targeted frontend tests**

Run:

```bash
cd frontend && npx vitest run src/api/liveQuotes.test.tsx src/screener/useScreenerRowsLive.test.tsx src/live/LiveStatusBar.test.tsx src/pages/Heatmap.test.tsx src/watchlist/WatchlistDrawer.test.tsx src/live/LiveCurrentPriceLine.test.tsx src/util/useDocumentTitle.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run build checks**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

Run:

```bash
pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_kis_multi_price.py tests/unit/live/test_live_quote_fetcher.py tests/unit/live/test_live_quotes_route.py -q
```

Expected: PASS.

- [ ] **Step 6: Optional browser smoke**

Start servers if they are not already running:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

```bash
cd frontend && npm run dev
```

Use the app:

1. Open `http://localhost:5173/live`.
2. Open settings.
3. Select `데이터소스 -> KIS 캔들 거래소 -> NXT`.
4. Open Watchlist, Heatmap, and Screener surfaces.
5. Confirm network requests to `/api/live/quotes` include `venue=NXT`.
6. Select `AUTO` before 09:00 KST and confirm requests include `venue=AUTO` while backend returns NXT-backed quotes.

- [ ] **Step 7: Commit docs and verification**

Run:

```bash
git add CONTEXT.md CHANGELOG.md
git commit -m "docs: document venue-aware live quotes"
```

Expected: commit succeeds.

## Self-Review

Spec coverage:

- Watchlist: covered by Task 4.
- Heatmap: covered by Task 4.
- Screener: covered by Task 4.
- NXT pre-open: covered by Task 2 phase tests and backend route test.
- KRX backward compatibility: covered by Task 1 default venue and Task 3 default URL.
- `AUTO`: covered by Task 1 policy and Task 2 route.
- `UN`: covered by Task 1 params and docs.
- Source Preference untouched: covered by Global Constraints.
- Hoga/WS KRX caveat: covered by docs and no changes to hoga panes.

Placeholder scan:

- No unresolved placeholder markers or unspecified test steps remain.

Type consistency:

- `LiveVenueOption` is frontend-only.
- `LiveVenuePolicy` includes `AUTO`; `KisVenue` excludes `AUTO`.
- Backend route parses `LiveVenuePolicy`, resolves to `KisVenue`, and passes concrete `KisVenue` to KIS client.
