"""Observed trades, grouped by event second; no I/O or inferred executions.

OHLC and price/side quantities have one source. A receive sequence breaks ties
when the exchange timestamp has only second precision. Unknown-side executions
are retained, while continuous-trade consumers can exclude them explicitly.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .snapshot import SnapshotKind
from .ticks import WsTick


@dataclass
class SecondTradeBar:
    t_ms: int
    open: int = 0
    high: int = 0
    low: int = 0
    close: int = 0
    volume: int = 0
    trade_value: int = 0
    count: int = 0
    first: tuple[int, int] = (0, 0)
    last: tuple[int, int] = (0, 0)
    revision: int = 0
    applied_late_seq: int = 0
    prices: dict[tuple[int, int], list[int]] = field(default_factory=dict)

    def ingest(self, *, t_ms: int, seq: int, price: int, qty: int, side: int) -> None:
        order = (t_ms, seq)
        if not self.count:
            self.open = self.high = self.low = self.close = price
            self.first = self.last = order
        else:
            self.high = max(self.high, price)
            self.low = min(self.low, price)
            if order < self.first:
                self.first, self.open = order, price
            if order > self.last:
                self.last, self.close = order, price
        self.volume += qty
        self.trade_value += price * qty
        self.count += 1
        self.revision += 1
        cell = self.prices.setdefault((price, side), [0, 0])
        cell[0] += qty
        cell[1] += 1

    def record(self) -> dict[str, Any]:
        return {
            "t_ms": self.t_ms, "open": self.open, "high": self.high,
            "low": self.low, "close": self.close, "volume": self.volume,
            "trade_value": self.trade_value, "count": self.count,
            "first": list(self.first), "last": list(self.last), "revision": self.revision,
            "applied_late_seq": self.applied_late_seq,
            "prices": [[price, side, qty, count]
                       for (price, side), (qty, count) in sorted(self.prices.items())],
        }

    @classmethod
    def restore(cls, row: dict[str, Any]) -> SecondTradeBar:
        bar = cls(t_ms=row["t_ms"])
        for name in ("open", "high", "low", "close", "volume", "trade_value", "count", "revision"):
            setattr(bar, name, row[name])
        bar.first, bar.last = tuple(row["first"]), tuple(row["last"])
        bar.applied_late_seq = row.get("applied_late_seq", 0)
        bar.prices = {(p, side): [qty, count] for p, side, qty, count in row["prices"]}
        return bar


def valid_trades(tick: WsTick) -> list[dict[str, int]]:
    if tick.kind is not SnapshotKind.TRADE:
        return []
    result = []
    for trade in tick.payload.get("trades", []):
        if not isinstance(trade, dict):
            continue
        t_ms, price, qty, side = (trade.get(k) for k in ("t_ms", "price", "qty", "side"))
        if (type(t_ms) is int and type(price) is int and type(qty) is int
                and t_ms >= 0 and price > 0 and qty > 0 and type(side) is int and side in (-1, 0, 1)):
            result.append({"t_ms": t_ms, "price": price, "qty": qty, "side": side})
    return result


def aggregate_bars(rows: list[dict[str, Any]], bucket_ms: int) -> list[dict[str, Any]]:
    """Rebucket observed OHLCV without filling absent executions."""
    groups: dict[int, dict[str, Any]] = {}
    for row in sorted(rows, key=lambda r: (r["t_ms"], tuple(r["first"]))):
        t = row["t_ms"] // bucket_ms * bucket_ms
        if t not in groups:
            groups[t] = {key: value for key, value in row.items()
                         if key not in ("prices", "revision", "applied_late_seq")}
            groups[t]["t_ms"] = t
        else:
            out = groups[t]
            out["high"], out["low"] = max(out["high"], row["high"]), min(out["low"], row["low"])
            if tuple(row["first"]) < tuple(out["first"]):
                out["first"], out["open"] = row["first"], row["open"]
            if tuple(row["last"]) > tuple(out["last"]):
                out["last"], out["close"] = row["last"], row["close"]
            for name in ("volume", "trade_value", "count"):
                out[name] += row[name]
    return list(groups.values())
