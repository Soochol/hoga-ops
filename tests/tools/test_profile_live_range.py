import json
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from pydantic import ValidationError

from hoga.api import bundle
from hoga.api.queries import QueryEngine
from tools import profile_live_range
from tools.range_request_manifest import RangeRequestManifest, load_request_manifest

MANIFEST_DIR = (
    Path(__file__).resolve().parents[2]
    / "docs"
    / "superpowers"
    / "measurements"
    / "2026-07-24-backend-performance"
    / "manifests"
)


def _manifest_payload(
    *,
    name: str = "test-sidecar",
    volume_distribution_bins: int | None = None,
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "name": name,
        "request": {
            "bucket_ms": 60_000,
            "source_pref": "hogaplay_first",
            "mode": "sidecar",
            "broker_late_entries_enabled": False,
            "broker_late_entry_start_hhmm": 930,
            "volume_distribution_bins": volume_distribution_bins,
            "trade_volume_poc_bins": None,
            "volume_distribution_price_min": None,
            "volume_distribution_price_max": None,
            "volume_distribution_cutoff_ms": None,
            "ask_peaks_enabled": False,
            "bid_peaks_enabled": False,
            "program_trade_enabled": False,
            "trade_volume_poc_enabled": False,
            "depth_heatmap_enabled": False,
            "depth_delta_enabled": False,
        },
    }


def _manifest(**kwargs: object) -> RangeRequestManifest:
    return RangeRequestManifest.model_validate(_manifest_payload(**kwargs))


def test_profile_registry_matches_current_bundle() -> None:
    missing = [
        name for name in profile_live_range.PROFILED_FUNCTIONS
        if not hasattr(bundle, name)
    ]
    assert missing == []


def test_profile_modes_match_api_contract() -> None:
    assert profile_live_range.SUPPORTED_MODES == ("hoga", "sidecar", "candles")
    assert "full" not in profile_live_range.SUPPORTED_MODES


def test_profile_range_case_reports_timings_and_restores_bundle_functions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    builder_calls = 0

    def builder(*args: object, **kwargs: object) -> None:
        nonlocal builder_calls
        builder_calls += 1

    monkeypatch.setattr(bundle, "build_program_trade_series", builder)
    original_builder = bundle.build_program_trade_series

    def build_range_bundle(*args: object, **kwargs: object) -> SimpleNamespace:
        bundle.build_program_trade_series()
        return SimpleNamespace(
            segments=[],
            candles=[],
            quote_ratio=SimpleNamespace(points=[]),
            fill_strength=SimpleNamespace(points=[]),
            ask_peaks=[],
            bid_peaks=[],
            depth_heatmap=[],
            depth_delta=[],
        )

    monkeypatch.setattr(bundle, "build_range_bundle", build_range_bundle)

    result = profile_live_range.profile_range_case(
        cast(QueryEngine, object()),
        label="case",
        request_manifest=_manifest(),
        code="005930",
        from_date="20260701",
        to_date="20260724",
    )

    assert builder_calls == 1
    assert result["label"] == "case"
    assert result["result_counts"] == {
        "segments": 0,
        "candles": 0,
        "quote_ratio": 0,
        "fill_strength": 0,
        "ask_peaks": 0,
        "bid_peaks": 0,
        "depth_heatmap": 0,
        "depth_delta": 0,
    }
    function = result["functions"]["build_program_trade_series"]
    assert function["total_ms"] >= 0
    assert function["calls"] == 1
    assert bundle.build_program_trade_series is original_builder
    assert result["configuration_name"] == "test-sidecar"
    assert result["request_manifest"]["request"]["ask_peaks_enabled"] is False
    assert len(result["request_manifest_sha256"]) == 64


def test_profile_uses_fixture_only_calendar_for_populated_weekday_inventory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "parquet" / "20260701").mkdir(parents=True)
    calendar_called = False

    def forbidden_calendar_call(date: str) -> bool:
        nonlocal calendar_called
        calendar_called = True
        raise AssertionError("Range measurements must not call the external calendar")

    monkeypatch.setattr("hoga.api.calendar.is_trading_day", forbidden_calendar_call)
    engine = QueryEngine(tmp_path)
    try:
        result = profile_live_range.profile_range_case(
            engine,
            label="fixture-only-calendar",
            request_manifest=_manifest(),
            code="005930",
            from_date="20260701",
            to_date="20260701",
        )
    finally:
        engine.close()

    assert calendar_called is False
    assert result["trading_calendar_policy"] == "fixture-weekday-lenient-v1"


def test_parser_requires_explicit_data_dir() -> None:
    parser = profile_live_range.build_parser()
    with pytest.raises(SystemExit) as exc:
        parser.parse_args([
            "--code", "005930", "--from", "20260701", "--to", "20260724",
        ])
    assert exc.value.code == 2


def test_parser_requires_explicit_request_manifest() -> None:
    parser = profile_live_range.build_parser()
    with pytest.raises(SystemExit) as exc:
        parser.parse_args([
            "--data-dir",
            "/fixture",
            "--code",
            "005930",
            "--from",
            "20260701",
            "--to",
            "20260724",
        ])
    assert exc.value.code == 2


