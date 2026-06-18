# Live KIS Venue Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/live` chart options for KRX, NXT, integrated KRX+NXT, and automatic regular-session KRX / extended-hours NXT routing for KIS candle OHLCV.

**Architecture:** Introduce a small KIS venue-routing domain type that maps UI options to KIS `FID_COND_MRKT_DIV_CODE` values and session windows. Thread that value through frontend query keys, backend route validation, KIS client calls, and candle caches so venue modes never share stale data. Implement `AUTO` after the explicit KRX/NXT/UN modes by merging KRX and NXT minute bars with deterministic time-window precedence.

**Tech Stack:** Python 3.11, FastAPI, httpx, pytest, React, TypeScript, Zustand, TanStack Query, Vitest.

## Global Constraints

- Default behavior must remain KRX until a user changes the setting.
- KIS venue div codes are `J` for KRX, `NX` for NXT, and `UN` for integrated KRX+NXT.
- UI labels must be exactly `KRX`, `NXT`, `통합`, and `자동`.
- `자동` means KRX for KRX regular session and NXT outside KRX regular session.
- KRX session window is `09:00~15:30` KST.
- NXT display/fetch window is `08:00~20:00` KST, with NXT unavailable during KRX opening/closing auction pauses where KIS returns no rows.
- Cache keys must include the selected venue policy or effective KIS venue div.
- Existing `/live` hoga panes remain KRX/Parquet based unless a later plan adds NXT WS support.
- Do not change `/replay` or `/api/range` behavior except where `/live` already consumes `/api/range` for hoga indicators.

---

## File Structure

- Create `hoga/live/kis_venue.py`
  - Owns backend venue option validation, labels, KIS div mapping, and session windows.
  - Provides a narrow API used by `kis_client.py` and `api.py`.

- Modify `hoga/live/kis_client.py`
  - Adds `venue_div` parameters to `fetch_past_minute_candles` and `fetch_past_daily_candles`.
  - Replaces KRX hard-coded anchor/stop times with venue-window helpers.

- Modify `hoga/live/past_candles_cache.py`
  - Adds venue namespace to disk and memory cache keys.
  - Keeps backwards-compatible KRX reads by using the new path only for new writes; the old path is not migrated.

- Modify `hoga/live/past_daily_candles_cache.py`
  - Adds a venue namespace to the in-memory daily batch and today caches.

- Modify `hoga/live/api.py`
  - Validates `venue` query parameter.
  - Threads explicit modes to KIS and caches.
  - Adds `AUTO` merge behavior for minute candles.

- Create `frontend/src/state/liveVenue.ts`
  - Owns persisted live venue option state and labels.

- Create `frontend/src/live/settings/LiveVenueRoutingRadio.tsx`
  - Renders one venue routing radio row.

- Modify `frontend/src/live/LiveSettingsSections.tsx`
  - Adds venue routing controls under the existing data-source settings section.

- Modify `frontend/src/api/livePastCandles.ts`
  - Adds venue query key and `venue=` query string.

- Modify `frontend/src/api/livePastDailyCandles.ts`
  - Adds venue query key and `venue=` query string.

- Modify `frontend/src/live/useLiveBundle.ts`
  - Reads selected venue option and passes it to KIS candle hooks.
  - Uses venue-specific session defaults for synthesized segments.

- Modify `frontend/src/live/LivePage.tsx`, `frontend/src/live/LiveChartRoot.tsx`, or `viewIdentity` composition
  - Ensures switching venue option remounts/reveals the chart cleanly.

- Modify `frontend/src/live/LiveStatusBar.tsx`
  - Shows the selected venue option next to timeframe/source.

---

### Task 1: Backend KIS Venue Type And KIS Client Parameters

**Files:**
- Create: `hoga/live/kis_venue.py`
- Modify: `hoga/live/kis_client.py:46-51`
- Modify: `hoga/live/kis_client.py:631-715`
- Modify: `hoga/live/kis_client.py:721-853`
- Test: `tests/unit/live/test_kis_venue.py`
- Test: `tests/unit/live/test_kis_rest_methods.py`

**Interfaces:**
- Produces: `KisVenue = Literal["KRX", "NXT", "UN"]`
- Produces: `kis_venue_div(venue: KisVenue) -> str`
- Produces: `session_window_hhmmss(venue: KisVenue) -> tuple[str, str]`
- Produces: `fetch_past_minute_candles(code: str, date_yyyymmdd: str, *, venue: KisVenue = "KRX", foreground: bool = False) -> list[KisCandle]`
- Produces: `fetch_past_daily_candles(code: str, from_yyyymmdd: str, to_yyyymmdd: str, *, venue: KisVenue = "KRX", adjust: bool = True, foreground: bool = False) -> DailyCandleFetchResult`
- Consumes: existing `KisCandle`, `DailyCandleFetchResult`, and `_get`.

- [ ] **Step 1: Write failing tests for venue mapping**

Add `tests/unit/live/test_kis_venue.py`:

```python
"""Tests for hoga.live.kis_venue."""

import pytest

from hoga.live.kis_venue import kis_venue_div, parse_kis_venue, session_window_hhmmss


def test_parse_kis_venue_accepts_supported_values() -> None:
    assert parse_kis_venue("KRX") == "KRX"
    assert parse_kis_venue("NXT") == "NXT"
    assert parse_kis_venue("UN") == "UN"


def test_parse_kis_venue_rejects_auto_at_kis_client_boundary() -> None:
    with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
        parse_kis_venue("AUTO")


def test_kis_venue_div_maps_to_kis_codes() -> None:
    assert kis_venue_div("KRX") == "J"
    assert kis_venue_div("NXT") == "NX"
    assert kis_venue_div("UN") == "UN"


def test_session_window_hhmmss_by_venue() -> None:
    assert session_window_hhmmss("KRX") == ("090000", "153000")
    assert session_window_hhmmss("NXT") == ("080000", "200000")
    assert session_window_hhmmss("UN") == ("080000", "200000")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_kis_venue.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.live.kis_venue'`.

- [ ] **Step 3: Implement backend venue helper**

Create `hoga/live/kis_venue.py`:

```python
"""KIS venue routing for /live candle backfill.

The UI exposes four policies, but the KIS client only accepts concrete KIS
venues. AUTO is expanded at the route layer before calling KisClient.
"""
from __future__ import annotations

from typing import Literal

KisVenue = Literal["KRX", "NXT", "UN"]
LiveVenuePolicy = Literal["KRX", "NXT", "UN", "AUTO"]

_KIS_DIV: dict[KisVenue, str] = {
    "KRX": "J",
    "NXT": "NX",
    "UN": "UN",
}

_SESSION_WINDOWS: dict[KisVenue, tuple[str, str]] = {
    "KRX": ("090000", "153000"),
    "NXT": ("080000", "200000"),
    "UN": ("080000", "200000"),
}


def parse_kis_venue(value: str) -> KisVenue:
    if value in _KIS_DIV:
        return value  # type: ignore[return-value]
    raise ValueError("venue must be one of KRX, NXT, UN")


def parse_live_venue_policy(value: str | None) -> LiveVenuePolicy:
    if value is None or value == "":
        return "KRX"
    if value in ("KRX", "NXT", "UN", "AUTO"):
        return value  # type: ignore[return-value]
    raise ValueError("venue must be one of KRX, NXT, UN, AUTO")


def kis_venue_div(venue: KisVenue) -> str:
    return _KIS_DIV[venue]


def session_window_hhmmss(venue: KisVenue) -> tuple[str, str]:
    return _SESSION_WINDOWS[venue]
```

- [ ] **Step 4: Run venue helper tests**

Run: `uv run pytest tests/unit/live/test_kis_venue.py -v`

Expected: PASS.

- [ ] **Step 5: Write failing KIS client parameter tests**

