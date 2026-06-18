from hoga.api import study_views as sv
from hoga.api.models import ParquetStudyViewWriteRequest


def _snapshot_with_dense_details(bar_count: int = 200):
    candles = [
        {
            "t": 1_000 + i * 60_000,
            "open": 100 + i,
            "high": 101 + i,
            "low": 99 + i,
            "close": 100 + i,
            "volume": 1_000 + i,
        }
        for i in range(bar_count)
    ]
    return {
        "schema_version": 1,
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "1m",
        "snapshot_from_ms": candles[0]["t"],
        "snapshot_to_ms": candles[-1]["t"],
        "bucket_kind": "1m",
        "viewport": {
            "right_edge_ms": candles[-1]["t"],
            "bar_span": bar_count,
            "at_live_edge": False,
        },
        "indicator_state": {
            "volume_enabled": True,
            "quote_totals_enabled": True,
            "ratio_enabled": True,
            "fill_strength_enabled": True,
            "aggregation_basis": "close",
            "auction_window_mask": True,
            "ratio_outlier_filter_enabled": True,
            "ratio_outlier_threshold": 50,
        },
        "provenance": {"saved_from_route": "/live", "data_provenance": "live_mixed"},
        "bundle": {
            "code": "005930",
            "timeframe": "1m",
            "snapshot_from_ms": candles[0]["t"],
            "snapshot_to_ms": candles[-1]["t"],
            "segments": [
                {
                    "date": "20260616",
                    "session_open_ms": candles[0]["t"],
                    "session_close_ms": candles[-1]["t"],
                    "source": "hogaplay",
                }
            ],
            "candles": candles,
            "quote_totals": [
                {"t": c["t"], "bid_total": 100, "ask_total": 90, "visible": True}
                for c in candles
            ],
            "ratio": [{"t": c["t"], "value": 0.1, "visible": True} for c in candles],
            "fill_strength": [
                {"t": c["t"], "buy_qty": 5, "sell_qty": 4, "visible": True}
                for c in candles
            ],
            "ask_peaks": [],
            "data_warnings": [],
            "orderbook_buckets": [
                {
                    "t": c["t"],
                    "available": False,
                    "snapshot": None,
                }
                for c in candles
            ],
            "broker_buckets": [
                {
                    "t": c["t"],
                    "available": False,
                    "brokers": [],
                }
                for c in candles
            ],
            "detail_warnings": [],
        },
        "captured_at_ms": 3_000,
    }


def _request_for(snapshot):
    return {
        "name": "삼성전자 1분봉 저장뷰",
        "code": snapshot["code"],
        "label": snapshot["label"],
        "timeframe": snapshot["timeframe"],
        "snapshot_from_ms": snapshot["snapshot_from_ms"],
        "snapshot_to_ms": snapshot["snapshot_to_ms"],
        "viewport": snapshot["viewport"],
        "indicator_state": snapshot["indicator_state"],
        "snapshot": snapshot,
        "provenance": snapshot["provenance"],
    }


def test_restorable_load_for_enriched_snapshot_is_json_only(tmp_path, monkeypatch):
    snapshot = _snapshot_with_dense_details(bar_count=200)
    req = ParquetStudyViewWriteRequest.model_validate(_request_for(snapshot))
    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    persisted = sv.load_snapshot(tmp_path, id="view1")
    assert len(persisted.bundle.candles) == 200
    assert len(persisted.bundle.orderbook_buckets) == 200
    assert len(persisted.bundle.broker_buckets) == 200

    def prepare(data_dir, loaded_snapshot):
        raise AssertionError(
            "enriched study snapshot load must not touch parquet enrichment"
        )

    monkeypatch.setattr(sv, "prepare_restorable_snapshot", prepare)

    loaded = sv.load_restorable_snapshot(tmp_path, id="view1")

    assert len(loaded.bundle.candles) == 200
    assert len(loaded.bundle.orderbook_buckets) == 200
    assert len(loaded.bundle.broker_buckets) == 200
