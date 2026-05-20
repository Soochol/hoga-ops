"""SSE inventory_added event fires when a new Stock-Date directory appears.

A real uvicorn server is used because ``httpx.ASGITransport`` buffers the
full response body before returning headers, which is incompatible with the
indefinite SSE stream this endpoint produces.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
import uvicorn

from hoga.api.app import create_app


async def _wait_until_started(server: uvicorn.Server, timeout: float = 5.0) -> None:
    """Poll the uvicorn ``Server.started`` flag until the listener is bound."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not server.started:
        if asyncio.get_running_loop().time() > deadline:
            raise RuntimeError("uvicorn did not start within timeout")
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_sse_inventory_added(tmp_path):
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir)

    # Bind to an ephemeral port so multiple test runs do not collide.
    config = uvicorn.Config(
        app, host="127.0.0.1", port=0, log_level="warning", lifespan="on"
    )
    server = uvicorn.Server(config)
    serve_task = asyncio.create_task(server.serve())
    try:
        await _wait_until_started(server)
        port = server.servers[0].sockets[0].getsockname()[1]

        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}", timeout=10.0
        ) as client:
            async with client.stream("GET", "/api/events") as r:

                async def make_dir():
                    # Give watchdog inotify warmup a beat after server start.
                    await asyncio.sleep(0.5)
                    (data_dir / "parquet" / "20260521" / "207940").mkdir(parents=True)

                asyncio.create_task(make_dir())
                saw_inventory_added = False
                async for raw in r.aiter_lines():
                    if raw.startswith("event: inventory_added"):
                        saw_inventory_added = True
                        break
                assert saw_inventory_added
    finally:
        server.should_exit = True
        await serve_task
