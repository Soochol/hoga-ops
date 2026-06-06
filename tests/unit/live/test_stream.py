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


async def test_on_tick_publishes_immediately_and_flush_writes_jsonl(tmp_path):
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    # 저장 경로 게이트는 flush 루프가 유지하는 플래그(리뷰 R2) — 루프 없이
    # on_tick만 단위 테스트하므로 플래그를 직접 연다.
    stream._gate_open = True

    now = int(time.time() * 1000)   # 벽시계 — buffer eviction 컷오프 안쪽
    await stream.on_tick(_trade_tick(now, qty=5, side=1))
    series = await buf.get_series("005930")          # per-tick: 즉시 buffer에
    assert len(series["trades"]) == 1

    await stream.flush_once(now_ms=now + 10_000)     # 10초 경계 flush
    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    assert '"kind": "fill"' in jsonl
    assert '"buy_qty": 5' in jsonl
    assert '"kind": "trade"' not in jsonl            # 체결 raw는 JSONL에 안 감(Q4)


async def test_on_tick_ingest_gated_off_skips_storage_but_still_displays(tmp_path):
    """게이트 False면 표시(buffer)는 들어가고 저장(다운샘플러)은 비어야 한다
    (리뷰 C1 벡터 1 — 15:30 이후 잔여 틱의 저장 누적 차단)."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    assert stream._gate_open is False   # 기본값: 루프 첫 판정 전엔 ingest 안 함(R2)

    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=5, side=1))
    series = await buf.get_series("005930")          # 표시는 무게이트 — 들어간다
    assert len(series["trades"]) == 1

    await stream.flush_once(now_ms=now + 10_000)     # 다운샘플러 비어 있음
    jsonl_path = tmp_path / "live" / "20260605" / "005930.jsonl"
    assert not jsonl_path.exists()                   # 저장 경로엔 아무것도 안 감


def _ob_tick(t_ms, tot_ask):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": t_ms, "asks": [], "bids": [],
        "total_ask_qty": tot_ask, "total_bid_qty": 0,
    })


async def test_run_flush_loop_drains_resets_and_reopen_has_no_ghost_carry(
    tmp_path, monkeypatch,
):
    """게이트 닫힘 전환 시 drain flush가 마감 당일 날짜로 합·carry를 1회 기록하고,
    직후 reset로 상태가 소멸해 **재개장(reopen) 후 flush들이 stale carry(OB)를
    다시 쓰지 않음**을 확인(리뷰 C1·I1·R3). OB는 상태형이라 flush가 비우지 않는
    carry — reset 배선이 빠지면 reopen flush마다 어제 호가창이 유령 기록된다."""
    monkeypatch.setattr(stream_mod, "FLUSH_INTERVAL_S", 0.05)
    monkeypatch.setattr(stream_mod, "IDLE_INTERVAL_S", 0.02)

    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")

    now = int(time.time() * 1000)

    # 게이트 스텁(루프 1iteration당 1콜): ①open(빈 flush) → ②ingest(OB+체결) 후
    # closed 전환(drain: ob 1줄 + fill 1줄 기록 → reset) → ③~⑥closed 유지 →
    # ⑦+ reopen — reset가 배선돼 있으면 빈 _ds라 아무것도 안 쓴다.
    # 시간 의존을 스텁 안에 가둬 '무엇이 쓰이는가'를 결정적으로 만든다.
    calls = {"n": 0}

    def gate(now_ms):
        calls["n"] += 1
        if calls["n"] == 1:
            return True
        if calls["n"] == 2:
            stream._ds.ingest(_ob_tick(now, tot_ask=111))   # 상태형 carry
            stream._ds.ingest(_trade_tick(now, qty=5, side=1))  # 흐름 합
            return False
        return calls["n"] > 6                                # ⑦+ reopen

    monkeypatch.setattr(stream_mod, "ws_capture_window", gate)

    jsonl_path = tmp_path / "live" / "20260605" / "005930.jsonl"
    task = asyncio.create_task(stream.run_flush_loop())
    try:
        # drain 기록까지 폴링.
        for _ in range(60):
            await asyncio.sleep(0.02)
            if jsonl_path.exists() and '"buy_qty": 5' in jsonl_path.read_text():
                break
        text = jsonl_path.read_text()
        assert text.count('"kind": "fill"') == 1   # drain의 합 1회
        assert text.count('"kind": "ob"') == 1     # drain의 carry 1회(정당)
        # reopen 후 flush가 여러 번 돌 때까지 대기 — reset가 빠졌다면 여기서
        # ob carry가 flush마다 다시 기록돼 count가 증가한다.
        for _ in range(100):
            await asyncio.sleep(0.02)
            if calls["n"] >= 12:
                break
        final = jsonl_path.read_text()
        assert final.count('"kind": "ob"') == 1    # 유령 carry 없음(R3 pin)
        assert final.count('"kind": "fill"') == 1  # 유령 합도 없음
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
