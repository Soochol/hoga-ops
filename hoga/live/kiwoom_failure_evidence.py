from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass

import httpx
from websockets.exceptions import ConnectionClosed, ConnectionClosedError, ConnectionClosedOK
from websockets.frames import Close, CloseCode
from websockets.http11 import Response as WsResponse

from .kiwoom_errors import (
    KiwoomApiError,
    KiwoomAuthError,
    KiwoomAuthTransientError,
    KiwoomBatchLimitError,
    KiwoomRateLimitError,
    KiwoomTerminalAuthError,
)
from .kiwoom_token_provider import KiwoomAuthError as TokenAuthError, KiwoomAuthTransient

_PHASES = ('token', 'connect', 'LOGIN', 'REG', 'REMOVE', 'receive', 'dispatch', 'close', 'unknown')
_FAMILIES = (
    (TimeoutError, 'TimeoutError'),
    (httpx.TimeoutException, 'TimeoutException'),
    (httpx.TransportError, 'TransportError'),
    (ConnectionClosedOK, 'ConnectionClosedOK'),
    (ConnectionClosedError, 'ConnectionClosedError'),
    (ConnectionClosed, 'ConnectionClosed'),
    (KiwoomBatchLimitError, 'KiwoomBatchLimitError'),
    (KiwoomTerminalAuthError, 'KiwoomTerminalAuthError'),
    (KiwoomRateLimitError, 'KiwoomRateLimitError'),
    (KiwoomAuthTransientError, 'KiwoomAuthTransientError'),
    (KiwoomAuthError, 'KiwoomAuthError'),
    (KiwoomAuthTransient, 'KiwoomAuthTransient'),
    (TokenAuthError, 'KiwoomAuthError'),
    (KiwoomApiError, 'KiwoomApiError'),
    (ConnectionRefusedError, 'ConnectionRefusedError'),
    (ConnectionResetError, 'ConnectionResetError'),
    (ConnectionAbortedError, 'ConnectionAbortedError'),
    (BrokenPipeError, 'BrokenPipeError'),
    (ConnectionError, 'ConnectionError'),
    (FileNotFoundError, 'FileNotFoundError'),
    (PermissionError, 'PermissionError'),
    (OSError, 'OSError'),
    (ValueError, 'ValueError'),
    (TypeError, 'TypeError'),
    (RuntimeError, 'RuntimeError'),
)
_MAX_NUMBER = 1e15
_MAX_CAUSES = 8
_MAX_PROVIDER_CODE = 80
_MAX_SNAPSHOT_BYTES = 64 * 1024


def integer(value: object) -> int | None:
    return value if type(value) is int and -(2**63) <= value < 2**63 else None


def number(value: object) -> int | float | None:
    return value if type(value) in (int, float) and 0 <= value <= _MAX_NUMBER and math.isfinite(value) else None


def numeric_fields(source: object, keys: tuple[str, ...]) -> dict:
    if type(source) is not dict:
        return {}
    return {key: number(source.get(key)) for key in keys if key in source}


def exception_data(exc: BaseException) -> dict:
    return BaseException.__dict__['__dict__'].__get__(exc)


def failure_phase(exc: BaseException) -> str:
    value = exception_data(exc).get('_kiwoom_phase')
    return value if type(value) is str and value in _PHASES else 'unknown'


def annotate_failure(exc: BaseException, phase: str, elapsed_ms: float) -> None:
    data = exception_data(exc)
    if '_kiwoom_phase' not in data:
        data['_kiwoom_phase'] = phase if phase in _PHASES else 'unknown'
        data['_kiwoom_elapsed_ms'] = number(max(0.0, elapsed_ms))


def exception_family(exc: BaseException) -> tuple[type[BaseException] | None, str]:
    return next(((family, label) for family, label in _FAMILIES if issubclass(type(exc), family)),
                (None, 'UnknownException'))


def _cause_chain(exc: BaseException, *, include_context: bool = True) -> tuple[list[BaseException], str]:
    nodes: list[BaseException] = []
    seen: set[int] = set()
    while True:
        if id(exc) in seen:
            return nodes, 'cycle'
        if len(nodes) == _MAX_CAUSES:
            return nodes, 'depth_limit'
        seen.add(id(exc))
        nodes.append(exc)
        cause = BaseException.__cause__.__get__(exc)
        if cause is None and include_context and not BaseException.__suppress_context__.__get__(exc):
            cause = BaseException.__context__.__get__(exc)
        if cause is None:
            return nodes, 'complete'
        exc = cause


def close_projection(exc: BaseException) -> dict:
    if type(exc) not in (ConnectionClosed, ConnectionClosedOK, ConnectionClosedError):
        return {'state': 'unavailable'}
    data = exception_data(exc)
    result: dict = {'state': 'available'}
    for field in ('rcvd', 'sent'):
        frame = data.get(field)
        if frame is not None and type(frame) is not Close:
            return {'state': 'unavailable'}
        code = None if frame is None else object.__getattribute__(frame, '__dict__').get('code')
        # The library uses its own standard IntEnum for synthetic close frames.
        if type(code) is CloseCode:
            code = int(code)
        result[field] = {'present': frame is not None, 'code': integer(code)}
    order = data.get('rcvd_then_sent')
    result['received_then_sent'] = order if type(order) is bool else None
    return result


