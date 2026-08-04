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

    async def fn(_client=None) -> str:
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


async def test_corider_survives_another_waiters_cancellation() -> None:
    """한 대기자의 취소가 **공유 태스크에 올라탄 다른 대기자를 죽이면 안 된다.**

    `live_candle_backfill` 이 날짜별 single-flight 에서 지키던 성질인데,
    PR-G(#1043)에서 중복제거가 거버너로 올라오면서 여기로 이사했다. 원 회귀
    (/investigate 2026-07-10): 타임프레임 전환 abort 로 한 요청이 취소되자
    같은 (venue, code, date) 에 dedup 으로 올라탄 다른 `/past-candles` 요청까지
    CancelledError 로 죽었다. bare `await` 는 대기자 취소를 `_fut_waiter.cancel()`
    로 공유 future 까지 전파한다 — 조인 지점이 `shield` 여야 한다.
    """
    s = _sched(workers=1)
    gate = asyncio.Event()
    calls = 0

    async def fn(_client=None) -> str:
        nonlocal calls
        calls += 1
        await gate.wait()
        return "v"

    doomed = asyncio.create_task(
        s.submit(key="k", api_id="ka10001", priority="background", call=fn))
    rider = asyncio.create_task(
        s.submit(key="k", api_id="ka10001", priority="background", call=fn))
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    doomed.cancel()
    await asyncio.sleep(0)
    gate.set()

    assert await rider == "v", "shield 가 없으면 여기서 CancelledError 다"
    assert calls == 1
    with pytest.raises(asyncio.CancelledError):
        await doomed
    await s.aclose()


async def test_distinct_keys_do_not_dedupe() -> None:
    s = _sched(workers=2)
    calls = 0

    async def fn(_client=None) -> int:
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

    async def blocker(_client=None) -> None:
        order.append("blocker")
        await gate.wait()

    async def mark(name: str) -> None:
        order.append(name)

    t0 = asyncio.create_task(
        s.submit(key="block", api_id="ka10001", priority="background", call=blocker))
    await asyncio.sleep(0)  # blocker 가 워커를 점유하게 한다

    tb = asyncio.create_task(
        s.submit(key="bg", api_id="ka10001", priority="background", call=lambda _client: mark("bg")))
    await asyncio.sleep(0)
    tu = asyncio.create_task(
        s.submit(key="uv", api_id="ka10001", priority="user_visible", call=lambda _client: mark("uv")))
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

        def available_at(self) -> float:
            return 0.0

        def penalize(self, seconds: float) -> None:
            return None

    # 내부 버킷을 갈아끼워 "대기 중" 창을 결정론적으로 연다 — 벽시계를 쓰지 않기 위해서다.
    # 키는 (앱키, TR) 다(ADR-0138) — 문자열로 넣으면 주입이 조용히 무시되고 실제 버킷이
    # 생겨서 이 테스트가 **무한 대기**한다.
    s._buckets[(0, "ka10001")] = _GatedBucket()

    async def mark(name: str) -> None:
        order.append(name)

    tb = asyncio.create_task(
        s.submit(key="bg", api_id="ka10001", priority="background", call=lambda _client: mark("bg")))
    await in_bucket.wait()          # background 가 버킷에서 자는 중

    tu = asyncio.create_task(
        s.submit(key="uv", api_id="ka10001", priority="user_visible", call=lambda _client: mark("uv")))
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

    async def blocked_uv(_client=None) -> None:
        await gate.wait()

    async def bg(_client=None) -> None:
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

    async def blocker(_client=None) -> None:
        await gate.wait()

    async def slow(_client=None) -> str:
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

    async def noop(_client=None) -> None:
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

    async def boom(_client=None) -> None:
        raise KiwoomRateLimitError("… 유량=3, API ID=ka10080]", api_id="ka10080")

    with pytest.raises(KiwoomRateLimitError):
        await s.submit(key="k", api_id="ka10080", priority="background", call=boom)
    assert s._tr_rates["ka10080"] == 3.0   # 자가 교정 계약을 직접 검증
    await s.aclose()


# === 실패·과부하 ==============================================================

async def test_exception_propagates_and_worker_survives() -> None:
    s = _sched(workers=1)

    async def boom(_client=None) -> None:
        raise ValueError("x")

    async def ok(_client=None) -> str:
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

    async def blocker(_client=None) -> None:
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


# === 무한 대기 방지 — 이 거버너는 프로세스 싱글턴이라 조용히 죽는다 ===========

