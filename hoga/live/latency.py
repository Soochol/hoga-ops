"""Bounded process-local timing samples; no payloads or credentials are retained."""
from collections import deque


class LatencySamples:
    def __init__(self, capacity: int = 256) -> None:
        self._samples: deque[float] = deque(maxlen=capacity)
        self.count = 0

    def observe(self, milliseconds: float) -> None:
        self.count += 1
        self._samples.append(max(0.0, milliseconds))

    def snapshot(self) -> dict:
        samples = sorted(self._samples)
        return {
            "count": self.count,
            "sample_size": len(samples),
            "p95_ms": samples[min(len(samples) - 1, int(len(samples) * 0.95))] if samples else 0,
            "max_ms": samples[-1] if samples else 0,
        }
