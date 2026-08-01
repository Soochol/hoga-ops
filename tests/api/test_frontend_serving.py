"""빌드된 프론트엔드를 백엔드와 같은 오리진에서 서빙한다(hoga/api/frontend.py).

같은 오리진이 요점이다 — 그래야 CORS·origin_guard·config.json 의 API 주소가 전부
저절로 풀리고, 터널 뒤 도메인이 무엇이든 재빌드 없이 동작한다. 자세한 근거는
모듈 docstring 참조.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.frontend import resolve_dist_dir


def _make_dist(tmp: Path) -> Path:
    dist = tmp / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>hoga</title>", encoding="utf-8")
    (dist / "assets" / "app-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (dist / "config.json").write_text(json.dumps({"api_url": ""}), encoding="utf-8")
    return dist


def test_spa_routes_serve_index_html(tmp_path: Path, monkeypatch) -> None:
    """/live·/study 는 서버 라우트가 아니라 클라이언트 라우트다 — 진입점을 줘야 한다."""
    dist = _make_dist(tmp_path)
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    client = TestClient(create_app(tmp_path / "data"))

    for path in ("/", "/live", "/study", "/deep/client/route"):
        resp = client.get(path)
        assert resp.status_code == 200, path
        assert "text/html" in resp.headers["content-type"]
        assert "<title>hoga</title>" in resp.text


def test_api_routes_are_not_shadowed(tmp_path: Path, monkeypatch) -> None:
    """catch-all 이 API 보다 먼저 등록되면 백엔드가 통째로 가려진다."""
    dist = _make_dist(tmp_path)
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    client = TestClient(create_app(tmp_path / "data"))

    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_unknown_api_path_is_json_404_not_html(tmp_path: Path, monkeypatch) -> None:
    """API 오타에 index.html 을 주면 클라이언트가 JSON 파싱에서 죽고, 진짜 원인이
    그 뒤에 숨는다."""
    dist = _make_dist(tmp_path)
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    client = TestClient(create_app(tmp_path / "data"))

    resp = client.get("/api/definitely-not-a-route")
    assert resp.status_code == 404
    assert "application/json" in resp.headers["content-type"]


def test_static_assets_are_served(tmp_path: Path, monkeypatch) -> None:
    dist = _make_dist(tmp_path)
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    client = TestClient(create_app(tmp_path / "data"))

    resp = client.get("/assets/app-abc123.js")
    assert resp.status_code == 200
    assert resp.text == "console.log(1)"


def test_config_json_is_never_cached(tmp_path: Path, monkeypatch) -> None:
    """캐시되면 API 주소를 바꿔도 안 먹는다 — 터널 주소 변경이 조용히 실패한다."""
    dist = _make_dist(tmp_path)
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    client = TestClient(create_app(tmp_path / "data"))

    resp = client.get("/config.json")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    assert resp.json() == {"api_url": ""}


def test_path_traversal_cannot_escape_dist(tmp_path: Path, monkeypatch) -> None:
    """full_path 는 사용자 입력이다. 탈출하면 서버 파일이 그대로 나간다."""
    dist = _make_dist(tmp_path)
    secret = tmp_path / "secret.txt"
    secret.write_text("TOPSECRET-APPKEY", encoding="utf-8")
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    client = TestClient(create_app(tmp_path / "data"))

    for path in (
        "/../secret.txt",
        "/../../secret.txt",
        "/%2e%2e%2fsecret.txt",
        "/assets/../../secret.txt",
        "/....//secret.txt",
    ):
        resp = client.get(path)
        assert "TOPSECRET" not in resp.text, f"경로 탈출: {path}"


def test_not_mounted_without_a_build(tmp_path: Path, monkeypatch) -> None:
    """dist 가 없으면 마운트하지 않는다 — Vite dev server 흐름을 건드리면 안 된다."""
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(tmp_path / "nope"))
    client = TestClient(create_app(tmp_path / "data"))

    resp = client.get("/live")
    assert resp.status_code == 404  # SPA fallback 이 없다 = 마운트 안 됨
    assert client.get("/health").status_code == 200  # API 는 정상


def test_resolve_dist_requires_index_html(tmp_path: Path, monkeypatch) -> None:
    """디렉토리만 있고 index.html 이 없으면 빌드가 아니다."""
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(empty))
    assert resolve_dist_dir() is None

    dist = _make_dist(tmp_path)
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    assert resolve_dist_dir() == dist


def test_unknown_path_with_non_get_method_is_404_not_405(tmp_path: Path, monkeypatch) -> None:
    """catch-all 을 GET 전용으로 등록하면 '경로 매칭·메서드 불일치' 가 되어 이 앱의
    404 전체가 405 로 바뀐다. SPA 진입점은 POST 대상이 아니므로 404 여야 한다."""
    dist = _make_dist(tmp_path)
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    client = TestClient(create_app(tmp_path / "data"))

    for method in ("post", "put", "patch", "delete"):
        resp = getattr(client, method)("/api/test/add-stockdate")
        assert resp.status_code == 404, f"{method} -> {resp.status_code}"
        resp = getattr(client, method)("/not-a-real-place")
        assert resp.status_code == 404, f"{method} -> {resp.status_code}"


def test_tunnel_origin_must_be_allowlisted_explicitly(tmp_path: Path, monkeypatch) -> None:
    """같은 오리진 서빙만으로는 부족하다 — 실측으로 확인한 함정.

    origin_guard._is_allowed 는 Origin 헤더가 **있으면** 화이트리스트만 본다.
    Sec-Fetch-Site: same-origin 구제는 Origin 이 **없을 때만** 적용되는데, 브라우저는
    same-origin POST·WS 핸드셰이크에 Origin 을 붙인다. 그래서 터널 도메인을
    HOGA_ALLOWED_ORIGINS 에 넣지 않으면 **GET 은 200 인데 POST 만 403** 이 되어
    "화면은 뜨는데 캡처와 실시간 스트림만 죽는" 형태로 고장난다.
    """
    dist = _make_dist(tmp_path)
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    domain = "https://hoga.example.com"
    headers = {"Origin": domain, "Sec-Fetch-Site": "same-origin"}

    monkeypatch.delenv("HOGA_ALLOWED_ORIGINS", raising=False)
    blocked = TestClient(create_app(tmp_path / "data"))
    assert blocked.get("/live", headers=headers).status_code == 200      # 화면은 뜬다
    assert blocked.post("/api/symbols/refresh", headers=headers).status_code == 403  # 쓰기는 죽는다

    monkeypatch.setenv("HOGA_ALLOWED_ORIGINS", domain)
    allowed = TestClient(create_app(tmp_path / "data"))
    assert allowed.post("/api/symbols/refresh", headers=headers).status_code == 200

    # 등록하지 않은 도메인은 그대로 막혀야 한다 — 이건 인증이 아니라 CSRF 방어다.
    evil = {"Origin": "https://evil.example.com", "Sec-Fetch-Site": "cross-site"}
    assert allowed.post("/api/symbols/refresh", headers=evil).status_code == 403


def test_local_dev_origins_survive_remote_config(tmp_path: Path, monkeypatch) -> None:
    """원격 접속을 켜도 로컬 개발이 계속 돌아야 한다 — 덧붙이기지 교체가 아니다."""
    monkeypatch.setenv("HOGA_ALLOWED_ORIGINS", "https://hoga.example.com")
    client = TestClient(create_app(tmp_path / "data"))

    resp = client.post(
        "/api/symbols/refresh",
        headers={"Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-origin"},
    )
    assert resp.status_code == 200
