"""키움 유량 거버너 테스트 — 큐 기계 **넷**을 봉인한다.

    1. 2단 우선순위    2. 중복제거    3. **승격**    4. **양보**

3·4 가 빠지면 "인터랙티브 팬이 백그라운드 백필 뒤에 줄 서는" 회귀가 재현된다 —
리포에 실측 이력이 있는 증상이라 결정문(#1011)에서 누락됐던 것을 여기서 못 박는다.

**벽시계에 기대지 않는다.** 순서·호출 횟수 같은 결정론적 계약만 단언한다
(메모리 `wallclock-ratio-assertions-replace-with-call-counts`).
"""
from __future__ import annotations

import asyncio

import pytest

from hoga.live.kiwoom_capacity import (
    DEFAULT_TR_RATE_PER_SEC,
    KiwoomCapacityOverloaded,
    KiwoomCapacityScheduler,
)
from hoga.live.kiwoom_errors import KiwoomRateLimitError

# 페이싱을 실질 0 으로 두어 테스트가 벽시계에 걸리지 않게 한다.
_FAST = 10_000.0


def _sched(**kw) -> KiwoomCapacityScheduler:
    kw.setdefault("rate_per_sec", _FAST)
    return KiwoomCapacityScheduler(**kw)


# === 기계 ② 중복제거 =========================================================

async def test_same_key_joins_one_inflight_call() -> None:
    s = _sched(workers=1)
    calls = 0
    gate = asyncio.Event()

    async def fn() -> str:
        nonlocal calls
        calls += 1
        await gate.wait()
        return "v"

    t1 = asyncio.create_task(s.submit(key="k", api_id="ka10001", priority="background", call=fn))
    t2 = asyncio.create_task(s.submit(key="k", api_id="ka10001", priority="background", call=fn))
    await asyncio.sleep(0)
    gate.set()
    assert await t1 == "v"
    assert await t2 == "v"
    assert calls == 1, "같은 key 는 한 번만 호출되어야 한다"
    await s.aclose()


async def test_distinct_keys_do_not_dedupe() -> None:
    s = _sched(workers=2)
    calls = 0

    async def fn() -> int:
        nonlocal calls
        calls += 1
        return calls

    await asyncio.gather(
        s.submit(key="a", api_id="ka10001", priority="background", call=fn),
        s.submit(key="b", api_id="ka10001", priority="background", call=fn),
    )
    assert calls == 2
    await s.aclose()


# === 기계 ① 우선순위 + ④ 양보 ================================================

async def test_user_visible_runs_before_queued_background() -> None:
    """워커 1개로 직렬화해 순서를 결정론적으로 관측한다."""
    s = _sched(workers=1)
    order: list[str] = []
    gate = asyncio.Event()

    async def blocker() -> None:
        order.append("blocker")
        await gate.wait()

    async def mark(name: str) -> None:
        order.append(name)

    t0 = asyncio.create_task(
        s.submit(key="block", api_id="ka10001", priority="background", call=blocker))
    await asyncio.sleep(0)  # blocker 가 워커를 점유하게 한다

    tb = asyncio.create_task(
        s.submit(key="bg", api_id="ka10001", priority="background", call=lambda: mark("bg")))
    await asyncio.sleep(0)
    tu = asyncio.create_task(
        s.submit(key="uv", api_id="ka10001", priority="user_visible", call=lambda: mark("uv")))
    await asyncio.sleep(0)

    gate.set()
    await asyncio.gather(t0, tb, tu)
    assert order.index("uv") < order.index("bg"), "user_visible 이 먼저여야 한다"
    await s.aclose()


async def test_background_defers_when_user_visible_arrives_during_bucket_wait() -> None:
    """기계 ④ — **실효 지점은 버킷 대기 중**이다.

    우선순위 큐는 dequeue 시점만 정렬한다. background 가 이미 dequeue 돼 같은 TR 의
    버킷에서 자는 동안 user_visible 이 도착하면, 양보가 없으면 그대로 진행해버린다 —
    버킷이 TR별이라 그 대기가 곧 "인터랙티브 팬이 백필 뒤에 줄 서는" 상황이다.

    버킷을 제어 가능한 페이크로 갈아끼워 **벽시계 없이** 그 창을 재현한다.
    """
    s = _sched(workers=1)
    order: list[str] = []
    in_bucket = asyncio.Event()
    release = asyncio.Event()

    class _GatedBucket:
        def __init__(self) -> None:
            self.first = True

        async def acquire(self) -> None:
            if self.first:
                self.first = False
                in_bucket.set()
                await release.wait()

        def penalize(self, seconds: float) -> None:
            return None

    # 내부 버킷을 갈아끼워 "대기 중" 창을 결정론적으로 연다 — 벽시계를 쓰지 않기 위해서다.
    s._buckets["ka10001"] = _GatedBucket()

    async def mark(name: str) -> None:
        order.append(name)

    tb = asyncio.create_task(
        s.submit(key="bg", api_id="ka10001", priority="background", call=lambda: mark("bg")))
    await in_bucket.wait()          # background 가 버킷에서 자는 중

    tu = asyncio.create_task(
        s.submit(key="uv", api_id="ka10001", priority="user_visible", call=lambda: mark("uv")))
    await asyncio.sleep(0)
    release.set()                   # background 를 깨운다

    await asyncio.gather(tb, tu)
    assert s.background_deferred_due_to_user_visible == 1, "버킷 대기 중 도착한 uv 에 양보해야 한다"
    assert order == ["uv", "bg"], "양보 결과 user_visible 이 먼저 실행되어야 한다"
    await s.aclose()


