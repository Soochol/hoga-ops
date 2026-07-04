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
from typing import TYPE_CHECKING, Literal, TypeVar

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import AskPeak, BidPeak, TradeVolumePoc
from hoga.tables.snapshots import QuoteRatioRow
from hoga.tables.trades import FillStrengthRow

if TYPE_CHECKING:
    from pydantic import BaseModel

_log = logging.getLogger(__name__)

# Bump when the bucketing/representative semantics of the underlying table
# queries change, so stale 1m caches are ignored rather than served wrong.
SCHEMA_VERSION = 3

Kind = Literal["ratio", "fill"]
_CACHE_MISS = object()
CACHE_MISS = _CACHE_MISS
_ModelT = TypeVar("_ModelT", bound="BaseModel")


class PastIndicatorsCache:
    """Disk-backed cache of 1-minute quote_ratio / fill_strength rows, keyed by
    (code, date, source). Past dates only — today is recomputed by the caller."""

    def __init__(self, data_dir: Path):
        self._data_dir = data_dir
        # In-memory hot cache (avoids re-reading disk within a process).
        self._mem_ratio: dict[tuple[str, str, str], list[QuoteRatioRow]] = {}
        self._mem_fill: dict[tuple[str, str, str], list[FillStrengthRow]] = {}
        # None is a valid cached result for empty/no-data days, so has_/get_
        # remain separate for peak caches.
        self._mem_ask_peak: dict[tuple[str, str, str, int], AskPeak | None] = {}
        self._mem_bid_peak: dict[tuple[str, str, str, int], BidPeak | None] = {}
        self._mem_trade_volume_poc: dict[
            tuple[str, str, str, int, int, int], TradeVolumePoc | None
        ] = {}

    def _path(self, code: str, date: str, source: str, kind: Kind) -> Path:
        return self._data_dir / "kis-past-indicators" / code / source / f"{date}.{kind}.json"

    # ── ratio (호가비) ─────────────────────────────────────────────────────────

    def get_ratio(self, code: str, date: str, source: str) -> list[QuoteRatioRow] | None:
        key = (code, date, source)
        hit = self._mem_ratio.get(key)
        if hit is not None:
            return hit
        tuples = self._read(code, date, source, "ratio")
        if tuples is None:
            return None
        rows = [
            QuoteRatioRow(
                bucket_intra_ms=t[0], bid_total=t[1], ask_total=t[2],
                bid_max=t[3], ask_max=t[4], imb_max_bid=t[5], imb_max_ask=t[6],
            )
            for t in tuples
        ]
        self._mem_ratio[key] = rows
        return rows

    def store_ratio(self, code: str, date: str, source: str, rows: list[QuoteRatioRow]) -> None:
        tuples = [
            [r.bucket_intra_ms, r.bid_total, r.ask_total,
             r.bid_max, r.ask_max, r.imb_max_bid, r.imb_max_ask]
            for r in rows
        ]
        self._write(code, date, source, "ratio", tuples)
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

    # ── ask/bid peak (매도/매수 최대벽) ───────────────────────────────────────

    def _model_path(
        self,
        code: str,
        date: str,
        source: str,
        suffix: str,
    ) -> Path:
        return self._data_dir / "kis-past-indicators" / code / source / f"{date}.{suffix}.json"

    def _peak_path(self, code: str, date: str, source: str, kind: Literal["ask_peak", "bid_peak"], bucket_ms: int) -> Path:
        return self._model_path(code, date, source, f"{kind}.{bucket_ms}")

    def _poc_path(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int,
    ) -> Path:
        return self._model_path(
            code,
            date,
            source,
            f"trade_volume_poc.{range_count}.{price_min}.{price_max}",
        )

    def _read_model_cache(
        self,
        path: Path,
        model_type: type[_ModelT],
    ) -> _ModelT | None | object:
        if not path.exists():
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            return _CACHE_MISS
        if body.get("version") != SCHEMA_VERSION:
            return _CACHE_MISS
        value = body.get("value")
        if value is None:
            return None
        try:
            return model_type.model_validate(value)
        except ValueError:
            _log.warning("past_indicators_cache.invalid_model path=%s", path, exc_info=True)
            return _CACHE_MISS

    def _write_model_cache(self, path: Path, value: "BaseModel | None") -> None:
        payload = {
            "version": SCHEMA_VERSION,
            "value": None if value is None else value.model_dump(mode="json"),
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(path, payload)
        except OSError:
            _log.warning("past_indicators_cache.write_failed path=%s", path, exc_info=True)

    def has_ask_peak(self, code: str, date: str, source: str, bucket_ms: int) -> bool:
        key = (code, date, source, bucket_ms)
        if key in self._mem_ask_peak:
            return True
        value = self._read_model_cache(
            self._peak_path(code, date, source, "ask_peak", bucket_ms),
            AskPeak,
        )
        if value is _CACHE_MISS:
            return False
        self._mem_ask_peak[key] = value  # type: ignore[assignment]
        return True

    def get_ask_peak(self, code: str, date: str, source: str, bucket_ms: int) -> AskPeak | None:
        key = (code, date, source, bucket_ms)
        if key in self._mem_ask_peak:
            return self._mem_ask_peak[key]
        value = self._read_model_cache(
            self._peak_path(code, date, source, "ask_peak", bucket_ms),
            AskPeak,
        )
        if value is _CACHE_MISS:
            return None
        self._mem_ask_peak[key] = value  # type: ignore[assignment]
        return self._mem_ask_peak[key]

    def store_ask_peak(
        self, code: str, date: str, source: str, bucket_ms: int, peak: AskPeak | None
    ) -> None:
        self._mem_ask_peak[(code, date, source, bucket_ms)] = peak
        self._write_model_cache(self._peak_path(code, date, source, "ask_peak", bucket_ms), peak)

    def has_bid_peak(self, code: str, date: str, source: str, bucket_ms: int) -> bool:
        key = (code, date, source, bucket_ms)
        if key in self._mem_bid_peak:
            return True
        value = self._read_model_cache(
            self._peak_path(code, date, source, "bid_peak", bucket_ms),
            BidPeak,
        )
        if value is _CACHE_MISS:
            return False
        self._mem_bid_peak[key] = value  # type: ignore[assignment]
        return True

    def get_bid_peak(self, code: str, date: str, source: str, bucket_ms: int) -> BidPeak | None:
        key = (code, date, source, bucket_ms)
        if key in self._mem_bid_peak:
            return self._mem_bid_peak[key]
        value = self._read_model_cache(
            self._peak_path(code, date, source, "bid_peak", bucket_ms),
            BidPeak,
        )
        if value is _CACHE_MISS:
            return None
        self._mem_bid_peak[key] = value  # type: ignore[assignment]
        return self._mem_bid_peak[key]

    def store_bid_peak(
        self, code: str, date: str, source: str, bucket_ms: int, peak: BidPeak | None
    ) -> None:
        self._mem_bid_peak[(code, date, source, bucket_ms)] = peak
        self._write_model_cache(self._peak_path(code, date, source, "bid_peak", bucket_ms), peak)

    # ── trade_volume_poc ─────────────────────────────────────────────────────

    def get_trade_volume_poc(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int,
    ) -> TradeVolumePoc | None | object:
        key = (code, date, source, range_count, price_min, price_max)
        if key in self._mem_trade_volume_poc:
            return self._mem_trade_volume_poc[key]
        value = self._read_model_cache(
            self._poc_path(code, date, source, range_count, price_min, price_max),
            TradeVolumePoc,
        )
        if value is _CACHE_MISS:
            return _CACHE_MISS
        self._mem_trade_volume_poc[key] = value  # type: ignore[assignment]
        return self._mem_trade_volume_poc[key]

    def store_trade_volume_poc(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int,
        poc: TradeVolumePoc | None,
    ) -> None:
        key = (code, date, source, range_count, price_min, price_max)
        self._mem_trade_volume_poc[key] = poc
        self._write_model_cache(
            self._poc_path(code, date, source, range_count, price_min, price_max),
            poc,
        )

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
