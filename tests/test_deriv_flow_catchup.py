"""마감 후 catch-up — **없으면 그날이 영구히 사라지는** 경로를 고정한다.

파생엔 일별 확정 TR 이 없다(`FHPTJ04040000` 의 시장구분은 KSP/KSQ 뿐). 그래서 수집 창
(09:00–15:45)을 놓친 날을 되살릴 방법이 소급 조회 말고는 없는데 그것도 없다. 유일하게
남은 길이 **마감 후에도 답하는 벤더에게 한 번 더 묻는 것**이고(2026-08-07 15:59 실측:
7상품 전부 정상 응답), 이 테스트가 그 길을 막지 않는지를 잰다.
"""
from __future__ import annotations

import datetime as dt

import pytest

from hoga.live.deriv_flow_collector import DerivFlowCollector
from hoga.live.deriv_flow_products import PRODUCTS
from hoga.live.deriv_flow_store import DerivSample

_DATE = "20260807"
_KST = dt.timezone(dt.timedelta(hours=9))


def _ms(hh: int, mm: int) -> int:
    return int(dt.datetime(2026, 8, 7, hh, mm, tzinfo=_KST).timestamp() * 1000)


def _row(tag: str = "final") -> dict[str, str]:
    legs = {"frgn": (60_000, 58_000), "prsn": (30_000, 31_000), "orgn": (40_000, 41_000)}
    row: dict[str, str] = {"_tag": tag}
    for p, (seln, shnu) in legs.items():
        for suf, c in (("seln", seln), ("shnu", shnu)):
            row[f"{p}_{suf}_vol"] = str(c)
            row[f"{p}_{suf}_tr_pbmn"] = str(c * 975.0 * 250_000 / 1e6)
    return row


def _make(tmp_path, *, now_ms: int, after_close: bool, calls=None, fetch=None):
    async def _gate(_ms: int) -> bool:
        return False  # 수집 창은 닫혀 있다 — catch-up 만 본다

    async def _after(_ms: int) -> bool:
        return after_close

    async def _default_fetch(iscd: str, iscd2: str):
        if calls is not None:
            calls.append(iscd2)
        return _row()

    return DerivFlowCollector(
        data_dir=tmp_path,
        date_fn=lambda: _DATE,
        now_ms_fn=lambda: now_ms,
        fetch_fn=fetch or _default_fetch,
        should_collect_fn=_gate,
        after_close_fn=_after,
    )


@pytest.mark.asyncio
async def test_captures_closing_snapshot_when_day_is_empty(tmp_path):
    """장중에 서버가 안 떠 있던 날 — 마감 후 기동이 그날을 살린다."""
    calls: list[str] = []
    c = _make(tmp_path, now_ms=_ms(16, 10), after_close=True, calls=calls)
    written = await c.catch_up_after_close()
    assert written == len(PRODUCTS)
    assert calls == [p.key for p in PRODUCTS]
    assert len(c.store.load_samples(_DATE)) == len(PRODUCTS)


@pytest.mark.asyncio
async def test_intraday_samples_do_not_count_as_final(tmp_path):
    """장중 표본이 아무리 많아도 **최종 누적이 아니다** — 마감 후 한 줄이 따로 필요하다."""
    c = _make(tmp_path, now_ms=_ms(16, 10), after_close=True)
    for i in range(5):
        c.store.append_sample(
            _DATE,
            DerivSample(
                sampled_at_ms=_ms(10, i),
                product="F001",
                request={"fid_input_iscd": "K2I", "fid_input_iscd_2": "F001"},
                row=_row(f"intraday{i}"),
            ),
        )
    written = await c.catch_up_after_close()
    assert written == len(PRODUCTS)


@pytest.mark.asyncio
async def test_same_values_are_not_rewritten(tmp_path):
    """값이 그대로면 두 번째 호출은 쓰지 않는다 — 부팅 catch-up 과 일일 루프가 겹쳐 돈다."""
    c = _make(tmp_path, now_ms=_ms(16, 10), after_close=True)
    first = await c.catch_up_after_close()
    second = await c.catch_up_after_close()
    assert (first, second) == (len(PRODUCTS), 0)
    assert len(c.store.load_samples(_DATE)) == len(PRODUCTS)


@pytest.mark.asyncio
async def test_later_settlement_update_is_appended(tmp_path):
    """**마감 직후 값은 아직 움직인다**(2026-08-07 실측: 15:59 +2,369계약 → 16시대
    +3,913). "이미 담았으니 건너뛴다" 로 두면 가장 이른 스냅샷이 그날의 최종본으로
    굳는다 — 값이 바뀌면 한 줄 더 붙어야 하고 읽기 경로는 마지막을 쓴다."""
    seq = {"n": 0}

    async def _fetch(iscd: str, iscd2: str):
        return _row(f"v{seq['n']}")

    c = _make(tmp_path, now_ms=_ms(16, 10), after_close=True, fetch=_fetch)
    assert await c.catch_up_after_close() == len(PRODUCTS)
    seq["n"] = 1  # 정산 반영으로 값이 갱신됐다
    assert await c.catch_up_after_close() == len(PRODUCTS)
    samples = [s for s in c.store.load_samples(_DATE) if s.product == "F001"]
    assert len(samples) == 2
    assert samples[-1].row["_tag"] == "v1"


@pytest.mark.asyncio
async def test_does_nothing_before_close(tmp_path):
    """장중에는 담지 않는다 — 그때 값은 최종 누적이 아니다."""
    calls: list[str] = []
    c = _make(tmp_path, now_ms=_ms(13, 0), after_close=False, calls=calls)
    assert await c.catch_up_after_close() == 0
    assert calls == []


@pytest.mark.asyncio
async def test_partial_failure_still_writes_the_rest(tmp_path):
    """한 상품이 실패해도 나머지는 담는다 — 전부 아니면 아무것도, 는 손실이 더 크다."""

    async def _fetch(iscd: str, iscd2: str):
        return None if iscd2 == "OC01" else _row()

    c = _make(tmp_path, now_ms=_ms(16, 10), after_close=True, fetch=_fetch)
    assert await c.catch_up_after_close() == len(PRODUCTS) - 1
    assert "OC01" not in {s.product for s in c.store.load_samples(_DATE)}


@pytest.mark.asyncio
async def test_units_are_probed_during_catchup(tmp_path):
    """마감 후 표본으로도 단위를 잰다 — 그날 유일한 표본일 수 있다."""
    c = _make(tmp_path, now_ms=_ms(16, 10), after_close=True)
    await c.catch_up_after_close()
    assert c.status.units is not None
    assert c.status.units.resolved


@pytest.mark.asyncio
async def test_observed_time_is_recorded_not_the_close_time(tmp_path):
    """관측 시각을 위조하지 않는다 — 안 본 시각을 적으면 커버리지가 거짓말한다."""
    c = _make(tmp_path, now_ms=_ms(16, 10), after_close=True)
    await c.catch_up_after_close()
    assert {s.sampled_at_ms for s in c.store.load_samples(_DATE)} == {_ms(16, 10)}
