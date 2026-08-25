"""PastIndicatorsCache — disk cache of 1m quote_ratio / fill_strength rows."""
from __future__ import annotations

import json
import os
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.api.models import (
    AskPeak,
    BidPeak,
    BrokerLateEntryEvent,
    DayVolumeDistribution,
    DepthHeatmapPoint,
    TradeVolumePoc,
    VolumeDistributionBin,
    WallSurgeEvent,
)
from hoga.api.past_indicators_cache import CACHE_MISS, KIND_VERSIONS, PastIndicatorsCache
from hoga.tables.snapshots import PeakRepRow, QuoteRatioRow
from hoga.tables.trades import FillStrengthRow

CODE = "005930"
DATE = "20260529"
SRC = "kiwoom_live"


def _store_dir(tmp_path: Path, code: str = CODE, source: str = SRC, venue: str = "KRX") -> Path:
    """캐시 트리의 (code, source, venue) 디렉터리 — **정본 헬퍼로 조립**한다.

    손으로 `/ code / source` 를 붙이면 venue 축이 있는 소스(`kiwoom_live`)에서
    세그먼트가 빠진다. 캐시 트리는 #1133 부터 parquet 트리와 같은
    `source_venue_dir` 규율을 쓴다 — venue 하나짜리 소스는 세그먼트 없음.
    """
    from hoga.api.sources import source_venue_dir

    return source_venue_dir(tmp_path / "kis-past-indicators" / code, source, venue)  # type: ignore[arg-type]


RATIO = [QuoteRatioRow(bucket_intra_ms=0, bid_total=10, ask_total=20,
                       bid_max=900, ask_max=800, imb_max_bid=100, imb_max_ask=2,
                       band_pct=2.5, tick=50),
         # 동시호가 센티넬 — 총잔량도 폭도 0.
         QuoteRatioRow(bucket_intra_ms=60_000, bid_total=0, ask_total=0,
                       bid_max=0, ask_max=0, imb_max_bid=0, imb_max_ask=0)]
FILL = [FillStrengthRow(bucket_intra_ms=0, buy_qty=5, sell_qty=3)]


def test_ratio_roundtrip_in_memory(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    assert c.get_ratio(CODE, DATE, SRC) is None
    c.store_ratio(CODE, DATE, SRC, RATIO)
    assert c.get_ratio(CODE, DATE, SRC) == RATIO


def test_fill_roundtrip_in_memory(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    assert c.get_fill(CODE, DATE, SRC) is None
    c.store_fill(CODE, DATE, SRC, FILL)
    assert c.get_fill(CODE, DATE, SRC) == FILL


def test_persists_to_disk_across_instances(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    PastIndicatorsCache(tmp_path).store_fill(CODE, DATE, SRC, FILL)
    # A FRESH instance (cold memory) must reconstruct identical rows from disk.
    fresh = PastIndicatorsCache(tmp_path)
    assert fresh.get_ratio(CODE, DATE, SRC) == RATIO
    assert fresh.get_fill(CODE, DATE, SRC) == FILL


def test_path_layout_is_code_source_date_kind(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    assert (_store_dir(tmp_path) / f"{DATE}.ratio.json").exists()


def test_source_is_part_of_the_key(tmp_path: Path) -> None:
    # Same (code, date), different source → independent entries (no silent swap).
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, "kiwoom_live", RATIO)
    assert c.get_ratio(CODE, DATE, "hogaplay") is None


def test_corrupt_file_is_a_miss(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)
    p = _store_dir(tmp_path) / f"{DATE}.ratio.json"
    p.write_text("{ not json", encoding="utf-8")
    PastIndicatorsCache(tmp_path)  # cold instance bypasses memory
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None


def test_version_mismatch_is_a_miss(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)
    p = _store_dir(tmp_path) / f"{DATE}.ratio.json"
    body = json.loads(p.read_text())
    body["version"] = 999
    p.write_text(json.dumps(body), encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None


def test_empty_rows_roundtrip(tmp_path: Path) -> None:
    # A no-data day legitimately caches an empty list (distinct from a miss=None).
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, [])
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) == []


def test_ratio_disk_payload_is_nine_tuples(tmp_path: Path) -> None:
    """디스크 직렬화는 [bucket_intra_ms, bid_total, ask_total, bid_max, ask_max,
    imb_max_bid, imb_max_ask, band_pct, tick] 9-tuple — Intra-Bar Max 필드(ADR-0076)와
    사다리 폭을 보존한다. 7→8 칸 확장이라 KIND_VERSIONS["ratio"] 범프가 필수였다
    (아래 test_ratio_version_bumped_for_band_pct 가 그 짝)."""
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    p = _store_dir(tmp_path) / f"{DATE}.ratio.json"
    body = json.loads(p.read_text())
    assert body["rows"][0] == [0, 10, 20, 900, 800, 100, 2, 2.5, 50]
    assert body["rows"][1] == [60_000, 0, 0, 0, 0, 0, 0, 0.0, 0]
    # 콜드 인스턴스가 9-tuple을 동일 QuoteRatioRow로 복원.
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) == RATIO


def test_ratio_version_bumped_for_new_columns(tmp_path: Path) -> None:
    """칸이 늘기 전(7·8-tuple) 캐시는 **버전 미스로 버려져야** 한다.

    막는 방향: 옛 파일이 되살아나 ``t[7]`` 에서 IndexError 로 죽는 것. 못 보는 것:
    같은 버전 안에서 폭 계산 규칙이 바뀌는 경우(그때는 또 범프해야 한다)."""
    from hoga.api import past_indicators_cache as mod
    assert mod.KIND_VERSIONS["ratio"] >= 9
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)
    p = _store_dir(tmp_path) / f"{DATE}.ratio.json"
    body = json.loads(p.read_text())
    for old_ver, ncol in ((7, 7), (8, 8)):
        body["version"] = old_ver
        body["rows"] = [r[:ncol] for r in json.loads(p.read_text())["rows"]]
        p.write_text(json.dumps(body))
        assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None, old_ver
        c.store_ratio(CODE, DATE, SRC, RATIO)


