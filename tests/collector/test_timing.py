import pytest

from hoga.collector.timing import CaptureTimingCollector


def make_env():
    from hoga.api.models import TimingEnv
    return TimingEnv(
        rate_limit_s=0.05,
        max_concurrent=3,
        page_step_ms_initial=60000,
        hoga_version="0.1.0",
        git_sha=None,
    )


def test_phase_accumulates_time(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)

    with c.phase("http_fetch"):
        fake_clock.tick_ms(120.0)
    with c.phase("parse"):
        fake_clock.tick_ms(5.0)
    with c.phase("http_fetch"):
        fake_clock.tick_ms(80.0)

    assert c.phase_totals_ms["http_fetch"] == pytest.approx(200.0)
    assert c.phase_totals_ms["parse"] == pytest.approx(5.0)


def test_phase_records_time_on_exception(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)

    with pytest.raises(RuntimeError, match="boom"):
        with c.phase("parse"):
            fake_clock.tick_ms(50.0)
            raise RuntimeError("boom")

    # Exception propagated AND time was still recorded.
    assert c.phase_totals_ms["parse"] == pytest.approx(50.0)


def test_nested_phase_raises(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)
    with c.phase("http_fetch"):
        with pytest.raises(RuntimeError, match="nesting is not allowed"):
            with c.phase("parse"):
                pass


def test_mark_page_boundary_creates_new_page(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)

    c.mark_page_boundary()  # page 0 starts
    with c.phase("http_fetch"):
        fake_clock.tick_ms(100.0)
    c.record_event_count(42)

    c.mark_page_boundary()  # page 1 starts
    with c.phase("http_fetch"):
        fake_clock.tick_ms(80.0)
    c.record_event_count(17)

    assert len(c.pages) == 2
    assert c.pages[0].idx == 0
    assert c.pages[0].http_ms == pytest.approx(100.0)
    assert c.pages[0].events == 42
    assert c.pages[1].idx == 1
    assert c.pages[1].http_ms == pytest.approx(80.0)
    assert c.pages[1].events == 17


def test_record_error_updates_page_and_totals(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)
    c.mark_page_boundary()
    c.record_error("429")
    c.mark_page_boundary()
    c.record_error("429")
    c.record_error("cookie_expired")

    assert c.error_counts == {"429": 2, "cookie_expired": 1}
    assert c.pages[0].errors == ["429"]
    assert c.pages[1].errors == ["429", "cookie_expired"]


def test_summary_phase_percentages_sum_to_100(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)
    c.mark_page_boundary()
    with c.phase("http_fetch"):
        fake_clock.tick_ms(700.0)
    with c.phase("parse"):
        fake_clock.tick_ms(200.0)
    with c.phase("rate_limit"):
        fake_clock.tick_ms(100.0)

    env = make_env()
    summary = c.summary(env=env)

    assert sum(summary.phase_percentages.values()) == pytest.approx(100.0, abs=0.5)
    assert summary.phase_percentages["http_fetch"] == pytest.approx(70.0, abs=0.5)


def test_summary_unaccounted_ms_when_total_exceeds_phases(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)
    # Advance the wall clock without entering any phase — that becomes "unaccounted".
    fake_clock.tick_ms(1000.0)
    with c.phase("http_fetch"):
        fake_clock.tick_ms(500.0)

    summary = c.summary(env=make_env())
    assert summary.unaccounted_ms == pytest.approx(1000.0, abs=1.0)
    assert summary.total_ms == pytest.approx(1500.0, abs=1.0)


def test_to_report_includes_pages(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)
    c.mark_page_boundary()
    with c.phase("http_fetch"):
        fake_clock.tick_ms(50.0)
    c.record_event_count(10)

    report = c.to_report(env=make_env())
    assert len(report.pages) == 1
    assert report.pages[0].idx == 0
    assert report.pages[0].http_ms == pytest.approx(50.0)
    assert report.pages[0].events == 10