async def test_defer_happens_at_most_once_per_request() -> None:
    """무제한 양보는 user_visible 이 오래 막힐 때 background 가 큐를 맴돌게 한다."""
    s = _sched(workers=1)
    gate = asyncio.Event()

    async def blocked_uv() -> None:
        await gate.wait()

    async def bg() -> None:
        return None

    tu = asyncio.create_task(
        s.submit(key="uv", api_id="ka10001", priority="user_visible", call=blocked_uv))
    await asyncio.sleep(0)
    tb = asyncio.create_task(
        s.submit(key="bg", api_id="ka10001", priority="background", call=bg))
    for _ in range(10):
        await asyncio.sleep(0)
    assert s.background_deferred_due_to_user_visible <= 1, "요청당 양보는 1회여야 한다"
    gate.set()
    await asyncio.gather(tu, tb)
    await s.aclose()


# === 기계 ③ 승격 =============================================================

async def test_background_inflight_is_promoted_when_user_asks_again() -> None:
    """백그라운드로 대기 중인 요청을 사용자가 다시 요청하면 끌어올린다.

    승격이 없으면 사용자가 방금 클릭한 종목이 백필 큐 뒤에서 기다린다.
    """
    s = _sched(workers=1)
    gate = asyncio.Event()

    async def blocker() -> None:
        await gate.wait()

    async def slow() -> str:
        return "v"

    t0 = asyncio.create_task(
        s.submit(key="block", api_id="ka10001", priority="background", call=blocker))
    await asyncio.sleep(0)

    tb = asyncio.create_task(
        s.submit(key="dup", api_id="ka10001", priority="background", call=slow))
    await asyncio.sleep(0)
    assert s._queued_priority["dup"] == "background"   # 내부 계약 직접 검증

    tu = asyncio.create_task(
        s.submit(key="dup", api_id="ka10001", priority="user_visible", call=slow))
    await asyncio.sleep(0)
    assert s._queued_priority["dup"] == "user_visible", (
        "같은 key 를 user_visible 로 다시 요청하면 승격되어야 한다"
    )

    gate.set()
    await asyncio.gather(t0, tb, tu)
    await s.aclose()


# === TR별 버킷 ================================================================

async def test_buckets_are_per_tr_not_global() -> None:
    """유량은 TR(API ID)별 독립이다 — ka10080 이 429 여도 ka10081 은 즉시 통과했다(#1015)."""
    s = _sched(workers=2)

    async def noop() -> None:
        return None

    await asyncio.gather(
        s.submit(key="a", api_id="ka10080", priority="background", call=noop),
        s.submit(key="b", api_id="ka10081", priority="background", call=noop),
    )
    assert s.snapshot()["tr_buckets"] == 2, "TR 마다 버킷이 따로 생겨야 한다"
    await s.aclose()


async def test_rate_limit_error_retunes_bucket_from_vendor_quota() -> None:
    """벤더가 `유량=5` 를 알려주므로 버킷을 그 값으로 자가 교정한다."""
    s = _sched(workers=1, rate_per_sec=_FAST)

    async def boom() -> None:
        raise KiwoomRateLimitError("… 유량=3, API ID=ka10080]", api_id="ka10080")

    with pytest.raises(KiwoomRateLimitError):
        await s.submit(key="k", api_id="ka10080", priority="background", call=boom)
    assert s._tr_rates["ka10080"] == 3.0   # 자가 교정 계약을 직접 검증
    await s.aclose()


# === 실패·과부하 ==============================================================

async def test_exception_propagates_and_worker_survives() -> None:
    s = _sched(workers=1)

    async def boom() -> None:
        raise ValueError("x")

    async def ok() -> str:
        return "v"

    with pytest.raises(ValueError, match="x"):
        await s.submit(key="a", api_id="ka10001", priority="background", call=boom)
    assert await s.submit(key="b", api_id="ka10001", priority="background", call=ok) == "v", (
        "한 요청의 실패가 워커를 죽이면 안 된다"
    )
    await s.aclose()


async def test_queue_overflow_raises_overloaded() -> None:
    s = _sched(workers=1, max_queued=1)
    gate = asyncio.Event()

    async def blocker() -> None:
        await gate.wait()

    t0 = asyncio.create_task(
        s.submit(key="a", api_id="ka10001", priority="background", call=blocker))
    await asyncio.sleep(0)
    t1 = asyncio.create_task(
        s.submit(key="b", api_id="ka10001", priority="background", call=blocker))
    await asyncio.sleep(0)
    with pytest.raises(KiwoomCapacityOverloaded):
        await s.submit(key="c", api_id="ka10001", priority="background", call=blocker)
    gate.set()
    await asyncio.gather(t0, t1)
    await s.aclose()


def test_default_rate_matches_vendor_measured_quota() -> None:
    """#1015 실측: 벤더가 429 에 `유량=5` 를 적어 보낸다."""
    assert DEFAULT_TR_RATE_PER_SEC == 5.0
