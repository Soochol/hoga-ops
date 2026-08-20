from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import polars as pl

from hoga.api import depth_daily, screener_depth
from hoga.api.models import (
    AskDepthNewHighLeaf,
    AskDepthNewHighPeriodLeaf,
    AskDepthRenewalLeaf,
    BidDepthNewHighLeaf,
    BidDepthNewHighPeriodLeaf,
    BidDepthRenewalLeaf,
    DepthPeakParams,
    DepthPeakPeriodParams,
    DepthRenewalParams,
    HeatmapDocument,
    HeatmapEntry,
    WatchlistFolder,
    code_items,
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
    # 경로 조립은 **정본 헬퍼**에 맡긴다 — 픽스처가 손으로 조립하면 레이아웃이
    # 바뀔 때마다(ADR-0037 소스 축 → ADR-0140 venue 축) 여기부터 어긋난다.
    from hoga.api.sources import source_venue_dir

    d = source_venue_dir(data_dir / "parquet" / date / code, source, "KRX")
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
                                 items=code_items(codes))],
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


def test_past_peak_falls_back_to_kiwoom_when_hogaplay_day_missing(tmp_path: Path) -> None:
    """창 안에 hogaplay 가 없는 날은 kiwoom_live 로 폴백해 기준선에 든다.

    2026-08-05 대원전선(006340) 사고의 축소판. 그 날 hogaplay 캡처가 빠져 기준선이
    170,683(전날 값)으로 내려앉았고, 실제 peak 431,144 는 창에서 통째로 사라져
    종목이 통과했다 — 차트 총잔량 지표는 소스 사다리 폴백으로 그 값을 그리고 있었다.

    여기서는 폴백일(20260713)의 kiwoom peak 9000 이 기준선을 지배해 **미통과**가
    옳다. 폴백이 없으면 기준선은 max(4000, 3000)=4000 이 되어 당일 5000 이 통과한다
    — 즉 이 단언은 폴백을 걷어내면 뒤집힌다(회귀 가드).
    """
    data_dir = tmp_path
    sdir = data_dir / "screener"
    code = "005930"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, ["20260710", "20260713", "20260714"], [code])

    _write_snap(data_dir, date="20260710", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(400,) * 10, bid_q=(100,) * 10)])
    # 20260713: hogaplay 캡처 결손 — kiwoom_live 만 있다(그 날의 진짜 peak 9000).
    _write_snap(data_dir, date="20260713", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(900,) * 10, bid_q=(100,) * 10)])
    _write_snap(data_dir, date="20260714", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(300,) * 10, bid_q=(100,) * 10)])
    depth_daily.sweep(data_dir)

    _write_snap(data_dir, date="20260715", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(500,) * 10, bid_q=(100,) * 10)])

    leaf = AskDepthNewHighLeaf(id="a1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis="intraday", today="20260715",
    )
    assert code not in res.passing["a1"]           # 폴백 없으면 통과했을 자리
    assert res.values[code].ask_past_peak == 9000  # 폴백일이 기준선을 지배
    assert res.values[code].ask_have_days == 3     # 결손일이 커버리지에도 든다


def test_eod_today_peak_also_falls_back_to_kiwoom(tmp_path: Path) -> None:
    """eod 기준의 '당일'(코퍼스 최신 확정일)도 같은 폴백 프레임에서 읽는다.

    intraday 는 '당일'을 live parquet 에서 직접 산출하지만 eod 는 depth_daily 에서
    읽는다. 그 조회가 폴백을 안 타면 **과거 창만 폴백되고 당일은 안 되는 비대칭**이
    생겨, hogaplay 가 없는 날이 최신 확정일이면 그 종목이 조용히 평가에서 빠진다
    (today_val=None → continue). 여기서는 20260714 에 kiwoom 만 있고, 그 값 5000 이
    '당일'로 잡혀 과거 peak 4000 을 넘어 통과해야 한다.

    이 경로는 폴백 도입 전까지 테스트가 **전혀 없었다** — eod 를 쓰던 기존 2건은
    기준시각 돌파(renewal) 조건이라 이 분기를 지나지 않는다.
    """
    data_dir = tmp_path
    sdir = data_dir / "screener"
    code = "005930"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, ["20260710", "20260713", "20260714"], [code])

    _write_snap(data_dir, date="20260710", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(400,) * 10, bid_q=(100,) * 10)])
    _write_snap(data_dir, date="20260713", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(300,) * 10, bid_q=(100,) * 10)])
    # 최신 확정일에 hogaplay 결손 — kiwoom_live 만 있다.
    _write_snap(data_dir, date="20260714", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(500,) * 10, bid_q=(100,) * 10)])
    depth_daily.sweep(data_dir)

    leaf = AskDepthNewHighLeaf(id="a1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis="eod", today="20260715",
    )
    assert res.values[code].ask_today == 5000      # 폴백 없으면 None → 평가에서 탈락
    assert res.values[code].ask_past_peak == 4000
    assert code in res.passing["a1"]


