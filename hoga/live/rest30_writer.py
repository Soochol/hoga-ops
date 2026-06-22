"""JSONL staging writer for persisted KIS REST 30-second capture."""
from __future__ import annotations

from pathlib import Path

from hoga.live.writer import LiveWriter


def rest30_live_root(data_dir: Path) -> Path:
    return data_dir / "live_api"


def make_rest30_writer(data_dir: Path) -> LiveWriter:
    return LiveWriter(rest30_live_root(data_dir))
