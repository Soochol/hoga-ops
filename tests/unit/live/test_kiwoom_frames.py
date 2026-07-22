"""kiwoom_frames 파서 골든 테스트 — fixture는 실계좌 실측 payload(2026-07-16).

합성이 아니라 실제 수신 프레임이라 "파서와 같은 상수로 생성한 동어반복"(ws_frames
테스트의 자인된 약점)이 아니다. 포트 계약(KIS ws_frames와 payload byte 동일)을
parity 테스트로 고정한다.

0F(주식당일거래원)는 2026-07-20 T2 채록 골든 파일에서 로드한다 — 57 FID 라
하드코딩 대신 파일 참조(tests/fixtures/kiwoom_t2/).
"""
import json
from pathlib import Path

from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.live.kiwoom_frames import parse_real_message, parse_real_row
from hoga.live.snapshot import SnapshotKind

_T2_GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "fixtures" / "kiwoom_t2" / "golden_frames_20260720.json"
)


def _t2_frames(typ: str) -> list[dict]:
    return [f for f in json.loads(_T2_GOLDEN.read_text()) if f.get("type") == typ]

DATE = "20260716"

# 파서의 미래-틱 가드(kiwoom_frames._MAX_FUTURE_SKEW_MS)는 0B/0D 의 date+HHMMSS 합성
# 스탬프를 도착 시각과 견준다. 골든 프레임의 HHMMSS 가 DATE 장중이므로 now_ms 도 같은
# 날 장 마감으로 둔다 — now_ms=0 이면 전 틱이 "미래"로 판정돼 드롭된다(그 동작 자체는
# test_future_tick_* 가 따로 고정한다).
NOW_MS = hhmmssms_to_unix_ms(DATE, 153000000)
T2_NOW_MS = hhmmssms_to_unix_ms("20260720", 153000000)

# 포트 계약(구 KIS ws_frames 파서 출력 — 삭제 후 하드코딩). ws_frames의 _parse_orderbook /
# _parse_trades가 만들던 payload 키 집합·중첩 구조. 값은 무관(키 셋만 대조).
_KIS_OB_PAYLOAD_KEYS = {"code", "t_ms", "asks", "bids", "total_ask_qty", "total_bid_qty"}
_KIS_LEVEL_KEYS = {"price", "qty"}
_KIS_TRADE_RECORD_KEYS = {"t_ms", "price", "qty", "side", "side_source"}
_KIS_TRADE_PAYLOAD_KEYS = {"trades"}
# 키움만 주는 additive 확장(계약 개정 2026-07-20 — kiwoom_frames 헤더 참조).
# 여기 없는 키가 payload 에 생기면 parity 테스트가 실패한다 = 계약 변경은 의도적으로만.
_KIWOOM_TRADE_EXTRA_KEYS = {
    "prev_close", "day_open", "day_high", "day_low",
    "fill_strength_pct", "vs_prev_volume_pct", "cum_volume", "vwap", "cum_value",
}

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
    t = parse_real_row(REAL_0D_KRX, date=DATE, now_ms=NOW_MS)
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
    t = parse_real_row(REAL_0B, date=DATE, now_ms=NOW_MS)
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
    t = parse_real_row(row, date=DATE, now_ms=NOW_MS)
    assert t is not None
    trade = t.payload["trades"][0]
    assert trade["qty"] == 7
    assert trade["side"] == -1  # 매도


def test_orderbook_nxt_venue_and_empty_levels():
    t = parse_real_row(REAL_0D_NXT_AFTER, date=DATE, now_ms=NOW_MS)
    assert t is not None
    assert t.code == "005380"  # _NX 접미 분리
    assert t.venue == "NXT"
    # 애프터마켓 단일가 — 3호가만, 4~10단계는 "-0" → {price:0, qty:0}.
    assert t.payload["asks"][0] == {"price": 425000, "qty": 273}
    assert t.payload["asks"][3] == {"price": 0, "qty": 0}
    assert t.payload["bids"][2] == {"price": 423500, "qty": 123}
    assert t.payload["bids"][9] == {"price": 0, "qty": 0}


