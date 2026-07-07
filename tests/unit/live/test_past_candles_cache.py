from __future__ import annotations

import datetime as dt

from hoga.live.past_candles_cache import PastCandlesCache


def _kst_ms(date_yyyymmdd: str) -> int:
    kst = dt.timezone(dt.timedelta(hours=9))
    d = dt.datetime.strptime(date_yyyymmdd, "%Y%m%d").replace(hour=9, tzinfo=kst)
    return int(d.timestamp() * 1000)


def _bar(date_s: str) -> list[dict]:
    return [{"t_ms": _kst_ms(date_s), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}]


def test_default_capacity_survives_two_symbol_deep_walkback(tmp_path) -> None:
    """250일 워크백(_PAST_MAX_DAYS) × 2종목 + 60일 워밍 × 4종목 ≈ 740키가
    공존해도 최근 날짜가 축출되지 않아야 한다. 512에서는 깊은 walk가 최근
    날짜를 밀어내 60초마다 재fetch churn을 일으켰다(2026-07-07 실측: 같은
    날짜 39회 재fetch)."""
    cache = PastCandlesCache(data_dir=tmp_path)
    start = dt.date(2025, 11, 1)
    dates = [(start + dt.timedelta(days=i)).strftime("%Y%m%d") for i in range(250)]
    for code in ("005930", "000660"):
        for date_s in dates:
            cache.store_past("KRX", code, date_s, _bar(date_s))
    for code in ("112040", "000270", "015760", "241560"):
        for date_s in dates[-60:]:
            cache.store_past("KRX", code, date_s, _bar(date_s))

    # 두 종목 250일 전량 + 워밍 4종목 60일 전량 생존
    assert all(
        cache.get_past("KRX", code, date_s) is not None
        for code in ("005930", "000660") for date_s in dates
    )
    assert all(
        cache.get_past("KRX", code, date_s) is not None
        for code in ("112040", "000270", "015760", "241560") for date_s in dates[-60:]
    )
