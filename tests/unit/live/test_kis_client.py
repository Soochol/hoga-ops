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
from hoga.live.index_registry import get_representative_index
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
async def test_fetch_index_minute_candles_calls_kis_time_chart_endpoint() -> None:
    captured: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["path"] = req.url.path
        captured["params"] = dict(req.url.params)
        captured["tr_id"] = req.headers.get("tr_id")
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "0",
                "msg1": "OK",
                "output2": [
                    {
                        "stck_bsop_date": "20260619",
                        "stck_cntg_hour": "093000",
                        "bstp_nmix_oprc": "2850.10",
                        "bstp_nmix_hgpr": "2852.34",
                        "bstp_nmix_lwpr": "2849.87",
                        "bstp_nmix_prpr": "2851.67",
                        "cntg_vol": "123456",
                    },
                ],
            },
        )

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        result = await client.fetch_index_minute_candles(
            get_representative_index("KOSPI"),
            "20260619",
            "20260619",
            bucket_seconds=60,
            foreground=True,
        )
    finally:
        await client.aclose()

    assert captured["path"] == "/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice"
    assert captured["tr_id"] == "FHKUP03500200"
    assert captured["params"] == {
        "FID_COND_MRKT_DIV_CODE": "U",
        "FID_ETC_CLS_CODE": "0",
        "FID_INPUT_ISCD": "0001",
        "FID_INPUT_HOUR_1": "60",
        "FID_PW_DATA_INCU_YN": "Y",
    }
    assert [c.close for c in result.candles] == [2851.67]
    assert result.candles[0].t_ms == 1781829000000


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("display_bucket_seconds", "kis_input_hour"),
    [
        (60, "60"),
        (180, "60"),
        (300, "300"),
        (600, "600"),
        (900, "300"),
        (1800, "600"),
    ],
)
async def test_fetch_index_minute_candles_uses_best_kis_source_for_display_bucket(
    display_bucket_seconds: int,
    kis_input_hour: str,
) -> None:
    captured: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["params"] = dict(req.url.params)
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "0",
                "msg1": "OK",
                "output2": [
                    {
                        "stck_bsop_date": "20260619",
                        "stck_cntg_hour": "090000",
                        "bstp_nmix_oprc": "2850.10",
                        "bstp_nmix_hgpr": "2852.34",
                        "bstp_nmix_lwpr": "2849.87",
                        "bstp_nmix_prpr": "2851.67",
                        "cntg_vol": "123456",
                    },
                ],
            },
        )

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        await client.fetch_index_minute_candles(
            get_representative_index("KOSPI"),
            "20260619",
            "20260619",
            bucket_seconds=display_bucket_seconds,
            foreground=True,
        )
    finally:
        await client.aclose()

    assert (captured["params"] or {})["FID_INPUT_HOUR_1"] == kis_input_hour


@pytest.mark.asyncio
async def test_fetch_index_minute_candles_aggregates_5m_source_to_15m_display_bucket() -> None:
    captured: dict[str, object] = {}

    def row(hhmmss: str, open_s: str, high_s: str, low_s: str, close_s: str, volume_s: str) -> dict[str, str]:
        return {
            "stck_bsop_date": "20260619",
            "stck_cntg_hour": hhmmss,
            "bstp_nmix_oprc": open_s,
            "bstp_nmix_hgpr": high_s,
            "bstp_nmix_lwpr": low_s,
            "bstp_nmix_prpr": close_s,
            "cntg_vol": volume_s,
        }

    def handler(req: httpx.Request) -> httpx.Response:
        captured["params"] = dict(req.url.params)
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "0",
                "msg1": "OK",
                "output2": [
                    row("090000", "100", "105", "99", "104", "10"),
                    row("090500", "104", "108", "103", "106", "20"),
                    row("091000", "106", "109", "101", "102", "30"),
                    row("091500", "102", "103", "100", "101", "40"),
                ],
            },
        )

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        result = await client.fetch_index_minute_candles(
            get_representative_index("KOSPI"),
            "20260619",
            "20260619",
            bucket_seconds=900,
            foreground=True,
        )
    finally:
        await client.aclose()

    assert (captured["params"] or {})["FID_INPUT_HOUR_1"] == "300"
    assert len(result.candles) == 2
    first = result.candles[0]
    assert first.open == 100.0
    assert first.high == 109.0
    assert first.low == 99.0
    assert first.close == 102.0
    assert first.volume == 60