def test_workers_are_recreated_when_the_event_loop_changes() -> None:
    """**루프가 바뀌면 큐를 아무도 안 비운다** — 예외도 타임아웃도 없는 무한 대기.

    거버너는 프로세스 싱글턴인데 `asyncio.run` 은 매번 새 루프를 만든다. 옛
    구현은 `if self._workers: return` 이라 죽은 루프의 워커 시체를 보고 "이미
    떠 있다" 고 판단했다. 그 상태에서 `submit` 하면 큐에 들어간 요청을 꺼낼
    워커가 없어 **영원히 매달린다** — 실패 모드 중 최악이라 못 박는다.
    """
    s = KiwoomCapacityScheduler(workers=1)

    async def round_one() -> str:
        return await s.submit(
            key="a", api_id="ka10001", priority="background",
            call=_returns("first"),
        )

    async def round_two() -> str:
        # 새 루프. 옛 구현은 여기서 **영원히** 매달렸다 — 상한을 씌워 행 대신
        # 명시적 실패로 떨어뜨린다(행은 CI 에서 최악의 실패 신호다). 실제 작업은
        # 1ms 미만이라 5초는 성질을 재는 예산이 아니라 교착 오라클이다.
        out = await asyncio.wait_for(
            s.submit(
                key="b", api_id="ka10001", priority="background",
                call=_returns("second"),
            ),
            timeout=5,
        )
        await s.aclose()
        return out

    assert asyncio.run(round_one()) == "first"
    assert asyncio.run(round_two()) == "second"


def test_dead_workers_do_not_wedge_the_queue() -> None:
    """워커가 끝나 있으면(시체) 다시 띄운다 — 같은 무한 대기의 다른 경로."""
    s = KiwoomCapacityScheduler(workers=1)

    async def scenario() -> str:
        await s.submit(
            key="a", api_id="ka10001", priority="background", call=_returns("warm"),
        )
        # 워커를 강제로 세운다(감시 태스크 사망 재현). aclose 는 리스트를 비우므로
        # 시체가 남는 상황을 만들려면 cancel 만 하고 리스트는 그대로 둔다.
        for w in s._workers:
            w.cancel()
        await asyncio.sleep(0)
        return await asyncio.wait_for(   # 교착 오라클 — 위와 같은 이유
            s.submit(
                key="b", api_id="ka10001", priority="background",
                call=_returns("revived"),
            ),
            timeout=5,
        )

    assert asyncio.run(scenario()) == "revived"


def _returns(value: str):
    async def _call(_client=None) -> str:
        return value

    return _call


# === 계정 풀 (ADR-0138) ======================================================
#
# 유량은 TR별인 **동시에 앱키별**이다. #1015 는 TR 축만 실증했고 앱키 축은
# ADR-0136 이 "미검증으로 남는다" 고 유보했다. 실측 결과 앱키0 을 429 까지
# 밀어붙인 직후 앱키1 이 대기 없이 통과했다 — 1키 4.17 → 4키 18.4 콜/초.


class _FakeClient:
    def __init__(self, account_id: int) -> None:
        self.account_id = account_id


async def test_pool_spreads_calls_across_accounts() -> None:
    """버킷이 (앱키, TR) 라야 계정 수만큼 처리량이 는다. 키가 TR 하나면 계정을
    아무리 늘려도 같은 버킷에서 직렬화된다."""
    s = _sched(workers=4)
    s.set_clients([_FakeClient(i) for i in range(4)])
    seen: list[int] = []

    async def fn(client) -> None:
        seen.append(client.account_id)

    await asyncio.gather(*(
        s.submit(key=f"k{i}", api_id="ka10001", priority="background", call=fn)
        for i in range(8)
    ))

    assert len(seen) == 8
    assert set(seen) == {0, 1, 2, 3}, "네 계정이 모두 쓰여야 한다"
    assert {k[0] for k in s._buckets} == {0, 1, 2, 3}
    await s.aclose()


async def test_rate_limited_account_falls_to_the_back_of_the_line() -> None:
    """failover 를 상태 기계 없이 얻는 방식 — `penalize` 로 밀린 계정은
    `available_at()` 이 뒤로 가서 자동으로 후순위가 된다."""
    s = _sched(workers=1)
    s.set_clients([_FakeClient(0), _FakeClient(1)])

    # 계정 0 을 실제 429 경로로 물린다(벤더 quota 파싱까지 그대로 태운다).
    s._penalize_if_rate_limited(
        0, "ka10001", KiwoomRateLimitError("초과[1700:유량=5, API ID=ka10001]"),
    )

    assert s._pick_account("ka10001") == 1, "물린 계정을 다시 고르면 안 된다"
    await s.aclose()


