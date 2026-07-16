from __future__ import annotations

import datetime as dt

import pytest

from hoga.api import captures
from hoga.api.disk_state import Classification, DiskState
from hoga.api.models import BulkEnqueueItem, BulkEnqueueRequest, CoveragePreviewRequest

# 16:30 이후 → today-too-early 게이트가 발화하지 않고, 아래 dates 는 과거라 무관.
_NOW = dt.datetime(2026, 7, 15, 20, 0)
_A = "005930"
_B = "000660"


@pytest.mark.asyncio
async def test_coverage_preview_classifies_and_lists_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_expand_to_trading_days",
                        lambda s, e: ["20260713", "20260714"])
    states = {
        (_A, "20260713"): DiskState.COMPLETE,
        (_A, "20260714"): DiskState.COMPLETE,
        (_B, "20260713"): DiskState.NONE,               # 수집 대상
        (_B, "20260714"): DiskState.NO_UPSTREAM_DATA,   # 상류 무데이터(제외)
    }
    monkeypatch.setattr(
        "hoga.api.disk_state.check_disk_state",
        lambda data_dir, code, date, *, source=None: Classification(state=states[(code, date)]),
    )
    req = CoveragePreviewRequest(codes=[_A, _B], start_date="20260713", end_date="20260714")
    res = await captures.coverage_preview_core(req, data_dir=tmp_path, now=_NOW)

    assert res.dates == ["20260713", "20260714"]
    assert res.codes == 2
    assert res.total == 4
    assert res.have == 2
    assert res.no_upstream == 1
    assert res.to_collect == 1
    assert [(m.code, m.date) for m in res.missing] == [(_B, "20260713")]
    assert res.est_minutes >= 1


@pytest.mark.asyncio
async def test_coverage_preview_requires_range_or_lookback(tmp_path):
    from fastapi import HTTPException
    req = CoveragePreviewRequest(codes=[_A])
    with pytest.raises(HTTPException) as ei:
        await captures.coverage_preview_core(req, data_dir=tmp_path, now=_NOW)
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_coverage_preview_trading_day_unavailable_is_503(monkeypatch, tmp_path):
    """KIS 캘린더 불가 → 500 아닌 503(enqueue_items_core 와 동일). 무자격증명 안내."""
    from fastapi import HTTPException
    from hoga.api.calendar import TradingDayUnavailableError
    from hoga.api.error_codes import UpstreamCode

    def _boom(_s, _e):
        raise TradingDayUnavailableError(UpstreamCode.KIS_CREDENTIALS_MISSING)

    monkeypatch.setattr(captures, "_expand_to_trading_days", _boom)
    req = CoveragePreviewRequest(codes=[_A], start_date="20260713", end_date="20260714")
    with pytest.raises(HTTPException) as ei:
        await captures.coverage_preview_core(req, data_dir=tmp_path, now=_NOW)
    assert ei.value.status_code == 503
    assert ei.value.detail["code"] == UpstreamCode.KIS_CREDENTIALS_MISSING


@pytest.mark.asyncio
async def test_coverage_preview_caps_oversized_request(monkeypatch, tmp_path):
    """codes × dates 가 상한 초과면 400(단일 스레드 직렬 분류 폭주 방지)."""
    from fastapi import HTTPException
    # 60거래일 × 200종목 = 12000 > 10000 상한.
    monkeypatch.setattr(captures, "_expand_to_trading_days",
                        lambda s, e: [f"2026{m:02d}{d:02d}" for m in (5, 6) for d in range(1, 31)])
    codes = [f"{i:06d}" for i in range(200)]
    req = CoveragePreviewRequest(codes=codes, start_date="20260501", end_date="20260630")
    with pytest.raises(HTTPException) as ei:
        await captures.coverage_preview_core(req, data_dir=tmp_path, now=_NOW)
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_bulk_enqueue_loops_per_code(monkeypatch, tmp_path):
    calls: list[tuple[str, list[str]]] = []

    async def fake_enqueue(req, *, data_dir, now):
        calls.append((req.code, req.dates))
        from hoga.api.models import EnqueueResponse
        # 첫 코드는 1건 enqueued, 둘째는 1건 deduped 로 집계 검증.
        if req.code == _A:
            return EnqueueResponse(enqueued=[_stub_item()], deduped=[], blocked=[])
        return EnqueueResponse(enqueued=[], deduped=[_stub_deduped()], blocked=[])

    monkeypatch.setattr(captures, "enqueue_items_core", fake_enqueue)
    req = BulkEnqueueRequest(items=[
        BulkEnqueueItem(code=_A, dates=["20260713"]),
        BulkEnqueueItem(code=_B, dates=["20260713", "20260714"]),
    ])
    res = await captures.bulk_enqueue_core(req, data_dir=tmp_path, now=_NOW)

    assert calls == [(_A, ["20260713"]), (_B, ["20260713", "20260714"])]
    assert res.codes == 2
    assert res.enqueued == 1
    assert res.deduped == 1
    assert res.blocked == 0


def _stub_item():
    from hoga.api.models import QueueItem
    return QueueItem(
        item_id="x", code=_A, date="20260713", phase="queued",
        force_retry=False, pause_origin=False, enqueued_at_ms=0,
    )


def _stub_deduped():
    from hoga.api.models import EnqueueDedupedRow
    return EnqueueDedupedRow(code=_B, date="20260713", reason="already_in_queue")
