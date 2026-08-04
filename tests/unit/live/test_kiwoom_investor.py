"""키움 투자자 어댑터 테스트 (#1041, PR-E).

실측이 잡은 함정 셋을 봉인한다 — 셋 다 **조용히 틀리는** 종류다:
  ① `amt_qty_tp` 는 2 가 수량(이름 순서가 직관과 반대)
  ② `unit_tp` 는 무의미
  ③ **외국인 = `frgnr_invsr` + `natfor`** (KIS 는 합산, 키움은 분리)
"""
from __future__ import annotations

import json

import httpx
import pytest

from hoga.live.index_registry import RepresentativeIndex
from hoga.live.kiwoom_investor import (
    AMT_QTY_QUANTITY,
    date_range,
    fetch_investor_net,
    fetch_investor_trend_estimate,
    fetch_market_investor_net_day,
    foreign_net,
)
from hoga.live.kiwoom_rest import KiwoomRestClient

KOSPI = RepresentativeIndex(
    id="KOSPI", label="코스피", kis_index_code="0001",
    investor_scope="market", enabled_by_default=True,
)

# 실측 행(005930, 20260803, amt_qty_tp=2). KIS 대조값: 외국인 -3,896,489 · 기관 -5,039,954
ROW_59 = {
    "dt": "20260803", "frgnr_invsr": "-3923675", "natfor": "27186",
    "orgn": "-5039954", "ind_invsr": "8658155",
}


class _Prov:
    def get_token(self) -> str:
        return "tok"


def _client(handler) -> KiwoomRestClient:
    return KiwoomRestClient(_Prov(), transport=httpx.MockTransport(handler))


def _ok(key: str, rows: list[dict], *, cont: str = "N", nk: str = "") -> httpx.Response:
    return httpx.Response(
        200, json={"return_code": 0, "return_msg": "정상", key: rows},
        headers={"cont-yn": cont, "next-key": nk},
    )


# === 함정 ③ 외국인 정의 — 가장 조용히 틀린다 =================================

def test_foreign_net_matches_kis_only_when_natfor_is_added() -> None:
    """KIS 는 내국인대우외국인을 외국인에 합산한다 — 실측으로 확인했다.

        키움 frgnr_invsr (-3,923,675) + natfor (+27,186) = -3,896,489 = KIS ✅

    `frgnr_invsr` 만 쓰면 0.7% 어긋난 값이 조용히 흐른다.
    """
    assert foreign_net(ROW_59, base="frgnr_invsr", native="natfor") == -3_896_489
    assert foreign_net(ROW_59, base="frgnr_invsr", native=None) == -3_923_675, (
        "natfor 를 빼면 KIS 와 어긋난다 — 이 차이가 함정이다"
    )


def test_institution_matches_kis_exactly() -> None:
    """기관계는 분리가 없어 그대로 일치한다(실측 대조)."""
    from hoga.live.kiwoom_investor import _signed
    assert _signed(ROW_59["orgn"]) == -5_039_954


# === 함정 ① amt_qty_tp — 이름 순서가 반대 ====================================

def test_quantity_axis_is_two_not_one() -> None:
    """`amt_qty_tp=1` 은 **금액(백만원)** 이다.

    검산: 952,097백만원 ÷ 3,923,675주 = 242,650원/주 — 당일 범위
    (238,000~249,500) 안. `1` 을 쓰면 금액을 수량 자리에 넣는다.
    """
    assert AMT_QTY_QUANTITY == "2"


async def test_investor_net_requests_the_quantity_axis() -> None:
    sent: list[dict] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content))
        return _ok("stk_invsr_orgn", [ROW_59])

    c = _client(_h)
    await fetch_investor_net(c, "005930", "20260803", "20260803")
    assert sent[0]["amt_qty_tp"] == "2", "수량 축을 요청해야 한다"
    await c.aclose()


# === ka10059 ==================================================================

async def test_investor_net_parses_and_anchors_at_0900() -> None:
    c = _client(lambda _r: _ok("stk_invsr_orgn", [ROW_59]))
    res = await fetch_investor_net(c, "005930", "20260803", "20260803")
    assert len(res.points) == 1
    p = res.points[0]
    assert p.foreign_net == -3_896_489
    assert p.institution_net == -5_039_954
    import datetime

    from hoga.util.timeenc import KST
    got = datetime.datetime.fromtimestamp(p.t_ms / 1000, tz=KST)
    assert (got.hour, got.minute) == (9, 0), "일봉과 같은 09:00 앵커"
    await c.aclose()


