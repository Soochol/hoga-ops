---
scope: both
spec: docs/superpowers/specs/2026-05-28-live-kis-past-candles-design.md
adr: docs/adr/0040-live-candle-backfill-separate-cache.md
---

# Live Candle Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/live` 페이지의 candle 데이터 path를 KIS dailychartprice 기반 새 endpoint(`/api/live/past-candles`)로 통일하고, 기존 intraday `/api/live/candles` 경로를 같은 PR에서 제거한다.

**Architecture:** 새 endpoint는 일자별 KIS dailychartprice 호출 결과를 디스크(past 일자) + 메모리(today, 60s TTL) 하이브리드로 캐시한다. Frontend의 `useLiveBundle`은 두 query — `useLivePastCandles`(candles) + `useRange`(호가 지표) — 를 결합하며, 두 endpoint cap의 비대칭(60일 vs 90일)은 frontend 레벨에서 60일로 clamping한다.

**Tech Stack:** Backend = FastAPI + pytest + httpx mocks (기존 `KisClient` 패턴 재사용). Frontend = TanStack Query + Vitest + React Testing Library.

---

## File Structure

| Path | Purpose | Action |
|---|---|---|
| `hoga/live/past_candles_cache.py` | 디스크 + 메모리 하이브리드 캐시. atomic write 재사용. | Create |
| `hoga/live/api.py` | `/api/live/past-candles` route 추가, `/api/live/candles` route 제거. | Modify |
| `hoga/live/kis_client.py` | `fetch_candles` 메서드 제거 (`fetch_past_minute_candles`만 유지). | Modify |
| `tests/unit/live/test_past_candles_cache.py` | 캐시 모듈 unit tests. | Create |
| `tests/unit/live/test_api.py` | 기존 `/candles` tests 제거, `/past-candles` integration tests 추가. | Modify |
| `tests/unit/live/test_kis_rest_methods.py` | `fetch_candles` tests 제거 (`fetch_past_minute_candles` tests 유지). | Modify |
| `frontend/src/api/livePastCandles.ts` | `useLivePastCandles` TanStack Query hook. | Create |
| `frontend/src/api/livePastCandles.test.tsx` | hook tests. | Create |
| `frontend/src/api/liveCandles.ts` | 제거. | Delete |
| `frontend/src/api/liveCandles.test.tsx` | 제거. | Delete |
| `frontend/src/live/buildLiveBundle.ts` | input schema 변경: `todayCandles` → `kisCandles`. | Modify |
| `frontend/src/live/buildLiveBundle.test.ts` | input schema 변경 반영 + 5/26 시나리오 추가. | Modify |
| `frontend/src/live/useLiveBundle.ts` | `useLivePastCandles` 와이어링 + 60일 clamping + timeframe aggregation. | Modify |
| `frontend/src/live/useLiveBundle.test.tsx` | 새 와이어링 반영. | Modify |

---

## Task 1: Backend cache module — `past_candles_cache.py`

**Files:**
- Create: `hoga/live/past_candles_cache.py`
- Test: `tests/unit/live/test_past_candles_cache.py`

이 모듈은 두 책임을 단일 표면에 모은다: (a) past 일자의 KIS candle 결과를 영구 디스크 cache에 저장/조회, (b) today 일자의 60s TTL 메모리 cache. 디스크 경로는 `data_dir/kis-past-candles/<code>/<YYYYMMDD>.json` 형태로 captures와 같은 data_dir scope에 둔다 (configurable for tests via `tmp_path`).

- [ ] **Step 1.1: Write failing test for disk cache miss → store → hit cycle**

`tests/unit/live/test_past_candles_cache.py`:

```python
"""Tests for hoga.live.past_candles_cache."""
from __future__ import annotations

import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from hoga.live.past_candles_cache import (
    PastCandlesCache,
    CachedDayResult,
)


def _bars(t_ms_list: list[int]) -> list[dict]:
    return [
        {"t_ms": t, "open": 100, "high": 110, "low": 95, "close": 105, "volume": 10}
        for t in t_ms_list
    ]


def test_past_disk_miss_then_store_then_hit(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    res = cache.get_past("005930", "20260520")
    assert res is None
    cache.store_past("005930", "20260520", _bars([1, 2, 3]))
    res2 = cache.get_past("005930", "20260520")
    assert res2 is not None
    assert [b["t_ms"] for b in res2] == [1, 2, 3]
    # File exists on disk:
    p = tmp_path / "kis-past-candles" / "005930" / "20260520.json"
    assert p.exists()
    body = json.loads(p.read_text())
    assert "candles" in body
    assert body["candles"][0]["t_ms"] == 1
```

- [ ] **Step 1.2: Run test → expect failure**

```bash
uv run pytest tests/unit/live/test_past_candles_cache.py::test_past_disk_miss_then_store_then_hit -v
```

Expected: `ModuleNotFoundError: No module named 'hoga.live.past_candles_cache'`.

- [ ] **Step 1.3: Implement past-disk path**

Create `hoga/live/past_candles_cache.py`:

