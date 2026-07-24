"""Unit tests for LiveStream orchestrator."""
import asyncio
import contextlib
import json
import time
from datetime import datetime, timedelta, timezone

import hoga.live.session_gate as session_gate_mod
import hoga.live.stream as stream_mod
from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream
from hoga.live.ticks import WsTick
from hoga.live.writer import LiveWriter

KST = timezone(timedelta(hours=9))


def _kst_ms(hour: int, minute: int = 0, second: int = 0) -> int:
    return int(datetime(2026, 6, 16, hour, minute, second, tzinfo=KST).timestamp() * 1000)


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
    assert '"kind": "trade"' in jsonl               # 매물대용 10초 가격 집계
    assert '"price": 100' in jsonl


async def test_prev_close_reaches_display_but_not_storage(tmp_path):
    """키움 additive 확장(prev_close)은 표시 스냅샷까지 살아 가되 저장 스키마는 안 건드린다.

    표시 경로는 on_tick 이 payload 를 스프레드하므로 확장 키가 그대로 실리고
    (프론트가 등락률 기준가로 쓴다), 저장 경로는 downsampler 가 payload 를
    재구성하므로 parquet 스키마가 불변이다 — 이 분리가 깨지면 여기서 잡힌다.
    """
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    now = int(time.time() * 1000)
    tick = _trade_tick(now, qty=5, side=1)
    tick.payload["prev_close"] = 96000
    await stream.on_tick(tick)

    series = await buf.get_series("005930")
    assert series["trades"][0]["prev_close"] == 96000   # 표시: 보존

    await stream.flush_once(now_ms=now + 10_000)
    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    assert "prev_close" not in jsonl                    # 저장: 미유출


def _candle_lines(jsonl: str) -> list[dict]:
    out = []
    for raw in jsonl.splitlines():
        if not raw:
            continue
        rec = json.loads(raw)
        if rec.get("kind") == "candle":
            out.append(rec)
    return out


async def test_candle_synthesized_and_written_on_minute_seal(tmp_path):
    """키움 체결 틱 → 1분봉 합성 → 분 봉인 시 candle JSONL 기록(방식 a')."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    stream._gate_open = True

    t0 = _kst_ms(10, 0, 5)
    for t, price, qty, cum in [(t0, 100, 5, 5), (t0 + 1000, 105, 3, 8), (t0 + 2000, 98, 2, 10)]:
        tick = WsTick(code="005930", t_ms=t, kind=SnapshotKind.TRADE, payload={
            "trades": [{"t_ms": t, "price": price, "qty": qty, "side": 1,
                        "side_source": "kiwoom_ws"}],
            "cum_volume": cum,
        })
        await stream.on_tick(tick)

    # 같은 분(10:00) flush → 아직 미봉인.
    await stream.flush_once(now_ms=t0 + 5_000)
    jsonl_path = tmp_path / "live" / "20260616" / "005930.jsonl"
    assert _candle_lines(jsonl_path.read_text()) == []

    # 다음 분(10:01) flush → 10:00 봉 봉인·기록.
    await stream.flush_once(now_ms=_kst_ms(10, 1, 5))
    candles = _candle_lines(jsonl_path.read_text())
    assert len(candles) == 1
    p = candles[0]["payload"]
    assert (p["open"], p["high"], p["low"], p["close"]) == (100, 105, 98, 98)  # close=마지막 틱
    assert p["volume"] == 10   # cum delta: 10 - 5 + 5


async def test_candle_not_synthesized_for_nxt(tmp_path):
    """NXT 틱은 성역 격리로 저장 경로 진입 전 리턴 — 캔들도 안 생긴다."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    stream._gate_open = True

    t0 = _kst_ms(10, 0, 5)
    tick = WsTick(code="005930", t_ms=t0, kind=SnapshotKind.TRADE, venue="NXT", payload={
        "trades": [{"t_ms": t0, "price": 100, "qty": 5, "side": 1, "side_source": "kiwoom_ws"}],
    })
    await stream.on_tick(tick)
    await stream.flush_once(now_ms=_kst_ms(10, 1, 5))
    jsonl_path = tmp_path / "live" / "20260616" / "005930.jsonl"
    assert not jsonl_path.exists() or _candle_lines(jsonl_path.read_text()) == []


