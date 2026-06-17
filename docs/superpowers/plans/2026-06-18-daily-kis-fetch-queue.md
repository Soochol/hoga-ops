# Daily KIS Fetch Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a priority-aware Daily KIS Fetch Queue that protects user-visible `/live` daily candle requests from screener background catch-up.

**Architecture:** KIS daily candle calls remain `KisClient` calls, but callers reach them through `DailyKisFetchQueue`. `kis_access` owns account selection through an explicit lease API; the queue owns foreground/background scheduling, account 0 fallback gating, and daily-TR cooldown.

**Tech Stack:** Python 3.14, FastAPI, asyncio, pytest, httpx MockTransport, existing `hoga.live.kis_client`, `hoga.live.kis_access`, `hoga.api.screener_store`.

## Global Constraints

- Do not redesign all KIS REST calls.
- Do not replace account routing in `kis_access`.
- Do not move screener into a separate worker process.
- Do not make startup recovery mandatory to finish before the API is usable.
- Foreground account = account 0; background account = account 1..N.
- Background account 0 fallback is allowed only when no foreground work is queued or active.
- `DailyKisFetchQueue` is the full canonical term; do not call it "job queue" or "KIS queue".
- Non-daily KIS calls keep ADR-0050 `_get` retry behavior.

---

## File Structure

- Create `hoga/live/daily_fetch_queue.py`: Daily KIS Fetch Queue, lane types, status snapshot, cooldown policy.
- Modify `hoga/live/kis_client.py`: add `retry` opt-out to `fetch_past_daily_candles`.
- Modify `hoga/live/kis_access.py`: add explicit `KisAccountLease` and `acquire_account_for_role`.
- Modify `hoga/live/api.py`: route `/api/live/past-daily-candles` through foreground queue.
- Modify `hoga/api/screener.py`: route screener KIS fetches through background queue.
- Modify `hoga/api/screener_store.py`: replace eager `gather` over all Codes with bounded worker collection and per-code failure tolerance.
- Modify `hoga/api/models.py` only if a typed queue status model is needed; prefer plain dict first.
- Test `tests/unit/live/test_kis_rest_methods.py`: retry opt-out behavior.
- Create `tests/unit/live/test_kis_access_account_lease.py`: role-to-account lease tests.
- Create `tests/unit/live/test_daily_fetch_queue.py`: priority, cooldown, account fallback, status tests.
- Modify or create screener tests for bounded per-code failures.
- Modify live API tests for foreground queue route.

---

### Task 1: Add Daily Retry Opt-Out to `KisClient`

**Files:**
- Modify: `hoga/live/kis_client.py`
- Modify: `tests/unit/live/test_kis_rest_methods.py`

**Interfaces:**
- Consumes: existing `KisClient._get(..., retry: bool = True)`.
- Produces: `KisClient.fetch_past_daily_candles(..., retry: bool = True) -> DailyCandleFetchResult`.

- [ ] **Step 1: Write failing retry opt-out test**

Append this test near the existing daily candle tests in `tests/unit/live/test_kis_rest_methods.py`:

```python
@pytest.mark.asyncio
async def test_fetch_past_daily_retry_false_does_not_retry_rate_limit(tmp_path) -> None:
    calls = {"data": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        calls["data"] += 1
        return httpx.Response(200, json={"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "rate"})

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
        _rate_limit_backoff=(0.0, 0.0, 0.0),
    )
    try:
        with pytest.raises(KisRateLimitError):
            await client.fetch_past_daily_candles(
                "005930", "20240101", "20240101", retry=False,
            )
        assert calls["data"] == 1
    finally:
        await client.aclose()
```

If `KisRateLimitError` is not imported in that file, update the import block:

```python
from hoga.live.kis_client import (
    KisClient,
    KisCredentials,
    KisRateLimitError,
    KisTransportError,
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/live/test_kis_rest_methods.py::test_fetch_past_daily_retry_false_does_not_retry_rate_limit -q`

