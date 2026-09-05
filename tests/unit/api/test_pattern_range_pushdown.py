"""선행 기간 제한과 전 기간 계산 후 마스킹의 결과/연산량 대조."""
import datetime as dt
import itertools

import numpy as np
import polars as pl
import pytest

from hoga.api import screener_pattern as sp
from hoga.api.models import PatternSearchRequest


@pytest.fixture(scope="module")
def data_dir(tmp_path_factory):
    root = tmp_path_factory.mktemp("pattern-pushdown")
    sdir = root / "screener"
    sdir.mkdir()
    n = 2600
    rng = np.random.default_rng(20260905)
    dates = np.busday_offset("2014-01-01", np.arange(n)).astype("datetime64[D]")
    rows = []
    for i in range(3):
        close = 100 * np.exp(rng.normal(0, .02, n).cumsum())
        op = close * np.exp(rng.normal(0, .01, n))
        rows.append(pl.DataFrame({
            "code": [f"{i+1:06}"] * n, "date": dates,
            "open": op, "high": np.maximum(op, close) * 1.01,
            "low": np.minimum(op, close) * .99, "close": close,
            "volume": rng.integers(10**8, 10**9, n),
        }))
    pl.concat(rows).write_parquet(sdir / "daily_adjusted.parquet")
    return root


def _same_response(actual, expected):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys()
        for key in expected:
            if key != "elapsed_ms":
                _same_response(actual[key], expected[key])
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for a, b in zip(actual, expected, strict=True):
            _same_response(a, b)
    elif isinstance(expected, float):
        assert actual == pytest.approx(expected, abs=1e-8, rel=1e-8)
    else:
        assert actual == expected


@pytest.mark.parametrize("timeframe,ma,anchor,volume,flex", itertools.product(
    ("D", "W", "M"), ("off", "short", "mid"), (None, "running", "first2"), (0, .3), (0, 2),
))
def test_trimmed_search_matches_full_scan(data_dir, monkeypatch, timeframe, ma, anchor, volume, flex):
    c = sp.load_corpus(data_dir, timeframe)
    n = c.series_len(0)
    # 버킷 중간 날짜를 경계로 둔다. W/M에서 버킷 키를 쓰면 이 대조가 깨진다.
    boundary = c.last_day_at(0, n - 28) - dt.timedelta(days=1)
    req = PatternSearchRequest(
        code="000001", mode="history", timeframe=timeframe, lengths=[7], top=100,
        since=boundary.strftime("%Y%m%d"), ma_preset=ma, flex_bars=flex,
        struct_tolerance=2 if anchor else None, struct_anchor=anchor or "running",
        volume_weight=volume, per_code=5, min_tv_eok=50, exclude_etf=False,
        no_overlap=True, forward_days=3,
    )
    # 시작 위치만 원래 계열의 처음으로 되돌리면 종전의 전량 계산 + 뒤쪽 since
    # 마스킹 경로다. 비교가 기간 필터 자체를 없애지는 않는다.
    with monkeypatch.context() as m:
        m.setattr(sp, "_history_start", lambda corpus, i, since: int(corpus.starts[i]))
        expected = sp.run_pattern_search(data_dir, req).model_dump()
    actual = sp.run_pattern_search(data_dir, req).model_dump()
    _same_response(actual, expected)


@pytest.mark.parametrize("query_offset", [100, 2575])
def test_dated_query_offsets_remain_in_original_series(data_dir, monkeypatch, query_offset):
    c = sp.load_corpus(data_dir)
    req = PatternSearchRequest(
        code="000001", mode="history", lengths=[7],
        **{"from": c.first_day_at(0, query_offset).strftime("%Y%m%d"),
           "to": c.last_day_at(0, query_offset + 6).strftime("%Y%m%d")},
        since=c.first_day_at(0, 2550).strftime("%Y%m%d"), no_overlap=False,
        min_tv_eok=0, exclude_etf=False, forward_days=3, per_code=5,
    )
    with monkeypatch.context() as m:
        m.setattr(sp, "_history_start", lambda corpus, i, since: int(corpus.starts[i]))
        expected = sp.run_pattern_search(data_dir, req).model_dump()
    _same_response(sp.run_pattern_search(data_dir, req).model_dump(), expected)


def test_kernel_never_reads_the_excluded_prefix(data_dir, monkeypatch):
    c = sp.load_corpus(data_dir)
    sizes = []
    correlate = np.correlate

    def counted(a, *args, **kwargs):
        sizes.append(len(a))
        return correlate(a, *args, **kwargs)

    monkeypatch.setattr(np, "correlate", counted)
    req = PatternSearchRequest(
        code="000001", mode="history", lengths=[7], ma_preset="short", volume_weight=.3,
        since=c.first_day_at(0, 2500).strftime("%Y%m%d"), min_tv_eok=0, exclude_etf=False,
    )
    assert sp.run_pattern_search(data_dir, req).results
    assert sizes and max(sizes) == 100
    assert sum(sizes) == 3 * 7 * 100  # 3종목 × (OHLC+MA2+거래량) × 100봉
