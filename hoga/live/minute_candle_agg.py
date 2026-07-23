"""Live Tick → 1분봉 캔들 합성기 (ADR-0125 — kiwoom WS 실시간 캔들).

키움 WS 체결(0B) 틱을 **수신 시점**(다운샘플 이전)에 받아 per-code·per-minute
OHLCV 봉으로 집계한다. `TickDownsampler`와 대칭인 sync 상태형 집계기다 —
LiveStream의 윈도 경계 원자성(materialize-then-reset)이 단일 이벤트 루프에서의
무중단 실행에 의존하므로 모든 메서드는 no-await여야 한다.

**왜 수신 시점인가(방식 a').** 저장된 `trades.parquet`은 10초 (가격,방향) 집계본이라
(1) 다운샘플러가 side==0(동시호가·장전 단일가) 물량을 버려 거래량이 언더카운트되고
(2) 윈도 시작 라벨이라 분 내 시가/종가 순서가 ±10초 소실된다. `on_tick`의 raw 틱은
per-tick 가격·수량·누적거래량(cum_volume, FID 13)을 전부 보므로 정확한 봉을 만든다.

**거래량은 봉 자기완결적 cum_volume delta**로 잡는다:
``volume = last_cum − first_cum + first_qty`` — 봉 첫 틱 직전 누적거래량이
``first_cum − first_qty``이므로 봉 구간 거래량은 위 식으로 봉 하나만 보고 구해진다
(봉 간 baseline 상태 불필요 → flush/commit durability가 단순). cum_volume이 프레임에
없으면 per-tick ``qty_sum``으로 폴백한다. 두 경로 모두 다운샘플의 side==0 누락을
겪지 않는다.

인코딩: 입력 틱 t_ms는 Unix ms(UTC). 분 경계는 60_000ms 격자라 KST(+9h 정수 시차)와
UTC에서 동일하게 정렬된다. flush가 내는 LiveSnapshot.t_ms도 **분 시작 Unix ms** —
자정기준 ms 변환(candles.parquet 네이티브)은 날짜를 아는 promote 단계가 맡는다.
"""
from __future__ import annotations

from dataclasses import dataclass

from .snapshot import LiveSnapshot, SnapshotKind
from .ticks import WsTick

MS_PER_MINUTE = 60_000


@dataclass
class _Bar:
    """진행 중(또는 봉인 대기) 1분봉 상태. 가격은 원 단위 int."""

    open: int
    high: int
    low: int
    close: int
    qty_sum: int = 0
    first_cum: int | None = None
    first_qty: int = 0
    last_cum: int | None = None

    def volume(self) -> int:
        """봉 구간 거래량 — cum_volume delta 우선, 미수신 시 per-tick 합 폴백."""
        if self.first_cum is not None and self.last_cum is not None:
            vol = self.last_cum - self.first_cum + self.first_qty
            if vol >= 0:
                return vol
            # cum 되감김(재시작·리셋 등 비정상) → 폴백.
        return self.qty_sum


class MinuteCandleAggregator:
    """모든 메서드는 sync(no await) — 다운샘플러와 동일 계약."""

    def __init__(self) -> None:
        # code → {minute_index → _Bar}. minute_index = unix_ms // 60_000.
        self._codes: dict[str, dict[int, _Bar]] = {}

    def ingest(self, tick: WsTick) -> None:
        if tick.kind is not SnapshotKind.TRADE:
            return
        trades = tick.payload.get("trades")
        if not trades:
            return
        cum = tick.payload.get("cum_volume")
        cum_val = int(cum) if isinstance(cum, int) and cum > 0 else None
        bars = self._codes.setdefault(tick.code, {})
        for tr in trades:
            price = int(tr.get("price", 0) or 0)
            qty = int(tr.get("qty", 0) or 0)
            t_ms = tr.get("t_ms")
            if price <= 0 or qty <= 0 or not isinstance(t_ms, int):
                continue
            minute = t_ms // MS_PER_MINUTE
            bar = bars.get(minute)
            if bar is None:
                bar = _Bar(open=price, high=price, low=price, close=price)
                bars[minute] = bar
            else:
                bar.high = max(bar.high, price)
                bar.low = min(bar.low, price)
                bar.close = price
            bar.qty_sum += qty
            if cum_val is not None:
                if bar.first_cum is None:
                    bar.first_cum = cum_val
                    bar.first_qty = qty
                bar.last_cum = cum_val

    def flush(self, *, now_ms: int, seal_all: bool = False) -> dict[str, list[LiveSnapshot]]:
        """완성(봉인) 봉만 반환 — **제거하지 않는다**(durability: commit이 뺀다).

        봉인 기준: 봉의 분 인덱스 < 현재 분(now_ms 기준). ``seal_all``이면 진행 중
        봉까지 전부 봉인(게이트 닫힘 전환 drain에서 마지막 봉을 잃지 않게).

        LiveSnapshot.t_ms는 분 시작 Unix ms. payload는 OHLCV(원 단위)."""
        cutoff = now_ms // MS_PER_MINUTE
        out: dict[str, list[LiveSnapshot]] = {}
        for code, bars in self._codes.items():
            snaps: list[LiveSnapshot] = []
            for minute in sorted(bars):
                if not seal_all and minute >= cutoff:
                    continue
                bar = bars[minute]
                snaps.append(LiveSnapshot(
                    t_ms=minute * MS_PER_MINUTE,
                    kind=SnapshotKind.CANDLE,
                    payload={
                        "open": bar.open,
                        "high": bar.high,
                        "low": bar.low,
                        "close": bar.close,
                        "volume": bar.volume(),
                    },
                ))
            if snaps:
                out[code] = snaps
        return out

    def commit(self, code: str, *, minutes: list[int]) -> None:
        """append 성공 후 봉인 봉을 제거한다(다운샘플러 commit_code와 동형).

        봉이 서로 독립(봉 자기완결적 거래량)이라 baseline을 다시 셈할 필요가 없다 —
        해당 분 버킷만 지우면 된다. evict된 코드엔 no-op."""
        bars = self._codes.get(code)
        if bars is None:
            return
        for minute in minutes:
            bars.pop(minute, None)
        if not bars:
            del self._codes[code]

    def set_active_codes(self, codes: set[str]) -> None:
        """Live Set 밖으로 밀려난 코드의 미봉인 봉 제거(다운샘플러와 동일 규율) —
        구독 해제된 종목이 유령 봉을 남기지 않게 한다."""
        for code in list(self._codes):
            if code not in codes:
                del self._codes[code]

    def reset(self) -> None:
        """일경계 초기화 — 진행 중 봉이 밤을 넘겨 다음 거래일을 오염시키지 않게.
        게이트 닫힘 순간 호출(다운샘플러 reset과 동일 위치)."""
        self._codes.clear()