Expected: FAIL with `TypeError: KisClient.fetch_past_daily_candles() got an unexpected keyword argument 'retry'`.

- [ ] **Step 3: Implement `retry` parameter**

In `hoga/live/kis_client.py`, change the daily method signature and `_get` call:

```python
    async def fetch_past_daily_candles(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        adjust: bool = True,
        foreground: bool = False,
        retry: bool = True,
    ) -> DailyCandleFetchResult:
```

Inside the pagination loop, replace the `_get` call with:

```python
            body = await self._get(
                path=path,
                tr_id=tr_id,
                params=params,
                foreground=foreground,
                retry=retry,
            )
```

- [ ] **Step 4: Run focused tests**

Run: `uv run pytest tests/unit/live/test_kis_rest_methods.py::test_fetch_past_daily_retry_false_does_not_retry_rate_limit tests/unit/live/test_kis_rest_methods.py::test_fetch_past_daily_rate_limit_propagates -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_rest_methods.py
git commit -m "feat: allow daily KIS retry opt-out"
```

---

### Task 2: Add Explicit KIS Account Lease API

**Files:**
- Modify: `hoga/live/kis_access.py`
- Create: `tests/unit/live/test_kis_access_account_lease.py`

**Interfaces:**
- Consumes: `kis_runtime.configured_account_ids(data_dir)`, `kis_runtime.ensure_kis_client_for_account(account_id, data_dir)`, `account_health.is_rest_degraded(account_id)`.
- Produces:
  - `@dataclass(frozen=True) class KisAccountLease`
  - `acquire_account_for_role(role: str, data_dir: Path, *, allow_account0_fallback: bool = True) -> KisAccountLease | None`

- [ ] **Step 1: Write failing lease tests**

Create `tests/unit/live/test_kis_access_account_lease.py`:

```python
from __future__ import annotations

from pathlib import Path

from hoga.live import account_health, kis_access


class _Client:
    def __init__(self, account_id: int):
        self.account_id = account_id


def test_foreground_lease_uses_account0(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_for_account",
        lambda account_id, data_dir: _Client(account_id),
    )

    lease = kis_access.acquire_account_for_role("foreground", tmp_path)

    assert lease is not None
    assert lease.account_id == 0
    assert lease.role == "foreground"
    assert lease.client.account_id == 0


def test_background_lease_uses_nonzero_accounts_round_robin(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "hoga.live.kis_runtime.configured_account_ids",
        lambda data_dir: [0, 1, 2],
    )
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_for_account",
        lambda account_id, data_dir: _Client(account_id),
    )
    account_health.reset_for_tests()

    first = kis_access.acquire_account_for_role("background", tmp_path)
    second = kis_access.acquire_account_for_role("background", tmp_path)

    assert first is not None and first.account_id == 1
    assert second is not None and second.account_id == 2


def test_background_lease_can_disallow_account0_fallback(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "hoga.live.kis_runtime.configured_account_ids",
        lambda data_dir: [0],
    )
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_for_account",
        lambda account_id, data_dir: _Client(account_id),
    )

    lease = kis_access.acquire_account_for_role(
        "background", tmp_path, allow_account0_fallback=False,
    )

    assert lease is None


def test_background_lease_can_allow_account0_fallback(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "hoga.live.kis_runtime.configured_account_ids",
        lambda data_dir: [0],
    )
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_for_account",
        lambda account_id, data_dir: _Client(account_id),
    )

    lease = kis_access.acquire_account_for_role(
        "background", tmp_path, allow_account0_fallback=True,
    )

    assert lease is not None
    assert lease.account_id == 0
    assert lease.role == "background"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/live/test_kis_access_account_lease.py -q`

Expected: FAIL with `AttributeError: module 'hoga.live.kis_access' has no attribute 'acquire_account_for_role'`.

