"""Read retirement preserves the shared process slot and queued capture writes."""
from __future__ import annotations

import asyncio
import shutil
import time
from pathlib import Path

import pytest

from hoga.api import compute_jobs
from hoga.api.read_shutdown import ReadInterrupted, ReadWork
from hoga.compute_executor import ComputeExecutor


def held_read(root: str):
    path = Path(root)
    (path / 'read.started').touch()
    deadline = time.monotonic() + 30
    while not (path / 'read.release').exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('read was not released')
        time.sleep(0.01)
    return 'read'


async def test_read_retirement_preserves_shared_pool_capture_parse_and_depth_save(tmp_path):
    work = ReadWork()
    pool = ComputeExecutor('process', max_workers=1)
    raw = tmp_path / 'raw/20260519/003490'
    raw.mkdir(parents=True)
    fixture = Path(__file__).resolve().parents[1] / 'fixtures/tiny_tsv'
    for name in ('info.tsv', 'first_001.tsv', 'chart.tsv'):
        shutil.copy(fixture / name, raw / name)
    read = work.start(lambda operation: compute_jobs.run_job(
        pool, held_read, str(tmp_path), operation=operation))
    capture = None
    try:
        async with asyncio.timeout(30):
            while not (tmp_path / 'read.started').exists():
                await asyncio.sleep(0.02)
        capture = asyncio.create_task(compute_jobs.run_job(
            pool, compute_jobs.capture_parse_job, str(tmp_path), '003490', '20260519', False,
            background=True))
        await asyncio.sleep(0)
        work.begin_read_shutdown()
        with pytest.raises(ReadInterrupted):
            await read.result()
        await work.wait_read_work()
        assert not capture.done()
        assert not (tmp_path / 'parquet/20260519/003490').exists()
        (tmp_path / 'read.release').touch()
        await asyncio.wait_for(capture, 30)
        assert (tmp_path / 'parquet/20260519/003490/hogaplay/snapshots.parquet').exists()
        saved = await compute_jobs.run_job(
            pool, compute_jobs.depth_daily_sweep_job, str(tmp_path), '003490', '20260519',
            background=True)
        assert saved['computed'] == 1 and saved['total_rows'] > 0
    finally:
        (tmp_path / 'read.release').touch()
        if capture is not None:
            await asyncio.gather(capture, return_exceptions=True)
        await work.wait_read_work()
        await pool.aclose()
