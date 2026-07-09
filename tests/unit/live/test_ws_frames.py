"""ws_frames 파서 단위 테스트 — 합성 프레임은 공식 샘플 인덱스 기준."""
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import parse_message


# 주의: 합성 fixture는 파서와 같은 상수로 생성 — 레이아웃 동어반복. 실검증은 Task 0 녹화 재생.
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
        f = ["0"] * 46
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


def test_krx_ticks_tagged_venue_krx():
    """기존 KRX TR로 온 틱은 venue='KRX'(하위호환 기본값)."""
    ob = parse_message(_asp_frame(), date="20260605", now_ms=0)
    cnt = parse_message(_cnt_frame(1), date="20260605", now_ms=0)
    mbc = parse_message(_mbc_frame(), date="20260605", now_ms=0)
    assert ob[0].venue == "KRX"
    assert cnt[0].venue == "KRX"
    assert mbc[0].venue == "KRX"


def test_parse_nxt_orderbook_reuses_krx_layout_tagged_nxt():
    """H0NXASP0(NXT 호가)는 KRX와 필드 레이아웃 동일 — 같은 파서, venue='NXT'."""
    raw = _asp_frame().replace("|H0STASP0|", "|H0NXASP0|", 1)
    ticks = parse_message(raw, date="20260605", now_ms=0)
    assert len(ticks) == 1
    t = ticks[0]
    assert t.kind is SnapshotKind.OB
    assert t.venue == "NXT"
    assert t.payload["asks"][0] == {"price": 75000, "qty": 100}
    assert t.payload["total_bid_qty"] == 2500


def test_parse_nxt_trade_reuses_krx_layout_tagged_nxt():
    """H0NXCNT0(NXT 체결)는 KRX와 동일 46필드 레이아웃 — 같은 파서, venue='NXT'."""
    raw = _cnt_frame(2).replace("|H0STCNT0|", "|H0NXCNT0|", 1)
    ticks = parse_message(raw, date="20260605", now_ms=0)
    assert len(ticks) == 2
    assert all(t.venue == "NXT" for t in ticks)
    assert ticks[0].kind is SnapshotKind.TRADE
    assert ticks[0].payload["trades"][0]["side"] == 1
    assert ticks[1].payload["trades"][0]["side"] == -1


def test_parse_control_pingpong():
    raw = '{"header":{"tr_id":"PINGPONG","datetime":"20260605093000"}}'
    out = parse_message(raw, date="20260605", now_ms=0)
    assert out == []  # 컨트롤은 빈 리스트 — 클라이언트가 raw로 직접 echo 판단


def test_parse_bad_numeric_field_no_raise():
    # OB: 총매도호가잔량이 빈 문자열 → 프레임만 버림, 예외 전파 없음
    parts = _asp_frame().split("^")
    parts[43] = ""  # ASP_TOT_ASK_Q
    assert parse_message("^".join(parts), date="20260605", now_ms=0) == []
    # TRADE: 2레코드 중 레코드0 현재가 불량 → 해당 레코드만 제외, 레코드1 생존
    parts = _cnt_frame(2).split("^")
    parts[2] = "abc"  # 레코드0 CNT_PRICE
    ticks = parse_message("^".join(parts), date="20260605", now_ms=0)
    assert len(ticks) == 1
    assert ticks[0].payload["trades"][0]["qty"] == 6  # 생존한 건 레코드1


def test_parse_trade_stride_mismatch_drops_frame():
    # 45필드×2(어긋난 stride) → 레코드 시프트 corruption 대신 프레임 전체 폐기
    recs = ["^".join(["0"] * 45) for _ in range(2)]
    raw = "0|H0STCNT0|002|" + "^".join(recs)
    assert parse_message(raw, date="20260605", now_ms=0) == []


def test_parse_short_frame_returns_empty():
    # ASP 최소 필드 미달
    assert parse_message("0|H0STASP0|001|005930^093015", date="20260605", now_ms=0) == []


def test_parse_encrypted_frame_returns_empty():
    # '1' 플래그 = 암호문 — 시세 3종은 평문이어야 함
    assert parse_message("1|H0STASP0|001|AAAA", date="20260605", now_ms=0) == []


def test_parse_malformed_header_returns_empty():
    # 파이프 3개 미만
    assert parse_message("0|H0STASP0|001", date="20260605", now_ms=0) == []


def test_parse_unknown_tr_returns_empty():
    assert parse_message("0|H0STOAA0|001|x^y", date="20260605", now_ms=0) == []
