"""KIS .mst symbol master cache + search + captured breakdown via disk_state.

Three-tier policy (spec §11 Q19):
- Tier 1: lifespan calls load_disk_state() at startup (disk-backed boot).
- Tier 2: GET-time ``asyncio.Lock`` + in-flight Future dedupe — N concurrent
  GETs trigger exactly one .mst fetch.
- Tier 3: .mst failure returns the last-known cache with ``status="stale"``
  (or ``status="unavailable"`` if no cache ever existed).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Generic, Literal, TypeVar

from fastapi import APIRouter, Query

from hoga.api.disk_state import DiskState, check_disk_state
from hoga.api.error_codes import UpstreamCode
from hoga.api.kiwoom_master import (
    API_ID as KIWOOM_MASTER_API_ID,
    KiwoomMasterFetchError,
    fetch_symbol_master as kiwoom_fetch_symbol_master,
    load_seed as _load_master_seed,
)
from hoga.api.models import SymbolHit, SymbolMasterInfo, SymbolsAllResponse
from hoga.util.atomic_write import atomic_write_json

logger = logging.getLogger(__name__)


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
    def loading(cls) -> SymbolCacheState:
        return cls(status="loading", reason=None)

    @classmethod
    def fresh(cls) -> SymbolCacheState:
        return cls(status="fresh", reason=None)

    @classmethod
    def stale(cls, *, reason: UpstreamCode) -> SymbolCacheState:
        return cls(status="stale", reason=reason)

    @classmethod
    def unavailable(cls, *, reason: UpstreamCode) -> SymbolCacheState:
        return cls(status="unavailable", reason=reason)


T = TypeVar("T")


class _RefreshCoordinator(Generic[T]):
    """Single-flight coordinator: N concurrent refreshes trigger one fetch.

    Owns the lock + in-flight future that previously lived as module-level
    globals. The future *carries the task's result* so every joined caller
    receives the same snapshot — no second read of module globals required
    after coalesce() returns. The lock guards transitions on ``_inflight``.

    Worker-owned lifecycle: the flight is owned by the detached worker task,
    NOT by any caller. The worker's done-callback (``_signal``) is the sole
    place that clears ``_inflight``/``_task``, and every caller — initiator
    and joiners alike — awaits the shared future through ``asyncio.shield``.
    Consequences:
      * Cancelling ANY caller (a POST /refresh whose client disconnected;
        Starlette cancels the handler) scopes to that caller only. It never
        cancels the shared future and never aborts the fetch. Awaiting a bare
        shared future is an asyncio footgun — a cancelled awaiter's Task
        cancels whatever future it is parked on, which here is the future
        EVERY other awaiter is parked on too — so one disconnected client
        would otherwise kill an in-flight boot refresh for all joiners.
      * The fetch runs to completion and populates the cache even if every
        caller has gone away. This is deliberate: an abandoned refresh should
        still land its data, not be wasted.
      * The ONLY thing that cancels the worker is explicit shutdown via
        :meth:`aclose`, which the lifespan calls before ``aclose_kis_client``
        so a mid-flight worker can't touch torn-down resources. Atomic writes
        make a mid-write cancel safe.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._inflight: asyncio.Future[T] | None = None
        # The detached worker task for the current flight — owned by the
        # coordinator, cleared by _signal on completion, cancelled only by aclose().
        self._task: asyncio.Task[T] | None = None

    async def coalesce(self, task_factory: Callable[[], asyncio.Task[T]]) -> T:
        """Start ``task_factory()`` once for the in-flight group; join existing.

        First caller wins: creates the worker task and the broadcast future
        under the lock. Subsequent callers that arrive while the worker is
        running await the same future and receive the same result. When the
        worker completes, ``_signal`` clears the in-flight slot so the next
        call starts a fresh flight and resolves the future for all waiters.

        ``task_factory`` runs under the lock — use it for state mutations
        that must be visible before any waiter resumes (e.g. setting
        ``SymbolCacheState.loading()``). If ``task_factory`` raises, the
        in-flight slot is rolled back so the failure does not deadlock
        every future call.
        """
        async with self._lock:
            if self._inflight is not None:
                fut = self._inflight
            else:
                loop = asyncio.get_running_loop()
                fut = loop.create_future()
                self._inflight = fut
                try:
                    task = task_factory()
                except BaseException:
                    # Roll back — no task was scheduled, future would never resolve.
                    self._inflight = None
                    raise
                self._task = task

                def _signal(t: asyncio.Task[T]) -> None:
                    # Worker owns the flight: clear the slot HERE (never in a
                    # caller's finally) so the next coalesce() starts fresh and
                    # no caller's cancellation can end the flight. Runs in the
                    # loop with no await, so it can't interleave into coalesce's
                    # (await-free) critical section — no lock needed.
                    if self._inflight is fut:
                        self._inflight = None
                        self._task = None
                    if fut.done():
                        # fut already settled (aclose() cancelled the worker, or
                        # reset()). OBSERVE the worker's outcome so an exception
                        # isn't reported "never retrieved" at GC.
                        if not t.cancelled():
                            t.exception()
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
        # shield: a cancelled awaiter (disconnected POST /refresh) must not
        # cancel the SHARED future — that would abort the fetch for every other
        # joiner. The flight lives until the worker finishes or aclose() cancels
        # it, independent of who is (still) awaiting.
        return await asyncio.shield(fut)

    async def aclose(self) -> None:
        """Shutdown hook — cancel+await the live worker. Idempotent.

        The lifespan calls this before ``aclose_kis_client`` so a mid-flight
        worker cannot touch torn-down resources. On a quiescent coordinator
        (no flight in progress) it is a no-op. ``_signal`` clears the slot when
        the cancelled worker's callback fires.
        """
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    def reset(self) -> None:
        """Test helper — clear in-flight state between tests.

        Cancels any live future to surface logic errors (a test should have
        awaited refresh() before calling reset_state_for_tests).
        """
        if self._inflight is not None and not self._inflight.done():
            self._inflight.cancel()
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._inflight = None
        self._task = None


