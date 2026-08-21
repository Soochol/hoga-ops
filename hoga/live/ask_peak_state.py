from __future__ import annotations

from bisect import insort
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
    latest_touch_t_ms: int | None = None
    latest_touch_price_extreme: int | None = None
    latest_seq_touches: list[TouchTick] = field(default_factory=list)
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
        touch = TouchTick(price=price, t_ms=t_ms, seq=seq if type(seq) is int else None)
        self._record_touch(touch)
        touched_prices = [
            wall_price
            for wall_price, peak in self.open_by_price.items()
            if self._trade_touches_peak(touch, peak)
        ]
        for wall_price in touched_prices:
            self._record_closed_peak(self.open_by_price.pop(wall_price))
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

            peak = Peak(price=price, qty=qty, t_ms=t_ms, seq=None)
            if self._is_touched_by_touch_history(
                t_ms=t_ms,
                wall_price=price,
                wall_seq=None,
            ):
                self._record_closed_peak(peak)
                continue
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
        # `all_ranked` 만 정렬한다 — 아래 `bounded_all` 이 상위 _EMIT_LIMIT 개를
        # 쓰기 때문이다. 나머지 둘은 **1위만** 쓰므로 정렬 대신 `_rank_one`(O(n)).
        # `open_by_price` 는 하루 동안 가격 수만큼 자라므로 이쪽이 큰 쪽이다
        # (`closed_traded` 는 _EMIT_LIMIT 로 잘려 항상 ≤3).
        all_ranked = _ranked_peaks([*self.closed_traded, *self.open_by_price.values()])
        self.all_peak = all_ranked[0] if all_ranked else None
        self.traded_peak = _rank_one(self.closed_traded)
        self.untraded_peak = _rank_one(self.open_by_price.values())
        bounded_all = all_ranked[:_EMIT_LIMIT]
        self.observed_peak_events = {
            _peak_event_key(self.side_name, peak): peak for peak in bounded_all
        }
        self.all_best_by_price_time = {
            (peak.price, peak.t_ms): peak for peak in bounded_all
        }

    def _record_touch(self, touch: TouchTick) -> None:
        if touch.t_ms != self.latest_touch_t_ms:
            self.latest_touch_t_ms = touch.t_ms
            self.latest_touch_price_extreme = touch.price
            self.latest_seq_touches = [touch]
            return
        current = self.latest_touch_price_extreme
        if current is None:
            self.latest_touch_price_extreme = touch.price
        elif self.side_name == "ask":
            self.latest_touch_price_extreme = max(current, touch.price)
        else:
            self.latest_touch_price_extreme = min(current, touch.price)
        insort(
            self.latest_seq_touches,
            touch,
            key=lambda tick: _seq_sort_key(tick.seq),
        )

    def _record_closed_peak(self, peak: Peak) -> None:
        self.closed_traded = _top_ranked_peaks([*self.closed_traded, peak])

    def _trade_touches_peak(self, touch: TouchTick, peak: Peak) -> bool:
        return self._is_touched_by_price(touch.price, peak.price) and _touch_is_after_wall(
            touch,
            peak,
        )

    def _is_touched_by_touch_history(
        self,
        *,
        t_ms: int,
        wall_price: int,
        wall_seq: int | None,
    ) -> bool:
        if t_ms != self.latest_touch_t_ms:
            return False
        if wall_seq is not None:
            wall = Peak(price=wall_price, qty=0, t_ms=t_ms, seq=wall_seq)
            return any(
                self._trade_touches_peak(tick, wall)
                for tick in self.latest_seq_touches
            )
        return self.latest_touch_price_extreme is not None and self._is_touched_by_price(
            self.latest_touch_price_extreme,
            wall_price,
        )


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


def _peak_rank_key(peak: Peak) -> tuple[int, int, int, tuple[int, int]]:
    """랭킹 정렬 키. 모듈 상수로 올려 `_ranked_peaks`·`_rank_one` 이 공유한다."""
    return (-peak.qty, peak.t_ms, peak.price, _seq_sort_key(peak.seq))


def _ranked_peaks(peaks: Iterable[Peak]) -> list[Peak]:
    return sorted(peaks, key=_peak_rank_key)


def _rank_one(peaks: Iterable[Peak]) -> Peak | None:
    """1위만 필요한 자리 — **정렬하지 않는다**.

    `sorted(...)[0]` 은 O(n log n) 인데 여기서 쓰는 것은 첫 항목 하나뿐이다.
    `min` 은 O(n) 이고 같은 키를 쓰므로 결과가 동일하다(동점 처리도 같다 — 키가
    `seq` 까지 포함한 전순서라 최솟값이 유일하다).

    싼 미시 최적화처럼 보이지만 **이 함수는 틱 경로 위에 있다**: 300종목 × 종목당
    ~16 ob/s 의 모든 틱이 `_refresh_rank_ones` 를 지나고, 그 본문은 이벤트 루프
    스레드에서 **양보 없이** 돈다(2026-08-18 py-spy 로 GIL 보유자가 이 경로임이
    확인됐다 — `_recv_loop → _dispatch → on_tick`). 실측 1.1~1.9배
    (n=10~600, 2026-08-21).
    """
    return min(peaks, key=_peak_rank_key, default=None)


def _peak_payload(peak: Peak) -> dict[str, int]:
    return {"price": peak.price, "qty": peak.qty, "t_ms": peak.t_ms}


def _peak_event_key(side_name: str, peak: Peak) -> PeakEventKey:
    return (peak.price, peak.t_ms, peak.seq, side_name, "candidate")


def _event_order_key(t_ms: int, seq: int | None) -> tuple[int, int]:
    return (t_ms, _seq_sort_key(seq))


def _touch_is_after_wall(touch: TouchTick, peak: Peak) -> bool:
    if touch.seq is None or peak.seq is None:
        return touch.t_ms >= peak.t_ms
    return _event_order_key(touch.t_ms, touch.seq) >= _event_order_key(peak.t_ms, peak.seq)


def _seq_sort_key(seq: int | None) -> int:
    return seq if type(seq) is int else -1


def _positive_int(value: object) -> int | None:
    if type(value) is not int:
        return None
    if value <= 0:
        return None
    return value
