"""kiwoom_frames 파서 골든 테스트 — fixture는 실계좌 실측 payload(2026-07-16).

합성이 아니라 실제 수신 프레임이라 "파서와 같은 상수로 생성한 동어반복"(ws_frames
테스트의 자인된 약점)이 아니다. 포트 계약(KIS ws_frames와 payload byte 동일)을
parity 테스트로 고정한다.
"""
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.live.kiwoom_frames import parse_real_message, parse_real_row
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import parse_message

DATE = "20260716"

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


# ── 포트 계약: KIS ws_frames와 payload 구조 byte 동일 ──


def _kis_asp_frame(hhmmss: str = "135622") -> str:
    f = ["0"] * 45
    f[0], f[1] = "000020", hhmmss
    for i, idx in enumerate(range(3, 13)):
        f[idx] = str(6500 + i * 10)
    for i, idx in enumerate(range(13, 23)):
        f[idx] = str(6490 - i * 10)
    for i, idx in enumerate(range(23, 33)):
        f[idx] = str(100 + i)
    for i, idx in enumerate(range(33, 43)):
        f[idx] = str(200 + i)
    f[43], f[44] = "4343", "26747"
    return "0|H0STASP0|001|" + "^".join(f)


def test_orderbook_payload_keys_match_kis():
    """키움 OB payload의 키 집합·중첩 구조가 KIS와 동일 — 포트 계약."""
    kiwoom = parse_real_row(REAL_0D_KRX, date=DATE, now_ms=0)
    kis = parse_message(_kis_asp_frame(), date=DATE, now_ms=0)[0]
    assert set(kiwoom.payload) == set(kis.payload)
    assert set(kiwoom.payload["asks"][0]) == set(kis.payload["asks"][0])
    assert len(kiwoom.payload["asks"]) == len(kis.payload["asks"]) == 10
    assert len(kiwoom.payload["bids"]) == len(kis.payload["bids"]) == 10
    # 같은 논리 데이터 → 같은 값(best ask price/qty).
    assert kiwoom.payload["asks"][0]["price"] == kis.payload["asks"][0]["price"] == 6500


def test_trade_payload_keys_match_kis():
    kiwoom = parse_real_row(REAL_0B, date=DATE, now_ms=0)
    f = ["0"] * 46
    f[0], f[1], f[2], f[12], f[21] = "000810", "135622", "686000", "3", "1"
    kis = parse_message("0|H0STCNT0|001|" + "^".join(f), date=DATE, now_ms=0)[0]
    assert set(kiwoom.payload) == set(kis.payload) == {"trades"}
    assert set(kiwoom.payload["trades"][0]) == set(kis.payload["trades"][0])