# Module-level state (per ADR-0006 single-module pattern, scoped to symbols.py).
_cache: list[SymbolHit] = []
_fetched_at_ms: int | None = None
_state: SymbolCacheState = SymbolCacheState.unavailable(
    reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED
)
_refresh_coordinator: _RefreshCoordinator[SymbolsAllResponse] = _RefreshCoordinator()
# v4: `nxt_enabled` 추가(ADR-0140 §4·#1127). **하한(_MIN)은 3 그대로** — v3 캐시는
# 그 필드만 없을 뿐 코드 체계가 같아 그대로 읽히고(nxt_enabled=None=모름),
# `needs_boot_refresh()` 가 배경 재다운로드를 예약해 자연히 채워진다. 하한까지
# 올리면 오프라인 부팅에서 캐시를 통째로 버리는 과잉무효화가 된다.
SCHEMA_VERSION = 4
# 로더가 받아들이는 가장 오래된 스키마.
#
# **v3 에서 하한을 올렸다(PR-I·#1045).** v2 는 KIS `.mst` 산이라 ETN 코드에 `Q`
# 접두가 붙어 있다(`Q500061`). 키움 `ka10099` 는 `500061` 을 준다. 하한을 안
# 올리면 stale 캐시와 새 fetch 가 **같은 종목을 다른 코드로** 내보내 검색 결과가
# 이원화된다 — 기존 캐시에 380건이다.
#
# v1 을 받아들이던 이유("거부하면 오프라인 부팅에서 검색이 빈다")는 여전히
# 유효하지만, 이제 **커밋된 시드 스냅샷**(`kiwoom_master_seed.json`)이 그 자리를
# 메운다. 디스크 캐시가 없거나 낡았으면 시드로 부팅한다.
_MIN_SCHEMA_VERSION = 3
# Schema version of the file load_disk_state read (None = nothing loaded).
# needs_boot_refresh() uses it to schedule a background re-download when a
# legacy-schema cache was accepted, so the upgrade converges to v2 online.
_loaded_schema_version: int | None = None

