from __future__ import annotations

import json
import logging
from contextlib import ExitStack
from datetime import datetime
from unittest.mock import patch

import pytest

from hoga.api import bundle, prewarm_usage
from tests.hoga.api.test_bundle import _engine_with_meta_for_dates, _patch_slice_builders
from tests.unit.api.test_peak_prewarm import _prewarm, _write_stock_date
from tools.report_prewarm_usage import summarize


def test_only_successful_real_warms_emit_usage(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger="hoga.api.prewarm_usage")
    _write_stock_date(tmp_path, date="20260610", code="005930")
    _prewarm(tmp_path, dry_run=True)
    assert not [r for r in caplog.records if r.name == prewarm_usage.__name__]
    _prewarm(tmp_path)
    _prewarm(tmp_path)  # already warm: must not inflate the denominator
    rows = [json.loads(r.getMessage().split(prewarm_usage.MARKER)[1])
            for r in caplog.records if r.name == prewarm_usage.__name__]
    assert len(rows) == 1
    assert rows[0]["event"] == "warm"
    assert rows[0]["data_dir"] == str(tmp_path)
    assert rows[0]["elapsed_ms"] >= 0


@pytest.mark.parametrize("mode,enabled,observe,expected", [
    ("sidecar", True, True, ["peak", "depth"]),
    ("sidecar", False, True, ["depth"]),
    ("hoga", True, True, []),
    ("candles", True, True, []),
    ("sidecar", True, False, []),
])
def test_demand_respects_scope_today_and_diagnostic_callers(tmp_path, mode, enabled, observe, expected):
    engine = _engine_with_meta_for_dates(["20260512", "20260615"])
    engine.data_dir = tmp_path
    with ExitStack() as stack:
        for context in _patch_slice_builders(bundle):
            stack.enter_context(context)
        stack.enter_context(patch.object(bundle, "build_depth_heatmap_slice", return_value=[]))
        stack.enter_context(patch.object(bundle, "now_kst", return_value=datetime(2026, 6, 15)))
        log = stack.enter_context(patch.object(bundle, "record_usage"))
        bundle.build_range_bundle(
            engine, code="005930", from_date="20260512", to_date="20260615", bucket_ms=60_000,
            mode=mode, ask_peaks_enabled=enabled, bid_peaks_enabled=enabled,
            broker_late_entries_enabled=False, program_trade_enabled=False,
            record_prewarm_demand=observe,
        )
    dates = log.call_args.kwargs["dates"]
    assert dates == ([{"date": "20260512", "source": "hogaplay", "kinds": expected}] if expected else [])


def test_cohort_excludes_early_demands_other_sources_roots_and_recent_warms(tmp_path):
    hour = 3_600_000_000_000

    def event(kind, at, *, source="hogaplay", code="005930", root=tmp_path):
        return {"v": 1, "event": kind, "at_ns": at * hour, "data_dir": str(root),
                "code": code, "venue": "KRX", "dates": [
                    {"date": "20260610", "source": source, "kinds": ["peak", "depth"]},
                ]}

    events = [
        event("demand", 1), event("warm", 2), event("warm", 2),  # duplicate input
        event("demand", 3, source="kiwoom_live"),
        event("demand", 4, root=tmp_path / "other"),
        event("warm", 3, code="000660"), event("demand", 5, code="000660"),
        event("warm", 29), event("demand", 30),  # pending even though already requested
        event("warm", 31, source="kiwoom_live"),
    ]
    result = summarize(events, data_dir=tmp_path)
    assert result["totals"] == {"warm_builds": 4, "pending": 2, "mature": 2, "demanded": 1, "unobserved": 1}
    assert result["demand_rate"] == 0.5
    assert result["by_source"]["kiwoom_live"]["warm_builds"] == 1
    assert summarize([], data_dir=tmp_path)["demand_rate"] is None
