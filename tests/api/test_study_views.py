import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from hoga.api import study_views as sv
from hoga.api.app import create_app
from hoga.api.models import (
    ParquetStudySnapshot,
    ParquetStudyView,
    ParquetStudyViewWriteRequest,
    StudyViewsFile,
)
from hoga.api.study_snapshot_contract import prepare_restorable_snapshot
from hoga.api.study_view_routes import build_router
from hoga.api.timeenc import hhmmssms_to_unix_ms


def _snapshot(**overrides):
    base = {
        "schema_version": 1,
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot_from_ms": 1_000,
        "snapshot_to_ms": 2_000,
        "bucket_kind": "5m",
        "viewport": {"right_edge_ms": 2_000, "bar_span": 200, "at_live_edge": False},
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
            "timeframe": "5m",
            "snapshot_from_ms": 1_000,
            "snapshot_to_ms": 2_000,
            "segments": [{"date": "20260616", "session_open_ms": 1_000, "session_close_ms": 2_000}],
            "candles": [{"t": 1_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}],
            "quote_totals": [{"t": 1_000, "bid_total": 100, "ask_total": 90, "visible": True}],
            "ratio": [{"t": 1_000, "value": 0.1, "visible": True}],
            "fill_strength": [{"t": 1_000, "buy_qty": 5, "sell_qty": 4, "visible": True}],
            "ask_peaks": [{
                "date": "20260616",
                "price": 70_500,
                "qty": 5_000,
                "t_ms": 1_000,
                "max_price": 70_700,
                "max_qty": 6_000,
                "max_t_ms": 1_000,
            }],
            "data_warnings": [],
        },
        "captured_at_ms": 3_000,
    }
    base.update(overrides)
    return base


def _req(**overrides):
    snap = _snapshot()
    base = {
        "name": "삼성전자 5분봉 2026.06.16",
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot_from_ms": 1_000,
        "snapshot_to_ms": 2_000,
        "viewport": snap["viewport"],
        "indicator_state": snap["indicator_state"],
        "snapshot": snap,
        "provenance": snap["provenance"],
    }
    base.update(overrides)
    return base


def _orderbook_bucket(t=1_000, *, available=True):
    return {
        "t": t,
        "available": available,
        "snapshot": {
            "ts_ms": t + 59_000,
            "seq": 1,
            "ask": [{"price": 70_100 + i, "qty": 10 + i} for i in range(10)],
            "bid": [{"price": 70_000 - i, "qty": 20 + i} for i in range(10)],
            "tot_ask": 145,
            "tot_bid": 245,
        } if available else None,
    }


def _broker_bucket(t=1_000, *, available=True):
    return {
        "t": t,
        "available": available,
        "brokers": [
            {"broker": "키움증권", "net": 100, "dominant_side": "buy"},
            {"broker": "JP모간", "net": -80, "dominant_side": "sell"},
        ] if available else [],
    }


