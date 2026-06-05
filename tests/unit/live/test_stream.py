"""Unit test for LiveStream orchestrator."""
import time

from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream
from hoga.live.writer import LiveWriter
from hoga.live.ws_frames import WsTick


def _trade_tick(t_ms, qty, side):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": t_ms, "price": 100, "qty": qty, "side": side,
                    "side_source": "kis_ws"}],
    })


async def test_on_tick_publishes_immediately_and_flush_writes_jsonl(tmp_path):
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")

    now = int(time.time() * 1000)   # 벽시계 — buffer eviction 컷오프 안쪽
    await stream.on_tick(_trade_tick(now, qty=5, side=1))
    series = await buf.get_series("005930")          # per-tick: 즉시 buffer에
    assert len(series["trades"]) == 1

    await stream.flush_once(now_ms=now + 10_000)     # 10초 경계 flush
    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    assert '"kind": "fill"' in jsonl
    assert '"buy_qty": 5' in jsonl
    assert '"kind": "trade"' not in jsonl            # 체결 raw는 JSONL에 안 감(Q4)