@pytest.mark.asyncio
async def test_fetch_index_minute_candles_filters_out_of_range_rows_without_warning() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "0",
                "msg1": "OK",
                "output2": [
                    {
                        "stck_bsop_date": "20260619",
                        "stck_cntg_hour": "093000",
                        "bstp_nmix_oprc": "2850.10",
                        "bstp_nmix_hgpr": "2852.34",
                        "bstp_nmix_lwpr": "2849.87",
                        "bstp_nmix_prpr": "2851.67",
                        "cntg_vol": "123456",
                    },
                    {
                        "stck_bsop_date": "20260622",
                        "stck_cntg_hour": "093000",
                        "bstp_nmix_oprc": "2860.10",
                        "bstp_nmix_hgpr": "2862.34",
                        "bstp_nmix_lwpr": "2859.87",
                        "bstp_nmix_prpr": "2861.67",
                        "cntg_vol": "123456",
                    },
                ],
            },
        )

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        result = await client.fetch_index_minute_candles(
            get_representative_index("KOSPI"),
            "20260622",
            "20260622",
            bucket_seconds=600,
            foreground=True,
        )
    finally:
        await client.aclose()

    assert [c.close for c in result.candles] == [2861.67]
    assert result.violations == []


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
async def test_token_bucket_capacity_caps_initial_and_refill() -> None:
    """capacity < rate이면 초기 토큰과 리필 상한이 capacity로 묶인다.

    명의-전역 버킷(3계좌 통합) 도입 시 burst 상한: capacity 없이는
    유휴→포화 전이의 첫 1초에 '가득 찬 버킷(rate개) + 리필(rate개)'가
    한꺼번에 나가 KIS 고정윈도 한도를 단일 계좌로도 넘을 수 있다.
    """
    bucket = _TokenBucket(rate=10.0, capacity=2.0)
    # 초기 토큰 ≤ 2: 두 개는 즉시, 세 번째는 리필(~0.1s@10/s)을 기다린다.
    start = time.monotonic()
    await bucket.acquire()
    await bucket.acquire()
    burst_elapsed = time.monotonic() - start
    assert burst_elapsed < 0.1, "capacity 안의 burst는 즉시 통과해야 함"
    start = time.monotonic()
    await bucket.acquire()
    elapsed = time.monotonic() - start
    assert 0.05 < elapsed < 0.3, "3번째 acquire는 리필 대기여야 함(초기 토큰이 2로 캡)"
    # 긴 유휴 후에도 토큰은 capacity(2)로 클램프 — rate(10)까지 차지 않는다.
    bucket._last = time.monotonic() - 10.0  # 10s 유휴 시뮬 (리필 후보 100토큰)
    start = time.monotonic()
    await bucket.acquire()
    await bucket.acquire()
    assert time.monotonic() - start < 0.1, "유휴 후 capacity만큼은 즉시"
    start = time.monotonic()
    await bucket.acquire()
    elapsed = time.monotonic() - start
    assert 0.05 < elapsed < 0.3, "유휴 리필도 2로 클램프 — 3번째는 대기해야 함"


@pytest.mark.asyncio
async def test_token_bucket_default_capacity_unchanged() -> None:
    """capacity 미지정 시 기존 동작 그대로 — rate만큼 가득 차서 시작(회귀 가드)."""
    bucket = _TokenBucket(rate=3.0)
    start = time.monotonic()
    for _ in range(3):
        await bucket.acquire()
    assert time.monotonic() - start < 0.1, "기본 버킷은 rate개 초기 burst를 즉시 통과"


