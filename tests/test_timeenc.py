"""Unix-ms ↔ hogaplay intra-day encodings, per ADR 0003."""
from datetime import datetime

from hoga.util import timeenc
from hoga.util.timeenc import (
    _date_unix_ms_at_kst_midnight,
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
    unix_ms_to_hhmmssms,
    unix_ms_to_ms_from_midnight,
)


def _clear_date_cache() -> None:
    """캐시가 있으면 비운다. 없으면 무동작 — 캐시 부재는 **단언**이 말하게 둔다.

    직접 `cache_clear()` 를 부르면 캐시가 사라졌을 때 AttributeError 로 먼저 죽어서
    실패 메시지가 "파싱을 13회 했다" 가 아니라 "속성이 없다" 가 된다. 가드는 무엇이
    깨졌는지 말해야 값이 있다.
    """
    getattr(_date_unix_ms_at_kst_midnight, "cache_clear", lambda: None)()


def test_hhmmssms_round_trip_at_open():
    # 2026-05-18 09:00:00.000 KST = 2026-05-18 00:00:00.000 UTC
    unix_ms = hhmmssms_to_unix_ms("20260518", 90000000)
    assert unix_ms == 1779062400000
    assert unix_ms_to_hhmmssms("20260518", unix_ms) == 90000000


def test_hhmmssms_round_trip_at_close():
    unix_ms = hhmmssms_to_unix_ms("20260518", 153000000)
    # 15:30 KST = 06:30 UTC
    assert unix_ms == 1779062400000 + 23400000  # +6h30m
    assert unix_ms_to_hhmmssms("20260518", unix_ms) == 153000000


def test_ms_from_midnight_to_unix_at_open():
    # 09:00 = 32_400_000 ms from midnight (9 hours)
    unix_ms = ms_from_midnight_to_unix_ms("20260518", 32_400_000)
    assert unix_ms == 1779062400000


def test_ms_from_midnight_to_unix_at_premarket():
    # 08:30 = 30_600_000 ms (matches the chart.tsv fixture)
    unix_ms = ms_from_midnight_to_unix_ms("20260518", 30_600_000)
    assert unix_ms == 1779062400000 - 1800000  # 30 min before 09:00 KST


def test_unix_ms_to_ms_from_midnight_inverts():
    # ADR-0109: KIS 분봉(Unix ms) → candles.parquet(자정 기준 ms) 왕복.
    for intra_ms in (0, 30_600_000, 32_400_000, 55_800_000):
        unix_ms = ms_from_midnight_to_unix_ms("20260518", intra_ms)
        assert unix_ms_to_ms_from_midnight("20260518", unix_ms) == intra_ms


def test_date_is_parsed_once_per_date(monkeypatch):
    """날짜 파싱은 **날짜당 1회**여야 한다 (`_date_unix_ms_at_kst_midnight` 의 캐시).

    이 함수는 두 진입점을 통해 **행마다** 불린다. 캐시가 사라지면 파싱 횟수가 행
    수만큼 늘고, 실측상 그게 `/api/range` mode=sidecar wall 의 62% 였다 —
    근거 수치는 `timeenc._date_unix_ms_at_kst_midnight` 주석.

    ⚠ 벽시계 비율이 아니라 **호출 횟수**로 고정한다. 비율 단언은 머신 부하로 흔들려
    간헐 실패하고, 그러면 가드가 무시되기 시작한다(#977 이 그 정리였다).

    이 테스트가 닫는 방향: **캐시 제거**(파싱이 행마다로 돌아감). 못 보는 것: 캐시가
    있어도 호출부가 날짜를 매 행 새 문자열로 만들면(예: f-string 재조립) 히트율이
    떨어지는 경우 — 그건 호출부 쪽 성질이라 여기서 안 보인다.
    """
    real_strptime = datetime.strptime
    parsed: list[str] = []

    class CountingDatetime:
        @staticmethod
        def strptime(value: str, fmt: str):
            parsed.append(value)
            return real_strptime(value, fmt)

    _clear_date_cache()
    monkeypatch.setattr(timeenc, "datetime", CountingDatetime)

    for intra_ms in range(0, 10_000, 1_000):            # 같은 날짜 10행
        ms_from_midnight_to_unix_ms("20260518", intra_ms)
    for hhmmssms in (90000000, 90001000, 90002000):     # 같은 날짜 3행 — 다른 진입점
        hhmmssms_to_unix_ms("20260518", hhmmssms)
    ms_from_midnight_to_unix_ms("20260519", 0)          # 다른 날짜 1행

    assert parsed == ["20260518", "20260519"], (
        f"날짜 파싱이 {len(parsed)}회 — 날짜당 1회여야 한다. 캐시가 사라졌나?"
    )

    _clear_date_cache()
