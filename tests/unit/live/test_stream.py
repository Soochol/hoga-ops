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


async def test_on_tick_drops_codes_outside_active_set(tmp_path):
    """리뷰 #6: unsubscribe 직후 도착한 in-flight 잔여 프레임이 퇴출 종목의
    다운샘플러 상태를 부활시키면(ingest의 setdefault) 매 10초 flush가 게이트
    마감까지 유령 carry/zero-fill을 쓰고 익일 promote가 parquet으로 영구화
    한다 — on_tick이 활성 집합 밖 코드를 표시·저장 양쪽에서 드롭해야 한다."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True
    stream.set_active_codes({"000660"})              # 005930은 Live Set 밖

    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=5, side=1))   # 005930 잔여 프레임
    series = await buf.get_series("005930")
    assert series["trades"] == []                    # 표시 ring 재생성 금지
    await stream.flush_once(now_ms=now + 10_000)     # 저장 경로에도 부활 없음
    assert not (tmp_path / "live" / "20260605" / "005930.jsonl").exists()


async def test_on_tick_unfiltered_before_active_set_known(tmp_path):
    """set_active_codes 호출 전(None)에는 무필터 — 단위 테스트·부분 조립
    호환을 위한 명시적 계약."""
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=5, side=1))
    assert len((await buf.get_series("005930"))["trades"]) == 1


async def test_flush_once_labels_fill_with_previous_flush_time(tmp_path):
    """리뷰 #5: fill 라벨 = 직전 flush 시각(윈도 시작). 마감 시각 라벨은
    fills.parquet 분봉 버킷팅(마감 floor)을 SSE per-trade 경로(체결 시각
    floor)와 분당 1윈도씩 어긋나게 한다. 첫 flush는 직전 시각이 없어
    now − FLUSH_INTERVAL 폴백."""
    import json as _json

    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    base = (int(time.time() * 1000) // 10_000) * 10_000
    await stream.flush_once(now_ms=base)              # 빈 flush — 윈도 시작 래치
    await stream.on_tick(_trade_tick(base + 1_000, qty=5, side=1))
    await stream.flush_once(now_ms=base + 10_000)     # 윈도 [base, base+10s) 마감

    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    fills = [d for d in map(_json.loads, jsonl.splitlines()) if d["kind"] == "fill"]
    assert fills[0]["t_ms"] == base                   # 윈도 시작 라벨
    assert fills[0]["payload"]["buy_qty"] == 5


def test_next_window_delay_aligns_to_wall_clock_boundary():
    """리뷰 #5: flush 윈도를 벽시계 경계에 정렬 — fills.py의 '10초는 모든
    bucket_ms(60s~1800s)에 정확히 중첩' 전제는 정렬된 루프에서만 참이다.
    경계 정각이면 한 윈도 전체를 기다린다(0 sleep 재진입 방지)."""
    assert stream_mod._next_window_delay_s(100.0, 10.0) == 10.0
    assert abs(stream_mod._next_window_delay_s(103.2, 10.0) - 6.8) < 1e-9
    assert stream_mod._next_window_delay_s(109.999, 10.0) < 0.0011


async def test_run_flush_loop_evaluates_gate_off_event_loop(tmp_path, monkeypatch):
    """게이트 술어는 이벤트 루프 스레드에서 실행하면 안 된다 — 캘린더 게이트
    (should_run_now)가 콜드/네거티브 캐시에서 동기 KIS HTTP(timeout 15s)를
    부르므로, 루프에서 직접 부르면 전체 백엔드(API·SSE·WS recv)가 동결된다.
    구 poller의 `await asyncio.to_thread(_should_poll_now, ...)` 가드 승계."""
    import threading

    monkeypatch.setattr(stream_mod, "IDLE_INTERVAL_S", 0.01)
    seen: list[bool] = []

    def gate(now_ms):
        seen.append(threading.current_thread() is threading.main_thread())
        return False

    monkeypatch.setattr(stream_mod, "ws_capture_window", gate)
    stream = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    task = asyncio.create_task(stream.run_flush_loop())
    try:
        for _ in range(50):
            await asyncio.sleep(0.01)
            if seen:
                break
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    assert seen, "게이트가 한 번도 평가되지 않음"
    assert not any(seen), "게이트 술어가 이벤트 루프(메인 스레드)에서 실행됨"


async def test_flush_date_change_resets_stale_state(tmp_path):
    """R1 백스톱 pin — suspend/시계 점프(미관측 일경계) 시 어제 carry가 오늘
    날짜 JSONL로 새는 것을 flush_once의 date-latch가 차단한다. 이 백스톱은
    해당 경로의 유일한 가드라 mutation-survivable이면 안 된다."""
    date = {"v": "20260605"}
    stream = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: date["v"], phase_fn=lambda: "regular")
    stream._gate_open = True
    now = int(time.time() * 1000)
    await stream.on_tick(_ob_tick(now, tot_ask=111))     # 상태형 carry 스테이징
    await stream.flush_once(now_ms=now)                  # D일: ob 기록 + carry 보존
    assert (tmp_path / "live" / "20260605" / "005930.jsonl").exists()
    date["v"] = "20260606"                               # 미관측 일경계 시뮬레이션
    await stream.flush_once(now_ms=now + 1_000)          # 백스톱: 기록 전 reset
    assert not (tmp_path / "live" / "20260606" / "005930.jsonl").exists()
