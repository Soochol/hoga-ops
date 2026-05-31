import json
from pathlib import Path

from hoga.api import screener_saves as ss
from hoga.api.models import SavedScreenersFile


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
