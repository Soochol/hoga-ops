"""Watchlist persistence + mutation tests. See spec 2026-05-26."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest


def test_load_returns_empty_when_file_missing(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist
    wl = load_watchlist(tmp_path)
    assert wl.entries == []


def test_save_then_load_round_trip(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist, save_watchlist
    from hoga.api.models import WatchlistEntry
    entry = WatchlistEntry(
        code="003490",
        name="대한항공",
        registered_at_kst_date="20260526",
        last_success_date=None,
    )
    save_watchlist(tmp_path, entries=[entry])
    wl = load_watchlist(tmp_path)
    assert len(wl.entries) == 1
    assert wl.entries[0].code == "003490"
    assert wl.entries[0].name == "대한항공"


def test_corrupted_json_is_backed_up_and_returns_empty(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist
    (tmp_path / "watchlist.json").write_text("not valid json at all")
    wl = load_watchlist(tmp_path)
    assert wl.entries == []
    # Original is moved aside.
    assert not (tmp_path / "watchlist.json").exists()
    backups = list(tmp_path.glob("watchlist.json.corrupt-*"))
    assert len(backups) == 1


def test_corrupted_pydantic_validation_is_also_backed_up(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [{"code": "BAD", "name": "x",
                     "registered_at_kst_date": "20260526",
                     "last_success_date": None}],
    }))
    wl = load_watchlist(tmp_path)
    assert wl.entries == []
    assert list(tmp_path.glob("watchlist.json.corrupt-*"))


@pytest.mark.asyncio
async def test_add_entry_inserts(tmp_path: Path):
    from hoga.api.watchlist import add_entry, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    wl = load_watchlist(tmp_path)
    assert [e.code for e in wl.entries] == ["003490"]
    assert wl.entries[0].registered_at_kst_date == "20260526"
    assert wl.entries[0].last_success_date is None


@pytest.mark.asyncio
async def test_add_entry_duplicate_raises(tmp_path: Path):
    from hoga.api.watchlist import add_entry, AlreadyInWatchlistError
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    with pytest.raises(AlreadyInWatchlistError):
        await add_entry(tmp_path, code="003490", name="대한항공",
                        today_kst_date="20260527")


@pytest.mark.asyncio
async def test_remove_entry(tmp_path: Path):
    from hoga.api.watchlist import add_entry, remove_entry, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await remove_entry(tmp_path, code="003490")
    assert load_watchlist(tmp_path).entries == []


@pytest.mark.asyncio
async def test_remove_entry_missing_raises(tmp_path: Path):
    from hoga.api.watchlist import remove_entry, NotInWatchlistError
    with pytest.raises(NotInWatchlistError):
        await remove_entry(tmp_path, code="003490")


@pytest.mark.asyncio
async def test_bump_last_success_advances_marker(tmp_path: Path):
    from hoga.api.watchlist import add_entry, bump_last_success, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await bump_last_success(tmp_path, code="003490", date="20260527")
    assert load_watchlist(tmp_path).entries[0].last_success_date == "20260527"


@pytest.mark.asyncio
async def test_bump_last_success_does_not_regress(tmp_path: Path):
    from hoga.api.watchlist import add_entry, bump_last_success, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await bump_last_success(tmp_path, code="003490", date="20260528")
    await bump_last_success(tmp_path, code="003490", date="20260527")  # older
    assert load_watchlist(tmp_path).entries[0].last_success_date == "20260528"


@pytest.mark.asyncio
async def test_bump_last_success_ignores_unwatched_code(tmp_path: Path):
    """Ad-hoc captures of non-watched Codes must not create entries."""
    from hoga.api.watchlist import bump_last_success, load_watchlist
    await bump_last_success(tmp_path, code="005930", date="20260527")
    assert load_watchlist(tmp_path).entries == []


@pytest.mark.asyncio
async def test_concurrent_bumps_serialize(tmp_path: Path):
    """Two simultaneous bumps must not clobber each other."""
    import asyncio
    from hoga.api.watchlist import add_entry, bump_last_success, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await add_entry(tmp_path, code="005930", name="삼성전자",
                    today_kst_date="20260526")
    await asyncio.gather(
        bump_last_success(tmp_path, code="003490", date="20260527"),
        bump_last_success(tmp_path, code="005930", date="20260527"),
    )
    wl = load_watchlist(tmp_path)
    by_code = {e.code: e.last_success_date for e in wl.entries}
    assert by_code == {"003490": "20260527", "005930": "20260527"}
