"""시장 종합 파서 — 실측(#1095·#1096)이 드러낸 함정을 테스트로 못박는다.

값은 전부 **2026-08-05 장중 실응답**에서 가져왔다. 합성값을 쓰면 스케일 함정이
테스트에서 사라진다 — 틀린 파서도 합성값에서는 통과하기 때문이다.
"""
from __future__ import annotations

from hoga.live.market_overview import (
    MAX_BREADTH_PAGES,
    count_rows,
    decimal_price,
    index_level,
    parse_index_sectors,
    parse_index_trade_value,
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


def test_double_minus_is_a_negative_number_not_garbage():
    """ka90005 는 음수를 마이너스 **두 개**로 준다 — 예전엔 통째로 None 이 됐다.

    2026-08-10 장중 실측(코스피 100행 전부 이 표기). 값이 사라지면 화면에서 비차익·
    전체 선이 빠지고 합계가 '—' 가 된다. 양수는 부호가 하나뿐이라 살아남아서,
    **순매도인 날에만** 증상이 나온다.
    """
    assert signed_int("--528475") == -528475
    assert signed_int("--502841") == -502841
    assert decimal_price("--1.5") == -1.5
    # 부호가 하나인 기존 표기는 그대로여야 한다(ka10051 등 다른 TR).
    assert signed_int("-8787") == -8787


def test_double_minus_row_satisfies_the_arithmetic_identity():
    """`차익 + 비차익 == 전체` — 이 검산이 `--` 를 음수로 읽는 근거다.

    2026-08-10 10:36:13 코스피 실응답 행. 파서가 부호를 잘못 접으면 이 항등식이
    깨지므로, 표기 해석이 바뀌면 여기서 잡힌다.

    ⚠ **항등식을 전 행에 걸면 안 된다.** 벤더의 `all_netprps` 는 자체 반올림이라
    원값(백만원) 기준으로 ±1 어긋나는 행이 있다 — 같은 응답 100행 실측에서 79행이
    정확히 0, 13행이 +1, 8행이 -1 이었다. 여기 쓴 행은 정확히 맞는 표본이고,
    부호를 틀리게 읽으면 오차가 백만원이 아니라 자릿수 단위로 벌어지므로 이 한 행
    만으로도 판별력이 있다.
    """
    row = {
        "cntr_tm": "103613",
        "dfrt_trde_netprps": "+25634",
        "ndiffpro_trde_netprps": "--528475",
        "all_netprps": "--502841",
        "kospi200": "+97539",
        "basis": "3.11",
    }
    got = parse_program_trend([row], kospi200_scaled=True)[0]
    assert got["arb_net_eok"] is not None
    assert got["non_arb_net_eok"] is not None
    assert got["total_net_eok"] is not None
    assert got["arb_net_eok"] + got["non_arb_net_eok"] == got["total_net_eok"]
    assert got["non_arb_net_eok"] < 0


def test_mixed_signs_are_refused_rather_than_guessed():
    """`'+-5'` 는 벤더에서 관측된 적이 없다 — 추측해서 통과시키지 않는다.

    조용히 틀린 값보다 빈 값이 낫다(ADR-0021). 이 표기가 실제로 오기 시작하면
    테스트가 먼저 깨지는 게 아니라 **화면이 비므로**, 그때 실측으로 의미를 정한다.
    """
    assert signed_int("+-5") is None
    assert signed_int("-+5") is None
    assert decimal_price("+-1.5") is None


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


def test_falling_index_level_is_not_negative():
    """지수 **레벨**은 부호를 벗긴다 — 등락률과 달리 접두 부호는 값이 아니라 방향이다.

    이 가드가 없어서 하락 중인 지수·업종의 값이 통째로 음수로 나갔다(2026-08-07 실측:
    코스닥 종합 -796.27 · 업종 32개 음수). 기존 픽스처가 **상승(+) 케이스만**
    담고 있어 파서가 부호를 그대로 흘리는 것을 아무도 못 봤다.
    """
    rows = [
        {"stk_cd": "101", "stk_nm": "종합(KOSDAQ)", "cur_prc": "-796.27", "flu_rt": "-0.67"},
        {"stk_cd": "011", "stk_nm": "금속", "cur_prc": "-6655.93", "flu_rt": "-1.55"},
        {"stk_cd": "603", "stk_nm": "변동성지수", "cur_prc": "-75.97", "flu_rt": "-1.56"},
    ]
    parsed = parse_index_sectors(rows)
    assert [b.value for b in parsed] == [796.27, 6655.93, 75.97]
    # 등락률은 부호가 곧 값이다 — 같이 벗기면 하락이 상승으로 뒤집힌다.
    assert [b.change_pct for b in parsed] == [-0.67, -1.55, -1.56]


def test_index_level_helper_strips_sign_but_keeps_none():
    assert index_level("-796.27") == 796.27
    assert index_level("+6613.59") == 6613.59
    assert index_level("") is None


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
    # 금액은 백만원 → 억원 정규화 + 필드명에 단위(2026-08-05 실측: 함의 주가 검증).
    assert a["arb_net_eok"] == 208.85
    assert a["non_arb_net_eok"] == 3247.18
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
    inst = parse_streaks(rows, actor="기관", direction="buy")
    frgn = parse_streaks(rows, actor="외국인", direction="buy")
    assert len(inst) == 1
    assert inst[0]["code"] == "035420"  # `_AL` venue 접미 제거
    assert inst[0]["streak_days"] == 1
    # 백만원 → 억원: 97,544백만 = 975.44억 (÷수량 428,739주 = 227,514원/주 ≈ 실주가)
    assert inst[0]["streak_net_eok"] == 975.44
    assert inst[0]["streak_net_qty_shares"] == 428739
    assert inst[0]["period_change_pct"] == 10.84
    # 연속일수가 없는 주체는 그 카드에서 빠진다
    assert frgn == []


def test_negative_streaks_are_net_selling_and_excluded():
    """음수 연속일수 = 연속 순매도 — "순매수 상위" 카드에 섞이면 안 된다.

    실화면(2026-08-05)에서 `-2일 · —` 행이 노출됐던 버그의 고정.
    """
    rows = [
        {"stk_cd": "017670_AL", "stk_nm": "SK텔레콤",
         "frgnr_cont_netprps_dys": "-1", "frgnr_cont_netprps_amt": "-2373"},
        {"stk_cd": "005930_AL", "stk_nm": "삼성전자",
         "frgnr_cont_netprps_dys": "+7", "frgnr_cont_netprps_amt": "+1241000"},
    ]
    got = parse_streaks(rows, actor="외국인", direction="buy")
    assert [r["name"] for r in got] == ["삼성전자"]
    assert got[0]["streak_net_eok"] == 12410.0


def test_sell_direction_is_the_exact_mirror():
    """순매도 방향은 같은 행에서 **반대 부호만** 고른다.

    벤더가 `netslmt_tp` 로 종목을 이미 갈라 주지만 그것으로 충분하지 않다 —
    두 주체 값이 한 행에 같이 오므로 순매도 응답에도 사들인 주체가 섞인다
    (2026-08-10 실측: 순매도 100행 중 외국인 양수 35). 필터를 빼면 "순매도 상위" 에
    +7일 행이 올라온다.
    """
    rows = [
        {"stk_cd": "017670_AL", "stk_nm": "SK텔레콤",
         "frgnr_cont_netprps_dys": "-1", "frgnr_cont_netprps_amt": "-2373"},
        {"stk_cd": "005930_AL", "stk_nm": "삼성전자",
         "frgnr_cont_netprps_dys": "+7", "frgnr_cont_netprps_amt": "+1241000"},
    ]
    got = parse_streaks(rows, actor="외국인", direction="sell")
    assert [r["name"] for r in got] == ["SK텔레콤"]
    # 부호는 보존한다 — 절대값으로 읽는 것은 화면의 결정이다.
    assert got[0]["streak_days"] == -1
    assert got[0]["streak_net_eok"] == -23.73


def test_sell_rows_survive_the_double_minus_notation():
    """ka10131 순매도 행의 **금액·수량은 마이너스 두 개**로 온다 — 일수는 하나뿐이다.

    2026-08-10 실측 원문(삼성전자): `dys='-2'` · `amt='--940483'` · `qty='--4105152'`.
    `signed_int` 의 폴딩(#1247)이 없으면 이 카드는 **일수만 나오고 금액·수량이 통째로
    `None`** 이 된다 — 순매수 방향은 값이 전부 양수라 이 결함이 무증상이었다.
    """
    rows = [{
        "stk_cd": "005930_AL", "stk_nm": "삼성전자", "prid_stkpc_flu_rt": "-1.24",
        "frgnr_cont_netprps_dys": "-2",
        "frgnr_cont_netprps_amt": "--940483",
        "frgnr_cont_netprps_qty": "--4105152",
    }]
    got = parse_streaks(rows, actor="외국인", direction="sell")
    assert len(got) == 1
    assert got[0]["streak_net_eok"] == -9404.83
    assert got[0]["streak_net_qty_shares"] == -4105152


def test_zero_streak_belongs_to_neither_direction():
    """연속이 끊긴 주체(0일)는 양쪽 카드 어디에도 실리지 않는다."""
    rows = [{"stk_cd": "005930_AL", "stk_nm": "삼성전자",
             "frgnr_cont_netprps_dys": "0", "frgnr_cont_netprps_amt": "0"}]
    assert parse_streaks(rows, actor="외국인", direction="buy") == []
    assert parse_streaks(rows, actor="외국인", direction="sell") == []


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


# ── 급등·급락 임계 (#1103 후속) ──────────────────────────────────────────

def _jump(rate: str) -> dict:
    return {"stk_cd": "x", "jmp_rt": rate}


def test_threshold_filters_the_vendor_noise_floor():
    """벤더 하한이 1% 라 그대로 세면 시장의 37% 가 '급등' 이 된다 — 임계가 의미를 만든다."""
    from hoga.live.market_overview import JUMP_RATE_THRESHOLD_PCT, count_above_threshold

    rows = [_jump("+9.36"), _jump("+3.00"), _jump("+2.99"), _jump("+1.01")]
    assert JUMP_RATE_THRESHOLD_PCT == 3.0
    assert count_above_threshold(rows) == 2  # 3.00 은 포함, 2.99 는 제외


def test_threshold_uses_absolute_value_so_plunge_counts_too():
    """급락은 음수로 온다 — 부호는 flu_tp 가 이미 갈랐다."""
    from hoga.live.market_overview import count_above_threshold

    assert count_above_threshold([_jump("-4.42"), _jump("-3.60"), _jump("-0.62")]) == 2


def test_early_stop_when_the_page_tail_falls_below_threshold():
    """응답이 내림차순이라 꼬리가 임계 아래면 다음 페이지는 볼 필요가 없다."""
    from hoga.live.market_overview import below_threshold

    assert below_threshold([_jump("+9.36"), _jump("+1.01")]) is True   # 꼬리 1.01 < 3
    assert below_threshold([_jump("+9.36"), _jump("+3.50")]) is False  # 꼬리 3.50 ≥ 3 → 더 본다
    assert below_threshold([]) is True                                  # 빈 페이지면 끝


def test_unparseable_rate_does_not_stop_the_walk():
    """값을 못 읽으면 조기 종료 판단을 하지 않는다 — 과소 집계보다 한 페이지 더가 낫다."""
    from hoga.live.market_overview import below_threshold, count_above_threshold

    assert below_threshold([_jump("+9.36"), {"stk_cd": "x"}]) is False
    assert count_above_threshold([{"stk_cd": "x"}]) == 0


def test_kosdaq_daily_index_columns_are_not_trusted():
    """일별 축 + 코스닥의 kospi200·basis 는 실측상 틀린 값이다 — 흘리지 않는다.

    근거(2026-08-05): 과거일 값이 코스피 응답과 **완전히 동일**하고(08/04 1000.03 ·
    08/03 986.72) basis 가 345·275 로 불가능한 크기였다. 장중 축은 시장별로 옳다.
    """
    rows = [{"cntr_tm": "20260804000000", "dfrt_trde_netprps": "+100",
             "ndiffpro_trde_netprps": "+200", "all_netprps": "+300",
             "kospi200": "+1000.03", "basis": "345.27"}]

    kept = parse_program_trend(rows, kospi200_scaled=False)[0]
    dropped = parse_program_trend(rows, kospi200_scaled=False, trust_index_columns=False)[0]

    # 순매수 3열은 어느 쪽이든 살아 있다 — 막는 것은 지수·베이시스뿐이다.
    assert kept["arb_net_eok"] == dropped["arb_net_eok"] == 1.0
    assert kept["total_net_eok"] == dropped["total_net_eok"] == 3.0
    assert kept["kospi200"] == 1000.03 and kept["basis"] == 345.27
    assert dropped["kospi200"] is None and dropped["basis"] is None


def test_index_investor_net_result_declares_amt_eok_unit():
    """#1119: 지수 경로는 금액(억원)을 담는다 — 응답이 스스로 말해야 한다."""
    from hoga.live.live_index_investor_net import LiveIndexInvestorNetFetcher

    got = LiveIndexInvestorNetFetcher._result(
        type("I", (), {"id": "KOSPI"})(), "20260801", "20260805", points=[], warnings=[],
    )
    assert got["unit"] == "amt_eok"


def test_sector_investor_rows_use_ka10051_scale_not_ka20003():
    """같은 이름의 필드가 TR 마다 100배 다르다 — 스케일을 섞으면 지수가 77,903 이 된다.

    실측(2026-08-07 장중 저장 표본): 코스닥 종합의 `cur_prc="-77903"` 는 779.03 이고
    `flu_rt="-282"` 는 -2.82% 다. 순매수 금액은 억원 정수라 변환이 없다 —
    **한 응답 안에서 필드마다 규칙이 갈린다.**
    """
    from hoga.live.market_overview import parse_sector_investor_rows

    rows = [
        {"inds_cd": "103_AL", "inds_nm": "일반서비스", "cur_prc": "-83812", "flu_rt": "-220",
         "ind_netprps": "+249", "frgnr_netprps": "-133", "orgn_netprps": "-128"},
        {"inds_cd": "101_AL", "inds_nm": "종합(KOSDAQ)", "cur_prc": "-77903", "flu_rt": "-282",
         "ind_netprps": "+3453", "frgnr_netprps": "-2435", "orgn_netprps": "-1129"},
    ]
    got = parse_sector_investor_rows(rows)

    # 종합이 맨 앞으로 온다 — 화면이 기준선으로 쓴다.
    assert [r["code"] for r in got] == ["101", "103"]
    whole = got[0]
    assert whole["value"] == 779.03          # 부호 벗김 + ÷100
    assert whole["change_pct"] == -2.82      # ÷100, 부호 유지
    assert whole["individual"] == 3453       # 억원 정수 — 변환 없음
    assert whole["foreign"] == -2435
    assert got[1]["name"] == "일반서비스"


def test_sector_investor_rows_strip_venue_suffix():
    """`_AL` 이 붙은 채 두면 ka20003 의 업종코드(`001`)와 조인이 안 된다."""
    from hoga.live.market_overview import parse_sector_investor_rows

    got = parse_sector_investor_rows([
        {"inds_cd": "013_AL", "inds_nm": "전기/전자", "cur_prc": "+123456", "flu_rt": "+150"},
    ])
    assert got[0]["code"] == "013"
    assert got[0]["value"] == 1234.56
    assert got[0]["change_pct"] == 1.5
    # 값이 없는 주체는 None — 0 으로 채우면 "안 샀다" 가 된다.
    assert got[0]["individual"] is None


# ── ka20006 일별 거래대금 ────────────────────────────────────────────────────
#
# 행은 2026-08-10 실응답이다. 값이 실물이라 단위 함정이 테스트에 남는다 —
# `18,840,196` 백만원 = 188,401.96억 = 18.84조이고, 같은 시각 ka20003 종합 행의
# `trade_value_eok` 가 정확히 188,401.96 이었다(두 TR 이 같은 축임을 교차 증명).

_KA20006_ROWS = [
    {"dt": "20260810", "cur_prc": "629966", "trde_qty": "299377", "trde_prica": "18840196"},
    {"dt": "20260807", "cur_prc": "625877", "trde_qty": "299377", "trde_prica": "24730513"},
    {"dt": "20260806", "cur_prc": "629638", "trde_qty": "311020", "trde_prica": "26452137"},
    {"dt": "20260805", "cur_prc": "659826", "trde_qty": "305114", "trde_prica": "25657754"},
]


def test_trade_value_unit_is_mwon_to_eok():
    """`trde_prica` 는 **백만원**이다 — 억원으로 정규화한다(÷100).

    8/5 값은 `market_overview.IndexBreadth` docstring 의 ka20003 실측치와 같은
    숫자다(25,657,754 → 25.66조). 두 TR 의 축이 같다는 것이 이 계열의 전제다.
    """
    got = parse_index_trade_value(_KA20006_ROWS, days=10)
    assert {p["date"]: p["value_eok"] for p in got} == {
        "20260805": 256577.54,
        "20260806": 264521.37,
        "20260807": 247305.13,
        "20260810": 188401.96,
    }


def test_trade_value_is_returned_oldest_first():
    """벤더는 최신 우선 역순으로 준다 — 파서가 뒤집어 시간축으로 돌려준다.

    호출부가 각자 뒤집으면 소비자마다 축이 갈린다(프로그램 추이가 그랬다).
    """
    got = parse_index_trade_value(_KA20006_ROWS, days=10)
    assert [p["date"] for p in got] == ["20260805", "20260806", "20260807", "20260810"]


def test_trade_value_window_keeps_the_newest_days():
    """`days` 절단은 **뒤집은 뒤**여야 최신 N일이 남는다.

    뒤집기 전에 자르면 `[:days]` 가 벤더 역순의 앞쪽 = 최신을 집지만, 뒤집은 뒤
    `[:days]` 를 쓰면 **가장 오래된** N일이 남는다. 방향과 절단을 함께 바꾸는
    실수라 한쪽만 보면 통과한다 — 그래서 창을 좁혀 날짜 자체를 단언한다.
    """
    got = parse_index_trade_value(_KA20006_ROWS, days=2)
    assert [p["date"] for p in got] == ["20260807", "20260810"]


def test_trade_value_drops_rows_it_cannot_read_rather_than_zeroing_them():
    """금액 없음·중복 날짜·짧은 `dt` 는 **버린다**. 0 으로 채우지 않는다.

    거래대금 0 은 휴장을 뜻하는 실제 값이라, 파싱 실패를 0 으로 접으면 그날 시장이
    쉬었다는 거짓말이 된다.
    """
    rows = [
        {"dt": "20260810", "trde_prica": "18840196"},
        {"dt": "20260810", "trde_prica": "99999999"},  # 중복 — 첫 행이 이긴다
        {"dt": "20260807", "trde_prica": ""},          # 금액 없음
        {"dt": "2026080", "trde_prica": "123"},        # 짧은 dt
        {"dt": "20260806", "trde_prica": "26452137"},
    ]
    got = parse_index_trade_value(rows, days=10)
    assert [p["date"] for p in got] == ["20260806", "20260810"]
    assert all(p["value_eok"] > 0 for p in got)
    assert got[-1]["value_eok"] == 188401.96
