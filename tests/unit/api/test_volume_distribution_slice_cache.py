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
