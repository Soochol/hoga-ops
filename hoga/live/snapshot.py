"""Live Snapshot — write-path 전용 도메인 모델 (CONTEXT.md 참조).

A LiveSnapshot is the unit of measurement Live Capture writes per
(Code, t_ms) tick — one entry in the JSONL feed of the form
`{t_ms, kind, payload}` where kind ∈ {"ob", "trade", "broker", "fill"}.

Wire-model models live in hoga/live/kis_models.py; LiveSnapshot is the
internal write-path representation only.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from typing import Any


class SnapshotKind(str, Enum):
    """The kinds of Live Snapshot. ob/broker/trade는 poller 시절부터,
    fill은 WS 전환(그릴링 Q4)의 10초 체결강도 구간합.

    WS 경로의 trade는 per-tick 원본이 아니라 10초 (price, side) qty
    집계이며, Continuous Trade Volume Distribution의 price-level artifact다.
    """

    OB = "ob"
    TRADE = "trade"
    BROKER = "broker"
    FILL = "fill"
    # 종목프로그램매매(키움 0w, PR-F4). 표시 버퍼·JSONL 저장을 타지 않는 유일한
    # kind — stream.on_tick 이 입구에서 프로그램 latch 로 라우팅하고 return 한다
    # (소비는 program_trade_store 사이드카 → /api/range 번들).
    PROGRAM = "program"


@dataclass(frozen=True)
class LiveSnapshot:
    """A single Live Snapshot entry written to JSONL.

    See CONTEXT.md "Live Snapshot" term and ADR-0038. The `payload` shape
    depends on `kind`:
    - OB: {"code": str, "t_ms": int, "asks": [...], "bids": [...], ...}
    - TRADE: {"trades": [{"t_ms", "price", "qty", "side", "side_source"}, ...]}
    - BROKER: {"code": str, "t_ms": int, "buy_top": [...], "sell_top": [...]}
    - FILL: {"buy_qty": int, "sell_qty": int, "phase": str}
    """

    t_ms: int
    kind: SnapshotKind
    payload: dict[str, Any]

    @classmethod
    def from_fill(
        cls, *, t_ms: int, buy_qty: int, sell_qty: int, phase: str
    ) -> LiveSnapshot:
        """10초 체결강도 구간합 — side==±1만 합산된 값을 받는다(분류는 다운샘플러 책임)."""
        return cls(
            t_ms=t_ms,
            kind=SnapshotKind.FILL,
            payload={"buy_qty": buy_qty, "sell_qty": sell_qty, "phase": phase},
        )

    def to_jsonl(self) -> str:
        """Serialize to one JSONL line (no trailing newline)."""
        return json.dumps(
            {"t_ms": self.t_ms, "kind": self.kind.value, "payload": self.payload},
            ensure_ascii=False,
        )
