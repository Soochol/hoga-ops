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
it) but `source` IS (a day can hold both hogaplay and promotion slices, chosen by
`_resolve_source`; serving the wrong one would be a silent data swap).

⚠️ 이 "1분 정본, 키에 tf 없음" 원칙을 **캔들 캐시(past_candles_cache)에 이식하지
말 것** — 그쪽은 키에 tic_scope 가 있는 것이 옳다. 두 캐시가 반대인 이유는
소스 비용 구조다(여긴 디스크=재집계 공짜, 캔들은 벤더 유량=잘게 받으면 콜 배수).
ADR-0139 참고.

Past-only by construction: the caller gates `date < today_kst` before touching
this cache. Today's snapshots are still being promoted (ADR-0043), so today must
recompute live and is never persisted here — no today/TTL layer (unlike
`PastCandlesCache`, whose today memory cache exists to spare KIS calls; indicator
recompute is a local read with no external quota).
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Literal, TypeVar, cast

from hoga.api.models import (
    AskPeak,
    BidPeak,
    BrokerLateEntryEvent,
    DayVolumeDistribution,
    DepthDeltaPoint,
    DepthHeatmapPoint,
    TradeVolumePoc,
)
from hoga.live.venue import Venue
from hoga.tables.snapshots import QuoteRatioRow
from hoga.tables.trades import FillStrengthRow
from hoga.util.atomic_write import atomic_write_json
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
#
# 2026-08-10 (ADR-0140 venue 축): 세션 경계가 meta 의 정규장에서 **venue 별 지표
# 구간**으로 바뀌어 NXT·UN 의 프리·애프터마켓이 집계에 들어온다 → 경계를 타는 kind 만
# 범프. **범프가 필수인 이유**: `_is_stale` 은 capture meta 의 mtime 만 보므로
# "데이터가 바뀌었나" 는 알아도 **"계산 로직이 바뀌었나" 는 모른다**. 실제로 meta 를
# 소급 재작성한 직후 구버전 서버가 캐시를 다시 채웠고, 새 코드가 그 잘린 캐시를
# 그대로 읽었다(실측). 경계 의미를 바꾸면서 여기를 안 올리면 그게 재발한다.
#
# ⚠ 경계를 **안 타는** kind 는 그대로 둔다(위 문단의 /study 콜드 로드 사고 방지):
#   * `fill`(체결강도) — 빌더가 경계를 받지 않는다.
#   * `broker_late` — 시작 HHMM 인자를 따로 받는다.
#   * `continuous_before` — close 값이 **파일명에** 들어가(`.153000000.json`) 경계가
#     바뀌면 자연히 다른 파일이 된다. 범프하면 이미 맞는 캐시만 버린다.
KIND_VERSIONS: dict[str, int] = {
    "ratio": 7,
    "fill": 6,
    "ask_peak": 7,
    "bid_peak": 7,
    "poc": 7,
    "depth": 7,
    "depth_delta": 2,
    "vdist": 7,
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
        # `/api/range` 는 **sync 라우트**(routes.py 의 `def api_range`)라 Starlette
        # 이 anyio 스레드풀에서 돌린다 — 즉 이 캐시의 OrderedDict 들이 여러 스레드에서
        # 동시에 변이된다. 락이 없던 동안 두 창을 재캡처 중에 팬하면
        # `_sync_generation` 의 prefix purge 가 순회 중 삭제와 겹쳐
        # `RuntimeError: dictionary changed size during iteration` 이 되고,
        # getter 의 `move_to_end` 는 다른 스레드가 방금 축출한 키에 `KeyError` 를 낸다.
        # 같은 파일 계열의 `QueryEngine._stock_date_cache` 는 정확히 이 문제를 알고
        # 방어해 뒀다(queries.py 주석) — 여기 한 곳만 빠져 있었다.
        # RLock: 락 구간에서 다른 락 메서드를 부르는 경로가 생겨도 자기 교착이 없다.
        self._lock = threading.RLock()
        self._mem_max_entries = max(0, int(mem_max_entries))
        self._mem_max_depth_entries = max(0, int(mem_max_depth_entries))
        # In-memory hot cache (avoids re-reading disk within a process).
        # WS4: dict당 LRU 상한 — 축출돼도 디스크 read-through로 값은 보존되므로
        # 관측 가능 동작은 불변, 장수명 프로세스의 메모리만 유계가 된다.
        self._mem_ratio: OrderedDict[tuple[str, str, str, str], list[QuoteRatioRow]] = OrderedDict()
        self._mem_fill: OrderedDict[tuple[str, str, str, str], list[FillStrengthRow]] = OrderedDict()
        # None is a valid cached result for empty/no-data days, so has_/get_
        # remain separate for peak caches.
        self._mem_ask_peak: OrderedDict[tuple[str, str, str, str, int], AskPeak | None] = OrderedDict()
        self._mem_bid_peak: OrderedDict[tuple[str, str, str, str, int], BidPeak | None] = OrderedDict()
        self._mem_trade_volume_poc: OrderedDict[
            tuple[str, str, str, str, int, int, int], TradeVolumePoc | None
        ] = OrderedDict()
        # depth_heatmap 은 (code, date, source, bucket_ms) 결과를 그대로 캐시한다.
        # ratio/fill 처럼 1m 저장 후 재집계하지 않는 이유: depth 대표 선택이
        # "연속거래 우선 + 완전-동시호가 버킷 폴백"의 조건부 argmax라, 1m 행에서
        # coarse 대표를 정확히 복원하려면 선택 근거(is_pre)를 함께 저장해야 하기
        # 때문. bucket_ms 별 결과 캐시가 단순·정확하다.
        self._mem_depth: OrderedDict[
            tuple[str, str, str, str, int], list[DepthHeatmapPoint]
        ] = OrderedDict()
        # depth_delta 는 증감 있는 가격만 담아 depth 보다 훨씬 작다(희소).
        # 공용 512 LRU 편승 — depth 처럼 전용 상한 불필요.
        self._mem_depth_delta: OrderedDict[
            tuple[str, str, str, str, int], list[DepthDeltaPoint]
        ] = OrderedDict()
        # 체결 분포(단일 모델|None)·거래원 지각진입(리스트)·연속거래 상한(스칼라).
        # 전부 소형이라 공용 512 LRU 편승(depth 처럼 전용 상한 불필요).
        self._mem_vdist: OrderedDict[
            tuple[str, str, str, str, int, int, int], DayVolumeDistribution | None
        ] = OrderedDict()
        self._mem_broker_late: OrderedDict[
            tuple[str, str, str, str, int], list[BrokerLateEntryEvent]
        ] = OrderedDict()
        self._mem_continuous_before: OrderedDict[
            tuple[str, str, str, str, int], int | None
        ] = OrderedDict()
        # Capture-freshness guard (2026-07-23). A cached indicator slice is only
        # valid for the exact capture it was computed from, yet a re-capture
        # rewrites the source parquet + meta.json under the SAME (code,date,source)
        # key — so without a token check a stale slice outlives the data it
        # summarizes. Incident: a sparse 08:18 hogaplay capture cached ONE ratio
        # point; the 08:38 full re-capture replaced snapshots.parquet (8.9k rows);
        # /live kept serving the 1 point because neither disk nor mem was
        # invalidated. meta.json mtime is the capture identity — bumped on every
        # capture, shared by every kind of the Stock-Date. Disk staleness is gated
        # in _read/_read_model_cache; mem staleness is gated by _sync_generation,
        # which purges these dicts on a token change.
        self._gen: dict[tuple[str, str, str, str], int] = {}
        self._all_mem_dicts: tuple[OrderedDict, ...] = (
            self._mem_ratio, self._mem_fill, self._mem_ask_peak, self._mem_bid_peak,
            self._mem_trade_volume_poc, self._mem_depth, self._mem_depth_delta,
            self._mem_vdist, self._mem_broker_late, self._mem_continuous_before,
        )
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
        with self._lock:
            od[key] = value
            od.move_to_end(key)
            while len(od) > self._mem_max_entries:
                od.popitem(last=False)
                if stats is not None:
                    stats.record_eviction()

    def _mem_hit(self, od: OrderedDict, key):
        """LRU 조회 — get 과 move_to_end 를 한 임계구역으로 묶는다.

        둘을 따로 하면 그 사이에 다른 스레드가 같은 키를 축출해 `move_to_end` 가
        `KeyError` 를 낸다. 값이 없으면 None(캐시가 None 을 유효값으로 쓰는 kind 는
        has_ 로 존재를 먼저 판정하므로 이 반환 계약이 유지된다).
        """
        with self._lock:
            hit = od.get(key)
            if hit is not None:
                od.move_to_end(key)
            return hit

    def _mem_hit_allowing_none(self, od: OrderedDict, key):
        """`None` 을 유효한 캐시값으로 쓰는 kind 용 LRU 조회 — 부재는 `_CACHE_MISS`.

        `if key in od: od.move_to_end(key); return od[key]` 는 **3단계 check-then-act**
        라 그 사이 다른 스레드의 축출이 끼면 `move_to_end` 나 `od[key]` 가 KeyError 를
        낸다. `_mem_hit` 을 쓸 수 없는 이유는 이 kind 들이 "없음" 과 "None 이 캐시됨" 을
        구별해야 해서다(has_ 와 get_ 이 따로 있는 이유와 같다).
        """
        with self._lock:
            if key not in od:
                return _CACHE_MISS
            od.move_to_end(key)
            return od[key]

    def _capture_mtime_ms(
        self, code: str, date: str, source: str, *, venue: Venue = "KRX",
    ) -> int:
        """Capture identity for a Stock-Date source+venue: meta.json mtime in ms.

        meta.json is rewritten by every capture of ``(date, code, source, venue)``,
        so a re-capture strictly advances this. Returns 0 when meta is absent (legacy
        flat layout; tests with no parquet on disk) — callers read 0 as "unknown,
        don't invalidate" so a missing source never nukes an otherwise-valid cache.

        venue 축은 #1133 에서 들어왔다. 그전엔 `"KRX"` 리터럴이라, 같은 (code, date,
        source) 의 NXT 재캡처가 KRX 의 mtime 을 정체성으로 삼았다 — 캐시가 venue 를
        구별하게 된 지금 그 리터럴은 무효화를 통째로 어긋나게 한다.
        """
        from hoga.api.sources import source_venue_dir  # noqa: PLC0415

        meta = (
            source_venue_dir(self._data_dir / "parquet" / date / code, source, venue)
            / "meta.json"
        )
        try:
            return meta.stat().st_mtime_ns // 1_000_000
        except OSError:
            return 0

    def _is_stale(self, path: Path, fetched_at_ms: object) -> bool:
        """True when the source capture is newer than this cache artifact.

        Derives (code, date, source, venue) from the cache ``path`` layout
        (kis-past-indicators/<code>/<source>[/<venue>]/<date>.<suffix>.json) so both
        disk readers share one gate without threading the key through. venue 세그먼트는
        `source_venue_dir` 규율대로 **여러 venue 를 덮는 source 에만** 있다 — 없으면
        그 source 는 정의상 KRX 전용이다. Lenient on any surprise (unparseable path,
        missing meta → token 0, missing timestamp): returns False so a cache we cannot
        prove stale is never discarded."""
        try:
            rel = path.relative_to(self._data_dir / "kis-past-indicators")
            code, source = rel.parts[0], rel.parts[1]
            venue = cast("Venue", rel.parts[2]) if len(rel.parts) > 3 else "KRX"  # noqa: PLR2004 — code/source/venue/file
            date = path.name.split(".", 1)[0]
        except (ValueError, IndexError):
            return False
        tok = self._capture_mtime_ms(code, date, source, venue=venue)
        if tok == 0 or not isinstance(fetched_at_ms, (int, float)):
            return False
        return tok > int(fetched_at_ms)

    def _sync_generation(self, code: str, date: str, source: str, *, venue: Venue = "KRX") -> None:
        """Evict in-memory entries for ``(code, date, source, venue)`` when its capture
        token advanced since they were memoized. One stat() per Stock-Date lookup;
        a prefix purge only on the (rare) re-capture. Disk artifacts are gated
        independently in _read/_read_model_cache, so a cold process is correct
        without this — this keeps a long-lived engine correct across a re-capture
        too (the incident's /live server held the stale slice in mem).

        ⚠ prefix 길이는 **키의 공통 머리 길이와 같아야 한다**(#1133 에서 3→4). venue 가
        키에 들어온 뒤에도 `k[:3]` 이면 한 venue 의 재캡처가 다른 venue 의 메모리
        항목까지 쓸어 간다 — 정확성은 유지되지만(디스크 read-through) 재캡처마다
        무관한 시장의 캐시를 버린다."""
        key = (code, date, source, venue)
        tok = self._capture_mtime_ms(code, date, source, venue=venue)
        with self._lock:
            prev = self._gen.get(key)
            if prev == tok:
                return
            self._gen[key] = tok
            if prev is None:
                return  # first sighting — nothing memoized under the old token
            for od in self._all_mem_dicts:
                # list(od) 로 스냅샷을 뜬 뒤 지운다 — 순회 중 삭제는 같은 스레드에서도
                # 위험하고, 락 밖이면 다른 스레드의 삽입이 순회를 깨뜨렸다.
                for k in [k for k in list(od) if k[:4] == key]:
                    od.pop(k, None)

    def _store_dir(self, code: str, source: str, venue: Venue) -> Path:
        """이 (code, source, venue) 의 캐시 디렉터리.

        parquet 트리와 **같은 규율**(`source_venue_dir`)을 쓴다 — venue 를 하나만
        덮는 source(hogaplay·kis_api)는 세그먼트가 없고, 여럿을 덮는 source
        (kiwoom_live)만 `{source}/{venue}/` 가 된다. 규율을 공유하는 덕에 기존
        hogaplay 캐시 파일은 경로가 그대로라 무효화되지 않는다. kiwoom_live 의 구
        파일만 새 경로에서 미스가 되어 한 번 재계산된다(값은 KRX 로 동일).
        """
        from hoga.api.sources import source_venue_dir  # noqa: PLC0415 — 순환 절단

        return source_venue_dir(self._data_dir / "kis-past-indicators" / code, source, venue)

    def _path(self, code: str, date: str, source: str, kind: Kind, *, venue: Venue = "KRX") -> Path:
        return self._store_dir(code, source, venue) / f"{date}.{kind}.json"

    # ── ratio (호가비) ─────────────────────────────────────────────────────────

    def get_ratio(self, code: str, date: str, source: str, *, venue: Venue = "KRX") -> list[QuoteRatioRow] | None:
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue)
        stats = self._stats["ratio"]
        hit = self._mem_hit(self._mem_ratio, key)
        if hit is not None:
            stats.record_hit()
            return hit
        tuples = self._read(code, date, source, "ratio", venue=venue)
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

    def store_ratio(
        self, code: str, date: str, source: str, rows: list[QuoteRatioRow], *, venue: Venue = "KRX",
    ) -> None:
        tuples = [
            [r.bucket_intra_ms, r.bid_total, r.ask_total,
             r.bid_max, r.ask_max, r.imb_max_bid, r.imb_max_ask]
            for r in rows
        ]
        self._write(code, date, source, "ratio", tuples, venue=venue)
        stats = self._stats["ratio"]
        stats.record_store()
        self._mem_put(self._mem_ratio, (code, date, source, venue), rows, stats)

    # ── fill (체결강도) ────────────────────────────────────────────────────────

    def get_fill(self, code: str, date: str, source: str, *, venue: Venue = "KRX") -> list[FillStrengthRow] | None:
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue)
        stats = self._stats["fill"]
        hit = self._mem_hit(self._mem_fill, key)
        if hit is not None:
            stats.record_hit()
            return hit
        triples = self._read(code, date, source, "fill", venue=venue)
        if triples is None:
            stats.record_miss()
            return None
        rows = [
            FillStrengthRow(bucket_intra_ms=t[0], buy_qty=t[1], sell_qty=t[2]) for t in triples
        ]
        stats.record_disk_hit()
        self._mem_put(self._mem_fill, key, rows, stats)
        return rows

    def store_fill(
        self, code: str, date: str, source: str, rows: list[FillStrengthRow], *, venue: Venue = "KRX",
    ) -> None:
        triples = [[r.bucket_intra_ms, r.buy_qty, r.sell_qty] for r in rows]
        self._write(code, date, source, "fill", triples, venue=venue)
        stats = self._stats["fill"]
        stats.record_store()
        self._mem_put(self._mem_fill, (code, date, source, venue), rows, stats)

    # ── ask/bid peak (매도/매수 최대벽) ───────────────────────────────────────

    def _model_path(
        self,
        code: str,
        date: str,
        source: str,
        suffix: str, *, venue: Venue = "KRX",
    ) -> Path:
        return self._store_dir(code, source, venue) / f"{date}.{suffix}.json"

    def _peak_path(self, code: str, date: str, source: str, kind: Literal["ask_peak", "bid_peak"], bucket_ms: int, *, venue: Venue = "KRX") -> Path:  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)
        return self._model_path(code, date, source, f"{kind}.{bucket_ms}", venue=venue)

    def _poc_path(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int, *, venue: Venue = "KRX",
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
        # Version mismatch (semantics changed) OR source re-captured after this
        # slice was cached (07/22 stale-slice incident) → miss, next store heals.
        if body.get("version") != KIND_VERSIONS[kind] or self._is_stale(
            path, body.get("fetched_at_ms")
        ):
            return _CACHE_MISS
        value = body.get("value")
        if value is None:
            return None
        try:
            return model_type.model_validate(value)
        except ValueError:
            _log.warning("past_indicators_cache.invalid_model path=%s", path, exc_info=True)
            return _CACHE_MISS

    def _write_model_cache(self, path: Path, value: BaseModel | None, *, kind: str) -> None:
        payload = {
            "version": KIND_VERSIONS[kind],
            "value": None if value is None else value.model_dump(mode="json"),
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(path, payload)
        except OSError:
            _log.warning("past_indicators_cache.write_failed path=%s", path, exc_info=True)

    def has_ask_peak(self, code: str, date: str, source: str, bucket_ms: int, *, venue: Venue = "KRX") -> bool:
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, bucket_ms)
        stats = self._stats["ask_peak"]
        if key in self._mem_ask_peak:
            stats.record_hit()
            return True
        value = self._read_model_cache(
            self._peak_path(code, date, source, "ask_peak", bucket_ms, venue=venue),
            AskPeak,
            kind="ask_peak",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return False
        stats.record_disk_hit()
        self._mem_put(self._mem_ask_peak, key, value, stats)  # type: ignore[arg-type]
        return True

    def get_ask_peak(
        self, code: str, date: str, source: str, bucket_ms: int, *, venue: Venue = "KRX",
    ) -> AskPeak | None:
        # Lookup accounted on has_ask_peak (the guarding call); get_ is a mem re-read.
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, bucket_ms)
        cached = self._mem_hit_allowing_none(self._mem_ask_peak, key)
        if cached is not _CACHE_MISS:
            return cached
        value = self._read_model_cache(
            self._peak_path(code, date, source, "ask_peak", bucket_ms, venue=venue),
            AskPeak,
            kind="ask_peak",
        )
        if value is _CACHE_MISS:
            return None
        self._mem_put(self._mem_ask_peak, key, value, self._stats["ask_peak"])  # type: ignore[arg-type]
        # put 직후 dict 재조회는 경합(그 사이 축출 → KeyError) — 손에 있는 값을 쓴다.
        return cast("AskPeak | None", value)

    def store_ask_peak(
        self, code: str, date: str, source: str, bucket_ms: int, peak: AskPeak | None, *, venue: Venue = "KRX"
    ) -> None:
        stats = self._stats["ask_peak"]
        stats.record_store()
        self._mem_put(self._mem_ask_peak, (code, date, source, venue, bucket_ms), peak, stats)
        self._write_model_cache(
            self._peak_path(code, date, source, "ask_peak", bucket_ms, venue=venue), peak, kind="ask_peak"
        )

    def has_bid_peak(self, code: str, date: str, source: str, bucket_ms: int, *, venue: Venue = "KRX") -> bool:
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, bucket_ms)
        stats = self._stats["bid_peak"]
        if key in self._mem_bid_peak:
            stats.record_hit()
            return True
        value = self._read_model_cache(
            self._peak_path(code, date, source, "bid_peak", bucket_ms, venue=venue),
            BidPeak,
            kind="bid_peak",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return False
        stats.record_disk_hit()
        self._mem_put(self._mem_bid_peak, key, value, stats)  # type: ignore[arg-type]
        return True

    def get_bid_peak(
        self, code: str, date: str, source: str, bucket_ms: int, *, venue: Venue = "KRX",
    ) -> BidPeak | None:
        # Lookup accounted on has_bid_peak (the guarding call); get_ is a mem re-read.
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, bucket_ms)
        cached = self._mem_hit_allowing_none(self._mem_bid_peak, key)
        if cached is not _CACHE_MISS:
            return cached
        value = self._read_model_cache(
            self._peak_path(code, date, source, "bid_peak", bucket_ms, venue=venue),
            BidPeak,
            kind="bid_peak",
        )
        if value is _CACHE_MISS:
            return None
        self._mem_put(self._mem_bid_peak, key, value, self._stats["bid_peak"])  # type: ignore[arg-type]
        return cast("BidPeak | None", value)

    def store_bid_peak(
        self, code: str, date: str, source: str, bucket_ms: int, peak: BidPeak | None, *, venue: Venue = "KRX"
    ) -> None:
        stats = self._stats["bid_peak"]
        stats.record_store()
        self._mem_put(self._mem_bid_peak, (code, date, source, venue, bucket_ms), peak, stats)
        self._write_model_cache(
            self._peak_path(code, date, source, "bid_peak", bucket_ms, venue=venue), peak, kind="bid_peak"
        )

    # ── trade_volume_poc ─────────────────────────────────────────────────────

    def get_trade_volume_poc(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int, *, venue: Venue = "KRX",
    ) -> TradeVolumePoc | None | object:
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, range_count, price_min, price_max)
        stats = self._stats["poc"]
        cached = self._mem_hit_allowing_none(self._mem_trade_volume_poc, key)
        if cached is not _CACHE_MISS:
            stats.record_hit()
            return cached
        value = self._read_model_cache(
            self._poc_path(code, date, source, range_count, price_min, price_max, venue=venue),
            TradeVolumePoc,
            kind="poc",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return _CACHE_MISS
        stats.record_disk_hit()
        self._mem_put(self._mem_trade_volume_poc, key, value, stats)  # type: ignore[arg-type]
        return cast("TradeVolumePoc | None", value)

    def store_trade_volume_poc(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int,
        poc: TradeVolumePoc | None, *, venue: Venue = "KRX",
    ) -> None:
        key = (code, date, source, venue, range_count, price_min, price_max)
        stats = self._stats["poc"]
        stats.record_store()
        self._mem_put(self._mem_trade_volume_poc, key, poc, stats)
        self._write_model_cache(
            self._poc_path(code, date, source, range_count, price_min, price_max, venue=venue),
            poc,
            kind="poc",
        )

    # ── depth_heatmap (호가 잔량 히트맵) ─────────────────────────────────────────

    def _depth_path(self, code: str, date: str, source: str, bucket_ms: int, *, venue: Venue = "KRX") -> Path:
        return self._model_path(code, date, source, f"depth.{bucket_ms}", venue=venue)

    def _mem_put_depth(
        self, key: tuple[str, str, str, str, int], value: list[DepthHeatmapPoint]
    ) -> None:
        stats = self._stats["depth"]
        od = self._mem_depth
        with self._lock:
            od[key] = value
            od.move_to_end(key)
            while len(od) > self._mem_max_depth_entries:
                od.popitem(last=False)
                stats.record_eviction()

    def get_depth(
        self, code: str, date: str, source: str, bucket_ms: int, *, venue: Venue = "KRX"
    ) -> list[DepthHeatmapPoint] | object:
        """Cached depth-heatmap points for a completed past Stock-Date, or
        ``_CACHE_MISS``. An empty list is a valid cached result (no-data day),
        so the sentinel — not ``[]`` — signals a miss (mirrors get_trade_volume_poc)."""
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, bucket_ms)
        stats = self._stats["depth"]
        hit = self._mem_hit(self._mem_depth, key)
        if hit is not None:
            stats.record_hit()
            return hit
        path = self._depth_path(code, date, source, bucket_ms, venue=venue)
        if not path.exists():
            stats.record_miss()
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            stats.record_miss()
            return _CACHE_MISS
        if body.get("version") != KIND_VERSIONS["depth"] or self._is_stale(
            path, body.get("fetched_at_ms")
        ):
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
        self,
        code: str,
        date: str,
        source: str,
        bucket_ms: int,
        points: list[DepthHeatmapPoint],
        *,
        venue: Venue = "KRX",
    ) -> None:
        stats = self._stats["depth"]
        stats.record_store()
        self._mem_put_depth((code, date, source, venue, bucket_ms), points)
        payload = {
            "version": KIND_VERSIONS["depth"],
            "points": [p.model_dump(mode="json") for p in points],
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(self._depth_path(code, date, source, bucket_ms, venue=venue), payload)
        except OSError:
            _log.warning(
                "past_indicators_cache.write_failed path=%s",
                self._depth_path(code, date, source, bucket_ms, venue=venue),
                exc_info=True,
            )

    # ── depth_delta (단별 잔량 증감) ─────────────────────────────────────────────

    def _depth_delta_path(self, code: str, date: str, source: str, bucket_ms: int, *, venue: Venue = "KRX") -> Path:
        return self._model_path(code, date, source, f"depth_delta.{bucket_ms}", venue=venue)

    def get_depth_delta(
        self, code: str, date: str, source: str, bucket_ms: int, *, venue: Venue = "KRX"
    ) -> list[DepthDeltaPoint] | object:
        """완료 과거일의 단별 잔량 증감 포인트, 또는 ``_CACHE_MISS``.

        get_depth 와 완전 대칭 — 빈 리스트도 유효 결과(무데이터 일자)라 센티넬로
        미스를 구분한다."""
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, bucket_ms)
        stats = self._stats["depth_delta"]
        hit = self._mem_hit(self._mem_depth_delta, key)
        if hit is not None:
            stats.record_hit()
            return hit
        path = self._depth_delta_path(code, date, source, bucket_ms, venue=venue)
        if not path.exists():
            stats.record_miss()
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            stats.record_miss()
            return _CACHE_MISS
        if body.get("version") != KIND_VERSIONS["depth_delta"] or self._is_stale(
            path, body.get("fetched_at_ms")
        ):
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
        self._mem_put(self._mem_depth_delta, key, points, stats)
        return points

    def store_depth_delta(
        self, code: str, date: str, source: str, bucket_ms: int, points: list[DepthDeltaPoint], *, venue: Venue = "KRX"
    ) -> None:
        stats = self._stats["depth_delta"]
        stats.record_store()
        self._mem_put(self._mem_depth_delta, (code, date, source, venue, bucket_ms), points, stats)
        payload = {
            "version": KIND_VERSIONS["depth_delta"],
            "points": [p.model_dump(mode="json") for p in points],
            "fetched_at_ms": int(time.time() * 1000),
        }
        try:
            atomic_write_json(self._depth_delta_path(code, date, source, bucket_ms, venue=venue), payload)
        except OSError:
            _log.warning(
                "past_indicators_cache.write_failed path=%s",
                self._depth_delta_path(code, date, source, bucket_ms, venue=venue),
                exc_info=True,
            )

    # ── volume_distribution (체결 분포) ──────────────────────────────────────────

    def _vdist_path(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int,
        *,
        venue: Venue = "KRX",
    ) -> Path:
        return self._model_path(
            code, date, source, f"volume_distribution.{range_count}.{price_min}.{price_max}", venue=venue
        )

    def get_volume_distribution(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int,
        *,
        venue: Venue = "KRX",
    ) -> DayVolumeDistribution | None | object:
        """Cached체결 분포 for a completed past Stock-Date, or ``_CACHE_MISS``.
        None(무데이터일)도 유효 캐시값이라 센티널로 미스를 구분(POC와 동일).
        ``source`` 는 호출부가 넘긴 trade_indicator_source — 키 정합 유지."""
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, range_count, price_min, price_max)
        stats = self._stats["vdist"]
        cached = self._mem_hit_allowing_none(self._mem_vdist, key)
        if cached is not _CACHE_MISS:
            stats.record_hit()
            return cached
        value = self._read_model_cache(
            self._vdist_path(code, date, source, range_count, price_min, price_max, venue=venue),
            DayVolumeDistribution,
            kind="vdist",
        )
        if value is _CACHE_MISS:
            stats.record_miss()
            return _CACHE_MISS
        stats.record_disk_hit()
        self._mem_put(self._mem_vdist, key, value, stats)  # type: ignore[arg-type]
        return cast("DayVolumeDistribution | None", value)

    def store_volume_distribution(
        self,
        code: str,
        date: str,
        source: str,
        range_count: int,
        price_min: int,
        price_max: int,
        value: DayVolumeDistribution | None, *, venue: Venue = "KRX",
    ) -> None:
        key = (code, date, source, venue, range_count, price_min, price_max)
        stats = self._stats["vdist"]
        stats.record_store()
        self._mem_put(self._mem_vdist, key, value, stats)
        self._write_model_cache(
            self._vdist_path(code, date, source, range_count, price_min, price_max, venue=venue),
            value,
            kind="vdist",
        )

    # ── broker_late_entries (거래원 지각 진입) ───────────────────────────────────
    #
    # ⚠️ 이벤트 선별은 broker_names.canonical(코드 레벨 별칭 병합)에 의존한다 —
    # 그 매핑이 바뀌면 캐시된 events 가 스테일해지므로 KIND_VERSIONS["broker_late"] 를
    # 범프해야 한다(bucketing/대표 semantics 변경과 동일 정책).

    def _broker_late_path(self, code: str, date: str, source: str, start_hhmm: int, *, venue: Venue = "KRX") -> Path:
        return self._model_path(code, date, source, f"broker_late.{start_hhmm}", venue=venue)

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
        if body.get("version") != KIND_VERSIONS[kind] or self._is_stale(
            path, body.get("fetched_at_ms")
        ):
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
        self, path: Path, items: Sequence[BaseModel], *, payload_key: str, kind: str
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
        self, code: str, date: str, source: str, start_hhmm: int, *, venue: Venue = "KRX"
    ) -> list[BrokerLateEntryEvent] | object:
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, start_hhmm)
        stats = self._stats["broker_late"]
        hit = self._mem_hit(self._mem_broker_late, key)
        if hit is not None:
            stats.record_hit()
            return hit
        value = self._read_model_list_cache(
            self._broker_late_path(code, date, source, start_hhmm, venue=venue),
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
        self,
        code: str,
        date: str,
        source: str,
        start_hhmm: int,
        events: list[BrokerLateEntryEvent],
        *,
        venue: Venue = "KRX",
    ) -> None:
        key = (code, date, source, venue, start_hhmm)
        stats = self._stats["broker_late"]
        stats.record_store()
        self._mem_put(self._mem_broker_late, key, events, stats)
        self._write_model_list_cache(
            self._broker_late_path(code, date, source, start_hhmm, venue=venue),
            events,
            payload_key="events",
            kind="broker_late",
        )

    # ── continuous_before_ms (연속거래 상한 — POC·체결분포 선행 스칼라) ──────────
    #
    # 결과 자체가 아니라 두 지표의 선행 의존값(snapshots+trades 2-스캔). 과거일은
    # 불변이라 한 번 계산해 재사용. None(경계 없음)도 유효 캐시값 → 센티널로 미스 구분.

    def _continuous_before_path(
        self, code: str, date: str, source: str, session_close_ms: int, *, venue: Venue = "KRX",
    ) -> Path:
        return self._model_path(code, date, source, f"continuous_before.{session_close_ms}", venue=venue)

    def get_continuous_before(
        self, code: str, date: str, source: str, session_close_ms: int, *, venue: Venue = "KRX"
    ) -> int | None | object:
        self._sync_generation(code, date, source, venue=venue)
        key = (code, date, source, venue, session_close_ms)
        stats = self._stats["continuous_before"]
        cached = self._mem_hit_allowing_none(self._mem_continuous_before, key)
        if cached is not _CACHE_MISS:
            stats.record_hit()
            return cached
        path = self._continuous_before_path(code, date, source, session_close_ms, venue=venue)
        if not path.exists():
            stats.record_miss()
            return _CACHE_MISS
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _log.warning("past_indicators_cache.corrupt path=%s", path, exc_info=True)
            stats.record_miss()
            return _CACHE_MISS
        if body.get("version") != KIND_VERSIONS["continuous_before"] or self._is_stale(
            path, body.get("fetched_at_ms")
        ):
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
        self, code: str, date: str, source: str, session_close_ms: int, value: int | None, *, venue: Venue = "KRX"
    ) -> None:
        key = (code, date, source, venue, session_close_ms)
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
                self._continuous_before_path(code, date, source, session_close_ms, venue=venue), payload
            )
        except OSError:
            _log.warning(
                "past_indicators_cache.write_failed path=%s",
                self._continuous_before_path(code, date, source, session_close_ms, venue=venue),
                exc_info=True,
            )

    # ── disk I/O ──────────────────────────────────────────────────────────────

    def _read(self, code: str, date: str, source: str, kind: Kind, *, venue: Venue = "KRX") -> list[list[int]] | None:
        p = self._path(code, date, source, kind, venue=venue)
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
        if self._is_stale(p, body.get("fetched_at_ms")):
            # Source re-captured after this slice was cached — ignore; next store heals.
            return None
        rows = body.get("rows")
        return rows if isinstance(rows, list) else None

    def _write(
        self, code: str, date: str, source: str, kind: Kind, rows: list[list[int]], *, venue: Venue = "KRX",
    ) -> None:
        path = self._path(code, date, source, kind, venue=venue)
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
