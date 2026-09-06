from __future__ import annotations

import os
import threading
import time
from dataclasses import replace
from pathlib import Path

import duckdb
import polars as pl
import pyarrow.parquet as pq
import pytest

from hoga.tables import snapshots
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
    _classify_wall_frame,
    _peak_touched_distinct,
    query_at,
    query_day_ask_bid_peak_dual,
    query_day_ask_bid_peak_dual_with_rep,
    query_day_ask_peak,
    query_day_ask_peak_dual,
    query_day_bid_peak,
    query_day_bid_peak_dual,
    query_first_ts,
    query_time_bounds,
    reaggregate_peak_rep,
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


def test_write_parquet_quantities_exceed_int32(tmp_path: Path) -> None:
    """총잔량·개별 호가 잔량이 int32 max(2,147,483,647)를 넘는 고거래량/상한가-락
    종목도 write→read 왕복이 깨지지 않아야 한다. 프로덕션 회귀: 252670(KODEX
    인버스) 총잔량 2,366,893,147 이 int32 스키마의 pa.array(type=int32())에서
    ArrowInvalid('Value ... too large to fit in C integer type')로 당시 승격
    루프(REST 30s promote, 현재는 제거됨)를 죽였다. 상한가 락이면 물량이 한 호가에
    몰려 bid_q1 도 int32 를 넘고, 델타는 부호 있는 하방 오버플로가 난다 — 셋 다
    int64 로 커버되는지 검증한다."""
    from hoga.tables.snapshots import read_parquet

    big_tot = 2_366_893_147   # 실제 프로덕션 크래시 값 (> int32 max)
    big_qty = 3_000_000_000   # 상한가 락 시 단일 호가 집중 물량 (> int32 max)
    neg_delta = -3_000_000_000  # 부호 있는 델타의 하방 오버플로 (< int32 min)
    ob = Orderbook(
        ts_ms=90000435, seq=1,
        ask_p=(25700,) + (0,) * 9,
        ask_q=(big_qty,) + (0,) * 9,
        ask_d=(neg_delta,) + (0,) * 9,
        bid_p=(25650,) + (0,) * 9,
        bid_q=(big_qty,) + (0,) * 9,
        bid_d=(neg_delta,) + (0,) * 9,
        tot_ask=big_tot, tot_ask_d=neg_delta,
        tot_bid=big_tot, tot_bid_d=neg_delta,
    )
    out = tmp_path / "snapshots.parquet"
    write_parquet([ob], out)  # int32 스키마였다면 여기서 ArrowInvalid
    rows = read_parquet(out)
    assert rows == [ob]       # 값 손실 없이 왕복(dataclass 전체 동등)


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


def test_query_index_build_is_single_flight_across_threads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """동시에 들어온 캐시 미스는 빌드를 **1회만** 유발한다.

    예전에는 캐시 락이 조회에만 걸려 있어 같은 파일을 N 스레드가 각자 빌드했다.
    빌드 구간은 GIL 을 잡으므로 중복이 그대로 지연으로 쌓였다 — 2026-08-07 프로덕션에서
    `/api/orderbook` 세 요청이 16.5초를 함께 기다린 뒤 나란히 끝난 것이 그 서명이다.

    단언은 **호출 횟수**다(경과 시간 비율이 아니다). sleep 은 다른 스레드가 락 앞에
    도달할 창을 열 뿐이라, 경합이 안 나면 캐시 히트로 역시 1회가 되어 위양성이 없다.
    """
    obs = [
        PARSERS[2](_ob_parts(ts_ms=90000000 + i * 1000, seq=i)) for i in range(1, 21)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)

    snapshots._query_at_cache.clear()
    with snapshots._query_at_build_locks_guard:
        snapshots._query_at_build_locks.clear()

    builds: list[Path] = []
    original_build = snapshots._build_query_index

    def counting_build(
        path: Path, stat: os.stat_result
    ) -> snapshots._SnapshotQueryIndex:
        builds.append(path)
        time.sleep(0.05)  # 나머지 스레드가 빌드 락에 도달할 창
        return original_build(path, stat)

    monkeypatch.setattr(snapshots, "_build_query_index", counting_build)

    barrier = threading.Barrier(4)
    results: list[object] = []

    def worker() -> None:
        barrier.wait()
        results.append(snapshots._load_query_index(out))

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(builds) == 1, f"중복 빌드 {len(builds)}회 — single-flight 락이 깨졌다"
    assert len(results) == 4
    assert all(result is results[0] for result in results)


def test_query_index_keeps_arrow_table_instead_of_materialized_rows() -> None:
    """인덱스는 행 튜플을 미리 만들지 않는다.

    75k 행 × 66컬럼을 `to_pylist()` 로 미리 펼치면 그 변환이 GIL 을 잡아 읽기 경로가
    통째로 직렬화된다(2026-08-07 실측: 파케이 읽기 4.1ms vs 변환 857ms, 8스레드 0.99x).
    행은 승자가 정해진 뒤 `_row_at` 이 하나만 꺼낸다.
    """
    fields = set(snapshots._SnapshotQueryIndex.__dataclass_fields__)
    assert "rows" not in fields
    assert "table" in fields


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

    Pads/truncates the given tuples to 10.

    ⚠ **가격은 더 이상 filler 가 아니다.** ``band_pct`` (사다리 폭)가 ask_p/bid_p 에서
    나오므로 이 픽스처의 가격 배치(ask 1..10, bid 10..1 — 실제 호가창과 달리 매도가
    매수보다 낮다)가 그대로 폭에 반영된다: (10 − 1) / ((1 + 10) / 2) × 100 =
    ``_OB_BAND_PCT``. 총잔량 계열만 볼 때는 여전히 ask_q / bid_q 만 중요하다.
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


@pytest.mark.parametrize("deep_time", [85_900_000, 90_000_000, 153_100_000, None])
def test_ratio_does_not_scan_for_last_continuous_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, deep_time: int | None,
) -> None:
    # 경계 이전 deep book의 '존재'만 필요하다. 실제 마지막 시각이 필요한
    # 다른 지표용 MAX 스캔을 총잔량에 다시 도입하지 않는다.
    obs = [_ob(ts_ms=90_100_000, seq=2, ask_q=(7,), bid_q=(9,))]
    if deep_time is not None:
        obs.append(_ob(ts_ms=deep_time, seq=1, ask_q=(1,) * 10, bid_q=(2,) * 10))
    path = tmp_path / "snapshots.parquet"
    write_parquet(obs, path)

    def unexpected_scan(*args, **kwargs):
        pytest.fail("총잔량은 마지막 유효 시각의 전체 MAX 스캔이 필요하지 않다")

    monkeypatch.setattr(snapshots, "_last_continuous_intra_ms", unexpected_scan)
    with duckdb.connect() as con:
        rows = snapshots.query_bucketed_ratio(
            con, path=path, bucket_ms=60_000,
            session_open_ms=90_000_000, session_close_ms=153_000_000,
        )
    shallow = next(r for r in rows if r.bucket_intra_ms == (9 * 60 + 1) * 60_000)
    # 기존 존재 판정에는 open 하한이 없다. 개장 전 deep만 있어도 구조 배제를
    # 활성화하며, 마감 후 deep만 있거나 deep이 없으면 퇴화 fallback을 유지한다.
    expected = (0, 0) if deep_time in (85_900_000, 90_000_000) else (9, 7)
    assert (shallow.bid_total, shallow.ask_total) == expected


@pytest.mark.parametrize("deep_time", [85_900_000, 90_000_000, 153_100_000, None])
def test_heatmap_uses_existence_without_last_time_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, deep_time: int | None,
) -> None:
    obs = [_ob(ts_ms=90_100_000, seq=2, ask_q=(7,), bid_q=(9,))]
    if deep_time is not None:
        obs.append(_ob(ts_ms=deep_time, seq=1, ask_q=(1,) * 10, bid_q=(2,) * 10))
    path = tmp_path / "snapshots.parquet"
    write_parquet(obs, path)

    def unexpected_scan(*args, **kwargs):
        pytest.fail("heatmap only needs existence, not the last continuous timestamp")

    monkeypatch.setattr(snapshots, "_last_continuous_intra_ms", unexpected_scan)
    with duckdb.connect() as con:
        rows = snapshots.query_bucketed_depth_heatmap(
            con, path=path, bucket_ms=60_000,
            session_open_ms=90_000_000, session_close_ms=153_000_000,
        )
    shallow = [r for r in rows if r.bucket_intra_ms == (9 * 60 + 1) * 60_000]
    if deep_time in (85_900_000, 90_000_000):
        assert shallow == []
    else:
        assert shallow[0].ask_qtys[0] == 7
        assert shallow[0].bid_qtys[0] == 9


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


