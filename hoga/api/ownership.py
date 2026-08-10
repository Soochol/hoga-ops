"""Single-owner guards for shared ``data_dir`` writers (ADR-0094).

``data_dir`` is machine-global by design (``resolve_data_dir()`` ignores cwd so
captures aren't re-fetched per worktree). The cost is that **two backend
instances share every writer**: the main checkout on :8000 and a worktree
backend that inherited the main ``.env`` both run the same background work
against the same files.

Four writers are guarded here, each with its own lock file. They are separate
locks — not one "I am the primary" flag — because the preconditions differ
(queue needs nothing, collectors need REST credentials, WS writers need a live
Kiwoom session), so a process that is wrong for one can be right for another:

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

``.ws_writers.lock`` — **Kiwoom-WS-derived writers**: the program-trade sidecar
(0w latch → ``ProgramTradeStore``) and the Today Promoter (live JSONL →
parquet). One lock for both; see ``try_acquire_ws_writer_ownership``.

``.daily.lock`` — **the 17:00 daily batch**. Lowest risk of the four because
``scheduler_state.json`` already enforces once-a-day, but that marker is
read-then-write: two instances ticking within the same few seconds both pass.

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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

_LOCK_FILENAME = ".queue.lock"
_COLLECTORS_LOCK_FILENAME = ".collectors.lock"
_WS_WRITERS_LOCK_FILENAME = ".ws_writers.lock"
_DAILY_LOCK_FILENAME = ".daily.lock"
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


def ws_writers_lock_path(data_dir: Path) -> Path:
    return data_dir / _WS_WRITERS_LOCK_FILENAME


def daily_lock_path(data_dir: Path) -> Path:
    return data_dir / _DAILY_LOCK_FILENAME


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


def try_acquire_ws_writer_ownership(data_dir: Path) -> DataDirLock | None:
    """Attempt to become the sole writer of Kiwoom-WS-derived files.

    Covers the program-trade sidecar (0w latch → ``ProgramTradeStore``) and the
    Today Promoter (live JSONL → parquet). **One lock for both** because they
    share a single precondition — a live Kiwoom WS session — and the vendor
    allows one WS session per app key. Two processes therefore can't both be
    healthy: they kick each other and the watchdog reconnects in a loop, so a
    split lock would always resolve the same way while costing a second file
    and a second failure mode to reason about.

    Note what this does *not* fix: the kick war itself. The lock keeps the
    files single-writer; keeping the WS session single is what an empty
    worktree ``.env`` is for (ADR-0134).
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    return _try_acquire(
        ws_writers_lock_path(data_dir),
        denied_message=(
            "Kiwoom WS writers owned by another process; this instance will "
            "not persist them (program-trade sidecar · today promoter)"
        ),
    )


def try_acquire_daily_ownership(data_dir: Path) -> DataDirLock | None:
    """Attempt to become the sole runner of the daily 17:00 batch.

    Lower risk than the other writers — ``scheduler_state.json`` already keeps
    it to once a day — but the marker is read-then-write, so two instances
    ticking within the same few seconds both pass the check. The lock closes
    that window; the marker still owns "once per day" across restarts.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    return _try_acquire(
        daily_lock_path(data_dir),
        denied_message=(
            "daily batch owned by another process; this instance will not run "
            "it (promotion · prune · enqueue · screener)"
        ),
    )


# ── 프로세스 수준 레지스트리 ────────────────────────────────────────────────
#
# 락이 넷이고 취득 지점이 셋(scheduler · storage_runtime · lifespan)이라, 각자
# 모듈 전역을 들면 관측면이 갈린다. 소유 상태의 SSOT 를 여기 한 곳에 둔다.
#
# 큐 락(`.queue.lock`)은 **여기 없다** — `captures.py` 가 자체 전역으로 관리하고
# `/health` 에 이미 노출한다(ADR-0094). 옮기는 것은 이 변경의 범위가 아니다.

_ACQUIRERS: dict[str, Callable[[Path], DataDirLock | None]] = {}
_held: dict[str, DataDirLock] = {}
#: writer 이름 → 왜 못 가졌나. 키가 없으면 "아직 시도 안 함"(= owned:null).
_denied: dict[str, str] = {}


def acquire(name: str, data_dir: Path, *, available: bool = True) -> bool:
    """이름 붙은 writer 락을 잡는다. 이미 잡았으면 그대로 유지(재기동 안전).

    ⚠ ``available=False``(무자격)면 **락을 시도조차 하지 않는다.** 무자격 인스턴스가
    선점하면 나중에 뜬 자격 있는 인스턴스가 그 일을 통째로 못 한다 — 워크트리가 빈
    `.env` 로(관례대로) 먼저 뜨고 사용자 dev 서버가 나중에 뜨는, **정상적이고 흔한
    순서**가 그렇다. 가드가 막으려던 것보다 나쁜 결과다.
    """
    if name in _held:
        return True
    if not available:
        _denied[name] = "no_credentials"
        return False
    lock = _ACQUIRERS[name](data_dir)
    if lock is None:
        _denied[name] = "held_by_other"
        return False
    _held[name] = lock
    _denied.pop(name, None)
    return True


def ownership_state() -> dict[str, dict[str, object]]:
    """관측면 — writer 별 소유 상태. `/api/live/status.writers` 로 나간다.

    **강등이 무증상이기 때문에** 필요하다: 락을 못 잡은 인스턴스는 읽기 경로가
    멀쩡해서 화면상 정상과 구별되지 않는다(승자가 쓴 파일을 그대로 서빙한다).

    세 상태를 **구별해서** 말한다. 하나로 뭉치면 관측면이 거짓말을 한다:

        owned=null                          아직 시도 안 함(미기동)
        owned=false reason=no_credentials   무자격 — 락을 시도하지 않았다
        owned=false reason=held_by_other    다른 프로세스가 쥐고 있다 ← 조사 대상
    """
    out: dict[str, dict[str, object]] = {}
    for name in _ACQUIRERS:
        if name in _held:
            out[name] = {"owned": True, "reason": None}
        elif name in _denied:
            out[name] = {"owned": False, "reason": _denied[name]}
        else:
            out[name] = {"owned": None, "reason": None}
    return out


def release_all() -> None:
    """셧다운에서 전부 해제. 멱등이고 비소유자에게도 안전하다.

    flock 은 프로세스 종료 시 커널이 어차피 놓지만, `--reload` 재기동은 앞선
    프로세스의 teardown 과 겹치므로 **명시적 해제가 즉시**여야 후임이 재시도
    창(4×0.5s) 안에 잡는다.
    """
    for lock in _held.values():
        lock.release()
    _held.clear()
    _denied.clear()


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


#: writer 이름 → 취득 함수. 이름이 곧 `/api/live/status.writers` 의 키다.
_ACQUIRERS.update({
    "collectors": try_acquire_collector_ownership,
    "ws": try_acquire_ws_writer_ownership,
    "daily": try_acquire_daily_ownership,
})
