"""장중 수급 수집기 — #1099·#1105 의 계약을 고정한다.

벽시계에 기대지 않는다: 시각·게이트·fetch 를 전부 주입해 **호출 횟수와 기록 내용**으로
검증한다(리포 규율 — 벽시계 비율 단언 대신 호출 계약).
"""
from __future__ import annotations

import pytest

from hoga.live.investor_flow_collector import InvestorFlowCollector

_ROWS_A = [{"inds_cd": "001_AL", "frgnr_netprps": "+100"}]
_ROWS_B = [{"inds_cd": "001_AL", "frgnr_netprps": "+200"}]


def _make(tmp_path, *, gate=True, now_ms=1_000, fetch=None, calls=None):
    async def _gate(_ms: int) -> bool:
        return gate

    async def _default_fetch(mrkt_tp: str, date: str):
        if calls is not None:
            calls.append((mrkt_tp, date))
        return list(_ROWS_A)

    return InvestorFlowCollector(
        data_dir=tmp_path,
        date_fn=lambda: "20260805",
        now_ms_fn=lambda: now_ms,
        fetch_market_fn=fetch or _default_fetch,
        should_collect_fn=_gate,
    )


@pytest.mark.asyncio
async def test_closed_market_writes_nothing(tmp_path):
    """게이트가 닫혀 있으면 벤더를 부르지도, 파일을 만들지도 않는다."""
    calls: list[tuple[str, str]] = []
    c = _make(tmp_path, gate=False, calls=calls)
    await c.run_once()
    assert calls == []
    assert c.store.load_samples("20260805") == []


@pytest.mark.asyncio
async def test_each_market_is_its_own_call(tmp_path):
    """코스닥은 별도 콜이다 — 한 submit 에 묶으면 버킷이 1 을 세고 벤더는 2 를 센다."""
    calls: list[tuple[str, str]] = []
    c = _make(tmp_path, calls=calls)
    await c.run_once()
    assert calls == [("0", "20260805"), ("1", "20260805")]
    assert len(c.store.load_samples("20260805")) == 2


@pytest.mark.asyncio
async def test_identical_values_are_not_rewritten(tmp_path):
    """동일 값이면 쓰지 않는다(#1099) — 60초 폴 × 90초 갱신의 중복을 흡수한다."""
    c = _make(tmp_path)
    await c.run_once()
    await c.run_once()
    assert len(c.store.load_samples("20260805")) == 2  # 시장당 1줄, 두 번째 사이클은 스킵
    assert c.status.skipped_duplicates == 2


@pytest.mark.asyncio
async def test_changed_values_append_a_new_sample(tmp_path):
    seq = {"n": 0}

    async def _fetch(mrkt_tp: str, _date: str):
        # 코스피만 두 번째 사이클에서 값이 바뀐다
        if mrkt_tp == "0" and seq["n"] > 0:
            return list(_ROWS_B)
        return list(_ROWS_A)

    c = _make(tmp_path, fetch=_fetch)
    await c.run_once()
    seq["n"] = 1
    await c.run_once()
    samples = c.store.load_samples("20260805")
    kospi = [s for s in samples if s.request["mrkt_tp"] == "0"]
    kosdaq = [s for s in samples if s.request["mrkt_tp"] == "1"]
    assert len(kospi) == 2  # 변화 → 추가
    assert len(kosdaq) == 1  # 동일 → 스킵
    assert kospi[-1].rows == _ROWS_B


@pytest.mark.asyncio
async def test_one_market_failing_leaves_an_asymmetric_record(tmp_path):
    """한 시장만 실패하면 그 줄만 빠진다 — 억지로 메우지 않는 것이 계약이다."""

    async def _fetch(mrkt_tp: str, _date: str):
        return None if mrkt_tp == "1" else list(_ROWS_A)

    c = _make(tmp_path, fetch=_fetch)
    await c.run_once()
    samples = c.store.load_samples("20260805")
    assert [s.request["mrkt_tp"] for s in samples] == ["0"]


@pytest.mark.asyncio
async def test_cycle_error_does_not_kill_the_collector(tmp_path):
    """한 사이클의 예외가 루프를 죽이면 수집이 조용히 멎는다(ADR-0064)."""

    async def _boom(_mrkt: str, _date: str):
        raise RuntimeError("upstream exploded")

    c = _make(tmp_path, fetch=_boom)
    with pytest.raises(RuntimeError):
        await c.run_once()  # run_once 는 던진다 — 삼키는 것은 _loop 의 책임
    c._record_cycle_error(RuntimeError("upstream exploded"))
    assert c.status.last_error is not None
    assert c.status.last_error_kind is not None


@pytest.mark.asyncio
async def test_amount_axis_is_recorded_in_the_request(tmp_path):
    """단위는 응답이 아니라 요청이 정한다(#1117) — 줄에 그 증빙이 남아야 한다."""
    c = _make(tmp_path)
    await c.run_once()
    sample = c.store.load_samples("20260805")[0]
    assert sample.request["amt_qty_tp"] == "0"  # 금액(억원)
    assert sample.source == "kiwoom:ka10051"


def test_task_handle_is_the_only_liveness_source(tmp_path):
    """`status.running` 은 기동 의도일 뿐 liveness 가 아니다(ADR-0088)."""
    c = _make(tmp_path)
    assert c.task is None
    assert c.status.running is False