@pytest.fixture
def study_client(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


def _view(**overrides):
    snap = _snapshot()
    base = {
        "id": "study_1",
        "name": "삼성전자 5분봉 2026.06.16",
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot_from_ms": 1_000,
        "snapshot_to_ms": 2_000,
        "viewport": snap["viewport"],
        "indicator_state": snap["indicator_state"],
        "memo": "",
        "tags": [],
        "provenance": snap["provenance"],
        "snapshot_schema_version": 1,
        "snapshot_path": "snapshots/study_1.parquet",
        "snapshot_size_bytes": 123,
        "created_at_ms": 3_000,
        "updated_at_ms": 3_000,
    }
    base.update(overrides)
    return base


def test_study_view_write_request_trims_name_and_defaults_memo_tags():
    req = ParquetStudyViewWriteRequest.model_validate(_req(name="  내 저장뷰  "))
    assert req.name == "내 저장뷰"
    assert req.memo == ""
    assert req.tags == []


def test_study_view_write_request_rejects_whitespace_name():
    with pytest.raises(ValidationError):
        ParquetStudyViewWriteRequest.model_validate(_req(name="   "))


def test_study_view_write_request_rejects_snapshot_metadata_mismatch():
    bad = _req(snapshot=_snapshot(code="000660"))
    with pytest.raises(ValidationError):
        ParquetStudyViewWriteRequest.model_validate(bad)


def test_study_snapshot_allows_hidden_indicator_without_numeric_value():
    snap = _snapshot()
    snap["bundle"]["ratio"] = [{"t": 1_000, "visible": False}]
    parsed = ParquetStudySnapshot.model_validate(snap)
    assert parsed.bundle.ratio[0].visible is False
    assert parsed.bundle.ask_peaks[0].qty == 5_000


def test_study_snapshot_preserves_bid_peaks():
    snap = _snapshot()
    snap["bundle"]["bid_peaks"] = [{
        "date": "20260616",
        "price": 69_900,
        "qty": 4_800,
        "t_ms": 1_000,
        "max_price": 69_800,
        "max_qty": 5_800,
        "max_t_ms": 1_000,
    }]

    parsed = ParquetStudySnapshot.model_validate(snap)

    assert parsed.bundle.bid_peaks[0].price == 69_900
    assert parsed.model_dump()["bundle"]["bid_peaks"][0]["qty"] == 4_800


def test_study_snapshot_rejects_unsorted_candles():
    snap = _snapshot()
    snap["bundle"]["candles"] = [
        {"t": 2_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10},
        {"t": 1_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10},
    ]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


@pytest.mark.parametrize(
    ("series_name", "point"),
    [
        ("quote_totals", {"t": 1_000, "ask_total": 90, "visible": True}),
        ("ratio", {"t": 1_000, "visible": True}),
        ("fill_strength", {"t": 1_000, "buy_qty": 5, "visible": True}),
    ],
)
def test_study_snapshot_rejects_visible_indicator_points_missing_numeric_values(series_name, point):
    snap = _snapshot()
    snap["bundle"][series_name] = [point]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


@pytest.mark.parametrize(
    ("series_name", "point"),
    [
        ("quote_totals", {"t": 1_000, "bid_total": float("nan"), "ask_total": 90, "visible": True}),
        ("ratio", {"t": 1_000, "value": float("inf"), "visible": True}),
        ("fill_strength", {"t": 1_000, "buy_qty": 5, "sell_qty": float("-inf"), "visible": True}),
    ],
)
def test_study_snapshot_rejects_visible_indicator_points_with_non_finite_values(series_name, point):
    snap = _snapshot()
    snap["bundle"][series_name] = [point]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


def test_study_snapshot_rejects_non_finite_candle_values():
    snap = _snapshot()
    snap["bundle"]["candles"] = [
        {"t": 1_000, "open": 1, "high": float("nan"), "low": 1, "close": 2, "volume": 10}
    ]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


def test_study_snapshot_rejects_non_finite_indicator_threshold():
    snap = _snapshot()
    snap["indicator_state"] = {**snap["indicator_state"], "ratio_outlier_threshold": float("inf")}
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


def test_study_snapshot_defaults_detail_arrays_for_legacy_snapshots():
    snap = ParquetStudySnapshot.model_validate(_snapshot())

    assert snap.source_policy == "fixed"
    assert snap.bundle.orderbook_buckets == []
    assert snap.bundle.broker_buckets == []
    assert snap.bundle.detail_warnings == []


def test_prepare_restorable_snapshot_preserves_fixed_segment_source(tmp_path):
    date = "20260616"
    unix_bucket = hhmmssms_to_unix_ms(date, 90_000_000)
    raw = _snapshot()
    raw["snapshot_from_ms"] = unix_bucket
    raw["snapshot_to_ms"] = unix_bucket
    raw["bundle"]["snapshot_from_ms"] = unix_bucket
    raw["bundle"]["snapshot_to_ms"] = unix_bucket
    raw["bundle"]["segments"][0]["source"] = "kis_live"
    raw["bundle"]["segments"][0]["date"] = date
    raw["bundle"]["segments"][0]["session_open_ms"] = unix_bucket
    raw["bundle"]["segments"][0]["session_close_ms"] = hhmmssms_to_unix_ms(date, 153_000_000)
    raw["bundle"]["candles"] = [
        {"t": unix_bucket, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}
    ]
    snap = ParquetStudySnapshot.model_validate(raw)

    prepared = prepare_restorable_snapshot(tmp_path, snap)

    assert prepared.source_policy == "fixed"
    assert prepared.bundle.segments[0].source == "kis_live"
    assert [(w.kind, w.message) for w in prepared.bundle.detail_warnings] == [
        ("orderbook", "parquet source missing: kis_live"),
        ("broker", "parquet source missing: kis_live"),
    ]


def test_study_snapshot_accepts_aligned_detail_arrays():
    raw = _snapshot()
    raw["bundle"]["orderbook_buckets"] = [_orderbook_bucket(1_000)]
    raw["bundle"]["broker_buckets"] = [_broker_bucket(1_000)]
    raw["bundle"]["detail_warnings"] = [
        {
            "kind": "orderbook",
            "t": 1_000,
            "code": "005930",
            "date": "20260616",
            "message": "missing representative",
        }
    ]

    snap = ParquetStudySnapshot.model_validate(raw)

    assert snap.bundle.orderbook_buckets[0].t == 1_000
    assert snap.bundle.orderbook_buckets[0].available is True
    assert snap.bundle.broker_buckets[0].brokers[0].net == 100
    assert snap.bundle.detail_warnings[0].kind == "orderbook"


def test_study_snapshot_rejects_detail_length_mismatch():
    raw = _snapshot()
    raw["bundle"]["orderbook_buckets"] = [_orderbook_bucket(1_000), _orderbook_bucket(2_000)]

    with pytest.raises(ValidationError, match="orderbook_buckets must align"):
        ParquetStudySnapshot.model_validate(raw)


def test_study_snapshot_rejects_detail_t_mismatch():
    raw = _snapshot()
    raw["bundle"]["broker_buckets"] = [_broker_bucket(1_001)]

    with pytest.raises(ValidationError, match="broker_buckets must align"):
        ParquetStudySnapshot.model_validate(raw)


def test_study_snapshot_rejects_available_orderbook_without_snapshot():
    raw = _snapshot()
    raw["bundle"]["orderbook_buckets"] = [{"t": 1_000, "available": True, "snapshot": None}]

    with pytest.raises(ValidationError, match="available orderbook buckets require snapshot"):
        ParquetStudySnapshot.model_validate(raw)


def test_study_snapshot_rejects_available_broker_bucket_without_brokers():
    raw = _snapshot()
    raw["bundle"]["broker_buckets"] = [{"t": 1_000, "available": True, "brokers": []}]

    with pytest.raises(ValidationError, match="available broker buckets require brokers"):
        ParquetStudySnapshot.model_validate(raw)


def test_parquet_study_view_trims_name():
    view = ParquetStudyView.model_validate(_view(name="  내 저장뷰  "))
    assert view.name == "내 저장뷰"


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": "   "},
        {"code": "bad"},
        {"snapshot_from_ms": 2_000, "snapshot_to_ms": 1_000},
    ],
)
def test_parquet_study_view_rejects_invalid_manifest_metadata(overrides):
    with pytest.raises(ValidationError):
        ParquetStudyView.model_validate(_view(**overrides))


