"""LiveSnapshot 단위 테스트.

poller 시절의 typed 빌더(from_orderbook/from_trades/from_brokers)와 그 byte-pin
테스트는 Task 13에서 poller와 함께 은퇴했다 — WS 경로의 payload 형태(키-호환)는
`tests/unit/live/test_ws_frames.py`가 파서 출력 기준으로 pin한다.
남은 빌더는 from_fill(10초 체결강도 구간합, 그릴링 Q4)뿐이다.
"""
from __future__ import annotations

from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def test_from_fill_payload_shape():
    s = LiveSnapshot.from_fill(t_ms=1_770_000_000_000, buy_qty=120, sell_qty=80, phase="regular")
    assert s.kind is SnapshotKind.FILL
    assert s.t_ms == 1_770_000_000_000
    assert s.payload == {"buy_qty": 120, "sell_qty": 80, "phase": "regular"}
    assert '"kind": "fill"' in s.to_jsonl()
