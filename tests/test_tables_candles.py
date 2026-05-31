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


def test_candles_not_in_dispatcher_registry() -> None:
    """Candles is parsed from chart.tsv, not first.tsv. It must NOT register any event_type.

    This is a contract test against the dispatcher: if a future change accidentally
    adds ``PARSERS = {6: parse_row}`` to candles.py, the dispatcher would pick it up
    and try to feed first.tsv rows through it. Catch that here.
    """
    from hoga.tables import candles as candles_mod  # noqa: PLC0415
    from hoga.tables.dispatch import PARSERS as registry  # noqa: PLC0415

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

    import hoga.api._atomic_write as aw

    def _boom(_src, _dst):
        raise OSError("simulated crash during atomic replace")

    monkeypatch.setattr(aw.os, "replace", _boom)

    raised = False
    try:
        write_parquet([Candle(ts_ms=2, open_=2, close_=2, high=2, low=2, vol_a=2, vol_b=2)], out)
    except OSError:
        raised = True
    assert raised, "write_parquet must use os.replace (atomic); a failed replace should propagate"

    rows = query_all(duckdb.connect(), path=out)
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
    rows = query_all(con, path=out)
    assert all(isinstance(r, ApiCandle) for r in rows)
    assert [r.ts_ms for r in rows] == [30600000, 30660000]
    assert rows[0].open == 2  # ascending sort moves second-inserted to first
    assert rows[1].open == 1
