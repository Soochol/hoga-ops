"""키움 REST 유량 거버너 — 단일 우선순위 큐 + **TR별** 토큰 버킷 (ADR-0136 §2).

## 버킷 단위가 TR 인 이유

벤더가 429 응답에 직접 적어 보낸다: `유량=5, **API ID=ka10080**`. 그리고 TR 간
독립을 실증했다 — `ka10080` 을 429 까지 밀어붙인 **직후 대기 없이** `ka10081` 을
호출하니 즉시 통과했다(#1015). 그래서 게이트는 앱키가 아니라 **TR** 이다.

KIS 스케줄러(303줄) 대비 **계정 차원이 통째로 사라진다** — 계정 풀 선택·health/
failover·`cooldown_scope`. 키움은 유량이 TR별이라 계정을 고를 이유가 없다.
반면 **우선순위 차원은 하나도 줄지 않는다**: 인터랙티브가 백필에 밀리는 문제는
벤더와 무관한 성질이다.

## 큐가 옮겨야 하는 기계는 **넷**이다

    1. 2단 우선순위    user_visible 이 background 보다 먼저
    2. 중복제거        같은 key 가 떠 있으면 그 future 에 조인
    3. **승격**        background 로 대기 중인 요청을 사용자가 다시 요청하면 끌어올린다
    4. **양보**        user_visible 이 대기 중이면 background 를 미룬다

3·4 가 빠지면 **"인터랙티브 팬이 백그라운드 백필 뒤에 줄 서는" 회귀가 재현된다** —
리포에 실측 이력이 있는 증상이라 테스트로 못 박는다.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar

log = logging.getLogger(__name__)

_T = TypeVar("_T")

Priority = Literal["user_visible", "background"]

# 벤더가 429 에 적어 보낸 값(#1015, ka10080 에서 확인). TR 마다 다를 수 있어
# per-TR 오버라이드를 열어둔다 — ADR-0136 의 Trigger Condition 이 이것이다.
DEFAULT_TR_RATE_PER_SEC = 5.0
# 버킷을 상한에 딱 붙이면 경계에서 429 가 난다. 실측 지연이 30~170ms 라
# 약간의 여유가 처리량에 거의 영향을 주지 않는다.
_HEADROOM = 0.8

_PRIORITY_ORDER: dict[Priority, int] = {"user_visible": 0, "background": 10}


class KiwoomCapacityOverloaded(RuntimeError):
    """큐가 상한을 넘었다 — 신규 요청 거절."""


@dataclass(order=True)
class _Request:
    order: int
    seq: int
    key: Hashable = field(compare=False)
    api_id: str = field(compare=False, default="")
    priority: Priority = field(compare=False, default="background")
    call: Callable[[], Awaitable[Any]] = field(compare=False, default=None)  # type: ignore[assignment]
    future: asyncio.Future = field(compare=False, default=None)  # type: ignore[assignment]
    deferred: bool = field(compare=False, default=False)
    """양보는 **요청당 1회**. 무제한이면 user_visible 이 오래 막힐 때 background 가
    큐를 맴돌며 워커를 태운다."""


class _TokenBucket:
    """TR 하나의 발사 게이트. 초당 `rate` 건."""

    def __init__(self, rate: float) -> None:
        self._interval = 1.0 / rate
        self._next_at = 0.0

    async def acquire(self) -> None:
        now = time.monotonic()
        wait = self._next_at - now
        if wait > 0:
            await asyncio.sleep(wait)
            now = time.monotonic()
        self._next_at = max(now, self._next_at) + self._interval

    def penalize(self, seconds: float) -> None:
        """429 를 만났을 때 그 TR 만 잠시 물린다."""
        self._next_at = max(self._next_at, time.monotonic() + seconds)


class KiwoomCapacityScheduler:
    """키움 REST 요청의 단일 진입점.

    워커 수는 동시성 상한일 뿐이고 **실제 게이트는 TR별 버킷**이다. 서로 다른 TR 은
    자연히 병렬로 흐르고, 같은 TR 은 버킷이 직렬화한다.
    """

    def __init__(
        self,
        *,
        workers: int = 4,
        max_queued: int = 512,
        rate_per_sec: float = DEFAULT_TR_RATE_PER_SEC,
        tr_rates: dict[str, float] | None = None,
    ) -> None:
        self._rate = rate_per_sec
        self._tr_rates = dict(tr_rates or {})
        self._buckets: dict[str, _TokenBucket] = {}
        self._queue: asyncio.PriorityQueue[_Request] = asyncio.PriorityQueue()
        self._inflight: dict[Hashable, asyncio.Future] = {}
        self._queued_priority: dict[Hashable, Priority] = {}
        self._started: set[Hashable] = set()
        self._workers: list[asyncio.Task] = []
        self._n_workers = workers
        self._max_queued = max_queued
        self._seq = 0
        self.background_deferred_due_to_user_visible = 0

    # --- 공개 API -----------------------------------------------------------

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[], Awaitable[_T]],
    ) -> _T:
        """요청 하나. 같은 `key` 가 떠 있으면 **새 호출 없이** 그 결과에 조인한다."""
        self._ensure_started()
        existing = self._inflight.get(key)
        if existing is not None:
            # 기계 ③ 승격 — 백그라운드로 대기 중인 것을 사용자가 다시 요청했다.
            if priority == "user_visible" and self._queued_priority.get(key) == "background":
                self._queued_priority[key] = "user_visible"
                self._queue.put_nowait(self._make(key, api_id, priority, call, existing))
            return await asyncio.shield(existing)  # 기계 ②

        if self._queue.qsize() >= self._max_queued:
            raise KiwoomCapacityOverloaded(f"queue full ({self._max_queued})")

        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._inflight[key] = future
        self._queued_priority[key] = priority
        self._queue.put_nowait(self._make(key, api_id, priority, call, future))
        return await asyncio.shield(future)

    def snapshot(self) -> dict[str, object]:
        """관측 표면. KIS 의 `kis_calls_today`/`kis_rate_limit_remaining` 은
        하드코딩 상수인 **죽은 필드**였다 — 이식하지 않고 여기서 새로 정의한다."""
        return {
            "queued": self._queue.qsize(),
            "inflight": len(self._inflight),
            "workers": len(self._workers),
            "tr_buckets": len(self._buckets),
            "background_deferred_due_to_user_visible": (
                self.background_deferred_due_to_user_visible
            ),
        }

    async def aclose(self) -> None:
        for w in self._workers:
            w.cancel()
        for w in self._workers:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await w
        self._workers.clear()

    # --- 내부 ---------------------------------------------------------------

    def _make(
        self, key: Hashable, api_id: str, priority: Priority,
        call: Callable[[], Awaitable[Any]], future: asyncio.Future,
    ) -> _Request:
        self._seq += 1
        return _Request(
            order=_PRIORITY_ORDER[priority], seq=self._seq, key=key,
            api_id=api_id, priority=priority, call=call, future=future,
        )

    def _bucket(self, api_id: str) -> _TokenBucket:
        b = self._buckets.get(api_id)
        if b is None:
            b = _TokenBucket(self._tr_rates.get(api_id, self._rate) * _HEADROOM)
            self._buckets[api_id] = b
        return b

    def _should_defer(self, req: _Request) -> bool:
        """background 를 뒤로 미룰지. 미룰 때 큐에 되넣고 True 를 돌려준다."""
        if req.deferred or req.priority != "background" or not self._has_queued_user_visible():
            return False
        req.deferred = True
        self.background_deferred_due_to_user_visible += 1
        self._queue.put_nowait(req)
        return True

    def _has_queued_user_visible(self) -> bool:
        return any(
            p == "user_visible" and k not in self._started
            for k, p in self._queued_priority.items()
        )

    def _ensure_started(self) -> None:
        if self._workers:
            return
        self._workers = [
            asyncio.create_task(self._worker(), name=f"kiwoom-capacity-{i}")
            for i in range(self._n_workers)
        ]

    async def _worker(self) -> None:
        while True:
            req = await self._queue.get()
            if req.future.done():
                continue
            # 기계 ④ 양보 (1차) — dequeue 직후. 우선순위 큐가 대개 먼저 걸러내므로
            # 여기서 걸리는 경우는 드물다.
            if self._should_defer(req):
                continue
            self._started.add(req.key)
            try:
                await self._bucket(req.api_id).acquire()
                # 기계 ④ 양보 (2차) — **여기가 실효 지점이다.** background 가 버킷에서
                # 자는 동안 같은 TR 의 user_visible 이 도착할 수 있다. 버킷은 TR별이라
                # 그 대기가 곧 "인터랙티브 팬이 백필 뒤에 줄 서는" 상황이다.
                if self._should_defer(req):
                    self._started.discard(req.key)
                    continue
                result = await req.call()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — future 로 전달, 워커는 살아남는다
                self._penalize_if_rate_limited(req.api_id, exc)
                if not req.future.done():
                    req.future.set_exception(exc)
            else:
                if not req.future.done():
                    req.future.set_result(result)
            finally:
                self._cleanup(req)

    def _penalize_if_rate_limited(self, api_id: str, exc: BaseException) -> None:
        from hoga.live.kiwoom_errors import KiwoomRateLimitError  # noqa: PLC0415 — 순환 절단

        if isinstance(exc, KiwoomRateLimitError):
            # 벤더가 상한을 알려줬으면 버킷을 그 값으로 교정한다.
            if exc.quota and exc.quota > 0:
                self._tr_rates[api_id] = float(exc.quota)
                self._buckets.pop(api_id, None)
            self._bucket(api_id).penalize(1.0)
            log.warning("kiwoom capacity: %s rate-limited (quota=%s)", api_id, exc.quota)

    def _cleanup(self, req: _Request) -> None:
        self._started.discard(req.key)
        if self._inflight.get(req.key) is req.future:
            self._inflight.pop(req.key, None)
            self._queued_priority.pop(req.key, None)
