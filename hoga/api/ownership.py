"""Single-owner guards for shared ``data_dir`` writers (ADR-0094).

``data_dir`` is machine-global by design (``resolve_data_dir()`` ignores cwd so
captures aren't re-fetched per worktree). The cost is that **two backend
instances share every writer**: the main checkout on :8000 and a worktree
backend that inherited the main ``.env`` both run the same background work
against the same files.

Two writers are guarded here, each with its own lock file:

``.queue.lock`` — **capture queue** (the original ADR-0094 case). Both
instances restored ``.queue.json`` and spawned worker pools, then raced on the
same Stock-Date: two orchestrators writing ``_progress.json`` and ``raw/*.tsv``
for one (code, date), stomping each other's cursor (observed 2026-07-09:
``started_at`` oscillating, ``pages_done`` going backwards).

``.collectors.lock`` — **market flow collectors** (investor-flow · deriv-flow,
added 2026-08-10). `scheduler.py` previously reasoned that these were safe to
duplicate because "REST 라 최악이 유량 합산" — measurement showed that
understated it. On 2026-08-10 a second backend on :8001 ran the same collectors
for 70 minutes (09:21:06–10:31:18) and the day's samples came out interleaved
at two phases (:53/:06, then :54/:30). Three consequences, none loud:

1. every sample written twice → coverage counts and gap analysis are wrong,
   and the stored cadence no longer reflects the configured poll interval;
2. vendor call volume doubled;
3. both processes hold vendor tokens — reissuing on one kills the other's
   (#1088), and a dead token passes the expiry check, so the victim goes
   silent rather than erroring.

The values themselves survive (they're cumulative snapshots, so a duplicate is
a duplicate, not a corruption) — which is exactly why nobody noticed.

Why flock and not a pid file: ``flock`` is released automatically by the
kernel when the holding process exits or crashes, so there is no stale-lock
cleanup to get wrong. The lock is tied to the open file descriptor, which we
keep open for the process lifetime (closing it releases the lock).

Locality note: ``data_dir`` is a local path (``~/.local/share/hoga-ops/data``).
``flock`` semantics are reliable on local filesystems; NFS is out of scope.

**This is a guard, not a fix for credential sharing.** The standing convention
is still an empty ``.env`` in worktrees (ADR-0134) — the lock only stops the
second process from *writing*, it does not stop it from holding a token.
"""

from __future__ import annotations

import fcntl
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

_LOCK_FILENAME = ".queue.lock"
_COLLECTORS_LOCK_FILENAME = ".collectors.lock"
# --reload restarts overlap the old process's teardown with the new process's
# boot; retry briefly so the successor acquires the lock the predecessor is
# about to release rather than falsely reporting a live conflict.
_ACQUIRE_RETRIES = 4
_ACQUIRE_RETRY_DELAY_S = 0.5

logger = logging.getLogger(__name__)


def lock_path(data_dir: Path) -> Path:
    return data_dir / _LOCK_FILENAME


def collectors_lock_path(data_dir: Path) -> Path:
    return data_dir / _COLLECTORS_LOCK_FILENAME


@dataclass
class DataDirLock:
    """Handle for an acquired ``data_dir`` lock.

    Holds the open fd for the process lifetime — ``release()`` (or process
    exit) drops the lock. The lock file's *content* (pid/port) is purely
    diagnostic; the lock itself is the flock on the fd, not the bytes.
    """

    fd: int
    path: Path

    def release(self) -> None:
        """Release the lock and close the fd. Idempotent-safe: a second call
        after the fd is closed is swallowed."""
        try:  # noqa: SIM105 — teardown/idempotent close — 예외 무시가 의도
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:  # noqa: SIM105 — teardown/idempotent close — 예외 무시가 의도
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


def _try_acquire(path: Path, *, denied_message: str) -> DataDirLock | None:
    """Acquire an exclusive advisory lock on ``path``, or return ``None``.

    ``denied_message`` is logged at WARNING with the current holder's
    diagnostic hint appended — it must say what this instance will *not* do,
    because a skipped writer is otherwise indistinguishable from a healthy one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # O_CREAT so a fresh data_dir works; we keep the fd open for the lifetime.
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    for attempt in range(_ACQUIRE_RETRIES):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if attempt < _ACQUIRE_RETRIES - 1:
                time.sleep(_ACQUIRE_RETRY_DELAY_S)
                continue
            logger.warning("%s (holder: %s)", denied_message, _read_owner_hint(path))
            os.close(fd)
            return None
        else:
            _write_owner_hint(fd)
            return DataDirLock(fd=fd, path=path)
    # Unreachable (loop either returns or continues), but keeps type-checkers happy.
    os.close(fd)
    return None


def try_acquire_queue_ownership(data_dir: Path) -> DataDirLock | None:
    """Attempt to become the sole capture-queue owner for ``data_dir``.

    Returns a :class:`DataDirLock` on success, or ``None`` if another live
    process already holds the lock (after a short retry window to absorb
    ``--reload`` handoffs). On success, writes a diagnostic ``pid=… port=…``
    line into the lock file — this is informational only and does not affect
    the lock.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    return _try_acquire(
        lock_path(data_dir),
        denied_message=(
            "capture queue owned by another process; this instance "
            "runs read-only for the queue (no worker pool, no mutations)"
        ),
    )


def try_acquire_collector_ownership(data_dir: Path) -> DataDirLock | None:
    """Attempt to become the sole market-flow collector for ``data_dir``.

    Same mechanism as the queue lock, **separate lock file** — the two writers
    are independent, and a process that loses the queue race can still be the
    right one to collect (or vice versa). Losing this one means the collectors
    are simply not started; every read path keeps serving from the samples the
    winner writes.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    return _try_acquire(
        collectors_lock_path(data_dir),
        denied_message=(
            "market flow collectors owned by another process; this instance "
            "will not collect (investor-flow · deriv-flow tasks not started)"
        ),
    )


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
