"""`/api/range` 일자 루프 앞의 peak 유계 병렬 prefetch (`_prefetch_peak_caches`)."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from hoga.api.bundle import _prefetch_peak_caches, build_ask_bid_peak_slices
from hoga.api.queries import QueryEngine
from hoga.tables import snapshots as snapshots_tbl
from tests.unit.api.test_peak_prewarm import _OPEN, _write_stock_date

_TODAY = "20260615"
_COARSE = 300_000


def _run(engine: QueryEngine, dates: list[str], *, bucket_ms: int = _COARSE) -> int:
    return _prefetch_peak_caches(
        engine, code="005930", dates=dates, source_pref="hogaplay", venue="KRX",
        bucket_ms=bucket_ms, cache=engine.indicators_cache, today_kst=_TODAY,
    )


def test_prefetch_fills_cold_dates_so_the_loop_never_scans(tmp_path: Path) -> None:
    """**이 함수의 존재 이유**: 루프가 도달했을 때 이미 캐시 히트여야 한다.

    그래야 "루프 본문은 한 줄도 안 바뀐다" 가 참이고, 병렬 이득이 루프의 순차성을
    건드리지 않고 얻어진다.
    """
    dates = ["20260610", "20260611"]
    for d in dates:
        _write_stock_date(tmp_path, date=d, code="005930")

    engine = QueryEngine(tmp_path)
    try:
        assert _run(engine, dates) == 2

        # 스파이에 빈 결과를 준다 — MagicMock 을 돌려주면 호출부의 unpack 이 먼저
        # 터져 **원인을 말하지 않는 실패**가 된다.
        with patch.object(
            snapshots_tbl, "query_day_ask_bid_peak_dual_with_rep",
            return_value=(None, None, []),
        ) as spy:
            for d in dates:
                build_ask_bid_peak_slices(
                    engine, code="005930", date=d, bucket_ms=_COARSE,
                    source="hogaplay", venue="KRX",
                    session_open_ms=_OPEN, session_close_ms=153_000_000,
                    cache=engine.indicators_cache, today_kst=_TODAY,
                )
        assert spy.call_count == 0, "prefetch 뒤에도 루프가 파케이를 다시 읽었다"
    finally:
        engine.close()


def test_prefetch_is_a_noop_when_every_date_is_warm(tmp_path: Path) -> None:
    """웜 경로에 비용을 얹지 않는다 — 두 번째 호출은 계산 0건이다.

    **막는 방향**: 콜드 판정을 요청 봉(`bucket_ms`)으로 하는 것. 굵은 봉 캐시는
    파생 경로가 저장하지 않으므로 그렇게 재면 **항상 콜드**로 보여 매 요청이
    prefetch 를 돌린다. 판정은 **1분** 캐시로 해야 한다.
    """
    dates = ["20260610", "20260611"]
    for d in dates:
        _write_stock_date(tmp_path, date=d, code="005930")

    engine = QueryEngine(tmp_path)
    try:
        assert _run(engine, dates) == 2
        assert _run(engine, dates) == 0
    finally:
        engine.close()


def test_prefetch_skips_when_fewer_than_two_cold_dates(tmp_path: Path) -> None:
    """콜드가 1개면 풀을 띄우지 않는다 — 워커 비용이 이득을 넘는다.

    루프가 그 하나를 정상 경로로 계산하므로 값은 같다.
    """
    _write_stock_date(tmp_path, date="20260610", code="005930")

    engine = QueryEngine(tmp_path)
    try:
        assert _run(engine, ["20260610"]) == 0
    finally:
        engine.close()


def test_prefetch_excludes_today(tmp_path: Path) -> None:
    """오늘자는 디스크 캐시가 없다(ADR-0043) — TODAY_TTL 의 몫이다."""
    _write_stock_date(tmp_path, date=_TODAY, code="005930")
    _write_stock_date(tmp_path, date="20260610", code="005930")

    engine = QueryEngine(tmp_path)
    try:
        # 과거일이 1개뿐이라 `_MIN_PREFETCH_TARGETS` 에도 걸린다 — 오늘이 후보에
        # 들어갔다면 2가 되어 이 단언이 깨진다.
        assert _run(engine, [_TODAY, "20260610"]) == 0
    finally:
        engine.close()


def test_prefetch_failure_does_not_propagate(tmp_path: Path) -> None:
    """워밍 실패가 요청을 죽이면 안 된다 — 루프가 같은 날짜를 정상 계산한다.

    **막는 방향**: prefetch 안의 예외가 `/api/range` 를 500 으로 만드는 것. 이
    경로는 순수한 최적화라 실패의 올바른 결과는 "조금 느림" 이지 에러가 아니다.
    """
    dates = ["20260610", "20260611"]
    for d in dates:
        _write_stock_date(tmp_path, date=d, code="005930")

    engine = QueryEngine(tmp_path)
    try:
        with patch.object(
            snapshots_tbl, "query_day_ask_bid_peak_dual_with_rep",
            side_effect=RuntimeError("boom"),
        ):
            assert _run(engine, dates) == 2  # 대상 수는 그대로, 예외는 삼켜진다
        # 캐시는 비어 있어야 한다 — 실패했으니 저장된 것이 없다.
        one = snapshots_tbl.ONE_MINUTE_MS
        assert not engine.indicators_cache.has_ask_peak(
            "005930", "20260610", "hogaplay", one, venue="KRX",
        )
    finally:
        engine.close()
