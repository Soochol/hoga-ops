"""Unit tests for LiveStream orchestrator."""
import asyncio
import contextlib
import time

import hoga.live.stream as stream_mod
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


async def test_on_tick_publishes_immediately_and_flush_writes_jsonl(tmp_path, monkeypatch):
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    # 저장 경로 게이트는 실벽시계라 야간·주말·휴일엔 ingest를 건너뛴다 — 결정성
    # 위해 게이트를 강제로 연다(리뷰 C1로 추가된 on_tick ingest 게이팅 때문).
    monkeypatch.setattr(stream_mod, "ws_capture_window", lambda now_ms: True)

    now = int(time.time() * 1000)   # 벽시계 — buffer eviction 컷오프 안쪽
    await stream.on_tick(_trade_tick(now, qty=5, side=1))
    series = await buf.get_series("005930")          # per-tick: 즉시 buffer에
    assert len(series["trades"]) == 1

    await stream.flush_once(now_ms=now + 10_000)     # 10초 경계 flush
    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    assert '"kind": "fill"' in jsonl
    assert '"buy_qty": 5' in jsonl
    assert '"kind": "trade"' not in jsonl            # 체결 raw는 JSONL에 안 감(Q4)


async def test_on_tick_ingest_gated_off_skips_storage_but_still_displays(tmp_path, monkeypatch):
    """게이트 False면 표시(buffer)는 들어가고 저장(다운샘플러)은 비어야 한다
    (리뷰 C1 벡터 1 — 15:30 이후 잔여 틱의 저장 누적 차단)."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    monkeypatch.setattr(stream_mod, "ws_capture_window", lambda now_ms: False)

    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=5, side=1))
    series = await buf.get_series("005930")          # 표시는 무게이트 — 들어간다
    assert len(series["trades"]) == 1

    await stream.flush_once(now_ms=now + 10_000)     # 다운샘플러 비어 있음
    jsonl_path = tmp_path / "live" / "20260605" / "005930.jsonl"
    assert not jsonl_path.exists()                   # 저장 경로엔 아무것도 안 감


async def test_run_flush_loop_drains_and_resets_at_gate_close(tmp_path, monkeypatch):
    """게이트 닫힘 전환 시 drain flush가 마감 당일 날짜로 합을 기록하고, 이후
    reset로 carry가 소멸해 재개장 후에도 유령 fill이 안 생김을 확인(리뷰 C1·I1)."""
    monkeypatch.setattr(stream_mod, "FLUSH_INTERVAL_S", 0.05)

    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")

    now = int(time.time() * 1000)
    trade = _trade_tick(now, qty=5, side=1)

    # 게이트 스텁: call 1 open(빈 _codes flush) → call 2에서 ingest 후 closed로
    # 전환(drain이 buy_qty=5를 유일한 fill로 기록) → 이후 항상 closed 유지.
    # 시간 의존을 스텁 안에 가둬 '무엇이 쓰이는가'를 결정적으로 만든다.
    calls = {"n": 0}

    def gate(now_ms):
        calls["n"] += 1
        if calls["n"] == 1:
            return True
        if calls["n"] == 2:
            stream._ds.ingest(trade)   # 닫히기 직전 잔여 합
            return False
        return False

    monkeypatch.setattr(stream_mod, "ws_capture_window", gate)

    jsonl_path = tmp_path / "live" / "20260605" / "005930.jsonl"
    task = asyncio.create_task(stream.run_flush_loop())
    try:
        # drain JSONL에 합이 기록될 때까지 폴링(else 분기 1s idle 안쪽).
        for _ in range(40):
            await asyncio.sleep(0.05)
            if jsonl_path.exists() and '"buy_qty": 5' in jsonl_path.read_text():
                break
        text = jsonl_path.read_text()
        assert '"kind": "fill"' in text
        assert '"buy_qty": 5' in text
        # reset로 코드 상태가 소멸 — 게이트가 닫힌 채 추가 fill 라인이 안 생긴다.
        assert text.count('"kind": "fill"') == 1
        for _ in range(40):                       # 1s idle보다 길게 대기(≥2s)
            await asyncio.sleep(0.05)
        assert jsonl_path.read_text().count('"kind": "fill"') == 1   # 유령 carry 없음
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
