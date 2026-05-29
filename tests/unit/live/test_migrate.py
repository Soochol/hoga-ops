from pathlib import Path
import json
from hoga.live.migrate import migrate_to_v2_layout, LayoutVersion


def test_migrate_moves_flat_files_into_hogaplay_subdir(tmp_path: Path) -> None:
    parquet_root = tmp_path / "parquet"
    sd_dir = parquet_root / "20260520" / "005930"
    sd_dir.mkdir(parents=True)
    for name in ("snapshots.parquet", "trades.parquet", "brokers.parquet", "candles.parquet"):
        (sd_dir / name).write_bytes(b"placeholder")
    (sd_dir / "meta.json").write_text(json.dumps({"code": "005930"}))

    migrate_to_v2_layout(tmp_path)

    target = sd_dir / "hogaplay"
    assert target.is_dir()
    for name in ("snapshots.parquet", "trades.parquet", "brokers.parquet", "candles.parquet", "meta.json"):
        assert (target / name).exists(), f"{name} not moved"
        assert not (sd_dir / name).exists(), f"{name} still at flat layout"

    sentinel = tmp_path / ".layout_v2"
    assert sentinel.exists()
    assert LayoutVersion.detect(tmp_path) == LayoutVersion.V2


def test_migrate_idempotent(tmp_path: Path) -> None:
    (tmp_path / ".layout_v2").touch()
    parquet_root = tmp_path / "parquet"
    sd_dir = parquet_root / "20260520" / "005930"
    sd_dir.mkdir(parents=True)
    (sd_dir / "snapshots.parquet").write_bytes(b"untouched")

    migrate_to_v2_layout(tmp_path)

    # sentinel already set → migration must NOT touch flat files
    assert (sd_dir / "snapshots.parquet").exists()
    assert not (sd_dir / "hogaplay").exists()


def test_migrate_preserves_existing_hogaplay_subdir(tmp_path: Path) -> None:
    parquet_root = tmp_path / "parquet"
    sd_dir = parquet_root / "20260520" / "005930"
    (sd_dir / "hogaplay").mkdir(parents=True)
    (sd_dir / "hogaplay" / "snapshots.parquet").write_bytes(b"pre-existing")
    (sd_dir / "snapshots.parquet").write_bytes(b"orphan-flat")

    migrate_to_v2_layout(tmp_path)

    assert (sd_dir / "hogaplay" / "snapshots.parquet").read_bytes() == b"pre-existing"
    # orphan-flat is left alone — the subdir already exists, so we don't auto-mix
    assert (sd_dir / "snapshots.parquet").exists()
