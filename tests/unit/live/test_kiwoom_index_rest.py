"""키움 지수 현재가·일봉 어댑터 테스트 (#1039, PR-C).

가장 중요한 것은 **가격 포맷 교차 검증**이다 — `ka20001` 은 소수점을 포함해
(`'-6241.91'`), `ka20006` 은 제거해(`'624191'`) 준다. 같은 값이 100배 어긋나면
지수 바가 조용히 틀린다.
"""
from __future__ import annotations

import httpx
import pytest

from hoga.live.index_registry import RepresentativeIndex
from hoga.live.kiwoom_index_candles import parse_price
from hoga.live.kiwoom_index_rest import (
    KiwoomIndexRestError,
    fetch_index_daily_candles,
    fetch_index_price,
)
from hoga.live.kiwoom_rest import KiwoomRestClient

KOSPI = RepresentativeIndex(
    id="KOSPI", label="코스피", kis_index_code="0001",
    investor_scope="market", enabled_by_default=True,
)
KOSDAQ = RepresentativeIndex(
    id="KOSDAQ", label="코스닥", kis_index_code="1001",
    investor_scope="market", enabled_by_default=True,
)


class _Prov:
    def get_token(self) -> str:
        return "tok"


def _client(handler) -> KiwoomRestClient:
    return KiwoomRestClient(_Prov(), transport=httpx.MockTransport(handler))


# === 가격 포맷 — 두 TR 이 다르다 =============================================

def test_two_tr_formats_parse_to_the_same_value() -> None:
    """실측(2026-08-03): 같은 날 같은 지수를 두 TR 이 다른 포맷으로 준다.

    `parse_price` docstring 이 "다른 TR 에 재사용하지 말 것" 이라 경고했지만,
    `.` 유무로 분기하므로 **둘 다 옳다.** 그 불변식을 여기서 못 박아 재사용을
    안전하게 만든다 — 깨지면 지수 바가 100배 틀린다.
    """
    assert parse_price("-6241.91") == pytest.approx(6241.91)   # ka20001 형식
    assert parse_price("624191") == pytest.approx(6241.91)     # ka20006 형식


# === ka20001 현재가 ==========================================================

async def test_index_price_takes_latest_row_and_preserves_signs() -> None:
    """20행 중 최신 1행으로 좁히고, 키움이 이미 실어 보낸 부호를 보존한다."""
    rows = [
        {"tm_n": "152000", "cur_prc_n": "-6241.91", "pred_pre_n": "-353.54",
         "flu_rt_n": "-5.36", "trde_qty_n": "147"},
        {"tm_n": "151950", "cur_prc_n": "-6241.34", "pred_pre_n": "-354.11",
         "flu_rt_n": "-5.37", "trde_qty_n": "147"},
    ]
    c = _client(lambda _r: httpx.Response(
        200, json={"return_code": 0, "return_msg": "정상", "inds_cur_prc_tm": rows}))
    idx, value, change, rate, t_ms = await fetch_index_price(c, KOSPI)
    assert idx == "KOSPI"
    assert value == pytest.approx(6241.91), "지수 레벨은 부호 없는 절대값"
    assert change == pytest.approx(-353.54), "전일대비는 부호 보존 — 하락이 음수"
    assert rate == pytest.approx(-5.36)
    assert t_ms > 0
    await c.aclose()


async def test_index_price_uses_response_time_not_fetch_time() -> None:
    """KIS 는 응답에 시각이 없어 수신 시각으로 대체했다. 키움은 `tm_n` 을 준다."""
    import datetime as _dt

    from hoga.util.timeenc import KST

    rows = [{"tm_n": "100000", "cur_prc_n": "3000.00", "pred_pre_n": "0",
             "flu_rt_n": "0"}]
    c = _client(lambda _r: httpx.Response(
        200, json={"return_code": 0, "return_msg": "정상", "inds_cur_prc_tm": rows}))
    _, _, _, _, t_ms = await fetch_index_price(c, KOSPI)
    got = _dt.datetime.fromtimestamp(t_ms / 1000, tz=KST)
    assert (got.hour, got.minute, got.second) == (10, 0, 0)
    await c.aclose()


async def test_index_price_empty_rows_raises() -> None:
    c = _client(lambda _r: httpx.Response(
        200, json={"return_code": 0, "return_msg": "정상", "inds_cur_prc_tm": []}))
    with pytest.raises(KiwoomIndexRestError):
        await fetch_index_price(c, KOSPI)
    await c.aclose()


