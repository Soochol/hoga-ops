# KIS Capacity Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an account-aware KIS capacity scheduler where adding KIS accounts increases usable REST throughput, under the assumption that KIS API rate limits are enforced per account/appkey.

**Architecture:** Replace route-local KIS burst controls and direct role-based account selection with a central `KisCapacityScheduler`. The scheduler owns request priority, coalescing, account leasing, account-scoped cooldown, and fairness. `KisClient` remains the only HTTP ingress and still owns auth, token bucket, transport retry, and `EGW00201` retry.

**Tech Stack:** Python 3.11+ `asyncio`, existing `kis_runtime` per-account `KisClient` singletons, FastAPI router closures, pytest + pytest-asyncio via `uv run --extra dev python -m pytest`.

## Global Constraints

- Assume KIS REST limits are per account/appkey. Effective capacity is `healthy_account_count * 15 calls/sec`.
- Preserve ADR-0050: all KIS data fetch HTTP calls still go through `KisClient`.
- Do not remove `KisClient._TokenBucket`; the account pool schedules above the per-account token buckets.
- Keep `KisClient._get` retry semantics unchanged. The scheduler sees `KisRateLimitError` only after client retry is exhausted.
- Scheduler owns account selection. Routes and background jobs must not call `kis_access.kis_for_role(...)` directly once migrated.
- Scheduler lifecycle is process-wide per `data_dir`, owned by `kis_capacity_runtime`, so live routes and background/screener callers share one capacity pool.
- FastAPI/app shutdown must call `aclose_kis_capacity_scheduler(data_dir=None)` before `aclose_kis_client()`. This cancels scheduler workers and in-flight shared requests before tearing down the underlying `KisClient` singletons.
- Scheduler worker count is resolved from configured account count by default: `clamp(configured_accounts * 8, min=4, max=64)`. `HOGA_KIS_CAPACITY_MAX_WORKERS` may override this. Workers are concurrency slots, not the rate-limit authority; account-level 15 calls/sec limiting remains in `KisClient._TokenBucket`.
- Scheduler worker sizing is evaluated only when a scheduler is created. Account-count or env override changes are not hot-reloaded into an existing scheduler; use app restart or `aclose_kis_capacity_scheduler(data_dir)` followed by recreate.
- `KisAccountPool` also snapshots configured account ids at creation. Account health/degraded state is evaluated dynamically, but adding/removing accounts requires app restart or explicit scheduler recreate.
- Invalid or non-positive `HOGA_KIS_CAPACITY_MAX_WORKERS` values must not fail app startup. Log a warning and fall back to account-count-based worker sizing.
- Scheduler pending capacity is bounded. Default `HOGA_KIS_CAPACITY_MAX_PENDING` is 1000 unique scheduled request keys; coalescing onto an existing key bypasses this limit. When the limit is reached, new unique requests raise `KisCapacityOverloaded`.
- Scheduler observability is part of the contract. `snapshot()` must expose configured account count, healthy account count, `max_workers`, `max_pending_requests`, queued/inflight counts, cooldown state, background deferral counters, and overload counter. `/api/live/status` should include this snapshot when the scheduler is wired.
- `kis_access` remains only as a compatibility facade during migration.
- Do not add a feature flag or dual allocator for migrated routes. Once a caller is migrated, `KisCapacityScheduler` is the only production path; rollback is via code revert. Keep `kis_access` role routing only for callers not yet migrated.
- Supersede the old `foreground -> account 0`, `background -> account 1..N` routing model for migrated callers. User wait-sensitivity is represented by scheduler priority (`user_visible` / `background`), not by a fixed account role.
- Accounts have no fixed foreground/background role after migration. Every healthy account can serve both `user_visible` and `background` requests.
- If a queued `background` request is coalesced by a later `user_visible` waiter with the same key, promote the queued request to `user_visible`. If it is already running, do not preempt it.
- Protect user-visible bursts with background reservation: when at least two healthy accounts exist, background work may not consume the final usable account for that request's cooldown key. If any `user_visible` request is queued, workers must not start new background requests.
- Reservation is evaluated against usable accounts for the request's cooldown key, not just total configured accounts. If only one account is configured, background may still use it; if multiple healthy accounts exist but cooldown leaves only one usable/free account for that key, background must wait.
- Do not add background aging in this plan. Background starvation is allowed while user-visible requests keep arriving; make the deferral visible with scheduler counters instead.
- Reserved-capacity deferral is not a request failure. `KisAccountReservationDeferred` means "requeue and wait"; `KisNoAccountAvailable` means no account can currently serve this request and surfaces as `KisCapacityCooldown`.
- Polling routes such as quotes and investor estimate must apply short route-level timeouts around background scheduler calls and gracefully fallback on timeout. These route-level timeouts must wrap scheduler submission with `asyncio.shield(...)`, so the HTTP response can abandon waiting without cancelling the shared scheduled request. Batch jobs may wait without a timeout.
- Account cooldown is scoped by `(account_id, endpoint, venue_or_scope)`. A rate limit on one account must not block healthy accounts.
- If all eligible accounts are cooling down for a request, return/surface `rate_limit_aborted` without touching KIS. If pending capacity is full, surface `capacity_overloaded` for user-visible routes and graceful fallback for polling/background routes.
- Priority names are `user_visible` and `background`.
- Cache hits bypass the scheduler.
- Use **KIS Capacity Scheduler** as the canonical public term. Avoid "KIS queue", "job queue", and "Capture Queue" wording.
- Implement with TDD. Each task adds a failing test first, confirms RED, implements, then confirms GREEN.
- Use `apply_patch` for manual edits. Do not bundle broad unrelated refactors.

---

## File Structure

- Create `hoga/live/kis_capacity_scheduler.py`
  - Owns `KisCapacityScheduler`, `KisRequestPriority`, `KisCapacityCooldown`, `KisCapacityOverloaded`, and scheduling/coalescing logic.
  - Does not import FastAPI.
  - Imports `KisRateLimitError` only to detect exhausted KIS rate-limit failures.
- Create `hoga/live/kis_account_pool.py`
  - Owns `KisAccountPool`, `KisAccountLease`, `KisAccountSnapshot`, and account selection/cooldown state.
  - Uses `kis_runtime.configured_account_ids(data_dir)` and `kis_runtime.ensure_kis_client_for_account(account_id, data_dir)`.
  - Uses `account_health.is_rest_degraded(account_id)` to skip degraded accounts.
- Create `hoga/live/kis_capacity_runtime.py`
  - Owns process-wide `KisCapacityScheduler` instances keyed by `data_dir`.
  - Provides `ensure_kis_capacity_scheduler(data_dir)` and `aclose_kis_capacity_scheduler(data_dir)`.
  - Keeps `kis_runtime` focused on `KisClient` lifecycle while this module owns scheduling/capacity lifecycle.
- Create `tests/unit/live/test_kis_account_pool.py`
  - Unit-tests account discovery, eligibility, least-loaded selection, account cooldown, and all-accounts-cooling behavior.
- Create `tests/unit/live/test_kis_capacity_scheduler.py`
  - Unit-tests scheduler coalescing, priority, lazy workers, account lease use, account-scoped cooldown, and cancellation shielding.
- Create `tests/unit/live/test_kis_capacity_runtime.py`
  - Unit-tests dynamic worker sizing, process-wide scheduler reuse by `data_dir`, close semantics, and isolation between different data dirs.
- Modify `hoga/live/api.py`
  - Route `/api/live/past-candles`, `/api/live/past-daily-candles`, `/api/live/quotes`, and `/api/live/investor-trend-estimate` through `KisCapacityScheduler`.
- Modify `hoga/api/startup_runtime.py` and `hoga/api/app.py`
  - Close the shared capacity runtime during FastAPI shutdown before closing `KisClient` singletons.
- Modify `hoga/live/kis_access.py`
  - Keep existing `kis_for_role`/`fetch_for_role` during migration.
  - Add a small compatibility helper only if a non-route caller cannot accept scheduler injection yet.
- Modify relevant tests:
  - `tests/unit/live/test_api.py`
  - `tests/unit/live/test_live_quote_fetcher.py`
  - `tests/api/test_startup_runtime.py`
  - `tests/unit/live/test_kis_runtime_accounts.py`
- Modify `CONTEXT.md`
  - Ensure the glossary defines **KIS Capacity Scheduler**.
- Add ADR:
  - `docs/adr/0082-kis-capacity-scheduler-account-pool.md`

---

## Core Model

```text
Route / Background Caller
  |
  v
KisCapacityScheduler.submit(...)
  |  coalescing, priority, lazy workers, background reservation
  v
KisAccountPool.lease(...)
  |  account discovery, health, cooldown, load score
  v
KisClient(account_id)
  |  auth, token bucket, HTTP, retry
  v
KIS Open API
```

Account capacity:

```text
available_capacity = count(healthy REST accounts) * 15 calls/sec
```

Account role:

```text
account 0, 1, 2, ...
  -> same role after migration
  -> all are healthy REST capacity resources
  -> request priority, not account identity, decides user protection
```

