import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import screener_saves as ss
from hoga.api.models import SavedScreenersFile, ScreenerSaveWriteRequest
from hoga.api.screener import build_router


@pytest.fixture
def client(tmp_path):
    # Saves routes need no parquet/status seeding (that's scan-only) — a bare
    # data_dir is enough; load_saves lazily returns an empty file on first read.
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


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


@pytest.mark.parametrize("payload", ["[]", "5", '"x"', "null"])
def test_non_object_json_quarantined(tmp_path, payload):
    # Valid JSON but not an object would AttributeError on raw.get and escape
    # quarantine. The isinstance(dict) guard treats it as corrupt instead.
    p = tmp_path / "screener" / "saves.json"
    p.parent.mkdir(parents=True)
    p.write_text(payload, encoding="utf-8")
    assert ss.load_saves(tmp_path).saves == []
    assert list(p.parent.glob("saves.json.corrupt-*-badshape"))


def test_schema_mismatch_quarantined(tmp_path):
    # Valid JSON object, right top-level shape, but a save missing required
    # `id` → pydantic ValidationError → quarantined to .corrupt-*-schema.
    p = tmp_path / "screener" / "saves.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"schema_version": 1, "saves": [
        {"name": "x", "conditions": [], "universe": {},
         "created_at_ms": 1, "updated_at_ms": 1}]}), encoding="utf-8")  # no `id`
    assert ss.load_saves(tmp_path).saves == []
    assert list(p.parent.glob("saves.json.corrupt-*-schema"))


async def test_save_saves_oserror_propagates(tmp_path, monkeypatch):
    # The one invariant whose violation is SILENT DATA LOSS: save_saves must
    # let OSError bubble (file=SSOT). Pin it so a future try/except regresses red.
    def _boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(ss, "atomic_write_json", _boom)
    with pytest.raises(OSError):
        await ss.create_save(tmp_path, req=_req(), id="srv1", now_ms=1)


def test_route_surfaces_500_on_write_failure(tmp_path, monkeypatch):
    # End-to-end: a write OSError reaches the client as HTTP 500, not a
    # swallowed 201 with no persisted data.
    def _boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(ss, "atomic_write_json", _boom)
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    c = TestClient(app, raise_server_exceptions=False)
    r = c.post("/api/screener/saves",
               json={"name": "급등주", "conditions": [], "universe": {}})
    assert r.status_code == 500


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


def test_saves_routes_crud(client):
    # create
    r = client.post(
        "/api/screener/saves",
        json={
            "name": "급등주",
            "conditions": [
                {"id": "a", "type": "new_high", "params": {"lookback": 200, "period": 500}}
            ],
            "universe": {},
        },
    )
    assert r.status_code == 201
    sid = r.json()["id"]
    # list
    assert [s["id"] for s in client.get("/api/screener/saves").json()["saves"]] == [sid]
    # put (rename)
    r2 = client.put(
        f"/api/screener/saves/{sid}",
        json={"name": "이름변경", "conditions": [], "universe": {}},
    )
    assert r2.status_code == 200 and r2.json()["name"] == "이름변경"
    # delete
    assert client.delete(f"/api/screener/saves/{sid}").status_code == 204
    assert client.get(f"/api/screener/saves/{sid}").status_code == 404


def test_save_blank_name_422(client):
    r = client.post("/api/screener/saves", json={"name": "", "conditions": [], "universe": {}})
    assert r.status_code == 422


def test_save_whitespace_only_name_422(client):
    # Spec: 이름 공백 → 422. min_length=1 alone accepts "   "; the field
    # validator strips and rejects empty-after-strip.
    assert client.post("/api/screener/saves",
        json={"name": "   ", "conditions": [], "universe": {}}).status_code == 422


def test_name_is_stripped(client):
    # Surrounding whitespace is trimmed before persistence.
    r = client.post("/api/screener/saves",
        json={"name": "  급등주  ", "conditions": [], "universe": {}})
    assert r.status_code == 201 and r.json()["name"] == "급등주"


def test_put_preserves_created_bumps_updated(client):
    r = client.post("/api/screener/saves", json={"name": "원본", "conditions": [], "universe": {}})
    body = r.json()
    sid, created = body["id"], body["created_at_ms"]
    r2 = client.put(
        f"/api/screener/saves/{sid}",
        json={"name": "수정", "conditions": [], "universe": {}},
    )
    upd = r2.json()
    assert upd["id"] == sid
    assert upd["created_at_ms"] == created            # preserved
    assert upd["updated_at_ms"] >= created            # bumped (monotonic clock)


def test_get_and_put_and_delete_missing_404(client):
    assert client.get("/api/screener/saves/nope").status_code == 404
    assert client.put("/api/screener/saves/nope",
        json={"name": "x", "conditions": [], "universe": {}}).status_code == 404
    assert client.delete("/api/screener/saves/nope").status_code == 404
