from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import duckdb
import pyarrow.parquet as pq
import pytest

from hoga.tables.snapshots import (
    PARQUET_SCHEMA,
    PARSERS,
    ApiOrderbookSnapshot,
    Orderbook,
    SnapshotValidationError,
    query_at,
    query_first_ts,
    query_time_bounds,
    validate,
    write_parquet,
)


def _ob_parts(ts_ms: int = 90000435, seq: int = 847) -> list[str]:
    header = ["2", "2", "835", str(seq), str(ts_ms), "32400435"]
    ask_p = ["25700", "25750", "25800"] + ["0"] * 7
    ask_q = ["657", "72", "111"] + ["0"] * 7
    ask_d = ["0"] * 10
    bid_p = ["25650", "25600", "25550"] + ["0"] * 7
    bid_q = ["2776", "4193", "4259"] + ["0"] * 7
    bid_d = ["0"] * 10
    totals = ["840", "-2387", "11228", "6383"]
    return header + ask_p + ask_q + ask_d + bid_p + bid_q + bid_d + totals


def test_parser_registered_for_event_type_2() -> None:
    assert set(PARSERS.keys()) == {2}


def test_parse_orderbook() -> None:
    ob = PARSERS[2](_ob_parts())
    assert isinstance(ob, Orderbook)
    assert ob.ts_ms == 90000435
    assert ob.seq == 847
    assert ob.ask_p[:3] == (25700, 25750, 25800)
    assert ob.bid_p[:3] == (25650, 25600, 25550)
    assert ob.tot_ask == 840
    assert ob.tot_bid == 11228


def test_parquet_schema_has_flat_level_columns() -> None:
    names = PARQUET_SCHEMA.names
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, 11):
            assert f"{prefix}{i}" in names, f"missing {prefix}{i}"
    for total in ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d"):
        assert total in names


def test_write_parquet_roundtrip(tmp_path: Path) -> None:
    ob1 = PARSERS[2](_ob_parts(ts_ms=90000435, seq=847))
    ob2 = PARSERS[2](_ob_parts(ts_ms=90001000, seq=848))
    out = tmp_path / "snapshots.parquet"
    write_parquet([ob2, ob1], out)  # passed out of order
    tbl = pq.read_table(out)
    assert tbl.num_rows == 2
    assert tbl.column("ts_ms").to_pylist() == [90000435, 90001000]  # writer sorts ascending
    assert tbl.column("ask_p1").to_pylist() == [25700, 25700]


def test_read_parquet_inverts_write_parquet(tmp_path: Path) -> None:
    """read_parquet must reassemble the exact Orderbook instances write_parquet
    persisted — verifies the flat-schema round trip is closed at the module
    boundary so callers (like cli._run_series_for) don't reimplement it."""
    from hoga.tables.snapshots import read_parquet

    ob1 = PARSERS[2](_ob_parts(ts_ms=90000435, seq=847))
    ob2 = PARSERS[2](_ob_parts(ts_ms=90001000, seq=848))
    out = tmp_path / "snapshots.parquet"
    write_parquet([ob2, ob1], out)

    rows = read_parquet(out)
    assert len(rows) == 2
    # Writer sorts by ts_ms — verify ordering preserved on read.
    assert [o.ts_ms for o in rows] == [90000435, 90001000]
    # Tuple fields must round-trip back to tuples (not lists).
    assert isinstance(rows[0].ask_p, tuple)
    assert len(rows[0].ask_p) == 10
    # Full Orderbook equality: read result must equal original (sorted) input.
    assert rows == [ob1, ob2]


