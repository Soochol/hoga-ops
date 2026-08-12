from __future__ import annotations

import json
from pathlib import Path

import polars as pl

from hoga.api import depth_daily
from hoga.tables.snapshots import Orderbook, write_parquet

_OPEN = 90_000_000
_CLOSE = 153_000_000


def _ob(*, ts_ms: int, seq: int, ask_q: tuple[int, ...], bid_q: tuple[int, ...]) -> Orderbook:
    def _pad(t: tuple[int, ...]) -> tuple[int, ...]:
        return (tuple(t) + (0,) * 10)[:10]

    return Orderbook(
        ts_ms=ts_ms, seq=seq,
        ask_p=tuple(range(1, 11)), ask_q=_pad(ask_q), ask_d=(0,) * 10,
        bid_p=tuple(range(10, 0, -1)), bid_q=_pad(bid_q), bid_d=(0,) * 10,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )


def _write_stock_date(
    data_dir: Path, *, date: str, code: str, obs: list[Orderbook],
    source: str = "hogaplay",
) -> Path:
    """정본 경로에 meta.json + snapshots.parquet 를 쓴다.

    경로 조립은 ``source_venue_dir`` 에 맡긴다 — 손으로 `{code}/{source}` 를 이으면
    venue 세그먼트를 붙이는 소스(kiwoom_live → `kiwoom_live/KRX`)에서 어긋나고,
    스윕이 그 픽스처를 아예 못 본다(테스트가 조용히 0건을 세게 된다).
    """
    from hoga.api.sources import source_venue_dir

    src_dir = source_venue_dir(data_dir / "parquet" / date / code, source, "KRX")
    src_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "name": code, "regular_session_open_ms": _OPEN,
        "regular_session_close_ms": _CLOSE,
    }
    (src_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    write_parquet(obs, src_dir / "snapshots.parquet")
    return src_dir


def test_sweep_writes_peak_matching_query_daily_depth_peak(tmp_path: Path) -> None:
    """스윕이 쓴 (code,date) peak 가 query_daily_depth_peak 오라클과 일치(배치↔직접)."""
    from hoga.duck import connect_bounded
    from hoga.tables.snapshots import query_daily_depth_peak

    obs = [
        _ob(ts_ms=90_100_000, seq=1, ask_q=(100,) * 10, bid_q=(50,) * 10),
        _ob(ts_ms=91_000_000, seq=2, ask_q=(300,) * 10, bid_q=(10,) * 10),
    ]
    _write_stock_date(tmp_path, date="20260714", code="005930", obs=obs)

    res = depth_daily.sweep(tmp_path)
    assert res.computed == 1
    assert res.total_rows == 1

    df = depth_daily.load(tmp_path)
    row = df.filter((pl.col("code") == "005930") & (pl.col("date") == "20260714")).row(0, named=True)

    con = connect_bounded()
    oracle = query_daily_depth_peak(
        con, path=tmp_path / "parquet" / "20260714" / "005930" / "hogaplay" / "snapshots.parquet",
        session_open_ms=_OPEN, session_close_ms=_CLOSE,
    )
    assert row["ask_peak"] == oracle.ask_peak == 3000
    assert row["bid_peak"] == oracle.bid_peak == 500
    assert row["src"] == "hogaplay"


def test_sweep_is_incremental_on_meta_mtime(tmp_path: Path) -> None:
    """두 번째 스윕은 메타 미변경분을 재계산하지 않는다(skipped), 신규만 computed."""
    _write_stock_date(
        tmp_path, date="20260714", code="005930",
        obs=[_ob(ts_ms=91_000_000, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10)],
    )
    r1 = depth_daily.sweep(tmp_path)
    assert r1.computed == 1 and r1.skipped == 0

    # 같은 데이터로 재실행 → 메타 mtime 그대로 → 전부 skip.
    r2 = depth_daily.sweep(tmp_path)
    assert r2.computed == 0 and r2.skipped == 1 and r2.total_rows == 1

    # 새 스톡데이트 추가 → 그것만 computed, 기존은 skip.
    _write_stock_date(
        tmp_path, date="20260715", code="005930",
        obs=[_ob(ts_ms=91_000_000, seq=1, ask_q=(200,) * 10, bid_q=(200,) * 10)],
    )
    r3 = depth_daily.sweep(tmp_path)
    assert r3.computed == 1 and r3.skipped == 1 and r3.total_rows == 2


def test_sweep_scopes_by_codes_and_dates(tmp_path: Path) -> None:
    """codes/dates 로 대상을 좁히면 그 밖은 스캔조차 하지 않는다(증분 훅 경로)."""
    _write_stock_date(
        tmp_path, date="20260714", code="005930",
        obs=[_ob(ts_ms=91_000_000, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10)],
    )
    _write_stock_date(
        tmp_path, date="20260714", code="000660",
        obs=[_ob(ts_ms=91_000_000, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10)],
    )
    res = depth_daily.sweep(tmp_path, codes={"005930"}, dates={"20260714"})
    assert res.scanned == 1 and res.computed == 1
    df = depth_daily.load(tmp_path)
    assert df["code"].to_list() == ["005930"]


def test_sweep_no_eligible_writes_sentinel_and_skips_next(tmp_path: Path) -> None:
    """유효 스냅샷 0(deep book 이 전부 세션 밖)이면 센티넬 행(peak null, eligible_count 0)을
    기록한다 — 다음 sweep 이 fingerprint 로 건너뛰고(재계산 방지), 스크리너는 읽지 않는다."""
    import polars as pl

    _write_stock_date(
        tmp_path, date="20260714", code="005930",
        obs=[_ob(ts_ms=85_900_000, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10)],  # 개장 전만
    )
    res = depth_daily.sweep(tmp_path)
    assert res.no_data == 1 and res.computed == 0 and res.total_rows == 1  # 센티넬 1행

    row = depth_daily.load(tmp_path).row(0, named=True)
    assert row["eligible_count"] == 0 and row["ask_peak"] is None and row["bid_peak"] is None

    # 두 번째 sweep: 메타 미변경 → 센티넬 fingerprint 로 skip(재계산 안 함).
    r2 = depth_daily.sweep(tmp_path)
    assert r2.no_data == 0 and r2.skipped == 1 and r2.computed == 0

    # 스크리너 필터(eligible_count>0)가 센티넬을 제외하는지 — load 후 필터 검증.
    dd = depth_daily.load(tmp_path).filter(pl.col("eligible_count") > 0)
    assert dd.height == 0


def test_sweep_recapture_good_to_degenerate_evicts_stale_peak(tmp_path: Path) -> None:
    """good→degenerate 재캡처 시 keep='last' 로 센티넬이 기존 good 행을 덮어 stale peak 를
    남기지 않는다(재캡처는 meta mtime 을 바꿔 재계산을 유발)."""
    import os

    import polars as pl

    d = _write_stock_date(
        tmp_path, date="20260714", code="005930",
        obs=[_ob(ts_ms=91_000_000, seq=1, ask_q=(300,) * 10, bid_q=(300,) * 10)],  # good
    )
    r1 = depth_daily.sweep(tmp_path)
    assert r1.computed == 1
    assert depth_daily.load(tmp_path).row(0, named=True)["ask_peak"] == 3000

    # 재캡처: 개장 전만(degenerate) + meta mtime 갱신(재계산 유발).
    write_parquet(
        [_ob(ts_ms=85_900_000, seq=1, ask_q=(100,) * 10, bid_q=(100,) * 10)],
        d / "snapshots.parquet",
    )
    meta = d / "meta.json"
    st = meta.stat()
    os.utime(meta, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))

    depth_daily.sweep(tmp_path)
    after = depth_daily.load(tmp_path)
    assert after.height == 1  # 여전히 1행(중복 아님)
    assert after.row(0, named=True)["ask_peak"] is None  # stale peak 아닌 센티넬
    assert after.filter(pl.col("eligible_count") > 0).height == 0