Background reservation:

```text
usable accounts for this cooldown_key = 3
background may lease at most 2 at once
one account remains available for user_visible bursts

healthy accounts = 3, but only 1 usable for this cooldown_key
background waits and preserves that final usable account

if user_visible is already queued
  -> do not start a new background request

background aging:
  -> not included
  -> background can wait indefinitely while user_visible work continues
  -> scheduler snapshot exposes why background was deferred
```

Cooldown behavior:

```text
account 2 gets EGW00201 on endpoint=past-minute, venue=KRX
  -> cooldown only (2, past-minute, KRX)
  -> accounts 0, 1, 3 can still serve past-minute/KRX
```

All accounts blocked:

```text
eligible accounts = [0, 1, 2]
all have active cooldown for (past-minute, KRX)
  -> scheduler raises KisCapacityCooldown
  -> route returns rate_limit_aborted
```

---

## Interfaces

```python
# hoga/live/kis_account_pool.py
from __future__ import annotations

from collections.abc import Hashable
from dataclasses import dataclass
from pathlib import Path
from hoga.live.kis_client import KisClient

@dataclass(frozen=True)
class KisAccountLease:
    account_id: int
    client: KisClient


@dataclass(frozen=True)
class KisAccountSnapshot:
    account_id: int
    healthy: bool
    inflight: int
    cooldowns: dict[str, float]


class KisNoAccountAvailable(RuntimeError):
    pass


class KisAccountReservationDeferred(RuntimeError):
    pass


class KisAccountPool:
    def __init__(self, data_dir: Path, *, now: Callable[[], float] = time.monotonic) -> None: ...

    def configured_accounts(self) -> list[int]: ...

    def eligible_accounts(self) -> list[int]: ...

    def cooldown_active(self, account_id: int, cooldown_key: Hashable) -> bool: ...

    def mark_cooldown(self, account_id: int, cooldown_key: Hashable, seconds: float) -> None: ...

    async def lease(
        self,
        *,
        cooldown_key: Hashable | None,
        reserve_one: bool = False,
    ) -> KisAccountLease: ...

    def release(self, account_id: int) -> None: ...

    def snapshot(self) -> list[KisAccountSnapshot]: ...
```

```python
# hoga/live/kis_capacity_scheduler.py
from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from typing import Literal, TypeVar

from hoga.live.kis_account_pool import KisAccountPool
from hoga.live.kis_client import KisClient

_T = TypeVar("_T")
KisRequestPriority = Literal["user_visible", "background"]


class KisCapacityCooldown(RuntimeError):
    """Raised when every eligible account is cooling down for this request."""


class KisCapacityOverloaded(RuntimeError):
    """Raised when the scheduler cannot accept another unique pending request."""


class KisCapacityScheduler:
    def __init__(
        self,
        *,
        name: str,
        account_pool: KisAccountPool,
        max_workers: int,
        max_pending_requests: int,
        account_cooldown_s: float,
    ) -> None: ...

    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: KisRequestPriority,
        call: Callable[[KisClient], Awaitable[_T]],
        cooldown_scope: Hashable | None = None,
    ) -> _T: ...

    def snapshot(self) -> dict[str, object]: ...

    async def aclose(self) -> None: ...
```

```python
# hoga/live/kis_capacity_runtime.py
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from hoga.live.kis_capacity_scheduler import KisCapacityScheduler


def max_workers_for_account_count(
    account_count: int,
    env: Mapping[str, str] | None = None,
) -> int: ...


def max_pending_requests_from_env(env: Mapping[str, str] | None = None) -> int: ...


def ensure_kis_capacity_scheduler(data_dir: Path) -> KisCapacityScheduler: ...


async def aclose_kis_capacity_scheduler(data_dir: Path | None = None) -> None: ...
```

Request cooldown key construction:

```python
cooldown_key = (endpoint, cooldown_scope)
```

Account cooldown storage:

```python
_cooldown_until[(account_id, cooldown_key)] = until_monotonic
```

---

### Task 1: Add `KisAccountPool`

**Files:**
- Create: `hoga/live/kis_account_pool.py`
- Create: `tests/unit/live/test_kis_account_pool.py`

**Interfaces:**
- Produces: `KisAccountPool`, `KisAccountLease`, `KisNoAccountAvailable`, `KisAccountReservationDeferred`
- Consumes: `kis_runtime.configured_account_ids`, `kis_runtime.ensure_kis_client_for_account`, `account_health.is_rest_degraded`

- [ ] **Step 1: Write failing tests for account discovery and eligibility**

Add `tests/unit/live/test_kis_account_pool.py`:

```python
from pathlib import Path

from hoga.live.kis_account_pool import KisAccountPool


def test_account_pool_discovers_configured_accounts(tmp_path: Path, monkeypatch) -> None:
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2])

    pool = KisAccountPool(tmp_path)

    assert pool.configured_accounts() == [0, 1, 2]


def test_account_pool_does_not_hot_reload_configured_accounts(tmp_path: Path, monkeypatch) -> None:
    from hoga.live import kis_runtime

    account_ids = [0, 1]
    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: account_ids)
    pool = KisAccountPool(tmp_path)

    account_ids.append(2)

    assert pool.configured_accounts() == [0, 1]


def test_account_pool_eligibility_filters_degraded_accounts(tmp_path: Path, monkeypatch) -> None:
    from hoga.live import account_health, kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2])
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: account_id == 2)
    pool = KisAccountPool(tmp_path)

    assert pool.eligible_accounts() == [0, 1]
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_account_pool.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'hoga.live.kis_account_pool'
```

- [ ] **Step 3: Implement account discovery and eligibility**

Create `hoga/live/kis_account_pool.py`:

```python
from __future__ import annotations

import time
from collections.abc import Callable, Hashable
from dataclasses import dataclass
from pathlib import Path

from hoga.live import account_health, kis_runtime
from hoga.live.kis_client import KisClient

@dataclass(frozen=True)
class KisAccountLease:
    account_id: int
    client: KisClient


@dataclass(frozen=True)
class KisAccountSnapshot:
    account_id: int
    healthy: bool
    inflight: int
    cooldowns: dict[str, float]


class KisNoAccountAvailable(RuntimeError):
    pass


class KisAccountReservationDeferred(RuntimeError):
    pass


class KisAccountPool:
    def __init__(self, data_dir: Path, *, now: Callable[[], float] = time.monotonic) -> None:
        self._data_dir = data_dir
        self._account_ids = tuple(kis_runtime.configured_account_ids(data_dir))
        self._now = now
        self._inflight: dict[int, int] = {}
        self._cooldown_until: dict[tuple[int, Hashable], float] = {}

    def configured_accounts(self) -> list[int]:
        return list(self._account_ids)

    def eligible_accounts(self) -> list[int]:
        configured = self.configured_accounts()
        return [a for a in configured if not account_health.is_rest_degraded(a)]

    def cooldown_active(self, account_id: int, cooldown_key: Hashable) -> bool:
        return self._now() < self._cooldown_until.get((account_id, cooldown_key), 0.0)

    def mark_cooldown(self, account_id: int, cooldown_key: Hashable, seconds: float) -> None:
        self._cooldown_until[(account_id, cooldown_key)] = max(
            self._cooldown_until.get((account_id, cooldown_key), 0.0),
            self._now() + seconds,
        )
```

- [ ] **Step 4: Run tests and confirm GREEN**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_account_pool.py -q
```

Expected:

```text
all selected tests passed
```

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_account_pool.py tests/unit/live/test_kis_account_pool.py
git commit -m "feat(live): add KIS account pool"
```

---

### Task 2: Add Account Leasing, Cooldown, And Snapshots

**Files:**
- Modify: `hoga/live/kis_account_pool.py`
- Modify: `tests/unit/live/test_kis_account_pool.py`

**Interfaces:**
- Consumes: `KisAccountPool.eligible_accounts(...)`
- Produces: `lease(...)`, `release(...)`, `snapshot(...)`

- [ ] **Step 1: Add failing tests for least-loaded leasing and cooldown**

Append to `tests/unit/live/test_kis_account_pool.py`:

