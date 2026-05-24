"""pykrx symbol master cache + search + captured breakdown via disk_state.

Three-tier policy (spec §11 Q19):
- Tier 1: lifespan calls load_disk_state() at startup (disk-backed boot).
- Tier 2: GET-time ``asyncio.Lock`` + in-flight Future dedupe — N concurrent
  GETs trigger exactly one pykrx call.
- Tier 3: pykrx failure returns the last-known cache with ``status="stale"``
  (or ``status="unavailable"`` if no cache ever existed).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Generic, Literal, TypeVar

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Query

from hoga.api.disk_state import DiskState, check_disk_state
from hoga.api.error_codes import UpstreamCode
from hoga.api.models import SymbolHit, SymbolMasterInfo, SymbolsAllResponse
from hoga.env import krx_creds_present, load_env

class PykrxFetchError(Exception):
    """Base for typed _fetch_from_pykrx failures.

    Subclasses distinguish the two upstream failure modes that need
    different ``reason`` codes on the response envelope. Caller
    (``_do_refresh``) maps each subclass to its UpstreamCode without an
    ``isinstance`` chain on a generic Exception.
    """


class KrxCredentialsMissing(PykrxFetchError):
    """KRX_ID/KRX_PW absent after ``load_env(override=True)``.

    Surfaces as ``UpstreamCode.KRX_CREDENTIALS_MISSING``. Raised before any
    pykrx call so a missing-creds refresh is a fast, network-free no-op.
    """


class KrxFetchFailed(PykrxFetchError):
    """pykrx network/auth/parsing failure.

    Surfaces as ``UpstreamCode.KRX_FETCH_FAILED``. Wraps the underlying
    exception via ``raise KrxFetchFailed() from e`` so logs preserve the
    original traceback.
    """


@dataclass(frozen=True)
class SymbolCacheState:
    """Atomic state for the Symbol Master cache (spec §5.3 2-axis matrix).

    Valid combinations (enforced by the factory classmethods):
      - SymbolCacheState.loading()                          status="loading",     reason=None
      - SymbolCacheState.fresh()                            status="fresh",       reason=None
      - SymbolCacheState.stale(reason=...)                  status="stale",       reason=UpstreamCode
      - SymbolCacheState.unavailable(reason=...)            status="unavailable", reason=UpstreamCode

    Frontend hint visibility and Refresh-button visibility derive from
    this two-axis matrix; constructing through the factories preserves
    spec §5.3's invariants.
    """

    status: Literal["loading", "fresh", "stale", "unavailable"]
    reason: UpstreamCode | None = None

    @classmethod
    def loading(cls) -> "SymbolCacheState":
        return cls(status="loading", reason=None)

    @classmethod
    def fresh(cls) -> "SymbolCacheState":
        return cls(status="fresh", reason=None)

    @classmethod
    def stale(cls, *, reason: UpstreamCode) -> "SymbolCacheState":
        return cls(status="stale", reason=reason)

    @classmethod
    def unavailable(cls, *, reason: UpstreamCode) -> "SymbolCacheState":
        return cls(status="unavailable", reason=reason)


T = TypeVar("T")


class _RefreshCoordinator(Generic[T]):
    """Single-flight coordinator: N concurrent refreshes trigger one fetch.

    Owns the lock + in-flight future that previously lived as module-level
    globals. The future *carries the task's result* so every joined caller
    receives the same snapshot — no second read of module globals required
    after coalesce() returns. The lock guards transitions on ``_inflight``.

    Ownership rule: only the initiator (the caller that created the future)
    clears ``_inflight``. Joining waiters MUST NOT clear it, otherwise a
    follow-on flight's future can be clobbered, defeating single-flight.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._inflight: asyncio.Future[T] | None = None

    async def coalesce(self, task_factory: Callable[[], asyncio.Task[T]]) -> T:
        """Start ``task_factory()`` once for the in-flight group; join existing.

        First caller wins: creates the task and the broadcast future under
        the lock. Subsequent callers that arrive while the task is running
        await the same future and receive the same result. When the task
        completes, all waiters unblock with that result; the initiator
        clears the in-flight slot so the next click starts fresh.

        ``task_factory`` runs under the lock — use it for state mutations
        that must be visible before any waiter resumes (e.g. setting
        ``SymbolCacheState.loading()``). If ``task_factory`` raises, the
        in-flight slot is rolled back so the failure does not deadlock
        every future call.
        """
        async with self._lock:
            if self._inflight is not None:
                fut = self._inflight
                is_initiator = False
            else:
                loop = asyncio.get_running_loop()
                fut = loop.create_future()
                self._inflight = fut
                is_initiator = True
                try:
                    task = task_factory()
                except BaseException:
                    # Roll back — no task was scheduled, future would never resolve.
                    self._inflight = None
                    raise

                def _signal(t: asyncio.Task[T]) -> None:
                    if fut.done():
                        return
                    if t.cancelled():
                        fut.cancel()
                        return
                    exc = t.exception()
                    if exc is not None:
                        fut.set_exception(exc)
                    else:
                        fut.set_result(t.result())

                task.add_done_callback(_signal)
        try:
            return await fut
        finally:
            if is_initiator:
                async with self._lock:
                    self._inflight = None

    def reset(self) -> None:
        """Test helper — clear in-flight state between tests.

        Cancels any live future to surface logic errors (a test should have
        awaited refresh() before calling reset_state_for_tests).
        """
        if self._inflight is not None and not self._inflight.done():
            self._inflight.cancel()
        self._inflight = None