def test_orderbook_expected_fill_present_in_auction():
    # 동시호가 프레임 — FID 23(예상체결가, 등락부호)/24(예상체결량)이 채워진다.
    row = {**REAL_0D_KRX, "values": {**REAL_0D_KRX["values"], "23": "+6480", "24": "12345"}}
    t = parse_real_row(row, date=DATE, now_ms=NOW_MS)
    assert t is not None
    assert t.payload["expected_price"] == 6480  # 부호=등락방향, abs
    assert t.payload["expected_qty"] == 12345


def test_orderbook_expected_fill_absent_when_zero():
    # 연속거래(평시) — 23/24 미채움/0 이면 키를 싣지 않는다(요약·OHLC 규약).
    # REAL_0D_KRX 자체에 23/24 부재 → 없어야 정상.
    t = parse_real_row(REAL_0D_KRX, date=DATE, now_ms=NOW_MS)
    assert t is not None
    assert "expected_price" not in t.payload
    assert "expected_qty" not in t.payload
    # 한쪽만 0 인 반쪽 프레임도 둘 다 제외.
    half = {**REAL_0D_KRX, "values": {**REAL_0D_KRX["values"], "23": "+6480", "24": "0"}}
    ht = parse_real_row(half, date=DATE, now_ms=NOW_MS)
    assert ht is not None
    assert "expected_price" not in ht.payload
    assert "expected_qty" not in ht.payload


def test_parse_real_message_wraps_data_list():
    msg = {"trnm": "REAL", "data": [REAL_0D_KRX, REAL_0B]}
    ticks = parse_real_message(msg, date=DATE, now_ms=NOW_MS)
    assert [t.kind for t in ticks] == [SnapshotKind.OB, SnapshotKind.TRADE]


def test_unsupported_type_and_malformed_dropped():
    assert parse_real_row({"type": "0J", "item": "001", "values": {}}, date=DATE, now_ms=NOW_MS) is None
    assert parse_real_row({"type": "0D", "item": "x"}, date=DATE, now_ms=NOW_MS) is None  # values 부재
    assert parse_real_message({"trnm": "REAL"}, date=DATE, now_ms=NOW_MS) == []


# ── 포트 계약: 구 KIS ws_frames 파서 payload 구조와 byte 동일(하드코딩 기대값) ──


def test_orderbook_payload_keys_match_kis():
    """키움 OB payload의 키 집합·중첩 구조가 (삭제된) KIS 파서와 동일 — 포트 계약."""
    kiwoom = parse_real_row(REAL_0D_KRX, date=DATE, now_ms=NOW_MS)
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
    kiwoom = parse_real_row(REAL_0B, date=DATE, now_ms=NOW_MS)
    assert _KIS_TRADE_PAYLOAD_KEYS <= set(kiwoom.payload)
    assert set(kiwoom.payload) - _KIS_TRADE_PAYLOAD_KEYS <= _KIWOOM_TRADE_EXTRA_KEYS
    # 체결 레코드 자체는 KIS 와 완전 동일 — 확장은 payload 최상위에만 붙인다.
    assert set(kiwoom.payload["trades"][0]) == _KIS_TRADE_RECORD_KEYS


# ── 0F 주식당일거래원 → BROKER (PR-F1) ──

# ADR-0111 REST 합성 경로(rest_buffer_build.brokers_to_snapshot)의 payload 키.
# phase/venue 는 stream.on_tick 이 덧붙이므로 파서 출력에는 없어야 한다.
_BROKER_PAYLOAD_KEYS = {"code", "t_ms", "sell_top", "buy_top"}
_BROKER_ENTRY_KEYS = {"name", "qty"}


def test_member_parses_t2_golden_frame():
    """실채록 0F(000660) — 5쌍 전부 파싱, 이름 내부 공백 보존, t_ms=now_ms."""
    frame = next(f for f in _t2_frames("0F") if f["item"] == "000660")
    t = parse_real_row(frame, date="20260720", now_ms=1784521985000)
    assert t is not None
    assert t.kind is SnapshotKind.BROKER
    assert t.code == "000660"
    assert t.t_ms == 1784521985000  # 시각 FID 부재 → 수신 시각
    assert t.payload["t_ms"] == 1784521985000
    assert len(t.payload["sell_top"]) == 5
    assert len(t.payload["buy_top"]) == 5
    assert t.payload["sell_top"][0] == {"name": "KB증권", "qty": 271775}
    assert t.payload["buy_top"][0] == {"name": "키움증권", "qty": 236731}
    # 내부 공백은 유의미("삼  성") — 양끝만 strip 됐는지.
    assert {"name": "삼  성", "qty": 229485} in t.payload["sell_top"]


