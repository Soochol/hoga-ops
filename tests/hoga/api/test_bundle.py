"""Tests for hoga.api.bundle module."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import duckdb
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


def test_build_volume_profile_range_single_date_uses_multi_file_glob(tmp_path):
    """One-date range: still calls read_parquet with a list parameter."""
    from hoga.api.bundle import build_volume_profile_range

    mock_engine = MagicMock()
    def _mk(d, c, src="hogaplay"):
        # Real dir + empty trades.parquet so build_volume_profile_range's
        # existence-guard passes (ADR-0043: missing trades.parquet now skipped).
        dd = tmp_path / c / d
        dd.mkdir(parents=True, exist_ok=True)
        (dd / "trades.parquet").touch()
        return dd
    mock_engine.parquet_dir.side_effect = _mk
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


def test_build_volume_profile_range_multi_date_unions_paths(tmp_path):
    """Multi-date range: paths list contains every date's trades.parquet."""
    from hoga.api.bundle import build_volume_profile_range

    mock_engine = MagicMock()
    def _mk(d, c, src="hogaplay"):
        dd = tmp_path / c / d
        dd.mkdir(parents=True, exist_ok=True)
        (dd / "trades.parquet").touch()
        return dd
    mock_engine.parquet_dir.side_effect = _mk
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
# Fix #2: top-edge bin clamped into last bin (price_max volume not dropped)
# ---------------------------------------------------------------------------


def _write_trades_parquet(path, rows: list[tuple[int, int, int]]) -> None:
    """Write a minimal trades.parquet: each row is (ts_ms, price, qty).
    Fills other required Trade columns with zeros."""
    from hoga.tables.trades import Trade, write_parquet
    trades = [
        Trade(
            ts_ms=ts_ms, seq=i, price=price, change_pct=0.0, qty=qty, side=0,
            cum_vol=0, cum_trades=0, low_so_far=0, high_so_far=0, net_pressure=0,
            unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0,
        )
        for i, (ts_ms, price, qty) in enumerate(rows, start=1)
    ]
    write_parquet(trades, path)


def test_build_volume_profile_range_top_edge_bin_not_dropped(tmp_path):
    """Trade at price_max must land in the top dense bin (vp_bins-1), not vanish.

    Setup: price_min=100, price_max=200, vp_bins=2 → bin_width=50.
    - price 100 → bin 0 (qty 15)
    - price 200 → FLOOR((200-100)/50)=2, folded into vp_bins-1=1 (qty 30)
    Before the fix the fold was absent and the 30 qty was silently dropped.
    """
    from hoga.api.bundle import build_volume_profile_range

    p = tmp_path / "trades.parquet"
    _write_trades_parquet(p, [
        (90_000_100, 100, 10),
        (90_000_200, 100, 5),
        (90_000_300, 200, 30),  # price_max — previously dropped
    ])

    mock_engine = MagicMock()
    mock_engine.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    mock_engine.conn = duckdb.connect()

    out = build_volume_profile_range(
        mock_engine, code="005930",
        dates_with_sources=[("20260512", "hogaplay")],
        vp_bins=2,
    )

    assert out.bin_count == 2
    assert out.price_min == 100
    assert out.price_max == 200
    qty_by_price_low = {b.price_low: b.qty for b in out.bins}
    assert qty_by_price_low[100] == 15  # bin 0: prices at 100
    assert qty_by_price_low[150] == 30  # bin 1 (top): price_max 200 folded in