```python
import pytest

from hoga.live.kis_account_pool import KisAccountReservationDeferred, KisNoAccountAvailable


class _FakeKis:
    pass


@pytest.mark.asyncio
async def test_account_pool_leases_least_loaded_account(tmp_path, monkeypatch) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis(), 2: _FakeKis()}
    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2])
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_for_account", lambda account_id, data_dir: clients[account_id])
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path)

    l0 = await pool.lease(cooldown_key=("past-minute", "KRX"))
    l1 = await pool.lease(cooldown_key=("past-minute", "KRX"))
    pool.release(l0.account_id)
    l2 = await pool.lease(cooldown_key=("past-minute", "KRX"))

    assert [l0.account_id, l1.account_id, l2.account_id] == [0, 1, 0]


@pytest.mark.asyncio
async def test_account_pool_skips_account_with_matching_cooldown(tmp_path, monkeypatch) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis()}
    now = 100.0
    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1])
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_for_account", lambda account_id, data_dir: clients[account_id])
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path, now=lambda: now)
    pool.mark_cooldown(0, ("past-minute", "KRX"), 10.0)

    lease = await pool.lease(cooldown_key=("past-minute", "KRX"))

    assert lease.account_id == 1


@pytest.mark.asyncio
async def test_account_pool_raises_when_all_eligible_accounts_are_cooling(tmp_path, monkeypatch) -> None:
    from hoga.live import account_health, kis_runtime

    now = 100.0
    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1])
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path, now=lambda: now)
    pool.mark_cooldown(0, ("past-minute", "KRX"), 10.0)
    pool.mark_cooldown(1, ("past-minute", "KRX"), 10.0)

    with pytest.raises(KisNoAccountAvailable):
        await pool.lease(cooldown_key=("past-minute", "KRX"))


@pytest.mark.asyncio
async def test_account_pool_reserve_one_blocks_background_from_final_slot(tmp_path, monkeypatch) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis(), 2: _FakeKis()}
    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2])
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_for_account", lambda account_id, data_dir: clients[account_id])
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path)

    first = await pool.lease(cooldown_key=("quotes", "quotes"), reserve_one=True)
    second = await pool.lease(cooldown_key=("quotes", "quotes"), reserve_one=True)

    assert [first.account_id, second.account_id] == [0, 1]
    with pytest.raises(KisAccountReservationDeferred):
        await pool.lease(cooldown_key=("quotes", "quotes"), reserve_one=True)


@pytest.mark.asyncio
async def test_account_pool_reservation_uses_non_cooling_accounts_for_key(tmp_path, monkeypatch) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis(), 2: _FakeKis()}
    now = 100.0
    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2])
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_for_account", lambda account_id, data_dir: clients[account_id])
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path, now=lambda: now)
    pool.mark_cooldown(1, ("past-minute", "KRX"), 10.0)
    pool.mark_cooldown(2, ("past-minute", "KRX"), 10.0)

    with pytest.raises(KisAccountReservationDeferred):
        await pool.lease(cooldown_key=("past-minute", "KRX"), reserve_one=True)

    lease = await pool.lease(cooldown_key=("past-minute", "KRX"), reserve_one=False)
    assert lease.account_id == 0
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_account_pool.py -q
```

Expected:

```text
AttributeError: 'KisAccountPool' object has no attribute 'lease'
```

- [ ] **Step 3: Implement lease, release, and snapshot**

Add to `KisAccountPool`:

```python
    async def lease(
        self,
        *,
        cooldown_key: Hashable | None,
        reserve_one: bool = False,
    ) -> KisAccountLease:
        eligible = self.eligible_accounts()
        candidates = eligible
        if cooldown_key is not None:
            candidates = [
                a for a in candidates
                if not self.cooldown_active(a, cooldown_key)
            ]
        if reserve_one and len(eligible) >= 2:
            free_candidates = [
                a for a in candidates
                if self._inflight.get(a, 0) == 0
            ]
            if len(free_candidates) <= 1:
                raise KisAccountReservationDeferred("reserved user-visible KIS account capacity")
        if not candidates:
            raise KisNoAccountAvailable("no eligible KIS account available")
        candidates.sort(key=lambda a: (self._inflight.get(a, 0), a))
        account_id = candidates[0]
        client = kis_runtime.ensure_kis_client_for_account(account_id, self._data_dir)
        if client is None:
            raise KisNoAccountAvailable(f"KIS account {account_id} credentials missing")
        self._inflight[account_id] = self._inflight.get(account_id, 0) + 1
        return KisAccountLease(account_id=account_id, client=client)

    def release(self, account_id: int) -> None:
        current = self._inflight.get(account_id, 0)
        if current <= 1:
            self._inflight.pop(account_id, None)
        else:
            self._inflight[account_id] = current - 1

    def snapshot(self) -> list[KisAccountSnapshot]:
        now = self._now()
        out: list[KisAccountSnapshot] = []
        for account_id in self.configured_accounts():
            cooldowns = {
                str(key): max(0.0, until - now)
                for (aid, key), until in self._cooldown_until.items()
                if aid == account_id and until > now
            }
            out.append(KisAccountSnapshot(
                account_id=account_id,
                healthy=not account_health.is_rest_degraded(account_id),
                inflight=self._inflight.get(account_id, 0),
                cooldowns=cooldowns,
            ))
        return out
```

- [ ] **Step 4: Run tests and confirm GREEN**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_account_pool.py -q
```

Expected:

```text
all selected tests passed
```

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_account_pool.py tests/unit/live/test_kis_account_pool.py
git commit -m "feat(live): lease KIS accounts by capacity"
```

---

### Task 3: Add `KisCapacityScheduler`

**Files:**
- Create: `hoga/live/kis_capacity_scheduler.py`
- Create: `tests/unit/live/test_kis_capacity_scheduler.py`

**Interfaces:**
- Consumes: `KisAccountPool.lease(...)`, `release(...)`, `mark_cooldown(...)`
- Produces: `KisCapacityScheduler.submit(...)`, `KisCapacityCooldown`

- [ ] **Step 1: Add failing scheduler tests**

Create `tests/unit/live/test_kis_capacity_scheduler.py`:

```python
import asyncio

import pytest

from hoga.live.kis_account_pool import (
    KisAccountLease,
    KisAccountReservationDeferred,
    KisNoAccountAvailable,
)
from hoga.live.kis_capacity_scheduler import (
    KisCapacityCooldown,
    KisCapacityOverloaded,
    KisCapacityScheduler,
)
from hoga.live.kis_client import KisRateLimitError


class _FakeKis:
    def __init__(self, account_id: int) -> None:
        self.account_id = account_id


class _FakePool:
    def __init__(self) -> None:
        self.clients = [_FakeKis(0), _FakeKis(1)]
        self.next = 0
        self.released: list[int] = []
        self.cooldowns: list[tuple[int, object, float]] = []

    async def lease(self, *, cooldown_key, reserve_one=False):
        client = self.clients[self.next % len(self.clients)]
        self.next += 1
        return KisAccountLease(account_id=client.account_id, client=client)

    def release(self, account_id: int) -> None:
        self.released.append(account_id)

    def mark_cooldown(self, account_id: int, cooldown_key, seconds: float) -> None:
        self.cooldowns.append((account_id, cooldown_key, seconds))

    def snapshot(self):
        return []


@pytest.mark.asyncio
async def test_capacity_scheduler_injects_leased_client_and_releases_account() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(name="test", account_pool=pool, max_workers=1, max_pending_requests=1000, account_cooldown_s=10.0)

    result = await scheduler.submit(
        key=("k", 1),
        endpoint="past-minute",
        priority="user_visible",
        cooldown_scope="KRX",
        call=lambda kis: asyncio.sleep(0, result=kis.account_id),
    )

    assert result == 0
    assert pool.released == [0]
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_coalesces_same_key() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(name="test", account_pool=pool, max_workers=1, max_pending_requests=1000, account_cooldown_s=10.0)
    calls = 0

    async def call(kis):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return kis.account_id

    r1, r2 = await asyncio.gather(
        scheduler.submit(key="same", endpoint="past-minute", priority="user_visible", cooldown_scope="KRX", call=call),
        scheduler.submit(key="same", endpoint="past-minute", priority="user_visible", cooldown_scope="KRX", call=call),
    )

    assert (r1, r2) == (0, 0)
    assert calls == 1
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_rejects_new_unique_request_when_pending_full() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(name="test", account_pool=pool, max_workers=1, max_pending_requests=1, account_cooldown_s=10.0)
    release_first = asyncio.Event()

    async def first(kis):
        await release_first.wait()
        return "first"

    first_task = asyncio.create_task(
        scheduler.submit(key="first", endpoint="test", priority="user_visible", call=first)
    )
    await asyncio.sleep(0)

    with pytest.raises(KisCapacityOverloaded):
        await scheduler.submit(
            key="second",
            endpoint="test",
            priority="user_visible",
            call=lambda kis: asyncio.sleep(0, result="second"),
        )
    assert scheduler.snapshot()["overloaded_rejections"] == 1

    release_first.set()
    assert await first_task == "first"
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_promotes_queued_background_when_user_visible_coalesces() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(name="test", account_pool=pool, max_workers=1, max_pending_requests=1000, account_cooldown_s=10.0)
    release_first = asyncio.Event()
    order: list[str] = []

    async def first(kis):
        order.append("first")
        await release_first.wait()
        return "first"

    async def shared_background(kis):
        order.append("shared")
        return "shared"

    first_task = asyncio.create_task(
        scheduler.submit(key="first", endpoint="test", priority="user_visible", call=first)
    )
    await asyncio.sleep(0)
    background_task = asyncio.create_task(
        scheduler.submit(key="shared", endpoint="daily", priority="background", call=shared_background)
    )
    await asyncio.sleep(0)
    user_task = asyncio.create_task(
        scheduler.submit(key="shared", endpoint="daily", priority="user_visible", call=lambda kis: asyncio.sleep(0, result="ignored"))
    )

    release_first.set()
    assert await first_task == "first"
    assert await user_task == "shared"
    assert await background_task == "shared"
    assert order == ["first", "shared"]

    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_marks_account_cooldown_on_rate_limit() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(name="test", account_pool=pool, max_workers=1, max_pending_requests=1000, account_cooldown_s=10.0)

    async def limited(kis):
        raise KisRateLimitError("EGW00201 rate limited")

    with pytest.raises(KisRateLimitError):
        await scheduler.submit(key="limited", endpoint="past-minute", priority="user_visible", cooldown_scope="KRX", call=limited)

    assert pool.cooldowns == [(0, ("past-minute", "KRX"), 10.0)]
    assert pool.released == [0]
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_translates_no_account_to_capacity_cooldown() -> None:
    class _NoAccountPool(_FakePool):
        async def lease(self, *, cooldown_key, reserve_one=False):
            raise KisNoAccountAvailable("all cooling")

    scheduler = KisCapacityScheduler(name="test", account_pool=_NoAccountPool(), max_workers=1, max_pending_requests=1000, account_cooldown_s=10.0)

    with pytest.raises(KisCapacityCooldown):
        await scheduler.submit(key="blocked", endpoint="past-minute", priority="user_visible", cooldown_scope="KRX", call=lambda kis: asyncio.sleep(0))

    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_does_not_start_background_while_user_visible_is_queued() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(name="test", account_pool=pool, max_workers=1, max_pending_requests=1000, account_cooldown_s=10.0)
    release_first = asyncio.Event()
    order: list[str] = []

    async def first(kis):
        order.append("first")
        await release_first.wait()
        return "first"

    async def background(kis):
        order.append("background")
        return "background"

    async def user_visible(kis):
        order.append("user_visible")
        return "user_visible"

    first_task = asyncio.create_task(
        scheduler.submit(key="first", endpoint="test", priority="user_visible", call=first)
    )
    await asyncio.sleep(0)
    background_task = asyncio.create_task(
        scheduler.submit(key="background", endpoint="test", priority="background", call=background)
    )
    user_task = asyncio.create_task(
        scheduler.submit(key="user", endpoint="test", priority="user_visible", call=user_visible)
    )

    release_first.set()
    assert await first_task == "first"
    assert await user_task == "user_visible"
    assert await background_task == "background"
    assert order == ["first", "user_visible", "background"]

    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_snapshot_reports_background_deferrals() -> None:
    class _ReservedPool(_FakePool):
        async def lease(self, *, cooldown_key, reserve_one=False):
            if reserve_one:
                raise KisAccountReservationDeferred("reserved user-visible KIS account capacity")
            return await super().lease(cooldown_key=cooldown_key, reserve_one=reserve_one)

    scheduler = KisCapacityScheduler(name="test", account_pool=_ReservedPool(), max_workers=1, max_pending_requests=1000, account_cooldown_s=10.0)

    task = asyncio.create_task(scheduler.submit(
        key="background",
        endpoint="quotes",
        priority="background",
        cooldown_scope="quotes",
        call=lambda kis: asyncio.sleep(0),
    ))
    await asyncio.sleep(0.02)

    snap = scheduler.snapshot()
    assert snap["background_deferred_due_to_reserved_capacity"] == 1
    assert snap["background_deferred_due_to_user_visible"] == 0
    assert not task.done()
    task.cancel()
    await scheduler.aclose()
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_capacity_scheduler.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'hoga.live.kis_capacity_scheduler'
```

