"""REST 모델 → LiveBuffer entry 변환 빌더 단위 테스트 (ADR-0067).

WS 경로(stream.on_tick)가 buffer에 넣는 entry shape와 동일한지 검증.
저장 경로(writer.append/promote/to_jsonl)는 절대 호출하지 않는다.

Entry shape (buffer.publish이 만드는 dict):
  {"t_ms": ..., "kind": "ob"|"trade"|"broker", **payload, "phase": ...}

주요 불변식:
- ob: asks/bids는 plain {price,qty} dict 목록 (pydantic 모델 아님)
- trade: KisTrade 1개 → trade entry 1개; payload["trades"]는 1-element 목록
- broker: sell_top/buy_top은 plain {name,qty} dict 목록
- 모든 entry에 "phase" 키가 존재 (on_tick이 phase를 payload에 추가)
"""
from __future__ import annotations

import asyncio

from hoga.live.buffer import LiveBuffer
from hoga.live.kis_models import (
    KisBrokerEntry,
    KisBrokers,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)
from hoga.live.rest_buffer_build import (
    ob_to_snapshot,
    trades_to_snapshots,
    brokers_to_snapshot,
)
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import parse_message


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_orderbook() -> KisOrderbook:
    return KisOrderbook(
        code="005930",
        asks=[OrderbookLevel(price=75100 + i * 100, qty=100 + i) for i in range(10)],
        bids=[OrderbookLevel(price=75000 - i * 100, qty=200 + i) for i in range(10)],
        total_ask_qty=1500,
        total_bid_qty=2500,
        t_ms=1_770_000_000_000,
    )


def _make_trades() -> list[KisTrade]:
    return [
        KisTrade(price=75000, qty=10, side=1, side_source="inferred",
                 t_ms=1_770_000_000_100),
        KisTrade(price=74900, qty=5, side=-1, side_source="inferred",
                 t_ms=1_770_000_000_200),
    ]


def _make_brokers() -> KisBrokers:
    return KisBrokers(
        code="005930",
        buy_top=[KisBrokerEntry(name=f"Buy{i}", qty=1000 + i) for i in range(5)],
        sell_top=[KisBrokerEntry(name=f"Sell{i}", qty=2000 + i) for i in range(5)],
    )


# ---------------------------------------------------------------------------
# ob_to_snapshot
# ---------------------------------------------------------------------------

class TestObToSnapshot:
    def test_returns_live_snapshot_kind_ob(self):
        snap = ob_to_snapshot(_make_orderbook(), phase="regular")
        assert snap.kind is SnapshotKind.OB

    def test_t_ms_matches_orderbook(self):
        ob = _make_orderbook()
        snap = ob_to_snapshot(ob, phase="regular")
        assert snap.t_ms == ob.t_ms

    def test_payload_has_phase(self):
        snap = ob_to_snapshot(_make_orderbook(), phase="preopen")
        assert snap.payload["phase"] == "preopen"

    def test_payload_code(self):
        ob = _make_orderbook()
        snap = ob_to_snapshot(ob, phase="regular")
        assert snap.payload["code"] == "005930"

    def test_payload_totals(self):
        ob = _make_orderbook()
        snap = ob_to_snapshot(ob, phase="regular")
        assert snap.payload["total_ask_qty"] == 1500
        assert snap.payload["total_bid_qty"] == 2500

    def test_asks_are_plain_dicts(self):
        ob = _make_orderbook()
        snap = ob_to_snapshot(ob, phase="regular")
        asks = snap.payload["asks"]
        assert isinstance(asks[0], dict)
        assert set(asks[0].keys()) == {"price", "qty"}

    def test_bids_are_plain_dicts(self):
        ob = _make_orderbook()
        snap = ob_to_snapshot(ob, phase="regular")
        bids = snap.payload["bids"]
        assert isinstance(bids[0], dict)
        assert set(bids[0].keys()) == {"price", "qty"}

    def test_entry_keys_match_ws_ob_entry(self):
        """buffer.publish이 만드는 entry 키셋이 WS ob 경로와 동일."""
        ob = _make_orderbook()
        snap = ob_to_snapshot(ob, phase="regular")
        entry = {"t_ms": snap.t_ms, "kind": snap.kind.value, **snap.payload}
        expected_keys = {"t_ms", "kind", "code", "asks", "bids",
                         "total_ask_qty", "total_bid_qty", "phase"}
        assert set(entry.keys()) == expected_keys

    def test_publishes_to_buffer(self):
        """snapshot이 LiveBuffer.publish를 통과할 수 있는지."""
        ob = _make_orderbook()
        snap = ob_to_snapshot(ob, phase="regular")
        buf = LiveBuffer()

        async def _run() -> dict | None:
            await buf.publish("005930", [snap], now_ms=1_770_000_001_000)
            return await buf.get_latest("005930")

        result = asyncio.run(_run())
        assert result is not None
        assert result["orderbook"] is not None