@pytest.mark.asyncio
async def test_kis_client_accepts_injected_rate_limiter() -> None:
    """주입된 공유 버킷을 두 클라이언트가 그대로 쓴다(명의-전역 예산).

    같은 명의의 계좌별 KisClient가 각자 버킷을 가지면 합산 송신이
    계좌수×rate가 되어 명의 한도를 넘는다 — 주입 seam이 공유의 전제.
    """
    shared = _TokenBucket(rate=10.0, capacity=1.0)
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"rt_cd": "0"}))
    c1 = KisClient(
        credentials=KisCredentials(app_key="K1", app_secret="S1", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=transport,
        rate_limiter=shared,
    )
    c2 = KisClient(
        credentials=KisCredentials(app_key="K2", app_secret="S2", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=transport,
        rate_limiter=shared,
    )
    try:
        assert c1._rate_limiter is shared
        assert c2._rate_limiter is shared
        # 공유 예산 증명: c1 쪽에서 유일한 토큰(capacity=1)을 소비하면
        # c2의 다음 acquire는 리필을 기다려야 한다.
        await c1._rate_limiter.acquire()
        start = time.monotonic()
        await c2._rate_limiter.acquire()
        elapsed = time.monotonic() - start
        assert elapsed >= 0.05, "c1이 소비한 토큰만큼 c2가 기다려야 공유 예산"
    finally:
        await c1.aclose()
        await c2.aclose()


@pytest.mark.asyncio
async def test_kis_client_default_builds_own_rate_limiter() -> None:
    """rate_limiter 미주입 시 기존처럼 자기 버킷을 만든다(단독 클라이언트 회귀 가드)."""
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"rt_cd": "0"}))
    c1 = KisClient(
        credentials=KisCredentials(app_key="K1", app_secret="S1", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=transport,
    )
    c2 = KisClient(
        credentials=KisCredentials(app_key="K2", app_secret="S2", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=transport,
    )
    try:
        assert isinstance(c1._rate_limiter, _TokenBucket)
        assert c1._rate_limiter is not c2._rate_limiter
    finally:
        await c1.aclose()
        await c2.aclose()


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


@pytest.mark.asyncio
async def test_fetch_market_investor_net_uses_kis_market_daily_api_params() -> None:
    seen: dict[str, str] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["path"] = req.url.path
        seen["tr_id"] = req.headers.get("tr_id", "")
        seen.update(dict(req.url.params))
        return httpx.Response(200, json={
            "rt_cd": "0",
            "output": [
                {
                    "stck_bsop_date": "20260619",
                    "frgn_ntby_qty": "-3519",
                    "orgn_ntby_qty": "17184",
                },
            ],
        })

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        result = await client.fetch_market_investor_net(
            get_representative_index("KOSDAQ"),
            "20260619",
            "20260619",
        )
        assert seen["path"] == "/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market"
        assert seen["tr_id"] == "FHPTJ04040000"
        assert seen["FID_COND_MRKT_DIV_CODE"] == "J"
        assert seen["FID_INPUT_ISCD"] == "1001"
        assert seen["FID_INPUT_ISCD_1"] == "KSQ"
        assert seen["FID_INPUT_ISCD_2"] == "1001"
        assert result.points[0].foreign_net == -3519
        assert result.points[0].institution_net == 17184
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
async def test_rate_limit_retry_logged_by_lane(monkeypatch, caplog) -> None:
    """로그 레벨은 lane별(2026-07-13 개정, 제안 A): background(폴러/레코더, 기본)의
    첫 바운스는 DEBUG로 강등됐다 — 설계된 손실률(~9-12%)이라 개별 이벤트가 신호가
    아니다(레코더가 사이클 율로 집계). foreground(사용자 차트 대기)의 첫 바운스만
    WARNING 유지 — 사용자 지연 신호이므로. 메시지 포맷(path·N/3)은 불변."""
    import logging

    async def fake_sleep(s: float) -> None:
        return

    monkeypatch.setattr("hoga.live.kis_client.asyncio.sleep", fake_sleep)

    def _bounce_twice_then_ok():
        return _make_attempt_counting_client(
            responses=[
                (500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "too fast"}),
                (500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "too fast"}),
                (200, _ok_orderbook_body()),
            ],
            _rate_limit_backoff=(1.0, 2.0, 4.0),
        )

    # background(기본): 두 재시도 모두 DEBUG.
    client, _ = _bounce_twice_then_ok()
    try:
        with caplog.at_level(logging.DEBUG, logger="hoga.live.kis_client"):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
    finally:
        await client.aclose()
    bg_logs = [r for r in caplog.records if "EGW00201" in r.getMessage()]
    assert len(bg_logs) == 2
    assert all(r.levelno == logging.DEBUG for r in bg_logs)
    assert "/uapi/probe" in bg_logs[0].getMessage()
    assert "1/3" in bg_logs[0].getMessage()

    # foreground: 첫 재시도 WARNING, 이후 DEBUG.
    caplog.clear()
    client, _ = _bounce_twice_then_ok()
    try:
        with caplog.at_level(logging.DEBUG, logger="hoga.live.kis_client"):
            await client._get(
                path="/uapi/probe", tr_id="PROBE0000", params={}, foreground=True,
            )
    finally:
        await client.aclose()
    fg_logs = [r for r in caplog.records if "EGW00201" in r.getMessage()]
    assert len(fg_logs) == 2
    assert fg_logs[0].levelno == logging.WARNING
    assert fg_logs[1].levelno == logging.DEBUG


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