# 키움 클라이언트 조달용 data_dir. `load_disk_state` 가 채운다 — 마스터 갱신은
# 이제 인증이 필요해서(`.mst` 무인증과 달리) 런타임 클라이언트가 있어야 한다.
_data_dir_for_fetch: Path | None = None


def _symbols_data_dir() -> Path | None:
    return _data_dir_for_fetch


def reset_state_for_tests() -> None:
    global _cache, _fetched_at_ms, _state, _loaded_schema_version  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    _cache, _fetched_at_ms, _state = (
        [],
        None,
        SymbolCacheState.unavailable(reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED),
    )
    _loaded_schema_version = None
    _refresh_coordinator.reset()


def _load_from_disk(path: Path) -> tuple[list[SymbolHit], int, int] | None:
    """Read the Symbol Master file. Return (entries, fetched_at_ms,
    schema_version) or None.

    Returns None when:
      - the file does not exist (no log; this is the first-boot normal path),
      - the JSON cannot be parsed,
      - schema_version is missing or outside [_MIN_SCHEMA_VERSION, SCHEMA_VERSION],
      - the entries array is missing or malformed.

    Legacy v1 files load fine (security_type defaults to "stock" below);
    needs_boot_refresh() schedules a background re-download to converge to v2.

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
    schema_version = payload.get("schema_version") if isinstance(payload, dict) else None
    if (
        not isinstance(schema_version, int)
        or not (_MIN_SCHEMA_VERSION <= schema_version <= SCHEMA_VERSION)
    ):
        logger.warning(
            "Symbol Master disk file schema mismatch at %s (got %r, accept %d..%d)",
            path, schema_version, _MIN_SCHEMA_VERSION, SCHEMA_VERSION,
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
                security_type=e.get("security_type", "stock"),
                # 구 캐시엔 이 키가 없다 → **모름**(None). `False`(미상장)로 읽으면
                # 캐시 하나가 "전 종목 NXT 미상장"이라 거짓 증언한다.
                nxt_enabled=e.get("nxt_enabled"),
                captured_count=0,
                captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
            )
            for e in raw_entries
        ]
    except (KeyError, TypeError) as e:
        logger.warning(
            "Symbol Master disk file has malformed entry at %s: %s", path, e,
        )
        return None
    return entries, fetched_at_ms, schema_version


def _write_to_disk(path: Path, entries: list[SymbolHit], fetched_at_ms: int) -> None:
    """Atomically persist the catalog. Creates parent dir if needed.

    Delegates to hoga.util.atomic_write.atomic_write_json (extracted per
    ADR-0015 footer + ADR-0019). captured_breakdown fields are stripped —
    disk file holds KRX-side data only (breakdown is a runtime view of
    data_dir).
    """
    payload = {
        "schema_version": SCHEMA_VERSION,
        "fetched_at_ms": fetched_at_ms,
        "source": "kis_mst",
        "entries": [
            {"code": e.code, "name": e.name, "market": e.market,
             "security_type": e.security_type, "nxt_enabled": e.nxt_enabled}
            for e in entries
        ],
    }
    atomic_write_json(path, payload)


def _rows_to_hits(rows) -> list[SymbolHit]:
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0}
    return [
        SymbolHit(
            code=r.code,
            name=r.name,
            market=r.market,  # type: ignore[arg-type]
            security_type=r.security_type,
            nxt_enabled=r.nxt_enabled,
            captured_count=0,
            captured_breakdown=dict(empty),
        )
        for r in rows
    ]


async def _fetch_symbol_master() -> list[SymbolHit]:
    """유일한 업스트림 진입점 — 키움 `ka10099` (PR-I·#1045).

    `.mst` 는 무인증 정적 파일이라 자격증명 없이도 검색이 살아 있었다(SPEC §7).
    `ka10099` 는 인증이 필요하므로 그 성질이 **시드 스냅샷**으로 옮겨간다:
    자격증명이 없으면 여기서 실패하고, 부팅은 커밋된 시드로 이뤄진다.
    """
    from hoga.live import kiwoom_access, kiwoom_rest_runtime  # noqa: PLC0415 — 순환 절단

    data_dir = _symbols_data_dir()
    client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
    if client is None:
        raise KiwoomMasterFetchError("키움 자격증명 없음 — 마스터를 갱신할 수 없다")

    # 거버너를 통과시킨다 — 저빈도지만 목적은 토큰 revoke(8005) 자동복구다
    # (복구가 거버너 소유, PR #1088). 우회하면 갱신이 조용히 멈추고 검색이 커밋된
    # 시드에 고정된다 — 신규 상장이 안 보이는데 화면에는 증상이 없다.
    scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)

    async def _run_call(fetch_fn, market):
        # 시장마다 1 submit — 버킷과 벤더가 같은 수를 세게(ADR-0137).
        return await kiwoom_access.run_with_capacity(
            scheduler,
            key=("symbol-master", market),
            api_id=KIWOOM_MASTER_API_ID,
            priority="background",
            client=client,
            fetch_fn=fetch_fn,
        )

    rows = await kiwoom_fetch_symbol_master(client, run_call=_run_call)
    return _rows_to_hits(rows)


def _build_all_captured_breakdowns(data_dir: Path) -> dict[str, dict[str, int]]:  # noqa: PLR0912 — ADR 이 지정한 단일 조립점 — 분기 분할이 설계에 반한다
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
                # source="hogaplay": the breakdown buckets mirror the capture
                # calendar's hogaplay-framed states, so a COMPLETE kiwoom_live/kis_api
                # promotion must not inflate the "complete" count. promotion-only
                # Stock-Dates resolve to NONE here (surfaced separately as *_live
                # on the calendar), matching the display axis.
                st = check_disk_state(
                    data_dir, code_dir.name, date_dir.name, source="hogaplay",
                ).state
                bucket = breakdowns.setdefault(
                    code_dir.name,
                    {"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
                )
                if st == DiskState.COMPLETE:
                    bucket["complete"] += 1
                elif st == DiskState.SOURCE_PARTIAL:
                    bucket["source_partial"] += 1
                elif st == DiskState.CLIENT_INCOMPLETE:
                    bucket["client_incomplete"] += 1
                elif st == DiskState.INVALID:
                    bucket["invalid"] += 1
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
                st = check_disk_state(data_dir, code_dir.name, date_dir.name).state
                if st == DiskState.CLIENT_INCOMPLETE:
                    bucket = breakdowns.setdefault(
                        code_dir.name,
                        {"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
                    )
                    bucket["client_incomplete"] += 1
    return breakdowns


def load_disk_state(*, path: Path, data_dir: Path) -> None:
    """Boot-time entry: populate in-memory state from disk + data_dir walk.

    No network — pure disk read. Called once from lifespan startup
    (see hoga/api/app.py — wired in T11). Replaces the deleted ensure_cache_warm.

    On success the in-memory cache is fresh with the disk file's contents and
    captured_breakdown filled from a single data_dir walk. On any disk-load
    failure (file absent, corrupt, schema mismatch, malformed entries) the
    cache is empty and _state surfaces SYMBOL_MASTER_NOT_INITIALIZED so the
    UI prompts the user to click Update.
    """
    global _cache, _fetched_at_ms, _state, _loaded_schema_version, _data_dir_for_fetch  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    _data_dir_for_fetch = data_dir
    result = _load_from_disk(path)
    if result is None:
        # **시드 스냅샷으로 부팅한다**(PR-I·#1045). `.mst` 는 무인증이라 첫 부팅에서
        # 바로 받아올 수 있었지만 `ka10099` 는 인증이 필요하다. 그 성질을 잃지
        # 않으려고 커밋된 시드를 둔다 — 자격증명이 없어도 검색이 산다.
        seed = _load_master_seed()
        if seed:
            entries = _rows_to_hits(seed)
            breakdowns = _build_all_captured_breakdowns(data_dir)
            empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0}
            for h in entries:
                breakdown = breakdowns.get(h.code, empty)
                h.captured_count = breakdown["complete"]
                h.captured_breakdown = breakdown
            _cache = entries
            _fetched_at_ms = None
            # 시드는 "낡았을 수 있는 진짜 카탈로그" 다 — fresh 가 아니라 stale.
            _state = SymbolCacheState.stale(reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED)
            _loaded_schema_version = None
            return
        _cache = []
        _fetched_at_ms = None
        _state = SymbolCacheState.unavailable(reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED)
        _loaded_schema_version = None
        return
    entries, fetched_at_ms, schema_version = result
    breakdowns = _build_all_captured_breakdowns(data_dir)
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0}
    for h in entries:
        breakdown = breakdowns.get(h.code, empty)
        h.captured_count = breakdown["complete"]
        h.captured_breakdown = breakdown
    _cache = entries
    _fetched_at_ms = fetched_at_ms
    _state = SymbolCacheState.fresh()
    _loaded_schema_version = schema_version


def current_status() -> str:
    """Boot helper — current cache status without building a full response."""
    return _state.status


def needs_boot_refresh() -> bool:
    """§4.4 boot policy, owned HERE (not at the lifespan call site): schedule
    the background .mst auto-refresh when the cache is unavailable OR a
    legacy-schema file was accepted (serve the old catalog now, converge to
    the current schema online)."""
    # PR-I(#1045): `stale` 도 포함한다. 시드 부팅이 그 상태를 만드는데, 시드는
    # 정의상 낡았으므로 온라인에서 수렴시켜야 한다.
    if _state.status in {"unavailable", "stale"}:
        return True
    return _loaded_schema_version is not None and _loaded_schema_version < SCHEMA_VERSION


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
    """POST /api/symbols/refresh — the only .mst fetch entry point.

    No credentials gate — the .mst is a static no-auth download (SPEC §7).
    Concurrency: _refresh_coordinator dedupes simultaneous clicks.
    """
    def _start_refresh_task() -> asyncio.Task[SymbolsAllResponse]:
        global _state  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
        _state = SymbolCacheState.loading()
        return asyncio.create_task(_do_refresh(path=path, data_dir=data_dir))

    return await _refresh_coordinator.coalesce(_start_refresh_task)


async def aclose_refresh() -> None:
    """Lifespan shutdown hook — cancel+await any in-flight .mst refresh worker.

    The refresh worker is coordinator-owned (decoupled from its callers), so
    cancelling the ``symbols-boot-refresh`` initiator task no longer stops it.
    The lifespan calls this before KIS/scheduler teardown so a mid-flight
    worker can't run on past process shutdown. No-op when idle.
    """
    await _refresh_coordinator.aclose()


def _set_stale_or_unavailable(reason: UpstreamCode) -> None:
    """Pick stale vs unavailable based on whether the cache has prior data."""
    global _state  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
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
    ``loading()`` even when an unexpected exception (e.g. ``OSError`` from
    a filesystem walk) escapes the typed handlers above.
    """
    global _cache, _fetched_at_ms, _state  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    try:
        try:
            entries = await _fetch_symbol_master()
        except KiwoomMasterFetchError:
            _set_stale_or_unavailable(UpstreamCode.MASTER_FETCH_FAILED)
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
        empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0}
        for h in entries:
            breakdown = breakdowns.get(h.code, empty)
            h.captured_count = breakdown["complete"]
            h.captured_breakdown = breakdown
        _cache = entries
        _fetched_at_ms = now_ms
        _state = SymbolCacheState.fresh()
        return _build_response()
    except Exception:  # safety net so _state never sticks at loading()
        logger.exception("Symbol refresh failed unexpectedly")
        _set_stale_or_unavailable(UpstreamCode.MASTER_FETCH_FAILED)
        return _build_response()


