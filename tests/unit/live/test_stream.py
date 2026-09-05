"""Unit tests for LiveStream orchestrator."""
import asyncio
import contextlib
import json
import threading
import time
from datetime import datetime, timedelta, timezone

import hoga.live.session_gate as session_gate_mod
import hoga.live.stream as stream_mod
from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream, build_today_peak_seed, today_peak_seed_path
from hoga.live.ticks import WsTick
from hoga.live.writer import LiveWriter

KST = timezone(timedelta(hours=9))


# 저장이 열린 venue 집합(ADR-0140 §3). 예전엔 `_gate_open = True` 불리언이었다 —
# 저장 창이 KRX 09:00–15:30 / NXT·UN 08:00–20:00 로 갈리면서 집합이 됐다.
_ALL_OPEN = frozenset({"KRX", "NXT", "UN"})


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
    stream._open_venues = _ALL_OPEN

    now = int(time.time() * 1000)   # 벽시계 — buffer eviction 컷오프 안쪽
    await stream.on_tick(_trade_tick(now, qty=5, side=1))
    series = await buf.get_series("005930")          # per-tick: 즉시 buffer에
    assert len(series["trades"]) == 1

    await stream.flush_once(now_ms=now + 10_000)     # 10초 경계 flush
    jsonl = (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").read_text()
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
    stream._open_venues = _ALL_OPEN

    now = int(time.time() * 1000)
    tick = _trade_tick(now, qty=5, side=1)
    tick.payload["prev_close"] = 96000
    await stream.on_tick(tick)

    series = await buf.get_series("005930")
    assert series["trades"][0]["prev_close"] == 96000   # 표시: 보존

    await stream.flush_once(now_ms=now + 10_000)
    jsonl = (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").read_text()
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
    stream._open_venues = _ALL_OPEN

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
    jsonl_path = tmp_path / "live" / "20260616" / "KRX" / "005930.jsonl"
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
    stream._open_venues = _ALL_OPEN

    t0 = _kst_ms(10, 0, 5)
    tick = WsTick(code="005930", t_ms=t0, kind=SnapshotKind.TRADE, venue="NXT", payload={
        "trades": [{"t_ms": t0, "price": 100, "qty": 5, "side": 1, "side_source": "kiwoom_ws"}],
    })
    await stream.on_tick(tick)
    await stream.flush_once(now_ms=_kst_ms(10, 1, 5))
    jsonl_path = tmp_path / "live" / "20260616" / "KRX" / "005930.jsonl"
    assert not jsonl_path.exists() or _candle_lines(jsonl_path.read_text()) == []


async def test_drain_seals_final_in_progress_candle(tmp_path):
    """게이트 닫힘 drain 이 **닫히는 시장의** 진행 중 마지막 봉을 봉인한다."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    stream._open_venues = _ALL_OPEN

    t0 = _kst_ms(15, 30, 1)   # 종가 근처 마지막 봉
    tick = WsTick(code="005930", t_ms=t0, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": t0, "price": 200, "qty": 7, "side": 1, "side_source": "kiwoom_ws"}],
    })
    await stream.on_tick(tick)
    jsonl_path = tmp_path / "live" / "20260616" / "KRX" / "005930.jsonl"

    # 일반 flush(같은 분)면 미봉인.
    await stream.flush_once(now_ms=t0 + 2_000)
    assert _candle_lines(jsonl_path.read_text()) == []

    # drain: 그 시장이 seal_candle_venues 에 들면 진행 중 봉도 봉인.
    await stream.flush_once(now_ms=t0 + 2_000, seal_candle_venues=frozenset({"KRX"}))
    candles = _candle_lines(jsonl_path.read_text())
    assert len(candles) == 1
    assert candles[0]["payload"]["close"] == 200


async def test_program_tick_routes_to_latch_and_display_buffer_not_storage(tmp_path):
    """PROGRAM 은 latch 와 표시 buffer 에 가지만 JSONL 저장에는 들어가지 않는다.

    **NXT 도 이제 둘 다 간다**(ADR-0140 §2 — `venue != "KRX"` 가드 삭제). 그래서 신고된
    "프리마켓 프로그램 빈 창"이 채워진다.

    ⚠ 그 대가로 latch 가 **(code, venue) 로 키잉돼야** 한다 — bare code 키잉이던 시절엔
    가드가 KRX 만 들여보내 안전했지만, 열린 지금은 세 시장이 같은 칸을 last-wins 로
    덮어쓴다. 값이 아니라 **시장이 섞이므로** 결과가 그럴듯해서 화면에서 안 드러난다.
    이 테스트가 그 키잉을 못박는다.
    """
    from hoga.live import program_trade_latch

    program_trade_latch.reset_for_tests()
    buf = LiveBuffer()
    display_q = buf.subscribe("005930")
    nxt_display_q = buf.subscribe("000660")
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._open_venues = _ALL_OPEN

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
    assert set(latched) == {("005930", "KRX"), ("000660", "NXT")}  # venue 별로 분리
    assert latched[("005930", "KRX")]["net_qty"] == 50
    assert latched[("000660", "NXT")]["net_qty"] == 1
    display_entry = await asyncio.wait_for(display_q.get(), timeout=1.0)
    assert display_entry == {
        **tick.payload,
        "kind": "program",
        "phase": "regular",
        "venue": "KRX",
    }
    nxt_entry = await asyncio.wait_for(nxt_display_q.get(), timeout=1.0)
    assert nxt_entry["venue"] == "NXT"  # 표시 fan-out 도 열렸다
    await stream.flush_once(now_ms=now + 10_000)
    assert not (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").exists()  # 저장 미진입
    program_trade_latch.reset_for_tests()


async def test_on_tick_ingest_gated_off_skips_storage_but_still_displays(tmp_path):
    """게이트 False면 표시(buffer)는 들어가고 저장(다운샘플러)은 비어야 한다
    (리뷰 C1 벡터 1 — 15:30 이후 잔여 틱의 저장 누적 차단)."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    assert stream._open_venues == frozenset()  # 기본값: 루프 첫 판정 전엔 ingest 안 함(R2)

    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=5, side=1))
    series = await buf.get_series("005930")          # 표시는 무게이트 — 들어간다
    assert len(series["trades"]) == 1

    await stream.flush_once(now_ms=now + 10_000)     # 다운샘플러 비어 있음
    jsonl_path = tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl"
    assert not jsonl_path.exists()                   # 저장 경로엔 아무것도 안 감