def test_schema_version_bumped_to_6_invalidates_peak_candidate_cache(tmp_path: Path) -> None:
    """v2→v6: 시간별 후보 배열 없는 peak 캐시는 버전 미스로 무효."""
    from hoga.api import past_indicators_cache as mod
    assert mod.KIND_VERSIONS["ratio"] >= 6
    assert mod.KIND_VERSIONS["ask_peak"] >= 6
    p = _store_dir(tmp_path) / f"{DATE}.ratio.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": 1, "rows": [[0, 10, 20]], "fetched_at_ms": 0}),
                 encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None

    ask_path = _store_dir(tmp_path) / f"{DATE}.ask_peak.60000.json"
    ask_path.write_text(json.dumps({
        "version": 2,
        "value": {
            "date": DATE,
            "price": 71000,
            "qty": 1000,
            "t_ms": 1,
            "max_price": 71000,
            "max_qty": 1000,
            "max_t_ms": 1,
        },
        "fetched_at_ms": 0,
    }), encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).has_ask_peak(CODE, DATE, SRC, 60_000) is False


def test_schema_version_bumped_to_6_invalidates_price_based_peak_classification_cache(tmp_path: Path) -> None:
    """v3→v6: 가격 집합 기준 peak 분류 캐시는 이벤트/lifecycle 기준 재계산이 필요."""
    from hoga.api import past_indicators_cache as mod
    assert mod.KIND_VERSIONS["ask_peak"] >= 6
    assert mod.KIND_VERSIONS["bid_peak"] >= 6

    peak_dir = _store_dir(tmp_path)
    peak_dir.mkdir(parents=True, exist_ok=True)
    stale_peak = {
        "version": 3,
        "value": {
            "date": DATE,
            "price": 101000,
            "qty": 30632,
            "t_ms": 1,
            "max_price": 101000,
            "max_qty": 30632,
            "max_t_ms": 1,
            "traded_peaks": [{"price": 101000, "qty": 30632, "t_ms": 1}],
        },
        "fetched_at_ms": 0,
    }
    (peak_dir / f"{DATE}.ask_peak.60000.json").write_text(json.dumps(stale_peak), encoding="utf-8")
    (peak_dir / f"{DATE}.bid_peak.60000.json").write_text(json.dumps(stale_peak), encoding="utf-8")

    reloaded = PastIndicatorsCache(tmp_path)
    assert reloaded.has_ask_peak(CODE, DATE, SRC, 60_000) is False
    assert reloaded.has_bid_peak(CODE, DATE, SRC, 60_000) is False


def test_schema_version_bumped_to_6_invalidates_raw_peak_event_rank_cache(tmp_path: Path) -> None:
    """v4→v6: 같은 가격 raw 이벤트 순위 캐시는 lifecycle 기준 재계산이 필요."""
    from hoga.api import past_indicators_cache as mod
    assert mod.KIND_VERSIONS["ask_peak"] >= 6
    assert mod.KIND_VERSIONS["bid_peak"] >= 6

    peak_dir = _store_dir(tmp_path)
    peak_dir.mkdir(parents=True, exist_ok=True)
    stale_peak = {
        "version": 4,
        "value": {
            "date": DATE,
            "price": 50000,
            "qty": 8000,
            "t_ms": 1,
            "max_price": 50000,
            "max_qty": 8000,
            "max_t_ms": 1,
            "traded_peaks": [
                {"price": 50000, "qty": 8000, "t_ms": 1},
                {"price": 50000, "qty": 7000, "t_ms": 2},
                {"price": 50000, "qty": 5000, "t_ms": 0},
            ],
        },
        "fetched_at_ms": 0,
    }
    (peak_dir / f"{DATE}.ask_peak.60000.json").write_text(json.dumps(stale_peak), encoding="utf-8")
    (peak_dir / f"{DATE}.bid_peak.60000.json").write_text(json.dumps(stale_peak), encoding="utf-8")

    reloaded = PastIndicatorsCache(tmp_path)
    assert reloaded.has_ask_peak(CODE, DATE, SRC, 60_000) is False
    assert reloaded.has_bid_peak(CODE, DATE, SRC, 60_000) is False


def test_kind_version_bump_invalidates_only_that_kind(
    tmp_path: Path, monkeypatch,
) -> None:
    """kind별 버전의 존재 이유: 한 kind의 semantics 변경(버전 범프)이 다른 kind의
    디스크 캐시를 무효화하면 안 된다 — 2026-07-11 전역 v5→v6 범프가 의미 불변
    kind(peak 등)까지 콜드로 만들어 /study 뷰 첫 로드가 수십 분으로 늘었던 회귀 가드."""
    from hoga.api import past_indicators_cache as mod

    ask = AskPeak(
        date=DATE, price=71000, qty=1, t_ms=1, max_price=71000, max_qty=1, max_t_ms=1
    )
    warm = PastIndicatorsCache(tmp_path)
    warm.store_ratio(CODE, DATE, SRC, RATIO)
    warm.store_fill(CODE, DATE, SRC, FILL)
    warm.store_ask_peak(CODE, DATE, SRC, 60_000, ask)

    monkeypatch.setitem(mod.KIND_VERSIONS, "ratio", mod.KIND_VERSIONS["ratio"] + 1)

    fresh = PastIndicatorsCache(tmp_path)  # cold memory → 디스크 버전 체크 경유
    assert fresh.get_ratio(CODE, DATE, SRC) is None  # 범프된 kind만 무효
    assert fresh.get_fill(CODE, DATE, SRC) == FILL
    assert fresh.get_ask_peak(CODE, DATE, SRC, 60_000) == ask


def test_kind_versions_covers_every_cache_kind(tmp_path: Path) -> None:
    """새 kind 추가 시 KIND_VERSIONS 등록 누락은 read/write에서 KeyError가 되므로,
    stats에 등록된 kind 집합과 일치해야 한다."""
    from hoga.api import past_indicators_cache as mod

    assert set(mod.KIND_VERSIONS) == set(PastIndicatorsCache(tmp_path)._stats)


def test_bid_peak_cache_is_independent_from_ask_peak(tmp_path: Path) -> None:
    cache = PastIndicatorsCache(tmp_path)
    ask = AskPeak(
        date="20260619", price=71000, qty=1, t_ms=1, max_price=71000, max_qty=1, max_t_ms=1
    )
    bid = BidPeak(
        date="20260619", price=70000, qty=2, t_ms=2, max_price=70000, max_qty=2, max_t_ms=2
    )

    cache.store_ask_peak("005930", "20260619", "hogaplay", 60_000, ask)
    cache.store_bid_peak("005930", "20260619", "hogaplay", 60_000, bid)

    assert cache.get_ask_peak("005930", "20260619", "hogaplay", 60_000) == ask
    assert cache.get_bid_peak("005930", "20260619", "hogaplay", 60_000) == bid


