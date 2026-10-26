import json
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.models import StudyViewReference, StudyViewsFile
from hoga.api.study_view_routes import build_router
from hoga.api.study_views import load_saves, save_saves
from tools import repair_study_calendar_ranges as repair_tool


def ms(date):
    return int(datetime.strptime(date, "%Y%m%d").replace(tzinfo=repair_tool.KST).timestamp() * 1000)


def row(**updates):
    return StudyViewReference.model_validate({
        "schema_version": 2, "id": "old", "group_id": "g", "name": "복기", "code": "068290",
        "label": "삼성출판사", "timeframe": "D", "memo": "사용자 메모", "tags": ["보존"],
        "created_at_ms": ms("20261026"), "updated_at_ms": ms("20261026"),
        "range": {"from_date": "20210422", "to_date": "20210422",
                  "from_ms": ms("20210422"), "to_ms": ms("20210422")},
        "viewport": {"left_edge_ms": ms("20200710"), "right_edge_ms": ms("20210422"),
                     "bar_span": 191.47, "at_live_edge": False}, **updates,
    })


@pytest.mark.parametrize("timeframe", ["D", "W", "M"])
def test_repairs_exact_clamp_signature_with_explicit_viewport(timeframe):
    req = repair_tool.repaired_request(row(timeframe=timeframe))
    assert req.range.from_date == "20200710"
    assert req.range.to_date == "20210422"
    assert req.range.from_ms == ms("20200710")


@pytest.mark.parametrize("updates", [
    {"timeframe": "1m"}, {"timeframe": "5s"}, {"created_at_ms": ms("20210423")},
    {"viewport": {"right_edge_ms": ms("20210422"), "bar_span": 191.47, "at_live_edge": False}},
    {"range": {"from_date": "20210421", "to_date": "20210422",
               "from_ms": ms("20210421"), "to_ms": ms("20210422")}},
    {"range": {"from_date": "20210421", "to_date": "20210422",
               "from_ms": ms("20210422"), "to_ms": ms("20210422")}},
    {"viewport": {"left_edge_ms": ms("20210422"), "right_edge_ms": ms("20210422"),
                  "bar_span": 1, "at_live_edge": False}},
])
def test_skips_unproven_or_already_valid_periods(updates):
    assert repair_tool.repaired_request(row(**updates)) is None


def test_apply_uses_real_update_api_backs_up_and_preserves_metadata(tmp_path, monkeypatch):
    original = StudyViewsFile(groups=[{"id": "g", "name": "보존 그룹"}], saves=[row()])
    save_saves(tmp_path, original)
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    client = TestClient(app)

    def api(method, url, payload=None):
        response = client.request(method, url, json=payload)
        response.raise_for_status()
        return response.json()

    monkeypatch.setattr(repair_tool, "api_json", api)
    dry = repair_tool.repair("http://testserver")
    assert dry["candidates"] == 1 and dry["applied"] == 0
    assert load_saves(tmp_path) == original
    backup = tmp_path / "backup.json"
    result = repair_tool.repair("http://testserver", apply=True, backup=backup)
    assert result["applied"] == 1
    assert json.loads(backup.read_text()) == original.model_dump(mode="json")
    repaired = load_saves(tmp_path)
    assert repaired.groups == original.groups
    before, after = original.saves[0].model_dump(), repaired.saves[0].model_dump()
    assert after.pop("range")["from_date"] == "20200710"
    before.pop("range")
    after.pop("updated_at_ms")
    before.pop("updated_at_ms")
    assert after == before
    assert repair_tool.repair("http://testserver", apply=True)["candidates"] == 0


def test_changed_row_aborts_without_overwrite(tmp_path, monkeypatch):
    original = StudyViewsFile(groups=[{"id": "g", "name": "복기"}], saves=[row()]).model_dump(mode="json")

    def api(method, url, payload=None):
        assert method == "GET"
        return original if url.endswith("/saves") else {**original["saves"][0], "memo": "다른 창의 편집"}

    monkeypatch.setattr(repair_tool, "api_json", api)
    with pytest.raises(ValueError, match="변경되었습니다"):
        repair_tool.repair("http://testserver", apply=True, backup=tmp_path / "backup.json")
    assert json.loads((tmp_path / "backup.json").read_text()) == original