def test_hogaplay_wins_over_kiwoom_on_days_that_have_both(tmp_path: Path) -> None:
    """두 소스가 다 있는 날은 hogaplay 값을 쓴다 — 폴백이 max 로 섞이지 않는다.

    kiwoom 을 더 크게 심어 구분한다. 소스별 max 를 합치면 기준선이 9000 이 되어
    미통과가 되겠지만, 올바른 동작은 hogaplay 4000 을 골라 **통과**다(표본이 30배
    촘촘한 쪽이 그 날의 진실이라는 것이 우선순위의 근거다).
    """
    data_dir = tmp_path
    sdir = data_dir / "screener"
    code = "005930"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, ["20260713", "20260714"], [code])

    _write_snap(data_dir, date="20260713", code=code, source="hogaplay",
                obs=[_ob(ts_ms=91_000_000, ask_q=(400,) * 10, bid_q=(100,) * 10)])
    _write_snap(data_dir, date="20260713", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(900,) * 10, bid_q=(100,) * 10)])
    depth_daily.sweep(data_dir)

    _write_snap(data_dir, date="20260715", code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(500,) * 10, bid_q=(100,) * 10)])

    leaf = AskDepthNewHighLeaf(id="a1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis="intraday", today="20260715",
    )
    assert res.values[code].ask_past_peak == 4000  # 9000(kiwoom) 이 아니다
    assert code in res.passing["a1"]


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
    assert res.values[code].ask_renewal_start_hhmm == 1200


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


# === 매수 총잔량 기준시각 돌파 (bid_depth_renewal) ===

def _bid_renewal_leaf(start_hhmm: int = 1200, leaf_id: str = "rb",
                      threshold_pct: float = 100.0) -> BidDepthRenewalLeaf:
    return BidDepthRenewalLeaf(id=leaf_id, params=DepthRenewalParams(
        start_hhmm=start_hhmm, threshold_pct=threshold_pct))


def test_bid_renewal_reads_the_bid_side(tmp_path: Path) -> None:
    """매수 조건은 매수 총잔량만 본다 — 두 side 가 반대로 움직이는 데이터로 확인."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        # 이전: ask 2000 / bid 1000,  이후: ask 800 / bid 3000
        _ob(ts_ms=113_000_000, ask_q=(200,) * 10, bid_q=(100,) * 10),
        _ob(ts_ms=130_000_000, ask_q=(80,) * 10, bid_q=(300,) * 10),
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_bid_renewal_leaf()])
    assert code in res.passing["rb"]                       # bid 1000 → 3000
    v = res.values[code]
    assert (v.bid_pre_max, v.bid_post_max) == (1000, 3000)
    assert v.bid_renewal_start_hhmm == 1200
    # 매도 조건이 없으므로 매도 사이드카는 비어 있다(남의 값이 새지 않는다).
    assert (v.ask_pre_max, v.ask_post_max, v.ask_renewal_start_hhmm) == (None, None, None)

    # 같은 데이터에 매도 조건을 걸면 미통과 — side 를 실제로 가려 본다는 증거.
    ask = _renewal_eval(tmp_path, code, leaves=[_renewal_leaf(leaf_id="ra")])
    assert ask.passing["ra"] == set()


def test_both_renewal_sides_keep_separate_start_hhmm(tmp_path: Path) -> None:
    """매도 12:00 · 매수 13:00 처럼 섞어 써도 배지가 남의 시각을 달지 않는다."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=100_000_000, ask_q=(100,) * 10, bid_q=(100,) * 10),  # 10:00 → 1000/1000
        _ob(ts_ms=123_000_000, ask_q=(150,) * 10, bid_q=(150,) * 10),  # 12:30 → 1500/1500
        _ob(ts_ms=140_000_000, ask_q=(200,) * 10, bid_q=(200,) * 10),  # 14:00 → 2000/2000
    ])
    res = _renewal_eval(tmp_path, code, leaves=[
        _renewal_leaf(1200, "ra"), _bid_renewal_leaf(1300, "rb")])
    v = res.values[code]
    # 매도 12:00 기준 → 이전 1000, 이후 max(1500, 2000)=2000
    assert (v.ask_pre_max, v.ask_post_max, v.ask_renewal_start_hhmm) == (1000, 2000, 1200)
    # 매수 13:00 기준 → 이전 max(1000,1500)=1500, 이후 2000
    assert (v.bid_pre_max, v.bid_post_max, v.bid_renewal_start_hhmm) == (1500, 2000, 1300)
    assert code in res.passing["ra"]
    assert code in res.passing["rb"]


