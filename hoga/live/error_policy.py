from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisRateLimitError,
    KisTransportError,
)

LiveErrorKind = Literal[
    "transport",
    "rate_limit",
    "auth",
    "kis_api",
    "internal",
    "unexpected",
]


@dataclass(frozen=True)
class LiveErrorPolicy:
    kind: LiveErrorKind
    reason: str
    code: str
    message: str
    log_level: int
    include_traceback: bool
    degraded: bool
    backoff_cycles: int


def format_live_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def classify_live_error(exc: BaseException, *, internal: bool = False) -> LiveErrorPolicy:
    if internal:
        return LiveErrorPolicy(
            kind="internal",
            reason="internal_processing_error",
            code=type(exc).__name__,
            message=str(exc),
            log_level=logging.ERROR,
            include_traceback=True,
            degraded=True,
            backoff_cycles=0,
        )
    if isinstance(exc, KisTransportError):
        return LiveErrorPolicy(
            kind="transport",
            reason="kis_transport_error",
            code=exc.msg_cd,
            message=exc.msg1,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
        )
    if isinstance(exc, KisRateLimitError):
        return LiveErrorPolicy(
            kind="rate_limit",
            reason="kis_rate_limit",
            code="EGW00201",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
        )
    if isinstance(exc, KisAuthError):
        return LiveErrorPolicy(
            kind="auth",
            reason="kis_auth_error",
            code="KIS_AUTH",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
        )
    if isinstance(exc, KisApiError):
        return LiveErrorPolicy(
            kind="kis_api",
            reason="kis_api_error",
            code=exc.msg_cd,
            message=exc.msg1,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
        )
    return LiveErrorPolicy(
        kind="unexpected",
        reason="unexpected_error",
        code=type(exc).__name__,
        message=str(exc),
        log_level=logging.ERROR,
        include_traceback=True,
        degraded=True,
        backoff_cycles=0,
    )
