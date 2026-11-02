import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from hoga.api import (
    screener_daily_projection as projection,
    screener_series_store as store,
    screener_snapshot_cache as cache,
)
from hoga.api.read_shutdown import ReadInterrupted
from tests.api.test_screener_daily_query_integrity import header, publish
from tests.api.test_screener_recovery import corpus as recovery_corpus

corpus = recovery_corpus


class Stop:
    def __init__(self):
        self.stopped = threading.Event()

    def checkpoint(self):
        if self.stopped.is_set():
            raise ReadInterrupted('retired test owner')


@pytest.mark.parametrize('stage', ['dependencies', 'body', 'decompress'])
def test_cancelled_compact_read_never_installs_facts(corpus, monkeypatch, stage):
    manifest = publish(corpus)
    value = header(corpus, manifest)
    cache.shared.clear()
    stop = Stop()
    if stage == 'dependencies':
        original = store._assert_file

        def assert_file(path, stamp):
            if path == projection._source_path(corpus, value['observation_id']):
                stop.stopped.set()
            return original(path, stamp)

        monkeypatch.setattr(store, '_assert_file', assert_file)
    elif stage == 'body':
        original = store._read_file

        def read_file(path, **kwargs):
            result = original(path, **kwargs)
            if path.suffix == '.zlib':
                stop.stopped.set()
            return result

        monkeypatch.setattr(store, '_read_file', read_file)
    else:
        original = projection._decompress

        def decompress(*args, **kwargs):
            stop.stopped.set()
            return original(*args, **kwargs)

        monkeypatch.setattr(projection, '_decompress', decompress)
    with pytest.raises(ReadInterrupted):
        projection.read(corpus, manifest, '005930', stop=stop)
    assert not cache.shared.entries and not cache.shared.flights


def test_cancelled_owner_retries_surviving_waiter_and_durable_publication(corpus, monkeypatch):
    manifest = publish(corpus)
    expected = projection.read(corpus, manifest, '005930')
    cache.shared.clear()
    stopped, survivor = Stop(), Stop()
    entered, release, waiter_entered = threading.Event(), threading.Event(), threading.Event()
    read = store._read_file
    wait = cache.SnapshotCache._wait_entry

    def read_file(path, **kwargs):
        if path.suffix == '.zlib' and kwargs.get('stop') is stopped:
            entered.set()
            assert release.wait(5)
        return read(path, **kwargs)

    def waiting(self, *args):
        waiter_entered.set()
        return wait(self, *args)

    monkeypatch.setattr(store, '_read_file', read_file)
    monkeypatch.setattr(cache.SnapshotCache, '_wait_entry', waiting)
    snapshot_id = store.load_snapshot(corpus)[0]
    with ThreadPoolExecutor(max_workers=3) as pool:
        first = pool.submit(projection.read, corpus, manifest, '005930', stop=stopped)
        assert entered.wait(5)
        second = pool.submit(projection.read, corpus, manifest, '005930', stop=survivor)
        assert waiter_entered.wait(5)
        publication = pool.submit(projection.prepare_existing_query_data, corpus,
                                  expected_snapshot=snapshot_id, codes=['005930'])
        assert publication.result(5)['no_op']
        stopped.stopped.set()
        release.set()
        with pytest.raises(ReadInterrupted):
            first.result(5)
        assert second.result(5) == expected
    assert not cache.shared.flights