- [ ] **Step 3: Implement scheduler**

Create `hoga/live/kis_capacity_scheduler.py`:

```python
from __future__ import annotations

import asyncio
import itertools
import logging
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass, field
from typing import Generic, Literal, TypeVar

from hoga.live.kis_account_pool import (
    KisAccountPool,
    KisAccountReservationDeferred,
    KisNoAccountAvailable,
)
from hoga.live.kis_client import KisClient, KisRateLimitError

log = logging.getLogger(__name__)
_T = TypeVar("_T")
KisRequestPriority = Literal["user_visible", "background"]


class KisCapacityCooldown(RuntimeError):
    """Raised when every eligible account is cooling down for this request."""


class KisCapacityOverloaded(RuntimeError):
    """Raised when the scheduler cannot accept another unique pending request."""


@dataclass(order=True)
class _ScheduledRequest(Generic[_T]):
    rank: int
    seq: int
    key: Hashable = field(compare=False)
    generation: int = field(compare=False)
    endpoint: str = field(compare=False)
    cooldown_key: Hashable | None = field(compare=False)
    call: Callable[[KisClient], Awaitable[_T]] = field(compare=False)
    future: asyncio.Future[_T] = field(compare=False)


class KisCapacityScheduler:
    def __init__(
        self,
        *,
        name: str,
        account_pool: KisAccountPool,
        max_workers: int,
        max_pending_requests: int,
        account_cooldown_s: float,
    ) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be positive")
        if max_pending_requests <= 0:
            raise ValueError("max_pending_requests must be positive")
        if account_cooldown_s < 0:
            raise ValueError("account_cooldown_s must be non-negative")
        self._name = name
        self._account_pool = account_pool
        self._max_workers = max_workers
        self._max_pending_requests = max_pending_requests
        self._account_cooldown_s = float(account_cooldown_s)
        self._queue: asyncio.PriorityQueue[_ScheduledRequest] = asyncio.PriorityQueue()
        self._inflight: dict[Hashable, asyncio.Future] = {}
        self._queued_priorities: dict[Hashable, KisRequestPriority] = {}
        self._request_generations: dict[Hashable, int] = {}
        self._request_calls: dict[Hashable, Callable[[KisClient], Awaitable]] = {}
        self._request_endpoints: dict[Hashable, str] = {}
        self._request_cooldown_keys: dict[Hashable, Hashable | None] = {}
        self._started_keys: set[Hashable] = set()
        self._background_deferred_due_to_user_visible = 0
        self._background_deferred_due_to_reserved_capacity = 0
        self._overloaded_rejections = 0
        self._seq = itertools.count()
        self._workers: list[asyncio.Task[None]] = []
        self._closed = False

    def _ensure_started(self) -> None:
        if self._workers:
            return
        self._workers = [
            asyncio.create_task(self._worker(), name=f"kis-capacity:{self._name}:{i}")
            for i in range(self._max_workers)
        ]

    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: KisRequestPriority,
        call: Callable[[KisClient], Awaitable[_T]],
        cooldown_scope: Hashable | None = None,
    ) -> _T:
        if self._closed:
            raise RuntimeError("KisCapacityScheduler is closed")
        existing = self._inflight.get(key)
        if existing is not None:
            if (
                priority == "user_visible"
                and self._queued_priorities.get(key) == "background"
                and key not in self._started_keys
            ):
                generation = self._request_generations.get(key, 0) + 1
                self._request_generations[key] = generation
                self._queued_priorities[key] = "user_visible"
                existing_call = self._request_calls[key]
                existing_endpoint = self._request_endpoints[key]
                existing_cooldown_key = self._request_cooldown_keys[key]
                await self._queue.put(_ScheduledRequest(
                    0,
                    next(self._seq),
                    key,
                    generation,
                    existing_endpoint,
                    existing_cooldown_key,
                    existing_call,
                    existing,
                ))
            return await asyncio.shield(existing)

        if len(self._inflight) >= self._max_pending_requests:
            self._overloaded_rejections += 1
            raise KisCapacityOverloaded("KIS capacity scheduler pending request limit reached")

        loop = asyncio.get_running_loop()
        future: asyncio.Future[_T] = loop.create_future()
        self._inflight[key] = future
        self._queued_priorities[key] = priority
        self._request_generations[key] = 0
        cooldown_key = (endpoint, cooldown_scope)
        self._request_calls[key] = call
        self._request_endpoints[key] = endpoint
        self._request_cooldown_keys[key] = cooldown_key
        rank = 0 if priority == "user_visible" else 10
        request = _ScheduledRequest(
            rank,
            next(self._seq),
            key,
            0,
            endpoint,
            cooldown_key,
            call,
            future,
        )
        self._ensure_started()
        await self._queue.put(request)
        return await asyncio.shield(future)

    async def _worker(self) -> None:
        while True:
            request = await self._queue.get()
            if request.future.done():
                self._inflight.pop(request.key, None)
                self._queued_priorities.pop(request.key, None)
                self._request_generations.pop(request.key, None)
                self._request_calls.pop(request.key, None)
                self._request_endpoints.pop(request.key, None)
                self._request_cooldown_keys.pop(request.key, None)
                self._started_keys.discard(request.key)
                self._queue.task_done()
                continue
            if request.generation != self._request_generations.get(request.key):
                self._queue.task_done()
                continue
            if request.rank > 0 and self._has_queued_user_visible():
                self._background_deferred_due_to_user_visible += 1
                await self._queue.put(request)
                self._queue.task_done()
                await asyncio.sleep(0)
                continue
            lease = None
            try:
                self._started_keys.add(request.key)
                lease = await self._account_pool.lease(
                    cooldown_key=request.cooldown_key,
                    reserve_one=request.rank > 0,
                )
                result = await request.call(lease.client)
            except KisAccountReservationDeferred:
                self._started_keys.discard(request.key)
                self._background_deferred_due_to_reserved_capacity += 1
                await self._queue.put(request)
                await asyncio.sleep(0.05)
            except KisNoAccountAvailable as exc:
                if request.rank > 0:
                    self._background_deferred_due_to_reserved_capacity += 1
                if not request.future.done():
                    request.future.set_exception(KisCapacityCooldown(str(exc)))
            except KisRateLimitError as exc:
                if lease is not None and request.cooldown_key is not None:
                    self._account_pool.mark_cooldown(
                        lease.account_id,
                        request.cooldown_key,
                        self._account_cooldown_s,
                    )
                    log.warning(
                        "KIS account cooldown scheduler=%s account=%s key=%r seconds=%.1f",
                        self._name,
                        lease.account_id,
                        request.cooldown_key,
                        self._account_cooldown_s,
                    )
                if not request.future.done():
                    request.future.set_exception(exc)
            except Exception as exc:
                if not request.future.done():
                    request.future.set_exception(exc)
            else:
                if not request.future.done():
                    request.future.set_result(result)
            finally:
                if lease is not None:
                    self._account_pool.release(lease.account_id)
                if not request.future.done() and lease is None:
                    self._queue.task_done()
                    continue
                self._inflight.pop(request.key, None)
                self._queued_priorities.pop(request.key, None)
                self._request_generations.pop(request.key, None)
                self._request_calls.pop(request.key, None)
                self._request_endpoints.pop(request.key, None)
                self._request_cooldown_keys.pop(request.key, None)
                self._started_keys.discard(request.key)
                self._queue.task_done()

    def _has_queued_user_visible(self) -> bool:
        return any(
            priority == "user_visible" and key not in self._started_keys
            for key, priority in self._queued_priorities.items()
        )

    def snapshot(self) -> dict[str, object]:
        account_snapshots = self._account_pool.snapshot()
        return {
            "name": self._name,
            "max_workers": self._max_workers,
            "max_pending_requests": self._max_pending_requests,
            "queued": self._queue.qsize(),
            "inflight": len(self._inflight),
            "configured_account_count": len(account_snapshots),
            "healthy_account_count": sum(1 for s in account_snapshots if s.healthy),
            "background_deferred_due_to_user_visible": self._background_deferred_due_to_user_visible,
            "background_deferred_due_to_reserved_capacity": self._background_deferred_due_to_reserved_capacity,
            "overloaded_rejections": self._overloaded_rejections,
            "accounts": [s.__dict__ for s in account_snapshots],
        }

    async def aclose(self) -> None:
        self._closed = True
        for worker in self._workers:
            worker.cancel()
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers = []
```

