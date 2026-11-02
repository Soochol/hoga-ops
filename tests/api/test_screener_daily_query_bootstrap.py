import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest

from hoga.api import (
    screener_daily_ingest as ingest,
    screener_daily_projection as projection,
    screener_series_store as store,
    screener_snapshot_cache as cache,
)
from hoga.util.atomic_write import atomic_write_json
from tests.api.test_screener_daily_confirmation import confirmed, strict_spec
from tests.api.test_screener_daily_query_integrity import header, publish
from tests.api.test_screener_recovery import NOW, corpus as recovery_corpus, observation

corpus = recovery_corpus


def legacy_snapshot(corpus):
    ready = publish(corpus)
    legacy = {key: value for key, value in ready.items() if key != 'daily_query'}
    legacy['observations']['000660'] = '0' * 64  # Unselected sources are deliberately unavailable.
    identity = store._write_object(store.root(corpus), legacy)
    atomic_write_json(store.root(corpus) / 'current.json', {'id': identity})
    return identity, legacy


def test_bootstrap_selected_cohort_child_noop_and_old_pinned_fallback(corpus, monkeypatch):
    identity, original = legacy_snapshot(corpus)
    source_path = projection._source_path(corpus, original['observations']['005930'])
    source_bytes, source_stat = source_path.read_bytes(), source_path.stat()
    reads = []
    read = store.read_object

    def checked(data_dir, object_id, **kwargs):
        reads.append(object_id)
        return read(data_dir, object_id, **kwargs)

    monkeypatch.setattr(store, 'read_object', checked)
    report = projection.prepare_existing_query_data(corpus, expected_snapshot=identity, codes=['005930'])
    assert report['prepared'] == ['005930'] and report['oversized'] == [] and not report['no_op']
    new_id, current = store.load_snapshot(corpus)
    assert new_id == report['snapshot_id'] and current['parent'] == identity
    assert {k: v for k, v in current.items() if k not in {'parent', 'daily_query'}} == {
        k: v for k, v in original.items() if k != 'parent'
    }
    assert '0' * 64 not in reads
    assert source_path.read_bytes() == source_bytes and source_path.stat() == source_stat
    assert store.load_snapshot(corpus, identity)[1] == original
    cache.shared.clear()
    reads.clear()
    assert projection.read(corpus, current, '005930') == projection.read(corpus, original, '005930')
    assert reads == [original['observations']['005930']]
    second = projection.prepare_existing_query_data(corpus, expected_snapshot=identity, codes=['005930'])
    assert second['no_op'] and second['snapshot_id'] == new_id and second['reused'] == ['005930']
    assert second['compressed_bytes'] > 0 and second['decoded_bytes'] >= second['compressed_bytes']


def test_bootstrap_merges_compatible_metadata_and_rejects_changed_observation(corpus):
    identity, original = legacy_snapshot(corpus)
    updated = {**original, 'daily_contract_required': True, 'parent': identity, 'quantity': {'000660': '2' * 64}}
    other = store._write_object(store.root(corpus), updated)
    atomic_write_json(store.root(corpus) / 'current.json', {'id': other})
    report = projection.prepare_existing_query_data(corpus, expected_snapshot=identity, codes=['005930'])
    _, current = store.load_snapshot(corpus)
    assert current['quantity'] == updated['quantity'] and current['parent'] == other
    assert report['previous_snapshot'] == other
    changed = {**current, 'observations': {**current['observations'], '005930': '3' * 64}}
    changed_id = store._write_object(store.root(corpus), changed)
    atomic_write_json(store.root(corpus) / 'current.json', {'id': changed_id})
    with pytest.raises(ValueError, match='snapshot changed'):
        projection.prepare_existing_query_data(corpus, expected_snapshot=identity, codes=['005930'])
    assert store.load_snapshot(corpus)[0] == changed_id


@pytest.mark.parametrize('target', ['body', 'header'])
def test_explicit_bootstrap_repairs_only_exact_derived_artifact(corpus, target):
    manifest = publish(corpus)
    snapshot_id = store.load_snapshot(corpus)[0]
    value = header(corpus, manifest)
    path = (projection._body_path(corpus, value['body_id']) if target == 'body' else
            projection._source_path(corpus, manifest['daily_query']['headers']['005930']))
    expected = path.read_bytes()
    source = projection._source_path(corpus, manifest['observations']['005930'])
    original = source.read_bytes()
    path.write_bytes(b'corrupt derived only')
    with path.open('rb') as old_reader:
        report = projection.prepare_existing_query_data(corpus, expected_snapshot=snapshot_id, codes=['005930'])
        assert old_reader.read() == b'corrupt derived only'
    assert path.read_bytes() == expected and source.read_bytes() == original
    assert report['prepared'] == ['005930']
    second = projection.prepare_existing_query_data(corpus, expected_snapshot=report['snapshot_id'], codes=['005930'])
    assert second['no_op'] and second['reused'] == ['005930']


def test_bootstrap_never_repairs_corrupt_raw_source(corpus):
    snapshot_id, manifest = legacy_snapshot(corpus)
    path = projection._source_path(corpus, manifest['observations']['005930'])
    path.write_bytes(b'corrupt original')
    with pytest.raises(ValueError):
        projection.prepare_existing_query_data(corpus, expected_snapshot=snapshot_id, codes=['005930'])
    assert path.read_bytes() == b'corrupt original' and store.load_snapshot(corpus)[0] == snapshot_id


