import json

from pydantic import BaseModel

from hoga.api.versioned_json_file import load_versioned_json_file


class ExampleFile(BaseModel):
    schema_version: int = 1
    values: list[int] = []


def test_missing_versioned_json_file_returns_empty(tmp_path):
    loaded = load_versioned_json_file(
        tmp_path / "saves.json",
        model=ExampleFile,
        current_version=1,
        empty_factory=ExampleFile,
    )

    assert loaded == ExampleFile()


def test_corrupt_versioned_json_file_is_quarantined(tmp_path):
    path = tmp_path / "saves.json"
    path.write_text("{ not json", encoding="utf-8")

    loaded = load_versioned_json_file(
        path,
        model=ExampleFile,
        current_version=1,
        empty_factory=ExampleFile,
    )

    assert loaded == ExampleFile()
    assert list(tmp_path.glob("saves.json.corrupt-*-badjson"))


def test_future_versioned_json_file_is_quarantined(tmp_path):
    path = tmp_path / "saves.json"
    path.write_text(json.dumps({"schema_version": 2, "values": []}), encoding="utf-8")

    loaded = load_versioned_json_file(
        path,
        model=ExampleFile,
        current_version=1,
        empty_factory=ExampleFile,
    )

    assert loaded == ExampleFile()
    assert list(tmp_path.glob("saves.json.corrupt-*-future-version"))


def test_schema_invalid_versioned_json_file_is_quarantined(tmp_path):
    path = tmp_path / "saves.json"
    path.write_text(json.dumps({"schema_version": "bad", "values": []}), encoding="utf-8")

    loaded = load_versioned_json_file(
        path,
        model=ExampleFile,
        current_version=1,
        empty_factory=ExampleFile,
    )

    assert loaded == ExampleFile()
    assert list(tmp_path.glob("saves.json.corrupt-*-schema"))
