import pytest
from pydantic import ValidationError

from hoga.api.models import (
    ParquetStudySnapshot,
    ParquetStudyView,
    ParquetStudyViewWriteRequest,
    StudyViewsFile,
)


def _snapshot(**overrides):
    base = {
        "schema_version": 1,
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot_from_ms": 1_000,
        "snapshot_to_ms": 2_000,
        "bucket_kind": "5m",
        "viewport": {"right_edge_ms": 2_000, "bar_span": 200, "at_live_edge": False},
        "indicator_state": {
            "volume_enabled": True,
            "quote_totals_enabled": True,
            "ratio_enabled": True,
            "fill_strength_enabled": True,
            "aggregation_basis": "close",
            "auction_window_mask": True,
            "ratio_outlier_filter_enabled": True,
            "ratio_outlier_threshold": 50,
        },
        "provenance": {"saved_from_route": "/live", "data_provenance": "live_mixed"},
        "bundle": {
            "code": "005930",
            "timeframe": "5m",
            "snapshot_from_ms": 1_000,
            "snapshot_to_ms": 2_000,
            "segments": [{"date": "20260616", "session_open_ms": 1_000, "session_close_ms": 2_000}],
            "candles": [{"t": 1_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}],
            "quote_totals": [{"t": 1_000, "bid_total": 100, "ask_total": 90, "visible": True}],
            "ratio": [{"t": 1_000, "value": 0.1, "visible": True}],
            "fill_strength": [{"t": 1_000, "buy_qty": 5, "sell_qty": 4, "visible": True}],
            "data_warnings": [],
        },
        "captured_at_ms": 3_000,
    }
    base.update(overrides)
    return base


def _req(**overrides):
    snap = _snapshot()
    base = {
        "name": "삼성전자 5분봉 2026.06.16",
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot_from_ms": 1_000,
        "snapshot_to_ms": 2_000,
        "viewport": snap["viewport"],
        "indicator_state": snap["indicator_state"],
        "snapshot": snap,
        "provenance": snap["provenance"],
    }
    base.update(overrides)
    return base


def _view(**overrides):
    snap = _snapshot()
    base = {
        "id": "study_1",
        "name": "삼성전자 5분봉 2026.06.16",
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot_from_ms": 1_000,
        "snapshot_to_ms": 2_000,
        "viewport": snap["viewport"],
        "indicator_state": snap["indicator_state"],
        "memo": "",
        "tags": [],
        "provenance": snap["provenance"],
        "snapshot_schema_version": 1,
        "snapshot_path": "snapshots/study_1.parquet",
        "snapshot_size_bytes": 123,
        "created_at_ms": 3_000,
        "updated_at_ms": 3_000,
    }
    base.update(overrides)
    return base


def test_study_view_write_request_trims_name_and_defaults_memo_tags():
    req = ParquetStudyViewWriteRequest.model_validate(_req(name="  내 저장뷰  "))
    assert req.name == "내 저장뷰"
    assert req.memo == ""
    assert req.tags == []


def test_study_view_write_request_rejects_whitespace_name():
    with pytest.raises(ValidationError):
        ParquetStudyViewWriteRequest.model_validate(_req(name="   "))


def test_study_view_write_request_rejects_snapshot_metadata_mismatch():
    bad = _req(snapshot=_snapshot(code="000660"))
    with pytest.raises(ValidationError):
        ParquetStudyViewWriteRequest.model_validate(bad)


def test_study_snapshot_allows_hidden_indicator_without_numeric_value():
    snap = _snapshot()
    snap["bundle"]["ratio"] = [{"t": 1_000, "visible": False}]
    parsed = ParquetStudySnapshot.model_validate(snap)
    assert parsed.bundle.ratio[0].visible is False


def test_study_snapshot_rejects_unsorted_candles():
    snap = _snapshot()
    snap["bundle"]["candles"] = [
        {"t": 2_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10},
        {"t": 1_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10},
    ]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


@pytest.mark.parametrize(
    ("series_name", "point"),
    [
        ("quote_totals", {"t": 1_000, "ask_total": 90, "visible": True}),
        ("ratio", {"t": 1_000, "visible": True}),
        ("fill_strength", {"t": 1_000, "buy_qty": 5, "visible": True}),
    ],
)
def test_study_snapshot_rejects_visible_indicator_points_missing_numeric_values(series_name, point):
    snap = _snapshot()
    snap["bundle"][series_name] = [point]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


@pytest.mark.parametrize(
    ("series_name", "point"),
    [
        ("quote_totals", {"t": 1_000, "bid_total": float("nan"), "ask_total": 90, "visible": True}),
        ("ratio", {"t": 1_000, "value": float("inf"), "visible": True}),
        ("fill_strength", {"t": 1_000, "buy_qty": 5, "sell_qty": float("-inf"), "visible": True}),
    ],
)
def test_study_snapshot_rejects_visible_indicator_points_with_non_finite_values(series_name, point):
    snap = _snapshot()
    snap["bundle"][series_name] = [point]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


def test_study_snapshot_rejects_non_finite_candle_values():
    snap = _snapshot()
    snap["bundle"]["candles"] = [
        {"t": 1_000, "open": 1, "high": float("nan"), "low": 1, "close": 2, "volume": 10}
    ]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


def test_study_snapshot_rejects_non_finite_indicator_threshold():
    snap = _snapshot()
    snap["indicator_state"] = {**snap["indicator_state"], "ratio_outlier_threshold": float("inf")}
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


def test_parquet_study_view_trims_name():
    view = ParquetStudyView.model_validate(_view(name="  내 저장뷰  "))
    assert view.name == "내 저장뷰"


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": "   "},
        {"code": "bad"},
        {"snapshot_from_ms": 2_000, "snapshot_to_ms": 1_000},
    ],
)
def test_parquet_study_view_rejects_invalid_manifest_metadata(overrides):
    with pytest.raises(ValidationError):
        ParquetStudyView.model_validate(_view(**overrides))


def test_study_views_file_defaults_empty():
    assert StudyViewsFile().schema_version == 1
    assert StudyViewsFile().saves == []