async def test_kosdaq_uses_its_own_market_type() -> None:
    """`mrkt_tp` 를 틀리면 코스닥 지수가 조용히 코스피 값을 받는다."""
    seen: list[dict] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        seen.append(_json.loads(r.content))
        return httpx.Response(200, json={
            "return_code": 0, "return_msg": "정상",
            "inds_cur_prc_tm": [{"tm_n": "090000", "cur_prc_n": "800.00",
                                 "pred_pre_n": "0", "flu_rt_n": "0"}]})

    c = _client(_h)
    await fetch_index_price(c, KOSDAQ)
    assert seen[0]["mrkt_tp"] == "10"
    assert seen[0]["inds_cd"] == "101"
    await c.aclose()


# === ka20006 일봉 ============================================================

def _daily(rows: list[dict], *, cont: str = "N", nk: str = "") -> httpx.Response:
    return httpx.Response(
        200, json={"return_code": 0, "return_msg": "정상", "inds_dt_pole_qry": rows},
        headers={"cont-yn": cont, "next-key": nk},
    )


async def test_daily_parses_scaled_prices_and_filters_range() -> None:
    rows = [
        {"dt": "20260803", "open_pric": "635827", "high_pric": "639300",
         "low_pric": "622329", "cur_prc": "624191", "trde_qty": "261857"},
        {"dt": "20260731", "open_pric": "565779", "high_pric": "663077",
         "low_pric": "562976", "cur_prc": "659545", "trde_qty": "434445"},
        {"dt": "20260601", "open_pric": "1", "high_pric": "1",
         "low_pric": "1", "cur_prc": "1", "trde_qty": "1"},  # 범위 밖
    ]
    c = _client(lambda _r: _daily(rows))
    res = await fetch_index_daily_candles(c, KOSPI, "20260731", "20260803")
    assert [x.t_ms for x in res.candles] == sorted(x.t_ms for x in res.candles), "ASC 정렬"
    assert len(res.candles) == 2, "범위 밖 날짜는 제외"
    assert res.candles[-1].close == pytest.approx(6241.91)
    assert res.candles[-1].open == pytest.approx(6358.27)
    assert res.violations == []
    await c.aclose()


async def test_daily_stops_when_older_than_from_is_seen() -> None:
    """구조적 술어 — `from` **이전** 날짜를 봐야 `from` 이 온전하다(ADR-0136 §3)."""
    pages = [
        _daily([{"dt": "20260803", "open_pric": "1", "high_pric": "1",
                 "low_pric": "1", "cur_prc": "1", "trde_qty": "0"}], cont="Y", nk="k"),
        _daily([{"dt": "20260730", "open_pric": "1", "high_pric": "1",
                 "low_pric": "1", "cur_prc": "1", "trde_qty": "0"}], cont="Y", nk="k2"),
    ]
    it = iter(pages)
    n = 0

    def _h(_r: httpx.Request) -> httpx.Response:
        nonlocal n
        n += 1
        return next(it)

    c = _client(_h)
    await fetch_index_daily_candles(c, KOSPI, "20260731", "20260803")
    assert n == 2, "from 이전(20260730)을 본 페이지에서 멈춘다"
    await c.aclose()


async def test_daily_nonpositive_close_is_dropped_with_violation() -> None:
    rows = [{"dt": "20260803", "open_pric": "100", "high_pric": "100",
             "low_pric": "100", "cur_prc": "0", "trde_qty": "0"}]
    c = _client(lambda _r: _daily(rows))
    res = await fetch_index_daily_candles(c, KOSPI, "20260803", "20260803")
    assert res.candles == []
    assert [v.reason for v in res.violations] == ["close_nonpositive"]
    await c.aclose()


async def test_daily_truncation_surfaces_out_of_range_not_silence() -> None:
    """조용한 절단 금지 — 상한에 걸리면 violation 으로 알린다."""
    def _h(_r: httpx.Request) -> httpx.Response:
        return _daily([{"dt": "20260803", "open_pric": "1", "high_pric": "1",
                        "low_pric": "1", "cur_prc": "1", "trde_qty": "0"}],
                      cont="Y", nk="k")

    c = _client(_h)
    res = await fetch_index_daily_candles(c, KOSPI, "20200101", "20260803")
    assert "out_of_range" in [v.reason for v in res.violations]
    await c.aclose()


async def test_daily_violation_reasons_stay_in_the_closed_set() -> None:
    """ADR-0129 D5 — 브로커 전용 reason 을 만들면 응답의 중립성이 깨진다."""
    allowed = {"close_nonpositive", "ohlc_inconsistent", "malformed_row", "out_of_range"}
    rows = [
        {"dt": "20260803", "open_pric": "x", "high_pric": "1",
         "low_pric": "1", "cur_prc": "1", "trde_qty": "0"},
    ]
    c = _client(lambda _r: _daily(rows))
    res = await fetch_index_daily_candles(c, KOSPI, "20260803", "20260803")
    assert res.violations, "파싱 실패는 violation 으로 남아야 한다"
    assert {v.reason for v in res.violations} <= allowed
    await c.aclose()
