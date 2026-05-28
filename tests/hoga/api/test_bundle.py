"""Tests for hoga.api.bundle module."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from hoga.api.bundle import downsample_candles
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
# build_volume_profile_range (ADR-0013): multi-date trades unioned into one profile
# ---------------------------------------------------------------------------

def test_build_volume_profile_range_empty_dates_returns_empty():
    from hoga.api.bundle import build_volume_profile_range
    mock_engine = MagicMock()
    out = build_volume_profile_range(mock_engine, code="005930", dates_with_sources=[])
    assert out.bin_count == 0
    assert out.bins == []


def test_build_volume_profile_range_single_date_uses_multi_file_glob():
    """One-date range: still calls read_parquet with a list parameter."""
    from hoga.api.bundle import build_volume_profile_range

    mock_engine = MagicMock()
    mock_engine.parquet_dir.side_effect = lambda d, c, src="hogaplay": __import__("pathlib").Path(f"/data/{c}/{d}")
    # First execute (MIN/MAX): returns (100, 200)
    # Second execute (GROUP BY bin): returns rows like [(0, 10), (1, 20), ...]
    mock_engine.conn.execute.side_effect = [
        MagicMock(fetchone=lambda: (100, 200)),
        MagicMock(fetchall=lambda: [(0, 10), (1, 20)]),
    ]

    out = build_volume_profile_range(mock_engine, code="005930", dates_with_sources=[("20260512", "hogaplay")])

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
    mock_engine.parquet_dir.side_effect = lambda d, c, src="hogaplay": __import__("pathlib").Path(f"/data/{c}/{d}")
    mock_engine.conn.execute.side_effect = [
        MagicMock(fetchone=lambda: (100, 200)),
        MagicMock(fetchall=lambda: [(0, 10), (1, 20), (2, 30)]),
    ]

    out = build_volume_profile_range(mock_engine, code="005930", dates_with_sources=[("20260512", "hogaplay"), ("20260513", "hogaplay"), ("20260514", "hogaplay")])

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
    mock_engine.parquet_dir.side_effect = lambda d, c, src="hogaplay": __import__("pathlib").Path(f"/data/{c}/{d}")
    mock_engine.conn.execute.return_value = MagicMock(fetchone=lambda: (None, None))

    out = build_volume_profile_range(mock_engine, code="005930", dates_with_sources=[("20260512", "hogaplay")])
    assert out.bin_count == 0
    assert out.bins == []


# ---------------------------------------------------------------------------
# build_range_bundle (ADR-0013/0014): partial-inventory, segments
# ---------------------------------------------------------------------------

def _patch_slice_builders(bundle_mod, bucket_ms: int = 60_000):
    """Return a list of context managers that stub every per-slice builder."""
    from unittest.mock import patch
    from hoga.api.models import (
        FillStrength, QuoteRatio, VolumeProfile,
    )
    qr = QuoteRatio(bucket_ms=bucket_ms, points=[])
    fs = FillStrength(bucket_ms=bucket_ms, points=[])
    vp = VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])
    return [
        patch.object(bundle_mod, "build_candles_slice", return_value=[]),
        patch.object(bundle_mod, "downsample_candles", return_value=[]),
        patch.object(bundle_mod, "build_quote_ratio_slice", return_value=qr),
        patch.object(bundle_mod, "build_fill_strength_slice", return_value=fs),
        patch.object(bundle_mod, "build_volume_profile_slice", return_value=vp),
    ]


def _engine_with_meta_for_dates(dates):
    """MagicMock engine with list_stock_dates_in_range + get_meta wired."""
    from unittest.mock import MagicMock
    eng = MagicMock()
    eng.list_stock_dates_in_range.return_value = dates
    eng.get_meta.return_value = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
    }
    return eng


def test_build_range_bundle_single_day_yields_one_segment():
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    patches = _patch_slice_builders(bundle_mod) + [
        patch.object(bundle_mod, "build_volume_profile_range", return_value=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260512", bucket_ms=60_000)

    assert len(rb.segments) == 1
    assert rb.segments[0].date == "20260512"
    assert rb.bucket_ms == 60_000
    assert len(rb.volume_profile_by_day) == 1


def test_build_range_bundle_multi_day_concatenates_per_segment_lists():
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile

    mock_engine = _engine_with_meta_for_dates(["20260512", "20260513"])
    patches = _patch_slice_builders(bundle_mod) + [
        patch.object(bundle_mod, "build_volume_profile_range", return_value=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260513", bucket_ms=60_000)

    assert len(rb.segments) == 2
    assert [s.date for s in rb.segments] == ["20260512", "20260513"]
    assert len(rb.volume_profile_by_day) == 2


def test_build_range_bundle_rejects_from_gt_to():
    from fastapi import HTTPException
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    with pytest.raises(HTTPException) as exc:
        build_range_bundle(mock_engine, code="005930", from_date="20260520", to_date="20260512", bucket_ms=60_000)
    assert exc.value.status_code == 400


def test_build_range_bundle_returns_empty_on_empty_inventory():
    """Spec 2026-05-27 §4.3: no captured Stock-Date → empty bundle (not 404)."""
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    mock_engine.list_stock_dates_in_range.return_value = []
    rb = build_range_bundle(
        mock_engine, code="005930", from_date="20260512", to_date="20260520", bucket_ms=60_000
    )
    assert rb.segments == []
    assert rb.candles == []
    assert rb.quote_ratio.points == []
    assert rb.fill_strength.points == []
    assert rb.excluded_dates == []
    assert rb.code == "005930"
    assert rb.from_date == "20260512"
    assert rb.to_date == "20260520"
    assert rb.bucket_ms == 60_000


def test_build_range_bundle_rejects_invalid_bucket_ms():
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    with pytest.raises(ValueError, match="bucket_ms"):
        build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260512", bucket_ms=42_000)


# --- ADR-0020 / Invariants ---


def _meta(
    *,
    open_ms: int = 90_000_000,
    close_ms: int = 153_000_000,
    complete: bool = True,
    partial: bool = False,
    pages: int = 100,
    events: int = 80,
) -> dict:
    """Healthy default meta dict; override fields per test."""
    return {
        "regular_session_open_ms": open_ms,
        "regular_session_close_ms": close_ms,
        "collection_complete": complete,
        "is_partial": partial,
        "pages_collected": pages,
        "total_unique_events": events,
    }


def test_build_range_bundle_skips_invalid_and_surfaces_in_excluded():
    """Bad Stock-Date (close=0 → INVALID) is dropped from segments
    and appears under excluded_dates with its violations."""
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile

    eng = _engine_with_meta_for_dates(["20260520", "20260518", "20260521"])
    # Per-date meta: 5/18 is broken (close_ms=0), others healthy.
    metas = {
        "20260520": _meta(),
        "20260518": _meta(close_ms=0),
        "20260521": _meta(),
    }
    eng.get_meta.side_effect = lambda date, _code, _source="hogaplay": metas[date]

    patches = _patch_slice_builders(bundle_mod) + [
        patch.object(bundle_mod, "build_volume_profile_range",
                     return_value=VolumeProfile(bin_count=0, price_min=0,
                                                price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(eng, code="005930",
                                from_date="20260520", to_date="20260521",
                                bucket_ms=60_000)

    # Only the 2 healthy dates are in segments.
    assert [s.date for s in rb.segments] == ["20260520", "20260521"]
    # The bad date is surfaced.
    assert len(rb.excluded_dates) == 1
    assert rb.excluded_dates[0].date == "20260518"
    fired_ids = {v.invariant_id for v in rb.excluded_dates[0].violations}
    assert "meta.close_after_open" in fired_ids
    # No warn-severity violations in this fixture.
    assert rb.data_warnings == []


def test_build_range_bundle_surfaces_warn_without_excluding():
    """Healthy shape but low unique-event ratio → warn only, segment included."""
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile

    eng = _engine_with_meta_for_dates(["20260520"])
    # Healthy bounds, but pages=4132 events=1553 → ratio invariant fires (warn).
    eng.get_meta.return_value = _meta(pages=4132, events=1553)

    patches = _patch_slice_builders(bundle_mod) + [
        patch.object(bundle_mod, "build_volume_profile_range",
                     return_value=VolumeProfile(bin_count=0, price_min=0,
                                                price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(eng, code="005930",
                                from_date="20260520", to_date="20260520",
                                bucket_ms=60_000)

    assert len(rb.segments) == 1
    assert rb.excluded_dates == []
    assert len(rb.data_warnings) == 1
    assert rb.data_warnings[0].date == "20260520"
    fired_ids = {v.invariant_id for v in rb.data_warnings[0].warnings}
    assert "collection.unique_events_ratio" in fired_ids


def test_build_range_bundle_empty_when_all_dates_excluded():
    """Spec 2026-05-27 §4.3: every Stock-Date INVALID → return empty bundle
    with excluded_dates populated (not 404)."""
    from hoga.api.bundle import build_range_bundle

    eng = _engine_with_meta_for_dates(["20260518"])
    eng.get_meta.return_value = _meta(close_ms=0)

    rb = build_range_bundle(
        eng, code="003490", from_date="20260518", to_date="20260518", bucket_ms=60_000
    )
    assert rb.segments == []
    assert len(rb.excluded_dates) == 1
    assert rb.excluded_dates[0].date == "20260518"


def test_build_range_bundle_excludes_real_5_18_003490_case():
    """Regression: the literal production payload that motivated ADR-0020 must
    not appear in segments. Both signals fire together — collection_complete=False
    AND close_ms=0 — and an earlier priority-ordering bug let this pass through
    as CLIENT_INCOMPLETE (which build_range_bundle does NOT skip). After the
    INVALID > CLIENT_INCOMPLETE flip, the date must be excluded."""
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile

    eng = _engine_with_meta_for_dates(["20260520", "20260518"])
    # Healthy 5/20 + the exact 5/18/003490 production shape (close=0 AND
    # collection_complete=False, stagnation_abort).
    metas = {
        "20260520": _meta(),
        "20260518": _meta(close_ms=0, complete=False),
    }
    eng.get_meta.side_effect = lambda date, _code, _source="hogaplay": metas[date]

    patches = _patch_slice_builders(bundle_mod) + [
        patch.object(bundle_mod, "build_volume_profile_range",
                     return_value=VolumeProfile(bin_count=0, price_min=0,
                                                price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(eng, code="003490",
                                from_date="20260518", to_date="20260520",
                                bucket_ms=60_000)

    # 5/18 must be excluded — virtual axis bug repeats otherwise.
    assert [s.date for s in rb.segments] == ["20260520"]
    assert len(rb.excluded_dates) == 1
    assert rb.excluded_dates[0].date == "20260518"
