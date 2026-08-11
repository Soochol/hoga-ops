"""잠정 → 확정 수렴 — 멱등 마커가 '파일 존재' 라는 계약을 고정한다 (#1115)."""
from __future__ import annotations

import pytest

from hoga.live.investor_flow_confirm import confirm_days
from hoga.live.investor_flow_store import DailyConfirmedFile, InvestorFlowStore


def _fetch_ok():
    async def _f(mrkt_tp: str, date: str):
        return [{"inds_cd": "001_AL" if mrkt_tp == "0" else "101_AL", "d": date}]

    return _f


@pytest.mark.asyncio
async def test_writes_missing_days(tmp_path):
    n = await confirm_days(
        tmp_path,
        dates=["20260803", "20260804"],
        fetch_market_fn=_fetch_ok(),
        now_ms_fn=lambda: 111,
    )
    store = InvestorFlowStore(tmp_path)
    assert n == 2
    assert store.is_confirmed("20260803") and store.is_confirmed("20260804")
    day = store.load_confirmed("20260803")
    assert day is not None
    # 두 시장이 한 확정본에 합쳐진다
    assert {r["inds_cd"] for r in day.rows} == {"001_AL", "101_AL"}


@pytest.mark.asyncio
async def test_already_confirmed_day_is_skipped_without_fetch(tmp_path):
    """파일 존재가 곧 멱등 마커 — 이미 확정된 날은 벤더를 부르지도 않는다."""
    store = InvestorFlowStore(tmp_path)
    store.write_confirmed(
        DailyConfirmedFile(date="20260803", confirmed_at_ms=1, request={}, rows=[])
    )
    calls: list[str] = []

    async def _f(mrkt_tp: str, date: str):
        calls.append(date)
        return []

    n = await confirm_days(
        tmp_path, dates=["20260803"], fetch_market_fn=_f, now_ms_fn=lambda: 2
    )
    assert n == 0
    assert calls == []


@pytest.mark.asyncio
async def test_partial_market_failure_defers_the_whole_day(tmp_path):
    """반쪽 확정본을 쓰면 '파일 존재 = 확정' 계약이 거짓말이 된다 — 그날은 미룬다."""

    async def _half(mrkt_tp: str, _date: str):
        return None if mrkt_tp == "1" else [{"inds_cd": "001_AL"}]

    n = await confirm_days(
        tmp_path, dates=["20260803"], fetch_market_fn=_half, now_ms_fn=lambda: 1
    )
    assert n == 0
    assert InvestorFlowStore(tmp_path).is_confirmed("20260803") is False


@pytest.mark.asyncio
async def test_one_bad_day_does_not_block_the_others(tmp_path):
    """확정은 날짜별로 독립이다 — 못 채운 날은 파일이 없으니 다음 런이 자동 재대상."""

    async def _f(mrkt_tp: str, date: str):
        if date == "20260803" and mrkt_tp == "1":
            return None
        return [{"inds_cd": "x", "d": date}]

    n = await confirm_days(
        tmp_path,
        dates=["20260803", "20260804"],
        fetch_market_fn=_f,
        now_ms_fn=lambda: 1,
    )
    store = InvestorFlowStore(tmp_path)
    assert n == 1
    assert store.is_confirmed("20260803") is False
    assert store.is_confirmed("20260804") is True


def test_collector_is_dormant_without_credentials(tmp_path, monkeypatch):
    """무자격이면 수집기를 만들지 않는다 — 크래시가 아니라 미기동이 옳다(ADR-0134)."""
    from hoga.live import investor_flow_runtime

    monkeypatch.setattr(investor_flow_runtime, "_kiwoom_seam", lambda _d: None)
    assert investor_flow_runtime.make_collector(tmp_path) is None


def test_collector_is_wired_to_the_investor_flow_window_not_the_regular_session(
    tmp_path, monkeypatch
):
    """**막는 것**: 배선이 기본값으로 조용히 되돌아가는 것.

    `should_collect_fn` 의 기본값은 `ws_capture_window_async`(정규장 15:30)라, 이 주입을
    빠뜨려도 수집기는 멀쩡히 돌고 테스트도 초록이다 — 다만 종가 단일가 체결분을 매일
    놓친다. 그 회귀는 다음 거래일 15:30 이 지나야 드러나므로 여기서 못박는다.

    **못 보는 것**: 게이트 자체의 시각 판정(그건 `test_session_gate.py` 의 몫)과, 창이
    열려 있을 때 실제로 표본이 찍히는지(`test_investor_flow_collector.py`).
    """
    from hoga.live import investor_flow_runtime
    from hoga.live.session_gate import investor_flow_capture_window_async

    monkeypatch.setattr(
        investor_flow_runtime, "_kiwoom_seam", lambda _d: (object(), object())
    )
    monkeypatch.setattr(investor_flow_runtime, "make_kiwoom_fetch", lambda _s, _c: None)
    collector = investor_flow_runtime.make_collector(tmp_path)
    assert collector is not None
    assert collector._should_collect_fn is investor_flow_capture_window_async


@pytest.mark.asyncio
async def test_confirm_is_noop_without_credentials(tmp_path, monkeypatch):
    from hoga.live import investor_flow_runtime

    monkeypatch.setattr(investor_flow_runtime, "_kiwoom_seam", lambda _d: None)
    import datetime as dt

    assert await investor_flow_runtime.confirm_recent(tmp_path, now=dt.datetime(2026, 8, 5)) == 0