def exception_projection(exc: BaseException) -> dict:
    nodes, stop = _cause_chain(exc)
    causes = []
    for node in nodes:
        errno = OSError.errno.__get__(node) if issubclass(type(node), OSError) else None
        causes.append({'type': exception_family(node)[1], 'errno': integer(errno)})
    return {'phase': failure_phase(exc), 'causes': causes, 'cause_stop': stop,
            'close': close_projection(exc)}


def provider_exception(exc: BaseException) -> Exception:
    """Only the legacy provider classifier sees these message-free copies.

    Its normal vendor types and structured codes remain intact. Never pass an
    original object to a classifier that reads overridable attributes.
    """
    nodes, _ = _cause_chain(exc, include_context=False)
    copied: list[Exception] = []
    for node in nodes:
        family, _ = exception_family(node)
        if family is None:
            family = RuntimeError
        if issubclass(family, ConnectionClosed):
            family = ConnectionError
        proxy = family.__new__(family)
        data, target = exception_data(node), exception_data(proxy)
        code = data.get('code')
        close = close_projection(node)
        if close['state'] == 'available':
            code = close['rcvd']['code'] if close['rcvd']['present'] else 1006
        if integer(code) is not None or (type(code) is str and len(code) <= _MAX_PROVIDER_CODE
                and re.fullmatch(r'(HTTP/[0-9]{3}|TRANSPORT/[A-Za-z]+)', code)):
            target['code'] = code
        if issubclass(family, KiwoomApiError):
            msg = data.get('msg')
            target['msg'] = '[1504:' if type(msg) is str and '[1504:' in msg else ''
        status = integer(data.get('http_status'))
        if node is exc:
            response = data.get('response')
            if type(response) in (httpx.Response, WsResponse):
                fields = object.__getattribute__(response, '__dict__')
                status = integer(fields.get('status_code')) or status
        if status is not None:
            target['http_status'] = status
        if issubclass(type(node), OSError):
            OSError.errno.__set__(proxy, integer(OSError.errno.__get__(node)))
        phase = data.get('_kiwoom_phase')
        target['_kiwoom_phase'] = phase if type(phase) is str and phase in _PHASES else None
        target['_kiwoom_elapsed_ms'] = number(data.get('_kiwoom_elapsed_ms'))
        copied.append(proxy)
    for parent, child in zip(copied, copied[1:], strict=False):
        parent.__cause__ = child
    return copied[0]


def runtime_projection(source: object) -> dict:
    if type(source) is not dict:
        return {'runtime_context': 'unavailable'}
    result = numeric_fields(source, ('live_started_at_ms', 'collector_started_at_ms'))
    for key in ('live_started_at_ms', 'collector_started_at_ms'):
        if key in result:
            result[key] = integer(source[key])
    for key, lengths in (('commit', (*range(7, 41), 64)), ('collector_epoch', (32,))):
        value = source.get(key)
        if type(value) is str and len(value) in lengths and re.fullmatch('[0-9a-fA-F]+', value):
            result[key] = value
    gc = source.get('gc')
    if type(gc) is dict:
        projected = numeric_fields(gc, ('warn_ms', 'over_threshold'))
        if type(gc.get('enabled')) is bool:
            projected['enabled'] = gc['enabled']
        for key in ('thresholds', 'current_counts'):
            values = gc.get(key)
            if type(values) in (list, tuple):
                projected[key] = [v if type(v) is int and number(v) is not None else None for v in values[:3]]
        generations = gc.get('by_generation')
        if type(generations) is dict:
            projected['by_generation'] = {
                key: numeric_fields(generations[key], ('collections', 'total_ms', 'max_ms', 'last_ms', 'last_at_ms'))
                for key in ('0', '1', '2') if key in generations
            }
        stats = gc.get('interpreter_stats')
        if type(stats) in (list, tuple):
            projected['interpreter_stats'] = [numeric_fields(row, ('collections', 'collected', 'uncollectable'))
                                              for row in stats[:3]]
        result['gc'] = projected
    return result


@dataclass(frozen=True, slots=True)
class FailureEvidence:
    encoded: str

    @classmethod
    def capture(cls, exc: BaseException, build: Callable[[], dict]) -> FailureEvidence:
        try:
            snapshot = {**build(), 'failure': exception_projection(exc)}
            encoded = json.dumps(snapshot, separators=(',', ':'), allow_nan=False)
            if len(encoded.encode('utf-8')) <= _MAX_SNAPSHOT_BYTES:
                return cls(encoded)
            fallback = 'size_limit'
        except BaseException:  # noqa: BLE001 — synchronous diagnostics cannot replace the primary failure
            fallback = 'unavailable'
        try:
            phase = failure_phase(exc)
        except BaseException:  # noqa: BLE001 — the fallback uses only fixed labels
            phase = 'unknown'
        return cls('{"diagnostics":"' + fallback + '","failure":{"phase":"' + phase
                   + '","causes":[],"cause_stop":"unavailable"}}')

    def snapshot(self) -> dict:
        return json.loads(self.encoded)
