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
from typing import Any


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

    def to_jsonl(self) -> str:
        """Serialize to one JSONL line (no trailing newline)."""
        return json.dumps(
            {"t_ms": self.t_ms, "kind": self.kind.value, "payload": self.payload},
            ensure_ascii=False,
        )
