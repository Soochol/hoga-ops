import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event

from hoga.util.mtime_cache import MtimeLruCache


def test_replacement_with_preserved_mtime_and_size_invalidates(tmp_path):
    path = tmp_path / 'file'
    path.write_text('old')
    old = path.stat()
    cache = MtimeLruCache(2)
    assert cache.get_or_load(path, lambda p: p.read_text()) == 'old'
    replacement = tmp_path / 'next'
    replacement.write_text('new')
    os.utime(replacement, ns=(old.st_atime_ns, old.st_mtime_ns))
    os.replace(replacement, path)
    assert cache.get_or_load(path, lambda p: p.read_text()) == 'new'


def test_replacement_during_load_retries_before_caching(tmp_path):
    path = tmp_path / 'file'
    path.write_text('old')
    cache = MtimeLruCache(2)
    calls = 0

    def load(p):
        nonlocal calls
        calls += 1
        value = p.read_text()
        if calls == 1:
            replacement = tmp_path / 'next'
            replacement.write_text('new')
            os.replace(replacement, p)
        return value

    assert cache.get_or_load(path, load) == 'new'
    assert cache.get_or_load(path, load) == 'new'
    assert calls == 2


def test_clear_during_load_does_not_repopulate_cache(tmp_path):
    path = tmp_path / 'file'
    path.write_text('x')
    cache = MtimeLruCache(2)
    entered, release = Event(), Event()
    calls = 0

    def load(p):
        nonlocal calls
        calls += 1
        entered.set()
        assert release.wait(3)
        return p.read_text()

    with ThreadPoolExecutor(1) as pool:
        first = pool.submit(cache.get_or_load, path, load)
        assert entered.wait(3)
        cache.clear()
        release.set()
        assert first.result(timeout=3) == 'x'
    assert cache.get_or_load(path, load) == 'x'
    assert calls == 2


def test_concurrent_readers_parse_once_and_other_paths_do_not_wait(tmp_path, monkeypatch):
    from concurrent.futures import Future
    from threading import Lock

    from hoga.util import mtime_cache

    entered, release, followers_ready = Event(), Event(), Event()
    guard = Lock()
    followers = 0

    class ObservedFuture(Future):
        def result(self, timeout=None):
            nonlocal followers
            with guard:
                followers += 1
                if followers == 3:
                    followers_ready.set()
            return super().result(timeout)

    monkeypatch.setattr(mtime_cache, 'Future', ObservedFuture)
    path, other = tmp_path / 'file', tmp_path / 'other'
    path.write_text('same')
    other.write_text('independent')
    cache = MtimeLruCache(2)
    calls = 0

    def load(p):
        nonlocal calls
        calls += 1
        entered.set()
        assert release.wait(5)
        return p.read_text()

    with ThreadPoolExecutor(4) as pool:
        first = pool.submit(cache.get_or_load, path, load)
        assert entered.wait(5)
        readers = [pool.submit(cache.get_or_load, path, load) for _ in range(3)]
        try:
            assert followers_ready.wait(5)
            assert cache.get_or_load(other, lambda p: p.read_text()) == 'independent'
        finally:
            release.set()
        assert [f.result(timeout=5) for f in [first, *readers]] == ['same'] * 4
    assert calls == 1


def test_failed_load_releases_waiters_and_next_call_can_retry(tmp_path, monkeypatch):
    from concurrent.futures import Future

    import pytest

    from hoga.util import mtime_cache

    entered, release, waiting = Event(), Event(), Event()

    class ObservedFuture(Future):
        def result(self, timeout=None):
            waiting.set()
            return super().result(timeout)

    monkeypatch.setattr(mtime_cache, 'Future', ObservedFuture)
    path = tmp_path / 'file'
    path.write_text('recovered')
    cache = MtimeLruCache(2)
    error = OSError('synthetic read error')

    def fail(p):
        entered.set()
        assert release.wait(5)
        raise error

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(cache.get_or_load, path, fail)
        assert entered.wait(5)
        second = pool.submit(cache.get_or_load, path, fail)
        try:
            assert waiting.wait(5)
        finally:
            release.set()
        for result in (first, second):
            with pytest.raises(OSError) as caught:
                result.result(timeout=5)
            assert caught.value is error
    assert cache.get_or_load(path, lambda p: p.read_text()) == 'recovered'


def test_continuously_changing_file_has_bounded_retries_and_is_not_cached(tmp_path):
    path = tmp_path / 'file'
    path.write_text('0')
    cache = MtimeLruCache(2)
    calls = 0

    def load(p):
        nonlocal calls
        value = p.read_text()
        calls += 1
        replacement = tmp_path / 'next'
        replacement.write_text(str(calls))
        os.replace(replacement, p)
        return value

    cache.get_or_load(path, load)
    assert calls == 3
    cache.get_or_load(path, load)
    assert calls == 6