Append to `tests/unit/live/test_kis_rest_methods.py`:

```python
@pytest.mark.asyncio
async def test_fetch_past_minute_candles_threads_nxt_venue_div(tmp_path) -> None:
    seen_params = []

    def handler(request):
        seen_params.append(dict(request.url.params))
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "MCA00000",
                "msg1": "정상처리",
                "output2": [],
            },
        )

    client = _client_with_transport(tmp_path, httpx.MockTransport(handler))
    await client.fetch_past_minute_candles("005930", "20260609", venue="NXT")

    assert seen_params
    assert seen_params[0]["FID_COND_MRKT_DIV_CODE"] == "NX"
    assert seen_params[0]["FID_INPUT_HOUR_1"] == "200000"


@pytest.mark.asyncio
async def test_fetch_past_daily_candles_threads_integrated_venue_div(tmp_path) -> None:
    seen_params = []

    def handler(request):
        seen_params.append(dict(request.url.params))
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "MCA00000",
                "msg1": "정상처리",
                "output2": [],
            },
        )

    client = _client_with_transport(tmp_path, httpx.MockTransport(handler))
    await client.fetch_past_daily_candles("005930", "20240101", "20240105", venue="UN")

    assert seen_params
    assert seen_params[0]["FID_COND_MRKT_DIV_CODE"] == "UN"
```

- [ ] **Step 6: Run KIS client parameter tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_kis_rest_methods.py -v -k "venue_div"`

Expected: FAIL with `TypeError: ... got an unexpected keyword argument 'venue'`.

- [ ] **Step 7: Implement KIS client venue parameters**

In `hoga/live/kis_client.py`, add imports:

```python
from hoga.live.kis_venue import KisVenue, kis_venue_div, session_window_hhmmss
```

Replace the `_STOCK_MRKT_DIV` block at lines 46-51 with:

```python
# Default KIS venue for backwards-compatible callers. New /live candle routes
# pass an explicit venue value and include it in cache/query keys.
_DEFAULT_KIS_VENUE: KisVenue = "KRX"
```

Change `fetch_past_minute_candles` signature and initial anchors:

```python
    async def fetch_past_minute_candles(
        self,
        code: str,
        date_yyyymmdd: str,
        *,
        venue: KisVenue = _DEFAULT_KIS_VENUE,
        foreground: bool = False,
    ) -> list[KisCandle]:
```

Inside the method, replace the fixed anchor setup:

```python
        session_open_hhmmss, session_close_hhmmss = session_window_hhmmss(venue)
        anchor_hhmmss = session_close_hhmmss
        venue_div = kis_venue_div(venue)
```

Replace the request param:

```python
                "FID_COND_MRKT_DIV_CODE": venue_div,
```

Replace the stop condition:

```python
            session_open_hour = int(session_open_hhmmss[:2])
            session_open_minute = int(session_open_hhmmss[2:4])
            if (
                earliest_dt.hour < session_open_hour
                or (
                    earliest_dt.hour == session_open_hour
                    and earliest_dt.minute <= session_open_minute
                )
            ):
                break
```

Change `fetch_past_daily_candles` signature:

```python
    async def fetch_past_daily_candles(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: KisVenue = _DEFAULT_KIS_VENUE,
        adjust: bool = True,
        foreground: bool = False,
    ) -> DailyCandleFetchResult:
```

Inside the daily method before the loop:

```python
        venue_div = kis_venue_div(venue)
```

Replace the request param:

```python
                "FID_COND_MRKT_DIV_CODE": venue_div,
```

- [ ] **Step 8: Run KIS client tests**

Run: `uv run pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_kis_rest_methods.py -v -k "venue or venue_div or fetch_past_minute or fetch_past_daily"`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add hoga/live/kis_venue.py hoga/live/kis_client.py tests/unit/live/test_kis_venue.py tests/unit/live/test_kis_rest_methods.py
git commit -m "feat(live): parameterize KIS candle venue"
```

---

### Task 2: Minute Candle Route And Disk Cache Venue Namespace

**Files:**
- Modify: `hoga/live/past_candles_cache.py:45-153`
- Modify: `hoga/live/api.py:838-1021`
- Test: `tests/unit/live/test_past_candles_cache.py`
- Test: `tests/unit/live/test_api.py`

**Interfaces:**
- Consumes: `parse_live_venue_policy(value: str | None) -> LiveVenuePolicy`
- Consumes: `KisVenue = Literal["KRX", "NXT", "UN"]`
- Produces: `PastCandlesCache.get_past(venue: KisVenue, code: str, date: str) -> list[dict] | None`
- Produces: `PastCandlesCache.store_past(venue: KisVenue, code: str, date: str, bars: list[dict]) -> None`
- Produces: `PastCandlesCache.get_today_tri(venue: KisVenue, code: str) -> tuple[TodayState, list[dict] | None]`
- Produces: `PastCandlesCache.store_today(venue: KisVenue, code: str, bars: list[dict] | None) -> None`
- Produces: `GET /api/live/past-candles?...&venue=KRX|NXT|UN|AUTO`

- [ ] **Step 1: Write failing cache namespace test**

Append to `tests/unit/live/test_past_candles_cache.py`:

```python
def test_past_cache_separates_venue_namespaces(tmp_path: Path) -> None:
    cache = PastCandlesCache(tmp_path)
    krx_bars = [{"t_ms": 1_779_062_400_000, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 10}]
    nxt_bars = [{"t_ms": 1_779_058_800_000, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 20}]

    cache.store_past("KRX", "005930", "20260518", krx_bars)
    cache.store_past("NXT", "005930", "20260518", nxt_bars)

    assert cache.get_past("KRX", "005930", "20260518") == krx_bars
    assert cache.get_past("NXT", "005930", "20260518") == nxt_bars
    assert (tmp_path / "kis-past-candles" / "KRX" / "005930" / "20260518.json").exists()
    assert (tmp_path / "kis-past-candles" / "NXT" / "005930" / "20260518.json").exists()
```

- [ ] **Step 2: Run cache test to verify it fails**

Run: `uv run pytest tests/unit/live/test_past_candles_cache.py -v -k "venue_namespaces"`

Expected: FAIL with `TypeError` because cache methods do not accept `venue`.

- [ ] **Step 3: Implement minute cache venue namespace**

In `hoga/live/past_candles_cache.py`, import `KisVenue`:

```python
from hoga.live.kis_venue import KisVenue
```

Change memory fields:

```python
        self._past_mem: dict[tuple[KisVenue, str, str], list[dict]] = {}
        self._today_mem: dict[tuple[KisVenue, str], tuple[float, list[dict] | None]] = {}
```

Replace `_past_path`, `get_past`, `store_past`, `get_today_tri`, and `store_today` signatures and key usage:

```python
    def _past_path(self, venue: KisVenue, code: str, date: str) -> Path:
        return self._data_dir / "kis-past-candles" / venue / code / f"{date}.json"

    def get_past(self, venue: KisVenue, code: str, date: str) -> list[dict] | None:
        key = (venue, code, date)
        if key in self._past_mem:
            bars = self._past_mem[key]
            if not self._bars_match_date(bars, date):
                self._past_mem.pop(key, None)
            else:
                return bars
        p = self._past_path(venue, code, date)
        if not p.exists():
            return None
        try:
            body = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_candles_cache.corrupt_or_unreadable path=%s", p, exc_info=True)
            return None
        bars = body.get("candles") or []
        if not self._bars_match_date(bars, date):
            _log.warning(
                "past_candles_cache.stale_disk_evicting path=%s reason=date_mismatch",
                p,
            )
            try:
                p.unlink()
            except OSError:
                pass
            return None
        self._past_mem[key] = bars
        return bars

    def store_past(self, venue: KisVenue, code: str, date: str, bars: list[dict]) -> None:
        p = self._past_path(venue, code, date)
        payload = {
            "candles": bars,
            "fetched_at_ms": int(time.time() * 1000),
            "kis_tr_id": _KIS_TR_ID,
            "venue": venue,
        }
        atomic_write_json(p, payload)
        self._past_mem[(venue, code, date)] = bars

    def get_today_tri(self, venue: KisVenue, code: str) -> tuple[TodayState, list[dict] | None]:
        entry = self._today_mem.get((venue, code))
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return "miss", None
        if value is None:
            return "negative", None
        return "hit", value

    def store_today(self, venue: KisVenue, code: str, bars: list[dict] | None) -> None:
        self._today_mem[(venue, code)] = (time.monotonic(), bars)
```

