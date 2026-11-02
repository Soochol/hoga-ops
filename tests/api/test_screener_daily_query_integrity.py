import copy
import json
import os
import zlib

import pytest

from hoga.api import (
    screener_daily_projection as projection,
    screener_series_store as store,
    screener_snapshot_cache as cache,
)
from tests.api.test_screener_daily_confirmation import confirmed, strict_spec
from tests.api.test_screener_recovery import NOW, corpus as recovery_corpus, observation

corpus = recovery_corpus


def publish(corpus, *, merged=False):
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    store.publish_pair(corpus, **payload)
    if merged:
        store.publish_pair(corpus, **payload)
    _, manifest = store.load_snapshot(corpus)
    cache.shared.clear()
    return manifest


def header(corpus, manifest):
    identity = manifest['daily_query']['headers']['005930']
    return store.read_object(corpus, identity)


def rebind(corpus, manifest, value):
    result = copy.deepcopy(manifest)
    identity = store._write_object(store.root(corpus), value)
    result['daily_query']['headers']['005930'] = identity
    return result


@pytest.mark.parametrize('damage', ['header_bytes', 'header_delete', 'body_bytes', 'body_delete', 'body_truncate',
                                   'schema', 'verifier', 'binding', 'candidate', 'decoded_length', 'body_schema',
                                   'trailing_body', 'compressed_limit', 'decoded_limit'])
def test_invalid_compact_uses_fully_verified_sources(corpus, monkeypatch, caplog, damage):
    manifest = publish(corpus)
    expected = projection.read(corpus, manifest, '005930')
    value = header(corpus, manifest)
    cache.shared.clear()
    header_path = projection._source_path(corpus, manifest['daily_query']['headers']['005930'])
    body_path = projection._body_path(corpus, value['body_id'])
    file_damage = {
        'header_bytes': lambda: header_path.write_text('{}'),
        'header_delete': header_path.unlink,
        'body_bytes': lambda: body_path.write_bytes(b'broken'),
        'body_delete': body_path.unlink,
        'body_truncate': lambda: body_path.write_bytes(body_path.read_bytes()[:-2]),
    }
    header_damage = {
        'schema': ('extra', 1), 'verifier': ('verifier', 'not_supported'),
        'binding': ('observation_id', '0' * 64), 'candidate': ('candidate_id', '0' * 64),
        'decoded_length': ('decoded_bytes', value['decoded_bytes'] + 1),
    }
    if damage in file_damage:
        file_damage[damage]()
    elif damage in header_damage:
        key, changed = header_damage[damage]
        value[key] = changed
    elif damage in {'body_schema', 'trailing_body'}:
        encoded = json.loads(zlib.decompress(body_path.read_bytes()))
        if damage == 'body_schema':
            encoded['candidate']['confirmed_dates'] = 'wrong'
        raw = json.dumps(encoded).encode()
        packed = zlib.compress(raw) + (b'garbage' if damage == 'trailing_body' else b'')
        value['body_id'] = projection._write_body(corpus, packed)
        value['compressed_bytes'] = len(packed)
        value['decoded_bytes'] = len(raw)
    elif damage == 'compressed_limit':
        monkeypatch.setattr(projection, 'MAX_COMPRESSED_BYTES', 1)
    elif damage == 'decoded_limit':
        monkeypatch.setattr(projection, 'MAX_DECODED_BYTES', 1)
    if damage not in {'header_bytes', 'header_delete', 'body_bytes', 'body_delete', 'body_truncate',
                      'compressed_limit', 'decoded_limit'}:
        manifest = rebind(corpus, manifest, value)
    calls = []
    read = store.read_object

    def checked(data_dir, identity, **kwargs):
        calls.append(identity)
        return read(data_dir, identity, **kwargs)

    monkeypatch.setattr(store, 'read_object', checked)
    assert projection.read(corpus, manifest, '005930') == expected
    assert manifest['observations']['005930'] in calls
    assert 'daily_query.verified_fallback' in caplog.text


@pytest.mark.parametrize('damage', ['tamper_same_size_mtime', 'delete', 'truncate', 'replace_identical'])
@pytest.mark.parametrize('target', ['observation', 'candidate'])
def test_raw_closure_invalidates_outer_cache(corpus, damage, target):
    manifest = publish(corpus, merged=True)
    value = header(corpus, manifest)
    identity = value['observation_id'] if target == 'observation' else value['candidate_id']
    path = projection._source_path(corpus, identity)
    key = (str(corpus), 'outer')
    def load():
        return projection.read(corpus, manifest, '005930')

    expected = cache.shared.obtain(key, load)
    if damage == 'delete':
        path.unlink()
        exception = FileNotFoundError
    elif damage == 'truncate':
        path.write_bytes(path.read_bytes()[:-4])
        exception = ValueError
    elif damage == 'replace_identical':
        replacement = path.with_suffix('.replacement')
        replacement.write_bytes(path.read_bytes())
        replacement.replace(path)
        assert cache.shared.obtain(key, load) == expected
        return
    else:
        stamp = path.stat()
        raw = path.read_bytes()
        changed = raw.replace(b'"volume": 100', b'"volume": 101', 1)
        assert changed != raw and len(changed) == len(raw)
        path.write_bytes(changed)
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        exception = ValueError
    with pytest.raises(exception):
        cache.shared.obtain(key, load)