def test_build_volume_profile_slice_top_edge_bin_not_dropped(tmp_path):
    """Trade at price_max must land in the top dense bin (vp_bins-1), not vanish.

    build_volume_profile_slice receives price_min/price_max externally (from candles),
    passed as price_min/price_max kwargs to bypass the candles query.
    Setup: price_lo=100, price_hi=200, vp_bins=2 → bin_width=50.
    - price 100 → bin 0 (qty 15)
    - price 200 → FLOOR((200-100)/50)=2, folded into vp_bins-1=1 (qty 30)
    """
    from hoga.api.bundle import build_volume_profile_slice

    trades_path = tmp_path / "trades.parquet"
    _write_trades_parquet(trades_path, [
        (90_000_100, 100, 10),
        (90_000_200, 100, 5),
        (90_000_300, 200, 30),  # price_hi — previously dropped
    ])
    # candles.parquet must exist for the existence guard (even if not queried
    # when price_min/price_max are supplied explicitly).
    (tmp_path / "candles.parquet").touch()

    mock_engine = MagicMock()
    mock_engine.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    mock_engine.conn = duckdb.connect()

    out = build_volume_profile_slice(
        mock_engine, code="005930", date="20260512",
        price_min=100, price_max=200, vp_bins=2,
    )

    assert out.bin_count == 2
    assert out.price_min == 100
    assert out.price_max == 200
    qty_by_price_low = {b.price_low: b.qty for b in out.bins}
    assert qty_by_price_low[100] == 15  # bin 0: prices at 100
    assert qty_by_price_low[150] == 30  # bin 1 (top): price_hi 200 folded in


# ---------------------------------------------------------------------------
# build_range_bundle (ADR-0013/0014): partial-inventory, segments
# ---------------------------------------------------------------------------

def _patch_slice_builders(bundle_mod, bucket_ms: int = 60_000, *, patch_ask_peak: bool = True):
    """Return a list of context managers that stub every per-slice builder.

    ``patch_ask_peak`` (default True) also stubs build_ask_peak_slice → None so the
    general bundle tests (MagicMock engine, no real parquet/conn) don't exercise it.
    The dedicated ask_peak tests pass False to run build_ask_peak_slice for real."""
    from unittest.mock import patch
    from hoga.api.models import (
        FillStrength, QuoteRatio, VolumeProfile,
    )
    qr = QuoteRatio(bucket_ms=bucket_ms, points=[])
    fs = FillStrength(bucket_ms=bucket_ms, points=[])
    vp = VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])
    patches = [
        patch.object(bundle_mod, "build_candles_slice", return_value=[]),
        patch.object(bundle_mod, "downsample_candles", return_value=[]),
        patch.object(bundle_mod, "build_quote_ratio_slice", return_value=qr),
        patch.object(bundle_mod, "build_fill_strength_slice", return_value=fs),
        patch.object(bundle_mod, "build_volume_profile_slice", return_value=vp),
    ]
    if patch_ask_peak:
        patches.append(patch.object(bundle_mod, "build_ask_peak_slice", return_value=None))
    return patches


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