def test_member_all_t2_frames_parse():
    """채록 0F 5건 전부 — 파싱 실패·빈 top 없이 통과해야 한다."""
    for frame in _t2_frames("0F"):
        t = parse_real_row(frame, date="20260720", now_ms=T2_NOW_MS)
        assert t is not None, frame["item"]
        assert t.payload["sell_top"] and t.payload["buy_top"]


def test_member_payload_keys_match_rest_synthesis():
    """포트 계약: REST 합성 경로와 shape-compat — 소비자(버퍼·거래원 카드) 무변경."""
    frame = _t2_frames("0F")[0]
    t = parse_real_row(frame, date="20260720", now_ms=T2_NOW_MS)
    assert t is not None
    assert set(t.payload) == _BROKER_PAYLOAD_KEYS
    for entry in [*t.payload["sell_top"], *t.payload["buy_top"]]:
        assert set(entry) == _BROKER_ENTRY_KEYS


def test_member_skips_empty_slots():
    """상위 5 미만(이름 공백/부재) 슬롯은 건너뛴다 — KIS 의 짧은 리스트와 동의미."""
    frame = _t2_frames("0F")[0]
    values = dict(frame["values"])
    values["145"] = "  "  # 매도 5위 이름 공백
    del values["144"]  # 매도 4위 이름 부재
    t = parse_real_row({**frame, "values": values}, date="20260720", now_ms=T2_NOW_MS)
    assert t is not None
    assert len(t.payload["sell_top"]) == 3
    assert len(t.payload["buy_top"]) == 5  # 매수 쪽은 영향 없음


# ── 0w 종목프로그램매매 → PROGRAM latch payload (PR-F4) ──


def test_program_parses_t2_golden_frame():
    """실채록 0w — 수급 필드 파싱 + 금액 ×1e6 정규화(백만원 → 원, F3 단위 확정)."""
    frame = next(f for f in _t2_frames("0w") if f["item"] == "000660")
    t = parse_real_row(frame, date="20260720", now_ms=1784521985000)
    assert t is not None
    assert t.kind is SnapshotKind.PROGRAM
    assert t.code == "000660"
    assert t.t_ms == 1784521985000
    v = frame["values"]
    assert t.payload["sell_qty"] == abs(int(v["202"]))
    assert t.payload["sell_amount"] == abs(int(v["204"])) * 1_000_000
    assert t.payload["buy_qty"] == abs(int(v["206"]))
    assert t.payload["buy_amount"] == abs(int(v["208"])) * 1_000_000
    # 순매수는 부호 유지 — F3 산식(210=206−202)이 파싱값에서도 성립해야 한다.
    assert t.payload["net_qty"] == t.payload["buy_qty"] - t.payload["sell_qty"]
    assert t.payload["net_amount"] == int(str(v["212"]).replace("+", "")) * 1_000_000
    assert t.payload["price"] > 0


def test_program_all_t2_frames_parse():
    for frame in _t2_frames("0w"):
        t = parse_real_row(frame, date="20260720", now_ms=T2_NOW_MS)
        assert t is not None, frame["item"]
        assert t.kind is SnapshotKind.PROGRAM


# ── FID 11(전일대비) → 전일종가 유도 ──


def test_trade_carries_prev_close_derived_from_delta():
    """전일종가 = abs(FID10) - FID11. 실측 fixture: 686000 - 25000 = 661000."""
    t = parse_real_row(REAL_0B, date=DATE, now_ms=NOW_MS)
    assert t is not None
    assert t.payload["prev_close"] == 661000
    # 등락률이 이 기준가로 복원되는지 — 키움 FID12 와 같은 값이어야 한다.
    price = t.payload["trades"][0]["price"]
    assert round((price / t.payload["prev_close"] - 1) * 100, 2) == 3.78


def test_trade_prev_close_absent_when_delta_missing():
    """FID 11 부재(합성·구버전 프레임)면 키 자체를 싣지 않는다 — 소비자는 optional."""
    values = {k: v for k, v in REAL_0B["values"].items() if k != "11"}
    t = parse_real_row({**REAL_0B, "values": values}, date=DATE, now_ms=NOW_MS)
    assert t is not None
    assert "prev_close" not in t.payload
    assert t.payload["trades"][0]["price"] == 686000  # 체결 자체는 살아남는다


