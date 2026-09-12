from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hoga.live import maintenance_recovery as recovery
from hoga.live.service_status import DEFAULT_NOTICE, provider_status


@pytest.fixture
def probe(tmp_path, monkeypatch):
    recovery._attempts.clear()
    recovery._inflight.clear()
    monkeypatch.setattr(recovery.time, 'time', lambda: DEFAULT_NOTICE.ends_at_ms / 1000 + 10)
    monkeypatch.setattr(recovery.kiwoom_rest_runtime, 'ensure_rest_clients', lambda _: [object()])
    monkeypatch.setattr(recovery.kiwoom_rest_runtime, 'ensure_scheduler', lambda _: object())
    call = AsyncMock(return_value=SimpleNamespace(rows=[{'cur_prc': '70000'}]))
    monkeypatch.setattr(recovery.kiwoom_access, 'run_with_capacity', call)
    return call


def paused_status(tmp_path):
    return provider_status(tmp_path, {
        'enabled': True, 'accounts_configured': 5, 'connected_accounts': 0, 'accounts': [],
    }, DEFAULT_NOTICE.ends_at_ms + 20_000, ws_expected=False)


async def test_weekend_rest_recovery_clears_notice_without_ws(tmp_path, probe):
    assert paused_status(tmp_path).notice_phase == 'overdue'
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    status = paused_status(tmp_path)
    assert status.connection == 'paused'
    assert status.notice is None
    assert (tmp_path / 'kiwoom-maintenance-recovered.json').exists()
    # Reading again (including after process restart) uses the persistent evidence.
    recovery._attempts.clear()
    assert paused_status(tmp_path).notice is None


async def test_failure_retries_once_per_minute_without_false_recovery(tmp_path, probe, monkeypatch):
    probe.side_effect = TimeoutError()
    monkeypatch.setattr(recovery.time, 'monotonic', lambda: 100)
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    assert probe.await_count == 1
    assert paused_status(tmp_path).notice_phase == 'overdue'
    monkeypatch.setattr(recovery.time, 'monotonic', lambda: 161)
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    assert probe.await_count == 2


async def test_empty_response_and_changed_notice_do_not_confirm_recovery(tmp_path, probe):
    probe.return_value = SimpleNamespace(rows=[])
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    assert paused_status(tmp_path).notice_phase == 'overdue'
    recovery._attempts.clear()
    probe.return_value = SimpleNamespace(rows=[{'cur_prc': '70000'}])
    (tmp_path / 'kiwoom-maintenance.json').write_text('null')
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    assert not (tmp_path / 'kiwoom-maintenance-recovered.json').exists()


async def test_no_probe_before_end_or_without_credentials(tmp_path, probe, monkeypatch):
    monkeypatch.setattr(recovery.time, 'time', lambda: DEFAULT_NOTICE.starts_at_ms / 1000)
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    probe.assert_not_called()
    monkeypatch.setattr(recovery.time, 'time', lambda: DEFAULT_NOTICE.ends_at_ms / 1000 + 1)
    monkeypatch.setattr(recovery.kiwoom_rest_runtime, 'ensure_rest_clients', lambda _: [])
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    probe.assert_not_called()


async def test_concurrent_status_polls_share_one_probe(tmp_path, probe):
    import asyncio

    entered, release = asyncio.Event(), asyncio.Event()

    async def response(*args, **kwargs):
        entered.set()
        await release.wait()
        return SimpleNamespace(rows=[{'cur_prc': '70000'}])

    probe.side_effect = response
    first = asyncio.create_task(recovery.check_recovery(tmp_path, DEFAULT_NOTICE))
    await entered.wait()
    await recovery.check_recovery(tmp_path, DEFAULT_NOTICE)
    assert probe.await_count == 1
    release.set()
    await first
    assert paused_status(tmp_path).notice is None
