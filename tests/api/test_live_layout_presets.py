import json

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
    # v3(PR-E, #713 §5): payload = 워크스페이스 전체 스냅샷(창·z순서·그룹→종목).
    base = {
        "name": "단타용",
        "payload": {
            "windows": [
                {
                    "id": "w1",
                    "kind": "chart",
                    "group": 1,
                    "rect": {"x": 0, "y": 0, "w": 442, "h": 531},
                    "chart": {
                        "timeframe": "1m",
                        "indicators": {"paneOrder": [], "paneStretch": {}, "byTimeframe": {}},
                    },
                },
                {"id": "w2", "kind": "book", "group": 1, "rect": {"x": 442, "y": 0, "w": 236, "h": 440}},
            ],
            "zOrder": ["w1", "w2"],
            "groupSymbols": {"1": {"code": "005930", "name": "삼성전자"}},
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
    assert created["schema_version"] == 3
    assert created["name"] == "단타용"
    assert created["payload"]["zOrder"] == ["w1", "w2"]
    assert created["payload"]["groupSymbols"]["1"]["code"] == "005930"
    assert created["payload"]["windows"][0]["chart"]["timeframe"] == "1m"

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
    # 서버는 키셋을 강제하지 않는다 — 프론트가 적용 시 canonical 정규화(readWindow)
    # 하므로, 미지의 창 kind·지표 필드가 payload 에 있어도 저장을 거부하지 않는다.
    req = LiveLayoutPresetWriteRequest.model_validate(
        _preset_req(payload={
            "windows": [{
                "id": "w9", "kind": "brand-new-kind", "group": 2,
                "rect": {"x": 0, "y": 0, "w": 100, "h": 100},
                "chart": {"timeframe": "5m", "someFutureField": 42},
            }],
            "zOrder": ["w9"],
            "groupSymbols": {"2": {"code": "000660", "name": "하이닉스", "extra": True}},
        })
    )
    assert req.payload.windows[0]["kind"] == "brand-new-kind"
    assert req.payload.windows[0]["chart"]["someFutureField"] == 42
    assert req.payload.groupSymbols["2"]["extra"] is True


def test_stale_v2_preset_file_is_discarded(tmp_path):
    # 구 v2 프리셋(pane_order + by_timeframe_enable + right_card_*, 파일
    # schema_version=2)은 폐기된다 — 변환 없이 빈 목록으로 재시작(PR-E, #713 §5).
    # 저장 프리셋 0개라 실질 손실 없음.
    manifest = llp._manifest_path(tmp_path)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps({
            "schema_version": 2,
            "presets": [{
                "schema_version": 2,
                "id": "old-2",
                "name": "구버전",
                "payload": {
                    "pane_order": ["candle"],
                    "by_timeframe_enable": {"minute": {"ratioEnabled": False}},
                    "right_card_order": ["orderbook"],
                },
                "created_at_ms": 1,
                "updated_at_ms": 1,
            }],
        }),
        encoding="utf-8",
    )
    reloaded = llp.load_presets(tmp_path)
    assert reloaded.presets == []


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
    # 부분 payload 도 기본값(빈 스냅샷)으로 채워진다(얕은 검증).
    req = LiveLayoutPresetWriteRequest.model_validate({"name": "빈 프리셋", "payload": {}})
    assert req.payload.windows == []
    assert req.payload.zOrder == []
    assert req.payload.groupSymbols == {}