```python
"""Disk + memory hybrid cache for KIS dailychartprice candle results.

Backs the GET /api/live/past-candles endpoint. Past dates (date < today_kst)
are persisted under <data_dir>/kis-past-candles/<code>/<YYYYMMDD>.json with
atomic write semantics. Today's candles live only in memory with a 60s TTL.

Cache file format (versionable):
    {
        "candles": [{t_ms, open, high, low, close, volume}, ...],
        "fetched_at_ms": int,
        "kis_tr_id": "FHKST03010230",
    }

ADR-0040 — separate cache namespace from kis_live promoted Parquet.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import TYPE_CHECKING

from hoga.api._atomic_write import atomic_write_json

if TYPE_CHECKING:
    pass

# Default TTL for today's memory cache.
TODAY_TTL_SECONDS = 60.0

# Cache file metadata constant.
_KIS_TR_ID = "FHKST03010230"


class CachedDayResult:
    """Convenience type — a list of candle dicts."""


class PastCandlesCache:
    """Disk-backed past + memory-only today cache for KIS minute candles."""

    def __init__(self, data_dir: Path, *, today_ttl_seconds: float = TODAY_TTL_SECONDS):
        self._data_dir = data_dir
        self._today_ttl = today_ttl_seconds
        # In-memory hot cache for past dates (avoids re-reading disk).
        self._past_mem: dict[tuple[str, str], list[dict]] = {}
        # Today: (code) -> (fetched_at_monotonic, bars).
        self._today_mem: dict[str, tuple[float, list[dict]]] = {}

    # --- past ---

    def _past_path(self, code: str, date: str) -> Path:
        return self._data_dir / "kis-past-candles" / code / f"{date}.json"

    def get_past(self, code: str, date: str) -> list[dict] | None:
        key = (code, date)
        if key in self._past_mem:
            return self._past_mem[key]
        p = self._past_path(code, date)
        if not p.exists():
            return None
        try:
            body = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        bars = body.get("candles") or []
        self._past_mem[key] = bars
        return bars

    def store_past(self, code: str, date: str, bars: list[dict]) -> None:
        p = self._past_path(code, date)
        payload = {
            "candles": bars,
            "fetched_at_ms": int(time.time() * 1000),
            "kis_tr_id": _KIS_TR_ID,
        }
        atomic_write_json(p, payload)
        self._past_mem[(code, date)] = bars

    # --- today ---

    def get_today(self, code: str) -> list[dict] | None:
        entry = self._today_mem.get(code)
        if entry is None:
            return None
        fetched_at, bars = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return None
        return bars

    def store_today(self, code: str, bars: list[dict]) -> None:
        self._today_mem[code] = (time.monotonic(), bars)
```

- [ ] **Step 1.4: Run test → expect pass**

```bash
uv run pytest tests/unit/live/test_past_candles_cache.py::test_past_disk_miss_then_store_then_hit -v
```

Expected: PASS.

- [ ] **Step 1.5: Add today memory cache tests**

Append to `tests/unit/live/test_past_candles_cache.py`:

```python
def test_today_memory_miss_then_store_then_hit(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=60)
    assert cache.get_today("005930") is None
    cache.store_today("005930", _bars([100]))
    assert cache.get_today("005930") == _bars([100])


def test_today_memory_expires_after_ttl(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=0.01)
    cache.store_today("005930", _bars([1]))
    time.sleep(0.02)
    assert cache.get_today("005930") is None


def test_today_does_not_touch_disk(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_today("005930", _bars([1, 2]))
    # No file should be created for today storage.
    today_dir = tmp_path / "kis-past-candles" / "005930"
    assert not today_dir.exists() or not any(today_dir.iterdir())


def test_past_mem_side_cache_avoids_disk_reread(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("005930", "20260520", _bars([1]))
    # Delete the file under cache's feet; in-memory side cache should still serve.
    (tmp_path / "kis-past-candles" / "005930" / "20260520.json").unlink()
    assert cache.get_past("005930", "20260520") == _bars([1])
```

- [ ] **Step 1.6: Run all cache tests → expect pass**

```bash
uv run pytest tests/unit/live/test_past_candles_cache.py -v
```

Expected: 4 tests PASS.

- [ ] **Step 1.7: Commit**

```bash
git add hoga/live/past_candles_cache.py tests/unit/live/test_past_candles_cache.py
git commit -m "feat(live): PastCandlesCache disk + memory hybrid"
```

---

## Task 2: Backend endpoint — `/api/live/past-candles`

**Files:**
- Modify: `hoga/live/api.py` (add new route)
- Test: `tests/unit/live/test_api.py` (add integration tests)

이 endpoint는 spec §Backend spec의 validation + 일자 처리 루프 + partial failure 처리 + cap을 모두 한 곳에서 책임진다. 캐시 인스턴스는 lifecycle 모듈을 통해 주입되거나 module-level singleton으로 lazy-init한다.

- [ ] **Step 2.1: Write failing test for 422 on missing params**

Append to `tests/unit/live/test_api.py`:

```python
# ----- /api/live/past-candles -----

import datetime
from hoga.live.kis_models import KisCandle


def _today_kst_yyyymmdd() -> str:
    kst = datetime.timezone(datetime.timedelta(hours=9))
    return datetime.datetime.now(kst).strftime("%Y%m%d")


class _FakeKisForPast:
    """Stub KIS client returning deterministic minute bars per date."""

    def __init__(self):
        self.calls: list[str] = []  # records date arg per call

    async def fetch_past_minute_candles(self, code: str, date_yyyymmdd: str) -> list[KisCandle]:
        self.calls.append(date_yyyymmdd)
        return [KisCandle(t_ms=int(date_yyyymmdd) * 1000, open=100, high=110, low=95, close=105, volume=10)]


def _past_app(tmp_path, fake_kis):
    from hoga.api.app import create_app
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()
    lifecycle.set_kis_client(fake_kis)  # type: ignore[arg-type]
    return create_app(tmp_path)


def test_past_candles_rejects_missing_code(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?from=20260501&to=20260502")
        assert r.status_code == 422


def test_past_candles_rejects_invalid_code_format(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=abc&from=20260501&to=20260502")
        assert r.status_code == 422


def test_past_candles_rejects_from_after_to(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260510&to=20260501")
        assert r.status_code == 422


def test_past_candles_rejects_range_over_60_days(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        # 61 days
        r = c.get("/api/live/past-candles?code=005930&from=20260101&to=20260302")
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "date_range_too_large"


def test_past_candles_rejects_to_in_future(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get(f"/api/live/past-candles?code=005930&from=20260501&to=20990101")
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "date_in_future"
```

