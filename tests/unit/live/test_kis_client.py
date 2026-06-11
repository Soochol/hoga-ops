"""Stage 1 / Task 1.1 + 1.2 — KIS HTTP client tests.

Task 13: `_get` 의미론(재시도/에러 정규화/율리미터) 테스트의 probe는
poller fetch가 은퇴하며 `client._get(...)` 직접 호출로 교체 — 검증 대상이
_get 계약 자체이므로 wrapper 메서드는 불필요하다."""
import asyncio
import json
import time

import httpx
import pytest

from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisClient,
    KisCredentials,
    KisRateLimitError,
    KisTransportError,
    _TokenBucket,
)
from tests.unit.live._fakes import FakeTokenProvider


class _RaisingTokenProvider:
    """Provider stub that raises KisAuthError on get_token() — used to verify
    that _get's retry loop does not swallow auth errors."""

    def get_token(self) -> str:
        raise KisAuthError("token issue failed")

    def close(self) -> None:
        pass


def _make_client_with_5xx(
    status: int,
    body,
    content_type: str = "application/json",
    *,
    _rate_limit_backoff: tuple[float, ...] = (1.0, 2.0, 4.0),
) -> KisClient:
    """Mock the data endpoint with status/body.

    ``_rate_limit_backoff`` defaults to production sequence; pass ``()`` for
    tests that assert raise-shape on EGW00201 and don't care about retry.
    """
    def handler(req: httpx.Request) -> httpx.Response:
        if isinstance(body, dict):
            return httpx.Response(status, json=body)
        return httpx.Response(
            status, content=body, headers={"content-type": content_type},
        )
    transport = httpx.MockTransport(handler)
    return KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=transport,
        _rate_limit_backoff=_rate_limit_backoff,
    )


@pytest.mark.asyncio
async def test_5xx_with_json_body_preserves_upstream_msg_cd() -> None:
    """KIS sometimes wraps a domain error in a 5xx — keep its msg_cd visible.

    Without this, the poller log shows `msg_cd=HTTP_500` for both a real
    gateway 5xx and a domain error like "session not open"; the operator
    can't tell them apart.
    """
    # NOTE: msg_cd must be a NON-token code here — EGW00121/00123 are KIS's
    # invalid/expired-token codes and now trigger the invalidate-and-retry
    # path; "장시간이 아닙니다" is a session-window domain error.
    client = _make_client_with_5xx(
        500, {"rt_cd": "1", "msg_cd": "OPSQ2000", "msg1": "장시간이 아닙니다"},
    )
    try:
        with pytest.raises(KisApiError) as exc_info:
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        err = exc_info.value
        assert err.msg_cd == "HTTP_500/OPSQ2000"
        assert err.msg1 == "장시간이 아닙니다"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_5xx_with_egw00201_raises_rate_limit_error() -> None:
    """KIS wraps the rate-limit code (EGW00201) in a 5xx envelope sometimes.

    Asserts only the exception SHAPE — retry behavior is covered by the
    dedicated retry tests below. `_rate_limit_backoff=()` disables retry so
    this test stays fast.
    """
    client = _make_client_with_5xx(
        500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "거래량 초과"},
        _rate_limit_backoff=(),
    )
    try:
        with pytest.raises(KisRateLimitError) as exc_info:
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        # Surface both the HTTP status and the upstream code so the
        # rate_limited log can name the precise upstream signal.
        assert "HTTP_500/EGW00201" in str(exc_info.value)
        assert "거래량 초과" in str(exc_info.value)
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_5xx_with_non_json_body_falls_back_to_text() -> None:
    """Gateway HTML / plain-text 5xx bodies keep the historical raw-text path."""
    client = _make_client_with_5xx(
        502, b"<html><body>502 Bad Gateway</body></html>",
        content_type="text/html",
    )
    try:
        with pytest.raises(KisApiError) as exc_info:
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        err = exc_info.value
        assert err.msg_cd == "HTTP_502"
        assert "Bad Gateway" in err.msg1
    finally:
        await client.aclose()


