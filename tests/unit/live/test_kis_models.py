"""Tests for restored REST 시세 모델: OrderbookLevel/KisOrderbook/KisTrade/KisBrokerEntry/KisBrokers."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from hoga.live.kis_models import (
    KisBrokerEntry,
    KisBrokers,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)


# ---------------------------------------------------------------------------
# OrderbookLevel
# ---------------------------------------------------------------------------

def test_orderbook_level_construction() -> None:
    lvl = OrderbookLevel(price=75000, qty=500)
    assert lvl.price == 75000
    assert lvl.qty == 500


# ---------------------------------------------------------------------------
# KisOrderbook
# ---------------------------------------------------------------------------

def test_kis_orderbook_construction() -> None:
    asks = [OrderbookLevel(price=75100 + i * 100, qty=100 + i * 10) for i in range(10)]
    bids = [OrderbookLevel(price=75000 - i * 100, qty=200 + i * 10) for i in range(10)]
    ob = KisOrderbook(
        code="005930",
        asks=asks,
        bids=bids,
        total_ask_qty=5000,
        total_bid_qty=6000,
        t_ms=1717830000000,
    )
    assert ob.code == "005930"
    assert len(ob.asks) == 10
    assert len(ob.bids) == 10
    assert ob.asks[0].price == 75100  # best ask = lowest
    assert ob.bids[0].price == 75000  # best bid = highest
    assert ob.total_ask_qty == 5000
    assert ob.total_bid_qty == 6000
    assert ob.t_ms == 1717830000000


# ---------------------------------------------------------------------------
# KisTrade
# ---------------------------------------------------------------------------

def test_kis_trade_buy_side() -> None:
    t = KisTrade(price=75000, qty=10, side=1, side_source="inferred", t_ms=1717830001000)
    assert t.price == 75000
    assert t.qty == 10
    assert t.side == 1
    assert t.side_source == "inferred"
    assert t.t_ms == 1717830001000


def test_kis_trade_all_valid_sides() -> None:
    for side in (-1, 0, 1, 2):
        t = KisTrade(price=70000, qty=1, side=side, side_source="inferred", t_ms=0)
        assert t.side == side


def test_kis_trade_auction_side_source() -> None:
    t = KisTrade(price=70000, qty=100, side=2, side_source="auction", t_ms=0)
    assert t.side_source == "auction"


def test_kis_trade_invalid_side_raises() -> None:
    with pytest.raises(ValidationError):
        KisTrade(price=70000, qty=1, side=3, side_source="inferred", t_ms=0)


def test_kis_trade_invalid_side_source_raises() -> None:
    with pytest.raises(ValidationError):
        KisTrade(price=70000, qty=1, side=1, side_source="unknown", t_ms=0)


# ---------------------------------------------------------------------------
# KisBrokerEntry
# ---------------------------------------------------------------------------

def test_kis_broker_entry_construction() -> None:
    entry = KisBrokerEntry(name="미래에셋", qty=12345)
    assert entry.name == "미래에셋"
    assert entry.qty == 12345


# ---------------------------------------------------------------------------
# KisBrokers
# ---------------------------------------------------------------------------

def test_kis_brokers_construction() -> None:
    buy_top = [KisBrokerEntry(name=f"매수{i}", qty=1000 - i * 100) for i in range(5)]
    sell_top = [KisBrokerEntry(name=f"매도{i}", qty=900 - i * 100) for i in range(5)]
    brokers = KisBrokers(code="005930", buy_top=buy_top, sell_top=sell_top)
    assert brokers.code == "005930"
    assert len(brokers.buy_top) == 5
    assert len(brokers.sell_top) == 5
    assert brokers.buy_top[0].name == "매수0"
    assert brokers.sell_top[0].qty == 900
