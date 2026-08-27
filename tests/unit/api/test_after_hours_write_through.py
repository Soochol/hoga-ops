"""시간외 호가 write-through — 라우트가 **지나가는 응답을 적는다**.

주기적으로 훑는 레코더가 있었다가 없앴다(2026-08-27). 프론트가 이미 5초마다
`ka10087` 을 치는데 그 응답을 아무도 저장하지 않아서, 저장하려고 **또** 치는
구조였다(2시간 13,320콜 중 98.3% 폐기). 여기서 재는 것은 둘이다:

1. 지나가는 응답이 실제로 남는가
2. **캐시 히트를 다시 쓰지 않는가** — 프론트 5초 · fetcher TTL 3초라 같은 값이
   되돌아오는데, 그때마다 쓰면 아무것도 바뀌지 않은 채 I/O 만 는다
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.live import api as live_api
from hoga.live.after_hours_store import load_book

DAY = "20260827"


@dataclass
class _Level:
    price: int
    qty: int


@dataclass
class _Book:
    code: str = "005930"
    ask: tuple = ()
    bid: tuple = ()
    total_ask_qty: int = 110
    total_bid_qty: int = 80
    cur_price: int | None = 1995
    close_price: int | None = 1995
    change_pct: float | None = 0.0
    acc_volume: int = 12_345
    base_tm: str | None = "160000"

    @property
    def has_quotes(self) -> bool:
        return any(lv.qty > 0 for lv in (*self.ask, *self.bid))


def _book() -> _Book:
    return _Book(
        ask=(_Level(2000, 50), _Level(2010, 60)),
        bid=(_Level(1990, 80),),
    )


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    live_api._last_saved_after_hours_at.clear()
    monkeypatch.setattr(live_api.after_hours_store, "today_kst_yyyymmdd", lambda: DAY)
    yield
    live_api._last_saved_after_hours_at.clear()


def test_response_is_written_through(tmp_path: Path) -> None:
    live_api._save_after_hours_book("005930", _book(), 1_787_000_000_000, tmp_path)
    saved = load_book(tmp_path, DAY, "005930")
    assert saved is not None
    assert saved.ask[0] == (2000, 50)
    assert saved.total_bid_qty == 80
    assert saved.fetched_at_ms == 1_787_000_000_000


def test_cache_hit_is_not_rewritten(tmp_path: Path, monkeypatch) -> None:
    """⚠ 같은 `fetched_at_ms` 는 fetcher 캐시 히트다 — 다시 쓸 이유가 없다."""
    writes: list[int] = []
    real = live_api.after_hours_store.save_books

    def counting(dd, day, books):
        writes.append(len(books))
        real(dd, day, books)

    monkeypatch.setattr(live_api.after_hours_store, "save_books", counting)
    for _ in range(5):  # 프론트가 5초마다 5번 물었고 전부 캐시 히트였다
        live_api._save_after_hours_book("005930", _book(), 1_787_000_000_000, tmp_path)
    assert writes == [1], f"캐시 히트인데 {len(writes)}회 썼다"


def test_new_observation_is_written(tmp_path: Path, monkeypatch) -> None:
    writes: list[int] = []
    real = live_api.after_hours_store.save_books

    def counting(dd, day, books):
        writes.append(len(books))
        real(dd, day, books)

    monkeypatch.setattr(live_api.after_hours_store, "save_books", counting)
    live_api._save_after_hours_book("005930", _book(), 1_787_000_000_000, tmp_path)
    live_api._save_after_hours_book("005930", _book(), 1_787_000_005_000, tmp_path)
    assert len(writes) == 2
    assert load_book(tmp_path, DAY, "005930").fetched_at_ms == 1_787_000_005_000


def test_codes_accumulate_across_calls(tmp_path: Path) -> None:
    """병합이라 종목이 쌓인다 — 라우트는 한 번에 한 종목만 적기 때문이다."""
    live_api._save_after_hours_book("005930", _book(), 1, tmp_path)
    live_api._save_after_hours_book("000660", _book(), 2, tmp_path)
    assert load_book(tmp_path, DAY, "005930") is not None
    assert load_book(tmp_path, DAY, "000660") is not None


def test_missing_data_dir_is_noop(tmp_path: Path) -> None:
    """무자격·미배선 환경에서 저장이 없다고 라우트가 죽으면 안 된다."""
    live_api._save_after_hours_book("005930", _book(), 1, None)  # 예외 없이 반환


def test_write_failure_does_not_propagate(tmp_path: Path, monkeypatch) -> None:
    """저장은 이 라우트의 **부수 효과**다 — 디스크가 꽉 찼다고 화면이 죽어선 안 된다."""
    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(live_api.after_hours_store, "save_books", boom)
    live_api._save_after_hours_book("005930", _book(), 1, tmp_path)  # 예외 없이 반환
    # 실패했으므로 "적었다" 고 기록해서도 안 된다 — 다음 시도가 다시 써야 한다.
    assert "005930" not in live_api._last_saved_after_hours_at