- [ ] **Step 4: Run tests and confirm GREEN**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_capacity_scheduler.py -q
```

Expected:

```text
all selected tests passed
```

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_capacity_scheduler.py tests/unit/live/test_kis_capacity_scheduler.py
git commit -m "feat(live): add account-aware KIS capacity scheduler"
```

---

### Task 4: Add Process-Wide Capacity Runtime

**Files:**
- Create: `hoga/live/kis_capacity_runtime.py`
- Create: `tests/unit/live/test_kis_capacity_runtime.py`

**Interfaces:**
- Consumes: `KisAccountPool`, `KisCapacityScheduler`
- Produces: process-wide scheduler lifecycle keyed by `data_dir`

- [ ] **Step 1: Add runtime tests**

Add tests in `tests/unit/live/test_kis_capacity_runtime.py`:

```python
def test_max_workers_for_account_count_scales_with_accounts() -> None:
    assert max_workers_for_account_count(0, {}) == 4
    assert max_workers_for_account_count(1, {}) == 8
    assert max_workers_for_account_count(2, {}) == 16
    assert max_workers_for_account_count(4, {}) == 32
    assert max_workers_for_account_count(8, {}) == 64
    assert max_workers_for_account_count(16, {}) == 64


def test_max_workers_for_account_count_accepts_env_override() -> None:
    assert max_workers_for_account_count(
        4,
        {"HOGA_KIS_CAPACITY_MAX_WORKERS": "12"},
    ) == 12


def test_max_workers_for_account_count_ignores_invalid_env_override() -> None:
    assert max_workers_for_account_count(
        2,
        {"HOGA_KIS_CAPACITY_MAX_WORKERS": "bad"},
    ) == 16
    assert max_workers_for_account_count(
        2,
        {"HOGA_KIS_CAPACITY_MAX_WORKERS": "0"},
    ) == 16
    assert max_workers_for_account_count(
        2,
        {"HOGA_KIS_CAPACITY_MAX_WORKERS": "-3"},
    ) == 16


def test_max_pending_requests_from_env_accepts_positive_override() -> None:
    assert max_pending_requests_from_env({"HOGA_KIS_CAPACITY_MAX_PENDING": "42"}) == 42


def test_max_pending_requests_from_env_ignores_invalid_override() -> None:
    assert max_pending_requests_from_env({}) == 1000
    assert max_pending_requests_from_env({"HOGA_KIS_CAPACITY_MAX_PENDING": "bad"}) == 1000
    assert max_pending_requests_from_env({"HOGA_KIS_CAPACITY_MAX_PENDING": "0"}) == 1000
    assert max_pending_requests_from_env({"HOGA_KIS_CAPACITY_MAX_PENDING": "-1"}) == 1000


def test_ensure_kis_capacity_scheduler_reuses_scheduler_for_same_data_dir(tmp_path) -> None:
    s1 = ensure_kis_capacity_scheduler(tmp_path)
    s2 = ensure_kis_capacity_scheduler(tmp_path)

    assert s1 is s2


def test_ensure_kis_capacity_scheduler_isolates_different_data_dirs(tmp_path) -> None:
    s1 = ensure_kis_capacity_scheduler(tmp_path / "one")
    s2 = ensure_kis_capacity_scheduler(tmp_path / "two")

    assert s1 is not s2


@pytest.mark.asyncio
async def test_existing_scheduler_does_not_hot_reload_worker_count(tmp_path, monkeypatch) -> None:
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0])
    s1 = ensure_kis_capacity_scheduler(tmp_path)
    assert s1.snapshot()["max_workers"] == 8

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2, 3])
    assert ensure_kis_capacity_scheduler(tmp_path) is s1
    assert s1.snapshot()["max_workers"] == 8

    await aclose_kis_capacity_scheduler(tmp_path)
    s2 = ensure_kis_capacity_scheduler(tmp_path)
    assert s2.snapshot()["max_workers"] == 32


@pytest.mark.asyncio
async def test_aclose_kis_capacity_scheduler_removes_scheduler(tmp_path) -> None:
    s1 = ensure_kis_capacity_scheduler(tmp_path)
    await aclose_kis_capacity_scheduler(tmp_path)
    s2 = ensure_kis_capacity_scheduler(tmp_path)

    assert s1 is not s2


@pytest.mark.asyncio
async def test_aclose_kis_capacity_scheduler_without_data_dir_closes_all(tmp_path) -> None:
    s1 = ensure_kis_capacity_scheduler(tmp_path / "one")
    s2 = ensure_kis_capacity_scheduler(tmp_path / "two")
    await aclose_kis_capacity_scheduler()

    assert ensure_kis_capacity_scheduler(tmp_path / "one") is not s1
    assert ensure_kis_capacity_scheduler(tmp_path / "two") is not s2
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_capacity_runtime.py -q
```

Expected:

```text
selected tests fail because runtime module does not exist yet
```

- [ ] **Step 3: Implement runtime**

Create `hoga/live/kis_capacity_runtime.py`:

