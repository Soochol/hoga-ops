"""Stage 1 / Task 1.1 + 1.2 — KIS HTTP client tests."""
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
            await client.fetch_orderbook("003490")
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
            await client.fetch_orderbook("003490")
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
            await client.fetch_orderbook("003490")
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

    async def counting_acquire() -> None:
        calls["n"] += 1
        await real_acquire()

    client._rate_limiter.acquire = counting_acquire  # type: ignore[method-assign]
    try:
        await client.fetch_orderbook("003490")
        assert calls["n"] == 1
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
        ob = await client.fetch_orderbook("003490")
        assert ob is not None
        # 3 data calls: 2 EGW00201 + 1 OK. Sleeps fired BETWEEN attempts.
        assert counter["data"] == 3
        assert sleeps == [1.0, 2.0]
    finally:
        await client.aclose()


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
            await client.fetch_orderbook("003490")
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
            await client.fetch_orderbook("003490")
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
        await client.fetch_orderbook("003490")  # must not raise
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
            await client.fetch_orderbook("003490")
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
            await client.fetch_orderbook("003490")
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

    async def counting_acquire() -> None:
        acquires["n"] += 1
        await real_acquire()

    client._rate_limiter.acquire = counting_acquire  # type: ignore[method-assign]
    try:
        with pytest.raises(KisRateLimitError):
            await client.fetch_orderbook("003490")
        # 4 attempts ⇒ 4 token acquires (no re-use across retries).
        assert acquires["n"] == 4
    finally:
        await client.aclose()
