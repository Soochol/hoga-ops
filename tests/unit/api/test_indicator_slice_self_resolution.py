"""WS3: 지표 슬라이스 빌더의 cache/today_kst 자가-해석 (ADR-0043/0090 게이트 내재화).

호출자가 cache/today_kst를 넘기지 않으면 빌더가 engine.indicators_cache와
현재 KST 날짜로 스스로 게이트를 적용한다 — 과거일 분-배수 버킷이면 디스크
1분 캐시가 자동으로 채워져야 한다. `None` 명시는 기존대로 "캐시 미적용".
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from hoga.api.bundle import build_quote_ratio_slice
from hoga.api.queries import QueryEngine

_KST = timezone(timedelta(hours=9))

CODE = "005930"
DATE = "20260625"  # 확정 과거일 (테스트 실행 시점 기준 항상 과거)
CLOSE_MS = 153_000_000  # 15:30:00.000 HHMMSSmmm


def _hms_native(h: int, m: int, s: int) -> int:
    return h * 10_000_000 + m * 100_000 + s * 1000


def _write_snapshots(path: Path, ts_list: list[int]) -> None:
    n = len(ts_list)
    cols: dict = {
        "ts_ms": ts_list,
        "seq": list(range(1, n + 1)),
    }
    for i in range(1, 11):
        cols[f"ask_p{i}"] = [100 + i] * n
        cols[f"ask_q{i}"] = [10 * i] * n
        cols[f"ask_d{i}"] = [0] * n
        cols[f"bid_p{i}"] = [100 - i] * n
        cols[f"bid_q{i}"] = [20 * i] * n
        cols[f"bid_d{i}"] = [0] * n
    cols["tot_ask"] = [550] * n
    cols["tot_ask_d"] = [0] * n
    cols["tot_bid"] = [1100] * n
    cols["tot_bid_d"] = [0] * n
    pq.write_table(pa.table(cols), path)


def _engine(tmp_path: Path) -> QueryEngine:
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True)
    (code_dir / "meta.json").write_text(json.dumps({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": CLOSE_MS,
        "collection_complete": True,
        "is_partial": False,
    }))
    _write_snapshots(
        code_dir / "snapshots.parquet",
        [_hms_native(9, 0, 10), _hms_native(9, 1, 10)],
    )
    return QueryEngine(tmp_path)


def _cache_file(tmp_path: Path) -> Path:
    return tmp_path / "kis-past-indicators" / CODE / "kis_live" / f"{DATE}.ratio.json"


def test_minimal_call_applies_disk_cache_gate(tmp_path: Path) -> None:
    """cache/today_kst 미지정 → 과거일 분-배수 버킷이 자동으로 디스크 캐시 적용."""
    engine = _engine(tmp_path)
    try:
        qr = build_quote_ratio_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
        )
    finally:
        engine.close()
    assert len(qr.points) == 2
    assert _cache_file(tmp_path).exists(), (
        "ADR-0043 게이트가 빌더 내부에서 적용돼야 한다 — 과거일 1분 캐시 파일 생성"
    )


def test_minimal_call_result_equals_explicit_call(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    today_kst = datetime.now(_KST).strftime("%Y%m%d")
    try:
        minimal = build_quote_ratio_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
        )
        explicit = build_quote_ratio_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
            cache=engine.indicators_cache, today_kst=today_kst,
        )
    finally:
        engine.close()
    assert minimal == explicit


def test_explicit_none_cache_preserves_bypass_semantics(tmp_path: Path) -> None:
    """cache=None 명시는 기존대로 캐시 미적용 (테스트 주입 시맨틱 보존)."""
    engine = _engine(tmp_path)
    try:
        build_quote_ratio_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
            cache=None, today_kst=None,
        )
    finally:
        engine.close()
    assert not _cache_file(tmp_path).exists()
