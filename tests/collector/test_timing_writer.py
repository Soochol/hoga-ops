import json
from pathlib import Path

import pytest

from hoga.api.models import (
    TimingEnv,
    TimingPageDetail,
    TimingPhaseTotals,
    TimingReport,
    TimingSummary,
)
from hoga.collector.timing_writer import write_timing_report


def _make_report(code: str = "005930", date: str = "20250520") -> TimingReport:
    return TimingReport(
        summary=TimingSummary(
            code=code,
            date=date,
            started_at_kst="2026-05-27T14:32:18+09:00",
            ended_at_kst="2026-05-27T14:33:02+09:00",
            total_ms=1000.0,
            phase_totals_ms=TimingPhaseTotals(http_fetch_ms=1000.0),
            phase_percentages={
                "http_fetch": 100.0,
                "parse": 0.0,
                "disk_write": 0.0,
                "rate_limit": 0.0,
                "backoff": 0.0,
                "cookie_pause": 0.0,
                "other": 0.0,
            },
            unaccounted_ms=0.0,
            page_count=1,
            event_count=10,
            error_counts={},
            env=TimingEnv(
                rate_limit_s=0.05,
                max_concurrent=3,
                page_step_ms_initial=60000,
                hoga_version="0.1.0",
                git_sha=None,
            ),
        ),
        pages=[TimingPageDetail(idx=0, http_ms=1000.0, parse_ms=0.0, write_ms=0.0, events=10, errors=[])],
    )


def test_writes_to_expected_path(tmp_path: Path):
    report = _make_report()
    out = write_timing_report(tmp_path, report)
    assert out == tmp_path / "timing" / "20250520" / "005930.json"
    assert out.exists()
    data = json.loads(out.read_text())
    assert data["summary"]["code"] == "005930"
    assert data["pages"][0]["events"] == 10


def test_creates_parent_directories(tmp_path: Path):
    report = _make_report(date="20260101")
    out = write_timing_report(tmp_path, report)
    assert out.parent.is_dir()


def test_atomic_overwrite(tmp_path: Path):
    write_timing_report(tmp_path, _make_report())
    second = _make_report()
    second.summary.event_count = 999
    write_timing_report(tmp_path, second)
    data = json.loads((tmp_path / "timing" / "20250520" / "005930.json").read_text())
    assert data["summary"]["event_count"] == 999