async def test_drain_seals_final_in_progress_candle(tmp_path):
    """게이트 닫힘 drain(seal_candles_all)이 진행 중 마지막 봉을 봉인한다."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    stream._gate_open = True

    t0 = _kst_ms(15, 30, 1)   # 종가 근처 마지막 봉
    tick = WsTick(code="005930", t_ms=t0, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": t0, "price": 200, "qty": 7, "side": 1, "side_source": "kiwoom_ws"}],
    })
    await stream.on_tick(tick)
    jsonl_path = tmp_path / "live" / "20260616" / "005930.jsonl"

    # 일반 flush(같은 분)면 미봉인.
    await stream.flush_once(now_ms=t0 + 2_000)
    assert _candle_lines(jsonl_path.read_text()) == []

    # drain: seal_candles_all → 진행 중 봉도 봉인.
    await stream.flush_once(now_ms=t0 + 2_000, seal_candles_all=True)
    candles = _candle_lines(jsonl_path.read_text())
    assert len(candles) == 1
    assert candles[0]["payload"]["close"] == 200


async def test_program_tick_routes_to_latch_and_display_buffer_not_storage(tmp_path):
    """KRX PROGRAM은 latch와 표시 buffer에 가지만 JSONL 저장에는 들어가지 않는다.

    NXT venue 는 latch·표시 buffer 어디에도 안 남는다 — 프로그램 수급은 KRX
    집계 데이터다.
    """
    from hoga.live import program_trade_latch
    program_trade_latch.reset_for_tests()
    buf = LiveBuffer()
    display_q = buf.subscribe("005930")
    nxt_display_q = buf.subscribe("000660")
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    now = int(time.time() * 1000)
    tick = WsTick(code="005930", t_ms=now, kind=SnapshotKind.PROGRAM, payload={
        "code": "005930", "t_ms": now, "net_qty": 50, "net_amount": 2_500_000,
        "sell_qty": 100, "sell_amount": 5_000_000, "buy_qty": 150,
        "buy_amount": 7_500_000, "price": 50_000,
    })
    await stream.on_tick(tick)
    nxt = WsTick(code="000660", t_ms=now, kind=SnapshotKind.PROGRAM, venue="NXT",
                 payload={"code": "000660", "t_ms": now, "net_qty": 1})
    await stream.on_tick(nxt)

    latched = program_trade_latch.drain()
    assert set(latched) == {"005930"}          # KRX 만 latch
    assert latched["005930"]["net_qty"] == 50
    display_entry = await asyncio.wait_for(display_q.get(), timeout=1.0)
    assert display_entry == {
        **tick.payload,
        "kind": "program",
        "phase": "regular",
        "venue": "KRX",
    }
    assert nxt_display_q.empty()
    await stream.flush_once(now_ms=now + 10_000)
    assert not (tmp_path / "live" / "20260605" / "005930.jsonl").exists()  # 저장 미진입
    program_trade_latch.reset_for_tests()


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


def _nxt_trade_tick(t_ms, qty, side):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.TRADE, venue="NXT", payload={
        "trades": [{"t_ms": t_ms, "price": 100, "qty": qty, "side": side,
                    "side_source": "kis_ws"}],
    })


async def test_on_tick_nxt_venue_displays_but_is_never_stored(tmp_path):
    """성역 격리(#524): NXT 틱은 표시(buffer)엔 들어가고 venue 태그도 실리지만,
    저장 게이트가 열려 있어도(정규장) 다운샘플러/저장엔 절대 안 들어간다 —
    KRX 정규장 캡처를 byte-for-byte 불변으로 유지."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True  # 저장 게이트 열림(정규장) — 그래도 NXT는 격리돼야 함
    now = int(time.time() * 1000)
    await stream.on_tick(_nxt_trade_tick(now, qty=5, side=1))

    series = await buf.get_series("005930")
    assert len(series["trades"]) == 1              # 표시엔 들어감
    assert series["trades"][0]["venue"] == "NXT"   # venue 태그 전달(프론트 구분용)

    await stream.flush_once(now_ms=now + 10_000)
    jsonl = tmp_path / "live" / "20260605" / "005930.jsonl"
    stored = jsonl.read_text() if jsonl.exists() else ""
    assert '"kind": "trade"' not in stored          # 저장 경로엔 NXT 미기록
    assert '"kind": "fill"' not in stored           # 흐름 집계에도 미반영


async def test_on_tick_krx_still_stored_alongside_nxt_isolation(tmp_path):
    """대조군: 동일 조건에서 KRX 틱은 기존대로 저장된다(격리가 KRX를 막지 않음)."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True
    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=7, side=1))  # KRX(기본 venue)
    await stream.flush_once(now_ms=now + 10_000)
    stored = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    assert '"buy_qty": 7' in stored
    assert '"kind": "trade"' in stored


async def test_on_tick_mixed_krx_and_nxt_stores_only_krx_flow(tmp_path):
    """혼합: 같은 스트림에 KRX·NXT 틱이 섞여 들어와도 저장 흐름 집계는 KRX만 반영한다
    (경계 스왑 찰나에 두 venue가 겹쳐도 캡처는 KRX 전용, #524 성역 격리)."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True
    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=7, side=1))         # KRX 매수 7
    await stream.on_tick(_nxt_trade_tick(now, qty=99, side=1))    # NXT 매수 99 — 저장 제외
    await stream.flush_once(now_ms=now + 10_000)

    stored = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    assert '"buy_qty": 7' in stored     # KRX만 집계
    assert '"buy_qty": 106' not in stored  # NXT 99가 섞이지 않음
    # 표시엔 둘 다(KRX+NXT) 있고 각 venue 태그가 붙는다.
    series = await buf.get_series("005930")
    assert {t["venue"] for t in series["trades"]} == {"KRX", "NXT"}