- [ ] **Step 2.2: Run validation tests → expect failure**

```bash
uv run pytest tests/unit/live/test_api.py::test_past_candles_rejects_missing_code -v
```

Expected: 404 / route not registered.

- [ ] **Step 2.3: Implement endpoint route**

Modify `hoga/live/api.py`. Add imports + helper + route. After existing `_CANDLES_CACHE` definition (and before `class ControlRequest`), insert helpers; inside `build_router` after `/candles` route, add new `/past-candles` route.

Top-of-file imports (add as needed):

```python
import re
from datetime import date as _date, datetime as _datetime, timedelta, timezone as _tz
from pathlib import Path
from hoga.live.kis_client import KisApiError, KisRateLimitError
from hoga.live.past_candles_cache import PastCandlesCache
```

Module-level (after `_CANDLES_TTL_SECONDS`):

```python
_PAST_CANDLES_CACHE: PastCandlesCache | None = None
_PAST_MAX_DAYS = 60
_CODE_RE = re.compile(r"^\d{6}$")
_KST = _tz(timedelta(hours=9))


def _today_kst_yyyymmdd_now() -> str:
    return _datetime.now(_KST).strftime("%Y%m%d")


def _parse_yyyymmdd(s: str) -> _date | None:
    try:
        return _datetime.strptime(s, "%Y%m%d").date()
    except ValueError:
        return None


def _date_iter(frm: _date, to: _date):
    cur = frm
    while cur <= to:
        yield cur.strftime("%Y%m%d")
        cur = cur + timedelta(days=1)


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms, "open": c.open, "high": c.high, "low": c.low,
        "close": c.close, "volume": c.volume,
    }


def get_past_candles_cache(data_dir: Path) -> PastCandlesCache:
    global _PAST_CANDLES_CACHE
    if _PAST_CANDLES_CACHE is None:
        _PAST_CANDLES_CACHE = PastCandlesCache(data_dir=data_dir)
    return _PAST_CANDLES_CACHE


def reset_past_candles_cache_for_tests() -> None:
    global _PAST_CANDLES_CACHE
    _PAST_CANDLES_CACHE = None
```

Update `build_router` signature to accept `data_dir: Path`:

```python
def build_router(
    get_status: Callable[[], LiveStatus],
    get_buffer: Callable[[], LiveBuffer] | None = None,
    on_control: Callable[[str], Awaitable[None]] | None = None,
    get_kis_client: "Callable[[], KisClient | None] | None" = None,
    *,
    data_dir: Path | None = None,
) -> APIRouter:
```

Inside `build_router`, after the existing `/candles` route (which Task 3 will delete), add:

```python
    @router.get("/past-candles")
    async def _get_past_candles(code: str, from_: str = "", to: str = "") -> dict:
        # FastAPI binds query param `from` to the function arg via alias.
        # We accept `from_` directly here for clarity; route alias defined via
        # Query(...). For minimal change, redefine using Query alias.
        raise NotImplementedError  # replaced below
```

Actually, FastAPI query params can be received as-is with `Query(alias='from')`. Use the explicit form:

```python
    from fastapi import Query

    @router.get("/past-candles")
    async def _get_past_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        if not _CODE_RE.match(code):
            raise HTTPException(422, {"code": "invalid_code", "msg": "code must be 6 digits"})
        frm = _parse_yyyymmdd(from_)
        too = _parse_yyyymmdd(to)
        if frm is None or too is None:
            raise HTTPException(422, {"code": "invalid_date", "msg": "from/to must be YYYYMMDD"})
        if frm > too:
            raise HTTPException(422, {"code": "from_after_to", "msg": "from must be <= to"})
        today_s = _today_kst_yyyymmdd_now()
        today_d = _parse_yyyymmdd(today_s)
        assert today_d is not None
        if too > today_d:
            raise HTTPException(422, {"code": "date_in_future", "msg": "to must be <= today_kst"})
        span_days = (too - frm).days + 1
        if span_days > _PAST_MAX_DAYS:
            raise HTTPException(
                422,
                {"code": "date_range_too_large", "msg": f"max {_PAST_MAX_DAYS} days", "max_days": _PAST_MAX_DAYS},
            )
        if get_kis_client is None:
            raise HTTPException(503, "KIS client not wired")
        kis = get_kis_client()
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if data_dir is None:
            raise HTTPException(503, "past-candles cache not wired (data_dir missing)")
        cache = get_past_candles_cache(data_dir)

        candles_all: list[dict] = []
        cached_dates: list[str] = []
        fresh_dates: list[str] = []
        warnings: list[dict] = []
        aborted = False

        for date_s in _date_iter(frm, too):
            if aborted:
                warnings.append({"date": date_s, "reason": "rate_limit_aborted", "msg": "previous date hit rate limit"})
                continue
            try:
                if date_s < today_s:
                    bars = cache.get_past(code, date_s)
                    if bars is None:
                        raw = await kis.fetch_past_minute_candles(code, date_s)
                        bars = [_candle_to_dict(c) for c in raw]
                        cache.store_past(code, date_s, bars)
                        fresh_dates.append(date_s)
                    else:
                        cached_dates.append(date_s)
                else:  # date_s == today_s
                    bars = cache.get_today(code)
                    if bars is None:
                        raw = await kis.fetch_past_minute_candles(code, date_s)
                        bars = [_candle_to_dict(c) for c in raw]
                        cache.store_today(code, bars)
                        fresh_dates.append(date_s)
                    else:
                        cached_dates.append(date_s)
                candles_all.extend(bars)
            except KisRateLimitError as e:
                warnings.append({"date": date_s, "reason": "kis_rate_limit", "msg": str(e)})
                aborted = True
            except KisApiError as e:
                warnings.append({"date": date_s, "reason": "kis_api_error", "msg": e.msg_cd})

        return {
            "code": code,
            "from": from_,
            "to": to,
            "candles": candles_all,
            "cached_dates": cached_dates,
            "fresh_dates": fresh_dates,
            "data_warnings": warnings,
        }
```

