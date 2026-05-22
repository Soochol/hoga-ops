"""UpstreamCode enum + CaptureErrorCode shape tests (ADR-0009)."""
from __future__ import annotations

from hoga.api.error_codes import CaptureErrorCode, UpstreamCode


def test_upstream_code_values() -> None:
    """All five UpstreamCode values are present with stable string values."""
    assert UpstreamCode.KRX_CREDENTIALS_MISSING.value == "krx_credentials_missing"
    assert UpstreamCode.KRX_FETCH_FAILED.value == "krx_fetch_failed"
    assert UpstreamCode.COOKIE_EXPIRED.value == "cookie_expired"
    assert UpstreamCode.COOKIE_MISSING.value == "cookie_missing"
    assert UpstreamCode.HOGAPLAY_HTTP_ERROR.value == "hogaplay_http_error"


def test_upstream_code_is_str_enum() -> None:
    """StrEnum so FastAPI serializes to the bare string on the wire."""
    assert isinstance(UpstreamCode.KRX_CREDENTIALS_MISSING, str)
    assert UpstreamCode.KRX_CREDENTIALS_MISSING == "krx_credentials_missing"


def test_capture_error_code_retains_non_upstream_values() -> None:
    """CaptureErrorCode keeps captures-domain non-upstream codes."""
    assert CaptureErrorCode.TODAY_TOO_EARLY.value == "today_too_early"
    assert CaptureErrorCode.MISSING_RANGE.value == "missing_range"
    assert CaptureErrorCode.TERMINAL.value == "terminal"
    assert CaptureErrorCode.NOT_FOUND.value == "not_found"
    assert CaptureErrorCode.INTERNAL_ERROR.value == "internal_error"


def test_capture_error_code_no_longer_has_upstream_values() -> None:
    """After migration, cookie/hogaplay codes live in UpstreamCode only."""
    for name in ("COOKIE_EXPIRED", "COOKIE_MISSING", "HOGAPLAY_HTTP_ERROR"):
        assert not hasattr(CaptureErrorCode, name), (
            f"CaptureErrorCode.{name} still exists — should have moved to UpstreamCode"
        )


def test_exception_to_error_code_returns_upstream_for_cookie() -> None:
    """captures.py:_exception_to_error_code maps cookie/hogaplay exceptions to UpstreamCode."""
    from hoga.api.captures import _exception_to_error_code
    from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
    from hoga.config import CookieMissingError

    assert _exception_to_error_code(CookieMissingError("no cookie")) == UpstreamCode.COOKIE_MISSING
    assert _exception_to_error_code(CookieExpiredError("cookie expired", status_code=401)) == UpstreamCode.COOKIE_EXPIRED
    assert _exception_to_error_code(HogaplayHTTPError("server error", status_code=500)) == UpstreamCode.HOGAPLAY_HTTP_ERROR
