"""Pin _fetch_first_body + _store_page_body behavior across the refactor.

Goal: a single fetch+store round produces identical disk artifacts and return
values before vs. after the split. We don't care which symbols exist — just
that calling the public surface twice with identical inputs produces identical
side effects.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock


def _make_body() -> str:
    # TSV row schema: at least 5 tab-separated fields so _seqs / _max_event_time
    # both find values. Field 3 (0-indexed) is the global_seq; field 4 is
    # event_time. Match _IDX_GLOBAL_SEQ=3, _IDX_EVENT_TIME=4 in orchestrator.
    return "a\tb\tc\t1000\t84000000\textra\n" "a\tb\tc\t1001\t84000100\textra\n"


def test_fetch_first_body_returns_client_body_unchanged():
    from hoga.collector.orchestrator import _fetch_first_body

    fake_client = MagicMock()
    fake_client.fetch_first.return_value = _make_body()

    body = _fetch_first_body(fake_client, code="005930", date="20250520", time_ms=0)
    assert body == _make_body()
    fake_client.fetch_first.assert_called_once_with("005930", "20250520", 0)


def test_store_page_body_writes_tsv_and_returns_new_seqs(tmp_path: Path):
    from hoga.collector.orchestrator import _store_page_body

    body = _make_body()
    seen: set[int] = set()

    new_page_idx, new_seqs = _store_page_body(
        tmp_path, body, page_idx=0, seen_seqs=seen
    )

    assert new_page_idx == 1
    assert new_seqs == {1000, 1001}
    # File written with zero-padded 5-digit index (page_idx after increment).
    written = tmp_path / "first_00001.tsv"
    assert written.exists()
    assert written.read_text(encoding="utf-8") == body
    # seen_seqs mutated in place — matches existing _fetch_and_store_page contract.
    assert seen == {1000, 1001}


def test_store_page_body_empty_body_does_not_write(tmp_path: Path):
    """Empty body must not advance page_idx or write a file — matches the
    `if body:` guard in the original _fetch_and_store_page."""
    from hoga.collector.orchestrator import _store_page_body

    seen: set[int] = set()
    new_page_idx, new_seqs = _store_page_body(
        tmp_path, "", page_idx=7, seen_seqs=seen
    )

    assert new_page_idx == 7
    assert new_seqs == set()
    assert list(tmp_path.glob("first_*.tsv")) == []
    assert seen == set()


def test_fetch_and_store_page_composite_unchanged(tmp_path: Path):
    """Composite still returns (body, page_idx, new_seqs) and is the public
    surface that _page_step_loop calls. This pins the external contract so
    Task 8 can safely wrap timing phases around the two helpers."""
    from hoga.collector.orchestrator import _fetch_and_store_page

    fake_client = MagicMock()
    fake_client.fetch_first.return_value = _make_body()

    seen: set[int] = {1000}  # 1000 already seen; only 1001 should be "new"
    body, page_idx, new_seqs = _fetch_and_store_page(
        tmp_path, fake_client, "005930", "20250520", 0, 0, seen
    )

    assert body == _make_body()
    assert page_idx == 1
    assert new_seqs == {1001}
    assert (tmp_path / "first_00001.tsv").read_text(encoding="utf-8") == body
    assert seen == {1000, 1001}