def test_both_renewal_sides_same_hhmm_scan_once(tmp_path: Path) -> None:
    """같은 기준시각이면 스냅샷 스캔은 한 번 — 양측 값이 한 쿼리에서 나온다."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(100,) * 10, bid_q=(200,) * 10),
        _ob(ts_ms=130_000_000, ask_q=(300,) * 10, bid_q=(100,) * 10),
    ])
    calls: list[int] = []
    real = screener_depth._today_split_peaks

    def _counting(*args, **kwargs):
        calls.append(kwargs["split_ms"])
        return real(*args, **kwargs)

    screener_depth._today_split_peaks = _counting
    try:
        res = _renewal_eval(tmp_path, code, leaves=[
            _renewal_leaf(1200, "ra"), _bid_renewal_leaf(1200, "rb")])
    finally:
        screener_depth._today_split_peaks = real
    assert calls == [120_000_000]              # 두 leaf, 스캔 1회
    assert code in res.passing["ra"]           # ask 1000 → 3000
    assert res.passing["rb"] == set()          # bid 2000 → 1000


def test_bid_renewal_alone_reports_no_coverage(tmp_path: Path) -> None:
    """매수 측도 과거 hogaplay 의존이 없다 — 커버리지 배너를 띄우지 않는다."""
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(10,) * 10, bid_q=(100,) * 10),
        _ob(ts_ms=130_000_000, ask_q=(10,) * 10, bid_q=(200,) * 10),
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_bid_renewal_leaf()])
    assert res.coverage is None
    assert "depth_corpus_unavailable" not in res.warnings


def test_bid_renewal_on_eod_basis_is_empty_with_warning(tmp_path: Path) -> None:
    code = "005930"
    _seed_heatmap(tmp_path, [code])
    _write_snap(tmp_path, date="20260715", code=code, source="kiwoom_live", obs=[
        _ob(ts_ms=113_000_000, ask_q=(10,) * 10, bid_q=(100,) * 10),
        _ob(ts_ms=130_000_000, ask_q=(10,) * 10, bid_q=(200,) * 10),
    ])
    res = _renewal_eval(tmp_path, code, leaves=[_bid_renewal_leaf()], basis="eod")
    assert res.passing["rb"] == set()
    assert "depth_renewal_requires_intraday" in res.warnings


# === 기간내 총잔량 peak (ask/bid_depth_new_high_period) ===============================
#
# 픽스처는 한 벌을 공유한다. 값은 **평탄하지 않게** 세웠다 — threshold 100 은 동률을
# 통과시키므로(설계상 "renews or revisits"), 평탄한 계단에서는 어떤 lookback 을 줘도
# 전부 통과해 창 파라미터가 테스트에서 지워진다.
#
#   0707: 4000   0708: 4000   0709: 3000   0710: 5000 ← 돌파   0713: 2000   0714: 1000
#   0715(당일): 1000  ← 오늘은 조용하다
#
# period=2 기준 0710 만 직전 창(0708·0709 max 4000)을 넘는다. 그래서 "3일 전에
# 돌파, 오늘은 조용" 이 되고, 이 픽스처 하나로 새 조건 통과 ↔ 당일 조건 미통과가
# 동시에 성립한다 — 새 코드 경로가 실제로 돌았다는 증거다.
_PERIOD_PEAKS = {
    "20260707": 400, "20260708": 400, "20260709": 300,
    "20260710": 500, "20260713": 200, "20260714": 100,
}
_PERIOD_CORPUS = list(_PERIOD_PEAKS)
_PERIOD_TODAY = "20260715"


def _seed_period_fixture(tmp_path: Path, code: str = "005930") -> tuple[Path, Path]:
    """과거 6거래일 hogaplay + 당일 live(조용). 반환 (data_dir, sdir)."""
    data_dir = tmp_path
    sdir = data_dir / "screener"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, _PERIOD_CORPUS, [code])
    for date, q in _PERIOD_PEAKS.items():
        _write_snap(data_dir, date=date, code=code, source="hogaplay",
                    obs=[_ob(ts_ms=91_000_000, ask_q=(q,) * 10, bid_q=(q,) * 10)])
    depth_daily.sweep(data_dir)
    _write_snap(data_dir, date=_PERIOD_TODAY, code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(100,) * 10, bid_q=(100,) * 10)])
    return data_dir, sdir


def _period_leaf(**params) -> AskDepthNewHighPeriodLeaf:
    return AskDepthNewHighPeriodLeaf(id="p1", params=DepthPeakPeriodParams(**params))


def _eval_period(data_dir: Path, sdir: Path, leaf, *, code: str = "005930",
                 basis: str = "intraday", today: str = _PERIOD_TODAY):
    return screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[leaf],
        universe_codes={code}, basis=basis, today=today,
    )


def test_period_peak_passes_on_a_breakout_three_days_ago(tmp_path: Path) -> None:
    """기간내 조건은 **오늘이 아닌 날**의 돌파로 통과한다 — 당일 조건과 갈리는 지점.

    같은 픽스처에서 당일 조건(오늘 1000 vs 과거 peak 5000)은 미통과다. 두 단언을
    한 테스트에 둔 것은 대조가 요점이기 때문 — 새 조건이 그냥 늘 통과하는 게
    아니라 **당일 조건이 놓치는 날**을 잡는다는 것을 보인다.
    """
    code = "005930"
    data_dir, sdir = _seed_period_fixture(tmp_path, code)

    res = _eval_period(data_dir, sdir, _period_leaf(lookback=5, period=2, threshold_pct=100))
    assert code in res.passing["p1"]

    today_leaf = AskDepthNewHighLeaf(
        id="t1", params=DepthPeakParams(lookback=20, threshold_pct=100))
    today_res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir, conditions=[today_leaf],
        universe_codes={code}, basis="intraday", today=_PERIOD_TODAY,
    )
    assert code not in today_res.passing["t1"]


def test_period_peak_lookback_window_excludes_the_older_breakout(tmp_path: Path) -> None:
    """lookback 을 2 로 좁히면 0710 돌파가 창 밖으로 나가 미통과.

    lookback 축이 실제로 판정에 쓰인다는 증거다 — 이 대조가 없으면 파라미터를
    무시하는 구현(늘 전 구간 스캔)도 앞 테스트를 통과한다.
    """
    code = "005930"
    data_dir, sdir = _seed_period_fixture(tmp_path, code)
    res = _eval_period(data_dir, sdir, _period_leaf(lookback=2, period=2, threshold_pct=100))
    assert code not in res.passing["p1"]


def test_period_peak_threshold_above_100_needs_strict_excess(tmp_path: Path) -> None:
    """0710 은 직전 창의 125%(5000/4000). thr=120 통과, thr=130 미통과.

    **이 대조가 비교 창의 자기 제외를 고정한다.** 판정일을 창에 포함하면
    기준선이 max(4000, 5000)=5000 이 되어 5000 ≥ 5000×1.2 가 거짓 — thr>100 이
    원리적으로 영영 통과할 수 없게 된다(신고가 SQL CTE 의 `v >= mx` 를 그대로
    미러하면 그렇게 된다).
    """
    code = "005930"
    data_dir, sdir = _seed_period_fixture(tmp_path, code)
    hit = _eval_period(data_dir, sdir, _period_leaf(lookback=5, period=2, threshold_pct=120))
    assert code in hit.passing["p1"]
    miss = _eval_period(data_dir, sdir, _period_leaf(lookback=5, period=2, threshold_pct=130))
    assert code not in miss.passing["p1"]


def test_period_peak_works_on_eod_basis(tmp_path: Path) -> None:
    """eod 에서도 동작한다 — 기준시각 돌파와 달리 당일 전용이 아니다.

    eod 의 '당일' 은 코퍼스 최신 확정 거래일(0714)이고 축은 거기서 끝난다.
    lookback=3 이면 0710 돌파가 창 안, lookback=2 면 밖이다.
    """
    code = "005930"
    data_dir, sdir = _seed_period_fixture(tmp_path, code)
    hit = _eval_period(data_dir, sdir, _period_leaf(lookback=3, period=2, threshold_pct=100),
                       basis="eod")
    assert code in hit.passing["p1"]
    assert "depth_renewal_requires_intraday" not in hit.warnings
    miss = _eval_period(data_dir, sdir, _period_leaf(lookback=2, period=2, threshold_pct=100),
                        basis="eod")
    assert code not in miss.passing["p1"]


def _plant_stale_today_row(data_dir: Path, *, ask: int, bid: int) -> None:
    """depth_daily 에 **오늘자 중간 집계 행**을 심는다(장중 스윕이 남기는 상태)."""
    dd_path = depth_daily.depth_daily_path(data_dir)
    dd = pl.read_parquet(dd_path)
    stale = dd.head(1).with_columns(
        pl.lit(_PERIOD_TODAY).alias("date"), pl.lit("kiwoom_live").alias("src"),
        pl.lit(ask).cast(pl.Int64).alias("ask_peak"),
        pl.lit(bid).cast(pl.Int64).alias("bid_peak"),
    )
    pl.concat([dd, stale]).write_parquet(dd_path)


def test_period_peak_today_column_comes_from_live_not_depth_daily(tmp_path: Path) -> None:
    """오늘 칸은 실시간 승격본이 소유한다 — dd 에 오늘 행이 있어도 그것이 이긴다.

    스윕은 캡처 완료 훅에서 돌기 때문에 장중에 **오늘자 kiwoom_live 행이 이미
    depth_daily 에 들어와 있을 수 있다**. 그 행은 그 시점까지의 중간 집계라 실시간
    승격본보다 낮으므로, 축의 마지막 칸을 dd 가 소유하면 방금 터진 돌파를 놓친다.
    여기서는 dd 오늘 행을 낮게(1000), live 를 높게(6000) 둬서 값으로 가른다.
    """
    code = "005930"
    data_dir, sdir = _seed_period_fixture(tmp_path, code)
    # 오늘 live 를 6000 으로 올린다 — 직전 창(0713·0714 max 2000)의 300%.
    _write_snap(data_dir, date=_PERIOD_TODAY, code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(600,) * 10, bid_q=(600,) * 10)])
    _plant_stale_today_row(data_dir, ask=1000, bid=1000)

    # lookback=1 → 오늘 하루만 판정 대상. dd 값(1000)을 읽으면 1000 < 2000×2.5 로
    # 미통과, live 값(6000)을 읽으면 통과다.
    res = _eval_period(data_dir, sdir, _period_leaf(lookback=1, period=2, threshold_pct=250))
    assert code in res.passing["p1"]


def test_period_peak_drops_today_when_live_is_absent(tmp_path: Path) -> None:
    """live 스냅샷이 없으면 오늘은 **판정 대상에서 빠진다** — dd 오늘 행으로 대신하지 않는다.

    ⚠ 이것이 dd 의 오늘 행을 빼는 필터가 실제로 막는 유일한 경우다. live 가 있으면
    어차피 뒤이어 덮어쓰므로 필터 유무가 결과를 바꾸지 않는다 — 그래서 위 테스트만
    으로는 필터가 죽어도 초록이다(실측).

    **막는 방향**: 당일 조건이 미통과인 종목이 lookback=1 기간내 조건으로는 통과하는
    비대칭. 당일 조건은 intraday 에서 실시간 승격본만 보므로 live 가 없으면 미통과인데,
    lookback=1 은 정의상 당일 조건과 같은 답을 내야 한다.
    **못 보는 것**: 과거일의 소스 선택. 그쪽은 여전히 depth_daily 의 폴백 규칙이 정한다.
    """
    code = "005930"
    data_dir, sdir = _seed_period_fixture(tmp_path, code)
    # 당일 live 파일을 치운다 — _today_peaks 가 이 종목을 못 본다.
    from hoga.api.sources import source_venue_dir
    live_dir = source_venue_dir(
        data_dir / "parquet" / _PERIOD_TODAY / code, "kiwoom_live", "KRX")
    (live_dir / "snapshots.parquet").unlink()
    # dd 에는 돌파로 보이는 오늘 행이 남아 있다(직전 창 2000 의 300%).
    _plant_stale_today_row(data_dir, ask=6000, bid=6000)

    params = DepthPeakPeriodParams(lookback=1, period=2, threshold_pct=250)
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir,
        conditions=[AskDepthNewHighPeriodLeaf(id="p1", params=params),
                    AskDepthNewHighLeaf(
                        id="t1", params=DepthPeakParams(lookback=2, threshold_pct=250))],
        universe_codes={code}, basis="intraday", today=_PERIOD_TODAY,
    )
    assert res.passing["p1"] == set()
    assert res.passing["t1"] == set()   # 당일 조건과 같은 답 — 그것이 요점이다


def test_period_peak_bid_side_uses_bid_column(tmp_path: Path) -> None:
    """매수 리프는 bid 컬럼을 본다. 픽스처는 ask=bid 라 side 혼선은 값이 아니라
    **컬럼 선택 실수**로만 드러나는데, 당일 live 를 비대칭으로 둬서 그것을 가른다."""
    code = "005930"
    data_dir, sdir = _seed_period_fixture(tmp_path, code)
    # 오늘 매수만 크게(9000), 매도는 조용(1000). 직전 창(0713·0714)은 양측 2000.
    _write_snap(data_dir, date=_PERIOD_TODAY, code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(100,) * 10, bid_q=(900,) * 10)])
    params = DepthPeakPeriodParams(lookback=1, period=2, threshold_pct=300)
    res = screener_depth.evaluate(
        data_dir=data_dir, sdir=sdir,
        conditions=[AskDepthNewHighPeriodLeaf(id="a", params=params),
                    BidDepthNewHighPeriodLeaf(id="b", params=params)],
        universe_codes={code}, basis="intraday", today=_PERIOD_TODAY,
    )
    assert code not in res.passing["a"]
    assert code in res.passing["b"]


def test_period_peak_coverage_needs_lookback_plus_period(tmp_path: Path) -> None:
    """커버리지의 need_days 는 lookback + period 다.

    가장 이른 판정일도 자기 직전 period 일을 기준선으로 쓰므로, lookback 만 세면
    배너의 '지난 N일 수집' 처방이 기준 창을 덮지 못한다. 픽스처는 6일치뿐이라
    need 25 에 못 미쳐 partial 로 잡힌다.
    """
    code = "005930"
    data_dir, sdir = _seed_period_fixture(tmp_path, code)
    res = _eval_period(data_dir, sdir, _period_leaf(lookback=5, period=20, threshold_pct=100))
    assert res.coverage is not None
    assert res.coverage.lookback == 25
    assert [c.code for c in res.coverage.partial] == [code]


def test_period_peak_without_baseline_does_not_pass(tmp_path: Path) -> None:
    """기준선이 하나도 없는 날은 통과가 아니라 제외다(비교 불가).

    코퍼스에는 있지만 depth 데이터가 전무한 종목이 그렇다 — 여기서 통과시키면
    '데이터가 없어서 걸린' 종목이 결과에 섞인다.
    """
    code = "005930"
    data_dir = tmp_path
    sdir = data_dir / "screener"
    _seed_heatmap(data_dir, [code])
    _seed_corpus(sdir, _PERIOD_CORPUS, [code])
    _write_snap(data_dir, date=_PERIOD_TODAY, code=code, source="kiwoom_live",
                obs=[_ob(ts_ms=91_000_000, ask_q=(500,) * 10, bid_q=(500,) * 10)])
    res = _eval_period(data_dir, sdir, _period_leaf(lookback=5, period=2, threshold_pct=100))
    assert res.passing["p1"] == set()
