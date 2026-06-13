"""Disk cache for 1-minute /api/range hoga indicators (호가비 · 체결강도).

The candle-parallel cache (ADR draft 2026-06-11). `/api/range` recomputes the
bucketed quote_ratio / fill_strength from the raw snapshots/trades parquet on
every request — for a liquid stock that is ~5.7 MB/day re-read + re-bucketed per
pan step, the dominant /live deep-scroll backfill cost (511–989 ms scaling with
depth). The computed result is only ~60 KB/day and, for a completed past day, is
IMMUTABLE — so it is cached exactly like past candles
(`kis-past-candles/<code>/<date>.json`):

    <data_dir>/kis-past-indicators/<code>/<source>/<YYYYMMDD>.<kind>.json

Stored at 1-minute granularity; coarser timeframes re-aggregate on read
(`indicator_reaggregate`, proven equal to a direct `bucket_ms=N` query). The key
is **(code, date, source)** — bucket_ms is NOT in the key (re-aggregation covers
it) but `source` IS (a day has both hogaplay and kis_live slices, chosen by
`_resolve_source`; serving the wrong one would be a silent data swap).

Past-only by construction: the caller gates `date < today_kst` before touching
this cache. Today's snapshots are still being promoted (ADR-0043), so today must
recompute live and is never persisted here — no today/TTL layer (unlike
`PastCandlesCache`, whose today memory cache exists to spare KIS calls; indicator
recompute is a local read with no external quota).
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from hoga.api._atomic_write import atomic_write_json
from hoga.tables.snapshots import QuoteRatioRow
from hoga.tables.trades import FillStrengthRow

if TYPE_CHECKING:
    from hoga.api.models import AskPeak

_log = logging.getLogger(__name__)

# Bump when the bucketing/representative semantics of the underlying table
# queries change, so stale 1m caches are ignored rather than served wrong.
SCHEMA_VERSION = 1

Kind = Literal["ratio", "fill"]


class PastIndicatorsCache:
    """Disk-backed cache of 1-minute quote_ratio / fill_strength rows, keyed by
    (code, date, source). Past dates only — today is recomputed by the caller."""

    def __init__(self, data_dir: Path):
        self._data_dir = data_dir
        # In-memory hot cache (avoids re-reading disk within a process).
        self._mem_ratio: dict[tuple[str, str, str], list[QuoteRatioRow]] = {}
        self._mem_fill: dict[tuple[str, str, str], list[FillStrengthRow]] = {}
        # 매도 최대벽 — 값이 작고 과거일 불변이라 in-memory만(디스크 미사용). None도 유효한
        # 캐시 값(데이터 없는 날)이라 has_/get_ 분리로 미스 구분.
        self._mem_ask_peak: dict[tuple[str, str, str], "AskPeak | None"] = {}

    def _path(self, code: str, date: str, source: str, kind: Kind) -> Path:
        return self._data_dir / "kis-past-indicators" / code / source / f"{date}.{kind}.json"

    # ── ratio (호가비) ─────────────────────────────────────────────────────────

    def get_ratio(self, code: str, date: str, source: str) -> list[QuoteRatioRow] | None:
        key = (code, date, source)
        hit = self._mem_ratio.get(key)
        if hit is not None:
            return hit
        triples = self._read(code, date, source, "ratio")
        if triples is None:
            return None
        rows = [
            QuoteRatioRow(bucket_intra_ms=t[0], bid_total=t[1], ask_total=t[2]) for t in triples
        ]
        self._mem_ratio[key] = rows
        return rows

    def store_ratio(self, code: str, date: str, source: str, rows: list[QuoteRatioRow]) -> None:
        triples = [[r.bucket_intra_ms, r.bid_total, r.ask_total] for r in rows]
        self._write(code, date, source, "ratio", triples)
        self._mem_ratio[(code, date, source)] = rows

    # ── fill (체결강도) ────────────────────────────────────────────────────────

    def get_fill(self, code: str, date: str, source: str) -> list[FillStrengthRow] | None:
        key = (code, date, source)
        hit = self._mem_fill.get(key)
        if hit is not None:
            return hit
        triples = self._read(code, date, source, "fill")
        if triples is None:
            return None
        rows = [
            FillStrengthRow(bucket_intra_ms=t[0], buy_qty=t[1], sell_qty=t[2]) for t in triples
        ]
        self._mem_fill[key] = rows
        return rows

    def store_fill(self, code: str, date: str, source: str, rows: list[FillStrengthRow]) -> None:
        triples = [[r.bucket_intra_ms, r.buy_qty, r.sell_qty] for r in rows]
        self._write(code, date, source, "fill", triples)
        self._mem_fill[(code, date, source)] = rows

    # ── ask_peak (매도 최대벽) — in-memory only ────────────────────────────────

    def has_ask_peak(self, code: str, date: str, source: str) -> bool:
        return (code, date, source) in self._mem_ask_peak

    def get_ask_peak(self, code: str, date: str, source: str) -> "AskPeak | None":
        return self._mem_ask_peak.get((code, date, source))

    def store_ask_peak(self, code: str, date: str, source: str, peak: "AskPeak | None") -> None:
        self._mem_ask_peak[(code, date, source)] = peak

    # ── disk I/O ──────────────────────────────────────────────────────────────

    def _read(self, code: str, date: str, source: str, kind: Kind) -> list[list[int]] | None:
        p = self._path(code, date, source, kind)
        if not p.exists():
            return None
        try:
            body = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", p, exc_info=True)
            return None
        if body.get("version") != SCHEMA_VERSION:
            # Semantics changed under an old file — ignore; next store heals it.
            return None
        rows = body.get("rows")
        return rows if isinstance(rows, list) else None

    def _write(self, code: str, date: str, source: str, kind: Kind, rows: list[list[int]]) -> None:
        path = self._path(code, date, source, kind)
        payload = {
            "version": SCHEMA_VERSION, "rows": rows, "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(path, payload)
        except OSError:
            # A cache write failure must never break the response — the value was
            # already computed and returned; the next request recomputes + retries.
            _log.warning("past_indicators_cache.write_failed path=%s", path, exc_info=True)
