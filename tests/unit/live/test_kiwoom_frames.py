"""kiwoom_frames 파서 골든 테스트 — fixture는 실계좌 실측 payload(2026-07-16).

합성이 아니라 실제 수신 프레임이라 "파서와 같은 상수로 생성한 동어반복"(ws_frames
테스트의 자인된 약점)이 아니다. 포트 계약(KIS ws_frames와 payload byte 동일)을
parity 테스트로 고정한다.
"""
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.live.kiwoom_frames import parse_real_message, parse_real_row
from hoga.live.snapshot import SnapshotKind

DATE = "20260716"

# 포트 계약(구 KIS ws_frames 파서 출력 — 삭제 후 하드코딩). ws_frames의 _parse_orderbook /
# _parse_trades가 만들던 payload 키 집합·중첩 구조. 값은 무관(키 셋만 대조).
_KIS_OB_PAYLOAD_KEYS = {"code", "t_ms", "asks", "bids", "total_ask_qty", "total_bid_qty"}
_KIS_LEVEL_KEYS = {"price", "qty"}
_KIS_TRADE_RECORD_KEYS = {"t_ms", "price", "qty", "side", "side_source"}
_KIS_TRADE_PAYLOAD_KEYS = {"trades"}
# 키움만 주는 additive 확장(계약 개정 2026-07-20 — kiwoom_frames 헤더 참조).
# 여기 없는 키가 payload 에 생기면 parity 테스트가 실패한다 = 계약 변경은 의도적으로만.
_KIWOOM_TRADE_EXTRA_KEYS = {"prev_close", "day_open", "day_high", "day_low"}

# 실측 0D(주식호가잔량, 000020) — 10호가 전 단계 채움, KRX 장중.
REAL_0D_KRX = {
    "type": "0D", "name": "주식호가잔량", "item": "000020",
    "values": {
        "21": "135622",
        "41": "+6500", "42": "+6510", "43": "+6520", "44": "+6530", "45": "+6540",
        "46": "+6550", "47": "+6560", "48": "+6570", "49": "+6580", "50": "+6590",
        "51": "+6490", "52": "+6480", "53": "+6470", "54": "+6460", "55": "+6440",
        "56": "+6410", "57": "+6400", "58": "+6390", "59": "+6380", "60": "+6370",
        "61": "20", "62": "244", "63": "72", "64": "352", "65": "47",
        "66": "108", "67": "729", "68": "718", "69": "333", "70": "1720",
        "71": "2", "72": "714", "73": "47", "74": "1887", "75": "30",
        "76": "742", "77": "4977", "78": "16855", "79": "1361", "80": "132",
        "121": "4343", "125": "26747",
    },
}

# 실측 0B(주식체결, 000810) — 매수 체결(FID 15 "+3"), 현재가 부호=등락방향.
REAL_0B = {
    "type": "0B", "name": "주식체결", "item": "000810",
    "values": {"20": "135622", "10": "+686000", "11": "+25000", "13": "98232", "15": "+3"},
}

# 실측 0D NXT 애프터마켓(005380_NX) — 3호가만 채우고 4~10단계는 "-0", venue=NXT.
REAL_0D_NXT_AFTER = {
    "type": "0D", "name": "주식호가잔량", "item": "005380_NX",
    "values": {
        "21": "153305",
        "41": "-425000", "42": "-425500", "43": "-426000",
        "44": "-0", "45": "-0", "46": "-0", "47": "-0", "48": "-0", "49": "-0", "50": "-0",
        "51": "-424500", "52": "-424000", "53": "-423500",
        "54": "-0", "55": "-0", "56": "-0", "57": "-0", "58": "-0", "59": "-0", "60": "-0",
        "61": "273", "62": "54", "63": "233",
        "64": "0", "65": "0", "66": "0", "67": "0", "68": "0", "69": "0", "70": "0",
        "71": "24", "72": "10", "73": "123",
        "74": "0", "75": "0", "76": "0", "77": "0", "78": "0", "79": "0", "80": "0",
        "121": "560", "125": "157",
    },
}


