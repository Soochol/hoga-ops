from __future__ import annotations

from bisect import insort
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import ClassVar, Literal

_EMIT_LIMIT = 3

#: 터치 판정 창(ADR-0156). 백엔드 과거일 경로(`snapshots.ONE_MINUTE_MS`)와 **같은 값이어야
#: 한다** — 오늘 실시간과 과거일이 같은 규칙으로 계산되는 것이 그 ADR 의 요구다.
_TOUCH_WINDOW_MS = 60_000

#: pending 벽을 몇 분 더 붙들고 있을 것인가. 자기 분이 지난 벽은 원리적으로 더는 터치될 수
#: 없으므로(판정이 분 안에서 닫힌다) 버려도 답이 안 바뀐다 — 여유분은 오직 **도착 순서**를
#: 위한 것이다(체결 틱이 같은 분의 호가 틱보다 늦게 올 수 있다). 이 값이 0 이면 분 경계에
#: 걸친 지연 도착이 조용히 미터치로 굳는다.
_PENDING_MINUTE_SLACK = 2


@dataclass
class Peak:
    price: int
    qty: int
    t_ms: int
    seq: int | None = None


PeakEventKey = tuple[int, int, int | None, str, str]


def _minute_of(t_ms: int) -> int:
    return t_ms // _TOUCH_WINDOW_MS


