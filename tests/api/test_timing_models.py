from hoga.api.models import (
    TimingEnv,
    TimingPageDetail,
    TimingPhaseTotals,
    TimingReport,
    TimingSummary,
)


def test_timing_phase_totals_defaults_to_zero():
    totals = TimingPhaseTotals()
    assert totals.http_fetch_ms == 0.0
    assert totals.parse_ms == 0.0
    assert totals.other_ms == 0.0


def test_timing_summary_roundtrip():
    summary = TimingSummary(
        code="005930",
        date="20250520",
        started_at_kst="2026-05-27T14:32:18+09:00",
        ended_at_kst="2026-05-27T14:33:02+09:00",
        total_ms=43821.4,
        phase_totals_ms=TimingPhaseTotals(
            http_fetch_ms=31204.8,
            parse_ms=4102.1,
            disk_write_ms=1843.7,
            rate_limit_ms=5021.0,
        ),
        phase_percentages={
            "http_fetch": 71.2,
            "rate_limit": 11.5,
            "parse": 9.4,
            "disk_write": 4.2,
            "backoff": 0.0,
            "cookie_pause": 0.0,
            "other": 0.0,
        },
        unaccounted_ms=1649.8,
        page_count=387,
        event_count=184231,
        error_counts={"429": 0, "cookie_expired": 0},
        env=TimingEnv(
            rate_limit_s=0.05,
            max_concurrent=3,
            page_step_ms_initial=60000,
            hoga_version="0.1.0",
            git_sha="9aef504",
        ),
    )
    data = summary.model_dump()
    rebuilt = TimingSummary.model_validate(data)
    assert rebuilt == summary


def test_timing_report_serialises_pages():
    report = TimingReport(
        summary=TimingSummary(
            code="005930",
            date="20250520",
            started_at_kst="2026-05-27T14:32:18+09:00",
            ended_at_kst="2026-05-27T14:33:02+09:00",
            total_ms=10.0,
            phase_totals_ms=TimingPhaseTotals(http_fetch_ms=10.0),
            phase_percentages={
                "http_fetch": 100.0, "parse": 0.0, "disk_write": 0.0,
                "rate_limit": 0.0, "backoff": 0.0, "cookie_pause": 0.0, "other": 0.0,
            },
            unaccounted_ms=0.0,
            page_count=1,
            event_count=0,
            error_counts={},
            env=TimingEnv(
                rate_limit_s=0.05,
                max_concurrent=3,
                page_step_ms_initial=60000,
                hoga_version="0.1.0",
                git_sha=None,
            ),
        ),
        pages=[
            TimingPageDetail(idx=0, http_ms=10.0, parse_ms=0.0, write_ms=0.0, events=0, errors=[]),
        ],
    )
    assert len(report.pages) == 1
    assert report.pages[0].idx == 0
