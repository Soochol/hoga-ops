"""Test atomic_write_parquet helper."""
from pathlib import Path

import polars as pl
import pytest

from hoga.api._atomic_write import atomic_write_parquet


def test_atomic_write_parquet_creates_file(tmp_path: Path) -> None:
    path = tmp_path / "snapshots.parquet"
    records = [{"t_ms": 1779800000000, "price": 27000}]
    atomic_write_parquet(path, records)
    assert path.exists()
    df = pl.read_parquet(path)
    assert df.shape == (1, 2)
    assert df["price"][0] == 27000


def test_atomic_write_parquet_overwrites_existing(tmp_path: Path) -> None:
    path = tmp_path / "snapshots.parquet"
    atomic_write_parquet(path, [{"t_ms": 1, "x": 10}])
    atomic_write_parquet(path, [{"t_ms": 2, "x": 20}, {"t_ms": 3, "x": 30}])
    df = pl.read_parquet(path)
    assert df.shape == (2, 2)
    assert df["x"].to_list() == [20, 30]


def test_atomic_write_parquet_creates_parent_dirs(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "dir" / "out.parquet"
    atomic_write_parquet(path, [{"t_ms": 1, "x": 1}])
    assert path.exists()


def test_atomic_write_parquet_empty_records_unlinks(tmp_path: Path) -> None:
    """빈 records → 기존 파일 unlink (downstream DuckDB가 빈 parquet 처리 까다로움)."""
    path = tmp_path / "out.parquet"
    atomic_write_parquet(path, [{"t_ms": 1, "x": 1}])
    assert path.exists()
    atomic_write_parquet(path, [])
    assert not path.exists()


def test_atomic_write_parquet_no_partial_file_on_error(tmp_path: Path, monkeypatch) -> None:
    """write_parquet이 raise하면 target 파일은 그대로 (tempfile만 남아도 OK)."""
    path = tmp_path / "out.parquet"
    atomic_write_parquet(path, [{"t_ms": 1, "x": 1}])
    original_size = path.stat().st_size

    def boom(*args, **kwargs):
        raise OSError("disk full simulation")

    monkeypatch.setattr(pl.DataFrame, "write_parquet", boom)
    with pytest.raises(OSError):
        atomic_write_parquet(path, [{"t_ms": 2, "x": 2}])
    # 기존 파일 보존
    assert path.exists()
    assert path.stat().st_size == original_size
