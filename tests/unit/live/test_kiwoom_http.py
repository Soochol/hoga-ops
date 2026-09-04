"""키움 HTTP 전송 정책 — 연결 재사용(keepalive)과 연결 단계 재시도가 **실제로 먹는지**.

이 파일이 지키는 것은 값 하나가 아니라 **경로**다. httpx 는 `Client(limits=…)` 를
transport 주입 시 조용히 무시하므로(`Client._init_transport` 의 이른 return), 설정을
"했는데 안 먹는" 상태가 에러 없이 성립한다. 그래서 단언은 우리가 넘긴 인자가 아니라
**connection pool 이 최종적으로 쥔 값**을 본다.

`_pool` 은 httpx 내부 속성이다. 의도적으로 그걸 읽는다 — httpx 가 이 이음매를 바꾸면
여기서 깨져야 하고, 그게 곧 "정책이 더 이상 전달되지 않는다"는 신호다.
"""
from __future__ import annotations

import httpx
import pytest

from hoga.live import kiwoom_http
from hoga.live.kiwoom_after_hours import KiwoomAfterHoursFetcher
from hoga.live.kiwoom_errors import KiwoomTransportError
from hoga.live.kiwoom_index_candles import KiwoomIndexCandlesFetcher
from hoga.live.kiwoom_rankings import KiwoomRankingsFetcher
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.kiwoom_stock_info import KiwoomStockInfoFetcher


class _Prov:
    def get_token(self) -> str:
        return "tok"


def _pool(client: httpx.Client | httpx.AsyncClient):
    return client._transport._pool  # noqa: SLF001 — 이 파일의 존재 이유(도크스트링)


# === 정책 값 ================================================================

def test_default_keepalive_is_not_httpx_default() -> None:
    """httpx 기본 5초가 곧 이 모듈이 존재하는 이유다 — 같아지면 모듈이 무의미해진다."""
    assert httpx.Limits().keepalive_expiry != kiwoom_http.DEFAULT_KEEPALIVE_S
    assert kiwoom_http.keepalive_s() == kiwoom_http.DEFAULT_KEEPALIVE_S


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("30", 30.0),
        ("0", 0.0),          # kill switch — httpx 기본 동작으로 되돌린다(유효한 값)
        ("-1", kiwoom_http.DEFAULT_KEEPALIVE_S),   # 음수는 폴백
        ("abc", kiwoom_http.DEFAULT_KEEPALIVE_S),  # 비수치도 폴백
    ],
)
def test_env_override(monkeypatch: pytest.MonkeyPatch, raw: str, expected: float) -> None:
    monkeypatch.setenv("HOGA_KIWOOM_KEEPALIVE_S", raw)
    assert kiwoom_http.keepalive_s() == expected


def test_transports_carry_both_knobs() -> None:
    """만료와 재시도는 **한 몸**이다 — 만료만 늘리면 stale 연결을 새 실패로 바꾼다."""
    for transport in (kiwoom_http.async_transport(), kiwoom_http.sync_transport()):
        assert transport._pool._keepalive_expiry == kiwoom_http.DEFAULT_KEEPALIVE_S
        assert transport._pool._retries == kiwoom_http.CONNECT_RETRIES


def test_sync_and_async_transports_are_distinct_classes() -> None:
    """서로 바꿔 넣으면 httpx 는 생성이 아니라 **요청 시점**에 터진다."""
    assert isinstance(kiwoom_http.sync_transport(), httpx.HTTPTransport)
    assert isinstance(kiwoom_http.async_transport(), httpx.AsyncHTTPTransport)


# === 클라이언트가 정책을 실제로 쥐는가 =======================================

def test_rest_client_default_transport_uses_policy() -> None:
    pool = _pool(KiwoomRestClient(_Prov())._client)
    assert pool._keepalive_expiry == kiwoom_http.DEFAULT_KEEPALIVE_S
    assert pool._retries == kiwoom_http.CONNECT_RETRIES


def test_rest_client_respects_injected_transport() -> None:
    """주입이 이겨야 한다 — 안 그러면 MockTransport 를 쓰는 18개 파일이 실제 벤더를 친다."""
    mock = httpx.MockTransport(lambda _r: httpx.Response(200, json={}))
    assert KiwoomRestClient(_Prov(), transport=mock)._client._transport is mock


@pytest.mark.parametrize(
    "make",
    [
        lambda: KiwoomAfterHoursFetcher(_Prov())._client,
        lambda: KiwoomRankingsFetcher(_Prov())._client,
        lambda: KiwoomStockInfoFetcher(_Prov())._client,
        lambda: KiwoomIndexCandlesFetcher(_Prov())._client,
    ],
    ids=["after_hours", "rankings", "stock_info", "index_candles"],
)
def test_sync_fetchers_use_policy(make) -> None:
    """동기 fetcher 넷도 같은 정책을 쓴다 — 하나라도 빠지면 그 TR 만 콜드로 남는다."""
    pool = _pool(make())
    assert pool._keepalive_expiry == kiwoom_http.DEFAULT_KEEPALIVE_S
    assert pool._retries == kiwoom_http.CONNECT_RETRIES


@pytest.mark.parametrize(
    "make",
    [
        lambda t: KiwoomAfterHoursFetcher(_Prov(), _transport=t)._client,
        lambda t: KiwoomRankingsFetcher(_Prov(), _transport=t)._client,
        lambda t: KiwoomStockInfoFetcher(_Prov(), _transport=t)._client,
        lambda t: KiwoomIndexCandlesFetcher(_Prov(), client=httpx.Client(transport=t))._client,
    ],
    ids=["after_hours", "rankings", "stock_info", "index_candles"],
)
def test_sync_fetchers_respect_injection(make) -> None:
    mock = httpx.MockTransport(lambda _r: httpx.Response(200, json={}))
    assert make(mock)._transport is mock


# === 전송 실패는 상시 경고로 남는다 ==========================================

async def test_transport_error_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    """이 줄이 keepalive 값을 튜닝하는 유일한 신호다 — 0 건이면 만료를 늘려도 안전하다."""
    def _boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection reset")

    client = KiwoomRestClient(_Prov(), transport=httpx.MockTransport(_boom))
    # 예외형을 **좁게** 잡는다 — `Exception` 으로 두면 필수 파라미터 누락 같은
    # 조기 종료가 통과해 버려서, 로그 단언이 도달조차 못 한 것을 숨긴다.
    with caplog.at_level("WARNING"), pytest.raises(KiwoomTransportError):
        await client.call(
            "ka10080", {"stk_cd": "005930", "tic_scope": "1", "upd_stkpc_tp": "0"},
        )
    assert "kiwoom.rest.transport_error" in caplog.text
    # 값 튜닝에 쓰이는 필드가 실제로 실려야 한다 — 문구만 맞고 값이 없으면 무용지물이다.
    assert "keepalive_s=90.0" in caplog.text
    assert "api_id=ka10080" in caplog.text