Update `hoga/api/app.py` to pass `data_dir` into `build_live_router(...)`:

```python
    app.include_router(
        build_live_router(
            get_status=live_get_status,
            get_buffer=live_get_buffer,
            on_control=_live_control,
            get_kis_client=live_get_kis_client,
            data_dir=data_dir,
        )
    )
```

- [ ] **Step 2.4: Run validation tests → expect pass**

```bash
uv run pytest tests/unit/live/test_api.py -k past_candles -v
```

Expected: 5 PASS (validation cases).

- [ ] **Step 2.5: Add happy-path + caching + partial-failure tests**

Append to `tests/unit/live/test_api.py`:

```python
@pytest.mark.asyncio
async def test_past_candles_happy_path_single_date(tmp_path) -> None:
    from hoga.live.api import reset_past_candles_cache_for_tests
    reset_past_candles_cache_for_tests()
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        # Use a past date (yesterday relative to KST)
        kst = datetime.timezone(datetime.timedelta(hours=9))
        yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["candles"] and body["candles"][0]["open"] == 100
        assert body["fresh_dates"] == [yesterday]
        assert body["cached_dates"] == []
        assert body["data_warnings"] == []
        # Disk file written under tmp_path
        assert (tmp_path / "kis-past-candles" / "005930" / f"{yesterday}.json").exists()


@pytest.mark.asyncio
async def test_past_candles_disk_cache_hit_on_second_call(tmp_path) -> None:
    from hoga.live.api import reset_past_candles_cache_for_tests
    reset_past_candles_cache_for_tests()
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        kst = datetime.timezone(datetime.timedelta(hours=9))
        yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")
        c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert fake.calls == [yesterday]
        # Second call — KIS should not be hit again
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200
        assert fake.calls == [yesterday]  # unchanged
        assert r.json()["cached_dates"] == [yesterday]
        assert r.json()["fresh_dates"] == []


@pytest.mark.asyncio
async def test_past_candles_today_memory_cache(tmp_path) -> None:
    from hoga.live.api import reset_past_candles_cache_for_tests
    reset_past_candles_cache_for_tests()
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        kst = datetime.timezone(datetime.timedelta(hours=9))
        today = datetime.datetime.now(kst).strftime("%Y%m%d")
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == [today]
        r = c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == [today]  # 60s TTL not yet expired
        assert r.json()["cached_dates"] == [today]
        # No disk file written for today
        assert not (tmp_path / "kis-past-candles" / "005930" / f"{today}.json").exists()


@pytest.mark.asyncio
async def test_past_candles_partial_failure_kis_api_error(tmp_path) -> None:
    from hoga.live.api import reset_past_candles_cache_for_tests
    from hoga.live.kis_client import KisApiError
    reset_past_candles_cache_for_tests()

    class _PartialFakeKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            if date_yyyymmdd == "20260502":
                raise KisApiError(msg_cd="HTTP_500", msg1="server error")
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    app = _past_app(tmp_path, _PartialFakeKis())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260503")
        assert r.status_code == 200
        body = r.json()
        warnings = body["data_warnings"]
        assert len(warnings) == 1
        assert warnings[0]["date"] == "20260502"
        assert warnings[0]["reason"] == "kis_api_error"
        # Two successful dates' bars in candles_all
        assert len(body["candles"]) == 2


@pytest.mark.asyncio
async def test_past_candles_rate_limit_aborts_remaining(tmp_path) -> None:
    from hoga.live.api import reset_past_candles_cache_for_tests
    from hoga.live.kis_client import KisRateLimitError
    reset_past_candles_cache_for_tests()

    class _RateLimitedFakeKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            self.calls.append(date_yyyymmdd)
            if date_yyyymmdd == "20260502":
                raise KisRateLimitError("EGW00201 rate limited")
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    fake = _RateLimitedFakeKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260503")
        assert r.status_code == 200
        body = r.json()
        # 20260502 fires rate limit, 20260503 must be skipped
        assert fake.calls == ["20260501", "20260502"]
        reasons = [w["reason"] for w in body["data_warnings"]]
        assert "kis_rate_limit" in reasons
        assert "rate_limit_aborted" in reasons
```

- [ ] **Step 2.6: Run full past-candles tests → expect pass**

```bash
uv run pytest tests/unit/live/test_api.py -k past_candles -v
```

Expected: 10 PASS.

- [ ] **Step 2.7: Commit**

```bash
git add hoga/live/api.py hoga/api/app.py tests/unit/live/test_api.py
git commit -m "feat(live): GET /api/live/past-candles endpoint (KIS dailychartprice)"
```

---

## Task 3: Backend — remove `/api/live/candles` and `KisClient.fetch_candles`

**Files:**
- Modify: `hoga/live/api.py` (delete `_get_candles` route + `_CANDLES_CACHE` + `_CANDLES_TTL_SECONDS`)
- Modify: `hoga/live/kis_client.py` (delete `fetch_candles` method)
- Modify: `tests/unit/live/test_api.py` (delete `test_get_live_candles_*` tests)
- Modify: `tests/unit/live/test_kis_rest_methods.py` (delete `test_fetch_candles_*` tests, keep `test_fetch_past_minute_candles_*`)

- [ ] **Step 3.1: Delete `/api/live/candles` route and helpers**

In `hoga/live/api.py`, delete:

```python
# DELETE these top-level constants:
_CANDLES_CACHE: dict[tuple[str, str], tuple[float, list[dict]]] = {}
_CANDLES_TTL_SECONDS = 60.0
```

