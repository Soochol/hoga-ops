"""구조 서명 — 봉 사이의 «차트 문법» 관계만 부호로 적어 비교한다 (ADR-0166 결정 12).

상관계수는 창 전체가 함께 오르내리는가를 재므로, 「3봉 고가가 앞 봉들의 고가를 넘었는데
종가는 못 넘었다」 같은 **국소 부등식**은 평균에 묻힌다. 실측(2026-09-04): 그 구조를 가진
쿼리로 상관 상위 100개를 뽑으면 같은 구조가 **8개**뿐이고, 20값 190쌍의 순서 일치도
(Kendall τ)로 바꿔도 top20 중 3개다 — 그림의 정체가 190쌍 중 서너 쌍에 있어서 고르게
세면 희석된다.

그래서 **차트에서 뜻이 있는 관계만** 센다. 봉마다:

* 색 — 종가 > 시가
* 직전까지의 최고가 대비 — 고가·종가가 그 위인가
* 직전까지의 최저가 대비 — 저가·종가가 그 아래인가

L봉이면 1 + 5(L−1) 개 부호. **쿼리의 부호열이 곧 규칙**이고(손으로 쓰지 않는다), 후보는
그 부호가 몇 개 맞는지로 걸러진다. 진폭은 애초에 보지 않는다 — 부호는 로그·중심화·
z-정규화 어느 것에도 불변이라 `Corpus.ch`(중심화 로그가격)를 그대로 쓴다.

**게이트이지 점수가 아니다.** 통과한 창들 안에서의 순서는 여전히 상관계수다. 분포·
베이스라인도 통과 전 모집단으로 계산한다 — 92개 안에서 p99.99 를 재면 최댓값이고,
길이 유연 병합(`corr − p99.99`)이 잡음이 된다.

값이 0인 관계(쿼리에서 정확히 같은 값)는 판정에서 뺀다 — 「같다」를 후보에 요구하면
실수 동률이라 아무도 못 맞춘다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

_OPEN, _HIGH, _LOW, _CLOSE = 0, 1, 2, 3

#: 봉 하나가 갖는 관계 — 첫 봉은 색뿐이다(«직전»이 없다).
_PER_BAR = ("색", "고가 vs 전고", "종가 vs 전고", "저가 vs 전저", "종가 vs 전저")


def relation_names(length: int) -> list[str]:
    """`query_signature` 와 **같은 순서**의 이름들. 화면이 「어느 관계가 틀렸나」를 말할
    때 이 인덱스로 찾는다."""
    names = ["1봉 색"]
    for d in range(1, length):
        names += [f"{d + 1}봉 {r}" for r in _PER_BAR]
    return names


def relation_count(length: int) -> int:
    return 1 + 5 * (length - 1)


#: 관계 종류별 「쿼리가 기대하는 것」 문구. 부호가 + 일 때 / − 일 때.
_PHRASE = {
    "색": ("양봉", "음봉"),
    "고가 vs 전고": ("고가 > 전고", "고가 < 전고"),
    "종가 vs 전고": ("종가 > 전고", "종가 < 전고"),
    "저가 vs 전저": ("저가 > 전저", "저가 < 전저"),
    "종가 vs 전저": ("종가 > 전저", "종가 < 전저"),
}


def relation_phrases(sig: np.ndarray, length: int) -> list[str]:
    """관계마다 **쿼리가 기대하는 것**을 한국어로 — 「5봉 저가 > 전저」. `query_signature`
    와 같은 인덱스라 행의 불일치 인덱스가 이 목록을 가리킨다. 부호 0(판정 제외)은
    「=」 로 적어 자리를 지킨다 — 불일치 목록에는 원리적으로 안 나온다.
    """
    kinds = ["색"] + [r for _ in range(1, length) for r in _PER_BAR]
    out = []
    for i, (kind, s_) in enumerate(zip(kinds, sig, strict=True)):
        bar = 1 if i == 0 else 2 + (i - 1) // 5
        if s_ == 0:
            out.append(f"{bar}봉 {kind.replace(' vs ', ' = ')}")
        else:
            out.append(f"{bar}봉 {_PHRASE[kind][0 if s_ > 0 else 1]}")
    return out


def mismatches(sig: np.ndarray, window: np.ndarray) -> list[int]:
    """한 후보 창에서 **쿼리 부호와 다른** 판정 관계의 인덱스. 총수 − 길이 = 그 창의
    `struct_match` 다(동률은 어느 부호와도 안 맞으므로 불일치로 센다 — `window_matches`
    와 같은 규칙)."""
    wsig = query_signature(window)
    return [int(i) for i in np.flatnonzero(sig) if wsig[i] != sig[i]]


def _relations(o, h, lo, cl, length: int):
    """관계 값들을 **같은 순서**로 낸다. 인자는 봉 오프셋 d 로 인덱싱되는 시퀀스 —
    쿼리 하나면 스칼라 열, 후보 전체면 창 수 길이의 벡터 열이다.

    직전까지의 최고·최저는 **증분**으로 민다. `np.maximum.reduce(h[:d])` 를 d 마다
    다시 하면 O(L²) 라 L=30 에서 435번 줄인다(창 수 백만 위에서).
    """
    yield cl[0] - o[0]
    hi_prev = h[0]
    lo_prev = lo[0]
    for d in range(1, length):
        if d > 1:
            hi_prev = np.maximum(hi_prev, h[d - 1])
            lo_prev = np.minimum(lo_prev, lo[d - 1])
        yield cl[d] - o[d]
        yield h[d] - hi_prev
        yield cl[d] - hi_prev
        yield lo[d] - lo_prev
        yield cl[d] - lo_prev


def query_signature(window: np.ndarray) -> np.ndarray:
    """(4, L) 창 → 관계별 부호(int8). 0 은 「판정 안 함」."""
    o, h, lo, cl = window[_OPEN], window[_HIGH], window[_LOW], window[_CLOSE]
    length = window.shape[1]
    return np.array([np.sign(v) for v in _relations(o, h, lo, cl, length)], dtype=np.int8)


def signature_total(sig: np.ndarray) -> int:
    """판정에 들어가는 관계 수 — 부호가 0 이 아닌 것."""
    return int(np.count_nonzero(sig))


def window_matches(
    ch: np.ndarray, sig: np.ndarray, length: int, starts: np.ndarray | None = None,
) -> np.ndarray:
    """후보 창마다 쿼리 부호와 **일치하는 관계 수**(int16).

    `starts` 가 없으면 전 창(시작 인덱스 0..N−L)을 슬라이스 뷰로 돈다 — 계열 경계를
    넘는 창도 계산되지만 호출부가 계열 안 범위만 읽으므로 닿지 않는다. `starts` 를 주면
    그 시작들만 계산한다(`now` 는 종목당 최신 창 하나라 전 창을 도는 것이 낭비다).
    """
    if starts is None:
        n = ch.shape[1] - length + 1
        pick = lambda k, d: ch[k, d : d + n]  # noqa: E731 — 슬라이스는 복사가 없다
    else:
        n = len(starts)
        pick = lambda k, d: ch[k, starts + d]  # noqa: E731
    o = [pick(_OPEN, d) for d in range(length)]
    h = [pick(_HIGH, d) for d in range(length)]
    lo = [pick(_LOW, d) for d in range(length)]
    cl = [pick(_CLOSE, d) for d in range(length)]
    out = np.zeros(n, dtype=np.int16)
    for s, value in zip(sig, _relations(o, h, lo, cl, length), strict=True):
        if s > 0:
            out += value > 0
        elif s < 0:
            out += value < 0
    return out


@dataclass
class StructGate:
    """검색에 넘기는 게이트. `matches` 의 인덱스 뜻은 모드마다 다르다 — `history` 는
    **전역 창 시작 인덱스**, `now` 는 **종목 인덱스**(그 종목의 최신 창).

    `hist` 는 검색이 **채워 돌려준다** — 다른 필터를 다 지난 후보창들의 일치 수 분포다
    (게이트를 걸기 **전** 모집단). 팝오버가 「이 단계를 고르면 몇 개 남나」를 이 값으로
    센다. 반환값으로 내지 않는 이유는 호출 지점 15곳의 언패킹을 안 건드리려는 것이다.
    """

    matches: np.ndarray
    need: int
    total: int
    #: 쿼리 부호열 — 행의 불일치 인덱스(`mismatches`)와 기대 문구가 여기서 나온다.
    sig: np.ndarray | None = None
    hist: np.ndarray = field(default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.hist is None:
            self.hist = np.zeros(self.total + 1, dtype=np.int64)

    def count(self, m: np.ndarray) -> None:
        self.hist += np.bincount(m, minlength=self.total + 1)[: self.total + 1]

    def passes(self, m: np.ndarray) -> np.ndarray:
        return m >= self.need
