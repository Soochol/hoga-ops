"""변경 라우트 → EventBus 브로드캐스트(교차 브라우저 목록 동기화).

닫는 방향: **관심목록·히트맵의 변경 라우트가 2xx 로 끝나면 열려 있는 모든 WS
연결에 신호가 간다.** 그래야 A 브라우저에서 추가한 종목이 B 브라우저에 새로고침
없이 나타난다.

못 보는 것(반대 방향):
  - 라우트를 타지 않는 쓰기(스케줄러의 ``last_success_date`` 갱신 등)는 대상이
    아니다. 사용자 편집의 교차 창 반영이 목표다.
  - 프론트가 그 신호로 **무엇을 하는지**는 여기서 재지 않는다
    (frontend/src/api/eventStream.test.ts 가 그 절반을 진다).

등록 의존: 없다. route_class 는 라우터에 등록되는 모든 경로를 자동으로 덮는다 —
아래 ``test_every_route_is_wrapped`` 가 그 자동성을 직접 잰다(개별 라우트를 하나
찔러 보는 것으로는 "새 라우트도 커버된다" 가 증명되지 않는다).
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.events import EventBus


@pytest.fixture(autouse=True)
def stub_refresh_live_stream():
    """히트맵 라우트의 ADR-0097 스토리지 재동기 훅을 실 lifecycle 에서 끊는다."""
    with patch("hoga.api.heatmap_routes.refresh_live_stream", new=AsyncMock()):
        yield


def _drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _client(tmp_path: Path, kind: str, *, bus: EventBus | None) -> TestClient:
    if kind == "watchlist":
        from hoga.api.watchlist_routes import build_router
    else:
        from hoga.api.heatmap_routes import build_router
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path, bus=bus))
    return TestClient(app)


@pytest.mark.parametrize(
    ("kind", "event_type"),
    [("watchlist", "watchlist_changed"), ("heatmap", "heatmap_changed")],
)
def test_mutation_publishes_change_event(tmp_path: Path, kind: str, event_type: str):
    bus = EventBus()
    q = bus.subscribe()
    client = _client(tmp_path, kind, bus=bus)

    resp = client.post(f"/api/{kind}/folders", json={"name": "테스트"})

    assert resp.status_code == 201
    assert _drain(q) == [{"type": event_type}]


@pytest.mark.parametrize("kind", ["watchlist", "heatmap"])
def test_read_publishes_nothing(tmp_path: Path, kind: str):
    """같은 라우터가 목록 GET 도 들고 있다 — 조회가 조회를 부르면 안 된다."""
    bus = EventBus()
    q = bus.subscribe()
    client = _client(tmp_path, kind, bus=bus)

    assert client.get(f"/api/{kind}").status_code == 200
    assert _drain(q) == []


@pytest.mark.parametrize("kind", ["watchlist", "heatmap"])
def test_failed_mutation_publishes_nothing(tmp_path: Path, kind: str):
    """실패한 변경은 남에게 알릴 것이 없다 — 4xx 는 발행하지 않는다."""
    bus = EventBus()
    q = bus.subscribe()
    client = _client(tmp_path, kind, bus=bus)

    resp = client.patch(f"/api/{kind}/folders/f_deadbeef", json={"name": "없음"})

    assert resp.status_code == 404
    assert _drain(q) == []


@pytest.mark.parametrize("kind", ["watchlist", "heatmap"])
def test_no_bus_still_serves(tmp_path: Path, kind: str):
    """bus 미주입(기존 라우터 테스트·조립 안 한 앱)에서도 라우터는 그대로 돈다."""
    client = _client(tmp_path, kind, bus=None)
    assert client.post(f"/api/{kind}/folders", json={"name": "테스트"}).status_code == 201


@pytest.mark.parametrize("kind", ["watchlist", "heatmap"])
def test_every_route_is_wrapped(tmp_path: Path, kind: str):
    """route_class 의 **자동성**을 직접 잰다.

    개별 라우트 하나가 발행한다는 사실은 "나중에 추가되는 변경 라우트도 커버된다"
    를 증명하지 않는다 — 그건 라우터에 등록된 모든 route 가 래핑 클래스일 때만
    참이다. 이 단언이 깨지면 라우터 어딘가가 자체 APIRoute 를 쓰고 있다는 뜻이고,
    그 경로의 변경은 다른 창에 조용히 전달되지 않는다.
    """
    from fastapi.routing import APIRoute

    from hoga.api.mutation_broadcast import mutation_broadcast_route_class

    if kind == "watchlist":
        from hoga.api.watchlist_routes import build_router
    else:
        from hoga.api.heatmap_routes import build_router

    wrapped = mutation_broadcast_route_class(EventBus(), "probe")
    assert wrapped is not APIRoute  # 래퍼가 실제로 만들어졌는지부터

    router = build_router(data_dir=tmp_path, bus=EventBus())
    api_routes = [r for r in router.routes if isinstance(r, APIRoute)]
    assert api_routes, "라우터에 APIRoute 가 하나도 없다 — 단언이 공허하다"
    plain = [r.path for r in api_routes if type(r) is APIRoute]
    assert plain == [], f"브로드캐스트로 감싸이지 않은 라우트: {plain}"
