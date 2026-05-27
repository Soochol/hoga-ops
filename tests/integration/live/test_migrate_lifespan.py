import time
from pathlib import Path
from hoga.api.app import create_app


def test_lifespan_runs_migration_on_startup(tmp_path: Path) -> None:
    parquet_root = tmp_path / "parquet"
    sd_dir = parquet_root / "20260520" / "005930"
    sd_dir.mkdir(parents=True)
    (sd_dir / "snapshots.parquet").write_bytes(b"x")

    from fastapi.testclient import TestClient
    app = create_app(tmp_path)
    with TestClient(app):
        assert (tmp_path / ".layout_v2").exists()
        assert (sd_dir / "hogaplay" / "snapshots.parquet").exists()


def test_migrate_under_5s_for_10k_dirs(tmp_path: Path) -> None:
    """Migration must be fast (filesystem rename only, no data copy).

    Plan Pre-Stage E + Review Merge Addendum (Eng B5):
    we removed the 503 + Retry-After guard during startup migration, so
    the move must complete inside FastAPI startup grace period.
    """
    parquet_root = tmp_path / "parquet"
    # 10000 (date, code) dirs each with a few zero-byte parquet placeholders
    for i in range(10_000):
        date = f"2026{(i // 1000) % 12 + 1:02d}{(i % 28) + 1:02d}"
        code = f"{i:06d}"
        sd = parquet_root / date / code
        sd.mkdir(parents=True, exist_ok=True)
        (sd / "snapshots.parquet").touch()
        (sd / "meta.json").touch()

    from hoga.live.migrate import migrate_to_v2_layout
    start = time.perf_counter()
    migrate_to_v2_layout(tmp_path)
    elapsed = time.perf_counter() - start

    assert elapsed < 5.0, f"migration took {elapsed:.2f}s — exceeds 5s budget"
    # spot-check a few
    sample = parquet_root / "20260101" / "000000" / "hogaplay" / "snapshots.parquet"
    assert sample.exists()
