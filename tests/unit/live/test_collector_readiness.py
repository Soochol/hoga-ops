"""Control/configuration delays must not masquerade as WS disconnections."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hoga.live import collector_process as cp, lifecycle
from hoga.live.collector_ipc import encode
from hoga.live.collector_process import CaptureProcessSession
from hoga.live.service_status import provider_status


@pytest.fixture
def owner(tmp_path, monkeypatch):
    clock = SimpleNamespace(value=100.0)
    monkeypatch.setattr(cp, 'time', SimpleNamespace(monotonic=lambda: clock.value, time=lambda: clock.value))
    manager = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    manager.process = SimpleNamespace(pid=1, is_alive=lambda: True)
    manager.peer = SimpleNamespace(closed=asyncio.Event())
    manager.epoch = 'current'
    manager.version = manager.ack_version = 1
    manager._received_at = clock.value
    manager._state = {
        'epoch': manager.epoch, 'desired_version': 1, 'ready': True, 'observed_at_ms': 100_000,
        'status': {'enabled': True, 'accounts_configured': 1, 'connected_accounts': 1,
                   'subscribed_count': 1, 'subscribed_codes': ['005930'], 'ready_codes': ['005930'],
                   'ready_registrations': ['005930:KRX'], 'connection_allowed': True,
                   'last_tick_ms': 100_000, 'last_recv_ms': 100_000, 'registration_incomplete': False,
                   'accounts': [{'account_id': 0, 'connected': True, 'connection_generation': 7,
                                 'registration_ready': True, 'last_recv_ms': 100_000, 'kicked_by_peer': False}]},
    }
    monkeypatch.setattr(lifecycle, '_state', lifecycle._State(kiwoom_session=manager))
    return manager, clock


async def test_sync_ack_and_state_are_separate_from_connection(owner, monkeypatch, tmp_path):
    manager, _ = owner
    entered, release = asyncio.Event(), asyncio.Event()

    async def call(method, config):
        assert method == 'sync'
        entered.set()
        await release.wait()
        return {'version': config['version']}

    manager.peer.call = call
    monkeypatch.setattr(manager, '_configuration', AsyncMock(return_value={'targets': ['005930']}))
    monkeypatch.setattr(manager, '_start', AsyncMock())
    request = asyncio.create_task(manager.sync(('005930',), n_accounts=1))
    try:
        await entered.wait()
        for stage in ('ack', 'state'):
            status = lifecycle.get_status()
            assert status.ws_connected and status.running and not status.capture_healthy
            assert status.capture_reason == 'syncing'
            assert status.kiwoom['collector']['sync_phase'] == stage
            assert status.kiwoom['accounts'][0]['connection_generation'] == 7
            assert not status.kiwoom['accounts'][0]['registration_ready']
            assert status.kiwoom['ready_registrations'] == []
            provider = provider_status(tmp_path, status.kiwoom, 100_000)
            assert provider.connected_accounts == 1 and provider.ready_accounts == 0
            assert provider.connection == 'partial'
            release.set()
            await request
        manager._state['desired_version'] = manager.version
        manager._finish_sync()
        assert lifecycle.get_status().capture_reason == 'healthy'
        assert manager.status()['collector']['sync_phase'] is None
    finally:
        request.cancel()
        await asyncio.gather(request, return_exceptions=True)


@pytest.mark.parametrize('fault', ['dead', 'ipc_closed', 'state_stale', 'old_epoch', 'storage_error'])
def test_faults_are_not_hidden_by_sync(owner, fault):
    manager, clock = owner
    manager.version = 2
    manager._sync_started_at = clock.value
    if fault == 'dead':
        manager.process.is_alive = lambda: False
    elif fault == 'ipc_closed':
        manager.peer.closed.set()
    elif fault == 'state_stale':
        clock.value += 10
    elif fault == 'old_epoch':
        manager._state['epoch'] = 'previous'
    else:
        manager._state['storage_errors'] = ['append_failed']
    status = lifecycle.get_status()
    assert not status.capture_healthy
    assert status.capture_reason == ('storage_error' if fault == 'storage_error' else 'collector_unavailable')
    assert status.ws_connected == (fault == 'storage_error')


@pytest.mark.parametrize('stage,limit', [('ack', 30), ('state', 10)])
def test_sync_deadlines_expire_despite_continuing_status_reports(owner, stage, limit):
    manager, clock = owner
    manager.version = 2
    manager._sync_started_at = clock.value
    if stage == 'state':
        manager.ack_version = 2
        manager._sync_acked_at = clock.value
    clock.value += limit
    manager._received_at = clock.value
    manager._state['observed_at_ms'] = int(clock.value * 1000)
    assert manager.status()['collector']['state_reason'] == 'sync_failed'
    assert lifecycle.get_status().capture_reason == 'collector_unavailable'


def test_actual_disconnect_during_sync_is_offline(owner):
    manager, clock = owner
    manager.version = 2
    manager._sync_started_at = clock.value
    manager._state['status']['connected_accounts'] = 0
    assert lifecycle.get_status().capture_reason == 'offline'


async def test_cancelled_sync_does_not_hide_failure_or_skip_retry(owner, monkeypatch):
    manager, _ = owner
    entered = asyncio.Event()

    async def pending(method, config):
        entered.set()
        await asyncio.Event().wait()

    manager.peer.call = pending
    config = {'targets': ['005930']}
    monkeypatch.setattr(manager, '_configuration', AsyncMock(return_value=config))
    monkeypatch.setattr(manager, '_start', AsyncMock())
    task = asyncio.create_task(manager.sync(('005930',), n_accounts=1))
    await entered.wait()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert lifecycle.get_status().capture_reason == 'collector_unavailable'
    # Even an ACKed version must retry after a failed control operation.
    manager.ack_version = manager.version
    manager.peer.call = AsyncMock(side_effect=lambda method, args: {'version': args['version']})
    await manager.sync(('005930',), n_accounts=1)
    manager.peer.call.assert_awaited_once()


async def test_previous_config_state_updates_transport_but_not_peaks(owner):
    manager, _ = owner
    manager.version = 2
    manager._sync_started_at = 100
    manager._peaks = {'preserved': True}
    reader = asyncio.StreamReader()
    state = {**manager._state, 'sequence': 1, 'peaks': {'old': True}}
    state['status'] = {**state['status'], 'connected_accounts': 0}
    reader.feed_data(encode(state))
    reader.feed_eof()
    with pytest.raises(asyncio.IncompleteReadError):
        await manager._states(reader, manager.epoch)
    assert manager._peaks == {'preserved': True}
    assert lifecycle.get_status().capture_reason == 'offline'
