from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import ClassVar, Literal

_EMIT_LIMIT = 3


@dataclass
class Peak:
    price: int
    qty: int
    t_ms: int
    seq: int | None = None


@dataclass(frozen=True)
class TouchTick:
    price: int
    t_ms: int
    seq: int | None = None


PeakEventKey = tuple[int, int, int | None, str, str]


@dataclass
class _TodaySidePeakState:
    traded_prices: set[int] = field(default_factory=set)
    observed_peak_events: dict[PeakEventKey, Peak] = field(default_factory=dict)
    open_by_price: dict[int, Peak] = field(default_factory=dict)
    closed_traded: list[Peak] = field(default_factory=list)
    all_best_by_price_time: dict[tuple[int, int], Peak] = field(default_factory=dict)
    touch_ticks: list[TouchTick] = field(default_factory=list)
    touch_price_extreme_by_t_ms: dict[int, int] = field(default_factory=dict)
    traded_peak: Peak | None = None
    untraded_peak: Peak | None = None
    all_peak: Peak | None = None
    coverage: Literal["full", "partial"] = "partial"

    side_name: ClassVar[str]

    def _is_touched_by_price(self, trade_price: int, wall_price: int) -> bool:
        raise NotImplementedError

    def ingest_trade(
        self,
        *,
        price: int,
        side: int,
        t_ms: int | None = None,
        seq: int | None = None,
    ) -> None:
        if side not in (1, -1):
            return
        if _positive_int(price) is None:
            return
        self.traded_prices.add(price)
        if type(t_ms) is not int or t_ms <= 0:
            return
        self.touch_ticks.append(
            TouchTick(price=price, t_ms=t_ms, seq=seq if type(seq) is int else None)
        )
        self._record_touch_price(t_ms=t_ms, price=price)
        touched_prices = [
            wall_price
            for wall_price in self.open_by_price
            if self._is_touched_by_price(price, wall_price)
        ]
        for wall_price in touched_prices:
            self.closed_traded.append(self.open_by_price.pop(wall_price))
        self._refresh_rank_ones()

    def _ingest_orderbook_levels(
        self,
        *,
        t_ms: int,
        levels: Sequence[Mapping[str, int]],
    ) -> None:
        for level in levels:
            price = _positive_int(level.get("price"))
            qty = _positive_int(level.get("qty"))
            if price is None or qty is None:
                continue

            key = (price, t_ms, None, self.side_name, "orderbook")
            peak = _larger_peak(
                self.observed_peak_events.get(key),
                price=price,
                qty=qty,
                t_ms=t_ms,
                seq=None,
            )
            self.observed_peak_events[key] = peak
            self.all_best_by_price_time[(price, t_ms)] = peak
            if self._is_touched_by_touch_history(t_ms=t_ms, wall_price=price):
                self.closed_traded.append(peak)
            else:
                self.open_by_price[price] = _larger_peak(
                    self.open_by_price.get(price),
                    price=price,
                    qty=qty,
                    t_ms=t_ms,
                    seq=None,
                )

        self._refresh_rank_ones()

    def snapshot(self) -> dict | None:
        if self.all_peak is None:
            return None

        traded_peaks = _top_ranked_peaks(self.closed_traded)
        untraded_peaks = _top_ranked_peaks(self.open_by_price.values())
        all_peaks = _top_ranked_peaks([*self.closed_traded, *self.open_by_price.values()])
        traded = traded_peaks[0] if traded_peaks else None
        untraded = untraded_peaks[0] if untraded_peaks else None
        all_peak = all_peaks[0] if all_peaks else None
        if all_peak is None:
            return None
        return {
            "coverage": self.coverage,
            "traded_prices": sorted(self.traded_prices),
            "traded_price": traded.price if traded is not None else None,
            "traded_qty": traded.qty if traded is not None else None,
            "traded_t_ms": traded.t_ms if traded is not None else None,
            "traded_peaks": [_peak_payload(p) for p in traded_peaks],
            "untraded_price": untraded.price if untraded is not None else None,
            "untraded_qty": untraded.qty if untraded is not None else None,
            "untraded_t_ms": untraded.t_ms if untraded is not None else None,
            "untraded_peaks": [_peak_payload(p) for p in untraded_peaks],
            "all_price": all_peak.price,
            "all_qty": all_peak.qty,
            "all_t_ms": all_peak.t_ms,
            "all_peaks": [_peak_payload(p) for p in all_peaks],
        }

    def _refresh_rank_ones(self) -> None:
        all_ranked = _ranked_peaks([*self.closed_traded, *self.open_by_price.values()])
        traded_ranked = _ranked_peaks(self.closed_traded)
        untraded_ranked = _ranked_peaks(self.open_by_price.values())
        self.all_peak = all_ranked[0] if all_ranked else None
        self.traded_peak = traded_ranked[0] if traded_ranked else None
        self.untraded_peak = untraded_ranked[0] if untraded_ranked else None

    def _record_touch_price(self, *, t_ms: int, price: int) -> None:
        current = self.touch_price_extreme_by_t_ms.get(t_ms)
        if current is None:
            self.touch_price_extreme_by_t_ms[t_ms] = price
            return
        if self.side_name == "ask":
            self.touch_price_extreme_by_t_ms[t_ms] = max(current, price)
        else:
            self.touch_price_extreme_by_t_ms[t_ms] = min(current, price)

    def _is_touched_by_touch_history(self, *, t_ms: int, wall_price: int) -> bool:
        touch_price = self.touch_price_extreme_by_t_ms.get(t_ms)
        if touch_price is None:
            return False
        return self._is_touched_by_price(touch_price, wall_price)


@dataclass
class TodayAskPeakState(_TodaySidePeakState):
    side_name: ClassVar[str] = "ask"

    def _is_touched_by_price(self, trade_price: int, wall_price: int) -> bool:
        return trade_price >= wall_price

    def ingest_orderbook(
        self,
        *,
        t_ms: int,
        asks: Sequence[Mapping[str, int]],
    ) -> None:
        self._ingest_orderbook_levels(t_ms=t_ms, levels=asks)


@dataclass
class TodayBidPeakState(_TodaySidePeakState):
    side_name: ClassVar[str] = "bid"

    def _is_touched_by_price(self, trade_price: int, wall_price: int) -> bool:
        return trade_price <= wall_price

    def ingest_orderbook(
        self,
        *,
        t_ms: int,
        bids: Sequence[Mapping[str, int]],
    ) -> None:
        self._ingest_orderbook_levels(t_ms=t_ms, levels=bids)


def _larger_peak(
    current: Peak | None,
    *,
    price: int,
    qty: int,
    t_ms: int,
    seq: int | None,
) -> Peak:
    if current is None or qty > current.qty:
        return Peak(price=price, qty=qty, t_ms=t_ms, seq=seq)
    return current


def _top_ranked_peaks(peaks: Iterable[Peak]) -> list[Peak]:
    return _ranked_peaks(peaks)[:_EMIT_LIMIT]


def _ranked_peaks(peaks: Iterable[Peak]) -> list[Peak]:
    return sorted(
        peaks,
        key=lambda p: (-p.qty, p.t_ms, p.price, _seq_sort_key(p.seq)),
    )


def _peak_payload(peak: Peak) -> dict[str, int]:
    return {"price": peak.price, "qty": peak.qty, "t_ms": peak.t_ms}


def _seq_sort_key(seq: int | None) -> int:
    return seq if type(seq) is int else -1


def _positive_int(value: object) -> int | None:
    if type(value) is not int:
        return None
    if value <= 0:
        return None
    return value
