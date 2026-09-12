"""Safe, process-local observations; never expose vendor text, tokens or request bodies."""
from __future__ import annotations

import contextlib
import time
import weakref
from typing import Literal

import httpx
from pydantic import BaseModel
from websockets.exceptions import ConnectionClosed

from .kiwoom_errors import (
    KiwoomAuthError,
    KiwoomAuthTransientError,
    KiwoomBatchLimitError,
    KiwoomRateLimitError,
    KiwoomTerminalAuthError,
)
from .kiwoom_token_provider import KiwoomAuthError as TokenAuthError, KiwoomAuthTransient


class ProviderFailure(BaseModel):
    channel: Literal['ws', 'rest']
    kind: Literal['auth', 'rate_limit', 'timeout', 'transport', 'server', 'request', 'unknown']
    operation: str
    observed_at_ms: int
    code: str | None = None


_observations: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def classify(exc: Exception) -> tuple[str, str | None]:
    """Use exception types/structured codes, not ambiguous message keywords."""
    code = getattr(exc, 'code', None)
    http_status = getattr(getattr(exc, 'response', None), 'status_code', None)
    cause = exc
    timed_out = False
    for _ in range(8):
        http_status = http_status or getattr(cause, 'http_status', None)
        if isinstance(cause, (httpx.TimeoutException, TimeoutError)):
            timed_out = True
        if cause.__cause__ is None:
            break
        cause = cause.__cause__
    if isinstance(code, str) and code.startswith('HTTP/'):
        with contextlib.suppress(ValueError):
            http_status = int(code[5:])
    safe_code = str(http_status) if isinstance(http_status, int) else str(code) if isinstance(code, int) else None
    if isinstance(exc, KiwoomBatchLimitError):
        return 'request', safe_code
    if isinstance(exc, KiwoomRateLimitError) or http_status == httpx.codes.TOO_MANY_REQUESTS:
        return 'rate_limit', safe_code
    if timed_out or isinstance(exc, (TimeoutError, httpx.TimeoutException)) or (
        isinstance(code, str) and code.startswith('TRANSPORT/') and 'Timeout' in code
    ):
        return 'timeout', safe_code
    if isinstance(http_status, int) and http_status >= httpx.codes.INTERNAL_SERVER_ERROR:
        return 'server', safe_code
    transport_types = (OSError, httpx.TransportError, KiwoomAuthTransientError, KiwoomAuthTransient, ConnectionClosed)
    if isinstance(exc, transport_types) or (
        isinstance(code, str) and code.startswith('TRANSPORT/')
    ):
        return 'transport', safe_code
    if isinstance(exc, (KiwoomAuthError, KiwoomTerminalAuthError, TokenAuthError)) or http_status in (401, 403):
        return 'auth', safe_code
    if isinstance(http_status, int) and http_status >= httpx.codes.BAD_REQUEST:
        return 'request', safe_code
    return 'unknown', safe_code


def begin(owner: object, operation: str) -> int:
    entries = _observations.setdefault(owner, {})
    generation, failure = entries.get(operation, (0, None))
    entries[operation] = (generation + 1, failure)
    return generation + 1


def finish(owner: object, operation: str, generation: int, channel: str, exc: Exception | None = None) -> None:
    entries = _observations.get(owner, {})
    if entries.get(operation, (None,))[0] != generation:
        return
    failure = None
    if exc is not None:
        kind, code = classify(exc)
        failure = ProviderFailure(channel=channel, kind=kind, operation=operation,
                                  observed_at_ms=int(time.time() * 1000), code=code)
    entries[operation] = (generation, failure)


def clear(owner: object) -> None:
    _observations.pop(owner, None)


def failures() -> list[ProviderFailure]:
    # Latest observation per channel/operation/kind; one account success never clears another.
    grouped = {}
    for entries in list(_observations.values()):
        for _, failure in entries.values():
            if failure is not None:
                key = (failure.channel, failure.operation, failure.kind)
                if key not in grouped or grouped[key].observed_at_ms < failure.observed_at_ms:
                    grouped[key] = failure
    return sorted(grouped.values(), key=lambda item: item.observed_at_ms, reverse=True)