def test_query_bucketed_ratio_excludes_opening_auction_via_open_bound(tmp_path: Path) -> None:
    """ADR-0062 v3: session_open_ms 하한으로 개장 동시호가를 (0,0) 센티넬로 배제한다
    (매도벽·히트맵과 공용 술어). 개장 전 deep book(구조 술어 통과)이라도 open 하한이
    잡아 대표에서 제외 → 그 버킷은 (0,0)."""
    from hoga.tables.snapshots import query_bucketed_ratio

    # 08:59:00 개장 전 deep book(구조 통과) + 09:01:00 정규장 deep book.
    obs = [
        _ob(ts_ms=85_900_000, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10),
        _ob(ts_ms=90_100_000, seq=2, ask_q=(300,) * 10, bid_q=(300,) * 10),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_ratio(
        con, path=out, bucket_ms=60_000,
        session_open_ms=90_000_000, session_close_ms=153_000_000,
    )
    by = {r.bucket_intra_ms: r for r in rows}
    # 개장 전 버킷(08:59 → linear 32_340_000): 유효 스냅샷 없음 → (0,0) 센티넬.
    assert (by[32_340_000].bid_total, by[32_340_000].ask_total) == (0, 0)
    # 정규장 버킷(09:01 → linear 32_460_000): 실제 총잔량(300 × 10레벨).
    assert by[32_460_000].ask_total == 3000
    assert by[32_460_000].bid_total == 3000


def test_query_bucketed_ratio_int32_overflow_on_extreme_book(tmp_path: Path) -> None:
    """A limit-up small-cap book can carry ~350M shares per level; the 10-level
    SUM then exceeds INT32 max (2_147_483_647). Regression for the production
    HTTP 500 (`OutOfRangeException: Overflow in addition of INT32`) observed on
    real capture data (differential `2085534523 + 176964345`). ask_q/bid_q are
    persisted as INT32 columns (see PARQUET_SCHEMA), so summing them in SQL
    without widening overflows; _ASK_Q_SUM/_BID_Q_SUM (and the deep-book
    _ASK_DEEP_SUM/_BID_DEEP_SUM used to classify continuous-vs-auction books)
    must accumulate in BIGINT.

    All 10 levels are > 0 (deep levels 4..10 included) so the snapshot
    classifies as a continuous-trading book (_DEEP_BOOK_SQL / is_pre), which is
    required for it to contribute to bid_total/ask_total at all. The per-level
    quantity (350M) is chosen so that BOTH the full 10-level sum AND the deep
    (level 4..10, 7-term) sum independently exceed INT32 max — this exercises
    the deep-book classification query (line ~822, which runs before the main
    totals query) as well as the totals query itself.
    """
    from hoga.tables.snapshots import query_bucketed_ratio

    per_level_ask = (350_000_000,) * 10
    per_level_bid = (350_000_000,) * 10
    expected_ask_total = sum(per_level_ask)
    expected_bid_total = sum(per_level_bid)
    assert expected_ask_total == 3_500_000_000
    assert expected_bid_total == 3_500_000_000
    assert expected_ask_total > 2_147_483_647  # INT32 max
    assert expected_bid_total > 2_147_483_647
    # Deep-book sum (levels 4..10, 7 terms) also exceeds INT32 max on its own,
    # stressing _ASK_DEEP_SUM / _BID_DEEP_SUM independently of the full sum.
    expected_ask_deep = sum(per_level_ask[3:])
    expected_bid_deep = sum(per_level_bid[3:])
    assert expected_ask_deep == 2_450_000_000
    assert expected_bid_deep == 2_450_000_000
    assert expected_ask_deep > 2_147_483_647
    assert expected_bid_deep > 2_147_483_647

    obs = [_ob(ts_ms=90_000_100, seq=1, ask_q=per_level_ask, bid_q=per_level_bid)]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()

    rows = query_bucketed_ratio(
        con, path=out, bucket_ms=60_000, session_close_ms=153_000_000,
    )

    assert len(rows) == 1
    assert rows[0].bid_total == expected_bid_total
    assert rows[0].ask_total == expected_ask_total


def test_query_bucketed_ratio_empty_parquet_returns_no_rows(tmp_path: Path) -> None:
    from hoga.tables.snapshots import query_bucketed_ratio

    out = tmp_path / "snapshots.parquet"
    write_parquet([], out)
    con = duckdb.connect()
    assert query_bucketed_ratio(con, path=out, bucket_ms=1000) == []


# ---------------------------------------------------------------------------
# query_daily_depth_peak: 하루치 매도/매수 총잔량(10단계 합) 당일 최댓값 스칼라
# ---------------------------------------------------------------------------


def test_query_daily_depth_peak_is_max_over_eligible_snapshots(tmp_path: Path) -> None:
    """당일 peak = 유효 스냅샷 전체의 SUM(ask_q1..10)/bid_q 최댓값. bucketed_ratio가
    pane에 그리는 Intra-Bar Max(ask_max)를 하루로 collapse한 값과 일치해야 한다."""
    from hoga.tables.snapshots import query_daily_depth_peak

    obs = [
        _ob(ts_ms=90_100_000, seq=1, ask_q=(100,) * 10, bid_q=(50,) * 10),   # ask 1000
        _ob(ts_ms=91_000_000, seq=2, ask_q=(300,) * 10, bid_q=(10,) * 10),   # ask 3000 (peak)
        _ob(ts_ms=92_000_000, seq=3, ask_q=(200,) * 10, bid_q=(400,) * 10),  # bid 4000 (peak)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    peak = query_daily_depth_peak(
        con, path=out, session_open_ms=90_000_000, session_close_ms=153_000_000,
    )
    assert peak is not None
    assert peak.ask_peak == 3000
    assert peak.bid_peak == 4000
    assert peak.eligible_count == 3


def test_query_daily_depth_peak_excludes_opening_and_closing_auction(tmp_path: Path) -> None:
    """ADR-0062 v3 술어 재사용: 개장 전(session_open 하한)·마감 동시호가(3호가 붕괴
    구조 술어)는 peak 계산에서 배제된다 — bucketed_ratio와 같은 규칙."""
    from hoga.tables.snapshots import query_daily_depth_peak

    obs = [
        # 08:59 개장 전 deep book(구조 통과, but open 하한이 배제) — 거대한 잔량이지만 무시.
        _ob(ts_ms=85_900_000, seq=1, ask_q=(9999,) * 10, bid_q=(9999,) * 10),
        # 09:01 정규장 deep book — 실제 peak.
        _ob(ts_ms=90_100_000, seq=2, ask_q=(300,) * 10, bid_q=(300,) * 10),
        # 15:25 마감 동시호가(3호가만) — 구조 술어가 배제.
        _ob(ts_ms=152_500_000, seq=3, ask_q=(500, 500, 500), bid_q=(500, 500, 500)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    peak = query_daily_depth_peak(
        con, path=out, session_open_ms=90_000_000, session_close_ms=153_000_000,
    )
    assert peak is not None
    assert peak.ask_peak == 3000   # 09:01 봉만(300×10), 개장전/마감동시호가 제외
    assert peak.bid_peak == 3000
    assert peak.eligible_count == 1


def test_query_daily_depth_peak_empty_or_no_eligible_returns_none(tmp_path: Path) -> None:
    """빈 parquet → None. deep book 이 존재하되 전부 세션 밖(개장 전)이면 유효 0 → None."""
    from hoga.tables.snapshots import query_daily_depth_peak

    out = tmp_path / "snapshots.parquet"
    write_parquet([], out)
    con = duckdb.connect()
    assert query_daily_depth_peak(
        con, path=out, session_open_ms=90_000_000, session_close_ms=153_000_000,
    ) is None

    # deep book 이 존재해 last_continuous 가 잡히므로 실제 술어가 적용된다. 그 deep
    # book 이 전부 개장 전(08:59)이면 open 하한이 배제 → 유효 0 → MAX NULL → None.
    obs = [_ob(ts_ms=85_900_000, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10)]
    out2 = tmp_path / "snapshots2.parquet"
    write_parquet(obs, out2)
    assert query_daily_depth_peak(
        con, path=out2, session_open_ms=90_000_000, session_close_ms=153_000_000,
    ) is None


def test_query_daily_depth_peak_degenerate_no_deep_book_falls_back_to_true(tmp_path: Path) -> None:
    """파일 전체에 세션내 deep book 이 하나도 없으면(퇴화 캡처) query_bucketed_ratio
    와 동일하게 술어가 TRUE 로 완화된다 — 시리즈를 통째로 비우지 않는다. 정상 거래일은
    항상 deep book 이 있어 이 분기는 퇴화 데이터에서만 발화한다."""
    from hoga.tables.snapshots import query_daily_depth_peak

    # 전부 3호가(구조 술어 미통과) → last_continuous None → 술어 TRUE 폴백.
    obs = [_ob(ts_ms=100_000_000, seq=1, ask_q=(1, 2, 3), bid_q=(4, 5, 6))]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    peak = query_daily_depth_peak(
        con, path=out, session_open_ms=90_000_000, session_close_ms=153_000_000,
    )
    assert peak is not None
    assert peak.ask_peak == 6    # 1+2+3
    assert peak.bid_peak == 15   # 4+5+6


def test_query_bucketed_depth_heatmap_picks_last_continuous_snapshot(tmp_path: Path) -> None:
    """session_close_ms 없음 → pre_auction_pred가 "TRUE"로 붕괴 → 단순
    last-in-bucket 대표 선택. 같은 분(minute) 버킷에 이른(작은잔량)·늦은(큰잔량)
    스냅샷을 두면 대표는 늦은 스냅샷이어야 하고(rep_key = intra_ms 만으로 결정),
    한 struct_pack에 묶인 40개 레벨 컬럼이 그 대표 물리 행에서 함께(round-trip)
    나오는지 검증한다. (deep-book 분류 경로는 여기서 타지 않음 — 그건
    session_close_ms를 넘기는 아래 테스트가 커버.)"""
    from hoga.tables.snapshots import query_bucketed_depth_heatmap

    # 두 스냅샷 모두 같은 60s 버킷(09:00:xx → intra 32_400_xxx). session_close_ms를
    # 넘기지 않으므로 연속/동시호가 구분 없이 늦은 스냅샷(seq2, 900)이 대표.
    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10),
        _ob(ts_ms=90_000_900, seq=2, ask_q=(900,) * 10, bid_q=(900,) * 10),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_depth_heatmap(con, path=out, bucket_ms=60000)
    assert len(rows) == 1
    row = rows[0]
    assert len(row.ask_prices) == 10 and len(row.ask_qtys) == 10
    assert len(row.bid_prices) == 10 and len(row.bid_qtys) == 10
    assert row.ask_qtys[0] == 900   # later snapshot won
    assert row.bid_qtys[0] == 900
    # 가격도 대표 스냅샷의 것: _ob는 ask_p=range(1,11), bid_p=range(10,0,-1).
    assert row.ask_prices == tuple(range(1, 11))
    assert row.bid_prices == tuple(range(10, 0, -1))
    assert row.bucket_intra_ms == 32_400_000


def test_query_bucketed_depth_heatmap_drops_fully_auction_bucket(tmp_path: Path) -> None:
    """session_close_ms를 넘겨 공용 술어(_book_indicator_eligible_sql) WHERE 사전 필터를
    태운다. ADR-0062 v3: 완전-동시호가 버킷은 결과에서 통째로 빠진다(매도벽과 동일 패턴,
    종전 last-in-bucket 폴백 방출 폐기 — 프론트 라이브 빌더 드롭과 파리티).

    - 연속거래 버킷(15:18): deep book(레벨4..10 > 0) 스냅샷 → 유효 → 40컬럼 대표 유지.
    - 마감 동시호가 버킷(15:20:58): 3-레벨 붕괴 shallow book만 → 유효 스냅샷 0 →
      GROUP BY에서 자연 탈락(방출되지 않는다).
    query_bucketed_ratio의 auction/deep-book 테스트와 동일한 fixture 구성."""
    from hoga.tables.snapshots import query_bucketed_depth_heatmap

    z = tuple([0] * 10)
    # 15:18:00 연속거래 책(레벨4..10 > 0) — 유일한 유효 스냅샷.
    continuous = Orderbook(
        ts_ms=151_800_000, seq=1,
        ask_p=tuple(range(101, 111)), ask_q=(10, 20, 30, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple(range(100, 90, -1)), bid_q=(50, 40, 30, 20, 5, 5, 5, 5, 5, 5), bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    # 15:20:58 마감 동시호가: 3-레벨 붕괴(레벨4+ = 0) shallow book 2건 한 버킷 →
    # _DEEP_BOOK_SQL 탈락 → 유효 스냅샷 0 → 버킷 자연 탈락.
    collapsed1 = Orderbook(
        ts_ms=152_058_000, seq=2,
        ask_p=(101, 102, 103) + (0,) * 7, ask_q=(99, 98, 97) + (0,) * 7, ask_d=z,
        bid_p=(100, 99, 98) + (0,) * 7, bid_q=(7, 7, 7) + (0,) * 7, bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    collapsed2 = Orderbook(
        ts_ms=152_058_500, seq=3,
        ask_p=(201, 202, 203) + (0,) * 7, ask_q=(50, 40, 30) + (0,) * 7, ask_d=z,
        bid_p=(200, 199, 198) + (0,) * 7, bid_q=(5, 5, 5) + (0,) * 7, bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    out = tmp_path / "snapshots.parquet"
    write_parquet([continuous, collapsed1, collapsed2], out)
    con = duckdb.connect()
    rows = query_bucketed_depth_heatmap(
        con, path=out, bucket_ms=1000, session_close_ms=153000000,
    )
    assert len(rows) == 1  # 연속거래 버킷만 — 완전-동시호가 버킷은 탈락
    cont_row = rows[0]

    # 연속거래 버킷: deep 스냅샷(seq1)의 40컬럼을 그대로 유지.
    assert cont_row.ask_qtys == (10, 20, 30, 40, 5, 6, 7, 8, 9, 1)
    assert cont_row.bid_qtys == (50, 40, 30, 20, 5, 5, 5, 5, 5, 5)
    assert cont_row.ask_prices == tuple(range(101, 111))
    assert cont_row.bid_prices == tuple(range(100, 90, -1))


def test_query_bucketed_depth_heatmap_drops_opening_auction_bucket(tmp_path: Path) -> None:
    """ADR-0062 v3: session_open_ms 하한으로 개장 동시호가 버킷을 배제한다(매도벽 동일).
    개장 전 10레벨 호가(구조 술어를 통과하는 라이브 WS 가정)라도 open 하한이 잡는다.

    - 08:59:00 개장 전 deep book(구조 통과) → open 하한(<09:00)으로 배제 → 버킷 탈락.
    - 09:01:00 정규장 deep book → 유효 → 방출."""
    from hoga.tables.snapshots import query_bucketed_depth_heatmap

    # 08:59:00 개장 전: 일부러 deep book(레벨4..10 > 0)으로 둬 구조 술어를 통과시킨다 —
    # open 하한이 유일한 배제 경로임을 검증.
    pre_open = _ob(ts_ms=85_900_000, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10)
    # 09:01:00 정규장 deep book.
    regular = _ob(ts_ms=90_100_000, seq=2, ask_q=(300,) * 10, bid_q=(300,) * 10)
    out = tmp_path / "snapshots.parquet"
    write_parquet([pre_open, regular], out)
    con = duckdb.connect()
    rows = query_bucketed_depth_heatmap(
        con, path=out, bucket_ms=60000,
        session_open_ms=90000000, session_close_ms=153000000,
    )
    assert len(rows) == 1  # 정규장 버킷만 — 개장 동시호가 버킷은 open 하한으로 탈락
    assert rows[0].bucket_intra_ms == 32_460_000  # 09:01 linear ms
    assert rows[0].ask_qtys[0] == 300


def test_query_bucketed_depth_heatmap_max_total_snapshot(tmp_path: Path) -> None:
    """대표(종가=마지막) 스냅샷과 별개로, 버킷 내 총잔량(bid+ask 10레벨 합)이
    최대였던 스냅샷의 40컬럼을 ``*_max`` 필드로 함께 방출하는지 검증(캔들 고가처럼).

    같은 60s 버킷에 deep book 3건. session_close_ms 미전달 → pre_auction_pred가
    "TRUE"로 붕괴 → is_pre 모두 1 → max는 순수 total로 결정. 최대(중간 스냅샷,
    total=10000)와 종가(마지막, total=6000)가 다르므로 두 대표가 갈린다."""
    from hoga.tables.snapshots import query_bucketed_depth_heatmap

    # 모두 같은 60s 버킷(09:00:xx → intra 32_400_xxx). 레벨 4..10 > 0 = deep book.
    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10),  # total=2000
        _ob(ts_ms=90_000_500, seq=2, ask_q=(500,) * 10, bid_q=(500,) * 10),  # total=10000 ← MAX
        _ob(ts_ms=90_000_900, seq=3, ask_q=(300,) * 10, bid_q=(300,) * 10),  # total=6000 ← 종가
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_depth_heatmap(con, path=out, bucket_ms=60000)
    assert len(rows) == 1
    r = rows[0]
    # 종가(대표) = 마지막 스냅샷.
    assert r.ask_qtys[0] == 300
    assert r.bid_qtys[0] == 300
    # 최대총잔량 대표 = 중간 스냅샷.
    assert r.ask_qtys_max[0] == 500
    assert r.bid_qtys_max[0] == 500
    assert len(r.ask_prices_max) == 10 and len(r.ask_qtys_max) == 10
    assert len(r.bid_prices_max) == 10 and len(r.bid_qtys_max) == 10
    # 가격도 대표 스냅샷의 것: _ob는 ask_p=range(1,11), bid_p=range(10,0,-1).
    assert r.ask_prices_max == tuple(range(1, 11))
    assert r.bid_prices_max == tuple(range(10, 0, -1))


def test_query_bucketed_depth_heatmap_per_price_max_differs_from_total_argmax(
    tmp_path: Path,
) -> None:
    """``*_pmax``(가격대마다 따로 최댓값)가 ``*_max``(총잔량 argmax 스냅샷)와 **갈리는지**.

    두 계열이 갈리려면 **어떤 가격의 최고 시점이 총잔량 최고 시점과 달라야** 한다.
    레벨 잔량을 균일하게 두면(기존 max 테스트가 그렇다) 두 값이 우연히 같아져서
    이 테스트가 아무것도 증명하지 못하므로, 최우선 호가만 다른 시점에 최고가 되게 짠다.

    실측을 축소한 것이다 — 005930 20260825 14:35 258,500원: 자기 최고 순간 93,543
    vs 총잔량 최고 순간 61,057(그 사이 10초). 사용자가 「당일 최대벽」과 히트맵을
    대조하다 발견한 20% 격차의 정체가 이 차이였다.
    """
    from hoga.tables.snapshots import query_bucketed_depth_heatmap

    obs = [
        # t1: 최우선 호가가 자기 최고(900). 총잔량 = 900 + 9*10 + 10*10 = 1090.
        _ob(ts_ms=90_000_100, seq=1, ask_q=(900,) + (10,) * 9, bid_q=(10,) * 10),
        # t2: 총잔량 최고(500*20 = 10000) — 그러나 최우선 호가는 500 뿐이다.
        _ob(ts_ms=90_000_500, seq=2, ask_q=(500,) * 10, bid_q=(500,) * 10),
        # t3: 종가(마지막).
        _ob(ts_ms=90_000_900, seq=3, ask_q=(300,) * 10, bid_q=(300,) * 10),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_depth_heatmap(con, path=out, bucket_ms=60000)
    assert len(rows) == 1
    r = rows[0]

    # 총잔량 argmax 는 t2 의 사진 통째 — 최우선 호가가 900 이었던 순간을 **놓친다**.
    assert r.ask_qtys_max[0] == 500
    # 가격대별은 그 순간을 잡는다. 나머지 레벨은 t2 가 최고(500).
    assert r.ask_qtys_pmax == (900,) + (500,) * 9
    assert r.bid_qtys_pmax == (500,) * 10

    # 정렬 규약 — ask 가격 오름차순 · bid 내림차순(`DepthHeatmapPoint` 가 프론트에
    # 약속한 순서). `_ob` 는 ask_p=range(1,11), bid_p=range(10,0,-1).
    assert r.ask_prices_pmax == tuple(range(1, 11))
    assert r.bid_prices_pmax == tuple(range(10, 0, -1))


def test_query_bucketed_depth_heatmap_per_price_max_drops_zero_qty_levels(
    tmp_path: Path,
) -> None:
    """가격대별 최댓값에서 잔량 0 레벨은 **셀을 만들지 않는다**.

    ``*_max`` 쪽은 "그 사진에 그렇게 찍혔다" 라 0 도 사실이지만, 가격대별에서 0 은
    "그 버킷에 후보가 없었다" 는 뜻이라 셀을 그리면 거짓이 된다. 프론트 누적기
    (`foldPriceMax`)도 같은 규약이다."""
    from hoga.tables.snapshots import query_bucketed_depth_heatmap

    # 레벨 4..10 > 0 이어야 deep book 으로 인정되므로 0 은 레벨 2 에만 둔다.
    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(100, 0) + (100,) * 8, bid_q=(100,) * 10),
        _ob(ts_ms=90_000_500, seq=2, ask_q=(200, 0) + (200,) * 8, bid_q=(200,) * 10),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_depth_heatmap(con, path=out, bucket_ms=60000)
    r = rows[0]
    # ask_p=2 는 두 틱 모두 0 이라 빠진다 → 9개.
    assert len(r.ask_prices_pmax) == 9
    assert 2 not in r.ask_prices_pmax
    assert all(q > 0 for q in r.ask_qtys_pmax)
    # `*_max` 는 그대로 10칸(0 포함) — 두 계열의 규약이 다르다는 것이 요점이다.
    assert len(r.ask_qtys_max) == 10


def test_query_bucketed_depth_heatmap_excludes_intraday_vi_in_mixed_bucket(tmp_path: Path) -> None:
    """ADR-0062 v2 (VI 통일): 한 버킷에 연속거래 책 + 그보다 **시간상 늦은** 장중 VI
    붕괴책이 섞이면, 대표는 늦은 VI가 아니라 연속거래 책이어야 한다(_DEEP_BOOK_SQL).
    이전(시간-only pre_auction_pred)엔 늦은 VI가 rep_key로 대표가 됐다."""
    from hoga.tables.snapshots import query_bucketed_depth_heatmap

    z = tuple([0] * 10)
    # 11:40:00 연속거래(deep, 레벨4..10 > 0) — 같은 60s 버킷 내, ask_q[0]=10
    cont = Orderbook(
        ts_ms=114_000_000, seq=1,
        ask_p=tuple(range(101, 111)), ask_q=(10, 20, 30, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple(range(100, 90, -1)), bid_q=(50, 40, 30, 20, 5, 5, 5, 5, 5, 5), bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    # 11:40:30 장중 VI 3-레벨 붕괴(레벨4+ = 0) — 같은 버킷, 시간상 더 늦음. ask_q[0]=99
    vi = Orderbook(
        ts_ms=114_030_000, seq=2,
        ask_p=(101, 102, 103) + (0,) * 7, ask_q=(99, 98, 97) + (0,) * 7, ask_d=z,
        bid_p=(100, 99, 98) + (0,) * 7, bid_q=(7, 7, 7) + (0,) * 7, bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    # 15:19:00 연속거래 앵커 — last_continuous_ms를 마감 근처로 세운다(VI는 그 이전).
    anchor = Orderbook(
        ts_ms=151_900_000, seq=3,
        ask_p=tuple(range(101, 111)), ask_q=(10, 20, 30, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple(range(100, 90, -1)), bid_q=(50, 40, 30, 20, 5, 5, 5, 5, 5, 5), bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    out = tmp_path / "snapshots.parquet"
    write_parquet([cont, vi, anchor], out)
    con = duckdb.connect()
    rows = query_bucketed_depth_heatmap(
        con, path=out, bucket_ms=60000, session_close_ms=153000000
    )
    reps = {r.ask_qtys[0] for r in rows}
    assert 99 not in reps, "장중 VI 붕괴책이 대표가 되면 안 됨(ADR-0062 v2)"
    assert 10 in reps, "연속거래 책이 대표여야 함"


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
    from hoga.util.timeenc import hhmmssms_to_unix_ms  # noqa: F401 (의도 명시용)

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


#: `_ob` 픽스처의 사다리 폭 — ask_p = 1..10, bid_p = 10..1 → (10 − 1) / 5.5 × 100.
_OB_BAND_PCT = 163.63636363636363

#: 두 픽스처 모두 중간가가 2,000원 미만이라 KRX 호가단위는 1원이다
#: (`_deep` mid = 100.5, `_ob` mid = 5.5).
_FIXTURE_TICK = 1

#: 두 골든 테스트의 `_deep` 픽스처가 갖는 사다리 폭(중간가 대비 %).
#: ask_p = 101..110, bid_p = 100..91 → (110 − 91) / ((101 + 100) / 2) × 100.
#: ⚠ **폭과 틱은 게이트가 다르다** — 붕괴 사다리는 폭을 못 재지만(ask_p10 = 0) 틱은
#: 중간가만 있으면 알 수 있다. 그래서 `band_pct = 0, tick = 1` 인 행이 정상으로 존재한다.
#: **폭에는 is_pre 와 별개의 두 번째 게이트가 있다** — 3단 붕괴 사다리는 `ask_p10 = 0`
#: 이라 폭을 잴 수 없어 0.0 이다. `session_close_ms=None` 분기(is_pre = TRUE)에서
#: 붕괴 행이 대표가 되면 총잔량은 나오는데 폭만 0 인 행이 생긴다 — 소비자는 0 을
#: "폭이 0" 이 아니라 **"보정 불가"** 로 다뤄야 한다.
_DEEP_BAND_PCT = 18.90547263681592

# ---------------------------------------------------------------------------
# query_bucketed_ratio golden values: the arg_max/arg_min GROUP BY rewrite
# was differentially validated against the prior windowed implementation
# (now deleted — real-data differential over 11,398 capture files with
# production session_close_ms values found 0 mismatches, 0 regressions; 14
# files showed pre-existing same-ts_ms representative-row nondeterminism
# unrelated to the rewrite). These tests now pin the rewrite's output
# directly against hardcoded expected rows — see ADR/plan "호가비 arg_max
# 재작성".
# ---------------------------------------------------------------------------


def test_query_bucketed_ratio_parity_mixed_continuous_and_auction_tail(
    tmp_path: Path,
) -> None:
    """Mixed bucket set: a normal continuous bucket, a straddle bucket (has
    both pre and non-pre rows), and a fully-auction tail bucket — the case
    that exercises the is_pre gating end-to-end."""
    from hoga.tables.snapshots import QuoteRatioRow, query_bucketed_ratio

    z = tuple([0] * 10)

    def _deep(ts_ms: int, seq: int, ask_q: tuple[int, ...], bid_q: tuple[int, ...]) -> Orderbook:
        return Orderbook(
            ts_ms=ts_ms, seq=seq,
            ask_p=tuple(range(101, 111)), ask_q=(tuple(ask_q) + (0,) * 10)[:10], ask_d=z,
            bid_p=tuple(range(100, 90, -1)), bid_q=(tuple(bid_q) + (0,) * 10)[:10], bid_d=z,
            tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
        )

    def _shallow(ts_ms: int, seq: int, ask_q: tuple[int, ...], bid_q: tuple[int, ...]) -> Orderbook:
        return Orderbook(
            ts_ms=ts_ms, seq=seq,
            ask_p=(101, 102, 103) + (0,) * 7, ask_q=(tuple(ask_q) + (0,) * 10)[:10], ask_d=z,
            bid_p=(100, 99, 98) + (0,) * 7, bid_q=(tuple(bid_q) + (0,) * 10)[:10], bid_d=z,
            tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
        )

    obs = [
        # Bucket 1 (09:00): plain continuous bucket, 3 rows, last wins.
        _deep(90_000_100, 1, (10, 20, 30, 40, 5, 6, 7, 8, 9, 1), (900, 1, 1, 1, 1, 1, 1, 1, 1, 1)),
        _deep(90_000_500, 2, (50, 60, 70, 80, 5, 6, 7, 8, 9, 1), (50, 1, 1, 1, 1, 1, 1, 1, 1, 1)),
        _deep(90_000_900, 3, (100, 110, 120, 130, 5, 6, 7, 8, 9, 1), (20, 1, 1, 1, 1, 1, 1, 1, 1, 1)),
        # Bucket 2 (15:18): deep continuous row that sets last_continuous_ms.
        _deep(151_800_000, 4, (10, 20, 30, 40, 5, 6, 7, 8, 9, 1), (50, 40, 30, 20, 5, 5, 5, 5, 5, 5)),
        # Bucket 3 (15:20:58): fully-auction tail bucket (shallow, after threshold).
        _shallow(152_058_000, 5, (99, 98, 97), (7, 7, 7)),
        _shallow(152_058_500, 6, (50, 40, 30), (5, 5, 5)),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    # Golden values captured from query_bucketed_ratio's output before the
    # windowed reference implementation was deleted (row-identical per the
    # real-data differential — see module-level comment above).
    want_by_combo = {
        (1000, None): [
            QuoteRatioRow(bucket_intra_ms=32400000, bid_total=29, ask_total=496, bid_max=909, ask_max=496, imb_max_bid=29, imb_max_ask=496, band_pct=_DEEP_BAND_PCT, tick=_FIXTURE_TICK),
            QuoteRatioRow(bucket_intra_ms=55080000, bid_total=170, ask_total=136, bid_max=170, ask_max=136, imb_max_bid=170, imb_max_ask=136, band_pct=_DEEP_BAND_PCT, tick=_FIXTURE_TICK),
            QuoteRatioRow(bucket_intra_ms=55258000, bid_total=15, ask_total=120, bid_max=21, ask_max=294, imb_max_bid=21, imb_max_ask=294,
                          tick=_FIXTURE_TICK),
        ],
        (1000, 153000000): [
            QuoteRatioRow(bucket_intra_ms=32400000, bid_total=29, ask_total=496, bid_max=909, ask_max=496, imb_max_bid=29, imb_max_ask=496, band_pct=_DEEP_BAND_PCT, tick=_FIXTURE_TICK),
            QuoteRatioRow(bucket_intra_ms=55080000, bid_total=170, ask_total=136, bid_max=170, ask_max=136, imb_max_bid=170, imb_max_ask=136, band_pct=_DEEP_BAND_PCT, tick=_FIXTURE_TICK),
            QuoteRatioRow(bucket_intra_ms=55258000, bid_total=0, ask_total=0, bid_max=0, ask_max=0, imb_max_bid=0, imb_max_ask=0),
        ],
        (60_000, None): [
            QuoteRatioRow(bucket_intra_ms=32400000, bid_total=29, ask_total=496, bid_max=909, ask_max=496, imb_max_bid=29, imb_max_ask=496, band_pct=_DEEP_BAND_PCT, tick=_FIXTURE_TICK),
            QuoteRatioRow(bucket_intra_ms=55080000, bid_total=170, ask_total=136, bid_max=170, ask_max=136, imb_max_bid=170, imb_max_ask=136, band_pct=_DEEP_BAND_PCT, tick=_FIXTURE_TICK),
            QuoteRatioRow(bucket_intra_ms=55200000, bid_total=15, ask_total=120, bid_max=21, ask_max=294, imb_max_bid=21, imb_max_ask=294,
                          tick=_FIXTURE_TICK),
        ],
        (60_000, 153000000): [
            QuoteRatioRow(bucket_intra_ms=32400000, bid_total=29, ask_total=496, bid_max=909, ask_max=496, imb_max_bid=29, imb_max_ask=496, band_pct=_DEEP_BAND_PCT, tick=_FIXTURE_TICK),
            QuoteRatioRow(bucket_intra_ms=55080000, bid_total=170, ask_total=136, bid_max=170, ask_max=136, imb_max_bid=170, imb_max_ask=136, band_pct=_DEEP_BAND_PCT, tick=_FIXTURE_TICK),
            QuoteRatioRow(bucket_intra_ms=55200000, bid_total=0, ask_total=0, bid_max=0, ask_max=0, imb_max_bid=0, imb_max_ask=0),
        ],
    }
    for bucket_ms in (1000, 60_000):
        for session_close_ms in (None, 153000000):
            got = query_bucketed_ratio(con, path=out, bucket_ms=bucket_ms, session_close_ms=session_close_ms)
            assert got == want_by_combo[(bucket_ms, session_close_ms)]


def test_query_bucketed_ratio_parity_one_side_zero_and_imb_tie_earlier_ts_wins(
    tmp_path: Path,
) -> None:
    """Degenerate one-side-zero snapshot (imb_key forced to 0) plus a genuine
    imb magnitude tie between two rows at DISTINCT ts_ms — the earlier ts_ms
    must win (arg_min tiebreak on ts_ms ASC)."""
    from hoga.tables.snapshots import QuoteRatioRow, query_bucketed_ratio

    obs = [
        # One side zero -> imb_key gated to 0 (not a real imbalance candidate).
        _ob(ts_ms=90_000_100, seq=1, ask_q=(0,), bid_q=(500,)),
        # Two rows with identical |imbalance| magnitude (ask/bid ratio equal);
        # earlier ts_ms (seq=2) must win over later ts_ms (seq=3) on the tie.
        _ob(ts_ms=90_000_300, seq=2, ask_q=(10,), bid_q=(100,)),  # imb = 100/10-1 = 9
        _ob(ts_ms=90_000_600, seq=3, ask_q=(20,), bid_q=(200,)),  # imb = 200/20-1 = 9 (tie)
        _ob(ts_ms=90_000_900, seq=4, ask_q=(30,), bid_q=(30,)),  # 종가, no imbalance
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    got = query_bucketed_ratio(con, path=out, bucket_ms=1000)
    # Golden value: earlier-ts row (seq=2: bid=100, ask=10) wins the imb tie.
    assert got == [
        QuoteRatioRow(bucket_intra_ms=32400000, bid_total=30, ask_total=30, bid_max=500, ask_max=30, imb_max_bid=100, imb_max_ask=10, band_pct=_OB_BAND_PCT, tick=_FIXTURE_TICK),
    ]


def test_query_bucketed_ratio_parity_empty_parquet(tmp_path: Path) -> None:
    from hoga.tables.snapshots import query_bucketed_ratio

    out = tmp_path / "snapshots.parquet"
    write_parquet([], out)
    con = duckdb.connect()
    got = query_bucketed_ratio(con, path=out, bucket_ms=1000)
    assert got == []


def test_query_bucketed_ratio_parity_genuine_straddle_bucket(tmp_path: Path) -> None:
    """A GENUINE straddle bucket: one bucket_ms=60_000 bucket holding BOTH a
    deep/continuous row and a shallow/auction row, with session_close_ms
    falling strictly between their intra_ms values. This is the ADR-0062 case
    (continuous->auction transition drifting to ~15:20:01.xx instead of a
    bucket boundary) — the ONE case where the representative tiering
    (``is_pre DESC`` outranking ``ts_ms DESC``) actually changes the winner
    versus plain last-in-bucket, rather than being a no-op. (The prior "mixed"
    parity test's docstring claimed a straddle bucket, but its bucket 2 only
    ever contains the single deep row — bucket 3 is fully shallow — so it
    never exercised this tiering. This test closes that gap.)

    ts_ms / session_close_ms chosen so the straddle is REAL, verified via the
    actual hhmmssms_to_intra_ms_sql SQL expression (not just hand math):
      intra(deep=15:20:05.000)    = 55_205_000  -> bucket 55_205_000//60_000 = 920
      intra(close=15:20:30.000)   = 55_230_000
      intra(shallow=15:20:35.000) = 55_235_000  -> bucket 55_235_000//60_000 = 920
    Both rows land in bucket 920 (bucket_intra_ms = 920 * 60_000 = 55_200_000),
    and intra(deep) <= intra(close) < intra(shallow) — deep is at/before the
    close, shallow is strictly after. So last_continuous_ms = intra(deep) =
    55_205_000, and within bucket 920 the deep row is_pre=TRUE beats the later
    shallow row (is_pre=FALSE): the tiering picks the EARLIER deep row over
    the LATER shallow row, the one case where the tiering is not a no-op.
    """
    from hoga.tables.snapshots import query_bucketed_ratio
    from hoga.util.timeenc import hhmmssms_to_intra_ms_sql

    z = tuple([0] * 10)
    DEEP_TS = 152_005_000  # 15:20:05.000 — continuous book, depth beyond level 3
    SHALLOW_TS = 152_035_000  # 15:20:35.000 — auction book, collapsed to 3 levels
    SESSION_CLOSE_MS = 152_030_000  # 15:20:30.000 — strictly between the two
    BUCKET_MS = 60_000

    deep = Orderbook(
        ts_ms=DEEP_TS, seq=1,
        ask_p=tuple(range(101, 111)), ask_q=(10, 20, 30, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple(range(100, 90, -1)), bid_q=(50, 40, 30, 20, 5, 5, 5, 5, 5, 5), bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    shallow = Orderbook(
        ts_ms=SHALLOW_TS, seq=2,
        ask_p=(101, 102, 103) + (0,) * 7, ask_q=(99, 98, 97) + (0,) * 7, ask_d=z,
        bid_p=(100, 99, 98) + (0,) * 7, bid_q=(7, 7, 7) + (0,) * 7, bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    out = tmp_path / "snapshots.parquet"
    write_parquet([deep, shallow], out)
    con = duckdb.connect()

    # --- Confirm the straddle is REAL before trusting the fixture (per task
    # instructions: don't ship a test whose "straddle" is fictional). Uses the
    # actual SQL expression the implementations use, not hand-rolled math.
    intra_deep, intra_shallow, intra_close = con.execute(
        f"SELECT {hhmmssms_to_intra_ms_sql(str(DEEP_TS))},"
        f" {hhmmssms_to_intra_ms_sql(str(SHALLOW_TS))},"
        f" {hhmmssms_to_intra_ms_sql(str(SESSION_CLOSE_MS))}"
    ).fetchone()
    assert intra_deep // BUCKET_MS == intra_shallow // BUCKET_MS, (
        "fixture bug: deep and shallow rows must share one bucket"
    )
    assert intra_deep <= intra_close < intra_shallow, (
        "fixture bug: session_close_ms must fall strictly between the two rows"
    )
    bucket_intra_ms = (intra_deep // BUCKET_MS) * BUCKET_MS

    got = query_bucketed_ratio(con, path=out, bucket_ms=BUCKET_MS, session_close_ms=SESSION_CLOSE_MS)

    # Pin the actual behavior: the straddle
    # bucket's representative must be the DEEP row's totals (ask=136, bid=170
    # summed across its 10 levels), NOT the shallow row's (ask=294, bid=21),
    # and NOT 0 (which would indicate a wrongly-fully-auction classification).
    assert len(got) == 1
    r = got[0]
    assert r.bucket_intra_ms == bucket_intra_ms == 55_200_000
    assert (r.bid_total, r.ask_total) == (170, 136)  # deep row: 50+40+30+20+5*6 / 10+20+30+40+5+6+7+8+9+1
    assert (r.bid_max, r.ask_max) == (170, 136)
    assert (r.imb_max_bid, r.imb_max_ask) == (170, 136)


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
    assert sum(1 for l in snap.ask if l.qty > 0) == 4  # 10-level book, not the 3-level auction  # noqa: E741 — 도메인 관례 변수(OHLC 의 l = low 등)


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
) -> Orderbook:
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
) -> Orderbook:
    """bid_q/bid_p are length 10. ask is filled deep enough to look continuous."""
    bp = tuple(bid_p or [24950 - 50 * i for i in range(10)])
    bq = tuple(bid_q)
    aq = tuple([100] * 10)
    ap = tuple([25000 + 50 * i for i in range(10)])
    z = tuple([0] * 10)
    return Orderbook(ts_ms=ts_ms, seq=seq, ask_p=ap, ask_q=aq, ask_d=z,
                     bid_p=bp, bid_q=bq, bid_d=z, tot_ask=sum(aq), tot_ask_d=0,
                     tot_bid=sum(bq), tot_bid_d=0)


def _con_for(path) -> duckdb.DuckDBPyConnection:
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


def _peak_reagg_fixture(tmp_path: Path) -> tuple[Path, Path]:
    """분 단위로 흩어진 스냅샷 — **3분은 비운다**.

    5분 창 0(0~4분)의 마지막 rep 보유 분이 4분이고, 3분을 비워 둠으로써 "마지막
    1분 버킷" 이 아니라 **"rep 가 존재하는 마지막 1분 버킷"** 을 골라야 한다는
    규칙이 실제로 검사된다. 앞의 규칙으로 짜면 창 0 이 통째로 비어 실패한다.
    """
    snapshots = tmp_path / "snapshots.parquet"
    trades = tmp_path / "trades.parquet"
    # 분 m 의 타임스탬프(HHMMSSmmm): 09:00 부터 1분씩.
    def at(minute: int) -> int:
        return 90_000_000 + minute * 100_000
    obs = []
    for m, top_qty in ((0, 300), (1, 120), (2, 900), (4, 450), (5, 700), (6, 210)):
        obs.append(
            replace(
                _ob_ap(
                    at(m),
                    [top_qty, 300, 10, 40, 5, 6, 7, 8, 9, 1],
                    ask_p=[25100, 25200, 25300, 25400, 25500, 25600, 25700, 25800, 25900, 26000],
                ),
                bid_p=(24950, 24900, 24850, 24800, 24750, 24700, 24650, 24600, 24550, 24500),
                bid_q=(top_qty + 50, 80, 70, 60, 50, 40, 30, 20, 10, 1),
            )
        )
    write_parquet(obs, snapshots)
    # 터치를 **분 0·2·4·6 에만** 둔다(1·5 는 비운다) — ADR-0156 판정이 분 스코프라,
    # 봉을 바꾸면 창의 rep 가 다른 분으로 옮겨 가면서 터치/미터치가 둘 다 축약을 탄다.
    write_trades(
        [t for m in (0, 2, 4, 6) for t in (
            _trade(90_000_000 + m * 100_000 + 5_000, 25100),
            _trade(90_000_000 + m * 100_000 + 6_000, 24950, side=-1),
        )],
        trades,
    )
    return snapshots, trades


@pytest.mark.parametrize("bucket_ms", [180_000, 300_000, 600_000])
def test_reaggregate_peak_rep_matches_direct_query(tmp_path: Path, bucket_ms: int) -> None:
    """1분 rep 행을 접은 결과 == 그 봉으로 직접 조회한 결과.

    이 동치가 봉별 재계산을 없앨 수 있는 유일한 근거다(ratio/fill 의
    `test_indicator_reaggregate` 와 같은 역할).

    **막는 방향**: 축약이 직접 조회와 어긋나는 쪽 — `reaggregate_peak_rep` 이
    만드는 **모든** 출력 키에 대해. 키 집합 자체도 함께 고정한다: 키가 늘면
    비교 없이 지나가는 필드가 생기고, 그것이 정확히 아래 "못 보는 것" 이 실제
    드리프트로 번진 경로였다(2026-08-28).

    **못 보는 것**: 이 함수가 **만들지 않는** 필드. 두 부류이고 사유가 다르다 —
    ① 진짜 봉 무관(`*_max*` 스칼라·`traded_max_peaks`·`traded_record_max_peaks`·
    `unreached_*`)은 `test_peak_max_fields_are_bucket_independent` 가 본다.
    ② **봉 의존인데 1분을 정본으로 고정한 것**(`all_max_peaks`·
    `traded_record_peaks`)은 `test_bucket_dependent_fields_are_pinned_to_1m_canon`
    이 본다. ②를 "봉 무관" 으로 착각한 주석이 이 테스트의 구멍과 짝이었다.
    """
    snapshots, trades = _peak_reagg_fixture(tmp_path)
    con = _con_for(snapshots)
    kw = {"session_open_ms": 90_000_000, "session_close_ms": 153_000_000}

    direct_ask, direct_bid = query_day_ask_bid_peak_dual(
        con, path=snapshots, trades_path=trades, bucket_ms=bucket_ms, **kw,
    )
    _, _, rep_rows = query_day_ask_bid_peak_dual_with_rep(
        con, path=snapshots, trades_path=trades, bucket_ms=60_000, **kw,
    )

    for side, direct in (("ask", direct_ask), ("bid", direct_bid)):
        reduced = reaggregate_peak_rep(
            [r for r in rep_rows if r.side == side], side=side, bucket_ms=bucket_ms,
        )
        assert direct is not None and reduced is not None, side
        # 키 집합 고정 — 늘어난 키는 아래 단언을 못 받으므로 여기서 걸린다.
        assert set(reduced) == {
            "side", "all_close", "traded_close", "traded_peaks", "all_peaks",
        }, f"{side} reduced keys"
        assert reduced["side"] == side
        assert reduced["all_close"] == (
            direct.all_price, direct.all_qty, direct.all_intra_ms,
        ), f"{side} all_close"
        assert reduced["traded_close"] == (
            (direct.price, direct.qty, direct.intra_ms) if direct.price is not None else None
        ), f"{side} traded_close"
        assert reduced["traded_peaks"] == direct.traded_peaks, f"{side} traded_peaks"
        assert reduced["all_peaks"] == direct.all_peaks, f"{side} all_peaks"


@pytest.mark.parametrize("bucket_ms", [180_000, 300_000, 600_000])
def test_bucket_dependent_fields_are_pinned_to_1m_canon(
    tmp_path: Path, bucket_ms: int,
) -> None:
    """`all_max_peaks`·`traded_record_peaks` 는 **봉 의존인데 1분이 정본이다**.

    두 사실을 한 자리에서 건다:

    1. **봉 의존이다** — 굵은 봉으로 직접 조회하면 1분과 값이 다르다.
       `all_max_peaks` 는 `_peak_bucket_dedup` 이 `subset=["price", "bucket_id"]`
       로 접기 때문이고(이름이 `*_max*` 라 봉 무관으로 오해받았다),
       `traded_record_peaks` 는 rep 프레임 산물이기 때문이다.
    2. **그래도 1분 값이 나간다** — `reaggregate_peak_rep` 이 이 둘을 만들지
       않으므로 `_peak_with_rep_outputs` 가 base(1분)를 그대로 나른다. 재파생하려면
       cont 행이 필요한데 캐시에는 rep 행만 있어 원리적으로 불가능하다.

    **막는 방향**: 누군가 이 둘을 "봉 무관" 으로 되돌려 적거나
    `test_peak_max_fields_are_bucket_independent` 에 끼워 넣는 것. 그러면 1번
    단언이 빨개진다. **못 보는 것**: 1분 정본이 굵은 봉 정본보다 *더 옳은가* —
    그것은 값 판단이라 테스트가 아니라 `_peak_with_rep_outputs` docstring 이 논증한다.
    """
    snapshots, trades = _peak_reagg_fixture(tmp_path)
    con = _con_for(snapshots)
    kw = {"session_open_ms": 90_000_000, "session_close_ms": 153_000_000}

    base_ask, base_bid = query_day_ask_bid_peak_dual(
        con, path=snapshots, trades_path=trades, bucket_ms=60_000, **kw,
    )
    coarse_ask, coarse_bid = query_day_ask_bid_peak_dual(
        con, path=snapshots, trades_path=trades, bucket_ms=bucket_ms, **kw,
    )
    _, _, rep_rows = query_day_ask_bid_peak_dual_with_rep(
        con, path=snapshots, trades_path=trades, bucket_ms=60_000, **kw,
    )

    for side, base, coarse in (
        ("ask", base_ask, coarse_ask), ("bid", base_bid, coarse_bid),
    ):
        assert base is not None and coarse is not None, side
        for field in ("all_max_peaks", "traded_record_peaks"):
            assert getattr(base, field) != getattr(coarse, field), (
                f"{side} {field} @{bucket_ms}: 봉 의존이어야 한다 — 같다면 이 필드가 "
                f"정말 봉 무관이 되었거나 픽스처가 그 차이를 잃은 것이다"
            )
        # 2번: 축약이 이 둘을 만들지 않으므로 파생 결과에 base 값이 남는다.
        reduced = reaggregate_peak_rep(
            [r for r in rep_rows if r.side == side], side=side, bucket_ms=bucket_ms,
        )
        assert reduced is not None
        assert "all_max_peaks" not in reduced and "traded_record_peaks" not in reduced, side


def test_peak_max_fields_are_bucket_independent(tmp_path: Path) -> None:
    """틱-max(`cont`) 계열은 봉을 바꿔도 같다 — 1분 캐시에서 그대로 쓰는 근거.

    이 성질이 깨지면 `_peak_slices_from_1m_cache` 가 굵은 봉에 1분 값을 잘못
    실어 나른다. 실서버 캐시 파일 대조(024840 20260818, 1분 vs 5분)에서 확인한
    것을 픽스처로 고정한다.

    **ADR-0156 이후 이 테스트는 터치 규칙까지 건다.** 터치 창을 차트 봉으로 바꾸면
    `cont` 이벤트의 `touched` 가 봉에 따라 달라져 `traded_max_peaks` 가 갈린다 —
    창을 1분으로 고정한 이유의 절반이 여기 있고, 되돌리면 여기가 빨개진다.
    """
    snapshots, trades = _peak_reagg_fixture(tmp_path)
    con = _con_for(snapshots)
    kw = {"session_open_ms": 90_000_000, "session_close_ms": 153_000_000}
    base_ask, base_bid = query_day_ask_bid_peak_dual(
        con, path=snapshots, trades_path=trades, bucket_ms=60_000, **kw,
    )
    for bucket_ms in (180_000, 300_000, 600_000):
        ask, bid = query_day_ask_bid_peak_dual(
            con, path=snapshots, trades_path=trades, bucket_ms=bucket_ms, **kw,
        )
        for base, other, side in ((base_ask, ask, "ask"), (base_bid, bid, "bid")):
            assert base is not None and other is not None
            assert (base.max_price, base.max_qty, base.max_intra_ms) == (
                other.max_price, other.max_qty, other.max_intra_ms
            ), f"{side} max @{bucket_ms}"
            assert (base.all_max_price, base.all_max_qty, base.all_max_intra_ms) == (
                other.all_max_price, other.all_max_qty, other.all_max_intra_ms
            ), f"{side} all_max @{bucket_ms}"
            assert base.traded_max_peaks == other.traded_max_peaks, f"{side} traded_max_peaks @{bucket_ms}"


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


def test_query_day_ask_peak_dual_counts_only_same_minute_touch(tmp_path: Path) -> None:
    """**같은 1분 안의 체결만** 벽을 체결로 만든다(ADR-0156).

    막는 방향: 다른 분의 체결이 벽을 체결로 만드는 쪽(ADR-0084 의 옛 규칙).
    여기서 10:20 벽은 10:00 벽보다 **두 배 크지만** 자기 분에 체결이 없어 탈락한다 —
    옛 규칙이었다면 10:00 의 체결이 이후 내내 유효해 둘 다 체결이었다.
    못 보는 것: 봉(bucket_ms)을 바꿨을 때의 동작 — 위 bucket_independent 테스트가 본다.
    """
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
    # 10:00:00.500 — 첫 벽과 **같은 분**. 두 번째 벽(10:20)의 분에는 체결이 없다.
    write_trades([_trade(100000500, 50000)], trades_path)

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
    assert second not in peak.traded_peaks       # 자기 분에 체결이 없다
    assert (peak.price, peak.qty, peak.intra_ms) == (50000, 100000, 36_000_000)
    # `all_*` 은 터치와 무관하므로 더 큰 두 번째 벽이 그대로 1위다.
    assert (peak.all_price, peak.all_qty, peak.all_intra_ms) == (50000, 200000, 37_200_000)


def test_query_day_ask_peak_dual_ranks_touched_best_per_price(tmp_path: Path) -> None:
    """가격당 rank-1 은 **터치된 이벤트 중에서만** 고른다(ADR-0156).

    분 604 의 9000 벽이 그날 그 가격의 최대지만 자기 분에 체결이 없어 후보가 아니다 —
    "가장 큰 벽" 이 아니라 "체결된 것 중 가장 큰 벽" 이 답이라는 계약.
    ADR-0084 의 lifecycle 세그먼트는 전역 시간 관계였으므로 대응물이 없다.
    """
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
    # 분 600·602 에만 체결 — 분 601·604 의 벽은 자기 분에 체결이 없다.
    write_trades([_trade(100003000, 50200), _trade(100203000, 50200)], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    # 분 602 의 rep(7000)이 가격 50000 의 대표다 — 분 601 의 8000 도, 분 604 의 9000 도
    # 자기 분에 체결이 없어 후보가 아니다.
    traded = (
        AskPeakCandidateRow(price=50000, qty=7000, intra_ms=36_120_000),
        AskPeakCandidateRow(price=50100, qty=4200, intra_ms=36_120_000),
        AskPeakCandidateRow(price=50200, qty=3200, intra_ms=36_120_000),
    )
    assert peak.traded_peaks == traded
    assert peak.traded_max_peaks == traded
    assert 9000 not in [c.qty for c in peak.traded_peaks]


def test_query_day_ask_peak_dual_keeps_one_best_touched_wall_per_price(tmp_path: Path) -> None:
    """같은 가격이 top-N 슬롯을 독식하지 않는다 — 가격당 하나로 접는다."""
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
    # 각 체결을 **그 벽과 같은 분**에 둔다(분 600·602·604).
    write_trades([
        _trade(100001000, 50000),
        _trade(100201000, 50000),
        _trade(100401000, 50100),
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


def test_query_day_bid_peak_dual_counts_only_same_minute_touch(tmp_path: Path) -> None:
    """매수 대칭판 — `test_query_day_ask_peak_dual_counts_only_same_minute_touch` 참조."""
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
    # 10:00:00.500 — 첫 벽과 **같은 분**. 두 번째 벽(10:20)의 분에는 체결이 없다.
    write_trades([_trade(100000500, 50000)], trades_path)

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
    assert second not in peak.traded_peaks       # 자기 분에 체결이 없다
    assert (peak.price, peak.qty, peak.intra_ms) == (50000, 100000, 36_000_000)
    # `all_*` 은 터치와 무관하므로 더 큰 두 번째 벽이 그대로 1위다.
    assert (peak.all_price, peak.all_qty, peak.all_intra_ms) == (50000, 200000, 37_200_000)


def test_query_day_bid_peak_dual_ranks_touched_best_per_price(tmp_path: Path) -> None:
    """가격당 rank-1 은 **터치된 이벤트 중에서만** 고른다(ADR-0156).

    분 604 의 9000 벽이 그날 그 가격의 최대지만 자기 분에 체결이 없어 후보가 아니다 —
    "가장 큰 벽" 이 아니라 "체결된 것 중 가장 큰 벽" 이 답이라는 계약.
    ADR-0084 의 lifecycle 세그먼트는 전역 시간 관계였으므로 대응물이 없다.
    """
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
    # 분 600·602 에만 체결 — 분 601·604 의 벽은 자기 분에 체결이 없다.
    write_trades([_trade(100003000, 49800), _trade(100203000, 49800)], trades_path)

    peak = query_day_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    # 분 602 의 rep(7000)이 가격 50000 의 대표다 — 분 601 의 8000 도, 분 604 의 9000 도
    # 자기 분에 체결이 없어 후보가 아니다.
    traded = (
        AskPeakCandidateRow(price=50000, qty=7000, intra_ms=36_120_000),
        AskPeakCandidateRow(price=49900, qty=4200, intra_ms=36_120_000),
        AskPeakCandidateRow(price=49800, qty=3200, intra_ms=36_120_000),
    )
    assert peak.traded_peaks == traded
    assert peak.traded_max_peaks == traded
    assert 9000 not in [c.qty for c in peak.traded_peaks]


def test_query_day_ask_peak_dual_ignores_trade_in_another_minute(tmp_path: Path) -> None:
    """같은 **가격**을 쳤어도 **다른 분**이면 체결이 아니다(ADR-0156 의 핵심).

    체결 09:55 · 벽 10:00 — 가격은 정확히 일치한다. ADR-0084 에서는 시각 순서만
    보았으므로 이 배치가 미터치였지만, 순서를 뒤집으면(체결이 나중) 터치가 됐다.
    지금은 **순서와 무관하게** 분이 다르면 아니다.
    """
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
    # 터치와 무관한 `all_*` 에는 그대로 남는다.
    assert peak.all_peaks[0] == AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)


def test_query_day_bid_peak_dual_ignores_trade_in_another_minute(tmp_path: Path) -> None:
    """같은 **가격**을 쳤어도 **다른 분**이면 체결이 아니다(ADR-0156 의 핵심).

    체결 09:55 · 벽 10:00 — 가격은 정확히 일치한다. ADR-0084 에서는 시각 순서만
    보았으므로 이 배치가 미터치였지만, 순서를 뒤집으면(체결이 나중) 터치가 됐다.
    지금은 **순서와 무관하게** 분이 다르면 아니다.
    """
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
    # 터치와 무관한 `all_*` 에는 그대로 남는다.
    assert peak.all_peaks[0] == AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)


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


def test_query_day_ask_peak_dual_same_millisecond_earlier_seq_still_touches(tmp_path: Path) -> None:
    """같은 분 안이면 체결이 벽보다 **앞서도** 터치다(ADR-0156).

    ADR-0084 에서는 `(ts, seq)` 로 "이후" 를 따져 seq 9 < 10 이 미터치였다. 규칙이
    분 안에서 닫히면서 순서가 판정에서 빠졌고, 이 배치의 답이 **뒤집혔다** —
    기본 기준(rep)의 벽은 그 분의 마지막 스냅샷에서 관측되므로 "이후" 만 세면
    거의 전부 미터치가 되기 때문이다.
    """
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
    assert peak.traded_peaks == (AskPeakCandidateRow(price=50000, qty=1000, intra_ms=32_400_000),)
    assert (peak.price, peak.qty, peak.intra_ms) == (50000, 1000, 32_400_000)


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


def test_query_day_bid_peak_dual_same_millisecond_earlier_seq_still_touches(tmp_path: Path) -> None:
    """같은 분 안이면 체결이 벽보다 **앞서도** 터치다(ADR-0156).

    ADR-0084 에서는 `(ts, seq)` 로 "이후" 를 따져 seq 9 < 10 이 미터치였다. 규칙이
    분 안에서 닫히면서 순서가 판정에서 빠졌고, 이 배치의 답이 **뒤집혔다** —
    기본 기준(rep)의 벽은 그 분의 마지막 스냅샷에서 관측되므로 "이후" 만 세면
    거의 전부 미터치가 되기 때문이다.
    """
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
    assert peak.traded_peaks == (AskPeakCandidateRow(price=50000, qty=1000, intra_ms=32_400_000),)
    assert (peak.price, peak.qty, peak.intra_ms) == (50000, 1000, 32_400_000)


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
    assert peak.all_peaks[0] == AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)


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
    assert peak.all_peaks[0] == AskPeakCandidateRow(price=50000, qty=100000, intra_ms=36_000_000)


def test_query_day_ask_peak_dual_returns_top_three_ranked_touched_candidates(tmp_path: Path) -> None:
    """가격이 다른 상위 3개까지 방출. **분 604~606 의 51000대 벽은 체결 가격(52000)
    아래인데도** 후보가 아니다 — 그 분에 체결이 없기 때문이다(ADR-0156).
    """
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
    # 분 600·601·602 에만 체결. 가격 52000 은 51000·51100·51200 벽도 **지배하지만**,
    # 그 벽들은 분 604·605·606 에 있어 터치되지 않는다.
    write_trades([
        _trade(100003000, 52000),
        _trade(100103000, 52000),
        _trade(100203000, 52000),
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
    # 51000대 벽은 체결가 52000 아래지만 **다른 분**이라 전부 탈락.
    assert {c.price for c in peak.traded_peaks}.isdisjoint({51000, 51100, 51200})
    assert {c.price for c in peak.traded_max_peaks}.isdisjoint({51000, 51100, 51200})


def test_query_day_ask_peak_dual_excludes_collapsed_books_from_all_price(tmp_path) -> None:
    """`all_*`(터치 무관) 과거일 peak도 동시호가/VI 3호가 collapsed book을 제외한다."""
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
    # 붕괴책의 99999 는 어느 계열에도 들어가지 않는다 — 연속책의 300 만 남는다.
    assert peak.traded_peaks == (AskPeakCandidateRow(price=25000, qty=300, intra_ms=36_010_000),)
    assert 99999 not in [c.qty for c in peak.all_peaks]
    assert peak.all_qty == 2000 and peak.all_price == 26000


def test_query_day_ask_peak_dual_excludes_one_sided_collapsed_ask_book(tmp_path) -> None:
    """매도 쪽이 3호가로 붕괴했으면 bid 쪽 depth가 남아 있어도 `all_*` peak에서 제외한다."""
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


def test_query_day_bid_peak_dual_splits_touched_and_all(tmp_path) -> None:
    """체결가와 같은 최우선 매수벽만 체결로 잡히고, 더 깊은 최대 벽은 `all_*` 로 간다."""
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
    # 09:01 분에는 체결이 없으므로 그 분의 12000 벽은 체결이 아니다.
    assert {c.price for c in peak.traded_peaks} == {70000}


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


# ── 분 스코프 분류기 유닛 테스트 (ADR-0156 의 판정 축을 프레임 단위로 고정) ──
#
# ⚠ 이 테스트들이 거는 것은 **분 경계**와 **가격 지배 방향** 둘뿐이다. 시각·순번의
# 전후 관계는 이제 판정에 들어가지 않으므로 여기서 재지 않는다(재려는 시도가
# ADR-0084 의 잔재다).


def _ev_frame(rows: list[tuple[int, int, int, int]]) -> pl.DataFrame:
    """(intra_ms, seq, price, qty) 튜플들 → _classify_wall_frame 이벤트 프레임."""
    cols = ("ts_ms", "seq", "price", "qty", "intra_ms", "bucket_id", "minute_id")
    return pl.DataFrame(
        {
            "ts_ms": [r[0] for r in rows],
            "seq": [r[1] for r in rows],
            "price": [r[2] for r in rows],
            "qty": [r[3] for r in rows],
            "intra_ms": [r[0] for r in rows],
            "bucket_id": [0] * len(rows),
            "minute_id": [r[0] // 60_000 for r in rows],
        },
        schema_overrides={c: pl.Int64 for c in cols},
    )


def _tk_frame(rows: list[tuple[int, int]]) -> pl.DataFrame:
    """(intra_ms, price) 튜플들 → _classify_wall_frame 터치 프레임."""
    return pl.DataFrame(
        {
            "minute_id": [r[0] // 60_000 for r in rows],
            "price": [r[1] for r in rows],
        },
        schema_overrides={c: pl.Int64 for c in ("minute_id", "price")},
    )


def test_classify_same_minute_touch_counts() -> None:
    cls = _classify_wall_frame(_ev_frame([(1000, 5, 50000, 10)]), _tk_frame([(1000, 50000)]), side="ask")
    assert cls["touched"].to_list() == [True]  # 같은 분 · 같은 가격 → 지배( >= )


def test_classify_earlier_touch_in_same_minute_counts() -> None:
    """체결이 벽보다 **앞서도** 같은 분이면 터치 — 순서는 판정에 들어가지 않는다."""
    cls = _classify_wall_frame(_ev_frame([(59_000, 5, 50000, 10)]), _tk_frame([(1_000, 50000)]), side="ask")
    assert cls["touched"].to_list() == [True]


def test_classify_touch_in_neighbouring_minute_does_not_count() -> None:
    """1ms 차이라도 **분이 갈리면** 아니다 — ADR-0156 이 옮긴 판정 축이 여기다.

    막는 방향: 창이 분보다 넓어지는 쪽(차트 봉 단위·하루 전체 모두 여기서 빨개진다).
    """
    events = _ev_frame([(60_000, 5, 50000, 10)])           # 분 1
    assert _classify_wall_frame(events, _tk_frame([(59_999, 50000)]), side="ask")["touched"].to_list() == [False]
    assert _classify_wall_frame(events, _tk_frame([(120_000, 50000)]), side="ask")["touched"].to_list() == [False]


def test_classify_uses_minute_extreme_not_last_touch() -> None:
    """분 안에 여러 체결이 있으면 **극값**이 판정한다(마지막 값이 아니라)."""
    events = _ev_frame([(30_000, 1, 50000, 10)])
    touches = _tk_frame([(1_000, 50000), (2_000, 49000)])   # 마지막은 미달, 극값은 도달
    assert _classify_wall_frame(events, touches, side="ask")["touched"].to_list() == [True]


def test_classify_touched_distinct_keeps_best_per_price() -> None:
    """같은 가격의 터치된 이벤트는 하나(rank-1)로 접힌다."""
    events = _ev_frame([(1_000, 1, 50000, 100), (3_000, 3, 50000, 40)])
    cls = _classify_wall_frame(events, _tk_frame([(2_000, 50000)]), side="ask")
    rows = _peak_touched_distinct(cls).to_dicts()
    assert [r["qty"] for r in rows] == [100]


def test_classify_bid_side_uses_lower_or_equal_domination() -> None:
    # bid에선 고가 터치(50100)가 저가 벽(50000)을 지배하지 않는다.
    cls = _classify_wall_frame(_ev_frame([(1000, 1, 50000, 10)]), _tk_frame([(2000, 50100)]), side="bid")
    assert cls["touched"].to_list() == [False]


@pytest.mark.wallclock
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


# ---------------------------------------------------------------------------
# query_daily_depth_peaks: 여러 파일을 쿼리 1회로 — 단건판과 동치
# ---------------------------------------------------------------------------
#
# 스크리너 총잔량 조건이 유니버스 전체를 훑으면 단건판은 ~478 쿼리(실측 1.5초,
# 2026-07-30 · 241종목 42MiB)다. 데이터량이 아니라 왕복 비용이 종목 수만큼 반복되는
# 것이 원인이라 한 쿼리로 접으면 0.12초다. 여기서는 **속도가 아니라 동치**를 고정한다.


def _peaks_batch(con, paths, **bounds):
    from hoga.tables.snapshots import query_daily_depth_peaks

    return query_daily_depth_peaks(con, paths=paths, **bounds)


def _peak_single(con, path, **bounds):
    from hoga.tables.snapshots import query_daily_depth_peak

    return query_daily_depth_peak(con, path=path, **bounds)


def test_query_daily_depth_peaks_matches_single_file_results(tmp_path: Path) -> None:
    """정상 파일 여러 개 — 배치 결과가 단건판을 파일마다 부른 것과 같아야 한다."""
    bounds = {"session_open_ms": 90_000_000, "session_close_ms": 153_000_000}
    paths = []
    for i, qty in enumerate((100, 250, 700)):
        out = tmp_path / f"s{i}.parquet"
        write_parquet([
            _ob(ts_ms=90_100_000, seq=1, ask_q=(qty,) * 10, bid_q=(qty // 2,) * 10),
            _ob(ts_ms=91_000_000, seq=2, ask_q=(qty * 2,) * 10, bid_q=(qty,) * 10),
        ], out)
        paths.append(out)

    con = duckdb.connect()
    batched = _peaks_batch(con, paths, **bounds)
    for path in paths:
        single = _peak_single(con, path, **bounds)
        assert single is not None
        got = batched[str(path)]
        assert (got.ask_peak, got.bid_peak, got.eligible_count) == (
            single.ask_peak, single.bid_peak, single.eligible_count,
        )


def test_query_daily_depth_peaks_omits_file_whose_deep_book_is_all_pre_open(
    tmp_path: Path,
) -> None:
    """**분기 정의 회귀 가드.**

    단건판의 완화(TRUE) 조건은 "유효 행이 0개" 가 아니라 "연속거래 행이 close 이하에
    하나도 없음" 이다. deep book 이 있지만 전부 개장 전이면 — 유효 행은 0개인데
    연속거래 행은 존재하므로 — 단건판은 **None** 을 반환한다.

    "유효 0개면 완화" 로 구현하면 이 파일이 전체 max 를 반환해 조용히 달라진다.
    실데이터 3거래일 719파일에서는 이 케이스가 한 번도 안 나와서 실측 동등성만으로는
    잡히지 않는다 — 그래서 합성으로 고정한다.
    """
    bounds = {"session_open_ms": 90_000_000, "session_close_ms": 153_000_000}
    out = tmp_path / "pre_open_only.parquet"
    write_parquet([_ob(ts_ms=85_900_000, seq=1, ask_q=(9999,) * 10, bid_q=(9999,) * 10)], out)

    con = duckdb.connect()
    assert _peak_single(con, out, **bounds) is None
    assert str(out) not in _peaks_batch(con, [out], **bounds)


def test_query_daily_depth_peaks_relaxes_predicate_for_degenerate_file(
    tmp_path: Path,
) -> None:
    """연속거래 행이 전무한 퇴화 파일은 단건판처럼 술어를 완화(TRUE)해야 한다.

    실데이터에서는 발화하지 않는 경로다(3거래일 719파일 중 0건) — 합성으로만 검증된다.
    """
    bounds = {"session_open_ms": 90_000_000, "session_close_ms": 153_000_000}
    out = tmp_path / "auction_only.parquet"
    # 3호가만 = 단일가 구조 → deep book 술어가 전부 배제 → last_continuous None.
    write_parquet([
        _ob(ts_ms=152_500_000, seq=1, ask_q=(500, 500, 500), bid_q=(400, 400, 400)),
        _ob(ts_ms=152_600_000, seq=2, ask_q=(700, 700, 700), bid_q=(300, 300, 300)),
    ], out)

    con = duckdb.connect()
    single = _peak_single(con, out, **bounds)
    assert single is not None, "퇴화 파일은 완화 술어로 값을 낸다(단건판 계약)"
    got = _peaks_batch(con, [out], **bounds)[str(out)]
    assert (got.ask_peak, got.bid_peak, got.eligible_count) == (
        single.ask_peak, single.bid_peak, single.eligible_count,
    )


def test_query_daily_depth_peaks_skips_empty_parquet(tmp_path: Path) -> None:
    """빈 파일은 결과에서 빠진다(단건판이 None 을 반환하는 것과 같은 의미)."""
    bounds = {"session_open_ms": 90_000_000, "session_close_ms": 153_000_000}
    empty = tmp_path / "empty.parquet"
    write_parquet([], empty)
    good = tmp_path / "good.parquet"
    write_parquet([_ob(ts_ms=90_100_000, seq=1, ask_q=(10,) * 10, bid_q=(20,) * 10)], good)

    con = duckdb.connect()
    batched = _peaks_batch(con, [empty, good], **bounds)
    assert str(empty) not in batched
    assert batched[str(good)].ask_peak == 100


def test_query_daily_depth_peaks_without_close_bound_relaxes_like_single(
    tmp_path: Path,
) -> None:
    """session_close 가 None 이면 단건판은 술어를 아예 TRUE 로 둔다 — 배치도 같다."""
    out = tmp_path / "s.parquet"
    write_parquet([
        _ob(ts_ms=85_900_000, seq=1, ask_q=(9999,) * 10, bid_q=(1,) * 10),
        _ob(ts_ms=90_100_000, seq=2, ask_q=(10,) * 10, bid_q=(20,) * 10),
    ], out)

    con = duckdb.connect()
    single = _peak_single(con, out, session_open_ms=90_000_000, session_close_ms=None)
    assert single is not None
    got = _peaks_batch(con, [out], session_open_ms=90_000_000, session_close_ms=None)[str(out)]
    assert (got.ask_peak, got.bid_peak, got.eligible_count) == (
        single.ask_peak, single.bid_peak, single.eligible_count,
    )


def test_query_daily_depth_peaks_empty_input(tmp_path: Path) -> None:
    del tmp_path
    assert _peaks_batch(duckdb.connect(), [], session_close_ms=153_000_000) == {}


def test_krx_tick_boundaries_and_sql_python_agree(tmp_path: Path) -> None:
    """호가단위표 — 경계값과 **SQL/파이썬 두 구현의 일치**를 못박는다.

    막는 방향: 표가 한쪽에서만 바뀌는 것(SQL 은 지표 계산에, 파이썬은 테스트·도구에
    쓰인다). 못 보는 것: 두 구현이 **함께** 틀리는 것 — 그건 실데이터 역산으로만
    잡히고, 그 역산 결과가 docs/research/2026-08-19-... §2 의 표다.
    """
    import duckdb as _duckdb

    from hoga.tables.snapshots import _krx_tick_sql, krx_tick

    # 경계는 "미만" 이다 — 2,000원은 이미 다음 밴드(5원)다.
    cases = [
        (0, 0), (1, 1), (1_999, 1), (2_000, 5), (4_999, 5), (5_000, 10),
        (19_999, 10), (20_000, 50), (49_999, 50), (50_000, 100),
        (199_999, 100), (200_000, 500), (499_999, 500), (500_000, 1_000),
        (3_000_000, 1_000),
    ]
    for price, want in cases:
        assert krx_tick(price) == want, price

    con = _duckdb.connect()
    for price, want in cases:
        if price <= 0:
            continue  # SQL 쪽은 호출부가 (ask_p1+bid_p1) > 0 로 먼저 거른다
        got = con.execute(f"SELECT {_krx_tick_sql(str(float(price)))}").fetchone()[0]
        assert got == want, (price, got, want)


def test_peak_record_sequence_keeps_morning_records_top3_drops() -> None:
    """기록 갱신 시퀀스는 **시간축 prefix maxima** 다 — 최종 크기순 top-3 과 축이 다르다.

    막는 방향: 벽이 장중에 커지는 날, top-3(크기순)이 전부 오후에 몰려 오전 기록이
    잘리는 것 — 최대벽 강도 pane 이 오전에 비던 실보고(2026-08-24)의 원인.
    못 보는 것: SQL 스캔·터치 분류(오라클 fuzz 가 본다 — test_peak_sweep_oracle).
    """
    import polars as pl

    from hoga.tables.snapshots import _peak_record_sequence

    df = pl.DataFrame({
        # 오전: 작은 기록 2개. 오후: 큰 벽 4개(최종 top-3 은 전부 오후).
        "price":    [100, 101, 200, 201, 202, 203],
        "qty":      [50, 80, 900, 1000, 950, 990],
        "intra_ms": [1000, 2000, 50_000, 60_000, 70_000, 80_000],
        "seq":      [1, 2, 3, 4, 5, 6],
        "touched":  [True] * 6,
    })
    records = _peak_record_sequence(df)
    # 오전 기록(50, 80)이 살아남고, 오후는 갱신된 것만(900, 1000).
    assert [(r.qty, r.intra_ms) for r in records] == [
        (50, 1000), (80, 2000), (900, 50_000), (1000, 60_000),
    ]


def test_peak_record_sequence_same_snapshot_levels_deterministic() -> None:
    """같은 스냅샷(같은 intra_ms·seq)의 여러 단계는 **최대 단계만** 기록이 된다.

    막는 방향: unpivot 순서 비결정으로 같은 시각의 작은 단계가 기록에 끼거나 빠지는 것
    — (intra_ms, seq, -qty) 정렬이 이를 결정화한다. 동률(strict >)은 기록이 아니다.
    """
    import polars as pl

    from hoga.tables.snapshots import _peak_record_sequence

    df = pl.DataFrame({
        "price":    [100, 101, 102, 103],
        "qty":      [500, 800, 800, 300],   # 같은 스냅샷: 500·800 / 다음 스냅샷: 800(동률)·300
        "intra_ms": [1000, 1000, 2000, 2000],
        "seq":      [1, 1, 2, 2],
        "touched":  [True] * 4,
    })
    records = _peak_record_sequence(df)
    assert [(r.qty, r.intra_ms) for r in records] == [(800, 1000)]
