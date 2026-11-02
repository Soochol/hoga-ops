"""Run file-triggered Uvicorn reloads with repository-owned result cancellation."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
from http import HTTPStatus
from importlib.metadata import version
from pathlib import Path

import httpx

MODES = ("baseline_async", "early_async", "early_thread", "early_thread_joined", "early_thread_tracked",
         "early_cooperative", "early_process")
ROOT = Path(__file__).resolve().parents[3]


def events(folder: Path) -> list[dict]:
    rows = []
    for file in folder.glob("events.*.jsonl"):
        for line in file.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return sorted(rows, key=lambda row: row["at"])


async def until(predicate, *, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        await asyncio.sleep(0.02)
    raise TimeoutError("probe condition did not become true")


def environment(folder: Path, mode: str, duration: float) -> dict[str, str]:
    # Allowlist rather than inheritance prevents real broker keys and dotenv state.
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL") if key in os.environ}
    env.update(PROBE_SANDBOX=str(folder), PROBE_MODE=mode, PROBE_DURATION=str(duration),
               PYTHONPATH=os.pathsep.join((str(ROOT), str(Path(__file__).resolve().parent))),
               PYTHONUNBUFFERED="1", HOGA_DATA_DIR=str(folder / "data"),
               HOGA_LOG_DIR=str(folder / "logs"), XDG_DATA_HOME=str(folder / "xdg"))
    return env


def observation(folder, mode, protected, first, restarted, changed_at, healthy_at, response):
    rows = events(folder)
    stopped = next(row for row in rows if row["event"] == "shutdown_entered")
    closed = next(row for row in rows if row["event"] == "lifespan_closed")
    response_event = next(row for row in rows if row["event"] == "result_returned")
    work_done = [row for row in rows if row["event"] in ("work_completed", "work_cancelled")]
    assert work_done or mode == "early_thread", "safe variants must acknowledge actual work exit"
    assert not Path(f"/proc/{first['pid']}").exists(), "old reload child survived"
    old_pids = {row["pid"] for row in rows if row["at"] < restarted["at"]}
    assert all(not Path(f"/proc/{pid}").exists() for pid in old_pids), "old work process survived"
    return {"mode": mode, "protected_write": protected, "response_status": response.status_code,
        "file_change_to_ready_s": restarted["at"] - changed_at,
        "file_change_to_health_s": healthy_at - changed_at,
        "shutdown_to_ready_s": restarted["at"] - stopped["at"],
        "shutdown_to_read_response_s": response_event["at"] - stopped["at"],
        "lifespan_closed_to_ready_s": restarted["at"] - closed["at"],
        "work_outcome": work_done[-1]["event"] if work_done else "completion_unacknowledged_at_exit",
        "cleanup_acknowledged": bool(work_done), "events": rows}


async def exercise(folder, mode, port, protected):
    await until(lambda: any(row["event"] == "ready" for row in events(folder)))
    first = next(row for row in events(folder) if row["event"] == "ready")
    # WatchFiles must be watching before the source modification is emitted.
    await asyncio.sleep(0.35)
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=30, trust_env=False) as client:
        assert (await client.get("/health")).json()["pid"] == first["pid"]
        result_task = asyncio.create_task(client.get("/result"))
        write_task = None
        try:
            await until(lambda: any(row["event"] == "work_started" for row in events(folder)))
            if protected:
                write_task = asyncio.create_task(client.post("/commit"))
                await until(lambda: any(row["event"] == "write_started" for row in events(folder)))
            changed_at = time.monotonic()
            (folder / "watch/trigger.py").write_text("generation = 1\n")
            restarted = await until(lambda: next((row for row in events(folder)
                if row["event"] == "ready" and row["pid"] != first["pid"]), None))
            response = await result_task
            health = await client.get("/health")
            healthy_at = time.monotonic()
            assert health.status_code == HTTPStatus.OK and health.json()["pid"] == restarted["pid"]
            expected = HTTPStatus.OK if mode == "baseline_async" else HTTPStatus.SERVICE_UNAVAILABLE
            assert response.status_code == expected, response.text
            if write_task is not None:
                assert (await write_task).status_code == HTTPStatus.OK
                assert json.loads((folder / "committed.json").read_text()) == {"complete": True}
            return observation(folder, mode, protected, first, restarted, changed_at, healthy_at, response)
        finally:
            for task in (result_task, write_task):
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(*(task for task in (result_task, write_task) if task is not None),
                                 return_exceptions=True)


async def stop_process(process):
    process.send_signal(signal.SIGTERM)
    try:
        output, _ = await asyncio.to_thread(process.communicate, timeout=10)
        return output
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        await asyncio.to_thread(process.communicate)
        raise AssertionError("probe cleanup required forced termination") from None


async def run_once(mode: str, duration: float, *, protected=False) -> dict:
    with tempfile.TemporaryDirectory(prefix="hoga-reload-probe-") as raw:
        folder = Path(raw)
        watch = folder / "watch"
        watch.mkdir()
        trigger = watch / "trigger.py"
        trigger.write_text("generation = 0\n")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--serve", str(port)],
            cwd=folder, env=environment(folder, mode, duration), stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, start_new_session=True)
        try:
            row = await exercise(folder, mode, port, protected)
        finally:
            server_log = await stop_process(process)
            if "row" not in locals():
                print(server_log[-6000:], file=sys.stderr)
        assert "WatchFiles detected changes" in server_log, "a real file reload must occur"
        assert "resource_tracker: There appear" not in server_log, "multiprocessing resources leaked"
        assert "Traceback (most recent call last)" not in server_log, server_log[-3000:]
        assert process.returncode == 0, process.returncode
        return {**row, "supervisor_exit_code": process.returncode, "server_log": server_log}


async def main(args) -> None:
    runs = []
    for repetition in range(args.repeats):
        # Every repetition interleaves the same modes under the live host workload.
        for mode in MODES:
            row = await run_once(mode, args.duration)
            row["repetition"] = repetition + 1
            runs.append(row)
            print(f"{repetition + 1} {mode}: {row['file_change_to_health_s']:.3f}s "
                  f"status={row['response_status']} work={row['work_outcome']}", flush=True)
    runs.append(await run_once("early_cooperative", args.duration, protected=True))
    summary = {}
    for mode in MODES:
        values = [row["file_change_to_health_s"] for row in runs
                  if row["mode"] == mode and not row["protected_write"]]
        summary[mode] = {"runs": len(values), "median_s": statistics.median(values),
                         "min_s": min(values), "max_s": max(values)}
    payload = {"scope": "Synthetic work; real Uvicorn reload, ContinuousMonitors and ComputeExecutor. "
                         "Not a production restart benchmark or a measured production speedup.",
        "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "environment": {"python": platform.python_version(), "uvicorn": version("uvicorn"),
                        "fastapi": version("fastapi"), "httpx": version("httpx"),
                        "cpu_count": os.cpu_count(), "load_average": os.getloadavg()},
        "duration_s": args.duration, "primary_metric": "file_change_to_health_s",
        "summary": summary, "runs": runs,
        "probe_sources": {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
                          for name in ("run_probe.py", "probe_app.py")}}
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", type=int)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--duration", type=float, default=2.0)
    parser.add_argument("--output", type=Path, default=Path("results.json"))
    arguments = parser.parse_args()
    if arguments.serve:
        from probe_app import serve
        serve(arguments.serve)
    else:
        asyncio.run(main(arguments))
