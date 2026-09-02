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


# 저장 계열(스크리너·저장뷰)의 최소 생성 payload. 폴더 CRUD 와 모양이 달라
# 파라미터를 따로 든다.
CHART = {"timeframe": "1m", "indicators": {"paneOrder": [], "paneStretch": {}, "byTimeframe": {}}}

_SAVE_CREATE = {
    "screener": (
        "/api/screener/saves",
        {
            "name": "저장A",
            "conditions": [],
            "universe": {"markets": ["KOSPI"], "scopes": []},
        },
    ),
    "live-layout-presets": (
        "/api/live-layout-presets",
        {
            "name": "단타용",
            "payload": {
                "windows": [
                    {"id": "w1", "kind": "chart", "group": 1,
                     "rect": {"x": 0, "y": 0, "w": 442, "h": 531},
                     "chart": CHART},
                ],
                "zOrder": ["w1"],
                # 프리셋은 창 배치와 함께 **그룹 종목**도 담는다(배치만이 아니다).
                "groupSymbols": {"1": {"code": "005930", "name": "삼성전자"}},
            },
        },
    ),
    "study-views": (
        "/api/study-views/saves",
        {
            "name": "뷰A",
            "code": "005930",
            "label": "삼성전자",
            "timeframe": "1m",
            "range": {
                "from_date": "20260817",
                "to_date": "20260818",
                "from_ms": 1_786_950_000_000,
                "to_ms": 1_787_036_400_000,
            },
            "viewport": {
                "right_edge_ms": 1_787_036_400_000,
                "bar_span": 120.0,
                "at_live_edge": True,
            },
            "tags": [],
        },
    ),
}


def _drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _build_router(kind: str, tmp_path: Path, bus: EventBus | None):
    if kind == "watchlist":
        from hoga.api.watchlist_routes import build_router
    elif kind == "heatmap":
        from hoga.api.heatmap_routes import build_router
    elif kind == "study-views":
        from hoga.api.study_view_routes import build_router
    elif kind == "live-layout-presets":
        from hoga.api.live_layout_preset_routes import build_router
    else:
        from hoga.api.screener import build_router
    return build_router(data_dir=tmp_path, bus=bus)


def _client(tmp_path: Path, kind: str, *, bus: EventBus | None) -> TestClient:
    app = FastAPI()
    app.include_router(_build_router(kind, tmp_path, bus))
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


# --- 저장 계열(스크리너·저장뷰) ------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "event_type"),
    [
        ("screener", "screener_saves_changed"),
        ("study-views", "study_views_changed"),
        ("live-layout-presets", "live_layout_presets_changed"),
    ],
)
def test_save_create_publishes_change_event(tmp_path: Path, kind: str, event_type: str):
    bus = EventBus()
    q = bus.subscribe()
    client = _client(tmp_path, kind, bus=bus)
    path, body = _SAVE_CREATE[kind]

    resp = client.post(path, json=body)

    assert resp.status_code == 201, resp.text
    assert _drain(q) == [{"type": event_type}]


@pytest.mark.parametrize(
    "kind", ["screener", "study-views", "live-layout-presets"],
)
def test_save_list_publishes_nothing(tmp_path: Path, kind: str):
    bus = EventBus()
    q = bus.subscribe()
    client = _client(tmp_path, kind, bus=bus)
    path, _ = _SAVE_CREATE[kind]

    assert client.get(path).status_code == 200
    assert _drain(q) == []


def test_screener_scan_is_not_a_broadcast_route(tmp_path: Path):
    """``POST /scan`` 은 **조회성 POST** 다 — 발행하면 안 된다.

    스캔은 사용자가 조건을 만질 때마다 나간다. 여기서 발행하면 열려 있는 모든 창이
    그 횟수만큼 저장 목록을 다시 읽는다. 관심목록 ``/catchup`` 에서 스퓨리어스를
    감수한 논리(가끔 누르는 버튼)가 이쪽으로 이식되지 않는 지점이다.

    스캔을 **실행하지 않고** 라우트 클래스로 잰다 — 실제 스캔은 무거운 데이터
    경로라 여기서 돌릴 것이 아니고, 플레인 클래스라는 사실이 곧 "발행 경로가
    존재하지 않는다" 는 더 강한 진술이다.
    """
    from fastapi.routing import APIRoute

    router = _build_router("screener", tmp_path, EventBus())
    scan = [r for r in router.routes if isinstance(r, APIRoute) and r.path.endswith("/scan")]
    assert len(scan) == 1, "scan 라우트를 못 찾았다 — 단언이 공허하다"
    assert type(scan[0]) is APIRoute