def _ob_tick(t_ms, tot_ask):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": t_ms, "asks": [], "bids": [],
        "total_ask_qty": tot_ask, "total_bid_qty": 0,
    })


def _ask_peak_ob_tick(t_ms):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": t_ms,
        "asks": [
            {"price": 101, "qty": 3},
            {"price": 102, "qty": 9},
            {"price": 103, "qty": 1},
            {"price": 104, "qty": 1},
        ],
        "bids": [
            {"price": 100, "qty": 1},
            {"price": 99, "qty": 1},
            {"price": 98, "qty": 1},
            {"price": 97, "qty": 1},
        ],
        "total_ask_qty": 14, "total_bid_qty": 4,
    })


def _ask_peak_ob_tick_with_front_qtys(t_ms, *, ask_101, ask_102):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": t_ms,
        "asks": [
            {"price": 101, "qty": ask_101},
            {"price": 102, "qty": ask_102},
            {"price": 103, "qty": 1},
            {"price": 104, "qty": 1},
        ],
        "bids": [
            {"price": 100, "qty": 1},
            {"price": 99, "qty": 1},
            {"price": 98, "qty": 1},
            {"price": 97, "qty": 1},
        ],
        "total_ask_qty": ask_101 + ask_102 + 2,
        "total_bid_qty": 4,
    })


def _bid_peak_ob_tick(t_ms):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": t_ms,
        "asks": [{"price": 70_100 + i * 50, "qty": 100} for i in range(10)],
        "bids": [
            {"price": 70_000, "qty": 5_000},
            {"price": 68_900, "qty": 12_000},
            *[{"price": 68_800 - i * 50, "qty": 100} for i in range(8)],
        ],
        "total_ask_qty": 1_000, "total_bid_qty": 17_800,
    })


async def test_on_tick_updates_today_ask_peak_state(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    now = _kst_ms(9, 10)
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": now, "price": 101, "qty": 5, "side": 1}],
    }))
    await stream.on_tick(_ask_peak_ob_tick(now + 5_000))

    assert stream.ask_peak_snapshot("005930") == {
        "date": "20260616",
        "coverage": "partial",
        "traded_prices": [101],
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "untraded_price": 102,
        "untraded_qty": 9,
        "untraded_t_ms": now + 5_000,
        "untraded_peaks": [
            {"price": 102, "qty": 9, "t_ms": now + 5_000},
            {"price": 101, "qty": 3, "t_ms": now + 5_000},
            {"price": 103, "qty": 1, "t_ms": now + 5_000},
        ],
        "all_price": 102,
        "all_qty": 9,
        "all_t_ms": now + 5_000,
        "all_peaks": [
            {"price": 102, "qty": 9, "t_ms": now + 5_000},
            {"price": 101, "qty": 3, "t_ms": now + 5_000},
            {"price": 103, "qty": 1, "t_ms": now + 5_000},
        ],
    }