# Module-level state (per ADR-0006 single-module pattern, scoped to symbols.py).
_cache: list[SymbolHit] = []
_fetched_at_ms: int | None = None
_state: SymbolCacheState = SymbolCacheState.unavailable(
    reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED
)
_refresh_coordinator: _RefreshCoordinator[SymbolsAllResponse] = _RefreshCoordinator()
SCHEMA_VERSION = 1


def reset_state_for_tests() -> None:
    global _cache, _fetched_at_ms, _state  # noqa: PLW0603
    _cache, _fetched_at_ms, _state = (
        [],
        None,
        SymbolCacheState.unavailable(reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED),
    )
    _refresh_coordinator.reset()


def _load_from_disk(path: Path) -> tuple[list[SymbolHit], int] | None:
    """Read the Symbol Master file. Return (entries, fetched_at_ms) or None.

    Returns None when:
      - the file does not exist (no log; this is the first-boot normal path),
      - the JSON cannot be parsed,
      - schema_version is missing or != SCHEMA_VERSION,
      - the entries array is missing or malformed.

    Every failure path other than "file absent" emits a logger.warning so
    developers can diagnose disk-corruption events without user reporting.
    Per ADR-0015 (consequences): "corruption is diagnosed via server logs."

    captured_breakdown is NOT populated here — load_disk_state fills it from
    the data_dir walk.
    """
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Symbol Master disk file unreadable at %s: %s", path, e)
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        logger.warning(
            "Symbol Master disk file schema mismatch at %s (got %r, expected %d)",
            path, payload.get("schema_version") if isinstance(payload, dict) else None, SCHEMA_VERSION,
        )
        return None
    raw_entries = payload.get("entries")
    fetched_at_ms = payload.get("fetched_at_ms")
    if not isinstance(raw_entries, list) or not isinstance(fetched_at_ms, int):
        logger.warning(
            "Symbol Master disk file missing/malformed entries or fetched_at_ms at %s",
            path,
        )
        return None
    try:
        entries = [
            SymbolHit(
                code=e["code"],
                name=e["name"],
                market=e["market"],
                captured_count=0,
                captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
            )
            for e in raw_entries
        ]
    except (KeyError, TypeError) as e:
        logger.warning(
            "Symbol Master disk file has malformed entry at %s: %s", path, e,
        )
        return None
    return entries, fetched_at_ms


