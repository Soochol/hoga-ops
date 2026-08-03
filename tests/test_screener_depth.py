from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import polars as pl

from hoga.api import depth_daily, screener_depth
from hoga.api.models import (
    AskDepthNewHighLeaf,
    AskDepthRenewalLeaf,
    BidDepthNewHighLeaf,
    DepthPeakParams,
    DepthRenewalParams,
    HeatmapDocument,
    HeatmapEntry,
    WatchlistFolder,
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


# === 매도 총잔량 기준시각 돌파 (ask_depth_renewal) — 당일 전용 ===

def _renewal_leaf(start_hhmm: int = 1200, leaf_id: str = "r1",
                  threshold_pct: float = 100.0) -> AskDepthRenewalLeaf:
    return AskDepthRenewalLeaf(id=leaf_id, params=DepthRenewalParams(
        start_hhmm=start_hhmm, threshold_pct=threshold_pct))


def _renewal_eval(data_dir: Path, code: str, *, leaves, basis: str = "intraday"):
    return screener_depth.evaluate(
        data_dir=data_dir, sdir=data_dir / "screener", conditions=leaves,
        universe_codes={code}, basis=basis, today="20260715",
    )


def test_renewal_passes_when_after_exceeds_before(tmp_path: Path) -> None:
    """기준시각 이후 최대 > 이전 최대 이면 통과."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=100_000_000, ask_q=(100,) * 10, bid_q=(10,) * 10),  # 10:00 → 1000
        _ob(ts_ms=113_000_000, ask_q=(150,) * 10, bid_q=(10,) * 10),  # 11:30 → 1500 (이전 최대)
        _ob(ts_ms=130_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),  # 13:00 → 2000 (이후 최대)
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf()])
    assert code in res.passing["r1"]
    assert res.values[code].ask_pre_max == 1500
    assert res.values[code].ask_post_max == 2000
    assert res.values[code].renewal_start_hhmm == 1200


def test_renewal_fails_when_after_falls_short(tmp_path: Path) -> None:
    """이후 최대가 문턱에 못 미치면 미통과."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),  # 이전 2000
        _ob(ts_ms=130_000_000, ask_q=(150,) * 10, bid_q=(10,) * 10),  # 이후 1500
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf()])
    assert res.passing["r1"] == set()


def test_renewal_tie_passes_at_100_and_fails_at_101(tmp_path: Path) -> None:
    """100% 는 동률 포함 — 신호 정의가 "renews **or revisits** a high" 이기 때문이다.

    peak 조건·실시간 알림과 같은 식(≥)이다. 엄밀히 더 큰 것만 원하는 사용자는 101 을
    쓴다 — 그 경계가 실제로 갈리는지 여기서 못 박는다.
    """
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),  # 이전 2000
        _ob(ts_ms=130_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),  # 이후 2000 — 동률
    ])
    at100 = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf(leaf_id="t100")])
    assert code in at100.passing["t100"]
    at101 = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf(leaf_id="t101", threshold_pct=101)])
    assert at101.passing["t101"] == set()


def test_renewal_threshold_above_100_requires_bigger_wall(tmp_path: Path) -> None:
    """120% 는 이전 최대의 1.2배 이상일 때만 — 문턱이 실제로 선별에 쓰인다."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(100,) * 10, bid_q=(10,) * 10),  # 이전 1000
        _ob(ts_ms=130_000_000, ask_q=(115,) * 10, bid_q=(10,) * 10),  # 이후 1150 — 115%
    ])
    assert code in _renewal_eval(
        tmp_path, code, leaves=[_renewal_leaf(leaf_id="a", threshold_pct=110)]).passing["a"]
    assert _renewal_eval(
        tmp_path, code, leaves=[_renewal_leaf(leaf_id="b", threshold_pct=120)]).passing["b"] == set()


def test_renewal_threshold_below_100_catches_near_misses(tmp_path: Path) -> None:
    """100 미만은 '근접'까지 잡는다 — 돌파 전에 미리 보고 싶을 때."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),  # 이전 2000
        _ob(ts_ms=130_000_000, ask_q=(180,) * 10, bid_q=(10,) * 10),  # 이후 1800 — 90%
    ])
    assert code in _renewal_eval(
        tmp_path, code, leaves=[_renewal_leaf(leaf_id="n", threshold_pct=90)]).passing["n"]


