"""Cross-process screener commit lock and recoverable historical publication."""
import fcntl
import json
import os
import shutil
from contextlib import contextmanager
from pathlib import Path

from hoga.util.atomic_write import atomic_write_json

_FILES = ("daily_unadjusted.parquet", "factors.parquet", "daily_adjusted.parquet")


def _recover(sdir: Path):
    marker = sdir / "history_publish.json"
    if not marker.exists():
        return
    for name in json.loads(marker.read_text())["files"]:
        if name not in _FILES:
            raise ValueError("Invalid historical publication file")
        staged = sdir / (name + ".history-pending")
        if staged.exists():
            os.replace(staged, sdir / name)
    marker.unlink()


def publish_history(sdir: Path, staging: Path):
    """Caller holds writer lock. Prepare every file before recording publication intent."""
    names = [name for name in _FILES if (staging / name).exists()]
    for name in names:
        shutil.copyfile(staging / name, sdir / (name + ".history-pending"))
    atomic_write_json(sdir / "history_publish.json", {"files": names})
    _recover(sdir)


@contextmanager
def screener_write_lock(sdir: Path):
    sdir.mkdir(parents=True, exist_ok=True)
    with (sdir / ".writer.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            _recover(sdir)
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


@contextmanager
def screener_read_lock(sdir: Path):
    """Read one published corpus; recover an interrupted publication before reading.

    Use only from synchronous worker code. Do not nest inside the writer lock.
    """
    sdir.mkdir(parents=True, exist_ok=True)
    with (sdir / ".writer.lock").open("a") as handle:
        while True:
            fcntl.flock(handle, fcntl.LOCK_SH)
            if not (sdir / "history_publish.json").exists():
                break
            fcntl.flock(handle, fcntl.LOCK_UN)
            # Never upgrade a shared lock in place: concurrent recoverers could deadlock.
            with screener_write_lock(sdir):
                pass
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
