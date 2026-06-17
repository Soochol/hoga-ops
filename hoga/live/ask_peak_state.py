from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal


@dataclass
class Peak:
    price: int
    qty: int
    t_ms: int


@dataclass
class TodayAskPeakState:
    traded_prices: set[int] = field(default_factory=set)
    observed_price_peaks: dict[int, Peak] = field(default_factory=dict)
    traded_peak: Peak | None = None
    all_peak: Peak | None = None
    coverage: Literal["full", "partial"] = "partial"

    def ingest_trade(self, *, price: int, side: int) -> None:
        if side in (1, -1):
            self.traded_prices.add(price)
            observed = self.observed_price_peaks.get(price)
            if observed is not None:
                self.traded_peak = _larger_peak(
                    self.traded_peak,
                    price=observed.price,
                    qty=observed.qty,
                    t_ms=observed.t_ms,
                )

    def ingest_orderbook(
        self,
        *,
        t_ms: int,
        asks: Sequence[Mapping[str, int]],
    ) -> None:
        for ask in asks:
            price = _positive_int(ask.get("price"))
            qty = _positive_int(ask.get("qty"))
            if price is None or qty is None:
                continue

            self.observed_price_peaks[price] = _larger_peak(
                self.observed_price_peaks.get(price),
                price=price,
                qty=qty,
                t_ms=t_ms,
            )
            self.all_peak = _larger_peak(self.all_peak, price=price, qty=qty, t_ms=t_ms)
            self.observed_price_peaks[price] = _larger_peak(
                self.observed_price_peaks.get(price), price=price, qty=qty, t_ms=t_ms
            )
            if price in self.traded_prices:
                self.traded_peak = _larger_peak(
                    self.traded_peak,
                    price=price, qty=qty, t_ms=t_ms,
                )

    def snapshot(self) -> dict | None:
        if self.all_peak is None:
            return None

        traded = self.traded_peak
        all_peak = self.all_peak
        return {
            "coverage": self.coverage,
            "traded_prices": sorted(self.traded_prices),
            "traded_price": traded.price if traded is not None else None,
            "traded_qty": traded.qty if traded is not None else None,
            "traded_t_ms": traded.t_ms if traded is not None else None,
            "all_price": all_peak.price,
            "all_qty": all_peak.qty,
            "all_t_ms": all_peak.t_ms,
        }


def _larger_peak(current: Peak | None, *, price: int, qty: int, t_ms: int) -> Peak:
    if current is None or qty > current.qty:
        return Peak(price=price, qty=qty, t_ms=t_ms)
    return current


def _positive_int(value: object) -> int | None:
    if type(value) is not int:
        return None
    if value <= 0:
        return None
    return value
