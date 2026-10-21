"""Actual spawn/four-socket path, using a fake broker and temporary capture data."""
import asyncio
import time
from datetime import datetime
from types import SimpleNamespace

from hoga.live.buffer import LiveBuffer
from hoga.live.collector_process import CaptureProcessSession
from hoga.live.collector_worker import run_worker
from hoga.live.snapshot import LiveSnapshot, SnapshotKind
from tests.unit.live.test_collector_process import FakeManager


class RegularClock:
    @classmethod
    def fromtimestamp(cls, stamp, tz):
        return datetime.fromtimestamp(stamp, tz).replace(hour=10)


class VolumeManager(FakeManager):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.buffer = kwargs['buffer']
        self._conns = {0: SimpleNamespace(codes={'005930'}, client=SimpleNamespace(
            connected=True, registration_ready=True, last_recv_ms=int(time.time()*1000),
            expected_codes={'005930'}, sub_missing=lambda: set(), connection_generation=1))}

    async def wait_for_trigger(self):
        while not (self.root / 'trigger').exists():
            await asyncio.sleep(0.01)
        stamp = int(time.time()*1000)
        for qty, cumulative in [(10, 100), (20, 120)]:
            await self.buffer.publish('005930', [LiveSnapshot(stamp, SnapshotKind.TRADE, dict(
                venue='KRX', cum_volume=cumulative, trades=[dict(t_ms=stamp, qty=qty)]))], now_ms=stamp)
        (self.root / 'child-progress').write_text('volume-published')


def volume_entry(root, epoch, sockets, parent_pid):
    from hoga.live import volume_state
    volume_state.datetime = RegularClock
    asyncio.run(run_worker(root, epoch, sockets, parent_pid, manager_factory=VolumeManager))


async def test_volume_snapshot_uses_separate_lane_and_survives_child_restart(tmp_path, monkeypatch):
    buffer = LiveBuffer()
    session = CaptureProcessSession(buffer=buffer, data_dir=tmp_path, process_target=volume_entry)

    async def config(targets, n_accounts):
        stamp = datetime.now().strftime('%Y%m%d')
        return dict(targets=list(targets), n_accounts=1, nxt_map={}, names={'005930': 'test'},
            calendar_date=stamp, calendar_allowed=True, view_refs=[], view_codes=[], account_refs=[])

    monkeypatch.setattr(session, '_configuration', config)
    try:
        await session.sync(('005930',), n_accounts=1)
        await session.set_volume_targets({'005930'})
        (tmp_path/'trigger').write_text('go')
        async with asyncio.timeout(10):
            while True:
                state = buffer.volume_replica.get('005930', int(time.time()*1000))
                if state and state['bars']:
                    break
                await asyncio.sleep(0.02)
        assert state['bars'][-1][1] == 30
        assert state['ready']
        assert buffer.volume_external
        assert any(task.get_name() == 'collector-volume' for task in session.tasks)
        old_epoch = buffer.volume_replica.epoch
        await session.stop()
        (tmp_path/'trigger').unlink()
        await session.sync(('005930',), n_accounts=1)
        assert buffer.volume_replica.epoch != old_epoch
        assert not buffer.volume_replica.streams
    finally:
        await session.stop()
