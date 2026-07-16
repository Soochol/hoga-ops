from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import polars as pl

from hoga.api import depth_daily, screener_depth
from hoga.api.models import (
    AskDepthNewHighLeaf, BidDepthNewHighLeaf, DepthPeakParams,
    HeatmapDocument, HeatmapEntry, WatchlistFolder,
)
from hoga.tables.snapshots import Orderbook, write_parquet

_OPEN = 90_000_000
_CLOSE = 153_000_000


def _ob(*, ts_ms: int, ask_q: tuple[int, ...], bid_q: tuple[int, ...]) -> Orderbook:
    def _pad(t: tuple[int, ...]) -> tuple[int, ...]:
        return (tuple(t) + (0,) * 10)[:10]

    return Orderbook(
        ts_ms=ts_ms, seq=1,
        ask_p=tuple(range(1, 11)), ask_q=_pad(ask_q), ask_d=(0,) * 10,
        bid_p=tuple(range(10, 0, -1)), bid_q=_pad(bid_q), bid_d=(0,) * 10,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )


def _write_snap(data_dir: Path, *, date: str, code: str, source: str,
                obs: list[Orderbook]) -> None:
    d = data_dir / "parquet" / date / code / source
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps({
        "name": code, "regular_session_open_ms": _OPEN,
        "regular_session_close_ms": _CLOSE,
    }), encoding="utf-8")
    write_parquet(obs, d / "snapshots.parquet")


def _seed_corpus(sdir: Path, dates: list[str], codes: list[str]) -> None:
    """daily_adjusted.parquet 시드(거래일 캘린더 역할). 값은 무관, date 만 쓰인다."""
    sdir.mkdir(parents=True, exist_ok=True)
    rows = []
    for d in dates:
        for c in codes:
            rows.append({
                "code": c, "date": dt.date(int(d[:4]), int(d[4:6]), int(d[6:])),
                "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1,
            })
    df = pl.DataFrame(rows, schema={
        "code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
        "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64,
    })
    df.write_parquet(sdir / "daily_adjusted.parquet")


def _seed_heatmap(data_dir: Path, codes: list[str]) -> None:
    doc = HeatmapDocument(
        schema_version=3,
        folders=[WatchlistFolder(id="f_00000000", name="G", order=0,
                                 member_codes=list(codes))],
        entries=[HeatmapEntry(code=c, name=c, folder_id="f_00000000", order=i)
                 for i, c in enumerate(codes)],
    )
    from hoga.api import heatmap
    heatmap.save_document(data_dir, doc)


def test_ask_depth_new_high_passes_when_today_exceeds_past(tmp_path: Path) -> None:
    """당일 ask peak ≥ 지난 N일 peak × threshold 이면 통과."""
    data_dir = tmp_path
    sdir = data_dir / "screener"
    code = "005930"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, ["20260710", "20260713", "20260714"], [code])

    # 과거 2일 hogaplay: peak 3000, 4000.
    _write_snap(data_dir, date="20260710", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(300,) * 10, bid_q=(100,) * 10)])
    _write_snap(data_dir, date="20260713", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(400,) * 10, bid_q=(100,) * 10)])
    depth_daily.sweep(data_dir)

    # 당일(20260715) live: ask peak 5000 > 과거 max 4000.
    _write_snap(data_dir, date="20260715", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(500,) * 10, bid_q=(100,) * 10)])

    leaf = AskDepthNewHighLeaf(id="a1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis="intraday", today="20260715",
    )
    assert code in res.passing["a1"]
    assert res.values[code].ask_today == 5000
    assert res.values[code].ask_past_peak == 4000
    assert res.values[code].ask_have_days == 2
    assert res.values[code].ask_need_days == 20


def test_ask_depth_below_threshold_fails(tmp_path: Path) -> None:
    data_dir = tmp_path
    sdir = data_dir / "screener"
    code = "005930"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, ["20260713", "20260714"], [code])
    _write_snap(data_dir, date="20260713", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(400,) * 10, bid_q=(100,) * 10)])
    depth_daily.sweep(data_dir)
    # 당일 ask 3000 < 과거 4000.
    _write_snap(data_dir, date="20260715", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(300,) * 10, bid_q=(100,) * 10)])
    leaf = AskDepthNewHighLeaf(id="a1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis="intraday", today="20260715",
    )
    assert code not in res.passing["a1"]


def test_missing_past_data_excluded_and_reported(tmp_path: Path) -> None:
    """과거 hogaplay 0일 → 통과 못하고 coverage.excluded 에 보고(수집 요청 대상)."""
    data_dir = tmp_path
    sdir = data_dir / "screener"
    code = "005930"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, ["20260713", "20260714"], [code])
    # 과거 hogaplay 없음. 당일만 존재.
    _write_snap(data_dir, date="20260715", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(500,) * 10, bid_q=(100,) * 10)])
    leaf = AskDepthNewHighLeaf(id="a1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis="intraday", today="20260715",
    )
    assert code not in res.passing["a1"]
    excluded_codes = {c.code for c in res.coverage.excluded}
    assert code in excluded_codes
    assert res.coverage.excluded[0].have_days == 0


def test_partial_coverage_flagged(tmp_path: Path) -> None:
    """0 < 보유 < N → partial 에 보고(보유분만으로 비교)."""
    data_dir = tmp_path
    sdir = data_dir / "screener"
    code = "005930"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, ["20260710", "20260713", "20260714"], [code])
    _write_snap(data_dir, date="20260713", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(400,) * 10, bid_q=(100,) * 10)])
    depth_daily.sweep(data_dir)
    _write_snap(data_dir, date="20260715", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(500,) * 10, bid_q=(100,) * 10)])
    # N=20 이지만 보유 1일 → partial.
    leaf = AskDepthNewHighLeaf(id="a1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis="intraday", today="20260715",
    )
    partial_codes = {c.code for c in res.coverage.partial}
    assert code in partial_codes
    assert code in res.passing["a1"]  # 보유분만으로도 통과 가능


def test_bid_side_condition(tmp_path: Path) -> None:
    data_dir = tmp_path
    sdir = data_dir / "screener"
    code = "005930"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, ["20260713", "20260714"], [code])
    _write_snap(data_dir, date="20260713", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(100,) * 10, bid_q=(200,) * 10)])
    depth_daily.sweep(data_dir)
    _write_snap(data_dir, date="20260715", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(100,) * 10, bid_q=(300,) * 10)])
    leaf = BidDepthNewHighLeaf(id="b1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis="intraday", today="20260715",
    )
    assert code in res.passing["b1"]  # bid 3000 >= 2000
    assert res.values[code].bid_today == 3000
    assert res.values[code].bid_past_peak == 2000
