"""KOSPI200 옵션 심리 지표 집계 (ADR-0135).

입력은 ``OptionChainSnapshot`` 하나, 출력은 표시용 dataclass. 전부 순수 함수라
네트워크·시계 의존이 없다.

**여기 있는 함수는 모두 전수 체인을 전제한다.** ATM 창으로 계산해도 되는 것은
ATM IV 와 25델타 리스크리버설 **두 값뿐**이다(``sentiment_routes`` 가 그 둘만
ATM 계층으로 덮어쓴다).

  P/C 비율     : 표준 정의가 전 종목 거래량·미결제 비율이다. ATM 창으로 내면
                 이름만 같은 다른 지표가 된다.
  Max Pain·GEX : 정의상 전 행사가 합산.
  IV 스마일     : 양 날개가 있어야 곡선 모양이 나온다.

Max Pain 과 GEX 를 ATM 창으로 계산하면 틀린 값이 조용히 나온다. 실측(2026-08-03)
에서 60% OTM 인 행사가 1597.5 의 OI 가 14,449 로 ATM(1000.0)의 1,674 보다 8.6배
컸다 — OI 는 ATM 에 몰려 있지 않다. 그래서 두 함수는 ``full_chain=False`` 인
스냅샷을 받으면 계산을 거부한다(조용히 틀린 값을 내느니 없는 게 낫다).

해석상 한계는 UI 로도 전달해야 한다:
  - P/C 비율은 **헤지와 투기를 구분하지 못한다**. 풋 미결제 증가는 하락 베팅일
    수도, 보유 포지션 보험일 수도 있다.
  - GEX 는 **방향 지표가 아니라 변동성 체제 지표**다. 부호는 딜러가 콜 매도·풋
    매수 포지션이라는 관례적 가정에서 나오며, 이 가정 자체가 검증 불가다.
"""
from __future__ import annotations

from dataclasses import dataclass

from hoga.live.kis_option_endpoints import OptionChainSnapshot, OptionQuote

#: KOSPI200 정규 옵션 계약승수(원/포인트). 미니는 1/5 이라 절대 합산하지 말 것.
CONTRACT_MULTIPLIER = 250_000


class InsufficientChainCoverage(ValueError):
    """전 행사가가 필요한 지표를 부분 체인으로 계산하려 했다."""


@dataclass(frozen=True)
class PutCallRatio:
    """거래량 기준과 미결제 기준을 따로 낸다 — 둘은 다른 것을 말한다.

    거래량은 '오늘의 흐름', 미결제는 '누적된 포지션'이다. 거래량 P/C 가 튀어도
    미결제 P/C 가 그대로면 당일 단타가 돌았을 뿐 포지션은 안 쌓인 것이다.
    """
    volume_ratio: float | None
    oi_ratio: float | None
    call_volume: int
    put_volume: int
    call_oi: int
    put_oi: int


@dataclass(frozen=True)
class StrikeOi:
    strike: float
    call_oi: int
    put_oi: int


@dataclass(frozen=True)
class OiDistribution:
    strikes: tuple[StrikeOi, ...]
    #: 만기 시 옵션 매도자 총손실이 최소가 되는 행사가.
    max_pain: float | None


@dataclass(frozen=True)
class GexPoint:
    strike: float
    #: 콜 감마 − 풋 감마, 계약승수 반영. 딜러 포지션 가정에 의존한다.
    gex: float


@dataclass(frozen=True)
class GammaExposure:
    points: tuple[GexPoint, ...]
    total: float
    #: 누적 GEX 부호가 뒤집히는 행사가 — 통상 '감마 플립'으로 불린다.
    flip_strike: float | None


@dataclass(frozen=True)
class IvPoint:
    strike: float
    call_iv: float | None
    put_iv: float | None
    #: 해당 행사가 미결제 합(콜+풋). IV 의 **신뢰도** 신호다 — 실측상 OI 한
    #: 자릿수 행사가의 IV 는 심하게 산포해 곡선을 톱니로 만든다. 지표에서 지우는
    #: 대신(그러면 Max Pain·GEX 가 보는 데이터와 달라진다) 화면이 이 값으로
    #: 투명도를 감쇠한다.
    oi: int = 0


@dataclass(frozen=True)
class IvSkew:
    points: tuple[IvPoint, ...]
    atm_iv: float | None
    #: 25델타 리스크 리버설(풋 IV − 콜 IV). 양수면 하방 보험이 더 비싸다.
    risk_reversal_25d: float | None


def _split(quotes: tuple[OptionQuote, ...]) -> tuple[list[OptionQuote], list[OptionQuote]]:
    return (
        [q for q in quotes if q.right == "call"],
        [q for q in quotes if q.right == "put"],
    )


def put_call_ratio(snap: OptionChainSnapshot) -> PutCallRatio:
    calls, puts = _split(snap.quotes)
    cv = sum(q.volume for q in calls)
    pv = sum(q.volume for q in puts)
    co = sum(q.open_interest for q in calls)
    po = sum(q.open_interest for q in puts)
    return PutCallRatio(
        # 분모 0 은 '비율 없음'이지 0 이 아니다 — 장 초반이나 휴장 직후에 실제로 난다.
        volume_ratio=(pv / cv) if cv else None,
        oi_ratio=(po / co) if co else None,
        call_volume=cv,
        put_volume=pv,
        call_oi=co,
        put_oi=po,
    )