async def test_investor_net_filters_range_and_dedupes() -> None:
    rows = [
        ROW_59,
        {**ROW_59, "dt": "20260731"},
        {**ROW_59, "dt": "20260731"},          # 중복
        {**ROW_59, "dt": "20260101"},          # 범위 밖
    ]
    c = _client(lambda _r: _ok("stk_invsr_orgn", rows))
    res = await fetch_investor_net(c, "005930", "20260731", "20260803")
    assert len(res.points) == 2
    assert [p.t_ms for p in res.points] == sorted(p.t_ms for p in res.points)
    await c.aclose()


async def test_investor_net_malformed_date_becomes_violation() -> None:
    c = _client(lambda _r: _ok("stk_invsr_orgn", [{**ROW_59, "dt": "20"}]))
    res = await fetch_investor_net(c, "20260101", "20260803", "20260803")
    assert res.points == []
    assert [v.reason for v in res.violations] == ["malformed_row"]
    await c.aclose()


async def test_investor_net_stops_when_older_than_from_is_seen() -> None:
    pages = [
        _ok("stk_invsr_orgn", [{**ROW_59, "dt": "20260803"}], cont="Y", nk="k"),
        _ok("stk_invsr_orgn", [{**ROW_59, "dt": "20260730"}], cont="Y", nk="k2"),
    ]
    it = iter(pages)
    n = 0

    def _h(_r: httpx.Request) -> httpx.Response:
        nonlocal n
        n += 1
        return next(it)

    c = _client(_h)
    await fetch_investor_net(c, "005930", "20260731", "20260803")
    assert n == 2, "from 이전 날짜를 본 페이지에서 멈춘다(구조적 술어)"
    await c.aclose()


# === ka10051 시장(업종) =======================================================

async def test_market_investor_strips_venue_suffix_from_index_code() -> None:
    """`inds_cd` 가 `'001_AL'` 처럼 접미를 달고 온다 — 안 벗기면 매칭이 실패한다."""
    rows = [
        {"inds_cd": "002_AL", "frgnr_netprps": "+1", "native_trmt_frgnr_netprps": "0",
         "orgn_netprps": "+1"},
        {"inds_cd": "001_AL", "frgnr_netprps": "+85703",
         "native_trmt_frgnr_netprps": "-451", "orgn_netprps": "+8222"},
    ]
    c = _client(lambda _r: _ok("inds_netprps", rows))
    pt = await fetch_market_investor_net_day(c, KOSPI, "20260731")
    assert pt is not None
    assert pt.foreign_net == 85_703 - 451, "여기도 natfor 계열을 합산한다"
    assert pt.institution_net == 8_222
    await c.aclose()


async def test_market_investor_day_issues_exactly_one_call() -> None:
    """KIS 는 시계열을 한 번에 주지만 ka10051 은 base_dt 하루치다(#1007).

    **1콜인 것이 계약이다** — 날짜 반복은 거버너 위(호출자)에 있어야 하고, 이 함수가
    여러 날을 돌면 그 반복이 다시 거버너 아래로 숨는다(ADR-0137).
    """
    seen: list[str] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        seen.append(_json.loads(r.content)["base_dt"])
        return _ok("inds_netprps", [])

    c = _client(_h)
    await fetch_market_investor_net_day(c, KOSPI, "20260801")
    assert seen == ["20260801"]
    await c.aclose()


async def test_market_investor_day_returns_none_on_non_trading_day() -> None:
    """휴장일은 빈 응답이다 — 실패가 아니라 '그 날은 데이터가 없다' 는 뜻이다."""
    c = _client(lambda _r: _ok("inds_netprps", []))
    assert await fetch_market_investor_net_day(c, KOSPI, "20260802") is None
    await c.aclose()


def test_date_range_is_inclusive_and_empty_when_reversed() -> None:
    """호출자가 이 목록만큼 submit 을 낸다 — 개수가 곧 유량이다."""
    assert date_range("20260801", "20260803") == ["20260801", "20260802", "20260803"]
    assert date_range("20260801", "20260801") == ["20260801"]
    assert date_range("20260803", "20260801") == []


# === ka10064 장중 추정 ========================================================

# 실측 슬롯(005930, 20260804 14:31). 두 축의 비가 232,864원/주 = 당일 범위
# (228,000~244,500) 안 — 축 배선이 뒤집히면 429만원/주가 되어 검산에서 걸린다.
_EST_QTY = [
    {"tm": "090000", "frgnr_invsr": "0", "orgn": "0"},
    {"tm": "143100", "frgnr_invsr": "-912000", "orgn": "-1925000"},
]
_EST_AMT = [
    {"tm": "090000", "frgnr_invsr": "0", "orgn": "0"},
    {"tm": "143100", "frgnr_invsr": "-212372", "orgn": "-451250"},
]


