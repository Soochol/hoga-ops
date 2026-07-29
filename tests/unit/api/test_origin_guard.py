"""OriginGuardMiddleware — 브라우저 교차 출처 상태변경 요청 차단.

**CORS 가 이걸 막아 준다는 가정이 틀렸다는 것** 이 이 테스트 묶음의 전제다.
Starlette 의 CORSMiddleware 는 `OPTIONS` + `access-control-request-method` 일 때만
preflight 로 차단하고, 그 밖의 요청은 origin 이 화이트리스트 밖이어도 핸들러를
실행한 뒤 응답 헤더만 뺀다. 브라우저가 응답을 못 읽는 것은 무의미하다 — 부작용은
이미 확정됐다.

특히 이 API 에는 파라미터가 하나도 없는 상태변경 라우트가 6개 있어(cancel-all·
catchup 등) FastAPI 가 body 를 파싱하지 않고, 그러면 form-urlencoded 로 도달해
**preflight 자체가 생기지 않는다** — 악성 페이지의 숨은 <form> 자동 제출로 그대로
호출된다. cancel_all() 은 큐를 전량 drain 하고 디스크에 확정하므로 되돌릴 수 없다.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from hoga.api.app import ALLOWED_ORIGINS
from hoga.api.origin_guard import OriginGuardMiddleware

_EVIL = "https://evil.example"
_GOOD = "http://localhost:5173"


def _client() -> TestClient:
    """실제 앱과 같은 배선 — CORS 안쪽, 가드 바깥."""
    app = FastAPI()

    @app.get("/read")
    async def _read() -> dict:
        return {"ok": True}

    @app.post("/no-body")           # 파라미터 0개 = preflight 를 만들지 않는 형태
    async def _no_body() -> dict:
        return {"did": "mutate"}

    @app.delete("/done")
    async def _done() -> dict:
        return {"cleared": True}

    app.add_middleware(
        CORSMiddleware, allow_origins=list(ALLOWED_ORIGINS),
        allow_methods=["*"], allow_headers=["*"],
    )
    app.add_middleware(OriginGuardMiddleware, allowed_origins=ALLOWED_ORIGINS)
    return TestClient(app)


def test_cors_alone_would_have_executed_the_handler() -> None:
    """전제 확인 — 가드가 **없으면** 악성 origin 의 POST 가 실제로 실행된다.

    이게 성립하지 않으면 이 미들웨어는 존재할 이유가 없다. CORS 만 붙인 앱으로
    직접 확인한다.
    """
    app = FastAPI()

    @app.post("/no-body")
    async def _no_body() -> dict:
        return {"did": "mutate"}

    app.add_middleware(
        CORSMiddleware, allow_origins=list(ALLOWED_ORIGINS),
        allow_methods=["*"], allow_headers=["*"],
    )
    resp = TestClient(app).post("/no-body", headers={"Origin": _EVIL})
    assert resp.status_code == 200
    assert resp.json() == {"did": "mutate"}, "CORS 는 핸들러 실행을 막지 않는다"


@pytest.mark.parametrize("method,path", [("post", "/no-body"), ("delete", "/done")])
def test_cross_origin_state_change_is_blocked(method: str, path: str) -> None:
    resp = getattr(_client(), method)(path, headers={"Origin": _EVIL})
    assert resp.status_code == 403
    assert resp.json()["code"] == "cross_origin_blocked"


def test_allowed_origin_passes() -> None:
    """정상 프론트엔드(localhost:5173)는 그대로 동작해야 한다."""
    resp = _client().post("/no-body", headers={"Origin": _GOOD})
    assert resp.status_code == 200
    assert resp.json() == {"did": "mutate"}


def test_non_browser_client_passes() -> None:
    """curl·스크립트·CLI 는 Origin 도 Sec-Fetch-Site 도 보내지 않는다 — 통과.

    이 가드는 인증 장치가 아니다. 인증 부재는 ADR-0036 이 명시적으로 스코프 밖으로
    둔 별개 주제이고, 여기서 비브라우저를 막으면 CLI·스크립트가 전부 깨진다.
    """
    resp = _client().post("/no-body")
    assert resp.status_code == 200


def test_same_origin_fetch_site_passes_without_origin_header() -> None:
    """Origin 없이 Sec-Fetch-Site: same-origin 만 오는 경우도 통과."""
    resp = _client().post("/no-body", headers={"Sec-Fetch-Site": "same-origin"})
    assert resp.status_code == 200


def test_cross_site_fetch_site_is_blocked_without_origin_header() -> None:
    resp = _client().post("/no-body", headers={"Sec-Fetch-Site": "cross-site"})
    assert resp.status_code == 403


def test_safe_methods_are_never_blocked() -> None:
    """GET 은 부작용이 없다 — 교차 출처여도 막지 않는다(막으면 조회가 깨진다)."""
    resp = _client().get("/read", headers={"Origin": _EVIL})
    assert resp.status_code == 200


def test_guard_and_cors_share_one_origin_list() -> None:
    """두 곳에 리터럴을 따로 두면 한쪽만 고쳐져 조용히 어긋난다.

    app.py 가 ALLOWED_ORIGINS 하나를 CORS 와 가드 양쪽에 넘기는지 고정한다.
    """
    import inspect

    from hoga.api import app as app_mod

    src = inspect.getsource(app_mod.create_app)
    assert "allow_origins=list(ALLOWED_ORIGINS)" in src
    assert "allowed_origins=ALLOWED_ORIGINS" in src


def test_guard_sits_outside_cors_in_the_real_app(tmp_path) -> None:
    """배선 순서 고정 — 가드가 CORS **안쪽**이면 아무 의미가 없다."""
    from hoga.api.app import create_app

    names = [m.cls.__name__ for m in create_app(tmp_path).user_middleware]
    assert names.index("OriginGuardMiddleware") < names.index("CORSMiddleware"), (
        f"가드가 CORS 안쪽에 있다: {names} (앞쪽일수록 바깥)"
    )
