"""Snapshot reuse preserves integrity, isolation, bounded memory and concurrency."""
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from hoga.api import screener_series_store as store, screener_snapshot_cache as cache


def object_file(tmp_path, value):
    folder = store.root(tmp_path) / 'objects'
    folder.mkdir(parents=True, exist_ok=True)
    identity = store.digest(value)
    path = folder / f'{identity}.json'
    import json
    path.write_text(json.dumps(value))
    return identity, path


def test_reuses_only_verified_unchanged_files_and_copies_results(tmp_path):
    memo = cache.SnapshotCache()
    identity, path = object_file(tmp_path, {'rows': [1, 2]})
    calls = []

    def load():
        calls.append(1)
        return store.read_object(tmp_path, identity)

    first = memo.obtain('one', load)
    first['rows'].append(3)
    assert memo.obtain('one', load) == {'rows': [1, 2]} and calls == [1]
    # Replacing a file with identical bytes still needs fresh attestation.
    replacement = path.with_suffix('.replacement')
    replacement.write_bytes(path.read_bytes())
    replacement.replace(path)
    assert memo.obtain('one', load) == {'rows': [1, 2]} and calls == [1, 1]
    stamp = path.stat()
    path.write_text('{"rows": [9, 2]}')
    os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    for _ in range(2):
        with pytest.raises(ValueError, match='checksum mismatch'):
            memo.obtain('one', load)
    assert calls == [1, 1, 1, 1]  # Neither corruption nor a failure is cached.


def test_nested_preparation_forwards_dependency_attestation(tmp_path):
    memo = cache.SnapshotCache()
    identity, path = object_file(tmp_path, {'value': 1})
    def inner():
        return memo.obtain('inner', lambda: store.read_object(tmp_path, identity))
    assert inner() == {'value': 1}
    assert memo.obtain('outer', inner) == {'value': 1}
    path.unlink()
    with pytest.raises(FileNotFoundError):
        memo.obtain('outer', inner)


def test_concurrent_requests_share_preparation_and_own_their_results():
    memo = cache.SnapshotCache()
    entered, release = threading.Event(), threading.Event()
    calls = []

    def load():
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return {'values': [1]}

    with ThreadPoolExecutor(max_workers=4) as pool:
        first = pool.submit(memo.obtain, 'key', load)
        assert entered.wait(5)
        others = [pool.submit(memo.obtain, 'key', load) for _ in range(3)]
        release.set()
        results = [first.result(), *(task.result() for task in others)]
    assert calls == [1]
    results[0]['values'].append(2)
    assert all(value == {'values': [1]} for value in results[1:])


def test_file_change_during_build_is_never_promoted(tmp_path):
    memo = cache.SnapshotCache()
    identity, path = object_file(tmp_path, {'value': 1})

    def load():
        value = store.read_object(tmp_path, identity)
        path.write_text('{"value": 2}')
        return value

    assert memo.obtain('key', load) == {'value': 1}
    assert not memo.entries


def test_retargeting_an_object_symlink_invalidates_its_cached_facts(tmp_path):
    memo = cache.SnapshotCache()
    identity, path = object_file(tmp_path, {'value': 1})
    original = path.with_suffix('.original')
    path.rename(original)
    path.symlink_to(original)
    def load():
        return store.read_object(tmp_path, identity)
    assert memo.obtain('key', load) == {'value': 1}
    corrupted = path.with_suffix('.corrupted')
    corrupted.write_text('{"value": 2}')
    path.unlink()
    path.symlink_to(corrupted)
    with pytest.raises(ValueError, match='checksum mismatch'):
        memo.obtain('key', load)


def test_lru_and_byte_budgets_and_oversized_values(monkeypatch):
    memo = cache.SnapshotCache()
    monkeypatch.setattr(cache, 'MAX_ENTRIES', 2)
    for key in ('a', 'b', 'a', 'c'):
        memo.obtain(key, lambda: [1])
    assert list(memo.entries) == ['a', 'c']
    monkeypatch.setattr(cache, 'MAX_BYTES', 30)
    memo.obtain('small', lambda: [1])
    assert memo.bytes <= 30
    monkeypatch.setattr(cache, 'MAX_ENTRY_BYTES', 1)
    assert memo.obtain('large', lambda: [1, 2]) == [1, 2]
    assert 'large' not in memo.entries


def test_scope_manifest_and_date_inputs_never_share_an_entry(tmp_path):
    calls = []
    def load():
        calls.append(1)
        return len(calls)
    first = cache.obtain(tmp_path, {'revision': 1}, 'phase', ('code', 'day1'), load)
    assert cache.obtain(tmp_path, {'revision': 1}, 'phase', ('code', 'day1'), load) == first
    for root, manifest, inputs in [
        (tmp_path / 'other', {'revision': 1}, ('code', 'day1')),
        (tmp_path, {'revision': 2}, ('code', 'day1')),
        (tmp_path, {'revision': 1}, ('other-code', 'day1')),
        (tmp_path, {'revision': 1}, ('code', 'day2')),
    ]:
        assert cache.obtain(root, manifest, 'phase', inputs, load) != first


def test_reset_during_preparation_does_not_restore_old_cache():
    memo = cache.SnapshotCache()
    entered, release = threading.Event(), threading.Event()
    def load():
        entered.set()
        assert release.wait(5)
        return 1
    with ThreadPoolExecutor() as pool:
        task = pool.submit(memo.obtain, 'key', load)
        assert entered.wait(5)
        memo.clear()
        assert memo.obtain('key', lambda: 2) == 2
        release.set()
        assert task.result() == 1
    assert memo.obtain('key', lambda: 3) == 2