def test_bundle_open_ms_zero_served_and_normalized():
    """open_ms=0 upstream sentinel: segment must be served (not excluded),
    session_open_ms must be KRX 09:00 (not midnight), and the
    meta.open_ms_normalized warn must appear exactly once (ADR-0063)."""
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile
    from hoga.api.timeenc import hhmmssms_to_unix_ms

    DATE = "20260520"
    eng = _engine_with_meta_for_dates([DATE])
    # open=0 is the upstream sentinel; close and completeness are healthy.
    eng.get_meta.return_value = _meta(open_ms=0)

    patches = _patch_slice_builders(bundle_mod) + [
        patch.object(bundle_mod, "build_volume_profile_range",
                     return_value=VolumeProfile(bin_count=0, price_min=0,
                                                price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(eng, code="005930",
                                from_date=DATE, to_date=DATE,
                                bucket_ms=60_000)

    # 1) Not excluded; present in segments.
    assert [s.date for s in rb.segments] == [DATE]
    assert DATE not in [e.date for e in rb.excluded_dates]

    # 2) session_open_ms == KRX 09:00 unix (NOT midnight).
    seg = rb.segments[0]
    assert seg.session_open_ms == hhmmssms_to_unix_ms(DATE, 90_000_000)
    assert seg.session_open_ms != hhmmssms_to_unix_ms(DATE, 0)

    # 3) The warn tag appears exactly once — guards against double-emit.
    warns = [w for w in rb.data_warnings if w.date == DATE]
    assert sum(
        1 for w in warns for v in w.warnings
        if v.invariant_id == "meta.open_ms_normalized"
    ) == 1


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


def test_build_range_bundle_includes_ask_peak_for_today(monkeypatch, tmp_path) -> None:
    """오늘(today_kst) 날짜에 snapshots.parquet(연속거래 + 단일 큰 매도단계)를 깔고
    build_range_bundle 호출. ask_peak가 그 최대단계 price/qty로 채워지는지."""
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    FIXTURE_DATE = "20260613"
    EXPECTED_QTY = 5000
    EXPECTED_PRICE = 25100

    # today-pin no longer gates ask_peak (computed from the most-recent segment);
    # kept harmless (still used by the indicator cache, which is patched out here).
    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: FIXTURE_DATE)

    # Build a real snapshots.parquet with continuous-trading rows.
    # Bids filled [100]*10 satisfies _BID_DEEP_SUM > 0 (continuous trading predicate).
    z = tuple([0] * 10)
    bp = tuple([24950 - 50 * i for i in range(10)])
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1),
        ask_d=z,
        bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_path = tmp_path / "snapshots.parquet"
    snapshots_write_parquet([ob], snapshots_path)
    # Also create a candles.parquet stub (needed by some guards).
    (tmp_path / "candles.parquet").touch()

    eng = _engine_with_meta_for_dates([FIXTURE_DATE])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()
    eng.indicators_cache = None  # ask_peak 캐시 미사용(MagicMock 회피); per-day 계산만 검증

    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False) + [
        patch.object(bundle_mod, "build_volume_profile_range",
                     return_value=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        bundle = build_range_bundle(eng, code="005930", from_date=FIXTURE_DATE, to_date=FIXTURE_DATE, bucket_ms=60000)

    assert len(bundle.ask_peaks) == 1
    p = bundle.ask_peaks[0]
    assert p.date == FIXTURE_DATE
    assert p.qty == EXPECTED_QTY
    assert p.price == EXPECTED_PRICE
    # t_ms is unix ms — must be positive and in a sane range
    assert p.t_ms > 0


def test_build_range_bundle_ask_peaks_includes_past_day_even_when_not_today(monkeypatch, tmp_path) -> None:
    """범위가 과거일만(오늘 미포함)이어도 그날 항목이 ask_peaks에 들어간다(per-day).
    (이전엔 '달력상 오늘'에만 계산해 휴장·과거일 조회 시 항상 비어 선이 안 보였다 — 회귀 가드.)"""
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    FIXTURE_DATE = "20260612"  # a past date (NOT today)

    # Pin today to a DIFFERENT date — the new logic computes ask_peak from the
    # most-recent SEGMENT, not from "today", so this no longer suppresses it.
    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: "20260613")

    z = tuple([0] * 10)
    bp = tuple([24950 - 50 * i for i in range(10)])
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1),
        ask_d=z,
        bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_path = tmp_path / "snapshots.parquet"
    snapshots_write_parquet([ob], snapshots_path)
    (tmp_path / "candles.parquet").touch()

    eng = _engine_with_meta_for_dates([FIXTURE_DATE])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()
    eng.indicators_cache = None  # ask_peak 캐시 미사용(MagicMock 회피); per-day 계산만 검증

    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False) + [
        patch.object(bundle_mod, "build_volume_profile_range",
                     return_value=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        bundle = build_range_bundle(eng, code="005930", from_date=FIXTURE_DATE, to_date=FIXTURE_DATE, bucket_ms=60000)

    # 과거일도 그날 항목이 ask_peaks에 들어간다(거래일별).
    assert len(bundle.ask_peaks) == 1
    assert bundle.ask_peaks[0].date == FIXTURE_DATE
    assert bundle.ask_peaks[0].qty == 5000
    assert bundle.ask_peaks[0].price == 25100


def test_build_range_bundle_ask_peaks_per_day(monkeypatch, tmp_path) -> None:
    """다일 범위: 각 거래일이 자기 최대벽을 ask_peaks에 가진다(per-day) — 날짜별 독립."""
    import contextlib
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import VolumeProfile
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: "20260613")
    z = tuple([0] * 10)
    bp = tuple([24950 - 50 * i for i in range(10)])

    def mk_ob(price_at_max: int, qty_at_max: int) -> Orderbook:
        ask_p = (price_at_max, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450)
        ask_q = (qty_at_max, 200, 30, 40, 5, 6, 7, 8, 9, 1)
        return Orderbook(ts_ms=90100000, seq=1, ask_p=ask_p, ask_q=ask_q, ask_d=z,
                         bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
                         tot_ask=sum(ask_q), tot_ask_d=0, tot_bid=1000, tot_bid_d=0)

    dirs = {}
    for d, price, qty in (("20260610", 30000, 9000), ("20260611", 28000, 3000)):
        dd = tmp_path / d
        dd.mkdir()
        snapshots_write_parquet([mk_ob(price, qty)], dd / "snapshots.parquet")
        (dd / "candles.parquet").touch()
        dirs[d] = dd

    eng = _engine_with_meta_for_dates(["20260610", "20260611"])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": dirs[d]
    eng.conn = duckdb.connect()
    eng.indicators_cache = None  # ask_peak 캐시 미사용(MagicMock 회피); per-day 계산만 검증

    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False) + [
        patch.object(bundle_mod, "build_volume_profile_range",
                     return_value=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])),
    ]
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        bundle = build_range_bundle(eng, code="005930", from_date="20260610", to_date="20260611", bucket_ms=60000)

    # 거래일별: 두 날 모두 각자의 최대벽이 ask_peaks에 — 06-10=9000@30000, 06-11=3000@28000.
    by_date = {p.date: p for p in bundle.ask_peaks}
    assert set(by_date) == {"20260610", "20260611"}
    assert by_date["20260610"].price == 30000 and by_date["20260610"].qty == 9000
    assert by_date["20260611"].price == 28000 and by_date["20260611"].qty == 3000


