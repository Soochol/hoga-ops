"""Live Snapshot — write-path 전용 도메인 모델 (CONTEXT.md 참조).

A LiveSnapshot is the unit of measurement Live Capture writes per
(Code, t_ms) tick — one entry in the JSONL feed of the form
`{t_ms, kind, payload}` where kind ∈ {"ob", "trade", "broker"}.

Wire-model models live in hoga/live/kis_models.py; LiveSnapshot is the
internal write-path representation only.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from hoga.live.kis_models import KisBrokers, KisOrderbook, KisTrade


class SnapshotKind(str, Enum):
    """The three kinds of Live Snapshot produced per polling cycle."""

    OB = "ob"
    TRADE = "trade"
    BROKER = "broker"


@dataclass(frozen=True)
class LiveSnapshot:
    """A single Live Snapshot entry written to JSONL.

    See CONTEXT.md "Live Snapshot" term and ADR-0038. The `payload` shape
    depends on `kind`:
    - OB: {"code": str, "t_ms": int, "asks": [...], "bids": [...], ...}
    - TRADE: {"trades": [{"t_ms", "price", "qty", "side", "side_source"}, ...]}
    - BROKER: {"code": str, "t_ms": int, "buy_top": [...], "sell_top": [...]}
    """

    t_ms: int
    kind: SnapshotKind
    payload: dict[str, Any]

    @classmethod
    def from_orderbook(cls, ob: KisOrderbook, *, phase: str) -> LiveSnapshot:
        """Build an OB snapshot from a typed KIS orderbook.

        Byte-identical to the legacy poller path (``ob.model_dump()`` plus a
        ``phase`` key) so promote.py's on-disk re-parse is unaffected; the
        payoff is that a KIS field rename is a type error here, not a silently
        zeroed parquet column at promote time.
        """
        payload = ob.model_dump()
        payload["phase"] = phase
        return cls(t_ms=ob.t_ms, kind=SnapshotKind.OB, payload=payload)

    @classmethod
    def from_trades(
        cls, trades: list[KisTrade], *, t_ms: int, phase: str
    ) -> LiveSnapshot:
        """Build a TRADE snapshot. ``t_ms`` is the cycle's outer tick (the OB
        t_ms), matching the legacy poller which anchored all three kinds to it."""
        payload = {"trades": [t.model_dump() for t in trades], "phase": phase}
        return cls(t_ms=t_ms, kind=SnapshotKind.TRADE, payload=payload)

    @classmethod
    def from_brokers(
        cls, brokers: KisBrokers, *, t_ms: int, phase: str
    ) -> LiveSnapshot:
        """Build a BROKER snapshot. ``t_ms`` is the cycle's outer tick."""
        payload = brokers.model_dump()
        payload["phase"] = phase
        return cls(t_ms=t_ms, kind=SnapshotKind.BROKER, payload=payload)

    def to_jsonl(self) -> str:
        """Serialize to one JSONL line (no trailing newline)."""
        return json.dumps(
            {"t_ms": self.t_ms, "kind": self.kind.value, "payload": self.payload},
            ensure_ascii=False,
        )
