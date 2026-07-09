"""Tests for RangeBundle / RangeSegment / Timeframe whitelist (ADR-0013, ADR-0014)."""
from __future__ import annotations

import pytest

from hoga.api.models import (
    ALLOWED_TIMEFRAME_MS,
    FillStrength,
    QuoteRatio,
    RangeBundle,
    RangeSegment,
    VolumeProfile,
    TradeVolumePoc,
    validate_bucket_ms,
)


def test_allowed_timeframe_ms_is_six_fixed_values():
    assert ALLOWED_TIMEFRAME_MS == (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000)


def test_validate_bucket_ms_accepts_whitelist():
    for ms in (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000):
        assert validate_bucket_ms(ms) == ms


def test_validate_bucket_ms_rejects_other_values():
    for bad in (0, 30_000, 120_000, 3_600_000):
        with pytest.raises(ValueError, match="bucket_ms"):
            validate_bucket_ms(bad)


def test_range_segment_carries_open_close_ms():
    seg = RangeSegment(
        date="20260512",
        session_open_ms=1_715_000_000_000,
        session_close_ms=1_715_023_400_000,
    )
    assert seg.date == "20260512"
    assert seg.session_open_ms < seg.session_close_ms


def test_range_bundle_requires_at_least_one_segment_and_consistent_bucket():
    bundle = RangeBundle(
        code="005930",
        from_date="20260512",
        to_date="20260512",
        bucket_ms=60_000,
        segments=[
            RangeSegment(date="20260512", session_open_ms=1, session_close_ms=2),
        ],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60_000, points=[]),
        fill_strength=FillStrength(bucket_ms=60_000, points=[]),
        volume_profile_range=VolumeProfile(
            bin_count=0,
            price_min=0,
            price_max=0,
            bin_width=0,
            bins=[],
        ),
        volume_profile_by_day=[
            VolumeProfile(
                bin_count=0,
                price_min=0,
                price_max=0,
                bin_width=0,
                bins=[],
            ),
        ],
    )
    assert bundle.bucket_ms == 60_000
    assert len(bundle.segments) == 1
    assert len(bundle.volume_profile_by_day) == 1


def test_range_bundle_has_excluded_dates_field_default_empty() -> None:
    from hoga.api.models import (
        ExcludedDate, DateWarning,
    )
    rb = RangeBundle(
        code="005930", from_date="20260520", to_date="20260520",
        bucket_ms=60_000,
        segments=[RangeSegment(date="20260520",
                               session_open_ms=1_000_000_000_000,
                               session_close_ms=1_000_000_001_000)],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60_000, points=[]),
        fill_strength=FillStrength(bucket_ms=60_000, points=[]),
        volume_profile_range=VolumeProfile(
            bin_count=0,
            price_min=0,
            price_max=0,
            bin_width=0,
            bins=[]),
        volume_profile_by_day=[],
    )
    assert rb.excluded_dates == []
    assert rb.data_warnings == []
    assert rb.trade_volume_pocs == []


def test_trade_volume_poc_model_round_trip() -> None:
    poc = TradeVolumePoc(
        date="20260624",
        center_price=72_300,
        low_price=71_500,
        high_price=73_100,
        qty=100,
        t_ms=1_782_259_320_000,
        band_pct=0.005,
    )
    assert poc.model_dump() == {
        "date": "20260624",
        "center_price": 72_300,
        "low_price": 71_500,
        "high_price": 73_100,
        "qty": 100,
        "t_ms": 1_782_259_320_000,
        "band_pct": 0.005,
    }


def test_depth_heatmap_point_defaults_and_shape() -> None:
    from hoga.api.models import DepthHeatmapPoint

    pt = DepthHeatmapPoint(
        t_ms=1_700_000_000_000,
        asks=[[1000, 500], [1010, 300]],
        bids=[[990, 400], [980, 200]],
        asks_max=[[1000, 900], [1010, 700]],
        bids_max=[[990, 800], [980, 600]],
    )
    assert pt.asks[0] == [1000, 500]
    assert pt.bids[0] == [990, 400]
    assert pt.asks_max[0] == [1000, 900]
    assert pt.bids_max[0] == [990, 800]

    empty = DepthHeatmapPoint(t_ms=1)
    assert empty.asks == []
    assert empty.bids == []
    assert empty.asks_max == []
    assert empty.bids_max == []

    rb = RangeBundle(
        code="005930", from_date="20260520", to_date="20260520",
        bucket_ms=60_000,
        segments=[RangeSegment(date="20260520",
                               session_open_ms=1_000_000_000_000,
                               session_close_ms=1_000_000_001_000)],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60_000, points=[]),
        fill_strength=FillStrength(bucket_ms=60_000, points=[]),
        volume_profile_range=VolumeProfile(
            bin_count=0,
            price_min=0,
            price_max=0,
            bin_width=0,
            bins=[]),
        volume_profile_by_day=[],
    )
    assert rb.depth_heatmap == []


def test_excluded_date_round_trip() -> None:
    from hoga.api.models import ExcludedDate
    ed = ExcludedDate(date="20260518", violations=[
        {"invariant_id": "meta.close_after_open", "severity": "error",
         "message": "x", "ctx": {"open_ms": 1, "close_ms": 0}},
    ])
    assert ed.model_dump()["date"] == "20260518"
    assert len(ed.model_dump()["violations"]) == 1


def test_date_warning_round_trip() -> None:
    from hoga.api.models import DateWarning
    dw = DateWarning(date="20260518", warnings=[
        {"invariant_id": "collection.finished", "severity": "warn",
         "message": "x", "ctx": {"complete": False}},
    ])
    assert dw.model_dump()["date"] == "20260518"
    assert len(dw.model_dump()["warnings"]) == 1