- [ ] **Step 4: Update existing cache tests to pass KRX**

In `tests/unit/live/test_past_candles_cache.py`, replace existing cache calls:

```python
cache.get_past("005930", "20260518")
cache.store_past("005930", "20260518", bars)
cache.get_today_tri("005930")
cache.store_today("005930", bars)
```

with:

```python
cache.get_past("KRX", "005930", "20260518")
cache.store_past("KRX", "005930", "20260518", bars)
cache.get_today_tri("KRX", "005930")
cache.store_today("KRX", "005930", bars)
```

- [ ] **Step 5: Run cache tests**

Run: `uv run pytest tests/unit/live/test_past_candles_cache.py -v`

Expected: PASS.

- [ ] **Step 6: Write failing minute route venue test**

Append to `tests/unit/live/test_api.py`:

```python
async def test_past_candles_threads_nxt_venue_to_kis_and_cache(tmp_path) -> None:
    seen = []

    class FakeKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            seen.append((code, date_yyyymmdd, kw))
            return [
                KisCandle(
                    t_ms=1_779_058_800_000,
                    open=10,
                    high=12,
                    low=9,
                    close=11,
                    volume=123,
                )
            ]

    app = _past_app(tmp_path, FakeKis())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=NXT")

    assert r.status_code == 200
    assert seen == [("005930", "20260518", {"venue": "NXT", "foreground": True})]
    assert r.json()["candles"][0]["volume"] == 123
    assert (tmp_path / "kis-past-candles" / "NXT" / "005930" / "20260518.json").exists()
```

- [ ] **Step 7: Run route test to verify it fails**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "threads_nxt_venue"`

Expected: FAIL because route ignores `venue` and cache signature changed.

- [ ] **Step 8: Implement minute route venue threading for explicit modes**

In `hoga/live/api.py`, import:

```python
from hoga.live.kis_venue import KisVenue, parse_live_venue_policy
```

Change `_past_inflight` key:

```python
    _past_inflight: dict[tuple[KisVenue, str, str], asyncio.Task[tuple[list[dict], str | None]]] = {}
```

Change `_fetch_past_shared`:

```python
    async def _fetch_past_shared(
        kis: KisClient, venue: KisVenue, code: str, date_s: str
    ) -> tuple[list[dict], str | None]:
        key = (venue, code, date_s)
        task = _past_inflight.get(key)
        if task is None:
            async def _do() -> tuple[list[dict], str | None]:
                raw = await kis.fetch_past_minute_candles(
                    code, date_s, venue=venue, foreground=True,
                )
                bars = [_candle_to_dict(c) for c in raw]
                try:
                    cache_instance.store_past(venue, code, date_s, bars)  # type: ignore[union-attr]
                except OSError as e:
                    return bars, str(e)
                return bars, None

            task = asyncio.create_task(_do())
            _past_inflight[key] = task
            task.add_done_callback(lambda _t, k=key: _past_inflight.pop(k, None))
        return await task
```

Change route signature:

```python
        venue: str | None = Query("KRX"),
```

After validation:

```python
        policy = parse_live_venue_policy(venue)
        if policy == "AUTO":
            raise HTTPException(422, {"code": "auto_not_implemented", "msg": "AUTO venue policy is implemented in a later task"})
        kis_venue: KisVenue = policy
```

Replace cache calls:

```python
            bars = cache.get_past(kis_venue, code, date_s)
```

Replace fetch call:

```python
                    bars, write_err = await _fetch_past_shared(kis, kis_venue, code, date_s)
```

Replace today calls:

```python
                state, today_bars = cache.get_today_tri(kis_venue, code)
                ...
                    raw = await kis.fetch_past_minute_candles(
                        code, date_s, venue=kis_venue, foreground=True,
                    )
                ...
                        cache.store_today(kis_venue, code, bars)
                ...
                        cache.store_today(kis_venue, code, None)
```

Add `venue` to response:

```python
            "venue": policy,
```

- [ ] **Step 9: Update existing API tests to default KRX-compatible fakes**

In fake KIS methods inside `tests/unit/live/test_api.py`, keep `**_kw` where already present. For fakes without `**_kw`, change:

```python
async def fetch_past_minute_candles(self, code, date_yyyymmdd):
```

to:

```python
async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
```

- [ ] **Step 10: Run minute route/cache tests**

Run: `uv run pytest tests/unit/live/test_past_candles_cache.py tests/unit/live/test_api.py -v -k "past_candles"`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add hoga/live/past_candles_cache.py hoga/live/api.py tests/unit/live/test_past_candles_cache.py tests/unit/live/test_api.py
git commit -m "feat(live): namespace minute candle cache by venue"
```

---

### Task 3: Daily Candle Route And Memory Cache Venue Namespace

**Files:**
- Modify: `hoga/live/past_daily_candles_cache.py:23-61`
- Modify: `hoga/live/api.py:1023-1048`
- Test: `tests/unit/live/test_past_daily_candles_cache.py`
- Test: `tests/unit/live/test_api.py`

**Interfaces:**
- Consumes: `KisVenue`
- Produces: `PastDailyCandlesCache.list_batches(venue: KisVenue, code: str) -> list[tuple[date, date, list[dict]]]`
- Produces: `PastDailyCandlesCache.append_batch(venue: KisVenue, code: str, frm: date, to: date, bars: list[dict]) -> None`
- Produces: `PastDailyCandlesCache.get_today(venue: KisVenue, code: str) -> tuple[TodayState, dict | None]`
- Produces: `PastDailyCandlesCache.store_today(venue: KisVenue, code: str, bar: dict | None) -> None`

- [ ] **Step 1: Write failing daily cache venue test**

Append to `tests/unit/live/test_past_daily_candles_cache.py`:

```python
def test_daily_cache_separates_venue_batches() -> None:
    cache = PastDailyCandlesCache()
    frm = date(2026, 5, 18)
    to = date(2026, 5, 20)
    krx_bars = [{"t_ms": 1, "close": 10}]
    nxt_bars = [{"t_ms": 1, "close": 20}]

    cache.append_batch("KRX", "005930", frm, to, krx_bars)
    cache.append_batch("NXT", "005930", frm, to, nxt_bars)

    assert cache.list_batches("KRX", "005930") == [(frm, to, krx_bars)]
    assert cache.list_batches("NXT", "005930") == [(frm, to, nxt_bars)]
```

- [ ] **Step 2: Run daily cache test to verify it fails**

Run: `uv run pytest tests/unit/live/test_past_daily_candles_cache.py -v -k "venue_batches"`

Expected: FAIL with `TypeError`.

- [ ] **Step 3: Implement daily cache venue namespace**

In `hoga/live/past_daily_candles_cache.py`, import:

```python
from hoga.live.kis_venue import KisVenue
```

Replace cache fields and methods:

