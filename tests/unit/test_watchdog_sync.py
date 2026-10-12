"""Run the deployment watchdog with fake HTTP and systemd commands."""
import json
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy' / 'hoga-ops-watchdog.sh'


def health():
    return {'status': 'degraded', 'dead_tasks': [], 'queue': {'ready': True, 'disabled_by_env': False},
            'collector': {'state_reason': 'syncing', 'alive': True, 'ready': False,
                          'error': None, 'storage_errors': [], 'state_age_ms': 800}}


def run(tmp_path, first, second):
    commands = tmp_path / 'commands'
    commands.mkdir()
    (tmp_path / 'first').write_text(first + '\n503')
    (tmp_path / 'second').write_text(second)
    for name, source in {
        'curl': ('#!/bin/sh\nif [ -f "$TEST_ROOT/called" ]; then cat "$TEST_ROOT/second"; '
                 'else touch "$TEST_ROOT/called"; cat "$TEST_ROOT/first"; fi\n'
                 'echo curl >> "$TEST_ROOT/actions"\n'),
        'sleep': '#!/bin/sh\necho sleep >> "$TEST_ROOT/actions"\n',
        'systemctl': '#!/bin/sh\necho "$*" >> "$TEST_ROOT/actions"\nexit 0\n',
    }.items():
        file = commands / name
        file.write_text(source)
        file.chmod(0o755)
    result = subprocess.run(['bash', str(SCRIPT)], env={**os.environ, 'PATH': f'{commands}:{os.environ["PATH"]}',
                            'TEST_ROOT': str(tmp_path), 'XDG_STATE_HOME': str(tmp_path)},
                            capture_output=True, text=True, check=False)
    return result, (tmp_path / 'actions').read_text()


def test_sync_recovers_without_restart(tmp_path):
    result, actions = run(tmp_path, json.dumps(health()), '{}\n200')
    assert result.returncode == 0
    assert actions.count('curl') == 2
    assert 'restart' not in actions
    assert 'recheck HTTP 200' in result.stderr


def test_sync_stays_unhealthy_and_restarts_once(tmp_path):
    result, actions = run(tmp_path, json.dumps(health()), json.dumps(health()) + '\n503')
    assert result.returncode == 0
    assert actions.count('curl') == 2
    assert actions.count('restart hoga-ops') == 1
    assert (tmp_path / 'hoga-ops/watchdog-restarts.log').exists()


@pytest.mark.parametrize('fault', ['task', 'queue', 'storage', 'stale', 'failed', 'malformed'])
def test_other_failures_cannot_use_sync_exception(tmp_path, fault):
    value = health()
    if fault == 'task':
        value['dead_tasks'] = ['worker']
    elif fault == 'queue':
        value['queue']['ready'] = False
    elif fault == 'storage':
        value['collector']['storage_errors'] = ['append_failed']
    elif fault == 'stale':
        value['collector']['state_age_ms'] = 10_000
    elif fault == 'failed':
        value['collector']['state_reason'] = 'sync_failed'
    first = '{' if fault == 'malformed' else json.dumps(value)
    result, actions = run(tmp_path, first, '{}\n200')
    assert result.returncode == 0
    assert actions.count('curl') == 1
    assert actions.count('restart hoga-ops') == 1
