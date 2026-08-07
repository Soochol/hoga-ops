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
        # 선물 2개만 벤더가 KIS 다 — 키움에 파생 TR 이 0건이라 대체 경로가 없다(ADR-0141).
        "/api/market/futures-candles",
        "/api/market/futures-quotes",
        "/api/market/investor-flow",
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

    # `volatility` 는 **키가 있고 값이 None** 이다 — 키를 빼면 프론트가 "아직 안 온 것"과
    # "무자격이라 없는 것"을 구별하지 못한다(카드가 조용히 사라진다).
    assert sectors == {"markets": {}, "volatility": None}
    assert streaks == {"외국인": [], "기관": [], "warnings": []}
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

    async def _walk(api_id, body, *, key, stop=None):  # noqa: ANN001, ARG001
        # 급등락은 임계 이상만 세고, 신고저는 전량 센다
        if api_id == "ka10019":
            rows = [{"stk_cd": str(i), "jmp_rt": "+9.0"} for i in range(3)]
            rows += [{"stk_cd": f"lo{i}", "jmp_rt": "+1.2"} for i in range(197)]
            return (rows, False)
        return ([{"stk_cd": str(i)} for i in range(45)], False)

    out = await _collect_breadth(_walk)
    kospi = out["markets"]["KOSPI"]
    assert kospi["new_high_52w"] == {"count": 45, "truncated": False}
    # 200행을 받았지만 임계(3%) 이상은 3개뿐 — 벤더 하한(1%)이 아니라 우리 임계가 센다
    assert kospi["surge"] == {"count": 3, "truncated": False}
    assert kospi["plunge"]["count"] == 3
    assert set(out["markets"]) == {"KOSPI", "KOSDAQ"}


@pytest.mark.asyncio
async def test_breadth_still_reports_truncation_when_it_happens():
    """임계 조기 종료가 절사를 없애지만, 일어나면 여전히 말해야 한다(#1099)."""
    from hoga.api.market_routes import _collect_breadth

    async def _walk(api_id, body, *, key, stop=None):  # noqa: ANN001, ARG001
        # 전 행이 임계 이상이라 조기 종료가 안 걸리고 상한에 닿은 상황
        if api_id == "ka10019":
            return ([{"stk_cd": str(i), "jmp_rt": "+9.0"} for i in range(1000)], True)
        return ([{"stk_cd": str(i)} for i in range(45)], False)

    out = await _collect_breadth(_walk)
    assert out["markets"]["KOSPI"]["surge"] == {"count": 1000, "truncated": True}


@pytest.mark.asyncio
async def test_breadth_is_dormant_without_credentials():
    """무자격이면 walk 가 None — 그 시장은 통째로 빠진다(빈 카운트를 지어내지 않는다)."""
    from hoga.api.market_routes import _collect_breadth

    async def _walk(_api_id, _body, *, key, stop=None):  # noqa: ANN001, ARG001
        return None

    assert await _collect_breadth(_walk) == {"markets": {}}


@pytest.mark.asyncio
async def test_investor_flow_reads_stored_samples_without_calling_the_vendor(tmp_path):
    """읽기 경로는 벤더를 부르지 않는다 — 표본은 수집기가 이미 찍었고 소급 조회는 불가다."""
    import datetime as dt

    from hoga.api.market_routes import _investor_flow_payload
    from hoga.collector.orchestrator import now_kst
    from hoga.live.investor_flow_store import IntradaySample, InvestorFlowStore

    date = now_kst().strftime("%Y%m%d")
    store = InvestorFlowStore(tmp_path)
    for i, frgn in enumerate(("+6473", "+7697")):
        store.append_sample(date, IntradaySample(
            sampled_at_ms=1_000 + i * 60_000,
            request={"mrkt_tp": "0", "amt_qty_tp": "0", "base_dt": date, "stex_tp": "3"},
            rows=[{"inds_cd": "001_AL", "ind_netprps": "-8787",
                   "frgnr_netprps": frgn, "orgn_netprps": "+1893"}],
        ))

    got = _investor_flow_payload(tmp_path)
    assert got["unit"] == "amt_eok"          # 단위를 이름에 박는다(#1117)
    assert got["confirmed"] is False          # 확정 파일이 없으니 잠정(파생)
    assert [p["foreign"] for p in got["markets"]["KOSPI"]] == [6473, 7697]
    cov = got["coverage"]
    assert cov["sample_count"] == 2
    assert cov["expected_count"] == 390       # 390분 ÷ 60초
    assert cov["gap_ranges"] == []
    assert isinstance(dt.datetime.strptime(got["date"], "%Y%m%d"), dt.datetime)


@pytest.mark.asyncio
async def test_investor_flow_empty_day_is_empty_not_error(tmp_path):
    from hoga.api.market_routes import _investor_flow_payload

    got = _investor_flow_payload(tmp_path)
    assert got["markets"] == {}
    assert got["coverage"]["sample_count"] == 0
    assert got["confirmed"] is False


@pytest.mark.asyncio
async def test_volatility_is_promoted_out_of_the_sector_list():
    """VKOSPI(`603`)는 업종 배열이 아니라 최상위 `volatility` 로 나간다 (2026-08-07).

    업종행으로 두면 두 곳에서 틀린다: 업종 온도 리스트에 "변동성지수" 가 한 줄로
    섞이고, 업종 분산·쏠림 계산이 그것을 업종으로 세어 왜곡된다. 소스가 키움
    ka20003 이라는 점이 이 승격의 근거다 — 예전 카드가 쓰던 KIS 선물(A04608)은
    당일 거래량 0 이라 값이 정산가에 굳어 장중 내내 움직이지 않았다.
    """
    from hoga.api.market_routes import _collect_sectors

    kospi = [
        {"stk_cd": "001", "stk_nm": "종합(KOSPI)", "cur_prc": "-6292.97", "flu_rt": "-0.21"},
        {"stk_cd": "005", "stk_nm": "음식료/담배", "cur_prc": "+4759.72", "flu_rt": "+1.69"},
        {"stk_cd": "603", "stk_nm": "변동성지수", "cur_prc": "-75.97", "flu_rt": "-1.56"},
    ]
    kosdaq = [{"stk_cd": "101", "stk_nm": "종합(KOSDAQ)", "cur_prc": "+802.99", "flu_rt": "+0.16"}]

    async def call(_api_id, params, *, key=None):  # noqa: ARG001
        return kospi if params["mrkt_tp"] == "0" else kosdaq

    got = await _collect_sectors(call)

    assert got["volatility"] == {
        "code": "603", "name": "변동성지수",
        "value": 75.97,          # 레벨은 부호를 벗긴다
        "change_pct": -1.56,     # 등락률은 부호가 곧 값이다
    }
    assert [s["code"] for s in got["markets"]["0"]["sectors"]] == ["005"]
    assert got["markets"]["0"]["index"]["value"] == 6292.97


@pytest.mark.asyncio
async def test_volatility_is_none_when_the_row_is_absent():
    """`603` 이 없는 날에도 키는 남는다 — 없는 것과 아직 안 온 것을 화면이 구별한다."""
    from hoga.api.market_routes import _collect_sectors

    async def call(_api_id, params, *, key=None):  # noqa: ARG001
        return [{"stk_cd": "001", "stk_nm": "종합(KOSPI)", "cur_prc": "+6292.97",
                 "flu_rt": "+0.21"}]

    got = await _collect_sectors(call)
    assert got["volatility"] is None
