"""Shared fixtures for collector timing tests."""
from __future__ import annotations

import pytest


class FakeClock:
    """Monotonic clock with manual advance — kills flakiness in timing tests."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def tick_ms(self, ms: float) -> None:
        self.t += ms / 1000.0


@pytest.fixture
def fake_clock() -> FakeClock:
    return FakeClock()
