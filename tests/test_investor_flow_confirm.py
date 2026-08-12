"""잠정 → 확정 수렴 — 멱등 마커가 두 단계라는 계약을 고정한다 (#1115).

파일 **존재**는 표시상 확정이고, 배치가 "다시 물 것인가" 를 판정하는 술어는
`is_final()`(확정 스탬프의 KST 날짜 > 대상일)이다.

**막는 것**: 당일에 쓴 확정본이 최종으로 굳는 것 — 그러면 벤더가 그 뒤 고친 값과
영구히 어긋난다(2026-08-12 실측 기관 13~32%).
**못 보는 것**: 벤더가 실제로 D+1 에 안정되는가(그건 실측의 몫이고, 이 테스트는
"D+1 에 한 번 더 묻는다" 는 배선만 본다) · 스케줄러가 이 함수를 언제 부르는가.
"""
from __future__ import annotations

import datetime as dt

import pytest

from hoga.live.investor_flow_confirm import confirm_days, is_final
from hoga.live.investor_flow_store import DailyConfirmedFile, InvestorFlowStore
from hoga.util.timeenc import KST


def _kst_ms(y: int, m: int, d: int, hh: int = 17, mm: int = 1) -> int:
    return int(dt.datetime(y, m, d, hh, mm, tzinfo=KST).timestamp() * 1000)


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
async def test_final_confirmed_day_is_skipped_without_fetch(tmp_path):
    """대상일보다 **늦은 날짜**에 확정된 날은 최종이다 — 벤더를 부르지도 않는다."""
    store = InvestorFlowStore(tmp_path)
    store.write_confirmed(
        DailyConfirmedFile(
            date="20260803",
            confirmed_at_ms=_kst_ms(2026, 8, 4),  # D+1 확정 = 최종
            request={},
            rows=[],
        )
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
async def test_same_day_confirmation_is_rewritten_by_the_next_run(tmp_path):
    """**당일 17:0x 확정본은 최종이 아니다** — 다음 런이 다시 물어 덮어쓴다.

    이것을 스킵하면 벤더가 그 뒤 고친 값과 영구히 어긋난 채 굳는다. `confirmed_at_ms`
    갱신까지 단언하는 이유: 안 갱신하면 재확정이 **매일 무한 반복**된다.
    """
    store = InvestorFlowStore(tmp_path)
    store.write_confirmed(
        DailyConfirmedFile(
            date="20260803",
            confirmed_at_ms=_kst_ms(2026, 8, 3),  # 당일 확정 = 비최종
            request={},
            rows=[{"inds_cd": "001_AL", "orgn_netprps": "6915"}],
        )
    )
    next_run_ms = _kst_ms(2026, 8, 4)
    n = await confirm_days(
        tmp_path,
        dates=["20260803"],
        fetch_market_fn=_fetch_ok(),
        now_ms_fn=lambda: next_run_ms,
    )
    assert n == 1
    day = store.load_confirmed("20260803")
    assert day is not None
    assert day.confirmed_at_ms == next_run_ms
    assert {r["inds_cd"] for r in day.rows} == {"001_AL", "101_AL"}
    # 그리고 이제 최종이다 — 그 다음 런은 부르지 않는다.
    assert is_final(day) is True


@pytest.mark.asyncio
async def test_second_run_on_the_same_day_does_not_freeze_the_value(tmp_path):
    """같은 날 재기동해 런이 두 번 돌아도 **최종이 되지 않는다**.

    "한 번 재확정했는가" 카운터였다면 여기서 궤적 중간값이 최종으로 굳는다.
    날짜 비교라 D+1 런이 여전히 이 날을 잡는다.
    """
    store = InvestorFlowStore(tmp_path)
    store.write_confirmed(
        DailyConfirmedFile(
            date="20260803", confirmed_at_ms=_kst_ms(2026, 8, 3, 17, 1), request={}, rows=[]
        )
    )
    await confirm_days(
        tmp_path,
        dates=["20260803"],
        fetch_market_fn=_fetch_ok(),
        now_ms_fn=lambda: _kst_ms(2026, 8, 3, 20, 0),  # 같은 날 저녁 재기동
    )
    day = store.load_confirmed("20260803")
    assert day is not None
    assert is_final(day) is False


def test_is_final_boundary_is_kst_midnight():
    """경계는 **KST 자정**이다 — UTC 로 계산하면 09:00 이전 스탬프가 전날로 밀린다.

    23:59:59 KST 는 아직 대상일이므로 비최종, 00:00:00 KST 는 D+1 이므로 최종.
    """

    def _day(ms: int) -> DailyConfirmedFile:
        return DailyConfirmedFile(date="20260803", confirmed_at_ms=ms, request={}, rows=[])

    assert is_final(_day(_kst_ms(2026, 8, 3, 23, 59))) is False
    assert is_final(_day(_kst_ms(2026, 8, 4, 0, 0))) is True


@pytest.mark.asyncio
async def test_corrupt_confirmed_file_is_rewritten(tmp_path):
    """손상된 확정본은 자가 치유된다 — 존재 검사만 하던 시절엔 영구히 '확정됨' 이었다."""
    store = InvestorFlowStore(tmp_path)
    path = store.daily_path("20260803")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ 반쪽 JSON", encoding="utf-8")

    n = await confirm_days(
        tmp_path, dates=["20260803"], fetch_market_fn=_fetch_ok(), now_ms_fn=lambda: 5
    )
    assert n == 1
    assert store.load_confirmed("20260803") is not None


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

    assert await investor_flow_runtime.confirm_recent(tmp_path, now=dt.datetime(2026, 8, 5)) == 0


def test_stamp_treats_naive_now_as_kst_on_a_utc_machine(monkeypatch):
    """**막는 것**: UTC 머신에서 당일 확정본이 즉시 최종으로 판정되는 것.

    naive `.timestamp()` 는 머신 로컬 tz 로 해석되므로, 정규화가 없으면 17:00 스탬프가
    KST 로 D+1(02:00)이 되어 `is_final` 이 True → 재확정이 통째로 무력화된다. 개발
    머신이 KST 라 그 회귀는 로컬에서 **영원히 초록**이다. 그래서 tz 를 실제로 바꿔
    잰다.

    **못 보는 것**: 프로덕션이 어떤 tz 로 도는가(그건 배포 환경의 성질이다) — 이
    테스트가 보장하는 것은 "어느 tz 든 스탬프는 KST 벽시계를 뜻한다" 뿐이다.
    """
    import time

    from hoga.live.investor_flow_runtime import _stamp_ms

    monkeypatch.setenv("TZ", "UTC")
    time.tzset()
    try:
        naive_close = dt.datetime(2026, 8, 3, 17, 1)  # KST 벽시계 17:01
        day = DailyConfirmedFile(
            date="20260803", confirmed_at_ms=_stamp_ms(naive_close), request={}, rows=[]
        )
        assert is_final(day) is False
    finally:
        monkeypatch.undo()
        time.tzset()