async def test_on_tick_updates_today_bid_peak_state(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260619", phase_fn=lambda: "regular")
    stream.set_active_codes({"005930"})

    now = int(datetime(2026, 6, 19, 9, 1, tzinfo=KST).timestamp() * 1000)
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": now, "price": 70_000, "qty": 5, "side": 1}],
    }))
    await stream.on_tick(_bid_peak_ob_tick(now + 5_000))

    assert stream.bid_peak_snapshot("005930") == {
        "date": "20260619",
        "coverage": "partial",
        "traded_prices": [70_000],
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "untraded_price": 68_900,
        "untraded_qty": 12_000,
        "untraded_t_ms": now + 5_000,
        "untraded_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": now + 5_000},
            {"price": 70_000, "qty": 5_000, "t_ms": now + 5_000},
            {"price": 68_450, "qty": 100, "t_ms": now + 5_000},
        ],
        "all_price": 68_900,
        "all_qty": 12_000,
        "all_t_ms": now + 5_000,
        "all_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": now + 5_000},
            {"price": 70_000, "qty": 5_000, "t_ms": now + 5_000},
            {"price": 68_450, "qty": 100, "t_ms": now + 5_000},
        ],
    }


async def test_on_tick_same_t_ms_trade_without_seq_touches_ask_peak_state(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    now = _kst_ms(9, 10)
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": now, "price": 101, "qty": 5, "side": 1}],
    }))
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": now,
        "asks": [
            {"price": 101, "qty": 3},
            {"price": 102, "qty": 9},
            {"price": 103, "qty": 1},
            {"price": 104, "qty": 1},
        ],
        "bids": [
            {"price": 100, "qty": 1},
            {"price": 99, "qty": 1},
            {"price": 98, "qty": 1},
            {"price": 97, "qty": 1},
        ],
        "total_ask_qty": 14, "total_bid_qty": 4,
    }))

    assert stream.ask_peak_snapshot("005930") == {
        "date": "20260616",
        "coverage": "partial",
        "traded_prices": [101],
        "traded_price": 101,
        "traded_qty": 3,
        "traded_t_ms": now,
        "traded_peaks": [
            {"price": 101, "qty": 3, "t_ms": now},
        ],
        "untraded_price": 102,
        "untraded_qty": 9,
        "untraded_t_ms": now,
        "untraded_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
            {"price": 104, "qty": 1, "t_ms": now},
        ],
        "all_price": 102,
        "all_qty": 9,
        "all_t_ms": now,
        "all_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 3, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
        ],
    }


async def test_on_tick_same_t_ms_trade_without_seq_touches_bid_peak_state(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260619", phase_fn=lambda: "regular")
    stream.set_active_codes({"005930"})

    now = int(datetime(2026, 6, 19, 9, 1, tzinfo=KST).timestamp() * 1000)
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": now, "price": 70_000, "qty": 5, "side": 1}],
    }))
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": now,
        "asks": [{"price": 70_100 + i * 50, "qty": 100} for i in range(10)],
        "bids": [
            {"price": 70_000, "qty": 5_000},
            {"price": 68_900, "qty": 12_000},
            *[{"price": 68_800 - i * 50, "qty": 100} for i in range(8)],
        ],
        "total_ask_qty": 1_000, "total_bid_qty": 17_800,
    }))

    assert stream.bid_peak_snapshot("005930") == {
        "date": "20260619",
        "coverage": "partial",
        "traded_prices": [70_000],
        "traded_price": 70_000,
        "traded_qty": 5_000,
        "traded_t_ms": now,
        "traded_peaks": [
            {"price": 70_000, "qty": 5_000, "t_ms": now},
        ],
        "untraded_price": 68_900,
        "untraded_qty": 12_000,
        "untraded_t_ms": now,
        "untraded_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": now},
            {"price": 68_450, "qty": 100, "t_ms": now},
            {"price": 68_500, "qty": 100, "t_ms": now},
        ],
        "all_price": 68_900,
        "all_qty": 12_000,
        "all_t_ms": now,
        "all_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": now},
            {"price": 70_000, "qty": 5_000, "t_ms": now},
            {"price": 68_450, "qty": 100, "t_ms": now},
        ],
    }


async def test_on_tick_orderbook_populates_untraded_peak_arrays_without_trades(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    now = _kst_ms(9, 10)
    await stream.on_tick(_ask_peak_ob_tick(now))

    assert stream.ask_peak_snapshot("005930") == {
        "date": "20260616",
        "coverage": "partial",
        "traded_prices": [],
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "untraded_price": 102,
        "untraded_qty": 9,
        "untraded_t_ms": now,
        "untraded_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 3, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
        ],
        "all_price": 102,
        "all_qty": 9,
        "all_t_ms": now,
        "all_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 3, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
        ],
    }