```python
        self._per_key: dict[tuple[KisVenue, str], list[tuple[date, date, list[dict]]]] = {}
        self._today_mem: dict[tuple[KisVenue, str], tuple[float, dict | None]] = {}

    def list_batches(self, venue: KisVenue, code: str) -> list[tuple[date, date, list[dict]]]:
        return list(self._per_key.get((venue, code), []))

    def append_batch(
        self, venue: KisVenue, code: str, frm: date, to: date, bars: list[dict],
    ) -> None:
        self._per_key.setdefault((venue, code), []).append((frm, to, bars))

    def get_today(self, venue: KisVenue, code: str) -> tuple[TodayState, dict | None]:
        entry = self._today_mem.get((venue, code))
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return "miss", None
        if value is None:
            return "negative", None
        return "hit", value

    def store_today(self, venue: KisVenue, code: str, bar: dict | None) -> None:
        self._today_mem[(venue, code)] = (time.monotonic(), bar)
```

- [ ] **Step 4: Update existing daily cache tests**

In `tests/unit/live/test_past_daily_candles_cache.py`, update existing calls:

```python
cache.list_batches("005930")
cache.append_batch("005930", frm, to, bars)
cache.get_today("005930")
cache.store_today("005930", bar)
```

to:

```python
cache.list_batches("KRX", "005930")
cache.append_batch("KRX", "005930", frm, to, bars)
cache.get_today("KRX", "005930")
cache.store_today("KRX", "005930", bar)
```

- [ ] **Step 5: Run daily cache tests**

Run: `uv run pytest tests/unit/live/test_past_daily_candles_cache.py -v`

Expected: PASS.

- [ ] **Step 6: Adapt `batched_daily_walkback` caller without changing shared helper**

If `batched_daily_walkback` expects cache methods with `(code, ...)`, do not broaden that shared helper in this task. Instead add an adapter class in `hoga/live/api.py` near the daily route:

```python
    class _VenueDailyCacheAdapter:
        def __init__(self, inner: PastDailyCandlesCache, venue: KisVenue) -> None:
            self._inner = inner
            self._venue = venue

        def list_batches(self, code: str):
            return self._inner.list_batches(self._venue, code)

        def append_batch(self, code: str, frm, to, bars: list[dict]) -> None:
            self._inner.append_batch(self._venue, code, frm, to, bars)

        def get_today(self, code: str):
            return self._inner.get_today(self._venue, code)

        def store_today(self, code: str, bar: dict | None) -> None:
            self._inner.store_today(self._venue, code, bar)
```

- [ ] **Step 7: Write failing daily route venue test**

Append to `tests/unit/live/test_api.py`:

```python
async def test_past_daily_candles_threads_un_venue_to_kis(tmp_path) -> None:
    seen = []

    class FakeKis:
        async def fetch_past_daily_candles(self, code, from_yyyymmdd, to_yyyymmdd, **kw):
            seen.append((code, from_yyyymmdd, to_yyyymmdd, kw))
            return DailyCandleFetchResult(
                candles=[
                    KisCandle(
                        t_ms=1_779_062_400_000,
                        open=10,
                        high=12,
                        low=9,
                        close=11,
                        volume=1000,
                    )
                ],
                violations=[],
            )

    app = _past_app(tmp_path, FakeKis())
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20260518&to=20260518&venue=UN")

    assert r.status_code == 200
    assert seen == [("005930", "20260518", "20260518", {"venue": "UN", "foreground": True})]
    assert r.json()["candles"][0]["volume"] == 1000
    assert r.json()["venue"] == "UN"
```

- [ ] **Step 8: Run route test to verify it fails**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "past_daily_candles_threads_un_venue"`

Expected: FAIL because daily route does not parse or thread `venue`.

- [ ] **Step 9: Implement daily route venue threading**

Change route signature:

```python
        venue: str | None = Query("KRX"),
```

After validation:

```python
        policy = parse_live_venue_policy(venue)
        if policy == "AUTO":
            raise HTTPException(422, {"code": "auto_not_implemented", "msg": "AUTO daily venue policy is implemented in a later task"})
        kis_venue: KisVenue = policy
```

Change `fetch_batch`:

```python
        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await kis.fetch_past_daily_candles(
                code_, from_s, to_s, venue=kis_venue, foreground=True,
            )
            return [_candle_to_dict(c) for c in result.candles], result.violations
```

Call `batched_daily_walkback` with adapter:

```python
        out = await batched_daily_walkback(
            cache=_VenueDailyCacheAdapter(daily_cache_instance, kis_venue),
            fetch_batch=fetch_batch,
            output_key="candles",
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
        )
        out["venue"] = policy
        return out
```

- [ ] **Step 10: Run daily route/cache tests**

Run: `uv run pytest tests/unit/live/test_past_daily_candles_cache.py tests/unit/live/test_api.py -v -k "past_daily or daily_cache"`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add hoga/live/past_daily_candles_cache.py hoga/live/api.py tests/unit/live/test_past_daily_candles_cache.py tests/unit/live/test_api.py
git commit -m "feat(live): namespace daily candle cache by venue"
```

---

### Task 4: Frontend Venue Preference Store And Settings UI

**Files:**
- Create: `frontend/src/state/liveVenue.ts`
- Create: `frontend/src/live/settings/LiveVenueRoutingRadio.tsx`
- Modify: `frontend/src/live/LiveSettingsSections.tsx:1-92`
- Modify: `frontend/src/live/LiveStatusBar.tsx:1-115`
- Test: `frontend/src/state/liveVenue.test.ts`
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`
- Test: `frontend/src/live/LiveStatusBar.test.tsx`

**Interfaces:**
- Produces: `LIVE_VENUE_OPTIONS = ['KRX', 'NXT', 'UN', 'AUTO'] as const`
- Produces: `type LiveVenueOption = 'KRX' | 'NXT' | 'UN' | 'AUTO'`
- Produces: `LIVE_VENUE_LABEL: Record<LiveVenueOption, string>`
- Produces: `useLiveVenueStore`
- Consumes: existing settings modal layout.

- [ ] **Step 1: Write failing store tests**

Create `frontend/src/state/liveVenue.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { LIVE_VENUE_LABEL, LIVE_VENUE_OPTIONS, useLiveVenueStore } from './liveVenue';

describe('useLiveVenueStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useLiveVenueStore.setState({ liveVenue: 'KRX' });
  });

  it('defines the four live venue options and labels', () => {
    expect(LIVE_VENUE_OPTIONS).toEqual(['KRX', 'NXT', 'UN', 'AUTO']);
    expect(LIVE_VENUE_LABEL).toEqual({
      KRX: 'KRX',
      NXT: 'NXT',
      UN: '통합',
      AUTO: '자동',
    });
  });

  it('defaults to KRX', () => {
    expect(useLiveVenueStore.getState().liveVenue).toBe('KRX');
  });

  it('updates and persists a supported venue option', () => {
    useLiveVenueStore.getState().setLiveVenue('AUTO');
    expect(useLiveVenueStore.getState().liveVenue).toBe('AUTO');
    expect(localStorage.getItem('live.venue.v1')).toContain('AUTO');
  });

  it('ignores unsupported persisted values', () => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ liveVenue: 'BAD' }));
    useLiveVenueStore.getState().hydrateFromStorage();
    expect(useLiveVenueStore.getState().liveVenue).toBe('KRX');
  });
});
```

- [ ] **Step 2: Run store test to verify it fails**

Run: `cd frontend && npm test -- src/state/liveVenue.test.ts --run`

Expected: FAIL because `./liveVenue` does not exist.

- [ ] **Step 3: Implement live venue store**

Create `frontend/src/state/liveVenue.ts`:

```ts
import { create } from 'zustand';

export const LIVE_VENUE_OPTIONS = ['KRX', 'NXT', 'UN', 'AUTO'] as const;
export type LiveVenueOption = (typeof LIVE_VENUE_OPTIONS)[number];

