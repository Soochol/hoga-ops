"""오늘자 경로가 TTL 내 재호출에서 쿼리를 다시 치지 않음을 잠근다 (ADR-0090)."""
from __future__ import annotations

from unittest.mock import patch

import duckdb
import pytest

import hoga.api.bundle as bundle_mod
from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
from hoga.tables.trades import Trade, write_parquet as trades_write_parquet


def _ob(ts_ms: int, seq: int = 1) -> Orderbook:
    z = tuple([0] * 10)
    return Orderbook(
        ts_ms=ts_ms, seq=seq,
        ask_p=tuple(25000 + 50 * i for i in range(10)),
        ask_q=tuple([100] * 10), ask_d=z,
        bid_p=tuple(24950 - 50 * i for i in range(10)),
        bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=1000, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )


def _trade(ts_ms: int, price: int = 25000, side: int = 1, seq: int = 1) -> Trade:
    return Trade(
        ts_ms=ts_ms, seq=seq, price=price, change_pct=0, qty=1, side=side,
        cum_vol=1, cum_trades=1, low_so_far=price, high_so_far=price,
        net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
    )


@pytest.fixture
def ratio_fixture(tmp_path):
    """snapshots.parquet 1개짜리 최소 engine (오늘/과거 공용)."""
    code, date, source = "005930", "20260707", "kis_live"
    d = tmp_path / date / code / source
    d.mkdir(parents=True)
    snapshots_write_parquet([_ob(90000000), _ob(90060000, seq=2)], d / "snapshots.parquet")

    class FakeEngine:
        conn = duckdb.connect()

        def parquet_dir(self, dd, cc, ss):
            return tmp_path / dd / cc / ss

    return FakeEngine(), code, date, source


@pytest.fixture
def fill_fixture(tmp_path):
    """trades.parquet 1개짜리 최소 engine (fill_strength가 trades로 폴백)."""
    code, date, source = "005930", "20260707", "kis_live"
    d = tmp_path / date / code / source
    d.mkdir(parents=True)
    trades_write_parquet(
        [_trade(90000500, side=1), _trade(90000700, side=-1)], d / "trades.parquet"
    )

    class FakeEngine:
        conn = duckdb.connect()

        def parquet_dir(self, dd, cc, ss):
            return tmp_path / dd / cc / ss

    return FakeEngine(), code, date, source


@pytest.fixture
def peak_fixture(tmp_path):
    """snapshots.parquet + trades.parquet — peak-dual 오늘 경로에 필요한 최소 세트."""
    code, date, source = "005930", "20260707", "kis_live"
    d = tmp_path / date / code / source
    d.mkdir(parents=True)
    snapshots_write_parquet([_ob(90000000), _ob(90060000, seq=2)], d / "snapshots.parquet")
    trades_write_parquet([_trade(90000500, price=25000, side=1)], d / "trades.parquet")

    class FakeEngine:
        conn = duckdb.connect()

        def parquet_dir(self, dd, cc, ss):
            return tmp_path / dd / cc / ss

    return FakeEngine(), code, date, source


def test_today_ratio_second_call_within_ttl_skips_query(ratio_fixture):
    engine, code, date, source = ratio_fixture
    with patch.object(
        bundle_mod.snapshots_tbl, "query_bucketed_ratio",
        wraps=bundle_mod.snapshots_tbl.query_bucketed_ratio,
    ) as spy:
        kw = dict(code=code, date=date, source=source, bucket_ms=60_000,
                  cache=None, today_kst=date)  # date == today → 오늘 경로
        r1 = bundle_mod.build_quote_ratio_slice(engine, **kw)
        r2 = bundle_mod.build_quote_ratio_slice(engine, **kw)
    assert spy.call_count == 1
    assert r1 == r2


def test_past_day_does_not_use_ttl(ratio_fixture):
    engine, code, date, source = ratio_fixture
    with patch.object(
        bundle_mod.snapshots_tbl, "query_bucketed_ratio",
        wraps=bundle_mod.snapshots_tbl.query_bucketed_ratio,
    ) as spy:
        kw = dict(code=code, date=date, source=source, bucket_ms=1_000,  # sub-minute → 1m 캐시 불가
                  cache=None, today_kst="29991231")  # date < today → 과거 경로
        bundle_mod.build_quote_ratio_slice(engine, **kw)
        bundle_mod.build_quote_ratio_slice(engine, **kw)
    assert spy.call_count == 2  # 과거일은 TTL 미적용


def test_today_fill_strength_second_call_within_ttl_skips_query(fill_fixture):
    engine, code, date, source = fill_fixture
    with patch.object(
        bundle_mod, "_query_fill_rows", wraps=bundle_mod._query_fill_rows,
    ) as spy:
        kw = dict(code=code, date=date, source=source, bucket_ms=60_000,
                   cache=None, today_kst=date)
        r1 = bundle_mod.build_fill_strength_slice(engine, **kw)
        r2 = bundle_mod.build_fill_strength_slice(engine, **kw)
    assert spy.call_count == 1
    assert r1 == r2


def test_today_fill_strength_none_result_is_not_cached(tmp_path):
    """빈 code_dir(체결 없음, ADR-0043 유효 무데이터) → None은 TTL에 캐시하면 안 된다:
    시가 직후 15초 내 fills/trades.parquet가 새로 생길 수 있어 stale None이 최대 TTL만큼
    새 파일을 가릴 수 있다."""
    code, date, source = "005930", "20260707", "kis_live"
    d = tmp_path / date / code / source
    d.mkdir(parents=True)  # no fills.parquet, no trades.parquet

    class FakeEngine:
        conn = duckdb.connect()

        def parquet_dir(self, dd, cc, ss):
            return tmp_path / dd / cc / ss

    engine = FakeEngine()
    with patch.object(
        bundle_mod, "_query_fill_rows", wraps=bundle_mod._query_fill_rows,
    ) as spy:
        kw = dict(code=code, date=date, source=source, bucket_ms=60_000,
                   cache=None, today_kst=date)
        r1 = bundle_mod.build_fill_strength_slice(engine, **kw)
        r2 = bundle_mod.build_fill_strength_slice(engine, **kw)
    assert spy.call_count == 2  # None must not be cached — always re-checked
    assert r1 == r2 == bundle_mod.FillStrength(bucket_ms=60_000, points=[])


def test_today_peak_dual_second_call_within_ttl_skips_query(peak_fixture):
    engine, code, date, source = peak_fixture
    with patch.object(
        bundle_mod.snapshots_tbl, "query_day_ask_bid_peak_dual",
        wraps=bundle_mod.snapshots_tbl.query_day_ask_bid_peak_dual,
    ) as spy:
        kw = dict(code=code, date=date, source=source, bucket_ms=60_000,
                   session_open_ms=90_000_000, session_close_ms=153_000_000,
                   cache=None, today_kst=date)
        r1 = bundle_mod.build_ask_bid_peak_slices(engine, **kw)
        r2 = bundle_mod.build_ask_bid_peak_slices(engine, **kw)
    assert spy.call_count == 1
    assert r1 == r2