def _nxt_trade_tick(t_ms, qty, side):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.TRADE, venue="NXT", payload={
        "trades": [{"t_ms": t_ms, "price": 100, "qty": qty, "side": side,
                    "side_source": "kis_ws"}],
    })


async def test_on_tick_nxt_venue_is_stored_in_its_own_file(tmp_path):
    """NXT 틱은 표시에도 가고 **자기 venue 파일에 저장된다**(ADR-0140 §2·§3).

    여기 있던 `..._displays_but_is_never_stored` 는 PR-F 이후 **엉뚱한 이유로 통과**
    하고 있었다: 성역 가드는 이미 없어졌는데, PR-D 가 파일을 venue 별로 갈라 놔서
    "NXT 가 저장 안 됨"이 아니라 "NXT 가 **KRX 파일에** 없음"만 보고 있었다.
    그 제목은 거짓이었다 — 여기서 바로잡는다.
    """
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._open_venues = _ALL_OPEN
    now = int(time.time() * 1000)
    await stream.on_tick(_nxt_trade_tick(now, qty=5, side=1))

    series = await buf.get_series("005930")
    assert len(series["trades"]) == 1
    assert series["trades"][0]["venue"] == "NXT"

    await stream.flush_once(now_ms=now + 10_000)
    nxt = (tmp_path / "live" / "20260605" / "NXT" / "005930.jsonl").read_text()
    assert '"buy_qty": 5' in nxt
    # KRX 파일은 안 생긴다 — 두 시장이 서로 다른 파일로 간다.
    assert not (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").exists()


async def test_on_tick_krx_and_nxt_flows_stay_in_separate_files(tmp_path):
    """혼합 스트림: 두 시장의 흐름 집계가 **각자 파일로** 갈린다 — 합산되지 않는다."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._open_venues = _ALL_OPEN
    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=7, side=1))       # KRX 매수 7
    await stream.on_tick(_nxt_trade_tick(now, qty=99, side=1))  # NXT 매수 99
    await stream.flush_once(now_ms=now + 10_000)

    day = tmp_path / "live" / "20260605"
    krx = (day / "KRX" / "005930.jsonl").read_text()
    assert '"buy_qty": 7' in krx
    assert '"buy_qty": 99' in (day / "NXT" / "005930.jsonl").read_text()
    assert '"buy_qty": 106' not in krx  # 합산되면 여기서 잡힌다
    series = await buf.get_series("005930")
    assert {tr["venue"] for tr in series["trades"]} == {"KRX", "NXT"}


async def test_ingest_gate_is_per_venue(tmp_path):
    """저장 게이트가 venue 별이다 — KRX 가 닫혀도(15:30 이후) NXT 는 계속 저장된다."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._open_venues = frozenset({"NXT", "UN"})  # 15:30~20:00 구간
    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=7, side=1))       # KRX — 게이트 밖
    await stream.on_tick(_nxt_trade_tick(now, qty=99, side=1))  # NXT — 게이트 안
    await stream.flush_once(now_ms=now + 10_000)

    day = tmp_path / "live" / "20260605"
    assert '"buy_qty": 99' in (day / "NXT" / "005930.jsonl").read_text()
    assert not (day / "KRX" / "005930.jsonl").exists()  # KRX 는 안 쌓인다
    # 표시는 무게이트 — 둘 다 화면엔 나온다.
    series = await buf.get_series("005930")
    assert {tr["venue"] for tr in series["trades"]} == {"KRX", "NXT"}



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
    # 체결(09:10:00)과 호가(09:10:05)가 **같은 분** — ADR-0156 에서 터치다.
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": now, "price": 101, "qty": 5, "side": 1}],
    }))
    await stream.on_tick(_ask_peak_ob_tick(now + 5_000))

    assert stream.ask_peak_snapshot("005930", "KRX") == {
        "date": "20260616",
        "coverage": "partial",
        "traded_price": 101,
        "traded_qty": 3,
        "traded_t_ms": now + 5_000,
        "traded_peaks": [{"price": 101, "qty": 3, "t_ms": now + 5_000}],
        "traded_record_peaks": [{"price": 101, "qty": 3, "t_ms": now + 5_000}],
        "traded_bar_peaks": [{"price": 101, "qty": 3, "t_ms": now + 5_000}],
        "all_price": 102,
        "all_qty": 9,
        "all_t_ms": now + 5_000,
        "all_peaks": [
            {"price": 102, "qty": 9, "t_ms": now + 5_000},
            {"price": 101, "qty": 3, "t_ms": now + 5_000},
            {"price": 103, "qty": 1, "t_ms": now + 5_000},
        ],
        # 당일 고가 101 위의 벽만 미도달이다(101 벽은 도달로 제외).
        "unreached_price": 102,
        "unreached_qty": 9,
        "unreached_t_ms": now + 5_000,
        "unreached_peaks": [
            {"price": 102, "qty": 9, "t_ms": now + 5_000},
            {"price": 103, "qty": 1, "t_ms": now + 5_000},
            {"price": 104, "qty": 1, "t_ms": now + 5_000},
        ],
        "day_extreme": 101,
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

    assert stream.bid_peak_snapshot("005930", "KRX") == {
        "date": "20260619",
        "coverage": "partial",
        "traded_price": 70_000,
        "traded_qty": 5_000,
        "traded_t_ms": now + 5_000,
        "traded_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": now + 5_000}],
        "traded_record_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": now + 5_000}],
        "traded_bar_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": now + 5_000}],
        "all_price": 68_900,
        "all_qty": 12_000,
        "all_t_ms": now + 5_000,
        "all_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": now + 5_000},
            {"price": 70_000, "qty": 5_000, "t_ms": now + 5_000},
            {"price": 68_450, "qty": 100, "t_ms": now + 5_000},
        ],
        # 당일 저가 70,000 아래의 벽만 미도달이다(70,000 매수벽은 도달로 제외).
        "unreached_price": 68_900,
        "unreached_qty": 12_000,
        "unreached_t_ms": now + 5_000,
        "unreached_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": now + 5_000},
            {"price": 68_450, "qty": 100, "t_ms": now + 5_000},
            {"price": 68_500, "qty": 100, "t_ms": now + 5_000},
        ],
        "day_extreme": 70_000,
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

    assert stream.ask_peak_snapshot("005930", "KRX") == {
        "date": "20260616",
        "coverage": "partial",
        "traded_price": 101,
        "traded_qty": 3,
        "traded_t_ms": now,
        "traded_peaks": [
            {"price": 101, "qty": 3, "t_ms": now},
        ],
        "traded_record_peaks": [{"price": 101, "qty": 3, "t_ms": now}],
        "traded_bar_peaks": [{"price": 101, "qty": 3, "t_ms": now}],
        "all_price": 102,
        "all_qty": 9,
        "all_t_ms": now,
        "all_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 3, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
        ],
        "unreached_price": 102,
        "unreached_qty": 9,
        "unreached_t_ms": now,
        "unreached_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
            {"price": 104, "qty": 1, "t_ms": now},
        ],
        "day_extreme": 101,
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

    assert stream.bid_peak_snapshot("005930", "KRX") == {
        "date": "20260619",
        "coverage": "partial",
        "traded_price": 70_000,
        "traded_qty": 5_000,
        "traded_t_ms": now,
        "traded_peaks": [
            {"price": 70_000, "qty": 5_000, "t_ms": now},
        ],
        "traded_record_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": now}],
        "traded_bar_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": now}],
        "all_price": 68_900,
        "all_qty": 12_000,
        "all_t_ms": now,
        "all_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": now},
            {"price": 70_000, "qty": 5_000, "t_ms": now},
            {"price": 68_450, "qty": 100, "t_ms": now},
        ],
        "unreached_price": 68_900,
        "unreached_qty": 12_000,
        "unreached_t_ms": now,
        "unreached_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": now},
            {"price": 68_450, "qty": 100, "t_ms": now},
            {"price": 68_500, "qty": 100, "t_ms": now},
        ],
        "day_extreme": 70_000,
    }


