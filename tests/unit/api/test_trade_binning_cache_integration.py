from __future__ import annotations

import json
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

from hoga.api.bundle import build_trade_volume_poc_slice, build_volume_distribution_slice
from hoga.api.queries import QueryEngine
from hoga.tables import trade_binning as tb, trades
from hoga.util.timeenc import hhmmssms_to_unix_ms


def test_builders_share_bins_and_exact_cutoff_index_only_with_past_cache(tmp_path):
    date, code = "20260623", "005930"
    directory = tmp_path / "parquet" / date / code / "kiwoom_live" / "KRX"
    directory.mkdir(parents=True)
    (directory / "meta.json").write_text(
        json.dumps(
            {
                "regular_session_open_ms": 90_000_000,
                "regular_session_close_ms": 153_000_000,
                "collection_complete": True,
                "is_partial": False,
            }
        )
    )
    pq.write_table(
        pa.table({"ts_ms": [90_000_000, 90_000_001], "price": [100, 110], "qty": [10, 20], "side": [1, -1]}),
        directory / "trades.parquet",
    )
    engine = QueryEngine(tmp_path)
    kwargs = dict(
        code=code,
        date=date,
        source="kiwoom_live",
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        range_count=5,
        today_kst="20260907",
    )
    try:
        with patch.object(tb, "query_statistics", wraps=tb.query_statistics) as query:
            build_volume_distribution_slice(engine, **kwargs, price_min=100, price_max=120)
            poc = build_trade_volume_poc_slice(engine, **kwargs, price_range=(100, 120))
        assert query.call_count == 1
        assert poc.qty == 20
        with patch.object(tb, "query_time_index", wraps=tb.query_time_index) as index:
            outputs = [
                build_volume_distribution_slice(
                    engine, **kwargs, price_min=100, price_max=120, cutoff_ms=hhmmssms_to_unix_ms(date, cut)
                )
                for cut in [90_000_000, 90_000_001]
            ]
        assert index.call_count == 1
        assert [sum(b.qty for b in result.bins) for result in outputs] == [10, 30]
        with patch.object(trades, "query_statistics", wraps=trades.query_statistics) as direct:
            for cut in [90_000_000, 90_000_001]:
                build_volume_distribution_slice(
                    engine, **kwargs, price_min=100, price_max=120, cutoff_ms=hhmmssms_to_unix_ms(date, cut), cache=None
                )
        assert direct.call_count == 2
    finally:
        engine.close()
