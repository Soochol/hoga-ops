"""Inventory push channel via SSE + watchdog directory observer."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Literal

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

logger = logging.getLogger(__name__)

WatchdogKind = Literal["created", "modified", "deleted"]


def classify_inventory_event(
    src_path: str,
    parquet_root: Path,
    *,
    is_directory: bool,
    kind: WatchdogKind,
) -> dict | None:
    """Decide whether a watchdog filesystem event should produce an
    inventory_* SSE event, and build the payload if so.

    Returns None when the event is irrelevant (wrong path, wrong depth,
    or wrong kind/is_directory combination). Returns a payload dict
    when the event maps to a visible inventory change.

    Pure function: no asyncio, no Bus, no I/O. Filesystem state is
    implicit in the inputs.

    Rules:
      - ``inventory_removed`` fires on directory deletion at depth=2
        (``parquet/<date>/<code>/``). When the dir vanishes, the row
        vanishes from ``list_stock_dates``.
      - ``inventory_added`` fires on ``meta.json`` create OR modify at
        depth=3 (``parquet/<date>/<code>/meta.json``). The capture
        worker writes ``meta.json`` LAST, so its appearance is when
        ``list_stock_dates`` first sees the row; re-captures overwrite
        the file, firing ``on_modified`` — also a refresh signal.
      - Everything else returns ``None``.
    """
    p = Path(src_path)
    try:
        rel = p.relative_to(parquet_root)
    except ValueError:
        return None
    parts = rel.parts

    if kind == "deleted" and is_directory and len(parts) == 2:
        date, code = parts
        return {"type": "inventory_removed", "code": code, "date": date}

    if kind in ("created", "modified") and not is_directory and len(parts) == 3:
        date, code, fname = parts
        if fname == "meta.json":
            return {"type": "inventory_added", "code": code, "date": date}

    return None


class _Bus:
    def __init__(self) -> None:
        self.queues: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        self.queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.queues.discard(q)

    def publish(self, evt: dict) -> None:
        for q in self.queues:
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                # Slow subscriber: log so the consistency gap is visible.
                logger.warning("SSE queue full, dropped event: %s", evt)


class _InventoryHandler(FileSystemEventHandler):
    def __init__(self, bus: _Bus, parquet_root: Path, loop: asyncio.AbstractEventLoop | None) -> None:
        self.bus = bus
        self.root = parquet_root
        self.loop = loop

    def _maybe_emit(self, path: str, kind: str) -> None:
        if self.loop is None:
            return
        p = Path(path)
        try:
            rel = p.relative_to(self.root)
        except ValueError:
            return
        parts = rel.parts
        if len(parts) != 2:
            return
        date, code = parts
        evt = {"type": kind, "code": code, "date": date}
        self.loop.call_soon_threadsafe(self.bus.publish, evt)

    def on_created(self, event):
        if event.is_directory:
            self._maybe_emit(event.src_path, "inventory_added")

    def on_deleted(self, event):
        if event.is_directory:
            self._maybe_emit(event.src_path, "inventory_removed")


def build_sse(parquet_root: Path) -> tuple[APIRouter, _Bus, Observer]:
    bus = _Bus()
    router = APIRouter()

    # Loop is captured at request time when a real running loop exists.
    handler = _InventoryHandler(bus, parquet_root, loop=None)
    observer = Observer()
    parquet_root.mkdir(parents=True, exist_ok=True)
    observer.schedule(handler, str(parquet_root), recursive=True)

    @router.get("/api/events")
    async def events():
        # Bind the watchdog handler to the loop that is actually serving requests.
        handler.loop = asyncio.get_running_loop()

        async def stream():
            q = bus.subscribe()
            try:
                while True:
                    try:
                        evt = await asyncio.wait_for(q.get(), timeout=30.0)
                        yield {"event": evt["type"], "data": json.dumps(evt)}
                    except asyncio.TimeoutError:
                        yield {"event": "heartbeat", "data": ""}
            finally:
                bus.unsubscribe(q)

        return EventSourceResponse(stream())

    return router, bus, observer
