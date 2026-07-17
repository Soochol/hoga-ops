"""kiwoom_fields venue 접미 헬퍼 — apply_venue/split_venue 대칭(ADR-0118 §2)."""
from hoga.live.kiwoom_fields import apply_venue, split_venue


def test_apply_venue_krx_is_bare():
    assert apply_venue("005930", "KRX") == "005930"


def test_apply_venue_nxt_appends_suffix():
    assert apply_venue("005930", "NXT") == "005930_NX"


def test_apply_split_roundtrip():
    """apply_venue → split_venue 왕복 = 항등(구독 코드가 REAL 에코로 되돌아오는 계약)."""
    for code in ("005930", "000660"):
        for venue in ("KRX", "NXT"):
            wire = apply_venue(code, venue)
            assert split_venue(wire) == (code, venue)
