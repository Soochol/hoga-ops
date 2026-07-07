"""Concurrency semantics of PeakSliceGuard (semaphore + single-flight)."""
from __future__ import annotations

import threading
import time

import pytest

from hoga.api.peak_slice_guard import PeakSliceGuard


def test_single_flight_computes_once_for_concurrent_same_key() -> None:
    guard = PeakSliceGuard(concurrency=4)
    calls = 0
    calls_lock = threading.Lock()
    release = threading.Event()

    def compute() -> str:
        nonlocal calls
        with calls_lock:
            calls += 1
        release.wait(timeout=5)
        return "value"

    results: list[str] = []
    results_lock = threading.Lock()

    def worker() -> None:
        r = guard.run("same-key", compute)
        with results_lock:
            results.append(r)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    # Give all workers time to arrive; only the leader should be inside compute.
    time.sleep(0.2)
    release.set()
    for t in threads:
        t.join(timeout=5)

    assert calls == 1  # single-flight collapsed 8 concurrent callers into 1 compute
    assert results == ["value"] * 8  # every caller received the shared result


def test_semaphore_caps_concurrent_distinct_key_computes() -> None:
    guard = PeakSliceGuard(concurrency=2)
    current = 0
    peak = 0
    lock = threading.Lock()
    release = threading.Event()

    def compute() -> None:
        nonlocal current, peak
        with lock:
            current += 1
            peak = max(peak, current)
        release.wait(timeout=5)
        with lock:
            current -= 1

    threads = [threading.Thread(target=guard.run, args=(f"key-{i}", compute)) for i in range(6)]
    for t in threads:
        t.start()
    time.sleep(0.2)
    release.set()
    for t in threads:
        t.join(timeout=5)

    assert peak <= 2  # never more than `concurrency` heavy computes at once


def test_exception_propagates_to_followers_and_leader() -> None:
    guard = PeakSliceGuard(concurrency=2)
    started = threading.Event()
    release = threading.Event()

    def compute() -> str:
        started.set()
        release.wait(timeout=5)
        raise ValueError("boom")

    errors: list[BaseException] = []
    errors_lock = threading.Lock()

    def worker() -> None:
        try:
            guard.run("k", compute)
        except BaseException as exc:  # noqa: BLE001
            with errors_lock:
                errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    started.wait(timeout=5)
    time.sleep(0.1)
    release.set()
    for t in threads:
        t.join(timeout=5)

    assert len(errors) == 5
    assert all(isinstance(e, ValueError) for e in errors)


def test_sequential_calls_after_completion_recompute() -> None:
    guard = PeakSliceGuard(concurrency=2)
    calls = 0

    def compute() -> int:
        nonlocal calls
        calls += 1
        return calls

    # No overlap → single-flight window closes between calls → each recomputes.
    assert guard.run("k", compute) == 1
    assert guard.run("k", compute) == 2
    assert calls == 2


def test_distinct_keys_compute_independently() -> None:
    guard = PeakSliceGuard(concurrency=4)
    assert guard.run("a", lambda: "ra") == "ra"
    assert guard.run("b", lambda: "rb") == "rb"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
