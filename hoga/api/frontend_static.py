"""prod 프론트 서빙 — FastAPI 가 vite dist 를 직접 서빙한다 (ADR-0134 §4).

prod 의 확정형은 단일 origin ``http://<MagicDNS 이름>:8000`` 하나다: FastAPI
프로세스 하나가 API 와 화면을 같이 서빙해 CORS 문제 자체를 소멸시킨다(리버스
프록시·정적 서버 기각 — 5명 규모에서 부품을 늘릴 근거가 없다).

**활성은 env opt-in** (``HOGA_FRONTEND_DIST``) — dev 는 vite(5173)가 프론트를
서빙하므로 이 마운트가 없어야 습관이 안 바뀐다. 경로가 잘못되면 기동 시점에
시끄럽게 죽는다(StaticFiles 의 check_dir) — prod 설정 오류가 "빈 화면 404" 로
위장되면 안 된다.

**SPA fallback**: react-router 딥링크(``/live`` 등)는 디스크에 파일이 없으므로
StaticFiles 만으로는 404 다. 파일이 아닌 경로는 index.html 로 되돌려 라우터가
받게 한다. 단 두 부류는 폴백하지 않는다:

- ``api/`` 로 시작하는 경로 — 존재하지 않는 API 를 호출한 클라이언트에게
  index.html(HTML)을 주면 JSON 파서가 깨지는 자리에서 원인이 숨는다. 404 를
  그대로 돌려준다. (등록된 ``/api/*`` 라우트는 mount 보다 먼저 매칭되므로
  여기 도달하는 것은 정의상 미등록 경로다.)
- 마지막 세그먼트에 ``.`` 이 있는 경로 — 해시드 자산(``assets/index-*.js``)의
  오타·스테일 참조다. index.html 을 주면 브라우저가 JS 자리에서 HTML 을 파싱해
  "Unexpected token '<'" 로 변형된다. 404 가 정직하다.
"""
from __future__ import annotations

from http import HTTPStatus
from pathlib import Path

from fastapi import FastAPI
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


def _is_spa_route(path: str) -> bool:
    """index.html 폴백 대상인가 — API 도 자산 참조도 아닌 클라이언트 라우트."""
    if path.startswith("api/"):
        return False
    last = path.rsplit("/", 1)[-1]
    return "." not in last


# 내용 해시가 파일명에 박히는 디렉터리. vite 가 JS·CSS·폰트를 전부 여기 낸다.
_HASHED_ASSET_PREFIX = "assets/"

_IMMUTABLE = "public, max-age=31536000, immutable"
_REVALIDATE = "no-cache"


def _apply_cache_policy(response: Response, path: str) -> None:
    """경로별 Cache-Control 을 못박는다 — 브라우저 휴리스틱에 맡기지 않는다.

    Starlette 의 FileResponse 는 ``last-modified`` 와 ``etag`` 만 싣고
    ``cache-control`` 은 비운다. 그러면 브라우저가 **휴리스틱 프레시니스**를
    적용한다(크롬: 지금−Last-Modified 의 10%). 마지막 배포가 오래됐을수록 그
    창이 커지므로, 재배포 직후 새 탭으로 들어온 사용자가 재검증 없이 캐시된 옛
    ``index.html`` 을 쓸 수 있다. 그 index 가 가리키는 ``assets/index-<옛해시>.js``
    는 새 빌드가 지워서 404 이고, 이건 React 부팅 **전**이라 AppErrorBoundary 도
    못 잡는 **완전한 빈 흰 화면**이 된다.

    - 해시드 자산: 내용이 바뀌면 이름이 바뀌므로 영구 캐시가 안전하다.
    - 그 외(``index.html``·``config.json``·favicon): 매번 재검증. ETag 가 이미
      있으므로 대개 304 라 비용은 헤더 왕복뿐이다.
    """
    immutable = path.startswith(_HASHED_ASSET_PREFIX)
    response.headers["cache-control"] = _IMMUTABLE if immutable else _REVALIDATE


class SpaStaticFiles(StaticFiles):
    """404 를 클라이언트 라우트에 한해 index.html 로 되돌리는 StaticFiles."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == HTTPStatus.NOT_FOUND and _is_spa_route(path):
                fallback = await super().get_response("index.html", scope)
                # 폴백은 실제로 index.html 이므로 그 정책을 따른다 — 요청 경로
                # (`/live` 등)로 판정하면 딥링크가 자산 취급을 받을 수 있다.
                _apply_cache_policy(fallback, "index.html")
                return fallback
            raise
        _apply_cache_policy(response, path)
        return response


def mount_frontend(app: FastAPI, dist: Path) -> None:
    """dist 를 루트에 마운트한다. 반드시 모든 라우터 include **뒤에** 불러야
    한다 — Starlette 은 등록 순서로 매칭하므로, 먼저 마운트하면 ``/api`` 가
    통째로 정적 404 에 가려진다."""

    @app.get("/config.json")
    def _same_origin_config() -> JSONResponse:
        """프론트 부팅 설정을 **서버가** 준다 — dist 안의 파일을 덮어쓴다.

        ``api_url: ""`` 는 same-origin 모드다(frontend/src/config.ts 의
        ``resolveApiUrl``/``resolveWsUrl`` 이 상대 경로·현재 host 로 푼다).
        이 마운트가 켜져 있다는 것 자체가 "FastAPI 가 화면도 서빙한다"(ADR-0134
        §4)는 뜻이므로 API 주소는 정의상 자기 origin 이고, 그 값은 서버가 이미
        알고 있다.

        **왜 dist 파일에 맡기지 않는가**: ``frontend/public/config.json`` 은 dev
        값(``http://localhost:8000``)이고 ``vite build`` 는 dist 를 비우고 그것을
        복사한다. 그래서 배포 절차에 "빌드한 뒤 dist/config.json 을 손으로
        고친다" 가 들어가 있었는데, 업그레이드 러닝북은 재빌드만 하고 그 손질을
        빠뜨렸다 — 첫 업그레이드에서 접속자 전원의 브라우저가 **자기 PC 의**
        8000 포트로 API 를 쏘아 화면이 통째로 죽고, 러닝북의 유일한 검증
        (``curl /health``)은 API 만 보므로 성공으로 보였다(2026-08-03).
        절차로 지켜야 하는 불변식을 서버가 스스로 만들게 해서 그 단계를 없앴다.

        mount 보다 **먼저** 등록되므로 정적 파일보다 이 라우트가 이긴다.
        """
        # 부팅 설정은 절대 캐시하지 않는다 — 배포로 값이 바뀌었는데 옛 값이
        # 살아 있으면 전 사용자가 엉뚱한 호스트로 API 를 쏜다.
        return JSONResponse({"api_url": ""}, headers={"cache-control": _REVALIDATE})

    app.mount("/", SpaStaticFiles(directory=dist, html=True), name="frontend")