# ------------------------------------------------------------------------
# Token bucket rate limiter
# ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_token_bucket_lets_initial_burst_through() -> None:
    """Bucket starts full so short bursts under capacity don't pay a penalty.

    This is the per-code 3-way fetch case (`asyncio.gather` 3 calls at once
    while we're well under steady-state rate): they should all go through
    without artificial sleep, otherwise every poller cycle starts slow.
    """
    bucket = _TokenBucket(rate=10.0)
    start = time.monotonic()
    for _ in range(10):
        await bucket.acquire()
    elapsed = time.monotonic() - start
    # 10 initial tokens consumed instantly — well under 100ms even on slow CI.
    assert elapsed < 0.1


@pytest.mark.asyncio
async def test_token_bucket_paces_to_rate_when_drained() -> None:
    """Past the initial burst, calls space out to the configured rate.

    With rate=10/sec, the 11th call has to wait for one token to refill —
    ~100ms. Tested singly so we measure the wait directly without floating-
    point compounding over a long sequence.
    """
    bucket = _TokenBucket(rate=10.0)
    for _ in range(10):
        await bucket.acquire()
    start = time.monotonic()
    await bucket.acquire()
    elapsed = time.monotonic() - start
    # Expected ~100ms; allow generous tolerance for event-loop scheduling.
    assert 0.05 < elapsed < 0.3


@pytest.mark.asyncio
async def test_token_bucket_serialises_concurrent_acquirers() -> None:
    """Multiple tasks acquiring simultaneously cumulatively respect the rate.

    Models the actual production scenario: poller cycle fires three
    coroutines (`asyncio.gather`) while a backfill request lands at the
    same instant. All four contend for the same bucket. Total wall time
    must reflect the cumulative cost, not let any acquirer "skip the queue".
    """
    bucket = _TokenBucket(rate=10.0)
    # Drain the initial burst.
    for _ in range(10):
        await bucket.acquire()
    start = time.monotonic()
    # 5 concurrent acquirers past empty bucket: total wait ≥ (5-1)/10 = 0.4s
    # because each needs ~100ms beyond the previous.
    await asyncio.gather(*(bucket.acquire() for _ in range(5)))
    elapsed = time.monotonic() - start
    assert elapsed >= 0.4


@pytest.mark.asyncio
async def test_token_bucket_invalid_rate_rejected() -> None:
    """Negative / zero rate is a programming error, not a soft default."""
    with pytest.raises(ValueError):
        _TokenBucket(rate=0)
    with pytest.raises(ValueError):
        _TokenBucket(rate=-1.0)


# ── 우선순위 레인 (2026-06-09): foreground(사용자 차트 대기)가 background(폴러/
# refetch/투자자)보다 토큰을 먼저 받는다. 단일 15/s 예산은 그대로 — 순서만 바뀜. ──


@pytest.mark.asyncio
async def test_token_bucket_foreground_served_before_background() -> None:
    """드레인된 버킷에서 background는 foreground 대기자에게 토큰을 양보한다.

    bg 3개가 먼저 대기하더라도, fg 대기자가 있는 동안 bg는 토큰을 양보하므로
    리필되는 토큰은 전부 fg가 먼저 가져간다 → 모든 fg가 모든 bg보다 앞선다.
    이게 핵심 계약: '방금 누른 차트' fetch가 연속 백그라운드 부하 앞으로 점프.
    """
    bucket = _TokenBucket(rate=20.0, yield_s=0.002, bg_max_yield_s=100.0)
    # 드레인: 이후 acquire는 리필을 기다려야 함.
    bucket._tokens = 0.0
    bucket._last = time.monotonic()
    order: list[str] = []

    async def acq(tag: str, fg: bool) -> None:
        await bucket.acquire(foreground=fg)
        order.append(tag)

    tasks = [asyncio.create_task(acq(f"bg{i}", False)) for i in range(3)]
    await asyncio.sleep(0.01)  # bg들이 먼저 대기 시작 (리필 1토큰=0.05s라 아직 0개 부여)
    tasks += [asyncio.create_task(acq(f"fg{i}", True)) for i in range(3)]
    await asyncio.gather(*tasks)

    fg_pos = [i for i, t in enumerate(order) if t.startswith("fg")]
    bg_pos = [i for i, t in enumerate(order) if t.startswith("bg")]
    assert max(fg_pos) < min(bg_pos), f"fg가 bg보다 먼저여야 함: {order}"