@pytest.mark.parametrize('target', ['raw', 'header', 'body'])
def test_mutation_during_compact_read_cannot_return_unverified_facts(corpus, monkeypatch, target):
    manifest = publish(corpus)
    expected = projection.read(corpus, manifest, '005930')
    value = header(corpus, manifest)
    raw_path = projection._source_path(corpus, value['observation_id'])
    header_path = projection._source_path(corpus, manifest['daily_query']['headers']['005930'])
    body_path = projection._body_path(corpus, value['body_id'])
    target_path = {'raw': raw_path, 'header': header_path, 'body': body_path}[target]
    cache.shared.clear()
    file_read = store._read_file
    changed, source_reads = [], []
    source_read = store.read_object

    def mutate(path, **kwargs):
        result = file_read(path, **kwargs)
        if path == body_path and not changed:
            target_path.write_bytes(b'corrupt')
            changed.append(True)
        return result

    def checked(data_dir, identity, **kwargs):
        source_reads.append(identity)
        return source_read(data_dir, identity, **kwargs)

    monkeypatch.setattr(store, '_read_file', mutate)
    monkeypatch.setattr(store, 'read_object', checked)
    with pytest.raises(ValueError):
        projection.read(corpus, manifest, '005930')
    assert source_reads == [value['observation_id']]
    if target != 'raw':
        assert projection.read(corpus, manifest, '005930') == expected


def test_legacy_none_empty_and_candidate_vs_merged_masks_survive_codec(corpus):
    payload = observation(strict_spec().targets[0], NOW.date())
    store.publish_pair(corpus, **payload)
    _, legacy = store.load_snapshot(corpus)
    facts = projection.read(corpus, legacy, '005930')
    assert facts.candidate.confirmed_dates is None
    daily = projection.summary(corpus, legacy, '005930')
    assert daily.confirmed_at_or_before(NOW.date(), required=True) is None
    assert daily.confirmed_at_or_before(NOW.date(), required=False) is not None
    payload = confirmed(payload)
    payload['confirmation']['first']['unadjusted'][0]['volume'] += 1
    store.publish_pair(corpus, **payload)
    _, checked = store.load_snapshot(corpus)
    facts = projection.read(corpus, checked, '005930')
    assert facts.candidate.confirmed_dates == set()
    assert projection.summary(corpus, checked, '005930').confirmed_at_or_before(NOW.date(), required=False) is None


def test_recursive_candidate_cycle_is_rejected(tmp_path, monkeypatch):
    identity = '1' * 64
    path = projection._source_path(tmp_path, identity)
    path.parent.mkdir(parents=True)
    path.write_text('{}')
    monkeypatch.setattr(store, 'read_object', lambda *a, **kw: {'candidate_observation': identity})
    with pytest.raises(ValueError, match='Cyclic'):
        projection.read(tmp_path, {'observations': {'005930': identity}}, '005930')


def test_verified_legacy_rows_decode_with_their_exact_length_bound(corpus, monkeypatch):
    manifest = publish(corpus)
    manifest = {key: value for key, value in manifest.items() if key != 'daily_query'}
    calls = []
    decompress = projection._decompress

    def bounded(packed, **kwargs):
        calls.append((kwargs['maximum'], kwargs['decoded_bytes']))
        assert kwargs['maximum'] == kwargs['decoded_bytes'] > 0
        return decompress(packed, **kwargs)

    monkeypatch.setattr(projection, '_decompress', bounded)
    assert projection.read(corpus, manifest, '005930') is not None
    assert len(calls) == 1


def test_derived_writer_cannot_accept_an_original_path(corpus):
    manifest = publish(corpus)
    original = projection._source_path(corpus, manifest['observations']['005930'])
    expected = original.read_bytes()
    with pytest.raises(TypeError):
        projection._write_query_file(corpus, original)
    assert original.read_bytes() == expected


@pytest.mark.parametrize('query', [None, [], 'unsupported', {'format': projection.FORMAT},
    {'format': projection.FORMAT, 'verifier': projection.VERIFIER, 'headers': None},
    {'format': projection.FORMAT, 'verifier': projection.VERIFIER, 'headers': []},
    *({'format': projection.FORMAT, 'verifier': projection.VERIFIER, 'headers': {'005930': ref}}
      for ref in [None, [], 1, '../bad', 'g' * 64])])
def test_malformed_optional_query_reference_uses_checked_sources(corpus, monkeypatch, query):
    manifest = publish(corpus)
    expected = projection.read(corpus, manifest, '005930')
    malformed = {**manifest, 'daily_query': query}
    calls = []
    read = store.read_object

    def checked(data_dir, identity, **kwargs):
        calls.append(identity)
        return read(data_dir, identity, **kwargs)

    monkeypatch.setattr(store, 'read_object', checked)
    assert projection.summary(corpus, malformed, '005930') is not None
    assert projection.read(corpus, malformed, '005930') == expected
    assert manifest['observations']['005930'] in calls


@pytest.mark.parametrize('warm', [False, True])
@pytest.mark.parametrize('ready', [False, True])
def test_original_change_during_final_decode_is_rejected(corpus, monkeypatch, warm, ready):
    manifest = publish(corpus)
    if not ready:
        manifest.pop('daily_query')
    if warm:
        projection.read(corpus, manifest, '005930')
    source = projection._source_path(corpus, manifest['observations']['005930'])
    decompress = projection._decompress
    changed = []

    def change_after_decode(packed, **kwargs):
        result = decompress(packed, **kwargs)
        if kwargs['maximum'] == kwargs['decoded_bytes']:
            source.write_text('{}')
            changed.append(True)
        return result

    monkeypatch.setattr(projection, '_decompress', change_after_decode)
    with pytest.raises(ValueError, match='changed'):
        projection.read(corpus, manifest, '005930')
    assert changed == [True]
