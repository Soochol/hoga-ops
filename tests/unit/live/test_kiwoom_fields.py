"""kiwoom_fields 의 venue 헬퍼 **재수출** 경로 — 소비자 계약 유지 확인.

정본은 `kiwoom_venue` 로 옮겼다(#1124 — 방향이 반대인 동명 상수 2벌 통합). 인코딩
자체의 전수 검증은 `test_kiwoom_venue.py` 가 한다. 여기 남은 것은 **기존 소비자가
쓰던 import 경로가 계속 산다**는 계약이다.
"""
from hoga.live.kiwoom_fields import apply_venue, split_venue


def test_apply_venue_krx_is_bare():
    assert apply_venue("005930", "KRX") == "005930"


def test_apply_venue_nxt_appends_suffix():
    assert apply_venue("005930", "NXT") == "005930_NX"


def test_apply_split_roundtrip():
    """apply_venue → split_venue 왕복 = 항등(구독 코드가 REAL 에코로 되돌아오는 계약)."""
    for code in ("005930", "000660"):
        for venue in ("KRX", "NXT", "UN"):
            wire = apply_venue(code, venue)
            assert split_venue(wire) == (code, venue)
