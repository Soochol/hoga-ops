"""Shared durable dispatch for legacy Toss and broker-independent commands."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from hoga.trading.toss import TradingError

T = TypeVar("T")


async def dispatch_command(
    journal: Any,
    tasks: dict[str, asyncio.Task],
    command_id: str,
    payload: dict,
    operation: Callable[[], Awaitable[T]],
    decode: Callable[[Any], T],
    *,
    prepared: bool = False,
) -> T:
    state, result = (
        journal.begin(command_id, payload, prepared=True) if prepared else journal.begin(command_id, payload)
    )
    if state == "accepted":
        return decode(result)
    if state == "rejected":
        raise TradingError(result["status"], result["code"], result["message"])
    if state != "new":
        task = tasks.get(command_id)
        if task is not None:
            return await asyncio.shield(task)
        raise TradingError(
            409, "order-outcome-unknown", "같은 요청을 다시 전송하지 않았습니다. 주문 내역을 확인하세요."
        )
    task = asyncio.create_task(operation())
    tasks[command_id] = task
    return await asyncio.shield(task)