export const LIVE_VENUE_LABEL: Record<LiveVenueOption, string> = {
  KRX: 'KRX',
  NXT: 'NXT',
  UN: '통합',
  AUTO: '자동',
};

const STORAGE_KEY = 'live.venue.v1';

type Store = {
  liveVenue: LiveVenueOption;
  setLiveVenue: (value: LiveVenueOption) => void;
  hydrateFromStorage: () => void;
};

function isLiveVenueOption(value: unknown): value is LiveVenueOption {
  return typeof value === 'string' && (LIVE_VENUE_OPTIONS as readonly string[]).includes(value);
}

function readStorage(): { liveVenue: LiveVenueOption } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { liveVenue?: unknown };
    if (isLiveVenueOption(parsed.liveVenue)) return { liveVenue: parsed.liveVenue };
  } catch {
    return null;
  }
  return null;
}

function persist(state: { liveVenue: LiveVenueOption }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable in tests or privacy modes.
  }
}

export const useLiveVenueStore = create<Store>((set) => ({
  liveVenue: readStorage()?.liveVenue ?? 'KRX',
  setLiveVenue: (value) => {
    if (!isLiveVenueOption(value)) return;
    set({ liveVenue: value });
    persist({ liveVenue: value });
  },
  hydrateFromStorage: () => {
    const stored = readStorage();
    set({ liveVenue: stored?.liveVenue ?? 'KRX' });
  },
}));
```

- [ ] **Step 4: Run store tests**

Run: `cd frontend && npm test -- src/state/liveVenue.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Write failing settings UI test**

Append to `frontend/src/live/LiveSettingsSections.test.tsx`:

```tsx
it('renders live venue routing options in data-source settings', () => {
  render(<LiveSettingsSections />);
  fireEvent.click(screen.getByTestId('settings-nav-data-source'));

  expect(screen.getByLabelText('KRX')).toBeInTheDocument();
  expect(screen.getByLabelText('NXT')).toBeInTheDocument();
  expect(screen.getByLabelText('통합')).toBeInTheDocument();
  expect(screen.getByLabelText('자동')).toBeInTheDocument();
});
```

- [ ] **Step 6: Run settings test to verify it fails**

Run: `cd frontend && npm test -- src/live/LiveSettingsSections.test.tsx --run`

Expected: FAIL because venue radios are not rendered.

- [ ] **Step 7: Implement venue radio component**

Create `frontend/src/live/settings/LiveVenueRoutingRadio.tsx`:

```tsx
import {
  LIVE_VENUE_LABEL,
  type LiveVenueOption,
  useLiveVenueStore,
} from '../../state/liveVenue';

export default function LiveVenueRoutingRadio({ value }: { value: LiveVenueOption }) {
  const current = useLiveVenueStore((s) => s.liveVenue);
  const setLiveVenue = useLiveVenueStore((s) => s.setLiveVenue);
  const label = LIVE_VENUE_LABEL[value];

  return (
    <label className="flex items-center gap-2 text-sm text-fg">
      <input
        type="radio"
        name="live-venue-routing"
        value={value}
        checked={current === value}
        onChange={() => setLiveVenue(value)}
      />
      <span>{label}</span>
    </label>
  );
}
```

- [ ] **Step 8: Add venue controls to data-source settings**

In `frontend/src/live/LiveSettingsSections.tsx`, add imports:

```ts
import { LIVE_VENUE_OPTIONS } from '../state/liveVenue';
import LiveVenueRoutingRadio from './settings/LiveVenueRoutingRadio';
```

In `DataSourceDetail`, after the existing `SOURCE_OPTIONS` block, add:

```tsx
      <div className="border-b border-border my-3" />
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
        KIS 캔들 시장 <span style={{ color: 'var(--fg-dimmer)' }}>(/live 차트)</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
        {LIVE_VENUE_OPTIONS.map((opt) => (
          <LiveVenueRoutingRadio key={opt} value={opt} />
        ))}
      </div>
```

- [ ] **Step 9: Add status bar label**

In `frontend/src/live/LiveStatusBar.tsx`, import:

```ts
import { LIVE_VENUE_LABEL, useLiveVenueStore } from '../state/liveVenue';
```

Inside `LiveStatusBar`:

```ts
  const liveVenue = useLiveVenueStore((s) => s.liveVenue);
```

After timeframe display:

```tsx
      <span aria-hidden>·</span>
      <span>{LIVE_VENUE_LABEL[liveVenue]}</span>
```

- [ ] **Step 10: Run frontend UI tests**

Run: `cd frontend && npm test -- src/state/liveVenue.test.ts src/live/LiveSettingsSections.test.tsx src/live/LiveStatusBar.test.tsx --run`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/state/liveVenue.ts frontend/src/state/liveVenue.test.ts frontend/src/live/settings/LiveVenueRoutingRadio.tsx frontend/src/live/LiveSettingsSections.tsx frontend/src/live/LiveSettingsSections.test.tsx frontend/src/live/LiveStatusBar.tsx frontend/src/live/LiveStatusBar.test.tsx
git commit -m "feat(live): add KIS candle venue setting"
```

---

### Task 5: Frontend Query Wiring And Chart Identity

**Files:**
- Modify: `frontend/src/api/livePastCandles.ts:31-55`
- Modify: `frontend/src/api/livePastDailyCandles.ts:34-55`
- Modify: `frontend/src/live/useLiveBundle.ts:1-240`
- Modify: `frontend/src/live/LivePage.tsx:127-135`
- Test: `frontend/src/api/livePastCandles.test.tsx`
- Test: `frontend/src/api/livePastDailyCandles.test.tsx`
- Test: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Consumes: `LiveVenueOption`
- Produces: `useLivePastCandles(code, from, to, venue)`
- Produces: `useLivePastDailyCandles(code, from, to, venue)`
- Produces: venue in query key and URL.

- [ ] **Step 1: Write failing hook URL tests**

Append to `frontend/src/api/livePastCandles.test.tsx`:

```tsx
it('threads venue into past-candles query string', async () => {
  const calls: string[] = [];
  vi.spyOn(clientMod, 'apiCall').mockImplementation(async (url: string) => {
    calls.push(url);
    return { code: '005930', from: '20260601', to: '20260601', candles: [], cached_dates: [], fresh_dates: [], data_warnings: [] };
  });

  renderHookWithClient(() => useLivePastCandles('005930', '20260601', '20260601', 'NXT'));

  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]).toContain('venue=NXT');
});
```

Append to `frontend/src/api/livePastDailyCandles.test.tsx`:

```tsx
it('threads venue into past-daily-candles query string', async () => {
  const calls: string[] = [];
  vi.spyOn(clientMod, 'apiCall').mockImplementation(async (url: string) => {
    calls.push(url);
    return { code: '005930', from: '20260601', to: '20260601', candles: [], cached_batches: [], fresh_batches: [], data_warnings: [] };
  });

  renderHookWithClient(() => useLivePastDailyCandles('005930', '20260601', '20260601', 'UN'));

  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]).toContain('venue=UN');
});
```

- [ ] **Step 2: Run hook URL tests to verify they fail**

Run: `cd frontend && npm test -- src/api/livePastCandles.test.tsx src/api/livePastDailyCandles.test.tsx --run`

Expected: FAIL because hook signatures do not accept venue.

- [ ] **Step 3: Update hook signatures and query keys**

In `frontend/src/api/livePastCandles.ts`, import:

```ts
import type { LiveVenueOption } from '../state/liveVenue';
```

Change signature and query:

```ts
export function useLivePastCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: () => (isKrxRegularSessionNow() ? 60_000 : false),
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
```

In `frontend/src/api/livePastDailyCandles.ts`, apply the same pattern:

```ts
import type { LiveVenueOption } from '../state/liveVenue';

