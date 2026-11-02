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

from hoga.api.read_shutdown import ReadDrainReport, ReadFlight, ReadInterrupted, ReadOperation, ReadWork

T = TypeVar("T")


@dataclass
class _Flight(Generic[T]):
    read: ReadFlight[T]
    readers: int = 0

    @property
    def task(self) -> asyncio.Task[T]:
        return self.read.task


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
        self._work = ReadWork()
        self._tasks = self._work.tasks

    def begin_read_shutdown(self) -> None:
        self._work.begin_read_shutdown()

    async def wait_read_work(self) -> ReadDrainReport:
        return await self._work.wait_read_work()

    async def aclose(self) -> None:
        (await self.wait_read_work()).log_failures()

    async def run(self, key: str, factory: Callable[[ReadOperation], Awaitable[T]], request: Request) -> T:
        try:
            return await self._run(key, factory, request)
        except ReadInterrupted as error:
            raise HTTPException(503, str(error)) from error

    async def _run(self, key: str, factory: Callable[[ReadOperation], Awaitable[T]], request: Request) -> T:
        self._work.check_admission()
        flight = self._inflight.get(key)
        if flight is None:
            flight = self._inflight[key] = _Flight(self._work.start(factory))
        flight.readers += 1
        disconnected = asyncio.create_task(_disconnected(request))
        result = asyncio.create_task(flight.read.result())
        try:
            done, _ = await asyncio.wait(
                (result, disconnected), return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnected in done:
                disconnected.result()
                raise HTTPException(499, "client disconnected")
            return result.result()
        finally:
            result.cancel()
            result.add_done_callback(_consume_result)
            disconnected.cancel()
            disconnected.add_done_callback(_consume_result)
            flight.readers -= 1
            if flight.readers == 0:
                self._inflight.pop(key, None)
                if not flight.task.done() and not flight.task.cancelling():
                    flight.task.cancel()