def _estimate_client(*, seen: list[str] | None = None) -> KiwoomRestClient:
    """`amt_qty_tp` 로 축을 갈라 응답하는 페이크. 축을 무시하고 한 벌만 돌려주면
    "두 축이 같은 값" 이라는 없는 사실이 테스트를 통과시킨다."""
    def handler(request: httpx.Request) -> httpx.Response:
        axis = json.loads(request.content)["amt_qty_tp"]
        if seen is not None:
            seen.append(axis)
        return _ok("opmr_invsr_trde_chart", _EST_QTY if axis == "2" else _EST_AMT)

    return _client(handler)


async def test_trend_estimate_carries_both_axes_with_units_in_the_names() -> None:
    """수량은 `_qty`, 금액은 `_amt_mwon` — 이 배선이 2026-08-04 까지 틀려 있었다.

    당시엔 `amt_qty_tp="1"`(금액) 하나만 부르고 그 값을 `_qty` 로 실어, 화면이
    4,512억원을 "45.1만주" 로 그렸다. 두 축 모두 부호도 자릿수도 그럴듯해서
    타입도 테스트도 잡지 못했다 — 유일한 오라클은 두 축의 비(단가)다.
    """
    c = _estimate_client()
    out = await fetch_investor_trend_estimate(c, "005930")

    assert [r.slot for r in out] == ["090000", "143100"]
    latest = out[1]
    assert latest.foreign_qty == -912_000
    assert latest.institution_qty == -1_925_000
    assert latest.sum_qty == -912_000 + -1_925_000
    assert latest.foreign_amt_mwon == -212_372
    assert latest.institution_amt_mwon == -451_250
    assert latest.sum_amt_mwon == -212_372 + -451_250

    unit_price = latest.foreign_amt_mwon * 1_000_000 / latest.foreign_qty
    assert 228_000 <= unit_price <= 244_500
    await c.aclose()


async def test_trend_estimate_asks_the_quantity_axis_too() -> None:
    """함정 ① 봉인 — 금액축(`1`) 하나만 부르던 것이 이 버그의 발생 지점이었다."""
    seen: list[str] = []
    c = _estimate_client(seen=seen)
    await fetch_investor_trend_estimate(c, "005930")
    assert sorted(seen) == ["1", "2"]
    await c.aclose()


async def test_trend_estimate_paces_each_axis_through_the_runner() -> None:
    """축이 둘이면 대기표도 둘이다 (ADR-0137).

    호출자가 이 함수 전체를 거버너 하나로 감싸면 버킷은 1 을 세고 벤더는 2 를
    센다. `run_call` 이 축마다 불리는지가 그 계약의 관측 지점이다.
    """
    axes: list[str] = []
    c = _estimate_client()

    async def run_call(fetch, axis):
        axes.append(axis)
        return await fetch(c)

    await fetch_investor_trend_estimate(c, "005930", run_call=run_call)
    assert sorted(axes) == ["1", "2"]
    await c.aclose()


async def test_trend_estimate_leaves_one_sided_slots_unfilled() -> None:
    """한 축에만 있는 슬롯은 반대 축이 None 이다 — 0 으로 채우면 "순매수 0" 이라는
    없는 사실이 된다."""
    def handler(request: httpx.Request) -> httpx.Response:
        axis = json.loads(request.content)["amt_qty_tp"]
        rows = _EST_QTY + [{"tm": "150000", "frgnr_invsr": "-5000", "orgn": "-1000"}]
        return _ok("opmr_invsr_trde_chart", rows if axis == "2" else _EST_AMT)

    c = _client(handler)
    out = await fetch_investor_trend_estimate(c, "005930")
    tail = out[-1]
    assert tail.slot == "150000"
    assert tail.foreign_qty == -5_000
    assert tail.foreign_amt_mwon is None
    assert tail.sum_amt_mwon is None
    await c.aclose()


async def test_trend_estimate_skips_rows_without_slot() -> None:
    c = _client(lambda _r: _ok("opmr_invsr_trde_chart",
                               [{"tm": "", "frgnr_invsr": "1", "orgn": "1"}]))
    assert await fetch_investor_trend_estimate(c, "005930") == []
    await c.aclose()


def test_signed_parser_tolerates_vendor_plus_prefix() -> None:
    from hoga.live.kiwoom_investor import _signed
    assert _signed("+85703") == 85_703
    assert _signed("-451") == -451
    assert _signed("") == 0
    assert _signed(None) == 0
    assert _signed("x") == 0


@pytest.mark.parametrize("bad", ["", "-", None])
def test_signed_parser_never_raises(bad) -> None:
    from hoga.live.kiwoom_investor import _signed
    assert _signed(bad) == 0
