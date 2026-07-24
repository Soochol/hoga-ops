from types import SimpleNamespace
from typing import cast

import pytest

from hoga.api import bundle
from hoga.api.queries import QueryEngine
from tools import profile_live_range


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
        request_kwargs={"mode": "hoga"},
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


def test_parser_requires_explicit_data_dir() -> None:
    parser = profile_live_range.build_parser()
    with pytest.raises(SystemExit) as exc:
        parser.parse_args([
            "--code", "005930", "--from", "20260701", "--to", "20260724",
        ])
    assert exc.value.code == 2


def test_parser_help_lists_only_supported_modes() -> None:
    help_text = profile_live_range.build_parser().format_help()

    assert "{hoga,sidecar,candles}" in help_text
    assert "full" not in help_text