- [ ] **Step 3: Implement lease API**

In `hoga/live/kis_access.py`, add imports:

```python
from dataclasses import dataclass
from typing import Literal
```

Add after `_bg_round_robin`:

```python
@dataclass(frozen=True)
class KisAccountLease:
    role: Literal["foreground", "background"]
    account_id: int
    client: KisClient
```

Add this function above `kis_for_role`:

```python
def acquire_account_for_role(
    role: str,
    data_dir: Path,
    *,
    allow_account0_fallback: bool = True,
) -> KisAccountLease | None:
    if role == "foreground":
        client = kis_runtime.get_kis_client(0)
        if client is None:
            client = kis_runtime.ensure_kis_client_from_env(data_dir)
        if client is None:
            return None
        return KisAccountLease(role="foreground", account_id=0, client=client)

    if role != "background":
        raise ValueError(f"unknown KIS account role: {role}")

    candidates = [
        a for a in kis_runtime.configured_account_ids(data_dir)
        if a >= 1 and not account_health.is_rest_degraded(a)
    ]
    if candidates:
        global _bg_round_robin  # noqa: PLW0603
        pick = candidates[_bg_round_robin % len(candidates)]
        _bg_round_robin += 1
        client = kis_runtime.ensure_kis_client_for_account(pick, data_dir)
        if client is not None:
            return KisAccountLease(role="background", account_id=pick, client=client)

    if not allow_account0_fallback:
        return None

    client = kis_runtime.get_kis_client(0)
    if client is None:
        client = kis_runtime.ensure_kis_client_from_env(data_dir)
    if client is None:
        return None
    return KisAccountLease(role="background", account_id=0, client=client)
```

Refactor `kis_for_role` to consume the lease API:

```python
def kis_for_role(role: str, data_dir: Path) -> KisClient | None:
    lease = acquire_account_for_role(role, data_dir)
    return lease.client if lease is not None else None
```

- [ ] **Step 4: Run lease tests and existing role users**

Run: `uv run pytest tests/unit/live/test_kis_access_account_lease.py tests/unit/live/test_api.py::test_past_daily_candles_route_exists -q`

If the named route smoke test does not exist, run: `uv run pytest tests/unit/live/test_api.py -q -k past_daily`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_access.py tests/unit/live/test_kis_access_account_lease.py
git commit -m "feat: add KIS account lease API"
```

---

### Task 3: Implement `DailyKisFetchQueue`

**Files:**
- Create: `hoga/live/daily_fetch_queue.py`
- Create: `tests/unit/live/test_daily_fetch_queue.py`

**Interfaces:**
- Consumes:
  - `kis_access.acquire_account_for_role(role, data_dir, allow_account0_fallback=...)`
  - `KisClient.fetch_past_daily_candles(..., retry=False)`
- Produces:
  - `Lane = Literal["foreground", "background"]`
  - `DailyKisFetchQueue.fetch_past_daily_candles(...)`
  - `DailyKisFetchQueue.snapshot() -> dict`
  - `get_daily_fetch_queue() -> DailyKisFetchQueue`

- [ ] **Step 1: Write priority and fallback tests**

Create `tests/unit/live/test_daily_fetch_queue.py`:

```python
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.live.daily_fetch_queue import DailyKisFetchQueue
from hoga.live.kis_client import DailyCandleFetchResult, KisRateLimitError


@dataclass
class _Lease:
    role: str
    account_id: int
    client: object


class _Client:
    def __init__(self, name: str, calls: list[str], fail_rate_limit: bool = False):
        self.name = name
        self.calls = calls
        self.fail_rate_limit = fail_rate_limit

    async def fetch_past_daily_candles(self, code, frm, to, *, adjust=True, foreground=False, retry=True):
        self.calls.append(f"{self.name}:{code}:fg={foreground}:retry={retry}")
        if self.fail_rate_limit:
            raise KisRateLimitError("EGW00201")
        return DailyCandleFetchResult(candles=[], violations=[])


