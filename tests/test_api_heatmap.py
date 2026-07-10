"""Heatmap independent-store + route tests (ADR-0068, amended by ADR-0097).

Mirrors the watchlist suite but asserts the SEPARATION invariants:
  - the heatmap store/routes never touch watchlist.json;
  - HeatmapEntry carries no capture fields;
  - entry-SET mutations resync storage targets (ADR-0097) while folder-shape
    mutations (rename/reorder/move/delete-folder) do not;
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
    from hoga.api.models import HeatmapDocument, HeatmapEntry
    save_document(tmp_path, HeatmapDocument(entries=[HeatmapEntry(code="003490", name="대한항공")]))
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
    from hoga.api.heatmap import add_entry, remove_entry, load_heatmap
    from hoga.api.heatmap import AlreadyInHeatmapError, NotInHeatmapError
    await add_entry(tmp_path, code="003490", name="대한항공")
    assert [e.code for e in load_heatmap(tmp_path)] == ["003490"]
    with pytest.raises(AlreadyInHeatmapError):
        await add_entry(tmp_path, code="003490", name="대한항공")
    await remove_entry(tmp_path, code="003490")
    assert load_heatmap(tmp_path) == []
    with pytest.raises(NotInHeatmapError):
        await remove_entry(tmp_path, code="003490")


@pytest.mark.asyncio
async def test_folder_crud_and_reparent(tmp_path: Path):
    from hoga.api import heatmap
    f = await heatmap.create_folder(tmp_path, name="반도체")
    await heatmap.add_entry(tmp_path, code="005930", name="삼성전자")
    await heatmap.move_entries(tmp_path, codes=["005930"], folder_id=f.id)
    doc = heatmap.load_document(tmp_path)
    assert doc.entries[0].folder_id == f.id
    # delete folder → member reparented to 미분류 (null), folder gone.
    await heatmap.delete_folder(tmp_path, folder_id=f.id)
    doc = heatmap.load_document(tmp_path)
    assert doc.folders == []
    assert doc.entries[0].folder_id is None


@pytest.mark.asyncio
async def test_reorder_set_mismatch_raises(tmp_path: Path):
    from hoga.api import heatmap
    from hoga.api.heatmap import HeatmapSetMismatchError
    await heatmap.add_entry(tmp_path, code="005930", name="삼성전자")
    await heatmap.add_entry(tmp_path, code="000660", name="SK하이닉스")
    with pytest.raises(HeatmapSetMismatchError):
        await heatmap.reorder_entries(tmp_path, folder_id=None, ordered_codes=["005930"])


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


def test_get_empty_heatmap_has_no_next_run(tmp_path: Path):
    r = TestClient(_app(tmp_path)).get("/api/heatmap")
    assert r.status_code == 200
    body = r.json()
    assert body["entries"] == []
    assert body["folders"] == []
    # No scheduler → no next_run_at_ms (distinct from /api/watchlist).
    assert "next_run_at_ms" not in body


def test_heatmap_folder_wire_drops_member_codes(tmp_path: Path):
    client = TestClient(_app(tmp_path))
    r = client.post("/api/heatmap/folders", json={"name": "반도체"})
    assert r.status_code == 201
    assert "member_codes" not in r.json()

    body = client.get("/api/heatmap").json()
    assert "member_codes" not in body["folders"][0]


def test_post_unknown_code_404(tmp_path: Path):
    from unittest.mock import patch
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[]):
        r = TestClient(_app(tmp_path)).post("/api/heatmap", json={"code": "999999"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "unknown_code"


def test_post_adds_then_duplicate_409(tmp_path: Path):
    from unittest.mock import patch
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[_fake_hit()]):
        client = TestClient(_app(tmp_path))
        r1 = client.post("/api/heatmap", json={"code": "003490"})
        r2 = client.post("/api/heatmap", json={"code": "003490"})
    assert r1.status_code == 201
    assert r1.json()["code"] == "003490"
    # Capture fields are absent on the wire shape too.
    assert "last_success_date" not in r1.json()
    assert "registered_at_kst_date" not in r1.json()
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "already_in_heatmap"


def test_delete_absent_404(tmp_path: Path):
    r = TestClient(_app(tmp_path)).delete("/api/heatmap/003490")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_in_heatmap"


def test_folder_create_and_move_routes(tmp_path: Path):
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        client = TestClient(_app(tmp_path))
        fr = client.post("/api/heatmap/folders", json={"name": "반도체"})
        client.post("/api/heatmap", json={"code": "005930"})
    assert fr.status_code == 201
    fid = fr.json()["id"]
    mv = client.post("/api/heatmap/move", json={"codes": ["005930"], "folder_id": fid})
    assert mv.status_code == 204
    assert client.get("/api/heatmap").json()["entries"][0]["folder_id"] == fid


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


def test_folder_member_add_moves_existing_code_without_duplicate(tmp_path: Path):
    from unittest.mock import patch
    hit = [_fake_hit("005930", "삼성전자")]
    client = TestClient(_app(tmp_path))
    fid = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]

    with patch("hoga.api.heatmap_routes.symbols.search", return_value=hit):
        assert client.post("/api/heatmap", json={"code": "005930"}).status_code == 201
        r = client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "005930"})

    assert r.status_code == 201
    entries = client.get("/api/heatmap").json()["entries"]
    assert [(e["code"], e["folder_id"]) for e in entries] == [("005930", fid)]


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
    """ADR-0097: the four routes that change the entry SET resync storage
    targets so the REST 30s recorder follows heatmap membership."""
    client = TestClient(_app(tmp_path))
    with patch("hoga.api.heatmap_routes.symbols.search",
               return_value=[_fake_hit("005930", "삼성전자")]):
        client.post("/api/heatmap", json={"code": "005930"})
        assert stub_refresh_live_stream.await_count == 1

        fid = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
        assert stub_refresh_live_stream.await_count == 1  # folder create: no resync

        client.post(f"/api/heatmap/folders/{fid}/members", json={"code": "005930"})
        assert stub_refresh_live_stream.await_count == 2

    client.delete("/api/heatmap/005930")
    assert stub_refresh_live_stream.await_count == 3

    client.post("/api/heatmap/remove", json={"codes": ["005930"]})
    assert stub_refresh_live_stream.await_count == 4


def test_folder_shape_mutations_do_not_resync(tmp_path: Path, stub_refresh_live_stream):
    """Rename/reorder/move/delete-folder leave the entry SET intact — the
    storage-target resync hook must not fire (heatmap UI stays snappy)."""
    client = TestClient(_app(tmp_path))
    with patch("hoga.api.heatmap_routes.symbols.search",
               return_value=[_fake_hit("005930", "삼성전자")]):
        client.post("/api/heatmap", json={"code": "005930"})
    fid = client.post("/api/heatmap/folders", json={"name": "반도체"}).json()["id"]
    calls_after_setup = stub_refresh_live_stream.await_count

    client.patch(f"/api/heatmap/folders/{fid}", json={"name": "IT"})
    client.put("/api/heatmap/folders/order", json={"ordered_ids": [fid]})
    client.post("/api/heatmap/move", json={"codes": ["005930"], "folder_id": fid})
    client.put("/api/heatmap/reorder", json={"folder_id": fid, "ordered_codes": ["005930"]})
    client.delete(f"/api/heatmap/folders/{fid}")

    assert stub_refresh_live_stream.await_count == calls_after_setup


def test_add_succeeds_even_if_storage_resync_fails(tmp_path: Path, stub_refresh_live_stream):
    """The disk write already committed — a resync failure must not fail the
    route (best-effort hook, same contract as the watchlist routes)."""
    stub_refresh_live_stream.side_effect = RuntimeError("lifecycle down")
    client = TestClient(_app(tmp_path))
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[_fake_hit()]):
        r = client.post("/api/heatmap", json={"code": "003490"})
    assert r.status_code == 201
    assert client.delete("/api/heatmap/003490").status_code == 204


def test_post_heatmap_does_not_touch_watchlist(tmp_path: Path):
    from unittest.mock import patch
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[_fake_hit()]):
        TestClient(_app(tmp_path)).post("/api/heatmap", json={"code": "003490"})
    # Adding to the heatmap writes heatmap.json only — watchlist.json untouched.
    assert (tmp_path / "heatmap.json").exists()
    assert not (tmp_path / "watchlist.json").exists()


# --- one-time seed ----------------------------------------------------------

def _seed_watchlist(tmp_path: Path) -> None:
    """Write a watchlist.json directly (v3: folder owns member_codes)."""
    from hoga.api import watchlist
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="반도체", order=0,
                                 member_codes=["005930", "035720"])],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자",
                           registered_at_kst_date="20260601", last_success_date="20260610"),
            WatchlistEntry(code="035720", name="카카오",
                           registered_at_kst_date="20260601", last_success_date=None),
        ],
    )
    watchlist.save_document(tmp_path, doc)


def test_seed_copies_watchlist_stripping_capture_fields(tmp_path: Path):
    from hoga.api.heatmap import seed_from_watchlist_if_absent, load_document
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
    from hoga.api.heatmap import seed_from_watchlist_if_absent, save_document, load_heatmap
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
