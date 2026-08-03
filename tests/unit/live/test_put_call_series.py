"""P/C 당일 시계열 링버퍼 테스트 (ADR-0135 후속)."""
from __future__ import annotations

from hoga.live.put_call_series import PutCallSeries


def test_appends_in_order() -> None:
    s = PutCallSeries()
    s.append(t_ms=1000, date_key="20260803", volume_ratio=0.6, oi_ratio=0.9)
    s.append(t_ms=2000, date_key="20260803", volume_ratio=0.7, oi_ratio=0.91)
    pts = s.points()
    assert [p.t_ms for p in pts] == [1000, 2000]
    assert pts[1].volume_ratio == 0.7


def test_date_rollover_resets() -> None:
    # 자정(KST)이 지나면 어제의 흐름은 오늘의 흐름이 아니다 — 섞이면 개장 직후
    # 차트가 어제 종가 무렵 수치에서 이어지는 것처럼 보인다.
    s = PutCallSeries()
    s.append(t_ms=1000, date_key="20260803", volume_ratio=0.6, oi_ratio=0.9)
    s.append(t_ms=2000, date_key="20260804", volume_ratio=0.5, oi_ratio=0.8)
    pts = s.points()
    assert len(pts) == 1
    assert pts[0].t_ms == 2000


def test_cap_drops_oldest() -> None:
    s = PutCallSeries(max_points=3)
    for i in range(5):
        s.append(t_ms=i, date_key="20260803", volume_ratio=None, oi_ratio=None)
    assert [p.t_ms for p in s.points()] == [2, 3, 4]


def test_none_ratios_are_kept() -> None:
    # 장 초반 분모 0 은 '비율 없음'이지 결측 삭제 대상이 아니다 — 시계열에 구멍으로
    # 남아야 "그 시각엔 거래가 없었다" 가 보인다.
    s = PutCallSeries()
    s.append(t_ms=1000, date_key="20260803", volume_ratio=None, oi_ratio=None)
    assert s.points()[0].volume_ratio is None
