"""시장 종합 읽기 라우트 — 캐시 4규약과 무자격 휴면을 고정한다 (#1121)."""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api.market_routes import build_router


def test_router_exposes_the_market_surfaces():
    r = build_router(data_dir=Path("/tmp"))
    assert sorted(x.path for x in r.routes) == [
        "/api/market/breadth",
        "/api/market/funds",
        "/api/market/program",
        "/api/market/sectors",
        "/api/market/streaks",
    ]


@pytest.mark.asyncio
async def test_ttl_cache_is_single_flight():
    """락이 곧 단일비행 — 동시 요청이 업스트림을 한 번만 친다."""
    from hoga.api import market_routes

    cache = market_routes._TtlCache(ttl_s=60.0)
    calls = {"n": 0}

    async def _fetch():
        calls["n"] += 1
        return {"v": calls["n"]}

    import asyncio

    got = await asyncio.gather(*(cache.get(_fetch) for _ in range(5)))
    assert calls["n"] == 1
    assert all(g == {"v": 1} for g in got)


@pytest.mark.asyncio
async def test_failure_keeps_last_good_and_does_not_hot_retry():
    """실패가 last-good 을 축출하지 않고, fetched_at 은 갱신돼 뜨거운 루프를 막는다."""
    from hoga.api import market_routes

    cache = market_routes._TtlCache(ttl_s=0.0)  # 항상 만료 → 매번 fetch 시도
    state = {"ok": True, "calls": 0}

    async def _fetch():
        state["calls"] += 1
        if not state["ok"]:
            raise RuntimeError("upstream down")
        return {"good": True}

    assert await cache.get(_fetch) == {"good": True}
    state["ok"] = False
    # 업스트림이 죽어도 마지막 성공값이 계속 서빙된다
    assert await cache.get(_fetch) == {"good": True}
    assert await cache.get(_fetch) == {"good": True}
    assert state["calls"] == 3  # 시도는 하되 값은 유지


@pytest.mark.asyncio
async def test_surfaces_are_dormant_without_credentials(monkeypatch, tmp_path):
    """무자격이면 빈 응답 — 크래시가 아니다(ADR-0134). dev·워크트리의 정상 경로다."""
    from hoga.live import kiwoom_rest_runtime

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: None)
    r = build_router(data_dir=tmp_path)
    by_path = {x.path: x for x in r.routes}

    sectors = await by_path["/api/market/sectors"].endpoint()
    streaks = await by_path["/api/market/streaks"].endpoint()
    program = await by_path["/api/market/program"].endpoint()

    assert sectors == {"markets": {}}
    assert streaks == {"외국인": [], "기관": []}
    assert program == {"axis": "intraday", "markets": {}}


@pytest.mark.asyncio
async def test_program_axes_do_not_share_a_cache(monkeypatch, tmp_path):
    """당일/일별이 캐시를 공유하면 토글이 서로의 값을 지운다."""
    from hoga.api import market_routes

    r = build_router(data_dir=tmp_path)
    program = next(x for x in r.routes if x.path == "/api/market/program")
    # `_call` 은 클로저라 직접 갈아끼울 수 없다 — 대신 seam 을 막아 두 축이 각자
    # 캐시를 쓰는지(= 축 라벨이 서로를 덮지 않는지) 확인한다.
    from hoga.live import kiwoom_rest_runtime

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: None)
    intraday = await program.endpoint(axis="intraday")
    daily = await program.endpoint(axis="daily")
    assert intraday["axis"] == "intraday"
    assert daily["axis"] == "daily"
    assert market_routes.TTL_PROGRAM_S == 60.0


@pytest.mark.asyncio
async def test_breadth_reports_truncation_not_just_a_count():
    """조용한 절사 금지 — 상한에 닿았으면 응답이 그 사실을 말해야 한다(#1099)."""
    from hoga.api.market_routes import _collect_breadth

    async def _walk(api_id, body, *, key):  # noqa: ANN001, ARG001
        # ka10019(급등락)만 커서가 안 끝나는 상황을 재현한다
        if api_id == "ka10019":
            return ([{"stk_cd": str(i)} for i in range(1000)], True)
        return ([{"stk_cd": str(i)} for i in range(45)], False)

    out = await _collect_breadth(_walk)
    kospi = out["markets"]["KOSPI"]
    assert kospi["new_high_52w"] == {"count": 45, "truncated": False}
    assert kospi["surge"] == {"count": 1000, "truncated": True}
    assert kospi["plunge"]["truncated"] is True
    assert set(out["markets"]) == {"KOSPI", "KOSDAQ"}


@pytest.mark.asyncio
async def test_breadth_is_dormant_without_credentials():
    """무자격이면 walk 가 None — 그 시장은 통째로 빠진다(빈 카운트를 지어내지 않는다)."""
    from hoga.api.market_routes import _collect_breadth

    async def _walk(_api_id, _body, *, key):  # noqa: ANN001, ARG001
        return None

    assert await _collect_breadth(_walk) == {"markets": {}}
