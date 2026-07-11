import threading
import time

import pytest

from hoga.api.slice_coalescer import SliceCoalescer



# ── SliceCoalescer (per-day slice single-flight) ────────────────────────────


def test_slice_coalescer_collapses_concurrent_same_key():
    # Two threads racing the SAME key run the compute exactly ONCE; the follower
    # receives the leader's result. Without single-flight both would compute.
    c = SliceCoalescer()
    calls = [0]
    entered = threading.Event()
    release = threading.Event()

    def compute():
        calls[0] += 1
        entered.set()
        release.wait()
        return "RESULT"

    results: list[str] = []

    def worker():
        results.append(c.run("k", compute))

    leader = threading.Thread(target=worker)
    leader.start()
    # Leader has registered its flight and entered compute → the second thread
    # is guaranteed to arrive as a follower (deterministic ordering).
    assert entered.wait(timeout=2)
    follower = threading.Thread(target=worker)
    follower.start()
    time.sleep(0.05)  # let the follower reach flight.done.wait()
    release.set()
    leader.join(timeout=2)
    follower.join(timeout=2)

    assert calls[0] == 1
    assert results == ["RESULT", "RESULT"]


def test_slice_coalescer_distinct_keys_each_compute():
    c = SliceCoalescer()
    calls = []
    c.run("a", lambda: calls.append("a"))
    c.run("b", lambda: calls.append("b"))
    assert calls == ["a", "b"]


def test_slice_coalescer_reruns_after_flight_completes():
    # Nothing is retained past the in-flight window → a later call recomputes
    # (zero staleness; the warm result lives in PastIndicatorsCache, not here).
    c = SliceCoalescer()
    calls = [0]

    def compute():
        calls[0] += 1
        return calls[0]

    assert c.run("k", compute) == 1
    assert c.run("k", compute) == 2


def test_slice_coalescer_propagates_exception_without_poisoning_key():
    c = SliceCoalescer()

    def boom():
        raise ValueError("nope")

    with pytest.raises(ValueError, match="nope"):
        c.run("k", boom)
    # Key is not poisoned — the flight was popped in `finally`, so a fresh
    # compute on the same key runs normally.
    assert c.run("k", lambda: 7) == 7

