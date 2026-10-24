from __future__ import annotations

import asyncio
import io
import json
import uuid

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image

from hoga.api import whiteboards as wb


def uid():
    return uuid.uuid4().hex


def app_for(path):
    app = FastAPI()
    app.include_router(wb.build_router(data_dir=path))
    return app


@pytest.fixture
async def client(tmp_path):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_for(tmp_path)), base_url="http://test"
    ) as client:
        yield client


async def create(client, **kwargs):
    response = await client.post(
        "/api/whiteboards", json={"id": uid(), "mutation_id": uid(), "name": "복기 노트", **kwargs}
    )
    assert response.status_code == 201, response.text
    return response.json()


def write(doc, **kwargs):
    return {
        "mutation_id": uid(),
        "expected_revision": doc["revision"],
        "name": doc["name"],
        "scene": doc["scene"],
        "deleted": False,
        **kwargs,
    }


def png():
    output = io.BytesIO()
    Image.new("RGB", (80, 40), "green").save(output, format="PNG")
    return output.getvalue()


async def test_crud_unknown_scene_fields_and_restart(client, tmp_path):
    doc = await create(client)
    req = write(
        doc,
        name="한글 이름",
        scene={
            "elements": [{"id": "memo", "type": "text", "text": "관찰\n메모", "customData": {"future": [1, 2]}}],
            "appState": {},
            "files": {},
        },
    )
    response = await client.put(f"/api/whiteboards/{doc['id']}", json=req)
    assert response.status_code == 200
    saved = response.json()
    assert saved["revision"] == 2
    assert saved["scene"] == req["scene"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_for(tmp_path)), base_url="http://test"
    ) as restarted:
        assert (await restarted.get(f"/api/whiteboards/{doc['id']}")).json() == saved
        summary = (await restarted.get("/api/whiteboards")).json()["boards"][0]
        assert summary["name"] == "한글 이름"
        assert summary["element_count"] == 1
        assert "scene" not in summary


async def test_create_and_save_idempotence_and_revision_conflict(client):
    req = {"id": uid(), "mutation_id": uid(), "name": "새 보드"}
    first = await client.post("/api/whiteboards", json=req)
    assert (await client.post("/api/whiteboards", json=req)).json() == first.json()
    doc = first.json()
    change = write(doc, name="변경")
    first_save = await client.put(f"/api/whiteboards/{doc['id']}", json=change)
    assert (await client.put(f"/api/whiteboards/{doc['id']}", json=change)).json() == first_save.json()
    stale = await client.put(f"/api/whiteboards/{doc['id']}", json=write(doc, name="덮어쓰기"))
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "whiteboard_conflict"
    reused = await client.put(f"/api/whiteboards/{doc['id']}", json={**change, "name": "다른 요청"})
    assert reused.status_code == 409


async def test_concurrent_writers_never_overwrite(client):
    doc = await create(client)
    results = await asyncio.gather(
        *(client.put(f"/api/whiteboards/{doc['id']}", json=write(doc, name=f"창 {i}")) for i in range(2))
    )
    assert sorted(response.status_code for response in results) == [200, 409]


async def test_image_dedup_round_trip_and_shared_clone_trash_restore(client):
    data = png()
    asset = (await client.post("/api/whiteboards/assets", content=data)).json()
    assert (await client.post("/api/whiteboards/assets", content=data)).json() == asset
    response = await client.get(f"/api/whiteboards/assets/{asset['asset_id']}")
    assert response.content == data
    assert response.headers["content-type"] == "image/png"
    scene = {
        "elements": [{"id": "image", "type": "image", "fileId": "file1"}],
        "appState": {},
        "files": {"file1": {**asset, "created": 1}},
    }
    original = await create(client, scene=scene)
    clone = await create(client, name="복사본", scene=scene)
    deleted = (await client.put(f"/api/whiteboards/{original['id']}", json=write(original, deleted=True))).json()
    assert deleted["deleted_at_ms"]
    assert [x["id"] for x in (await client.get("/api/whiteboards")).json()["boards"]] == [clone["id"]]
    assert len((await client.get("/api/whiteboards?deleted=true")).json()["boards"]) == 1
    assert (await client.get(f"/api/whiteboards/assets/{asset['asset_id']}")).content == data
    restored = (await client.put(f"/api/whiteboards/{original['id']}", json=write(deleted, deleted=False))).json()
    assert restored["deleted_at_ms"] is None
    assert restored["scene"] == clone["scene"]


async def test_reject_bad_images_oversize_missing_references_and_embeds(client, monkeypatch):
    assert (await client.post("/api/whiteboards/assets", content=b"not an image")).status_code == 422
    monkeypatch.setattr(wb, "MAX_IMAGE_BYTES", 10)
    assert (await client.post("/api/whiteboards/assets", content=png())).status_code == 413
    missing = await client.post(
        "/api/whiteboards",
        json={"id": uid(), "mutation_id": uid(), "scene": {"elements": [{"type": "image", "fileId": "absent"}]}},
    )
    assert missing.status_code == 422
    embed = await client.post(
        "/api/whiteboards",
        json={
            "id": uid(),
            "mutation_id": uid(),
            "scene": {"elements": [{"type": "embeddable", "link": "https://example.com"}]},
        },
    )
    assert embed.status_code == 422


async def test_write_failure_preserves_last_good_document(client, monkeypatch):
    doc = await create(client)

    def fail(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(wb, "atomic_write_json", fail)
    assert (await client.put(f"/api/whiteboards/{doc['id']}", json=write(doc, name="失敗"))).status_code == 503
    assert (await client.get(f"/api/whiteboards/{doc['id']}")).json() == doc


async def test_corruption_and_future_version_preserved(client, tmp_path):
    doc = await create(client)
    path = tmp_path / "whiteboards" / "boards" / f"{doc['id']}.json"
    for payload in ('{"partial":', "[]", json.dumps({**doc, "schema_version": 99})):
        path.write_text(payload)
        assert (await client.get(f"/api/whiteboards/{doc['id']}")).status_code in (409, 503)
        result = (await client.get("/api/whiteboards")).json()
        assert result["unreadable_ids"] == [doc["id"]]
        assert path.read_text() == payload


async def test_invalid_id_and_whitespace_name(client):
    assert (await client.get("/api/whiteboards/not-an-id")).status_code == 404
    response = await client.post("/api/whiteboards", json={"id": uid(), "mutation_id": uid(), "name": "  "})
    assert response.status_code == 422