@pytest.mark.asyncio
async def test_token_bucket_background_normal_without_foreground() -> None:
    """foreground 대기자가 없으면 background는 평소처럼 즉시 토큰을 받는다."""
    bucket = _TokenBucket(rate=100.0)
    # 토큰 충분 + fg 없음 → 즉시 (양보 없음).
    await asyncio.wait_for(bucket.acquire(foreground=False), timeout=0.1)


@pytest.mark.asyncio
async def test_token_bucket_starvation_backstop() -> None:
    """누적 양보가 상한을 넘으면 background도 강제 획득(영구 기아 방지).

    fg 대기자가 계속 있어도(여기선 인위로 _fg_waiters=1 유지) bg_max_yield_s
    경과 후 bg가 토큰을 가져간다.
    """
    bucket = _TokenBucket(rate=50.0, yield_s=0.01, bg_max_yield_s=0.05)
    bucket._tokens = 10.0  # 토큰은 있음 — 막는 건 오직 양보 규칙
    bucket._fg_waiters = 1  # 사라지지 않는 fg 대기자 시뮬
    # bg는 ~0.05s 양보 후 백스톱으로 강제 획득 → timeout 안에 완료.
    await asyncio.wait_for(bucket.acquire(foreground=False), timeout=1.0)


@pytest.mark.asyncio
async def test_token_bucket_foreground_still_respects_rate_cap() -> None:
    """foreground도 토큰 없이는 못 간다 — 우선순위는 순서일 뿐 15/s 천장은 불변."""
    bucket = _TokenBucket(rate=10.0)
    bucket._tokens = 0.0
    bucket._last = time.monotonic()
    start = time.monotonic()
    await bucket.acquire(foreground=True)
    elapsed = time.monotonic() - start
    # rate=10 → 1토큰 리필 ~0.1s. foreground라도 기다림.
    assert elapsed >= 0.05


@pytest.mark.asyncio
async def test_token_bucket_foreground_waiter_count_released_on_cancel() -> None:
    """취소돼도 _fg_waiters는 finally로 복구 — 이후 background가 영구 양보하지 않게."""
    bucket = _TokenBucket(rate=10.0)
    bucket._tokens = 0.0
    bucket._last = time.monotonic()
    task = asyncio.create_task(bucket.acquire(foreground=True))
    await asyncio.sleep(0.01)  # fg가 대기 진입 → _fg_waiters=1
    assert bucket._fg_waiters == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert bucket._fg_waiters == 0  # finally 복구


@pytest.mark.asyncio
async def test_token_bucket_background_not_starved_under_sustained_foreground() -> None:
    """지속 foreground가 모든 리필 토큰을 가져가도 background는 백스톱 안에 진전.

    적대리뷰 L2 P1 회귀: 드레인된 버킷 + 끊임없는 foreground flood에서, background는
    토큰을 한 번도 '가용'으로 보지 못한다(fg가 즉시 소비). 양보-sleep 누적 방식은
    이때 진전이 0이라 영구 기아했다. 벽시계 데드라인 방식은 bg_max_yield_s 경과 후
    양보를 멈추고 공정 경쟁에 합류하므로 bounded 시간 안에 토큰을 얻는다.
    """
    bucket = _TokenBucket(rate=50.0, yield_s=0.005, bg_max_yield_s=0.1)
    bucket._tokens = 0.0
    bucket._last = time.monotonic()
    stop = False

    async def fg_flood() -> None:
        while not stop:
            await bucket.acquire(foreground=True)

    floods = [asyncio.create_task(fg_flood()) for _ in range(3)]
    try:
        # flood에도 불구하고 background는 BOUNDED 시간에 완료한다(과거 코드는 무한 대기).
        # 고정 코드는 backstop(0.1s) 후 FIFO lock으로 공정 경쟁해 보통 ~0.2s에 완료하나,
        # lock 경쟁 스케줄링 변동으로 1s를 넘을 수 있다(분산 큼). 타임아웃은 '무한 vs
        # 유한'을 가르는 용도라 넉넉히 둔다 — 5s는 관측 최악(~1.2s)의 4배 여유.
        await asyncio.wait_for(bucket.acquire(foreground=False), timeout=5.0)
    finally:
        stop = True
        for t in floods:
            t.cancel()
        await asyncio.gather(*floods, return_exceptions=True)