def test_renewal_latches_after_pullback(tmp_path: Path) -> None:
    """한 번 돌파했으면 뒤에서 다시 줄어도 계속 잡힌다(이후 창의 **최댓값** 판정).

    폴링(15~30초) 사이에 지나간 순간을 놓치지 않는 것이 이 조건의 요점 — 스냅샷
    최신값으로 판정하면 이 케이스가 사라진다.
    """
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(150,) * 10, bid_q=(10,) * 10),  # 이전 최대 1500
        _ob(ts_ms=130_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),  # 돌파 2000
        _ob(ts_ms=140_000_000, ask_q=(80,) * 10, bid_q=(10,) * 10),   # 되돌림 800 — 현재값 판정이면 탈락
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf()])
    assert code in res.passing["r1"]


def test_renewal_needs_both_windows(tmp_path: Path) -> None:
    """기준시각이 아직 미래면(이후 창이 비면) 통과하지 않는다."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=100_000_000, ask_q=(100,) * 10, bid_q=(10,) * 10),
        _ob(ts_ms=113_000_000, ask_q=(150,) * 10, bid_q=(10,) * 10),
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf()])
    assert res.passing["r1"] == set()
    assert res.values[code].ask_post_max is None


def test_renewal_start_hhmm_moves_the_boundary(tmp_path: Path) -> None:
    """같은 데이터라도 기준시각이 다르면 판정이 뒤집힌다 — 파라미터가 실제로 쓰인다."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=100_000_000, ask_q=(100,) * 10, bid_q=(10,) * 10),  # 10:00 → 1000
        _ob(ts_ms=113_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),  # 11:30 → 2000
        _ob(ts_ms=130_000_000, ask_q=(150,) * 10, bid_q=(10,) * 10),  # 13:00 → 1500
    ])
    # 11:00 기준 → 이전 1000 < 이후 2000 → 통과.
    early = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf(1100, "early")])
    assert code in early.passing["early"]
    # 12:00 기준 → 이전 2000 > 이후 1500 → 미통과.
    late = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf(1200, "late")])
    assert late.passing["late"] == set()


def test_renewal_alone_reports_no_coverage(tmp_path: Path) -> None:
    """과거 hogaplay 의존이 없으므로 커버리지 배너를 띄우지 않는다.

    커버리지 배너의 처방은 "지난 N일 수집"인데, 당일 전용 조건엔 줄 수 있는 조치가
    아니다 — 없는 처방을 제안하느니 배너를 그리지 않는다.
    """
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(150,) * 10, bid_q=(10,) * 10),
        _ob(ts_ms=130_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf()])
    assert res.coverage is None
    assert "depth_corpus_unavailable" not in res.warnings  # 코퍼스를 아예 읽지 않는다


def test_renewal_on_eod_basis_is_empty_with_warning(tmp_path: Path) -> None:
    """eod 기준에선 '기준시각 이후'가 정의되지 않는다 — 조용히 통과시키지 않는다."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(150,) * 10, bid_q=(10,) * 10),
        _ob(ts_ms=130_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf()], basis="eod")
    assert res.passing["r1"] == set()
    assert "depth_renewal_requires_intraday" in res.warnings


def test_renewal_and_peak_conditions_coexist(tmp_path: Path) -> None:
    """두 갈래를 한 스크린에 섞어도 각자의 사이드카·커버리지가 유지된다."""
    code = "005930"
    sdir = tmp_path / "screener"
    _seed_heatmap(tmp_path, [code])
    _seed_corpus(sdir, ["20260713", "20260714"], [code])
    _write_snap(tmp_path, date="20260713", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(100,) * 10, bid_q=(10,) * 10)])
    depth_daily.sweep(tmp_path)
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(150,) * 10, bid_q=(10,) * 10),
        _ob(ts_ms=130_000_000, ask_q=(200,) * 10, bid_q=(10,) * 10),
    ])
    peak = AskDepthNewHighLeaf(id="p1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = _renewal_eval(tmp_path, code, leaves=[peak, _renewal_leaf()])
    assert code in res.passing["p1"]   # 당일 2000 >= 과거 1000
    assert code in res.passing["r1"]   # 1500 → 2000
    v = res.values[code]
    assert (v.ask_today, v.ask_past_peak) == (2000, 1000)   # peak 배지 값
    assert (v.ask_pre_max, v.ask_post_max) == (1500, 2000)  # 돌파 배지 값
    assert res.coverage is not None    # peak 조건이 있으므로 커버리지는 살아 있다
