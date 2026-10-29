from __future__ import annotations

import asyncio
import hashlib
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


async def test_canvas_capture_stock_codes_are_searchable_without_changing_legacy_records(client):
    doc = await create(client, review={"date": "2026-10-29"})
    asset = (await client.post("/api/whiteboards/assets", content=png(), headers={"Content-Type": "image/png"})).json()
    def image(key, source, **extra):
        return {"id": key, "type": "image", "fileId": "chart", "customData": {"chartSource": source}, **extra}
    scene = {"elements": [
        image("daily", {"code": "0000D0", "timeframe": "D"}),
        image("minute", {"code": "0000D0", "timeframe": "5m"}),
        image("index", {"index_id": "KOSPI"}), image("bad", {"code": "../../"}),
        image("deleted", {"code": "000660"}, isDeleted=True), image("malformed", "invalid"),
    ], "files": {"chart": {**asset, "created": 1}}, "appState": {}}
    response = await client.put(f"/api/whiteboards/{doc['id']}", json=write(doc, scene=scene, review=doc["review"]))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["review"]["stocks"] == ["0000D0"]
    assert saved["review"]["records"] == []
    assert (await client.get("/api/whiteboards")).json()["boards"][0]["review"]["stocks"] == ["0000D0"]
    scene["elements"][0]["isDeleted"] = True
    scene["elements"][1]["isDeleted"] = True
    removed = await client.put(f"/api/whiteboards/{doc['id']}", json=write(saved, scene=scene, review=saved["review"]))
    assert removed.json()["review"]["stocks"] == []


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


async def test_daily_open_is_atomic_and_reuses_the_original_note(client):
    responses = await asyncio.gather(*(client.post("/api/whiteboards/daily/2026-10-24") for _ in range(8)))
    assert all(response.status_code == 200 for response in responses)
    ids = {response.json()["id"] for response in responses}
    assert len(ids) == 1
    doc = responses[0].json()
    assert doc["schema_version"] == 2
    assert doc["review"]["date"] == "2026-10-24"
    saved = (await client.put(f"/api/whiteboards/{doc['id']}", json=write(
        doc, name="하루 복기", review={**doc["review"], "summary": "내일의 원칙", "completed": True},
    ))).json()
    again = (await client.post("/api/whiteboards/daily/2026-10-24")).json()
    assert again == saved
    assert (await client.post("/api/whiteboards/daily/2026-02-30")).status_code == 422
    assert (await client.get("/api/whiteboards")).json()["boards"][0]["review"] == {
        "date": "2026-10-24", "summary": "내일의 원칙", "completed": True, "stocks": [],
    }


async def test_note_records_images_restart_and_validation(client, tmp_path):
    doc = (await client.post("/api/whiteboards/daily/2026-10-23")).json()
    image = (await client.post("/api/whiteboards/assets", content=png())).json()
    scene = {**doc["scene"], "files": {"chart": {**image, "created": 1}}}
    record = {"id": uid(), "stock": "삼성전자", "code": "005930", "title": "첫 눌림", "image_file_id": "chart",
              "judgment": "지지 확인", "action": "관망", "result": "기준 유지"}
    req = write(doc, scene=scene, review={**doc["review"], "records": [record], "principle": "확인하고 진입"})
    response = await client.put(f"/api/whiteboards/{doc['id']}", json=req)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["review"]["stocks"] == ["삼성전자"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_for(tmp_path)), base_url="http://test"
    ) as restarted:
        assert (await restarted.get(f"/api/whiteboards/{doc['id']}")).json() == saved
        assert (await restarted.get(f"/api/whiteboards/assets/{image['asset_id']}")).content == png()
    # An older canvas request which omits review cannot silently erase writing.
    preserved = await client.put(f"/api/whiteboards/{doc['id']}", json=write(saved))
    assert preserved.json()["review"] == saved["review"]
    current = preserved.json()
    bad_date = {**current["review"], "date": "2026-02-30"}
    assert (await client.put(f"/api/whiteboards/{doc['id']}", json=write(current, review=bad_date))).status_code == 422
    missing = {**current["review"], "records": [{**record, "image_file_id": "missing"}]}
    assert (await client.put(f"/api/whiteboards/{doc['id']}", json=write(current, review=missing))).status_code == 422
    duplicate = {**current["review"], "records": [record, record]}
    assert (await client.put(f"/api/whiteboards/{doc['id']}", json=write(current, review=duplicate))).status_code == 422
    assert (await client.get(f"/api/whiteboards/{doc['id']}")).json() == current


async def test_daily_trash_restore_and_conflict_preserve_writing(client):
    doc = (await client.post("/api/whiteboards/daily/2026-10-23")).json()
    req = write(doc, review={**doc["review"], "summary": "먼저 저장한 기록"})
    saved = (await client.put(f"/api/whiteboards/{doc['id']}", json=req)).json()
    stale = write(doc, review={**doc["review"], "summary": "다른 창의 초안"})
    assert (await client.put(f"/api/whiteboards/{doc['id']}", json=stale)).status_code == 409
    trashed = (await client.put(f"/api/whiteboards/{doc['id']}", json=write(saved, deleted=True))).json()
    assert trashed["review"]["summary"] == "먼저 저장한 기록"
    assert not (await client.get("/api/whiteboards")).json()["boards"]
    assert (await client.get("/api/whiteboards?deleted=true")).json()["boards"][0]["id"] == doc["id"]
    restored = (await client.put(f"/api/whiteboards/{doc['id']}", json=write(trashed))).json()
    assert restored["review"] == saved["review"]
    assert (await client.post("/api/whiteboards/daily/2026-10-23")).json()["id"] == doc["id"]


async def test_pre_upgrade_mutation_hash_and_unknown_note_fields_are_preserved(client, tmp_path):
    doc = await create(client)
    request = wb.WhiteboardWrite.model_validate(write(doc, name="배포 전 저장"))
    saved = (await client.put(f"/api/whiteboards/{doc['id']}", json=request.model_dump(exclude={"review"}))).json()
    path = tmp_path / "whiteboards" / "boards" / f"{doc['id']}.json"
    saved["last_mutation_hash"] = hashlib.sha256(request.model_dump_json(exclude={"review"}).encode()).hexdigest()
    path.write_text(json.dumps(saved))
    retry = await client.put(f"/api/whiteboards/{doc['id']}", json=request.model_dump(exclude={"review"}))
    assert retry.status_code == 200
    assert retry.json()["revision"] == saved["revision"]
    note = (await client.post("/api/whiteboards/daily/2026-10-24")).json()
    target = tmp_path / "whiteboards" / "boards" / f"{note['id']}.json"
    note["review"]["future_field"] = "보존할 미래 필드"
    raw = json.dumps(note)
    target.write_text(raw)
    assert (await client.get(f"/api/whiteboards/{note['id']}")).status_code == 503
    assert target.read_text() == raw


async def test_invalid_id_and_whitespace_name(client):
    assert (await client.get("/api/whiteboards/not-an-id")).status_code == 404
    response = await client.post("/api/whiteboards", json={"id": uid(), "mutation_id": uid(), "name": "  "})
    assert response.status_code == 422
