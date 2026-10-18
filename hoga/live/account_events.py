"""Private account-event fanout. Raw account numbers never enter the UI event bus."""

from __future__ import annotations

import inspect
from collections import defaultdict

_listeners: dict[tuple[str, int], set] = defaultdict(set)
_states: dict[tuple[str, int], bool] = {}
_mock_sessions: dict[str, object] = {}


async def dispatch_account_event(environment: str, account: int, row: dict, generation: int) -> None:
    for callback, _ in tuple(_listeners.get((environment, account), ())):
        value = callback(row, generation)
        if inspect.isawaitable(value):
            await value


async def dispatch_account_state(environment: str, account: int, connected: bool, generation: int) -> None:
    _states[(environment, account)] = connected
    for _, callback in tuple(_listeners.get((environment, account), ())):
        callback(connected)


async def subscribe_account(data_dir, environment: str, account: int, callback, state_callback):
    from . import kiwoom_runtime, lifecycle, storage_runtime  # noqa: PLC0415
    from .kiwoom_session import KiwoomSessionManager  # noqa: PLC0415

    if kiwoom_runtime.ensure_token_provider_for_account(account, data_dir, environment=environment) is None:
        raise ConnectionError("account event credentials unavailable")
    key = (environment, account)
    listener = (callback, state_callback)
    _listeners[key].add(listener)
    try:
        if environment == "real":
            session = storage_runtime._ensure_kiwoom_session(
                lifecycle._state,
                data_dir=data_dir,
                buffer=lifecycle.get_buffer(),
                date_fn=lifecycle._today_kst,
                now_ms_fn=lifecycle._now_ms,
            )
        else:
            session = _mock_sessions.get(str(data_dir))
            if session is None:
                session = KiwoomSessionManager(
                    buffer=lifecycle.get_buffer(), data_dir=data_dir, date_fn=lifecycle._today_kst, environment="mock"
                )
                _mock_sessions[str(data_dir)] = session
        await session.retain_account(account)
        state_callback(_states.get(key, False))
    except BaseException:
        _listeners[key].discard(listener)
        raise

    async def release():
        _listeners[key].discard(listener)
        if not _listeners[key]:
            _listeners.pop(key, None)
            _states.pop(key, None)
            await session.release_account(account)
        state_callback(False)

    return release