Delete the entire `/candles` route function inside `build_router`:

```python
    # DELETE this block:
    @router.get("/candles")
    async def _get_candles(code: str, timeframe: str = "1m") -> dict:
        ...
```

- [ ] **Step 3.2: Delete `fetch_candles` in `KisClient`**

In `hoga/live/kis_client.py`, find and delete the entire `async def fetch_candles(...)` method (around line 156-205 per the test fixture, exact line range will vary — search for `# Task 2.4: fetch_candles` comment block).

```bash
grep -n "# Task 2.4: fetch_candles\|async def fetch_candles\|# fetch_past_minute_candles" hoga/live/kis_client.py
```

Delete the block from the `# Task 2.4: fetch_candles` comment through the end of `fetch_candles` method (just before `# fetch_past_minute_candles` block).

- [ ] **Step 3.3: Delete intraday endpoint tests**

In `tests/unit/live/test_api.py`, delete these three tests:

```python
# DELETE:
def test_get_live_candles_503_when_kis_not_set(tmp_path) -> None: ...
async def test_get_live_candles_returns_kis_response(tmp_path) -> None: ...
def test_get_live_candles_invalid_timeframe(tmp_path) -> None: ...
```

- [ ] **Step 3.4: Delete `fetch_candles` REST method tests**

In `tests/unit/live/test_kis_rest_methods.py`, delete the `# Task 2.4: fetch_candles` block and `test_fetch_candles_parses_real_fixture` test. Keep `test_fetch_past_minute_candles_*` tests intact.

- [ ] **Step 3.5: Run full backend suite to confirm no regressions**

```bash
uv run pytest tests/unit/live tests/test_api*.py -q
```

Expected: all pass; deleted tests no longer reported.

- [ ] **Step 3.6: Commit**

```bash
git add hoga/live/api.py hoga/live/kis_client.py tests/unit/live/test_api.py tests/unit/live/test_kis_rest_methods.py
git commit -m "refactor(live): remove /api/live/candles intraday endpoint + fetch_candles"
```

---

## Task 4: Frontend hook — `useLivePastCandles`

**Files:**
- Create: `frontend/src/api/livePastCandles.ts`
- Create: `frontend/src/api/livePastCandles.test.tsx`

- [ ] **Step 4.1: Write failing tests for the hook**

`frontend/src/api/livePastCandles.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLivePastCandles, type LivePastCandlesResponse } from './livePastCandles';
import * as client from './client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const RESPONSE: LivePastCandlesResponse = {
  code: '005930',
  from: '20260501',
  to: '20260502',
  candles: [
    { t_ms: 1, open: 100, high: 110, low: 95, close: 105, volume: 10 },
  ],
  cached_dates: [],
  fresh_dates: ['20260501', '20260502'],
  data_warnings: [],
};

describe('useLivePastCandles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches candles for given code+from+to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastCandles('005930', '20260501', '20260502'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith('/api/live/past-candles?code=005930&from=20260501&to=20260502');
  });

  it('does not fetch when code is null', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles(null, '20260501', '20260502'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fetch when from > to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles('005930', '20260510', '20260501'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('queryKey changes split cache entries', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(
      ({ to }: { to: string }) => useLivePastCandles('005930', '20260501', to),
      { wrapper: wrap(qc), initialProps: { to: '20260502' } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ to: '20260503' });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 4.2: Run hook tests → expect failure (module missing)**

```bash
cd frontend && npx vitest run src/api/livePastCandles.test.tsx
```

Expected: `Cannot find module './livePastCandles'`.

- [ ] **Step 4.3: Create the hook**

`frontend/src/api/livePastCandles.ts`:

```ts
import { useQuery, keepPreviousData } from '@tanstack/react-query';

import { apiCall } from './client';

export interface LivePastCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LivePastCandlesWarning {
  date: string;
  reason: string;
  msg: string;
}

export interface LivePastCandlesResponse {
  code: string;
  from: string;
  to: string;
  candles: LivePastCandle[];
  cached_dates: string[];
  fresh_dates: string[];
  data_warnings: LivePastCandlesWarning[];
}

