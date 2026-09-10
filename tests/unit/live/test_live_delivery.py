import asyncio

from hoga.live.buffer import LiveBuffer
from hoga.live.delivery import LiveDelivery, LiveOutbox
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def entry(seq, *, venue="KRX", kind="ob"):
    return {"seq": seq, "t_ms": 1000, "venue": venue, "kind": kind, "qty": seq}


async def test_overflow_preserves_latest_per_venue_and_reports_history_loss():
    buf = LiveBuffer()
    q = buf.subscribe("005930", batch=True)
    # Quiet venue must survive an active venue's entire burst.
    await buf.publish("005930", [LiveSnapshot(1, SnapshotKind.OB, {"venue": "NXT"})])
    for n in range(1200):
        await buf.publish("005930", [LiveSnapshot(n, SnapshotKind.OB, {"venue": "KRX"})])
    batch = await q.get()
    assert batch["dropped"] == 177
    latest = {row["venue"]: row for row in batch["latest"]}
    assert latest["KRX"]["seq"] == 1201
    assert latest["NXT"]["seq"] == 1
    assert batch["data"][0]["seq"] == 178
    assert (await buf.stats_snapshot())["subscriber_drops"] == 177


async def test_ordered_batches_preserve_all_normal_load_trades_and_multiplicity():
    q = LiveDelivery()
    for n in range(500):
        q.put_nowait(entry(n, kind="trade"))
    rows = []
    while not q.empty():
        batch = await q.get()
        assert batch["dropped"] == 0
        rows.extend(batch["data"])
    assert [row["seq"] for row in rows] == list(range(500))
    assert sum(row["qty"] for row in rows) == sum(range(500))


async def test_slow_socket_outbox_is_fair_and_keeps_latest_separate_from_history():
    out = LiveOutbox()
    for code in ("A", "B"):
        q = LiveDelivery()
        for n in range(1500):
            q.put_nowait(entry(n))
        while not q.empty():
            out.offer(code, await q.get())
    out.put_nowait({"ch": "subscribed", "code": "A"})
    assert (await out.get())["ch"] == "subscribed"
    a, b = await out.get(), await out.get()
    assert [a["code"], b["code"]] == ["A", "B"]
    assert a["dropped"] == b["dropped"] == 476
    assert a["latest"][0]["seq"] == 1499
    assert a["data"][0]["seq"] == 476


async def test_outbox_recovers_after_discarding_last_pending_code():
    out = LiveOutbox()
    q = LiveDelivery()
    q.put_nowait(entry(1))
    out.offer("A", await q.get())
    out.discard("A")
    task = asyncio.create_task(out.get())
    await asyncio.sleep(0)
    out.put_nowait({"ch": "subscribed", "code": "B"})
    assert await task == {"ch": "subscribed", "code": "B"}


async def test_intermediate_history_does_not_replace_unsent_latest():
    out = LiveOutbox()
    out.offer("A", {"data": [entry(1)], "latest": [entry(99)], "dropped": 0})
    out.offer("A", {"data": [entry(2)], "latest": [], "dropped": 0})
    batch = await out.get()
    assert batch["latest"][0]["seq"] == 99
    assert [row["seq"] for row in batch["data"]] == [1, 2]