async def test_single_account_degenerates_to_previous_behavior() -> None:
    """풀이 비면 계정 0 하나로 동작하고 클라이언트는 호출자가 준 것을 쓴다 —
    자격증명 1벌인 환경(ADR-0134 dev 프로필)이 이 경로다."""
    s = _sched(workers=1)
    received: list[object] = []

    async def fn(client) -> str:
        received.append(client)
        return "v"

    assert await s.submit(
        key="k", api_id="ka10001", priority="background", call=fn) == "v"

    assert s._accounts == (0,)
    assert received == [None], "풀이 없으면 None — 호출자 클라이언트를 쓰라는 신호"
    assert set(s._buckets) == {(0, "ka10001")}
    await s.aclose()


async def test_shrinking_the_pool_drops_dead_account_buckets() -> None:
    """계정이 줄면 사라진 계정의 버킷도 함께 버린다 — 남겨두면 `_pick_account`
    가 존재하지 않는 계정을 고를 수 있다."""
    s = _sched(workers=2)
    s.set_clients([_FakeClient(i) for i in range(4)])

    async def fn(client) -> None:
        return None

    await asyncio.gather(*(
        s.submit(key=f"k{i}", api_id="ka10001", priority="background", call=fn)
        for i in range(8)
    ))
    assert {k[0] for k in s._buckets} == {0, 1, 2, 3}

    s.set_clients([_FakeClient(0)])

    assert {k[0] for k in s._buckets} == {0}
    assert s._accounts == (0,)
    await s.aclose()


async def test_snapshot_exposes_per_account_call_counts() -> None:
    """쏠림이 보이지 않으면 앱키를 늘려도 배수가 안 나는 것을 알아챌 수 없다."""
    s = _sched(workers=2)
    s.set_clients([_FakeClient(0), _FakeClient(1)])

    async def fn(client) -> None:
        return None

    await asyncio.gather(*(
        s.submit(key=f"k{i}", api_id="ka10001", priority="background", call=fn)
        for i in range(6)
    ))

    snap = s.snapshot()
    assert snap["accounts"] == 2
    counts = snap["calls_by_account"]
    assert sum(counts.values()) == 6
    assert set(counts) == {0, 1}
    await s.aclose()


# === 인증 실패: 토큰 무효화 + 계정 격리 + 1회 재시도 (2026-08-04) =============
#
# 키움 토큰은 수명이 **두 축**이다: 시계 만료(`expires_dt`)와 벤더 측 무효화(8005).
# 후자는 만료 시각이 한참 남았는데도 죽는다 — 같은 앱키로 어딘가에서 재발급하면
# 이전 토큰이 무효가 된다. 앱키 4개 중 2개가 이렇게 죽어 /live 과거 캔들이 통째로
# 멎었다(2026-08-04 실측). 재시도를 **거버너 위**에 두는 것이 요점이다: 클라이언트
# 안에서 몰래 한 번 더 쏘면 그 콜이 TR 버킷을 안 거쳐 페이싱에서 보이지 않는다.


class _AuthFailingClient(_FakeClient):
    """`invalidate_token` 호출을 기록하는 계정 더블."""

    def __init__(self, account_id: int) -> None:
        super().__init__(account_id)
        self.invalidated = 0

    async def invalidate_token(self) -> None:
        self.invalidated += 1


def _auth_error(msg: str = "인증에 실패했습니다[8005:Token이 유효하지 않습니다]"):
    from hoga.live.kiwoom_errors import KiwoomAuthError

    return KiwoomAuthError(msg)


async def test_auth_failure_invalidates_token_and_retries_on_healthy_account() -> None:
    """죽은 앱키를 만나면 토큰을 버리고 **살아 있는 앱키로 요청이 완주**해야 한다.

    이게 없으면 죽은 계정에 배정된 요청이 그대로 실패하고, walk 는 한 페이지만
    실패해도 전체가 무너져 미캐시 날짜 전량이 `api_error` 가 된다.
    """
    s = _sched(workers=1)
    clients = [_AuthFailingClient(0), _AuthFailingClient(1)]
    s.set_clients(clients)
    seen: list[int] = []

    async def fn(client) -> str:
        seen.append(client.account_id)
        if client.account_id == 0:
            raise _auth_error()
        return "v"

    assert await s.submit(
        key="k", api_id="ka10001", priority="user_visible", call=fn) == "v"
    assert seen == [0, 1], "죽은 계정에서 한 번, 살아 있는 계정에서 한 번"
    assert clients[0].invalidated == 1, "죽은 계정의 토큰을 버려야 다음 발급이 산다"
    assert clients[1].invalidated == 0, "멀쩡한 계정의 토큰까지 버리면 안 된다"
    assert s._inflight == {}, "되큐 경로가 inflight 를 흘리면 안 된다"
    await s.aclose()