```python
from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Mapping
from pathlib import Path

from hoga.live import kis_runtime
from hoga.live.kis_account_pool import KisAccountPool
from hoga.live.kis_capacity_scheduler import KisCapacityScheduler

_DEFAULT_WORKERS_PER_ACCOUNT = 8
_DEFAULT_MIN_WORKERS = 4
_DEFAULT_MAX_WORKERS = 64
_DEFAULT_MAX_PENDING_REQUESTS = 1000
_DEFAULT_ACCOUNT_COOLDOWN_S = 8.0

_schedulers: dict[Path, KisCapacityScheduler] = {}
_lock = asyncio.Lock()
log = logging.getLogger(__name__)


def _scheduler_key(data_dir: Path) -> Path:
    return data_dir.expanduser().resolve()


def max_workers_for_account_count(
    account_count: int,
    env: Mapping[str, str] | None = None,
) -> int:
    source = os.environ if env is None else env
    override = source.get("HOGA_KIS_CAPACITY_MAX_WORKERS")
    if override:
        try:
            parsed = int(override)
        except ValueError:
            log.warning("invalid HOGA_KIS_CAPACITY_MAX_WORKERS=%r; using account-based default", override)
        else:
            if parsed > 0:
                return parsed
            log.warning("non-positive HOGA_KIS_CAPACITY_MAX_WORKERS=%r; using account-based default", override)
    return max(
        _DEFAULT_MIN_WORKERS,
        min(_DEFAULT_MAX_WORKERS, max(0, account_count) * _DEFAULT_WORKERS_PER_ACCOUNT),
    )


def _max_workers_for_data_dir(data_dir: Path) -> int:
    account_count = len(kis_runtime.configured_account_ids(data_dir))
    return max_workers_for_account_count(account_count)


def max_pending_requests_from_env(env: Mapping[str, str] | None = None) -> int:
    source = os.environ if env is None else env
    override = source.get("HOGA_KIS_CAPACITY_MAX_PENDING")
    if override:
        try:
            parsed = int(override)
        except ValueError:
            log.warning("invalid HOGA_KIS_CAPACITY_MAX_PENDING=%r; using default", override)
        else:
            if parsed > 0:
                return parsed
            log.warning("non-positive HOGA_KIS_CAPACITY_MAX_PENDING=%r; using default", override)
    return _DEFAULT_MAX_PENDING_REQUESTS


async def ensure_kis_capacity_scheduler_async(data_dir: Path) -> KisCapacityScheduler:
    key = _scheduler_key(data_dir)
    async with _lock:
        scheduler = _schedulers.get(key)
        if scheduler is None:
            scheduler = KisCapacityScheduler(
                name="kis-capacity",
                account_pool=KisAccountPool(key),
                max_workers=_max_workers_for_data_dir(key),
                max_pending_requests=max_pending_requests_from_env(),
                account_cooldown_s=_DEFAULT_ACCOUNT_COOLDOWN_S,
            )
            _schedulers[key] = scheduler
        return scheduler


def ensure_kis_capacity_scheduler(data_dir: Path) -> KisCapacityScheduler:
    key = _scheduler_key(data_dir)
    scheduler = _schedulers.get(key)
    if scheduler is None:
        scheduler = KisCapacityScheduler(
            name="kis-capacity",
            account_pool=KisAccountPool(key),
            max_workers=_max_workers_for_data_dir(key),
            max_pending_requests=max_pending_requests_from_env(),
            account_cooldown_s=_DEFAULT_ACCOUNT_COOLDOWN_S,
        )
        _schedulers[key] = scheduler
    return scheduler


async def aclose_kis_capacity_scheduler(data_dir: Path | None = None) -> None:
    if data_dir is None:
        schedulers = list(_schedulers.values())
        _schedulers.clear()
    else:
        scheduler = _schedulers.pop(_scheduler_key(data_dir), None)
        schedulers = [scheduler] if scheduler is not None else []
    await asyncio.gather(*(s.aclose() for s in schedulers), return_exceptions=True)
```

Do not store route-specific state in this module. It owns only shared capacity lifecycle.

- [ ] **Step 4: Run tests and confirm GREEN**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_capacity_runtime.py -q
```

Expected:

```text
all selected tests passed
```

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_capacity_runtime.py tests/unit/live/test_kis_capacity_runtime.py
git commit -m "feat(live): add KIS capacity scheduler runtime"
```

---

### Task 5: Wire Capacity Runtime Into App Shutdown

**Files:**
- Modify: `hoga/api/startup_runtime.py`
- Modify: `hoga/api/app.py`
- Modify: `tests/api/test_startup_runtime.py`

**Interfaces:**
- Consumes: `aclose_kis_capacity_scheduler(data_dir=None)`
- Produces: deterministic shutdown of scheduler workers before `KisClient` teardown

- [ ] **Step 1: Add shutdown-order tests**

Update existing `StartupRuntimeDeps(...)` test fixtures in `tests/api/test_startup_runtime.py` with a new dependency:

```python
aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-kis-capacity", None),
```

Then assert the shutdown order in `test_startup_runtime_starts_safe_default_tasks`:

```python
assert calls.index(("close-kis-capacity", None)) < calls.index(("close-kis", None))
```

Also assert partial-start cleanup closes capacity before `KisClient`:

```python
assert calls.index(("close-kis-capacity", None)) < calls.index(("close-kis", None))
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
uv run --extra dev python -m pytest tests/api/test_startup_runtime.py -q
```

Expected:

```text
selected tests fail because StartupRuntimeDeps does not accept aclose_kis_capacity_scheduler yet
```

- [ ] **Step 3: Implement shutdown wiring**

In `hoga/api/startup_runtime.py`, add the dependency:

```python
@dataclass(frozen=True)
class StartupRuntimeDeps:
    ...
    aclose_kis_capacity_scheduler: Callable[[], Awaitable[None]]
    aclose_kis_client: Callable[[], Awaitable[None]]
```

Call it in shutdown after scheduler/background tasks have been cancelled and before closing `KisClient`:

```python
        await self.deps.aclose_kis_capacity_scheduler()
        await self.deps.aclose_kis_client()
```

In `hoga/api/app.py`, import and wire the runtime close function:

```python
from hoga.live.kis_capacity_runtime import aclose_kis_capacity_scheduler
```

```python
startup_runtime = await start_app_runtime(
    data_dir,
    deps=StartupRuntimeDeps(
        ...
        aclose_kis_capacity_scheduler=lambda: aclose_kis_capacity_scheduler(),
        aclose_kis_client=aclose_kis_client,
        ...
    ),
)
```

Keep `aclose_kis_capacity_scheduler(data_dir=None)` as the app-level shutdown behavior so every scheduler created in the process is closed. Unit tests that create runtime schedulers directly should call the same no-arg close in teardown/fixtures for isolation.

- [ ] **Step 4: Run tests and confirm GREEN**

```bash
uv run --extra dev python -m pytest tests/api/test_startup_runtime.py tests/unit/live/test_kis_capacity_runtime.py -q
```

Expected:

```text
all selected tests passed
```

- [ ] **Step 5: Commit**

```bash
git add hoga/api/startup_runtime.py hoga/api/app.py tests/api/test_startup_runtime.py
git commit -m "fix(live): close KIS capacity scheduler on app shutdown"
```

---

### Task 6: Wire Capacity Scheduler Into `/api/live/past-candles`

**Files:**
- Modify: `hoga/live/api.py`
- Modify: `tests/unit/live/test_api.py`

**Interfaces:**
- Consumes: `KisCapacityScheduler.submit(...)`
- Produces: past-candles route using account-aware scheduling

- [ ] **Step 1: Add route tests**

Add tests near existing past-candles tests in `tests/unit/live/test_api.py`:

```python
@pytest.mark.asyncio
async def test_past_candles_capacity_scheduler_coalesces_same_date_across_requests(tmp_path) -> None:
    import asyncio as _asyncio
    import httpx

    class _SlowFakeKis:
        def __init__(self):
            self.calls = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append((code, date_yyyymmdd))
            await _asyncio.sleep(0.05)
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    fake = _SlowFakeKis()
    app = _past_app(tmp_path, fake)
    transport = httpx.ASGITransport(app=app)
    url = "/api/live/past-candles?code=005930&from=20260501&to=20260501"
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r1, r2 = await _asyncio.gather(ac.get(url), ac.get(url))

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert fake.calls == [("005930", "20260501")]
```

Add a cooldown follow-up test:

```python
def test_past_candles_capacity_scheduler_returns_rate_limit_aborted_when_all_accounts_cooling(tmp_path) -> None:
    class _LimitedKis:
        def __init__(self):
            self.calls = 0

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls += 1
            raise KisRateLimitError("EGW00201 rate limited")

    fake = _LimitedKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r1 = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260501")
        r2 = c.get("/api/live/past-candles?code=005930&from=20260502&to=20260502")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert any(w["reason"] == "kis_rate_limit" for w in r1.json()["data_warnings"])
    assert any(w["reason"] == "rate_limit_aborted" for w in r2.json()["data_warnings"])
    assert fake.calls == 1
```

Add a status observability test:

```python
def test_live_status_includes_kis_capacity_scheduler_snapshot(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKis())

    with TestClient(app) as c:
        r = c.get("/api/live/status")

    assert r.status_code == 200
    scheduler = r.json()["kis_capacity_scheduler"]
    assert scheduler["max_workers"] >= 4
    assert scheduler["max_pending_requests"] == 1000
    assert "configured_account_count" in scheduler
    assert "healthy_account_count" in scheduler
    assert "queued" in scheduler
    assert "inflight" in scheduler
    assert "overloaded_rejections" in scheduler
    assert "background_deferred_due_to_user_visible" in scheduler
    assert "background_deferred_due_to_reserved_capacity" in scheduler
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_api.py -k "past_candles_capacity_scheduler" -q
```

Expected:

```text
selected tests fail because route still uses route-local controls
```

- [ ] **Step 3: Replace route-local controls**

In `hoga/live/api.py`, import:

```python
from hoga.live.kis_capacity_runtime import ensure_kis_capacity_scheduler
from hoga.live.kis_capacity_scheduler import KisCapacityCooldown, KisCapacityOverloaded
```