@pytest.mark.asyncio
async def test_background_waits_while_foreground_is_waiting(tmp_path: Path) -> None:
    calls: list[str] = []
    release_fg = asyncio.Event()

    class SlowForeground(_Client):
        async def fetch_past_daily_candles(self, *args, **kwargs):
            await release_fg.wait()
            return await super().fetch_past_daily_candles(*args, **kwargs)

    fg_client = SlowForeground("fg", calls)
    bg_client = _Client("bg", calls)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        if role == "foreground":
            return _Lease(role, 0, fg_client)
        return _Lease(role, 1, bg_client)

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.0,),
    )

    fg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="foreground", code="FG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await asyncio.sleep(0)
    bg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="background", code="BG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await asyncio.sleep(0)

    assert calls == []
    release_fg.set()
    await asyncio.gather(bg, fg)

    assert calls == ["fg:FG:fg=True:retry=False", "bg:BG:fg=False:retry=False"]


@pytest.mark.asyncio
async def test_background_account0_fallback_waits_for_foreground_idle(tmp_path: Path) -> None:
    calls: list[str] = []
    fg_started = asyncio.Event()
    release_fg = asyncio.Event()

    class SlowForeground(_Client):
        async def fetch_past_daily_candles(self, *args, **kwargs):
            fg_started.set()
            await release_fg.wait()
            return await super().fetch_past_daily_candles(*args, **kwargs)

    fg_client = SlowForeground("fg", calls)
    fallback_client = _Client("fallback", calls)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        if role == "foreground":
            return _Lease(role, 0, fg_client)
        if allow_account0_fallback:
            return _Lease(role, 0, fallback_client)
        return None

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.0,),
    )

    fg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="foreground", code="FG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await fg_started.wait()
    bg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="background", code="BG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await asyncio.sleep(0)

    assert calls == []
    release_fg.set()
    await asyncio.gather(fg, bg)
    assert calls == ["fg:FG:fg=True:retry=False", "fallback:BG:fg=False:retry=False"]


@pytest.mark.asyncio
async def test_rate_limit_sets_cooldown_and_records_status(tmp_path: Path) -> None:
    calls: list[str] = []
    client = _Client("fg", calls, fail_rate_limit=True)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        return _Lease(role, 0, client)

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.01,),
    )

    with pytest.raises(KisRateLimitError):
        await queue.fetch_past_daily_candles(
            tmp_path, lane="foreground", code="FG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
        )

    snap = queue.snapshot()
    assert snap["daily_rate_limit_count"] == 1
    assert snap["cooldown_remaining_ms"] >= 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_daily_fetch_queue.py -q`

Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.live.daily_fetch_queue'`.

- [ ] **Step 3: Implement queue module**

Create `hoga/live/daily_fetch_queue.py`:

