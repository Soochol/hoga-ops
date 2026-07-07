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
    AskPeakCandidateRow,
    AskPeakDualRow,
    AskPeakRow,
    BidPeakDualRow,
    BidPeakRow,
    Orderbook,
    SnapshotValidationError,
    query_at,
    query_day_ask_peak_dual,
    query_day_ask_bid_peak_dual,
    query_day_ask_peak,
    query_day_bid_peak,
    query_day_bid_peak_dual,
    query_first_ts,
    query_time_bounds,
    validate,
    write_parquet,
)
from hoga.tables.trades import Trade, write_parquet as write_trades


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


def test_query_at_uses_path_index_without_duckdb_for_repeated_cursor_reads(
    tmp_path: Path,
) -> None:
    """The hover orderbook path is latency-sensitive: cursor movement can call
    query_at many times for the same snapshots.parquet. It should answer from a
    file-backed in-memory index instead of running a DuckDB parquet scan per
    cursor tick.
    """
    obs = [
        PARSERS[2](_ob_parts(ts_ms=t, seq=i))
        for i, t in enumerate([90000000, 90001000, 90002000], start=1)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    class NoDuckDB:
        def execute(self, *_args, **_kwargs):  # pragma: no cover - failure path
            raise AssertionError("query_at should not execute DuckDB scans")

    first = query_at(NoDuckDB(), path=out, t_ms=90001500)
    second = query_at(NoDuckDB(), path=out, t_ms=90002500)

    assert first is not None
    assert second is not None
    assert first.ts_ms == 90001000
    assert second.ts_ms == 90002000


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


def test_query_bucketed_ratio_intra_max_independent_sides(tmp_path: Path) -> None:
    """한 버킷 내 bid 최댓값과 ask 최댓값이 서로 다른 시점이어도 각각 독립 포착
    (캔들 고가가 시·종가와 무관하듯). 종가는 마지막 스냅샷 값으로 유지."""
    from hoga.tables.snapshots import query_bucketed_ratio

    # 모두 같은 1000ms 버킷. bid max@t1(seq1, bid=900), ask max@t2(seq2, ask=800),
    # 종가=마지막(seq3, bid=10 ask=20).
    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(1,), bid_q=(900,)),
        _ob(ts_ms=90_000_500, seq=2, ask_q=(800,), bid_q=(1,)),
        _ob(ts_ms=90_000_900, seq=3, ask_q=(20,), bid_q=(10,)),  # 종가
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_ratio(con, path=out, bucket_ms=1000)
    assert len(rows) == 1
    r = rows[0]
    assert (r.bid_total, r.ask_total) == (10, 20)   # 종가 = 마지막 스냅샷
    assert r.bid_max == 900                          # bid 독립 최댓값
    assert r.ask_max == 800                          # ask 독립 최댓값
    assert r.bid_max >= r.bid_total and r.ask_max >= r.ask_total  # 상계 invariant


def test_query_bucketed_ratio_imb_max_picks_extreme_imbalance_snapshot(tmp_path: Path) -> None:
    """호가비 Intra-Bar Max는 |imbalance| 최대 스냅샷의 (bid,ask) 쌍. max끼리 결합과
    부호가 뒤집힌다(스펙 예시): A(bid100,ask2)=매수우위, B(bid10,ask300)=매도우위.
    |imbalance| 극값 = A → imb_max_bid/ask = (100,2). (bid_max=100, ask_max=300 결합 아님.)"""
    from hoga.tables.snapshots import query_bucketed_ratio
    from hoga.api.timeenc import hhmmssms_to_unix_ms  # noqa: F401 (의도 명시용)

    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(2,), bid_q=(100,)),   # A: |imb| = 100/2-1 = 49 (매수우위)
        _ob(ts_ms=90_000_500, seq=2, ask_q=(300,), bid_q=(10,)),  # B: |imb| = 300/10-1 = 29 (매도우위)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_ratio(con, path=out, bucket_ms=1000)
    assert len(rows) == 1
    r = rows[0]
    assert (r.imb_max_bid, r.imb_max_ask) == (100, 2)  # A — 더 큰 |imbalance|
    assert (r.bid_max, r.ask_max) == (100, 300)        # 독립 최댓값은 max끼리(부호 뒤집힘 증거)