def test_sweep_empty_tree_returns_empty(tmp_path: Path) -> None:
    res = depth_daily.sweep(tmp_path)
    assert res.scanned == 0 and res.total_rows == 0
    assert depth_daily.load(tmp_path).height == 0


def _seed_two_sources(
    tmp_path: Path, *, hogaplay_ask: int | None, kiwoom_ask: int | None,
    hogaplay_degenerate: bool = False,
) -> None:
    """같은 (code,date)에 소스별 스톡데이트를 심는다. ask 값이 소스의 지문이 된다.

    ``hogaplay_degenerate`` 는 개장 전 스냅샷만 써서 센티넬(eligible 0)을 만든다.
    """
    if hogaplay_ask is not None:
        ts = 85_900_000 if hogaplay_degenerate else 91_000_000
        _write_stock_date(
            tmp_path, date="20260714", code="005930", source="hogaplay",
            obs=[_ob(ts_ms=ts, seq=1, ask_q=(hogaplay_ask,) * 10, bid_q=(10,) * 10)],
        )
    if kiwoom_ask is not None:
        _write_stock_date(
            tmp_path, date="20260714", code="005930", source="kiwoom_live",
            obs=[_ob(ts_ms=91_000_000, seq=1, ask_q=(kiwoom_ask,) * 10, bid_q=(10,) * 10)],
        )