```python
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from hoga.live import kis_access
from hoga.live.kis_client import DailyCandleFetchResult, KisRateLimitError

Lane = Literal["foreground", "background"]


class DailyKisFetchQueue:
    def __init__(
        self,
        *,
        acquire_account: Callable = kis_access.acquire_account_for_role,
        foreground_concurrency: int = 3,
        background_concurrency_per_account: int = 1,
        account0_background_fallback_concurrency: int = 1,
        global_rate_per_sec: float = 6.0,
        cooldown_backoff: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0),
    ) -> None:
        self._acquire_account = acquire_account
        self._fg_sem = asyncio.Semaphore(foreground_concurrency)
        self._bg_per_account = background_concurrency_per_account
        self._account0_bg_sem = asyncio.Semaphore(account0_background_fallback_concurrency)
        self._global_min_interval = 1.0 / global_rate_per_sec
        self._rate_lock = asyncio.Lock()
        self._last_start = 0.0
        self._cooldown_until = 0.0
        self._cooldown_backoff = cooldown_backoff
        self._cooldown_index = 0
        self._fg_waiting = 0
        self._fg_active = 0
        self._bg_waiting = 0
        self._bg_active = 0
        self._daily_rate_limit_count = 0
        self._account_bg_sems: dict[int, asyncio.Semaphore] = {}

    def snapshot(self) -> dict:
        now = time.monotonic()
        return {
            "queued_foreground": self._fg_waiting,
            "queued_background": self._bg_waiting,
            "active_foreground": self._fg_active,
            "active_background": self._bg_active,
            "cooldown_remaining_ms": max(0, int((self._cooldown_until - now) * 1000)),
            "daily_rate_limit_count": self._daily_rate_limit_count,
        }

    async def fetch_past_daily_candles(
        self,
        data_dir: Path,
        *,
        lane: Lane,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        adjust: bool = True,
    ) -> DailyCandleFetchResult:
        if lane == "foreground":
            return await self._run_foreground(data_dir, code, from_yyyymmdd, to_yyyymmdd, adjust)
        return await self._run_background(data_dir, code, from_yyyymmdd, to_yyyymmdd, adjust)

    async def _run_foreground(self, data_dir: Path, code: str, frm: str, to: str, adjust: bool):
        self._fg_waiting += 1
        try:
            async with self._fg_sem:
                self._fg_waiting -= 1
                self._fg_active += 1
                try:
                    lease = self._acquire_account("foreground", data_dir)
                    if lease is None:
                        raise RuntimeError("KIS foreground account unavailable")
                    return await self._call_lease(lease, code, frm, to, adjust, foreground=True)
                finally:
                    self._fg_active -= 1
        finally:
            if self._fg_waiting > 0 and self._fg_active == 0:
                self._fg_waiting = max(0, self._fg_waiting)

    async def _run_background(self, data_dir: Path, code: str, frm: str, to: str, adjust: bool):
        self._bg_waiting += 1
        try:
            await asyncio.sleep(0)
            while self._fg_waiting or self._fg_active:
                await asyncio.sleep(0.02)
            lease = self._acquire_account("background", data_dir, allow_account0_fallback=False)
            if lease is None:
                while self._fg_waiting or self._fg_active:
                    await asyncio.sleep(0.02)
                lease = self._acquire_account("background", data_dir, allow_account0_fallback=True)
            if lease is None:
                raise RuntimeError("KIS background account unavailable")
            sem = self._account0_bg_sem if lease.account_id == 0 else self._account_bg_sems.setdefault(
                lease.account_id, asyncio.Semaphore(self._bg_per_account),
            )
            async with sem:
                self._bg_waiting -= 1
                self._bg_active += 1
                try:
                    if lease.account_id == 0:
                        while self._fg_waiting or self._fg_active:
                            await asyncio.sleep(0.02)
                    return await self._call_lease(lease, code, frm, to, adjust, foreground=False)
                finally:
                    self._bg_active -= 1
        finally:
            if self._bg_waiting > 0 and self._bg_active == 0:
                self._bg_waiting = max(0, self._bg_waiting)

    async def _call_lease(self, lease, code: str, frm: str, to: str, adjust: bool, *, foreground: bool):
        await self._wait_global_turn()
        try:
            result = await lease.client.fetch_past_daily_candles(
                code,
                frm,
                to,
                adjust=adjust,
                foreground=foreground,
                retry=False,
            )
            self._cooldown_index = 0
            return result
        except KisRateLimitError:
            self._daily_rate_limit_count += 1
            delay = self._cooldown_backoff[min(self._cooldown_index, len(self._cooldown_backoff) - 1)]
            self._cooldown_index += 1
            self._cooldown_until = max(self._cooldown_until, time.monotonic() + delay)
            raise

    async def _wait_global_turn(self) -> None:
        async with self._rate_lock:
            now = time.monotonic()
            wait = max(0.0, self._cooldown_until - now, self._last_start + self._global_min_interval - now)
            if wait:
                await asyncio.sleep(wait)
            self._last_start = time.monotonic()


_queue = DailyKisFetchQueue()


def get_daily_fetch_queue() -> DailyKisFetchQueue:
    return _queue
```