def test_study_views_file_defaults_empty():
    assert StudyViewsFile().schema_version == 1
    assert StudyViewsFile().saves == []


def test_study_view_routes_crud(study_client):
    r = study_client.post("/api/study-views/saves", json=_req())
    assert r.status_code == 201
    sid = r.json()["id"]
    assert study_client.get("/api/study-views/saves").json()["saves"][0]["id"] == sid
    assert study_client.get(f"/api/study-views/saves/{sid}").json()["id"] == sid
    snap = study_client.get(f"/api/study-views/saves/{sid}/snapshot").json()
    assert snap["code"] == "005930"
    r2 = study_client.put(f"/api/study-views/saves/{sid}", json=_req(name="수정"))
    assert r2.status_code == 200
    assert r2.json()["id"] == sid
    assert r2.json()["name"] == "수정"
    assert study_client.delete(f"/api/study-views/saves/{sid}").status_code == 204
    assert study_client.get(f"/api/study-views/saves/{sid}").status_code == 404


def test_study_view_routes_missing_ids_return_study_specific_404(study_client):
    r = study_client.get("/api/study-views/saves/missing")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "study_view_not_found"

    r = study_client.get("/api/study-views/saves/missing/snapshot")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "study_view_not_found"

    r = study_client.put("/api/study-views/saves/missing", json=_req())
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "study_view_not_found"

    r = study_client.delete("/api/study-views/saves/missing")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "study_view_not_found"


