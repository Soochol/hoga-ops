"""Disk cache for 1-minute /api/range hoga indicators (호가비 · 체결강도).

The candle-parallel cache (ADR draft 2026-06-11). `/api/range` recomputes the
bucketed quote_ratio / fill_strength from the raw snapshots/trades parquet on
every request — for a liquid stock that is ~5.7 MB/day re-read + re-bucketed per
pan step, the dominant /live deep-scroll backfill cost (511–989 ms scaling with
depth). The computed result is only ~60 KB/day and, for a completed past day, is
IMMUTABLE — so it is cached under this module's indicator store path:

    <data_dir>/kis-past-indicators/<code>/<source>/<YYYYMMDD>.<kind>.json

This branch keeps KIS minute/day candle caches in memory only; legacy
`kis-past-candles/<code>/<date>.json` artifacts are not runtime cache input.

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
from collections.abc import Sequence
from collections import OrderedDict
from pathlib import Path
from typing import TYPE_CHECKING, Literal, TypeVar

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    AskPeak,
    BidPeak,
    BrokerLateEntryEvent,
    DayVolumeDistribution,
    DepthDeltaPoint,
    DepthHeatmapPoint,
    TradeVolumePoc,
)
from hoga.tables.snapshots import QuoteRatioRow
from hoga.tables.trades import FillStrengthRow
from hoga.util.cache_stats import CacheStats

if TYPE_CHECKING:
    from pydantic import BaseModel

_log = logging.getLogger(__name__)

# Kind별 스키마 버전. 어떤 kind의 bucketing/대표 선택 semantics가 바뀌면 **그 kind만**
# 범프한다 — 구 파일은 버전 체크에 걸려 다음 접근 때 투명하게 재계산+재기록된다.
#
# ⚠️ 과거엔 전역 SCHEMA_VERSION 하나였는데, v5→v6 범프(ratio·depth만 의미 변경)가
# 의미 불변 kind(peak 등 7종)까지 무효화해 /study 뷰 첫 로드가 수십 분으로 늘었다
# (2026-07-11 실측: 콜드 비용의 95%+가 peak 재계산, 값은 v5와 동일). kind별 버전은
# 그 재발 방지책이다. 전부 6에서 시작하는 이유: 기존 디스크 파일이 전부 v6이라
# 마이그레이션 없이 호환된다.
#
# 버전 이력(전역 시절): v6 (ADR-0062 v3) 동시호가 배제 통일 — ratio에 개장(session_open)
# 하한 추가, depth heatmap을 WHERE 사전 필터 드롭으로 전환.
KIND_VERSIONS: dict[str, int] = {
    "ratio": 6,
    "fill": 6,
    "ask_peak": 6,
    "bid_peak": 6,
    "poc": 6,
    "depth": 6,
    "depth_delta": 1,
    "vdist": 6,
    "broker_late": 6,
    "continuous_before": 6,
}

Kind = Literal["ratio", "fill"]
DEFAULT_MEM_MAX_ENTRIES = 512
# depth_heatmap 항목은 하루치 40컬럼 × 수백 버킷 ≈ 1.5MB/entry (ratio의 ~20배).
# 공용 512 상한을 그대로 쓰면 최악 수백 MB가 되므로 전용 소형 상한을 둔다 —
# 축출돼도 디스크 read-through라 값은 보존되고 관측 동작은 불변이다.
DEFAULT_DEPTH_MEM_MAX_ENTRIES = 64
_CACHE_MISS = object()
CACHE_MISS = _CACHE_MISS
_ModelT = TypeVar("_ModelT", bound="BaseModel")


class PastIndicatorsCache:
    """Disk-backed cache of 1-minute quote_ratio / fill_strength rows, keyed by
    (code, date, source). Past dates only — today is recomputed by the caller."""

    def __init__(
        self,
        data_dir: Path,
        *,
        mem_max_entries: int = DEFAULT_MEM_MAX_ENTRIES,
        mem_max_depth_entries: int = DEFAULT_DEPTH_MEM_MAX_ENTRIES,
    ):
        self._data_dir = data_dir
        self._mem_max_entries = max(0, int(mem_max_entries))
        self._mem_max_depth_entries = max(0, int(mem_max_depth_entries))
        # In-memory hot cache (avoids re-reading disk within a process).
        # WS4: dict당 LRU 상한 — 축출돼도 디스크 read-through로 값은 보존되므로
        # 관측 가능 동작은 불변, 장수명 프로세스의 메모리만 유계가 된다.
        self._mem_ratio: OrderedDict[tuple[str, str, str], list[QuoteRatioRow]] = OrderedDict()
        self._mem_fill: OrderedDict[tuple[str, str, str], list[FillStrengthRow]] = OrderedDict()
        # None is a valid cached result for empty/no-data days, so has_/get_
        # remain separate for peak caches.
        self._mem_ask_peak: OrderedDict[tuple[str, str, str, int], AskPeak | None] = OrderedDict()
        self._mem_bid_peak: OrderedDict[tuple[str, str, str, int], BidPeak | None] = OrderedDict()
        self._mem_trade_volume_poc: OrderedDict[
            tuple[str, str, str, int, int, int], TradeVolumePoc | None
        ] = OrderedDict()
        # depth_heatmap 은 (code, date, source, bucket_ms) 결과를 그대로 캐시한다.
        # ratio/fill 처럼 1m 저장 후 재집계하지 않는 이유: depth 대표 선택이
        # "연속거래 우선 + 완전-동시호가 버킷 폴백"의 조건부 argmax라, 1m 행에서
        # coarse 대표를 정확히 복원하려면 선택 근거(is_pre)를 함께 저장해야 하기
        # 때문. bucket_ms 별 결과 캐시가 단순·정확하다.
        self._mem_depth: OrderedDict[
            tuple[str, str, str, int], list[DepthHeatmapPoint]
        ] = OrderedDict()
        # depth_delta 는 증감 있는 가격만 담아 depth 보다 훨씬 작다(희소).
        # 공용 512 LRU 편승 — depth 처럼 전용 상한 불필요.
        self._mem_depth_delta: OrderedDict[
            tuple[str, str, str, int], list[DepthDeltaPoint]
        ] = OrderedDict()
        # 체결 분포(단일 모델|None)·거래원 지각진입(리스트)·연속거래 상한(스칼라).
        # 전부 소형이라 공용 512 LRU 편승(depth 처럼 전용 상한 불필요).
        self._mem_vdist: OrderedDict[
            tuple[str, str, str, int, int, int], DayVolumeDistribution | None
        ] = OrderedDict()
        self._mem_broker_late: OrderedDict[
            tuple[str, str, str, int], list[BrokerLateEntryEvent]
        ] = OrderedDict()
        self._mem_continuous_before: OrderedDict[
            tuple[str, str, str, int], int | None
        ] = OrderedDict()
        # Per-kind stats. Peak lookups are accounted on has_*, not get_* — bundle.py
        # calls has_ (the real disk-touching lookup) then get_ (an already-promoted
        # mem re-read); counting both would double-count (advisor #2).
        self._stats: dict[str, CacheStats] = {
            kind: CacheStats()
            for kind in (
                "ratio", "fill", "ask_peak", "bid_peak", "poc", "depth", "depth_delta",
                "vdist", "broker_late", "continuous_before",
            )
        }

    def stats_snapshot(self) -> dict[str, dict[str, int | float | None]]:
        sizes = {
            "ratio": len(self._mem_ratio),
            "fill": len(self._mem_fill),
            "ask_peak": len(self._mem_ask_peak),
            "bid_peak": len(self._mem_bid_peak),
            "poc": len(self._mem_trade_volume_poc),
            "depth": len(self._mem_depth),
            "depth_delta": len(self._mem_depth_delta),
            "vdist": len(self._mem_vdist),
            "broker_late": len(self._mem_broker_late),
            "continuous_before": len(self._mem_continuous_before),
        }
        return {kind: st.snapshot(size=sizes[kind]) for kind, st in self._stats.items()}

    def _mem_put(self, od: OrderedDict, key, value, stats: CacheStats | None = None) -> None:
        od[key] = value
        od.move_to_end(key)
        while len(od) > self._mem_max_entries:
            od.popitem(last=False)
            if stats is not None:
                stats.record_eviction()

    def _path(self, code: str, date: str, source: str, kind: Kind) -> Path:
        return self._data_dir / "kis-past-indicators" / code / source / f"{date}.{kind}.json"

    # ── ratio (호가비) ─────────────────────────────────────────────────────────

    def get_ratio(self, code: str, date: str, source: str) -> list[QuoteRatioRow] | None:
        key = (code, date, source)
        stats = self._stats["ratio"]
        hit = self._mem_ratio.get(key)
        if hit is not None:
            self._mem_ratio.move_to_end(key)
            stats.record_hit()
            return hit
        tuples = self._read(code, date, source, "ratio")
        if tuples is None:
            stats.record_miss()
            return None
        rows = [
            QuoteRatioRow(
                bucket_intra_ms=t[0], bid_total=t[1], ask_total=t[2],
                bid_max=t[3], ask_max=t[4], imb_max_bid=t[5], imb_max_ask=t[6],
            )
            for t in tuples
        ]
        stats.record_disk_hit()
        self._mem_put(self._mem_ratio, key, rows, stats)
        return rows

    def store_ratio(self, code: str, date: str, source: str, rows: list[QuoteRatioRow]) -> None:
        tuples = [
            [r.bucket_intra_ms, r.bid_total, r.ask_total,
             r.bid_max, r.ask_max, r.imb_max_bid, r.imb_max_ask]
            for r in rows
        ]
        self._write(code, date, source, "ratio", tuples)
        stats = self._stats["ratio"]
        stats.record_store()
        self._mem_put(self._mem_ratio, (code, date, source), rows, stats)

    # ── fill (체결강도) ────────────────────────────────────────────────────────

    def get_fill(self, code: str, date: str, source: str) -> list[FillStrengthRow] | None:
        key = (code, date, source)
        stats = self._stats["fill"]
        hit = self._mem_fill.get(key)
        if hit is not None:
            self._mem_fill.move_to_end(key)
            stats.record_hit()
            return hit
        triples = self._read(code, date, source, "fill")
        if triples is None:
            stats.record_miss()
            return None
        rows = [
            FillStrengthRow(bucket_intra_ms=t[0], buy_qty=t[1], sell_qty=t[2]) for t in triples
        ]
        stats.record_disk_hit()
        self._mem_put(self._mem_fill, key, rows, stats)
        return rows

    def store_fill(self, code: str, date: str, source: str, rows: list[FillStrengthRow]) -> None:
        triples = [[r.bucket_intra_ms, r.buy_qty, r.sell_qty] for r in rows]
        self._write(code, date, source, "fill", triples)
        stats = self._stats["fill"]
        stats.record_store()
        self._mem_put(self._mem_fill, (code, date, source), rows, stats)

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
        *,
        kind: str,
    ) -> _ModelT | None | object:
        if not path.exists():
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            return _CACHE_MISS
        if body.get("version") != KIND_VERSIONS[kind]:
            return _CACHE_MISS
        value = body.get("value")
        if value is None:
            return None
        try:
            return model_type.model_validate(value)
        except ValueError:
            _log.warning("past_indicators_cache.invalid_model path=%s", path, exc_info=True)
            return _CACHE_MISS

    def _write_model_cache(self, path: Path, value: "BaseModel | None", *, kind: str) -> None:
        payload = {
            "version": KIND_VERSIONS[kind],
            "value": None if value is None else value.model_dump(mode="json"),
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(path, payload)
        except OSError:
            _log.warning("past_indicators_cache.write_failed path=%s", path, exc_info=True)

    def has_ask_peak(self, code: str, date: str, source: str, bucket_ms: int) -> bool:
        key = (code, date, source, bucket_ms)
        stats = self._stats["ask_peak"]
        if key in self._mem_ask_peak:
            stats.record_hit()
            return True
        value = self._read_model_cache(
            self._peak_path(code, date, source, "ask_peak", bucket_ms),
            AskPeak,
            kind="ask_peak",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return False
        stats.record_disk_hit()
        self._mem_put(self._mem_ask_peak, key, value, stats)  # type: ignore[arg-type]
        return True

    def get_ask_peak(self, code: str, date: str, source: str, bucket_ms: int) -> AskPeak | None:
        # Lookup accounted on has_ask_peak (the guarding call); get_ is a mem re-read.
        key = (code, date, source, bucket_ms)
        if key in self._mem_ask_peak:
            self._mem_ask_peak.move_to_end(key)
            return self._mem_ask_peak[key]
        value = self._read_model_cache(
            self._peak_path(code, date, source, "ask_peak", bucket_ms),
            AskPeak,
            kind="ask_peak",
        )
        if value is _CACHE_MISS:
            return None
        self._mem_put(self._mem_ask_peak, key, value, self._stats["ask_peak"])  # type: ignore[arg-type]
        return self._mem_ask_peak[key]

    def store_ask_peak(
        self, code: str, date: str, source: str, bucket_ms: int, peak: AskPeak | None
    ) -> None:
        stats = self._stats["ask_peak"]
        stats.record_store()
        self._mem_put(self._mem_ask_peak, (code, date, source, bucket_ms), peak, stats)
        self._write_model_cache(
            self._peak_path(code, date, source, "ask_peak", bucket_ms), peak, kind="ask_peak"
        )

    def has_bid_peak(self, code: str, date: str, source: str, bucket_ms: int) -> bool:
        key = (code, date, source, bucket_ms)
        stats = self._stats["bid_peak"]
        if key in self._mem_bid_peak:
            stats.record_hit()
            return True
        value = self._read_model_cache(
            self._peak_path(code, date, source, "bid_peak", bucket_ms),
            BidPeak,
            kind="bid_peak",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return False
        stats.record_disk_hit()
        self._mem_put(self._mem_bid_peak, key, value, stats)  # type: ignore[arg-type]
        return True

    def get_bid_peak(self, code: str, date: str, source: str, bucket_ms: int) -> BidPeak | None:
        # Lookup accounted on has_bid_peak (the guarding call); get_ is a mem re-read.
        key = (code, date, source, bucket_ms)
        if key in self._mem_bid_peak:
            self._mem_bid_peak.move_to_end(key)
            return self._mem_bid_peak[key]
        value = self._read_model_cache(
            self._peak_path(code, date, source, "bid_peak", bucket_ms),
            BidPeak,
            kind="bid_peak",
        )
        if value is _CACHE_MISS:
            return None
        self._mem_put(self._mem_bid_peak, key, value, self._stats["bid_peak"])  # type: ignore[arg-type]
        return self._mem_bid_peak[key]

    def store_bid_peak(
        self, code: str, date: str, source: str, bucket_ms: int, peak: BidPeak | None
    ) -> None:
        stats = self._stats["bid_peak"]
        stats.record_store()
        self._mem_put(self._mem_bid_peak, (code, date, source, bucket_ms), peak, stats)
        self._write_model_cache(
            self._peak_path(code, date, source, "bid_peak", bucket_ms), peak, kind="bid_peak"
        )

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
        stats = self._stats["poc"]
        if key in self._mem_trade_volume_poc:
            self._mem_trade_volume_poc.move_to_end(key)
            stats.record_hit()
            return self._mem_trade_volume_poc[key]
        value = self._read_model_cache(
            self._poc_path(code, date, source, range_count, price_min, price_max),
            TradeVolumePoc,
            kind="poc",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return _CACHE_MISS
        stats.record_disk_hit()
        self._mem_put(self._mem_trade_volume_poc, key, value, stats)  # type: ignore[arg-type]
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
        stats = self._stats["poc"]
        stats.record_store()
        self._mem_put(self._mem_trade_volume_poc, key, poc, stats)
        self._write_model_cache(
            self._poc_path(code, date, source, range_count, price_min, price_max),
            poc,
            kind="poc",
        )

    # ── depth_heatmap (호가 잔량 히트맵) ─────────────────────────────────────────

    def _depth_path(self, code: str, date: str, source: str, bucket_ms: int) -> Path:
        return self._model_path(code, date, source, f"depth.{bucket_ms}")

    def _mem_put_depth(
        self, key: tuple[str, str, str, int], value: list[DepthHeatmapPoint]
    ) -> None:
        stats = self._stats["depth"]
        od = self._mem_depth
        od[key] = value
        od.move_to_end(key)
        while len(od) > self._mem_max_depth_entries:
            od.popitem(last=False)
            stats.record_eviction()

    def get_depth(
        self, code: str, date: str, source: str, bucket_ms: int
    ) -> list[DepthHeatmapPoint] | object:
        """Cached depth-heatmap points for a completed past Stock-Date, or
        ``_CACHE_MISS``. An empty list is a valid cached result (no-data day),
        so the sentinel — not ``[]`` — signals a miss (mirrors get_trade_volume_poc)."""
        key = (code, date, source, bucket_ms)
        stats = self._stats["depth"]
        hit = self._mem_depth.get(key)
        if hit is not None:
            self._mem_depth.move_to_end(key)
            stats.record_hit()
            return hit
        path = self._depth_path(code, date, source, bucket_ms)
        if not path.exists():
            stats.record_miss()
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            stats.record_miss()
            return _CACHE_MISS
        if body.get("version") != KIND_VERSIONS["depth"]:
            stats.record_miss()
            return _CACHE_MISS
        raw = body.get("points")
        if not isinstance(raw, list):
            stats.record_miss()
            return _CACHE_MISS
        try:
            points = [DepthHeatmapPoint.model_validate(v) for v in raw]
        except ValueError:
            _log.warning("past_indicators_cache.invalid_model path=%s", path, exc_info=True)
            stats.record_miss()
            return _CACHE_MISS
        stats.record_disk_hit()
        self._mem_put_depth(key, points)
        return points

    def store_depth(
        self, code: str, date: str, source: str, bucket_ms: int, points: list[DepthHeatmapPoint]
    ) -> None:
        stats = self._stats["depth"]
        stats.record_store()
        self._mem_put_depth((code, date, source, bucket_ms), points)
        payload = {
            "version": KIND_VERSIONS["depth"],
            "points": [p.model_dump(mode="json") for p in points],
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(self._depth_path(code, date, source, bucket_ms), payload)
        except OSError:
            _log.warning(
                "past_indicators_cache.write_failed path=%s",
                self._depth_path(code, date, source, bucket_ms),
                exc_info=True,
            )

    # ── depth_delta (단별 잔량 증감) ─────────────────────────────────────────────

    def _depth_delta_path(self, code: str, date: str, source: str, bucket_ms: int) -> Path:
        return self._model_path(code, date, source, f"depth_delta.{bucket_ms}")

    def get_depth_delta(
        self, code: str, date: str, source: str, bucket_ms: int
    ) -> list[DepthDeltaPoint] | object:
        """완료 과거일의 단별 잔량 증감 포인트, 또는 ``_CACHE_MISS``.

        get_depth 와 완전 대칭 — 빈 리스트도 유효 결과(무데이터 일자)라 센티넬로
        미스를 구분한다."""
        key = (code, date, source, bucket_ms)
        stats = self._stats["depth_delta"]
        hit = self._mem_depth_delta.get(key)
        if hit is not None:
            self._mem_depth_delta.move_to_end(key)
            stats.record_hit()
            return hit
        path = self._depth_delta_path(code, date, source, bucket_ms)
        if not path.exists():
            stats.record_miss()
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            stats.record_miss()
            return _CACHE_MISS
        if body.get("version") != KIND_VERSIONS["depth_delta"]:
            stats.record_miss()
            return _CACHE_MISS
        raw = body.get("points")
        if not isinstance(raw, list):
            stats.record_miss()
            return _CACHE_MISS
        try:
            points = [DepthDeltaPoint.model_validate(v) for v in raw]
        except ValueError:
            _log.warning("past_indicators_cache.invalid_model path=%s", path, exc_info=True)
            stats.record_miss()
            return _CACHE_MISS
        stats.record_disk_hit()
        self._mem_depth_delta[key] = points
        self._mem_depth_delta.move_to_end(key)
        while len(self._mem_depth_delta) > DEFAULT_MEM_MAX_ENTRIES:
            self._mem_depth_delta.popitem(last=False)
            stats.record_eviction()
        return points

    def store_depth_delta(
        self, code: str, date: str, source: str, bucket_ms: int, points: list[DepthDeltaPoint]
    ) -> None:
        stats = self._stats["depth_delta"]
        stats.record_store()
        self._mem_depth_delta[(code, date, source, bucket_ms)] = points
        self._mem_depth_delta.move_to_end((code, date, source, bucket_ms))
        while len(self._mem_depth_delta) > DEFAULT_MEM_MAX_ENTRIES:
            self._mem_depth_delta.popitem(last=False)
            stats.record_eviction()
        payload = {
            "version": KIND_VERSIONS["depth_delta"],
            "points": [p.model_dump(mode="json") for p in points],
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(self._depth_delta_path(code, date, source, bucket_ms), payload)
        except OSError:
            _log.warning(
                "past_indicators_cache.write_failed path=%s",
                self._depth_delta_path(code, date, source, bucket_ms),
                exc_info=True,
            )

    # ── volume_distribution (체결 분포) ──────────────────────────────────────────

    def _vdist_path(
        self, code: str, date: str, source: str, range_count: int, price_min: int, price_max: int
    ) -> Path:
        return self._model_path(
            code, date, source, f"volume_distribution.{range_count}.{price_min}.{price_max}"
        )

    def get_volume_distribution(
        self, code: str, date: str, source: str, range_count: int, price_min: int, price_max: int
    ) -> DayVolumeDistribution | None | object:
        """Cached체결 분포 for a completed past Stock-Date, or ``_CACHE_MISS``.
        None(무데이터일)도 유효 캐시값이라 센티널로 미스를 구분(POC와 동일).
        ``source`` 는 호출부가 넘긴 trade_indicator_source — 키 정합 유지."""
        key = (code, date, source, range_count, price_min, price_max)
        stats = self._stats["vdist"]
        if key in self._mem_vdist:
            self._mem_vdist.move_to_end(key)
            stats.record_hit()
            return self._mem_vdist[key]
        value = self._read_model_cache(
            self._vdist_path(code, date, source, range_count, price_min, price_max),
            DayVolumeDistribution,
            kind="vdist",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return _CACHE_MISS
        stats.record_disk_hit()
        self._mem_put(self._mem_vdist, key, value, stats)  # type: ignore[arg-type]
        return self._mem_vdist[key]

    def store_volume_distribution(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int,
        value: DayVolumeDistribution | None,
    ) -> None:
        key = (code, date, source, range_count, price_min, price_max)
        stats = self._stats["vdist"]
        stats.record_store()
        self._mem_put(self._mem_vdist, key, value, stats)
        self._write_model_cache(
            self._vdist_path(code, date, source, range_count, price_min, price_max),
            value,
            kind="vdist",
        )

    # ── broker_late_entries (거래원 지각 진입) ───────────────────────────────────
    #
    # ⚠️ 이벤트 선별은 broker_names.canonical(코드 레벨 별칭 병합)에 의존한다 —
    # 그 매핑이 바뀌면 캐시된 events 가 스테일해지므로 KIND_VERSIONS["broker_late"] 를
    # 범프해야 한다(bucketing/대표 semantics 변경과 동일 정책).

    def _broker_late_path(self, code: str, date: str, source: str, start_hhmm: int) -> Path:
        return self._model_path(code, date, source, f"broker_late.{start_hhmm}")

    def _read_model_list_cache(
        self, path: Path, model_type: type[_ModelT], *, payload_key: str, kind: str
    ) -> list[_ModelT] | object:
        """List-of-model 디스크 read (list 또는 ``_CACHE_MISS``). ``[]`` 는 유효
        캐시값이라 미스와 구분된다. depth 의 인라인 read 와 동형이나 payload_key 로
        일반화 — broker_late 가 재사용한다(depth 는 기존 경로 유지)."""
        if not path.exists():
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            return _CACHE_MISS
        if body.get("version") != KIND_VERSIONS[kind]:
            return _CACHE_MISS
        raw = body.get(payload_key)
        if not isinstance(raw, list):
            return _CACHE_MISS
        try:
            return [model_type.model_validate(v) for v in raw]
        except ValueError:
            _log.warning("past_indicators_cache.invalid_model path=%s", path, exc_info=True)
            return _CACHE_MISS

    def _write_model_list_cache(
        self, path: Path, items: "Sequence[BaseModel]", *, payload_key: str, kind: str
    ) -> None:
        payload = {
            "version": KIND_VERSIONS[kind],
            payload_key: [m.model_dump(mode="json") for m in items],
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(path, payload)
        except OSError:
            _log.warning("past_indicators_cache.write_failed path=%s", path, exc_info=True)

    def get_broker_late(
        self, code: str, date: str, source: str, start_hhmm: int
    ) -> list[BrokerLateEntryEvent] | object:
        key = (code, date, source, start_hhmm)
        stats = self._stats["broker_late"]
        hit = self._mem_broker_late.get(key)
        if hit is not None:
            self._mem_broker_late.move_to_end(key)
            stats.record_hit()
            return hit
        value = self._read_model_list_cache(
            self._broker_late_path(code, date, source, start_hhmm),
            BrokerLateEntryEvent,
            payload_key="events",
            kind="broker_late",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return _CACHE_MISS
        stats.record_disk_hit()
        self._mem_put(self._mem_broker_late, key, value, stats)  # type: ignore[arg-type]
        return value  # type: ignore[return-value]

    def store_broker_late(
        self, code: str, date: str, source: str, start_hhmm: int, events: list[BrokerLateEntryEvent]
    ) -> None:
        key = (code, date, source, start_hhmm)
        stats = self._stats["broker_late"]
        stats.record_store()
        self._mem_put(self._mem_broker_late, key, events, stats)
        self._write_model_list_cache(
            self._broker_late_path(code, date, source, start_hhmm),
            events,
            payload_key="events",
            kind="broker_late",
        )

    # ── continuous_before_ms (연속거래 상한 — POC·체결분포 선행 스칼라) ──────────
    #
    # 결과 자체가 아니라 두 지표의 선행 의존값(snapshots+trades 2-스캔). 과거일은
    # 불변이라 한 번 계산해 재사용. None(경계 없음)도 유효 캐시값 → 센티널로 미스 구분.

    def _continuous_before_path(self, code: str, date: str, source: str, session_close_ms: int) -> Path:
        return self._model_path(code, date, source, f"continuous_before.{session_close_ms}")

    def get_continuous_before(
        self, code: str, date: str, source: str, session_close_ms: int
    ) -> int | None | object:
        key = (code, date, source, session_close_ms)
        stats = self._stats["continuous_before"]
        if key in self._mem_continuous_before:
            self._mem_continuous_before.move_to_end(key)
            stats.record_hit()
            return self._mem_continuous_before[key]
        path = self._continuous_before_path(code, date, source, session_close_ms)
        if not path.exists():
            stats.record_miss()
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            stats.record_miss()
            return _CACHE_MISS
        if body.get("version") != KIND_VERSIONS["continuous_before"]:
            stats.record_miss()
            return _CACHE_MISS
        value = body.get("value")
        if value is not None and not isinstance(value, int):
            stats.record_miss()
            return _CACHE_MISS
        stats.record_disk_hit()
        self._mem_put(self._mem_continuous_before, key, value, stats)
        return value

    def store_continuous_before(
        self, code: str, date: str, source: str, session_close_ms: int, value: int | None
    ) -> None:
        key = (code, date, source, session_close_ms)
        stats = self._stats["continuous_before"]
        stats.record_store()
        self._mem_put(self._mem_continuous_before, key, value, stats)
        payload = {
            "version": KIND_VERSIONS["continuous_before"],
            "value": value,
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(
                self._continuous_before_path(code, date, source, session_close_ms), payload
            )
        except OSError:
            _log.warning(
                "past_indicators_cache.write_failed path=%s",
                self._continuous_before_path(code, date, source, session_close_ms),
                exc_info=True,
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
        if body.get("version") != KIND_VERSIONS[kind]:
            # Semantics changed under an old file — ignore; next store heals it.
            return None
        rows = body.get("rows")
        return rows if isinstance(rows, list) else None

    def _write(self, code: str, date: str, source: str, kind: Kind, rows: list[list[int]]) -> None:
        path = self._path(code, date, source, kind)
        payload = {
            "version": KIND_VERSIONS[kind], "rows": rows,
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(path, payload)
        except OSError:
            # A cache write failure must never break the response — the value was
            # already computed and returned; the next request recomputes + retries.
            _log.warning("past_indicators_cache.write_failed path=%s", path, exc_info=True)