- [ ] **Step 4: Run queue tests**

Run: `uv run pytest tests/unit/live/test_daily_fetch_queue.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/daily_fetch_queue.py tests/unit/live/test_daily_fetch_queue.py
git commit -m "feat: add daily KIS fetch queue"
```

---

### Task 4: Route Live Daily Candles Through Foreground Queue

**Files:**
- Modify: `hoga/live/api.py`
- Modify: `tests/unit/live/test_api.py`

**Interfaces:**
- Consumes: `get_daily_fetch_queue().fetch_past_daily_candles(data_dir, lane="foreground", ...)`.
- Produces: `/api/live/past-daily-candles` no longer directly calls `kis_access.kis_for_role("foreground")`.

- [ ] **Step 1: Write route adapter test**

In `tests/unit/live/test_api.py`, add a focused test near existing past-daily route tests:

```python
def test_past_daily_candles_uses_foreground_queue(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from hoga.live.kis_client import DailyCandleFetchResult, KisCandle
    from hoga.live.api import build_router

    calls = []

    class FakeQueue:
        async def fetch_past_daily_candles(self, data_dir, *, lane, code, from_yyyymmdd, to_yyyymmdd, adjust=True):
            calls.append((data_dir, lane, code, from_yyyymmdd, to_yyyymmdd, adjust))
            return DailyCandleFetchResult(candles=[
                KisCandle(t_ms=1704168000000, open=1, high=2, low=1, close=2, volume=3)
            ])

    monkeypatch.setattr("hoga.live.api.get_daily_fetch_queue", lambda: FakeQueue())

    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))

    res = TestClient(app).get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240102")

    assert res.status_code == 200
    assert calls
    assert calls[0][1] == "foreground"
    assert calls[0][2] == "005930"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/live/test_api.py -q -k foreground_queue`

Expected: FAIL because `hoga.live.api.get_daily_fetch_queue` is not imported or not used.

- [ ] **Step 3: Update live route**

In `hoga/live/api.py`, add import:

```python
from hoga.live.daily_fetch_queue import get_daily_fetch_queue
```

In `_get_past_daily_candles`, remove direct `kis = kis_access.kis_for_role("foreground", data_dir)` resolution. Keep `data_dir` and cache checks.

Replace `fetch_batch` body with:

```python
        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await get_daily_fetch_queue().fetch_past_daily_candles(
                data_dir,
                lane="foreground",
                code=code_,
                from_yyyymmdd=from_s,
                to_yyyymmdd=to_s,
                adjust=True,
            )
            return [_candle_to_dict(c) for c in result.candles], result.violations
```

- [ ] **Step 4: Run focused tests**

Run: `uv run pytest tests/unit/live/test_api.py -q -k "past_daily and queue"`

Expected: PASS. If the `-k` expression does not select the new test, run the exact new test name.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "feat: route live daily candles through queue"
```

---

### Task 5: Route Screener Through Background Queue and Bound Workers

**Files:**
- Modify: `hoga/api/screener.py`
- Modify: `hoga/api/screener_store.py`
- Create or modify: `tests/test_api_screener_update.py`

**Interfaces:**
- Consumes: `get_daily_fetch_queue().fetch_past_daily_candles(data_dir, lane="background", adjust=False, ...)`.
- Produces:
  - `screener_store.run_update(..., fetch_one)` no longer fails whole batch on one code failure.
  - no eager universe-sized `asyncio.gather`.

- [ ] **Step 1: Write bounded failure-tolerance test**

Create `tests/test_api_screener_update.py` if no suitable file exists:

```python
from __future__ import annotations

import datetime as dt

import polars as pl
import pytest

