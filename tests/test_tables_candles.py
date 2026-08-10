from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from hoga.tables.candles import (
    PARQUET_SCHEMA,
    ApiCandle,
    Candle,
    parse_row,
    query_all,
    read_parquet,
    write_parquet,
)


def test_parse_row() -> None:
    line = "30600000\t08:30:00\t281000\t281000\t281000\t281000\t119\t0\t0\t43\t5"
    c = parse_row(line)
    assert isinstance(c, Candle)
    assert c.ts_ms == 30600000
    assert c.open_ == c.close_ == c.high == c.low == 281000
    assert c.vol_a == 119
    assert c.vol_b == 0


def test_parse_row_folds_auction_volume_into_vol_a() -> None:
    """9번째 컬럼(단일가 체결량)이 vol_a 에 합쳐진다 (#1278).

    실제 chart.tsv 행이다 — 20260716/053080 의 마감 단일가 봉. 그 봉은
    ``vol_a=0 vol_b=0`` 인데 단일가 체결 261 주가 9번째 컬럼에 있다. 파서가
    그 컬럼을 버리던 시절 이 봉의 거래량은 **0** 이었고, 그게 일봉 거래량이
    벤더보다 항상 적던 원인이다.

    가격은 그때도 맞았다(단일가 8500) — **가격은 맞고 수량만 없는 것**이 이
    결함의 지문이라 아래에서 둘 다 단언한다.
    """
    line = "55800000\t15:30:42\t8500\t8500\t8500\t8500\t0\t0\t261\t4842\t4842"
    c = parse_row(line)
    assert c.open_ == c.close_ == c.high == c.low == 8500
    assert c.vol_a == 261, "단일가 체결량이 vol_a 에 폴드되지 않았다"
    assert c.vol_b == 0
    assert c.vol_a + c.vol_b == 261


def test_parse_row_adds_auction_volume_to_continuous_volume() -> None:
    """시가단일가 봉처럼 연속체결과 단일가가 **같은 봉**에 있으면 더한다.

    09:00 봉은 09:00:00 의 시가단일가 프린트와 09:00:01~09:00:59 의 연속체결을
    함께 담는다. 폴드가 덮어쓰기가 아니라 덧셈이어야 하는 자리 — 덮어쓰기여도
    위 마감봉 테스트(연속체결 0)는 통과하므로 이 케이스가 따로 필요하다.
    """
    line = "32400000\t09:00:31\t8500\t8600\t8600\t8500\t100\t55\t20368\t1\t1"
    c = parse_row(line)
    assert c.vol_a == 100 + 20368
    assert c.vol_b == 55


def test_parse_row_tolerates_row_without_auction_field() -> None:
    """9번째 컬럼이 없는 행은 단일가 0 으로 읽는다 — 거부하지 않는다.

    ``CANDLE_MIN_FIELDS`` 는 8 로 유지한다(#1278). 실측 raw 는 전부 11 필드라
    이 경로가 실제로 타지는 않지만, 하한을 올려 8 필드 행을 새로 죽이는 것은
    이 수정의 범위가 아니다.
    """
    c = parse_row("30600000\t08:30:00\t281000\t281000\t281000\t281000\t119\t7")
    assert (c.vol_a, c.vol_b) == (119, 7)


def test_candles_not_in_dispatcher_registry() -> None:
    """Candles is parsed from chart.tsv, not first.tsv. It must NOT register any event_type.

    This is a contract test against the dispatcher: if a future change accidentally
    adds ``PARSERS = {6: parse_row}`` to candles.py, the dispatcher would pick it up
    and try to feed first.tsv rows through it. Catch that here.
    """
    from hoga.tables import candles as candles_mod
    from hoga.tables.dispatch import PARSERS as registry

    assert getattr(candles_mod, "PARSERS", {}) == {}, "candles must not declare PARSERS"
    # And no registry entry should call into candles.parse_row.
    candles_funcs = {candles_mod.parse_row}
    assert not (set(registry.values()) & candles_funcs), (
        "candles.parse_row leaked into the dispatcher registry"
    )


