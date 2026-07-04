import logging

import httpx

from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisRateLimitError,
    KisTransportError,
)


def test_transport_error_maps_to_warning_without_traceback_and_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisTransportError(httpx.ConnectError("down")))

    assert policy.kind == "transport"
    assert policy.code == "TRANSPORT/ConnectError"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 3


def test_rate_limit_error_maps_without_supervisor_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisRateLimitError("EGW00201 exhausted"))

    assert policy.kind == "rate_limit"
    assert policy.code == "EGW00201"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_auth_error_maps_to_warning_with_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisAuthError("token issue failed"))

    assert policy.kind == "auth"
    assert policy.code == "KIS_AUTH"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 3


def test_generic_kis_api_error_maps_without_traceback() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisApiError("HTTP_500", "server error"))

    assert policy.kind == "kis_api"
    assert policy.code == "HTTP_500"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_unexpected_error_keeps_traceback() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(RuntimeError("boom"))

    assert policy.kind == "unexpected"
    assert policy.code == "RuntimeError"
    assert policy.log_level == logging.ERROR
    assert policy.include_traceback is True
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_internal_marker_keeps_traceback_but_uses_internal_kind() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(ValueError("bad row"), internal=True)

    assert policy.kind == "internal"
    assert policy.code == "ValueError"
    assert policy.log_level == logging.ERROR
    assert policy.include_traceback is True
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_format_live_error_preserves_compatibility_shape() -> None:
    from hoga.live.error_policy import format_live_error

    exc = RuntimeError("boom")

    assert format_live_error(exc) == "RuntimeError: boom"
