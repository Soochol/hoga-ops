"""0J/0U 파서 — **2026-08-07 장중 실측 프레임**을 픽스처로 쓴다.

합성값을 쓰면 이 파일이 지키려는 함정이 통째로 사라진다: 실측이 하락장이라 레벨에
붙은 `-` 접두가 픽스처에 들어 있고, 그게 이 파서의 존재 이유 절반이다. `ka20003`
쪽 같은 버그는 픽스처가 상승(+) 케이스만 담고 있어서 오래 잠복했다.
"""
from __future__ import annotations

from hoga.live.kiwoom_sector_frames import merge_tick, parse_sector_row

# 실측 원본(KOSDAQ 150, 0J) — 하락 중이라 10·18 에 `-`, 16·17 에 `+` 가 붙어 있다.
REAL_0J_150 = {
    "type": "0J", "item": "150",
    "values": {"20": "105602", "10": "-1327.93", "11": "-43.69", "12": "-3.19",
               "15": "0", "13": "28264", "14": "1272796", "16": "+1383.62",
               "17": "+1402.03", "18": "-1317.33", "25": "5", "26": "-31783"},
}

# 실측 원본(종합 KOSPI, 0U) — 등락종목수가 여기 있다.
REAL_0U_001 = {
    "type": "0U", "item": "001",
    "values": {"20": "105700", "252": "359", "251": "3", "253": "39", "255": "510",
               "254": "0", "13": "161020", "14": "12180438", "10": "-6200.89",
               "11": "-95.49", "12": "-1.52", "256": "908", "257": "96.29", "25": "5"},
}


def test_index_level_strips_direction_sign_but_change_keeps_it():
    """레벨은 부호를 벗기고 등락은 유지 — 섞으면 하락장 전 지수가 음수가 된다."""
    t = parse_sector_row(REAL_0J_150)
    assert t is not None
    assert t.value == 1327.93       # `-1327.93` 의 `-` 는 방향이지 값이 아니다
    assert t.open == 1383.62
    assert t.high == 1402.03
    assert t.low == 1317.33          # `-1317.33` → 저가도 레벨이다
    assert t.change == -43.69        # 여기 `-` 는 값이다
    assert t.change_pct == -3.19


def test_trade_value_is_normalised_to_eok_like_ka20003():
    """단위를 ka20003 축(억원)에 맞춘다 — 어긋나면 폴링↔WS 교대 시 100배 점프."""
    t = parse_sector_row(REAL_0U_001)
    assert t is not None
    assert t.trade_value_eok == 121804.38   # 12,180,438 백만원 = 12.18조
    assert t.cum_volume == 161020


def test_updown_counts_come_from_0u():
    t = parse_sector_row(REAL_0U_001)
    assert t is not None
    assert (t.rising, t.falling, t.flat) == (359, 510, 39)
    assert (t.upper, t.lower) == (3, 0)
    assert t.traded_count == 908
    assert t.traded_pct == 96.29


def test_each_type_leaves_the_other_axis_none():
    """준 것만 채운다 — 병합하는 쪽이 "말 안 한 것" 과 "0" 을 구별해야 한다."""
    j = parse_sector_row(REAL_0J_150)
    u = parse_sector_row(REAL_0U_001)
    assert j is not None and u is not None
    assert j.rising is None and j.upper is None      # 0J 엔 등락종목수가 없다
    assert u.open is None and u.high is None          # 0U 엔 시고저가 없다


def test_merge_does_not_let_one_axis_erase_the_other():
    """0U 틱이 0J 의 시고저를 지우면 안 된다 — 단순 교체였다면 지운다."""
    snap = merge_tick(None, parse_sector_row(REAL_0J_150))
    assert snap["open"] == 1383.62

    same_code_updown = {**REAL_0U_001, "item": "150"}
    snap = merge_tick(snap, parse_sector_row(same_code_updown))
    assert snap["open"] == 1383.62        # 유지돼야 한다
    assert snap["rising"] == 359          # 새 축은 얹힌다
    assert snap["last_0J_hhmmss"] == "105602"
    assert snap["last_0U_hhmmss"] == "105700"


def test_non_sector_rows_and_empty_codes_are_ignored():
    assert parse_sector_row({"type": "0B", "item": "005930", "values": {}}) is None
    assert parse_sector_row({"type": "0J", "item": "", "values": {}}) is None


def test_missing_fields_are_none_not_zero():
    """빈 문자열·부호 단독을 0 으로 읽으면 "지수 0" 이라는 거짓말이 된다."""
    t = parse_sector_row({"type": "0J", "item": "001",
                          "values": {"20": "090000", "10": "", "11": "+", "12": "-"}})
    assert t is not None
    assert t.value is None and t.change is None and t.change_pct is None