def test_build_ask_peak_slice_caches_past_days(tmp_path) -> None:
    """과거일은 indicators_cache로 1회만 계산(불변) — 두번째 호출은 재스캔 안 함. 오늘은 미캐시."""
    from unittest.mock import MagicMock
    from hoga.api.bundle import build_ask_peak_slice
    from hoga.api.past_indicators_cache import PastIndicatorsCache
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    z = tuple([0] * 10)
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple([24950 - 50 * i for i in range(10)]), bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_write_parquet([ob], tmp_path / "snapshots.parquet")
    cache = PastIndicatorsCache(tmp_path / "cachedir")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()

    p1 = build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                              source="hogaplay", cache=cache, today_kst="20260613")
    assert p1 is not None and p1.qty == 5000 and p1.date == "20260610"
    assert p1.max_qty == 5000 and p1.max_price == 25100
    assert p1.max_t_ms == p1.t_ms
    assert cache.has_ask_peak("005930", "20260610", "hogaplay", 60_000)

    # 두번째 호출: parquet_dir이 깨져도 캐시에서 반환(재스캔 안 함).
    eng.parquet_dir.side_effect = AssertionError("should not recompute a cached past day")
    p2 = build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                              source="hogaplay", cache=cache, today_kst="20260613")
    assert p2 == p1

    # 오늘 날짜는 cacheable 아님 → 캐시에 저장하지 않는다(매번 재계산해 ratchet seed 갱신).
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    build_ask_peak_slice(eng, code="005930", date="20260613", bucket_ms=60_000,
                         source="hogaplay", cache=cache, today_kst="20260613")
    assert not cache.has_ask_peak("005930", "20260613", "hogaplay", 60_000)


def test_build_ask_peak_slice_cache_key_is_bucket_ms_aware(tmp_path) -> None:
    """버킷 대표 위에서 집계하므로 분봉(bucket_ms)이 다르면 결과도 다를 수 있다 — 캐시 키에
    bucket_ms가 포함돼야 60s 결과가 180s 조회에 잘못 재사용되지 않는다(회귀 가드)."""
    from unittest.mock import MagicMock
    from hoga.api.bundle import build_ask_peak_slice
    from hoga.api.past_indicators_cache import PastIndicatorsCache
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    z = tuple([0] * 10)
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple([24950 - 50 * i for i in range(10)]), bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_write_parquet([ob], tmp_path / "snapshots.parquet")
    cache = PastIndicatorsCache(tmp_path / "cachedir")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()

    build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                         source="hogaplay", cache=cache, today_kst="20260613")
    assert cache.has_ask_peak("005930", "20260610", "hogaplay", 60_000)
    # 다른 bucket_ms는 별개 키 — 캐시 미스라 재계산해야 한다(parquet_dir 다시 호출됨).
    assert not cache.has_ask_peak("005930", "20260610", "hogaplay", 180_000)
    build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=180_000,
                         source="hogaplay", cache=cache, today_kst="20260613")
    assert cache.has_ask_peak("005930", "20260610", "hogaplay", 180_000)


