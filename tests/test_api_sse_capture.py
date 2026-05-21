"""SSE bus delivers capture_* events 1:1 (no throttling in v1+1).

Uses real uvicorn + httpx streaming (same pattern as tests/test_api_sse.py),
because httpx.ASGITransport buffers the full response body before returning
headers — incompatible with the indefinite SSE stream.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
import uvicorn

from hoga.api.app import create_app


async def _wait_started(server: uvicorn.Server, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not server.started:
        if asyncio.get_running_loop().time() > deadline:
            raise RuntimeError("server did not start")
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_sse_capture_finished_after_progress(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app = create_app(data_dir)

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        await _wait_started(server)
        port = server.servers[0].sockets[0].getsockname()[1]
        base = f"http://127.0.0.1:{port}"

        sse_events: list[dict] = []
        async def collect_events():
            async with httpx.AsyncClient(timeout=30) as client, \
                       client.stream("GET", f"{base}/api/events") as r:
                buf = ""
                async for chunk in r.aiter_text():
                    # sse_starlette uses CRLF — normalize so a single
                    # "\n\n" delimiter splits event blocks regardless.
                    buf += chunk.replace("\r\n", "\n")
                    while "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                        evt_type = ""
                        evt_data = ""
                        for line in block.splitlines():
                            if line.startswith("event:"):
                                evt_type = line.split(":", 1)[1].strip()
                            elif line.startswith("data:"):
                                evt_data = line.split(":", 1)[1].strip()
                        if evt_type.startswith("capture_"):
                            sse_events.append({"type": evt_type,
                                               "data": json.loads(evt_data) if evt_data else {}})
                        if evt_type == "capture_finished":
                            return

        collect_task = asyncio.create_task(collect_events())
        await asyncio.sleep(0.2)  # let SSE subscribe

        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(f"{base}/api/captures", json={
                "code": "005930", "date": "20260520",
                "allow_partial": True, "resume": False, "capture_only": True,
            })
            assert r.status_code == 201, r.text

        await asyncio.wait_for(collect_task, timeout=30)

        # At least one progress + one terminal finished, in order
        terminal_idx = next(i for i, e in enumerate(sse_events)
                            if e["type"] == "capture_finished")
        progress_count = sum(1 for e in sse_events[:terminal_idx]
                             if e["type"] == "capture_progress")
        assert progress_count >= 1, sse_events
        assert sse_events[terminal_idx]["data"]["phase"] in {"done", "failed"}
    finally:
        server.should_exit = True
        await task