def search(q: str, *, limit: int = 20) -> list[SymbolHit]:
    """Pure in-memory filter — caller is expected to have already populated
    the cache via :func:`get_all`.

    Numeric prefix → code match. Otherwise → name substring match.
    Sort: name-prefix matches before substring matches, then by name length.
    """
    q_norm = q.strip()
    if not q_norm:
        return list(_cache)[:limit]
    if q_norm.isdigit():
        # Code prefix
        matches = [h for h in _cache if h.code.startswith(q_norm)]
        return matches[:limit]
    # Name substring (case-insensitive)
    q_lower = q_norm.lower()
    matches = [h for h in _cache if q_lower in h.name.lower()]
    matches.sort(key=lambda h: (not h.name.lower().startswith(q_lower), len(h.name)))
    return matches[:limit]


def all_etf_etn_codes() -> frozenset[str] | None:
    """마스터 전체의 etf/etn 코드 집합. 마스터 미로드면 ``None`` — "ETF 제외" SSOT.

    증권그룹구분코드 EF(ETF)/EN(ETN) 판별은 실 .mst 대조로 사실상 100% 정확
    (단일종목 레버리지·해외물 포함, ETF/ETN 은 전량 KOSPI — 코스닥엔 부재).
    마스터에 없는 코드는 미포함 — 일반주로 간주해 통과시킨다(리츠·펀드 등 scope
    밖 종목은 파서가 드롭하므로 여기서 조회 실패 → 유지, 사용자 결정은 ETF+ETN
    만 제외).

    ``None`` 과 빈 집합을 **구분**하는 것이 이 시그니처의 요점이다. 이전 판은
    캐시가 비어도 빈 집합을 돌려줘, 마스터 다운로드가 실패한 부팅에서 "ETF 제외"
    토글이 켜진 채 **조용히 아무것도 거르지 않았다**(fail-open, 사용자·UI 어디에도
    신호 없음). None = 판정 불가이므로 호출처가 경고를 띄우거나 폴백을 고를 수 있다.

    _cache(≈4천행) 1회 순회 — 순위는 TTL 캐시 뒤, 스캔은 요청당 1회라 저빈도."""
    if not _cache:
        return None
    return frozenset(h.code for h in _cache if h.security_type in ("etf", "etn"))


