"""Signature guard: _run_capture_and_parse + _run_capture_inner accept collector kwarg."""
import inspect

from hoga.api import captures as _cap


def test_run_capture_and_parse_accepts_collector():
    sig = inspect.signature(_cap._run_capture_and_parse)
    assert "collector" in sig.parameters
    assert sig.parameters["collector"].default is None
    assert sig.parameters["collector"].kind == inspect.Parameter.KEYWORD_ONLY


def test_run_capture_inner_accepts_collector():
    sig = inspect.signature(_cap._run_capture_inner)
    assert "collector" in sig.parameters
    assert sig.parameters["collector"].default is None


def test_timing_enabled_default_is_true(monkeypatch):
    monkeypatch.delenv("HOGA_CAPTURE_TIMING", raising=False)
    assert _cap._timing_enabled() is True


def test_timing_enabled_disabled_explicitly(monkeypatch):
    monkeypatch.setenv("HOGA_CAPTURE_TIMING", "0")
    assert _cap._timing_enabled() is False
    monkeypatch.setenv("HOGA_CAPTURE_TIMING", "false")
    assert _cap._timing_enabled() is False


def test_timing_enabled_empty_string_means_enabled(monkeypatch):
    monkeypatch.setenv("HOGA_CAPTURE_TIMING", "")
    assert _cap._timing_enabled() is True  # empty == unset == default ON


def test_run_item_records_cookie_expired_before_reraise():
    """Task 12: ``_run_item`` catches CookieExpiredError, records it on the
    collector, then re-raises so the worker loop's ``_handle_cookie_expired``
    pause behavior runs unchanged."""
    src = inspect.getsource(_cap._run_item)
    assert "CookieExpiredError" in src, (
        "_run_item must catch CookieExpiredError to record it on the collector"
    )
    assert (
        'record_error("cookie_expired")' in src
        or "record_error('cookie_expired')" in src
    ), "_run_item must call collector.record_error('cookie_expired')"
    # Sanity: the catch must re-raise so the worker loop still sees the
    # exception and triggers _handle_cookie_expired(state).
    catch_idx = src.index("CookieExpiredError")
    tail = src[catch_idx:]
    assert "raise" in tail, "_run_item must re-raise after recording"
