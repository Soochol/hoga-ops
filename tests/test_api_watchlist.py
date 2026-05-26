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
