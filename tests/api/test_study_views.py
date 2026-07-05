import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from hoga.api import study_views as sv
from hoga.api.models import (
    StudyViewReference,
    StudyViewReferenceWriteRequest,
    StudyViewsFile,
)
from hoga.api.study_view_routes import build_router
from hoga.api.timeenc import hhmmssms_to_unix_ms


def _ref_req(**overrides):
    from_ms = hhmmssms_to_unix_ms("20260616", 90_000_000)
    to_ms = hhmmssms_to_unix_ms("20260618", 153_000_000)
    base = {
        "name": "삼성전자 복기",
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "range": {
            "from_date": "20260616",
            "to_date": "20260618",
            "from_ms": from_ms,
            "to_ms": to_ms,
        },
        "viewport": {"right_edge_ms": to_ms, "bar_span": 200, "at_live_edge": False},
        "memo": "돌파 복기",
        "tags": ["breakout"],
    }
    base.update(overrides)
    return base


@pytest.fixture
def study_client(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


def test_reference_write_request_strips_name_and_defaults_optional_fields():
    raw = _ref_req(name="  내 저장뷰  ", memo=None, tags=None)

    req = StudyViewReferenceWriteRequest.model_validate(raw)

    assert req.name == "내 저장뷰"
    assert req.memo == ""
    assert req.tags == []


def test_reference_write_request_preserves_right_padding_bars():
    raw = _ref_req(
        viewport={
            **_ref_req()["viewport"],
            "right_padding_bars": 24.5,
        },
    )

    req = StudyViewReferenceWriteRequest.model_validate(raw)

    assert req.viewport.right_padding_bars == 24.5


def test_reference_write_request_rejects_negative_right_padding_bars():
    raw = _ref_req(
        viewport={
            **_ref_req()["viewport"],
            "right_padding_bars": -1,
        },
    )

    with pytest.raises(ValidationError):
        StudyViewReferenceWriteRequest.model_validate(raw)


def test_reference_write_request_rejects_blank_name():
    with pytest.raises(ValidationError):
        StudyViewReferenceWriteRequest.model_validate(_ref_req(name="   "))


def test_reference_write_request_rejects_invalid_range_dates():
    raw = _ref_req()
    raw["range"] = {**raw["range"], "from_date": "20260619"}

    with pytest.raises(ValidationError):
        StudyViewReferenceWriteRequest.model_validate(raw)


def test_reference_model_strips_name():
    raw = {
        "schema_version": 2,
        "id": "view1",
        **_ref_req(name="  삼성 복기  "),
        "created_at_ms": 1,
        "updated_at_ms": 2,
    }

    view = StudyViewReference.model_validate(raw)

    assert view.name == "삼성 복기"


def test_study_views_file_is_v2_only():
    raw = {
        "schema_version": 1,
        "saves": [{
            "schema_version": 2,
            "id": "view1",
            **_ref_req(),
            "created_at_ms": 1,
            "updated_at_ms": 2,
        }],
    }

    file = StudyViewsFile.model_validate(raw)

    assert file.saves[0].schema_version == 2
    assert file.saves[0].range.from_date == "20260616"


def test_study_views_file_rejects_legacy_rows_without_schema_version():
    raw = {
        "schema_version": 1,
        "saves": [{
            "id": "legacy1",
            "name": "옛 저장뷰",
            "code": "005930",
            "label": "삼성전자",
            "timeframe": "5m",
        }],
    }

    with pytest.raises(ValidationError):
        StudyViewsFile.model_validate(raw)


def test_study_view_routes_crud(study_client):
    create = study_client.post(
        "/api/study-views/saves",
        json=_ref_req(viewport={**_ref_req()["viewport"], "right_padding_bars": 11}),
    )

    assert create.status_code == 201
    created = create.json()
    sid = created["id"]
    assert created["schema_version"] == 2
    assert "snapshot_path" not in created
    assert "indicator_state" not in created
    assert "panePrefsByTimeframe" not in created
    assert created["viewport"]["right_padding_bars"] == 11

    listed = study_client.get("/api/study-views/saves").json()["saves"]
    assert [row["id"] for row in listed] == [sid]
    assert study_client.get(f"/api/study-views/saves/{sid}").json()["id"] == sid

    update = study_client.put(f"/api/study-views/saves/{sid}", json=_ref_req(name="수정", memo="new"))
    assert update.status_code == 200
    assert update.json()["id"] == sid
    assert update.json()["name"] == "수정"
    assert update.json()["memo"] == "new"

    delete = study_client.delete(f"/api/study-views/saves/{sid}")
    assert delete.status_code == 204
    assert study_client.get(f"/api/study-views/saves/{sid}").status_code == 404


def test_study_view_routes_reject_legacy_snapshot_payload(study_client):
    body = {
        "name": "legacy",
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot": {},
    }

    response = study_client.post("/api/study-views/saves", json=body)

    assert response.status_code == 422


def test_study_view_routes_snapshot_endpoint_removed(study_client):
    create = study_client.post("/api/study-views/saves", json=_ref_req())
    sid = create.json()["id"]

    response = study_client.get(f"/api/study-views/saves/{sid}/snapshot")

    assert response.status_code == 404


def test_study_view_routes_missing_ids_return_study_specific_404(study_client):
    response = study_client.get("/api/study-views/saves/missing")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "study_view_not_found"

    response = study_client.put("/api/study-views/saves/missing", json=_ref_req())
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "study_view_not_found"

    response = study_client.delete("/api/study-views/saves/missing")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "study_view_not_found"


def test_study_views_create_update_delete_reference(tmp_path):
    req = StudyViewReferenceWriteRequest.model_validate(_ref_req())

    created = sv.create_save_sync(tmp_path, req=req, id="view1", now_ms=10)
    assert created.id == "view1"
    assert created.created_at_ms == 10
    assert not (tmp_path / "study_views" / "snapshots" / "view1.json").exists()

    updated_req = StudyViewReferenceWriteRequest.model_validate(_ref_req(name="수정"))
    updated = sv.update_save_sync(tmp_path, id="view1", req=updated_req, now_ms=20)
    assert updated.id == "view1"
    assert updated.name == "수정"
    assert updated.created_at_ms == 10
    assert updated.updated_at_ms == 20

    sv.delete_save_sync(tmp_path, id="view1")
    assert sv.load_saves(tmp_path).saves == []


def test_metadata_patch_renames_and_updates_memo(study_client):
    create = study_client.post("/api/study-views/saves", json=_ref_req(name="원래 이름", memo="old"))
    sid = create.json()["id"]

    patch = study_client.patch(
        f"/api/study-views/saves/{sid}/metadata",
        json={"name": " 새 이름 ", "memo": " new memo "},
    )

    assert patch.status_code == 200
    assert patch.json()["name"] == "새 이름"
    assert patch.json()["memo"] == "new memo"


def test_metadata_patch_rejects_blank_name(study_client):
    create = study_client.post("/api/study-views/saves", json=_ref_req())
    sid = create.json()["id"]

    patch = study_client.patch(f"/api/study-views/saves/{sid}/metadata", json={"name": "   "})

    assert patch.status_code == 422


def test_metadata_patch_missing_id_returns_404(study_client):
    patch = study_client.patch("/api/study-views/saves/missing/metadata", json={"memo": "x"})

    assert patch.status_code == 404
    assert patch.json()["detail"]["code"] == "study_view_not_found"