# ---------------------------------------------------------------------------
# KIS 스택 감사 Fix B: 파싱 방어 — 기형 응답이 fetch 전체를 죽이지 않는다.
# 분봉 row는 그 row만 skip(대칭), orderbook/trades/brokers 구조 이상은 typed
# KisApiError로 승격해 error_policy가 'unexpected'가 아닌 'kis_api'로 분류한다.
# ---------------------------------------------------------------------------


def _minute_row(hhmmss: str, **over: str) -> dict[str, str]:
    base = {
        "stck_bsop_date": "20260619",
        "stck_cntg_hour": hhmmss,
        "stck_oprc": "100",
        "stck_hgpr": "105",
        "stck_lwpr": "99",
        "stck_prpr": "104",
        "cntg_vol": "10",
    }
    base.update(over)
    return base


@pytest.mark.asyncio
async def test_fetch_past_minute_candles_skips_malformed_row_without_crashing() -> None:
    """기형 row(필수 필드 결측)는 그 row만 버리고 나머지는 반환 — KeyError로
    fetch 전체를 죽이지 않는다(같은 루프의 날짜-필드 skip 가드와 대칭)."""
    good = _minute_row("093000")
    malformed = {k: v for k, v in _minute_row("093100").items() if k != "stck_oprc"}

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"rt_cd": "0", "output2": [good, malformed]})

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260619")
    finally:
        await client.aclose()

    # 정상 row는 살아남고, 기형 row(093100)는 조용히 제외됐다.
    assert [c.close for c in candles] == [104]


@pytest.mark.asyncio
async def test_fetch_past_minute_candles_skips_nonnumeric_field() -> None:
    """비숫자 필드(ValueError)도 KeyError와 동일하게 그 row만 skip."""
    good = _minute_row("093000")
    malformed = _minute_row("093100", stck_hgpr="N/A")

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"rt_cd": "0", "output2": [good, malformed]})

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260619")
    finally:
        await client.aclose()

    assert [c.close for c in candles] == [104]


@pytest.mark.asyncio
async def test_fetch_orderbook_missing_output1_raises_typed_api_error() -> None:
    """output1 결측(구조 이상) → KeyError가 아니라 KisApiError로 승격."""
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"rt_cd": "0"})  # output1 없음

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(KisApiError):
            await client.fetch_orderbook("005930")
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_fetch_trades_missing_output2_raises_typed_api_error() -> None:
    """output2 결측 → KisApiError로 승격(iteration 전 가드)."""
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"rt_cd": "0"})  # output2 없음

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(KisApiError):
            await client.fetch_trades("005930")
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_fetch_brokers_empty_output_raises_typed_api_error() -> None:
    """output 빈 리스트 → IndexError가 아니라 KisApiError로 승격."""
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"rt_cd": "0", "output": []})  # 빈 리스트

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(KisApiError):
            await client.fetch_brokers("005930")
    finally:
        await client.aclose()


