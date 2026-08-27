"""시간외 마지막 호가 레코더 — 창 게이트·격리·병합을 잰다.

이 루프가 없으면 18:00 이후 시간외 조회가 통째로 빈다(그 구간에 `ka10087` 이 답하지
않고, 저장하는 주체가 아무도 없다). 그래서 "언제 도는가" 와 "실패해도 남는가" 가
이 태스크의 계약이다.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.live import lifecycle
from hoga.live.after_hours_store import load_book, stored_codes


@dataclass
class _Level:
    price: int
    qty: int


@dataclass
class _Book:
    code: str
    ask: tuple
    bid: tuple
    total_ask_qty: int = 180
    total_bid_qty: int = 170
    cur_price: int | None = 1995
    close_price: int | None = 1995
    acc_volume: int = 12_345
    base_tm: str | None = "160000"

    @property
    def has_quotes(self) -> bool:
        return any(lv.qty > 0 for lv in (*self.ask, *self.bid))


@dataclass
class _View:
    book: _Book
    fetched_at_ms: int = 1_787_000_000_000


def _view(code: str, *, empty: bool = False) -> _View:
    qty = 0 if empty else 50
    return _View(
        book=_Book(
            code=code,
            ask=(_Level(0 if empty else 2000, qty), _Level(0, 0)),
            bid=(_Level(0 if empty else 1990, qty), _Level(0, 0)),
        )
    )


async def _run_one_cycle(
    tmp_path: Path,
    *,
    codes: list[str],
    fetch,
    in_window: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """루프를 한 주기만 돌린다 — `interval_s` 를 길게 잡고 즉시 취소."""
    monkeypatch.setattr(
        lifecycle, "is_after_hours_single_price_window", lambda _t: in_window
    )
    monkeypatch.setattr(lifecycle, "today_kst_yyyymmdd", lambda: "20260827")
    task = lifecycle.start_after_hours_recorder(
        tmp_path,
        get_codes=lambda: codes,
        fetch=fetch,
        interval_s=3600.0,
        code_gap_s=0.0,
    )
    # 첫 주기가 끝날 때까지만 양보한다(sleep(interval) 에 들어가면 완료).
    for _ in range(50):
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_records_inside_the_window(tmp_path, monkeypatch):
    async def fetch(code):
        return _view(code)

    await _run_one_cycle(
        tmp_path, codes=["005930", "000660"], fetch=fetch, in_window=True, monkeypatch=monkeypatch
    )
    assert stored_codes(tmp_path, "20260827") == ("000660", "005930")
    saved = load_book(tmp_path, "20260827", "005930")
    assert saved is not None
    assert saved.ask[0] == (2000, 50)
    assert saved.fetched_at_ms == 1_787_000_000_000


async def test_does_not_touch_the_vendor_outside_the_window(tmp_path, monkeypatch):
    """창 밖에서는 **한 건도** 치지 않는다 — 장중 유량을 태우지 않기 위한 방어선이다."""
    calls: list[str] = []

    async def fetch(code):
        calls.append(code)
        return _view(code)

    await _run_one_cycle(
        tmp_path, codes=["005930"], fetch=fetch, in_window=False, monkeypatch=monkeypatch
    )
    assert calls == []
    assert stored_codes(tmp_path, "20260827") == ()


async def test_one_failure_does_not_stop_the_rest(tmp_path, monkeypatch):
    async def fetch(code):
        if code == "005930":
            raise RuntimeError("vendor 502")
        return _view(code)

    await _run_one_cycle(
        tmp_path, codes=["005930", "000660"], fetch=fetch, in_window=True, monkeypatch=monkeypatch
    )
    assert stored_codes(tmp_path, "20260827") == ("000660",)


async def test_empty_book_is_not_stored(tmp_path, monkeypatch):
    """전 단계가 0 = 그 종목에 시간외 주문이 없다. 저장하면 저녁 조회가
    "있는데 비었다" 로 보인다 — 라우트의 `has_quotes` 판정과 같은 규율."""

    async def fetch(code):
        return _view(code, empty=True)

    await _run_one_cycle(
        tmp_path, codes=["005930"], fetch=fetch, in_window=True, monkeypatch=monkeypatch
    )
    assert stored_codes(tmp_path, "20260827") == ()


async def test_no_codes_writes_nothing(tmp_path, monkeypatch):
    async def fetch(code):  # pragma: no cover — 불려선 안 된다
        raise AssertionError("빈 목록인데 fetch 가 불렸다")

    await _run_one_cycle(
        tmp_path, codes=[], fetch=fetch, in_window=True, monkeypatch=monkeypatch
    )
    assert stored_codes(tmp_path, "20260827") == ()


async def test_pacing_applies_on_the_empty_book_path(tmp_path, monkeypatch):
    """⚠ 간격이 **빈 사다리 경로에도** 걸려야 한다.

    대부분의 종목에 시간외 주문이 없어 빈 사다리가 정상이다. 간격이 저장 직전에만
    있으면 그 종목들은 HTTP 지연(실측 30~170ms)만으로 연달아 나가고, 초당 5~10콜이
    되어 `ka10087` 버킷 상한(5/s)을 넘는다. 이 fetcher 는 거버너를 타지 않으므로
    (직접 httpx) 페이싱이 여기서 빠지면 어디에도 없다.
    """
    gaps: list[float] = []
    real_sleep = asyncio.sleep

    async def spy(delay: float) -> None:
        gaps.append(delay)
        # 주기 sleep(=interval_s)은 진짜로 재워 **한 주기만** 돌게 한다. 즉시
        # 반환시키면 루프가 계속 돌아 개수 단언이 무의미해진다.
        # 60초 이상이면 주기 sleep, 아니면 종목 간 간격이다.
        await real_sleep(3600 if delay >= 60 else 0)

    monkeypatch.setattr(asyncio, "sleep", spy)

    async def fetch(code):
        return _view(code, empty=True)  # 전부 빈 사다리 = 흔한 경로

    monkeypatch.setattr(
        lifecycle, "is_after_hours_single_price_window", lambda _t: True
    )
    monkeypatch.setattr(lifecycle, "today_kst_yyyymmdd", lambda: "20260827")
    task = lifecycle.start_after_hours_recorder(
        tmp_path,
        get_codes=lambda: ["005930", "000660", "035720"],
        fetch=fetch,
        interval_s=3600.0,
        code_gap_s=0.25,
    )
    for _ in range(50):
        await real_sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # 3 종목 → 간격 2회(첫 종목 앞에서는 기다리지 않는다).
    assert gaps.count(0.25) == 2
    # 그리고 저장할 것은 없다(전부 빈 사다리) — 페이싱과 저장 판정은 독립이다.
    assert stored_codes(tmp_path, "20260827") == ()