async def test_auth_retry_is_single_shot() -> None:
    """재발급이 쿨다운에 걸렸거나 자격증명 자체가 틀리면 두 번째도 같은 자리에서
    실패한다. 무제한 재시도면 그대로 무한 루프다."""
    s = _sched(workers=1)
    s.set_clients([_AuthFailingClient(0), _AuthFailingClient(1)])
    calls = 0

    async def fn(_client) -> None:
        nonlocal calls
        calls += 1
        raise _auth_error()

    from hoga.live.kiwoom_errors import KiwoomAuthError

    with pytest.raises(KiwoomAuthError):
        await s.submit(key="k", api_id="ka10001", priority="user_visible", call=fn)
    assert calls == 2, "최초 1 + 재시도 1 — 그 이상이면 루프다"
    assert s._inflight == {}
    await s.aclose()


async def test_auth_isolation_is_account_wide_not_per_tr() -> None:
    """**유량과 축이 다르다.** 429 는 (앱키, TR) 이라 그 버킷만 밀면 되지만, 죽은
    토큰은 그 계정의 **모든 TR** 을 못 쓴다. TR 버킷 하나만 밀면 같은 죽은 계정이
    다른 TR 로 계속 뽑힌다."""
    s = _sched(workers=1)
    s.set_clients([_AuthFailingClient(0), _AuthFailingClient(1)])

    async def fn(client) -> None:
        if client.account_id == 0:
            raise _auth_error()

    await s.submit(key="k", api_id="ka10001", priority="user_visible", call=fn)

    assert s._pick_account("ka10001") == 1
    assert s._pick_account("ka10080") == 1, "다른 TR 로도 죽은 계정을 고르면 안 된다"
    await s.aclose()


async def test_all_accounts_auth_blocked_still_dispatches() -> None:
    """전 계정이 격리돼도 `min` 은 하나를 고른다 — 데드락이 아니라 지연이고,
    그 시도가 곧 재발급 기회다."""
    s = _sched(workers=1)
    s.set_clients([_AuthFailingClient(0), _AuthFailingClient(1)])
    s._auth_blocked_until = {0: 1e18, 1: 1e18}

    async def fn(client) -> str:
        return f"ok{client.account_id}"

    assert (await s.submit(
        key="k", api_id="ka10001", priority="user_visible", call=fn)).startswith("ok")
    await s.aclose()


async def test_snapshot_exposes_auth_failures_and_blocked_accounts() -> None:
    """계정별 생사가 여기 보이지 않으면 서버를 직접 뒤져야만 진단된다 — 화면에는
    '일부 과거구간 로딩 실패' 밖에 안 뜬다."""
    s = _sched(workers=1)
    s.set_clients([_AuthFailingClient(0), _AuthFailingClient(1)])

    async def fn(client) -> None:
        if client.account_id == 0:
            raise _auth_error()

    await s.submit(key="k", api_id="ka10001", priority="user_visible", call=fn)

    snap = s.snapshot()
    assert snap["auth_failures_by_account"] == {0: 1}
    assert snap["auth_blocked_accounts"] == [0]
    await s.aclose()


async def test_shrinking_pool_drops_auth_isolation() -> None:
    """사라진 계정의 격리가 남아 있으면, 풀이 다시 커졌을 때 **다른 앱키가** 그
    account_id 를 물려받아 애먼 격리를 산다."""
    s = _sched(workers=1)
    s.set_clients([_AuthFailingClient(0), _AuthFailingClient(1)])
    # 격리를 직접 세운다 — 검증 대상이 `set_clients` 의 정리 규칙이고, 계정 1 이
    # 뽑히게 만들려면 계정 0 을 먼저 밀어야 해서 경로가 되레 흐려진다.
    s._auth_blocked_until = {1: 1e18}
    assert s.snapshot()["auth_blocked_accounts"] == [1]

    s.set_clients([_AuthFailingClient(0)])
    assert s.snapshot()["auth_blocked_accounts"] == []
    await s.aclose()
