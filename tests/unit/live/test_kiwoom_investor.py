"""키움 투자자 어댑터 테스트 (#1041, PR-E).

실측이 잡은 함정 셋을 봉인한다 — 셋 다 **조용히 틀리는** 종류다:
  ① `amt_qty_tp` 는 2 가 수량(이름 순서가 직관과 반대)
  ② `unit_tp` 는 무의미
  ③ **외국인 = `frgnr_invsr` + `natfor`** (KIS 는 합산, 키움은 분리)
"""
from __future__ import annotations

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

async def test_trend_estimate_has_no_natfor_field() -> None:
    """가집계 TR 에는 `natfor` 가 없다 — base 만 쓰는 것이 맞다."""
    rows = [
        {"tm": "090000", "frgnr_invsr": "0", "orgn": "0"},
        {"tm": "095700", "frgnr_invsr": "-62603", "orgn": "-173941"},
    ]
    c = _client(lambda _r: _ok("opmr_invsr_trde_chart", rows))
    out = await fetch_investor_trend_estimate(c, "005930")
    assert [r.slot for r in out] == ["090000", "095700"]
    assert out[1].foreign_qty == -62_603
    assert out[1].institution_qty == -173_941
    assert out[1].sum_qty == -62_603 + -173_941
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
