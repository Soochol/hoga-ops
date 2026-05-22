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
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Query

from hoga.api.disk_state import DiskState, check_disk_state
from hoga.api.error_codes import UpstreamCode
from hoga.api.models import SymbolHit, SymbolsAllResponse
from hoga.env import krx_creds_present, load_env

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


# Module-level state (per ADR-0006 single-module pattern, scoped to symbols.py).
_cache: list[SymbolHit] = []
_fetched_at_ms: int | None = None
_state: SymbolCacheState = SymbolCacheState.loading()
_lock = asyncio.Lock()
_inflight: asyncio.Future | None = None
SCHEMA_VERSION = 1


def reset_state_for_tests() -> None:
    global _cache, _fetched_at_ms, _state, _inflight  # noqa: PLW0603
    _cache, _fetched_at_ms, _state, _inflight = [], None, SymbolCacheState.loading(), None


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


async def _fetch_from_pykrx() -> list[SymbolHit]:
    """Override in tests. Production implementation calls pykrx directly.

    CRITICAL: uses ``pykrx.stock.get_market_cap(date, market=...)`` which returns
    a DataFrame containing both ticker codes (index) AND names (``종목명`` column)
    in ONE call per market. The naive N=6000 sequential ``get_market_ticker_name``
    approach would take ~10 minutes at boot — this version takes ~2 seconds.
    """
    from pykrx import stock

    loop = asyncio.get_running_loop()
    today = time.strftime("%Y%m%d")

    def _scrape() -> list[tuple[str, str, str]]:
        rows: list[tuple[str, str, str]] = []
        for market in ("KOSPI", "KOSDAQ"):
            df = stock.get_market_cap(today, market=market)  # ONE call returns code+name
            for code in df.index:
                name = str(df.loc[code, "종목명"])
                rows.append((str(code), name, market))
        return rows

    rows = await loop.run_in_executor(None, _scrape)
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

    A per-symbol bucketing pass called from :func:`_do_fetch_and_populate`
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


async def _do_fetch_and_populate(data_dir: Path) -> None:
    """Inner helper — runs under in-flight Future protection."""
    global _cache, _fetched_at_ms, _state  # noqa: PLW0603

    # Pre-check: deterministically classify "missing credentials" without
    # depending on pykrx's exception-message format (which can drift across
    # versions). Also saves the network round-trip when creds are absent.
    if not krx_creds_present():
        _state = (
            SymbolCacheState.stale(reason=UpstreamCode.KRX_CREDENTIALS_MISSING)
            if _cache
            else SymbolCacheState.unavailable(reason=UpstreamCode.KRX_CREDENTIALS_MISSING)
        )
        return

    try:
        hits = await _fetch_from_pykrx()
    except Exception:  # noqa: BLE001 — pykrx failure path (preserved)
        _state = (
            SymbolCacheState.stale(reason=UpstreamCode.KRX_FETCH_FAILED)
            if _cache
            else SymbolCacheState.unavailable(reason=UpstreamCode.KRX_FETCH_FAILED)
        )
        return

    # Single-pass walk → {code: breakdown}; assign per symbol.
    loop = asyncio.get_running_loop()
    breakdowns = await loop.run_in_executor(None, _build_all_captured_breakdowns, data_dir)
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
    for h in hits:
        breakdown = breakdowns.get(h.code, empty)
        h.captured_count = breakdown["complete"]
        h.captured_breakdown = breakdown
    _cache = hits
    _fetched_at_ms = int(time.time() * 1000)
    _state = SymbolCacheState.fresh()


async def get_all(*, data_dir: Path) -> SymbolsAllResponse:
    """Tier 2: GET-time lock + Future dedupe.

    N concurrent calls share one underlying fetch.
    """
    global _inflight, _state  # noqa: PLW0603
    async with _lock:
        if _inflight is None:
            # Downgrade to loading only when there's no cache to serve.
            if not _cache:
                _state = SymbolCacheState.loading()
            loop = asyncio.get_running_loop()
            _inflight = loop.create_future()
            fetch_task = asyncio.create_task(_do_fetch_and_populate(data_dir))

            def _signal(_t: asyncio.Task) -> None:
                if _inflight is not None and not _inflight.done():
                    _inflight.set_result(None)

            fetch_task.add_done_callback(_signal)
        fut = _inflight
    await fut
    async with _lock:
        _inflight = None
    return SymbolsAllResponse(
        symbols=list(_cache),
        status=_state.status,
        fetched_at_ms=_fetched_at_ms,
        reason=_state.reason,
    )


async def refresh(*, data_dir: Path) -> SymbolsAllResponse:
    """POST /api/symbols/refresh — force a synchronous re-fetch.

    load_env(override=True) runs under _lock so the os.environ mutation
    and the _fetched_at_ms reset share one critical section. The inflight
    Future dedupe inside get_all() collapses concurrent refresh storms to
    one pykrx call.
    """
    global _fetched_at_ms  # noqa: PLW0603
    async with _lock:
        load_env(override=True)
        _fetched_at_ms = None
    return await get_all(data_dir=data_dir)


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


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/symbols", tags=["symbols"])

    @router.get("/all")
    async def get_all_route() -> SymbolsAllResponse:
        return await get_all(data_dir=data_dir)

    @router.get("")
    async def search_route(
        q: str = Query("", min_length=0),
        limit: int = Query(20, ge=1, le=100),
    ) -> list[SymbolHit]:
        # If cache empty, populate first.
        if not _cache:
            await get_all(data_dir=data_dir)
        return search(q, limit=limit)

    @router.post("/refresh")
    async def refresh_route() -> SymbolsAllResponse:
        return await refresh(data_dir=data_dir)

    return router