def test_trade_survives_malformed_delta():
    """FID 11 이 불량이어도 프레임을 버리지 않는다 — 선택 필드가 필수 경로를 죽이면 안 된다."""
    t = parse_real_row(
        {**REAL_0B, "values": {**REAL_0B["values"], "11": "??"}}, date=DATE, now_ms=NOW_MS
    )
    assert t is not None
    assert "prev_close" not in t.payload
    assert t.payload["trades"][0]["qty"] == 3


def test_trade_carries_day_ohlc():
    """당일 시가/고가/저가(FID 16/17/18) — 부호는 등락방향이라 abs 만 취한다.

    실측 000660 프레임의 값 그대로: 시가 1,745,000 / 고가 1,892,000 / 저가 1,735,000.
    """
    values = {**REAL_0B["values"], "16": "-1745000", "17": "+1892000", "18": "-1735000"}
    t = parse_real_row({**REAL_0B, "values": values}, date=DATE, now_ms=NOW_MS)
    assert t is not None
    assert t.payload["day_open"] == 1745000
    assert t.payload["day_high"] == 1892000
    assert t.payload["day_low"] == 1735000


def test_trade_omits_day_ohlc_when_absent_or_zero():
    """미수신(키 부재)·0 은 싣지 않는다 — 소비자가 폴링값으로 폴백해야 한다."""
    # REAL_0B fixture 에는 16/17/18 이 없다(애프터마켓 채록).
    t = parse_real_row(REAL_0B, date=DATE, now_ms=NOW_MS)
    assert t is not None
    assert "day_open" not in t.payload and "day_high" not in t.payload
    # 0 으로 오는 경우도 동일.
    zero = {**REAL_0B["values"], "16": "0", "17": "-0", "18": "+0"}
    t2 = parse_real_row({**REAL_0B, "values": zero}, date=DATE, now_ms=NOW_MS)
    assert t2 is not None
    assert "day_open" not in t2.payload
    assert "day_low" not in t2.payload


def test_trade_prev_close_rejects_nonpositive():
    """전일종가는 등락률 분모라 0 이하면 싣지 않는다(0 나눗셈·부호 반전 방지)."""
    t = parse_real_row(
        {**REAL_0B, "values": {**REAL_0B["values"], "11": "+686000"}}, date=DATE, now_ms=NOW_MS
    )
    assert t is not None
    assert "prev_close" not in t.payload


# ── 종목 요약 지표(228 체결강도 · 30 어제보다 · 13 거래량 · 620 VWAP) ──
# 이 4개는 0B 43개 FID 중 그동안 버리던 값이다. 아래 테스트가 "파서와 같은 상수로
# 만든 동어반복"이 아닌 이유: 골든 프레임은 실채록이고, 파서가 뽑은 값을 **같은
# 프레임의 다른 FID로 재계산**해 대조한다(프레임이 스스로를 검증한다).


def test_trade_summary_metrics_cross_check_against_golden_frames():
    """실채록 3종목 전건에서 요약 지표가 원본 FID 산술과 일치해야 한다.

    228 = 1031/1030×100 (매수체결량 ÷ 매도체결량)
    30  = 13/(13−26)×100 (오늘 누적 ÷ 전일 전량)
    620 = 14×1e6/13      (거래대금 ÷ 거래량 — 14 가 백만원 단위임을 함께 증명)
    """
    frames = _t2_frames("0B")
    assert len(frames) == 3, "골든 0B 프레임 3종목 기대"
    for frame in frames:
        v = frame["values"]
        t = parse_real_row(frame, date=DATE, now_ms=NOW_MS)
        assert t is not None, frame["item"]

        sell = int(v["1030"])
        buy = int(v["1031"])
        assert t.payload["fill_strength_pct"] == round(buy / sell * 100, 2)

        cum = int(v["13"])
        prev_vol = cum - int(v["26"])
        assert t.payload["vs_prev_volume_pct"] == round(cum / prev_vol * 100, 2)

        assert t.payload["cum_volume"] == cum
        # 14 는 백만원. 원 단위로 환산해 거래량으로 나누면 620(당일거래평균가)이다.
        assert abs(int(v["14"]) * 1_000_000 / cum - t.payload["vwap"]) < 1
        # 누적거래대금(cum_value)은 파서가 원으로 정규화해 싣는다.
        assert t.payload["cum_value"] == int(v["14"]) * 1_000_000