# ------------------------------------------------------------------------
# EGW00201 바운스 카운터 + 로그 레벨 (2026-07-13, 제안 A)
# 설계된 정상 손실률(~9-12%)을 개별 WARN 로그가 아닌 율로 집계하기 위한 관측 채널.
# ------------------------------------------------------------------------


def _make_client_bounce_then_ok(
    n_bounces: int,
    *,
    _rate_limit_backoff: tuple[float, ...] = (0.0, 0.0, 0.0),
) -> KisClient:
    """처음 n_bounces번은 EGW00201, 그 다음엔 성공을 돌려주는 stateful 클라이언트.

    backoff는 0초라 재시도가 즉시(테스트 속도). n_bounces가 backoff+1을 넘으면
    끝까지 EGW00201만 나와 재시도가 소진(raise)된다."""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] <= n_bounces:
            return httpx.Response(
                200, json={"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "거래량 초과"},
            )
        return httpx.Response(200, json={"rt_cd": "0", "msg1": "ok"})

    return KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
        _rate_limit_backoff=_rate_limit_backoff,
    )


@pytest.mark.asyncio
async def test_bounce_counter_increments_on_recovered_rate_limit() -> None:
    """EGW00201 후 재시도로 복구돼도 바운스는 카운트된다(설계된 손실률의 집계원)."""
    from hoga.live import kis_client as kc

    kc.reset_bounces_for_tests()
    client = _make_client_bounce_then_ok(1)
    try:
        body = await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert body["rt_cd"] == "0"  # 복구 성공
        assert kc.rate_limit_bounces_total() == 1  # 바운스 1회 집계됨
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_bounce_counter_increments_on_exhausted_retries() -> None:
    """재시도 소진(끝까지 EGW00201)이면 매 시도가 바운스로 집계되고 raise된다."""
    from hoga.live import kis_client as kc

    kc.reset_bounces_for_tests()
    # backoff=(0,) → 총 2시도(1 + 재시도 1). 둘 다 EGW00201이면 소진.
    client = _make_client_bounce_then_ok(5, _rate_limit_backoff=(0.0,))
    try:
        with pytest.raises(KisRateLimitError):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        assert kc.rate_limit_bounces_total() == 2  # 2시도 모두 바운스
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_background_first_bounce_is_debug_not_warning(caplog) -> None:
    """background 호출(foreground=False, 기본)의 첫 바운스는 DEBUG로 강등된다 —
    설계된 손실률이라 개별 이벤트가 신호가 아니다."""
    import logging

    from hoga.live import kis_client as kc

    kc.reset_bounces_for_tests()
    client = _make_client_bounce_then_ok(1)
    try:
        with caplog.at_level(logging.DEBUG, logger="hoga.live.kis_client"):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
        rate_logs = [r for r in caplog.records if "rate-limited" in r.getMessage()]
        assert rate_logs, "바운스 로그가 있어야 한다"
        assert all(r.levelno == logging.DEBUG for r in rate_logs)  # WARNING 없음
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_foreground_first_bounce_is_warning(caplog) -> None:
    """foreground 호출(사용자가 기다리는 차트 fetch)의 첫 바운스는 WARNING 유지 —
    사용자 지연 신호이므로."""
    import logging

    from hoga.live import kis_client as kc

    kc.reset_bounces_for_tests()
    client = _make_client_bounce_then_ok(1)
    try:
        with caplog.at_level(logging.DEBUG, logger="hoga.live.kis_client"):
            await client._get(
                path="/uapi/probe", tr_id="PROBE0000", params={}, foreground=True,
            )
        rate_logs = [r for r in caplog.records if "rate-limited" in r.getMessage()]
        assert any(r.levelno == logging.WARNING for r in rate_logs)  # 첫 재시도 WARN
    finally:
        await client.aclose()
