"""build_depth_heatmap_slice 의 PastIndicatorsCache 배선 (형제 지표와 동일 게이트).

호가 잔량 히트맵은 과거일 결과가 불변이므로 (code, date, source, bucket_ms) 로
1회 계산 후 재사용한다. 좌측 팬 워크백·토글 refetch 마다 전액 재스캔하던
~27ms/일(실측)을 캐시 히트로 제거하는 것이 목적. 오늘은 프로모션 진행 중이라
항상 재계산(ADR-0043) — 게이트는 형제 빌더와 공유하는 _indicator_cacheable.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from hoga.api import bundle as bundle_mod
from hoga.api.bundle import build_depth_heatmap_slice
from hoga.api.queries import QueryEngine

_KST = timezone(timedelta(hours=9))

CODE = "005930"
DATE = "20260625"  # 확정 과거일
CLOSE_MS = 153_000_000  # 15:30:00.000 HHMMSSmmm


def _hms_native(h: int, m: int, s: int) -> int:
    return h * 10_000_000 + m * 100_000 + s * 1000


def _write_snapshots(path: Path, ts_list: list[int]) -> None:
    n = len(ts_list)
    cols: dict = {"ts_ms": ts_list, "seq": list(range(1, n + 1))}
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


def _cache_file(tmp_path: Path, bucket_ms: int = 60_000) -> Path:
    return (
        tmp_path / "kis-past-indicators" / CODE / "kis_live" / f"{DATE}.depth.{bucket_ms}.json"
    )


def test_minimal_call_applies_disk_cache_gate(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    try:
        pts = build_depth_heatmap_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
        )
    finally:
        engine.close()
    assert len(pts) == 2
    assert _cache_file(tmp_path).exists(), "과거일 depth 캐시 파일이 생성돼야 한다"


def test_minimal_call_result_equals_explicit(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    today_kst = datetime.now(_KST).strftime("%Y%m%d")
    try:
        minimal = build_depth_heatmap_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
        )
        explicit = build_depth_heatmap_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
            cache=engine.indicators_cache, today_kst=today_kst,
        )
    finally:
        engine.close()
    assert minimal == explicit


def test_explicit_none_cache_preserves_bypass(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    try:
        build_depth_heatmap_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
            cache=None, today_kst=None,
        )
    finally:
        engine.close()
    assert not _cache_file(tmp_path).exists()


def test_cache_hit_avoids_requery(tmp_path: Path, monkeypatch) -> None:
    """2회째 호출은 테이블 쿼리를 재실행하지 않고 캐시에서 반환한다 (성능 이득의 핵심)."""
    engine = _engine(tmp_path)
    calls = {"n": 0}
    real = bundle_mod.snapshots_tbl.query_bucketed_depth_heatmap

    def _counting(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(
        bundle_mod.snapshots_tbl, "query_bucketed_depth_heatmap", _counting
    )
    try:
        first = build_depth_heatmap_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
        )
        second = build_depth_heatmap_slice(
            engine, code=CODE, date=DATE, bucket_ms=60_000,
            source="kis_live", session_close_ms=CLOSE_MS,
        )
    finally:
        engine.close()
    assert first == second
    assert calls["n"] == 1, "2회째는 캐시 히트라 테이블 쿼리를 재실행하면 안 된다"