async def test_on_tick_continuous_trade_reclassifies_earlier_wall_but_not_later_same_price_wall(
    tmp_path,
):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    now = _kst_ms(9, 10)
    await stream.on_tick(_ask_peak_ob_tick_with_front_qtys(now, ask_101=3, ask_102=9))
    await stream.on_tick(WsTick(code="005930", t_ms=now + 1_000, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": now + 1_000, "price": 101, "qty": 5, "side": 1}],
    }))
    await stream.on_tick(
        _ask_peak_ob_tick_with_front_qtys(now + 2_000, ask_101=8, ask_102=4)
    )

    assert stream.ask_peak_snapshot("005930") == {
        "date": "20260616",
        "coverage": "partial",
        "traded_prices": [101],
        "traded_price": 101,
        "traded_qty": 3,
        "traded_t_ms": now,
        "traded_peaks": [
            {"price": 101, "qty": 3, "t_ms": now},
        ],
        "untraded_price": 102,
        "untraded_qty": 9,
        "untraded_t_ms": now,
        # Same-price walls collapse to their best open peak (ADR-0084 event-based
        # model, commit 38fb9ff8): the later 102@4 collapses into 102@9 rather
        # than staying a separate untraded row, so rank-3 falls through to 103@1.
        "untraded_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 8, "t_ms": now + 2_000},
            {"price": 103, "qty": 1, "t_ms": now},
        ],
        "all_price": 102,
        "all_qty": 9,
        "all_t_ms": now,
        # all_peaks = closed_traded + open: the earlier 101@3 was touched by the
        # trade (closed_traded), so it ranks third here, not the collapsed 102@4.
        "all_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 8, "t_ms": now + 2_000},
            {"price": 101, "qty": 3, "t_ms": now},
        ],
    }


async def test_on_tick_does_not_create_ask_peak_for_inactive_code(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    stream.set_active_codes({"000660"})

    now = _kst_ms(9, 10)
    await stream.on_tick(_ask_peak_ob_tick(now))

    assert stream.ask_peak_snapshot("005930") is None


async def test_on_tick_ignores_malformed_ask_peak_levels(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    now = _kst_ms(9, 10)
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": now, "asks": [None], "bids": [],
        "total_ask_qty": 0, "total_bid_qty": 0,
    }))

    assert stream.ask_peak_snapshot("005930") is None


async def test_on_tick_ignores_auction_or_post_close_ask_peak_books(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    trade_t = _kst_ms(9, 10)
    await stream.on_tick(WsTick(code="005930", t_ms=trade_t, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": trade_t, "price": 101, "qty": 5, "side": 1}],
    }))

    collapsed_t = _kst_ms(9, 11)
    await stream.on_tick(WsTick(code="005930", t_ms=collapsed_t, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": collapsed_t,
        "asks": [
            {"price": 101, "qty": 30_000},
            {"price": 102, "qty": 20_000},
            {"price": 103, "qty": 10_000},
        ],
        "bids": [
            {"price": 100, "qty": 30_000},
            {"price": 99, "qty": 20_000},
            {"price": 98, "qty": 10_000},
        ],
        "total_ask_qty": 60_000,
        "total_bid_qty": 60_000,
    }))
    await stream.on_tick(_ask_peak_ob_tick(_kst_ms(15, 31)))

    assert stream.ask_peak_snapshot("005930") is None


async def test_on_tick_ignores_one_sided_collapsed_ask_peak_book(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    trade_t = _kst_ms(9, 10)
    await stream.on_tick(WsTick(code="005930", t_ms=trade_t, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": trade_t, "price": 101, "qty": 5, "side": 1}],
    }))

    collapsed_t = _kst_ms(9, 11)
    await stream.on_tick(WsTick(code="005930", t_ms=collapsed_t, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": collapsed_t,
        "asks": [
            {"price": 101, "qty": 30_000},
            {"price": 102, "qty": 20_000},
            {"price": 103, "qty": 10_000},
        ] + [{"price": 0, "qty": 0} for _ in range(7)],
        "bids": [{"price": 100 - i, "qty": 100} for i in range(10)],
        "total_ask_qty": 60_000,
        "total_bid_qty": 1_000,
    }))

    assert stream.ask_peak_snapshot("005930") is None


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

    monkeypatch.setattr(session_gate_mod, "ws_capture_window", gate)

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


