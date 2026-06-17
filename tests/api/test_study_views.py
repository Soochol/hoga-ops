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
from hoga.api.study_view_routes import build_router


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