@pytest.mark.asyncio
async def test_token_bucket_invalid_yield_params_rejected() -> None:
    """yield_s<=0(라이브락/busy-spin) / bg_max_yield_s<0(우선순위 무력화)은 거부.

    적대리뷰 L2 P3: yield_s=0이면 양보 분기가 wait=0 busy-spin이 되어 영구 기아 +
    이벤트루프 소진. 생성 시점에 막는다(rate 검증과 동일 정책).
    """
    with pytest.raises(ValueError):
        _TokenBucket(rate=10.0, yield_s=0.0)
    with pytest.raises(ValueError):
        _TokenBucket(rate=10.0, yield_s=-0.01)
    with pytest.raises(ValueError):
        _TokenBucket(rate=10.0, bg_max_yield_s=-1.0)


@pytest.mark.asyncio
async def test_kis_client_get_goes_through_rate_limiter() -> None:
    """`_get` must route every call through `_rate_limiter.acquire()`.

    Without this contract, future endpoints that bypass `_get` would
    silently escape the per-API-key budget — exactly the regression the
    rate limiter exists to prevent.
    """
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "rt_cd": "0",
            "output1": {
                **{f"askp{i}": "0" for i in range(1, 11)},
                **{f"askp_rsqn{i}": "0" for i in range(1, 11)},
                **{f"bidp{i}": "0" for i in range(1, 11)},
                **{f"bidp_rsqn{i}": "0" for i in range(1, 11)},
                "total_askp_rsqn": "0",
                "total_bidp_rsqn": "0",
            },
        })
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    calls = {"n": 0}
    real_acquire = client._rate_limiter.acquire

    async def counting_acquire(*, foreground: bool = False) -> None:
        calls["n"] += 1
        await real_acquire(foreground=foreground)

    client._rate_limiter.acquire = counting_acquire  # type: ignore[method-assign]
    try:
        await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert calls["n"] == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_foreground_flag_threads_to_rate_limiter() -> None:
    """foreground 인자가 _get·공개 fetch_*를 거쳐 _rate_limiter.acquire까지 전파.

    past-candles/daily 라우트는 foreground=True로 호출(사용자 차트 대기) → 우선순위
    레인. 폴러/스크리너 등 기본값은 False(배경). acquire가 본 flag를 기록해 검증.
    """
    def handler(req: httpx.Request) -> httpx.Response:
        # output2 빈 배열 → fetch_past_minute_candles가 한 번 _get 후 즉시 종료.
        return httpx.Response(200, json={"rt_cd": "0", "output2": []})

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    seen: list[bool] = []
    real_acquire = client._rate_limiter.acquire

    async def spy_acquire(*, foreground: bool = False) -> None:
        seen.append(foreground)
        await real_acquire(foreground=foreground)

    client._rate_limiter.acquire = spy_acquire  # type: ignore[method-assign]
    try:
        await client._get(path="/uapi/probe", tr_id="P", params={}, foreground=True)
        assert seen[-1] is True
        await client._get(path="/uapi/probe", tr_id="P", params={})
        assert seen[-1] is False
        # 공개 메서드: past-candles는 foreground=True (라우트가 그렇게 호출).
        seen.clear()
        await client.fetch_past_minute_candles("005930", "20260609", foreground=True)
        assert seen and all(f is True for f in seen)
        # 기본값(폴러/스크리너 경로) = background.
        seen.clear()
        await client.fetch_past_minute_candles("005930", "20260609")
        assert seen and all(f is False for f in seen)
    finally:
        await client.aclose()