async def test_seed_ask_peak_from_live_file_loads_full_day_peak_and_full_coverage(tmp_path):
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    live_root = tmp_path / "live"
    live_root.mkdir(parents=True, exist_ok=True)
    live_path = live_root / "20260616" / "005930.jsonl"
    live_path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {
            "t_ms": _kst_ms(9, 10),
            "kind": "ob",
            "payload": {
                "code": "005930",
                "t_ms": _kst_ms(9, 10),
                "asks": [
                    {"price": 10_100, "qty": 500},
                    {"price": 10_200, "qty": 900},
                    {"price": 10_300, "qty": 10},
                    {"price": 10_400, "qty": 700},
                ],
                "bids": [
                    {"price": 10_000, "qty": 500},
                    {"price": 9_900, "qty": 900},
                    {"price": 9_800, "qty": 10},
                    {"price": 9_700, "qty": 700},
                ],
                "total_ask_qty": 2_110,
                "total_bid_qty": 2_110,
            },
        },
        {
            "t_ms": _kst_ms(10, 0),
            "kind": "trade",
            "payload": {
                "trades": [{
                    "t_ms": _kst_ms(10, 0),
                    "price": 10_100,
                    "qty": 1,
                    "side": 1,
                    "side_source": "kis_ws",
                }],
            },
        },
    ]
    live_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")

    stream.seed_ask_peak_from_live_file(code="005930", date="20260616", live_root=live_root)

    assert stream.ask_peak_snapshot("005930") == {
        "date": "20260616",
        "coverage": "full",
        "traded_prices": [10_100],
        "traded_price": 10_100,
        "traded_qty": 500,
        "traded_t_ms": _kst_ms(9, 10),
        "traded_peaks": [
            {"price": 10_100, "qty": 500, "t_ms": _kst_ms(9, 10)},
        ],
        "untraded_price": 10_200,
        "untraded_qty": 900,
        "untraded_t_ms": _kst_ms(9, 10),
        "untraded_peaks": [
            {"price": 10_200, "qty": 900, "t_ms": _kst_ms(9, 10)},
            {"price": 10_400, "qty": 700, "t_ms": _kst_ms(9, 10)},
            {"price": 10_300, "qty": 10, "t_ms": _kst_ms(9, 10)},
        ],
        "all_price": 10_200,
        "all_qty": 900,
        "all_t_ms": _kst_ms(9, 10),
        "all_peaks": [
            {"price": 10_200, "qty": 900, "t_ms": _kst_ms(9, 10)},
            {"price": 10_400, "qty": 700, "t_ms": _kst_ms(9, 10)},
            {"price": 10_100, "qty": 500, "t_ms": _kst_ms(9, 10)},
        ],
    }


