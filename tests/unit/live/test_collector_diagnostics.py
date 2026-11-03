import asyncio
import gc
import os
import socket
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hoga.api import gc_probe, ownership
from hoga.live import collector_worker as M, kiwoom_diagnostics as D


async def until(predicate):
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0)
    assert predicate()


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    from hoga.live import last_ob_runtime, last_ob_store

    callbacks, thresholds = list(gc.callbacks), gc.get_threshold()
    instances, flushers, recorders = [], [], []
    release = AsyncMock()
    worker_type = M.CollectorWorker
    probe_type = D.LoopLagEvidence

    async def wait(*_args):
        await asyncio.Event().wait()

    class Worker:
        synchronize = worker_type.synchronize

        def __init__(self, root, epoch, peer, **_kwargs):
            self.config = {}
            self.epoch, self.peer = epoch, peer
            self.started_at_ms = 42
            self.stopping = asyncio.Event()
            self.ready = False
            self.buffer = SimpleNamespace(desired_version=0, restore_last_ob=AsyncMock(),
                                          drop_codes_except=AsyncMock())
            self.monitor = SimpleNamespace(set_targets=Mock())
            self.manager = SimpleNamespace(sync=AsyncMock(), status=lambda: {}, _us_refs=set())
            self.views = {}
            self.program = SimpleNamespace(start=Mock())
            self.display = self.state_outbox = self.volume_outbox = SimpleNamespace(send=wait)
            self.shutdown = AsyncMock()
            instances.append(self)

        commands = states = watchdog = volumes = staticmethod(wait)

    def start_flusher(*_args, **_kwargs):
        task = asyncio.create_task(wait(), name='test-diagnostics-flusher')
        flushers.append(task)
        return task

    def probe():
        recorder = probe_type(interval_s=0)
        recorders.append(recorder)
        return recorder

    monkeypatch.setattr(M, 'CollectorWorker', Worker)
    monkeypatch.setattr(M, '_parent_watch', lambda *_args: None)
    monkeypatch.setattr(M, '_release_capture', release)
    monkeypatch.setattr(ownership, 'acquire', lambda *_args: True)
    monkeypatch.setattr(last_ob_runtime, 'start_flusher', start_flusher)
    monkeypatch.setattr(last_ob_store, 'load', lambda *_args: {})
    monkeypatch.setattr(D, 'LoopLagEvidence', probe)
    pairs = [socket.socketpair() for _ in range(4)]
    try:
        yield SimpleNamespace(path=tmp_path, sockets=tuple(pair[0] for pair in pairs), workers=instances,
                              recorders=recorders, flushers=flushers, release=release)
    finally:
        for pair in pairs:
            for sock in pair:
                sock.close()
        D.configure_failure_context(None)
        gc_probe.uninstall()
        gc.set_threshold(*thresholds)
        assert gc.callbacks == callbacks


def assert_clean(runtime):
    assert D.failure_context() == {'runtime_context': 'not_wired'}
    assert gc_probe.stats_snapshot()['enabled'] is False
    assert all(task.done() for task in runtime.flushers)
    assert not [task for task in asyncio.all_tasks() if task.get_name() == 'collector-loop-evidence']
    for recorder in runtime.recorders:
        assert recorder.state in ('unobserved', 'stopped', 'failed')
        assert recorder.snapshot()['pending_deadline'] is None
        assert recorder.snapshot()['pending_overdue_ms'] is None


@pytest.mark.parametrize('ending', ['normal', 'cancel', 'shutdown_failure', 'probe_failure'])
async def test_worker_one_optional_probe_survives_sync_and_cleans_every_exit(runtime, ending):
    task = asyncio.create_task(M.run_worker(str(runtime.path), 'a' * 32, runtime.sockets, os.getpid()))
    try:
        await until(lambda: runtime.flushers and runtime.recorders[0].state == 'active')
        worker, recorder = runtime.workers[0], runtime.recorders[0]
        assert gc_probe.stats_snapshot()['enabled'] is True
        for version in range(1, 6):
            await worker.synchronize({'version': version, 'targets': [], 'n_accounts': 0,
                                      'commit': 'b' * 40, 'live_started_at_ms': 7})
        assert len(runtime.recorders) == 1
        assert len([t for t in asyncio.all_tasks() if t.get_name() == 'collector-loop-evidence']) == 1
        context = D.failure_context()
        assert context['collector_epoch'] == 'a' * 32
        assert context['commit'] == 'b' * 40
        assert context['collector_loop']['state'] == 'active'
        if ending == 'probe_failure':
            def broken_clock_once():
                recorder.clock = time.monotonic
                raise RuntimeError('SECRET')
            recorder.clock = broken_clock_once
            await until(lambda: recorder.state == 'failed')
            assert not task.done()
            assert worker.manager.sync.await_count == 5
        if ending == 'shutdown_failure':
            worker.shutdown.side_effect = RuntimeError('shutdown test')
        if ending == 'cancel':
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            worker.stopping.set()
            if ending == 'shutdown_failure':
                with pytest.raises(RuntimeError, match='shutdown test'):
                    await task
            else:
                await task
        assert worker.shutdown.await_count == 1
        assert runtime.release.await_count == 1
        if ending == 'probe_failure':
            assert recorder.state == 'failed'
        assert_clean(runtime)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize('stage', ['channel', 'constructor', 'gc_install', 'ownership', 'restore'])
async def test_worker_setup_failure_clears_context_callbacks_and_optional_task(runtime, monkeypatch, stage):
    def broken(*_args, **_kwargs):
        raise RuntimeError('setup test')

    if stage == 'channel':
        original = M.open_channel
        opened = 0

        async def open_channel(sock):
            nonlocal opened
            opened += 1
            if opened == 2:
                broken()
            return await original(sock)
        monkeypatch.setattr(M, 'open_channel', open_channel)
    elif stage == 'constructor':
        monkeypatch.setattr(M, 'CollectorWorker', broken)
    elif stage == 'gc_install':
        original_install = gc_probe.install

        def install(**kwargs):
            original_install(**kwargs)
            broken()
        monkeypatch.setattr(gc_probe, 'install', install)
    elif stage == 'ownership':
        monkeypatch.setattr(ownership, 'acquire', lambda *_args: False)
    else:
        original_worker = M.CollectorWorker

        def worker(*args, **kwargs):
            instance = original_worker(*args, **kwargs)
            instance.buffer.restore_last_ob.side_effect = RuntimeError('setup test')
            return instance
        monkeypatch.setattr(M, 'CollectorWorker', worker)
    with pytest.raises(RuntimeError):
        await M.run_worker(str(runtime.path), 'a' * 32, runtime.sockets, os.getpid())
    assert_clean(runtime)
