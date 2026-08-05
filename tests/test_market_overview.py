"""시장 종합 파서 — 실측(#1095·#1096)이 드러낸 함정을 테스트로 못박는다.

값은 전부 **2026-08-05 장중 실응답**에서 가져왔다. 합성값을 쓰면 스케일 함정이
테스트에서 사라진다 — 틀린 파서도 합성값에서는 통과하기 때문이다.
"""
from __future__ import annotations

from hoga.live.market_overview import (
    MAX_BREADTH_PAGES,
    count_rows,
    decimal_price,
    parse_index_sectors,
    parse_program_trend,
    parse_streaks,
    scaled_price,
    signed_int,
)


def test_signed_int_handles_vendor_sign_strings():
    assert signed_int("+12,410") == 12410
    assert signed_int("-8787") == -8787
    assert signed_int("") is None
    assert signed_int("+") is None
    assert signed_int(None) is None


def test_scale_is_per_tr_not_global():
    """같은 지수를 TR 마다 다르게 준다 — 한 파서로 묶으면 100배 틀린다.

    ka20003 '+6613.59'(소수점) vs ka10051 '658091'(×100) — 둘 다 6,600 대여야 한다.
    """
    assert decimal_price("+6613.59") == 6613.59
    assert scaled_price("658091") == 6580.91
    # 반대로 읽으면 100배씩 어긋난다 — 그 실수를 명시적으로 고정한다.
    assert scaled_price("+6613.59") != 6613.59
    assert decimal_price("658091") == 658091.0


def test_index_breadth_from_real_row():
    """ka20003 종합(KOSPI) 실행 — 등락종목수가 여기 있다(#1100 의 근거)."""
    rows = [
        {"stk_cd": "001", "stk_nm": "종합(KOSPI)", "cur_prc": "+6613.59", "flu_rt": "+4.00",
         "rising": "739", "fall": "140", "stdns": "34", "upl": "0", "lst": "0"},
        {"stk_cd": "005", "stk_nm": "음식료/담배", "cur_prc": "+4759.72", "flu_rt": "+0.12",
         "rising": "38", "fall": "8", "stdns": "1", "upl": "0", "lst": "0"},
    ]
    parsed = parse_index_sectors(rows)
    kospi, food = parsed
    assert kospi.value == 6613.59
    assert (kospi.rising, kospi.falling, kospi.flat) == (739, 140, 34)
    # 종합지수만 등락종목수를 붙일 자격이 있다(업종은 화면에 안 쓴다)
    assert kospi.is_whole_market is True
    assert food.is_whole_market is False


def test_kosdaq_index_is_also_whole_market():
    rows = [{"stk_cd": "101", "stk_nm": "종합(KOSDAQ)", "cur_prc": "+795.84",
             "flu_rt": "+1.94", "rising": "1332", "fall": "336", "stdns": "56", "upl": "7"}]
    assert parse_index_sectors(rows)[0].is_whole_market is True


def test_kospi200_and_kosdaq150_are_not_whole_market():
    """#1100: 지수 상품엔 등락종목수를 붙이지 않는다 — 코스닥150 은 값이 있어도 마찬가지."""
    rows = [
        {"stk_cd": "150", "stk_nm": "KOSDAQ 150", "rising": "105", "fall": "42"},
        {"stk_cd": "201", "stk_nm": "코스피200"},
    ]
    assert [b.is_whole_market for b in parse_index_sectors(rows)] == [False, False]


def test_program_kospi200_scale_differs_between_the_two_trs():
    """ka90005 는 ×100 정수, ka90010 은 소수점 — 같은 필드 이름이라 더 위험하다."""
    intraday = [{"cntr_tm": "103905", "dfrt_trde_netprps": "+20885",
                 "ndiffpro_trde_netprps": "+324718", "all_netprps": "+345603",
                 "kospi200": "+103645", "basis": "2.80"}]
    daily = [{"cntr_tm": "20260805000000", "dfrt_trde_netprps": "+20885",
              "ndiffpro_trde_netprps": "+328785", "all_netprps": "349669",
              "kospi200": "+1037.95"}]

    a = parse_program_trend(intraday, kospi200_scaled=True)[0]
    b = parse_program_trend(daily, kospi200_scaled=False)[0]
    assert a["kospi200"] == 1036.45
    assert b["kospi200"] == 1037.95
    # 둘이 같은 자릿수여야 한다 — 어긋나면 파서를 잘못 붙인 것이다.
    assert abs(a["kospi200"] - b["kospi200"]) < 10
    assert a["arb_net"] == 20885
    assert a["non_arb_net"] == 324718
    assert a["basis"] == 2.80


