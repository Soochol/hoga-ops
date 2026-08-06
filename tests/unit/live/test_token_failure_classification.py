"""토큰 발급 실패의 영구/일시 분류 — REST-degraded latch 오발동 방지.

**핵심은 KIS 쪽이다.** `account_health` 의 latch 는 **프로세스 재시작까지 영구**이고
(그 모듈 docstring 이 "토큰 ~24h 캐시라 발급 실패 드묾" 을 정당화로 든다), 켜지면 그
계정이 background REST 라우팅에서 빠지며 로그가 `check KIS_APP_KEY_N` 이라고 **원인을
오진**한다.

그런데 쿨다운은 드물지 않다 — revoke 복구 경로가 정확히 그것을 유발한다(거버너가 토큰을
버리고 60초 격리 후 되큐하고, 격리 60초와 발급 쿨다운 60초가 맞춰진 경계값이다).
분류가 없으면 **revoke 한 번이 계정을 프로세스 수명 동안 degraded** 로 만든다.

키움 쪽은 같은 분류를 넣되 **오늘 동작은 바뀌지 않는다**(latch 콜백이 배선돼 있지 않다).
계약을 맞춰 두는 것이 목적이다.
"""
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_client import KisAuthError, KisAuthTransient, KisCredentials
from hoga.live.kis_token_provider import KisTokenProvider
from hoga.live.kiwoom_token_provider import (
    KiwoomAuthError,
    KiwoomAuthTransient,
    KiwoomCredentials,
    KiwoomTokenProvider,
)

KIS_CREDS = KisCredentials(app_key="k", app_secret="s", env="real")
KIWOOM_CREDS = KiwoomCredentials(app_key="k", app_secret="s")


def _kis(handler, cache: Path, on_fail=None) -> KisTokenProvider:
    return KisTokenProvider(
        KIS_CREDS, cache, _transport=httpx.MockTransport(handler), on_issue_failure=on_fail
    )


def _kiwoom(handler, cache: Path) -> KiwoomTokenProvider:
    return KiwoomTokenProvider(KIWOOM_CREDS, cache, _transport=httpx.MockTransport(handler))


def _kis_ok(_req: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})


def _kiwoom_ok(_req: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"token": "T", "expires_dt": "20991231235959"})


# ── 계약: 하위 타입이라 기존 except 가 계속 잡는다 ────────────────────────

def test_transient_is_a_subtype_so_existing_handlers_still_catch() -> None:
    """새 타입을 형제로 만들면 기존 `except KisAuthError` 가 놓친다 — 하위여야 한다."""
    assert issubclass(KisAuthTransient, KisAuthError)
    assert issubclass(KiwoomAuthTransient, KiwoomAuthError)


# ── KIS: latch 오발동이 실제 결함이었다 ───────────────────────────────────

def test_cooldown_does_not_latch_the_account(tmp_path) -> None:
    """쿨다운은 페이싱 문제다 — 계정을 재시작까지 degraded 로 만들면 안 된다."""
    latched: list[int] = []
    p = _kis(_kis_ok, tmp_path / "t.json", on_fail=lambda: latched.append(1))

    assert p.get_token() == "T"
    p.invalidate()  # revoke 시나리오: 캐시를 버려 다음 호출이 발급 경로로 간다

    with pytest.raises(KisAuthTransient, match="cooldown"):
        p.get_token()
    assert latched == [], "쿨다운으로 latch 가 켜졌다 — revoke 한 번에 계정이 죽는다"
    p.close()


def test_transport_error_does_not_latch_the_account(tmp_path) -> None:
    """네트워크 순간 끊김도 일시다."""
    latched: list[int] = []

    def _boom(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    p = _kis(_boom, tmp_path / "t.json", on_fail=lambda: latched.append(1))
    with pytest.raises(KisAuthTransient):
        p.get_token()
    assert latched == []
    p.close()


def test_server_error_does_not_latch_the_account(tmp_path) -> None:
    """5xx = 벤더 쪽 — 키가 틀린 게 아니다."""
    latched: list[int] = []
    p = _kis(
        lambda _r: httpx.Response(503, text="unavailable"),
        tmp_path / "t.json",
        on_fail=lambda: latched.append(1),
    )
    with pytest.raises(KisAuthTransient):
        p.get_token()
    assert latched == []
    p.close()


def test_client_error_still_latches(tmp_path) -> None:
    """4xx 는 **영구**다 — 키/시크릿 오설정이면 latch 가 맞는 대응이다.

    이걸 일시로 돌리면 오설정 앱키가 조용히 재시도만 반복한다(ADR-0064 가 막으려던
    silent capacity degradation 의 반대 방향 실패).
    """
    latched: list[int] = []
    p = _kis(
        lambda _r: httpx.Response(401, text="invalid appkey"),
        tmp_path / "t.json",
        on_fail=lambda: latched.append(1),
    )
    with pytest.raises(KisAuthError) as exc:
        p.get_token()
    assert not isinstance(exc.value, KisAuthTransient)
    assert latched == [1], "4xx 는 latch 되어야 한다"
    p.close()


def test_cooldown_is_marked_before_the_post(tmp_path) -> None:
    """POST 가 실패해도 쿨다운이 찍혀야 한다 — 안 찍으면 매 호출이 10초를 치른다."""
    calls: list[httpx.Request] = []

    def _boom(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        raise httpx.ConnectError("boom")

    p = _kis(_boom, tmp_path / "t.json")
    with pytest.raises(KisAuthTransient):
        p.get_token()
    with pytest.raises(KisAuthTransient, match="cooldown"):
        p.get_token()
    assert len(calls) == 1  # 두 번째는 네트워크를 타지 않았다
    p.close()


# ── 키움: 같은 분류, 오늘은 동작 변화 없음 ────────────────────────────────

def test_kiwoom_cooldown_is_transient(tmp_path) -> None:
    p = _kiwoom(_kiwoom_ok, tmp_path / "kt.json")
    assert p.get_token() == "T"
    p.invalidate()
    with pytest.raises(KiwoomAuthTransient, match="cooldown"):
        p.get_token()
    p.close()


def test_kiwoom_transport_and_5xx_are_transient(tmp_path) -> None:
    def _boom(_req: httpx.Request) -> httpx.Response:
        raise httpx.ReadError("boom")

    p = _kiwoom(_boom, tmp_path / "kt1.json")
    with pytest.raises(KiwoomAuthTransient):
        p.get_token()
    p.close()

    p = _kiwoom(lambda _r: httpx.Response(502, text="bad gateway"), tmp_path / "kt2.json")
    with pytest.raises(KiwoomAuthTransient):
        p.get_token()
    p.close()


def test_kiwoom_client_error_stays_permanent(tmp_path) -> None:
    p = _kiwoom(lambda _r: httpx.Response(403, text="forbidden"), tmp_path / "kt3.json")
    with pytest.raises(KiwoomAuthError) as exc:
        p.get_token()
    assert not isinstance(exc.value, KiwoomAuthTransient)
    p.close()


def test_kiwoom_missing_token_in_200_stays_permanent(tmp_path) -> None:
    """200 인데 토큰이 없다 — 기존 분류(영구)를 유지한다(동작 변화 최소화)."""
    p = _kiwoom(lambda _r: httpx.Response(200, json={}), tmp_path / "kt4.json")
    with pytest.raises(KiwoomAuthError) as exc:
        p.get_token()
    assert not isinstance(exc.value, KiwoomAuthTransient)
    p.close()
