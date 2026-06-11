"""Heatmap independent-store + route tests (ADR-0068).

Mirrors the watchlist suite but asserts the SEPARATION invariants:
  - the heatmap store/routes never touch watchlist.json;
  - HeatmapEntry carries no capture fields;
  - heatmap routes never call refresh_live_stream;
  - the one-time seed copies the watchlist (capture-stripped) only when
    heatmap.json is absent AND the watchlist is non-empty, and never writes
    the watchlist.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


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


# --- separation invariants --------------------------------------------------

def test_heatmap_routes_never_refresh_live_stream():
    """The heatmap is a read-only quote consumer — its routes must NOT drive
    the KIS WS subscription (ADR-0068 rule 2). Structural guard: the helper is
    never imported into the routes module (so it can't be called), while the
    watchlist routes DO import it (proving the guard is meaningful, not vacuous)."""
    import hoga.api.heatmap_routes as m
    import hoga.api.watchlist_routes as wm
    assert not hasattr(m, "refresh_live_stream")
    assert hasattr(wm, "refresh_live_stream")


def test_post_heatmap_does_not_touch_watchlist(tmp_path: Path):
    from unittest.mock import patch
    with patch("hoga.api.heatmap_routes.symbols.search", return_value=[_fake_hit()]):
        TestClient(_app(tmp_path)).post("/api/heatmap", json={"code": "003490"})
    # Adding to the heatmap writes heatmap.json only — watchlist.json untouched.
    assert (tmp_path / "heatmap.json").exists()
    assert not (tmp_path / "watchlist.json").exists()


# --- one-time seed ----------------------------------------------------------

def _seed_watchlist(tmp_path: Path) -> None:
    """Write a watchlist.json directly (folder + foldered entry + 미분류 entry)."""
    from hoga.api import watchlist
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="반도체", order=0)],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자",
                           registered_at_kst_date="20260601",
                           last_success_date="20260610", folder_id="f_0000000a", order=0),
            WatchlistEntry(code="035720", name="카카오",
                           registered_at_kst_date="20260601",
                           last_success_date=None, folder_id=None, order=0),
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
    # folder_id copied verbatim (grilling G5); 미분류 entry preserved as null.
    by_code = {e.code: e for e in doc.entries}
    assert by_code["005930"].folder_id == "f_0000000a"
    assert by_code["035720"].folder_id is None
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
