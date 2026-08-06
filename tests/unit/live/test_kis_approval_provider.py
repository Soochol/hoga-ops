"""KIS WS 승인키 provider — `KisTokenProvider` 대칭.

**주 회귀 가드는 실패 분류다.** 자격증명 부재(영구)와 네트워크·벤더 장애(일시)를
같은 예외로 뭉치면 호출부가 백오프 여부를 결정할 수 없고, 일시 장애를 영구 실패로
오분류해 폴링 주기마다 헛발질한다(30초 × 11시간 ≈ 1,300회).

두 번째 가드는 **발급 쿨다운을 POST 전에 찍는 것**이다. 인증 엔드포인트가 매달리면
이후 요청이 각자 15초 블로킹을 치르는 대신 쿨다운에서 빠르게 실패해야 한다.
"""
import httpx
import pytest

from hoga.live.kis_approval_provider import (
    KisApprovalProvider,
    KisApprovalTransient,
    KisApprovalUnavailable,
)
from hoga.live.kis_client import KisCredentials

CREDS = KisCredentials(app_key="k", app_secret="s", env="real")


def _provider(handler) -> KisApprovalProvider:
    return KisApprovalProvider(CREDS, _transport=httpx.MockTransport(handler))


def _ok(_req: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"approval_key": "APPROVAL-1"})


def test_issues_and_caches() -> None:
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return _ok(req)

    p = _provider(handler)
    assert p.get_key() == "APPROVAL-1"
    assert p.get_key() == "APPROVAL-1"
    assert len(calls) == 1  # 두 번째는 캐시 히트 — I/O 없음
    p.close()


def test_missing_credentials_is_permanent() -> None:
    """무자격 dev 프로필(ADR-0134)에서 정상 경로다 — 재시도 대상이 아니다."""
    p = KisApprovalProvider(
        KisCredentials(app_key="", app_secret="", env="real"),
        _transport=httpx.MockTransport(_ok),
    )
    with pytest.raises(KisApprovalUnavailable):
        p.get_key()
    p.close()


def test_transport_error_is_transient() -> None:
    """네트워크 실패를 영구로 분류하면 야간 경로가 그날 내내 죽는다."""

    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    p = _provider(handler)
    with pytest.raises(KisApprovalTransient):
        p.get_key()
    p.close()


def test_http_error_is_transient() -> None:
    p = _provider(lambda _r: httpx.Response(500, text="oops"))
    with pytest.raises(KisApprovalTransient):
        p.get_key()
    p.close()


def test_missing_key_in_200_is_transient() -> None:
    """200 인데 키가 없다 — 스펙 위반이지만 영구로 두면 벤더 일시 이상에 그날이 죽는다."""
    p = _provider(lambda _r: httpx.Response(200, json={}))
    with pytest.raises(KisApprovalTransient):
        p.get_key()
    p.close()


def test_cooldown_blocks_second_issue() -> None:
    """분당 1회. 쿨다운은 **일시** 실패다 — 기다리면 풀린다."""
    p = _provider(_ok)
    assert p.get_key() == "APPROVAL-1"
    p.invalidate()  # 캐시를 버려 다음 호출이 발급 경로로 간다
    with pytest.raises(KisApprovalTransient, match="쿨다운"):
        p.get_key()
    p.close()


def test_cooldown_marked_before_post() -> None:
    """POST 가 실패해도 쿨다운이 찍혀야 한다 — 안 찍으면 매 호출이 15초를 치른다."""
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        raise httpx.ConnectError("boom")

    p = _provider(handler)
    with pytest.raises(KisApprovalTransient):
        p.get_key()
    with pytest.raises(KisApprovalTransient, match="쿨다운"):
        p.get_key()
    assert len(calls) == 1  # 두 번째는 네트워크를 타지 않았다
    p.close()


def test_invalidate_drops_cache_only() -> None:
    """디스크 캐시가 없다 — 응답에 만료 시각이 없어 유효성을 판정할 수 없기 때문이다."""
    p = _provider(_ok)
    p.get_key()
    p.invalidate()
    assert p._key is None
    p.close()
