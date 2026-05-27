import pytest

from hoga.collector.timing import CaptureTimingCollector


class FakeClock:
    """Monotonic clock with manual advance — kills flakiness."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def tick_ms(self, ms: float) -> None:
        self.t += ms / 1000.0


def test_phase_accumulates_time():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)

    with c.phase("http_fetch"):
        clock.tick_ms(120.0)
    with c.phase("parse"):
        clock.tick_ms(5.0)
    with c.phase("http_fetch"):
        clock.tick_ms(80.0)

    assert c.phase_totals_ms["http_fetch"] == pytest.approx(200.0)
    assert c.phase_totals_ms["parse"] == pytest.approx(5.0)


def test_phase_records_time_on_exception():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)

    with pytest.raises(RuntimeError, match="boom"):
        with c.phase("parse"):
            clock.tick_ms(50.0)
            raise RuntimeError("boom")

    # Exception propagated AND time was still recorded.
    assert c.phase_totals_ms["parse"] == pytest.approx(50.0)


def test_nested_phase_raises():
    c = CaptureTimingCollector("005930", "20250520", clock=FakeClock())
    with c.phase("http_fetch"):
        with pytest.raises(RuntimeError, match="nesting is not allowed"):
            with c.phase("parse"):
                pass


def test_mark_page_boundary_creates_new_page():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)

    c.mark_page_boundary()  # page 0 starts
    with c.phase("http_fetch"):
        clock.tick_ms(100.0)
    c.record_event_count(42)

    c.mark_page_boundary()  # page 1 starts
    with c.phase("http_fetch"):
        clock.tick_ms(80.0)
    c.record_event_count(17)

    assert len(c.pages) == 2
    assert c.pages[0].idx == 0
    assert c.pages[0].http_ms == pytest.approx(100.0)
    assert c.pages[0].events == 42
    assert c.pages[1].idx == 1
    assert c.pages[1].http_ms == pytest.approx(80.0)
    assert c.pages[1].events == 17


def test_record_error_updates_page_and_totals():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)
    c.mark_page_boundary()
    c.record_error("429")
    c.mark_page_boundary()
    c.record_error("429")
    c.record_error("cookie_expired")

    assert c.error_counts == {"429": 2, "cookie_expired": 1}
    assert c.pages[0].errors == ["429"]
    assert c.pages[1].errors == ["429", "cookie_expired"]