def test_ask_bid_peak_cache_survives_new_cache_instance(tmp_path: Path) -> None:
    cache = PastIndicatorsCache(tmp_path)
    ask = AskPeak(
        date="20260619", price=70000, qty=1000, t_ms=1, max_price=70000, max_qty=1000, max_t_ms=1
    )
    bid = BidPeak(
        date="20260619", price=69000, qty=900, t_ms=2, max_price=69000, max_qty=900, max_t_ms=2
    )
    cache.store_ask_peak("005930", "20260619", "hogaplay", 60_000, ask)
    cache.store_bid_peak("005930", "20260619", "hogaplay", 60_000, bid)

    reloaded = PastIndicatorsCache(tmp_path)
    assert reloaded.get_ask_peak("005930", "20260619", "hogaplay", 60_000) == ask
    assert reloaded.get_bid_peak("005930", "20260619", "hogaplay", 60_000) == bid


def test_peak_cache_loads_payload_without_ranked_arrays(tmp_path: Path) -> None:
    """ranked 배열이 없는 payload 도 읽히고, **없어진 `untraded_*` 키는 무시된다**.

    ADR-0156 이 미체결 계열을 지우면서 디스크에 남은 구 payload 는 kind 버전 범프로
    걸러지지만, 그것과 **별개로** 모델이 미지 키에 터지지 않는 것이 계약이다
    (pydantic 기본이 extra='ignore' 라는 사실에 의존한다 — 바뀌면 여기가 빨개진다).

    ⚠ 버전은 **현재 값**으로 기록한다 — 숫자를 박으면 kind 범프마다 이 테스트가
    깨지는데, 여기서 재는 것은 버전이 아니라 **없는 필드의 기본값 처리**다.
    """
    from hoga.api import past_indicators_cache as mod

    peak_dir = _store_dir(tmp_path)
    peak_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": mod.KIND_VERSIONS["ask_peak"],
        "value": {
            "date": "20260619",
            "price": 70000,
            "qty": 1000,
            "t_ms": 1,
            "max_price": 70000,
            "max_qty": 1000,
            "max_t_ms": 1,
            # ADR-0156 이후 모델에 없는 키 — 조용히 버려져야 한다.
            "untraded_price": 69900,
            "untraded_qty": 900,
            "untraded_t_ms": 2,
        },
        "fetched_at_ms": 0,
    }
    (peak_dir / "20260619.ask_peak.60000.json").write_text(json.dumps(payload), encoding="utf-8")
    (peak_dir / "20260619.bid_peak.60000.json").write_text(json.dumps(payload), encoding="utf-8")

    reloaded = PastIndicatorsCache(tmp_path)
    ask = reloaded.get_ask_peak("005930", "20260619", SRC, 60_000)
    bid = reloaded.get_bid_peak("005930", "20260619", SRC, 60_000)

    assert ask is not None
    assert (ask.price, ask.qty, ask.t_ms) == (70000, 1000, 1)
    assert ask.traded_peaks == []
    assert ask.all_peaks == []
    assert not hasattr(ask, "untraded_price")
    assert bid is not None
    assert (bid.price, bid.qty, bid.t_ms) == (70000, 1000, 1)
    assert bid.traded_peaks == []
    assert bid.all_peaks == []


def test_trade_volume_poc_cache_survives_new_cache_instance(tmp_path: Path) -> None:
    cache = PastIndicatorsCache(tmp_path)
    poc = TradeVolumePoc(
        date="20260619",
        center_price=70000,
        low_price=69900,
        high_price=70100,
        qty=123,
        t_ms=1,
        band_pct=0.005,
    )
    cache.store_trade_volume_poc("005930", "20260619", "hogaplay", 10, 69900, 70100, poc)

    reloaded = PastIndicatorsCache(tmp_path)
    assert reloaded.get_trade_volume_poc("005930", "20260619", "hogaplay", 10, 69900, 70100) == poc


def test_mem_overlay_bounded_falls_back_to_disk(tmp_path: Path) -> None:
    """WS4: 인메모리 오버레이는 상한을 넘으면 LRU 축출하되, 디스크
    read-through로 값 자체는 보존된다 (관측 가능 동작 불변, 메모리만 유계)."""
    cache = PastIndicatorsCache(tmp_path, mem_max_entries=2)
    rows_by_date = {}
    for i, date_s in enumerate(("20260601", "20260602", "20260603")):
        rows = [QuoteRatioRow(
            bucket_intra_ms=60_000, bid_total=100 + i, ask_total=200 + i,
            bid_max=10, ask_max=20, imb_max_bid=1, imb_max_ask=2,
        )]
        rows_by_date[date_s] = rows
        cache.store_ratio("005930", date_s, "kiwoom_live", rows)

    assert len(cache._mem_ratio) == 2  # 상한 유지
    # 축출된 첫 날짜도 디스크에서 그대로 읽힌다.
    got = cache.get_ratio("005930", "20260601", "kiwoom_live")
    assert got == rows_by_date["20260601"]


# ── depth_heatmap ────────────────────────────────────────────────────────────

_DEPTH = [
    DepthHeatmapPoint(
        t_ms=1_700_000_000_000,
        asks=[[70100, 5], [70200, 3]],
        bids=[[70000, 8], [69900, 2]],
        asks_max=[[70100, 9], [70200, 4]],
        bids_max=[[70000, 12], [69900, 6]],
    ),
    DepthHeatmapPoint(t_ms=1_700_000_060_000),  # 빈 레벨 버킷도 유효 데이터
]