def test_parquet_schema_columns() -> None:
    names = PARQUET_SCHEMA.names
    for col in ("ts_ms", "open", "close", "high", "low", "vol_a", "vol_b"):
        assert col in names


def test_write_parquet_is_atomic_on_replace_failure(tmp_path: Path, monkeypatch) -> None:
    """A failed write must leave a pre-existing candles.parquet intact.

    Regression guard (architecture-review QW-1): candles.write_parquet must
    route through the shared atomic-write helper (tempfile + os.replace) like
    its sibling tables, so a crash mid-write can never expose a torn or
    zero-length parquet to a concurrent reader. With the old in-place
    pq.write_table the target was overwritten/torn on failure; with os.replace
    the original survives untouched.
    """
    out = tmp_path / "candles.parquet"
    write_parquet([Candle(ts_ms=1, open_=1, close_=1, high=1, low=1, vol_a=1, vol_b=1)], out)

    import hoga.util.atomic_write as aw

    def _boom(_src, _dst):
        raise OSError("simulated crash during atomic replace")

    monkeypatch.setattr(aw.os, "replace", _boom)

    raised = False
    try:
        write_parquet([Candle(ts_ms=2, open_=2, close_=2, high=2, low=2, vol_a=2, vol_b=2)], out)
    except OSError:
        raised = True
    assert raised, "write_parquet must use os.replace (atomic); a failed replace should propagate"

    rows = query_all(duckdb.connect(), path=out, ts_offset_ms=0)
    assert [r.ts_ms for r in rows] == [1], "original parquet must survive a failed write intact"


def test_write_parquet_sorts_ascending(tmp_path: Path) -> None:
    p = 281000
    candles = [
        Candle(ts_ms=30660000, open_=p, close_=p, high=p, low=p, vol_a=10, vol_b=2),
        Candle(ts_ms=30600000, open_=p, close_=p, high=p, low=p, vol_a=119, vol_b=0),
    ]
    out = tmp_path / "candles.parquet"
    write_parquet(candles, out)
    tbl = pq.read_table(out)
    assert tbl.column("ts_ms").to_pylist() == [30600000, 30660000]


def test_query_all_returns_ascending_api_models(tmp_path: Path) -> None:
    out = tmp_path / "candles.parquet"
    write_parquet(
        [
            Candle(ts_ms=30660000, open_=1, close_=1, high=1, low=1, vol_a=1, vol_b=1),
            Candle(ts_ms=30600000, open_=2, close_=2, high=2, low=2, vol_a=2, vol_b=2),
        ],
        out,
    )
    con = duckdb.connect()
    rows = query_all(con, path=out, ts_offset_ms=0)
    assert all(isinstance(r, ApiCandle) for r in rows)
    assert [r.ts_ms for r in rows] == [30600000, 30660000]
    assert rows[0].open == 2  # ascending sort moves second-inserted to first
    assert rows[1].open == 1


def test_query_all_shifts_ts_by_offset_in_sql(tmp_path: Path) -> None:
    """`ts_offset_ms` 가 SQL 에서 더해진다 — 파케이는 자정 기준 ms 로 남는다.

    보정을 파이썬에서 `model_copy` 로 하면 같은 행을 두 벌 물질화하고, 5개월치
    1분봉이면 36,276개짜리 두 벌이다. 이 단언이 그 보정의 **유일한 위치**가
    SQL 임을 못 박는다.
    """
    out = tmp_path / "candles.parquet"
    write_parquet(
        [
            Candle(ts_ms=30_600_000, open_=2, close_=2, high=2, low=2, vol_a=2, vol_b=2),
            Candle(ts_ms=30_660_000, open_=1, close_=1, high=1, low=1, vol_a=1, vol_b=1),
        ],
        out,
    )
    con = duckdb.connect()
    offset = 1_749_772_800_000  # 어느 Stock-Date 의 KST 자정 Unix ms

    rows = query_all(con, path=out, ts_offset_ms=offset)

    assert [r.ts_ms for r in rows] == [offset + 30_600_000, offset + 30_660_000]
    # 오프셋은 단조라 정렬이 뒤집히지 않는다.
    assert rows[0].ts_ms < rows[1].ts_ms
    # 값 컬럼은 손대지 않는다 — 시프트가 OHLCV 로 새면 안 된다.
    assert [r.open for r in rows] == [2, 1]
    # 디스크는 여전히 자정 기준이다(보정이 읽기 경로에만 있다).
    assert pq.read_table(out).column("ts_ms").to_pylist() == [30_600_000, 30_660_000]


