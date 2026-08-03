"""GET /api/inventory/calendar?code&year&month."""
from __future__ import annotations

import datetime as dt
import json

import pytest
from fastapi.testclient import TestClient

import hoga.api.calendar as cal

# Approximate KRX trading days for May 2026 — weekdays minus a plausible
# holiday on 2026-05-05 (Children's Day). Tests only need consistency,
# not real-world fidelity.
_MAY_2026_TRADING_DAYS = {
    f"202605{d:02d}"
    for d in (1, 4, 6, 7, 8, 11, 12, 13, 14, 15,
              18, 19, 20, 21, 22, 25, 26, 27, 28, 29)
}


@pytest.fixture(autouse=True)
def _stub_trading_days(monkeypatch):
    """거래일 소스를 2026-05 한 달로 고정한다.

    PR-H(#1044) 이후 소스는 KIS 원격이 아니라 **정적 시드 + data_dir 오버레이**다.
    그래서 스텁하는 자리도 월 캐시가 아니라 소스 자체다. 커버리지 끝은 이 집합의
    최대값이라, 2026-05 밖 날짜는 자연히 "모름"(None)이 된다 — 그 계약은
    `tests/api/test_trading_days_source.py` 가 따로 본다.
    """
    cal.reset_cache_for_tests()
    monkeypatch.setattr(
        cal.trading_days_source, "trading_days",
        lambda _data_dir=None: frozenset(_MAY_2026_TRADING_DAYS),
    )
    yield
    cal.reset_cache_for_tests()


def _build_app(monkeypatch, tmp_path):
    from hoga.api.app import create_app
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    return create_app(data_dir=tmp_path)


def test_calendar_returns_envelope_with_as_of_ms(monkeypatch, tmp_path):
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/inventory/calendar?code=005930&year=2026&month=5")
        assert r.status_code == 200
        body = r.json()
        assert "cells" in body and "as_of_ms" in body
        assert isinstance(body["as_of_ms"], int) and body["as_of_ms"] > 0
        # 31 days in May.
        assert len(body["cells"]) == 31


def test_calendar_marks_weekends(monkeypatch, tmp_path):
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/inventory/calendar?code=005930&year=2026&month=5")
        body = r.json()
        # 20260516 was a Saturday.
        sat = next(cell for cell in body["cells"] if cell["date"] == "20260516")
        assert sat["status"] == "weekend"


def test_calendar_marks_future_dates(monkeypatch, tmp_path):
    KST = dt.timezone(dt.timedelta(hours=9))
    fixed_now = dt.datetime(2026, 5, 15, 10, 0, 0, tzinfo=KST)
    monkeypatch.setattr("hoga.api.calendar._now_kst", lambda: fixed_now, raising=False)
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        # 20260518 is in the future relative to fixed_now.
        cell = next(c for c in body["cells"] if c["date"] == "20260518")
        assert cell["status"] == "future"


def test_calendar_marks_today_locked_before_1630_kst(monkeypatch, tmp_path):
    KST = dt.timezone(dt.timedelta(hours=9))
    monkeypatch.setattr("hoga.api.calendar._now_kst",
                        lambda: dt.datetime(2026, 5, 22, 16, 29, 0, tzinfo=KST),
                        raising=False)
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        today_cell = next(c for c in body["cells"] if c["date"] == "20260522")
        assert today_cell["status"] == "today_locked"


def test_calendar_uses_disk_state_for_captured_cells(monkeypatch, tmp_path):
    (tmp_path / "parquet" / "20260518" / "005930").mkdir(parents=True)
    (tmp_path / "parquet" / "20260518" / "005930" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": False}))
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        cell = next(c for c in body["cells"] if c["date"] == "20260518")
        assert cell["status"] == "complete"
        assert cell["captured_at_ms"] is not None


def _write_source_meta(tmp_path, date, code, source, meta):
    d = tmp_path / "parquet" / date / code / source
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta))


