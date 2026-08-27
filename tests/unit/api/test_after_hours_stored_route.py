"""창 밖 시간외 조회 — 저장본을 내주는 경로.

18:00 이 지나면 `ka10087` 이 답하지 않고 그 호가는 링버퍼에도 없다. 이 경로가
**저녁에 그날 시간외를 볼 수 있는 유일한 수단**이라, 여기서 조용히 비면 사용자에겐
"저장 기능이 없는 것" 과 구별되지 않는다.
"""
from __future__ import annotations

from pathlib import Path

from hoga.live.after_hours_store import StoredAfterHoursBook, save_cycle
from hoga.live.api import AfterHoursBookResponse, _stored_after_hours_response

DAY = "20260827"


def _stored(code: str = "005930") -> StoredAfterHoursBook:
    return StoredAfterHoursBook(
        code=code,
        ask=((2000, 50), (2010, 60), (0, 0), (0, 0), (0, 0)),
        bid=((1990, 80), (0, 0), (0, 0), (0, 0), (0, 0)),
        total_ask_qty=110,
        total_bid_qty=80,
        cur_price=1995,
        close_price=1995,
        acc_volume=12_345,
        base_tm="160000",
        fetched_at_ms=1_787_000_000_000,
    )


def _seed(tmp_path: Path, monkeypatch, *, day: str = DAY) -> None:
    save_cycle(tmp_path, day, {"005930": _stored()})
    monkeypatch.setattr("hoga.live.api.today_kst_yyyymmdd", lambda: DAY)


def test_serves_the_stored_book_outside_the_window(tmp_path, monkeypatch) -> None:
    _seed(tmp_path, monkeypatch)
    res = _stored_after_hours_response("005930", tmp_path)
    assert res.active is True
    assert res.source == "stored"
    assert res.fetched_at_ms == 1_787_000_000_000
    assert [(lv.price, lv.qty) for lv in res.ask[:2]] == [(2000, 50), (2010, 60)]
    assert res.total_bid_qty == 80
    assert res.close_price == 1995


def test_source_distinguishes_stored_from_live(tmp_path, monkeypatch) -> None:
    """`source` 가 판별 필드다 — 프론트는 이 값으로 폴링 여부와 문구를 정한다."""
    _seed(tmp_path, monkeypatch)
    assert _stored_after_hours_response("005930", tmp_path).source == "stored"
    # 기본값(벤더 실시간 경로)은 여전히 'kiwoom' 이다.
    assert AfterHoursBookResponse(code="005930", active=False).source == "kiwoom"


def test_no_stored_book_is_inactive_not_error(tmp_path, monkeypatch) -> None:
    _seed(tmp_path, monkeypatch)
    res = _stored_after_hours_response("000660", tmp_path)
    assert res.active is False
    assert res.ask == []


def test_yesterday_file_is_not_served_today(tmp_path, monkeypatch) -> None:
    """자정을 넘기면 조회가 빈다 — "장중 시간외 = 없음" 정책이 여기서 파생된다.

    날짜 조건을 따로 쓰지 않는다: 오늘 파일만 읽으므로 저절로 그렇게 된다.
    """
    save_cycle(tmp_path, "20260826", {"005930": _stored()})
    monkeypatch.setattr("hoga.live.api.today_kst_yyyymmdd", lambda: DAY)
    assert _stored_after_hours_response("005930", tmp_path).active is False


def test_missing_data_dir_is_inactive(tmp_path, monkeypatch) -> None:
    """무자격·미배선 환경에서도 500 이 아니라 "없음" 이다."""
    monkeypatch.setattr("hoga.live.api.today_kst_yyyymmdd", lambda: DAY)
    assert _stored_after_hours_response("005930", None).active is False


def test_stored_payload_survives_response_model(tmp_path, monkeypatch) -> None:
    """⚠ `response_model` 은 선언되지 않은 키를 **에러 없이 버린다**(CLAUDE.md).

    라우트 함수를 직접 부르는 테스트는 그 단계를 건너뛰므로, 여기서만 모델을 한 번
    더 통과시켜 필드가 살아남는지 잰다.
    """
    _seed(tmp_path, monkeypatch)
    res = _stored_after_hours_response("005930", tmp_path)
    dumped = AfterHoursBookResponse.model_validate(res.model_dump()).model_dump()
    assert dumped["source"] == "stored"
    assert dumped["fetched_at_ms"] == 1_787_000_000_000
    assert dumped["total_ask_qty"] == 110
    assert len(dumped["ask"]) == 5


def test_expected_and_fills_are_empty_by_design(tmp_path, monkeypatch) -> None:
    """저장하지 않는다 — 체결이 끝난 뒤의 "예상" 은 의미가 없고, 그 값을 담으려면
    폴러가 `ka10001` 까지 쳐야 하는데 그건 상하한가 조회와 같은 TR 이다."""
    _seed(tmp_path, monkeypatch)
    res = _stored_after_hours_response("005930", tmp_path)
    assert res.exp_price is None
    assert res.exp_qty is None
    assert res.fills == []
