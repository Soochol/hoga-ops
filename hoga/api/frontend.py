"""빌드된 프론트엔드를 백엔드와 **같은 오리진**에서 서빙한다.

**왜 같은 오리진이 중요한가.** 원격 접속(터널 뒤 공개 도메인)에서 프론트와 API 가
다른 오리진이면 세 곳이 동시에 깨진다 — CORS 화이트리스트(``app.ALLOWED_ORIGINS``
는 localhost dev 포트가 하드코딩돼 있다), ``origin_guard``(상태변경 요청을 차단),
그리고 ``config.json`` 의 API 주소(도메인마다 다시 써야 한다).

같은 오리진이면 셋 다 저절로 풀린다:

- CORS 는 same-origin 요청에 적용되지 않는다.
- ``origin_guard`` 는 ``Sec-Fetch-Site: same-origin`` 을 통과시킨다
  (``_SELF_INITIATED_FETCH_SITES``) — 하드코딩된 허용 목록과 무관하다.
- 프론트의 ``resolveApiUrl`` 은 ``api_url`` 이 **빈 문자열이면 상대 경로**를 쓴다
  (``frontend/src/config.ts``). 그래서 배포본의 ``config.json`` 을
  ``{"api_url": ""}`` 로 두면 도메인이 무엇이든 그대로 동작하고,
  ``resolveWsUrl`` 이 https→wss 승격까지 해 준다.

즉 **도메인을 코드 어디에도 적지 않는다.** 터널 주소가 바뀌어도 재빌드가 없다.

**개발 흐름은 건드리지 않는다.** dist 가 없으면 아무것도 마운트하지 않으므로,
Vite dev server(5173) + uvicorn(8000) 의 교차 오리진 구성은 기존 CORS·origin_guard
설정 그대로 돌아간다. 이 모듈은 "빌드된 산출물이 있을 때만" 켜진다.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

log = logging.getLogger(__name__)

# SPA fallback 에서 제외할 최상위 경로. 여기로 온 미지의 경로는 index.html 이 아니라
# 404 여야 한다 — API 오타에 HTML 을 돌려주면 클라이언트가 JSON 파싱에서 죽고,
# 진짜 원인(경로 오타)이 그 뒤에 숨는다.
_SERVER_PREFIXES: tuple[str, ...] = ("api", "health", "docs", "redoc", "openapi.json")


def resolve_dist_dir(explicit: str | os.PathLike[str] | None = None) -> Path | None:
    """서빙할 프론트엔드 빌드 디렉토리. 없으면 None(마운트 생략).

    우선순위: 인자 > ``HOGA_FRONTEND_DIST`` env > 저장소의 ``frontend/dist``.
    마지막 것은 체크아웃에서 그냥 실행할 때를 위한 편의이고, 배포에서는 env 로
    명시하는 편이 낫다.
    """
    if explicit is not None:
        p = Path(explicit).expanduser()
        return p if (p / "index.html").is_file() else None
    raw = os.environ.get("HOGA_FRONTEND_DIST", "").strip()
    if raw:
        p = Path(raw).expanduser()
        return p if (p / "index.html").is_file() else None
    # hoga/api/frontend.py → 저장소 루트 → frontend/dist
    p = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    return p if (p / "index.html").is_file() else None


def mount_frontend(app: FastAPI, dist_dir: Path) -> None:
    """dist 를 마운트한다. **모든 API 라우터를 등록한 뒤에 호출해야 한다.**

    Starlette 은 등록 순서대로 매칭하므로, 아래 catch-all 이 먼저 등록되면 API 를
    통째로 가린다. 호출 순서가 이 모듈의 유일한 암묵적 계약이라 여기 적어 둔다.
    """
    assets = dist_dir / "assets"
    if assets.is_dir():
        # 파일명에 해시가 박혀 있어 불변이다 — 길게 캐시해도 안전하고, 터널 너머
        # 느린 회선에서 재방문 비용을 크게 줄인다.
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    index = dist_dir / "index.html"

    # **GET 전용으로 등록하면 안 된다.** 그러면 미지의 경로로 온 POST/DELETE 가
    # "경로는 매칭, 메서드는 불일치" 가 되어 Starlette 이 404 대신 **405** 를 낸다.
    # catch-all 이 모든 경로를 매칭하므로 이 앱의 404 전체가 405 로 바뀐다
    # (tests/test_api_test_routes.py 가 이걸 잡았다). 전 메서드를 받아 GET·HEAD 만
    # 파일을 주고 나머지는 404 로 돌린다 — SPA 진입점은 POST 대상이 아니다.
    @app.api_route(
        "/{full_path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def _spa(full_path: str, request: Request) -> FileResponse:
        head = full_path.split("/", 1)[0]
        if request.method not in ("GET", "HEAD") or head in _SERVER_PREFIXES:
            # 여기 도달했다 = 위의 어떤 API 라우트에도 안 걸렸다 = 진짜 404 다.
            raise HTTPException(status_code=404, detail="Not Found")

        candidate = (dist_dir / full_path).resolve()
        # 경로 탈출 방지. full_path 는 사용자 입력이고 ".." 가 들어올 수 있다.
        if full_path and candidate.is_file() and candidate.is_relative_to(dist_dir.resolve()):
            return FileResponse(candidate, headers=_cache_headers(candidate))

        # 클라이언트 라우트(/live, /study, ...) — SPA 진입점을 돌려준다.
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    log.info("frontend mounted from %s", dist_dir)


def _cache_headers(path: Path) -> dict[str, str]:
    """``config.json`` 만은 캐시하면 안 된다 — API 주소를 바꿔도 안 먹는다."""
    if path.name == "config.json":
        return {"Cache-Control": "no-store"}
    return {"Cache-Control": "no-cache"}
