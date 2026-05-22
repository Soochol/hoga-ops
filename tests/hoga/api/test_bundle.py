"""Tests for hoga.api.bundle module."""
from __future__ import annotations

import pytest

from hoga.api.bundle import downsample_candles
from hoga.tables.candles import ApiCandle


def _c(ts_ms: int, o: int, h: int, l: int, c: int, va: int = 0, vb: int = 0) -> ApiCandle:
    """KRX prices are integer-won (see hoga/tables/candles.py:ApiCandle)."""
    return ApiCandle(ts_ms=ts_ms, open=o, close=c, high=h, low=l, vol_a=va, vol_b=vb)


def test_downsample_candles_identity_at_60000():
    inp = [_c(60_000, 100, 110, 95, 105), _c(120_000, 105, 108, 100, 102)]
    out = downsample_candles(inp, bucket_ms=60_000)
    assert out == inp


def test_downsample_candles_5min_groups_five_1min_bars():
    inp = [
        _c(0,        100, 110,  95, 105, 10, 20),
        _c(60_000,   105, 115, 102, 110, 15, 25),
        _c(120_000,  110, 120, 108, 118,  5, 30),
        _c(180_000,  118, 119, 110, 112, 20, 10),
        _c(240_000,  112, 125, 111, 122, 30, 15),
    ]
    out = downsample_candles(inp, bucket_ms=300_000)
    assert len(out) == 1
    bar = out[0]
    assert bar.ts_ms == 0
    assert bar.open == 100
    assert bar.close == 122
    assert bar.high == 125
    assert bar.low == 95
    assert bar.vol_a == 80
    assert bar.vol_b == 100


def test_downsample_candles_includes_last_partial_bucket():
    inp = [_c(i * 60_000, 100, 110, 90, 105, 1, 1) for i in range(7)]
    out = downsample_candles(inp, bucket_ms=300_000)
    assert len(out) == 2
    assert out[0].ts_ms == 0
    assert out[1].ts_ms == 300_000
    assert out[1].vol_a == 2


def test_downsample_candles_empty_input_returns_empty():
    assert downsample_candles([], bucket_ms=300_000) == []


def test_downsample_candles_rejects_invalid_bucket():
    with pytest.raises(ValueError, match="bucket_ms"):
        downsample_candles([_c(0, 1, 1, 1, 1)], bucket_ms=42_000)


def test_downsample_candles_handles_all_six_timeframes():
    inp = [_c(i * 60_000, 100, 110, 90, 105, 1, 1) for i in range(30)]
    for bucket_ms in (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000):
        out = downsample_candles(inp, bucket_ms=bucket_ms)
        assert sum(c.vol_a for c in out) == 30
        for c in out:
            assert c.ts_ms % bucket_ms == 0
