"""같은 읽기 요청은 공유하고, 마지막 독자가 떠나면 대기 작업을 취소한다.

작업은 ComputeExecutor의 취소 가능한 제출 대기를 포함한다. 이미 실행한 CPU
작업은 강제 중단하지 않으며 실행기가 완료될 때까지 워커 자리를 보유한다.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Generic, TypeVar

from fastapi import HTTPException, Request

T = TypeVar("T")


@dataclass
class _Flight(Generic[T]):
    task: asyncio.Task[T]
    readers: int = 0


async def _disconnected(request: Request) -> None:
    # FastAPI가 JSON body를 읽은 뒤 호출한다. 폴링 대신 ASGI disconnect를 기다려
    # 대기 요청 수에 비례한 주기 타이머를 만들지 않는다.
    while (await request.receive())["type"] != "http.disconnect":
        pass


def _consume_result(task: asyncio.Task) -> None:
    if not task.cancelled():
        task.exception()


class ReadRequestCoalescer(Generic[T]):
    def __init__(self) -> None:
        self._inflight: dict[str, _Flight[T]] = {}

    async def run(self, key: str, factory: Callable[[], Awaitable[T]], request: Request) -> T:
        flight = self._inflight.get(key)
        if flight is None:
            task = asyncio.create_task(factory())
            task.add_done_callback(_consume_result)
            flight = self._inflight[key] = _Flight(task)
        flight.readers += 1
        disconnected = asyncio.create_task(_disconnected(request))
        try:
            done, _ = await asyncio.wait(
                (flight.task, disconnected), return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnected in done:
                disconnected.result()
                raise HTTPException(499, "client disconnected")
            return flight.task.result()
        finally:
            disconnected.cancel()
            disconnected.add_done_callback(_consume_result)
            flight.readers -= 1
            if flight.readers == 0:
                self._inflight.pop(key, None)
                flight.task.cancel()
