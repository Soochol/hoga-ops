"""prod 프론트 서빙(HOGA_FRONTEND_DIST) — 마운트·SPA fallback·비폴백 경계.

실제 create_app 으로 검증한다 — 합성 앱만 검증하면 "라우터 뒤에 마운트" 같은
배선 순서 계약을 놓친다(test_origin_guard 의 real-app 테스트와 같은 이유).
lifespan(폴러·워커)은 띄우지 않는다 — 라우팅 계층만 본다.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app

_INDEX_MARKER = "<title>hoga-dist-fixture</title>"


@pytest.fixture()
def dist(tmp_path: Path) -> Path:
    """최소 vite dist 모형 — index.html + config.json + 해시드 자산 하나."""
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text(
        f"<!doctype html><html><head>{_INDEX_MARKER}</head><body></body></html>",
        encoding="utf-8",
    )
    # **일부러 dev 값을 쓴다** — `vite build` 가 dist 를 비우고
    # frontend/public/config.json 을 그대로 복사하므로, 갓 빌드한 dist 의 실제
    # 내용이 이것이다. 서버가 이걸 덮어쓰는지가 아래 계약의 핵심이다.
    (d / "config.json").write_text(
        '{ "api_url": "http://localhost:8000" }', encoding="utf-8",
    )
    (d / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    return d


@pytest.fixture()
def client(dist: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(dist))
    return TestClient(create_app(tmp_path / "data"))


def test_root_serves_index(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    assert _INDEX_MARKER in resp.text


@pytest.mark.parametrize("path", ["/live", "/study", "/screener/deep/link"])
def test_spa_deep_link_falls_back_to_index(client: TestClient, path: str) -> None:
    """react-router 딥링크는 디스크에 없다 — index.html 로 폴백해야 라우터가 받는다."""
    resp = client.get(path)
    assert resp.status_code == 200
    assert _INDEX_MARKER in resp.text


def test_static_files_are_served_verbatim(client: TestClient) -> None:
    js = client.get("/assets/index-abc123.js")
    assert js.status_code == 200
    assert "console.log" in js.text


def test_config_json_is_same_origin_regardless_of_dist_contents(
    client: TestClient, dist: Path,
) -> None:
    """서빙이 켜져 있으면 API 주소는 정의상 자기 origin 이다 — 서버가 답한다.

    dist 안에는 dev 값(localhost:8000)이 들어 있다(픽스처 주석 참고). 그 파일이
    이겼다면 접속자들의 브라우저가 **자기 PC 의** 8000 포트로 API 를 쏜다 —
    업그레이드 러닝북이 재빌드만 하고 수동 패치를 빠뜨렸을 때 실제로 벌어지던
    전면 장애다(2026-08-03). 절차로 지키던 불변식을 서버가 만들게 한 계약.
    """
    assert "localhost:8000" in (dist / "config.json").read_text(encoding="utf-8")
    assert client.get("/config.json").json() == {"api_url": ""}


def test_hashed_assets_are_immutable_and_html_revalidates(client: TestClient) -> None:
    """캐시 정책을 브라우저 휴리스틱에 맡기면 배포가 흰 화면을 만든다.

    Starlette 은 cache-control 을 안 싣고 last-modified 만 준다 → 크롬은
    (지금−Last-Modified)의 10% 를 프레시로 간주한다. 그 창 안에 재배포하면 새
    탭이 캐시된 옛 index.html 을 쓰고, 그게 가리키는 옛 해시 청크는 이미 지워져
    404 다 — React 부팅 전이라 ErrorBoundary 도 없는 완전한 흰 화면.
    """
    assets = client.get("/assets/index-abc123.js")
    assert assets.headers["cache-control"] == "public, max-age=31536000, immutable"

    for path in ("/", "/live", "/config.json"):
        assert client.get(path).headers["cache-control"] == "no-cache", path


def test_missing_asset_is_404_not_index(client: TestClient) -> None:
    """스테일 해시 참조에 index.html 을 주면 'Unexpected token <' 로 위장된다."""
    resp = client.get("/assets/index-gone999.js")
    assert resp.status_code == 404
    assert _INDEX_MARKER not in resp.text


def test_unknown_api_path_is_404_not_index(client: TestClient) -> None:
    """미등록 /api 경로가 HTML 을 받으면 JSON 파서 자리에서 원인이 숨는다."""
    resp = client.get("/api/definitely-not-a-route")
    assert resp.status_code == 404
    assert _INDEX_MARKER not in resp.text


def test_health_still_wins_over_mount(client: TestClient) -> None:
    """라우터가 mount 보다 먼저 매칭되는지 — 배선 순서 계약."""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json().get("status") == "ok"


def test_without_env_root_is_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """env 미설정이면 마운트 자체가 없다 — dev 동작 불변의 계약."""
    monkeypatch.delenv("HOGA_FRONTEND_DIST", raising=False)
    client = TestClient(create_app(tmp_path / "data"))
    assert client.get("/").status_code == 404


def test_missing_dist_dir_fails_loudly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """경로 오타가 '빈 화면 404' 로 위장되면 안 된다 — 기동 시점에 죽는다."""
    monkeypatch.setenv("HOGA_FRONTEND_DIST", str(tmp_path / "no-such-dist"))
    with pytest.raises(RuntimeError):
        create_app(tmp_path / "data")