def test_trade_summary_metrics_absent_when_not_received():
    """미수신 FID 는 키를 싣지 않는다 — day_ohlc 와 같은 규약."""
    t = parse_real_row(REAL_0B, date=DATE, now_ms=NOW_MS)
    assert t is not None
    for key in ("fill_strength_pct", "vs_prev_volume_pct", "vwap", "cum_value"):
        assert key not in t.payload
    # REAL_0B 에는 13(누적거래량)이 있으므로 이건 실린다.
    assert t.payload["cum_volume"] == 98232


def test_trade_ratio_takes_magnitude_and_survives_malformed():
    """비율 FID 의 부호는 증감방향이라 크기만 취하고, 불량값은 틱을 죽이지 않는다."""
    values = {**REAL_0B["values"], "30": "-43.85", "228": "100.61"}
    t = parse_real_row({**REAL_0B, "values": values}, date=DATE, now_ms=NOW_MS)
    assert t is not None
    assert t.payload["vs_prev_volume_pct"] == 43.85  # abs
    assert t.payload["fill_strength_pct"] == 100.61

    bad = {**REAL_0B["values"], "30": "abc", "228": ""}
    t2 = parse_real_row({**REAL_0B, "values": bad}, date=DATE, now_ms=NOW_MS)
    assert t2 is not None, "선택 필드 불량이 체결 틱 전체를 버리면 안 된다"
    assert "vs_prev_volume_pct" not in t2.payload
    assert t2.payload["trades"][0]["price"] == 686000


# --- 비거래일/자정넘김 스탬프 가드 -----------------------------------------
#
# 회귀 배경: 0B/0D 프레임엔 날짜가 없고 HHMMSS 만 있어 처리 시점의 date 와 합성한다.
# 자정을 넘겨 처리된 이전 세션 프레임이 "오늘 날짜 + 어제 장중 시각"으로 스탬프되면
# 미래 시각 캔들이 차트 끝에 붙고, 그 상태로 저장한 학습뷰의 to_date 가 주말이 됐다
# (실측: 009150 저장뷰 — 토 02:11 저장인데 캔들 끝이 같은 토 15:18).


def test_future_tick_dropped_when_stamp_precedes_arrival() -> None:
    """도착보다 미래인 합성 스탬프는 버린다 — 실측 사고 재현(13시간 미래)."""
    saturday = "20260627"
    arrival = hhmmssms_to_unix_ms(saturday, 21100000)  # 토 02:11 처리
    frame = {**REAL_0D_KRX, "values": {**REAL_0D_KRX["values"], "21": "151800"}}

    assert parse_real_row(frame, date=saturday, now_ms=arrival) is None


def test_future_tick_guard_allows_clock_skew() -> None:
    """스큐 여유 안(수초 미래)은 정상 틱으로 통과 — 오탐 방지."""
    t = parse_real_row(REAL_0D_KRX, date=DATE, now_ms=NOW_MS - 3_000)

    assert t is not None
    assert t.t_ms == hhmmssms_to_unix_ms(DATE, 135622000)


def test_past_tick_always_allowed() -> None:
    """장중 지연 틱(과거 방향)은 제한 없이 통과 — 가드는 미래 방향 전용."""
    t = parse_real_row(REAL_0D_KRX, date=DATE, now_ms=NOW_MS + 3_600_000)

    assert t is not None


def test_weekend_frame_dropped_entirely() -> None:
    """주말 프레임은 전량 폐기 — KRX 는 토/일 세션이 없다."""
    msg = {"trnm": "REAL", "data": [REAL_0D_KRX, REAL_0B]}

    for weekend in ("20260627", "20260628"):  # 토, 일
        arrival = hhmmssms_to_unix_ms(weekend, 153000000)
        assert parse_real_message(msg, date=weekend, now_ms=arrival) == []


def test_weekday_frame_survives_weekend_guard() -> None:
    """평일은 영향 없음 — 가드가 정상 경로를 막지 않는다."""
    msg = {"trnm": "REAL", "data": [REAL_0D_KRX]}

    assert len(parse_real_message(msg, date=DATE, now_ms=NOW_MS)) == 1
