"""Six offline sockets exercise the real parser, stream and durable stores."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime

from hoga.live.buffer import LiveBuffer
from hoga.live.kiwoom_ws_client import KiwoomWsClient
from hoga.live.second_trade_store import SecondTradeStore
from hoga.live.stream import LiveStream
from hoga.live.writer import LiveWriter
from hoga.util.timeenc import KST

DATE = "20260616"
T = int(datetime(2026, 6, 16, 10, tzinfo=KST).timestamp() * 1000)


class OfflineSocket:
    def __init__(self, frames):
        self.frames = iter(frames)
        self.sent = []

    async def recv(self):
        raw = next(self.frames, None)
        if raw is None:
            await asyncio.Event().wait()
        return raw

    async def send(self, raw):
        self.sent.append(json.loads(raw))


async def test_six_accounts_preserve_mixed_ticks_during_real_storage_flush(tmp_path):  # noqa: PLR0915 — one six-account lifecycle
    codes = [f"{i + 1:06}" for i in range(319)]
    buffer = LiveBuffer()
    clients, sockets, streams, stores, seen, expected = [], [], [], [], [], []
    receivers, acks = [], []
    flushing = []

    for account in range(6):
        owned = codes[account::6]
        store = SecondTradeStore(tmp_path / str(account) / "seconds")
        store._sealed_before = T - 1000
        stream = LiveStream(buffer=buffer, writer=LiveWriter(tmp_path / str(account) / "legacy"),
                            date_fn=lambda: DATE, phase_fn=lambda: "regular", seconds=store)
        stream.set_active_codes(set(owned))
        stream._open_venues = frozenset({"KRX", "NXT", "UN"})
        received, ordered, frames = [], [], []
        for frame in range(96):
            rows = []
            for offset in range(4):
                index = frame * 4 + offset
                code = owned[index % len(owned)]
                suffix, venue = [("", "KRX"), ("_NX", "NXT"), ("_AL", "UN")][index % 3]
                kind = "0B" if index % 2 == 0 else "0D"
                values = {"20": "100000", "10": "100", "15": "2"} if kind == "0B" else {
                    "21": "100000", **{str(fid): "100" for fid in range(41, 61)},
                    **{str(fid): "10" for fid in range(61, 81)}, "121": "100", "125": "100",
                }
                rows.append({"type": kind, "item": code + suffix, "values": values})
                ordered.append((code, venue, "trade" if kind == "0B" else "ob"))
            frames.append(json.dumps({"trnm": "REAL", "data": rows}))
            if frame in (0, 95):
                frames.append('{"trnm":"PING"}')
                frames.append('{"trnm":"REG","return_code":0}')

        async def consume(tick, stream=stream, received=received):
            await stream.on_tick(tick)
            received.append((tick.code, tick.venue, tick.kind.value))
            if len(received) % 8 == 0:
                await asyncio.sleep(0)  # A callback which already gave controls a turn.

        ws = OfflineSocket(frames)
        instance = KiwoomWsClient(token_fn=lambda: asyncio.sleep(0, result="unused"),
                                  on_tick=consume, date_fn=lambda: DATE, account_id=account)
        instance._ws = ws
        ack = asyncio.get_running_loop().create_future()
        instance._ack_waiters["REG"] = ack
        acks.append(ack)
        clients.append(instance)
        sockets.append(ws)
        streams.append(stream)
        stores.append(store)
        seen.append(received)
        expected.append(ordered)

    async def concurrent_flush(stream, received):
        while len(received) < 8:
            await asyncio.sleep(0)
        await stream.flush_once(now_ms=T + 10_000)

    try:
        receivers = [asyncio.create_task(c._recv_loop(ws)) for c, ws in zip(clients, sockets, strict=True)]
        flushing = [asyncio.create_task(concurrent_flush(s, r)) for s, r in zip(streams, seen, strict=True)]
        async with asyncio.timeout(30):
            while any(len(r) < len(e) for r, e in zip(seen, expected, strict=True)):
                for receiver in receivers:
                    if receiver.done():
                        receiver.result()
                await asyncio.sleep(0)
            await asyncio.gather(*flushing)
            await asyncio.gather(*(s.flush_once(now_ms=T + 70_000) for s in streams))
        assert seen == expected
        assert set(code for account in seen for code, _, _ in account) == set(codes)
        assert all(ws.sent == [{"trnm": "PING"}] * 2 for ws in sockets)
        assert all(ack.done() and ack.result()["return_code"] == 0 for ack in acks)
        for c in clients:
            assert c.data_queue_snapshot()["overflows"] == 0
            assert c.data_queue_snapshot()["discarded_messages"] == 0
            assert c._flow.completed_frames == 96
            assert c._consumer_budget.observed_resumes > 0
        for store, ordered in zip(stores, expected, strict=True):
            volume = sum(row["volume"] for code, venue in set((c, v) for c, v, _ in ordered)
                         for row in store.disk_rows(code, venue, DATE))
            assert volume == 384  # 192 trades × quantity 2, independently replayed from disk.
        legacy = [json.loads(line) for path in tmp_path.glob("*/legacy/*/*/*.jsonl")
                  for line in path.read_text().splitlines()]
        assert {row["kind"] for row in legacy} >= {"ob", "trade", "fill", "candle"}
        assert sum(row["payload"]["volume"] for row in legacy if row["kind"] == "candle") == 2304
        assert all(s._ask_peak_by_code and s._bid_peak_by_code for s in streams)
    finally:
        for task in [*receivers, *flushing]:
            task.cancel()
        await asyncio.gather(*receivers, *flushing, return_exceptions=True)