def test_build_ask_peak_slice_wires_intra_max(tmp_path) -> None:
    """build_ask_peak_slice가 close 변종과 틱-max 변종(max_*)을 모두 배선한다."""
    from unittest.mock import MagicMock
    from hoga.api.bundle import build_ask_peak_slice
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    z = tuple([0] * 10)
    ap = tuple(25000 + 50 * i for i in range(10))
    bp = tuple(24950 - 50 * i for i in range(10))
    bq = tuple([100] * 10)
    spike = Orderbook(ts_ms=90010000, seq=1, ask_p=ap, ask_q=(5000,) + (1,) * 9, ask_d=z,
                      bid_p=bp, bid_q=bq, bid_d=z, tot_ask=5009, tot_ask_d=0, tot_bid=1000, tot_bid_d=0)
    rep = Orderbook(ts_ms=90055000, seq=2, ask_p=ap, ask_q=(1000,) + (1,) * 9, ask_d=z,
                    bid_p=bp, bid_q=bq, bid_d=z, tot_ask=1009, tot_ask_d=0, tot_bid=1000, tot_bid_d=0)
    snapshots_write_parquet([spike, rep], tmp_path / "snapshots.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()

    p = build_ask_peak_slice(
        eng, code="005930", date="20260610", bucket_ms=60_000,
        source="hogaplay", session_open_ms=90000000, session_close_ms=153000000,
    )
    assert p is not None
    assert p.qty == 1000 and p.price == 25000
    assert p.max_qty == 5000 and p.max_price == 25000
    assert p.max_t_ms < p.t_ms


def test_build_ask_peak_slice_wires_all_price_peak(tmp_path) -> None:
    """과거 AskPeak은 체결가격 기준과 미체결 포함 최대벽을 함께 싣는다."""
    from unittest.mock import MagicMock
    from hoga.api.bundle import build_ask_peak_slice
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    z = tuple([0] * 10)
    ap = (25000, 26000, 27000, 27100, 27200, 27300, 27400, 27500, 27600, 27700)
    bp = tuple(24950 - 50 * i for i in range(10))
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=ap, ask_q=(1000, 9000, 100, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=10170, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    tr = Trade(
        ts_ms=90050000, seq=1, price=25000, change_pct=0, qty=1, side=1,
        cum_vol=1, cum_trades=1, low_so_far=25000, high_so_far=25000,
        net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
    )
    snapshots_write_parquet([ob], tmp_path / "snapshots.parquet")
    trades_write_parquet([tr], tmp_path / "trades.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()

    p = build_ask_peak_slice(
        eng, code="005930", date="20260610", bucket_ms=60_000,
        source="hogaplay", session_open_ms=90000000, session_close_ms=153000000,
    )

    assert p is not None
    assert p.price == 25000 and p.qty == 1000
    assert p.all_price == 26000 and p.all_qty == 9000


def test_range_bundle_ask_peak_field_defaults_none() -> None:
    from hoga.api.models import AskPeak, RangeBundle
    from hoga.api.models import QuoteRatio, FillStrength, VolumeProfile
    b = RangeBundle(
        code="005930", from_date="20260613", to_date="20260613", bucket_ms=60000,
        segments=[], candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60000, points=[]),
        fill_strength=FillStrength(bucket_ms=60000, points=[]),
        volume_profile_range=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[]),
        volume_profile_by_day=[],
    )
    assert b.ask_peaks == []  # 기본 빈 리스트 — 기존 클라 무영향
    b2 = b.model_copy(update={"ask_peaks": [
        AskPeak(date="20260613", price=25100, qty=5000, t_ms=1,
                max_price=25100, max_qty=5000, max_t_ms=1)
    ]})
    assert b2.ask_peaks[0].price == 25100 and b2.ask_peaks[0].date == "20260613"
