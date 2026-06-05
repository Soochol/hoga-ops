"""Typed LiveSnapshot builders (architecture-review SR-1, backend half).

The poller builds JSONL payloads by hand (`ob.model_dump()` + `["phase"]=...`)
and stuffs them into `LiveSnapshot.payload: dict[str, Any]`, erasing the typed
KIS models at the write boundary. These builders move that construction behind
a typed seam so a KIS field rename is a type error at the poller, not a silently
zeroed parquet column at promote time.

CONTRACT (load-bearing): the builders must produce byte-identical JSONL to the
old hand-rolled path, because promote.py re-parses on-disk JSONL with defensive
`.get()` and must keep reading both old and new files. These tests pin that.
"""
from __future__ import annotations

import json

from hoga.live.kis_models import (
    KisBrokerEntry,
    KisBrokers,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def _ob() -> KisOrderbook:
    return KisOrderbook(
        code="005930",
        asks=[OrderbookLevel(price=26850, qty=6141)],
        bids=[OrderbookLevel(price=26800, qty=879)],
        total_ask_qty=102768,
        total_bid_qty=95085,
        t_ms=1779800000000,
    )


def _trades() -> list[KisTrade]:
    return [
        KisTrade(price=26900, qty=10, side=1, side_source="inferred", t_ms=1779800000001),
        KisTrade(price=26890, qty=5, side=-1, side_source="inferred", t_ms=1779800000002),
    ]


def _brokers() -> KisBrokers:
    return KisBrokers(
        code="005930",
        buy_top=[KisBrokerEntry(name="미래에셋", qty=1000)],
        sell_top=[KisBrokerEntry(name="키움", qty=900)],
    )


def test_from_orderbook_builds_ob_snapshot() -> None:
    ob = _ob()
    snap = LiveSnapshot.from_orderbook(ob, phase="regular")
    assert snap.kind is SnapshotKind.OB
    assert snap.t_ms == ob.t_ms
    assert snap.payload["phase"] == "regular"
    assert snap.payload["total_ask_qty"] == 102768
    assert snap.payload["bids"] == [{"price": 26800, "qty": 879}]


def test_from_orderbook_payload_matches_legacy_handrolled() -> None:
    """Byte-for-byte parity with the old poller path: model_dump() + phase."""
    ob = _ob()
    legacy = ob.model_dump()
    legacy["phase"] = "regular"
    assert LiveSnapshot.from_orderbook(ob, phase="regular").payload == legacy


def test_from_trades_wraps_in_trades_key() -> None:
    trades = _trades()
    snap = LiveSnapshot.from_trades(trades, t_ms=1779800000000, phase="afterhours")
    assert snap.kind is SnapshotKind.TRADE
    assert snap.t_ms == 1779800000000
    assert snap.payload["phase"] == "afterhours"
    assert snap.payload["trades"] == [t.model_dump() for t in trades]


def test_from_trades_payload_matches_legacy_handrolled() -> None:
    trades = _trades()
    legacy = {"trades": [t.model_dump() for t in trades], "phase": "regular"}
    assert (
        LiveSnapshot.from_trades(trades, t_ms=1779800000000, phase="regular").payload
        == legacy
    )


def test_from_brokers_builds_broker_snapshot() -> None:
    brokers = _brokers()
    snap = LiveSnapshot.from_brokers(brokers, t_ms=1779800000000, phase="regular")
    assert snap.kind is SnapshotKind.BROKER
    assert snap.t_ms == 1779800000000
    assert snap.payload["phase"] == "regular"
    assert snap.payload["buy_top"] == [{"name": "미래에셋", "qty": 1000}]


def test_from_brokers_payload_matches_legacy_handrolled() -> None:
    brokers = _brokers()
    legacy = brokers.model_dump()
    legacy["phase"] = "regular"
    assert (
        LiveSnapshot.from_brokers(brokers, t_ms=1779800000000, phase="regular").payload
        == legacy
    )


def test_builders_roundtrip_through_jsonl_unchanged() -> None:
    """The whole point: a builder-produced snapshot serializes to the same JSONL
    shape promote.py already parses ({t_ms, kind, payload})."""
    ob = _ob()
    line = LiveSnapshot.from_orderbook(ob, phase="regular").to_jsonl()
    row = json.loads(line)
    assert set(row.keys()) == {"t_ms", "kind", "payload"}
    assert row["kind"] == "ob"
    assert row["payload"]["bids"][0]["price"] == 26800


def test_from_fill_payload_shape():
    s = LiveSnapshot.from_fill(t_ms=1_770_000_000_000, buy_qty=120, sell_qty=80, phase="regular")
    assert s.kind is SnapshotKind.FILL
    assert s.t_ms == 1_770_000_000_000
    assert s.payload == {"buy_qty": 120, "sell_qty": 80, "phase": "regular"}
    assert '"kind": "fill"' in s.to_jsonl()