Inside `build_router`, obtain the process-wide scheduler after `data_dir` is known:

```python
_kis_scheduler = ensure_kis_capacity_scheduler(data_dir) if data_dir is not None else None
```

Include the scheduler snapshot in `/api/live/status`:

```python
"kis_capacity_scheduler": _kis_scheduler.snapshot() if _kis_scheduler is not None else None,
```

Replace `_fetch_past_shared` with:

```python
async def _fetch_past_scheduled(
    venue: KisVenue,
    code: str,
    date_s: str,
) -> tuple[list[dict], str | None]:
    if _kis_scheduler is None:
        raise HTTPException(503, "KIS scheduler not wired")

    async def _do(kis: KisClient) -> tuple[list[dict], str | None]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=True,
        )
        bars = [_candle_to_dict(c) for c in raw]
        try:
            cache_instance.store_past(venue, code, date_s, bars)  # type: ignore[union-attr]
        except OSError as e:
            return bars, str(e)
        return bars, None

    return await _kis_scheduler.submit(
        key=("live-candle-backfill", "minute", venue, code, date_s),
        endpoint="past-minute",
        priority="user_visible",
        cooldown_scope=venue,
        call=_do,
    )
```

In pending-date and today paths, translate exceptions:

```python
except KisCapacityOverloaded:
    warnings_by_date[date_s] = {"date": date_s, "reason": "capacity_overloaded", "msg": "KIS capacity scheduler pending request limit reached"}
    return
except KisCapacityCooldown:
    warnings_by_date[date_s] = _past_rate_limit_aborted_warning(date_s)
    return
except KisRateLimitError as e:
    blocked.set()
    warnings_by_date[date_s] = {"date": date_s, "reason": "kis_rate_limit", "msg": str(e)}
    return
```

Keep cache hit, AUTO merge, and weekend today skip behavior unchanged.

- [ ] **Step 4: Run focused tests**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_account_pool.py tests/unit/live/test_kis_capacity_scheduler.py tests/unit/live/test_api.py -k "past_candles or minute_today" -q
```

Expected:

```text
all selected tests passed
```

- [ ] **Step 5: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "refactor(live): route past candles through KIS capacity scheduler"
```

---

### Task 7: Migrate Daily Candles, Quotes, And Investor Estimate

**Files:**
- Modify: `hoga/live/api.py`
- Modify: `tests/unit/live/test_api.py`
- Modify: `tests/unit/live/test_live_quote_fetcher.py` if constructor signatures change

**Interfaces:**
- Consumes: shared `_kis_scheduler`
- Produces: all `/api/live` REST KIS routes use scheduler account allocation

- [ ] **Step 1: Add daily scheduler tests**

Add to `tests/unit/live/test_api.py`:

```python
def test_past_daily_capacity_scheduler_cooldown_blocks_followup(tmp_path) -> None:
    fake = _FakeKisForDaily()
    fake.raise_rate_limit_on_call = 0
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r1 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240106&to=20240110")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert any(w["reason"] == "kis_rate_limit" for w in r1.json()["data_warnings"])
    assert any(w["reason"] == "rate_limit_aborted" for w in r2.json()["data_warnings"])
```

Add quote degradation test:

```python
def test_quotes_capacity_scheduler_cooldown_degrades_to_empty(tmp_path) -> None:
    class _LimitedQuotesKis:
        async def fetch_multi_price(self, codes):
            raise KisRateLimitError("EGW00201 rate limited")

    app = _quotes_app(tmp_path, _LimitedQuotesKis())
    with TestClient(app) as c:
        c.get("/api/live/quotes?codes=005930")
        r = c.get("/api/live/quotes?codes=000660")

    assert r.status_code == 200
    assert r.json()["quotes"] == []
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_api.py -k "capacity_scheduler and (daily or quotes)" -q
```

Expected:

```text
selected tests fail because daily and quotes are not routed through scheduler
```

- [ ] **Step 3: Schedule daily candle fetches**

In daily `fetch_batch`, replace direct `kis.fetch_past_daily_candles(...)` with:

```python
async def _fetch_daily_once(kis: KisClient, venue_: KisVenue):
    return await kis.fetch_past_daily_candles(
        code_,
        from_s,
        to_s,
        venue=venue_,
        foreground=True,
    )

try:
    result = await _kis_scheduler.submit(
        key=("live-candle-backfill", "daily", kis_venue, code_, from_s, to_s),
        endpoint="past-daily",
        priority="user_visible",
        cooldown_scope=kis_venue,
        call=lambda kis: _fetch_daily_once(kis, kis_venue),
    )
except (KisCapacityCooldown, KisCapacityOverloaded) as e:
    raise KisRateLimitError(str(e)) from e
```

For KRX fallback, use separate key/scope:

```python
fallback = await _kis_scheduler.submit(
    key=("live-candle-backfill", "daily", "KRX", code_, from_s, to_s, "fallback"),
    endpoint="past-daily",
    priority="user_visible",
    cooldown_scope="KRX",
    call=lambda kis: _fetch_daily_once(kis, "KRX"),
)
```

- [ ] **Step 4: Schedule quotes and investor estimate**

Quotes:

```python
try:
    quotes = await asyncio.wait_for(
        asyncio.shield(_kis_scheduler.submit(
            key=("quotes", tuple(sorted(code_list)), phase),
            endpoint="quotes",
            priority="background",
            cooldown_scope="quotes",
            call=lambda kis: _quote_fetcher.fetch_and_gate(kis, code_list, phase),
        )),
        timeout=1.0,
    )
except (asyncio.TimeoutError, KisCapacityCooldown, KisCapacityOverloaded):
    quotes = []
return LiveQuotesResponse(phase=phase, quotes=quotes)
```

Investor estimate:

```python
try:
    return await asyncio.wait_for(
        asyncio.shield(_kis_scheduler.submit(
            key=("investor-trend-estimate", code),
            endpoint="investor-trend-estimate",
            priority="background",
            cooldown_scope="investor-trend-estimate",
            call=lambda kis: _investor_estimate_fetcher.fetch(kis, code),
        )),
        timeout=1.5,
    )
except (asyncio.TimeoutError, KisCapacityCooldown, KisCapacityOverloaded):
    return _investor_estimate_fetcher._error_response(
        code,
        _investor_estimate_fetcher._today_fn(),
        "kis_capacity_unavailable",
        "KIS capacity scheduler unavailable",
    )
```

- [ ] **Step 5: Run route tests**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_api.py tests/unit/live/test_live_quote_fetcher.py -q
```

Expected:

```text
all tests passed
```

- [ ] **Step 6: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py tests/unit/live/test_live_quote_fetcher.py
git commit -m "refactor(live): schedule live REST KIS routes by account capacity"
```

---

### Task 8: Add Screener And Non-Route Scheduling Facade

**Files:**
- Modify: `hoga/live/kis_access.py`
- Modify: `hoga/api/screener_intraday.py`
- Modify: `hoga/api/screener_backfill.py`
- Modify: `hoga/api/screener.py`
- Modify: relevant tests under `tests/api/`

**Interfaces:**
- Consumes: `KisCapacityScheduler.submit(...)`
- Produces: `kis_access.schedule_with_capacity(...)`

- [ ] **Step 1: Add failing facade test**

Add to `tests/unit/live/test_kis_runtime_accounts.py`:

```python
@pytest.mark.asyncio
async def test_schedule_with_capacity_invokes_scheduler_with_background_priority(tmp_path, monkeypatch):
    from hoga.live import kis_access

    seen = {}

    class _Scheduler:
        async def submit(self, **kwargs):
            seen.update(kwargs)
            return await kwargs["call"]("client")

    async def call(kis):
        return f"ok:{kis}"

    result = await kis_access.schedule_with_capacity(
        _Scheduler(),
        key=("screener", "005930"),
        endpoint="screener",
        priority="background",
        cooldown_scope="screener",
        call=call,
    )

    assert result == "ok:client"
    assert seen["endpoint"] == "screener"
    assert seen["priority"] == "background"
```

- [ ] **Step 2: Run test and confirm RED**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_runtime_accounts.py::test_schedule_with_capacity_invokes_scheduler_with_background_priority -q
```

Expected:

```text
AttributeError: module 'hoga.live.kis_access' has no attribute 'schedule_with_capacity'
```

- [ ] **Step 3: Add facade**

Add to `hoga/live/kis_access.py`:

```python
from collections.abc import Hashable
from hoga.live.kis_capacity_scheduler import KisCapacityScheduler, KisRequestPriority


async def schedule_with_capacity(
    scheduler: KisCapacityScheduler,
    *,
    key: Hashable,
    endpoint: str,
    priority: KisRequestPriority,
    cooldown_scope: Hashable | None,
    call,
):
    return await scheduler.submit(
        key=key,
        endpoint=endpoint,
        priority=priority,
        cooldown_scope=cooldown_scope,
        call=call,
    )