@dataclass
class _TodaySidePeakState:
    """오늘분 최대벽 상태 — **동일분 터치**(ADR-0156) 기준.

    벽 이벤트는 자기가 관측된 1분 안의 체결로만 터치된다. 그래서 자기 분이 지난 벽은
    더 이상 터치될 수 없고, 미터치 대기열(`pending_by_minute`)은 **최근 몇 분만**
    붙들면 된다 — ADR-0084 시절의 `open_by_price` 가 하루치 distinct 가격을 모두
    붙들던 것과 다르다(300종목 × 2 side 가 한 프로세스에 상주한다).

    ``all_*`` 계열(「보이는 영역 최대벽」의 원천)은 top-3 만 **증분으로** 유지한다
    (`_offer_all`). 가격별 딕셔너리를 들면 틱 경로가 그 크기에 비례해 느려지는데,
    이 경로는 이벤트 루프 스레드에서 **양보 없이** 돈다.
    """

    #: 터치 무관 `all_*` 계열의 top-3. **가격별 딕셔너리를 들지 않는다** — 근거는
    #: `_offer_all` docstring. 이것이 이 클래스의 유일한 `all` 상태다.
    all_top: list[Peak] = field(default_factory=list)
    #: 분 → (가격 → 아직 터치 안 된 벽). `_PENDING_MINUTE_SLACK` 창만 보관.
    pending_by_minute: dict[int, dict[int, Peak]] = field(default_factory=dict)
    #: 분 → 그 분 체결가의 극값(ask=max, bid=min). pending 과 같은 창만 보관.
    touch_extreme_by_minute: dict[int, int] = field(default_factory=dict)
    #: 터치된 벽 top-3.
    closed_traded: list[Peak] = field(default_factory=list)
    observed_peak_events: dict[PeakEventKey, Peak] = field(default_factory=dict)
    all_best_by_price_time: dict[tuple[int, int], Peak] = field(default_factory=dict)
    #: 양 스트림에서 본 가장 최근 분 — 창 청소의 기준(단조).
    latest_minute: int = -1
    traded_peak: Peak | None = None
    all_peak: Peak | None = None
    coverage: Literal["full", "partial"] = "partial"

    side_name: ClassVar[str]

    def _is_touched_by_price(self, trade_price: int, wall_price: int) -> bool:
        raise NotImplementedError

    def _extend_touch_extreme(self, current: int | None, trade_price: int) -> int:
        if current is None:
            return trade_price
        return max(current, trade_price) if self.side_name == "ask" else min(current, trade_price)

    def ingest_trade(
        self,
        *,
        price: int,
        side: int,
        t_ms: int | None = None,
        seq: int | None = None,
    ) -> None:
        del seq  # 판정이 분 안에서 닫히므로 체결 순번은 쓰이지 않는다(ADR-0156).
        if side not in (1, -1):
            return
        if _positive_int(price) is None:
            return
        if type(t_ms) is not int or t_ms <= 0:
            return
        minute = _minute_of(t_ms)
        self.touch_extreme_by_minute[minute] = self._extend_touch_extreme(
            self.touch_extreme_by_minute.get(minute), price,
        )
        # 이 체결이 닫는 것은 **같은 분의** 대기 벽뿐이다.
        pending = self.pending_by_minute.get(minute)
        if pending:
            closed = [
                wall_price
                for wall_price, peak in pending.items()
                if self._is_touched_by_price(price, peak.price)
            ]
            for wall_price in closed:
                self._record_closed_peak(pending.pop(wall_price))
            if not pending:
                self.pending_by_minute.pop(minute, None)
        self._advance_window(minute)
        self._refresh_rank_ones()

    def _ingest_orderbook_levels(
        self,
        *,
        t_ms: int,
        levels: Sequence[Mapping[str, int]],
    ) -> None:
        minute = _minute_of(t_ms)
        extreme = self.touch_extreme_by_minute.get(minute)
        for level in levels:
            price = _positive_int(level.get("price"))
            qty = _positive_int(level.get("qty"))
            if price is None or qty is None:
                continue

            peak = Peak(price=price, qty=qty, t_ms=t_ms, seq=None)
            self._offer_all(peak)
            if extreme is not None and self._is_touched_by_price(extreme, price):
                self._record_closed_peak(peak)
                continue
            bucket = self.pending_by_minute.setdefault(minute, {})
            bucket[price] = _larger_peak(
                bucket.get(price), price=price, qty=qty, t_ms=t_ms, seq=None,
            )

        self._advance_window(minute)
        self._refresh_rank_ones()

    def _offer_all(self, peak: Peak) -> None:
        """`all` top-3 에 벽 하나를 제시한다 — 가격당 하나로 접으며 O(1).

        ## 왜 가격별 딕셔너리가 필요 없는가

        한 가격의 후보는 **개선 방향으로만** 바뀐다(더 큰 qty 일 때만 교체). 그래서
        어떤 가격 p 가 top-3 밖에 있다면, p 의 *현재* 최선이 이미 3위보다 나쁘다는
        뜻이고, 이후 p 에 오는 후보 중 top-3 에 들 수 있는 것은 **3위를 이기는 것**
        뿐이다 — 그건 딕셔너리 없이 3위와만 비교하면 판별된다. top-3 안의 가격이
        개선되면 그 자리를 빼고 다시 넣는데, 개선 전 값이 이미 4위 이하 전부보다
        나았으므로 개선 후에도 그렇다(밀려난 후보가 되살아날 일이 없다).

        ## 왜 이 최적화가 필요한가

        종전엔 `all_by_price` 딕셔너리를 하루 내내 들고 **매 틱 전량 정렬**했다.
        가격 다양성이 큰 종목에서 이 경로가 폭발한다 — 실측(하루치 재생, 2026-08-21):
        가격 ~49개 종목 347ms · ~400개 1,221ms · ~1,180개 **3,508ms**. 이 루프는
        300종목 × ~16 ob/s 로 **이벤트 루프 스레드에서 양보 없이** 돈다.
        ADR-0156 이 미체결 계열을 지우면서 구 `open_by_price`(터치된 가격을 영구히
        떨궈 작게 유지되던 구조)가 사라진 것이 회귀의 출처였다.
        """
        top = self.all_top
        key = _peak_rank_key(peak)
        for i, cur in enumerate(top):
            if cur.price != peak.price:
                continue
            if _peak_rank_key(cur) <= key:
                return          # 같은 가격에 이미 더 좋은(또는 동일한) 후보가 있다
            top.pop(i)
            break
        else:
            if len(top) >= _EMIT_LIMIT and _peak_rank_key(top[-1]) <= key:
                return          # 3위도 못 이긴다
        insort(top, peak, key=_peak_rank_key)
        del top[_EMIT_LIMIT:]

    def _advance_window(self, minute: int) -> None:
        """관측 분이 앞으로 갔으면 창 밖의 대기 벽·체결 극값을 버린다.

        버려진 대기 벽은 **미터치로 확정된 것**이고, 미터치 계열은 ADR-0156 에서
        사라졌으므로 어디에도 실리지 않는다. `all_top` 은 별도 구조라 무손실이다.
        """
        if minute <= self.latest_minute:
            return
        self.latest_minute = minute
        cutoff = minute - _PENDING_MINUTE_SLACK
        for stale in [m for m in self.pending_by_minute if m < cutoff]:
            self.pending_by_minute.pop(stale, None)
        for stale in [m for m in self.touch_extreme_by_minute if m < cutoff]:
            self.touch_extreme_by_minute.pop(stale, None)

    def snapshot(self) -> dict | None:
        if self.all_peak is None:
            return None

        traded_peaks = _top_ranked_peaks(self.closed_traded)
        all_peaks = list(self.all_top)
        traded = traded_peaks[0] if traded_peaks else None
        all_peak = all_peaks[0] if all_peaks else None
        if all_peak is None:
            return None
        return {
            "coverage": self.coverage,
            "traded_price": traded.price if traded is not None else None,
            "traded_qty": traded.qty if traded is not None else None,
            "traded_t_ms": traded.t_ms if traded is not None else None,
            "traded_peaks": [_peak_payload(p) for p in traded_peaks],
            "all_price": all_peak.price,
            "all_qty": all_peak.qty,
            "all_t_ms": all_peak.t_ms,
            "all_peaks": [_peak_payload(p) for p in all_peaks],
        }

    def _refresh_rank_ones(self) -> None:
        # 두 계열 모두 **이미 상한 3** 이라 여기서 큰 정렬이 없다 — `all_top` 은
        # `_offer_all` 이 증분으로, `closed_traded` 는 `_record_closed_peak` 가
        # `_top_ranked_peaks` 로 유지한다. 이 함수가 틱 경로 위에 있으므로
        # (300종목 × ~16 ob/s, 이벤트 루프 스레드) 여기에 O(가격 수) 를 두지 말 것.
        self.all_peak = self.all_top[0] if self.all_top else None
        self.traded_peak = _rank_one(self.closed_traded)
        bounded_all = self.all_top
        self.observed_peak_events = {
            _peak_event_key(self.side_name, peak): peak for peak in bounded_all
        }
        self.all_best_by_price_time = {
            (peak.price, peak.t_ms): peak for peak in bounded_all
        }

    def _record_closed_peak(self, peak: Peak) -> None:
        self.closed_traded = _top_ranked_peaks([*self.closed_traded, peak])


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


def _seq_sort_key(seq: int | None) -> int:
    return seq if type(seq) is int else -1


def _positive_int(value: object) -> int | None:
    if type(value) is not int:
        return None
    if value <= 0:
        return None
    return value
