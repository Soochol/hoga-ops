from __future__ import annotations

import datetime as dt

from hoga.api.screener_factors import compute_factor_segments, pair_raw_adj


def test_inner_joins_by_date_sorted():
    raw = [(dt.date(2021, 4, 5), 502000.0), (dt.date(2021, 4, 15), 120500.0)]
    adj = [(dt.date(2021, 4, 15), 120500.0), (dt.date(2021, 4, 5), 100759.0)]  # unsorted
    assert pair_raw_adj(raw, adj) == [
        (dt.date(2021, 4, 5), 502000.0, 100759.0),
        (dt.date(2021, 4, 15), 120500.0, 120500.0),
    ]


def test_drops_dates_missing_on_either_side():
    raw = [(dt.date(2000, 1, 4), 1000.0), (dt.date(2021, 4, 5), 502000.0)]
    adj = [(dt.date(2021, 4, 5), 100759.0)]
    assert pair_raw_adj(raw, adj) == [(dt.date(2021, 4, 5), 502000.0, 100759.0)]


def test_feeds_compute_factor_segments():
    raw = [(dt.date(2021, 4, 5), 502000.0), (dt.date(2021, 4, 15), 120500.0)]
    adj = [(dt.date(2021, 4, 5), 100759.0), (dt.date(2021, 4, 15), 120500.0)]
    segs = compute_factor_segments(pair_raw_adj(raw, adj))
    assert len(segs) == 2
    assert abs(segs[0].factor - 100759.0 / 502000.0) < 1e-9
    assert segs[1].factor == 1.0


def test_empty_when_no_overlap():
    assert pair_raw_adj([(dt.date(2020, 1, 1), 1.0)], []) == []