def test_depth_roundtrip_in_memory(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    assert c.get_depth(CODE, DATE, SRC, 60_000) is CACHE_MISS
    c.store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    assert c.get_depth(CODE, DATE, SRC, 60_000) == _DEPTH


def test_depth_empty_list_is_a_valid_cached_result(tmp_path: Path) -> None:
    # 무데이터 거래일은 [] 를 캐시한다 — get 은 [](캐시됨)와 CACHE_MISS(미캐시)를 구분해야.
    c = PastIndicatorsCache(tmp_path)
    c.store_depth(CODE, DATE, SRC, 60_000, [])
    assert c.get_depth(CODE, DATE, SRC, 60_000) == []
    assert c.get_depth(CODE, DATE, SRC, 60_000) is not CACHE_MISS


def test_depth_persists_to_disk_across_instances(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    fresh = PastIndicatorsCache(tmp_path)  # cold memory → reconstruct from disk
    assert fresh.get_depth(CODE, DATE, SRC, 60_000) == _DEPTH


def test_depth_bucket_ms_is_part_of_the_key(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    assert c.get_depth(CODE, DATE, SRC, 300_000) is CACHE_MISS


def test_depth_disk_payload_shape_is_frozen(tmp_path: Path) -> None:
    """디스크 payload 의 **키 집합과 값**을 못 박는다.

    이 캐시의 포맷을 바꾸면 사용자가 재계산을 치른다 — 파일 docstring 이 그 비용을
    "`/study` 콜드 로드 사고 그 자체(콜드 비용의 95%+ = peak 재계산, 수십 분)" 라고
    적어 뒀다. 그런데 "새 인스턴스에서 디스크로 살아남는다" 류 테스트는 **같은 코드로
    쓰고 같은 코드로 읽으므로** 읽기·쓰기를 함께 바꾸면 조용히 통과한다. 이 테스트는
    파일 내용을 직접 보므로 그 경우에도 빨개진다.
    """
    PastIndicatorsCache(tmp_path).store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    body = json.loads(
        (_store_dir(tmp_path) / f"{DATE}.depth.60000.json").read_text(encoding="utf-8")
    )
    assert set(body) == {"version", "points", "fetched_at_ms"}
    assert body["version"] == KIND_VERSIONS["depth"]
    assert body["points"] == [p.model_dump(mode="json") for p in _DEPTH]
    assert isinstance(body["fetched_at_ms"], int)


def test_depth_path_layout(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    assert (_store_dir(tmp_path) / f"{DATE}.depth.60000.json").exists()


def test_depth_version_mismatch_is_a_miss(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    p = _store_dir(tmp_path) / f"{DATE}.depth.60000.json"
    body = json.loads(p.read_text(encoding="utf-8"))
    body["version"] = -1
    p.write_text(json.dumps(body), encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_depth(CODE, DATE, SRC, 60_000) is CACHE_MISS


def test_depth_mem_overlay_bounded_falls_back_to_disk(tmp_path: Path) -> None:
    cache = PastIndicatorsCache(tmp_path, mem_max_depth_entries=2)
    for date_s in ("20260601", "20260602", "20260603"):
        cache.store_depth("005930", date_s, "kiwoom_live", 60_000, _DEPTH)
    assert len(cache._mem_depth) == 2  # 전용 상한 유지(공용 512 아님)
    assert cache.get_depth("005930", "20260601", "kiwoom_live", 60_000) == _DEPTH  # 디스크 복원


# ── volume_distribution (체결 분포) ──────────────────────────────────────────

_VDIST = DayVolumeDistribution(
    date=DATE, range_count=10, price_min=70_000, price_max=71_000,
    session_open_ms=1_700_000_000_000, session_close_ms=1_700_020_000_000,
    last_trade_ms=1_700_019_000_000,
    bins=[VolumeDistributionBin(price_low=70_000, price_high=70_100, qty=500)],
)
_VD_KEY = (CODE, DATE, SRC, 10, 70_000, 71_000)


def test_vdist_roundtrip_and_miss_sentinel(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    assert c.get_volume_distribution(*_VD_KEY) is CACHE_MISS
    c.store_volume_distribution(*_VD_KEY, _VDIST)
    assert c.get_volume_distribution(*_VD_KEY) == _VDIST


def test_vdist_none_is_a_valid_cached_result(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_volume_distribution(*_VD_KEY, None)
    assert c.get_volume_distribution(*_VD_KEY) is None
    assert c.get_volume_distribution(*_VD_KEY) is not CACHE_MISS


def test_vdist_persists_and_price_range_is_part_of_key(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_volume_distribution(*_VD_KEY, _VDIST)
    fresh = PastIndicatorsCache(tmp_path)  # cold memory → disk reconstruct
    assert fresh.get_volume_distribution(*_VD_KEY) == _VDIST
    # price_max 다르면 별도 엔트리(파일명에 박힘).
    assert fresh.get_volume_distribution(CODE, DATE, SRC, 10, 70_000, 72_000) is CACHE_MISS


def test_vdist_path_layout(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_volume_distribution(*_VD_KEY, _VDIST)
    assert (
        _store_dir(tmp_path)
        / f"{DATE}.volume_distribution.10.70000.71000.json"
    ).exists()


# ── broker_late_entries (거래원 지각 진입) ───────────────────────────────────

_BROKER = [
    BrokerLateEntryEvent(t_ms=1_700_019_000_000, broker="미래에셋", side="buy", net=1200),
    BrokerLateEntryEvent(t_ms=1_700_019_060_000, broker="키움", side="sell", net=-800),
]




# ── 단일 모델 kind 표 ──────────────────────────────────────────────────────────
#
# `_read_model_cache` 계열(단일 모델 하나를 싣는 kind)에는 **버전 불일치·손상 파일
# 테스트가 아예 없었다.** #1352 의 red-check 이 그것을 드러냈다 — 그 계열의 버전 검사를
# 무력화했는데 **아무것도 실패하지 않았다.**
#
# `_is_stale` 은 capture meta 의 mtime 만 보므로 "데이터가 바뀌었나" 는 알아도 **"계산
# 로직이 바뀌었나" 는 모른다**. kind 버전이 그 축을 대신하는데, 그 축을 지키는 테스트가
# 이 계열에 없었다.


def _sole_cache_file(tmp_path: Path) -> Path:
    """방금 저장된 캐시 파일 하나. 파일명 규칙을 **표가 알 필요 없게** 한다 —
    규칙이 바뀌어도 이 표는 안 깨지고, 파일이 둘이면 오히려 실패해서 표가 잘못
    쓰였다는 것을 알려준다(경로 레이아웃 자체는 kind 별 기존 테스트가 따로 잰다)."""
    files = sorted(_store_dir(tmp_path).glob("*.json"))
    assert len(files) == 1, f"기대: 캐시 파일 1개, 실제: {[f.name for f in files]}"
    return files[0]


@dataclass(frozen=True)
class _ModelKindCase:
    """단일 모델을 디스크에 싣는 kind 하나."""

    kind: str
    store: Callable[[PastIndicatorsCache], None]
    get: Callable[[PastIndicatorsCache], object]
    expected: object
    miss: object


_POC_SAMPLE = TradeVolumePoc(
    date=DATE, center_price=70_500, low_price=70_400, high_price=70_600, qty=321, t_ms=17, band_pct=0.005
)
_ASK_PEAK_SAMPLE = AskPeak(date=DATE, price=71_000, qty=7, t_ms=11, max_price=71_000, max_qty=7, max_t_ms=11)
_BID_PEAK_SAMPLE = BidPeak(date=DATE, price=70_000, qty=5, t_ms=13, max_price=70_000, max_qty=5, max_t_ms=13)

# peak 은 `has_*` 가 디스크→mem 승격을 맡고 `get_*` 은 승격된 값을 재조회한다(조회 통계도
# `has_*` 에서만 계수된다). 그래서 표의 `get` 이 둘을 함께 부른다 — 이 비대칭 자체가
# 이 계열의 사실이라 표가 그것을 숨기지 않는다.
_MODEL_KIND_CASES = [
    _ModelKindCase(
        "ask_peak",
        lambda c: c.store_ask_peak(CODE, DATE, SRC, 60_000, _ASK_PEAK_SAMPLE),
        lambda c: (c.has_ask_peak(CODE, DATE, SRC, 60_000), c.get_ask_peak(CODE, DATE, SRC, 60_000))[1],
        _ASK_PEAK_SAMPLE,
        None,
    ),
    _ModelKindCase(
        "bid_peak",
        lambda c: c.store_bid_peak(CODE, DATE, SRC, 60_000, _BID_PEAK_SAMPLE),
        lambda c: (c.has_bid_peak(CODE, DATE, SRC, 60_000), c.get_bid_peak(CODE, DATE, SRC, 60_000))[1],
        _BID_PEAK_SAMPLE,
        None,
    ),
    _ModelKindCase(
        "vdist",
        lambda c: c.store_volume_distribution(CODE, DATE, SRC, 10, 70_000, 71_000, _VDIST),
        lambda c: c.get_volume_distribution(CODE, DATE, SRC, 10, 70_000, 71_000),
        _VDIST,
        CACHE_MISS,
    ),
    _ModelKindCase(
        "poc",
        lambda c: c.store_trade_volume_poc(CODE, DATE, SRC, 10, 70_000, 71_000, _POC_SAMPLE),
        lambda c: c.get_trade_volume_poc(CODE, DATE, SRC, 10, 70_000, 71_000),
        _POC_SAMPLE,
        CACHE_MISS,
    ),
    # 스칼라 kind — 모델이 아니라 `int | None` 을 싣지만 **저장 메커니즘의 명제는 같다**.
    # `None` 도 유효 캐시값이라 미스와 구별된다(그 명제는 아래 고유 테스트가 따로 잰다).
    _ModelKindCase(
        "continuous_before",
        lambda c: c.store_continuous_before(CODE, DATE, SRC, 153_000_000, 70_800),
        lambda c: c.get_continuous_before(CODE, DATE, SRC, 153_000_000),
        70_800,
        CACHE_MISS,
    ),
    # `ratio`·`fill` 은 `_read`/`_write` 계열 — 모델이 아니라 raw tuple 리스트를 싣고,
    # **미스 신호가 `None`** 인 유일한 계열이다(나머지는 `_CACHE_MISS` 센티넬). 그 비대칭은
    # 표의 `miss` 칸이 담는다 — 표가 kind 를 같게 취급하려고 사실을 뭉개면 안 된다.
    _ModelKindCase(
        "ratio",
        lambda c: c.store_ratio(CODE, DATE, SRC, RATIO),
        lambda c: c.get_ratio(CODE, DATE, SRC),
        RATIO,
        None,
    ),
    _ModelKindCase(
        "fill",
        lambda c: c.store_fill(CODE, DATE, SRC, FILL),
        lambda c: c.get_fill(CODE, DATE, SRC),
        FILL,
        None,
    ),
]

_MODEL_KIND_IDS = [c.kind for c in _MODEL_KIND_CASES]



def test_kind_tables_cover_every_kind() -> None:
    """두 표가 `KIND_VERSIONS` 전수를 덮는가.

    **이 테스트가 이 파일에서 가장 중요한 한 줄이다.** 명제를 표로 모아도 새 kind 를
    표에 넣는 것이 규율로 남으면 결국 또 빠진다 — 실제로 `wall_surge`(그리고 그때 함께
    있었고 지금은 제거된 `depth_delta`)가 그렇게 캐시 테스트 0건이었고, 단일 모델 계열은
    버전 축이 통째로 비어 있었다. 여기가
    빨개지면 "표에 한 줄" 이 규율이 아니라 **요구**가 된다.
    """
    covered = {c.kind for c in _LIST_KIND_CASES} | {c.kind for c in _MODEL_KIND_CASES}
    missing = set(KIND_VERSIONS) - covered
    extra = covered - set(KIND_VERSIONS)
    assert covered == set(KIND_VERSIONS), (
        f"표가 덮지 않는 kind={sorted(missing)} / KIND_VERSIONS 에 없는 표 항목={sorted(extra)}. "
        "kind 를 추가했다면 위 두 표 중 저장 형태가 맞는 쪽에 한 줄을 더한다."
    )

@pytest.mark.parametrize("case", _MODEL_KIND_CASES, ids=_MODEL_KIND_IDS)
def test_model_kind_persists_to_disk_across_instances(case: _ModelKindCase, tmp_path: Path) -> None:
    case.store(PastIndicatorsCache(tmp_path))
    assert case.get(PastIndicatorsCache(tmp_path)) == case.expected  # cold memory → 디스크 복원


@pytest.mark.parametrize("case", _MODEL_KIND_CASES, ids=_MODEL_KIND_IDS)
def test_model_kind_version_mismatch_is_a_miss(case: _ModelKindCase, tmp_path: Path) -> None:
    case.store(PastIndicatorsCache(tmp_path))
    path = _sole_cache_file(tmp_path)
    body = json.loads(path.read_text(encoding="utf-8"))
    body["version"] = KIND_VERSIONS[case.kind] + 1
    path.write_text(json.dumps(body), encoding="utf-8")
    assert case.get(PastIndicatorsCache(tmp_path)) is case.miss


@pytest.mark.parametrize("case", _MODEL_KIND_CASES, ids=_MODEL_KIND_IDS)
def test_model_kind_corrupt_file_is_a_miss(case: _ModelKindCase, tmp_path: Path) -> None:
    case.store(PastIndicatorsCache(tmp_path))
    _sole_cache_file(tmp_path).write_text("{not json", encoding="utf-8")
    assert case.get(PastIndicatorsCache(tmp_path)) is case.miss


# ── kind 파라미터화 테이블 ─────────────────────────────────────────────────────
#
# 아래 명제들은 **저장 메커니즘의 성질**이지 kind 고유 규칙이 아니다. 종전엔 kind 마다
# 손으로 반복돼 있었고(버전 불일치 7회 · 재캡처 5회 · 빈 결과 6회 · 디스크 생존 7회),
# 그래서 새 kind 가 생겨도 **아무도 그 표에 넣지 않는 일**이 벌어졌다 — 실제로
# `wall_surge` 는 캐시 단위 테스트가 **0건**이었다(roundtrip · 버전 · `[]`-유효 ·
# 손상 전부 없음). 이제 표에 한 줄을 더하면 다섯 명제가 함께 붙는다.
#
# kind **고유** 명제(POC 의 cutoff 제외, `wall_surge` 의 bucket_ms 부재, ratio 의 7-tuple
# 직렬화 등)는 이 표가 아니라 각자의 자리에 그대로 둔다 — 표는 공통분만 담는다.


@dataclass(frozen=True)
class _ListKindCase:
    """list-of-model 을 디스크에 싣는 kind 하나."""

    kind: str
    filename: str
    store: Callable[[PastIndicatorsCache, list], None]
    get: Callable[[PastIndicatorsCache], object]
    sample: list


_PEAK_REP_SAMPLE = [
    PeakRepRow(bucket_id=3, side="ask", price=70_100, qty=900, intra_ms=180_000, seq=2, touched=True),
    PeakRepRow(bucket_id=3, side="bid", price=70_000, qty=800, intra_ms=180_000, seq=2, touched=False),
]
_WALL_SURGE_SAMPLE = [
    WallSurgeEvent(t_ms=1_764_000_000_000, side="ask", price=70_100, qty=900, jump=700, total=5_000, kind="grow")
]

_LIST_KIND_CASES = [
    _ListKindCase(
        "peak_rep",
        f"{DATE}.peak_rep.json",   # 1분 고정이라 파일명에 bucket 이 없다
        lambda c, v: c.store_peak_rep(CODE, DATE, SRC, v),
        lambda c: c.get_peak_rep(CODE, DATE, SRC),
        _PEAK_REP_SAMPLE,
    ),
    _ListKindCase(
        "depth",
        f"{DATE}.depth.60000.json",
        lambda c, v: c.store_depth(CODE, DATE, SRC, 60_000, v),
        lambda c: c.get_depth(CODE, DATE, SRC, 60_000),
        _DEPTH,
    ),
    _ListKindCase(
        "wall_surge",
        f"{DATE}.wall_surge.json",
        lambda c, v: c.store_wall_surge(CODE, DATE, SRC, v),
        lambda c: c.get_wall_surge(CODE, DATE, SRC),
        _WALL_SURGE_SAMPLE,
    ),
    _ListKindCase(
        "broker_late",
        f"{DATE}.broker_late.930.json",
        lambda c, v: c.store_broker_late(CODE, DATE, SRC, 930, v),
        lambda c: c.get_broker_late(CODE, DATE, SRC, 930),
        _BROKER,
    ),
]

_LIST_KIND_IDS = [c.kind for c in _LIST_KIND_CASES]


@pytest.mark.parametrize("case", _LIST_KIND_CASES, ids=_LIST_KIND_IDS)
def test_list_kind_roundtrips_through_memory(case: _ListKindCase, tmp_path: Path) -> None:
    cache = PastIndicatorsCache(tmp_path)
    case.store(cache, case.sample)
    assert case.get(cache) == case.sample


@pytest.mark.parametrize("case", _LIST_KIND_CASES, ids=_LIST_KIND_IDS)
def test_list_kind_persists_to_disk_across_instances(case: _ListKindCase, tmp_path: Path) -> None:
    case.store(PastIndicatorsCache(tmp_path), case.sample)
    assert case.get(PastIndicatorsCache(tmp_path)) == case.sample  # cold memory → 디스크에서 복원


@pytest.mark.parametrize("case", _LIST_KIND_CASES, ids=_LIST_KIND_IDS)
def test_list_kind_empty_is_a_valid_cached_value(case: _ListKindCase, tmp_path: Path) -> None:
    """`[]` 는 **캐시된 사실**이지 미스가 아니다 — 구별 못 하면 매번 재계산한다."""
    case.store(PastIndicatorsCache(tmp_path), [])
    assert case.get(PastIndicatorsCache(tmp_path)) == []


@pytest.mark.parametrize("case", _LIST_KIND_CASES, ids=_LIST_KIND_IDS)
def test_list_kind_version_mismatch_is_a_miss(case: _ListKindCase, tmp_path: Path) -> None:
    """`_is_stale` 은 capture meta 의 mtime 만 보므로 **계산 로직이 바뀐 것은 모른다** —
    그래서 kind 버전이 그 축을 대신한다."""
    case.store(PastIndicatorsCache(tmp_path), case.sample)
    path = _store_dir(tmp_path) / case.filename
    body = json.loads(path.read_text(encoding="utf-8"))
    body["version"] = KIND_VERSIONS[case.kind] + 1
    path.write_text(json.dumps(body), encoding="utf-8")
    assert case.get(PastIndicatorsCache(tmp_path)) is CACHE_MISS


@pytest.mark.parametrize("case", _LIST_KIND_CASES, ids=_LIST_KIND_IDS)
def test_list_kind_corrupt_file_is_a_miss(case: _ListKindCase, tmp_path: Path) -> None:
    """손상 파일은 예외가 아니라 미스여야 한다 — 캐시가 죽으면 라우트가 함께 죽는다."""
    case.store(PastIndicatorsCache(tmp_path), case.sample)
    (_store_dir(tmp_path) / case.filename).write_text("{not json", encoding="utf-8")
    assert case.get(PastIndicatorsCache(tmp_path)) is CACHE_MISS


def test_broker_late_roundtrip_and_empty_valid(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    assert c.get_broker_late(CODE, DATE, SRC, 930) is CACHE_MISS
    c.store_broker_late(CODE, DATE, SRC, 930, _BROKER)
    assert c.get_broker_late(CODE, DATE, SRC, 930) == _BROKER
    # [] 도 유효 캐시값.
    c.store_broker_late(CODE, DATE, SRC, 1000, [])
    assert c.get_broker_late(CODE, DATE, SRC, 1000) == []
    assert c.get_broker_late(CODE, DATE, SRC, 1000) is not CACHE_MISS


def test_broker_late_persists_and_hhmm_is_part_of_key(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_broker_late(CODE, DATE, SRC, 930, _BROKER)
    fresh = PastIndicatorsCache(tmp_path)
    assert fresh.get_broker_late(CODE, DATE, SRC, 930) == _BROKER
    assert fresh.get_broker_late(CODE, DATE, SRC, 1000) is CACHE_MISS


def test_broker_late_version_mismatch_is_a_miss(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_broker_late(CODE, DATE, SRC, 930, _BROKER)
    p = _store_dir(tmp_path) / f"{DATE}.broker_late.930.json"
    body = json.loads(p.read_text(encoding="utf-8"))
    body["version"] = -1
    p.write_text(json.dumps(body), encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_broker_late(CODE, DATE, SRC, 930) is CACHE_MISS


# ── continuous_before_ms (선행 스칼라) ───────────────────────────────────────


def test_continuous_before_roundtrip_none_and_int(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    assert c.get_continuous_before(CODE, DATE, SRC, 153_000_000) is CACHE_MISS
    # int 값
    c.store_continuous_before(CODE, DATE, SRC, 153_000_000, 151_030_000)
    assert c.get_continuous_before(CODE, DATE, SRC, 153_000_000) == 151_030_000
    # None(경계 없음)도 유효 캐시값 → 센티널과 구분
    c.store_continuous_before(CODE, DATE, "other", 153_000_000, None)
    assert c.get_continuous_before(CODE, DATE, "other", 153_000_000) is None
    assert c.get_continuous_before(CODE, DATE, "other", 153_000_000) is not CACHE_MISS


def test_continuous_before_persists_and_close_ms_is_part_of_key(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_continuous_before(CODE, DATE, SRC, 153_000_000, 151_030_000)
    fresh = PastIndicatorsCache(tmp_path)
    assert fresh.get_continuous_before(CODE, DATE, SRC, 153_000_000) == 151_030_000
    assert fresh.get_continuous_before(CODE, DATE, SRC, 133_000_000) is CACHE_MISS


# ── capture-freshness (재캡처 시 stale 슬라이스 무효화) ─────────────────────────
# 07/22 사건: 빈약한 초기 캡처가 ratio 1포인트를 캐시 → 전량 재캡처로 snapshots.parquet
# 이 교체됐으나 (code,date,source) 키가 동일해 캐시가 그대로 서빙됨. 이제 meta.json
# mtime(캡처 신원)이 캐시 기록 시각(fetched_at_ms)보다 나중이면 stale로 판정한다.


def _write_source_meta(tmp_path: Path, code: str, date: str, source: str, mtime_s: float) -> None:
    """Create the source's meta.json with a controlled mtime.

    경로 조립은 **정본 헬퍼**에 맡긴다 — 손으로 조립하면 venue 축이 있는 소스
    (`kiwoom_live`)에서 세그먼트가 빠져 무효화 판정이 파일을 못 찾는다.
    """
    from hoga.api.sources import source_venue_dir

    meta = source_venue_dir(tmp_path / "parquet" / date / code, source, "KRX") / "meta.json"
    meta.parent.mkdir(parents=True, exist_ok=True)
    meta.write_text("{}", encoding="utf-8")
    os.utime(meta, (mtime_s, mtime_s))


def _cache_fetched_at_ms(tmp_path: Path, code: str, date: str, source: str, kind: str) -> int:
    p = _store_dir(tmp_path, code, source) / f"{date}.{kind}.json"
    return int(json.loads(p.read_text(encoding="utf-8"))["fetched_at_ms"])


def test_disk_slice_invalidated_when_source_recaptured(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    fetched = _cache_fetched_at_ms(tmp_path, CODE, DATE, SRC, "ratio")
    # source re-captured 60s AFTER the cache was written
    _write_source_meta(tmp_path, CODE, DATE, SRC, mtime_s=fetched / 1000 + 60)
    # a cold instance (no mem) must treat the on-disk slice as stale
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None


def test_mem_slice_invalidated_when_source_recaptured(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)
    assert c.get_ratio(CODE, DATE, SRC) == RATIO  # warm the in-memory entry
    fetched = _cache_fetched_at_ms(tmp_path, CODE, DATE, SRC, "ratio")
    _write_source_meta(tmp_path, CODE, DATE, SRC, mtime_s=fetched / 1000 + 60)
    # SAME long-lived instance: the generation guard must drop the stale mem entry
    # (without it, the warm mem hit would keep returning the pre-recapture slice).
    assert c.get_ratio(CODE, DATE, SRC) is None


def test_model_slice_invalidated_when_source_recaptured(tmp_path: Path) -> None:
    # non-ratio kind travels the _read_model_cache gate — verify it too (depth).
    PastIndicatorsCache(tmp_path).store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    fetched = _cache_fetched_at_ms(tmp_path, CODE, DATE, SRC, "depth.60000")
    _write_source_meta(tmp_path, CODE, DATE, SRC, mtime_s=fetched / 1000 + 60)
    assert PastIndicatorsCache(tmp_path).get_depth(CODE, DATE, SRC, 60_000) is CACHE_MISS


def test_fresh_slice_survives_when_source_older_than_cache(tmp_path: Path) -> None:
    # normal flow: capture happens first, indicator cached after → keep the cache.
    _write_source_meta(tmp_path, CODE, DATE, SRC, mtime_s=1.0)  # ancient source
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)  # fetched_at_ms = now >> source mtime
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) == RATIO


def test_missing_source_meta_is_lenient(tmp_path: Path) -> None:
    # no parquet/meta on disk (legacy flat layout / pure-cache fixtures): capture
    # token is unknown (0) → never invalidate an otherwise-valid slice.
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) == RATIO


# ── 스레드 안전성 (`/api/range` 는 sync 라우트 = anyio 스레드풀) ────────────────
#
# `/api/range` 는 `def api_range`(async 아님)라 Starlette 이 anyio 스레드풀에서
# 돌린다 — 이 캐시의 OrderedDict 들이 **여러 스레드에서 동시에 변이된다**. 락이 없던
# 동안 `_sync_generation` 의 prefix purge 가 순회 중 삭제와 겹치면
# `RuntimeError: dictionary changed size during iteration` 이 되고, LRU 축출과
# `move_to_end` 가 겹치면 `KeyError` 가 난다.
#
# 여기서는 스레드를 띄워 경합을 **기다리지** 않는다: GIL 아래서 dict 연산이 워낙
# 빨라 그런 테스트는 버그가 있어도 통과해 커버리지를 위장한다(실측 확인). 대신
# 불변식을 직접 검사한다 — **모든 변이가 락 보유 중에 일어나는가**. 결정론적이고,
# 락을 지우면 반드시 실패한다.


class _TrackedLock:
    """보유 여부를 스레드별로 추적하는 락 래퍼."""

    def __init__(self, inner) -> None:
        self._inner = inner
        self._local = threading.local()

    def __enter__(self):
        self._inner.__enter__()
        self._local.depth = getattr(self._local, "depth", 0) + 1
        return self

    def __exit__(self, *exc) -> bool | None:
        self._local.depth = getattr(self._local, "depth", 1) - 1
        return self._inner.__exit__(*exc)

    @property
    def held(self) -> bool:
        return getattr(self._local, "depth", 0) > 0


class _LockAssertingDict(OrderedDict):
    """변이 시 락 보유를 단언하는 OrderedDict."""

    def __init__(self, lock: _TrackedLock, name: str, src: OrderedDict) -> None:
        super().__init__(src)
        self._lock_ref = lock
        self._name = name

    def _require_lock(self, op: str) -> None:
        assert self._lock_ref.held, f"{self._name}.{op}() 이 락 밖에서 실행됐다"

    def __setitem__(self, key, value) -> None:
        self._require_lock("__setitem__")
        super().__setitem__(key, value)

    def __delitem__(self, key) -> None:
        self._require_lock("__delitem__")
        super().__delitem__(key)

    def move_to_end(self, key, last: bool = True) -> None:
        self._require_lock("move_to_end")
        super().move_to_end(key, last)

    def popitem(self, last: bool = True):
        self._require_lock("popitem")
        return super().popitem(last)

    def pop(self, key, *default):
        self._require_lock("pop")
        return super().pop(key, *default)


def _instrument(cache: PastIndicatorsCache) -> _TrackedLock:
    """캐시의 락을 추적 래퍼로, 모든 mem dict 를 단언 dict 로 교체한다."""
    lock = _TrackedLock(cache._lock)
    cache._lock = lock
    names = [n for n in vars(cache) if n.startswith("_mem_")]
    for name in names:
        value = getattr(cache, name)
        if isinstance(value, OrderedDict):
            setattr(cache, name, _LockAssertingDict(lock, name, value))
    # _all_mem_dicts 는 같은 객체들의 튜플이라 교체 후 다시 묶어야 purge 가 새 dict 를 본다.
    # 이 목록이 프로덕션 `_all_mem_dicts` 보다 짧으면 그만큼이 **감시 밖**이 된다 —
    # 실제로 `_mem_wall_surge` 가 빠져 있었고 아무도 몰랐다. 개수를 못 박아 재발을 막는다.
    _production_count = len(cache._all_mem_dicts)
    cache._all_mem_dicts = tuple(
        getattr(cache, n) for n in (
            "_mem_ratio", "_mem_fill", "_mem_ask_peak", "_mem_bid_peak",
            "_mem_trade_volume_poc", "_mem_depth",
            # `_mem_wall_surge` 가 빠져 있었다 — 프로덕션 `_all_mem_dicts` 보다 이 목록이
            # 하나 짧아서, wall_surge dict 의 락 위반을 아무도 못 봤다.
            "_mem_wall_surge",
            "_mem_vdist", "_mem_broker_late", "_mem_continuous_before",
        )
    )
    assert len(cache._all_mem_dicts) == _production_count, (
        "락 감시 목록이 프로덕션 `_all_mem_dicts` 와 개수가 다르다 — 빠진 dict 는 "
        "락 위반이 나도 이 테스트가 못 본다."
    )
    return lock


def _seed_meta(tmp_path: Path, *, code: str, date: str, source: str, marker: int) -> None:
    """meta.json 을 써서 capture 토큰(mtime)을 만든다 — _sync_generation 의 입력."""
    d = tmp_path / "parquet" / date / code / source
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps({"marker": marker}), encoding="utf-8")


def test_every_mem_mutation_happens_under_the_lock(tmp_path: Path) -> None:
    """put · LRU 축출 · getter 의 move_to_end · 재캡처 purge 전부 락 안에서."""
    cache = PastIndicatorsCache(tmp_path, mem_max_entries=2)
    _instrument(cache)
    date, source = "20260701", "hogaplay"

    # put + LRU 축출(상한 2를 넘겨 popitem 을 강제)
    for i in range(5):
        code = f"{i:06d}"
        _seed_meta(tmp_path, code=code, date=date, source=source, marker=i)
        cache.store_ratio(code, date, source, RATIO)

    # getter 히트 경로(move_to_end)
    assert cache.get_ratio("000004", date, source) is not None

    # None 을 유효값으로 쓰는 kind 의 히트 경로
    cache.store_ask_peak("000004", date, source, 60_000, None)
    assert cache.has_ask_peak("000004", date, source, 60_000)
    cache.get_ask_peak("000004", date, source, 60_000)

    # 재캡처 → prefix purge (토큰 전진 후 같은 키를 다시 조회)
    cache.store_ratio("000004", date, source, RATIO)
    os.utime(
        tmp_path / "parquet" / date / "000004" / source / "meta.json",
        (10_000_000, 10_000_000),
    )
    cache.get_ratio("000004", date, source)


def test_lock_assertion_catches_an_unlocked_mutation(tmp_path: Path) -> None:
    """가드 자체가 작동하는지 — 락 밖 변이를 실제로 잡는다.

    이게 없으면 위 테스트가 "변이가 한 번도 안 일어나서" 통과하는 경우와
    구별되지 않는다.
    """
    import pytest

    cache = PastIndicatorsCache(tmp_path, mem_max_entries=8)
    _instrument(cache)
    with pytest.raises(AssertionError, match="락 밖에서"):
        cache._mem_ratio["x"] = []
