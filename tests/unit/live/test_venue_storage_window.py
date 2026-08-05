"""venue 별 저장 창과 완결 판정 (ADR-0140 §3·§6, PR-G).

저장 게이트가 하나(정규장 09:00–15:30)에서 **venue 별**로 갈린다:

    KRX    09:00 ─ 15:30
    NXT·UN 08:00 ─ 20:00

그 결과 하루에 닫힘이 **두 번** 일어나고, 두 가지가 동시에 위험해진다:

1. 15:30 에 KRX 를 닫으면서 **아직 열려 있는 NXT 의 carry 를 지우는 것**
2. 15:35 에 NXT 를 **거짓 COMPLETE** 로 확정하는 것 — NXT 는 20:00 까지 거래한다
"""
import asyncio
import contextlib
import time
from datetime import datetime

import pytest

from hoga.live import session_gate as session_gate_mod, stream as stream_mod
from hoga.live.buffer import LiveBuffer
from hoga.live.promote import _collection_finished
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream
from hoga.live.ticks import WsTick
from hoga.live.writer import LiveWriter
from hoga.util.timeenc import KST

_ALL_OPEN = frozenset({"KRX", "NXT", "UN"})


def _ob(venue: str, t_ms: int, tot_ask: int) -> WsTick:
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.OB, venue=venue, payload={
        "code": "005930", "t_ms": t_ms, "asks": [], "bids": [],
        "total_ask_qty": tot_ask, "total_bid_qty": 0,
    })


# ── 부분 닫힘 — 이 PR 의 핵심 위험 ────────────────────────────────────────────

async def test_partial_close_drains_only_the_closed_venue(tmp_path, monkeypatch):
    """15:30 에 KRX 를 닫으면서 **NXT carry 를 지우면 안 된다**.

    예전 판은 닫힘이 하루 한 번이라 전체 reset 이면 됐다. 그대로 두면 아직 열려 있는
    NXT 의 `last_ob` 가 사라져 **조용한 종목이 다음 flush 에서 행을 못 만든다** —
    데이터가 틀리는 게 아니라 **없어진다**.
    """
    monkeypatch.setattr(stream_mod, "FLUSH_INTERVAL_S", 0.05)
    monkeypatch.setattr(stream_mod, "IDLE_INTERVAL_S", 0.02)
    stream = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(tmp_path / "live"),
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    now = int(time.time() * 1000)
    calls = {"n": 0}

    def windows(_ms):
        calls["n"] += 1
        if calls["n"] == 1:
            stream._ds.ingest(_ob("KRX", now, tot_ask=111))
            stream._ds.ingest(_ob("NXT", now, tot_ask=222))
            return _ALL_OPEN                    # ① 전 venue 개방
        return frozenset({"NXT", "UN"})         # ② KRX 만 닫힘(15:30)

    monkeypatch.setattr(session_gate_mod, "venue_capture_windows", windows)
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

    assert not [k for k in stream._ds._codes if k[1] == "KRX"]  # 닫힌 시장만 버려진다
    assert [k for k in stream._ds._codes if k[1] == "NXT"]      # 열린 시장 carry 는 산다
    # 전 venue 가 닫힌 게 아니므로 일경계 라벨은 유지된다 — 지우면 NXT 의 이후 fill
    # 윈도 라벨이 전부 어긋난다(`fill_t_ms` 가 now−FLUSH_INTERVAL 로 폴백).
    assert stream._last_flush_date == "20260605"


def test_downsampler_reset_scopes_to_one_venue():
    """`reset(venue)` 이 그 시장만 버린다 — 인자 없으면 전체(기존 계약 보존)."""
    from hoga.live.downsampler import TickDownsampler

    ds = TickDownsampler()
    ds.ingest(_ob("KRX", 1_000, tot_ask=100))
    ds.ingest(_ob("NXT", 1_000, tot_ask=900))

    ds.reset("KRX")
    assert [k[1] for k in ds._codes] == ["NXT"]
    ds.reset()
    assert not ds._codes


