"""Live Tick → 10초 Live Snapshot 다운샘플러 (spec §5.3 · §8).

상태형(ob/broker): 윈도 내 마지막 payload가 살아남고, 윈도가 비면 직전값을
flush 시각 t_ms로 carry(§9). 흐름형(fill): side==±1 qty 합 — side==0
(Auction Cross/장전)은 trades.query_fill_strength 의 ``WHERE side != 0``과
동일하게 제외한다. 매물대용 trade snapshot은 같은 side 필터로 10초 동안의
(price, side) qty를 집계해 저장한다.
"""
from __future__ import annotations

from dataclasses import dataclass

from .snapshot import LiveSnapshot, SnapshotKind
from .ticks import WsTick


@dataclass
class _CodeState:
    last_ob: dict | None = None
    last_broker: dict | None = None
    buy_qty: int = 0
    sell_qty: int = 0
    trade_qty_by_price_side: dict[tuple[int, int], int] | None = None


class TickDownsampler:
    """모든 메서드는 sync(no await)여야 한다 — LiveStream의 윈도 경계 원자성
    (materialize-then-reset)이 단일 이벤트 루프에서의 무중단 실행에 의존한다."""

    def __init__(self) -> None:
        self._codes: dict[str, _CodeState] = {}

    def ingest(self, tick: WsTick) -> None:
        st = self._codes.setdefault(tick.code, _CodeState())
        if tick.kind is SnapshotKind.OB:
            st.last_ob = tick.payload
        elif tick.kind is SnapshotKind.BROKER:
            st.last_broker = tick.payload
        elif tick.kind is SnapshotKind.TRADE:
            for tr in tick.payload.get("trades", ()):
                side = tr.get("side", 0)
                price = int(tr.get("price", 0) or 0)
                qty = int(tr.get("qty", 0) or 0)
                if side == 1:
                    st.buy_qty += qty
                elif side == -1:
                    st.sell_qty += qty
                else:
                    continue
                if price <= 0 or qty <= 0:
                    continue
                if st.trade_qty_by_price_side is None:
                    st.trade_qty_by_price_side = {}
                key = (price, int(side))
                st.trade_qty_by_price_side[key] = st.trade_qty_by_price_side.get(key, 0) + qty

    def set_active_codes(self, codes: set[str]) -> None:
        """Live Set 밖으로 밀려난 코드의 carry 상태 제거(advisor C) —
        구독 해제된 종목이 유령 10초 스냅샷을 계속 쓰는 사고 방지.
        carry(§9)는 '조용하지만 살아있는' 종목용이지 '떠난' 종목용이 아니다."""
        for code in list(self._codes):
            if code not in codes:
                del self._codes[code]

    def reset(self) -> None:
        """일경계 초기화 — carry는 '같은 날 조용한 종목'용이지 익일용이 아니다
        (리뷰 C1 벡터 2). 게이트가 닫히는 순간 호출해 last_ob/last_broker가 밤을
        넘겨 다음 거래일 첫 flush를 어제 종가 호가창으로 오염시키는 것을 막는다."""
        self._codes.clear()

    def flush(
        self, *, now_ms: int, phase: str, fill_t_ms: int | None = None
    ) -> dict[str, list[LiveSnapshot]]:
        """윈도 마감 — 코드별 [ob?, broker?, fill] 반환. 흐름 합은 리셋,
        상태(last_ob/last_broker)는 다음 윈도 carry를 위해 보존.

        fill_t_ms(리뷰 #5): 흐름형(fill)은 **윈도 시작** 라벨 — 마감 시각으로
        스탬프하면 분 경계를 걸친 윈도의 합 전체가 다음 분봉으로 귀속돼
        trades 폴백·SSE per-trade 버킷팅과 어긋난다. 상태형(ob/broker)은
        '마감 순간의 상태'이므로 now_ms 유지. None이면 now_ms 폴백(직접 호출
        테스트 호환)."""
        label_ms = fill_t_ms if fill_t_ms is not None else now_ms
        out: dict[str, list[LiveSnapshot]] = {}
        for code, st in self._codes.items():
            snaps: list[LiveSnapshot] = []
            if st.last_ob is not None:
                payload = {**st.last_ob, "phase": phase}
                snaps.append(LiveSnapshot(t_ms=now_ms, kind=SnapshotKind.OB, payload=payload))
            if st.last_broker is not None:
                payload = {**st.last_broker, "phase": phase}
                snaps.append(LiveSnapshot(t_ms=now_ms, kind=SnapshotKind.BROKER, payload=payload))
            if st.trade_qty_by_price_side:
                trades = [
                    {
                        "t_ms": label_ms,
                        "price": price,
                        "qty": qty,
                        "side": side,
                        "side_source": "kis_ws_10s",
                    }
                    for (price, side), qty in sorted(st.trade_qty_by_price_side.items())
                    if qty > 0
                ]
                if trades:
                    snaps.append(LiveSnapshot(
                        t_ms=label_ms,
                        kind=SnapshotKind.TRADE,
                        payload={"trades": trades, "phase": phase},
                    ))
            snaps.append(LiveSnapshot.from_fill(
                t_ms=label_ms, buy_qty=st.buy_qty, sell_qty=st.sell_qty, phase=phase,
            ))
            # 흐름 합은 여기서 리셋하지 않는다(spec 2026-06-08 flush-durability):
            # stream.flush_once가 append 성공 후 commit_code로 '본 양'만 뺀다.
            # await(append) 창에 도착한 틱이 손실되지 않고(subtract-on-commit),
            # append 실패 시엔 commit이 안 불려 합이 다음 윈도로 롤된다(보존).
            out[code] = snaps
        return out

    def commit_code(
        self,
        code: str,
        *,
        buy_qty: int,
        sell_qty: int,
        trades: list[dict] | None = None,
    ) -> None:
        """append 성공 후 flush가 본 흐름 합을 뺀다(spec flush-durability §2.2).

        zero가 아니라 **빼기**인 이유: flush와 commit 사이 await 창에 도착한
        틱(st.buy_qty 증가분)을 보존하기 위함 — 0으로 리셋하면 그 틱이 손실된다.
        evict된(set_active_codes 후 사라진) 코드엔 no-op."""
        st = self._codes.get(code)
        if st is None:
            return
        st.buy_qty -= buy_qty
        st.sell_qty -= sell_qty
        if trades and st.trade_qty_by_price_side:
            for trade in trades:
                key = (int(trade.get("price", 0) or 0), int(trade.get("side", 0) or 0))
                qty = int(trade.get("qty", 0) or 0)
                if key in st.trade_qty_by_price_side:
                    remaining = st.trade_qty_by_price_side[key] - qty
                    if remaining > 0:
                        st.trade_qty_by_price_side[key] = remaining
                    else:
                        del st.trade_qty_by_price_side[key]
            if not st.trade_qty_by_price_side:
                st.trade_qty_by_price_side = None
