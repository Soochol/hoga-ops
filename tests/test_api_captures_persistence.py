"""Tests for captures_persistence module — save/load/quarantine the queue manifest."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.captures_persistence import (
    MANIFEST_FILENAME,
    load_manifest,
    manifest_path,
    save_manifest,
)
from hoga.api.models import QueueManifest, QueueManifestItem


def _make_item(item_id: str = "20260524T100000000-005930-20260520") -> QueueManifestItem:
    return QueueManifestItem(
        item_id=item_id,
        code="005930",
        date="20260520",
        force_retry=False,
        enqueued_at_ms=1700000000000,
        pause_origin=False,
    )


def test_manifest_path_returns_dotfile_in_data_dir(tmp_path: Path) -> None:
    assert manifest_path(tmp_path) == tmp_path / MANIFEST_FILENAME
    assert MANIFEST_FILENAME == ".queue.json"


def test_save_then_load_roundtrip(tmp_path: Path) -> None:
    manifest = QueueManifest(paused=False, items=[_make_item(), _make_item("id2")])
    save_manifest(tmp_path, manifest)
    back = load_manifest(tmp_path)
    assert back == manifest


def test_save_writes_atomically_no_tmp_left(tmp_path: Path) -> None:
    save_manifest(tmp_path, QueueManifest(paused=False, items=[_make_item()]))
    leftovers = [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_save_preserves_paused_flag(tmp_path: Path) -> None:
    save_manifest(tmp_path, QueueManifest(paused=True, items=[]))
    back = load_manifest(tmp_path)
    assert back is not None and back.paused is True


def test_load_returns_none_when_file_missing(tmp_path: Path) -> None:
    assert load_manifest(tmp_path) is None


def test_load_quarantines_invalid_json(tmp_path: Path) -> None:
    (tmp_path / ".queue.json").write_text("not json", encoding="utf-8")
    assert load_manifest(tmp_path) is None
    # Original file is gone, quarantine file exists
    assert not (tmp_path / ".queue.json").exists()
    quarantined = list(tmp_path.glob(".queue.json.corrupt-*"))
    assert len(quarantined) == 1
    assert "parse_error" in quarantined[0].name


def test_load_quarantines_schema_mismatch(tmp_path: Path) -> None:
    (tmp_path / ".queue.json").write_text(
        json.dumps({"schema_version": 99, "paused": False, "items": []}),
        encoding="utf-8",
    )
    assert load_manifest(tmp_path) is None
    quarantined = list(tmp_path.glob(".queue.json.corrupt-*"))
    assert len(quarantined) == 1
    assert "version_mismatch_99" in quarantined[0].name


def test_load_quarantines_missing_required_field(tmp_path: Path) -> None:
    """e.g. items field absent — pydantic validation fails."""
    (tmp_path / ".queue.json").write_text(
        json.dumps({"schema_version": 1, "paused": False}),
        encoding="utf-8",
    )
    assert load_manifest(tmp_path) is None
    quarantined = list(tmp_path.glob(".queue.json.corrupt-*"))
    assert len(quarantined) == 1


def test_save_swallows_oserror_via_unwritable_parent(tmp_path: Path, caplog) -> None:
    """save_manifest must NOT propagate OSError — in-memory state is the
    runtime source of truth; disk failure is best-effort only."""
    bad_dir = tmp_path / "readonly"
    bad_dir.mkdir()
    bad_dir.chmod(0o500)  # read+execute, no write
    try:
        # Should not raise. Should log a warning.
        with caplog.at_level("WARNING", logger="hoga.api.captures_persistence"):
            save_manifest(bad_dir, QueueManifest(paused=False, items=[_make_item()]))
        assert any("manifest write failed" in r.message for r in caplog.records)
    finally:
        bad_dir.chmod(0o700)  # restore for cleanup


# ADR-0042: fail_streaks dict on the manifest.

def test_load_manifest_without_fail_streaks_defaults_to_empty(tmp_path: Path) -> None:
    """Old .queue.json files (pre-ADR-0042) lack the fail_streaks key.
    Loader must treat the missing key as an empty dict — no migration."""
    manifest_path(tmp_path).write_text(
        '{"schema_version": 1, "paused": false, "items": []}',
        encoding="utf-8",
    )
    loaded = load_manifest(tmp_path)
    assert loaded is not None
    assert loaded.fail_streaks == {}


def test_save_load_manifest_roundtrip_preserves_fail_streaks(tmp_path: Path) -> None:
    saved = QueueManifest(
        paused=False,
        items=[],
        fail_streaks={"005930|20260520": 3, "003490|20260319": 5},
    )
    save_manifest(tmp_path, saved)
    loaded = load_manifest(tmp_path)
    assert loaded is not None
    assert loaded.fail_streaks == {"005930|20260520": 3, "003490|20260319": 5}