def _status_for(monkeypatch, tmp_path, date, code):
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get(f"/api/inventory/calendar?code={code}&year=2026&month=5").json()
        return next(cc for cc in body["cells"] if cc["date"] == date)


def test_calendar_kis_live_only_complete_shows_complete_live(monkeypatch, tmp_path):
    """ADR-0115: hogaplay absent, kis_live COMPLETE → complete_live (not complete)."""
    _write_source_meta(tmp_path, "20260518", "005930", "kis_live",
                       {"collection_complete": True, "is_partial": False})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "complete_live"
    assert cell["captured_at_ms"] is not None


def test_calendar_kis_live_only_partial_shows_partial_live(monkeypatch, tmp_path):
    _write_source_meta(tmp_path, "20260518", "005930", "kis_live",
                       {"collection_complete": True, "is_partial": True})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "partial_live"


def test_calendar_hogaplay_wins_over_kis_live(monkeypatch, tmp_path):
    """hogaplay COMPLETE + kis_live present → hogaplay-framed 'complete'."""
    _write_source_meta(tmp_path, "20260518", "005930", "hogaplay",
                       {"collection_complete": True, "is_partial": False})
    _write_source_meta(tmp_path, "20260518", "005930", "kis_live",
                       {"collection_complete": True, "is_partial": False})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "complete"


def test_calendar_kis_live_incomplete_shows_none(monkeypatch, tmp_path):
    """kis_live not finalized (CLIENT_INCOMPLETE) → 'none' (✕ noise removed)."""
    _write_source_meta(tmp_path, "20260518", "005930", "kis_live",
                       {"collection_complete": False, "is_partial": True})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "none"


from pathlib import Path

import pytest

from hoga.api import calendar as calendar_module
from hoga.api.error_codes import UpstreamCode


def test_disk_state_to_status_maps_invalid() -> None:
    """ADR-0020: DiskState.INVALID maps to 'invalid' string on the wire."""
    from hoga.api.calendar import _disk_state_to_status
    from hoga.api.disk_state import DiskState
    assert _disk_state_to_status(DiskState.INVALID) == "invalid"


def test_calendar_cell_constructs_with_invalid_status() -> None:
    """Pydantic Literal must accept 'invalid' — runtime validation passes.

    Regression: if CalendarStatus omitted 'invalid', CalendarCell(status='invalid')
    would raise ValidationError and the calendar route would 500 for any code
    with an INVALID-classified date.
    """
    from hoga.api.models import CalendarCell
    cell = CalendarCell(date="20260518", status="invalid",  # type: ignore[arg-type]
                        captured_at_ms=None)
    assert cell.status == "invalid"


def test_calendar_route_renders_invalid_cell_e2e(monkeypatch, tmp_path):
    """End-to-end: a parquet dir with INVALID-shaped meta surfaces as
    {status: 'invalid'} in the calendar response (no 500)."""
    pq = tmp_path / "parquet" / "20260518" / "005930"
    pq.mkdir(parents=True)
    # collection_complete=True so it passes the CLIENT_INCOMPLETE branch;
    # close_ms=0 trips meta.close_after_open + meta.close_in_kst_range → INVALID.
    (pq / "meta.json").write_text(json.dumps({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,
        "collection_complete": True,
        "is_partial": False,
    }))
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        cell = next(c for c in body["cells"] if c["date"] == "20260518")
        assert cell["status"] == "invalid"


@pytest.fixture(autouse=False)
def _reset_calendar_state():
    calendar_module.reset_cache_for_tests()
    yield
    calendar_module.reset_cache_for_tests()


def _stub_source(monkeypatch, days_yyyymmdd, *, calls=None):
    """거래일 소스를 고정한다 — PR-H(#1044) 이후의 유일한 이음매.

    KIS 판의 `fetch_month_trading_days` 몽키패치를 대체한다. 그쪽은 월 단위
    원격 호출이었고 실패가 곧 조회 실패였지만, 여기서는 파일 내용만 정한다.
    """
    def _days(_data_dir=None):
        if calls is not None:
            calls.append(1)
        return frozenset(days_yyyymmdd)

    monkeypatch.setattr(calendar_module.trading_days_source, "trading_days", _days)


