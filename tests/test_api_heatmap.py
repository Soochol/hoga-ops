"""Heatmap independent-store + route tests (ADR-0068, amended by 0097/0112/0142).

Mirrors the watchlist suite but asserts the SEPARATION invariants:
  - the heatmap store/routes never touch watchlist.json;
  - HeatmapEntry carries no capture fields — since ADR-0142 the heatmap DOES
    drive captures, but the marker lives in a code-keyed ``capture_markers``
    side table, never on the (folder_id, code)-keyed entry;
  - entry-SET mutations resync storage targets (ADR-0097) while folder-shape
    mutations (rename/reorder/move) do not — delete-folder resyncs since v3
    (it deletes member entries too, ADR-0112);
  - v3 (ADR-0112): folder_id is required (no 미분류 null group) — folder
    delete is destructive, and v1/v2 folder-less entries migrate into a real
    '미분류' folder (f_00000000);
  - the one-time seed copies the watchlist (capture-stripped) only when
    heatmap.json is absent AND the watchlist is non-empty, and never writes
    the watchlist.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def stub_refresh_live_stream():
    """Keep route tests hermetic: the ADR-0097 storage resync hook must never
    reach the real lifecycle (global state, creds probing) from this suite."""
    with patch("hoga.api.heatmap_routes.refresh_live_stream", new=AsyncMock()) as mock:
        yield mock


# --- store: persistence -----------------------------------------------------

def test_load_returns_empty_when_file_missing(tmp_path: Path):
    from hoga.api.heatmap import load_heatmap
    assert load_heatmap(tmp_path) == []


def test_save_then_load_round_trip(tmp_path: Path):
    from hoga.api.heatmap import load_heatmap, save_document
    from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder
    save_document(tmp_path, HeatmapDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="항공", order=0)],
        entries=[HeatmapEntry(code="003490", name="대한항공", folder_id="f_0000000a")]))
    entries = load_heatmap(tmp_path)
    assert len(entries) == 1
    assert entries[0].code == "003490"
    # HeatmapEntry has NO capture fields (ADR-0068 G2).
    assert not hasattr(entries[0], "last_success_date")
    assert not hasattr(entries[0], "registered_at_kst_date")


def test_corrupted_json_is_backed_up_and_returns_empty(tmp_path: Path):
    from hoga.api.heatmap import load_heatmap
    (tmp_path / "heatmap.json").write_text("not valid json")
    assert load_heatmap(tmp_path) == []
    assert not (tmp_path / "heatmap.json").exists()
    assert len(list(tmp_path.glob("heatmap.json.corrupt-*"))) == 1


# --- store: entry + folder mutations ---------------------------------------

@pytest.mark.asyncio
async def test_add_and_remove_entry(tmp_path: Path):
    from hoga.api import heatmap
    from hoga.api.heatmap import NotInHeatmapError
    f = await heatmap.create_folder(tmp_path, name="항공")
    await heatmap.add_entry_to_folder(tmp_path, code="003490", name="대한항공", folder_id=f.id)
    assert [e.code for e in heatmap.load_heatmap(tmp_path)] == ["003490"]
    # Re-adding an existing code is a move/no-op, never a duplicate (v3 single
    # add command — the old AlreadyInHeatmapError surface is gone).
    await heatmap.add_entry_to_folder(tmp_path, code="003490", name="대한항공", folder_id=f.id)
    assert [e.code for e in heatmap.load_heatmap(tmp_path)] == ["003490"]
    await heatmap.remove_entry(tmp_path, code="003490")
    assert heatmap.load_heatmap(tmp_path) == []
    with pytest.raises(NotInHeatmapError):
        await heatmap.remove_entry(tmp_path, code="003490")


@pytest.mark.asyncio
async def test_delete_folder_deletes_members(tmp_path: Path):
    """v3 (ADR-0112): folder delete is destructive — the folder AND its member
    entries disappear; nothing is reparented (no 미분류)."""
    from hoga.api import heatmap
    f = await heatmap.create_folder(tmp_path, name="반도체")
    keep = await heatmap.create_folder(tmp_path, name="자동차")
    await heatmap.add_entry_to_folder(tmp_path, code="005930", name="삼성전자", folder_id=f.id)
    await heatmap.add_entry_to_folder(tmp_path, code="005380", name="현대차", folder_id=keep.id)
    await heatmap.delete_folder(tmp_path, folder_id=f.id)
    doc = heatmap.load_document(tmp_path)
    assert [fo.id for fo in doc.folders] == [keep.id]
    assert [(e.code, e.folder_id) for e in doc.entries] == [("005380", keep.id)]


@pytest.mark.asyncio
async def test_reorder_set_mismatch_raises(tmp_path: Path):
    from hoga.api import heatmap
    from hoga.api.heatmap import HeatmapSetMismatchError
    f = await heatmap.create_folder(tmp_path, name="반도체")
    await heatmap.add_entry_to_folder(tmp_path, code="005930", name="삼성전자", folder_id=f.id)
    await heatmap.add_entry_to_folder(tmp_path, code="000660", name="SK하이닉스", folder_id=f.id)
    with pytest.raises(HeatmapSetMismatchError):
        await heatmap.reorder_entries(tmp_path, folder_id=f.id, ordered_codes=["005930"])


# --- store: v2 → v3 migration (ADR-0112) ------------------------------------

def _write_v2(tmp_path: Path, *, folders: list[dict], entries: list[dict]) -> None:
    import json
    (tmp_path / "heatmap.json").write_text(json.dumps(
        {"schema_version": 2, "folders": folders, "entries": entries},
        ensure_ascii=False), encoding="utf-8")


def test_migrate_v2_null_entries_land_in_uncat_real_folder(tmp_path: Path):
    """v2 folder-less (미분류) entries are rescued into a REAL '미분류' folder
    with the deterministic id f_00000000 — after existing folder members."""
    from hoga.api.heatmap import load_document
    _write_v2(tmp_path,
              folders=[{"id": "f_0000000a", "name": "반도체", "order": 0}],
              entries=[
                  {"code": "005930", "name": "삼성전자", "folder_id": "f_0000000a", "order": 0},
                  {"code": "035720", "name": "카카오", "folder_id": None, "order": 0},
                  {"code": "003490", "name": "대한항공", "folder_id": None, "order": 1},
              ])
    doc = load_document(tmp_path)
    assert doc.schema_version == 4
    assert [(f.id, f.name) for f in doc.folders] == [
        ("f_0000000a", "반도체"), ("f_00000000", "미분류")]
    by_code = {e.code: e for e in doc.entries}
    assert by_code["005930"].folder_id == "f_0000000a"
    assert by_code["035720"].folder_id == "f_00000000"
    assert by_code["003490"].folder_id == "f_00000000"
    # rescued entries keep their relative order, compacted to 0..N-1.
    assert (by_code["035720"].order, by_code["003490"].order) == (0, 1)


def test_migrate_v2_merges_into_existing_f00000000(tmp_path: Path):
    """A heatmap seeded verbatim from a v3 watchlist already carries
    f_00000000 ('기본') — rescued entries merge into it AFTER its members,
    never duplicating the folder id."""
    from hoga.api.heatmap import load_document
    _write_v2(tmp_path,
              folders=[{"id": "f_00000000", "name": "기본", "order": 0}],
              entries=[
                  {"code": "005930", "name": "삼성전자", "folder_id": "f_00000000", "order": 0},
                  {"code": "035720", "name": "카카오", "folder_id": None, "order": 0},
              ])
    doc = load_document(tmp_path)
    assert [(f.id, f.name) for f in doc.folders] == [("f_00000000", "기본")]
    by_code = {e.code: e for e in doc.entries}
    assert by_code["035720"].folder_id == "f_00000000"
    assert by_code["005930"].order < by_code["035720"].order


def test_migrate_v1_folderless_file_rescues_all_entries(tmp_path: Path):
    """v1 (no schema_version, no folders key) — every entry is folder-less, so
    all land in the 미분류 real folder preserving file order."""
    import json
    (tmp_path / "heatmap.json").write_text(json.dumps({"entries": [
        {"code": "005930", "name": "삼성전자"},
        {"code": "035720", "name": "카카오"},
    ]}, ensure_ascii=False), encoding="utf-8")
    from hoga.api.heatmap import load_document
    doc = load_document(tmp_path)
    assert doc.schema_version == 4
    assert [(f.id, f.name) for f in doc.folders] == [("f_00000000", "미분류")]
    assert [(e.code, e.folder_id, e.order) for e in doc.entries] == [
        ("005930", "f_00000000", 0), ("035720", "f_00000000", 1)]


def test_migrate_v2_without_nulls_is_clean_version_bump(tmp_path: Path):
    from hoga.api.heatmap import load_document
    _write_v2(tmp_path,
              folders=[{"id": "f_0000000a", "name": "반도체", "order": 0}],
              entries=[{"code": "005930", "name": "삼성전자",
                        "folder_id": "f_0000000a", "order": 0}])
    doc = load_document(tmp_path)
    assert doc.schema_version == 4
    assert [f.id for f in doc.folders] == ["f_0000000a"]  # no 미분류 minted


def test_future_schema_version_halts_loudly(tmp_path: Path):
    import json

    from hoga.api.heatmap import UnsupportedHeatmapSchema, load_document
    (tmp_path / "heatmap.json").write_text(
        json.dumps({"schema_version": 5, "folders": [], "entries": []}))
    with pytest.raises(UnsupportedHeatmapSchema):
        load_document(tmp_path)


# --- routes -----------------------------------------------------------------

def _app(tmp_path: Path) -> FastAPI:
    from hoga.api.heatmap_routes import build_router
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return app


def _fake_hit(code: str = "003490", name: str = "대한항공"):
    from hoga.api.models import SymbolHit
    return SymbolHit(
        code=code, name=name, market="KOSPI", captured_count=0,
        captured_breakdown={"complete": 0, "source_partial": 0,
                            "client_incomplete": 0, "invalid": 0},
    )


def test_get_empty_heatmap_reports_the_shared_next_run(tmp_path: Path):
    r = TestClient(_app(tmp_path)).get("/api/heatmap")
    assert r.status_code == 200
    body = r.json()
    assert body["entries"] == []
    assert body["folders"] == []
    assert body["capture_markers"] == {}
    # ADR-0142: 히트맵도 17:00 일일 런의 적재 대상이므로 next_run_at_ms 가 있다.
    # 값은 관심목록 라우트와 **같은 함수**(scheduler.next_run_at_ms)에서 나온다 —
    # 두 화면이 다른 시각을 말하면 그 자체가 버그이므로 그 함수와 대조한다.
    import datetime as _dt
    from zoneinfo import ZoneInfo

    from hoga.api.scheduler import next_run_at_ms
    expected = next_run_at_ms(_dt.datetime.now(tz=ZoneInfo("Asia/Seoul")))
    assert abs(body["next_run_at_ms"] - expected) < 2000


def test_heatmap_folder_wire_drops_member_codes(tmp_path: Path):
    client = TestClient(_app(tmp_path))
    r = client.post("/api/heatmap/folders", json={"name": "반도체"})
    assert r.status_code == 201
    assert "member_codes" not in r.json()

    body = client.get("/api/heatmap").json()
    assert "member_codes" not in body["folders"][0]


def test_folderless_post_route_is_gone(tmp_path: Path):
    """v3 (ADR-0112): the folder-less POST /api/heatmap no longer exists —
    the only add surface is the folder-scoped member add."""
    r = TestClient(_app(tmp_path)).post("/api/heatmap", json={"code": "003490"})
    assert r.status_code == 405


def test_member_add_unknown_code_404(tmp_path: Path):
    from unittest.mock import patch
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "항공"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[]):
        r = client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "999999"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "unknown_code"


def test_member_add_wire_has_no_capture_fields(tmp_path: Path):
    from unittest.mock import patch
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "항공"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[_fake_hit()]):
        r = client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "003490"})
    assert r.status_code == 201
    assert r.json()["code"] == "003490"
    assert "last_success_date" not in r.json()
    assert "registered_at_kst_date" not in r.json()


def test_delete_absent_404(tmp_path: Path):
    r = TestClient(_app(tmp_path)).delete("/api/heatmap/003490")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_in_heatmap"


def test_folder_create_and_move_routes(tmp_path: Path):
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))
    src = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
    dst = client.post("/api/heatmap/folders", json={"name": "대형주"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        client.post(f"/api/heatmap/folders/{src}/members", json={"code": "005930"})
    mv = client.post("/api/heatmap/move", json={
        "codes": ["005930"], "from_folder_id": src, "folder_id": dst})
    assert mv.status_code == 204
    entries = client.get("/api/heatmap").json()["entries"]
    # 이동이지 복제가 아니다 — 출발 그룹 등록은 사라진다.
    assert [(e["code"], e["folder_id"]) for e in entries] == [("005930", dst)]


def test_move_without_from_folder_is_rejected_422(tmp_path: Path):
    """한 종목이 여러 그룹에 등록될 수 있으므로 출발 그룹 없는 이동은 어느 등록을 옮길지
    정해지지 않는다 — 서버가 추측하는 대신 와이어에서 거절한다."""
    r = TestClient(_app(tmp_path)).post(
        "/api/heatmap/move", json={"codes": ["005930"], "folder_id": "f_0000000a"})
    assert r.status_code == 422


def test_move_to_null_folder_is_rejected_422(tmp_path: Path):
    """v3 wire contract: folder_id must be a real folder id — a null
    destination (the old 미분류) is a validation error, not a reparent."""
    r = TestClient(_app(tmp_path)).post(
        "/api/heatmap/move",
        json={"codes": ["005930"], "from_folder_id": "f_0000000a", "folder_id": None})
    assert r.status_code == 422


def test_folder_member_add_is_atomic_for_new_code(tmp_path: Path):
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]

    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        r = client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "005930"})

    assert r.status_code == 201
    assert r.json()["code"] == "005930"
    assert r.json()["folder_id"] == fid
    entries = client.get("/api/heatmap").json()["entries"]
    assert [(e["code"], e["folder_id"], e["order"]) for e in entries] == [("005930", fid, 0)]


def test_folder_member_add_registers_in_both_groups(tmp_path: Path):
    """한 종목 다중 그룹 등록. 다른 그룹에 이미 있어도 **이동이 아니라 추가** — 옮기려면
    명시적 /move 를 쓴다. (구 v3 동작은 두 번째 추가가 첫 등록을 옮겨 갔다.)"""
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))
    a = client.post("/api/heatmap/folders", json={"name": "대형주"}).json()["id"]
    b = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]

    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        assert client.post(f"/api/heatmap/folders/{a}/members",
                           json={"code": "005930"}).status_code == 201
        r = client.post(f"/api/heatmap/folders/{b}/members", json={"code": "005930"})

    assert r.status_code == 201
    entries = client.get("/api/heatmap").json()["entries"]
    assert sorted((e["code"], e["folder_id"]) for e in entries) == sorted(
        [("005930", a), ("005930", b)])
    # 각 그룹 안에서는 여전히 0-based 단일 등록.
    assert all(e["order"] == 0 for e in entries)


def test_remove_member_is_scoped_to_one_group(tmp_path: Path):
    """그룹 스코프 해제는 다른 그룹의 등록을 건드리지 않는다 — 화면의 한 행을 지웠는데
    보이지도 않는 그룹에서 종목이 사라지면 안 된다."""
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))
    a = client.post("/api/heatmap/folders", json={"name": "대형주"}).json()["id"]
    b = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        client.post(f"/api/heatmap/folders/{a}/members", json={"code": "005930"})
        client.post(f"/api/heatmap/folders/{b}/members", json={"code": "005930"})

    r = client.delete(f"/api/heatmap/folders/{a}/members/005930")
    assert r.status_code == 204
    entries = client.get("/api/heatmap").json()["entries"]
    assert [(e["code"], e["folder_id"]) for e in entries] == [("005930", b)]

    # 그 그룹에 없는 코드를 지우려 하면 404 (다른 그룹에 있어도 마찬가지).
    assert client.delete(f"/api/heatmap/folders/{a}/members/005930").status_code == 404


def test_remove_code_route_clears_every_group(tmp_path: Path):
    """그룹 없는 DELETE /{code} 는 '히트맵에서 완전 제거' — 모든 등록을 지운다."""
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))
    a = client.post("/api/heatmap/folders", json={"name": "대형주"}).json()["id"]
    b = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        client.post(f"/api/heatmap/folders/{a}/members", json={"code": "005930"})
        client.post(f"/api/heatmap/folders/{b}/members", json={"code": "005930"})

    assert client.delete("/api/heatmap/005930").status_code == 204
    assert client.get("/api/heatmap").json()["entries"] == []


def test_move_into_group_that_already_has_the_code_collapses(tmp_path: Path):
    """한 그룹은 같은 코드를 한 번만 담는다 — 이미 있는 그룹으로 옮기면 출발 등록이
    사라질 뿐 중복 행이 생기지 않는다."""
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))
    a = client.post("/api/heatmap/folders", json={"name": "대형주"}).json()["id"]
    b = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        client.post(f"/api/heatmap/folders/{a}/members", json={"code": "005930"})
        client.post(f"/api/heatmap/folders/{b}/members", json={"code": "005930"})

    mv = client.post("/api/heatmap/move", json={
        "codes": ["005930"], "from_folder_id": a, "folder_id": b})
    assert mv.status_code == 204
    entries = client.get("/api/heatmap").json()["entries"]
    assert [(e["code"], e["folder_id"]) for e in entries] == [("005930", b)]


def test_delete_folder_keeps_the_codes_other_registrations(tmp_path: Path):
    """그룹 삭제는 그 그룹의 등록만 지운다(파괴적이지만 그룹 스코프) — 같은 종목이
    다른 그룹에 있으면 히트맵에서 사라지지 않는다."""
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))
    a = client.post("/api/heatmap/folders", json={"name": "대형주"}).json()["id"]
    b = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        client.post(f"/api/heatmap/folders/{a}/members", json={"code": "005930"})
        client.post(f"/api/heatmap/folders/{b}/members", json={"code": "005930"})

    assert client.delete(f"/api/heatmap/folders/{a}").status_code == 204
    entries = client.get("/api/heatmap").json()["entries"]
    assert [(e["code"], e["folder_id"]) for e in entries] == [("005930", b)]


def test_folder_member_add_preserves_order_when_code_already_in_folder(tmp_path: Path):
    from unittest.mock import patch
    hits = [
        _fake_hit("005930", "삼성전자"),
        _fake_hit("000660", "SK하이닉스"),
    ]
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]

    with patch("hoga.api.heatmap_routes.symbols.search", side_effect=[[hits[0]], [hits[1]], [hits[0]]]):
        assert client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "005930"}).status_code == 201
        assert client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "000660"}).status_code == 201
        r = client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "005930"})

    assert r.status_code == 201
    entries = client.get("/api/heatmap").json()["entries"]
    assert [(e["code"], e["folder_id"], e["order"]) for e in entries] == [
        ("005930", fid, 0),
        ("000660", fid, 1),
    ]


def test_folder_member_add_rejects_missing_folder_without_adding_code(tmp_path: Path):
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))

    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        r = client.post("/api/heatmap/folders/f_ffffffff/members", json={"code": "005930"})

    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "folder_not_found"
    assert client.get("/api/heatmap").json()["entries"] == []


# --- separation invariants --------------------------------------------------

def test_entry_set_mutations_resync_storage_targets(tmp_path: Path, stub_refresh_live_stream):
    """ADR-0097 (amended by ADR-0112): every route that can change the entry
    SET — member add, delete, bulk remove, and folder delete (which deletes
    members too) — resyncs storage targets so the REST 30s recorder follows."""
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
    assert stub_refresh_live_stream.await_count == 0  # folder create: no resync

    with patch("hoga.api.heatmap_routes.symbols.search",
               return_value=[_fake_hit("005930", "삼성전자")]):
        client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "005930"})
        assert stub_refresh_live_stream.await_count == 1

    client.delete("/api/heatmap/005930")
    assert stub_refresh_live_stream.await_count == 2

    client.post("/api/heatmap/remove", json={"codes": ["005930"]})
    assert stub_refresh_live_stream.await_count == 3

    client.delete(f"/api/heatmap/folders/{fid}")
    assert stub_refresh_live_stream.await_count == 4  # v3: deletes members too


def test_folder_shape_mutations_do_not_resync(tmp_path: Path, stub_refresh_live_stream):
    """Rename/reorder/move leave the entry SET intact — the storage-target
    resync hook must not fire (heatmap UI stays snappy). Folder DELETE is no
    longer shape-only (v3 deletes members) and lives in the resync test."""
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search",
               return_value=[_fake_hit("005930", "삼성전자")]):
        client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "005930"})
    calls_after_setup = stub_refresh_live_stream.await_count

    client.patch(f"/api/heatmap/folders/{fid}", json={"name": "IT"})
    client.put("/api/heatmap/folders/order", json={"ordered_ids": [fid]})
    client.post("/api/heatmap/move", json={"codes": ["005930"], "folder_id": fid})
    client.put("/api/heatmap/reorder", json={"folder_id": fid, "ordered_codes": ["005930"]})

    assert stub_refresh_live_stream.await_count == calls_after_setup


def test_add_succeeds_even_if_storage_resync_fails(tmp_path: Path, stub_refresh_live_stream):
    """The disk write already committed — a resync failure must not fail the
    route (best-effort hook, same contract as the watchlist routes)."""
    stub_refresh_live_stream.side_effect = RuntimeError("lifecycle down")
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "항공"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[_fake_hit()]):
        r = client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "003490"})
    assert r.status_code == 201
    assert client.delete("/api/heatmap/003490").status_code == 204


def test_member_add_does_not_touch_watchlist(tmp_path: Path):
    from unittest.mock import patch
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "항공"}).json()["id"]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[_fake_hit()]):
        client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "003490"})
    # Adding to the heatmap writes heatmap.json only — watchlist.json untouched.
    assert (tmp_path / "heatmap.json").exists()
    assert not (tmp_path / "watchlist.json").exists()


# --- one-time seed ----------------------------------------------------------

def _seed_watchlist(tmp_path: Path) -> None:
    """Write a watchlist.json directly (v3: folder owns member_codes)."""
    from hoga.api import watchlist
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder, code_items
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="반도체", order=0,
                                 items=code_items(["005930", "035720"]))],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자",
                           registered_at_kst_date="20260601", last_success_date="20260610"),
            WatchlistEntry(code="035720", name="카카오",
                           registered_at_kst_date="20260601", last_success_date=None),
        ],
    )
    watchlist.save_document(tmp_path, doc)


def test_seed_copies_watchlist_stripping_capture_fields(tmp_path: Path):
    from hoga.api.heatmap import load_document, seed_from_watchlist_if_absent
    _seed_watchlist(tmp_path)
    seed_from_watchlist_if_absent(tmp_path)
    doc = load_document(tmp_path)
    assert {f.name for f in doc.folders} == {"반도체"}
    assert {e.code for e in doc.entries} == {"005930", "035720"}
    # folder_id derived from the watchlist folder's member_codes (v3, ADR-0070):
    # both Codes are members of 반도체, so both land in f_0000000a.
    by_code = {e.code: e for e in doc.entries}
    assert by_code["005930"].folder_id == "f_0000000a"
    assert by_code["035720"].folder_id == "f_0000000a"
    # No capture fields carried.
    assert not hasattr(by_code["005930"], "last_success_date")


def test_seed_skips_when_heatmap_already_present(tmp_path: Path):
    from hoga.api.heatmap import load_heatmap, save_document, seed_from_watchlist_if_absent
    from hoga.api.models import HeatmapDocument
    _seed_watchlist(tmp_path)
    # Heatmap already exists (empty, user-cleared) → seed must NOT overwrite it.
    save_document(tmp_path, HeatmapDocument())
    seed_from_watchlist_if_absent(tmp_path)
    assert load_heatmap(tmp_path) == []


def test_seed_skips_when_watchlist_empty(tmp_path: Path):
    """Empty watchlist → do NOT create heatmap.json (avoid permanent-empty
    footgun); retry next boot (grilling G6)."""
    from hoga.api.heatmap import seed_from_watchlist_if_absent
    seed_from_watchlist_if_absent(tmp_path)
    assert not (tmp_path / "heatmap.json").exists()


def test_seed_does_not_mutate_watchlist(tmp_path: Path):
    from hoga.api.heatmap import seed_from_watchlist_if_absent
    _seed_watchlist(tmp_path)
    before = (tmp_path / "watchlist.json").read_text()
    seed_from_watchlist_if_absent(tmp_path)
    assert (tmp_path / "watchlist.json").read_text() == before


# --- capture markers (ADR-0142) ---------------------------------------------

def _write_v4(tmp_path: Path, *, entries: list[dict], markers: dict | None = None) -> None:
    import json
    (tmp_path / "heatmap.json").write_text(json.dumps({
        "schema_version": 4,
        "folders": [{"id": "f_0000000a", "name": "반도체", "order": 0},
                    {"id": "f_0000000b", "name": "AI", "order": 1}],
        "entries": entries,
        "capture_markers": markers or {},
    }, ensure_ascii=False), encoding="utf-8")


def test_v3_file_migrates_to_v4_with_empty_markers(tmp_path: Path):
    """v3→v4 는 순수 필드 추가 — 디스크를 훑어 마커를 시드하지 않는다.

    시드했다면 load 마다 271회 stat 이 붙는다. 마커 부재는 이미 '수집 이력 없음'
    이라는 옳은 의미라 backfill 이 필요 없다.
    """
    from hoga.api.heatmap import load_document
    _write_v2(tmp_path,
              folders=[{"id": "f_0000000a", "name": "반도체", "order": 0}],
              entries=[{"code": "005930", "name": "삼성전자",
                        "folder_id": "f_0000000a", "order": 0}])
    doc = load_document(tmp_path)
    assert doc.schema_version == 4
    assert doc.capture_markers == {}


def test_malformed_markers_are_dropped_not_quarantined(tmp_path: Path):
    """마커 한 줄이 깨져도 그룹·종목은 살아남는다 (ADR-0065 우선순위).

    마커는 디스크에서 재계산 가능하고 그룹 구성은 아니다 — 복구 가능한 것을 지키려고
    복구 불가능한 것을 corrupt 백업으로 보내면 정확히 거꾸로다.
    """
    from hoga.api.heatmap import load_document
    _write_v4(tmp_path,
              entries=[{"code": "005930", "name": "삼성전자",
                        "folder_id": "f_0000000a", "order": 0}],
              markers={"005930": "20260806", "BAD!!": "20260806",
                       "000660": "not-a-date", "035720": 20260806})
    doc = load_document(tmp_path)
    assert doc.capture_markers == {"005930": "20260806"}   # 나쁜 3줄만 탈락
    assert [e.code for e in doc.entries] == ["005930"]     # 종목은 무사
    assert len(doc.folders) == 2                           # 그룹도 무사


@pytest.mark.asyncio
async def test_marker_is_shared_across_groups_not_forked(tmp_path: Path):
    """한 종목이 두 그룹에 등록돼도 마커는 하나다 — 이 설계의 존재 이유.

    entry 에 마커를 얹었다면 이 시나리오에서 값이 2벌로 갈라졌을 것이고, 두 값이
    가리키는 실제 캡처는 (code,date) 하나뿐이라 어느 쪽이 진실인지 말할 수 없다.
    """
    from hoga.api import heatmap
    _write_v4(tmp_path, entries=[
        {"code": "005930", "name": "삼성전자", "folder_id": "f_0000000a", "order": 0},
        {"code": "005930", "name": "삼성전자", "folder_id": "f_0000000b", "order": 0},
    ])
    await heatmap.bump_last_success(tmp_path, code="005930", date="20260806")
    assert heatmap.load_capture_markers(tmp_path) == {"005930": "20260806"}

    # 한 그룹에서만 빼면 다른 등록이 남아 있으므로 마커도 남는다.
    await heatmap.remove_entry(tmp_path, code="005930", folder_id="f_0000000a")
    assert heatmap.load_capture_markers(tmp_path) == {"005930": "20260806"}
    # 마지막 등록까지 빠지면 save 경로가 고아 마커를 걷어낸다.
    await heatmap.remove_entry(tmp_path, code="005930", folder_id="f_0000000b")
    assert heatmap.load_capture_markers(tmp_path) == {}


@pytest.mark.asyncio
async def test_delete_folder_prunes_markers_of_orphaned_codes(tmp_path: Path):
    """그룹 삭제도 마커를 정리한다 — remove 계열마다 정리 코드를 두지 않고
    save_document 한 곳에 맡긴 덕분에 자동으로 따라온다."""
    from hoga.api import heatmap
    _write_v4(tmp_path, entries=[
        {"code": "005930", "name": "삼성전자", "folder_id": "f_0000000a", "order": 0},
        {"code": "000660", "name": "SK하이닉스", "folder_id": "f_0000000b", "order": 0},
    ], markers={"005930": "20260806", "000660": "20260806"})
    await heatmap.delete_folder(tmp_path, folder_id="f_0000000a")
    assert heatmap.load_capture_markers(tmp_path) == {"000660": "20260806"}


@pytest.mark.asyncio
async def test_add_seeds_marker_from_disk_for_a_new_code(tmp_path: Path):
    """이미 캡처가 있는 종목을 새로 넣으면 '미수집'으로 보이지 않는다."""
    from hoga.api import heatmap
    _write_v4(tmp_path, entries=[])
    with patch("hoga.api.disk_state.latest_complete_date", return_value="20260805"):
        await heatmap.add_entry_to_folder(
            tmp_path, code="005930", name="삼성전자", folder_id="f_0000000a")
    assert heatmap.load_capture_markers(tmp_path) == {"005930": "20260805"}


def test_get_heatmap_serves_markers(tmp_path: Path):
    _write_v4(tmp_path,
              entries=[{"code": "005930", "name": "삼성전자",
                        "folder_id": "f_0000000a", "order": 0}],
              markers={"005930": "20260806"})
    body = TestClient(_app(tmp_path)).get("/api/heatmap").json()
    assert body["capture_markers"] == {"005930": "20260806"}
