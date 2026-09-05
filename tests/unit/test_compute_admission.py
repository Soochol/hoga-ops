"""CPU 풀 제출 전 취소와 실행 중 permit 수명을 호출 횟수로 검증한다."""
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from hoga.compute_executor import ComputeExecutor


async def test_cancelled_call_keeps_running_worker_slot_and_drops_waiting_call(monkeypatch):
    # process 분기의 제출/await 계약을 제어 가능한 실제 future로 잰다. 프로세스
    # spawn과 pickle은 test_compute_pools의 실 프로세스 왕복이 따로 검증한다.
    executor = ComputeExecutor("process", max_workers=1)
    loop = asyncio.get_running_loop()
    started, finished = asyncio.Event(), asyncio.Event()
    release = threading.Event()
    ran = []

    def work(name):
        ran.append(name)
        if name == "running":
            loop.call_soon_threadsafe(started.set)
            release.wait(5)
            loop.call_soon_threadsafe(finished.set)
        return name

    with ThreadPoolExecutor(max_workers=1) as pool:
        monkeypatch.setattr(executor, "_ensure_pool", lambda: pool)
        first = asyncio.create_task(executor.run(work, "running"))
        await started.wait()
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        waiting = asyncio.create_task(executor.run(work, "abandoned"))
        # Task가 acquire까지 진행하게 한 뒤 취소한다. 시간 임계 단언은 없다.
        await asyncio.sleep(0)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        last = asyncio.create_task(executor.run(work, "latest"))
        await asyncio.sleep(0)
        assert ran == ["running"]
        release.set()
        await finished.wait()
        assert await last == "latest"
    assert ran == ["running", "latest"]
