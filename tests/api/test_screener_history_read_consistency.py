import datetime as dt
import fcntl
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import polars as pl
import pytest

from hoga.api import screener_history_coverage as coverage, screener_write_lock as publication
from hoga.api.models import HistoryVolumeParams, NewHighVolLeaf


def corpus(root, monkeypatch):
    sdir, staging = root / 'screener', root / 'stage'
    sdir.mkdir()
    staging.mkdir()
    for directory, volume in ((sdir, 10), (staging, 20)):
        pl.DataFrame({'code': ['005930'], 'date': [dt.date(2026, 9, 1)], 'volume': [volume]}).write_parquet(
            directory / 'daily_adjusted.parquet')
    pl.DataFrame(schema={'code': pl.String, 'seg_start': pl.Date, 'factor': pl.Float64}).write_parquet(
        sdir / 'factors.parquet')
    pl.DataFrame({'code': ['005930'], 'seg_start': [dt.date(2026, 9, 1)], 'factor': [1.]}).write_parquet(
        staging / 'factors.parquet')
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20260901'])
    leaf = NewHighVolLeaf(id='v', params=HistoryVolumeParams(
        mode='date_range', start_date='2026-09-01', end_date='2026-09-01',
        record_period={'unit': 'trading_days', 'value': 1}))
    return sdir, staging, leaf


def test_reader_waits_until_entire_publication_is_visible(tmp_path, monkeypatch):
    sdir, staging, leaf = corpus(tmp_path, monkeypatch)
    between, release, reader_waiting = Event(), Event(), Event()
    replace, flock = os.replace, fcntl.flock

    def hold_replace(source, target):
        replace(source, target)
        if target.name == 'factors.parquet':
            between.set()
            assert release.wait(5)

    def observe_lock(handle, operation):
        if operation == fcntl.LOCK_SH:
            reader_waiting.set()
        return flock(handle, operation)

    monkeypatch.setattr(publication.os, 'replace', hold_replace)
    monkeypatch.setattr(publication.fcntl, 'flock', observe_lock)

    def publish():
        with publication.screener_write_lock(sdir):
            publication.publish_history(sdir, staging)

    with ThreadPoolExecutor(2) as pool:
        writer = pool.submit(publish)
        assert between.wait(5)
        reader = pool.submit(coverage.evaluate, tmp_path, [leaf], ['005930'])
        try:
            assert reader_waiting.wait(5)
            assert not reader.done()
        finally:
            release.set()
        writer.result(timeout=5)
        result = reader.result(timeout=5)
    assert result.coverage.complete == 1
    assert result.matches['005930'][0].volume == 20


def test_reader_recovers_interrupted_publication_before_evaluation(tmp_path, monkeypatch):
    sdir, staging, leaf = corpus(tmp_path, monkeypatch)
    replace = os.replace

    def fail_after_factor(source, target):
        replace(source, target)
        if target.name == 'factors.parquet':
            raise OSError('synthetic publication interruption')

    with monkeypatch.context() as patcher:
        patcher.setattr(publication.os, 'replace', fail_after_factor)
        with pytest.raises(OSError), publication.screener_write_lock(sdir):
            publication.publish_history(sdir, staging)
    assert (sdir / 'history_publish.json').exists()
    result = coverage.evaluate(tmp_path, [leaf], ['005930'])
    assert result.coverage.complete == 1
    assert result.matches['005930'][0].volume == 20
    assert not (sdir / 'history_publish.json').exists()
