"""Pure-function and behavioral tests for the inventory event bus pipeline.

Separate from test_api_sse.py (the live uvicorn integration test) because
these tests are purely in-process — no inotify, no asyncio loop, no
network. The pure function and EventBus are unit-testable without fixtures.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from watchdog.events import FileCreatedEvent

from hoga.api.events import WatchdogKind, EventBus, _InventoryHandler, classify_inventory_event


@pytest.fixture
def parquet_root(tmp_path: Path) -> Path:
    root = tmp_path / "parquet"
    root.mkdir()
    return root


# All test paths are built via Path operations (not string concatenation
# with "/") so the test exercises the same normalisation that production
# watchdog paths go through on whatever OS the test runs on.
@pytest.mark.parametrize(
    "build_relative, is_directory, kind, expected",
    [
        # inventory_added: meta.json file create/modify at depth=3
        (
            ("20260524", "003490", "meta.json"), False, "created",
            {"type": "inventory_added", "code": "003490", "date": "20260524"},
        ),
        (
            ("20260524", "003490", "meta.json"), False, "modified",
            {"type": "inventory_added", "code": "003490", "date": "20260524"},
        ),
        # meta.json deletion is NOT an inventory_removed signal (dir-delete
        # is). The function returns None so the watchdog event is silently
        # filtered.
        (("20260524", "003490", "meta.json"), False, "deleted", None),
        # Non-meta.json file at the right depth: ignored.
        (("20260524", "003490", "trades.parquet"), False, "created", None),
        # Dir create at depth=2: no longer triggers inventory_added under
        # the new contract — meta.json doesn't exist yet at this moment.
        (("20260524", "003490"), True, "created", None),
        # Dir delete at depth=2: inventory_removed.
        (
            ("20260524", "003490"), True, "deleted",
            {"type": "inventory_removed", "code": "003490", "date": "20260524"},
        ),
        # Wrong depths.
        (("20260524",), True, "deleted", None),
        (("20260524", "003490", "subdir", "meta.json"), False, "created", None),
    ],
)
def test_classify_inventory_event(
    parquet_root: Path,
    build_relative: tuple[str, ...],
    is_directory: bool,
    kind: WatchdogKind,
    expected: dict | None,
) -> None:
    src_path = str(parquet_root.joinpath(*build_relative))
    result = classify_inventory_event(
        src_path, parquet_root, is_directory=is_directory, kind=kind
    )
    assert result == expected


def test_classify_inventory_event_rejects_path_outside_root(
    parquet_root: Path, tmp_path: Path,
) -> None:
    """A watchdog event for a path outside parquet_root returns None.

    Defensive: the observer is scheduled on parquet_root, so this
    shouldn't happen in production, but the function must not crash
    or misclassify if it does.
    """
    outside = tmp_path / "elsewhere" / "20260524" / "003490" / "meta.json"
    result = classify_inventory_event(
        str(outside), parquet_root, is_directory=False, kind="created",
    )
    assert result is None


@pytest.mark.asyncio
async def test_inventory_handler_dispatches_meta_create_to_bus(
    parquet_root: Path,
) -> None:
    """A meta.json file_created event reaches bus.publish with the right payload."""
    bus = EventBus()
    loop = asyncio.get_running_loop()
    handler = _InventoryHandler(bus, parquet_root, loop=loop)
    # Spy on the bus
    bus.publish = MagicMock(wraps=bus.publish)  # type: ignore[method-assign]

    meta_path = parquet_root / "20260524" / "003490" / "meta.json"
    handler.on_created(FileCreatedEvent(str(meta_path)))

    # _dispatch hops to the event loop via call_soon_threadsafe — yield
    # once so the scheduled publish runs.
    await asyncio.sleep(0)

    bus.publish.assert_called_once_with(
        {"type": "inventory_added", "code": "003490", "date": "20260524"},
    )


@pytest.mark.asyncio
async def test_inventory_handler_short_circuits_when_loop_none(
    parquet_root: Path,
) -> None:
    """Pre-startup events (loop=None) are silently dropped."""
    bus = EventBus()
    handler = _InventoryHandler(bus, parquet_root, loop=None)
    bus.publish = MagicMock(wraps=bus.publish)  # type: ignore[method-assign]

    meta_path = parquet_root / "20260524" / "003490" / "meta.json"
    handler.on_created(FileCreatedEvent(str(meta_path)))

    bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_bus_publish_fans_to_all_subscribers() -> None:
    bus = EventBus()
    q1 = bus.subscribe()
    q2 = bus.subscribe()

    bus.publish({"type": "heartbeat"})

    assert q1.get_nowait() == {"type": "heartbeat"}
    assert q2.get_nowait() == {"type": "heartbeat"}


@pytest.mark.asyncio
async def test_bus_unsubscribe_stops_delivery() -> None:
    bus = EventBus()
    q1 = bus.subscribe()
    q2 = bus.subscribe()
    bus.unsubscribe(q1)

    bus.publish({"type": "heartbeat"})

    # q1 was unsubscribed — its queue must stay empty.
    with pytest.raises(asyncio.QueueEmpty):
        q1.get_nowait()
    # q2 still subscribed — receives the event.
    assert q2.get_nowait() == {"type": "heartbeat"}


@pytest.mark.asyncio
async def test_bus_unsubscribe_idempotent() -> None:
    """Calling unsubscribe twice on the same queue must not raise.

    EventBus uses set.discard internally, which is the no-raise contract
    the caller relies on (the SSE stream's finally-block always calls
    unsubscribe, even if the client disconnected before subscribe
    completed in some error paths).
    """
    bus = EventBus()
    q = bus.subscribe()
    bus.unsubscribe(q)
    bus.unsubscribe(q)  # must not raise


@pytest.mark.asyncio
async def test_bus_publish_drops_with_warning_when_queue_full(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """When a subscriber's queue is full, publish logs a warning and
    does NOT raise. This protects fast publishers from one slow client."""
    bus = EventBus()
    q = bus.subscribe()
    # Saturate the queue (maxsize=64 per the bus implementation) so the
    # next publish hits QueueFull. Use put_nowait to avoid await yield
    # semantics affecting the test.
    while not q.full():
        q.put_nowait({"type": "filler"})

    with caplog.at_level(logging.WARNING, logger="hoga.api.events"):
        bus.publish({"type": "heartbeat"})

    assert any(
        "event bus queue full" in rec.message for rec in caplog.records
    ), f"expected QueueFull warning in caplog records: {[r.message for r in caplog.records]}"