# ---------------------------------------------------------------------------
# trades_to_snapshots
# ---------------------------------------------------------------------------

class TestTradesToSnapshots:
    def test_one_snapshot_per_trade(self):
        trades = _make_trades()
        snaps = trades_to_snapshots(trades, phase="regular")
        assert len(snaps) == 2

    def test_returns_live_snapshot_kind_trade(self):
        snaps = trades_to_snapshots(_make_trades(), phase="regular")
        for s in snaps:
            assert s.kind is SnapshotKind.TRADE

    def test_t_ms_matches_individual_trade(self):
        trades = _make_trades()
        snaps = trades_to_snapshots(trades, phase="regular")
        assert snaps[0].t_ms == trades[0].t_ms
        assert snaps[1].t_ms == trades[1].t_ms

    def test_payload_trades_is_one_element_list(self):
        """WS 경로(_parse_trades)와 동일: 1체결 → trades 리스트 1원소."""
        snaps = trades_to_snapshots(_make_trades(), phase="regular")
        for s in snaps:
            assert isinstance(s.payload["trades"], list)
            assert len(s.payload["trades"]) == 1

    def test_payload_trade_keys(self):
        snaps = trades_to_snapshots(_make_trades(), phase="regular")
        trade_rec = snaps[0].payload["trades"][0]
        assert set(trade_rec.keys()) == {"t_ms", "price", "qty", "side", "side_source"}

    def test_payload_has_phase(self):
        snaps = trades_to_snapshots(_make_trades(), phase="auction")
        for s in snaps:
            assert s.payload["phase"] == "auction"

    def test_empty_input_returns_empty(self):
        assert trades_to_snapshots([], phase="regular") == []

    def test_entry_keys_match_ws_trade_entry(self):
        """buffer entry 키셋이 WS trade 경로와 동일."""
        trades = _make_trades()
        snap = trades_to_snapshots(trades, phase="regular")[0]
        entry = {"t_ms": snap.t_ms, "kind": snap.kind.value, **snap.payload}
        expected_keys = {"t_ms", "kind", "trades", "phase"}
        assert set(entry.keys()) == expected_keys


# ---------------------------------------------------------------------------
# brokers_to_snapshot
# ---------------------------------------------------------------------------

class TestBrokersToSnapshot:
    def test_returns_live_snapshot_kind_broker(self):
        snap = brokers_to_snapshot(_make_brokers(), now_ms=1_770_000_000_000, phase="regular")
        assert snap.kind is SnapshotKind.BROKER

    def test_t_ms_is_now_ms(self):
        """KisBrokers는 t_ms 없음 — now_ms 사용 (WS broker와 동일)."""
        snap = brokers_to_snapshot(_make_brokers(), now_ms=9_999_999, phase="regular")
        assert snap.t_ms == 9_999_999

    def test_payload_has_phase(self):
        snap = brokers_to_snapshot(_make_brokers(), now_ms=0, phase="closing")
        assert snap.payload["phase"] == "closing"

    def test_payload_code(self):
        snap = brokers_to_snapshot(_make_brokers(), now_ms=0, phase="regular")
        assert snap.payload["code"] == "005930"

    def test_buy_top_are_plain_dicts(self):
        snap = brokers_to_snapshot(_make_brokers(), now_ms=0, phase="regular")
        buy = snap.payload["buy_top"]
        assert isinstance(buy[0], dict)
        assert set(buy[0].keys()) == {"name", "qty"}

    def test_sell_top_are_plain_dicts(self):
        snap = brokers_to_snapshot(_make_brokers(), now_ms=0, phase="regular")
        sell = snap.payload["sell_top"]
        assert isinstance(sell[0], dict)
        assert set(sell[0].keys()) == {"name", "qty"}

    def test_buy_top_length(self):
        snap = brokers_to_snapshot(_make_brokers(), now_ms=0, phase="regular")
        assert len(snap.payload["buy_top"]) == 5

    def test_sell_top_length(self):
        snap = brokers_to_snapshot(_make_brokers(), now_ms=0, phase="regular")
        assert len(snap.payload["sell_top"]) == 5

    def test_entry_keys_match_ws_broker_entry(self):
        """buffer entry 키셋이 WS broker 경로와 동일 (t_ms 포함)."""
        snap = brokers_to_snapshot(_make_brokers(), now_ms=1_770_000_000_000, phase="regular")
        entry = {"t_ms": snap.t_ms, "kind": snap.kind.value, **snap.payload}
        expected_keys = {"t_ms", "kind", "code", "buy_top", "sell_top", "phase"}
        assert set(entry.keys()) == expected_keys


# ---------------------------------------------------------------------------
# WS-anchored parity tests: entry keys from builder == entry keys from WS path
# on_tick formula: entry = {"t_ms": tick.t_ms, "kind": tick.kind.value,
#                           **tick.payload, "phase": phase}
# Values differ legitimately (side_source, t_ms, phase); key structure must be =.
# ---------------------------------------------------------------------------

