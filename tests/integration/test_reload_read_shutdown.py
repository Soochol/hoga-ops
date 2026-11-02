"""The production runner retires real app readers before a file-triggered reload."""
from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

APP_SOURCE = '''
import asyncio
import json
import os
import threading
import time
from pathlib import Path
from hoga.api.app import create_app as real_app
from hoga.api import screener_runner
from hoga.api.models import ScreenerResponse
from hoga.api.screener_history_jobs import _finish_disk_write
from hoga.live.screener_volume import ScreenerVolumeRuntime

root = Path(os.environ['PROBE_ROOT'])
lock = threading.Lock()
def mark(event):
    with lock, (root / f'events.{os.getpid()}.jsonl').open('a') as out:
        out.write(json.dumps({'event':event,'at':time.monotonic(),'pid':os.getpid()})+'\\n')

async def scan(*, operation, **kwargs):
    def read():
        mark('work_started')
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if os.environ['PROBE_MODE'] == 'cooperative': operation.checkpoint()
                if (root / f'release.{os.getpid()}').exists(): return
                time.sleep(0.01)
            raise TimeoutError('driver did not release read')
        finally:
            mark('work_exited')
    await operation.run_sync(read)
    return ScreenerResponse(status='ok', rows=[])

def publication():
    mark('write_started')
    deadline=time.monotonic()+10
    while not (root / 'write.release').exists():
        if time.monotonic() >= deadline: raise TimeoutError('write not released')
        time.sleep(0.01)
    path=root / 'committed.json'
    staged=path.with_suffix('.tmp')
    staged.write_text(json.dumps({'complete':True}))
    staged.replace(path)
    mark('write_committed')

def create_app():
    mark('factory')
    screener_runner.run_screener_scan=scan
    original=ScreenerVolumeRuntime.close
    def close(self):
        events=[json.loads(line)['event'] for line in
                (root / f'events.{os.getpid()}.jsonl').read_text().splitlines()]
        if 'work_started' in events: assert 'work_exited' in events
        mark('volume_closed')
        return original(self)
    ScreenerVolumeRuntime.close=close
    app=real_app(Path(os.environ['HOGA_DATA_DIR']))
    @app.get('/probe')
    async def probe(): return {'pid':os.getpid()}
    @app.post('/protected')
    async def protected():
        await _finish_disk_write(publication)
        return {'complete':True}
    return app
'''


async def until(check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        await asyncio.sleep(0.02)
    raise TimeoutError('isolated reload did not finish')


def events(root, pid):
    path = root / f'events.{pid}.jsonl'
    return [json.loads(line)['event'] for line in path.read_text().splitlines()] if path.exists() else []


async def ready(client, old=None):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            response = await client.get('/probe', timeout=0.5)
            if response.is_success and response.json()['pid'] != old:
                health = await client.get('/health', timeout=0.5)
                if health.is_success and health.json()['status'] == 'ok':
                    return response.json()['pid']
        except httpx.HTTPError:
            pass
        await asyncio.sleep(0.05)
    raise TimeoutError('new API did not become ready')


def sandbox_env(root, mode):
    repo = Path(__file__).resolve().parents[2]
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG') if key in os.environ}
    env.update(PYTHONPATH=os.pathsep.join((str(repo), str(root))), PROBE_ROOT=str(root), PROBE_MODE=mode,
        HOGA_DATA_DIR=str(root / 'data'), HOGA_LOG_DIR=str(root / 'logs'), XDG_DATA_HOME=str(root / 'xdg'),
        HOGA_LIVE_STARTUP_ENABLED='false', HOGA_LIVE_TODAY_PROMOTE_ENABLED='false',
        HOGA_ENABLE_TEST_ENDPOINTS='1', HOGA_STARTUP_CATCHUP_ENABLED='false')
    return env


async def exercise_generation(client, root, source, pid, *, protected):
    reader = asyncio.create_task(client.post('/api/screener/scan', json={'conditions': []}))
    await until(lambda: 'work_started' in events(root, pid))
    writer = None
    if protected:
        writer = asyncio.create_task(client.post('/protected'))
        await until(lambda: 'write_started' in events(root, pid))
    source.write_text(APP_SOURCE + f'\n# generation {pid}\n')
    response = await reader
    assert response.status_code == httpx.codes.SERVICE_UNAVAILABLE, response.text
    assert '다시 시작' in response.json()['detail']
    if protected:
        assert 'write_committed' not in events(root, pid)
        (root / 'write.release').touch()
        assert (await writer).json() == {'complete': True}
        assert json.loads((root / 'committed.json').read_text()) == {'complete': True}
    (root / f'release.{pid}').touch()
    new_pid = await ready(client, pid)
    old = events(root, pid)
    assert old.index('work_exited') < old.index('volume_closed')
    if protected:
        assert old.index('write_committed') < old.index('volume_closed')
    assert not Path(f'/proc/{pid}').exists()
    return new_pid


@pytest.mark.skipif(sys.platform != 'linux', reason='POSIX reload subprocess lifecycle')
@pytest.mark.parametrize('mode', ['cooperative', 'noncooperative'])
async def test_actual_app_file_reload_drains_reads_and_preserves_publication(tmp_path, mode):
    source = tmp_path / 'reload_app.py'
    source.write_text(APP_SOURCE)
    (tmp_path / '.env').touch()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    script = ('from hoga.server import run_server; from pathlib import Path; '
              f'run_server(host="127.0.0.1",port={port},reload=True,reload_dirs=[Path(".")],'
              'app="reload_app:create_app")')
    process = subprocess.Popen([sys.executable, '-c', script], cwd=tmp_path, env=sandbox_env(tmp_path, mode),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    collected = asyncio.create_task(asyncio.to_thread(process.communicate))
    output = ''
    try:
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', timeout=20, trust_env=False) as client:
            pid = await ready(client)
            assert pid != process.pid
            for iteration in range(5):
                pid = await exercise_generation(client, tmp_path, source, pid, protected=iteration == 0)
    finally:
        process.send_signal(signal.SIGTERM)
        try:
            output, _ = await asyncio.wait_for(asyncio.shield(collected), timeout=30)
        except TimeoutError:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = await collected
            pytest.fail('test subprocess did not stop normally\n' + output[-5000:])
    assert process.returncode == 0, output[-5000:]
    assert 'read_retirement_unavailable' not in output, output[-5000:]
    assert 'resource_tracker:' not in output, output[-5000:]
    assert 'Traceback' not in output, output[-5000:]
    assert output.count('WatchFiles detected changes') == 5, output[-5000:]
    assert output.count('Application shutdown complete.') == 6, output[-5000:]