def test_query_bucketed_ratio_auction_bucket_zeroes_max_fields(tmp_path: Path) -> None:
    """마감 동시호가 버킷(연속거래 책이 끝난 뒤)은 종가뿐 아니라 max 필드도 0 센티넬.

    현실 데이터에선 그날 어딘가에 deep 연속거래 책이 항상 있어 last_continuous_ms가
    설정된다(None 폴백 분기는 production 미발동). 그래서 EARLIER 버킷(15:18)에 deep
    연속거래 스냅샷 1건을 두어 임계값을 세우고, 3-레벨 붕괴(동시호가) 스냅샷들은 그
    이후 별도 버킷(15:20:58, intra > last_continuous_ms)에 두어 후행 auction 버킷이
    is_pre=FALSE로 4 max 필드 + 총잔량이 모두 0이 되는지 검증한다(연속거래 버킷은 정상값)."""
    from hoga.tables.snapshots import query_bucketed_ratio

    z = tuple([0] * 10)
    # 15:18:00 연속거래 책(레벨4..10 > 0) — last_continuous_ms를 세운다. 별도 버킷.
    continuous = Orderbook(
        ts_ms=151_800_000, seq=1,
        ask_p=tuple(range(101, 111)), ask_q=(10, 20, 30, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple(range(100, 90, -1)), bid_q=(50, 40, 30, 20, 5, 5, 5, 5, 5, 5), bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    # 15:20:58 마감 동시호가: 3-레벨 붕괴 호가창(레벨4+ = 0) 2건 한 버킷.
    # intra(55_258_xxx) > last_continuous_ms(55_080_000) → is_pre FALSE → 전부 0.
    collapsed1 = Orderbook(
        ts_ms=152_058_000, seq=2,
        ask_p=(101, 102, 103) + (0,) * 7, ask_q=(99, 98, 97) + (0,) * 7, ask_d=z,
        bid_p=(100, 99, 98) + (0,) * 7, bid_q=(7, 7, 7) + (0,) * 7, bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    collapsed2 = Orderbook(
        ts_ms=152_058_500, seq=3,
        ask_p=(101, 102, 103) + (0,) * 7, ask_q=(50, 40, 30) + (0,) * 7, ask_d=z,
        bid_p=(100, 99, 98) + (0,) * 7, bid_q=(5, 5, 5) + (0,) * 7, bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    out = tmp_path / "snapshots.parquet"
    write_parquet([continuous, collapsed1, collapsed2], out)
    con = duckdb.connect()
    # session_close_ms(15:30:00)는 deep 스냅샷 뒤이자 auction 구간을 포함.
    rows = query_bucketed_ratio(con, path=out, bucket_ms=1000, session_close_ms=153000000)
    assert len(rows) == 2  # 연속거래 버킷 + 마감 동시호가 버킷
    cont_row, auction_row = rows[0], rows[1]  # bucket-ascending
    # 연속거래 버킷(is_pre TRUE)은 정상값.
    assert (cont_row.bid_total, cont_row.ask_total) == (170, 136)  # 50+40+30+20+5*6 / 10+20+30+40+5+6+7+8+9+1
    assert (cont_row.bid_max, cont_row.ask_max) == (170, 136)
    # 마감 동시호가 버킷(is_pre FALSE)은 종가 + max 필드 전부 0 센티넬.
    assert (auction_row.bid_total, auction_row.ask_total) == (0, 0)
    assert (auction_row.bid_max, auction_row.ask_max) == (0, 0)
    assert (auction_row.imb_max_bid, auction_row.imb_max_ask) == (0, 0)


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


def test_query_bucket_representative_fully_auction_returns_none(tmp_path: Path) -> None:
    """A fully-auction window has no representative because no continuous row qualifies."""
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
    assert snap is None


def test_query_bucket_representative_no_session_close_excludes_later_shallow_row(
    tmp_path: Path,
) -> None:
    from hoga.tables.snapshots import query_bucket_representative

    obs = [
        _ob(ts_ms=151_958_000, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),
        _ob(ts_ms=152_058_000, seq=2, ask_q=(99, 98, 97), bid_q=(7, 7, 7)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    snap = query_bucket_representative(
        con, path=out, lo_native=151_800_000, hi_native=152_059_999, session_close_ms=None
    )
    assert snap is not None
    assert snap.ts_ms == 151_958_000
    assert snap.seq == 1


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


def test_query_bucket_representative_uses_path_index_without_duckdb(
    tmp_path: Path,
) -> None:
    from hoga.tables.snapshots import query_bucket_representative

    obs = [
        _ob(ts_ms=151_958_000, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),
        _ob(ts_ms=152_000_000, seq=2, ask_q=(10, 20, 30, 40), bid_q=(6, 6, 6, 6)),
        _ob(ts_ms=152_058_000, seq=3, ask_q=(99, 98, 97), bid_q=(8, 8, 8)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    class NoDuckDB:
        def execute(self, *_args, **_kwargs):  # pragma: no cover - failure path
            raise AssertionError("query_bucket_representative should use cached index")

    snap = query_bucket_representative(
        NoDuckDB(),
        path=out,
        lo_native=151_958_000,
        hi_native=152_059_999,
        session_close_ms=153_000_000,
    )

    assert snap is not None
    assert snap.seq == 2


def test_query_bucket_representatives_prefer_last_continuous_book_over_later_shallow_row(
    tmp_path: Path,
) -> None:
    from hoga.tables.snapshots import query_bucket_representative, query_bucket_representatives

    obs = [
        _ob(ts_ms=151_958_000, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),
        _ob(ts_ms=152_000_000, seq=2, ask_q=(10, 20, 30, 40), bid_q=(6, 6, 6, 6)),
        _ob(ts_ms=152_000_500, seq=3, ask_q=(11, 22, 33), bid_q=(7, 7, 7)),
        _ob(ts_ms=152_058_000, seq=4, ask_q=(99, 98, 97), bid_q=(8, 8, 8)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    with duckdb.connect(":memory:") as con:
        single = query_bucket_representative(
            con,
            path=out,
            lo_native=151_958_000,
            hi_native=152_059_999,
            session_close_ms=153_000_000,
        )
        batch = query_bucket_representatives(
            con,
            path=out,
            buckets=[(151_958_000, 152_059_999)],
            session_close_ms=153_000_000,
    )

    assert single is not None
    assert single.seq == 2
    assert batch[151_958_000].seq == 2
    assert single.ask[0].price == batch[151_958_000].ask[0].price == 1


def test_query_bucket_representatives_omit_fully_auction_bucket(tmp_path: Path) -> None:
    from hoga.tables.snapshots import query_bucket_representatives

    obs = [
        _ob(ts_ms=151_700_000, seq=1, ask_q=(1, 2, 3, 4), bid_q=(1, 1, 1, 1)),
        _ob(ts_ms=152_100_000, seq=2, ask_q=(11, 12, 13), bid_q=(2, 2, 2)),
        _ob(ts_ms=152_200_000, seq=3, ask_q=(21, 22, 23), bid_q=(3, 3, 3)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    with duckdb.connect(":memory:") as con:
        reps = query_bucket_representatives(
            con,
            path=out,
            buckets=[(152_100_000, 152_359_999)],
            session_close_ms=153_000_000,
        )

    assert 152_100_000 not in reps


def test_query_bucket_representatives_no_session_close_keep_deep_and_omit_fully_shallow(
    tmp_path: Path,
) -> None:
    from hoga.tables.snapshots import query_bucket_representatives

    obs = [
        _ob(ts_ms=151_800_000, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),
        _ob(ts_ms=152_058_000, seq=2, ask_q=(99, 98, 97), bid_q=(7, 7, 7)),
        _ob(ts_ms=152_100_000, seq=3, ask_q=(88, 87, 86), bid_q=(6, 6, 6)),
        _ob(ts_ms=152_200_000, seq=4, ask_q=(77, 76, 75), bid_q=(4, 4, 4)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    with duckdb.connect(":memory:") as con:
        reps = query_bucket_representatives(
            con,
            path=out,
            buckets=[(151_800_000, 152_059_999), (152_100_000, 152_359_999)],
            session_close_ms=None,
        )

    assert reps[151_800_000].ts_ms == 151_800_000
    assert 152_100_000 not in reps


def test_query_bucket_representative_and_batch_share_seq_tiebreak(tmp_path: Path) -> None:
    from hoga.tables.snapshots import query_bucket_representative, query_bucket_representatives

    obs = [
        _ob(ts_ms=151_958_000, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),
        _ob(ts_ms=151_958_000, seq=2, ask_q=(11, 21, 31, 41), bid_q=(6, 6, 6, 6)),
        _ob(ts_ms=152_058_000, seq=3, ask_q=(99, 98, 97), bid_q=(7, 7, 7)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    with duckdb.connect(":memory:") as con:
        single = query_bucket_representative(
            con,
            path=out,
            lo_native=151_800_000,
            hi_native=152_059_999,
            session_close_ms=153_000_000,
        )
        batch = query_bucket_representatives(
            con,
            path=out,
            buckets=[(151_800_000, 152_059_999)],
            session_close_ms=153_000_000,
        )

    assert single is not None
    assert batch[151_800_000].seq == 2
    assert single.seq == batch[151_800_000].seq == 2


def test_query_bucket_representative_uses_seq_tiebreak_independent_of_write_order(
    tmp_path: Path,
) -> None:
    from hoga.tables.snapshots import query_bucket_representative

    obs = [
        _ob(ts_ms=151_958_000, seq=2, ask_q=(11, 21, 31, 41), bid_q=(6, 6, 6, 6)),
        _ob(ts_ms=151_958_000, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    with duckdb.connect(":memory:") as con:
        snap = query_bucket_representative(
            con,
            path=out,
            lo_native=151_800_000,
            hi_native=152_059_999,
            session_close_ms=153_000_000,
        )

    assert snap is not None
    assert snap.seq == 2


def test_query_bucket_representatives_matches_single_query_for_multiple_buckets(
    tmp_path: Path,
) -> None:
    from hoga.tables.snapshots import query_bucket_representative, query_bucket_representatives

    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(10, 20, 30, 40), bid_q=(5, 5, 5, 5)),
        _ob(ts_ms=90_010_000, seq=2, ask_q=(11, 21, 31, 41), bid_q=(6, 6, 6, 6)),
        _ob(ts_ms=90_060_100, seq=3, ask_q=(12, 22, 32, 42), bid_q=(7, 7, 7, 7)),
        _ob(ts_ms=90_070_000, seq=4, ask_q=(99, 98, 97), bid_q=(8, 8, 8)),
        _ob(ts_ms=90_120_100, seq=5, ask_q=(13, 23, 33, 43), bid_q=(9, 9, 9, 9)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    buckets = [
        (90_000_000, 90_059_999),
        (90_060_000, 90_119_999),
        (90_120_000, 90_179_999),
    ]

    with duckdb.connect(":memory:") as con:
        single = {
            lo: query_bucket_representative(
                con,
                path=out,
                lo_native=lo,
                hi_native=hi,
                session_close_ms=153_000_000,
            )
            for lo, hi in buckets
        }
        batch = query_bucket_representatives(
            con,
            path=out,
            buckets=buckets,
            session_close_ms=153_000_000,
        )

    assert {lo: snap.seq for lo, snap in batch.items()} == {
        lo: snap.seq for lo, snap in single.items() if snap is not None
    }


# ---------------------------------------------------------------------------
# query_day_ask_peak (Task 1): 당일 연속거래 매도 최대벽 집계
# ---------------------------------------------------------------------------


def _ob_ap(
    ts_ms: int,
    ask_q: list[int],
    ask_p: list[int] | None = None,
    *,
    seq: int = 1,
) -> "Orderbook":
    """ask_q/ask_p는 길이 10. bid는 연속거래로 보이게 깊이 채움(레벨4+ >0)."""
    ap = tuple(ask_p or [25000 + 50 * i for i in range(10)])
    aq = tuple(ask_q)
    bq = tuple([100] * 10)  # bid 깊이 충분 → 연속거래(_BID_DEEP_SUM>0)
    bp = tuple([24950 - 50 * i for i in range(10)])
    z = tuple([0] * 10)
    return Orderbook(ts_ms=ts_ms, seq=seq, ask_p=ap, ask_q=aq, ask_d=z,
                     bid_p=bp, bid_q=bq, bid_d=z, tot_ask=sum(aq), tot_ask_d=0,
                     tot_bid=sum(bq), tot_bid_d=0)


def _ob_bp(
    ts_ms: int,
    bid_q: list[int],
    bid_p: list[int] | None = None,
    *,
    seq: int = 1,
) -> "Orderbook":
    """bid_q/bid_p are length 10. ask is filled deep enough to look continuous."""
    bp = tuple(bid_p or [24950 - 50 * i for i in range(10)])
    bq = tuple(bid_q)
    aq = tuple([100] * 10)
    ap = tuple([25000 + 50 * i for i in range(10)])
    z = tuple([0] * 10)
    return Orderbook(ts_ms=ts_ms, seq=seq, ask_p=ap, ask_q=aq, ask_d=z,
                     bid_p=bp, bid_q=bq, bid_d=z, tot_ask=sum(aq), tot_ask_d=0,
                     tot_bid=sum(bq), tot_bid_d=0)


def _con_for(path) -> "duckdb.DuckDBPyConnection":
    return duckdb.connect()


def test_query_day_ask_peak_basic(tmp_path) -> None:
    # 가장 큰 단일 매도단계: ts 90100000, level3(가격 25100)에 5000
    obs = [
        _ob_ap(90000000, [10, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
        _ob_ap(90100000, [100, 200, 5000, 40, 5, 6, 7, 8, 9, 1],
            ask_p=[25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450]),
        _ob_ap(90200000, [10, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(_con_for(out), path=out, bucket_ms=60_000)
    assert peak == AskPeakRow(
        price=25100, qty=5000, intra_ms=peak.intra_ms,
        max_price=25100, max_qty=5000, max_intra_ms=peak.max_intra_ms,
    )
    assert peak.qty == 5000 and peak.price == 25100
    assert peak.max_qty == 5000 and peak.max_price == 25100


def test_query_day_ask_peak_tie_earliest(tmp_path) -> None:
    obs = [
        _ob_ap(90200000, [7000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[26000] + [25000 + i for i in range(9)]),
        _ob_ap(90100000, [7000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[25500] + [25000 + i for i in range(9)]),  # 더 이른 시각
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(_con_for(out), path=out, bucket_ms=60_000)
    assert peak is not None and peak.qty == 7000 and peak.price == 25500  # 이른 시각 채택


def test_query_day_ask_peak_excludes_single_price(tmp_path) -> None:
    # 동시호가/VI 붕괴 호가창(레벨4..10 = 0 양측)이 더 큰 누적 qty를 가져도 배제.
    z = tuple([0] * 10)
    collapsed = Orderbook(
        ts_ms=152100000, seq=1,
        ask_p=(25000, 25050, 25100) + (0,) * 7, ask_q=(99999, 1, 1) + (0,) * 7, ask_d=z,
        bid_p=(24950, 24900, 24850) + (0,) * 7, bid_q=(1, 1, 1) + (0,) * 7, bid_d=z,
        tot_ask=100001, tot_ask_d=0, tot_bid=3, tot_bid_d=0,
    )
    continuous = _ob_ap(90100000, [10, 20, 300, 40, 5, 6, 7, 8, 9, 1],
                     ask_p=[25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450])
    out = tmp_path / "snapshots.parquet"
    write_parquet([collapsed, continuous], out)
    peak = query_day_ask_peak(_con_for(out), path=out, bucket_ms=60_000)
    assert peak is not None and peak.qty == 300  # 붕괴행의 99999 무시, 연속행 최대


def test_query_day_ask_peak_empty(tmp_path) -> None:
    out = tmp_path / "snapshots.parquet"
    write_parquet([], out)
    assert query_day_ask_peak(_con_for(out), path=out, bucket_ms=60_000) is None


def test_query_day_ask_peak_excludes_opening_auction(tmp_path) -> None:
    """개장 동시호가(<09:00)는 10레벨 누적 호가라 _DEEP_BOOK_SQL을 통과하지만(레벨4+ >0),
    session_open_ms 하한으로 배제 — 보통 그날 최대 누적이라 게이트 없으면 peak를 가로챈다."""
    obs = [
        # 08:55 개장 동시호가: 거대한 누적(level1=99999), 깊이도 채워 연속거래로 보임.
        _ob_ap(85500000, [99999, 50000, 40000, 30000, 20, 10, 9, 8, 7, 6],
            ask_p=[24000 + 50 * i for i in range(10)]),
        # 09:10 연속거래: 실제 최대벽 level3=300.
        _ob_ap(91000000, [10, 20, 300, 40, 5, 6, 7, 8, 9, 1],
            ask_p=[25000 + 50 * i for i in range(10)]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(
        _con_for(out), path=out, bucket_ms=60_000,
        session_open_ms=90000000, session_close_ms=153000000,
    )
    assert peak is not None and peak.qty == 300 and peak.price == 25100  # 개장 99999 무시


def test_query_day_ask_peak_excludes_post_cross_reexpansion(tmp_path) -> None:
    """마감 교차 후(~15:30:14) 호가창이 재확장하면 _DEEP_BOOK_SQL을 통과하지만,
    session_close_ms 상한(15:30:00)으로 배제."""
    obs = [
        _ob_ap(91000000, [10, 20, 300, 40, 5, 6, 7, 8, 9, 1],
            ask_p=[25000 + 50 * i for i in range(10)]),  # 09:10 연속거래 최대벽 300
        # 15:30:14 재확장: 거대한 벽이지만 마감 후라 배제.
        _ob_ap(153014000, [88888, 7, 6, 5, 4, 3, 2, 1, 1, 1],
            ask_p=[26000 + 50 * i for i in range(10)]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(
        _con_for(out), path=out, bucket_ms=60_000,
        session_open_ms=90000000, session_close_ms=153000000,
    )
    assert peak is not None and peak.qty == 300  # 15:30:14의 88888 무시


def test_query_day_ask_peak_bucket_representative_not_tick_max(tmp_path) -> None:
    """버킷 중간에 잠깐 솟았다 빠진 벽은 raw 틱 max로는 잡히지만, 버킷 대표(마지막 연속거래
    스냅샷)에는 안 나타난다 → 사용자가 보는 분봉 호가창과 일치하도록 대표 위에서 집계."""
    obs = [
        # 3분 버킷 [09:00,09:03): 09:00:10 스파이크 5000(중간) → 09:02:55 1000(대표=마지막).
        _ob_ap(90010000, [5000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[25000 + 50 * i for i in range(10)]),
        _ob_ap(90255000, [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[25000 + 50 * i for i in range(10)]),
        # 다음 3분 버킷 [09:03,09:06): 대표 level1=2000.
        _ob_ap(90310000, [2000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[25000 + 50 * i for i in range(10)]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(
        _con_for(out), path=out, bucket_ms=180_000,  # 3분
        session_open_ms=90000000, session_close_ms=153000000,
    )
    # 틱 max였다면 5000. 버킷 대표라 max(1000, 2000) = 2000.
    assert peak is not None and peak.qty == 2000


def test_query_day_ask_peak_intra_max_captures_mid_bucket_spike(tmp_path) -> None:
    """버킷 중간에 잠깐 솟았다 빠진 매도벽: close 변종(버킷 대표=마지막 연속거래)에는
    안 나타나지만, 틱-max 변종(max_*)은 연속거래 스냅샷 전체에서 잡아낸다."""
    obs = [
        _ob_ap(90010000, [5000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[25000 + 50 * i for i in range(10)]),
        _ob_ap(90255000, [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[25000 + 50 * i for i in range(10)]),
        _ob_ap(90310000, [2000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[25000 + 50 * i for i in range(10)]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(
        _con_for(out), path=out, bucket_ms=180_000,
        session_open_ms=90000000, session_close_ms=153000000,
    )
    assert peak is not None
    assert peak.qty == 2000 and peak.price == 25000
    assert peak.max_qty == 5000 and peak.max_price == 25000
    assert peak.max_qty >= peak.qty


def test_query_day_ask_peak_intra_max_excludes_single_price(tmp_path) -> None:
    """틱-max도 close와 동일하게 동시호가/VI 붕괴 호가창을 배제한다."""
    z = tuple([0] * 10)
    collapsed = Orderbook(
        ts_ms=152100000, seq=1,
        ask_p=(25000, 25050, 25100) + (0,) * 7, ask_q=(99999, 1, 1) + (0,) * 7, ask_d=z,
        bid_p=(24950, 24900, 24850) + (0,) * 7, bid_q=(1, 1, 1) + (0,) * 7, bid_d=z,
        tot_ask=100001, tot_ask_d=0, tot_bid=3, tot_bid_d=0,
    )
    spike = _ob_ap(90010000, [700, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        ask_p=[25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450])
    rep = _ob_ap(90055000, [10, 20, 300, 40, 5, 6, 7, 8, 9, 1],
        ask_p=[25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450])
    out = tmp_path / "snapshots.parquet"
    write_parquet([collapsed, spike, rep], out)
    peak = query_day_ask_peak(
        _con_for(out), path=out, bucket_ms=60_000,
        session_open_ms=90000000, session_close_ms=153000000,
    )
    assert peak is not None
    assert peak.qty == 300
    assert peak.max_qty == 700


def _trade(ts_ms: int, price: int, side: int = 1, *, seq: int = 1) -> Trade:
    return Trade(
        ts_ms=ts_ms, seq=seq, price=price, change_pct=0, qty=1, side=side,
        cum_vol=1, cum_trades=1, low_so_far=price, high_so_far=price,
        net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
    )


def _assert_no_post_touch_scalars(peak: AskPeakDualRow | BidPeakDualRow) -> None:
    assert (peak.price, peak.qty, peak.intra_ms) == (None, None, None)
    assert (peak.max_price, peak.max_qty, peak.max_intra_ms) == (None, None, None)


def test_query_day_ask_bid_peak_dual_matches_existing_separate_queries(tmp_path: Path) -> None:
    snapshots = tmp_path / "snapshots.parquet"
    trades = tmp_path / "trades.parquet"
    obs = [
        replace(
            _ob_ap(
            90001000,
            [50, 300, 10, 40, 5, 6, 7, 8, 9, 1],
            ask_p=[25100, 25200, 25300, 25400, 25500, 25600, 25700, 25800, 25900, 26000],
            ),
            bid_p=(24950, 24900, 24850, 24800, 24750, 24700, 24650, 24600, 24550, 24500),
            bid_q=(900, 80, 70, 60, 50, 40, 30, 20, 10, 1),
        ),
        replace(
            _ob_ap(
            90061000,
            [60, 100, 500, 40, 5, 6, 7, 8, 9, 1],
            ask_p=[26100, 26200, 26300, 26400, 26500, 26600, 26700, 26800, 26900, 27000],
            ),
            bid_p=(24950, 24900, 24850, 24800, 24750, 24700, 24650, 24600, 24550, 24500),
            bid_q=(1000, 80, 70, 60, 50, 40, 30, 20, 10, 1),
        ),
    ]
    write_parquet(obs, snapshots)
    write_trades([_trade(90010000, 25200), _trade(90020000, 24950, side=-1)], trades)

    con = _con_for(snapshots)
    expected_ask = query_day_ask_peak_dual(
        con,
        path=snapshots,
        trades_path=trades,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )
    expected_bid = query_day_bid_peak_dual(
        con,
        path=snapshots,
        trades_path=trades,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    actual_ask, actual_bid = query_day_ask_bid_peak_dual(
        con,
        path=snapshots,
        trades_path=trades,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert actual_ask == expected_ask
    assert actual_bid == expected_bid


def test_query_day_ask_peak_dual_classifies_post_touch_and_post_untouched_events(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_ap(
                100000000,
                [100000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
            ),
            _ob_ap(
                102000000,
                [200000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(100500000, 50000)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    first = AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)
    second = AskPeakCandidateRow(price=50000, qty=200000, intra_ms=37_200_000)
    assert peak.traded_peaks == (first,)
    assert peak.traded_max_peaks == (first,)
    assert peak.untraded_peaks[0] == second
    assert peak.untraded_max_peaks[0] == second
    assert (peak.price, peak.qty, peak.intra_ms) == (50000, 100000, 36_000_000)
    assert (peak.all_price, peak.all_qty, peak.all_intra_ms) == (50000, 200000, 37_200_000)
    assert (peak.untraded_price, peak.untraded_qty, peak.untraded_intra_ms) == (50000, 200000, 37_200_000)


def test_query_day_ask_peak_dual_ranks_lifecycle_representatives(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    ask_prices = [50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900]
    write_parquet(
        [
            _ob_ap(100000000, [5000, 4000, 3000, 1, 1, 1, 1, 1, 1, 1], ask_p=ask_prices),
            _ob_ap(100100000, [8000, 4100, 3100, 1, 1, 1, 1, 1, 1, 1], ask_p=ask_prices),
            _ob_ap(100200000, [7000, 4200, 3200, 1, 1, 1, 1, 1, 1, 1], ask_p=ask_prices),
            _ob_ap(100400000, [9000, 100, 100, 1, 1, 1, 1, 1, 1, 1], ask_p=ask_prices),
        ],
        snapshots_path,
    )
    write_trades([_trade(100300000, 50200)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    traded = (
        AskPeakCandidateRow(price=50000, qty=8000, intra_ms=36_060_000),
        AskPeakCandidateRow(price=50100, qty=4200, intra_ms=36_120_000),
        AskPeakCandidateRow(price=50200, qty=3200, intra_ms=36_120_000),
    )
    untraded = AskPeakCandidateRow(price=50000, qty=9000, intra_ms=36_240_000)
    assert peak.traded_peaks == traded
    assert peak.traded_max_peaks == traded
    assert peak.untraded_peaks[0] == untraded
    assert peak.untraded_max_peaks[0] == untraded


def test_query_day_ask_peak_dual_keeps_one_best_traded_lifecycle_per_price(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    ask_prices = [50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900]
    write_parquet(
        [
            _ob_ap(100000000, [5000, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=ask_prices),
            _ob_ap(100200000, [6000, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=ask_prices),
            _ob_ap(100400000, [1, 4000, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=ask_prices),
        ],
        snapshots_path,
    )
    write_trades([
        _trade(100100000, 50000),
        _trade(100300000, 50000),
        _trade(100500000, 50100),
    ], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks[:2] == (
        AskPeakCandidateRow(price=50000, qty=6000, intra_ms=36_120_000),
        AskPeakCandidateRow(price=50100, qty=4000, intra_ms=36_240_000),
    )
    assert [p.price for p in peak.traded_peaks].count(50000) == 1


def test_query_day_bid_peak_dual_classifies_post_touch_and_post_untouched_events(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_bp(
                100000000,
                [100000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
            ),
            _ob_bp(
                102000000,
                [200000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(100500000, 50000)], trades_path)

    peak = query_day_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    first = AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)
    second = AskPeakCandidateRow(price=50000, qty=200000, intra_ms=37_200_000)
    assert peak.traded_peaks == (first,)
    assert peak.traded_max_peaks == (first,)
    assert peak.untraded_peaks[0] == second
    assert peak.untraded_max_peaks[0] == second
    assert (peak.price, peak.qty, peak.intra_ms) == (50000, 100000, 36_000_000)
    assert (peak.all_price, peak.all_qty, peak.all_intra_ms) == (50000, 200000, 37_200_000)
    assert (peak.untraded_price, peak.untraded_qty, peak.untraded_intra_ms) == (50000, 200000, 37_200_000)


def test_query_day_bid_peak_dual_ranks_lifecycle_representatives(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    bid_prices = [50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100]
    write_parquet(
        [
            _ob_bp(100000000, [5000, 4000, 3000, 1, 1, 1, 1, 1, 1, 1], bid_p=bid_prices),
            _ob_bp(100100000, [8000, 4100, 3100, 1, 1, 1, 1, 1, 1, 1], bid_p=bid_prices),
            _ob_bp(100200000, [7000, 4200, 3200, 1, 1, 1, 1, 1, 1, 1], bid_p=bid_prices),
            _ob_bp(100400000, [9000, 100, 100, 1, 1, 1, 1, 1, 1, 1], bid_p=bid_prices),
        ],
        snapshots_path,
    )
    write_trades([_trade(100300000, 49800)], trades_path)

    peak = query_day_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    traded = (
        AskPeakCandidateRow(price=50000, qty=8000, intra_ms=36_060_000),
        AskPeakCandidateRow(price=49900, qty=4200, intra_ms=36_120_000),
        AskPeakCandidateRow(price=49800, qty=3200, intra_ms=36_120_000),
    )
    untraded = AskPeakCandidateRow(price=50000, qty=9000, intra_ms=36_240_000)
    assert peak.traded_peaks == traded
    assert peak.traded_max_peaks == traded
    assert peak.untraded_peaks[0] == untraded
    assert peak.untraded_max_peaks[0] == untraded


def test_query_day_ask_peak_dual_ignores_prior_same_price_trade(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_ap(
                100000000,
                [100000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(95500000, 50000)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == ()
    assert peak.traded_max_peaks == ()
    _assert_no_post_touch_scalars(peak)
    only = AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)
    assert peak.untraded_peaks[0] == only
    assert peak.untraded_max_peaks[0] == only


def test_query_day_bid_peak_dual_ignores_prior_same_price_trade(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_bp(
                100000000,
                [100000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(95500000, 50000)], trades_path)

    peak = query_day_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == ()
    assert peak.traded_max_peaks == ()
    _assert_no_post_touch_scalars(peak)
    only = AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)
    assert peak.untraded_peaks[0] == only
    assert peak.untraded_max_peaks[0] == only


def test_query_day_ask_peak_dual_same_millisecond_equal_seq_counts_as_touch(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_ap(
                90_000_000,
                [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
                seq=10,
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(90_000_000, 50000, seq=10)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == (AskPeakCandidateRow(price=50000, qty=1000, intra_ms=32_400_000),)
    assert AskPeakCandidateRow(price=50000, qty=1000, intra_ms=32_400_000) not in peak.untraded_peaks


def test_query_day_ask_peak_dual_same_millisecond_earlier_seq_does_not_touch(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_ap(
                90_000_000,
                [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
                seq=10,
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(90_000_000, 50000, seq=9)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == ()
    _assert_no_post_touch_scalars(peak)
    assert peak.untraded_peaks[0] == AskPeakCandidateRow(price=50000, qty=1000, intra_ms=32_400_000)


def test_query_day_bid_peak_dual_same_millisecond_equal_seq_counts_as_touch(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_bp(
                90_000_000,
                [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
                seq=10,
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(90_000_000, 50000, seq=10)], trades_path)

    peak = query_day_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == (AskPeakCandidateRow(price=50000, qty=1000, intra_ms=32_400_000),)
    assert AskPeakCandidateRow(price=50000, qty=1000, intra_ms=32_400_000) not in peak.untraded_peaks


def test_query_day_bid_peak_dual_same_millisecond_earlier_seq_does_not_touch(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_bp(
                90_000_000,
                [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
                seq=10,
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(90_000_000, 50000, seq=9)], trades_path)

    peak = query_day_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == ()
    _assert_no_post_touch_scalars(peak)
    assert peak.untraded_peaks[0] == AskPeakCandidateRow(price=50000, qty=1000, intra_ms=32_400_000)


def test_query_day_ask_peak_dual_ignores_side_zero_crosses(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_ap(
                100000000,
                [100000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(100500000, 60000, side=0)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == ()
    _assert_no_post_touch_scalars(peak)
    assert peak.untraded_peaks[0] == AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)


def test_query_day_bid_peak_dual_ignores_side_zero_crosses(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_bp(
                100000000,
                [100000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
            ),
        ],
        snapshots_path,
    )
    write_trades([_trade(100500000, 40000, side=0)], trades_path)

    peak = query_day_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == ()
    _assert_no_post_touch_scalars(peak)
    assert peak.untraded_peaks[0] == AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)


def test_query_day_ask_peak_dual_returns_top_three_ranked_post_touch_and_post_untouched_candidates(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_ap(100010000, [1900, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[50000, 52100, 52200, 52300, 52400, 52500, 52600, 52700, 52800, 52900]),
            _ob_ap(100050000, [900, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[50000, 52100, 52200, 52300, 52400, 52500, 52600, 52700, 52800, 52900]),
            _ob_ap(100110000, [1800, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[50100, 53100, 53200, 53300, 53400, 53500, 53600, 53700, 53800, 53900]),
            _ob_ap(100150000, [800, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[50100, 53100, 53200, 53300, 53400, 53500, 53600, 53700, 53800, 53900]),
            _ob_ap(100210000, [1700, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[50200, 54100, 54200, 54300, 54400, 54500, 54600, 54700, 54800, 54900]),
            _ob_ap(100250000, [700, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[50200, 54100, 54200, 54300, 54400, 54500, 54600, 54700, 54800, 54900]),
            _ob_ap(100410000, [2200, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[51000, 55100, 55200, 55300, 55400, 55500, 55600, 55700, 55800, 55900]),
            _ob_ap(100450000, [1200, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[51000, 55100, 55200, 55300, 55400, 55500, 55600, 55700, 55800, 55900]),
            _ob_ap(100510000, [2100, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[51100, 56100, 56200, 56300, 56400, 56500, 56600, 56700, 56800, 56900]),
            _ob_ap(100550000, [1100, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[51100, 56100, 56200, 56300, 56400, 56500, 56600, 56700, 56800, 56900]),
            _ob_ap(100610000, [2000, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[51200, 57100, 57200, 57300, 57400, 57500, 57600, 57700, 57800, 57900]),
            _ob_ap(100650000, [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1], ask_p=[51200, 57100, 57200, 57300, 57400, 57500, 57600, 57700, 57800, 57900]),
        ],
        snapshots_path,
    )
    write_trades([_trade(100330000, 50300)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == (
        AskPeakCandidateRow(price=50000, qty=900, intra_ms=36_050_000),
        AskPeakCandidateRow(price=50100, qty=800, intra_ms=36_110_000),
        AskPeakCandidateRow(price=50200, qty=700, intra_ms=36_170_000),
    )
    assert peak.traded_max_peaks == (
        AskPeakCandidateRow(price=50000, qty=1900, intra_ms=36_010_000),
        AskPeakCandidateRow(price=50100, qty=1800, intra_ms=36_070_000),
        AskPeakCandidateRow(price=50200, qty=1700, intra_ms=36_130_000),
    )
    assert peak.untraded_peaks == (
        AskPeakCandidateRow(price=51000, qty=1200, intra_ms=36_290_000),
        AskPeakCandidateRow(price=51100, qty=1100, intra_ms=36_350_000),
        AskPeakCandidateRow(price=51200, qty=1000, intra_ms=36_410_000),
    )
    assert peak.untraded_max_peaks == (
        AskPeakCandidateRow(price=51000, qty=2200, intra_ms=36_250_000),
        AskPeakCandidateRow(price=51100, qty=2100, intra_ms=36_310_000),
        AskPeakCandidateRow(price=51200, qty=2000, intra_ms=36_370_000),
    )


def test_query_day_ask_peak_dual_excludes_collapsed_books_from_all_price(tmp_path) -> None:
    """미체결 포함 과거일 peak도 동시호가/VI 3호가 collapsed book을 제외한다."""
    z = tuple([0] * 10)
    collapsed = Orderbook(
        ts_ms=100000000, seq=1,
        ask_p=(25000, 25050, 25100) + (0,) * 7,
        ask_q=(99999, 1, 1) + (0,) * 7,
        ask_d=z,
        bid_p=(24950, 24900, 24850) + (0,) * 7,
        bid_q=(1, 1, 1) + (0,) * 7,
        bid_d=z,
        tot_ask=100001, tot_ask_d=0, tot_bid=3, tot_bid_d=0,
    )
    continuous = _ob_ap(
        100010000,
        [300, 2000, 30, 40, 5, 6, 7, 8, 9, 1],
        ask_p=[25000, 26000, 27000, 27100, 27200, 27300, 27400, 27500, 27600, 27700],
    )
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet([collapsed, continuous], snapshots_path)
    write_trades([_trade(100000500, 25000)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90000000,
        session_close_ms=153000000,
    )

    assert peak is not None
    assert peak.traded_peaks == ()
    _assert_no_post_touch_scalars(peak)
    assert peak.all_qty == 2000 and peak.all_price == 26000


def test_query_day_ask_peak_dual_excludes_one_sided_collapsed_ask_book(tmp_path) -> None:
    """매도 쪽이 3호가로 붕괴했으면 bid 쪽 depth가 남아 있어도 미체결 peak에서 제외한다."""
    z = tuple([0] * 10)
    one_sided_collapsed = Orderbook(
        ts_ms=100000000, seq=1,
        ask_p=(25000, 25050, 25100) + (0,) * 7,
        ask_q=(99999, 1, 1) + (0,) * 7,
        ask_d=z,
        bid_p=tuple(24950 - 50 * i for i in range(10)),
        bid_q=tuple([100] * 10),
        bid_d=z,
        tot_ask=100001, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    continuous = _ob_ap(
        100010000,
        [300, 2000, 30, 40, 5, 6, 7, 8, 9, 1],
        ask_p=[25000, 26000, 27000, 27100, 27200, 27300, 27400, 27500, 27600, 27700],
    )
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet([one_sided_collapsed, continuous], snapshots_path)
    write_trades([_trade(100000500, 25000)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90000000,
        session_close_ms=153000000,
    )

    assert peak is not None
    assert peak.all_qty == 2000 and peak.all_price == 26000
    assert peak.all_max_qty == 2000 and peak.all_max_price == 26000


def test_query_day_bid_peak_basic(tmp_path) -> None:
    obs = [
        _ob_bp(90000000, [100, 5000, 30, 40, 5, 6, 7, 8, 9, 1]),
        _ob_bp(90030000, [8000, 100, 30, 40, 5, 6, 7, 8, 9, 1],
            bid_p=[70000, 69900, 69800, 69700, 69600, 69500, 69400, 69300, 69200, 69100]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    peak = query_day_bid_peak(_con_for(out), path=out, bucket_ms=60_000)

    assert peak == BidPeakRow(
        price=70000,
        qty=8000,
        intra_ms=9 * 60 * 60 * 1000 + 30_000,
        max_price=70000,
        max_qty=8000,
        max_intra_ms=9 * 60 * 60 * 1000 + 30_000,
    )


def test_query_day_bid_peak_excludes_auction_and_session_boundaries(tmp_path) -> None:
    z = tuple([0] * 10)
    collapsed = Orderbook(
        ts_ms=91000000, seq=1,
        ask_p=(70100, 70150, 70200) + (0,) * 7,
        ask_q=(1, 1, 1) + (0,) * 7,
        ask_d=z,
        bid_p=(70000, 69900, 69800) + (0,) * 7,
        bid_q=(99999, 1, 1) + (0,) * 7,
        bid_d=z,
        tot_ask=3, tot_ask_d=0, tot_bid=100001, tot_bid_d=0,
    )
    regular = _ob_bp(
        92000000,
        [5000, 100, 50, 40, 30, 20, 10, 9, 8, 7],
        bid_p=[70000, 69900, 69800, 69700, 69600, 69500, 69400, 69300, 69200, 69100],
    )
    obs = [
        _ob_bp(85500000, [99999, 100, 50, 40, 30, 20, 10, 9, 8, 7],
               bid_p=[70500, 70400, 70300, 70200, 70100, 70000, 69900, 69800, 69700, 69600]),
        collapsed,
        regular,
        _ob_bp(153014000, [88888, 100, 50, 40, 30, 20, 10, 9, 8, 7],
               bid_p=[70600, 70500, 70400, 70300, 70200, 70100, 70000, 69900, 69800, 69700]),
    ]
    snapshots = tmp_path / "snapshots.parquet"
    trades = tmp_path / "trades.parquet"
    write_parquet(obs, snapshots)
    write_trades([_trade(92000500, 70000)], trades)

    peak = query_day_bid_peak(
        _con_for(snapshots),
        path=snapshots,
        bucket_ms=60_000,
        session_open_ms=90000000,
        session_close_ms=153000000,
    )
    dual = query_day_bid_peak_dual(
        _con_for(snapshots),
        path=snapshots,
        trades_path=trades,
        bucket_ms=60_000,
        session_open_ms=90000000,
        session_close_ms=153000000,
    )

    assert peak is not None
    assert peak.price == 70000 and peak.qty == 5000
    assert dual is not None
    assert dual.price == 70000 and dual.qty == 5000
    assert dual.all_price == 70000 and dual.all_qty == 5000


def test_query_day_bid_peak_dual_populates_below_low_untraded(tmp_path) -> None:
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    snapshots = tmp_path / "snapshots.parquet"
    trades = tmp_path / "trades.parquet"
    obs = [
        _ob_bp(90000000, [1000, 9000, 30, 40, 5, 6, 7, 8, 9, 1],
            bid_p=[70000, 69000, 68900, 68800, 68700, 68600, 68500, 68400, 68300, 68200]),
        _ob_bp(90100000, [5000, 100, 12000, 40, 5, 6, 7, 8, 9, 1],
            bid_p=[70000, 69000, 68900, 68800, 68700, 68600, 68500, 68400, 68300, 68200]),
    ]
    tr = Trade(
        ts_ms=90050000, seq=1, price=70000, change_pct=0, qty=1, side=1,
        cum_vol=1, cum_trades=1, low_so_far=70000, high_so_far=70000,
        net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
    )
    write_parquet(obs, snapshots)
    trades_write_parquet([tr], trades)

    peak = query_day_bid_peak_dual(_con_for(snapshots), path=snapshots, trades_path=trades, bucket_ms=60_000)

    assert peak is not None
    assert (peak.price, peak.qty, peak.intra_ms) == (70000, 1000, 9 * 60 * 60 * 1000)
    assert (peak.max_price, peak.max_qty, peak.max_intra_ms) == (70000, 1000, 9 * 60 * 60 * 1000)
    assert peak.traded_peaks == (AskPeakCandidateRow(price=70000, qty=1000, intra_ms=32400000),)
    assert peak.traded_max_peaks == (AskPeakCandidateRow(price=70000, qty=1000, intra_ms=32400000),)
    assert (peak.all_price, peak.all_qty, peak.all_intra_ms) == (68900, 12000, 9 * 60 * 60 * 1000 + 60_000)
    assert (peak.all_max_price, peak.all_max_qty, peak.all_max_intra_ms) == (68900, 12000, 9 * 60 * 60 * 1000 + 60_000)
    assert peak.all_peaks[0] == AskPeakCandidateRow(price=68900, qty=12000, intra_ms=32460000)
    assert peak.all_max_peaks[0] == AskPeakCandidateRow(price=68900, qty=12000, intra_ms=32460000)
    assert (peak.untraded_price, peak.untraded_qty, peak.untraded_intra_ms) == (68900, 12000, 9 * 60 * 60 * 1000 + 60_000)
    assert (peak.untraded_max_price, peak.untraded_max_qty, peak.untraded_max_intra_ms) == (68900, 12000, 9 * 60 * 60 * 1000 + 60_000)
    assert peak.untraded_peaks == (
        AskPeakCandidateRow(price=68900, qty=12000, intra_ms=32460000),
        AskPeakCandidateRow(price=69000, qty=9000, intra_ms=32400000),
        AskPeakCandidateRow(price=70000, qty=5000, intra_ms=32460000),
    )
    assert peak.untraded_max_peaks == (
        AskPeakCandidateRow(price=68900, qty=12000, intra_ms=32460000),
        AskPeakCandidateRow(price=69000, qty=9000, intra_ms=32400000),
        AskPeakCandidateRow(price=70000, qty=5000, intra_ms=32460000),
    )


# ---------------------------------------------------------------------------
# P5 회귀: Intra-Bar Max 상계 불변식
# ---------------------------------------------------------------------------


def _imb(bid: int, ask: int) -> float:
    """frontend/src/util/imbalance.ts quoteImbalance 미러(부호 규약 동일)."""
    if bid <= 0 or ask <= 0:
        return 0.0
    return ask / bid - 1 if ask >= bid else -(bid / ask - 1)


def test_quote_bucketed_ratio_intra_max_geq_close(tmp_path: Path) -> None:
    """bid_max/ask_max는 각 변 독립 버킷 최댓값이므로 종가 대표값 이상이다."""
    from hoga.tables.snapshots import query_bucketed_ratio

    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(10, 20, 30, 40), bid_q=(900, 1, 1, 1)),
        _ob(ts_ms=90_000_500, seq=2, ask_q=(50, 60, 70, 80), bid_q=(50, 1, 1, 1)),
        _ob(ts_ms=90_000_900, seq=3, ask_q=(100, 110, 120, 130), bid_q=(20, 1, 1, 1)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    rows = query_bucketed_ratio(duckdb.connect(), path=out, bucket_ms=1000)
    assert len(rows) == 1
    r = rows[0]
    assert r.ask_total == 460 and r.bid_total == 23
    assert r.ask_max >= r.ask_total
    assert r.bid_max >= r.bid_total
    assert r.ask_max == 460
    assert r.bid_max == 903 and r.bid_max > r.bid_total


def test_quote_bucketed_ratio_imbalance_magnitude_geq_close(tmp_path: Path) -> None:
    """imb_max_*는 버킷 내 |imbalance| 최대 스냅샷 쌍이므로 종가의 |imbalance| 이상이다."""
    from hoga.tables.snapshots import query_bucketed_ratio

    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(10,), bid_q=(900, 1, 1, 1)),
        _ob(ts_ms=90_000_900, seq=2, ask_q=(100, 110, 120, 130), bid_q=(20, 1, 1, 1)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    rows = query_bucketed_ratio(duckdb.connect(), path=out, bucket_ms=1000)
    assert len(rows) == 1
    r = rows[0]
    close_mag = abs(_imb(r.bid_total, r.ask_total))
    max_mag = abs(_imb(r.imb_max_bid, r.imb_max_ask))
    assert max_mag >= close_mag
    assert (r.imb_max_bid, r.imb_max_ask) == (903, 10)
    assert max_mag > close_mag


def test_day_ask_peak_max_qty_geq_close_qty(tmp_path: Path) -> None:
    """ask-peak 틱-max 변종의 당일 max(max_qty)는 버킷 종가 대표의 당일 max(qty) 이상이다."""
    obs = [
        _ob_ap(90_000_000, [3000, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
        _ob_ap(90_000_500, [8000, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
        _ob_ap(90_000_900, [3000, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(_con_for(out), path=out, bucket_ms=60_000)
    assert peak is not None
    assert peak.max_qty >= peak.qty
    assert peak.qty == 3000
    assert peak.max_qty == 8000 and peak.max_qty > peak.qty


def _hhmmssms(i: int, ms: int) -> int:
    """i번째 이벤트를 유효한 HHMMSSmmm(비선형) 타임스탬프로 인코딩.

    분·초 자리올림이 유효한 값만 생성해 ``hhmmssms_to_intra_ms`` 디코딩이 WRONG
    ms를 만들지 않게 한다(중복/역순 방지).
    """
    return int(f"{10 + i // 3600:02d}{(i // 60) % 60:02d}{i % 60:02d}{ms:03d}")


def _pathological_peak_dataset(
    tmp_path: Path, *, n_snapshots: int, n_trades: int
) -> tuple[Path, Path]:
    """조인 폭발용: 넓은 가격 분포(distinct ask 레벨 다수) × 모든 레벨을 지배하는 고가 터치.

    비등가 조인 ``t.price >= p.price`` 의 카디널리티 = ``n_trades × distinct_prices`` 를
    인위적으로 키워 2026-07-05 356GB 스필 경로(실측 최악 distinct 803 × 55만 거래)를
    작은 규모로 재현한다. distinct 가격은 스냅샷 가격 사다리로, 터치 수는 거래로 분리 제어.
    """
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    obs = []
    for i in range(n_snapshots):
        base = 50000 + (i % 80) * 10  # 80 사다리 × 10 오프셋 → distinct 가격 ≈ 800
        obs.append(_ob_ap(_hhmmssms(i, 0), [100 + i % 50] * 10, ask_p=[base + j for j in range(10)]))
    write_parquet(obs, snapshots_path)
    top = 50000 + 80 * 10 + 100  # 모든 ask 레벨을 지배하는 고가(장중 이후 고정 ts)
    trades = [_trade(150_000_000, top, seq=i + 1) for i in range(n_trades)]
    write_trades(trades, trades_path)
    return snapshots_path, trades_path


@pytest.mark.xfail(reason="quadratic non-equi-join SQL path — removed in peak sweep rewrite", strict=True)
def test_query_day_ask_bid_peak_dual_perf_guardrail(tmp_path: Path) -> None:
    """2026-07-05 356GB 스필 회귀 방지: 넓은 가격 분포 × 다수 터치에서
    비등가 조인이 폭발하지 않고 수 초 안에 완료되어야 한다."""
    import time

    snapshots_path, trades_path = _pathological_peak_dataset(
        tmp_path, n_snapshots=2500, n_trades=60000
    )
    started = time.monotonic()
    ask, bid = query_day_ask_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )
    elapsed = time.monotonic() - started
    assert ask is not None
    assert elapsed < 5.0, f"peak dual query took {elapsed:.1f}s"