def nxt_enabled_by_code() -> dict[str, bool | None] | None:
    """``code`` → NXT 상장 여부. 마스터 미로드면 ``None``.

    **키의 부재와 값 ``None`` 을 둘 다 "모름"으로 읽어야 한다** — 마스터에 없는 코드
    (신규 상장·스코프 밖)는 키가 없고, 있는데 `nxtEnable` 을 못 받은 행은 값이 None
    이다. 둘 다 `False`(미상장 확정)와 구분된다. `all_etf_etn_codes` 와 같은 규율:
    판정 불가를 빈 결과로 뭉개면 호출처가 fail-open 인지 fail-closed 인지 못 고른다.

    구독 파생(`live.coverage.subscription_venues`)이 종목당 호출하므로 **맵을 한 번
    만들어 넘긴다** — `search()` 를 코드마다 부르면 4천 행 스캔이 종목 수만큼 반복된다.

    _cache(≈4천행) 1회 순회 — 호출은 정합화 패스당 1회(30s)라 저빈도.
    """
    if not _cache:
        return None
    return {h.code: h.nxt_enabled for h in _cache}


def all_listed_rows() -> list[tuple[str, str, str, bool]] | None:
    """마스터 전체를 ``(code, name, market, is_etf)`` 로. 미로드면 ``None``.

    스크리너 로스터(stocks.parquet)를 최신 상장 목록에 맞추는 데 쓴다. 그 파일은
    외부 DB 에서 수동 1회 시드된 스냅샷이라 **신규 상장을 영영 모른다** — 그리고
    일봉 갱신 대상 목록이 바로 그 파일에서 나오므로(screener._build_plan), 로스터에
    없는 종목은 봉을 받지도 못하고 따라서 스크리너에 나타날 수도 없다. 실측
    2026-08-03: 마스터에만 있는 일반주 **79 종목**이 그 상태였다.

    ``all_etf_etn_codes`` 와 같은 규칙으로 ``None`` 과 빈 목록을 구분한다 —
    마스터 다운로드가 실패한 부팅에서 "상장 종목이 0개"로 읽히면 호출처가 로스터를
    비우는 파괴적 오작동을 할 수 있다.
    """
    if not _cache:
        return None
    return [
        (h.code, h.name, h.market, h.security_type in ("etf", "etn"))
        for h in _cache
    ]


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
