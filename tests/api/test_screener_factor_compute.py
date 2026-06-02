from __future__ import annotations

import datetime as dt
from hoga.api.screener_factors import FactorSegment, compute_factor_segments


def test_clean_split_two_segments():
    # 삼성 50:1: 분할 前 factor=adj/raw=0.02, 後=1.0
    rows = [
        (dt.date(2018, 4, 20), 2581000.0, 51620.0),  # 0.02
        (dt.date(2018, 4, 27), 2650000.0, 53000.0),  # 0.02
        (dt.date(2018, 4, 30), 2650000.0, 53000.0),  # 거래정지(평탄) → 같은 세그먼트
        (dt.date(2018, 5, 4),  51900.0,   51900.0),  # 1.0 (분할 後)
        (dt.date(2018, 5, 8),  52600.0,   52600.0),  # 1.0
    ]
    assert compute_factor_segments(rows) == [
        FactorSegment(dt.date(2018, 4, 20), 0.02),
        FactorSegment(dt.date(2018, 5, 4), 1.0),
    ]


def test_non_clean_ratio_kakao():
    # 카카오 1:5, 실현 factor≈0.2007 (깨끗한 0.2 아님) — 그래도 정확히 잡힘
    rows = [
        (dt.date(2021, 4, 5), 502000.0, 100759.0),   # 0.20071...
        (dt.date(2021, 4, 15), 120500.0, 120500.0),  # 1.0
    ]
    segs = compute_factor_segments(rows)
    assert len(segs) == 2
    assert segs[0].seg_start == dt.date(2021, 4, 5)
    assert abs(segs[0].factor - 100759.0 / 502000.0) < 1e-9
    assert segs[1] == FactorSegment(dt.date(2021, 4, 15), 1.0)


def test_no_split_single_segment():
    rows = [
        (dt.date(2024, 1, 2), 1000.0, 1000.0),
        (dt.date(2024, 1, 3), 1100.0, 1100.0),
    ]
    assert compute_factor_segments(rows) == [FactorSegment(dt.date(2024, 1, 2), 1.0)]


def test_zero_raw_close_skipped():
    rows = [
        (dt.date(2024, 1, 2), 0.0, 0.0),       # 불량/결측 → 스킵
        (dt.date(2024, 1, 3), 1000.0, 1000.0),
    ]
    assert compute_factor_segments(rows) == [FactorSegment(dt.date(2024, 1, 3), 1.0)]


def test_zero_adj_close_skipped():
    rows = [
        (dt.date(2024, 1, 2), 1000.0, 0.0),    # adj 불량/결측 → 스킵(factor=0 방지)
        (dt.date(2024, 1, 3), 1000.0, 1000.0),
    ]
    assert compute_factor_segments(rows) == [FactorSegment(dt.date(2024, 1, 3), 1.0)]


def test_empty_input_returns_empty():
    assert compute_factor_segments([]) == []
