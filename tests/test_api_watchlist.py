"""Watchlist persistence + mutation tests. See spec 2026-05-26."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest


def test_load_returns_empty_when_file_missing(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist
    wl = load_watchlist(tmp_path)
    assert wl == []


def test_save_then_load_round_trip(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist, save_document
    from hoga.api.models import WatchlistDocument, WatchlistEntry
    entry = WatchlistEntry(
        code="003490",
        name="대한항공",
        registered_at_kst_date="20260526",
        last_success_date=None,
    )
    save_document(tmp_path, WatchlistDocument(entries=[entry]))
    wl = load_watchlist(tmp_path)
    assert len(wl) == 1
    assert wl[0].code == "003490"
    assert wl[0].name == "대한항공"


def test_corrupted_json_is_backed_up_and_returns_empty(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist
    (tmp_path / "watchlist.json").write_text("not valid json at all")
    wl = load_watchlist(tmp_path)
    assert wl == []
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
    assert wl == []
    assert list(tmp_path.glob("watchlist.json.corrupt-*"))


@pytest.mark.asyncio
async def test_add_entry_inserts(tmp_path: Path):
    from hoga.api.watchlist import add_entry, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    wl = load_watchlist(tmp_path)
    assert [e.code for e in wl] == ["003490"]
    assert wl[0].registered_at_kst_date == "20260526"
    assert wl[0].last_success_date is None


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
    assert load_watchlist(tmp_path) == []


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
    assert load_watchlist(tmp_path)[0].last_success_date == "20260527"


@pytest.mark.asyncio
async def test_bump_last_success_does_not_regress(tmp_path: Path):
    from hoga.api.watchlist import add_entry, bump_last_success, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await bump_last_success(tmp_path, code="003490", date="20260528")
    await bump_last_success(tmp_path, code="003490", date="20260527")  # older
    assert load_watchlist(tmp_path)[0].last_success_date == "20260528"


@pytest.mark.asyncio
async def test_bump_last_success_ignores_unwatched_code(tmp_path: Path):
    """Ad-hoc captures of non-watched Codes must not create entries."""
    from hoga.api.watchlist import bump_last_success, load_watchlist
    await bump_last_success(tmp_path, code="005930", date="20260527")
    assert load_watchlist(tmp_path) == []


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
    by_code = {e.code: e.last_success_date for e in wl}
    assert by_code == {"003490": "20260527", "005930": "20260527"}


@pytest.mark.asyncio
async def test_add_entry_seeds_last_success_from_disk(tmp_path: Path, monkeypatch):
    """When the Code already has complete captures on disk, add_entry
    initializes last_success_date with the latest of them. Fixes the
    "마지막 성공: 아직 없음" UX for Codes registered after data already
    landed (e.g., 098460 with 30+ trading days on disk)."""
    from hoga.api import disk_state, watchlist
    monkeypatch.setattr(
        disk_state, "latest_complete_date",
        lambda _dir, code: "20260524" if code == "003490" else None,
    )
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date == "20260524"


@pytest.mark.asyncio
async def test_add_entry_no_disk_data_leaves_marker_null(tmp_path: Path, monkeypatch):
    """No prior captures → marker stays null, preserves "first capture"
    catch-up behavior driven by registered_at_kst_date."""
    from hoga.api import disk_state, watchlist
    monkeypatch.setattr(
        disk_state, "latest_complete_date", lambda _dir, _code: None,
    )
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date is None


# --- Coverage gaps from /review audit (2026-05-27) -------------------------


def test_load_watchlist_propagates_oserror_not_corruption(tmp_path: Path, monkeypatch):
    """A transient read failure (EIO, permission flip) must NOT be treated
    as 'corruption' — auto-renaming the file on a read error silently
    wipes user data. Only JSONDecodeError and ValidationError trigger the
    backup-and-empty path."""
    from hoga.api.watchlist import load_watchlist
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1, "entries": [],
    }))
    original_read_text = Path.read_text

    def fail_read(self, *args, **kwargs):
        if self.name == "watchlist.json":
            raise OSError("simulated EIO")
        return original_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fail_read)
    with pytest.raises(OSError, match="simulated EIO"):
        load_watchlist(tmp_path)
    # The file must NOT have been renamed to .corrupt-*.
    assert (tmp_path / "watchlist.json").exists()
    assert not list(tmp_path.glob("watchlist.json.corrupt-*"))


@pytest.mark.asyncio
async def test_lock_prevents_lost_update_on_same_code(tmp_path: Path, monkeypatch):
    """The existing test_concurrent_bumps_serialize exercises bumps on
    DIFFERENT codes (mutating distinct list elements, which would succeed
    even without the lock). This pins the real race: two bumps targeting
    the SAME code with different dates — without the lock, one would
    clobber the other's read-modify-write."""
    from hoga.api import watchlist
    import asyncio as _asyncio
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    # Drive the two bumps concurrently. The lock must serialize them so
    # the newer date wins regardless of scheduling order.
    await _asyncio.gather(
        watchlist.bump_last_success(tmp_path, code="003490", date="20260527"),
        watchlist.bump_last_success(tmp_path, code="003490", date="20260526"),
    )
    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date == "20260527"


@pytest.mark.asyncio
async def test_bump_last_success_same_date_is_noop_no_write(tmp_path: Path, monkeypatch):
    """`date == last_success_date` boundary: the comparison is strict `>`,
    so equal dates must produce no save_watchlist call (avoid needless
    atomic-write churn under steady-state catch-up loops)."""
    from hoga.api import watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260527")

    save_calls = 0

    def spy_save(*args, **kwargs):
        nonlocal save_calls
        save_calls += 1
    monkeypatch.setattr(watchlist, "save_document", spy_save)

    await watchlist.bump_last_success(tmp_path, code="003490", date="20260527")
    assert save_calls == 0
