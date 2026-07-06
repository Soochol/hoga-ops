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


def _observe_future_exception(future: asyncio.Future) -> None:
    if future.cancelled():
        return
    try:
        future.exception()
    except asyncio.InvalidStateError:
        return


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
        self._capacity_change_condition: asyncio.Condition | None = None
        self._capacity_change_loop: asyncio.AbstractEventLoop | None = None
        self._capacity_change_generation = 0
        self._capacity_retry_backstop_s = 1.0
        self._seq = itertools.count()
        self._workers: list[asyncio.Task[None]] = []
        self._worker_loop: asyncio.AbstractEventLoop | None = None
        self._closed = False

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
                await self._queue.put(
                    _ScheduledRequest(
                        0,
                        next(self._seq),
                        key,
                        generation,
                        self._request_endpoints[key],
                        self._request_cooldown_keys[key],
                        self._request_calls[key],
                        existing,
                    )
                )
            return await asyncio.shield(existing)

        if len(self._inflight) >= self._max_pending_requests:
            self._overloaded_rejections += 1
            raise KisCapacityOverloaded("KIS capacity scheduler pending request limit reached")

        loop = asyncio.get_running_loop()
        future: asyncio.Future[_T] = loop.create_future()
        future.add_done_callback(_observe_future_exception)
        self._inflight[key] = future
        self._queued_priorities[key] = priority
        self._request_generations[key] = 0
        cooldown_key = (endpoint, cooldown_scope)
        self._request_calls[key] = call
        self._request_endpoints[key] = endpoint
        self._request_cooldown_keys[key] = cooldown_key
        self._ensure_started()
        await self._queue.put(
            _ScheduledRequest(
                0 if priority == "user_visible" else 10,
                next(self._seq),
                key,
                0,
                endpoint,
                cooldown_key,
                call,
                future,
            )
        )
        return await asyncio.shield(future)

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
            "background_deferred_due_to_user_visible": (
                self._background_deferred_due_to_user_visible
            ),
            "background_deferred_due_to_reserved_capacity": (
                self._background_deferred_due_to_reserved_capacity
            ),
            "overloaded_rejections": self._overloaded_rejections,
            "accounts": [s.__dict__ for s in account_snapshots],
        }

    async def aclose(self) -> None:
        self._closed = True
        for worker in self._workers:
            worker.cancel()
        current_loop = asyncio.get_running_loop()
        current_loop_workers = [
            worker for worker in self._workers if worker.get_loop() is current_loop
        ]
        if current_loop_workers:
            await asyncio.gather(*current_loop_workers, return_exceptions=True)
        self._workers = []
        self._worker_loop = None

    def _ensure_started(self) -> None:
        loop = asyncio.get_running_loop()
        if (
            self._workers
            and self._worker_loop is loop
            and any(not worker.done() for worker in self._workers)
        ):
            return
        for worker in self._workers:
            worker.cancel()
        self._workers = [
            asyncio.create_task(self._worker(), name=f"kis-capacity:{self._name}:{i}")
            for i in range(self._max_workers)
        ]
        self._worker_loop = loop

    def _has_queued_user_visible(self) -> bool:
        return any(
            priority == "user_visible" and key not in self._started_keys
            for key, priority in self._queued_priorities.items()
        )

    async def _worker(self) -> None:  # noqa: PLR0912, PLR0915
        while True:
            request = await self._queue.get()
            if request.future.done():
                self._cleanup_request(request.key)
                self._queue.task_done()
                continue
            if request.generation != self._request_generations.get(request.key):
                self._queue.task_done()
                continue
            if request.rank > 0 and self._has_queued_user_visible():
                self._background_deferred_due_to_user_visible += 1
                await self._queue.put(request)
                self._queue.task_done()
                await asyncio.sleep(0.01)
                continue

            lease = None
            requeued = False
            capacity_generation = self._capacity_change_generation
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
                self._queue.task_done()
                requeued = True
                await self._wait_for_capacity_change(capacity_generation)
                if (
                    not request.future.done()
                    and request.generation == self._request_generations.get(request.key)
                ):
                    await self._queue.put(request)
                continue
            except KisNoAccountAvailable as exc:
                if not request.future.done():
                    request.future.set_exception(KisCapacityCooldown(str(exc)))
            except KisRateLimitError as exc:
                if lease is not None:
                    self._account_pool.mark_cooldown(
                        lease.account_id,
                        request.cooldown_key,
                        self._account_cooldown_s,
                    )
                if not request.future.done():
                    request.future.set_exception(exc)
            except Exception as exc:  # noqa: BLE001
                if not request.future.done():
                    request.future.set_exception(exc)
            else:
                if not request.future.done():
                    request.future.set_result(result)
            finally:
                if not requeued:
                    if lease is not None:
                        self._account_pool.release(lease.account_id)
                    self._cleanup_request(request.key)
                    self._queue.task_done()
                    await self._notify_capacity_changed(request.cooldown_key)

    def _cleanup_request(self, key: Hashable) -> None:
        self._inflight.pop(key, None)
        self._queued_priorities.pop(key, None)
        self._request_generations.pop(key, None)
        self._request_calls.pop(key, None)
        self._request_endpoints.pop(key, None)
        self._request_cooldown_keys.pop(key, None)
        self._started_keys.discard(key)

    def _get_capacity_change_condition(self) -> asyncio.Condition:
        loop = asyncio.get_running_loop()
        if self._capacity_change_condition is None or self._capacity_change_loop is not loop:
            self._capacity_change_condition = asyncio.Condition()
            self._capacity_change_loop = loop
        return self._capacity_change_condition

    async def _wait_for_capacity_change(self, observed_generation: int) -> None:
        condition = self._get_capacity_change_condition()
        try:
            async with condition:
                await asyncio.wait_for(
                    condition.wait_for(
                        lambda: self._closed
                        or self._capacity_change_generation != observed_generation
                    ),
                    timeout=self._capacity_retry_backstop_s,
                )
        except TimeoutError:
            return

    async def _notify_capacity_changed(self, cooldown_key: Hashable | None) -> None:
        if not self._account_pool.reserved_background_capacity_available(cooldown_key):
            return
        condition = self._get_capacity_change_condition()
        async with condition:
            self._capacity_change_generation += 1
            condition.notify(1)
