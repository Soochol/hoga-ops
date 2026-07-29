"""build_volume_distribution_slice 의 PastIndicatorsCache 배선 (POC/depth 패턴).

체결 분포는 과거일 결과가 불변 → (code,date,source,range_count,price_min,price_max)
결과 캐시로 trades.parquet 풀스캔 재지불을 제거한다. cutoff_ms 요청은 캐시 우회.
MagicMock engine + 실 PastIndicatorsCache 주입 + 테이블 쿼리 patch 로 "히트 시
재쿼리 회피"를 검증한다(실 parquet 불필요 — 존재 검사만 통과시키면 된다)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from hoga.api import bundle as bundle_mod
from hoga.api.bundle import build_volume_distribution_slice
from hoga.api.past_indicators_cache import PastIndicatorsCache
from hoga.tables.trades import VolumeProfileBinning

_KST = timezone(timedelta(hours=9))
CODE = "005930"
PAST = "20260512"  # 확정 과거일
SRC = "hogaplay"
_BINNING = VolumeProfileBinning(
    price_min=70_000, price_max=71_000, bin_width=100.0, bins=[(0, 123)], max_intra_ms=32_460_000
)


def _engine(tmp_path: Path) -> MagicMock:
    code_dir = tmp_path / PAST / CODE
    code_dir.mkdir(parents=True)
    (code_dir / "candles.parquet").touch()
    (code_dir / "trades.parquet").touch()
    engine = MagicMock()
    engine.conn = object()
    engine.parquet_dir.return_value = code_dir
    engine.indicators_cache = PastIndicatorsCache(tmp_path)
    return engine


def _call(engine, *, date: str = PAST, cutoff_ms: int | None = None):
    """기본(자가-해석 캐시) 호출. cache/today_kst 우회가 필요한 테스트는 빌더를 직접 호출."""
    return build_volume_distribution_slice(
        engine, code=CODE, date=date, source=SRC,
        session_open_ms=90_000_000, session_close_ms=153_000_000, range_count=10,
        price_min=70_000, price_max=71_000, cutoff_ms=cutoff_ms,
    )


def test_cache_hit_avoids_requery(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    with patch.object(
        bundle_mod.trades_tbl, "query_continuous_trade_volume_distribution",
        return_value=_BINNING,
    ) as q:
        first = _call(engine)
        second = _call(engine)
    assert first == second
    assert q.call_count == 1, "2회째는 캐시 히트라 trades 스캔을 재실행하면 안 된다"


def test_cutoff_request_is_not_cached(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    # cutoff 수학은 이 테스트 관심사가 아니라(캐시 우회만 검증) 변환도 patch.
    with patch.object(
        bundle_mod.trades_tbl, "query_continuous_trade_volume_distribution",
        return_value=_BINNING,
    ) as q, \
         patch.object(bundle_mod.trades_tbl, "_session_bound_to_intra_ms", return_value=0), \
         patch.object(bundle_mod, "unix_ms_to_hhmmssms", return_value=100_000_000):
        _call(engine, cutoff_ms=1_700_000_000_000)
        _call(engine, cutoff_ms=1_700_000_000_000)
    assert q.call_count == 2, "cutoff variant 는 캐시 우회 — 매번 재계산"


def _direct(engine, *, date: str, cache, today_kst):
    return build_volume_distribution_slice(
        engine, code=CODE, date=date, source=SRC,
        session_open_ms=90_000_000, session_close_ms=153_000_000, range_count=10,
        price_min=70_000, price_max=71_000, cache=cache, today_kst=today_kst,
    )


def test_explicit_none_cache_bypasses(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    with patch.object(
        bundle_mod.trades_tbl, "query_continuous_trade_volume_distribution",
        return_value=_BINNING,
    ) as q:
        _direct(engine, date=PAST, cache=None, today_kst=None)
        _direct(engine, date=PAST, cache=None, today_kst=None)
    assert q.call_count == 2


def test_today_second_call_within_ttl_skips_query(tmp_path: Path) -> None:
    # ADR-0090: 오늘자(cutoff 없음)는 디스크 캐시 대신 short-TTL 프로세스 캐시.
    # TTL 창 내 2회째는 trades 풀스캔 GROUP BY를 재실행하지 않는다.
    engine = _engine(tmp_path)
    today = datetime.now(_KST).strftime("%Y%m%d")
    with patch.object(
        bundle_mod.trades_tbl, "query_continuous_trade_volume_distribution",
        return_value=_BINNING,
    ) as q:
        _direct(engine, date=today, cache=engine.indicators_cache, today_kst=today)
        _direct(engine, date=today, cache=engine.indicators_cache, today_kst=today)
    assert q.call_count == 1, "오늘 TTL 창 내 2회째는 캐시 히트"


# ---------------------------------------------------------------------------
# cutoff → upper_bound_ms 변환 (2026-07-30)
#
# 위 캐시 테스트들은 cutoff 수학을 관심 밖으로 두고 `_session_bound_to_intra_ms`
# 자체를 patch 한다(test_cutoff_request_is_not_cached:67 이 return_value=0). 그래서
# **변환이 틀려도 초록이었다** — 아래가 그 사각을 메운다.
#
# 결함: bundle 이 unix_ms_to_hhmmssms 로 만든 값(항상 HHMMSSmmm)을 휴리스틱 래퍼
# `_session_bound_to_intra_ms` 에 넘겼는데, 그 래퍼는 `value > 86_400_000` 일 때만
# HHMMSSmmm 으로 보고 디코드한다. 09:00 미만 커서는 HHMMSSmmm 이 그 임계
# (=08:64:00.000, 존재하지 않는 시각) 아래라 linear ms 로 오인되어 원값이 통과했다.
# 그러면 query_volume_distribution 의 min(session_close, upper_bound, ...) 에서
# 장 마감이 이겨 **cutoff 가 조용히 무시되고 하루 전체 분포가 반환**됐다.
# ---------------------------------------------------------------------------


def _upper_bound_for(engine, *, hh: int, mm: int) -> int | None:
    """주어진 KST 시각으로 cutoff 를 걸었을 때 trades 쿼리에 넘어간 upper_bound_ms."""
    cutoff_unix = int(datetime(2026, 5, 12, hh, mm, tzinfo=_KST).timestamp() * 1000)
    with patch.object(
        bundle_mod.trades_tbl, "query_continuous_trade_volume_distribution",
        return_value=_BINNING,
    ) as q:
        _call(engine, cutoff_ms=cutoff_unix)
    return q.call_args.kwargs.get("upper_bound_ms")


def test_pre_open_cutoff_decodes_to_intra_ms(tmp_path: Path) -> None:
    """09:00 **이전** 커서도 장중 ms 로 정확히 디코드돼야 한다.

    08:30 은 HHMMSSmmm 으로 83_000_000 이고 올바른 intra_ms 는 30_600_000 이다.
    회귀 시에는 83_000_001 이 넘어가 23.06h 로 해석되고, 하류 min() 에서 장 마감
    (55_800_000)이 이겨 cutoff 가 사라진다.
    """
    got = _upper_bound_for(_engine(tmp_path), hh=8, mm=30)
    assert got == 30_600_000 + 1, (
        f"08:30 커서의 upper_bound_ms 가 {got} — 30_600_001 이어야 한다. "
        "HHMMSSmmm 을 linear ms 로 오인하면 83_000_001 이 된다."
    )


def test_pre_open_cutoff_actually_bounds_the_session(tmp_path: Path) -> None:
    """디코딩이 틀리면 장 마감보다 큰 값이 나와 cutoff 가 무력화된다 — 그 경계를 고정."""
    session_close_intra_ms = 55_800_000  # 15:30
    for hh, mm in ((8, 30), (8, 45), (8, 59)):
        got = _upper_bound_for(_engine(tmp_path / f"{hh}{mm}"), hh=hh, mm=mm)
        assert got is not None and got <= session_close_intra_ms, (
            f"{hh:02d}:{mm:02d} 커서가 장 마감({session_close_intra_ms})보다 큰 "
            f"{got} 로 변환됐다 — min() 에서 밀려 cutoff 가 조용히 무시된다."
        )


def test_post_open_cutoff_unchanged(tmp_path: Path) -> None:
    """09:00 이후는 원래도 맞았다 — 수정이 그쪽을 건드리지 않았는지 확인."""
    assert _upper_bound_for(_engine(tmp_path / "a"), hh=10, mm=0) == 36_000_000 + 1
    assert _upper_bound_for(_engine(tmp_path / "b"), hh=15, mm=20) == 55_200_000 + 1
