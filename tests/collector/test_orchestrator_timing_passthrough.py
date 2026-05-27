"""Verifies collector kwarg is accepted by collect_stock_date / _page_step_loop.

We don't run a real capture here — that's the integration test in
tests/api/test_captures_timing.py. This test only guards the signature.
"""
import inspect

from hoga.collector import orchestrator
from hoga.collector.timing import CaptureTimingCollector


def test_collect_stock_date_accepts_collector_kwarg():
    sig = inspect.signature(orchestrator.collect_stock_date)
    assert "collector" in sig.parameters
    p = sig.parameters["collector"]
    assert p.default is None
    assert p.kind == inspect.Parameter.KEYWORD_ONLY


def test_page_step_loop_accepts_collector_kwarg():
    sig = inspect.signature(orchestrator._page_step_loop)
    assert "collector" in sig.parameters
    p = sig.parameters["collector"]
    assert p.default is None


def test_collector_type_is_threadable():
    # The collector class must not require asyncio context (caller threads
    # it into a ThreadPoolExecutor).
    c = CaptureTimingCollector("000000", "20000101")
    with c.phase("http_fetch"):
        pass
    assert c.phase_totals_ms["http_fetch"] >= 0.0
