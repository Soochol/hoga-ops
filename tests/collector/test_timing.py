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
