"""build_broker_late_entries_slice 의 PastIndicatorsCache 배선.

거래원 지각 진입은 과거일 이벤트가 불변 → (code,date,source,start_hhmm) 캐시로
brokers.parquet 풀스캔을 제거한다. MagicMock engine + 실 PastIndicatorsCache +
쿼리 patch 로 "히트 시 재쿼리 회피"를 검증(실 parquet 불필요)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from hoga.api import bundle as bundle_mod
from hoga.api.bundle import build_broker_late_entries_slice
from hoga.api.past_indicators_cache import PastIndicatorsCache
from hoga.tables.brokers import BrokerLateEntryEventRow

_KST = timezone(timedelta(hours=9))
CODE = "005930"
PAST = "20260512"
SRC = "hogaplay"
_ROWS = [BrokerLateEntryEventRow(t_ms=100_000_000, broker="미래에셋", side="buy", net=1200)]


def _engine(tmp_path: Path) -> MagicMock:
    code_dir = tmp_path / PAST / CODE
    code_dir.mkdir(parents=True)
    (code_dir / "brokers.parquet").touch()
    engine = MagicMock()
    engine.conn = object()
    engine.parquet_dir.return_value = code_dir
    engine.indicators_cache = PastIndicatorsCache(tmp_path)
    return engine


def test_cache_hit_avoids_requery(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    with patch.object(
        bundle_mod.brokers_tbl, "query_late_entry_events", return_value=_ROWS
    ) as q:
        first = build_broker_late_entries_slice(engine, code=CODE, date=PAST, source=SRC, start_hhmm=930)
        second = build_broker_late_entries_slice(engine, code=CODE, date=PAST, source=SRC, start_hhmm=930)
    assert first == second
    assert q.call_count == 1, "2회째는 캐시 히트라 brokers 스캔을 재실행하면 안 된다"


def test_start_hhmm_is_part_of_key(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    with patch.object(
        bundle_mod.brokers_tbl, "query_late_entry_events", return_value=_ROWS
    ) as q:
        build_broker_late_entries_slice(engine, code=CODE, date=PAST, source=SRC, start_hhmm=930)
        build_broker_late_entries_slice(engine, code=CODE, date=PAST, source=SRC, start_hhmm=1000)
    assert q.call_count == 2, "start_hhmm 이 다르면 별도 캐시 엔트리 → 재쿼리"


def test_explicit_none_cache_bypasses(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    with patch.object(
        bundle_mod.brokers_tbl, "query_late_entry_events", return_value=_ROWS
    ) as q:
        for _ in range(2):
            build_broker_late_entries_slice(
                engine, code=CODE, date=PAST, source=SRC, start_hhmm=930,
                cache=None, today_kst=None,
            )
    assert q.call_count == 2


def test_today_second_call_within_ttl_skips_query(tmp_path: Path) -> None:
    # ADR-0090: 오늘자는 디스크 캐시 대신 short-TTL 프로세스 캐시(brokers.parquet
    # 존재). TTL 창 내 2회째는 풀스캔을 재실행하지 않는다.
    engine = _engine(tmp_path)
    today = datetime.now(_KST).strftime("%Y%m%d")
    with patch.object(
        bundle_mod.brokers_tbl, "query_late_entry_events", return_value=_ROWS
    ) as q:
        for _ in range(2):
            build_broker_late_entries_slice(
                engine, code=CODE, date=today, source=SRC, start_hhmm=930,
                cache=engine.indicators_cache, today_kst=today,
            )
    assert q.call_count == 1, "오늘 TTL 창 내 2회째는 캐시 히트"