export function useLivePastCandles(
  code: string | null,
  from: string | null,
  to: string | null,
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-candles', code, from, to] as const,
    queryFn: () =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${from}&to=${to}`,
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}
```

- [ ] **Step 4.4: Run hook tests → expect pass**

```bash
cd frontend && npx vitest run src/api/livePastCandles.test.tsx
```

Expected: 4 PASS.

- [ ] **Step 4.5: Commit**

```bash
git add frontend/src/api/livePastCandles.ts frontend/src/api/livePastCandles.test.tsx
git commit -m "feat(live): useLivePastCandles TanStack Query hook"
```

---

## Task 5: Frontend — refactor `buildLiveBundle.ts`

**Files:**
- Modify: `frontend/src/live/buildLiveBundle.ts`
- Modify: `frontend/src/live/buildLiveBundle.test.ts`

새 input schema: `todayCandles` 제거 → `kisCandles: Candle[]` (이미 wire `Candle` 형식으로 변환된 KIS past+today). `pastBundle.candles`는 *사용 안 함* (지표 + segments만 통과). 5/26 시나리오는 `excluded_dates`가 있어도 KIS candle은 그대로 통과하는 것을 명시 테스트.

- [ ] **Step 5.1: Update existing tests to new schema (will fail)**

Replace `frontend/src/live/buildLiveBundle.test.ts` "empty inputs" + "today-only" tests' input fields:

```ts
// In each call to buildLiveBundle({...}):
// REMOVE: `todayCandles: [...]`
// ADD:    `kisCandles: [...]`  (already wire-shaped Candle[])
```

Also update the assertion in the "past bundle includes today" test — since the new behavior IGNORES `pastBundle.candles`, the test should assert that `bundle.candles` reflects `kisCandles`, not `pastBundle.candles`.

Concrete: open `frontend/src/live/buildLiveBundle.test.ts` and apply these edits:

```ts
// Test "empty inputs → empty bundle"
buildLiveBundle({
  code: '005930',
  todayDate: TODAY,
  todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
  pastBundle: null,
  sseOb: [],
  sseTrade: [],
  kisCandles: [],         // was: todayCandles: []
  bucketMs: 60_000,
});

// Test "today-only: SSE + candles..."
buildLiveBundle({
  code: '005930',
  todayDate: TODAY,
  todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
  pastBundle: null,
  sseOb: [...],
  sseTrade: [...],
  kisCandles: [           // was: todayCandles
    { ts_ms: TODAY_OPEN, open: 70000, close: 70050, high: 70100, low: 69900, vol_a: 1000, vol_b: 0 },
  ],
  bucketMs: 60_000,
});
// And the assertion still expects bundle.candles to equal kisCandles ts_ms shape.

// Test "past bundle includes today → SSE buffer is ignored" — REPLACE with two tests:
//   (a) past bundle .candles is IGNORED; kisCandles is the single source.
//   (b) past bundle .excluded_dates / .data_warnings pass through.
```

Add new tests at the bottom of the describe block:

```ts
  it('pastBundle.candles is ignored; kisCandles is the candle source', () => {
    const past = emptyRangeBundle({
      candles: [
        { ts_ms: TODAY_OPEN - 86400_000, open: 1, close: 2, high: 3, low: 0, vol_a: 99, vol_b: 0 },
      ],
    });
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [],
      sseTrade: [],
      kisCandles: [
        { ts_ms: TODAY_OPEN, open: 100, close: 100, high: 100, low: 100, vol_a: 5, vol_b: 0 },
      ],
      bucketMs: 60_000,
    });
    expect(bundle.candles).toEqual([
      { ts_ms: TODAY_OPEN, open: 100, close: 100, high: 100, low: 100, vol_a: 5, vol_b: 0 },
    ]);
  });

  it('5/26-style: pastBundle.excluded_dates passes through alongside KIS candles', () => {
    const past = emptyRangeBundle({
      excluded_dates: [{ date: '20260526', reason: 'meta.close_after_open', severity: 'error', message: '...' }],
    });
    const kis = [
      { ts_ms: Date.UTC(2026, 4, 26, 0, 0, 0), open: 70000, close: 70050, high: 70100, low: 69900, vol_a: 10, vol_b: 0 },
    ];
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [],
      sseTrade: [],
      kisCandles: kis,
      bucketMs: 60_000,
    });
    expect(bundle.excluded_dates).toEqual(past.excluded_dates);
    expect(bundle.candles).toEqual(kis);
  });
```

Note: `RangeBundle.excluded_dates` field type — confirm shape (string[] vs object[]) before running. If string[], adjust the test to `['20260526']`.

```bash
grep -n "excluded_dates" frontend/src/api/types.ts
```

If `excluded_dates: string[]`, update the test:
```ts
excluded_dates: ['20260526'],
```
and the assertion accordingly.

- [ ] **Step 5.2: Run buildLiveBundle tests → expect failure (schema mismatch)**

```bash
cd frontend && npx vitest run src/live/buildLiveBundle.test.ts
```

Expected: TypeScript / runtime errors about `todayCandles` vs `kisCandles`.

- [ ] **Step 5.3: Refactor `buildLiveBundle.ts`**

Replace the contents of `frontend/src/live/buildLiveBundle.ts`:

```ts
import type { RangeBundle, RangeSegment, Candle, VolumeProfile } from '../api/types';
import {
  bucketHogaSeries,
  type ObSnapshot,
  type TradeSnapshot,
} from './bucketHogaSeries';

/** /live never mounts VolumeProfileOverlay; the bundle ships an empty profile
 * that satisfies the RangeBundle type without claiming any data. */
const EMPTY_VOLUME_PROFILE: VolumeProfile = {
  bin_count: 0,
  price_min: 0,
  price_max: 0,
  bin_width: 0,
  bins: [],
};

export interface BuildLiveBundleInput {
  code: string;
  todayDate: string;
  todaySession: { open_ms: number; close_ms: number };
  /** Past stock-dates fetched via /api/range. Used for hoga indicators
   * (quote_ratio, fill_strength), segments, and excluded_dates only —
   * `pastBundle.candles` is intentionally ignored. */
  pastBundle: RangeBundle | null;
  sseOb: ObSnapshot[];
  sseTrade: TradeSnapshot[];
  /** Candles from /api/live/past-candles (KIS dailychartprice), already
   * client-side aggregated to the display timeframe and converted to wire
   * Candle shape. Single source of truth for the bundle's candle array
   * (ADR-0040 — Live Candle Backfill). */
  kisCandles: Candle[];
  bucketMs: number;
}

export function buildLiveBundle(input: BuildLiveBundleInput): RangeBundle {
  const {
    code,
    todayDate,
    todaySession,
    pastBundle,
    sseOb,
    sseTrade,
    kisCandles,
    bucketMs,
  } = input;

  const pastSegments = pastBundle?.segments ?? [];
  const pastHasToday = pastSegments.some((s) => s.date === todayDate);

  // Today hoga indicators from SSE buffer. When promoted past covers today
  // we skip the SSE bucket to avoid double-counting.
  const todayBuckets = pastHasToday
    ? { quoteRatioPoints: [], fillStrengthPoints: [] }
    : bucketHogaSeries(sseOb, sseTrade, bucketMs);

  // Today segment marker — present if we have any signal for today.
  const todaySegments: RangeSegment[] = [];
  if (!pastHasToday) {
    const hasToday =
      sseOb.length > 0 ||
      sseTrade.length > 0 ||
      kisCandles.some((c) => c.ts_ms >= todaySession.open_ms);
    if (hasToday) {
      todaySegments.push({
        date: todayDate,
        session_open_ms: todaySession.open_ms,
        session_close_ms: todaySession.close_ms,
        source: 'kis_live',
      });
    }
  }

  const pastFromDate = pastBundle?.from_date ?? todayDate;
  const segments = [...pastSegments, ...todaySegments];

  return {
    code,
    from_date: pastFromDate,
    to_date: todayDate,
    bucket_ms: bucketMs,
    segments,
    candles: kisCandles,
    quote_ratio: {
      bucket_ms: bucketMs,
      points: [...(pastBundle?.quote_ratio.points ?? []), ...todayBuckets.quoteRatioPoints],
    },
    fill_strength: {
      bucket_ms: bucketMs,
      points: [...(pastBundle?.fill_strength.points ?? []), ...todayBuckets.fillStrengthPoints],
    },
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    excluded_dates: pastBundle?.excluded_dates,
    data_warnings: pastBundle?.data_warnings,
  };
}
```

- [ ] **Step 5.4: Run tests → expect pass**

```bash
cd frontend && npx vitest run src/live/buildLiveBundle.test.ts
```

Expected: all PASS.

- [ ] **Step 5.5: Commit**

```bash
git add frontend/src/live/buildLiveBundle.ts frontend/src/live/buildLiveBundle.test.ts
git commit -m "refactor(live): buildLiveBundle uses kisCandles as single candle source"
```

---

## Task 6: Frontend — refactor `useLiveBundle.ts`

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`

Wires `useLivePastCandles`, applies 60-day clamping at the bundle level (so the two backend caps stay independent), converts KIS bars to wire `Candle` shape (`vol_a = volume, vol_b = 0`), and aggregates 1m bars into the display timeframe.

- [ ] **Step 6.1: Update existing test mocks to add `useLivePastCandles`**

In `frontend/src/live/useLiveBundle.test.tsx`, find the `vi.mock(...)` block for `../api/liveCandles` and replace with a `vi.mock('../api/livePastCandles', ...)`.

```bash
grep -n "useLiveCandles\|liveCandles" frontend/src/live/useLiveBundle.test.tsx
```

Replace:

```ts
// REMOVE
vi.mock('../api/liveCandles', () => ({
  useLiveCandles: vi.fn(() => ({ candles: [], data: undefined, isLoading: false, error: null })),
}));

// REPLACE WITH
vi.mock('../api/livePastCandles', () => ({
  useLivePastCandles: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
}));
```

- [ ] **Step 6.2: Add a new test asserting 60-day clamping behavior**

Append to `frontend/src/live/useLiveBundle.test.tsx`:

```tsx
import { useLivePastCandles } from '../api/livePastCandles';
import { useRange } from '../api/range';

it('clamps pastFrom to 60 days before today', () => {
  // (Setup as existing tests — render useLiveBundle with a code, 1m timeframe,
  // and historicalFromDate set to 90 days ago.)
  const today = '20260527';
  const ninetyDaysAgo = '20260227';
  const sixtyDaysAgo = '20260328';
  // Mock useLivePageStore so historicalFromDate = 90 days ago.
  // (Use the existing useLivePageStore mock pattern from this file's other tests.)

  // Render useLiveBundle(code='005930', timeframe='1m', today=today)
  // and assert:
  expect(useLivePastCandles).toHaveBeenCalledWith('005930', sixtyDaysAgo, today);
  expect(useRange).toHaveBeenCalledWith('005930', sixtyDaysAgo, '20260526', '1m');
});
```

(The test author should look at how the existing tests render `useLiveBundle` and follow that same pattern. If the existing test setup uses a different fixture style, adapt.)

- [ ] **Step 6.3: Refactor `useLiveBundle.ts`**

Replace contents of `frontend/src/live/useLiveBundle.ts`:

```ts
import { useMemo } from 'react';
import { useLiveSeries } from '../api/liveSeries';
import { useLivePastCandles } from '../api/livePastCandles';
import { useRange } from '../api/range';
import { useLivePageStore, type LiveTimeframe, bucketSeconds, baseFor } from '../state/livePage';
import { TIMEFRAME_TO_MS, type Timeframe, type RangeBundle, type Candle } from '../api/types';
import { buildLiveBundle } from './buildLiveBundle';
import { aggregateCandles } from './aggregateCandles';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import {
  yesterdayKst,
  regularSessionOpenMs,
  regularSessionCloseMs,
  subtractDaysKst,
  INITIAL_HISTORICAL_DAYS,
} from './liveDateTime';

const MINUTE_TIMEFRAMES: ReadonlyArray<Timeframe> = ['1m', '3m', '5m', '10m', '15m', '30m'];
const PAST_CANDLES_MAX_DAYS = 60;

function isMinuteTimeframe(tf: LiveTimeframe): tf is Timeframe {
  return (MINUTE_TIMEFRAMES as ReadonlyArray<string>).includes(tf);
}

function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function kisBarToCandle(b: { t_ms: number; open: number; high: number; low: number; close: number; volume: number }): Candle {
  return {
    ts_ms: b.t_ms,
    open: b.open,
    close: b.close,
    high: b.high,
    low: b.low,
    vol_a: b.volume,
    vol_b: 0,
  };
}

export interface UseLiveBundleResult {
  bundle: RangeBundle | null;
  isLoading: boolean;
  error: unknown;
}

/** Orchestrate live SSE + KIS past-candles + /api/range hoga indicators into a
 * single RangeBundle for LiveChartRoot. ADR-0040 — KIS candles are the single
 * candle source via the dedicated `/api/live/past-candles` endpoint.
 */
export function useLiveBundle(
  code: string | null,
  timeframe: LiveTimeframe,
  todayKstYyyymmdd: string,
): UseLiveBundleResult {
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);

  const live = useLiveSeries(code ?? '');

  const isMinute = isMinuteTimeframe(timeframe);
  const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;

  // 60-day clamp at the bundle layer so /api/range's 90-day cap and
  // /api/live/past-candles' 60-day cap can stay independent.
  const seedFrom = historicalFromDate ?? subtractDaysKst(todayKstYyyymmdd, INITIAL_HISTORICAL_DAYS);
  const earliestAllowed = subtractDaysKst(todayKstYyyymmdd, PAST_CANDLES_MAX_DAYS - 1);
  const pastFrom = laterDate(seedFrom, earliestAllowed);
  const pastTo = yesterdayKst(todayKstYyyymmdd);

  const enableRange = !!(code && isMinute && pastFrom <= pastTo);
  const past = useRange(
    enableRange ? code : null,
    enableRange ? pastFrom : null,
    enableRange ? pastTo : null,
    enableRange ? (timeframe as Timeframe) : null,
  );

  // KIS past-candles: range is [pastFrom, today] (today included, ADR-0040).
  const pastCandlesEnabled = !!(code && isMinute);
  const pastCandlesQuery = useLivePastCandles(
    pastCandlesEnabled ? code : null,
    pastCandlesEnabled ? pastFrom : null,
    pastCandlesEnabled ? todayKstYyyymmdd : null,
  );

  const kisCandles = useMemo<Candle[]>(() => {
    const raw = pastCandlesQuery.data?.candles ?? [];
    if (raw.length === 0) return [];
    const base = raw.map(kisBarToCandle);
    if (!isMinute) return base;
    const bucket = bucketSeconds(timeframe);
    if (bucket === null || timeframe === '1m') return base;
    // aggregateCandles operates on the KIS bar shape — adapt.
    const aggregatedRaw = aggregateCandles(raw, bucket);
    return aggregatedRaw.map(kisBarToCandle);
  }, [pastCandlesQuery.data, isMinute, timeframe]);

  const bundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;

    const todaySession =
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) };

    const sseOb = isMinute ? (live.ob as unknown as ObSnapshot[]) : [];
    const sseTrade = isMinute ? (live.trade as unknown as TradeSnapshot[]) : [];

    return buildLiveBundle({
      code,
      todayDate: todayKstYyyymmdd,
      todaySession,
      pastBundle: past.data ?? null,
      sseOb,
      sseTrade,
      kisCandles,
      bucketMs,
    });
  }, [code, todayKstYyyymmdd, isMinute, live.initial, live.ob, live.trade, past.data, kisCandles, bucketMs]);

  return {
    bundle,
    isLoading: live.isLoading || past.isLoading || pastCandlesQuery.isLoading,
    error: live.error ?? past.error ?? pastCandlesQuery.error ?? null,
  };
}
```

- [ ] **Step 6.4: Run useLiveBundle tests → expect pass**

```bash
cd frontend && npx vitest run src/live/useLiveBundle.test.tsx
```

Expected: all PASS.

- [ ] **Step 6.5: Commit**

```bash
git add frontend/src/live/useLiveBundle.ts frontend/src/live/useLiveBundle.test.tsx
git commit -m "refactor(live): wire useLivePastCandles + 60-day clamp in useLiveBundle"
```

---

## Task 7: Frontend — delete `liveCandles.ts` + cleanup

**Files:**
- Delete: `frontend/src/api/liveCandles.ts`
- Delete: `frontend/src/api/liveCandles.test.tsx`

- [ ] **Step 7.1: Search for any remaining imports**

```bash
grep -rn "liveCandles\|useLiveCandles" frontend/src/ --exclude-dir=node_modules
```

Expected: only the file itself (which we're about to delete) + possibly some test refs.

- [ ] **Step 7.2: Delete files**

```bash
git rm frontend/src/api/liveCandles.ts frontend/src/api/liveCandles.test.tsx
```

- [ ] **Step 7.3: Run full frontend test suite**

```bash
cd frontend && npx vitest run
```

Expected: all tests PASS, no `useLiveCandles` import errors.

- [ ] **Step 7.4: Build to confirm no TS errors**

```bash
cd frontend && npm run build
```

Expected: build succeeds.

- [ ] **Step 7.5: Commit**

```bash
git commit -m "refactor(live): remove liveCandles.ts (superseded by livePastCandles)"
```

---

## Task 8: Final verification + smoke

- [ ] **Step 8.1: Full backend test suite**

```bash
uv run pytest -q
```

Expected: all tests PASS (741 baseline + new past-candles tests; intraday tests removed).

- [ ] **Step 8.2: Full frontend test suite**

```bash
cd frontend && npx vitest run
```

Expected: all PASS.

- [ ] **Step 8.3: Frontend build**

```bash
cd frontend && npm run build
```

Expected: build succeeds.

- [ ] **Step 8.4: Manual dev-server smoke (per CLAUDE.md)**

In one terminal:
```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

In another:
```bash
cd frontend && npm run dev
```

Browser: open `http://localhost:5173/live`. Pick a watchlist code. Verify:
- Past minute candles render going back 20 days (default `INITIAL_HISTORICAL_DAYS`).
- Today's candle is sized normally (not 0.7% micro-scale).
- 5/26-style invariant fire date (or any past `excluded_dates` entry): candle is visible; fill_strength is empty for that date.
- Network panel: `/api/live/past-candles?...` request fires. Refresh page: second request shows `cached_dates` populated for past dates.

- [ ] **Step 8.5: No commit (manual verification only)**

If smoke reveals issues, route them through systematic-debugging skill and create fix commits — do not adjust the plan retroactively.