async def test_on_tick_orderbook_populates_all_peak_arrays_without_trades(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    now = _kst_ms(9, 10)
    await stream.on_tick(_ask_peak_ob_tick(now))

    assert stream.ask_peak_snapshot("005930", "KRX") == {
        "date": "20260616",
        "coverage": "partial",
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "traded_record_peaks": [],
        "traded_bar_peaks": [],
        "all_price": 102,
        "all_qty": 9,
        "all_t_ms": now,
        "all_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 3, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
        ],
        # 체결 0건 — 극값이 없으니 모든 벽이 미도달이다.
        "unreached_price": 102,
        "unreached_qty": 9,
        "unreached_t_ms": now,
        "unreached_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 3, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
        ],
        "day_extreme": None,
    }


async def test_on_tick_continuous_trade_touches_every_same_minute_wall_at_or_below_it(
    tmp_path,
):
    """같은 분 안이라면 체결 **전후 모두** 그 가격 이하 벽을 터치한다(ADR-0156).

    ADR-0084 에서는 체결 이후의 101@8 만 미터치로 남았다 — 순서가 판정에서 빠지며
    두 벽 모두 체결이 됐다. 102 는 체결가(101) 위라 여전히 미터치다.
    """
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

    assert stream.ask_peak_snapshot("005930", "KRX") == {
        "date": "20260616",
        "coverage": "partial",
        "traded_price": 101,
        "traded_qty": 8,
        "traded_t_ms": now + 2_000,
        "traded_peaks": [
            {"price": 101, "qty": 8, "t_ms": now + 2_000},
            {"price": 101, "qty": 3, "t_ms": now},
        ],
        # `all_*` 은 가격당 최댓값으로 접힌다(터치 무관) — 102 는 9, 101 은 8.
        # 같은 가격이 두 번 기록을 세운다 — 기록 시퀀스는 **가격별 dedup 을 하지
        # 않는다**(과거일 `_peak_record_sequence` 와 같은 규약).
        "traded_record_peaks": [
            {"price": 101, "qty": 3, "t_ms": now},
            {"price": 101, "qty": 8, "t_ms": now + 2_000},
        ],
        # 봉별은 그 분의 **최대 하나**다 — 기록 시퀀스가 둘을 남기는 것과
        # 정확히 갈리는 자리(같은 분 안의 101@3 → 101@8).
        "traded_bar_peaks": [{"price": 101, "qty": 8, "t_ms": now + 2_000}],
        "all_price": 102,
        "all_qty": 9,
        "all_t_ms": now,
        "all_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 101, "qty": 8, "t_ms": now + 2_000},
            {"price": 103, "qty": 1, "t_ms": now},
        ],
        # 극값 101 이 101 벽을 소급 제거 — 이후 101@8 도 삽입 시점에 이미 도달이라 안 담긴다.
        "unreached_price": 102,
        "unreached_qty": 9,
        "unreached_t_ms": now,
        "unreached_peaks": [
            {"price": 102, "qty": 9, "t_ms": now},
            {"price": 103, "qty": 1, "t_ms": now},
            {"price": 104, "qty": 1, "t_ms": now},
        ],
        "day_extreme": 101,
    }


