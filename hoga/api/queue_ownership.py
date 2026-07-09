"""Single-owner guard for the capture queue (ADR-0094).

Two backend instances sharing one ``data_dir`` (e.g. the main checkout on
:8000 and a worktree dogfood backend on :8011/:8012) both restore the same
``.queue.json`` at boot and both spawn worker pools. They then race on the
same Stock-Date: two orchestrators write ``_progress.json`` and ``raw/*.tsv``
for the same (code, date), stomping each other's cursor (observed: ``started_at``
oscillating, ``pages_done`` going backwards). The captured data survives via
global_seq dedupe, but the progress state is corrupted and the upstream is hit
twice.

This module makes queue ownership exclusive via an advisory ``flock(2)`` on
``<data_dir>/.queue.lock``. Only the holder restores the manifest, spawns
workers, and persists mutations. A non-owner still serves all read paths
(charts, inventory, GET /queue) — it just can't mutate the queue.

Why flock and not a pid file: ``flock`` is released automatically by the
kernel when the holding process exits or crashes, so there is no stale-lock
cleanup to get wrong. The lock is tied to the open file descriptor, which we
keep open for the process lifetime (closing it releases the lock).

Locality note: ``data_dir`` is a local path (``~/.local/share/hoga-ops/data``).
``flock`` semantics are reliable on local filesystems; NFS is out of scope.
"""

from __future__ import annotations

import fcntl
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

_LOCK_FILENAME = ".queue.lock"
# --reload restarts overlap the old process's teardown with the new process's
# boot; retry briefly so the successor acquires the lock the predecessor is
# about to release rather than falsely reporting a live conflict.
_ACQUIRE_RETRIES = 4
_ACQUIRE_RETRY_DELAY_S = 0.5

logger = logging.getLogger(__name__)


def lock_path(data_dir: Path) -> Path:
    return data_dir / _LOCK_FILENAME


@dataclass
class QueueOwnership:
    """Handle for an acquired queue lock.

    Holds the open fd for the process lifetime — ``release()`` (or process
    exit) drops the lock. The lock file's *content* (pid/port) is purely
    diagnostic; the lock itself is the flock on the fd, not the bytes.
    """

    fd: int
    path: Path

    def release(self) -> None:
        """Release the lock and close the fd. Idempotent-safe: a second call
        after the fd is closed is swallowed."""
        try:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def _read_owner_hint(path: Path) -> str:
    """Best-effort read of the current holder's diagnostic line (pid/port).

    Returns a short descriptor for logging; never raises.
    """
    try:
        return path.read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


def try_acquire_queue_ownership(data_dir: Path) -> QueueOwnership | None:
    """Attempt to become the sole queue owner for ``data_dir``.

    Returns a :class:`QueueOwnership` on success, or ``None`` if another live
    process already holds the lock (after a short retry window to absorb
    ``--reload`` handoffs). On success, writes a diagnostic ``pid=… port=…``
    line into the lock file — this is informational only and does not affect
    the lock.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    path = lock_path(data_dir)
    # O_CREAT so a fresh data_dir works; we keep the fd open for the lifetime.
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    for attempt in range(_ACQUIRE_RETRIES):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if attempt < _ACQUIRE_RETRIES - 1:
                time.sleep(_ACQUIRE_RETRY_DELAY_S)
                continue
            holder = _read_owner_hint(path)
            logger.warning(
                "capture queue owned by another process (%s); this instance "
                "runs read-only for the queue (no worker pool, no mutations)",
                holder,
            )
            os.close(fd)
            return None
        else:
            _write_owner_hint(fd)
            return QueueOwnership(fd=fd, path=path)
    # Unreachable (loop either returns or continues), but keeps type-checkers happy.
    os.close(fd)
    return None


def _write_owner_hint(fd: int) -> None:
    """Stamp pid/port into the lock file for diagnostics. Never raises."""
    port = os.environ.get("HOGA_PORT") or os.environ.get("UVICORN_PORT") or "?"
    hint = f"pid={os.getpid()} port={port}"
    try:
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, hint.encode("utf-8"))
        os.fsync(fd)
    except OSError:
        pass
