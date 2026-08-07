"""시장 종합 읽기 라우트 — 캐시 4규약과 무자격 휴면을 고정한다 (#1121)."""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api.market_routes import build_router


def test_router_exposes_the_market_surfaces():
    r = build_router(data_dir=Path("/tmp"))
    assert sorted(x.path for x in r.routes) == [
        "/api/market/breadth",
        # 파생 투자자 수급도 KIS 전용이다 — 키움 337 TR 중 파생 투자자 TR 이 0건이라
        # 대체 경로가 없고, 원천 TR 은 모의투자 미지원이다.
        "/api/market/deriv-flow",
        "/api/market/funds",
        # 선물 2개만 벤더가 KIS 다 — 키움에 파생 TR 이 0건이라 대체 경로가 없다(ADR-0141).
        "/api/market/futures-candles",
        "/api/market/futures-quotes",
        "/api/market/investor-flow",
        "/api/market/program",
        "/api/market/sector-flow",
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
async def test_breadth_counts_52w_only():
    """급등락(ka10019)은 뺐다 — 시장 폭 카드가 업종 수급으로 교체되며 소비자가 0 이 됐다.

    이 테스트가 지키는 것은 "안 부른다" 다. ka10019 는 이 라우터에서 가장 무거운 콜
    (페이지 walk × 2시장)이라 되살아나면 조용히 5분마다 돈다.
    """
    from hoga.api.market_routes import _collect_breadth

    called: list[str] = []

    async def _walk(api_id, body, *, key, stop=None):  # noqa: ANN001, ARG001
        called.append(api_id)
        return ([{"stk_cd": str(i)} for i in range(45)], False)

    out = await _collect_breadth(_walk)
    kospi = out["markets"]["KOSPI"]
    assert kospi["new_high_52w"] == {"count": 45, "truncated": False}
    assert kospi["new_low_52w"] == {"count": 45, "truncated": False}
    assert set(kospi) == {"new_high_52w", "new_low_52w"}
    assert set(called) == {"ka10016"}
    assert set(out["markets"]) == {"KOSPI", "KOSDAQ"}


@pytest.mark.asyncio
async def test_breadth_still_reports_truncation_when_it_happens():
    """조용한 절사 금지 — 상한에 닿았으면 카운트는 **하한**이다(#1099)."""
    from hoga.api.market_routes import _collect_breadth

    async def _walk(_api_id, _body, *, key, stop=None):  # noqa: ANN001, ARG001
        return ([{"stk_cd": str(i)} for i in range(1000)], True)

    out = await _collect_breadth(_walk)
    assert out["markets"]["KOSPI"]["new_high_52w"] == {"count": 1000, "truncated": True}


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


# ── wire model 계약 (ADR-0004) ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dormant_payloads_satisfy_their_wire_models(monkeypatch, tmp_path):
    """무자격 응답이 wire model 검증을 **통과**해야 한다 — 안 그러면 500 이다.

    위 라우트 테스트들은 엔드포인트 함수를 직접 부르므로 FastAPI 의 response_model
    단계를 건너뛴다. 즉 dict 단언만으로는 모델과의 정합을 못 본다. 무자격은
    dev·워크트리·e2e 의 **정상 경로**라 여기서 깨지면 그 환경 전체가 500 이 된다.
    """
    from hoga.api import market_routes as mr
    from hoga.live import kiwoom_rest_runtime

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: None)
    r = build_router(data_dir=tmp_path)
    by_path = {x.path: x for x in r.routes}

    for path, model in (
        ("/api/market/sectors", mr.MarketSectorsResponse),
        ("/api/market/streaks", mr.StreaksResponse),
        ("/api/market/program", mr.ProgramResponse),
        ("/api/market/breadth", mr.BreadthResponse),
        ("/api/market/investor-flow", mr.InvestorFlowResponse),
        ("/api/market/deriv-flow", mr.DerivFlowResponse),
        ("/api/market/sector-flow", mr.SectorFlowResponse),
    ):
        payload = await by_path[path].endpoint()
        model.model_validate(payload)  # 예외 없이 통과하는 것이 계약이다


def test_literal_fallback_dicts_satisfy_their_wire_models():
    """업스트림 예외 시 쓰이는 `or {...}` 리터럴 폴백도 모델을 통과해야 한다.

    이 경로는 캐시가 last-good 조차 못 가진 상태에서만 열려서 위 무자격 테스트로는
    안 닿는다 — `_collect_*` 는 벤더가 없어도 정상 dict 를 만들기 때문이다.
    빠뜨리기 쉬운 자리라 리터럴을 그대로 박아 고정한다.
    """
    from hoga.api import market_routes as mr

    # `/sectors` 폴백엔 `volatility` 키가 아예 없다 — 모델 기본값이 채워 준다.
    sectors = mr.MarketSectorsResponse.model_validate({"markets": {}})
    assert sectors.volatility is None

    mr.ProgramResponse.model_validate({"axis": "intraday", "markets": {}})
    mr.BreadthResponse.model_validate({"markets": {}})
    mr.StreaksResponse.model_validate({"외국인": [], "기관": [], "warnings": []})
    mr.FuturesQuotesResponse.model_validate({"quotes": [], "session": "closed", "unavailable": None})
    mr.FuturesCandlesResponse.model_validate({"series": {}})


