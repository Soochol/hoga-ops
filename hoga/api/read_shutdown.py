"""Selective read retirement and actual synchronous-work ownership."""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from typing import Generic, Protocol, TypeVar

log = logging.getLogger(__name__)
STATE_KEY = "hoga_read_shutdown"
RESTARTING_DETAIL = "서버를 다시 시작하고 있습니다. 잠시 후 다시 조회해 주세요."
T = TypeVar("T")


class ReadInterrupted(Exception):
    """A particular read execution was retired by its shutdown owner."""


@dataclass(frozen=True)
class ReadDrainReport:
    failures: tuple[Exception, ...] = ()

    def log_failures(self) -> None:
        for error in self.failures:
            log.error("reload.read_work_failed", exc_info=error)


class ReadOwner(Protocol):
    def begin_read_shutdown(self) -> None: ...
    async def wait_read_work(self) -> ReadDrainReport: ...


class ReadShutdown:
    def __init__(self) -> None:
        self._owners: list[ReadOwner] = []
        self._begun = False
        self._errors: list[Exception] = []
        self._completion: asyncio.Task[ReadDrainReport] | None = None

    def register(self, owner: ReadOwner) -> None:
        if self._begun or any(item is owner for item in self._owners):
            raise RuntimeError("read owner registration must be unique and precede shutdown")
        self._owners.append(owner)

    def begin(self) -> None:
        if self._begun:
            return
        self._begun = True
        log.info("reload.read_retirement owners=%d", len(self._owners))
        for owner in self._owners:
            try:
                owner.begin_read_shutdown()
            except Exception as error:
                self._errors.append(error)
                log.exception("reload.read_retirement_failed owner=%s", type(owner).__name__)

    async def wait_finished(self) -> ReadDrainReport:
        self.begin()
        if self._completion is None:
            self._completion = asyncio.create_task(self._drain(), name="read-shutdown-drain")
        return await asyncio.shield(self._completion)

    async def _drain(self) -> ReadDrainReport:
        started = time.monotonic()
        reports = await asyncio.gather(*(owner.wait_read_work() for owner in self._owners),
                                       return_exceptions=True)
        failures = list(self._errors)
        for report in reports:
            if isinstance(report, ReadDrainReport):
                failures.extend(report.failures)
            elif isinstance(report, Exception):
                failures.append(report)
            elif isinstance(report, BaseException):
                raise report
        log.info("reload.read_drained elapsed_ms=%.1f failures=%d",
                 (time.monotonic() - started) * 1000, len(failures))
        return ReadDrainReport(tuple(failures))


class ReadOperation:
    def __init__(self, owner: ReadWork) -> None:
        self._owner = owner
        self._stopped = threading.Event()
        self.retired = asyncio.Event()

    def checkpoint(self) -> None:
        if self._stopped.is_set():
            raise ReadInterrupted(RESTARTING_DETAIL)

    def stop_work(self) -> None:
        self._stopped.set()

    def retire(self) -> None:
        self.retired.set()
        self.stop_work()

    async def run_sync(self, fn: Callable[[], T]) -> T:
        self.checkpoint()

        def invoke():
            self.checkpoint()
            result = fn()
            self.checkpoint()
            return result

        task = asyncio.create_task(asyncio.to_thread(invoke), name="read-sync-work")
        self._owner.track_worker(task)
        # asyncio.wait leaves owned work alive without shield's late-error callback.
        await asyncio.wait((task,))
        return task.result()


@dataclass(eq=False)
class ReadFlight(Generic[T]):
    task: asyncio.Task[T]
    operation: ReadOperation

    async def result(self) -> T:
        retired = asyncio.create_task(self.operation.retired.wait())
        try:
            await asyncio.wait((self.task, retired), return_when=asyncio.FIRST_COMPLETED)
            if self.operation.retired.is_set():
                raise ReadInterrupted(RESTARTING_DETAIL)
            return self.task.result()
        finally:
            retired.cancel()


class ReadWork:
    def __init__(self) -> None:
        self.tasks: set[asyncio.Task] = set()
        self._flights: set[ReadFlight] = set()
        self._workers: set[asyncio.Task] = set()
        self._stopping = False
        self._errors: list[Exception] = []
        self._completion: asyncio.Task[ReadDrainReport] | None = None

    def check_admission(self) -> None:
        if self._stopping:
            raise ReadInterrupted(RESTARTING_DETAIL)

    def start(self, factory: Callable[[ReadOperation], Awaitable[T]], *, name=None) -> ReadFlight[T]:
        self.check_admission()
        operation = ReadOperation(self)

        async def run():
            try:
                return await factory(operation)
            finally:
                operation.stop_work()

        task = asyncio.create_task(run(), name=name)
        flight = ReadFlight(task, operation)
        self.tasks.add(task)
        self._flights.add(flight)

        def finished(done):
            self.tasks.discard(done)
            self._flights.discard(flight)
            self._observe(done)

        task.add_done_callback(finished)
        return flight

    def _observe(self, task: asyncio.Task) -> None:
        if not task.cancelled():
            error = task.exception()
            if (self._stopping and isinstance(error, Exception) and not isinstance(error, ReadInterrupted)
                    and not any(item is error for item in self._errors)):
                self._errors.append(error)

    def track_worker(self, task: asyncio.Task) -> None:
        self._workers.add(task)

        def finished(done):
            self._workers.discard(done)
            self._observe(done)

        task.add_done_callback(finished)

    def begin_read_shutdown(self) -> None:
        if self._stopping:
            return
        self._stopping = True
        for flight in tuple(self._flights):
            if not flight.task.done():
                flight.operation.retire()
                if not flight.task.cancelling():
                    flight.task.cancel()

    async def wait_read_work(self) -> ReadDrainReport:
        self.begin_read_shutdown()
        if self._completion is None:
            self._completion = asyncio.create_task(self._drain(), name="read-work-drain")
        return await asyncio.shield(self._completion)

    async def _drain(self) -> ReadDrainReport:
        while self.tasks or self._workers:
            pending = tuple(self.tasks | self._workers)
            done, _ = await asyncio.wait(pending, timeout=2)
            if not done:
                log.warning("reload.read_work_waiting tasks=%s", [task.get_name() for task in pending])
        return ReadDrainReport(tuple(self._errors))


async def run_read_sync(operation: ReadOperation | None, fn: Callable[..., T], /, *args, **kwargs) -> T:
    if operation is None:
        return await asyncio.to_thread(fn, *args, **kwargs)
    return await operation.run_sync(partial(fn, *args, **kwargs))


def checkpoint(operation: ReadOperation | None) -> None:
    if operation is not None:
        operation.checkpoint()
