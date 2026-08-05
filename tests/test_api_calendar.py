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


def test_calendar_kiwoom_live_only_complete_shows_complete_live(monkeypatch, tmp_path):
    """ADR-0115: hogaplay absent, kiwoom_live COMPLETE → complete_live (not complete)."""
    _write_source_meta(tmp_path, "20260518", "005930", "kiwoom_live",
                       {"collection_complete": True, "is_partial": False})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "complete_live"
    assert cell["captured_at_ms"] is not None


def test_calendar_kiwoom_live_only_partial_shows_partial_live(monkeypatch, tmp_path):
    _write_source_meta(tmp_path, "20260518", "005930", "kiwoom_live",
                       {"collection_complete": True, "is_partial": True})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "partial_live"


def test_calendar_hogaplay_wins_over_kiwoom_live(monkeypatch, tmp_path):
    """hogaplay COMPLETE + kiwoom_live present → hogaplay-framed 'complete'."""
    _write_source_meta(tmp_path, "20260518", "005930", "hogaplay",
                       {"collection_complete": True, "is_partial": False})
    _write_source_meta(tmp_path, "20260518", "005930", "kiwoom_live",
                       {"collection_complete": True, "is_partial": False})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "complete"


_KST = dt.timezone(dt.timedelta(hours=9))


def _status_at(monkeypatch, tmp_path, date, code, now):
    """`_status_for` 와 같지만 시계를 고정한다.

    확정/미확정 갈림은 **보유 창(2일) 기준 나이**에 달려 있어(ADR-0131) 실제
    시각으로 돌리면 모든 픽스처가 만료되어 미확정 경로를 아예 못 밟는다.
    """
    monkeypatch.setattr("hoga.api.calendar._now_kst", lambda: now, raising=False)
    return _status_for(monkeypatch, tmp_path, date, code)


def test_calendar_unconfirmed_gap_within_retention_stays_source_partial(monkeypatch, tmp_path):
    """아직 재캡처가 채워 줄 여지가 있는 구멍은 ⚠ 그대로."""
    _write_source_meta(tmp_path, "20260519", "005930", "hogaplay",
                       {"collection_complete": True, "is_partial": True})
    cell = _status_at(monkeypatch, tmp_path, "20260519", "005930",
                      dt.datetime(2026, 5, 20, 18, 0, tzinfo=_KST))
    assert cell["status"] == "source_partial"


def test_calendar_identical_recapture_marks_confirmed(monkeypatch, tmp_path):
    """ADR-0093: 재캡처가 동일 갭을 재현하면 확정 — 별도 상태로 갈라진다."""
    _write_source_meta(tmp_path, "20260519", "005930", "hogaplay",
                       {"collection_complete": True, "is_partial": True,
                        "identical_capture_count": 2})
    cell = _status_at(monkeypatch, tmp_path, "20260519", "005930",
                      dt.datetime(2026, 5, 20, 18, 0, tzinfo=_KST))
    assert cell["status"] == "source_partial_confirmed"
    # 확정이어도 하루 대부분은 수집돼 있다 — 캡처 시각을 잃으면 안 된다.
    assert cell["captured_at_ms"] is not None


def test_calendar_session_edge_gap_marks_confirmed(monkeypatch, tmp_path):
    """ADR-0126: 세션 개시에 접한 갭은 재캡처 횟수와 무관하게 확정이다."""
    _write_source_meta(tmp_path, "20260519", "005930", "hogaplay",
                       {"collection_complete": True, "is_partial": True,
                        "regular_session_open_ms": 90000000,
                        "regular_session_close_ms": 153000000,
                        "gap_ranges": [{"start_ms": 90000000, "end_ms": 90200000}]})
    cell = _status_at(monkeypatch, tmp_path, "20260519", "005930",
                      dt.datetime(2026, 5, 20, 18, 0, tzinfo=_KST))
    assert cell["status"] == "source_partial_confirmed"


def test_calendar_expired_unconfirmed_gap_marks_confirmed(monkeypatch, tmp_path):
    """ADR-0131: 보유 창 밖 미확정 갭은 확정 경로가 원리적으로 닫혀 있다.

    같은 meta 가 창 안(위 테스트)에서는 ⚠ 로 남는다는 점이 핵심 — 판정은 meta
    단독이 아니라 meta × 나이다. 이 셀을 ⚠ 로 두면 decide_capture 가
    `upstream_gap` 으로 건너뛰는 동안 사용자는 계속 재캡처를 누른다.
    """
    _write_source_meta(tmp_path, "20260511", "005930", "hogaplay",
                       {"collection_complete": True, "is_partial": True})
    cell = _status_at(monkeypatch, tmp_path, "20260511", "005930",
                      dt.datetime(2026, 5, 20, 18, 0, tzinfo=_KST))
    assert cell["status"] == "source_partial_confirmed"