def _write_to_disk(path: Path, entries: list[SymbolHit], fetched_at_ms: int) -> None:
    """Atomically persist the catalog. Creates parent dir if needed.

    Atomicity: temp file in target's parent + os.replace. captured_breakdown
    fields are stripped — disk file holds KRX-side data only (breakdown is a
    runtime view of data_dir).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "fetched_at_ms": fetched_at_ms,
        "source": "pykrx",
        "entries": [
            {"code": e.code, "name": e.name, "market": e.market}
            for e in entries
        ],
    }
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=2)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def _ensure_krx_credentials() -> None:
    """Reload .env and verify KRX_ID/KRX_PW are present.

    Called by :func:`_fetch_from_pykrx` before any pykrx I/O so the user's
    most recent ``.env`` edits take effect on every explicit refresh click
    (override=True wins over shell env). Raises :class:`KrxCredentialsMissing`
    when either value is empty after the reload — a fast, network-free
    failure mode.

    Safe to call under an asyncio Lock: when a local worktree ``.env`` exists
    no subprocess runs, and the git-fallback subprocess (when it does fire)
    is bounded by a short timeout in :func:`hoga.env.load_env`.
    """
    load_env(override=True)
    if not krx_creds_present():
        raise KrxCredentialsMissing()


async def _fetch_from_pykrx() -> list[SymbolHit]:
    """Sole upstream entry point — loads creds, calls pykrx, maps errors.

    Self-contained: callers do not load .env or check credentials. The two
    failure modes surface as typed exceptions (:class:`KrxCredentialsMissing`,
    :class:`KrxFetchFailed`) so :func:`_do_refresh` maps each to its
    UpstreamCode without an opaque catch-all.

    Verified against pykrx 1.2.8 in Task 9 Step 1 (Variant B). In pykrx 1.2.8,
    ``get_market_cap`` no longer returns a ``종목명`` column
    (columns: ['종가','시가총액','거래량','거래대금','상장주식수']), and
    ``get_market_fundamental`` also lacks it. Per-ticker
    ``get_market_ticker_name`` is the only reliable name-lookup API.

    ThreadPoolExecutor batches per-code get_market_ticker_name calls
    (max_workers=8). Total fetch ~30-120s for ~2600 codes across both markets;
    acceptable because pykrx is called only on explicit user trigger.
    All-or-nothing: any per-market or per-code failure raises and aborts.
    """
    _ensure_krx_credentials()

    from concurrent.futures import ThreadPoolExecutor

    from pykrx import stock

    loop = asyncio.get_running_loop()
    today = time.strftime("%Y%m%d")

    def _scrape() -> list[tuple[str, str, str]]:
        rows: list[tuple[str, str, str]] = []
        for market in ("KOSPI", "KOSDAQ"):
            codes = stock.get_market_ticker_list(today, market=market)
            with ThreadPoolExecutor(max_workers=8) as pool:
                names = list(pool.map(stock.get_market_ticker_name, codes))
            for code, name in zip(codes, names, strict=True):
                rows.append((str(code), str(name), market))
        return rows

    try:
        rows = await loop.run_in_executor(None, _scrape)
    except Exception as e:  # noqa: BLE001 — pykrx exposes no typed errors
        raise KrxFetchFailed() from e
    return [
        SymbolHit(
            code=c,
            name=n,
            market=m,  # type: ignore[arg-type]
            captured_count=0,
            captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
        )
        for c, n, m in rows
    ]


def _build_all_captured_breakdowns(data_dir: Path) -> dict[str, dict[str, int]]:
    """Walk ``data/parquet/*`` and ``data/raw/*`` ONCE, building ``{code: breakdown}``.

    A per-symbol bucketing pass called from :func:`_do_refresh`
    would be ``O(symbols × parquet_dates)`` — 6000 ×
    100 = 600,000 stat calls per cache rebuild. This single-pass walk is
    ``O(total_stock_date_dirs)`` — orders of magnitude fewer disk ops when the
    typical user has <200 captured Stock-Dates across all symbols.
    """
    breakdowns: dict[str, dict[str, int]] = {}
    parquet_root = data_dir / "parquet"
    if parquet_root.exists():
        for date_dir in parquet_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                if not code_dir.is_dir():
                    continue
                st = check_disk_state(data_dir, code_dir.name, date_dir.name)
                bucket = breakdowns.setdefault(
                    code_dir.name,
                    {"complete": 0, "source_partial": 0, "client_incomplete": 0},
                )
                if st == DiskState.COMPLETE:
                    bucket["complete"] += 1
                elif st == DiskState.SOURCE_PARTIAL:
                    bucket["source_partial"] += 1
                elif st == DiskState.CLIENT_INCOMPLETE:
                    bucket["client_incomplete"] += 1
    raw_root = data_dir / "raw"
    if raw_root.exists():
        for date_dir in raw_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                if not code_dir.is_dir():
                    continue
                # Skip if parquet covered this (code, date) — already counted.
                if (parquet_root / date_dir.name / code_dir.name).exists():
                    continue
                st = check_disk_state(data_dir, code_dir.name, date_dir.name)
                if st == DiskState.CLIENT_INCOMPLETE:
                    bucket = breakdowns.setdefault(
                        code_dir.name,
                        {"complete": 0, "source_partial": 0, "client_incomplete": 0},
                    )
                    bucket["client_incomplete"] += 1
    return breakdowns


def load_disk_state(*, path: Path, data_dir: Path) -> None:
    """Boot-time entry: populate in-memory state from disk + data_dir walk.

    No pykrx, no network — pure disk read. Called once from lifespan startup
    (see hoga/api/app.py — wired in T11). Replaces the deleted ensure_cache_warm.

    On success the in-memory cache is fresh with the disk file's contents and
    captured_breakdown filled from a single data_dir walk. On any disk-load
    failure (file absent, corrupt, schema mismatch, malformed entries) the
    cache is empty and _state surfaces SYMBOL_MASTER_NOT_INITIALIZED so the
    UI prompts the user to click Update.
    """
    global _cache, _fetched_at_ms, _state  # noqa: PLW0603
    result = _load_from_disk(path)
    if result is None:
        _cache = []
        _fetched_at_ms = None
        _state = SymbolCacheState.unavailable(reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED)
        return
    entries, fetched_at_ms = result
    breakdowns = _build_all_captured_breakdowns(data_dir)
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
    for h in entries:
        breakdown = breakdowns.get(h.code, empty)
        h.captured_count = breakdown["complete"]
        h.captured_breakdown = breakdown
    _cache = entries
    _fetched_at_ms = fetched_at_ms
    _state = SymbolCacheState.fresh()


async def get_all(*, data_dir: Path) -> SymbolsAllResponse:
    """Return the in-memory Symbol Master.

    Pure read — no fetching, no locking, no Future. Boot already populated
    _cache via load_disk_state(); explicit refresh via POST /api/symbols/refresh
    is the only mutation entry point.

    data_dir is preserved in the signature for backwards-compat with existing
    route wiring; it is unused on the read path.
    """
    del data_dir  # unused — kept for route-handler signature compatibility
    return SymbolsAllResponse(
        symbols=list(_cache),
        status=_state.status,
        fetched_at_ms=_fetched_at_ms,
        reason=_state.reason,
    )


async def refresh(*, path: Path, data_dir: Path) -> SymbolsAllResponse:
    """POST /api/symbols/refresh — the only pykrx entry point.

    Concurrency: :data:`_refresh_coordinator` dedupes simultaneous clicks
    (Settings + SymbolSearch may fire together) — N concurrent calls trigger
    exactly one underlying fetch and every joined caller receives the same
    response snapshot.

    Credentials are verified on a fast-path BEFORE flipping ``_state`` to
    ``loading()`` so a missing-creds system never produces a transient
    ``loading`` status flash. Concurrent GET /api/symbols/all would
    otherwise briefly observe ``status='loading'`` and the UI would
    spinner-flash before re-flipping to KRX_CREDENTIALS_MISSING.

    Failure semantics: pykrx exception → disk file unchanged, memory state
    stale (if cache populated) or unavailable. Any other unexpected exception
    is caught by :func:`_do_refresh`'s broad fallback and surfaces as
    ``KRX_FETCH_FAILED``.
    """
    try:
        _ensure_krx_credentials()
    except KrxCredentialsMissing:
        # Idempotent: concurrent callers without .env all converge on the
        # same stale/unavailable snapshot. No need to route through the
        # coordinator's single-flight machinery — there is no flight.
        _set_stale_or_unavailable(UpstreamCode.KRX_CREDENTIALS_MISSING)
        return _build_response()

    def _start_refresh_task() -> asyncio.Task[SymbolsAllResponse]:
        global _state  # noqa: PLW0603
        _state = SymbolCacheState.loading()
        return asyncio.create_task(_do_refresh(path=path, data_dir=data_dir))

    return await _refresh_coordinator.coalesce(_start_refresh_task)


def _set_stale_or_unavailable(reason: UpstreamCode) -> None:
    """Pick stale vs unavailable based on whether the cache has prior data."""
    global _state  # noqa: PLW0603
    _state = (
        SymbolCacheState.stale(reason=reason)
        if _cache
        else SymbolCacheState.unavailable(reason=reason)
    )


def _build_response() -> SymbolsAllResponse:
    """Snapshot module state into a response envelope.

    Called from :func:`_do_refresh` so the snapshot is captured at
    task-completion time and broadcast by the coordinator's future. This
    keeps joined waiters from observing transient state from a subsequent
    refresh cycle.
    """
    return SymbolsAllResponse(
        symbols=list(_cache),
        status=_state.status,
        fetched_at_ms=_fetched_at_ms,
        reason=_state.reason,
    )


async def _do_refresh(*, path: Path, data_dir: Path) -> SymbolsAllResponse:
    """Inner refresh routine — runs as the single-flight task.

    Returns the response snapshot the coordinator hands back to every
    waiter joined to this flight. Always returns — the broad ``except``
    safety net at the bottom guarantees ``_state`` is never left at
    ``loading()`` even when an unexpected exception (e.g. ``ImportError``
    from a broken pykrx, ``OSError`` from a filesystem walk) escapes the
    typed handlers above.
    """
    global _cache, _fetched_at_ms, _state  # noqa: PLW0603
    try:
        try:
            entries = await _fetch_from_pykrx()
        except KrxCredentialsMissing:
            _set_stale_or_unavailable(UpstreamCode.KRX_CREDENTIALS_MISSING)
            return _build_response()
        except KrxFetchFailed:
            _set_stale_or_unavailable(UpstreamCode.KRX_FETCH_FAILED)
            return _build_response()

        now_ms = int(time.time() * 1000)
        try:
            _write_to_disk(path, entries, now_ms)
        except OSError as exc:
            # Disk-related failures (full volume, read-only mount, missing
            # parent dir, EACCES) are an expected operational class — log
            # a single warning with the cause and surface the dedicated
            # DISK_WRITE_FAILED reason so operators and the UI can
            # distinguish "the upstream source is down" from "we couldn't
            # persist what the upstream gave us".
            logger.warning(
                "Symbol cache disk write failed at %s: %s", path, exc,
            )
            _set_stale_or_unavailable(UpstreamCode.DISK_WRITE_FAILED)
            return _build_response()
        loop = asyncio.get_running_loop()
        breakdowns = await loop.run_in_executor(
            None, _build_all_captured_breakdowns, data_dir
        )
        empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
        for h in entries:
            breakdown = breakdowns.get(h.code, empty)
            h.captured_count = breakdown["complete"]
            h.captured_breakdown = breakdown
        _cache = entries
        _fetched_at_ms = now_ms
        _state = SymbolCacheState.fresh()
        return _build_response()
    except Exception:  # noqa: BLE001 — safety net so _state never sticks at loading()
        logger.exception("Symbol refresh failed unexpectedly")
        _set_stale_or_unavailable(UpstreamCode.KRX_FETCH_FAILED)
        return _build_response()


def search(q: str, *, limit: int = 20) -> list[SymbolHit]:
    """Pure in-memory filter — caller is expected to have already populated
    the cache via :func:`get_all`.

    Numeric prefix → code match. Otherwise → name substring match.
    Sort: code-prefix matches before substring matches, then by name length.
    """
    q_norm = q.strip()
    if not q_norm:
        return list(_cache)[:limit]
    if q_norm.isdigit():
        # Code prefix
        matches = [h for h in _cache if h.code.startswith(q_norm)]
        return matches[:limit]
    # Name substring
    matches = [h for h in _cache if q_norm in h.name]
    matches.sort(key=lambda h: (not h.name.startswith(q_norm), len(h.name)))
    return matches[:limit]


def build_router(*, path: Path, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/symbols", tags=["symbols"])

    @router.get("/all")
    async def get_all_route() -> SymbolsAllResponse:
        return await get_all(data_dir=data_dir)

    @router.get("")
    async def search_route(
        q: str = Query("", min_length=0),
        limit: int = Query(20, ge=1, le=100),
    ) -> list[SymbolHit]:
        return search(q, limit=limit)

    @router.post("/refresh")
    async def refresh_route() -> SymbolsAllResponse:
        return await refresh(path=path, data_dir=data_dir)

    @router.get("/info")
    async def info_route() -> SymbolMasterInfo:
        return SymbolMasterInfo(
            count=len(_cache),
            fetched_at_ms=_fetched_at_ms,
            status=_state.status,
            reason=_state.reason,
        )

    return router
