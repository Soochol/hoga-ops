"""Live Snapshot — write-path 전용 도메인 모델 (CONTEXT.md 참조).

A LiveSnapshot is the unit of measurement Live Capture writes per
(Code, t_ms) tick — one entry in the JSONL feed of the form
`{t_ms, kind, payload}` where kind ∈ {"ob", "trade", "broker", "fill"}.

Wire-model models live in hoga/live/candle_models.py; LiveSnapshot is the
internal write-path representation only.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from typing import Any


class SnapshotKind(str, Enum):  # noqa: UP042 — StrEnum 전환은 str() 동작이 바뀌어 wire format 위험
    """The kinds of Live Snapshot. ob/broker/trade는 poller 시절부터,
    fill은 WS 전환(그릴링 Q4)의 10초 체결강도 구간합.

    WS 경로의 trade는 per-tick 원본이 아니라 10초 (price, side) qty
    집계이며, Continuous Trade Volume Distribution의 price-level artifact다.
    """

    OB = "ob"
    TRADE = "trade"
    BROKER = "broker"
    FILL = "fill"
    # 종목프로그램매매(키움 0w). stream.on_tick이 KRX 틱을 표시 buffer와
    # program_trade_latch 양쪽으로 fan-out한다. 표시 buffer는 /api/live/series와
    # WS push용이며, latch는 30초 sidecar 저장용이다. JSONL ingest에는 들어가지 않는다.
    PROGRAM = "program"
    # 주식시간외호가(키움 0E). PROGRAM 과 같은 **표시 전용** 부류 — stream.on_tick 이
    # 표시 buffer 로만 내보내고 JSONL ingest 에는 넣지 않는다.
    #
    # OB 와 합치지 않는 이유는 담는 것이 다르기 때문이다. 0E 에는 10단 사다리가 없고
    # 총잔량 두 개뿐이라(kiwoom_fields 의 0E 절), OB 로 위장하면 빈 사다리가 15:30
    # 스냅샷을 0 으로 덮어써 화면에서 호가가 사라진다. 별도 kind 라야 소비자가
    # "사다리는 정규장 마지막 값, 총잔량은 시간외 현재값"을 구분해 그릴 수 있다.
    AFTER_HOURS = "ah"
    # 키움 WS 체결 틱에서 수신 시점에 합성한 1분봉(ADR-0040/0121/0124 개정).
    # trade(10초 집계·매물대용)와 달리 candle은 완성된 OHLCV 봉이며 candles.parquet
    # 으로 승격된다. payload={"open","high","low","close","volume"}(원 단위),
    # LiveSnapshot.t_ms=분 시작 Unix ms(promote가 자정기준 ms로 변환).
    CANDLE = "candle"


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
