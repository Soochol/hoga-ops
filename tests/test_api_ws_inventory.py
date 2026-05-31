"""WebSocket port of the /api/events SSE e2e inventory test.

Previously, ``test_api_sse.py::test_sse_inventory_added`` spun up a real
uvicorn server because ``httpx.ASGITransport`` buffers SSE bodies.  WebSocket
has no such limitation, so we use Starlette's ``TestClient`` instead.

``TestClient.__enter__`` runs the full FastAPI lifespan, which:
 - starts the watchdog observer (``observer.start()``)
 - binds ``inv_handler.loop`` to the running asyncio event loop

so by the time ``websocket_connect`` returns the bus subscription is live and
the observer is already watching the parquet directory.
"""

from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from hoga.api.app import create_app


def test_ws_inventory_added(tmp_path: Path) -> None:
    """inventory_added event is delivered over WS when meta.json appears."""
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir)

    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        # Observer is armed and bus subscription is active at this point.
        # Give inotify a small beat so the recursive watch is fully registered
        # before we write — observer.start() is synchronous but the inotify
        # descriptor may still be setting up on the kernel side.
        time.sleep(0.2)

        code_dir = data_dir / "parquet" / "20260521" / "207940"
        code_dir.mkdir(parents=True)
        # Per _InventoryHandler: inventory_added fires when meta.json appears
        # (the capture worker writes meta.json last, so that is when
        # list_stock_dates first sees the row).  Dir creation classifies to
        # None and is ignored.
        (code_dir / "meta.json").write_text("{}", encoding="utf-8")

        # Linux inotify may fire on_created + on_modified for a single write,
        # producing two identical frames.  Assert only the first.
        frame = ws.receive_json()
        assert frame == {
            "ch": "event",
            "data": {"type": "inventory_added", "code": "207940", "date": "20260521"},
        }
