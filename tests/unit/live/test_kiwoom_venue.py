"""키움 wire venue 인코딩 정본 — 접미 ↔ venue 대칭 (ADR-0140, #1124).

이 모듈이 생기기 전엔 **같은 이름의 상수가 두 벌**이었고 방향까지 반대였다:
`kiwoom_fields.VENUE_SUFFIX = {"_NX": "NXT"}`(접미→venue, `_AL` 없음) vs
`kiwoom_multi_quote.VENUE_SUFFIX = {"KRX":"", "NXT":"_NX", "UN":"_AL"}`(venue→접미).
"""
import pytest

from hoga.live import kiwoom_fields, kiwoom_multi_quote
from hoga.live.kiwoom_venue import VENUE_SUFFIX, apply_venue, split_venue

VENUES = ("KRX", "NXT", "UN")


@pytest.mark.parametrize(("venue", "wire"), [
    ("KRX", "005930"),
    ("NXT", "005930_NX"),
    ("UN", "005930_AL"),
])
def test_apply_venue_encodes_each_venue(venue, wire):
    assert apply_venue("005930", venue) == wire


@pytest.mark.parametrize("venue", VENUES)
@pytest.mark.parametrize("code", ["005930", "000660", "0001A0"])
def test_roundtrip_is_identity(code, venue):
    """`apply_venue ∘ split_venue = 항등` — **세 venue 전부**.

    구독 코드가 REAL 프레임의 `item` 으로, REST `stk_cd` 로 그대로 에코돼 돌아오는
    계약이 이 대칭에 기대고 있다.
    """
    assert split_venue(apply_venue(code, venue)) == (code, venue)


def test_al_suffix_is_stripped_and_tagged_un():
    """⚠ 회귀 가드 — 이게 이 PR 이 고친 버그다.

    구버전 `kiwoom_fields.VENUE_SUFFIX` 는 `{"_NX": "NXT"}` 뿐이라 `_AL` 을 몰랐고,
    `split_venue("005930_AL")` 이 **`("005930_AL", "KRX")`** 를 돌려줬다 — 접미가
    안 벗겨져 코드가 오염되고 venue 가 KRX 로 오분류된다.
    """
    assert split_venue("005930_AL") == ("005930", "UN")


def test_bare_code_is_krx():
    assert split_venue("005930") == ("005930", "KRX")


def test_krx_empty_suffix_does_not_shadow_others():
    """`""`(KRX)를 순회에 넣으면 첫 비교에서 무조건 매치돼 `_NX`/`_AL` 이 도달 불가가 된다.

    역인덱스가 무접미를 제외하고 폴백으로만 쓰는 이유 — 이 테스트가 그 설계를 못박는다.
    """
    assert VENUE_SUFFIX["KRX"] == ""
    assert split_venue("005930_NX")[1] == "NXT"
    assert split_venue("005930_AL")[1] == "UN"


def test_unknown_venue_falls_back_to_bare():
    """모르는 venue 는 무접미(KRX)로 떨어진다 — **의도된 하위호환이 아니라 남은 함정**.

    `session_gate.AUTO_VENUE`("AUTO")를 그대로 넘기면 NXT 시간대에 KRX 를 오구독한다.
    호출부가 AUTO 를 먼저 해석해야 한다(`kiwoom_session._reconcile`). AUTO 는
    ADR-0140 §7 에서 소멸 예정이고 그때 엄격화한다 — 지금은 **현행 동작을 못박아**
    이 PR 이 행동을 안 바꿨음을 보인다.
    """
    assert apply_venue("005930", "AUTO") == "005930"


def test_re_exports_stay_wired():
    """기존 소비자는 `kiwoom_fields.split_venue` / `kiwoom_multi_quote.VENUE_SUFFIX` 로
    접근한다. 정본 이전 후에도 같은 객체여야 한다(호환 재수출)."""
    assert kiwoom_fields.split_venue is split_venue
    assert kiwoom_fields.apply_venue is apply_venue
    assert kiwoom_fields.VENUE_SUFFIX is VENUE_SUFFIX
    assert kiwoom_multi_quote.VENUE_SUFFIX is VENUE_SUFFIX


def test_single_source_of_truth():
    """정본이 하나임을 구조로 확인 — 같은 dict 객체를 모두가 본다."""
    from hoga.live import kiwoom_daily_candles, kiwoom_minute_candles

    assert kiwoom_daily_candles.VENUE_SUFFIX is VENUE_SUFFIX
    assert kiwoom_minute_candles.VENUE_SUFFIX is VENUE_SUFFIX
