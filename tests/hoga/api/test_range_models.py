"""Tests for RangeBundle / RangeSegment / Timeframe whitelist (ADR-0013, ADR-0014)."""
from __future__ import annotations

import pytest

from hoga.api.models import (
    ALLOWED_TIMEFRAME_MS,
    DepthIntensity,
    FillStrength,
    QuoteRatio,
    RangeBundle,
    RangeSegment,
    VolumeProfile,
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
        depth_intensity=DepthIntensity(
            bucket_ms=60_000,
            price_min=0,
            price_max=0,
            price_step=1,
            times=[],
            bid_grid=[],
            ask_grid=[],
        ),
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