def test_screener_broadcast_is_scoped_to_saves(tmp_path: Path):
    """자동성의 **경계**를 양방향으로 잰다.

    스크리너는 라우터 전체가 아니라 ``/saves`` 서브라우터만 브로드캐스트한다.
    그래서 단언이 둘이다: ① saves 경로는 **전부** 감싸여 있다(새 저장 라우트가
    자동 커버) ② 그 밖의 경로는 **하나도** 감싸이지 않았다(scan/update 가 조용히
    발행하게 되는 회귀를 막는다).

    ②가 없으면 "메인 라우터에 route_class 를 걸어 버리는" 되돌림이 초록으로
    통과한다 — 그 되돌림이야말로 이 분리가 막으려는 것이다.
    """
    from fastapi.routing import APIRoute

    router = _build_router("screener", tmp_path, EventBus())
    api_routes = [r for r in router.routes if isinstance(r, APIRoute)]
    assert api_routes, "라우터에 APIRoute 가 없다 — 단언이 공허하다"

    # 저장 **계열**은 둘이다(조건검색 · 봉 패턴). 채널은 다르지만 둘 다 브로드캐스트를
    # 가져야 하고, 그 밖은 가지면 안 된다 — 새 저장 계열을 더하면 여기 접두사도 함께
    # 늘린다(안 늘리면 이 가드가 그 라우트를 «샌 것» 으로 잡는다).
    save_prefixes = ("/api/screener/saves", "/api/screener/pattern-saves")
    saves = [r for r in api_routes if r.path.startswith(save_prefixes)]
    others = [r for r in api_routes if not r.path.startswith(save_prefixes)]
    # 개수를 고정하지 않는다 — 저장 라우트가 늘어도 이 가드는 계속 유효해야 한다.
    # "빠뜨린 것" 은 아래 두 단언이 잡는다: 메인 라우터에 `/saves…` 를 달면 그
    # 라우트는 여기 saves 목록에 들어오면서 플레인 클래스라 unwrapped 에 걸린다.
    assert saves, "saves 라우트가 없다 — ① 단언이 공허하다"
    assert others, "saves 밖 라우트가 없다 — ② 단언이 공허하다"

    unwrapped = [r.path for r in saves if type(r) is APIRoute]
    assert unwrapped == [], f"브로드캐스트가 빠진 저장 라우트: {unwrapped}"
    leaked = [f"{sorted(r.methods)} {r.path}" for r in others if type(r) is not APIRoute]
    assert leaked == [], f"저장 밖인데 브로드캐스트가 걸렸다: {leaked}"


@pytest.mark.parametrize(
    "kind",
    ["watchlist", "heatmap", "study-views", "live-layout-presets"],
)
def test_every_route_is_wrapped(tmp_path: Path, kind: str):
    """route_class 의 **자동성**을 직접 잰다.

    개별 라우트 하나가 발행한다는 사실은 "나중에 추가되는 변경 라우트도 커버된다"
    를 증명하지 않는다 — 그건 라우터에 등록된 모든 route 가 래핑 클래스일 때만
    참이다. 이 단언이 깨지면 라우터 어딘가가 자체 APIRoute 를 쓰고 있다는 뜻이고,
    그 경로의 변경은 다른 창에 조용히 전달되지 않는다.
    """
    from fastapi.routing import APIRoute

    from hoga.api.mutation_broadcast import mutation_broadcast_route_class

    wrapped = mutation_broadcast_route_class(EventBus(), "probe")
    assert wrapped is not APIRoute  # 래퍼가 실제로 만들어졌는지부터

    router = _build_router(kind, tmp_path, EventBus())
    api_routes = [r for r in router.routes if isinstance(r, APIRoute)]
    assert api_routes, "라우터에 APIRoute 가 하나도 없다 — 단언이 공허하다"
    plain = [r.path for r in api_routes if type(r) is APIRoute]
    assert plain == [], f"브로드캐스트로 감싸이지 않은 라우트: {plain}"
