"""파생 수급 수집기 — 계약을 고정한다.

벽시계에 기대지 않는다: 시각·게이트·fetch 를 전부 주입해 **호출 횟수와 기록 내용**으로
검증한다(리포 규율 — 벽시계 비율 단언 대신 호출 계약).
"""
from __future__ import annotations

import pytest

from hoga.live.deriv_flow_collector import DerivFlowCollector
from hoga.live.deriv_flow_products import PRODUCTS, UNIT_PROBE_KEY

_DATE = "20260807"


def _row(tag: str = "a") -> dict[str, str]:
    """3주체 gross 260,000계약 · 대금 백만원 규모의 선물성 응답."""
    legs = {"frgn": (60_000, 58_000), "prsn": (30_000, 31_000), "orgn": (40_000, 41_000)}
    row: dict[str, str] = {"_tag": tag}
    for prefix, (seln, shnu) in legs.items():
        for suffix, contracts in (("seln", seln), ("shnu", shnu)):
            row[f"{prefix}_{suffix}_vol"] = str(contracts)
            row[f"{prefix}_{suffix}_tr_pbmn"] = str(contracts * 975.0 * 250_000 / 1e6)
        row[f"{prefix}_ntby_qty"] = str(shnu - seln)
        row[f"{prefix}_ntby_tr_pbmn"] = str((shnu - seln) * 975.0 * 250_000 / 1e6)
    return row


def _make(tmp_path, *, gate=True, now_ms=1_000, fetch=None, calls=None):
    async def _gate(_ms: int) -> bool:
        return gate

    async def _default_fetch(iscd: str, iscd2: str):
        if calls is not None:
            calls.append((iscd, iscd2))
        return _row()

    return DerivFlowCollector(
        data_dir=tmp_path,
        date_fn=lambda: _DATE,
        now_ms_fn=lambda: now_ms,
        fetch_fn=fetch or _default_fetch,
        should_collect_fn=_gate,
    )


@pytest.mark.asyncio
async def test_closed_market_writes_nothing(tmp_path):
    """게이트가 닫혀 있으면 벤더를 부르지도, 파일을 만들지도 않는다."""
    calls: list[tuple[str, str]] = []
    c = _make(tmp_path, gate=False, calls=calls)
    await c.run_once()
    assert calls == []
    assert c.store.load_samples(_DATE) == []


@pytest.mark.asyncio
async def test_each_product_is_its_own_call(tmp_path):
    """상품 7개는 각각 별도 콜이다 — 이 TR 은 요청 하나가 시장 하나를 답한다."""
    calls: list[tuple[str, str]] = []
    c = _make(tmp_path, calls=calls)
    await c.run_once()
    assert calls == [(p.iscd, p.key) for p in PRODUCTS]
    assert len(c.store.load_samples(_DATE)) == len(PRODUCTS)


@pytest.mark.asyncio
async def test_identical_values_are_not_rewritten(tmp_path):
    """동일 값이면 쓰지 않는다 — 60초 폴이 벤더 갱신보다 촘촘해서 생기는 중복을 흡수."""
    c = _make(tmp_path)
    await c.run_once()
    await c.run_once()
    assert len(c.store.load_samples(_DATE)) == len(PRODUCTS)
    assert c.status.skipped_duplicates == len(PRODUCTS)


@pytest.mark.asyncio
async def test_changed_values_append(tmp_path):
    seq = iter([_row("a"), _row("b")])
    calls = 0

    async def _fetch(iscd: str, iscd2: str):
        nonlocal calls
        calls += 1
        # 선물만 두 번 답하고 나머지는 실패시켜 줄 수를 단순하게 유지한다.
        if iscd2 != UNIT_PROBE_KEY:
            return None
        return next(seq)

    c = _make(tmp_path, fetch=_fetch)
    await c.run_once()
    await c.run_once()
    assert len(c.store.load_samples(_DATE)) == 2
    assert calls == 2 * len(PRODUCTS)


@pytest.mark.asyncio
async def test_one_product_failure_does_not_block_others(tmp_path):
    """한 상품이 실패하면 그 줄만 빠진다 — 억지로 메우지 않는다(커버리지가 드러낸다)."""

    async def _fetch(iscd: str, iscd2: str):
        return None if iscd2 == "OC01" else _row()

    c = _make(tmp_path, fetch=_fetch)
    await c.run_once()
    stored = {s.product for s in c.store.load_samples(_DATE)}
    assert "OC01" not in stored
    assert len(stored) == len(PRODUCTS) - 1


@pytest.mark.asyncio
async def test_raw_row_is_stored_verbatim(tmp_path):
    """행을 파싱하지 않고 원본을 보관한다 — 단위 해석이 바뀌어도 다시 읽을 수 있어야
    한다(장중 표본은 소급 조회가 불가능하다)."""
    c = _make(tmp_path)
    await c.run_once()
    sample = c.store.load_samples(_DATE)[0]
    assert sample.row == _row()
    assert sample.request == {"fid_input_iscd": PRODUCTS[0].iscd, "fid_input_iscd_2": PRODUCTS[0].key}


@pytest.mark.asyncio
async def test_units_are_probed_from_futures(tmp_path):
    """단위 판정이 상태에 실린다 — 화면이 억원 축을 쓸 수 있는지가 여기서 갈린다."""
    c = _make(tmp_path)
    assert c.status.units is None
    await c.run_once()
    assert c.status.units is not None
    assert (c.status.units.quantity, c.status.units.amount) == ("contract", "million_won")


@pytest.mark.asyncio
async def test_unresolved_units_do_not_block_storage(tmp_path):
    """판정이 안 서도 원값은 쌓인다 — 저장을 미루면 그 시각이 영영 사라진다."""

    async def _fetch(iscd: str, iscd2: str):
        row = _row()
        for k in list(row):
            if k.endswith("_vol"):
                row[k] = str(float(row[k]) / 1000)  # 임계 미달 → 보류
        return row

    c = _make(tmp_path, fetch=_fetch)
    await c.run_once()
    assert c.status.units is not None
    assert not c.status.units.resolved
    assert len(c.store.load_samples(_DATE)) == len(PRODUCTS)
