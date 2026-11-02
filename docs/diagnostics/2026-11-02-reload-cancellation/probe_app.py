"""Isolated reload experiment. Never used by the production application."""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from uvicorn.supervisors import ChangeReload

from hoga.api.models import ScanRequest, ScreenerResponse
from hoga.api.screener_continuous import ContinuousMonitors, Monitor
from hoga.api.screener_history_jobs import _finish_disk_write
from hoga.compute_executor import ComputeExecutor
from hoga.live.buffer import LiveBuffer

_stop = threading.Event()
_events_lock = threading.Lock()


def emit(event: str, **extra) -> None:
    row = {"event": event, "pid": os.getpid(), "at": time.monotonic(), **extra}
    path = Path(os.environ["PROBE_SANDBOX"]) / f"events.{os.getpid()}.jsonl"
    with _events_lock, path.open("a") as file:
        file.write(json.dumps(row) + "\n")


def blocking_work(duration: float, cooperative: bool = False) -> None:
    emit("work_started")
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        if cooperative and _stop.wait(0.02):
            emit("work_cancelled")
            return
        if not cooperative:
            time.sleep(min(0.02, max(0, deadline - time.monotonic())))
    emit("work_completed")


def commit_write(duration: float) -> None:
    emit("write_started")
    time.sleep(duration)
    path = Path(os.environ["PROBE_SANDBOX"]) / "committed.json"
    staged = path.with_suffix(".tmp")
    staged.write_text(json.dumps({"complete": True}))
    staged.replace(path)
    emit("write_committed")


async def run_work(mode: str, executor: ComputeExecutor | None, duration: float, active_sync: set) -> None:
    if mode.endswith("async"):
        emit("work_started")
        await asyncio.sleep(duration)
        emit("work_completed")
    elif executor is not None:
        await executor.run(blocking_work, duration)
    elif mode == "early_thread_joined":
        task = asyncio.create_task(asyncio.to_thread(blocking_work, duration))
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise
    elif mode in ("early_thread_tracked", "early_cooperative"):
        task = asyncio.create_task(asyncio.to_thread(blocking_work, duration, mode == "early_cooperative"))
        active_sync.add(task)
        task.add_done_callback(active_sync.discard)
        await asyncio.shield(task)
    else:
        await asyncio.to_thread(blocking_work, duration, mode == "early_cooperative")


async def close_runtime(owner, executor, active_sync) -> None:
    emit("lifespan_shutdown")
    await owner.close()
    if active_sync:
        emit("work_ack_drain_started")
        await asyncio.gather(*active_sync, return_exceptions=True)
        emit("work_ack_drain_finished")
    if executor is not None:
        await executor.aclose()
    emit("lifespan_closed")


def create_app() -> FastAPI:
    mode = os.environ["PROBE_MODE"]
    executor = ComputeExecutor("process", name="reload-probe") if mode == "early_process" else None
    active_sync: set[asyncio.Task] = set()

    async def set_targets(_codes):
        return None

    owner = ContinuousMonitors(Path(os.environ["PROBE_SANDBOX"]), None, LiveBuffer(), set_targets)
    request = ScanRequest.model_validate({"conditions": [{"id": "v", "type": "new_high_vol",
        "params": {"timeframe": "1m", "period": 2, "lookback": 1}}],
        "universe": {"scopes": ["watchlist"]}, "basis": "intraday"})
    owner.monitors["probe"] = Monitor("probe", "fixture", request, ["005930"], [], owner.now())

    async def scan(_monitor):
        duration = float(os.environ["PROBE_DURATION"])
        emit("scan_started")
        try:
            await run_work(mode, executor, duration, active_sync)
            emit("scan_completed")
            return ScreenerResponse.model_construct(status="ok", rows=[])
        except asyncio.CancelledError:
            if mode.endswith("async"):
                emit("work_cancelled")
            emit("scan_cancelled")
            raise

    owner._scan_result = scan

    async def begin_stop():
        if mode == "baseline_async":
            return
        if mode == "early_cooperative":
            _stop.set()
        emit("early_cancel_started")
        await owner.close()
        emit("early_cancel_finished")

    @asynccontextmanager
    async def lifespan(_app):
        emit("ready")
        try:
            yield {"hoga_probe_stop": begin_stop}
        finally:
            await close_runtime(owner, executor, active_sync)

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"pid": os.getpid()}

    @app.get("/result")
    async def result():
        try:
            response = await owner.result("probe")
            emit("result_returned", status=200)
            return {"status": response.status}
        except (asyncio.CancelledError, HTTPException):
            if not owner.closed:
                raise
            emit("result_returned", status=503)
            return JSONResponse({"reason": "server_restarting"}, status_code=503)

    @app.post("/commit")
    async def commit():
        await _finish_disk_write(commit_write, 0.8)
        return {"complete": True}

    return app


class ProbeServer(uvicorn.Server):
    async def shutdown(self, sockets=None):
        emit("shutdown_entered")
        await super().shutdown(sockets)

    async def _wait_tasks_to_complete(self):
        await self.lifespan.state["hoga_probe_stop"]()
        await super()._wait_tasks_to_complete()


def serve(port: int) -> None:
    config = uvicorn.Config("probe_app:create_app", factory=True, host="127.0.0.1", port=port,
        reload=True, reload_dirs=[str(Path(os.environ["PROBE_SANDBOX"]) / "watch")],
        reload_delay=0.1, log_level="info", access_log=False)
    server = ProbeServer(config)
    sock = config.bind_socket()
    ChangeReload(config, target=server.run, sockets=[sock]).run()
