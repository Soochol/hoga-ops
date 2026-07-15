import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from hoga.api import live_layout_presets as llp
from hoga.api.models import (
    LiveLayoutPresetsFile,
    LiveLayoutPresetWriteRequest,
)
from hoga.api.live_layout_preset_routes import build_router


def _preset_req(**overrides):
    base = {
        "name": "단타용",
        "payload": {
            "pane_order": ["candle", "volume", "ratio", "quote-totals"],
            "pane_prefs_by_timeframe": {"minute": {"ratioEnabled": False}},
            "indicator_flags": {"movingAverageEnabled": True, "volumeEnabled": True},
            "right_panel_width_px": 420,
            "right_card_order": ["orderbook", "brokers"],
            "right_card_hidden": {"program": True},
            "right_card_collapsed": {"investor": True},
            "right_card_weights": {"orderbook": 34.0, "brokers": 22.0},
        },
    }
    base.update(overrides)
    return base


@pytest.fixture
def preset_client(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


def test_preset_routes_crud(preset_client):
    create = preset_client.post("/api/live-layout-presets", json=_preset_req())
    assert create.status_code == 201
    created = create.json()
    pid = created["id"]
    assert created["schema_version"] == 1
    assert created["name"] == "단타용"
    assert created["payload"]["right_panel_width_px"] == 420
    assert created["payload"]["pane_order"] == ["candle", "volume", "ratio", "quote-totals"]

    listed = preset_client.get("/api/live-layout-presets").json()["presets"]
    assert [row["id"] for row in listed] == [pid]

    update = preset_client.put(f"/api/live-layout-presets/{pid}", json=_preset_req(name="스윙용"))
    assert update.status_code == 200
    assert update.json()["id"] == pid
    assert update.json()["name"] == "스윙용"

    delete = preset_client.delete(f"/api/live-layout-presets/{pid}")
    assert delete.status_code == 204
    # 삭제 후 목록에서 사라진다.
    assert preset_client.get("/api/live-layout-presets").json()["presets"] == []


def test_preset_routes_missing_id_returns_preset_specific_404(preset_client):
    resp = preset_client.put("/api/live-layout-presets/missing", json=_preset_req())
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "live_layout_preset_not_found"

    resp = preset_client.delete("/api/live-layout-presets/missing")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "live_layout_preset_not_found"


def test_preset_write_request_strips_name():
    req = LiveLayoutPresetWriteRequest.model_validate(_preset_req(name="  내 프리셋  "))
    assert req.name == "내 프리셋"


def test_preset_write_request_rejects_blank_name():
    with pytest.raises(ValidationError):
        LiveLayoutPresetWriteRequest.model_validate(_preset_req(name="   "))


def test_preset_payload_accepts_unknown_keys_shallowly():
    # 서버는 키셋을 강제하지 않는다 — 프론트가 적용 시 canonical 정규화하므로,
    # 미지의 pane/카드 키가 payload 에 있어도 저장을 거부하지 않는다(ADR-0114 §4).
    req = LiveLayoutPresetWriteRequest.model_validate(
        _preset_req(payload={
            "pane_order": ["candle", "brand-new-pane"],
            "indicator_flags": {"someFutureFlag": True},
            "right_card_order": ["orderbook", "future-card"],
        })
    )
    assert "brand-new-pane" in req.payload.pane_order
    assert req.payload.indicator_flags["someFutureFlag"] is True


def test_presets_sorted_by_updated_at_desc_and_persist_across_reload(tmp_path):
    r1 = LiveLayoutPresetWriteRequest.model_validate(_preset_req(name="A"))
    r2 = LiveLayoutPresetWriteRequest.model_validate(_preset_req(name="B"))
    llp.create_preset_sync(tmp_path, req=r1, id="p1", now_ms=10)
    llp.create_preset_sync(tmp_path, req=r2, id="p2", now_ms=20)

    # updated_at_ms 내림차순 정렬.
    presets = llp.list_presets_sync(tmp_path)
    assert [p.id for p in presets] == ["p2", "p1"]

    # 매니페스트가 디스크에 남아 재로드된다.
    reloaded = llp.load_presets(tmp_path)
    assert isinstance(reloaded, LiveLayoutPresetsFile)
    assert {p.id for p in reloaded.presets} == {"p1", "p2"}


def test_preset_default_payload_fields():
    # 부분 payload 도 기본값으로 채워진다(얕은 검증).
    req = LiveLayoutPresetWriteRequest.model_validate({"name": "빈 프리셋", "payload": {}})
    assert req.payload.right_panel_width_px == 400
    assert req.payload.pane_order == []
    assert req.payload.right_card_weights == {}