def _ws_entry(tick_payload: dict, t_ms: int, kind_value: str, phase: str = "regular") -> set[str]:
    """Replicate on_tick's formula for the buffer entry key set."""
    entry = {"t_ms": t_ms, "kind": kind_value, **tick_payload, "phase": phase}
    return set(entry.keys())


def _asp_frame(code: str = "005930", hhmmss: str = "093015") -> str:
    """Minimal synthetic ASP frame (mirrors test_ws_frames.py fixture)."""
    f = ["0"] * 59
    f[0], f[1], f[2] = code, hhmmss, "0"
    for i, idx in enumerate(range(3, 13)):
        f[idx] = str(75000 + i * 10)
    for i, idx in enumerate(range(13, 23)):
        f[idx] = str(74990 - i * 10)
    for i, idx in enumerate(range(23, 33)):
        f[idx] = str(100 + i)
    for i, idx in enumerate(range(33, 43)):
        f[idx] = str(200 + i)
    f[43], f[44] = "1500", "2500"
    return "0|H0STASP0|001|" + "^".join(f)


def _cnt_frame(n: int = 1) -> str:
    recs = []
    for k in range(n):
        f = ["0"] * 46
        f[0], f[1], f[2] = "005930", "093015", "75000"
        f[12] = str(5 + k)
        f[21] = "1"
        recs.append("^".join(f))
    return f"0|H0STCNT0|{n:03d}|" + "^".join(recs)


def _mbc_frame() -> str:
    f = ["0"] * 80
    f[0] = "005930"
    for i, idx in enumerate(range(1, 6)):
        f[idx] = f"매도사{i + 1}"
    for i, idx in enumerate(range(6, 11)):
        f[idx] = f"매수사{i + 1}"
    for i, idx in enumerate(range(11, 16)):
        f[idx] = str(1000 + i)
    for i, idx in enumerate(range(16, 21)):
        f[idx] = str(2000 + i)
    return "0|H0STMBC0|001|" + "^".join(f)


class TestWsKeyParity:
    """Builder entry keys must equal the keys that on_tick would put in buffer."""

    def test_ob_key_parity_with_ws_path(self):
        ticks = parse_message(_asp_frame(), date="20260605", now_ms=0)
        ws_tick = ticks[0]
        ws_keys = _ws_entry(ws_tick.payload, ws_tick.t_ms, ws_tick.kind.value)

        ob = _make_orderbook()
        snap = ob_to_snapshot(ob, phase="regular")
        rest_keys = set({"t_ms": snap.t_ms, "kind": snap.kind.value, **snap.payload}.keys())

        assert rest_keys == ws_keys, (
            f"ob key mismatch — REST has {rest_keys - ws_keys} extra, "
            f"WS has {ws_keys - rest_keys} extra"
        )

    def test_trade_key_parity_with_ws_path(self):
        ticks = parse_message(_cnt_frame(1), date="20260605", now_ms=0)
        ws_tick = ticks[0]
        ws_keys = _ws_entry(ws_tick.payload, ws_tick.t_ms, ws_tick.kind.value)

        trade = _make_trades()[0]
        snaps = trades_to_snapshots([trade], phase="regular")
        snap = snaps[0]
        rest_keys = set({"t_ms": snap.t_ms, "kind": snap.kind.value, **snap.payload}.keys())

        assert rest_keys == ws_keys, (
            f"trade key mismatch — REST has {rest_keys - ws_keys} extra, "
            f"WS has {ws_keys - rest_keys} extra"
        )

    def test_trade_record_key_parity_with_ws_path(self):
        """trades 리스트 안의 레코드 키도 WS와 동일해야."""
        ticks = parse_message(_cnt_frame(1), date="20260605", now_ms=0)
        ws_trade_rec_keys = set(ticks[0].payload["trades"][0].keys())

        trade = _make_trades()[0]
        snap = trades_to_snapshots([trade], phase="regular")[0]
        rest_trade_rec_keys = set(snap.payload["trades"][0].keys())

        assert rest_trade_rec_keys == ws_trade_rec_keys, (
            f"trade record key mismatch — REST has {rest_trade_rec_keys - ws_trade_rec_keys} extra, "
            f"WS has {ws_trade_rec_keys - rest_trade_rec_keys} extra"
        )

    def test_broker_key_parity_with_ws_path(self):
        ticks = parse_message(_mbc_frame(), date="20260605", now_ms=1_770_000_000_000)
        ws_tick = ticks[0]
        ws_keys = _ws_entry(ws_tick.payload, ws_tick.t_ms, ws_tick.kind.value)

        snap = brokers_to_snapshot(_make_brokers(), now_ms=1_770_000_000_000, phase="regular")
        rest_keys = set({"t_ms": snap.t_ms, "kind": snap.kind.value, **snap.payload}.keys())

        assert rest_keys == ws_keys, (
            f"broker key mismatch — REST has {rest_keys - ws_keys} extra, "
            f"WS has {ws_keys - rest_keys} extra"
        )
