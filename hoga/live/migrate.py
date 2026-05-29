"""One-shot layout migration: parquet/{date}/{code}/*.parquet → parquet/{date}/{code}/hogaplay/*.parquet.

See ADR-0037. Sentinel: <data_dir>/.layout_v2 marks completion.
"""
from __future__ import annotations
from enum import Enum
from pathlib import Path
import shutil

SENTINEL_NAME = ".layout_v2"
_MOVED_FILE_NAMES = (
    "snapshots.parquet", "trades.parquet", "brokers.parquet", "candles.parquet",
    "meta.json", "_progress.json", ".no_upstream_data",
)


class LayoutVersion(Enum):
    V1_FLAT = "v1"
    V2 = "v2"

    @classmethod
    def detect(cls, data_dir: Path) -> "LayoutVersion":
        return cls.V2 if (data_dir / SENTINEL_NAME).exists() else cls.V1_FLAT


def migrate_to_v2_layout(data_dir: Path) -> None:
    if LayoutVersion.detect(data_dir) is LayoutVersion.V2:
        return
    parquet_root = data_dir / "parquet"
    if parquet_root.is_dir():
        for date_dir in parquet_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                if not code_dir.is_dir() or (code_dir / "hogaplay").exists():
                    continue
                target = code_dir / "hogaplay"
                target.mkdir()
                for name in _MOVED_FILE_NAMES:
                    src = code_dir / name
                    if src.exists():
                        shutil.move(str(src), str(target / name))
    (data_dir / SENTINEL_NAME).touch()