def test_query_at_returns_api_model_for_latest_before(tmp_path: Path) -> None:
    obs = [
        PARSERS[2](_ob_parts(ts_ms=t, seq=i))
        for i, t in enumerate([90000000, 90001000, 90002000], start=1)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    api = query_at(con, path=out, t_ms=90001500)
    assert isinstance(api, ApiOrderbookSnapshot)
    assert api.ts_ms == 90001000
    assert [lvl.price for lvl in api.ask] == [25700, 25750, 25800, 0, 0, 0, 0, 0, 0, 0]
    assert len(api.ask) == 10
    assert len(api.bid) == 10
    # Wire Model drops delta columns (ADR-0004) — they stay on the Entity.
    assert not hasattr(api, "ask_d") and not hasattr(api, "bid_d")


def test_query_at_returns_none_before_first(tmp_path: Path) -> None:
    obs = [PARSERS[2](_ob_parts(ts_ms=90000000, seq=1))]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    assert query_at(con, path=out, t_ms=80000000) is None


def test_query_time_bounds(tmp_path: Path) -> None:
    obs = [
        PARSERS[2](_ob_parts(ts_ms=t, seq=i))
        for i, t in enumerate([90000000, 90001000, 90002000], start=1)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    assert query_time_bounds(con, path=out) == (90000000, 90002000)


def test_query_time_bounds_empty(tmp_path: Path) -> None:
    con = duckdb.connect()
    missing = tmp_path / "missing.parquet"
    write_parquet([], missing)
    assert query_time_bounds(con, path=missing) is None


def test_query_first_ts(tmp_path: Path) -> None:
    obs = [
        PARSERS[2](_ob_parts(ts_ms=t, seq=i)) for i, t in enumerate([90000000, 90001000], start=1)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    assert query_first_ts(con, path=out) == 90000000
    empty = tmp_path / "empty.parquet"
    write_parquet([], empty)
    assert query_first_ts(con, path=empty) is None


def test_validate_passes_for_correctly_ordered_book() -> None:
    obs = [PARSERS[2](_ob_parts())]
    validate(obs)  # should not raise


def test_validate_raises_when_ask_prices_not_sorted() -> None:
    base = PARSERS[2](_ob_parts())
    bad_ask = (25700, 25800, 25750) + tuple([0] * 7)
    broken = replace(base, ask_p=bad_ask)
    with pytest.raises(SnapshotValidationError, match="ask prices not sorted"):
        validate([broken])


def test_validate_raises_when_bid_prices_not_sorted() -> None:
    base = PARSERS[2](_ob_parts())
    bad_bid = (25650, 25550, 25600) + tuple([0] * 7)
    broken = replace(base, bid_p=bad_bid)
    with pytest.raises(SnapshotValidationError, match="bid prices not sorted"):
        validate([broken])


# ---------------------------------------------------------------------------
# query_bucketed_ratio (ADR-0001): bucketed bid/ask depth totals, native time
# ---------------------------------------------------------------------------


def _ob(*, ts_ms: int, seq: int, ask_q: tuple[int, ...], bid_q: tuple[int, ...]) -> Orderbook:
    """Build an Orderbook with controlled per-level qty arrays.

    Only ask_q / bid_q matter for query_bucketed_ratio (it SUMs the 10 levels);
    prices/deltas/totals are filler. Pads/truncates the given tuples to 10.
    """
    def _pad(t: tuple[int, ...]) -> tuple[int, ...]:
        return (tuple(t) + (0,) * 10)[:10]

    return Orderbook(
        ts_ms=ts_ms, seq=seq,
        ask_p=tuple(range(1, 11)), ask_q=_pad(ask_q), ask_d=(0,) * 10,
        bid_p=tuple(range(10, 0, -1)), bid_q=_pad(bid_q), bid_d=(0,) * 10,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )


def test_query_bucketed_ratio_sums_all_ten_levels(tmp_path: Path) -> None:
    """ask_total / bid_total are the SUM across all 10 ask_q / bid_q columns."""
    from hoga.tables.snapshots import query_bucketed_ratio

    obs = [_ob(ts_ms=90_000_100, seq=1, ask_q=(10, 20, 30), bid_q=(5, 5, 5, 5))]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_ratio(con, path=out, bucket_ms=1000)
    assert len(rows) == 1
    assert rows[0].ask_total == 60   # 10+20+30
    assert rows[0].bid_total == 20   # 5*4


def test_query_bucketed_ratio_takes_last_snapshot_in_bucket(tmp_path: Path) -> None:
    """Within one bucket, the LAST snapshot (max ts_ms) wins — mirrors the
    ROW_NUMBER() OVER (... ORDER BY ts_ms DESC) rn=1 selection."""
    from hoga.tables.snapshots import query_bucketed_ratio

    # All three in the same 1000ms bucket (09:00:00.x -> intra 32_400_0xx).
    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(1,), bid_q=(1,)),
        _ob(ts_ms=90_000_500, seq=2, ask_q=(2,), bid_q=(2,)),
        _ob(ts_ms=90_000_900, seq=3, ask_q=(99,), bid_q=(77,)),  # latest in bucket
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_ratio(con, path=out, bucket_ms=1000)
    assert len(rows) == 1
    assert rows[0].ask_total == 99
    assert rows[0].bid_total == 77


def test_query_bucketed_ratio_buckets_on_linear_minute_boundary(tmp_path: Path) -> None:
    """Two snapshots straddling a minute boundary land in distinct, ascending
    intra_ms buckets (hhmmssms_to_intra_ms_sql, not naive ts_ms // bucket_ms)."""
    from hoga.tables.snapshots import query_bucketed_ratio

    # 09:00:59.000 -> intra 32_459_000; 09:01:00.000 -> intra 32_460_000.
    # bucket_ms=60_000: bucket_a = 32_400_000, bucket_b = 32_460_000.
    obs = [
        _ob(ts_ms=90_059_000, seq=1, ask_q=(11,), bid_q=(22,)),
        _ob(ts_ms=90_100_000, seq=2, ask_q=(33,), bid_q=(44,)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_ratio(con, path=out, bucket_ms=60_000)
    assert [r.bucket_intra_ms for r in rows] == [32_400_000, 32_460_000]  # ascending, distinct
    assert [r.ask_total for r in rows] == [11, 33]
    assert [r.bid_total for r in rows] == [22, 44]


def test_query_bucketed_ratio_empty_parquet_returns_no_rows(tmp_path: Path) -> None:
    from hoga.tables.snapshots import query_bucketed_ratio

    out = tmp_path / "snapshots.parquet"
    write_parquet([], out)
    con = duckdb.connect()
    assert query_bucketed_ratio(con, path=out, bucket_ms=1000) == []


# ---------------------------------------------------------------------------
# query_bucket_representative (ADR-0062): sidebar 10호가 = indicator's structural
# representative. The orderbook endpoint must show the same snapshot the
# 호가비·총잔량 indicator labels at a straddle bucket, EXCLUDING the closing
# auction (3-level) book.
# ---------------------------------------------------------------------------


def test_query_bucket_representative_excludes_auction_snapshot(tmp_path: Path) -> None:
    """Straddle bucket [15:18,15:21): the representative is the last continuous
    book (depth beyond level 3) at/before close (15:19:58), NOT the 15:20:58
    closing-auction 3-level snapshot the window also spans."""
    from hoga.tables.snapshots import query_bucket_representative

    CLOSE = 153_000_000  # 15:30:00.000
    obs = [
        _ob(ts_ms=151_800_000, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),  # 15:18 continuous
        _ob(ts_ms=151_958_000, seq=2, ask_q=(1, 2, 3, 4), bid_q=(9, 9, 9, 9)),      # 15:19:58 LAST continuous
        _ob(ts_ms=152_058_000, seq=3, ask_q=(99, 98, 97), bid_q=(7, 7, 7)),         # 15:20:58 auction (3-level)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    snap = query_bucket_representative(
        con, path=out, lo_native=151_800_000, hi_native=152_059_999, session_close_ms=CLOSE
    )
    assert snap is not None
    assert snap.ts_ms == 151_958_000  # last continuous, NOT the 15:20:58 auction
    assert sum(1 for l in snap.ask if l.qty > 0) == 4  # 10-level book, not the 3-level auction


def test_query_bucket_representative_fully_auction_falls_back_to_last(tmp_path: Path) -> None:
    """A fully-auction window (no continuous snapshot in it) falls back to the
    last snapshot in the window — mirrors query_bucketed_ratio's fallback."""
    from hoga.tables.snapshots import query_bucket_representative

    CLOSE = 153_000_000
    obs = [
        _ob(ts_ms=151_700_000, seq=1, ask_q=(1, 2, 3, 4), bid_q=(1, 1, 1, 1)),  # continuous before window → sets threshold
        _ob(ts_ms=152_100_000, seq=2, ask_q=(11, 12, 13), bid_q=(2, 2, 2)),     # auction in window
        _ob(ts_ms=152_200_000, seq=3, ask_q=(21, 22, 23), bid_q=(3, 3, 3)),     # last auction in window
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    snap = query_bucket_representative(
        con, path=out, lo_native=152_100_000, hi_native=152_359_999, session_close_ms=CLOSE
    )
    assert snap is not None
    assert snap.ts_ms == 152_200_000  # last in the fully-auction window


def test_query_bucket_representative_no_session_close_is_legacy_last(tmp_path: Path) -> None:
    """session_close_ms None → legacy last-in-window (no structural exclusion)."""
    from hoga.tables.snapshots import query_bucket_representative

    obs = [
        _ob(ts_ms=151_800_000, seq=1, ask_q=(1, 2, 3, 4), bid_q=(1,)),
        _ob(ts_ms=152_058_000, seq=2, ask_q=(99, 98, 97), bid_q=(7,)),  # auction, but no bound → last wins
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    snap = query_bucket_representative(
        con, path=out, lo_native=151_800_000, hi_native=152_059_999, session_close_ms=None
    )
    assert snap is not None
    assert snap.ts_ms == 152_058_000  # legacy last-in-window


def test_query_bucket_representative_empty_window_returns_none(tmp_path: Path) -> None:
    from hoga.tables.snapshots import query_bucket_representative

    obs = [_ob(ts_ms=151_800_000, seq=1, ask_q=(1, 2, 3, 4), bid_q=(1,))]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    # window entirely after the only snapshot → None
    snap = query_bucket_representative(
        con, path=out, lo_native=160_000_000, hi_native=160_300_000, session_close_ms=153_000_000
    )
    assert snap is None
