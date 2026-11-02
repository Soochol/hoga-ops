import datetime as dt
import json
import os
import subprocess
import sys
from dataclasses import asdict

import pytest

from hoga.api import (
    screener_daily_ingest as ingest,
    screener_daily_projection as projection,
    screener_series_runner as runner,
    screener_series_store as store,
    screener_series_values as values,
)
from tests.api.test_screener_daily_confirmation import confirmed, strict_spec
from tests.api.test_screener_recovery import DAYS, NOW, corpus as recovery_corpus, observation

corpus = recovery_corpus


def _normalized(value):
    if isinstance(value, dict):
        return {str(key): _normalized(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalized(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return sorted(_normalized(item) for item in value)
    if isinstance(value, dt.date):
        return value.isoformat()
    return value


def _result(data_dir, manifest):
    series = values.load_series(data_dir, manifest, ['005930'], first=DAYS[0], last=DAYS[-1])['005930']
    return _normalized({
        'confirmed': runner._confirmed_at(data_dir, manifest, ['005930'], NOW.date()),
        'contract': runner._daily_contract(data_dir, manifest, ['005930']),
        'observation': asdict(projection.read(data_dir, manifest, '005930')),
        'series': asdict(series),
        'quantities': {day: str(series.quantity(day, DAYS[-1], 'raw')) for day in DAYS},
        'amounts': {day: series.amount(day) for day in DAYS},
    })


@pytest.mark.parametrize('scenario', ['confirmed', 'legacy', 'unstable', 'conflict', 'quality', 'correction'])
def test_publication_is_queryable_after_restart_without_source_json(corpus, scenario):
    payload = observation(strict_spec().targets[0], NOW.date())
    payload['unadjusted'][1].update(volume=2**60 + 1, detail={'nested': [None, {'exact': 2**60 + 3}]})
    if scenario != 'legacy':
        payload = confirmed(payload)
    store.publish_pair(corpus, **payload)
    if scenario == 'conflict':
        payload['unadjusted'][0]['volume'] += 1
    if scenario == 'unstable':
        payload['confirmation']['first']['unadjusted'][0]['volume'] += 1
    elif scenario != 'legacy':
        payload = confirmed({key: value for key, value in payload.items() if key != 'confirmation'})
    store.publish_pair(corpus, **payload)
    if scenario == 'quality':
        ingest._publish(corpus, {
            'entries': {'005930:2018-05-04': {'code': '005930', 'date': '2018-05-04', 'status': 'provisional'}},
            'summary': {'commit_pending': True}, 'confirmed_through': {},
        })
    identity, manifest = store.load_snapshot(corpus)
    if scenario == 'correction':
        candidate = projection.read(corpus, manifest, '005930').candidate
        selected = candidate.unadjusted[1]
        review = {
            'kind': 'screener_correction_review', 'code': '005930', 'baseline': manifest['baseline'],
            'observation_id': manifest['observations']['005930'], 'candidate_id': candidate.identity,
            'accepted': [{'date': DAYS[1].isoformat(), 'selected': selected, 'preserved': dict(selected, volume=90)}],
        }
        identity = store.publish_correction_reviews(corpus, {'005930': review}, expected_snapshot=identity)
        _, manifest = store.load_snapshot(corpus)
    expected = _result(corpus, {key: value for key, value in manifest.items() if key != 'daily_query'})
    script = '''
import json
import sys
from pathlib import Path
from hoga.api import screener_series_store as store
from tests.api.test_screener_daily_query_publication import _result
root = Path(sys.argv[1])
_, manifest = store.load_snapshot(root, sys.argv[2])
header_id = manifest['daily_query']['headers']['005930']
header = store.read_object(root, header_id)
blocked = {store.root(root) / 'objects' / (source['identity'] + '.json') for source in header['sources']}
def audit(event, args):
    if event == 'open' and isinstance(args[0], (str, bytes)) and Path(args[0]) in blocked:
        raise AssertionError('published query reopened full source observation JSON')
sys.addaudithook(audit)
print(json.dumps(_result(root, manifest), sort_keys=True))
'''
    result = subprocess.run([sys.executable, '-c', script, str(corpus), identity],
                            capture_output=True, text=True, check=False, env={**os.environ, 'PYTHONPATH': os.getcwd()})
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == expected


def test_summary_reads_no_row_body_and_readers_never_publish(corpus, monkeypatch):
    from hoga.api import screener_daily_projection as projection, screener_snapshot_cache as cache

    store.publish_pair(corpus, **confirmed(observation(strict_spec().targets[0], NOW.date())))
    _, manifest = store.load_snapshot(corpus)
    cache.shared.clear()
    read = store._read_file

    def header_only(path, **kwargs):
        assert path.suffix != '.zlib', 'metadata query opened row body'
        return read(path, **kwargs)

    def forbidden(*args, **kwargs):
        raise AssertionError('query reader attempted publication')

    monkeypatch.setattr(store, '_read_file', header_only)
    monkeypatch.setattr(store, '_write_object', forbidden)
    monkeypatch.setattr(projection, '_write_body', forbidden)
    assert runner._confirmed_at(corpus, manifest, ['005930'], NOW.date()) is not None
    assert runner._daily_contract(corpus, manifest, ['005930'])['daily_confirmation_policy'] == 'historical_recheck_v1'


def test_corrupt_existing_source_cannot_be_attested_from_incoming_values(corpus):
    import json

    import pytest

    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    source = store.pair_value(**payload)
    folder = store.root(corpus) / 'objects'
    folder.mkdir(parents=True)
    path = folder / (store.digest(source) + '.json')
    path.write_text(json.dumps({**source, 'corrupt': True}))
    with pytest.raises(ValueError, match='checksum mismatch'):
        store.publish_pair(corpus, **payload)
    assert not (store.root(corpus) / 'current.json').exists()