# ------------------------------------------------------------------------
# ADR-0049: centralized EGW00201 retry in _get
# ------------------------------------------------------------------------


def _make_attempt_counting_client(
    *,
    responses: list,
    _rate_limit_backoff: tuple[float, ...] = (0.0, 0.0, 0.0),
) -> tuple[KisClient, dict]:
    """Per-attempt response sequence. ``responses[i]`` is consumed on the
    i-th data-endpoint call; the last entry is reused after exhaustion so
    tests can model "fails N times then succeeds forever" or "fails forever".

    Each entry is `(status, json_or_bytes)`; status 200 with a dict body
    flows through ``_unwrap``, other statuses raise httpx.HTTPStatusError.
    Returns the client + a counter dict whose ``["data"]`` key records the
    number of data-endpoint calls.
    """
    counter = {"data": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        idx = min(counter["data"], len(responses) - 1)
        counter["data"] += 1
        status, body = responses[idx]
        return httpx.Response(status, json=body)

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
        _rate_limit_backoff=_rate_limit_backoff,
    )
    return client, counter


def _ok_orderbook_body() -> dict:
    return {
        "rt_cd": "0",
        "output1": {
            **{f"askp{i}": "0" for i in range(1, 11)},
            **{f"askp_rsqn{i}": "0" for i in range(1, 11)},
            **{f"bidp{i}": "0" for i in range(1, 11)},
            **{f"bidp_rsqn{i}": "0" for i in range(1, 11)},
            "total_askp_rsqn": "0",
            "total_bidp_rsqn": "0",
        },
    }


@pytest.mark.asyncio
async def test_get_retries_on_rate_limit_5xx_then_succeeds(monkeypatch) -> None:
    """Two transient 5xx-EGW00201 responses followed by 200/OK — _get retries
    and finally returns the body. Validates ADR-0049's primary contract.
    """
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    monkeypatch.setattr("hoga.live.kis_client.asyncio.sleep", fake_sleep)
    client, counter = _make_attempt_counting_client(
        responses=[
            (500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "too fast"}),
            (500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "too fast"}),
            (200, _ok_orderbook_body()),
        ],
        _rate_limit_backoff=(1.0, 2.0, 4.0),
    )
    try:
        body = await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert body.get("rt_cd") == "0"
        # 3 data calls: 2 EGW00201 + 1 OK. Sleeps fired BETWEEN attempts.
        assert counter["data"] == 3
        assert sleeps == [1.0, 2.0]
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_rate_limit_retry_is_logged(monkeypatch, caplog) -> None:
    """스펙 2026-06-08 ⑤: 재시도는 +1~7s의 침묵 지연이었다 — 첫 재시도는
    WARNING(운영 신호), 이후 재시도는 DEBUG(병렬 fetch 동시 재시도 로그 벽 방지)."""
    import logging

    async def fake_sleep(s: float) -> None:
        return

    monkeypatch.setattr("hoga.live.kis_client.asyncio.sleep", fake_sleep)
    client, _counter = _make_attempt_counting_client(
        responses=[
            (500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "too fast"}),
            (500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "too fast"}),
            (200, _ok_orderbook_body()),
        ],
        _rate_limit_backoff=(1.0, 2.0, 4.0),
    )
    try:
        with caplog.at_level(logging.DEBUG, logger="hoga.live.kis_client"):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
    finally:
        await client.aclose()
    retry_logs = [r for r in caplog.records if "EGW00201" in r.getMessage()]
    assert len(retry_logs) == 2
    assert retry_logs[0].levelno == logging.WARNING
    assert "/uapi/probe" in retry_logs[0].getMessage()
    assert "1/3" in retry_logs[0].getMessage()
    assert retry_logs[1].levelno == logging.DEBUG


