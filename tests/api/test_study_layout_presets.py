import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from hoga.api import live_layout_presets as llp, study_layout_presets as slp
from hoga.api.models import StudyLayoutPresetWriteRequest
from hoga.api.study_layout_preset_routes import build_router


def _preset_req(**overrides):
    # `/study` payload = **창 배치만**. 종목(groupSymbols)이 없는 것이 `/live` 와의
    # 계약 차이 — 프리셋 적용이 열린 탭(저장뷰)을 건드리지 않는다.
    base = {
        "name": "분석용",
        "payload": {
            "windows": [
                {
                    "id": "w1",
                    "kind": "chart",
                    "rect": {"x": 0, "y": 0, "w": 0.7, "h": 1},
                    "chart": {
                        "timeframe": "1m",
                        "indicators": {"paneOrder": [], "paneStretch": {}, "byTimeframe": {}},
                    },
                },
                {"id": "w2", "kind": "book", "rect": {"x": 0.7, "y": 0, "w": 0.3, "h": 1}},
            ],
            "zOrder": ["w1", "w2"],
        },
    }
    base.update(overrides)
    return base


@pytest.fixture
def preset_client(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


def test_study_preset_routes_crud(preset_client):
    create = preset_client.post("/api/study-layout-presets", json=_preset_req())
    assert create.status_code == 201
    created = create.json()
    pid = created["id"]
    assert created["schema_version"] == 1
    assert created["name"] == "분석용"
    assert created["payload"]["zOrder"] == ["w1", "w2"]
    assert created["payload"]["windows"][0]["chart"]["timeframe"] == "1m"
    # 종목은 담기지 않는다 — 모델에 필드 자체가 없다.
    assert "groupSymbols" not in created["payload"]

    listed = preset_client.get("/api/study-layout-presets").json()["presets"]
    assert [row["id"] for row in listed] == [pid]

    update = preset_client.put(
        f"/api/study-layout-presets/{pid}", json=_preset_req(name="관찰용")
    )
    assert update.status_code == 200
    assert update.json()["name"] == "관찰용"

    delete = preset_client.delete(f"/api/study-layout-presets/{pid}")
    assert delete.status_code == 204
    assert preset_client.get("/api/study-layout-presets").json()["presets"] == []


def test_study_preset_missing_id_returns_resource_specific_404(preset_client):
    resp = preset_client.put("/api/study-layout-presets/missing", json=_preset_req())
    assert resp.status_code == 404
    # `/live` 와 코드가 구분돼야 클라이언트가 어느 목록을 다시 읽을지 안다.
    assert resp.json()["detail"]["code"] == "study_layout_preset_not_found"

    resp = preset_client.delete("/api/study-layout-presets/missing")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "study_layout_preset_not_found"


def test_study_preset_conflicts_when_expected_updated_at_ms_is_stale(preset_client):
    pid = preset_client.post("/api/study-layout-presets", json=_preset_req()).json()["id"]
    first = preset_client.put(
        f"/api/study-layout-presets/{pid}", json=_preset_req(name="탭1 저장")
    )
    assert first.status_code == 200
    fresh_ms = first.json()["updated_at_ms"]

    stale = preset_client.put(
        f"/api/study-layout-presets/{pid}",
        json=_preset_req(name="탭2 저장", expected_updated_at_ms=fresh_ms - 1),
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "study_layout_preset_conflict"
    # 거절은 쓰기 전에 일어난다 — 저장본은 탭1 것 그대로.
    assert (
        preset_client.get("/api/study-layout-presets").json()["presets"][0]["name"]
        == "탭1 저장"
    )


def test_study_preset_accepts_matching_expected_updated_at_ms(preset_client):
    created = preset_client.post("/api/study-layout-presets", json=_preset_req()).json()

    resp = preset_client.put(
        f"/api/study-layout-presets/{created['id']}",
        json=_preset_req(name="정상", expected_updated_at_ms=created["updated_at_ms"]),
    )

    assert resp.status_code == 200
    assert resp.json()["name"] == "정상"


def test_study_preset_without_expected_updated_at_ms_overwrites(preset_client):
    pid = preset_client.post("/api/study-layout-presets", json=_preset_req()).json()["id"]
    preset_client.put(f"/api/study-layout-presets/{pid}", json=_preset_req(name="먼저"))

    resp = preset_client.put(f"/api/study-layout-presets/{pid}", json=_preset_req(name="나중"))

    assert resp.status_code == 200
    assert resp.json()["name"] == "나중"


def test_study_preset_rejects_blank_name():
    with pytest.raises(ValidationError):
        StudyLayoutPresetWriteRequest.model_validate(_preset_req(name="   "))


def test_study_preset_payload_accepts_unknown_window_keys():
    # 서버는 키셋을 강제하지 않는다 — 정규화는 프론트가 apply 시점에 한다
    # (studyWorkspace.applySnapshot → readWindow).
    req = StudyLayoutPresetWriteRequest.model_validate(
        _preset_req(
            payload={
                "windows": [
                    {
                        "id": "w9",
                        "kind": "brand-new-kind",
                        "rect": {"x": 0, "y": 0, "w": 0.5, "h": 0.5},
                        "chart": {"timeframe": "5m", "someFutureField": 42},
                    }
                ],
                "zOrder": ["w9"],
            }
        )
    )
    assert req.payload.windows[0]["kind"] == "brand-new-kind"
    assert req.payload.windows[0]["chart"]["someFutureField"] == 42


def test_study_and_live_presets_do_not_share_a_manifest(tmp_path):
    # 두 리소스가 같은 뼈대를 쓰되 저장 루트가 달라 목록이 섞이지 않는다.
    assert slp._manifest_path(tmp_path) != llp._manifest_path(tmp_path)
    assert slp._manifest_path(tmp_path).parent.name == "study_layout_presets"
