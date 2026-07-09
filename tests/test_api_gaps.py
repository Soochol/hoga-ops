"""WS1: GET /api/gaps + QueryEngine.compute_gap_ranges.

Surfaces continuous-trading data gaps for a source_partial Stock-Date so the
inventory drawer can tell the user WHICH windows the upstream archive is
missing (re-capture won't recover them).
"""
from __future__ import annotations

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.queries import QueryEngine
from hoga.api.timeenc import hhmmssms_to_unix_ms

_CLOSE = 153000000  # 15:30:00.000 (regular)


def _write_source(
    tmp_path: Path, code: str, date: str, ts_hhmmssms: list[int], **meta_extra: object,
) -> None:
    """Write a hogaplay source dir with a snapshots.parquet holding ts_hhmmssms."""
    sd = tmp_path / "parquet" / date / code / "hogaplay"
    sd.mkdir(parents=True)
    pq.write_table(
        pa.table({"ts_ms": pa.array(ts_hhmmssms, type=pa.int64())}),
        sd / "snapshots.parquet",
    )
    # candles.parquet is required by list_stock_dates but not by /gaps.
    pq.write_table(
        pa.table({"low": pa.array([], type=pa.int64()), "high": pa.array([], type=pa.int64()),
                  "vol_a": pa.array([], type=pa.int64()), "vol_b": pa.array([], type=pa.int64())}),
        sd / "candles.parquet",
    )
    meta = {
        "code": code, "name": "대한항공",
        "regular_session_open_ms": 90000000, "regular_session_close_ms": _CLOSE,
        "pages_collected": 10, "collection_complete": True,
        **meta_extra,
    }
    (sd / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


# --- QueryEngine.compute_gap_ranges ---------------------------------------


def test_compute_gap_ranges_meta_origin_when_field_present(tmp_path: Path) -> None:
    _write_source(
        tmp_path, "003490", "20260707", [90000000, 90001000],
        is_partial=True,
        gap_ranges=[{"start_ms": 135132000, "end_ms": 141133000}],
    )
    eng = QueryEngine(tmp_path)
    try:
        ranges, sparse, origin = eng.compute_gap_ranges("20260707", "003490", "hogaplay")
    finally:
        eng.close()
    assert origin == "meta"
    assert sparse is False
    assert ranges == [(135132000, 141133000)]


def test_compute_gap_ranges_computed_origin_for_legacy_meta(tmp_path: Path) -> None:
    # Dense 10:00:00/10:00:01 then a jump to 10:02:00 = one ≥60s gap. No
    # gap_ranges field on meta → recompute from snapshots.
    _write_source(
        tmp_path, "003490", "20260707",
        [100000000, 100001000, 100200000],
        is_partial=True,
    )
    eng = QueryEngine(tmp_path)
    try:
        ranges, sparse, origin = eng.compute_gap_ranges("20260707", "003490", "hogaplay")
    finally:
        eng.close()
    assert origin == "computed"
    assert sparse is False
    assert ranges == [(100001000, 100200000)]


def test_compute_gap_ranges_sparse_when_too_few_datapoints(tmp_path: Path) -> None:
    _write_source(tmp_path, "003490", "20260707", [90000000], is_partial=True)
    eng = QueryEngine(tmp_path)
    try:
        ranges, sparse, origin = eng.compute_gap_ranges("20260707", "003490", "hogaplay")
    finally:
        eng.close()
    assert ranges == []
    assert sparse is True
    assert origin == "computed"


# --- GET /api/gaps route ---------------------------------------------------


def test_gaps_route_converts_boundaries_to_unix_ms(tmp_path: Path) -> None:
    _write_source(
        tmp_path, "003490", "20260707",
        [100000000, 100001000, 100200000],
        is_partial=True,
    )
    client = TestClient(create_app(data_dir=tmp_path))
    resp = client.get("/api/gaps", params={"code": "003490", "date": "20260707"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["origin"] == "computed"
    assert body["sparse"] is False
    assert body["source"] == "hogaplay"
    assert body["gap_ranges"] == [{
        "start_ms": hhmmssms_to_unix_ms("20260707", 100001000),
        "end_ms": hhmmssms_to_unix_ms("20260707", 100200000),
    }]


def test_gaps_route_rejects_non_hogaplay_source(tmp_path: Path) -> None:
    _write_source(tmp_path, "003490", "20260707", [90000000, 90001000])
    client = TestClient(create_app(data_dir=tmp_path))
    resp = client.get(
        "/api/gaps",
        params={"code": "003490", "date": "20260707", "source": "kis_live"},
    )
    assert resp.status_code == 400


def test_gaps_route_404_for_missing_stock_date(tmp_path: Path) -> None:
    client = TestClient(create_app(data_dir=tmp_path))
    resp = client.get("/api/gaps", params={"code": "003490", "date": "20260707"})
    assert resp.status_code == 404
