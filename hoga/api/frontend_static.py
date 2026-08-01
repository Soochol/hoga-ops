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
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


def _is_spa_route(path: str) -> bool:
    """index.html 폴백 대상인가 — API 도 자산 참조도 아닌 클라이언트 라우트."""
    if path.startswith("api/"):
        return False
    last = path.rsplit("/", 1)[-1]
    return "." not in last


class SpaStaticFiles(StaticFiles):
    """404 를 클라이언트 라우트에 한해 index.html 로 되돌리는 StaticFiles."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == HTTPStatus.NOT_FOUND and _is_spa_route(path):
                return await super().get_response("index.html", scope)
            raise


def mount_frontend(app: FastAPI, dist: Path) -> None:
    """dist 를 루트에 마운트한다. 반드시 모든 라우터 include **뒤에** 불러야
    한다 — Starlette 은 등록 순서로 매칭하므로, 먼저 마운트하면 ``/api`` 가
    통째로 정적 404 에 가려진다."""
    app.mount("/", SpaStaticFiles(directory=dist, html=True), name="frontend")
