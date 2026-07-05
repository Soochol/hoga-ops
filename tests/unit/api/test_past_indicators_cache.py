"""PastIndicatorsCache — disk cache of 1m quote_ratio / fill_strength rows."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.models import AskPeak, BidPeak, TradeVolumePoc
from hoga.api.past_indicators_cache import PastIndicatorsCache
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


def test_schema_version_bumped_to_3_invalidates_peak_candidate_cache(tmp_path: Path) -> None:
    """SCHEMA_VERSION 2→3: 시간별 후보 배열 없는 peak 캐시는 버전 미스로 무효."""
    from hoga.api import past_indicators_cache as mod
    assert mod.SCHEMA_VERSION == 3
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


def test_peak_cache_loads_version_3_payload_without_ranked_untraded_arrays(tmp_path: Path) -> None:
    peak_dir = tmp_path / "kis-past-indicators" / CODE / SRC
    peak_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 3,
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
