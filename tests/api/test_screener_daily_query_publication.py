import os
import subprocess
import sys

from hoga.api import screener_series_runner as runner, screener_series_store as store
from tests.api.test_screener_daily_confirmation import confirmed, strict_spec
from tests.api.test_screener_recovery import DAYS, NOW, corpus as recovery_corpus, observation

corpus = recovery_corpus


def test_publication_is_queryable_after_restart_without_source_json(corpus):
    store.publish_pair(corpus, **confirmed(observation(strict_spec().targets[0], NOW.date())))
    identity, manifest = store.load_snapshot(corpus)
    expected = runner._confirmed_at(corpus, manifest, ['005930'], NOW.date())
    script = '''
import datetime as dt
import json
import sys
from pathlib import Path
from hoga.api import screener_series_store as store, screener_series_runner as runner, screener_series_values as values
root = Path(sys.argv[1])
_, manifest = store.load_snapshot(root, sys.argv[2])
blocked = {store.root(root) / 'objects' / (key + '.json') for key in manifest['observations'].values()}
def audit(event, args):
    if event == 'open' and isinstance(args[0], (str, bytes)) and Path(args[0]) in blocked:
        raise AssertionError('published query reopened full source observation JSON')
sys.addaudithook(audit)
assert runner._confirmed_at(root, manifest, ['005930'], dt.date(2018, 5, 8)) == int(sys.argv[3])
assert runner._daily_contract(root, manifest, ['005930'])['daily_confirmation_policy'] == 'closed_daily_two_observations_v1'
item = values.load_series(root, manifest, ['005930'], first=dt.date(2018, 5, 2), last=dt.date(2018, 5, 4))['005930']
print(json.dumps({str(day): row for day, row in item.prices.items()}, sort_keys=True))
'''
    result = subprocess.run([sys.executable, '-c', script, str(corpus), identity, str(expected)],
                            capture_output=True, text=True, env={**os.environ, 'PYTHONPATH': os.getcwd()})
    assert result.returncode == 0, result.stderr
    assert DAYS[0].isoformat() in result.stdout
