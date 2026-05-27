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
