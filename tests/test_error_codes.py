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