def test_orderbook_krx_full_depth():
    t = parse_real_row(REAL_0D_KRX, date=DATE, now_ms=0)
    assert t is not None
    assert t.code == "000020"
    assert t.kind is SnapshotKind.OB
    assert t.venue == "KRX"
    assert t.t_ms == hhmmssms_to_unix_ms(DATE, 135622000)
    # 매도호가1(best) = 6500, 등락부호 strip.
    assert t.payload["asks"][0] == {"price": 6500, "qty": 20}
    assert t.payload["asks"][9] == {"price": 6590, "qty": 1720}
    assert t.payload["bids"][0] == {"price": 6490, "qty": 2}
    assert t.payload["bids"][9] == {"price": 6370, "qty": 132}
    assert t.payload["total_ask_qty"] == 4343
    assert t.payload["total_bid_qty"] == 26747


def test_trade_side_from_qty_sign():
    t = parse_real_row(REAL_0B, date=DATE, now_ms=0)
    assert t is not None
    assert t.code == "000810"
    assert t.kind is SnapshotKind.TRADE
    trade = t.payload["trades"][0]
    assert trade["price"] == 686000  # 부호=등락방향, abs
    assert trade["qty"] == 3
    assert trade["side"] == 1  # FID 15 "+3" → 매수
    assert trade["side_source"] == "kiwoom_ws"
    assert trade["t_ms"] == hhmmssms_to_unix_ms(DATE, 135622000)


def test_trade_sell_side():
    row = {**REAL_0B, "values": {**REAL_0B["values"], "15": "-7"}}
    t = parse_real_row(row, date=DATE, now_ms=0)
    assert t is not None
    trade = t.payload["trades"][0]
    assert trade["qty"] == 7
    assert trade["side"] == -1  # 매도


def test_orderbook_nxt_venue_and_empty_levels():
    t = parse_real_row(REAL_0D_NXT_AFTER, date=DATE, now_ms=0)
    assert t is not None
    assert t.code == "005380"  # _NX 접미 분리
    assert t.venue == "NXT"
    # 애프터마켓 단일가 — 3호가만, 4~10단계는 "-0" → {price:0, qty:0}.
    assert t.payload["asks"][0] == {"price": 425000, "qty": 273}
    assert t.payload["asks"][3] == {"price": 0, "qty": 0}
    assert t.payload["bids"][2] == {"price": 423500, "qty": 123}
    assert t.payload["bids"][9] == {"price": 0, "qty": 0}


def test_parse_real_message_wraps_data_list():
    msg = {"trnm": "REAL", "data": [REAL_0D_KRX, REAL_0B]}
    ticks = parse_real_message(msg, date=DATE, now_ms=0)
    assert [t.kind for t in ticks] == [SnapshotKind.OB, SnapshotKind.TRADE]


def test_unsupported_type_and_malformed_dropped():
    assert parse_real_row({"type": "0J", "item": "001", "values": {}}, date=DATE, now_ms=0) is None
    assert parse_real_row({"type": "0D", "item": "x"}, date=DATE, now_ms=0) is None  # values 부재
    assert parse_real_message({"trnm": "REAL"}, date=DATE, now_ms=0) == []


# ── 포트 계약: 구 KIS ws_frames 파서 payload 구조와 byte 동일(하드코딩 기대값) ──


def test_orderbook_payload_keys_match_kis():
    """키움 OB payload의 키 집합·중첩 구조가 (삭제된) KIS 파서와 동일 — 포트 계약."""
    kiwoom = parse_real_row(REAL_0D_KRX, date=DATE, now_ms=0)
    assert set(kiwoom.payload) == _KIS_OB_PAYLOAD_KEYS
    assert set(kiwoom.payload["asks"][0]) == _KIS_LEVEL_KEYS
    assert set(kiwoom.payload["bids"][0]) == _KIS_LEVEL_KEYS
    assert len(kiwoom.payload["asks"]) == 10
    assert len(kiwoom.payload["bids"]) == 10
    # 실측 fixture의 best ask price(000020 10호가 전단계 채움).
    assert kiwoom.payload["asks"][0]["price"] == 6500


