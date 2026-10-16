"""Uvicorn reload must release pool semaphores before re-raising SIGTERM."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


@pytest.mark.skipif(sys.platform != "linux", reason="POSIX reload signal lifecycle")
@pytest.mark.parametrize("stop_signal", [signal.SIGTERM, signal.SIGINT])
def test_reload_and_stop_release_compute_pool_semaphores(tmp_path: Path, stop_signal: int) -> None:
    # Use a credential-free ASGI app and an OS-assigned port. This exercises
    # Uvicorn's real supervisor/signal behavior without starting vendor clients.
    app_source = '''
import asyncio
import time
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from hoga.api.compute_pools import ComputePools
from hoga.compute_executor import ComputeExecutor, _worker_pid
from hoga.live.promote_executor import PromoteExecutor

@asynccontextmanager
async def lifespan(app):
    pools = ComputePools(ComputeExecutor(), ComputeExecutor())
    promoter = PromoteExecutor()
    await asyncio.gather(*(ex.run(_worker_pid) for ex in
                           (pools.wide, pools.narrow, promoter)))
    # Cancelling the caller leaves submitted work alive, as during shutdown.
    work = asyncio.create_task(promoter.run(time.sleep, 0.2))
    await asyncio.sleep(0)
    work.cancel()
    await asyncio.gather(work, return_exceptions=True)
    with Path("ready").open("a") as ready:
        ready.write("started\\n")
    try:
        yield
    finally:
        await pools.aclose()
        await promoter.aclose()

app = FastAPI(lifespan=lifespan)
'''
    app_path = tmp_path / "shutdown_app.py"
    app_path.write_text(app_source)
    ready_path = tmp_path / "ready"
    root = Path(__file__).resolve().parents[2]
    env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(root), str(tmp_path))))
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "shutdown_app:app", "--host", "127.0.0.1",
         "--port", "0", "--reload", "--reload-dir", str(tmp_path),
         "--reload-delay", "0.1"],
        cwd=tmp_path, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, start_new_session=True,
    )
    try:
        for generation in range(3):
            deadline = time.monotonic() + 30
            while True:
                if proc.poll() is not None:
                    output, _ = proc.communicate(timeout=10)
                    pytest.fail(output)
                if ready_path.exists() and len(ready_path.read_text().splitlines()) >= generation + 1:
                    break
                assert time.monotonic() < deadline, "Uvicorn startup/reload timed out"
                time.sleep(0.05)
            if generation < 2:
                app_path.write_text(app_source + f"\n# reload {generation}\n")
        proc.send_signal(stop_signal)
        # Read through EOF, including the separate resource tracker's final
        # output. Waiting only for the supervisor can miss a late warning.
        output, _ = proc.communicate(timeout=30)
    finally:
        # Only this test's isolated process group is eligible for cleanup.
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate(timeout=10)

    assert "Stopping reloader process" in output, output
    assert output.count("Application shutdown complete.") == 3, output
    assert "resource_tracker:" not in output, output
    assert "Traceback" not in output, output