def test_study_view_routes_snapshot_missing_file_returns_integrity_error(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    client = TestClient(app)
    r = client.post("/api/study-views/saves", json=_req())
    assert r.status_code == 201
    sid = r.json()["id"]
    (tmp_path / "study_views" / "snapshots" / f"{sid}.json").unlink()

    r = client.get(f"/api/study-views/saves/{sid}/snapshot")

    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "study_view_snapshot_missing"


def test_study_view_routes_snapshot_invalid_file_returns_integrity_error(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    client = TestClient(app)
    r = client.post("/api/study-views/saves", json=_req())
    assert r.status_code == 201
    sid = r.json()["id"]
    (tmp_path / "study_views" / "snapshots" / f"{sid}.json").write_text(
        "{ not json", encoding="utf-8"
    )

    r = client.get(f"/api/study-views/saves/{sid}/snapshot")

    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "study_view_snapshot_invalid"


def test_study_view_routes_mounted_in_app_factory(tmp_path):
    client = TestClient(create_app(tmp_path))
    r = client.get("/api/study-views/saves")
    assert r.status_code == 200
    assert r.json() == {"schema_version": 1, "saves": []}


def test_study_views_load_missing_returns_empty(tmp_path):
    assert sv.load_saves(tmp_path).saves == []


def test_study_views_create_writes_manifest_and_snapshot(tmp_path):
    created = sv.create_save_sync(
        tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10
    )
    assert created.id == "view1"
    assert (tmp_path / "study_views" / "saves.json").exists()
    assert (tmp_path / "study_views" / "snapshots" / "view1.json").exists()
    assert sv.load_snapshot(tmp_path, id="view1").code == "005930"


def test_study_views_create_uses_snapshot_contract_module(tmp_path, monkeypatch):
    calls = []

    def prepare(data_dir, snapshot):
        calls.append((data_dir, snapshot.code))
        return snapshot.model_copy(update={"source_policy": "fixed"})

    monkeypatch.setattr(sv, "prepare_restorable_snapshot", prepare)

    sv.create_save_sync(
        tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10
    )
    snap = sv.load_snapshot(tmp_path, id="view1")

    assert calls == [(tmp_path, "005930")]
    assert snap.source_policy == "fixed"


def test_study_views_create_enriches_snapshot_detail_buckets(tmp_path):
    from hoga.api.timeenc import hhmmssms_to_unix_ms
    from hoga.tables.brokers import BrokerRow, write_parquet as write_brokers
    from hoga.tables.snapshots import Orderbook, write_parquet as write_snapshots

    z = tuple(0 for _ in range(10))
    ask_p = tuple(70_100 + i for i in range(10))
    ask_q = tuple(10 + i for i in range(10))
    bid_p = tuple(70_000 - i for i in range(10))
    bid_q = tuple(20 + i for i in range(10))
    date = "20260616"
    code = "005930"
    source_dir = tmp_path / "parquet" / date / code / "hogaplay"
    source_dir.mkdir(parents=True)
    (source_dir / "meta.json").write_text(
        json.dumps(
            {
                "code": code,
                "date": date,
                "source": "hogaplay",
                "regular_session_open_ms": 90_000_000,
                "regular_session_close_ms": 153_000_000,
            }
        ),
        encoding="utf-8",
    )
    write_snapshots(
        [
            Orderbook(
                ts_ms=90_000_500,
                seq=1,
                ask_p=ask_p,
                ask_q=ask_q,
                ask_d=z,
                bid_p=bid_p,
                bid_q=bid_q,
                bid_d=z,
                tot_ask=sum(ask_q),
                tot_ask_d=0,
                tot_bid=sum(bid_q),
                tot_bid_d=0,
            )
        ],
        source_dir / "snapshots.parquet",
    )
    write_brokers(
        [
            BrokerRow(
                ts_ms=90_000_500,
                seq=1,
                side="buy",
                rank=1,
                broker="키움증권",
                qty_today=100,
                qty_delta=0,
            ),
            BrokerRow(
                ts_ms=90_000_500,
                seq=1,
                side="sell",
                rank=1,
                broker="JP모간",
                qty_today=80,
                qty_delta=0,
            ),
            BrokerRow(
                ts_ms=90_004_000,
                seq=2,
                side="buy",
                rank=1,
                broker="키움증권",
                qty_today=300,
                qty_delta=200,
            ),
        ],
        source_dir / "brokers.parquet",
    )

    unix_bucket = hhmmssms_to_unix_ms(date, 90_000_000)
    raw = _req()
    raw["snapshot_from_ms"] = unix_bucket
    raw["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["segments"] = [
        {
            "date": date,
            "session_open_ms": unix_bucket,
            "session_close_ms": unix_bucket + 23_400_000,
            "source": "hogaplay",
        }
    ]
    raw["snapshot"]["bundle"]["candles"] = [
        {"t": unix_bucket, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}
    ]
    req = ParquetStudyViewWriteRequest.model_validate(raw)

    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    snap = sv.load_snapshot(tmp_path, id="view1")

    assert snap.bundle.orderbook_buckets[0].t == unix_bucket
    assert snap.bundle.orderbook_buckets[0].available is True
    assert snap.bundle.orderbook_buckets[0].snapshot is not None
    assert snap.bundle.orderbook_buckets[0].snapshot.ts_ms == unix_bucket + 500
    assert snap.bundle.broker_buckets[0].available is True
    assert snap.bundle.broker_buckets[0].brokers[0].broker == "키움증권"
    assert snap.bundle.broker_buckets[0].brokers[0].net == 100
    assert snap.bundle.detail_warnings == []

    restorable = sv.load_restorable_snapshot(tmp_path, id="view1")

    assert restorable.bundle.orderbook_buckets[0].available is True
    assert restorable.bundle.orderbook_buckets[0].snapshot is not None
    assert restorable.bundle.orderbook_buckets[0].snapshot.ts_ms == unix_bucket + 500
    assert restorable.bundle.broker_buckets[0].available is True
    assert restorable.bundle.broker_buckets[0].brokers[0].broker == "키움증권"
    assert restorable.bundle.broker_buckets[0].brokers[0].net == 100
    assert restorable.bundle.detail_warnings == []


def test_load_restorable_snapshot_returns_persisted_enriched_snapshot_without_re_enrich(
    tmp_path, monkeypatch
):
    raw = _snapshot()
    raw["bundle"]["orderbook_buckets"] = [_orderbook_bucket(1_000)]
    raw["bundle"]["broker_buckets"] = [_broker_bucket(1_000)]
    raw["bundle"]["detail_warnings"] = [
        {
            "kind": "orderbook",
            "t": 1_000,
            "code": "005930",
            "date": "20260616",
            "message": "persisted warning",
        }
    ]
    req = ParquetStudyViewWriteRequest.model_validate(
        _req(snapshot=raw, viewport=raw["viewport"], indicator_state=raw["indicator_state"])
    )
    created = sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    assert created.snapshot_size_bytes > 0
    snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"
    sv.atomic_write_json(snapshot_path, raw)

    calls = []

    def prepare(data_dir, snapshot):
        calls.append((data_dir, snapshot.code))
        raise AssertionError("load_restorable_snapshot must not re-enrich persisted details")

    monkeypatch.setattr(sv, "prepare_restorable_snapshot", prepare)

    snap = sv.load_restorable_snapshot(tmp_path, id="view1")

    assert calls == []
    assert snap.bundle.orderbook_buckets[0].available is True
    assert snap.bundle.broker_buckets[0].available is True
    assert snap.bundle.detail_warnings[0].message == "persisted warning"


def test_load_restorable_snapshot_does_not_enrich_legacy_snapshot_without_detail_arrays(
    tmp_path, monkeypatch
):
    req = ParquetStudyViewWriteRequest.model_validate(_req())
    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"
    sv.atomic_write_json(snapshot_path, req.snapshot.model_dump(mode="json"))

    calls = []

    def prepare(data_dir, snapshot):
        calls.append((data_dir, snapshot.code))
        raise AssertionError("legacy study snapshot load must not repair from parquet")

    monkeypatch.setattr(sv, "prepare_restorable_snapshot", prepare)

    snap = sv.load_restorable_snapshot(tmp_path, id="view1")

    assert calls == []
    assert snap.bundle.orderbook_buckets == []
    assert snap.bundle.broker_buckets == []


@pytest.mark.parametrize("timeframe", ["D", "W", "M"])
def test_study_views_create_calendar_detail_enrichment_uses_segment_session_window(
    tmp_path, timeframe
):
    from hoga.api.timeenc import hhmmssms_to_unix_ms
    from hoga.tables.brokers import BrokerRow, write_parquet as write_brokers
    from hoga.tables.snapshots import Orderbook, write_parquet as write_snapshots

    z = tuple(0 for _ in range(10))
    ask_p = tuple(70_100 + i for i in range(10))
    ask_q = tuple(10 + i for i in range(10))
    bid_p = tuple(70_000 - i for i in range(10))
    bid_q = tuple(20 + i for i in range(10))
    date = "20260616"
    code = "005930"
    source_dir = tmp_path / "parquet" / date / code / "hogaplay"
    source_dir.mkdir(parents=True)
    (source_dir / "meta.json").write_text(
        json.dumps(
            {
                "code": code,
                "date": date,
                "source": "hogaplay",
                "regular_session_open_ms": 90_000_000,
                "regular_session_close_ms": 153_000_000,
            }
        ),
        encoding="utf-8",
    )
    write_snapshots(
        [
            Orderbook(
                ts_ms=90_000_500,
                seq=1,
                ask_p=ask_p,
                ask_q=ask_q,
                ask_d=z,
                bid_p=bid_p,
                bid_q=bid_q,
                bid_d=z,
                tot_ask=sum(ask_q),
                tot_ask_d=0,
                tot_bid=sum(bid_q),
                tot_bid_d=0,
            )
        ],
        source_dir / "snapshots.parquet",
    )
    write_brokers(
        [
            BrokerRow(
                ts_ms=90_000_500,
                seq=1,
                side="buy",
                rank=1,
                broker="키움증권",
                qty_today=100,
                qty_delta=0,
            )
        ],
        source_dir / "brokers.parquet",
    )

    unix_bucket = hhmmssms_to_unix_ms(date, 90_000_000)
    raw = _req(timeframe=timeframe)
    raw["snapshot_from_ms"] = unix_bucket
    raw["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["timeframe"] = timeframe
    raw["snapshot"]["bucket_kind"] = timeframe
    raw["snapshot"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["timeframe"] = timeframe
    raw["snapshot"]["bundle"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["segments"] = [
        {
            "date": date,
            "session_open_ms": unix_bucket,
            "session_close_ms": hhmmssms_to_unix_ms(date, 153_000_000),
            "source": "hogaplay",
        }
    ]
    raw["snapshot"]["bundle"]["candles"] = [
        {"t": unix_bucket, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}
    ]
    req = ParquetStudyViewWriteRequest.model_validate(raw)

    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    snap = sv.load_snapshot(tmp_path, id="view1")

    assert snap.bundle.orderbook_buckets[0].available is True
    assert snap.bundle.orderbook_buckets[0].snapshot is not None
    assert snap.bundle.orderbook_buckets[0].snapshot.ts_ms == unix_bucket + 500
    assert snap.bundle.broker_buckets[0].available is True
    assert snap.bundle.broker_buckets[0].brokers[0].broker == "키움증권"
    assert snap.bundle.detail_warnings == []


def test_study_views_create_detail_enrichment_without_orderbook_representative_disables_broker(
    tmp_path,
):
    from hoga.api.timeenc import hhmmssms_to_unix_ms
    from hoga.tables.brokers import BrokerRow, write_parquet as write_brokers
    from hoga.tables.snapshots import Orderbook, write_parquet as write_snapshots

    z = tuple(0 for _ in range(10))
    ask_p = tuple(70_100 + i for i in range(10))
    bid_p = tuple(70_000 - i for i in range(10))
    shallow_ask_q = (10, 11, 12) + z[3:]
    shallow_bid_q = (20, 21, 22) + z[3:]
    date = "20260616"
    code = "005930"
    source_dir = tmp_path / "parquet" / date / code / "hogaplay"
    source_dir.mkdir(parents=True)
    (source_dir / "meta.json").write_text(
        json.dumps(
            {
                "code": code,
                "date": date,
                "source": "hogaplay",
                "regular_session_open_ms": 90_000_000,
                "regular_session_close_ms": 153_000_000,
            }
        ),
        encoding="utf-8",
    )
    write_snapshots(
        [
            Orderbook(
                ts_ms=90_000_500,
                seq=1,
                ask_p=ask_p,
                ask_q=shallow_ask_q,
                ask_d=z,
                bid_p=bid_p,
                bid_q=shallow_bid_q,
                bid_d=z,
                tot_ask=sum(shallow_ask_q),
                tot_ask_d=0,
                tot_bid=sum(shallow_bid_q),
                tot_bid_d=0,
            )
        ],
        source_dir / "snapshots.parquet",
    )
    write_brokers(
        [
            BrokerRow(
                ts_ms=90_004_000,
                seq=1,
                side="buy",
                rank=1,
                broker="키움증권",
                qty_today=300,
                qty_delta=0,
            )
        ],
        source_dir / "brokers.parquet",
    )

    unix_bucket = hhmmssms_to_unix_ms(date, 90_000_000)
    raw = _req()
    raw["snapshot_from_ms"] = unix_bucket
    raw["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["segments"] = [
        {
            "date": date,
            "session_open_ms": unix_bucket,
            "session_close_ms": unix_bucket + 23_400_000,
            "source": "hogaplay",
        }
    ]
    raw["snapshot"]["bundle"]["candles"] = [
        {"t": unix_bucket, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}
    ]
    req = ParquetStudyViewWriteRequest.model_validate(raw)

    sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    snap = sv.load_snapshot(tmp_path, id="view1")

    assert snap.code == "005930"
    assert snap.bundle.orderbook_buckets[0].t == unix_bucket
    assert snap.bundle.orderbook_buckets[0].available is False
    assert snap.bundle.broker_buckets[0].t == unix_bucket
    assert snap.bundle.broker_buckets[0].available is False
    assert snap.bundle.broker_buckets[0].brokers == []
    assert [w.message for w in snap.bundle.detail_warnings] == [
        "no continuous representative for saved candle bucket",
        "broker detail unavailable without orderbook representative",
    ]


def test_study_views_create_detail_enrichment_missing_parquet_is_non_fatal(tmp_path):
    from hoga.api.timeenc import hhmmssms_to_unix_ms

    date = "20260616"
    unix_bucket = hhmmssms_to_unix_ms(date, 90_000_000)
    raw = _req()
    raw["snapshot_from_ms"] = unix_bucket
    raw["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_from_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["snapshot_to_ms"] = unix_bucket
    raw["snapshot"]["bundle"]["segments"] = [
        {
            "date": date,
            "session_open_ms": unix_bucket,
            "session_close_ms": hhmmssms_to_unix_ms(date, 153_000_000),
            "source": "hogaplay",
        }
    ]
    raw["snapshot"]["bundle"]["candles"] = [
        {"t": unix_bucket, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}
    ]
    req = ParquetStudyViewWriteRequest.model_validate(raw)

    created = sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    snap = sv.load_snapshot(tmp_path, id="view1")

    assert created.id == "view1"
    assert snap.code == "005930"
    assert snap.bundle.orderbook_buckets[0].t == unix_bucket
    assert snap.bundle.orderbook_buckets[0].available is False
    assert snap.bundle.orderbook_buckets[0].snapshot is None
    assert snap.bundle.broker_buckets[0].t == unix_bucket
    assert snap.bundle.broker_buckets[0].available is False
    assert snap.bundle.broker_buckets[0].brokers == []
    assert [(w.kind, w.message) for w in snap.bundle.detail_warnings] == [
        ("orderbook", "parquet source missing: hogaplay"),
        ("broker", "parquet source missing: hogaplay"),
    ]


def test_study_views_create_snapshot_write_failure_does_not_create_manifest_row(
    tmp_path, monkeypatch
):
    real_atomic_write_json = sv.atomic_write_json

    def fail_snapshot_write(path, payload, *, indent=2):
        if path.name == "view1.json":
            raise OSError("snapshot write failed")
        real_atomic_write_json(path, payload, indent=indent)

    monkeypatch.setattr(sv, "atomic_write_json", fail_snapshot_write)

    with pytest.raises(OSError, match="snapshot write failed"):
        sv.create_save_sync(
            tmp_path,
            req=ParquetStudyViewWriteRequest.model_validate(_req()),
            id="view1",
            now_ms=10,
        )

    assert sv.load_saves(tmp_path).saves == []
    assert not (tmp_path / "study_views" / "snapshots" / "view1.json").exists()


def test_study_views_create_manifest_write_failure_removes_orphan_snapshot(tmp_path, monkeypatch):
    real_atomic_write_json = sv.atomic_write_json

    def fail_manifest_write(path, payload, *, indent=2):
        if path.name == "saves.json":
            raise OSError("manifest write failed")
        real_atomic_write_json(path, payload, indent=indent)

    monkeypatch.setattr(sv, "atomic_write_json", fail_manifest_write)

    with pytest.raises(OSError, match="manifest write failed"):
        sv.create_save_sync(
            tmp_path,
            req=ParquetStudyViewWriteRequest.model_validate(_req()),
            id="view1",
            now_ms=10,
        )

    assert sv.load_saves(tmp_path).saves == []
    assert not (tmp_path / "study_views" / "snapshots" / "view1.json").exists()


def test_study_views_corrupt_manifest_quarantined(tmp_path):
    p = tmp_path / "study_views" / "saves.json"
    p.parent.mkdir(parents=True)
    p.write_text("{ not json", encoding="utf-8")
    assert sv.load_saves(tmp_path).saves == []
    assert list(p.parent.glob("saves.json.corrupt-*-badjson"))


def test_study_views_malformed_manifest_version_quarantined_as_schema(tmp_path):
    p = tmp_path / "study_views" / "saves.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"schema_version": "bad", "saves": []}), encoding="utf-8")
    assert sv.load_saves(tmp_path).saves == []
    assert list(p.parent.glob("saves.json.corrupt-*-schema"))


def test_study_views_update_manifest_write_failure_keeps_old_snapshot(tmp_path, monkeypatch):
    original = sv.create_save_sync(
        tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10
    )
    old_snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"
    old_snapshot_text = old_snapshot_path.read_text(encoding="utf-8")
    updated_req = ParquetStudyViewWriteRequest.model_validate(
        _req(snapshot=_snapshot(captured_at_ms=9_000))
    )
    real_atomic_write_json = sv.atomic_write_json

    def fail_manifest_write(path, payload, *, indent=2):
        if path.name == "saves.json":
            raise OSError("manifest write failed")
        real_atomic_write_json(path, payload, indent=indent)

    monkeypatch.setattr(sv, "atomic_write_json", fail_manifest_write)

    with pytest.raises(OSError, match="manifest write failed"):
        sv.update_save_sync(tmp_path, id="view1", req=updated_req, now_ms=20)

    assert old_snapshot_path.read_text(encoding="utf-8") == old_snapshot_text
    assert sv.get_save_sync(tmp_path, id="view1") == original


def test_study_views_update_snapshot_promotion_failure_rolls_back_manifest(tmp_path, monkeypatch):
    original = sv.create_save_sync(
        tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10
    )
    snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"
    old_snapshot_text = snapshot_path.read_text(encoding="utf-8")
    updated_req = ParquetStudyViewWriteRequest.model_validate(
        _req(snapshot=_snapshot(captured_at_ms=9_000))
    )
    real_replace = type(snapshot_path).replace

    def fail_staged_snapshot_replace(self, target):
        if self.name == "view1.json.staged":
            raise OSError("snapshot promotion failed")
        return real_replace(self, target)

    monkeypatch.setattr(type(snapshot_path), "replace", fail_staged_snapshot_replace)

    with pytest.raises(OSError, match="snapshot promotion failed"):
        sv.update_save_sync(tmp_path, id="view1", req=updated_req, now_ms=20)

    assert snapshot_path.read_text(encoding="utf-8") == old_snapshot_text
    assert sv.get_save_sync(tmp_path, id="view1") == original


def test_study_views_update_uses_snapshot_contract_module(tmp_path, monkeypatch):
    sv.create_save_sync(
        tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10
    )
    calls = []

    def prepare(data_dir, snapshot):
        calls.append((data_dir, snapshot.captured_at_ms))
        return snapshot.model_copy(update={"source_policy": "fixed"})

    monkeypatch.setattr(sv, "prepare_restorable_snapshot", prepare)
    updated_req = ParquetStudyViewWriteRequest.model_validate(
        _req(snapshot=_snapshot(captured_at_ms=9_000))
    )

    sv.update_save_sync(tmp_path, id="view1", req=updated_req, now_ms=20)
    snap = sv.load_snapshot(tmp_path, id="view1")

    assert calls == [(tmp_path, 9_000)]
    assert snap.captured_at_ms == 9_000
    assert snap.source_policy == "fixed"


def test_study_views_delete_manifest_write_failure_keeps_snapshot_and_manifest(
    tmp_path, monkeypatch
):
    original = sv.create_save_sync(
        tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10
    )
    snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"
    real_atomic_write_json = sv.atomic_write_json

    def fail_manifest_write(path, payload, *, indent=2):
        if path.name == "saves.json":
            raise OSError("manifest write failed")
        real_atomic_write_json(path, payload, indent=indent)

    monkeypatch.setattr(sv, "atomic_write_json", fail_manifest_write)

    with pytest.raises(OSError, match="manifest write failed"):
        sv.delete_save_sync(tmp_path, id="view1")

    assert snapshot_path.exists()
    assert sv.get_save_sync(tmp_path, id="view1") == original


def test_study_views_delete_missing_snapshot_still_removes_manifest(tmp_path):
    sv.create_save_sync(
        tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10
    )
    (tmp_path / "study_views" / "snapshots" / "view1.json").unlink()
    sv.delete_save_sync(tmp_path, id="view1")
    assert sv.load_saves(tmp_path).saves == []


def test_study_views_delete_snapshot_unlink_failure_rolls_back_manifest(tmp_path, monkeypatch):
    original = sv.create_save_sync(
        tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10
    )
    snapshot_path = tmp_path / "study_views" / "snapshots" / "view1.json"
    real_unlink = type(snapshot_path).unlink

    def fail_snapshot_unlink(self, missing_ok=False):
        if self.name == "view1.json":
            raise OSError("snapshot delete failed")
        return real_unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(type(snapshot_path), "unlink", fail_snapshot_unlink)

    with pytest.raises(OSError, match="snapshot delete failed"):
        sv.delete_save_sync(tmp_path, id="view1")

    assert snapshot_path.exists()
    assert sv.get_save_sync(tmp_path, id="view1") == original


def test_study_views_missing_save_raises(tmp_path):
    with pytest.raises(sv.StudyViewNotFoundError):
        sv.get_save_sync(tmp_path, id="missing")


def test_metadata_patch_renames_without_touching_snapshot(study_client, tmp_path, monkeypatch):
    create = study_client.post("/api/study-views/saves", json=_req(name="원래 이름", memo="old"))
    assert create.status_code == 201
    save_id = create.json()["id"]
    snapshot_path = tmp_path / "study_views" / "snapshots" / f"{save_id}.json"
    before_snapshot = snapshot_path.read_text(encoding="utf-8")
    before_mtime = snapshot_path.stat().st_mtime_ns

    monkeypatch.setattr("hoga.api.study_view_routes.time.time", lambda: 10.0)
    patch = study_client.patch(
        f"/api/study-views/saves/{save_id}/metadata",
        json={"name": "  새 이름  "},
    )

    assert patch.status_code == 200
    body = patch.json()
    assert body["name"] == "새 이름"
    assert body["memo"] == "old"
    assert body["updated_at_ms"] == 10_000
    assert snapshot_path.read_text(encoding="utf-8") == before_snapshot
    assert snapshot_path.stat().st_mtime_ns == before_mtime


def test_metadata_patch_updates_memo_without_touching_snapshot(study_client, tmp_path):
    create = study_client.post("/api/study-views/saves", json=_req(name="원래 이름", memo="old"))
    assert create.status_code == 201
    save_id = create.json()["id"]
    snapshot_path = tmp_path / "study_views" / "snapshots" / f"{save_id}.json"
    before_snapshot = snapshot_path.read_text(encoding="utf-8")

    patch = study_client.patch(
        f"/api/study-views/saves/{save_id}/metadata",
        json={"memo": "  새 메모  "},
    )

    assert patch.status_code == 200
    body = patch.json()
    assert body["name"] == "원래 이름"
    assert body["memo"] == "새 메모"
    assert snapshot_path.read_text(encoding="utf-8") == before_snapshot


def test_metadata_patch_rejects_blank_name(study_client):
    create = study_client.post("/api/study-views/saves", json=_req())
    assert create.status_code == 201
    save_id = create.json()["id"]

    patch = study_client.patch(
        f"/api/study-views/saves/{save_id}/metadata",
        json={"name": "   "},
    )

    assert patch.status_code == 422


def test_metadata_patch_missing_id_returns_404(study_client):
    patch = study_client.patch(
        "/api/study-views/saves/missing/metadata",
        json={"memo": "x"},
    )

    assert patch.status_code == 404
    assert patch.json()["detail"]["code"] == "study_view_not_found"
