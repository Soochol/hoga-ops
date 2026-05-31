import json

import pytest

from hoga.api import screener_saves as ss
from hoga.api.models import SavedScreenersFile, ScreenerSaveWriteRequest


def test_load_missing_returns_empty(tmp_path):
    assert ss.load_saves(tmp_path).saves == []


def test_save_then_load_roundtrip(tmp_path):
    f = SavedScreenersFile(saves=[])
    ss.save_saves(tmp_path, f)
    assert (tmp_path / "screener" / "saves.json").exists()
    assert ss.load_saves(tmp_path).schema_version == 1


def test_corrupt_file_quarantined(tmp_path):
    p = tmp_path / "screener" / "saves.json"
    p.parent.mkdir(parents=True)
    p.write_text("{ not json", encoding="utf-8")
    assert ss.load_saves(tmp_path).saves == []           # empty
    assert list(p.parent.glob("saves.json.corrupt-*"))    # renamed


def test_future_version_quarantined(tmp_path):
    p = tmp_path / "screener" / "saves.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"schema_version": 99, "saves": []}), encoding="utf-8")
    assert ss.load_saves(tmp_path).saves == []
    assert list(p.parent.glob("saves.json.corrupt-*"))


def _req(name="급등주"):
    return ScreenerSaveWriteRequest(name=name, conditions=[
        {"id": "a", "type": "new_high", "params": {"lookback": 200, "period": 500}}], universe={})


async def test_crud_roundtrip(tmp_path):
    s = await ss.create_save(tmp_path, req=_req(), id="srv1", now_ms=100)
    assert s.id == "srv1" and s.created_at_ms == 100
    assert [x.id for x in await ss.list_saves(tmp_path)] == ["srv1"]
    upd = await ss.update_save(tmp_path, id="srv1", req=_req("이름변경"), now_ms=200)
    assert upd.name == "이름변경" and upd.created_at_ms == 100 and upd.updated_at_ms == 200
    await ss.delete_save(tmp_path, id="srv1")
    assert await ss.list_saves(tmp_path) == []


async def test_update_missing_raises(tmp_path):
    with pytest.raises(ss.ScreenerSaveNotFoundError):
        await ss.update_save(tmp_path, id="nope", req=_req(), now_ms=1)


async def test_delete_missing_raises(tmp_path):
    with pytest.raises(ss.ScreenerSaveNotFoundError):
        await ss.delete_save(tmp_path, id="nope")