# ── venue 별 저장 창 ─────────────────────────────────────────────────────────

def _ms(h: int, m: int) -> int:
    return int(datetime(2026, 5, 27, h, m, tzinfo=KST).timestamp() * 1000)  # 화요일


@pytest.mark.parametrize(("hh", "mm", "expected"), [
    (8, 30, {"NXT", "UN"}),          # 장전 — NXT 만 (KRX 는 동시호가라 저장 안 함)
    (10, 0, {"KRX", "NXT", "UN"}),   # 정규장 — 셋 다
    (16, 0, {"NXT", "UN"}),          # 애프터마켓 — KRX 마감
    (21, 0, set()),                  # 연결 창 밖 — 전부 닫힘
])
def test_capture_window_opens_per_venue(hh, mm, expected, monkeypatch):
    monkeypatch.setattr(session_gate_mod, "is_trading_day_now", lambda _ms: True)
    assert session_gate_mod.venue_capture_windows(_ms(hh, mm)) == expected


def test_non_trading_day_closes_every_venue(monkeypatch):
    monkeypatch.setattr(session_gate_mod, "is_trading_day_now", lambda _ms: False)
    assert session_gate_mod.venue_capture_windows(_ms(10, 0)) == frozenset()


def test_krx_window_is_delegated_not_reimplemented(monkeypatch):
    """KRX 판정은 `ws_capture_window` 에 **위임**한다 — 조건을 다시 쓰지 않는다.

    `should_run_now` 만으로는 부족하다: 그건 `market_phase != "closed"` 일 뿐이라
    장전 동시호가에도 True 다. 기존 KRX 캡처와 byte-for-byte 동일하려면 판정이 한
    곳에서 나와야 한다.
    """
    monkeypatch.setattr(session_gate_mod, "is_trading_day_now", lambda _ms: True)
    seen: list[int] = []
    monkeypatch.setattr(session_gate_mod, "ws_capture_window",
                        lambda ms: (seen.append(ms), False)[1])
    assert "KRX" not in session_gate_mod.venue_capture_windows(_ms(10, 0))
    assert seen  # 실제로 위임했다


# ── venue 별 완결 판정 — 15:35 거짓 COMPLETE 차단 ────────────────────────────

def _at(h: int, m: int) -> datetime:
    return datetime(2026, 5, 27, h, m, tzinfo=KST)


def test_krx_finalizes_at_1535_unchanged():
    """KRX 는 기존 그대로 — 15:35 (마감 15:30 + 5분 settle)."""
    assert _collection_finished("20260527", venue="KRX", now=_at(15, 34)) is False
    assert _collection_finished("20260527", venue="KRX", now=_at(15, 35)) is True


@pytest.mark.parametrize("venue", ["NXT", "UN"])
def test_nxt_does_not_finalize_at_1535(venue):
    """⚠ 회귀 가드. 15:35 에 NXT 를 COMPLETE 로 찍으면 **4.5시간치를 빼놓고** 끝났다고
    말하는 것이다. 그 거짓말은 조용하다 — 행은 ✓ 로 보이고 완결 기반 소비자
    (보관함 배지·재캡처 게이트)가 전부 그걸 믿는다."""
    assert _collection_finished("20260527", venue=venue, now=_at(15, 35)) is False
    assert _collection_finished("20260527", venue=venue, now=_at(19, 59)) is False
    assert _collection_finished("20260527", venue=venue, now=_at(20, 5)) is True


def test_unknown_venue_falls_back_to_krx_timing():
    """모르는 venue 는 **기존 동작**(KRX 15:35)으로 떨어진다 — 더 이른 마감이 아니라."""
    assert _collection_finished("20260527", venue="???", now=_at(15, 35)) is True


def test_past_day_is_complete_for_every_venue():
    """지난 날은 시각과 무관하게 완결 — venue 축이 그 규칙을 안 바꾼다."""
    for venue in ("KRX", "NXT", "UN"):
        assert _collection_finished("20260526", venue=venue, now=_at(9, 0)) is True