```

- [ ] **Step 4: Migrate screener callers only where scheduler injection exists**

Use the same process-wide scheduler at the app boundary:

```python
from hoga.live.kis_capacity_runtime import ensure_kis_capacity_scheduler

scheduler = ensure_kis_capacity_scheduler(data_dir)

await kis_access.schedule_with_capacity(
    scheduler,
    key=("screener-intraday", tuple(sorted(codes))),
    endpoint="screener-intraday",
    priority="background",
    cooldown_scope="screener-intraday",
    call=lambda kis: kis.fetch_multi_price(codes),
)
```

If a screener module has no scheduler injection seam, add a constructor/function parameter named `kis_scheduler: KisCapacityScheduler | None = None`. When it is `None`, keep the old `fetch_for_role("background", ...)` path for backward compatibility.

- [ ] **Step 5: Run screener tests**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_runtime_accounts.py tests/api/test_screener_update.py tests/api/test_screener_kis_adapter.py -q
```

Expected:

```text
all selected tests passed
```

- [ ] **Step 6: Commit**

```bash
git add hoga/live/kis_access.py hoga/api/screener.py hoga/api/screener_intraday.py hoga/api/screener_backfill.py tests/unit/live/test_kis_runtime_accounts.py tests/api
git commit -m "refactor(live): expose capacity scheduling for background KIS callers"
```

---

### Task 9: Documentation, ADR, And Full Regression

**Files:**
- Modify: `CONTEXT.md`
- Create: `docs/adr/0082-kis-capacity-scheduler-account-pool.md`
- Modify tests if docs expose status fields

**Interfaces:**
- Consumes: completed scheduler behavior
- Produces: documented architecture and rollout evidence

- [ ] **Step 1: Update `CONTEXT.md`**

Replace/ensure the glossary entry says:

```markdown
**KIS Capacity Scheduler**:
Process-local async scheduler that treats configured KIS REST accounts as a capacity pool. `kis_capacity_runtime` owns one shared scheduler per `data_dir`, so `/api/live/*` routes and screener/background callers share the same account capacity. Its account list and worker count are fixed at creation time; worker count defaults to `clamp(configured_accounts * 8, 4, 64)` and can be overridden with `HOGA_KIS_CAPACITY_MAX_WORKERS`. Pending unique request keys are bounded by `HOGA_KIS_CAPACITY_MAX_PENDING` (default 1000), while coalesced waiters do not consume more pending capacity. Workers are concurrency slots, not rate-limit owners. FastAPI shutdown closes this runtime before closing `KisClient` singletons. It coalesces duplicate semantic KIS requests, prioritizes `user_visible` over `background`, leases the least-loaded healthy account, and applies account-scoped cooldown after `KisClient` exhausts `EGW00201` retry. `/api/live/status` exposes scheduler snapshot fields for capacity debugging. It sits above **KisClient**: HTTP, auth/token lifecycle, per-account 15/s token bucket, and retry remain `KisClient` responsibilities. Adding KIS accounts increases available REST capacity after scheduler recreate/app restart under the accepted assumption that KIS limits are account/appkey-scoped.
_Avoid_: "KIS queue", "job queue", "Capture Queue"; this is request capacity management, not Full Capture scheduling.
```

- [ ] **Step 2: Add ADR**

Create `docs/adr/0082-kis-capacity-scheduler-account-pool.md`:

```markdown
# 0082 — KIS Capacity Scheduler owns account-aware REST request scheduling

**Status:** accepted

## Decision

Introduce `KisCapacityScheduler` and `KisAccountPool` above `KisClient`, with `kis_capacity_runtime` owning one process-wide scheduler per `data_dir`. Routes and background callers submit semantic KIS requests to that shared scheduler; the scheduler leases a healthy configured account, runs the callable with that account's `KisClient`, and applies account-scoped cooldown after exhausted `EGW00201`. FastAPI shutdown closes the shared scheduler runtime before closing `KisClient` singletons.

The scheduler worker count scales with configured account count by default: `clamp(configured_accounts * 8, 4, 64)`. `HOGA_KIS_CAPACITY_MAX_WORKERS` may override this for operations. Workers only control concurrent scheduled request execution; account-level KIS rate limiting remains in `KisClient._TokenBucket`.

Configured account ids and worker sizing are evaluated at scheduler/account-pool creation time. Account-count or env changes are not hot-reloaded; operators restart the app or explicitly close/recreate the scheduler runtime.

Pending capacity is bounded by unique scheduled request key, defaulting to 1000 via `HOGA_KIS_CAPACITY_MAX_PENDING`. Coalesced waiters on an existing key do not consume extra pending capacity. New unique requests over the limit raise `KisCapacityOverloaded`.

Migrated callers do not keep a feature flag or dual allocator path. `KisCapacityScheduler` becomes the only production path for those callers; old `kis_access` role routing remains only for callers not yet migrated.

## Assumption

KIS REST rate limits are enforced per account/appkey. Therefore adding configured accounts increases available REST capacity approximately linearly: `healthy_accounts * 15 calls/sec`.

## Preserved invariants

- KIS HTTP data fetches still go through `KisClient`.
- `KisClient._get` remains the retry owner.
- Each account keeps its own `KisClient` token bucket.
- `KisClient` remains the only owner of HTTP, auth/token lifecycle, token bucket rate limiting, and transport retry.

## Alternatives rejected

1. Keep route-local controls. This fixes `/past-candles` but leaves capacity fragmented.
2. Keep `kis_access` role routing as the allocator. This round-robins background accounts but cannot lend idle accounts to user-visible work.
3. Move retry/circuit breaking into `KisClient`. This improves one account's behavior but cannot choose among accounts.
4. Hot-reload accounts and worker counts. This adds worker-pool resize complexity around queued requests and shared futures; explicit restart/recreate is simpler and safer.
5. Add a feature flag for migrated routes. This leaves two production allocators and makes incidents harder to reason about; rollback by code revert is clearer.

## Consequences

- User-visible chart work can use any healthy account instead of account 0 only.
- Background work can consume spare capacity without permanently stealing the foreground lane.
- One account's rate limit no longer blocks healthy accounts.
- Adding accounts increases both account-token-bucket capacity and default scheduler concurrency.
- Account additions require scheduler recreate/app restart before they enter the capacity pool.
- `/api/live/status` exposes scheduler snapshot fields for account counts, worker/pending limits, queue/inflight counts, deferrals, overloads, and account cooldowns.
- Scheduler worker lifecycle and account lease accounting become production responsibilities and must be tested.
- Shutdown order becomes part of the contract: scheduler runtime closes before `KisClient` runtime.
```

- [ ] **Step 3: Run full verification**

```bash
uv run --extra dev python -m pytest tests/unit/live/test_kis_account_pool.py tests/unit/live/test_kis_capacity_scheduler.py tests/unit/live/test_kis_capacity_runtime.py tests/api/test_startup_runtime.py tests/unit/live/test_api.py tests/unit/live/test_live_quote_fetcher.py tests/unit/live/test_kis_runtime_accounts.py -q
git diff --check
```

Expected:

```text
all tests passed
git diff --check prints no output
```

- [ ] **Step 4: Commit**

```bash
git add CONTEXT.md docs/adr/0082-kis-capacity-scheduler-account-pool.md
git commit -m "docs: document KIS capacity scheduler architecture"
```

---

## Rollout Checklist

- Configure at least two KIS accounts in `.env`:
  - `KIS_APP_KEY`, `KIS_APP_SECRET`
  - `KIS_APP_KEY_2`, `KIS_APP_SECRET_2`
- Optional extra accounts continue the existing suffix pattern:
  - `KIS_APP_KEY_3`, `KIS_APP_SECRET_3`
- Manual `/live` checks:
  - uncached `/api/live/past-candles` range
  - `venue=AUTO`
  - daily timeframe
  - quotes drawer
  - investor trend estimate
- Check `/api/live/status`:
  - `kis_capacity_scheduler.configured_account_count`
  - `kis_capacity_scheduler.healthy_account_count`
  - `kis_capacity_scheduler.max_workers`
  - `kis_capacity_scheduler.max_pending_requests`
  - deferral and overload counters during burst tests
- Watch logs:
  - account IDs should distribute under burst load
  - one account cooldown should not stop healthy accounts
  - all-account cooldown should produce quick `rate_limit_aborted`
- Confirm cache hits do not lease accounts.

## Self-Review

**Spec coverage:** The plan builds account discovery, account leasing, account-scoped cooldown, capacity-aware scheduling, route migration, background facade, docs, and ADR. It implements the assumption that each account adds REST capacity.

**Placeholder scan:** The plan contains no unresolved placeholder markers. Deferred behavior is explicitly named as compatibility fallback for non-route screener seams.

**Type consistency:** `KisAccountPool`, `KisCapacityScheduler`, `KisCapacityCooldown`, `KisNoAccountAvailable`, `KisAccountReservationDeferred`, `submit`, `lease`, `release`, and `snapshot` are introduced before later tasks consume them.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-kis-capacity-scheduler.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