async def test_on_tick_does_not_create_ask_peak_for_inactive_code(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    stream.set_active_codes({"000660"})

    now = _kst_ms(9, 10)
    await stream.on_tick(_ask_peak_ob_tick(now))

    assert stream.ask_peak_snapshot("005930", "KRX") is None


async def test_on_tick_ignores_malformed_ask_peak_levels(tmp_path):
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")

    now = _kst_ms(9, 10)
    await stream.on_tick(WsTick(code="005930", t_ms=now, kind=SnapshotKind.OB, payload={
        "code": "005930", "t_ms": now, "asks": [None], "bids": [],
        "total_ask_qty": 0, "total_bid_qty": 0,
    }))

    assert stream.ask_peak_snapshot("005930", "KRX") is None


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

    assert stream.ask_peak_snapshot("005930", "KRX") is None


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

    assert stream.ask_peak_snapshot("005930", "KRX") is None


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

    # 새 이음매는 venue 집합이다(ADR-0140 §3). bool 스텁만 두면 KRX 만 스텁되고
    # NXT·UN 은 실제 달력을 타 테스트가 의도한 상태가 안 나온다.
    monkeypatch.setattr(session_gate_mod, "venue_capture_windows",
                        lambda ms: _ALL_OPEN if gate(ms) else frozenset())

    jsonl_path = tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl"
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
    stream._open_venues = _ALL_OPEN
    stream.set_active_codes({"000660"})              # 005930은 Live Set 밖

    now = int(time.time() * 1000)
    await stream.on_tick(_trade_tick(now, qty=5, side=1))   # 005930 잔여 프레임
    series = await buf.get_series("005930")
    assert series["trades"] == []                    # 표시 ring 재생성 금지
    await stream.flush_once(now_ms=now + 10_000)     # 저장 경로에도 부활 없음
    assert not (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").exists()


async def test_today_peak_seed_loads_full_day_ask_peak_and_full_coverage(tmp_path):
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    live_root = tmp_path / "live"
    live_root.mkdir(parents=True, exist_ok=True)
    # 실디스크 레이아웃과 **같은** venue 세그먼트(ADR-0140 §3). 종전 시더는 이걸 빼고
    # 읽어 실서버에서 파일을 영영 못 찾았는데, 이 픽스처가 낡은 경로에 있어 초록이었다.
    live_path = live_root / "20260616" / "KRX" / "005930.jsonl"
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

    seed = build_today_peak_seed(code="005930", venue="KRX", date="20260616", live_root=live_root)
    assert seed is not None
    assert stream.install_today_peak_seed(code="005930", venue="KRX", seed=seed) == "installed"

    # 호가 09:10 · 체결 10:00 — **다른 분**이라 체결 계열은 비어 있다(ADR-0156).
    assert stream.ask_peak_snapshot("005930", "KRX") == {
        "date": "20260616",
        "coverage": "full",
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "traded_record_peaks": [],
        "traded_bar_peaks": [],
        "all_price": 10_200,
        "all_qty": 900,
        "all_t_ms": _kst_ms(9, 10),
        "all_peaks": [
            {"price": 10_200, "qty": 900, "t_ms": _kst_ms(9, 10)},
            {"price": 10_400, "qty": 700, "t_ms": _kst_ms(9, 10)},
            {"price": 10_100, "qty": 500, "t_ms": _kst_ms(9, 10)},
        ],
        # 재생 극값 10,100 이 10,100 벽을 제거 — 그 위 세 벽만 미도달이다.
        "unreached_price": 10_200,
        "unreached_qty": 900,
        "unreached_t_ms": _kst_ms(9, 10),
        "unreached_peaks": [
            {"price": 10_200, "qty": 900, "t_ms": _kst_ms(9, 10)},
            {"price": 10_400, "qty": 700, "t_ms": _kst_ms(9, 10)},
            {"price": 10_300, "qty": 10, "t_ms": _kst_ms(9, 10)},
        ],
        "day_extreme": 10_100,
    }


async def test_today_peak_seed_loads_full_day_bid_peak_and_full_coverage(tmp_path):
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260619", phase_fn=lambda: "regular")
    live_root = tmp_path / "live"
    live_root.mkdir(parents=True, exist_ok=True)
    live_path = live_root / "20260619" / "KRX" / "005930.jsonl"
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

    seed = build_today_peak_seed(code="005930", venue="KRX", date="20260619", live_root=live_root)
    assert seed is not None
    assert stream.install_today_peak_seed(code="005930", venue="KRX", seed=seed) == "installed"

    # 체결 09:01:00 · 호가 09:01:05 — **같은 분**이라 70,000 매수벽이 체결이다.
    _bid_ob_ms = int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000)
    assert stream.bid_peak_snapshot("005930", "KRX") == {
        "date": "20260619",
        "coverage": "full",
        "traded_price": 70_000,
        "traded_qty": 5_000,
        "traded_t_ms": _bid_ob_ms,
        "traded_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": _bid_ob_ms}],
        "traded_record_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": _bid_ob_ms}],
        "traded_bar_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": _bid_ob_ms}],
        "all_price": 68_900,
        "all_qty": 12_000,
        "all_t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000),
        "all_peaks": [
            {
                "price": 68_900,
                "qty": 12_000,
                "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000),
            },
            {
                "price": 70_000,
                "qty": 5_000,
                "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000),
            },
            {
                "price": 68_450,
                "qty": 100,
                "t_ms": int(datetime(2026, 6, 19, 9, 1, 5, tzinfo=KST).timestamp() * 1000),
            },
        ],
        # 재생 저가 70,000 아래의 벽만 미도달(70,000 매수벽은 도달로 제외).
        "unreached_price": 68_900,
        "unreached_qty": 12_000,
        "unreached_t_ms": _bid_ob_ms,
        "unreached_peaks": [
            {"price": 68_900, "qty": 12_000, "t_ms": _bid_ob_ms},
            {"price": 68_450, "qty": 100, "t_ms": _bid_ob_ms},
            {"price": 68_500, "qty": 100, "t_ms": _bid_ob_ms},
        ],
        "day_extreme": 70_000,
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
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._open_venues = _ALL_OPEN

    base = (int(time.time() * 1000) // 10_000) * 10_000
    await stream.flush_once(now_ms=base)              # 빈 flush — 윈도 시작 래치
    await stream.on_tick(_trade_tick(base + 1_000, qty=5, side=1))
    await stream.flush_once(now_ms=base + 10_000)     # 윈도 [base, base+10s) 마감

    jsonl = (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").read_text()
    fills = [d for d in map(json.loads, jsonl.splitlines()) if d["kind"] == "fill"]
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
    monkeypatch.setattr(stream_mod, "IDLE_INTERVAL_S", 0.01)
    seen: list[bool] = []

    def gate(now_ms):
        seen.append(threading.current_thread() is threading.main_thread())
        return False

    # 새 이음매는 venue 집합이다(ADR-0140 §3). bool 스텁만 두면 KRX 만 스텁되고
    # NXT·UN 은 실제 달력을 타 테스트가 의도한 상태가 안 나온다.
    monkeypatch.setattr(session_gate_mod, "venue_capture_windows",
                        lambda ms: _ALL_OPEN if gate(ms) else frozenset())
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
    stream._open_venues = _ALL_OPEN
    now = int(time.time() * 1000)
    await stream.on_tick(_ob_tick(now, tot_ask=111))     # 상태형 carry 스테이징
    await stream.flush_once(now_ms=now)                  # D일: ob 기록 + carry 보존
    assert (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").exists()
    date["v"] = "20260606"                               # 미관측 일경계 시뮬레이션
    await stream.flush_once(now_ms=now + 1_000)          # 백스톱: 기록 전 reset
    assert not (tmp_path / "live" / "20260606" / "KRX" / "005930.jsonl").exists()


async def test_drain_resets_day_state(tmp_path, monkeypatch):
    """spec 2026-06-08 §2.4: open→closed drain이 _last_flush_date/last_flush_ms를
    리셋 → 다음 개장 첫 flush가 R1 경고 미발화(#15) + 재개방 fill 라벨 폴백
    (ship 스킵분). drain을 run_flush_loop 전환으로 실제 트리거."""
    monkeypatch.setattr(stream_mod, "FLUSH_INTERVAL_S", 0.05)
    monkeypatch.setattr(stream_mod, "IDLE_INTERVAL_S", 0.02)
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
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
    # 새 이음매는 venue 집합이다(ADR-0140 §3). bool 스텁만 두면 KRX 만 스텁되고
    # NXT·UN 은 실제 달력을 타 테스트가 의도한 상태가 안 나온다.
    monkeypatch.setattr(session_gate_mod, "venue_capture_windows",
                        lambda ms: _ALL_OPEN if gate(ms) else frozenset())
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
    stream._open_venues = _ALL_OPEN

    fail = {"on": True}
    orig_append = writer.append

    async def flaky_append(date, code, venue, snaps):
        if fail["on"]:
            raise OSError("disk full")
        return await orig_append(date, code, venue, snaps)

    monkeypatch.setattr(writer, "append", flaky_append)

    now = (int(time.time() * 1000) // 10_000) * 10_000
    await stream.on_tick(_trade_tick(now + 100, qty=5, side=1))
    await stream.flush_once(now_ms=now + 10_000)        # append 실패 → 합 보존
    # 다음 윈도: append 정상화 → 보존된 5가 기록돼야(손실 0)
    fail["on"] = False
    await stream.flush_once(now_ms=now + 20_000)
    jsonl = (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").read_text()
    fills = [d for d in map(json.loads, jsonl.splitlines()) if d["kind"] == "fill"]
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
    stream._open_venues = _ALL_OPEN

    orig_append = writer.append
    # 벽시계 파생 now 금지(보조 방어선). 상수라 분 위상이 고정된다 — 아래 주입
    # 가드가 이미 위상 의존을 없애지만, 상수를 함께 둬 재현을 결정적으로 만든다.
    now = 1_780_617_600_000
    injected = False

    async def slow_append(date, code, venue, snaps):
        # append await 도중 새 틱 도착을 시뮬레이션(인터리브 강제).
        #
        # 주입 가드가 flake의 1차 방어선이다. flush_once는 append를 두 벌 부른다 —
        # 다운샘플러 flush와 캔들 flush. now가 분의 끝자락(≈마지막 10초)에 걸리면
        # 봉이 봉인돼 두 번째 append가 살아나고, 가드가 없으면 틱이 2회 주입돼
        # 다음 윈도가 3이 아닌 6이 된다(실측: 벽시계 초 50~59 구간에서 결정적 실패).
        # 조건 ① kind=FILL: 캔들 append의 snaps에는 FILL이 없어 걸러진다.
        # 조건 ② injected: 검증 대상은 "await 창에 도착한 틱 1개의 보존"이므로
        #   주입 총량을 append 호출 횟수에서 완전히 분리한다.
        nonlocal injected
        if not injected and any(snapshot.kind == SnapshotKind.FILL for snapshot in snaps):
            injected = True
            await stream.on_tick(_trade_tick(now + 5_000, qty=3, side=1))
        return await orig_append(date, code, venue, snaps)

    monkeypatch.setattr(writer, "append", slow_append)

    await stream.on_tick(_trade_tick(now + 100, qty=5, side=1))   # 윈도1 buy=5
    await stream.flush_once(now_ms=now + 10_000)   # flush buy=5 → await 중 buy=8 → commit -5 → 3
    # 다음 윈도: 보존된 3이 기록(await 창 틱 손실 없음)
    jsonl = (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").read_text()
    fills = [d for d in map(json.loads, jsonl.splitlines()) if d["kind"] == "fill"]
    await stream.flush_once(now_ms=now + 20_000)
    jsonl2 = (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").read_text()
    fills2 = [d for d in map(json.loads, jsonl2.splitlines()) if d["kind"] == "fill"]
    second_flush_fills = fills2[len(fills):]
    assert len(second_flush_fills) == 1
    assert second_flush_fills[0]["payload"]["buy_qty"] == 3, \
        f"await 창에 도착한 틱(3) 손실됨: {[f['payload'] for f in fills2]}"


async def test_flush_per_code_isolation_on_append_failure(tmp_path, monkeypatch):
    """spec 2026-06-08 flush-durability §2.3: 한 코드(A)의 append OSError가 다른
    코드(B)의 윈도를 폐기하지 않는다 — old(whole-flush_once 중단)와의 headline
    차이. A 합은 보존(다음 윈도 롤), B는 기록+commit(buy→0). try를 루프 밖으로
    되돌리는 회귀를 잡는 가드."""
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._open_venues = _ALL_OPEN

    orig_append = writer.append

    async def selective_append(date, code, venue, snaps):
        if code == "005930":            # A만 실패
            raise OSError("disk full for A")
        return await orig_append(date, code, venue, snaps)   # B 성공

    monkeypatch.setattr(writer, "append", selective_append)

    now = (int(time.time() * 1000) // 10_000) * 10_000
    await stream.on_tick(_trade_tick(now + 100, qty=5, side=1))            # A=005930 buy=5
    await stream.on_tick(WsTick(code="000660", t_ms=now + 100,
                                kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": now + 100, "price": 100, "qty": 7, "side": 1,
                    "side_source": "kis_ws"}]}))                            # B=000660 buy=7
    await stream.flush_once(now_ms=now + 10_000)   # A append 실패, B 성공

    # B는 기록됨(A 실패가 B를 안 버림)
    b_jsonl = tmp_path / "live" / "20260605" / "KRX" / "000660.jsonl"
    assert b_jsonl.exists()
    b_fills = [d for d in map(json.loads, b_jsonl.read_text().splitlines())
               if d["kind"] == "fill"]
    assert b_fills[-1]["payload"]["buy_qty"] == 7
    # B는 commit돼 합이 0으로(다음 윈도 새 합), A는 보존(5)
    assert stream._ds._codes[("000660", "KRX")].buy_qty == 0
    assert stream._ds._codes[("005930", "KRX")].buy_qty == 5   # A 보존 → 다음 윈도 롤


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
    stream._open_venues = _ALL_OPEN

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
    jsonl = (tmp_path / "live" / "20260605" / "KRX" / "005930.jsonl").read_text()
    assert "미래에셋증권" not in jsonl      # 저장: 원시 유지
    assert "미래에셋" in jsonl


async def test_broker_unknown_alias_passes_through_unchanged(tmp_path):
    """미지 별칭은 추측 병합하지 않고 그대로 통과한다(골드만/씨티그룹 교훈)."""
    buf = LiveBuffer()
    stream = LiveStream(buffer=buf, writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._open_venues = _ALL_OPEN

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
    stream._open_venues = _ALL_OPEN

    now = int(time.time() * 1000)
    await stream.on_tick(_broker_tick(
        now, buy_top=[{"qty": 5}, {"name": None, "qty": 1}, "junk"], sell_top=[],
    ))

    series = await buf.get_series("005930")
    assert len(series["brokers"][0]["buy_top"]) == 3


def _ob_row(t_ms: int, price: int, qty: int) -> dict:
    """연속호가 판정을 통과하는 최소 ob 행(10단은 불필요 — 4단이면 족하다)."""
    return {
        "t_ms": t_ms,
        "kind": "ob",
        "payload": {
            "code": "005930",
            "t_ms": t_ms,
            "asks": [
                {"price": price, "qty": qty},
                {"price": price + 100, "qty": 10},
                {"price": price + 200, "qty": 10},
                {"price": price + 300, "qty": 10},
            ],
            "bids": [
                {"price": price - 100, "qty": 10},
                {"price": price - 200, "qty": 10},
                {"price": price - 300, "qty": 10},
                {"price": price - 400, "qty": 10},
            ],
            "total_ask_qty": qty + 30,
            "total_bid_qty": 40,
        },
    }


def _write_rows(root, date: str, venue: str, rows: list[dict]) -> None:
    path = today_peak_seed_path(live_root=root, date=date, venue=venue, code="005930")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")


async def test_today_peak_seed_lands_in_the_requested_venue_only(tmp_path):
    """요청한 venue 슬롯에만 들어간다 — 옆 venue 는 비어 있어야 한다.

    **막는 것**: 설치 슬롯의 venue 가 어긋나는 것(예: `(code, "KRX")` 로 못박기).
    `install_today_peak_seed` 의 키를 바꾸면 빨개진다 — KRX 가 비어 있다는 단언이 그 절반이다.

    **못 보는 것**: `WsTick.venue` 전파. 종전 시더의 버그가 그것이었지만(틱에 venue 를 안
    실어 기본값 "KRX" 로 떨어졌다), 지금 구조에서는 **재현 자체가 불가능**하다 — 재생은
    분리된 상태를 **호출자가 지정**하고(`lambda: ask`) ingest 는 `tick.venue` 를 읽지
    않기 때문이다. 그래서 이 테스트는 그 버그의 red-check 이 아니다(실제로 `venue=venue`
    를 지워도 초록이다). 그 버그를 막는 것은 테스트가 아니라 **구조**다.
    """
    stream = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    live_root = tmp_path / "live"
    _write_rows(live_root, "20260616", "NXT", [_ob_row(_kst_ms(9, 10), 10_200, 900)])

    seed = build_today_peak_seed(code="005930", venue="NXT", date="20260616", live_root=live_root)
    assert seed is not None
    stream.install_today_peak_seed(code="005930", venue="NXT", seed=seed)

    nxt = stream.ask_peak_snapshot("005930", "NXT")
    assert nxt is not None
    assert nxt["all_price"] == 10_200
    assert stream.ask_peak_snapshot("005930", "KRX") is None


async def test_today_peak_seed_requires_the_venue_path_segment(tmp_path):
    """낡은 경로(`{date}/{code}.jsonl`)에 있는 파일은 못 찾는다 — 실레이아웃만 읽는다."""
    live_root = tmp_path / "live"
    stale = live_root / "20260616" / "005930.jsonl"
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text(json.dumps(_ob_row(_kst_ms(9, 10), 10_200, 900)) + "\n")

    assert build_today_peak_seed(
        code="005930", venue="KRX", date="20260616", live_root=live_root,
    ) is None


async def test_today_peak_seed_merges_into_a_live_state_instead_of_skipping(tmp_path):
    """장중 재기동 복구 — 이미 살아 있는 상태에 재생본을 **흡수**한다.

    이 결함의 더 나쁜 절반이 여기다: 재기동 후 래칫이 재기동 시점부터만 쌓여 조용히
    과소평가된다. 그 경우 시딩이 도착할 때 상태가 이미 **있으므로**, 스킵하면 정작 고쳐야
    할 케이스를 비켜간다. 재생본의 더 큰 벽(900)이 살아 있는 작은 벽(120)을 이겨야 한다.
    """
    stream = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    # 재기동 후 라이브로 들어온 작은 벽.
    stream._ingest_ask_peak(WsTick(
        code="005930", t_ms=_kst_ms(14, 0), kind=SnapshotKind.OB,
        payload=_ob_row(_kst_ms(14, 0), 10_500, 120)["payload"], venue="KRX",
    ))
    before = stream.ask_peak_snapshot("005930", "KRX")
    assert before is not None and before["all_qty"] == 120

    live_root = tmp_path / "live"
    _write_rows(live_root, "20260616", "KRX", [_ob_row(_kst_ms(9, 10), 10_200, 900)])
    seed = build_today_peak_seed(code="005930", venue="KRX", date="20260616", live_root=live_root)
    assert seed is not None

    assert stream.install_today_peak_seed(code="005930", venue="KRX", seed=seed) == "merged"

    after = stream.ask_peak_snapshot("005930", "KRX")
    assert after is not None
    assert after["all_qty"] == 900                       # 재생분이 이겼다
    assert after["coverage"] == "full"
    # 라이브분도 살아 있다 — 흡수지 교체가 아니다(나머지 자리는 채움 단의 10들이다).
    assert {900, 120} <= {p["qty"] for p in after["all_peaks"]}


async def test_today_peak_seed_is_idempotent(tmp_path):
    """같은 재생본을 두 번 흡수해도 답이 같다 — 락 경합·재시도에 안전하다."""
    stream = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260616", phase_fn=lambda: "regular")
    live_root = tmp_path / "live"
    _write_rows(live_root, "20260616", "KRX", [_ob_row(_kst_ms(9, 10), 10_200, 900)])
    seed = build_today_peak_seed(code="005930", venue="KRX", date="20260616", live_root=live_root)
    assert seed is not None

    stream.install_today_peak_seed(code="005930", venue="KRX", seed=seed)
    once = stream.ask_peak_snapshot("005930", "KRX")
    stream.install_today_peak_seed(code="005930", venue="KRX", seed=seed)

    assert stream.ask_peak_snapshot("005930", "KRX") == once