def test_calendar_complete_is_unaffected_by_confirmation_split(monkeypatch, tmp_path):
    """구멍이 없으면 나이와 무관하게 ✓ — 새 분기가 완결 셀을 건드리지 않는다."""
    _write_source_meta(tmp_path, "20260511", "005930", "hogaplay",
                       {"collection_complete": True, "is_partial": False})
    cell = _status_at(monkeypatch, tmp_path, "20260511", "005930",
                      dt.datetime(2026, 5, 20, 18, 0, tzinfo=_KST))
    assert cell["status"] == "complete"


def test_calendar_kiwoom_live_incomplete_shows_none(monkeypatch, tmp_path):
    """kiwoom_live not finalized (CLIENT_INCOMPLETE) → 'none' (✕ noise removed)."""
    _write_source_meta(tmp_path, "20260518", "005930", "kiwoom_live",
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
    """커버리지 끝을 넘는 달은 None. 재시도해도 달라지지 않는다.

    **사유는 세우지 않는다.** 커버리지 밖은 사건이 아니라 소스의 성질이라
    (`ka20006` 역산은 미래를 못 준다) 여기에 사유를 세우면 `get_month_map` 이
    미래 달마다 경고를 실어 보낸다 — 캡처 폼의 오른쪽 그리드가 항상 +1개월이라
    배너가 상시 점등됐다.
    """
    _stub_source(monkeypatch, _MAY_2026_TRADING_DAYS)
    assert calendar_module._trading_days_for(2026, 5) is not None
    assert calendar_module._trading_days_for(2027, 1) is None
    assert calendar_module.last_failure_reason() is None


def test_trading_days_for_sets_reason_only_when_source_absent(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """사유를 세우는 경로는 **시드 부재 하나뿐**이다.

    그 결과 사유가 프로세스 전역이어도 경합이 없다 — 소스가 없으면 모든 스레드가
    같은 값을 쓰고, 있으면 아무도 세우지 않는다. 예전에는 커버리지 밖 달과
    커버리지 안 달이 스레드풀에서 서로의 사유를 덮었다(좌/우 그리드 동시 요청).
    """
    _stub_source(monkeypatch, set())
    assert calendar_module._trading_days_for(2026, 5) is None
    assert calendar_module.last_failure_reason() == UpstreamCode.TRADING_DAYS_UNAVAILABLE


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
    after_first = len(calls)
    assert calendar_module.is_trading_session_today("20260605") is True
    # **증분으로 잰다.** 첫 호출은 커버리지 검사 + 월 조회로 소스를 두 번 읽는다
    # (부분 커버 달 회귀 수정, 2026-08-04). 이 테스트가 지키는 성질은 "확정된
    # 세션은 다시 조회하지 않는다" 이므로 절대 횟수가 아니라 증분이 맞다.
    assert len(calls) == after_first, "확정 양성은 소스를 다시 읽지 않는다"


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
    """추측한 날짜 목록으로 진행하지 않는다 — enqueue 경로는 fail-fast 다.

    사유는 STALE(커버리지 부족)이지 UNAVAILABLE(소스 부재)이 아니다. 조치가 다르다:
    종료일을 앞당기면 되는 것과, 서버 설치를 고쳐야 하는 것.
    """
    _stub_source(monkeypatch, _MAY_2026_TRADING_DAYS)
    assert calendar_module.trading_days_in_range("20260501", "20260508")
    with pytest.raises(calendar_module.TradingDayUnavailableError) as exc:
        calendar_module.trading_days_in_range("20260501", "20270108")
    assert exc.value.code == UpstreamCode.TRADING_DAYS_STALE


def test_trading_days_in_range_distinguishes_absent_source(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """소스를 못 읽으면 UNAVAILABLE — 종료일을 앞당겨도 낫지 않는다."""
    _stub_source(monkeypatch, set())
    with pytest.raises(calendar_module.TradingDayUnavailableError) as exc:
        calendar_module.trading_days_in_range("20260501", "20260508")
    assert exc.value.code == UpstreamCode.TRADING_DAYS_UNAVAILABLE


# ---------------------------------------------------------------------------
# get_month_map 의 커버리지 계약
#
# `_trading_days_for` 는 **월 단위**라 부분 커버 달을 못 가른다 — 커버리지가 5/15
# 까지인 5월은 비어 있지 않은 집합을 돌려주고, 그러면 5/18 이후가 전부 "휴장" 으로
# **확정**된다. `5db711f9`(#1044 회귀)가 라이브 세션 게이트에서 고친 함정이 달력
# 셀에는 그대로 남아 있었다. 아래 셋이 세 갈래를 각각 못 박는다.
# ---------------------------------------------------------------------------

_KST = dt.timezone(dt.timedelta(hours=9))


def _month_map(monkeypatch, tmp_path: Path, *, now: dt.datetime, year: int, month: int):
    monkeypatch.setattr("hoga.api.calendar._now_kst", lambda: now, raising=False)
    return calendar_module.get_month_map(
        data_dir=tmp_path, code="005930", year=year, month=month,
    )


def test_month_map_future_month_carries_no_reason(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _reset_calendar_state: None,
) -> None:
    """미래 달은 **경고할 게 없다** — 모든 셀이 `future` 라 거래일 여부를 주장하지 않는다.

    캡처 폼의 `DateRangePicker` 는 항상 두 달(현재 + 다음)을 그리고, 배너는
    `left.reason ?? right.reason` 이다. 다음 달은 구조적으로 항상 커버리지 밖이라
    여기서 사유를 내면 배너가 **영구 점등**된다(실측 2026-08-04).
    """
    _stub_source(monkeypatch, _MAY_2026_TRADING_DAYS)
    resp = _month_map(monkeypatch, tmp_path,
                      now=dt.datetime(2026, 5, 20, 10, 0, tzinfo=_KST), year=2026, month=7)
    assert resp.reason is None
    assert {c.status for c in resp.cells} == {"future"}


def test_month_map_past_beyond_coverage_is_not_holiday(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _reset_calendar_state: None,
) -> None:
    """**경계에서 자른다** — 커버리지 안은 정확한 휴장일, 그 뒤는 평일 근사 + 경고.

    커버리지 밖을 `holiday` 로 단정하면 진짜 거래일이 **선택조차 불가능**해진다.
    모르는 것은 근사하고, 근사했다고 말한다.
    """
    covered = {d for d in _MAY_2026_TRADING_DAYS if d <= "20260515"}
    _stub_source(monkeypatch, covered)
    resp = _month_map(monkeypatch, tmp_path,
                      now=dt.datetime(2026, 5, 20, 17, 0, tzinfo=_KST), year=2026, month=5)
    status = {c.date: c.status for c in resp.cells}

    # 커버리지 안의 진짜 휴장일(어린이날)은 그대로 확정된다.
    assert status["20260505"] == "holiday"
    # 커버리지 밖 과거 평일은 "휴장" 이 아니라 "미수집" 이다 — 캡처를 걸 수 있다.
    assert status["20260518"] == "none"
    assert status["20260519"] == "none"
    # 주말은 근사와 무관하게 주말이다.
    assert status["20260516"] == "weekend"
    assert resp.reason == UpstreamCode.TRADING_DAYS_STALE


def test_month_map_today_alone_beyond_coverage_is_quiet(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _reset_calendar_state: None,
) -> None:
    """**오늘은 구조적으로 항상 커버리지 밖**이라 경고 근거가 될 수 없다.

    `ka20006` 은 장이 끝나야 오늘 행을 준다. 오늘을 근거로 경고하면 정상 운영에서
    매일 배너가 뜬다 — 경고는 "알았어야 하는 과거 날짜를 못 안다" 일 때만 뜬다.
    """
    covered = {d for d in _MAY_2026_TRADING_DAYS if d <= "20260519"}
    _stub_source(monkeypatch, covered)
    resp = _month_map(monkeypatch, tmp_path,
                      now=dt.datetime(2026, 5, 20, 10, 0, tzinfo=_KST), year=2026, month=5)
    assert resp.reason is None


def test_month_map_absent_source_reports_unavailable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _reset_calendar_state: None,
) -> None:
    """소스 부재는 커버리지 부족과 **조치가 다르다** — 사유도 다르다."""
    _stub_source(monkeypatch, set())
    resp = _month_map(monkeypatch, tmp_path,
                      now=dt.datetime(2026, 5, 20, 17, 0, tzinfo=_KST), year=2026, month=5)
    assert resp.reason == UpstreamCode.TRADING_DAYS_UNAVAILABLE


def test_reset_cache_clears_last_failure_reason(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    _stub_source(monkeypatch, set())
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


