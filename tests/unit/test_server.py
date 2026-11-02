import asyncio
import logging
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
import uvicorn
from fastapi import FastAPI
from typer.testing import CliRunner

from hoga import server
from hoga.api.read_shutdown import STATE_KEY, ReadInterrupted, ReadShutdown, ReadWork


@pytest.fixture(autouse=True)
def capture_logs(monkeypatch):
    monkeypatch.setattr(server, 'log', logging.getLogger('hoga.server.tests'))


@pytest.mark.parametrize('state', [{}, {STATE_KEY: object()}, None])
async def test_missing_or_invalid_state_preserves_ordinary_drain(monkeypatch, state, caplog):
    calls = []

    async def ordinary(_server):
        calls.append('ordinary')

    monkeypatch.setattr(uvicorn.Server, '_wait_tasks_to_complete', ordinary)
    instance = server.ReadDrainServer(uvicorn.Config('unused:factory'))
    instance.lifespan = SimpleNamespace(state=state)
    await instance._wait_tasks_to_complete()
    assert calls == ['ordinary']
    assert 'ordinary drain continues' in caplog.text


async def test_boundary_begins_before_ordinary_drain_once(monkeypatch):
    calls = []
    reads = ReadShutdown()

    class Owner:
        def begin_read_shutdown(self):
            calls.append('read retired')

    reads.register(Owner())

    async def ordinary(_server):
        calls.append('ordinary')

    monkeypatch.setattr(uvicorn.Server, '_wait_tasks_to_complete', ordinary)
    instance = server.ReadDrainServer(uvicorn.Config('unused:factory'))
    instance.lifespan = SimpleNamespace(state={STATE_KEY: reads})
    await instance._wait_tasks_to_complete()
    await instance._wait_tasks_to_complete()
    assert calls == ['read retired', 'ordinary', 'ordinary']


def test_unsupported_version_uses_standard_server(monkeypatch, caplog):
    calls = []

    class Standard:
        started = True

        def __init__(self, config):
            assert config.workers == 1

        def run(self):
            calls.append('ordinary')

    monkeypatch.setattr(uvicorn, '__version__', 'unsupported')
    monkeypatch.setattr(uvicorn, 'Server', Standard)
    server.run_server(host='127.0.0.1', port=0)
    assert calls == ['ordinary']
    assert 'read_retirement_unsupported' in caplog.text


def test_startup_failure_remains_a_nonzero_exit(monkeypatch):
    monkeypatch.setattr(server.ReadDrainServer, 'run', lambda self: None)
    with pytest.raises(SystemExit) as error:
        server.run_server(host='127.0.0.1', port=0)
    assert error.value.code == server.STARTUP_FAILURE


def test_cli_has_one_runner_for_reload_and_nonreload(monkeypatch):
    from hoga import cli

    calls = []
    monkeypatch.setattr(cli, 'load_env', lambda: None)
    monkeypatch.setattr(cli, 'run_server', lambda **kwargs: calls.append(kwargs))
    runner = CliRunner()
    assert runner.invoke(cli.app, ['serve', '--port', '8123']).exit_code == 0
    assert runner.invoke(cli.app, ['serve', '--port', '8124', '--reload', '--reload-dir', 'hoga']).exit_code == 0
    assert calls[0] == {'host': '127.0.0.1', 'port': 8123, 'reload': False, 'reload_dirs': []}
    assert calls[1]['reload'] is True
    assert [str(path) for path in calls[1]['reload_dirs']] == ['hoga']


@pytest.mark.parametrize('lifespan_mode', ['on', 'off'])
async def test_real_server_should_exit_without_signal(lifespan_mode, caplog):
    reads, work = ReadShutdown(), ReadWork()
    reads.register(work)
    entered = asyncio.Event()
    closed = []

    async def query(_operation):
        entered.set()
        await asyncio.Event().wait()

    @asynccontextmanager
    async def lifespan(_app):
        yield {STATE_KEY: reads}
        await reads.wait_finished()
        closed.append(True)

    instance = server.ReadDrainServer(uvicorn.Config(
        FastAPI(lifespan=lifespan), host='127.0.0.1', port=0, lifespan=lifespan_mode))
    serving = asyncio.create_task(instance.serve())
    flight = None
    try:
        async with asyncio.timeout(5):
            while not instance.started:
                await asyncio.sleep(0.01)
        if lifespan_mode == 'on':
            flight = work.start(query)
            await entered.wait()
        instance.should_exit = True
        await asyncio.wait_for(serving, 5)
        if flight is not None:
            with pytest.raises(ReadInterrupted):
                await flight.result()
            assert closed == [True]
        else:
            assert not closed
            assert 'ordinary drain continues' in caplog.text
    finally:
        instance.should_exit = True
        await serving