def test_streaks_wire_keys_stay_korean():
    """주체 키는 wire 에서 **한글 그대로**다 — alias 는 파이썬 쪽 사정일 뿐이다.

    FastAPI 가 응답을 `by_alias=True` 로 직렬화하므로 프론트 계약은 변하지 않는다.
    이 단언이 없으면 누군가 alias 를 지워도 파이썬 테스트는 전부 통과한다.
    """
    from hoga.api.market_routes import StreaksResponse

    dumped = StreaksResponse.model_validate(
        {"외국인": [], "기관": [], "warnings": ["etf_filter_unavailable"]}
    ).model_dump(by_alias=True)

    assert set(dumped) == {"외국인", "기관", "warnings"}


def test_breadth_omits_absent_axes_rather_than_nulling_them():
    """벤더가 못 준 축은 **키가 빠진다** — `null` 로 실리면 FE 의 `?:` 계약이 깨진다.

    라우트에 `response_model_exclude_none=True` 를 건 이유가 이것이고, 그 옵션은
    라우트 데코레이터에 있어서 모델만 봐서는 알 수 없다. 여기서 직렬화까지 재 둔다.
    """
    from hoga.api.market_routes import BreadthResponse

    got = BreadthResponse.model_validate(
        {"markets": {"KOSPI": {"new_high_52w": {"count": 3, "truncated": False}}}}
    ).model_dump(exclude_none=True)

    # 신저 축은 키 자체가 빠진다 — `null` 로 실리면 FE 의 `?:` 계약이 깨진다.
    assert got["markets"]["KOSPI"] == {"new_high_52w": {"count": 3, "truncated": False}}


@pytest.mark.asyncio
async def test_sector_flow_reads_latest_sample_per_market_without_calling_the_vendor(tmp_path):
    """읽기 경로에 벤더가 없다 — ka10051 표본에 업종 행이 처음부터 들어 있었다.

    시장이 한 파일에 번갈아 쌓이므로 **시장별 마지막** 표본을 각각 집어야 한다.
    통째로 마지막 한 줄만 보면 한 시장이 통째로 빈다.
    """
    from hoga.api.market_routes import _sector_flow_payload
    from hoga.collector.orchestrator import now_kst
    from hoga.live.investor_flow_store import IntradaySample, InvestorFlowStore

    date = now_kst().strftime("%Y%m%d")
    store = InvestorFlowStore(tmp_path)

    def sample(ms, mrkt, code, name, ind):
        return IntradaySample(
            sampled_at_ms=ms,
            request={"mrkt_tp": mrkt, "amt_qty_tp": "0", "base_dt": date, "stex_tp": "3"},
            rows=[{"inds_cd": f"{code}_AL", "inds_nm": name, "cur_prc": "-77903",
                   "flu_rt": "-282", "ind_netprps": ind, "frgnr_netprps": "-1",
                   "orgn_netprps": "+1"}],
        )

    store.append_sample(date, sample(1_000, "0", "001", "종합(KOSPI)", "+100"))
    store.append_sample(date, sample(2_000, "1", "101", "종합(KOSDAQ)", "+200"))
    store.append_sample(date, sample(3_000, "0", "001", "종합(KOSPI)", "+300"))  # 코스피 최신

    got = _sector_flow_payload(tmp_path)

    assert got["unit"] == "amt_eok"          # 단위를 필드로 말한다(#1117)
    assert got["sampled_at_ms"] == 3_000
    assert set(got["markets"]) == {"KOSPI", "KOSDAQ"}
    assert got["markets"]["KOSPI"][0]["individual"] == 300   # 마지막 표본
    assert got["markets"]["KOSDAQ"][0]["individual"] == 200  # 덮이지 않았다


@pytest.mark.asyncio
async def test_sector_flow_empty_day_is_empty_not_error(tmp_path):
    """수집기가 아직 안 돌았으면 빈 markets — 크래시가 아니다(ADR-0134)."""
    from hoga.api.market_routes import _sector_flow_payload

    got = _sector_flow_payload(tmp_path)
    assert got["markets"] == {}
    assert got["sampled_at_ms"] is None