from hoga.api import screener_store
from hoga.api.screener_store import DailyBar


@pytest.mark.asyncio
async def test_run_update_keeps_successful_codes_when_one_fetch_fails(tmp_path):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["000001"],
            "date": [dt.date(2024, 1, 1)],
            "open": [1.0],
            "high": [1.0],
            "low": [1.0],
            "close": [1.0],
            "volume": [1],
        },
        schema=screener_store._DAILY_PL_SCHEMA,
    ).write_parquet(sdir / "daily_unadjusted.parquet")

    async def fetch_one(code: str, frm: str, to: str):
        if code == "000002":
            raise RuntimeError("boom")
        return [
            DailyBar(
                code=code,
                date=dt.date(2024, 1, 2),
                open=2.0,
                high=2.0,
                low=2.0,
                close=2.0,
                volume=2,
            )
        ]

    updated = await screener_store.run_update(
        sdir,
        codes=["000001", "000002"],
        fetch_one=fetch_one,
        trading_days=["20240102"],
        now_ms=123,
    )

    assert updated == 1
    status = screener_store.read_status(sdir / "status.json")
    assert status is not None
    assert status.last_raw_date == "20240102"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api_screener_update.py::test_run_update_keeps_successful_codes_when_one_fetch_fails -q`

Expected: FAIL because `asyncio.gather` propagates `RuntimeError("boom")`.

- [ ] **Step 3: Make `run_update` bounded and tolerant**

In `hoga/api/screener_store.py`, replace `_FETCH_CONCURRENCY = 8` comment and collection logic:

```python
_FETCH_CONCURRENCY = 2
```

Replace `fetched = await asyncio.gather(*(_one(c) for c in codes))` with worker queue code:

```python
    q: asyncio.Queue[str | None] = asyncio.Queue()
    for c in codes:
        q.put_nowait(c)
    for _ in range(_FETCH_CONCURRENCY):
        q.put_nowait(None)

    fetched: list[list[DailyBar]] = []
    failures: list[tuple[str, str]] = []

    async def _worker() -> None:
        while True:
            code = await q.get()
            if code is None:
                return
            try:
                fetched.append(await _one(code))
            except Exception as e:  # noqa: BLE001
                failures.append((code, type(e).__name__))
                log.warning("screener update: daily fetch failed code=%s error=%s", code, type(e).__name__)

    await asyncio.gather(*(_worker() for _ in range(_FETCH_CONCURRENCY)))
```

Keep:

```python
    rows: list[DailyBar] = [b for batch in fetched for b in batch]
```

- [ ] **Step 4: Route screener fetch through queue**

In `hoga/api/screener.py`, add import:

```python
from hoga.live.daily_fetch_queue import get_daily_fetch_queue
```

Change `fetch_one` inside `trigger_update`:

```python
    async def fetch_one(c: str, f: str, t: str) -> list[DailyBar]:
        return await _kis_fetch_one_via_queue(data_dir, c, f, t)
```

Add helper near `_kis_fetch_one`:

```python
async def _kis_fetch_one_via_queue(data_dir: Path, code: str, frm: str, to: str) -> list[DailyBar]:
    res = await get_daily_fetch_queue().fetch_past_daily_candles(
        data_dir,
        lane="background",
        code=code,
        from_yyyymmdd=frm,
        to_yyyymmdd=to,
        adjust=False,
    )
    if res.violations:
        sample = [
            {"date": v.date_yyyymmdd, "reason": v.reason, "detail": v.detail}
            for v in res.violations[:5]
        ]
        if all(v.reason == "out_of_range" for v in res.violations):
            log.info(
                "screener daily out-of-range rows code=%s count=%d range=[%s,%s] sample=%s",
                code, len(res.violations), frm, to, sample,
            )
        else:
            log.warning(
                "screener daily violations code=%s count=%d range=[%s,%s] sample=%s",
                code, len(res.violations), frm, to, sample,
            )
    return [
        DailyBar(
            code=code,
            date=datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).date(),
            open=float(c.open),
            high=float(c.high),
            low=float(c.low),
            close=float(c.close),
            volume=c.volume,
        )
        for c in res.candles
    ]