def test_trade_payload_keys_match_kis():
    """KIS 계약 키는 전부 보존되고, 초과분은 허용된 additive 확장뿐이어야 한다.

    exact-equality 를 쓰지 않는 건 계약이 느슨해져서가 아니라, 확장을 **허용목록으로
    고정**하기 때문이다 — 목록 밖 키가 생기면 여기서 실패한다.
    """
    kiwoom = parse_real_row(REAL_0B, date=DATE, now_ms=0)
    assert _KIS_TRADE_PAYLOAD_KEYS <= set(kiwoom.payload)
    assert set(kiwoom.payload) - _KIS_TRADE_PAYLOAD_KEYS <= _KIWOOM_TRADE_EXTRA_KEYS
    # 체결 레코드 자체는 KIS 와 완전 동일 — 확장은 payload 최상위에만 붙인다.
    assert set(kiwoom.payload["trades"][0]) == _KIS_TRADE_RECORD_KEYS


# ── FID 11(전일대비) → 전일종가 유도 ──


def test_trade_carries_prev_close_derived_from_delta():
    """전일종가 = abs(FID10) - FID11. 실측 fixture: 686000 - 25000 = 661000."""
    t = parse_real_row(REAL_0B, date=DATE, now_ms=0)
    assert t is not None
    assert t.payload["prev_close"] == 661000
    # 등락률이 이 기준가로 복원되는지 — 키움 FID12 와 같은 값이어야 한다.
    price = t.payload["trades"][0]["price"]
    assert round((price / t.payload["prev_close"] - 1) * 100, 2) == 3.78


def test_trade_prev_close_absent_when_delta_missing():
    """FID 11 부재(합성·구버전 프레임)면 키 자체를 싣지 않는다 — 소비자는 optional."""
    values = {k: v for k, v in REAL_0B["values"].items() if k != "11"}
    t = parse_real_row({**REAL_0B, "values": values}, date=DATE, now_ms=0)
    assert t is not None
    assert "prev_close" not in t.payload
    assert t.payload["trades"][0]["price"] == 686000  # 체결 자체는 살아남는다


def test_trade_survives_malformed_delta():
    """FID 11 이 불량이어도 프레임을 버리지 않는다 — 선택 필드가 필수 경로를 죽이면 안 된다."""
    t = parse_real_row(
        {**REAL_0B, "values": {**REAL_0B["values"], "11": "??"}}, date=DATE, now_ms=0
    )
    assert t is not None
    assert "prev_close" not in t.payload
    assert t.payload["trades"][0]["qty"] == 3


def test_trade_carries_day_ohlc():
    """당일 시가/고가/저가(FID 16/17/18) — 부호는 등락방향이라 abs 만 취한다.

    실측 000660 프레임의 값 그대로: 시가 1,745,000 / 고가 1,892,000 / 저가 1,735,000.
    """
    values = {**REAL_0B["values"], "16": "-1745000", "17": "+1892000", "18": "-1735000"}
    t = parse_real_row({**REAL_0B, "values": values}, date=DATE, now_ms=0)
    assert t is not None
    assert t.payload["day_open"] == 1745000
    assert t.payload["day_high"] == 1892000
    assert t.payload["day_low"] == 1735000


def test_trade_omits_day_ohlc_when_absent_or_zero():
    """미수신(키 부재)·0 은 싣지 않는다 — 소비자가 폴링값으로 폴백해야 한다."""
    # REAL_0B fixture 에는 16/17/18 이 없다(애프터마켓 채록).
    t = parse_real_row(REAL_0B, date=DATE, now_ms=0)
    assert t is not None
    assert "day_open" not in t.payload and "day_high" not in t.payload
    # 0 으로 오는 경우도 동일.
    zero = {**REAL_0B["values"], "16": "0", "17": "-0", "18": "+0"}
    t2 = parse_real_row({**REAL_0B, "values": zero}, date=DATE, now_ms=0)
    assert t2 is not None
    assert "day_open" not in t2.payload
    assert "day_low" not in t2.payload


def test_trade_prev_close_rejects_nonpositive():
    """전일종가는 등락률 분모라 0 이하면 싣지 않는다(0 나눗셈·부호 반전 방지)."""
    t = parse_real_row(
        {**REAL_0B, "values": {**REAL_0B["values"], "11": "+686000"}}, date=DATE, now_ms=0
    )
    assert t is not None
    assert "prev_close" not in t.payload