def test_sweep_collects_both_sources_as_separate_rows(tmp_path: Path) -> None:
    """기본 sources 가 hogaplay·kiwoom_live 둘 다 — (code,date,src) 키라 행이 갈린다.

    폴백이 고를 후보가 애초에 스토어에 있어야 성립한다. 예전 기본값(hogaplay 단독)
    이면 kiwoom_live 행이 0개라 select_with_fallback 이 영원히 no-op 이었다.
    """
    _seed_two_sources(tmp_path, hogaplay_ask=30, kiwoom_ask=50)

    res = depth_daily.sweep(tmp_path)
    assert res.computed == 2

    df = depth_daily.load(tmp_path).sort("src")
    assert df["src"].to_list() == ["hogaplay", "kiwoom_live"]
    assert df["ask_peak"].to_list() == [300, 500]


def test_select_with_fallback_prefers_hogaplay_even_when_lower(tmp_path: Path) -> None:
    """둘 다 있으면 hogaplay — **값 크기가 아니라 소스 순위**가 고른다.

    kiwoom 값을 더 크게 심어 "max 를 고르는 것" 과 구별한다. 표본이 30배 촘촘한
    hogaplay 가 진실에 가깝다는 것이 순위의 근거이므로, 값 비교로 뒤집으면 안 된다.
    """
    _seed_two_sources(tmp_path, hogaplay_ask=30, kiwoom_ask=50)
    depth_daily.sweep(tmp_path)

    sel = depth_daily.select_with_fallback(depth_daily.load(tmp_path))
    assert sel.height == 1
    assert sel.row(0, named=True)["src"] == "hogaplay"
    assert sel.row(0, named=True)["ask_peak"] == 300


def test_select_with_fallback_uses_kiwoom_when_hogaplay_absent(tmp_path: Path) -> None:
    """hogaplay 캡처가 없는 날 — 예전엔 그 날이 창에서 통째로 빠져 기준선이 낮아졌다."""
    _seed_two_sources(tmp_path, hogaplay_ask=None, kiwoom_ask=50)
    depth_daily.sweep(tmp_path)

    sel = depth_daily.select_with_fallback(depth_daily.load(tmp_path))
    assert sel.height == 1
    assert sel.row(0, named=True)["src"] == "kiwoom_live"
    assert sel.row(0, named=True)["ask_peak"] == 500


def test_select_with_fallback_falls_back_past_hogaplay_sentinel(tmp_path: Path) -> None:
    """hogaplay 가 센티넬(퇴화 캡처)이고 kiwoom 이 정상 → kiwoom 이 남는다.

    **필터 순서 회귀 가드.** `eligible_count > 0` 이 우선순위 선택보다 **뒤**에 오면
    센티넬이 순위로 먼저 이긴 뒤 필터에 걸려 그 (code,date)가 통째로 사라진다 —
    정상 kiwoom 행이 있는데도. 그건 폴백이 막으려던 바로 그 증상이다.
    """
    _seed_two_sources(tmp_path, hogaplay_ask=30, kiwoom_ask=50, hogaplay_degenerate=True)
    depth_daily.sweep(tmp_path)

    raw = depth_daily.load(tmp_path)
    assert raw.height == 2  # 센티넬 + 정상
    assert raw.filter(pl.col("src") == "hogaplay").row(0, named=True)["eligible_count"] == 0

    sel = depth_daily.select_with_fallback(raw)
    assert sel.height == 1
    assert sel.row(0, named=True)["src"] == "kiwoom_live"
    assert sel.row(0, named=True)["ask_peak"] == 500


def test_select_with_fallback_empty_frame_is_passthrough(tmp_path: Path) -> None:
    """빈 프레임 — 스키마를 잃지 않고 그대로 나간다(호출부가 .filter 를 이어 쓴다)."""
    empty = depth_daily.load(tmp_path)
    out = depth_daily.select_with_fallback(empty)
    assert out.height == 0
    assert set(out.columns) == set(empty.columns)
