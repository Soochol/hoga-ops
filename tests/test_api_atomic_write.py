"""Tests for the shared atomic JSON write helper extracted per ADR-0015 + ADR-0019."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api._atomic_write import atomic_write_json


def test_writes_json_to_path(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    atomic_write_json(target, {"hello": "world"})
    assert json.loads(target.read_text(encoding="utf-8")) == {"hello": "world"}


def test_creates_parent_dir(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "deep" / "out.json"
    atomic_write_json(target, [1, 2, 3])
    assert target.exists()
    assert json.loads(target.read_text(encoding="utf-8")) == [1, 2, 3]


def test_overwrites_existing_atomically(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    target.write_text('{"old": true}', encoding="utf-8")
    atomic_write_json(target, {"new": True})
    assert json.loads(target.read_text(encoding="utf-8")) == {"new": True}


def test_no_tmp_files_left_on_success(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    atomic_write_json(target, {"a": 1})
    leftovers = [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_korean_utf8_preserved(tmp_path: Path) -> None:
    """Ensure ensure_ascii=False behavior carries over (symbols.py relies on it)."""
    target = tmp_path / "out.json"
    atomic_write_json(target, {"name": "삼성전자"})
    raw = target.read_text(encoding="utf-8")
    assert "삼성전자" in raw  # not escaped as \uXXXX