def test_manifest_rejects_unknown_and_missing_required_fields() -> None:
    unknown = _manifest_payload()
    unknown["request"]["unexpected"] = True
    with pytest.raises(ValidationError, match="unexpected"):
        RangeRequestManifest.model_validate(unknown)

    missing = _manifest_payload()
    del missing["request"]["depth_delta_enabled"]
    with pytest.raises(ValidationError, match="depth_delta_enabled"):
        RangeRequestManifest.model_validate(missing)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("bucket_ms", 61_000),
        ("volume_distribution_bins", 4),
        ("trade_volume_poc_bins", 31),
        ("broker_late_entry_start_hhmm", 1_521),
        ("volume_distribution_price_min", -1),
        ("volume_distribution_cutoff_ms", -1),
    ],
)
def test_manifest_rejects_invalid_numeric_bounds(field: str, value: int) -> None:
    payload = _manifest_payload()
    payload["request"][field] = value
    if field == "volume_distribution_price_min":
        payload["request"]["volume_distribution_price_max"] = 10

    with pytest.raises(ValidationError, match=field):
        RangeRequestManifest.model_validate(payload)


def test_manifest_rejects_coerced_numeric_and_boolean_types() -> None:
    numeric_string = _manifest_payload()
    numeric_string["request"]["volume_distribution_bins"] = "10"
    with pytest.raises(ValidationError, match="volume_distribution_bins"):
        RangeRequestManifest.model_validate(numeric_string)

    truthy_integer = _manifest_payload()
    truthy_integer["request"]["ask_peaks_enabled"] = 1
    with pytest.raises(ValidationError, match="ask_peaks_enabled"):
        RangeRequestManifest.model_validate(truthy_integer)


def test_manifest_rejects_unpaired_or_reversed_price_range() -> None:
    unpaired = _manifest_payload()
    unpaired["request"]["volume_distribution_price_min"] = 100
    with pytest.raises(ValidationError, match="supplied together"):
        RangeRequestManifest.model_validate(unpaired)

    reversed_range = _manifest_payload()
    reversed_range["request"]["volume_distribution_price_min"] = 200
    reversed_range["request"]["volume_distribution_price_max"] = 100
    with pytest.raises(ValidationError, match="price_max"):
        RangeRequestManifest.model_validate(reversed_range)


@pytest.mark.parametrize("code", ["0000H0", "Q500093"])
def test_manifest_request_kwargs_accepts_every_api_code_shape(code: str) -> None:
    kwargs = _manifest().request_kwargs(
        code=code,
        from_date="20260701",
        to_date="20260701",
    )

    assert kwargs["code"] == code


def test_manifest_request_kwargs_rejects_cutoff_outside_stock_date() -> None:
    payload = _manifest_payload()
    payload["request"]["volume_distribution_cutoff_ms"] = 1_780_819_201_000
    manifest = RangeRequestManifest.model_validate(payload)

    with pytest.raises(ValueError, match="not within Stock-Date"):
        manifest.request_kwargs(
            code="005930",
            from_date="20260701",
            to_date="20260701",
        )


def test_manifest_loader_records_basename_without_absolute_path(tmp_path: Path) -> None:
    path = tmp_path / "frontend-default-sidecar.json"
    path.write_text(json.dumps(_manifest_payload()), encoding="utf-8")

    loaded = load_request_manifest(path)

    assert loaded.source_name == "frontend-default-sidecar.json"
    assert str(tmp_path) not in json.dumps(loaded.metadata())


def test_enabled_manifest_invokes_and_times_volume_distribution_without_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_kwargs: dict[str, object] = {}
    volume_calls = 0

    def volume_builder(*args: object, **kwargs: object) -> None:
        nonlocal volume_calls
        volume_calls += 1

    def build_range_bundle(*args: object, **kwargs: object) -> SimpleNamespace:
        captured_kwargs.update(kwargs)
        if kwargs["volume_distribution_bins"] is not None:
            bundle.build_volume_distribution_slice()
        return SimpleNamespace(
            segments=[],
            candles=[],
            quote_ratio=SimpleNamespace(points=[]),
            fill_strength=SimpleNamespace(points=[]),
            ask_peaks=[],
            bid_peaks=[],
            depth_heatmap=[],
            depth_delta=[],
        )

    monkeypatch.setattr(bundle, "build_volume_distribution_slice", volume_builder)
    monkeypatch.setattr(bundle, "build_range_bundle", build_range_bundle)

    result = profile_live_range.profile_range_case(
        cast(QueryEngine, object()),
        label="volume-enabled",
        request_manifest=_manifest(volume_distribution_bins=10),
        code="005930",
        from_date="20260701",
        to_date="20260724",
    )

    assert volume_calls == 1
    assert captured_kwargs["volume_distribution_bins"] == 10
    assert captured_kwargs["ask_peaks_enabled"] is False
    assert result["functions"]["build_volume_distribution_slice"]["calls"] == 1


def test_committed_representative_manifests_are_strict_and_distinct() -> None:
    default = load_request_manifest(MANIFEST_DIR / "frontend-default-sidecar.json")
    volume = load_request_manifest(
        MANIFEST_DIR / "volume-distribution-enabled-sidecar.json"
    )

    assert default.manifest.request.volume_distribution_bins is None
    assert default.manifest.request.ask_peaks_enabled is False
    assert volume.manifest.request.volume_distribution_bins == 10
    assert volume.manifest.request.volume_distribution_price_min is None
    assert volume.manifest.request.volume_distribution_price_max is None
    assert default.manifest.sha256() != volume.manifest.sha256()