export function useLivePastDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-daily-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastDailyCandlesResponse>(
        `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: () => (isKrxRegularSessionNow() ? 60_000 : false),
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
```

- [ ] **Step 4: Wire selected venue into `useLiveBundle`**

In `frontend/src/live/useLiveBundle.ts`, import:

```ts
import { useLiveVenueStore } from '../state/liveVenue';
```

Inside `useLiveBundle` after `historicalFromDate`:

```ts
  const liveVenue = useLiveVenueStore((s) => s.liveVenue);
```

Pass it to both hooks:

```ts
  const pastCandlesQuery = useLivePastCandles(
    enableMinute ? code : null,
    enableMinute ? minutePastFrom : null,
    enableMinute ? minutePastTo : null,
    liveVenue,
  );
```

```ts
  const pastDailyCandlesQuery = useLivePastDailyCandles(
    enableDaily ? code : null,
    enableDaily ? dailyPastFrom : null,
    enableDaily ? dailyPastTo : null,
    liveVenue,
  );
```

- [ ] **Step 5: Force chart identity change when venue changes**

In `frontend/src/LivePage.tsx`, read live venue:

```ts
  const liveVenue = useLiveVenueStore((s) => s.liveVenue);
```

Import:

```ts
import { useLiveVenueStore } from '../state/liveVenue';
```

Change `viewIdentity`:

```tsx
        viewIdentity={`${activeTabId ?? ''}|${liveVenue}`}
```

- [ ] **Step 6: Run frontend hook and bundle tests**

Run: `cd frontend && npm test -- src/api/livePastCandles.test.tsx src/api/livePastDailyCandles.test.tsx src/live/useLiveBundle.test.tsx --run`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/livePastCandles.ts frontend/src/api/livePastCandles.test.tsx frontend/src/api/livePastDailyCandles.ts frontend/src/api/livePastDailyCandles.test.tsx frontend/src/live/useLiveBundle.ts frontend/src/live/useLiveBundle.test.tsx frontend/src/live/LivePage.tsx
git commit -m "feat(live): thread venue setting into KIS candle queries"
```

---

### Task 6: Venue-Specific Session Windows In Chart Segments

**Files:**
- Modify: `frontend/src/live/liveDateTime.ts:15-100`
- Modify: `frontend/src/live/buildLiveBundle.ts:1-184`
- Modify: `frontend/src/live/useLiveBundle.ts:243-250`
- Test: `frontend/src/live/liveDateTime.test.ts`
- Test: `frontend/src/live/buildLiveBundle.test.ts`

**Interfaces:**
- Produces: `venueSessionOpenMs(yyyymmdd: string, venue: LiveVenueOption) -> number`
- Produces: `venueSessionCloseMs(yyyymmdd: string, venue: LiveVenueOption) -> number`
- Consumes: `LiveVenueOption`

- [ ] **Step 1: Write failing session-window tests**

Append to `frontend/src/live/liveDateTime.test.ts`:

```ts
import { venueSessionCloseMs, venueSessionOpenMs } from './liveDateTime';

it('uses KRX session bounds for KRX', () => {
  const date = '20260612';
  expect(venueSessionOpenMs(date, 'KRX')).toBe(regularSessionOpenMs(date));
  expect(venueSessionCloseMs(date, 'KRX')).toBe(regularSessionCloseMs(date));
});

it('uses extended session bounds for NXT, UN, and AUTO', () => {
  const date = '20260612';
  const open = regularSessionOpenMs(date) - 60 * 60_000;
  const close = regularSessionOpenMs(date) + 11 * 60 * 60_000;

  expect(venueSessionOpenMs(date, 'NXT')).toBe(open);
  expect(venueSessionCloseMs(date, 'NXT')).toBe(close);
  expect(venueSessionOpenMs(date, 'UN')).toBe(open);
  expect(venueSessionCloseMs(date, 'UN')).toBe(close);
  expect(venueSessionOpenMs(date, 'AUTO')).toBe(open);
  expect(venueSessionCloseMs(date, 'AUTO')).toBe(close);
});
```

- [ ] **Step 2: Run session tests to verify they fail**

Run: `cd frontend && npm test -- src/live/liveDateTime.test.ts --run`

Expected: FAIL because `venueSessionOpenMs` and `venueSessionCloseMs` are not exported.

- [ ] **Step 3: Implement frontend venue session helpers**

In `frontend/src/live/liveDateTime.ts`, import:

```ts
import type { LiveVenueOption } from '../state/liveVenue';
```

Add:

```ts
const HOUR_MS = 60 * 60_000;

export function venueSessionOpenMs(yyyymmdd: string, venue: LiveVenueOption): number {
  const krxOpen = regularSessionOpenMs(yyyymmdd);
  return venue === 'KRX' ? krxOpen : krxOpen - HOUR_MS;
}

export function venueSessionCloseMs(yyyymmdd: string, venue: LiveVenueOption): number {
  const krxOpen = regularSessionOpenMs(yyyymmdd);
  return venue === 'KRX' ? regularSessionCloseMs(yyyymmdd) : krxOpen + 11 * HOUR_MS;
}
```

- [ ] **Step 4: Thread venue into synthesized segments**

In `frontend/src/live/buildLiveBundle.ts`, import `LiveVenueOption` and session helpers:

```ts
import type { LiveVenueOption } from '../state/liveVenue';
import {
  venueSessionOpenMs,
  venueSessionCloseMs,
  regularSessionOpenMs,
  regularSessionCloseMs,
} from './liveDateTime';
```

Add optional prop:

```ts
  venue?: LiveVenueOption;
```

Inside `buildChartBundle`, set:

```ts
  const venue = args.venue ?? 'KRX';
```

Replace synthesized segment defaults:

```ts
      session_open_ms: venueSessionOpenMs(d, venue),
      session_close_ms: venueSessionCloseMs(d, venue),
```

- [ ] **Step 5: Pass venue from `useLiveBundle`**

In `frontend/src/live/useLiveBundle.ts`, replace `todaySession` fallback:

```ts
        : { open_ms: venueSessionOpenMs(todayKstYyyymmdd, liveVenue), close_ms: venueSessionCloseMs(todayKstYyyymmdd, liveVenue) },
```

For `live.initial`, use venue bounds when selected venue is not KRX because `/api/live/series` still reports KRX session:

```ts
        ? liveVenue === 'KRX'
          ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? venueSessionCloseMs(todayKstYyyymmdd, liveVenue) }
          : { open_ms: venueSessionOpenMs(todayKstYyyymmdd, liveVenue), close_ms: venueSessionCloseMs(todayKstYyyymmdd, liveVenue) }
```

Pass venue to `buildChartBundle`:

```ts
      venue: liveVenue,