```

Keep `_kis_fetch_one(client, ...)` only if other tests or callers still use it; otherwise remove it.

- [ ] **Step 5: Run screener tests**

Run: `uv run pytest tests/test_api_screener_update.py::test_run_update_keeps_successful_codes_when_one_fetch_fails -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/screener.py hoga/api/screener_store.py tests/test_api_screener_update.py
git commit -m "feat: route screener daily fetches through queue"
```

---

### Task 6: Add Queue Observability

**Files:**
- Modify: `hoga/api/screener.py`
- Modify: `tests/test_api.py` or `tests/test_api_screener_update.py`

**Interfaces:**
- Consumes: `get_daily_fetch_queue().snapshot() -> dict`.
- Produces: `/api/screener/status` includes `daily_queue`.

- [ ] **Step 1: Write status test**

Add to the screener API test file:

```python
def test_screener_status_includes_daily_queue(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from hoga.api.app import create_app
    from hoga.api.screener_store import write_status

    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True)
    write_status(
        sdir / "status.json",
        last_raw_date="20240101",
        universe_size=1,
        derive_ms=1,
        now_ms=123,
    )

    class FakeQueue:
        def snapshot(self):
            return {
                "queued_foreground": 0,
                "queued_background": 2,
                "active_foreground": 0,
                "active_background": 1,
                "cooldown_remaining_ms": 500,
                "daily_rate_limit_count": 3,
            }

    monkeypatch.setattr("hoga.api.screener.get_daily_fetch_queue", lambda: FakeQueue())

    res = TestClient(create_app(tmp_path)).get("/api/screener/status")

    assert res.status_code == 200
    body = res.json()
    assert body["daily_queue"]["queued_background"] == 2
    assert body["daily_queue"]["cooldown_remaining_ms"] == 500
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api_screener_update.py -q -k daily_queue`

Expected: FAIL because `daily_queue` is absent.

- [ ] **Step 3: Add queue snapshot to status route**

In `hoga/api/screener.py`, ensure import exists:

```python
from hoga.live.daily_fetch_queue import get_daily_fetch_queue
```

In `status()` route, change return:

```python
        return {
            **s.model_dump(),
            "status": "ok",
            "days_behind": days_behind,
            "daily_queue": get_daily_fetch_queue().snapshot(),
        }
```

- [ ] **Step 4: Run status test**

Run: `uv run pytest tests/test_api_screener_update.py -q -k daily_queue`

Expected: PASS.

- [ ] **Step 5: Run focused regression suite**

Run:

```bash
uv run pytest \
  tests/unit/live/test_daily_fetch_queue.py \
  tests/unit/live/test_kis_access_account_lease.py \
  tests/unit/live/test_kis_rest_methods.py::test_fetch_past_daily_retry_false_does_not_retry_rate_limit \
  tests/unit/live/test_batched_daily_walkback.py \
  tests/test_api_screener_update.py \
  -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/screener.py tests/test_api_screener_update.py
git commit -m "feat: expose daily KIS queue status"
```

---

## Self-Review

- Spec coverage: account roles, account 0 fallback, global daily TR governor, retry ownership, screener bounded workers, foreground protection, observability, and tests are all covered.
- Placeholder scan: no placeholder markers or deferred-work phrases should remain in this plan.
- Type consistency: `DailyKisFetchQueue.fetch_past_daily_candles`, `KisAccountLease`, and `acquire_account_for_role` are defined before later tasks consume them.
- Known carry-over: `hoga/api/screener.py` may already contain the violation-log improvement from prior diagnosis. Preserve it; Task 5 incorporates that logging in the queue helper.