async def test_seed_bid_peak_from_live_file_loads_full_day_peak_and_full_coverage(tmp_path):
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260619", phase_fn=lambda: "regular")
    live_root = tmp_path / "live"
    live_root.mkdir(parents=True, exist_ok=True)
    live_path = live_root / "20260619" / "005930.jsonl"
    live_path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {
            "t_ms": int(datetime(2026, 6, 19, 9, 1, tzinfo=KST).timestamp() * 1000),
            "kind": "trade",
            "payload": {
                "trades": [{
                    "t_ms": int(datetime(2026, 6, 19, 9, 1, tzinfo=KST).timestamp() * 1000),
                    "price": 70_000,
                    "qty": 1,
                    "side": 1,
                    "side_source": "kis_ws",
                }],
            },
        },
        {
            "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000),
            "kind": "ob",
            "payload": _bid_peak_ob_tick(
                int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000)
            ).payload,
        },
    ]
    live_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")

    stream.seed_bid_peak_from_live_file(code="005930", date="20260619", live_root=live_root)

    assert stream.bid_peak_snapshot("005930") == {
        "date": "20260619",
        "coverage": "full",
        "traded_prices": [70_000],
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "untraded_price": 68_900,
        "untraded_qty": 12_000,
        "untraded_t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000),
        "untraded_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000)},
            {"price": 70_000, "qty": 5_000, "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000)},
            {"price": 68_450, "qty": 100, "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000)},
        ],
        "all_price": 68_900,
        "all_qty": 12_000,
        "all_t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000),
        "all_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000)},
            {"price": 70_000, "qty": 5_000, "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000)},
            {"price": 68_450, "qty": 100, "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000)},
        ],
    }


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

    monkeypatch.setattr(session_gate_mod, "ws_capture_window", gate)
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


async def test_drain_resets_day_state(tmp_path, monkeypatch):
    """spec 2026-06-08 §2.4: open→closed drain이 _last_flush_date/last_flush_ms를
    리셋 → 다음 개장 첫 flush가 R1 경고 미발화(#15) + 재개방 fill 라벨 폴백
    (ship 스킵분). drain을 run_flush_loop 전환으로 실제 트리거."""
    monkeypatch.setattr(stream_mod, "FLUSH_INTERVAL_S", 0.05)
    monkeypatch.setattr(stream_mod, "IDLE_INTERVAL_S", 0.02)
    buf = LiveBuffer(); writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    now = int(time.time() * 1000)
    calls = {"n": 0}
    def gate(now_ms):
        calls["n"] += 1
        if calls["n"] == 1:
            stream._ds.ingest(_ob_tick(now, tot_ask=111))
            return True            # ①open: flush로 _last_flush_date 래치
        return False               # ②+ closed: drain 후 리셋
    monkeypatch.setattr(session_gate_mod, "ws_capture_window", gate)
    task = asyncio.create_task(stream.run_flush_loop())
    try:
        for _ in range(80):
            await asyncio.sleep(0.02)
            if calls["n"] >= 3:
                break
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    # drain 후 일경계 상태가 리셋됐는가(production 리셋 없으면 '20260605' 잔류 → FAIL)
    assert stream._last_flush_date is None
    assert stream.last_flush_ms is None


async def test_flush_failure_preserves_window_sum(tmp_path, monkeypatch):
    """spec 2026-06-08 flush-durability §2.3: append가 OSError로 실패하면 그
    윈도의 흐름 합이 폐기되지 않고 다음 윈도로 롤된다(commit 미호출 → 보존).
    현재(리셋-인-flush)는 합이 0이 돼 영구 소실 → 이 테스트가 RED."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    fail = {"on": True}
    orig_append = writer.append

    async def flaky_append(date, code, snaps):
        if fail["on"]:
            raise OSError("disk full")
        return await orig_append(date, code, snaps)

    monkeypatch.setattr(writer, "append", flaky_append)

    now = (int(time.time() * 1000) // 10_000) * 10_000
    await stream.on_tick(_trade_tick(now + 100, qty=5, side=1))
    await stream.flush_once(now_ms=now + 10_000)        # append 실패 → 합 보존
    # 다음 윈도: append 정상화 → 보존된 5가 기록돼야(손실 0)
    fail["on"] = False
    await stream.flush_once(now_ms=now + 20_000)
    import json as _json
    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    fills = [d for d in map(_json.loads, jsonl.splitlines()) if d["kind"] == "fill"]
    assert any(f["payload"]["buy_qty"] == 5 for f in fills), \
        f"실패 윈도의 합 5가 다음 윈도로 롤되지 않음: {[f['payload'] for f in fills]}"


async def test_flush_preserves_tick_arriving_during_append(tmp_path, monkeypatch):
    """spec flush-durability §2.1(핵심): append await 창에 도착한 틱은
    commit이 '본 양'만 빼므로 보존된다. subtract가 아니라 zero-on-commit이면
    이 틱이 손실 → 이 인터리브 테스트가 그 회귀를 잡는다(순차 테스트는 못 잡음)."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    orig_append = writer.append

    async def slow_append(date, code, snaps):
        # append await 도중 새 틱 도착을 시뮬레이션(인터리브 강제).
        await stream.on_tick(_trade_tick(now + 5000, qty=3, side=1))
        return await orig_append(date, code, snaps)

    monkeypatch.setattr(writer, "append", slow_append)

    now = (int(time.time() * 1000) // 10_000) * 10_000
    await stream.on_tick(_trade_tick(now + 100, qty=5, side=1))   # 윈도1 buy=5
    await stream.flush_once(now_ms=now + 10_000)   # flush buy=5 → await 중 buy=8 → commit -5 → 3
    # 다음 윈도: 보존된 3이 기록(await 창 틱 손실 없음)
    import json as _json
    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    fills = [d for d in map(_json.loads, jsonl.splitlines()) if d["kind"] == "fill"]
    await stream.flush_once(now_ms=now + 20_000)
    jsonl2 = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    fills2 = [d for d in map(_json.loads, jsonl2.splitlines()) if d["kind"] == "fill"]
    assert fills2[-1]["payload"]["buy_qty"] == 3, \
        f"await 창에 도착한 틱(3) 손실됨: {[f['payload'] for f in fills2]}"


async def test_flush_per_code_isolation_on_append_failure(tmp_path, monkeypatch):
    """spec 2026-06-08 flush-durability §2.3: 한 코드(A)의 append OSError가 다른
    코드(B)의 윈도를 폐기하지 않는다 — old(whole-flush_once 중단)와의 headline
    차이. A 합은 보존(다음 윈도 롤), B는 기록+commit(buy→0). try를 루프 밖으로
    되돌리는 회귀를 잡는 가드."""
    import json as _json
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    orig_append = writer.append

    async def selective_append(date, code, snaps):
        if code == "005930":            # A만 실패
            raise OSError("disk full for A")
        return await orig_append(date, code, snaps)   # B 성공

    monkeypatch.setattr(writer, "append", selective_append)

    now = (int(time.time() * 1000) // 10_000) * 10_000
    await stream.on_tick(_trade_tick(now + 100, qty=5, side=1))            # A=005930 buy=5
    await stream.on_tick(WsTick(code="000660", t_ms=now + 100,
                                kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": now + 100, "price": 100, "qty": 7, "side": 1,
                    "side_source": "kis_ws"}]}))                            # B=000660 buy=7
    await stream.flush_once(now_ms=now + 10_000)   # A append 실패, B 성공

    # B는 기록됨(A 실패가 B를 안 버림)
    b_jsonl = tmp_path / "live" / "20260605" / "000660.jsonl"
    assert b_jsonl.exists()
    b_fills = [d for d in map(_json.loads, b_jsonl.read_text().splitlines())
               if d["kind"] == "fill"]
    assert b_fills[-1]["payload"]["buy_qty"] == 7
    # B는 commit돼 합이 0으로(다음 윈도 새 합), A는 보존(5)
    assert stream._ds._codes["000660"].buy_qty == 0
    assert stream._ds._codes["005930"].buy_qty == 5   # A 보존 → 다음 윈도 롤


def _broker_tick(t_ms, buy_top, sell_top):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.BROKER, payload={
        "code": "005930", "t_ms": t_ms, "buy_top": buy_top, "sell_top": sell_top,
    })


