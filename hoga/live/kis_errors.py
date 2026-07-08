"""KIS domain error types + retryable-transport classification.

Split from kis_client.py (Stage 4, 2026-07-08). Leaf module: importing it never
pulls in the HTTP client, so the transport core (kis_client) and the endpoint
mixins (kis_endpoints) can both depend on these types without an import cycle.
"""
from __future__ import annotations

import httpx

# Which transport failures are worth replaying. The connection-level set:
# the request either never reached KIS or the socket broke, so a fresh
# connection is likely to succeed and a replay is cheap. Deliberately EXCLUDES
# read/write *timeouts* (KIS got the request but is slow — replaying doubles
# the 10s wait and adds load to a struggling upstream) and LocalProtocolError
# (our bug, not transient). Non-retryable transport errors still normalize to
# KisTransportError — they just skip the replay and degrade immediately.
_RETRYABLE_TRANSPORT: tuple[type[httpx.TransportError], ...] = (
    httpx.RemoteProtocolError,
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpx.PoolTimeout,
)


class KisAuthError(RuntimeError):
    """Token issue failed or cool-down breached."""


class KisRateLimitError(RuntimeError):
    """msg_cd == 'EGW00201'.

    Originally documented as "backoff caller's responsibility" (Audit-4).
    Post-ADR-0050 the backoff lives in ``KisClient._get`` itself — this
    exception only surfaces to callers AFTER the client's retry sequence
    has been exhausted. Caller-actionable response is "this caller's range
    is blocked for now, move on".
    """


class KisApiError(RuntimeError):
    """rt_cd != '0' generic failure."""

    def __init__(self, msg_cd: str, msg1: str):
        self.msg_cd = msg_cd
        self.msg1 = msg1
        super().__init__(f"KIS api error {msg_cd}: {msg1}")


class KisTransportError(KisApiError):
    """An httpx ``TransportError`` (TCP disconnect, connect failure, read
    timeout) normalized into the KIS domain. KIS closing the connection
    without a response surfaces as ``httpx.RemoteProtocolError``, which is a
    ``TransportError`` *sibling* of ``HTTPStatusError`` — so ``_do_get_once``'s
    status-only catch let it escape as an unhandled 500 (2026-06-11 daily
    backfill regression). Subtyping ``KisApiError`` is deliberate: every
    existing ``except KisApiError`` site (the walk-back orchestrator's
    degrade-and-continue arms) absorbs it without modification, so no caller
    can forget to handle it (ADR-0050's anti-asymmetry principle). The
    synthetic ``msg_cd`` ('TRANSPORT/<httpx class>') names the failure without
    colliding with EGW token codes, so ``_get``'s token-invalid branch never
    false-triggers on it."""

    def __init__(self, exc: httpx.TransportError):
        # Classified at raise time so the retry loop stays dumb: connection-
        # level failures replay, timeouts/local-protocol errors degrade.
        self.retryable = isinstance(exc, _RETRYABLE_TRANSPORT)
        super().__init__(msg_cd=f"TRANSPORT/{type(exc).__name__}", msg1=str(exc)[:200])