def test_oversize_reports_verified_fallback_without_a_ready_reference(corpus, monkeypatch):
    snapshot_id, manifest = legacy_snapshot(corpus)
    monkeypatch.setattr(projection, 'MAX_DECODED_BYTES', 1)
    report = projection.prepare_existing_query_data(corpus, expected_snapshot=snapshot_id, codes=['005930'])
    assert report['oversized'] == ['005930'] and report['prepared'] == []
    _, current = store.load_snapshot(corpus)
    assert '005930' not in current['daily_query']['headers']
    assert projection.read(corpus, current, '005930') == projection.read(corpus, manifest, '005930')


@pytest.mark.parametrize('boundary', ['source', 'body', 'header', 'snapshot', 'before_pointer', 'after_pointer'])
def test_interrupted_publication_exposes_only_complete_previous_or_new_snapshot(corpus, monkeypatch, boundary):
    original = publish(corpus)
    old_id = store.load_snapshot(corpus)[0]
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    payload['unadjusted'][0]['extra'] = 'new observation'
    payload = confirmed({k: v for k, v in payload.items() if k != 'confirmation'})
    write = store._write_object
    write_body = projection._write_body
    write_header = projection._write_header
    pointer = store.atomic_write_json

    def fail():
        raise OSError('injected durable boundary')

    def object_write(base, value):
        result = write(base, value)
        if boundary == 'source' and isinstance(value, dict) and 'unadjusted' in value:
            fail()
        if boundary == 'snapshot' and isinstance(value, dict) and 'observations' in value:
            fail()
        return result

    def body_write(*args):
        result = write_body(*args)
        if boundary == 'body':
            fail()
        return result

    def header_write(*args):
        result = write_header(*args)
        if boundary == 'header':
            fail()
        return result

    def pointer_write(path, value):
        if path.name == 'current.json' and boundary == 'before_pointer':
            fail()
        pointer(path, value)
        if path.name == 'current.json' and boundary == 'after_pointer':
            fail()

    with monkeypatch.context() as patch:
        patch.setattr(store, '_write_object', object_write)
        patch.setattr(projection, '_write_body', body_write)
        patch.setattr(projection, '_write_header', header_write)
        patch.setattr(store, 'atomic_write_json', pointer_write)
        with pytest.raises(OSError, match='injected'):
            store.publish_pair(corpus, **payload)
    current_id, current = store.load_snapshot(corpus)
    assert (current_id != old_id) == (boundary == 'after_pointer')
    facts = projection.read(corpus, current, '005930')
    assert facts is not None
    assert store.load_snapshot(corpus, old_id)[1] == original
    retry = store.publish_pair(corpus, **payload)
    assert projection.read(corpus, store.load_snapshot(corpus, retry)[1], '005930') is not None


def test_guard_and_observation_writers_merge_under_one_publisher_lock(corpus):
    publish(corpus)
    payload = confirmed(observation(strict_spec().targets[0], NOW.date()))
    state = {'entries': {}, 'summary': {'commit_pending': True}, 'confirmed_through': {'005930': '2018-05-04'}}
    barrier = threading.Barrier(2)

    def guard():
        barrier.wait(5)
        ingest._publish(corpus, state)

    def observation_write():
        barrier.wait(5)
        return store.publish_pair(corpus, **payload)

    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(guard), pool.submit(observation_write)]
        for task in tasks:
            task.result(5)
    _, manifest = store.load_snapshot(corpus)
    assert store.read_object(corpus, manifest['daily_ingest']) == ingest.guard_payload(state)
    value = header(corpus, manifest)
    assert value['observation_id'] == manifest['observations']['005930']


def test_bootstrap_all_durable_writes_hold_existing_publisher_lock(corpus, monkeypatch):
    identity, _ = legacy_snapshot(corpus)
    lock, write, held = store._series_write_lock, projection._write_query_file, []

    @contextmanager
    def owned(path):
        with lock(path):
            held.append(True)
            try:
                yield
            finally:
                held.pop()

    def checked(*args, **kwargs):
        assert held
        return write(*args, **kwargs)

    monkeypatch.setattr(store, '_series_write_lock', owned)
    monkeypatch.setattr(projection, '_write_query_file', checked)
    projection.prepare_existing_query_data(corpus, expected_snapshot=identity, codes=['005930'])


@pytest.mark.parametrize('target', ['body', 'header', 'raw'])
def test_artifact_mutation_after_snapshot_write_rejects_pointer_commit(corpus, monkeypatch, target):
    identity, _ = legacy_snapshot(corpus)
    write = store._write_object

    def corrupt_after_snapshot(base, value):
        result = write(base, value)
        if isinstance(value, dict) and 'daily_query' in value:
            ready = header(corpus, value)
            path = {
                'body': projection._body_path(corpus, ready['body_id']),
                'header': projection._source_path(corpus, value['daily_query']['headers']['005930']),
                'raw': projection._source_path(corpus, ready['observation_id']),
            }[target]
            path.write_bytes(b'corrupted after sealing')
        return result

    monkeypatch.setattr(store, '_write_object', corrupt_after_snapshot)
    with pytest.raises(ValueError):
        projection.prepare_existing_query_data(corpus, expected_snapshot=identity, codes=['005930'])
    assert store.load_snapshot(corpus)[0] == identity


def test_snapshot_existing_under_expected_hash_must_match_actual_disk(corpus, monkeypatch):
    identity, _ = legacy_snapshot(corpus)
    write = store._write_object

    def corrupt_snapshot(base, value):
        result = write(base, value)
        if isinstance(value, dict) and 'daily_query' in value:
            projection._source_path(corpus, result).write_text('{}')
        return result

    monkeypatch.setattr(store, '_write_object', corrupt_snapshot)
    with pytest.raises(ValueError, match='checksum mismatch'):
        projection.prepare_existing_query_data(corpus, expected_snapshot=identity, codes=['005930'])
    assert store.load_snapshot(corpus)[0] == identity