def test_one_streak_response_fills_both_actor_cards():
    """ka10131 은 외국인·기관이 필드로 갈려 있어 **한 콜로 2카드**를 채운다(#1096)."""
    rows = [{
        "rank": "1", "stk_cd": "035420_AL", "stk_nm": "NAVER",
        "prid_stkpc_flu_rt": "+10.84",
        "orgn_cont_netprps_dys": "+1", "orgn_cont_netprps_amt": "+97544",
        "orgn_cont_netprps_qty": "+428739",
        "frgnr_cont_netprps_dys": "", "frgnr_cont_netprps_amt": "",
    }]
    inst = parse_streaks(rows, actor="기관")
    frgn = parse_streaks(rows, actor="외국인")
    assert len(inst) == 1
    assert inst[0]["code"] == "035420"  # `_AL` venue 접미 제거
    assert inst[0]["streak_days"] == 1
    assert inst[0]["streak_net_amt"] == 97544
    assert inst[0]["period_change_pct"] == 10.84
    # 연속일수가 없는 주체는 그 카드에서 빠진다
    assert frgn == []


def test_truncated_count_says_so():
    """조용한 절사 금지 — 끊었으면 응답이 그 사실을 말해야 한다(#1099)."""
    rows = [{"stk_cd": str(i)} for i in range(1000)]
    hit_cap = count_rows(rows, pages_used=MAX_BREADTH_PAGES, cont=True)
    assert hit_cap.count == 1000
    assert hit_cap.truncated is True
    assert hit_cap.as_dict() == {"count": 1000, "truncated": True}


def test_complete_count_is_not_truncated():
    rows = [{"stk_cd": str(i)} for i in range(45)]  # ka10016 실측 45행, 커서 종료
    done = count_rows(rows, pages_used=1, cont=False)
    assert done.count == 45
    assert done.truncated is False


def test_market_investor_row_picks_the_whole_market_only():
    """28~32행 중 종합 행 하나만 — 업종 행은 이 표면이 쓰지 않는다."""
    from hoga.live.market_overview import market_investor_row

    rows = [
        {"inds_cd": "002_AL", "ind_netprps": "-8891", "frgnr_netprps": "+6861", "orgn_netprps": "+1636"},
        {"inds_cd": "001_AL", "ind_netprps": "-8787", "frgnr_netprps": "+6473", "orgn_netprps": "+1893"},
    ]
    got = market_investor_row(rows)
    assert got is not None
    label, values = got
    assert label == "KOSPI"
    assert values == {"individual": -8787, "foreign": 6473, "institution": 1893}


def test_market_investor_row_is_none_without_a_whole_market_row():
    from hoga.live.market_overview import market_investor_row

    assert market_investor_row([{"inds_cd": "005_AL", "ind_netprps": "1"}]) is None


def test_kosdaq_row_is_labelled():
    from hoga.live.market_overview import market_investor_row

    got = market_investor_row([{"inds_cd": "101_AL", "ind_netprps": "+4244",
                                "frgnr_netprps": "-3355", "orgn_netprps": "-892"}])
    assert got is not None and got[0] == "KOSDAQ"


def test_expected_sample_count_is_the_denominator_of_coverage():
    """화면의 '표본 42/78' 에서 분모 — 없으면 42 가 많은지 적은지 알 수 없다."""
    from hoga.live.market_overview import expected_sample_count

    assert expected_sample_count(session_minutes=390, poll_interval_ms=60_000) == 390
    assert expected_sample_count(session_minutes=390, poll_interval_ms=300_000) == 78
