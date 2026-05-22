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


# ---------------------------------------------------------------------------
# build_volume_profile_range (ADR-0013): multi-date trades unioned into one profile
# ---------------------------------------------------------------------------

def test_build_volume_profile_range_empty_dates_returns_empty():
    from hoga.api.bundle import build_volume_profile_range
    mock_engine = MagicMock()
    out = build_volume_profile_range(mock_engine, code="005930", dates=[])
    assert out.bin_count == 0
    assert out.bins == []


def test_build_volume_profile_range_single_date_uses_multi_file_glob():
    """One-date range: still calls read_parquet with a list parameter."""
    from hoga.api.bundle import build_volume_profile_range

    mock_engine = MagicMock()
    mock_engine.parquet_dir.side_effect = lambda d, c: __import__("pathlib").Path(f"/data/{c}/{d}")
    # First execute (MIN/MAX): returns (100, 200)
    # Second execute (GROUP BY bin): returns rows like [(0, 10), (1, 20), ...]
    mock_engine.conn.execute.side_effect = [
        MagicMock(fetchone=lambda: (100, 200)),
        MagicMock(fetchall=lambda: [(0, 10), (1, 20)]),
    ]

    out = build_volume_profile_range(mock_engine, code="005930", dates=["20260512"])

    # Verify the first call's parameter list contains a path-list element
    # (DuckDB multi-file glob: execute(sql, [paths]) where paths=list[str]).
    calls = mock_engine.conn.execute.call_args_list
    assert len(calls) >= 1
    # args = (sql, params_list); params_list = [paths] where paths is list[str]
    params = calls[0].args[1]
    assert isinstance(params, list)
    assert any(isinstance(p, list) and all(isinstance(s, str) for s in p) for p in params)
    assert out.bin_count > 0
    assert out.price_min == 100
    assert out.price_max == 200


def test_build_volume_profile_range_multi_date_unions_paths():
    """Multi-date range: paths list contains every date's trades.parquet."""
    from hoga.api.bundle import build_volume_profile_range

    mock_engine = MagicMock()
    mock_engine.parquet_dir.side_effect = lambda d, c: __import__("pathlib").Path(f"/data/{c}/{d}")
    mock_engine.conn.execute.side_effect = [
        MagicMock(fetchone=lambda: (100, 200)),
        MagicMock(fetchall=lambda: [(0, 10), (1, 20), (2, 30)]),
    ]

    out = build_volume_profile_range(mock_engine, code="005930", dates=["20260512", "20260513", "20260514"])

    # Find the path-list parameter and verify it contains all 3 trades.parquet entries.
    # Each execute call's params is [paths] where paths is list[str] of size 3.
    calls = mock_engine.conn.execute.call_args_list
    path_lists = []
    for call in calls:
        params = call.args[1] if len(call.args) > 1 else []
        if isinstance(params, list):
            for p in params:
                if isinstance(p, list) and all(isinstance(s, str) for s in p):
                    path_lists.append(p)
    assert path_lists, "Expected at least one path-list parameter"
    assert any(len(pl) == 3 for pl in path_lists), "Expected a 3-element paths list for 3 dates"
    assert out.bin_count > 0


def test_build_volume_profile_range_no_trades_returns_empty():
    """If MIN/MAX returns (None, None), no trades captured → empty profile."""
    from hoga.api.bundle import build_volume_profile_range

    mock_engine = MagicMock()
    mock_engine.parquet_dir.side_effect = lambda d, c: __import__("pathlib").Path(f"/data/{c}/{d}")
    mock_engine.conn.execute.return_value = MagicMock(fetchone=lambda: (None, None))

    out = build_volume_profile_range(mock_engine, code="005930", dates=["20260512"])
    assert out.bin_count == 0
    assert out.bins == []


# ---------------------------------------------------------------------------
# build_range_bundle (ADR-0013/0014): 30-day cap, partial-inventory, segments
# ---------------------------------------------------------------------------

def _mock_session_bundle(date: str, bucket_ms: int = 60_000):
    """Stub SessionBundle return value for a single build_bundle call."""
    from hoga.api.models import (
        DepthIntensity, FillStrength, QuoteRatio, SessionBundle, VolumeProfile,
    )
    return SessionBundle(
        code="005930", date=date,
        session_open_ms=1_700_000_000_000, session_close_ms=1_700_023_400_000,
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=[]),
        depth_intensity=DepthIntensity(
            bucket_ms=bucket_ms, price_min=100, price_max=200,
            price_step=1, times=[], bid_grid=[], ask_grid=[],
        ),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=[]),
        volume_profile=VolumeProfile(
            bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[],
        ),
    )


def test_build_range_bundle_single_day_yields_one_segment():
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile

    mock_engine = MagicMock()
    mock_engine.list_stock_dates_in_range.return_value = ["20260512"]
    with (
        patch.object(bundle_mod, "build_bundle", side_effect=lambda e, *, code, date, bucket_ms: _mock_session_bundle(date, bucket_ms)),
        patch.object(bundle_mod, "build_volume_profile_range", return_value=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])),
    ):
        rb = build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260512", bucket_ms=60_000)

    assert len(rb.segments) == 1
    assert rb.segments[0].date == "20260512"
    assert rb.bucket_ms == 60_000
    assert len(rb.depth_intensity_by_day) == 1
    assert len(rb.volume_profile_by_day) == 1


def test_build_range_bundle_multi_day_concatenates_per_segment_lists():
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile

    mock_engine = MagicMock()
    mock_engine.list_stock_dates_in_range.return_value = ["20260512", "20260513"]
    with (
        patch.object(bundle_mod, "build_bundle", side_effect=lambda e, *, code, date, bucket_ms: _mock_session_bundle(date, bucket_ms)),
        patch.object(bundle_mod, "build_volume_profile_range", return_value=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])),
    ):
        rb = build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260513", bucket_ms=60_000)

    assert len(rb.segments) == 2
    assert [s.date for s in rb.segments] == ["20260512", "20260513"]
    assert len(rb.depth_intensity_by_day) == 2
    assert len(rb.volume_profile_by_day) == 2


def test_build_range_bundle_rejects_from_gt_to():
    from fastapi import HTTPException
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    with pytest.raises(HTTPException) as exc:
        build_range_bundle(mock_engine, code="005930", from_date="20260520", to_date="20260512", bucket_ms=60_000)
    assert exc.value.status_code == 400


def test_build_range_bundle_rejects_range_over_30_days():
    from fastapi import HTTPException
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    with pytest.raises(HTTPException) as exc:
        build_range_bundle(mock_engine, code="005930", from_date="20260101", to_date="20260201", bucket_ms=60_000)
    assert exc.value.status_code == 400
    assert "30 days" in str(exc.value.detail)


def test_build_range_bundle_raises_404_on_empty_inventory():
    from fastapi import HTTPException
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    mock_engine.list_stock_dates_in_range.return_value = []
    with pytest.raises(HTTPException) as exc:
        build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260520", bucket_ms=60_000)
    assert exc.value.status_code == 404


def test_build_range_bundle_rejects_invalid_bucket_ms():
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    with pytest.raises(ValueError, match="bucket_ms"):
        build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260512", bucket_ms=42_000)