```

- [ ] **Step 6: Write build bundle session test**

Append to `frontend/src/live/buildLiveBundle.test.ts`:

```ts
it('synthesizes extended session segments for NXT candles', () => {
  const date = '20260612';
  const open = regularSessionOpenMs(date) - 60 * 60_000;
  const close = regularSessionOpenMs(date) + 11 * 60 * 60_000;
  const bundle = buildChartBundle({
    code: '005930',
    todayDate: date,
    todaySession: { open_ms: open, close_ms: close },
    pastBundle: null,
    kisCandles: [{ ts_ms: open, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
    bucketMs: 60_000,
    hasTodayObSignal: false,
    investorPoints: [],
    venue: 'NXT',
  });

  expect(bundle!.segments[0].session_open_ms).toBe(open);
  expect(bundle!.segments[0].session_close_ms).toBe(close);
});
```

- [ ] **Step 7: Run session and bundle tests**

Run: `cd frontend && npm test -- src/live/liveDateTime.test.ts src/live/buildLiveBundle.test.ts src/live/useLiveBundle.test.tsx --run`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/live/liveDateTime.ts frontend/src/live/liveDateTime.test.ts frontend/src/live/buildLiveBundle.ts frontend/src/live/buildLiveBundle.test.ts frontend/src/live/useLiveBundle.ts frontend/src/live/useLiveBundle.test.tsx
git commit -m "feat(live): use venue-specific chart session windows"
```

---

### Task 7: AUTO Minute Candle Merge Policy

**Files:**
- Modify: `hoga/live/kis_venue.py`
- Modify: `hoga/live/api.py:886-1021`
- Test: `tests/unit/live/test_kis_venue.py`
- Test: `tests/unit/live/test_api.py`

**Interfaces:**
- Produces: `auto_minute_venue_for_hhmmss(hhmmss: str) -> KisVenue`
- Produces: `merge_auto_minute_bars(krx: list[dict], nxt: list[dict]) -> list[dict]`
- `AUTO` route behavior:
  - NXT bars before `09:00:00`
  - KRX bars from `09:00:00` through `15:30:00`
  - NXT bars after `15:30:00`
  - duplicate `t_ms` resolved by KRX in regular session and NXT outside it

- [ ] **Step 1: Write failing AUTO helper tests**

Append to `tests/unit/live/test_kis_venue.py`:

```python
from hoga.live.kis_venue import auto_minute_venue_for_hhmmss


def test_auto_minute_venue_for_hhmmss() -> None:
    assert auto_minute_venue_for_hhmmss("075959") == "NXT"
    assert auto_minute_venue_for_hhmmss("080000") == "NXT"
    assert auto_minute_venue_for_hhmmss("085959") == "NXT"
    assert auto_minute_venue_for_hhmmss("090000") == "KRX"
    assert auto_minute_venue_for_hhmmss("152000") == "KRX"
    assert auto_minute_venue_for_hhmmss("153000") == "KRX"
    assert auto_minute_venue_for_hhmmss("153001") == "NXT"
    assert auto_minute_venue_for_hhmmss("200000") == "NXT"
```

- [ ] **Step 2: Run AUTO helper test to verify it fails**

Run: `uv run pytest tests/unit/live/test_kis_venue.py -v -k "auto_minute"`

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement AUTO helper**

In `hoga/live/kis_venue.py`, add:

```python
def auto_minute_venue_for_hhmmss(hhmmss: str) -> KisVenue:
    if "090000" <= hhmmss <= "153000":
        return "KRX"
    return "NXT"
```

- [ ] **Step 4: Add merge helper in route module**

In `hoga/live/api.py`, import:

```python
from datetime import datetime
from hoga.live.kis_venue import auto_minute_venue_for_hhmmss
```

Add near `_candle_to_dict` helpers:

```python
def _hhmmss_from_t_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST).strftime("%H%M%S")


def _merge_auto_minute_bars(krx: list[dict], nxt: list[dict]) -> list[dict]:
    by_t: dict[int, dict] = {}
    for bar in nxt:
        t_ms = bar.get("t_ms")
        if isinstance(t_ms, int) and auto_minute_venue_for_hhmmss(_hhmmss_from_t_ms(t_ms)) == "NXT":
            by_t[t_ms] = bar
    for bar in krx:
        t_ms = bar.get("t_ms")
        if isinstance(t_ms, int) and auto_minute_venue_for_hhmmss(_hhmmss_from_t_ms(t_ms)) == "KRX":
            by_t[t_ms] = bar
    return [by_t[t] for t in sorted(by_t)]
```

- [ ] **Step 5: Write failing AUTO route merge test**

Append to `tests/unit/live/test_api.py`:

```python
async def test_past_candles_auto_merges_krx_regular_and_nxt_extended(tmp_path) -> None:
    seen = []

    def ts(date: str, hh: int, mm: int) -> int:
        return int(datetime(int(date[:4]), int(date[4:6]), int(date[6:8]), hh, mm, tzinfo=KIS_KST).timestamp() * 1000)

    class FakeKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            seen.append(kw["venue"])
            if kw["venue"] == "KRX":
                return [
                    KisCandle(t_ms=ts(date_yyyymmdd, 9, 0), open=100, high=100, low=100, close=100, volume=10),
                    KisCandle(t_ms=ts(date_yyyymmdd, 15, 30), open=150, high=150, low=150, close=150, volume=20),
                ]
            if kw["venue"] == "NXT":
                return [
                    KisCandle(t_ms=ts(date_yyyymmdd, 8, 0), open=80, high=80, low=80, close=80, volume=1),
                    KisCandle(t_ms=ts(date_yyyymmdd, 9, 0), open=999, high=999, low=999, close=999, volume=999),
                    KisCandle(t_ms=ts(date_yyyymmdd, 15, 31), open=151, high=151, low=151, close=151, volume=2),
                ]
            raise AssertionError(kw)

    app = _past_app(tmp_path, FakeKis())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260612&to=20260612&venue=AUTO")

    assert r.status_code == 200
    body = r.json()
    assert seen == ["KRX", "NXT"]
    assert [c["close"] for c in body["candles"]] == [80, 100, 150, 151]
    assert body["venue"] == "AUTO"
```

- [ ] **Step 6: Run AUTO route test to verify it fails**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "auto_merges_krx_regular"`

Expected: FAIL because `AUTO` route still returns 422.

- [ ] **Step 7: Implement AUTO minute route branch**

In `_get_past_candles`, replace the `AUTO` 422 branch with:

```python
        auto_mode = policy == "AUTO"
        kis_venue: KisVenue = "KRX" if not auto_mode else "UN"
```

Then handle explicit modes through existing path and add a separate fetch inside `_one`:

```python
                try:
                    if auto_mode:
                        krx_bars, krx_write_err = await _fetch_past_shared(kis, "KRX", code, date_s)
                        nxt_bars, nxt_write_err = await _fetch_past_shared(kis, "NXT", code, date_s)
                        bars = _merge_auto_minute_bars(krx_bars, nxt_bars)
                        write_err = krx_write_err or nxt_write_err
                    else:
                        bars, write_err = await _fetch_past_shared(kis, kis_venue, code, date_s)
```

For cache reads in AUTO mode:

```python
            if auto_mode:
                krx_cached = cache.get_past("KRX", code, date_s)
                nxt_cached = cache.get_past("NXT", code, date_s)
                bars = (
                    _merge_auto_minute_bars(krx_cached, nxt_cached)
                    if krx_cached is not None and nxt_cached is not None
                    else None
                )
            else:
                bars = cache.get_past(kis_venue, code, date_s)
```

For today in AUTO mode, bypass combined today cache and fetch both venues when miss:

```python
                    if auto_mode:
                        krx_raw = await kis.fetch_past_minute_candles(code, date_s, venue="KRX", foreground=True)
                        nxt_raw = await kis.fetch_past_minute_candles(code, date_s, venue="NXT", foreground=True)
                        krx_bars = [_candle_to_dict(c) for c in krx_raw]
                        nxt_bars = [_candle_to_dict(c) for c in nxt_raw]
                        bars = _merge_auto_minute_bars(krx_bars, nxt_bars)
                        cache.store_today("KRX", code, krx_bars or None)
                        cache.store_today("NXT", code, nxt_bars or None)
```

Keep explicit mode behavior unchanged.

- [ ] **Step 8: Run AUTO tests**

Run: `uv run pytest tests/unit/live/test_kis_venue.py tests/unit/live/test_api.py -v -k "auto or past_candles"`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add hoga/live/kis_venue.py hoga/live/api.py tests/unit/live/test_kis_venue.py tests/unit/live/test_api.py
git commit -m "feat(live): merge AUTO KRX/NXT minute candles"
```

---

### Task 8: AUTO Daily Policy And User-Facing Warning Boundary

**Files:**
- Modify: `hoga/live/api.py:1023-1048`
- Modify: `frontend/src/live/liveDataWarnings.ts`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Test: `tests/unit/live/test_api.py`
- Test: `frontend/src/live/LiveChartRoot.test.tsx`

**Interfaces:**
- `AUTO` daily route returns integrated `UN` daily bars, because daily bars have no intraday time ranges to split into KRX/NXT.
- Produces warning reason: `auto_daily_uses_integrated`

- [ ] **Step 1: Write failing daily AUTO route test**

Append to `tests/unit/live/test_api.py`:

```python
async def test_past_daily_candles_auto_uses_integrated_venue_with_warning(tmp_path) -> None:
    seen = []

    class FakeKis:
        async def fetch_past_daily_candles(self, code, from_yyyymmdd, to_yyyymmdd, **kw):
            seen.append(kw["venue"])
            return DailyCandleFetchResult(
                candles=[
                    KisCandle(t_ms=1_779_062_400_000, open=1, high=2, low=1, close=2, volume=300)
                ],
                violations=[],
            )

    app = _past_app(tmp_path, FakeKis())
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20260612&to=20260612&venue=AUTO")

    assert r.status_code == 200
    body = r.json()
    assert seen == ["UN"]
    assert body["venue"] == "AUTO"
    assert body["candles"][0]["volume"] == 300
    assert any(w["reason"] == "auto_daily_uses_integrated" for w in body["data_warnings"])
```

- [ ] **Step 2: Run daily AUTO test to verify it fails**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "daily_candles_auto_uses_integrated"`

Expected: FAIL because daily AUTO still returns 422.

- [ ] **Step 3: Implement daily AUTO as integrated daily bars**

In `_get_past_daily_candles`, replace AUTO 422 with:

```python
        auto_mode = policy == "AUTO"
        kis_venue: KisVenue = "UN" if auto_mode else policy
```

After `batched_daily_walkback`:

```python
        out["venue"] = policy
        if auto_mode:
            out.setdefault("data_warnings", []).append({
                "batch": f"{from_}__{to}",
                "reason": "auto_daily_uses_integrated",
                "msg": "AUTO daily candles use KIS integrated venue because daily bars cannot be split by intraday KRX/NXT session",
            })
        return out
```

- [ ] **Step 4: Update frontend warning type**

In `frontend/src/api/livePastDailyCandles.ts`, extend warning reason:

```ts
  reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation' | 'auto_daily_uses_integrated';
```

In `frontend/src/live/liveDataWarnings.ts`, add label handling:

```ts
  auto_daily_uses_integrated: '자동 일봉은 통합 기준',
```

- [ ] **Step 5: Run backend and frontend warning tests**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "daily_candles_auto_uses_integrated"`

Expected: PASS.

Run: `cd frontend && npm test -- src/live/LiveChartRoot.test.tsx --run`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py frontend/src/api/livePastDailyCandles.ts frontend/src/live/liveDataWarnings.ts frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx
git commit -m "feat(live): support AUTO daily candle policy"
```

---

### Task 9: End-To-End Verification And Documentation

**Files:**
- Create: `docs/adr/0078-live-kis-venue-routing.md`
- Modify: `docs/superpowers/plans/2026-06-18-live-kis-venue-routing.md`
- Test: backend and frontend command suite.

**Interfaces:**
- Documents accepted behavior:
  - KRX/NXT/UN explicit candle modes
  - AUTO minute merge
  - AUTO daily integrated fallback
  - WS/hoga pane limitation

- [ ] **Step 1: Create ADR**

Create `docs/adr/0078-live-kis-venue-routing.md`:

```markdown
# 0078 — Live KIS Candle Venue Routing

**Status:** accepted (2026-06-18)

## Decision

`/live` exposes a KIS candle venue setting with four options:

- `KRX`: KIS `FID_COND_MRKT_DIV_CODE=J`, 09:00~15:30 KST chart session.
- `NXT`: KIS `FID_COND_MRKT_DIV_CODE=NX`, 08:00~20:00 KST chart session.
- `통합`: KIS `FID_COND_MRKT_DIV_CODE=UN`, 08:00~20:00 KST chart session.
- `자동`: minute candles merge KRX during 09:00~15:30 and NXT outside that window. Daily candles use KIS integrated (`UN`) bars because a daily bar cannot be split by intraday venue.

The setting applies to KIS candle OHLCV backfill only. Existing hoga panes,
orderbook snapshots, quote ratio, fill strength, and broker panes remain bound
to the existing live WS/Parquet path until a future NXT WS plan adds venue-aware
live subscriptions.

## Why

KIS supports venue selection directly on the candle endpoints. Threading the
venue through route, cache, and query keys lets users inspect KRX-only, NXT-only,
and integrated OHLCV without corrupting existing KRX cache entries.

AUTO is useful for a trader-oriented view that uses the KRX regular session as
the authoritative main-session source while still showing NXT extended-hours
price and volume before and after KRX.

## Consequences

- Candle cache cardinality increases by venue.
- Venue switches remount the chart to avoid stale viewport and axis state.
- `/replay` remains unchanged.
- NXT WS support remains a separate future decision.
```

- [ ] **Step 2: Run backend focused tests**

Run:

```bash
uv run pytest \
  tests/unit/live/test_kis_venue.py \
  tests/unit/live/test_kis_rest_methods.py \
  tests/unit/live/test_past_candles_cache.py \
  tests/unit/live/test_past_daily_candles_cache.py \
  tests/unit/live/test_api.py \
  -v
```

Expected: PASS.

- [ ] **Step 3: Run frontend focused tests**

Run:

```bash
cd frontend && npm test -- \
  src/state/liveVenue.test.ts \
  src/live/LiveSettingsSections.test.tsx \
  src/api/livePastCandles.test.tsx \
  src/api/livePastDailyCandles.test.tsx \
  src/live/liveDateTime.test.ts \
  src/live/buildLiveBundle.test.ts \
  src/live/useLiveBundle.test.tsx \
  src/live/LiveStatusBar.test.tsx \
  --run
```

Expected: PASS.

- [ ] **Step 4: Run type checks**

Run:

```bash
uv run pyright
cd frontend && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Manual QA**

Start the app using the repository's normal dev commands. In `/live`:

1. Open settings.
2. Go to `데이터소스`.
3. Select `KRX`.
4. Confirm network calls include `venue=KRX`.
5. Select `NXT`.
6. Confirm network calls include `venue=NXT` and chart reloads.
7. Select `통합`.
8. Confirm network calls include `venue=UN` and chart reloads.
9. Select `자동`.
10. Confirm minute timeframe calls `venue=AUTO`, chart reloads, and status bar shows `자동`.
11. Switch to `D`; confirm daily calls `venue=AUTO` and the warning banner does not block rendering.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/0078-live-kis-venue-routing.md docs/superpowers/plans/2026-06-18-live-kis-venue-routing.md
git commit -m "docs(adr): live KIS venue routing"
```

---

## Self-Review

**Spec coverage:** Covered KRX, NXT, integrated, and automatic policies. Covered candle OHLCV and volume by threading venue through KIS candle endpoints and preserving `volume` mapping. Covered time expansion by adding venue-specific session windows. Covered automatic regular/extended policy for minute bars and documented daily fallback. Covered cache/query key separation.

**Placeholder scan:** No steps use TBD, TODO, "similar to", or undefined behavior. Each task includes exact files, concrete snippets, commands, and expected outcomes.

**Type consistency:** Backend uses `KisVenue` for concrete KIS calls and `LiveVenuePolicy` for route/UI policy. Frontend uses `LiveVenueOption` with the same option values as backend route policy. `AUTO` is never passed to `KisClient`; it is expanded in `hoga/live/api.py`.
