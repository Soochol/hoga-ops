"""ws_frames 파서 단위 테스트 — 합성 프레임은 공식 샘플 인덱스 기준."""
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import parse_message


def _asp_frame(code: str = "005930", hhmmss: str = "093015") -> str:
    f = ["0"] * 59
    f[0], f[1], f[2] = code, hhmmss, "0"
    for i, idx in enumerate(range(3, 13)):
        f[idx] = str(75000 + i * 10)  # 매도호가 1~10
    for i, idx in enumerate(range(13, 23)):
        f[idx] = str(74990 - i * 10)  # 매수호가 1~10
    for i, idx in enumerate(range(23, 33)):
        f[idx] = str(100 + i)  # 매도잔량
    for i, idx in enumerate(range(33, 43)):
        f[idx] = str(200 + i)  # 매수잔량
    f[43], f[44] = "1500", "2500"
    return "0|H0STASP0|001|" + "^".join(f)


def _cnt_frame(n: int = 1) -> str:
    recs = []
    for k in range(n):
        f = ["0"] * 45
        f[0], f[1], f[2] = "005930", "093015", "75000"
        f[12] = str(5 + k)  # 체결거래량
        f[21] = "1" if k % 2 == 0 else "5"  # 매수/매도 교대
        recs.append("^".join(f))
    return f"0|H0STCNT0|{n:03d}|" + "^".join(recs)


def _mbc_frame() -> str:
    f = ["0"] * 80
    f[0] = "005930"
    for i, idx in enumerate(range(1, 6)):
        f[idx] = f"매도사{i + 1}"
    for i, idx in enumerate(range(6, 11)):
        f[idx] = f"매수사{i + 1}"
    for i, idx in enumerate(range(11, 16)):
        f[idx] = str(1000 + i)
    for i, idx in enumerate(range(16, 21)):
        f[idx] = str(2000 + i)
    return "0|H0STMBC0|001|" + "^".join(f)


def test_parse_orderbook_frame():
    ticks = parse_message(_asp_frame(), date="20260605", now_ms=0)
    assert len(ticks) == 1
    t = ticks[0]
    assert t.code == "005930"
    assert t.kind is SnapshotKind.OB
    assert t.payload["asks"][0] == {"price": 75000, "qty": 100}
    assert t.payload["bids"][9] == {"price": 74900, "qty": 209}
    assert t.payload["total_ask_qty"] == 1500
    assert t.payload["total_bid_qty"] == 2500
    # 09:30:15 KST → t_ms 검증 (timeenc 왕복)
    assert t.t_ms == hhmmssms_to_unix_ms("20260605", 93015000)


def test_parse_trade_frame_side_mapping():
    ticks = parse_message(_cnt_frame(2), date="20260605", now_ms=0)
    assert len(ticks) == 2
    assert ticks[0].kind is SnapshotKind.TRADE
    assert ticks[0].payload["trades"][0]["side"] == 1  # 체결구분 '1' = 매수
    assert ticks[1].payload["trades"][0]["side"] == -1  # '5' = 매도
    assert ticks[0].payload["trades"][0]["qty"] == 5


def test_parse_trade_side3_is_auction_zero():
    raw = _cnt_frame(1).split("^")
    raw[21] = "3"  # 장전(단일가) → side 0
    ticks = parse_message("^".join(raw), date="20260605", now_ms=0)
    assert ticks[0].payload["trades"][0]["side"] == 0


def test_parse_member_frame_uses_now_ms():
    ticks = parse_message(_mbc_frame(), date="20260605", now_ms=1_770_000_000_000)
    t = ticks[0]
    assert t.kind is SnapshotKind.BROKER
    assert t.t_ms == 1_770_000_000_000  # MBC엔 시간 필드 없음
    assert t.payload["sell_top"][0] == {"name": "매도사1", "qty": 1000}
    assert t.payload["buy_top"][4] == {"name": "매수사5", "qty": 2004}


def test_parse_control_pingpong():
    raw = '{"header":{"tr_id":"PINGPONG","datetime":"20260605093000"}}'
    out = parse_message(raw, date="20260605", now_ms=0)
    assert out == []  # 컨트롤은 빈 리스트 — 클라이언트가 raw로 직접 echo 판단
