"""거래일 달력 소스 테스트 (#1044, PR-H).

시드는 **실제 커밋된 파일**을 쓴다 — 그게 프로덕션이 읽는 것과 같은 파일이고,
페이크로 갈아끼우면 "시드가 실제로 맞는가" 를 아무도 안 보게 된다.
"""
from __future__ import annotations

import datetime

import pytest

from hoga.api import trading_days as td


@pytest.fixture(autouse=True)
def _clean():
    td.reset_for_tests()
    yield
    td.reset_for_tests()


# === 커밋된 시드 자체의 성질 =================================================

def test_seed_has_no_weekends() -> None:
    """주말이 섞이면 역산이 깨진 것이다 — `ka20006` 은 거래일에만 행이 있다."""
    days = td.trading_days()
    weekend = [
        d for d in days
        if datetime.date(int(d[:4]), int(d[4:6]), int(d[6:8])).weekday() >= 5
    ]
    assert weekend == []


def test_seed_marks_fixed_holidays_as_non_trading() -> None:
    """날짜가 고정된 공휴일 — 매년 반드시 휴장이다.

    **커버리지 안의 날짜만 고른다.** 처음엔 `20260815`(광복절)를 넣었다가
    `None` 이 나왔는데, 그게 정답이었다 — 시드가 20260803 까지라 그 뒤는 모르는
    것이 맞다. 이 테스트가 보는 것은 "휴장을 휴장이라고 답하는가" 이므로 두
    관심사를 섞지 않는다(커버리지 밖은 아래 테스트가 따로 본다).
    """
    for holiday in ("20250101", "20260101", "20251225", "20250815", "20240815"):
        assert td.is_trading_day(holiday) is False, holiday


def test_seed_year_counts_are_plausible() -> None:
    """연 242~253 거래일. 벗어나면 페이지가 빠졌거나 겹쳤다는 신호다."""
    import collections

    per_year = collections.Counter(d[:4] for d in td.trading_days())
    full_years = {y: n for y, n in per_year.items() if "2007" <= y <= "2025"}
    assert full_years, "시드가 비었다"
    assert all(242 <= n <= 253 for n in full_years.values()), full_years


def test_seed_covers_back_to_2007() -> None:
    days = td.trading_days()
    assert min(days) < "20070201", "2007년 초까지 덮어야 한다"


# === 커버리지 밖은 False 가 아니라 None ======================================

def test_beyond_coverage_is_unknown_not_non_trading() -> None:
    """**여기서 False 를 내면 조용히 틀린다.**

    진짜 거래일이 "휴장" 으로 읽혀 빈 캔들이 진실처럼 그려진다. 시드는 커밋
    시점까지만 덮으므로 그 뒤는 정직하게 모른다고 답해야 하고, 오버레이가
    그 경계를 하루씩 민다.
    """
    end = max(td.trading_days())
    year = int(end[:4]) + 5
    assert td.is_trading_day(f"{year}0601") is None


def test_inside_coverage_answers_definitively() -> None:
    assert td.is_trading_day("20260803") is True
    assert td.is_trading_day("20260802") is False   # 일요일


# === 오버레이 ================================================================

def test_overlay_extends_coverage(tmp_path) -> None:
    end = max(td.trading_days())
    future = f"{int(end[:4]) + 1}0302"
    assert td.is_trading_day(future, tmp_path) is None

    assert td.append_overlay(tmp_path, [future]) == 1
    assert td.is_trading_day(future, tmp_path) is True


def test_overlay_never_duplicates_seed_days(tmp_path) -> None:
    known = sorted(td.trading_days())[:3]
    assert td.append_overlay(tmp_path, known) == 0
    assert not td.overlay_path(tmp_path).exists(), "쓸 것이 없으면 파일도 만들지 않는다"


def test_overlay_reload_follows_mtime(tmp_path) -> None:
    """**한 번 읽고 캐시해 버리면 그 프로세스는 새 거래일을 영원히 모른다.**

    systemd 상시 운영이라 프로세스가 하루를 넘겨 사는 것이 정상이다.
    """
    end = max(td.trading_days())
    d1, d2 = f"{int(end[:4]) + 1}0302", f"{int(end[:4]) + 1}0303"
    td.append_overlay(tmp_path, [d1])
    assert td.is_trading_day(d1, tmp_path) is True

    # 캐시를 데운 뒤 파일이 자란다 — 스케줄러가 덧붙이는 상황.
    path = td.overlay_path(tmp_path)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(d2 + "\n")
    import os
    st = path.stat()
    os.utime(path, (st.st_atime, st.st_mtime + 1))   # mtime 해상도 회피

    assert td.is_trading_day(d2, tmp_path) is True, "mtime 이 바뀌면 다시 읽어야 한다"


def test_no_data_dir_still_answers_from_seed() -> None:
    """오버레이가 없어도 시드만으로 답한다 — 자격증명도 data_dir 도 필요 없다."""
    assert td.is_trading_day("20260803", None) is True


# === 파서 ====================================================================

def test_parser_ignores_comments_and_blank_lines() -> None:
    got = td.parse_seed("# 주석\n\n20260803\n  20260731  \nnot-a-date\n2026080\n")
    assert got == frozenset({"20260803", "20260731"})
