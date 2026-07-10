"""REST 모델 → LiveBuffer entry 변환 빌더 (ADR-0067 보는종목 표시 전용).

activeCode를 REST로 조회한 결과를 LiveBuffer.publish에 넘길 LiveSnapshot으로 변환한다.
WS 경로(stream.on_tick)가 publish하는 entry와 동일 shape을 생성하므로 프론트가
WS/REST를 구분 없이 표시할 수 있다.

절대 호출 금지: writer.append / promote / to_jsonl — 디스크 저장은 WS 경로 전용.

Entry shape (buffer.publish가 만드는 dict):
  {"t_ms": ..., "kind": "ob"|"trade"|"broker", **payload}
  payload에는 항상 "phase" 키 포함 (on_tick이 phase를 payload에 추가하는 것과 동일).
"""
from __future__ import annotations

from hoga.live.kis_models import KisBrokers, KisOrderbook, KisTrade
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def ob_to_snapshot(
    ob: KisOrderbook, *, phase: str, venue: str | None = None
) -> LiveSnapshot:
    """KisOrderbook → SnapshotKind.OB LiveSnapshot.

    WS ob 경로(_parse_orderbook → on_tick)와 동일 payload shape:
      {code, t_ms, asks[{price,qty}], bids[{price,qty}],
       total_ask_qty, total_bid_qty, phase, [venue]}

    venue(ADR-0099, 시분할 표시폴러)는 optional — None(저장 레코더)이면 payload에
    "venue" 키 자체를 넣지 않아 디스크 스키마 불변. 값이 있으면 WS 경로
    (stream.py: payload["venue"]=tick.venue)와 동일 shape으로 프론트 venue 매칭 동작.
    """
    payload = {
        "code": ob.code,
        "t_ms": ob.t_ms,
        "asks": [{"price": lvl.price, "qty": lvl.qty} for lvl in ob.asks],
        "bids": [{"price": lvl.price, "qty": lvl.qty} for lvl in ob.bids],
        "total_ask_qty": ob.total_ask_qty,
        "total_bid_qty": ob.total_bid_qty,
        "phase": phase,
    }
    if venue is not None:
        payload["venue"] = venue
    return LiveSnapshot(t_ms=ob.t_ms, kind=SnapshotKind.OB, payload=payload)


def trades_to_snapshots(
    trades: list[KisTrade], *, phase: str
) -> list[LiveSnapshot]:
    """list[KisTrade] → list[LiveSnapshot(kind=TRADE)].

    WS trade 경로(_parse_trades → on_tick)와 동일: 체결 1건 → snapshot 1개.
    payload: {"trades": [{"t_ms", "price", "qty", "side", "side_source"}], "phase"}
    """
    return [
        LiveSnapshot(
            t_ms=tr.t_ms,
            kind=SnapshotKind.TRADE,
            payload={
                "trades": [
                    {
                        "t_ms": tr.t_ms,
                        "price": tr.price,
                        "qty": tr.qty,
                        "side": tr.side,
                        "side_source": tr.side_source,
                    }
                ],
                "phase": phase,
            },
        )
        for tr in trades
    ]


def brokers_to_snapshot(
    brokers: KisBrokers, *, now_ms: int, phase: str
) -> LiveSnapshot:
    """KisBrokers → SnapshotKind.BROKER LiveSnapshot.

    WS broker 경로(_parse_member → on_tick)와 동일 payload shape:
      {code, t_ms, sell_top[{name,qty}], buy_top[{name,qty}], phase}

    KisBrokers에는 t_ms 필드가 없으므로 WS 경로처럼 수신 시각(now_ms)을 사용한다.
    """
    return LiveSnapshot(
        t_ms=now_ms,
        kind=SnapshotKind.BROKER,
        payload={
            "code": brokers.code,
            "t_ms": now_ms,
            "sell_top": [{"name": e.name, "qty": e.qty} for e in brokers.sell_top],
            "buy_top": [{"name": e.name, "qty": e.qty} for e in brokers.buy_top],
            "phase": phase,
        },
    )