async def test_broker_names_canonical_on_display_but_raw_in_storage(tmp_path):
    """거래원명 정규화는 표시 경로에만 적용되고 저장은 원시 이름 그대로다.

    hoga.broker_names 의 원칙("API 경계에서만 적용, 저장 스키마 불변") 을 고정한다.
    표시 경로만 정규화되면 프론트가 파케이 조회 결과(이미 canonical)와 WS 스냅샷을
    한 화면에서 합쳐도 같은 거래원이 갈라지지 않는다.
    """
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    now = int(time.time() * 1000)
    # 실측 별칭(2026-07-21 018260): 스트림은 짧은/도시접미 형태를 쓴다.
    await stream.on_tick(_broker_tick(
        now,
        buy_top=[{"name": "미래에셋", "qty": 100}],
        sell_top=[{"name": "JP모간서울", "qty": 200}],
    ))

    series = await buf.get_series("005930")
    assert series["brokers"][0]["buy_top"][0]["name"] == "미래에셋증권"
    assert series["brokers"][0]["sell_top"][0]["name"] == "JP모간"
    assert series["brokers"][0]["buy_top"][0]["qty"] == 100   # 수량은 불변

    await stream.flush_once(now_ms=now + 10_000)
    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    assert "미래에셋증권" not in jsonl      # 저장: 원시 유지
    assert "미래에셋" in jsonl


async def test_broker_unknown_alias_passes_through_unchanged(tmp_path):
    """미지 별칭은 추측 병합하지 않고 그대로 통과한다(골드만/씨티그룹 교훈)."""
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    now = int(time.time() * 1000)
    await stream.on_tick(_broker_tick(
        now, buy_top=[{"name": "듣도보도못한증권", "qty": 1}], sell_top=[],
    ))

    series = await buf.get_series("005930")
    assert series["brokers"][0]["buy_top"][0]["name"] == "듣도보도못한증권"


async def test_broker_malformed_top_entries_do_not_crash_display(tmp_path):
    """이름 키가 없거나 형태가 어긋난 항목이 표시 경로를 죽이지 않는다."""
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True

    now = int(time.time() * 1000)
    await stream.on_tick(_broker_tick(
        now, buy_top=[{"qty": 5}, {"name": None, "qty": 1}, "junk"], sell_top=[],
    ))

    series = await buf.get_series("005930")
    assert len(series["brokers"][0]["buy_top"]) == 3
