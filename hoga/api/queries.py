"""Cross-table query coordinator. Per-table queries live in ``hoga/tables/``."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.invariants import normalize_session_bounds
from hoga.api.models import StockDate
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.tables import snapshots


def resolve_source_dir(stock_date_dir: Path, source: str) -> Path:
    """Resolve the on-disk parquet dir for one source.

    Tries ``{stock_date_dir}/{source}/`` first (post-migration layout per
    ADR-0037). Falls back to ``{stock_date_dir}/`` (flat, pre-migration)
    only if the source subdir doesn't exist AND the flat dir has a
    meta.json — this preserves backward compatibility with test fixtures
    that build the flat layout directly.
    """
    sub = stock_date_dir / source
    if sub.exists():
        return sub
    if (stock_date_dir / "meta.json").exists():
        return stock_date_dir  # legacy flat layout
    return sub  # return the not-existing source path for the error to surface naturally


@dataclass(frozen=True, slots=True)
class _CachedStockDate:
    """Cache entry pairing a meta.json mtime fingerprint with the built StockDate.

    Keyed in QueryEngine._stock_date_cache by (date, code). Validity is
    checked by re-stat()ing meta.json on every list_stock_dates call —
    the filesystem is the source of truth; this struct just avoids the
    DuckDB + JSON parse work when nothing on disk has changed.
    """
    meta_mtime_ns: int
    value: StockDate


class StockDateNotFound(LookupError):
    """No parquet directory for (date, code)."""


class QueryEngine:
    """Owns the shared DuckDB connection; exposes cross-table queries (inventory + meta).

    Per-table queries (orderbook, trades, candles, brokers) live in the table
    modules and are called by routes.py directly with this engine's connection.
    """

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._conn = duckdb.connect(database=":memory:", read_only=False)
        # Per-call mtime-validated cache for list_stock_dates. See
        # _CachedStockDate docstring; keyed by (date, code).
        self._stock_date_cache: dict[tuple[str, str], _CachedStockDate] = {}

    def close(self) -> None:
        self._conn.close()

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        # Returns a fresh cursor per access. DuckDB's parent connection is
        # NOT thread-safe — concurrent .execute() from FastAPI's sync-route
        # thread pool would race on the shared connection state and crash
        # the process under modest load (verified 2026-05-23 with 30
        # concurrent read-path requests). Each cursor() call creates an
        # independent connection over the same in-memory database, so
        # callers can read in parallel without contention. Cursors are
        # cheap and GC'd as soon as the call expression ends.
        return self._conn.cursor()

    def parquet_dir(self, date: str, code: str, source: str = "hogaplay") -> Path:
        sd_dir = self.data_dir / "parquet" / date / code
        if not sd_dir.exists():
            raise StockDateNotFound(f"{date}/{code}")
        resolved = resolve_source_dir(sd_dir, source)
        # Verify a meta.json actually lives at the resolved path. Bare existence
        # of the Stock-Date dir isn't enough — could be an empty post-migration
        # shell without the requested source.
        if not (resolved / "meta.json").exists():
            raise StockDateNotFound(f"{date}/{code}/{source}")
        return resolved

    def list_stock_dates(self) -> list[StockDate]:
        base = self.data_dir / "parquet"
        if not base.exists():
            # Disk gone entirely — drop the whole cache rather than
            # quietly hoarding stale entries until the next call sees
            # the same empty result.
            self._stock_date_cache.clear()
            return []
        out: list[StockDate] = []
        seen_keys: set[tuple[str, str]] = set()
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            for code_dir in sorted(date_dir.iterdir()):
                if not code_dir.is_dir():
                    continue
                code = code_dir.name
                # Find the "winning" meta.json: prefer hogaplay/, fall back to
                # other source subdirs, then flat layout.
                meta_path = self._find_winning_meta(code_dir)
                if meta_path is None:
                    continue
                try:
                    mtime_ns = meta_path.stat().st_mtime_ns
                except FileNotFoundError:
                    continue
                key = (date, code)
                seen_keys.add(key)
                # Single .get() — must not be replaced by `key in cache`
                # then `cache[key]` (two ops). The spec mandates a single
                # atomic dict op so a racing prune cannot null the entry
                # between the check and the read.
                cached = self._stock_date_cache.get(key)
                if cached is not None and cached.meta_mtime_ns == mtime_ns:
                    out.append(cached.value)
                    continue
                # _compute_stock_date wants the dir containing the parquet files,
                # which is the source dir or the flat dir — same as meta_path.parent.
                # Wrap in try/except: a parquet with a non-hogaplay schema
                # (e.g. partially-migrated state) would raise a DuckDB
                # BinderException; we'd rather skip the row than 500 the whole
                # inventory endpoint.
                try:
                    sd = self._compute_stock_date(date, code, meta_path.parent)
                except Exception:  # noqa: BLE001
                    seen_keys.discard(key)
                    continue
                self._stock_date_cache[key] = _CachedStockDate(
                    meta_mtime_ns=mtime_ns, value=sd
                )
                out.append(sd)
        # Snapshot iteration via list() — safe against concurrent inserts
        # from another threadpool worker. pop(..., None) instead of del
        # because a concurrent pruner may have already removed the same
        # vanished key.
        for k in list(self._stock_date_cache.keys()):
            if k not in seen_keys:
                self._stock_date_cache.pop(k, None)
        return out

    @staticmethod
    def _find_winning_meta(code_dir: Path) -> Path | None:
        """Find the meta.json to use for inventory display.

        Returns the hogaplay/meta.json if present, else the flat-layout
        meta.json (pre-migration), else None. kis_live is intentionally
        EXCLUDED — its snapshots.parquet uses `t_ms` (Unix ms) while
        the inventory readers assume hogaplay's `ts_ms` (HHMMSSmmm) and
        the underlying `_compute_stock_date` shape that ApiCandle /
        snapshot path emit. A kis_live-only Stock-Date is therefore
        invisible to the Inventory page; users see kis_live data on
        /live and (via Source Preference) on /replay instead.
        """
        candidate = code_dir / "hogaplay" / "meta.json"
        if candidate.exists():
            return candidate
        flat = code_dir / "meta.json"
        if flat.exists():
            return flat
        return None

    def _compute_stock_date(
        self, date: str, code: str, code_dir: Path
    ) -> StockDate:
        """Build a StockDate row from on-disk parquet for one (date, code).

        Caller has already verified that code_dir/meta.json exists.
        Reads meta.json + snapshots.parquet bounds + candles.parquet
        price/volume aggregates + dir stat() for captured_at and total size.
        """
        meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
        _state = classify_from_meta(meta).state          # original meta; warn note discarded (StockDate has no warn field)
        norm_meta, _ = normalize_session_bounds(meta)    # value-conversion only
        snap_path = code_dir / "snapshots.parquet"
        # snapshots.ts_ms is stored as HHMMSSmmm (per existing tests
        # asserting e.g. ts_ms == 90010435). Convert to Unix ms here.
        bounds = (
            snapshots.query_time_bounds(self.conn, path=snap_path)
            if snap_path.exists()
            else None
        )
        open_ms = hhmmssms_to_unix_ms(date, norm_meta["regular_session_open_ms"])
        close_ms = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])
        if bounds is not None:
            first_ms = hhmmssms_to_unix_ms(date, bounds[0])
            last_ms = hhmmssms_to_unix_ms(date, bounds[1])
        else:
            first_ms = open_ms
            last_ms = close_ms

        # Price range + total volume from candles.parquet.
        candles_path = code_dir / "candles.parquet"
        if candles_path.exists():
            row = self.conn.execute(
                "SELECT MIN(low), MAX(high), "
                "COALESCE(SUM(CAST(vol_a AS BIGINT) + CAST(vol_b AS BIGINT)), 0) "
                "FROM read_parquet(?)",
                [str(candles_path)],
            ).fetchone()
            if row is None or row[0] is None:
                price_min = 0
                price_max = 0
                total_volume = 0
            else:
                price_min = int(row[0])
                price_max = int(row[1])
                total_volume = int(row[2])
        else:
            price_min = 0
            price_max = 0
            total_volume = 0

        # Stock-Date dirs are flat by construction (parse_stock_date emits
        # only top-level parquet/meta files), so non-recursive iteration is
        # sufficient and intentional here.
        files = [p for p in code_dir.iterdir() if p.is_file()]
        captured_at = (
            int(max(p.stat().st_mtime for p in files) * 1000) if files else 0
        )
        file_size_bytes = sum(p.stat().st_size for p in files)

        return StockDate(
            date=date,
            code=code,
            name=meta["name"],
            regular_session_open_ms=open_ms,
            regular_session_close_ms=close_ms,
            data_window_first_ms=first_ms,
            data_window_last_ms=last_ms,
            price_min=price_min,
            price_max=price_max,
            captured_at=captured_at,
            total_volume=total_volume,
            pages_collected=int(meta["pages_collected"]),
            file_size_bytes=file_size_bytes,
            today_open=int(meta["today_open"]),
            today_high=int(meta["today_high"]),
            today_low=int(meta["today_low"]),
            today_close=int(meta["today_close"]),
            # Single source of truth for meta → completeness bits.
            # The DiskState enum normalizes the rule "if collection
            # didn't finish, is_partial is True regardless of what
            # meta says" — see classify_from_meta docstring.
            collection_complete=_state in (
                DiskState.COMPLETE, DiskState.SOURCE_PARTIAL,
            ),
            is_partial=_state in (
                DiskState.SOURCE_PARTIAL, DiskState.CLIENT_INCOMPLETE,
            ),
            full_capture_count=meta.get("full_capture_count"),
            # ADR-0020: surface the full enum so consumers can
            # see INVALID — the boolean pair above flattens it.
            disk_state=_state.value,
        )

    def get_meta(self, date: str, code: str, source: str = "hogaplay") -> dict[str, Any]:
        path = self.parquet_dir(date, code, source) / "meta.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def list_stock_dates_in_range(
        self, *, code: str, from_date: str, to_date: str,
        source_pref: str = "hogaplay",
    ) -> list[str]:
        """Ascending list of captured YYYYMMDD strings for ``code`` in [from_date, to_date].

        Filters the parquet inventory by code and inclusive date range. Compares
        as YYYYMMDD strings — lexical order matches calendar order for that format.
        Returns ``[]`` when no Stock-Date matches (caller maps to HTTP 404).

        Matches if EITHER the preferred source has meta.json OR any source does
        (ADR-0039: preference + fallback). Includes legacy flat layout.
        """
        base = self.data_dir / "parquet"
        if not base.exists():
            return []
        out: list[str] = []
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            if date < from_date or date > to_date:
                continue
            code_dir = date_dir / code
            if not code_dir.is_dir():
                continue
            # Preferred source first
            if (code_dir / source_pref / "meta.json").exists():
                out.append(date)
                continue
            # Legacy flat layout
            if (code_dir / "meta.json").exists():
                out.append(date)
                continue
            # Any other source subdir
            for src_dir in code_dir.iterdir():
                if src_dir.is_dir() and (src_dir / "meta.json").exists():
                    out.append(date)
                    break
        return out