def oi_distribution(snap: OptionChainSnapshot, *, full_chain: bool) -> OiDistribution:
    """행사가별 콜/풋 미결제 + Max Pain.

    Max Pain 은 각 후보 행사가에서 만기 시 옵션 매도자가 떠안는 총 내재가치가
    최소가 되는 지점이다. 전 행사가 합산이므로 부분 체인이면 거부한다.
    """
    if not full_chain:
        raise InsufficientChainCoverage("Max Pain 은 전 행사가 체인이 필요하다")
    calls, puts = _split(snap.quotes)
    call_oi = {q.strike: q.open_interest for q in calls}
    put_oi = {q.strike: q.open_interest for q in puts}
    strikes = sorted(set(call_oi) | set(put_oi))
    rows = tuple(
        StrikeOi(k, call_oi.get(k, 0), put_oi.get(k, 0)) for k in strikes
    )

    best: float | None = None
    best_pain: float | None = None
    for settle in strikes:
        pain = 0.0
        for k in strikes:
            if k < settle:  # 콜 매도자가 물린다
                pain += call_oi.get(k, 0) * (settle - k)
            elif k > settle:  # 풋 매도자가 물린다
                pain += put_oi.get(k, 0) * (k - settle)
        if best_pain is None or pain < best_pain:
            best_pain, best = pain, settle
    return OiDistribution(strikes=rows, max_pain=best)


def gamma_exposure(snap: OptionChainSnapshot, *, full_chain: bool) -> GammaExposure:
    """행사가별 딜러 감마 익스포저.

    부호 관례: 콜 +, 풋 −. 이는 '딜러가 콜을 팔고 풋을 산다'는 시장 관례적 가정이며
    검증 가능한 사실이 아니다 — UI 에 반드시 명시할 것. 방향이 아니라 변동성 체제를
    읽는 지표다(양수 = 딜러 롱감마 = 움직임 억제, 음수 = 증폭).
    """
    if not full_chain:
        raise InsufficientChainCoverage("GEX 는 전 행사가 체인이 필요하다")
    calls, puts = _split(snap.quotes)
    spot = snap.underlying
    call_g = {q.strike: q.gamma * q.open_interest for q in calls}
    put_g = {q.strike: q.gamma * q.open_interest for q in puts}
    strikes = sorted(set(call_g) | set(put_g))
    # spot^2 · 1% 스케일링은 GEX 의 통상 표기(1% 이동당 딜러 감마 노출액).
    scale = CONTRACT_MULTIPLIER * spot * spot * 0.01 if spot > 0 else CONTRACT_MULTIPLIER
    points = tuple(
        GexPoint(k, (call_g.get(k, 0.0) - put_g.get(k, 0.0)) * scale) for k in strikes
    )
    total = sum(p.gex for p in points)

    flip: float | None = None
    running = 0.0
    for p in points:
        prev = running
        running += p.gex
        if prev <= 0 < running or prev >= 0 > running:
            flip = p.strike
    return GammaExposure(points=points, total=total, flip_strike=flip)


def _iv_usable(q: OptionQuote) -> bool:
    """IV 곡선에 넣을 수 있는 값인가.

    두 가지를 건다.

    1. **iv == 0 은 결측이다.** 거래가 없는 종목은 IV 가 0.0 으로 오는데 이를 곡선에
       넣으면 스마일이 바닥으로 꺾여 스큐 판정이 뒤집힌다.
    2. **미결제도 거래도 없는 종목의 IV 는 순수 이론값이다.** 시장이 값을 매긴 적
       없는 지점이라 스마일의 표본이 될 수 없다.

    2번은 방어적 가드다 — 2026-08-03 근월물 실측에서는 390개 행사가가 **전부**
    미결제나 거래를 갖고 있어 한 건도 걸러지지 않았다. 만기 직후나 신규 상장 직후의
    빈 행사가를 위한 것이지, 곡선 노이즈를 줄이는 장치가 아니다(그 노이즈는 OI 가
    한 자릿수인 행사가들의 실제 IV 산포이며, 임계를 올려 지우는 것은 자의적이다).
    """
    return q.iv > 0 and (q.open_interest > 0 or q.volume > 0)


def iv_skew(snap: OptionChainSnapshot) -> IvSkew:
    """행사가별 IV 곡선 + ATM IV + 25델타 리스크 리버설.

    유동성 필터는 ``_iv_usable`` 참조 — 걸러진 행사가는 곡선에서 빠진다.
    """
    calls, puts = _split(snap.quotes)
    call_iv = {q.strike: q.iv for q in calls if _iv_usable(q)}
    put_iv = {q.strike: q.iv for q in puts if _iv_usable(q)}
    oi_sum: dict[float, int] = {}
    for q in snap.quotes:
        oi_sum[q.strike] = oi_sum.get(q.strike, 0) + q.open_interest
    strikes = sorted(set(call_iv) | set(put_iv))
    points = tuple(
        IvPoint(k, call_iv.get(k), put_iv.get(k), oi=oi_sum.get(k, 0)) for k in strikes
    )

    atm: float | None = None
    if snap.underlying > 0 and strikes:
        nearest = min(strikes, key=lambda k: abs(k - snap.underlying))
        pair = [v for v in (call_iv.get(nearest), put_iv.get(nearest)) if v is not None]
        atm = sum(pair) / len(pair) if pair else None

    # 25델타: 델타 절대값이 0.25 에 가장 가까운 콜/풋을 각각 고른다.
    rr: float | None = None
    c25 = min((q for q in calls if _iv_usable(q)), key=lambda q: abs(q.delta - 0.25), default=None)
    p25 = min((q for q in puts if _iv_usable(q)), key=lambda q: abs(q.delta + 0.25), default=None)
    if c25 is not None and p25 is not None:
        rr = p25.iv - c25.iv
    return IvSkew(points=points, atm_iv=atm, risk_reversal_25d=rr)