# ---------------------------------------------------------------------------
# 커버리지 계약 — PR-H(#1044)
#
# **조회 경로에 벤더가 없으면 "일시 장애" 라는 사건이 없다.** 그래서 이 자리에
# 있던 세 테스트가 사라졌다:
#
#   test_trading_days_for_negative_caches_failures
#   test_trading_days_for_singleflights_concurrent_failures
#   test_trading_days_for_maps_creds_missing_to_distinct_reason
#
# 셋 다 "원격이 실패했을 때" 의 캐시·경합·사유 분류를 봤는데, 정적 파일에는
# 실패가 없다. #976 이 세운 두 갈래("영구 결여는 평일 폴백 · 일시 장애는
# fail-fast") 중 일시 장애 쪽이 통째로 없어진 결과다.
#
# 남는 불확실성은 하나다: **커버리지 밖**. 아래가 그것을 못 박는다.
# ---------------------------------------------------------------------------

def test_trading_days_for_returns_none_beyond_coverage(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """커버리지 끝을 넘는 달은 None. 재시도해도 달라지지 않는다."""
    _stub_source(monkeypatch, _MAY_2026_TRADING_DAYS)
    assert calendar_module._trading_days_for(2026, 5) is not None
    assert calendar_module._trading_days_for(2027, 1) is None
    assert calendar_module.last_failure_reason() == UpstreamCode.KIS_HOLIDAY_FETCH_FAILED


def test_trading_days_for_needs_no_credentials(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """**자격증명 없이도 달력이 정확하다.**

    dev 무자격 관례(ADR-0134)에서 지금까지 휴장일 정확도를 포기하고 평일 폴백을
    쓰던 경로가 그냥 맞는 답을 낸다. 여기서는 KIS 자격증명 env 를 비워도 커밋된
    시드가 답하는 것을 본다(스텁 없이 실제 파일).
    """
    for key in ("KIS_APP_KEY", "KIS_APP_SECRET"):
        monkeypatch.delenv(key, raising=False)
    days = calendar_module._trading_days_for(2026, 5)
    assert days is not None and "20260501" in days


# ---------------------------------------------------------------------------
# is_trading_session_today (ADR-0064): lag-free "is TODAY a KRX session?"
#
# 폴러 게이트는 **오늘**이 거래일인지를 지연 없는 소스로 판정해야 한다 — 잘못된
# False 가 캐시되면 그 프로세스의 라이브 캡처가 조용히 멈춘다. 소스가 정적
# 파일로 바뀌어도 per-day 의미론(양성은 캐시, 음성은 스로틀 재확인)은 그대로다.
# ---------------------------------------------------------------------------

def test_is_trading_session_today_true_when_in_trading_days(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    _stub_source(monkeypatch, ["20260604", "20260605"])
    assert calendar_module.is_trading_session_today("20260605") is True


def test_is_trading_session_today_false_on_holiday(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    _stub_source(monkeypatch, ["20260604", "20260608"])
    assert calendar_module.is_trading_session_today("20260605") is False


def test_is_trading_session_today_none_beyond_coverage(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """커버리지 밖이면 None — 폴러는 None 에 관대하다(잠깐의 헛발질이 캡처
    중단보다 낫다). **False 로 답하면 그 관대함이 발동하지 않는다.**"""
    _stub_source(monkeypatch, ["20260101"])
    assert calendar_module.is_trading_session_today("20260605") is None


def test_is_trading_session_today_none_when_source_is_empty(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """시드를 못 읽은 상태 = 배포 사고. 재시도 대상은 아니지만 None 이어야 한다."""
    _stub_source(monkeypatch, [])
    assert calendar_module.is_trading_session_today("20260605") is None


def test_is_trading_session_today_caches_positive(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """확정된 거래 세션은 하루 단위로 캐시된다 — 소스를 다시 읽지 않는다."""
    calls: list = []
    _stub_source(monkeypatch, ["20260605"], calls=calls)
    assert calendar_module.is_trading_session_today("20260605") is True
    assert calendar_module.is_trading_session_today("20260605") is True
    assert len(calls) == 1


def test_is_trading_session_today_rechecks_negative_and_self_heals(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """**오늘에 대한 False 는 영구 캐시하지 않는다.**

    소스가 일시적으로 오늘을 빠뜨리면(ADR-0064 의 버그 모양) 게이트가 재시작
    없이 스스로 회복해야 한다. 지금은 그 "일시적 누락" 이 **오버레이가 아직
    갱신되지 않은 상태**다 — 스케줄러가 채우면 다음 재확인에서 True 가 된다.
    재확인은 스로틀된다.
    """
    _stub_source(monkeypatch, ["20260604", "20260630"])
    assert calendar_module.is_trading_session_today("20260605", _now_s=0.0) is False
    # 스로틀 창 안: 여전히 False
    assert calendar_module.is_trading_session_today("20260605", _now_s=10.0) is False
    # 오버레이가 채워졌다 → 스로틀 창 밖에서 True 로 회복
    _stub_source(monkeypatch, ["20260604", "20260605", "20260630"])
    assert calendar_module.is_trading_session_today("20260605", _now_s=120.0) is True


def test_get_month_map_fail_soft_when_calendar_has_no_coverage(
    monkeypatch: pytest.MonkeyPatch, tmp_path, _reset_calendar_state: None,
) -> None:
    """커버리지가 없으면 평일 폴백으로 **렌더는 계속된다**(fail-soft).

    달력 화면은 휴장일 정확도가 떨어져도 보이는 편이 낫다 — 사용자는
    `reason` 배너로 그 사실을 안다. 이 정책은 KIS 판과 같다.
    """
    _stub_source(monkeypatch, [])
    resp = calendar_module.get_month_map(
        data_dir=tmp_path, code="005930", year=2026, month=5,
    )
    assert resp.reason is not None
    assert len(resp.cells) > 0


def test_trading_days_in_range_raises_beyond_coverage(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """추측한 날짜 목록으로 진행하지 않는다 — enqueue 경로는 fail-fast 다."""
    _stub_source(monkeypatch, _MAY_2026_TRADING_DAYS)
    assert calendar_module.trading_days_in_range("20260501", "20260508")
    with pytest.raises(calendar_module.TradingDayUnavailableError):
        calendar_module.trading_days_in_range("20260501", "20270108")


def test_reset_cache_clears_last_failure_reason(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    _stub_source(monkeypatch, _MAY_2026_TRADING_DAYS)
    calendar_module._trading_days_for(2027, 1)
    assert calendar_module.last_failure_reason() is not None
    calendar_module.reset_cache_for_tests()
    assert calendar_module.last_failure_reason() is None


def test_calendar_cell_shows_no_upstream_data_for_sentinel(tmp_path: Path, monkeypatch) -> None:
    """A sentinel directory must surface as CalendarCell.status =
    'no_upstream_data' on the wire so the frontend can render the '–' marker.
    captured_at_ms stays None (no capture timestamp — there was nothing to
    capture)."""
    from hoga.api.calendar import get_month_map

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    (raw_dir / ".no_upstream_data").touch()

    # 거래일 분기를 결정론적으로 태운다 — 소스를 2026-03 전체로 고정한다.
    from hoga.api.calendar import reset_cache_for_tests
    reset_cache_for_tests()
    monkeypatch.setattr(
        calendar_module.trading_days_source, "trading_days",
        lambda _data_dir=None: frozenset(f"202603{day:02d}" for day in range(1, 32)),
    )

    try:
        resp = get_month_map(data_dir=tmp_path, code="003490", year=2026, month=3)
    finally:
        reset_cache_for_tests()

    cell = next(c for c in resp.cells if c.date == "20260319")
    assert cell.status == "no_upstream_data"
    assert cell.captured_at_ms is None