# ---------------------------------------------------------------------------
# read_parquet — symmetric inverse of write_parquet (Candle round-trip)
# ---------------------------------------------------------------------------


def test_read_parquet_round_trips_write_parquet(tmp_path: Path) -> None:
    """write_parquet ↔ read_parquet must round-trip Candles exactly (ASC by ts).

    Single test surface for the parquet column schema — if the columns drift,
    this breaks rather than a caller silently re-deriving them.
    """
    candles = [
        Candle(ts_ms=30600000, open_=281000, close_=281500, high=282000, low=280500, vol_a=119, vol_b=3),
        Candle(ts_ms=30660000, open_=281500, close_=281200, high=281900, low=281000, vol_a=42, vol_b=7),
    ]
    out = tmp_path / "candles.parquet"
    write_parquet(candles, out)
    assert read_parquet(out) == candles


def test_read_parquet_maps_open_close_columns_to_underscored_fields(tmp_path: Path) -> None:
    """Regression for the validate --deep candle-load break (2026-06-08): the
    parquet columns are ``open``/``close`` but the Candle fields are
    ``open_``/``close_``. A naive ``Candle(**row)`` raised
    ``unexpected keyword argument 'open'``, so cli._run_series_for loaded NO
    candles and series.candles_ts_monotonic was never evaluated under --deep —
    making --deep --fix able to CLEAR archived candles_ts errors (re-including
    chart-crashing dates). read_parquet owns the remap; assert the field values
    survive it."""
    out = tmp_path / "candles.parquet"
    write_parquet([Candle(ts_ms=1, open_=100, close_=200, high=250, low=90, vol_a=5, vol_b=6)], out)
    [c] = read_parquet(out)
    assert (c.open_, c.close_) == (100, 200)
    assert (c.high, c.low, c.vol_a, c.vol_b) == (250, 90, 5, 6)


def test_read_parquet_empty_table_returns_empty_list(tmp_path: Path) -> None:
    out = tmp_path / "candles.parquet"
    write_parquet([], out)
    assert read_parquet(out) == []


# ---------------------------------------------------------------------------
# query_price_range (ADR-0001): MIN(low)/MAX(high) for the volume-profile grid
# ---------------------------------------------------------------------------


def test_query_price_range_returns_min_low_max_high(tmp_path: Path) -> None:
    from hoga.tables.candles import query_price_range

    out = tmp_path / "candles.parquet"
    write_parquet(
        [
            Candle(ts_ms=1, open_=100, close_=100, high=150, low=90, vol_a=1, vol_b=1),
            Candle(ts_ms=2, open_=100, close_=100, high=200, low=80, vol_a=1, vol_b=1),
        ],
        out,
    )
    con = duckdb.connect()
    assert query_price_range(con, path=out) == (80, 200)  # (MIN(low), MAX(high))


def test_query_price_range_empty_candles_returns_none(tmp_path: Path) -> None:
    from hoga.tables.candles import query_price_range

    out = tmp_path / "candles.parquet"
    write_parquet([], out)
    con = duckdb.connect()
    assert query_price_range(con, path=out) is None
