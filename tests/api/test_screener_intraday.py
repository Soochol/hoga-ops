import asyncio
import datetime as dt
from dataclasses import dataclass
from pathlib import Path

import polars as pl
import pytest

from hoga.api import screener_intraday, screener_universe
from hoga.api.models import ScreenerUniverse


@dataclass(frozen=True)
class Quote:
    code: str
    price: int
    change_pct: float | None = None
    change_won: int | None = None
    open: int | None = None
    high: int | None = None
    low: int | None = None
    volume: int | None = None


class FakeKis:
    def __init__(self, quotes):
        self.quotes = quotes
        self.calls = 0
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def fetch_multi_price(self, codes):
        self.calls += 1
        self.started.set()
        await asyncio.sleep(0)
        return [q for q in self.quotes if q.code in codes]


def _patch_scheduler(monkeypatch, fake: FakeKis, calls: list[dict] | None = None) -> None:
    monkeypatch.setattr(screener_intraday.kis_access, "has_rest_capacity", lambda data_dir: True)
    monkeypatch.setattr(screener_intraday, "ensure_kis_capacity_scheduler", lambda data_dir: object())

    async def fake_run_with_capacity(
        scheduler,
        *,
        data_dir,
        key,
        endpoint,
        priority,
        fetch_fn,
        cooldown_scope=None,
    ):
        if calls is not None:
            calls.append({
                "scheduler": scheduler,
                "data_dir": data_dir,
                "key": key,
                "endpoint": str(endpoint),
                "priority": priority,
                "cooldown_scope": cooldown_scope,
            })
        return await fetch_fn(fake)

    monkeypatch.setattr(screener_intraday.kis_access, "run_with_capacity", fake_run_with_capacity)


def _write_stocks(path: Path) -> None:
    pl.DataFrame({
        "code": ["000111", "000222", "000333"],
        "name": ["a", "b", "c"],
        "market": ["KOSPI", "KOSDAQ", "KOSPI"],
        "is_etf": [False, False, True],
        "is_halted": [False, True, False],
    }).write_parquet(path)


def test_codes_for_universe_applies_screener_universe(tmp_path: Path):
    stocks = tmp_path / "stocks.parquet"
    _write_stocks(stocks)

    codes = screener_universe.codes_for_universe(
        stocks,
        ScreenerUniverse(markets=["KOSPI"], exclude_etf=True, exclude_halted=True),
    )

    assert codes == ["000111"]


@pytest.mark.asyncio
async def test_build_intraday_overlay_creates_daily_rows(monkeypatch, tmp_path: Path):
    fake = FakeKis([
        Quote("000111", price=109, open=100, high=110, low=99, volume=1234),
        Quote("000222", price=0, open=0, high=0, low=0, volume=0),
    ])
    calls = []
    _patch_scheduler(monkeypatch, fake, calls)

    overlay = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path,
        codes=["000111", "000222"],
        today="20260625",
        now_ms=1_000,
        ttl_ms=15_000,
    )

    assert overlay.fetched_at_ms == 1_000
    assert overlay.rows.height == 1
    row = overlay.rows.to_dicts()[0]
    assert row["code"] == "000111"
    assert row["date"] == dt.date(2026, 6, 25)
    assert row["close"] == 109.0
    assert row["high"] == 110.0
    assert row["volume"] == 1234
    assert "intraday_quote_invalid" in overlay.warnings
    assert calls == [{
        "scheduler": calls[0]["scheduler"],
        "data_dir": tmp_path,
        "key": ("screener-intraday", "20260625", ("000111", "000222")),
        "endpoint": "quotes",
        "priority": "background",
        "cooldown_scope": "quotes:KRX",
    }]


@pytest.mark.asyncio
async def test_build_intraday_overlay_warns_when_volume_is_unavailable(monkeypatch, tmp_path: Path):
    fake = FakeKis([Quote("000111", price=109, open=100, high=110, low=99, volume=None)])
    _patch_scheduler(monkeypatch, fake)

    overlay = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path,
        codes=["000111"],
        today="20260625",
        now_ms=1_000,
        ttl_ms=15_000,
    )

    assert overlay.rows.height == 0
    assert "intraday_volume_unavailable" in overlay.warnings


@pytest.mark.asyncio
async def test_build_intraday_overlay_reuses_ttl_cache(monkeypatch, tmp_path: Path):
    fake = FakeKis([Quote("000111", price=109, open=100, high=110, low=99, volume=1234)])
    _patch_scheduler(monkeypatch, fake)

    first = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=1_000, ttl_ms=15_000,
    )
    second = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=2_000, ttl_ms=15_000,
    )

    assert fake.calls == 1
    assert first.rows.to_dicts() == second.rows.to_dicts()


@pytest.mark.asyncio
async def test_build_intraday_overlay_singleflights_concurrent_fetches(monkeypatch, tmp_path: Path):
    fake = FakeKis([Quote("000111", price=109, open=100, high=110, low=99, volume=1234)])
    _patch_scheduler(monkeypatch, fake)

    first, second = await asyncio.gather(
        screener_intraday.build_intraday_overlay(
            data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=1_000, ttl_ms=15_000,
        ),
        screener_intraday.build_intraday_overlay(
            data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=1_000, ttl_ms=15_000,
        ),
    )

    assert fake.calls == 1
    assert first.rows.to_dicts() == second.rows.to_dicts()
