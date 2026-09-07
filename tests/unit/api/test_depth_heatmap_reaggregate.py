from __future__ import annotations

import random

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from hoga.api.depth_heatmap_reaggregate import reaggregate_depth_heatmap
from hoga.api.models import DepthHeatmapPoint
from hoga.tables.snapshots import query_bucketed_depth_heatmap
from hoga.util.timeenc import ms_from_midnight_to_unix_ms

DATE = "20260904"


def wire(rows):
    return [
        DepthHeatmapPoint(
            t_ms=ms_from_midnight_to_unix_ms(DATE, r.bucket_intra_ms),
            asks=list(map(list, zip(r.ask_prices, r.ask_qtys, strict=True))),
            bids=list(map(list, zip(r.bid_prices, r.bid_qtys, strict=True))),
            asks_max=list(map(list, zip(r.ask_prices_max, r.ask_qtys_max, strict=True))),
            bids_max=list(map(list, zip(r.bid_prices_max, r.bid_qtys_max, strict=True))),
            asks_price_max=list(map(list, zip(r.ask_prices_pmax, r.ask_qtys_pmax, strict=True))),
            bids_price_max=list(map(list, zip(r.bid_prices_pmax, r.bid_qtys_pmax, strict=True))),
        )
        for r in rows
    ]


@pytest.mark.parametrize("bounded", [False, True])
@pytest.mark.parametrize("ties", [False, True])
def test_complete_wire_matches_direct_sql_with_gaps_ties_vi_and_midnight_alignment(tmp_path, bounded, ties):
    rng = random.Random(20260907)
    data = {"ts_ms": []}
    for i in range(1, 11):
        for side in ["ask", "bid"]:
            data[f"{side}_p{i}"] = []
            data[f"{side}_q{i}"] = []
    for row in range(80):
        data["ts_ms"].append(90_000_000 + rng.randrange(12) * 100_000 + rng.choice([0, 1, 1000]))
        for i in range(1, 11):
            for side in ["ask", "bid"]:
                data[f"{side}_p{i}"].append(1000 + (i if side == "ask" else -i) + rng.randrange(3))
                qty = 10 if ties else rng.choice([0, 0, 5, 10])
                if row % 7 == 0 and i > 3:
                    qty = 0  # shallow VI rows among otherwise deep books
                data[f"{side}_q{i}"].append(qty)
    path = tmp_path / "snapshots.parquet"
    pq.write_table(pa.table(data), path)
    bounds = {"session_open_ms": 90_200_000, "session_close_ms": 91_000_000} if bounded else {}
    with duckdb.connect() as con:
        one = wire(query_bucketed_depth_heatmap(con, path=path, bucket_ms=60_000, **bounds))
        before = [p.model_dump() for p in one]
        for bucket in [180_000, 300_000, 420_000, 900_000]:
            expected = wire(query_bucketed_depth_heatmap(con, path=path, bucket_ms=bucket, **bounds))
            assert reaggregate_depth_heatmap(one, date=DATE, bucket_ms=bucket) == expected
        assert [p.model_dump() for p in one] == before
        assert reaggregate_depth_heatmap(one, date=DATE, bucket_ms=60_000) is one
    assert reaggregate_depth_heatmap([], date=DATE, bucket_ms=300_000) == []
    with pytest.raises(ValueError):
        reaggregate_depth_heatmap(one, date=DATE, bucket_ms=90_000)
