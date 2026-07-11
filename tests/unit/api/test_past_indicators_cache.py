"""PastIndicatorsCache — disk cache of 1m quote_ratio / fill_strength rows."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.models import (
    AskPeak,
    BidPeak,
    BrokerLateEntryEvent,
    DayVolumeDistribution,
    DepthHeatmapPoint,
    TradeVolumePoc,
    VolumeDistributionBin,
)
from hoga.api.past_indicators_cache import CACHE_MISS, PastIndicatorsCache
from hoga.tables.snapshots import QuoteRatioRow
from hoga.tables.trades import FillStrengthRow

CODE = "005930"
DATE = "20260529"
SRC = "kis_live"

RATIO = [QuoteRatioRow(bucket_intra_ms=0, bid_total=10, ask_total=20,
                       bid_max=900, ask_max=800, imb_max_bid=100, imb_max_ask=2),
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
    assert (tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json").exists()


def test_source_is_part_of_the_key(tmp_path: Path) -> None:
    # Same (code, date), different source → independent entries (no silent swap).
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, "kis_live", RATIO)
    assert c.get_ratio(CODE, DATE, "hogaplay") is None


def test_corrupt_file_is_a_miss(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json"
    p.write_text("{ not json", encoding="utf-8")
    PastIndicatorsCache(tmp_path)  # cold instance bypasses memory
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None


def test_version_mismatch_is_a_miss(tmp_path: Path) -> None:
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, RATIO)
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json"
    body = json.loads(p.read_text())
    body["version"] = 999
    p.write_text(json.dumps(body), encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None


def test_empty_rows_roundtrip(tmp_path: Path) -> None:
    # A no-data day legitimately caches an empty list (distinct from a miss=None).
    c = PastIndicatorsCache(tmp_path)
    c.store_ratio(CODE, DATE, SRC, [])
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) == []


def test_ratio_disk_payload_is_seven_tuples(tmp_path: Path) -> None:
    """디스크 직렬화는 [bucket_intra_ms, bid_total, ask_total, bid_max, ask_max,
    imb_max_bid, imb_max_ask] 7-tuple — Intra-Bar Max 필드를 보존(ADR-0076)."""
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json"
    body = json.loads(p.read_text())
    assert body["rows"][0] == [0, 10, 20, 900, 800, 100, 2]
    assert body["rows"][1] == [60_000, 0, 0, 0, 0, 0, 0]
    # 콜드 인스턴스가 7-tuple을 동일 QuoteRatioRow로 복원.
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) == RATIO


def test_schema_version_bumped_to_6_invalidates_peak_candidate_cache(tmp_path: Path) -> None:
    """v2→v6: 시간별 후보 배열 없는 peak 캐시는 버전 미스로 무효."""
    from hoga.api import past_indicators_cache as mod
    assert mod.KIND_VERSIONS["ratio"] == 6
    assert mod.KIND_VERSIONS["ask_peak"] == 6
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": 1, "rows": [[0, 10, 20]], "fetched_at_ms": 0}),
                 encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None

    ask_path = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ask_peak.60000.json"
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
    assert mod.KIND_VERSIONS["ask_peak"] == 6
    assert mod.KIND_VERSIONS["bid_peak"] == 6

    peak_dir = tmp_path / "kis-past-indicators" / CODE / SRC
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
            "untraded_peaks": [],
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
    assert mod.KIND_VERSIONS["ask_peak"] == 6
    assert mod.KIND_VERSIONS["bid_peak"] == 6

    peak_dir = tmp_path / "kis-past-indicators" / CODE / SRC
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
            "untraded_peaks": [],
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


def test_peak_cache_loads_version_6_payload_without_ranked_untraded_arrays(tmp_path: Path) -> None:
    peak_dir = tmp_path / "kis-past-indicators" / CODE / SRC
    peak_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 6,
        "value": {
            "date": "20260619",
            "price": 70000,
            "qty": 1000,
            "t_ms": 1,
            "max_price": 70000,
            "max_qty": 1000,
            "max_t_ms": 1,
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
    assert ask.untraded_price == 69900
    assert ask.untraded_peaks == []
    assert ask.untraded_max_peaks == []
    assert bid is not None
    assert bid.untraded_price == 69900
    assert bid.untraded_peaks == []
    assert bid.untraded_max_peaks == []


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
        cache.store_ratio("005930", date_s, "kis_live", rows)

    assert len(cache._mem_ratio) == 2  # 상한 유지
    # 축출된 첫 날짜도 디스크에서 그대로 읽힌다.
    got = cache.get_ratio("005930", "20260601", "kis_live")
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


def test_depth_path_layout(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    assert (tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.depth.60000.json").exists()


def test_depth_version_mismatch_is_a_miss(tmp_path: Path) -> None:
    PastIndicatorsCache(tmp_path).store_depth(CODE, DATE, SRC, 60_000, _DEPTH)
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.depth.60000.json"
    body = json.loads(p.read_text(encoding="utf-8"))
    body["version"] = -1
    p.write_text(json.dumps(body), encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_depth(CODE, DATE, SRC, 60_000) is CACHE_MISS


def test_depth_mem_overlay_bounded_falls_back_to_disk(tmp_path: Path) -> None:
    cache = PastIndicatorsCache(tmp_path, mem_max_depth_entries=2)
    for date_s in ("20260601", "20260602", "20260603"):
        cache.store_depth("005930", date_s, "kis_live", 60_000, _DEPTH)
    assert len(cache._mem_depth) == 2  # 전용 상한 유지(공용 512 아님)
    assert cache.get_depth("005930", "20260601", "kis_live", 60_000) == _DEPTH  # 디스크 복원


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
        tmp_path / "kis-past-indicators" / CODE / SRC
        / f"{DATE}.volume_distribution.10.70000.71000.json"
    ).exists()


# ── broker_late_entries (거래원 지각 진입) ───────────────────────────────────

_BROKER = [
    BrokerLateEntryEvent(t_ms=1_700_019_000_000, broker="미래에셋", side="buy", net=1200),
    BrokerLateEntryEvent(t_ms=1_700_019_060_000, broker="키움", side="sell", net=-800),
]


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
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.broker_late.930.json"
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
