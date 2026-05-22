"""Tests for hoga.api.bundle module."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from hoga.api.bundle import build_bundle, downsample_candles
from hoga.tables.candles import ApiCandle


def _c(ts_ms: int, o: int, h: int, l: int, c: int, va: int = 0, vb: int = 0) -> ApiCandle:
    """KRX prices are integer-won (see hoga/tables/candles.py:ApiCandle)."""
    return ApiCandle(ts_ms=ts_ms, open=o, close=c, high=h, low=l, vol_a=va, vol_b=vb)


def test_downsample_candles_identity_at_60000():
    inp = [_c(60_000, 100, 110, 95, 105), _c(120_000, 105, 108, 100, 102)]
    out = downsample_candles(inp, bucket_ms=60_000)
    assert out == inp


def test_downsample_candles_5min_groups_five_1min_bars():
    inp = [
        _c(0,        100, 110,  95, 105, 10, 20),
        _c(60_000,   105, 115, 102, 110, 15, 25),
        _c(120_000,  110, 120, 108, 118,  5, 30),
        _c(180_000,  118, 119, 110, 112, 20, 10),
        _c(240_000,  112, 125, 111, 122, 30, 15),
    ]
    out = downsample_candles(inp, bucket_ms=300_000)
    assert len(out) == 1
    bar = out[0]
    assert bar.ts_ms == 0
    assert bar.open == 100
    assert bar.close == 122
    assert bar.high == 125
    assert bar.low == 95
    assert bar.vol_a == 80
    assert bar.vol_b == 100


def test_downsample_candles_includes_last_partial_bucket():
    inp = [_c(i * 60_000, 100, 110, 90, 105, 1, 1) for i in range(7)]
    out = downsample_candles(inp, bucket_ms=300_000)
    assert len(out) == 2
    assert out[0].ts_ms == 0
    assert out[1].ts_ms == 300_000
    assert out[1].vol_a == 2


def test_downsample_candles_empty_input_returns_empty():
    assert downsample_candles([], bucket_ms=300_000) == []


def test_downsample_candles_rejects_invalid_bucket():
    with pytest.raises(ValueError, match="bucket_ms"):
        downsample_candles([_c(0, 1, 1, 1, 1)], bucket_ms=42_000)


def test_downsample_candles_handles_all_six_timeframes():
    inp = [_c(i * 60_000, 100, 110, 90, 105, 1, 1) for i in range(30)]
    for bucket_ms in (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000):
        out = downsample_candles(inp, bucket_ms=bucket_ms)
        assert sum(c.vol_a for c in out) == 30
        for c in out:
            assert c.ts_ms % bucket_ms == 0


# ---------------------------------------------------------------------------
# build_bundle: bucket_ms propagation (ADR-0014)
# ---------------------------------------------------------------------------

def _mock_engine_with_meta() -> MagicMock:
    """Engine stub whose get_meta returns the keys build_bundle actually reads."""
    mock_engine = MagicMock()
    mock_engine.get_meta.return_value = {
        "regular_session_open_ms": 90_000_000,   # HHMMSSmmm: 09:00:00.000
        "regular_session_close_ms": 153_000_000,  # HHMMSSmmm: 15:30:00.000
    }
    return mock_engine


def test_build_bundle_propagates_bucket_ms_to_all_series():
    """All four series builders + downsample_candles must receive bucket_ms."""
    from hoga.api import bundle as bundle_mod
    from hoga.api.models import DepthIntensity, FillStrength, QuoteRatio, VolumeProfile

    qr = QuoteRatio(bucket_ms=300_000, points=[])
    di = DepthIntensity(
        bucket_ms=300_000, price_min=0, price_max=0, price_step=1,
        times=[], bid_grid=[], ask_grid=[],
    )
    fs = FillStrength(bucket_ms=300_000, points=[])
    vp = VolumeProfile(
        bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[],
    )

    mock_engine = _mock_engine_with_meta()

    with (
        patch.object(bundle_mod, "build_candles_slice", return_value=[]),
        patch.object(bundle_mod, "build_quote_ratio_slice", return_value=qr) as p_qr,
        patch.object(bundle_mod, "build_depth_intensity_slice", return_value=di) as p_di,
        patch.object(bundle_mod, "build_fill_strength_slice", return_value=fs) as p_fs,
        patch.object(bundle_mod, "build_volume_profile_slice", return_value=vp),
        patch.object(bundle_mod, "downsample_candles", return_value=[]) as p_down,
    ):
        build_bundle(mock_engine, code="005930", date="20260512", bucket_ms=300_000)

    assert p_qr.call_args.kwargs.get("bucket_ms") == 300_000
    di_kwargs = p_di.call_args.kwargs
    assert (
        di_kwargs.get("depth_bucket_ms") == 300_000
        or di_kwargs.get("bucket_ms") == 300_000
    )
    assert p_fs.call_args.kwargs.get("bucket_ms") == 300_000
    assert p_down.call_args.kwargs.get("bucket_ms") == 300_000


def test_build_bundle_default_bucket_ms_is_60000():
    """Default keeps existing 1-minute behaviour."""
    from hoga.api import bundle as bundle_mod
    from hoga.api.models import DepthIntensity, FillStrength, QuoteRatio, VolumeProfile

    qr = QuoteRatio(bucket_ms=60_000, points=[])
    di = DepthIntensity(
        bucket_ms=60_000, price_min=0, price_max=0, price_step=1,
        times=[], bid_grid=[], ask_grid=[],
    )
    fs = FillStrength(bucket_ms=60_000, points=[])
    vp = VolumeProfile(
        bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[],
    )
    mock_engine = _mock_engine_with_meta()

    with (
        patch.object(bundle_mod, "build_candles_slice", return_value=[]),
        patch.object(bundle_mod, "build_quote_ratio_slice", return_value=qr) as p_qr,
        patch.object(bundle_mod, "build_depth_intensity_slice", return_value=di),
        patch.object(bundle_mod, "build_fill_strength_slice", return_value=fs),
        patch.object(bundle_mod, "build_volume_profile_slice", return_value=vp),
        patch.object(bundle_mod, "downsample_candles", return_value=[]) as p_down,
    ):
        build_bundle(mock_engine, code="005930", date="20260512")

    assert p_qr.call_args.kwargs.get("bucket_ms") == 60_000
    assert p_down.call_args.kwargs.get("bucket_ms") == 60_000


def test_build_bundle_rejects_invalid_bucket_ms():
    """bucket_ms must be in ALLOWED_TIMEFRAME_MS (ADR-0014)."""
    mock_engine = _mock_engine_with_meta()
    with pytest.raises(ValueError, match="bucket_ms"):
        build_bundle(mock_engine, code="005930", date="20260512", bucket_ms=42_000)