@pytest.mark.asyncio
async def test_get_retries_on_rt_cd_egw00201_then_raises(monkeypatch) -> None:
    """200/rt_cd!=0/EGW00201 path: the JSON-envelope flavour of rate limit.
    Same exception type as the 5xx-EGW00201 path, so the same retry loop
    catches it. Coverage gap closed by ADR-0049.
    """
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    monkeypatch.setattr("hoga.live.kis_client.asyncio.sleep", fake_sleep)
    client, counter = _make_attempt_counting_client(
        responses=[(200, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "rate limited"})],
        _rate_limit_backoff=(1.0, 2.0, 4.0),
    )
    try:
        with pytest.raises(KisRateLimitError):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        # 4 attempts = 1 initial + 3 retries; 3 sleeps between them.
        assert counter["data"] == 4
        assert sleeps == [1.0, 2.0, 4.0]
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_get_does_not_retry_on_api_error(monkeypatch) -> None:
    """Non-EGW00201 KisApiError must propagate on the first attempt — those
    are caller-actionable (session window, suspended stock, etc.).
    """
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    monkeypatch.setattr("hoga.live.kis_client.asyncio.sleep", fake_sleep)
    # Non-token msg_cd (EGW00121/00123 would trigger the invalidate-and-retry
    # path; that behavior has its own tests below).
    client, counter = _make_attempt_counting_client(
        responses=[(200, {"rt_cd": "1", "msg_cd": "OPSQ2000", "msg1": "장시간 아님"})],
    )
    try:
        with pytest.raises(KisApiError):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert counter["data"] == 1
        assert sleeps == []
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_token_invalid_invalidates_and_retries_once() -> None:
    """EGW00123 (expired token): _get must invalidate the provider's cached
    token and retry once with a fresh one — without this a server-side
    revocation had NO recovery path (dead token served from memory+disk for
    up to ~24h, surviving restarts)."""
    client, counter = _make_attempt_counting_client(
        responses=[
            (200, {"rt_cd": "1", "msg_cd": "EGW00123", "msg1": "기간이 만료된 token 입니다"}),
            (200, _ok_orderbook_body()),
        ],
    )
    provider = client._token_provider
    try:
        await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})  # must not raise
        assert counter["data"] == 2
        assert provider.invalidated == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_token_invalid_twice_propagates() -> None:
    """A second consecutive token-invalid response propagates (no retry loop)."""
    client, counter = _make_attempt_counting_client(
        responses=[(200, {"rt_cd": "1", "msg_cd": "EGW00121", "msg1": "유효하지 않은 token 입니다"})],
    )
    provider = client._token_provider
    try:
        with pytest.raises(KisApiError):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert counter["data"] == 2  # original + one retry
        assert provider.invalidated == 1  # invalidated once, not in a loop
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_get_does_not_retry_on_auth_error() -> None:
    """KisAuthError from the token provider short-circuits the retry loop —
    no point retrying data fetches when token acquisition itself fails.
    """
    data_calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        data_calls["n"] += 1
        return httpx.Response(200, json=_ok_orderbook_body())

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=_RaisingTokenProvider(),
        _transport=httpx.MockTransport(handler),
        _rate_limit_backoff=(0.0, 0.0, 0.0),
    )
    try:
        with pytest.raises(KisAuthError):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        # Data endpoint never reached — auth failed first.
        assert data_calls["n"] == 0
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_get_retry_false_kwarg_disables_retry(monkeypatch) -> None:
    """``retry=False`` is the diagnostic opt-out: callers that explicitly want
    raw single-shot behavior (e.g. a probe asking "is KIS currently rate-
    limiting me?") must NOT get the retry-then-succeed safety net.
    """
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    monkeypatch.setattr("hoga.live.kis_client.asyncio.sleep", fake_sleep)
    client, counter = _make_attempt_counting_client(
        responses=[(200, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "rate"})],
    )
    try:
        with pytest.raises(KisRateLimitError):
            # Direct _get call so we can pass retry=False — fetch_* helpers
            # don't expose it, by design (production callers always retry).
            await client._get(
                path="/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
                tr_id="FHKST01010200",
                params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": "003490"},
                retry=False,
            )
        assert counter["data"] == 1
        assert sleeps == []
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_get_approval_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/oauth2/Approval"
        body = json.loads(request.content)
        assert body == {"grant_type": "client_credentials",
                        "appkey": "AK", "secretkey": "AS"}  # 필드명 secretkey!
        return httpx.Response(200, json={"approval_key": "APPROVAL-123"})

    kis = KisClient(
        KisCredentials(app_key="AK", app_secret="AS"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        assert await kis.get_approval_key() == "APPROVAL-123"
    finally:
        await kis.aclose()


async def test_get_approval_key_missing_key_raises_with_body() -> None:
    """200 without approval_key (KIS error envelope) — the error message must
    carry the response body, since the WS reconnect loop's `err=%r` log is the
    operator's only diagnostic surface (Task 6)."""
    transport = httpx.MockTransport(
        lambda req: httpx.Response(200, json={"error_description": "bad appkey"})
    )
    kis = KisClient(
        KisCredentials(app_key="AK", app_secret="AS"),
        token_provider=FakeTokenProvider(),
        _transport=transport,
    )
    try:
        with pytest.raises(KisAuthError) as exc_info:
            await kis.get_approval_key()
        assert "bad appkey" in str(exc_info.value)
    finally:
        await kis.aclose()


async def test_get_approval_key_non_200_raises_with_status() -> None:
    """Non-200 → KisAuthError naming the HTTP status (same pattern as
    token issuance) instead of a bare httpx.HTTPStatusError traceback."""
    transport = httpx.MockTransport(
        lambda req: httpx.Response(403, json={"error_description": "forbidden"})
    )
    kis = KisClient(
        KisCredentials(app_key="AK", app_secret="AS"),
        token_provider=FakeTokenProvider(),
        _transport=transport,
    )
    try:
        with pytest.raises(KisAuthError) as exc_info:
            await kis.get_approval_key()
        assert "HTTP 403" in str(exc_info.value)
    finally:
        await kis.aclose()


async def test_get_retry_re_acquires_rate_limiter_each_attempt(monkeypatch) -> None:
    """Each retry passes through the token bucket again — a retry burst can't
    skip the per-API-key budget by reusing the previous attempt's token. This
    is the invariant that lets us reason about poller + backfill coexistence:
    no matter how many times any caller retries, the total tokens consumed
    equals the total HTTP attempts.
    """

    async def fake_sleep(s: float) -> None:
        pass

    monkeypatch.setattr("hoga.live.kis_client.asyncio.sleep", fake_sleep)
    client, _ = _make_attempt_counting_client(
        responses=[(200, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "rate"})],
    )
    acquires = {"n": 0}
    real_acquire = client._rate_limiter.acquire

    async def counting_acquire(*, foreground: bool = False) -> None:
        acquires["n"] += 1
        await real_acquire(foreground=foreground)

    client._rate_limiter.acquire = counting_acquire  # type: ignore[method-assign]
    try:
        with pytest.raises(KisRateLimitError):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        # 4 attempts ⇒ 4 token acquires (no re-use across retries).
        assert acquires["n"] == 4
    finally:
        await client.aclose()


# ---------------------------------------------------------------------------
# Transport-error normalization + selective retry (regression: 2026-06-11
# foreground daily-candle backfill 500 — httpx.RemoteProtocolError escaped
# _do_get_once's HTTPStatusError-only catch and bubbled to a 500). See
# ADR-0050 amendment. Design decisions D1–D8 locked via /plan-eng-review.
# ---------------------------------------------------------------------------
def _make_client_for_transport(
    handler,
    *,
    _transport_retry_backoff: tuple[float, ...] = (0.0,),
    _rate_limit_backoff: tuple[float, ...] = (),
) -> KisClient:
    """Build a client whose mock transport runs ``handler`` — which may RAISE
    an httpx transport exception to simulate a TCP disconnect / connect failure.

    ``_transport_retry_backoff`` mirrors ``_rate_limit_backoff``: a tuple of
    sleeps between transport retries (``len`` = retry count). Defaults to one
    instant retry; pass ``()`` to assert raise-shape without retry.
    """
    return KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
        _rate_limit_backoff=_rate_limit_backoff,
        _transport_retry_backoff=_transport_retry_backoff,
    )


