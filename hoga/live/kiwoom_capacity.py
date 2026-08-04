"""키움 REST 유량 거버너 — 단일 우선순위 큐 + **TR별** 토큰 버킷 (ADR-0136 §2).

## 버킷 단위가 TR 인 이유

벤더가 429 응답에 직접 적어 보낸다: `유량=5, **API ID=ka10080**`. 그리고 TR 간
독립을 실증했다 — `ka10080` 을 429 까지 밀어붙인 **직후 대기 없이** `ka10081` 을
호출하니 즉시 통과했다(#1015). 그래서 게이트는 앱키가 아니라 **TR** 이다.

첫 판은 여기서 **계정 차원이 통째로 사라진다**고 봤다 — 유량이 TR별이면 계정을 고를
이유가 없기 때문이다. 그 뒤 두 번 되돌아왔고, 둘 다 실측이 이유였다:

    ADR-0138    유량은 TR별인 **동시에 앱키별**이다 → 버킷 키가 (앱키, TR) 이 된다
    2026-08-04  토큰은 계정 단위로 죽는다(8005) → 계정 단위 격리가 필요하다

그래도 KIS 의 health check·failover 상태 기계는 되살리지 않았다. 둘 다 **`_available_at`
정렬 하나**에 얹혀 있다 — 물린 계정은 뒤로 밀리고 회복되면 스스로 돌아온다.

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
from collections.abc import Awaitable, Callable, Hashable, Sequence
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

# 인증 실패한 계정을 후보에서 미뤄 두는 시간.
# **토큰 재발급 쿨다운(`kiwoom_token_provider._REISSUE_COOLDOWN_MS` = 60s)과 맞춘다.**
# 더 짧으면 격리가 풀린 계정이 아직 쿨다운에 걸려 재발급에 실패하고, 실패→격리→해제→
# 재실패를 돌며 멀쩡한 앱키의 처리량만 갉아먹는다.
_AUTH_BLOCK_SECONDS = 60.0


class KiwoomCapacityOverloaded(RuntimeError):
    """큐가 상한을 넘었다 — 신규 요청 거절."""


@dataclass(order=True)
class _Request:
    order: int
    seq: int
    key: Hashable = field(compare=False)
    api_id: str = field(compare=False, default="")
    priority: Priority = field(compare=False, default="background")
    call: Callable[[Any], Awaitable[Any]] = field(compare=False, default=None)  # type: ignore[assignment]
    future: asyncio.Future = field(compare=False, default=None)  # type: ignore[assignment]
    deferred: bool = field(compare=False, default=False)
    """양보는 **요청당 1회**. 무제한이면 user_visible 이 오래 막힐 때 background 가
    큐를 맴돌며 워커를 태운다."""
    auth_retried: bool = field(compare=False, default=False)
    """인증 실패 재시도도 **요청당 1회**. 재발급이 쿨다운에 걸렸거나 자격증명 자체가
    틀렸으면 두 번째도 같은 자리에서 실패한다 — 무제한이면 그대로 무한 루프다."""
    requeued: bool = field(compare=False, default=False)
    """이번 순회가 이 요청을 큐로 되돌렸나. `_cleanup` 이 inflight 항목을 **떨어뜨리지
    않도록** 하는 표식이다 — 떨어뜨리면 같은 key 의 새 요청이 조인할 future 를 잃고
    중복 호출이 된다. 큐에서 꺼낼 때마다 초기화된다."""


class _TokenBucket:
    """(앱키, TR) 하나의 발사 게이트. 초당 `rate` 건."""

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

    def available_at(self) -> float:
        """다음 발사가 가능한 시각(monotonic). 계정 선택의 정렬 키다 — 429 로
        물린 계정은 `_next_at` 이 뒤로 밀려 자연히 후순위가 된다."""
        return max(self._next_at, time.monotonic())

    def penalize(self, seconds: float) -> None:
        """429 를 만났을 때 그 (앱키, TR) 만 잠시 물린다."""
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
        # 버킷 키가 (앱키, TR) 인 이유는 ADR-0138 실측이다: 유량은 TR별인 **동시에**
        # 앱키별이다. 앱키0 을 429 까지 밀어붙인 직후 앱키1 이 대기 없이 통과했다.
        self._buckets: dict[tuple[int, str], _TokenBucket] = {}
        # 계정 풀. 비어 있으면 계정 0 하나로 동작하고 클라이언트는 호출자가 준 것을
        # 쓴다 — 자격증명이 없는 환경·테스트에서 이 경로가 정상이다(ADR-0134).
        self._clients: tuple[Any, ...] = ()
        self._queue: asyncio.PriorityQueue[_Request] = asyncio.PriorityQueue()
        self._inflight: dict[Hashable, asyncio.Future] = {}
        self._queued_priority: dict[Hashable, Priority] = {}
        self._started: set[Hashable] = set()
        self._workers: list[asyncio.Task] = []
        # 워커가 붙어 있는 루프. 바뀌면 큐·inflight 를 통째로 버린다(_ensure_started).
        self._loop: asyncio.AbstractEventLoop | None = None
        self._n_workers = workers
        self._max_queued = max_queued
        self._seq = 0
        self.background_deferred_due_to_user_visible = 0
        self._calls_by_account: dict[int, int] = {}
        # 인증 실패로 격리된 계정의 해제 시각(monotonic). 버킷 penalize 와 **따로** 두는
        # 이유는 축이 다르기 때문이다: 유량은 (앱키, TR)별이라 버킷을 밀면 되지만,
        # 죽은 토큰은 그 계정의 **모든 TR** 을 못 쓴다. TR 버킷 하나만 밀면 같은 죽은
        # 계정이 다른 TR 로 계속 뽑힌다.
        self._auth_blocked_until: dict[int, float] = {}
        self._auth_failures_by_account: dict[int, int] = {}

    # --- 공개 API -----------------------------------------------------------

    def set_clients(self, clients: Sequence[Any]) -> None:
        """계정 풀을 등록한다. 유량이 앱키별이라 풀 크기가 곧 처리량 배수다
        (실측: 1키 4.17 → 2키 8.14 → 4키 18.4 콜/초, ADR-0138).

        멱등이고, 같은 풀을 다시 넣어도 버킷 상태를 잃지 않는다 — 풀이 줄어들 때만
        사라진 계정의 버킷을 버린다."""
        self._clients = tuple(clients)
        if self._clients:
            live = set(self._accounts)
            self._buckets = {k: v for k, v in self._buckets.items() if k[0] in live}
            # 격리 상태도 함께 버린다 — 사라진 계정의 차단이 남아 있으면, 나중에 풀이
            # 다시 커졌을 때 **다른 앱키가** 그 account_id 를 물려받아 애먼 격리를 산다.
            self._auth_blocked_until = {
                a: t for a, t in self._auth_blocked_until.items() if a in live
            }

    @property
    def _accounts(self) -> tuple[int, ...]:
        return tuple(range(len(self._clients))) if self._clients else (0,)

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[Any], Awaitable[_T]],
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
            "accounts": len(self._accounts),
            # 계정별 호출 수. 쏠림이 보이지 않으면 앱키를 늘려도 배수가 안 나는 것을
            # 알아챌 수 없다(ADR-0138).
            "calls_by_account": dict(sorted(self._calls_by_account.items())),
            # 계정별 인증 실패 누계와 **현재 격리 중인 계정**. 토큰이 죽으면 화면에는
            # "일부 과거구간 로딩 실패" 밖에 안 뜨고 원인은 벤더 msg 안에 있다 —
            # 계정별 생사가 여기 보이지 않으면 서버를 직접 뒤져야만 진단된다
            # (2026-08-04 조사에서 실제로 그랬다).
            "auth_failures_by_account": dict(sorted(self._auth_failures_by_account.items())),
            "auth_blocked_accounts": sorted(
                a for a, until in self._auth_blocked_until.items() if until > time.monotonic()
            ),
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
        call: Callable[[Any], Awaitable[Any]], future: asyncio.Future,
    ) -> _Request:
        self._seq += 1
        return _Request(
            order=_PRIORITY_ORDER[priority], seq=self._seq, key=key,
            api_id=api_id, priority=priority, call=call, future=future,
        )

    def _bucket(self, account_id: int, api_id: str) -> _TokenBucket:
        b = self._buckets.get((account_id, api_id))
        if b is None:
            b = _TokenBucket(self._tr_rates.get(api_id, self._rate) * _HEADROOM)
            self._buckets[(account_id, api_id)] = b
        return b

    def _available_at(self, account_id: int, api_id: str) -> float:
        """이 계정이 이 TR 을 다음에 쏠 수 있는 시각 — **유량과 인증 중 늦은 쪽**."""
        return max(
            self._bucket(account_id, api_id).available_at(),
            self._auth_blocked_until.get(account_id, 0.0),
        )

    def _pick_account(self, api_id: str) -> int:
        """가장 빨리 열리는 계정. 라운드로빈이 아닌 이유는 **failover 가 공짜로
        따라오기** 때문이다 — 429 를 맞아 `penalize` 된 계정은 `available_at()` 이
        뒤로 밀려 자동으로 후순위가 되고, 회복되면 스스로 돌아온다. KIS 시절의
        health check·failover 상태 기계를 되살릴 필요가 없다.

        인증 실패도 같은 원리에 얹는다(`_available_at`) — 토큰이 죽은 계정은 정렬에서
        뒤로 밀리고 격리가 풀리면 스스로 복귀한다. **전 계정이 격리돼도 `min` 은 하나를
        고르므로 데드락이 아니다** — 느려질 뿐이고, 그 시도가 재발급 기회가 된다."""
        accounts = self._accounts
        if len(accounts) == 1:
            return accounts[0]
        return min(accounts, key=lambda a: self._available_at(a, api_id))

    def _client_for(self, account_id: int) -> Any | None:
        """풀이 비었으면 None — 호출자가 넘긴 클라이언트를 쓰라는 신호다."""
        return self._clients[account_id] if account_id < len(self._clients) else None

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
        """워커를 **살아 있고 이 루프에 속한 것만** 남기고 모자란 만큼 채운다.

        `if self._workers: return` 은 안 된다. 이 거버너는 프로세스 싱글턴이라
        두 가지 방식으로 조용히 죽는다:

          - 워커가 끝났는데(`done()`) 리스트에 시체로 남아 있다
          - 워커가 **다른 이벤트 루프**에서 만들어졌다(테스트마다 새 루프,
            혹은 재기동 경로)

        둘 다 결과가 같다: 큐에 넣은 요청을 아무도 꺼내지 않아 `submit` 이
        **예외도 타임아웃도 없이 영원히 대기**한다. 무한 대기는 최악의 실패
        모드라 여기서 사전에 끊는다.
        """
        loop = asyncio.get_running_loop()
        if self._loop is not None and self._loop is not loop:
            # 루프가 바뀌었으면 큐·inflight 도 전부 죽은 루프 소유다. 남겨 두면
            # 새 요청이 **죽은 future 에 조인해서** 다시 무한 대기한다.
            self._queue = asyncio.PriorityQueue()
            self._inflight.clear()
            self._queued_priority.clear()
            self._started.clear()
            self._workers = []
        self._loop = loop
        self._workers = [t for t in self._workers if not t.done()]
        if self._workers:
            return
        self._workers = [
            asyncio.create_task(self._worker(), name=f"kiwoom-capacity-{i}")
            for i in range(self._n_workers)
        ]

    async def _worker(self) -> None:
        while True:
            req = await self._queue.get()
            req.requeued = False
            if req.future.done():
                continue
            # 기계 ④ 양보 (1차) — dequeue 직후. 우선순위 큐가 대개 먼저 걸러내므로
            # 여기서 걸리는 경우는 드물다.
            if self._should_defer(req):
                continue
            account = self._pick_account(req.api_id)
            self._started.add(req.key)
            try:
                await self._bucket(account, req.api_id).acquire()
                # 기계 ④ 양보 (2차) — **여기가 실효 지점이다.** background 가 버킷에서
                # 자는 동안 같은 TR 의 user_visible 이 도착할 수 있다. 버킷은 (앱키, TR)별이라
                # 그 대기가 곧 "인터랙티브 팬이 백필 뒤에 줄 서는" 상황이다.
                if self._should_defer(req):
                    self._started.discard(req.key)
                    continue
                self._calls_by_account[account] = self._calls_by_account.get(account, 0) + 1
                result = await req.call(self._client_for(account))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — future 로 전달, 워커는 살아남는다
                self._penalize_if_rate_limited(account, req.api_id, exc)
                if await self._recover_if_auth_failure(account, req, exc):
                    continue
                if not req.future.done():
                    req.future.set_exception(exc)
            else:
                if not req.future.done():
                    req.future.set_result(result)
            finally:
                self._cleanup(req)

    def _penalize_if_rate_limited(
        self, account_id: int, api_id: str, exc: BaseException
    ) -> None:
        from hoga.live.kiwoom_errors import KiwoomRateLimitError  # noqa: PLC0415 — 순환 절단

        if isinstance(exc, KiwoomRateLimitError):
            # 벤더가 상한을 알려줬으면 버킷을 그 값으로 교정한다. 유량은 앱키별이므로
            # **그 계정의 버킷만** 버린다 — 전 계정을 버리면 멀쩡한 앱키의 페이싱
            # 상태까지 잃는다(ADR-0138).
            if exc.quota and exc.quota > 0:
                self._tr_rates[api_id] = float(exc.quota)
                self._buckets.pop((account_id, api_id), None)
            self._bucket(account_id, api_id).penalize(1.0)
            log.warning(
                "kiwoom capacity: %s rate-limited on account %d (quota=%s)",
                api_id, account_id, exc.quota,
            )

    async def _recover_if_auth_failure(
        self, account_id: int, req: _Request, exc: BaseException
    ) -> bool:
        """인증 실패면 토큰을 버리고 계정을 격리한 뒤 **요청을 1회 되큐한다**.

        되큐했으면 True — 호출자는 future 를 건드리지 않고 다음 순회로 넘어간다.

        재시도가 **거버너 위**에 있는 것이 요점이다. 클라이언트 안에서 몰래 한 번 더
        쏘면 그 콜은 TR 버킷을 거치지 않아 페이싱에서 보이지 않는다(ADR-0137). 여기서
        되큐하면 재시도도 대기표를 뽑고, 격리 덕에 **살아 있는 앱키로 자동 failover**
        된다 — 계정 선택이 `_available_at` 정렬 하나로 끝나므로 별도 상태 기계가 없다.
        """
        from hoga.live.kiwoom_errors import KiwoomAuthError  # noqa: PLC0415 — 순환 절단

        if not isinstance(exc, KiwoomAuthError):
            return False

        self._auth_failures_by_account[account_id] = (
            self._auth_failures_by_account.get(account_id, 0) + 1
        )
        self._auth_blocked_until[account_id] = time.monotonic() + _AUTH_BLOCK_SECONDS
        client = self._client_for(account_id)
        invalidate = getattr(client, "invalidate_token", None)
        if invalidate is not None:
            try:
                await invalidate()
            except Exception:
                # 무효화 실패가 원래 인증 오류를 가리면 안 된다 — 격리는 이미 걸렸고,
                # 되큐 여부만 아래에서 정한다. logging.exception 이라 BLE001 은
                # 발화하지 않는다.
                log.exception("kiwoom capacity: token invalidate failed on account %d", account_id)
        log.warning(
            "kiwoom capacity: auth failure on account %d (%s) — isolated %.0fs, retry=%s",
            account_id, req.api_id, _AUTH_BLOCK_SECONDS, not req.auth_retried,
        )

        if req.auth_retried or req.future.done():
            return False
        req.auth_retried = True
        req.requeued = True
        self._queue.put_nowait(req)
        return True

    def _cleanup(self, req: _Request) -> None:
        self._started.discard(req.key)
        # 되큐된 요청은 **아직 살아 있다** — inflight 를 떨어뜨리면 같은 key 의 새 요청이
        # 조인할 future 를 잃고 중복 호출이 된다(기계 ②가 뚫린다).
        if req.requeued:
            return
        if self._inflight.get(req.key) is req.future:
            self._inflight.pop(req.key, None)
            self._queued_priority.pop(req.key, None)
