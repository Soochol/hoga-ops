"""`hoga.api.peak_prewarm` — 과거일 1분 최대벽 캐시 워밍."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from hoga.api import peak_prewarm
from hoga.api.queries import QueryEngine
from hoga.api.sources import source_venue_dir
from hoga.tables import snapshots as snapshots_tbl

_OPEN = 90_000_000
_CLOSE = 153_000_000
_TODAY = "20260615"


def _write_stock_date(data_dir: Path, *, date: str, code: str,
                      source: str = "hogaplay") -> Path:
    """정본 경로에 meta.json + snapshots/trades.parquet.

    경로 조립은 `source_venue_dir` 에 맡긴다 — 손으로 `{code}/{source}` 를 이으면
    venue 세그먼트를 붙이는 소스(kiwoom_live → `kiwoom_live/KRX`)에서 어긋나고,
    워밍이 그 픽스처를 아예 못 본다(테스트가 조용히 0건을 세게 된다).

    데이터는 `_peak_reagg_fixture` 를 재사용한다 — 봉을 바꾸면 값이 실제로 갈리는
    픽스처라, "굵은 봉이 파생됐다" 를 재는 아래 테스트가 의미를 갖는다.
    """
    from tests.test_tables_snapshots import _peak_reagg_fixture

    src_dir = source_venue_dir(data_dir / "parquet" / date / code, source, "KRX")
    src_dir.mkdir(parents=True, exist_ok=True)
    _peak_reagg_fixture(src_dir)  # snapshots.parquet + trades.parquet
    (src_dir / "meta.json").write_text(
        json.dumps({
            "name": code,
            "regular_session_open_ms": _OPEN,
            "regular_session_close_ms": _CLOSE,
        }),
        encoding="utf-8",
    )
    return src_dir


def _prewarm(tmp_path: Path, **kw):
    with patch("hoga.api.bundle._today_kst_yyyymmdd", return_value=_TODAY):
        return peak_prewarm.prewarm(tmp_path, sources=("hogaplay",), **kw)


def test_prewarm_fills_1m_cache_and_is_idempotent(tmp_path: Path) -> None:
    """첫 실행은 계산하고 두 번째는 건너뛴다 — 일일 런이 매일 돌아도 싸다."""
    _write_stock_date(tmp_path, date="20260610", code="005930")

    first = _prewarm(tmp_path)
    assert (first.scanned, first.warmed, first.skipped, first.failed) == (1, 1, 0, 0)

    engine = QueryEngine(tmp_path)
    try:
        cache = engine.indicators_cache
        assert cache.has_ask_peak("005930", "20260610", "hogaplay", snapshots_tbl.ONE_MINUTE_MS)
        assert cache.has_bid_peak("005930", "20260610", "hogaplay", snapshots_tbl.ONE_MINUTE_MS)
    finally:
        engine.close()

    second = _prewarm(tmp_path)
    assert (second.warmed, second.skipped) == (0, 1)


def test_prewarm_excludes_today(tmp_path: Path) -> None:
    """오늘자는 대상이 아니다 — `PastIndicatorsCache` 는 past-only 다(ADR-0043).

    **막는 방향**: 오늘 parquet 은 5분마다 통째로 overwrite 되므로 디스크에 박제하면
    곧 stale 이 되고, 그것을 지울 장치가 이 경로에 없다(meta mtime 은 재캡처만 본다).
    """
    _write_stock_date(tmp_path, date=_TODAY, code="005930")
    _write_stock_date(tmp_path, date="20260616", code="005930")  # 미래 날짜도 제외

    res = _prewarm(tmp_path)
    assert (res.scanned, res.warmed) == (0, 0)


def test_prewarm_fills_missing_heatmap_even_when_peaks_are_warm(tmp_path: Path) -> None:
    from hoga.api.bundle import build_ask_bid_peak_slices, build_depth_heatmap_slice

    _write_stock_date(tmp_path, date="20260610", code="005930")
    args = dict(code="005930", date="20260610", source="hogaplay", venue="KRX",
                session_open_ms=_OPEN, session_close_ms=_CLOSE, today_kst=_TODAY)
    engine = QueryEngine(tmp_path)
    try:
        build_ask_bid_peak_slices(engine, bucket_ms=60_000, **args)
    finally:
        engine.close()
    assert _prewarm(tmp_path).warmed == 1, "최대벽 hit라도 빠진 히트맵을 준비해야 한다"
    engine = QueryEngine(tmp_path)
    try:
        with patch.object(snapshots_tbl, "query_bucketed_depth_heatmap",
                          wraps=snapshots_tbl.query_bucketed_depth_heatmap) as scan:
            one = build_depth_heatmap_slice(engine, bucket_ms=60_000, **args)
            coarse = build_depth_heatmap_slice(engine, bucket_ms=300_000, **args)
        assert one and coarse
        assert scan.call_count == 0, "1분 워밍 후 1분·5분 모두 원본 스캔이 없어야 한다"
    finally:
        engine.close()
    assert _prewarm(tmp_path).warmed == 0


def test_depth_failure_keeps_peaks_continues_other_dates_and_retries(tmp_path: Path) -> None:
    from hoga.api.bundle import build_depth_heatmap_slice
    from hoga.api.past_indicators_cache import CACHE_MISS

    _write_stock_date(tmp_path, date="20260612", code="005930")
    _write_stock_date(tmp_path, date="20260611", code="000660")
    attempted = []

    def fail_first_depth(engine, **kwargs):
        attempted.append(kwargs["code"])
        if kwargs["code"] == "005930":
            cache = engine.indicators_cache
            assert cache.has_ask_peak("005930", "20260612", "hogaplay", 60_000)
            assert cache.has_bid_peak("005930", "20260612", "hogaplay", 60_000)
            raise RuntimeError("depth computation failed after peak persistence")
        return build_depth_heatmap_slice(engine, **kwargs)

    with patch("hoga.api.bundle.build_depth_heatmap_slice", side_effect=fail_first_depth):
        first = _prewarm(tmp_path)
    assert attempted == ["005930", "000660"]
    assert (first.scanned, first.warmed, first.failed) == (2, 1, 1)

    engine = QueryEngine(tmp_path)
    try:
        cache = engine.indicators_cache
        assert cache.has_ask_peak("005930", "20260612", "hogaplay", 60_000)
        assert cache.has_bid_peak("005930", "20260612", "hogaplay", 60_000)
        assert cache.get_depth("005930", "20260612", "hogaplay", 60_000) is CACHE_MISS
        continued_depth = cache.get_depth("000660", "20260611", "hogaplay", 60_000)
        assert isinstance(continued_depth, list) and continued_depth
    finally:
        engine.close()

    second = _prewarm(tmp_path)
    assert (second.warmed, second.skipped, second.failed) == (1, 1, 0)
    engine = QueryEngine(tmp_path)
    try:
        recovered_depth = engine.indicators_cache.get_depth("005930", "20260612", "hogaplay", 60_000)
        assert isinstance(recovered_depth, list) and recovered_depth
    finally:
        engine.close()


def test_prewarm_limit_truncates_and_takes_recent_dates_first(tmp_path: Path) -> None:
    """상한에 걸리면 **최신 날짜부터** 채운다.

    **막는 방향**: 오름차순 순회. 그러면 첫 실행이 몇 달 전 날짜만 채우고 정작
    사용자가 오늘 열어 볼 어제가 콜드로 남는다 — 상한이 있는 한 순서가 곧 정책이다.
    """
    for date in ("20260601", "20260602", "20260603"):
        _write_stock_date(tmp_path, date=date, code="005930")

    res = _prewarm(tmp_path, limit=1)
    assert (res.warmed, res.truncated) == (1, True)

    engine = QueryEngine(tmp_path)
    try:
        cache = engine.indicators_cache
        one = snapshots_tbl.ONE_MINUTE_MS
        assert cache.has_ask_peak("005930", "20260603", "hogaplay", one), "최신일이 먼저"
        assert not cache.has_ask_peak("005930", "20260601", "hogaplay", one)
    finally:
        engine.close()


def test_warm_1m_cache_lets_coarse_bucket_derive_without_scanning(tmp_path: Path) -> None:
    """**이 모듈의 존재 이유**: 1분 한 번이 모든 봉을 커버한다.

    1분을 데운 뒤 굵은 봉을 요청하면 파케이 스캔이 **0회**여야 한다 — 그래야
    "봉별로 돌 필요가 없다"(모듈 docstring)가 참이다. 실측으로는 직접 계산 0.33s
    대 파생 2.6~4.9ms 의 차이다.

    **못 보는 것**: 파생 결과가 직접 조회와 같은가 —
    `test_reaggregate_peak_rep_matches_direct_query` 가 본다.
    """
    from hoga.api.bundle import build_ask_bid_peak_slices

    _write_stock_date(tmp_path, date="20260610", code="005930")
    assert _prewarm(tmp_path).warmed == 1

    engine = QueryEngine(tmp_path)
    try:
        # 반환값을 주는 이유: 스파이가 MagicMock 을 돌려주면 호출부의 unpack 이
        # 먼저 터져 **원인을 말하지 않는 실패**가 된다. 빈 결과를 돌려주면
        # 아래 call_count 단언까지 도달해 "다시 읽었다" 가 그대로 찍힌다.
        with patch.object(
            snapshots_tbl, "query_day_ask_bid_peak_dual_with_rep",
            return_value=(None, None, []),
        ) as spy:
            ask, bid = build_ask_bid_peak_slices(
                engine, code="005930", date="20260610", bucket_ms=300_000,
                source="hogaplay", venue="KRX",
                session_open_ms=_OPEN, session_close_ms=_CLOSE,
                cache=engine.indicators_cache, today_kst=_TODAY,
            )
        assert spy.call_count == 0, "1분 캐시가 있는데 굵은 봉이 파케이를 다시 읽었다"
        assert ask is not None and bid is not None
    finally:
        engine.close()


def test_prewarm_counts_unreadable_meta_as_failed_and_continues(tmp_path: Path) -> None:
    """메타가 깨진 스톡데이트는 failed 로 세고 **나머지를 계속** 채운다.

    배치라 한 칸의 실패가 나머지를 죽이면 안 된다. 다음 런이 같은 칸을 다시 잡는다.
    """
    bad = _write_stock_date(tmp_path, date="20260610", code="005930")
    (bad / "meta.json").write_text("{ not json", encoding="utf-8")
    _write_stock_date(tmp_path, date="20260611", code="000660")

    res = _prewarm(tmp_path)
    assert res.scanned == 2
    assert res.warmed == 1
    assert res.failed == 1


def test_prewarm_prioritizes_watchlist_before_newer_unwatched_dates(tmp_path: Path) -> None:
    """A cache version bump must not spend the daily budget on unrelated codes."""
    from types import SimpleNamespace

    _write_stock_date(tmp_path, date="20260610", code="005930")
    _write_stock_date(tmp_path, date="20260611", code="005930")
    _write_stock_date(tmp_path, date="20260612", code="000660")
    with patch("hoga.api.watchlist.load_watchlist", return_value=[SimpleNamespace(code="005930")]):
        first = _prewarm(tmp_path, limit=1)
    assert first.warmed == 1 and first.truncated
    engine = QueryEngine(tmp_path)
    try:
        cache = engine.indicators_cache
        assert cache.has_ask_peak("005930", "20260611", "hogaplay", snapshots_tbl.ONE_MINUTE_MS)
        assert not cache.has_ask_peak("000660", "20260612", "hogaplay", snapshots_tbl.ONE_MINUTE_MS)
        # After watched dates are warm, the same budget reaches the remainder.
        with patch("hoga.api.watchlist.load_watchlist", return_value=[SimpleNamespace(code="005930")]):
            second = _prewarm(tmp_path, limit=2, engine=engine)
        assert (second.warmed, second.skipped, second.truncated) == (2, 1, False)
        assert cache.has_ask_peak("000660", "20260612", "hogaplay", snapshots_tbl.ONE_MINUTE_MS)
    finally:
        engine.close()