@pytest.mark.asyncio
async def test_remote_protocol_error_normalized_to_kis_transport_error() -> None:
    """KIS closing the TCP connection without a response (httpx
    RemoteProtocolError) must NOT escape as a bare httpx error — it surfaces
    as KisTransportError, a KisApiError SUBTYPE so every existing
    ``except KisApiError`` site degrades it instead of 500ing.
    """
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.RemoteProtocolError(
            "Server disconnected without sending a response."
        )

    client = _make_client_for_transport(handler, _transport_retry_backoff=())
    try:
        with pytest.raises(KisTransportError) as exc_info:
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        err = exc_info.value
        # Subtype contract: degrades at any `except KisApiError` boundary.
        assert isinstance(err, KisApiError)
        # Synthetic msg_cd names the transport class; NEVER an EGW token code,
        # so _get's token-invalid branch can't false-trigger on it.
        assert err.msg_cd == "TRANSPORT/RemoteProtocolError"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_transport_error_retried_then_recovers() -> None:
    """One disconnect is transient (stale keepalive) — a single near-immediate
    retry on a fresh connection recovers it, so the user's chart backfill
    succeeds instead of the batch dropping to a data_warning."""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.RemoteProtocolError(
                "Server disconnected without sending a response."
            )
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "OK", "msg1": "ok"})

    client = _make_client_for_transport(handler, _transport_retry_backoff=(0.0,))
    try:
        body = await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert body["rt_cd"] == "0"
        assert calls["n"] == 2  # failed once, retried once, succeeded
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_read_timeout_normalized_but_not_retried() -> None:
    """A ReadTimeout means KIS received the request but is slow to answer —
    replaying just doubles the 10s wait and piles load on an already-slow
    upstream. So it is normalized (no 500 escapes) but NOT retried; only
    connection-level failures (RemoteProtocolError/ConnectError/...) replay.
    Asserts the upstream is hit exactly once despite a retry being configured."""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ReadTimeout("timed out")

    client = _make_client_for_transport(handler, _transport_retry_backoff=(0.0,))
    try:
        with pytest.raises(KisTransportError) as exc_info:
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert exc_info.value.msg_cd == "TRANSPORT/ReadTimeout"
        assert calls["n"] == 1  # normalized, NOT retried
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_connection_error_retries_are_bounded() -> None:
    """A persistent connection-level failure replays per the backoff tuple then
    gives up — it does not loop forever. With a 2-entry backoff the upstream is
    hit exactly 3 times (1 initial + 2 retries) before KisTransportError."""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("connection refused")

    client = _make_client_for_transport(handler, _transport_retry_backoff=(0.0, 0.0))
    try:
        with pytest.raises(KisTransportError):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert calls["n"] == 3  # 1 + 2 retries, bounded
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_transport_error_does_not_invalidate_token() -> None:
    """Regression guard for the subtype decision: KisTransportError IS a
    KisApiError, so _get's `except KisApiError` sees it — but its synthetic
    msg_cd ('TRANSPORT/...') carries no EGW00121/00123 token code, so the
    invalidate-and-retry path must NOT fire. A network blip must never nuke a
    valid cached token (a needless re-issue, and a retry storm if it loops)."""
    provider = FakeTokenProvider()

    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.RemoteProtocolError("server disconnected")

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=provider,
        _transport=httpx.MockTransport(handler),
        _rate_limit_backoff=(),
        _transport_retry_backoff=(),
    )
    try:
        with pytest.raises(KisTransportError):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert provider.invalidated == 0
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_retry_false_disables_transport_retry_too() -> None:
    """``retry=False`` means raw single-shot (ADR-0050 invariant 3) — it must
    disable the transport replay as well, not just the EGW00201 backoff, so a
    diagnostic probe sees exactly one wire attempt."""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("connection refused")

    client = _make_client_for_transport(handler, _transport_retry_backoff=(0.0,))
    try:
        with pytest.raises(KisTransportError):
            await client._get(
                path="/uapi/probe", tr_id="PROBE0000", params={}, retry=False
            )
        assert calls["n"] == 1  # single-shot: no transport replay under retry=False
    finally:
        await client.aclose()
