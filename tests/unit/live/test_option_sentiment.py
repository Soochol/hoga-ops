"""옵션 심리 지표 집계 테스트 (ADR-0135).

Max Pain 은 손으로 검산한 값을 고정한다. 나머지는 각 지표가 조용히 틀리는
경로(0 나눗셈, iv=0 결측, 부분 체인)를 막는 것이 목적이다.
"""
from __future__ import annotations

import pytest

from hoga.live.kis_option_endpoints import OptionChainSnapshot, OptionQuote
from hoga.live.option_sentiment import (
    InsufficientChainCoverage,
    gamma_exposure,
    iv_skew,
    oi_distribution,
    put_call_ratio,
)


def _q(
    right, strike, *, volume=0, oi=0, iv=0.0, delta=0.0, gamma=0.0
) -> OptionQuote:
    return OptionQuote(
        code=f"{'B' if right == 'call' else 'C'}{int(strike)}",
        right=right,
        strike=strike,
        price=1.0,
        volume=volume,
        open_interest=oi,
        oi_change=0,
        iv=iv,
        delta=delta,
        gamma=gamma,
        vega=0.0,
        theta=0.0,
    )


def _snap(quotes, *, underlying=110.0) -> OptionChainSnapshot:
    return OptionChainSnapshot(
        expiry="202608",
        underlying=underlying,
        quotes=tuple(quotes),
        dropped=0,
        t_ms=0,
    )


def test_put_call_ratio_splits_volume_and_oi() -> None:
    snap = _snap([
        _q("call", 100.0, volume=10, oi=100),
        _q("put", 100.0, volume=25, oi=50),
    ])
    r = put_call_ratio(snap)
    assert r.volume_ratio == 2.5
    assert r.oi_ratio == 0.5
    assert (r.call_volume, r.put_volume) == (10, 25)


def test_put_call_ratio_zero_denominator_is_none_not_zero() -> None:
    # 장 초반·휴장 직후에 실제로 난다. 0 을 반환하면 '콜 우위'로 오독된다.
    snap = _snap([_q("put", 100.0, volume=5, oi=5)])
    r = put_call_ratio(snap)
    assert r.volume_ratio is None
    assert r.oi_ratio is None


def test_max_pain_matches_hand_calculation() -> None:
    # 콜 OI 100→10 110→20 120→30 / 풋 OI 100→30 110→20 120→10
    #   settle=100: 풋 20*10 + 10*20 = 400
    #   settle=110: 콜 10*10 + 풋 10*10 = 200   ← 최소
    #   settle=120: 콜 10*20 + 20*10 = 400
    snap = _snap([
        _q("call", 100.0, oi=10), _q("call", 110.0, oi=20), _q("call", 120.0, oi=30),
        _q("put", 100.0, oi=30), _q("put", 110.0, oi=20), _q("put", 120.0, oi=10),
    ])
    dist = oi_distribution(snap, full_chain=True)
    assert dist.max_pain == 110.0
    assert [s.strike for s in dist.strikes] == [100.0, 110.0, 120.0]
    assert dist.strikes[2].call_oi == 30
    assert dist.strikes[0].put_oi == 30


def test_max_pain_and_gex_refuse_partial_chain() -> None:
    # ATM 창만으로 계산하면 조용히 틀린다 — 거부가 옳다.
    snap = _snap([_q("call", 100.0, oi=10)])
    with pytest.raises(InsufficientChainCoverage):
        oi_distribution(snap, full_chain=False)
    with pytest.raises(InsufficientChainCoverage):
        gamma_exposure(snap, full_chain=False)


def test_gex_sign_follows_call_minus_put() -> None:
    calls_only = _snap([_q("call", 110.0, oi=100, gamma=0.01)])
    puts_only = _snap([_q("put", 110.0, oi=100, gamma=0.01)])
    assert gamma_exposure(calls_only, full_chain=True).total > 0
    assert gamma_exposure(puts_only, full_chain=True).total < 0


def test_gex_flip_strike_detected() -> None:
    snap = _snap([
        _q("put", 100.0, oi=100, gamma=0.02),   # 누적 음수로 시작
        _q("call", 120.0, oi=300, gamma=0.02),  # 여기서 누적이 양수로 뒤집힘
    ])
    assert gamma_exposure(snap, full_chain=True).flip_strike == 120.0


def test_iv_skew_excludes_zero_iv() -> None:
    # iv=0 은 '거래 없음'이지 '변동성 0' 이 아니다. 곡선에 넣으면 스마일이 꺾인다.
    snap = _snap([
        _q("call", 100.0, oi=5, iv=0.0, delta=0.9),
        _q("call", 110.0, oi=5, iv=15.0, delta=0.5),
        _q("put", 110.0, oi=5, iv=17.0, delta=-0.5),
    ])
    sk = iv_skew(snap)
    assert [p.strike for p in sk.points] == [110.0]
    assert sk.atm_iv == 16.0  # (15 + 17) / 2


def test_iv_skew_risk_reversal_uses_25_delta() -> None:
    snap = _snap([
        _q("call", 120.0, oi=5, iv=14.0, delta=0.25),
        _q("call", 110.0, oi=5, iv=16.0, delta=0.50),
        _q("put", 100.0, oi=5, iv=20.0, delta=-0.25),
    ])
    sk = iv_skew(snap)
    # 25델타 풋(20.0) − 25델타 콜(14.0). 양수 = 하방 보험이 더 비싸다.
    assert sk.risk_reversal_25d == 6.0


def test_iv_skew_drops_strikes_with_no_liquidity() -> None:
    """미결제도 거래도 없는 행사가의 IV 는 순수 이론값이라 곡선 표본이 될 수 없다.

    방어적 가드다 — 2026-08-03 근월물 실측에서는 390개 행사가 전부가 미결제나
    거래를 갖고 있어 한 건도 걸러지지 않았다. 만기 직후·신규 상장 직후의 빈
    행사가를 위한 것이다.
    """
    snap = _snap([
        _q("call", 100.0, iv=88.0),                 # OI 0 · 거래 0 → 이론값
        _q("call", 110.0, oi=12, iv=15.0),          # 미결제 있음 → 유효
        _q("put", 120.0, volume=3, iv=18.0),        # 거래 있음 → 유효
    ])
    sk = iv_skew(snap)
    assert [p.strike for p in sk.points] == [110.0, 120.0]


def test_iv_skew_points_carry_oi_for_confidence() -> None:
    # 화면이 저유동성 IV 를 투명도로 감쇠하려면 포인트에 OI 가 실려야 한다.
    # 콜+풋 합산 — IV 없는 쪽(풋)의 미결제도 그 행사가의 유동성이다.
    snap = _snap([
        _q("call", 110.0, oi=12, iv=15.0),
        _q("put", 110.0, oi=8, iv=0.0),  # IV 결측이지만 OI 는 합산 대상
    ])
    sk = iv_skew(snap)
    assert sk.points[0].oi == 20


def test_iv_skew_no_valid_iv_returns_none() -> None:
    snap = _snap([_q("call", 100.0, oi=5, iv=0.0), _q("put", 100.0, oi=5, iv=0.0)])
    sk = iv_skew(snap)
    assert sk.points == ()
    assert sk.atm_iv is None
    assert sk.risk_reversal_25d is None
