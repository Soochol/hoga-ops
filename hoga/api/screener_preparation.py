"""Shared, resumable daily observations; bounded collection and a single batch publisher."""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from pathlib import Path

import httpx

from hoga.api import screener_series_store as store
from hoga.api.screener_history_jobs import _finish_disk_write
from hoga.api.screener_recovery import RecoveryTarget
from hoga.api.screener_recovery_provider import collector
from hoga.live.kiwoom_errors import KiwoomRateLimitError, KiwoomTransportError
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

CONCURRENCY = 4
BATCH_SIZE = 8
BATCH_SECONDS = .25
RETRY_SECONDS = 1800
DAILY_ATTEMPTS = 2
log = logging.getLogger(__name__)


class PreparationDeferred(ValueError):
    """A bounded retry is waiting; polling must not create a new provider observation."""

    def __init__(self, message, retry_at=None):
        super().__init__(message)
        self.retry_at = retry_at


class DailyPreparation:
    def __init__(self, data_dir: Path, *, fetch=None, clock=None):
        self.data_dir = data_dir
        self.clock = clock or (lambda: dt.datetime.now(KST))
        self.fetch = fetch or collector(data_dir, clock=self.clock)
        self.sem = asyncio.Semaphore(CONCURRENCY)
        self.tasks: dict[tuple, asyncio.Task] = {}
        self.queue = asyncio.Queue()
        self.writer: asyncio.Task | None = None
        self.closing = False

    def check(self, anchor):
        if self.closing or self.clock().date() != anchor:
            raise PreparationDeferred("수정 기준일이 바뀌었습니다. 새 기준으로 다시 조회합니다")

    async def prepare(self, code, first, last, anchor):
        """Consumers detach freely; cancellation never cancels another consumer's fetch."""
        self.check(anchor)
        key = (code, first, last, anchor)
        task = self.tasks.get(key)
        if task is None:
            for (other_code, start, end, basis), active in self.tasks.items():
                if other_code == code and basis == anchor and start <= first and end >= last:
                    task = active
                    break
        if task is None:
            task = asyncio.create_task(self._prepare(code, first, last, anchor))
            self.tasks[key] = task
            task.add_done_callback(lambda completed: self._finished(key, completed))
        return await asyncio.shield(task)

    def _finished(self, key, task):
        self.tasks.pop(key, None)
        if not task.cancelled():
            task.exception()  # detached consumers must not leave unobserved errors

    def _checkpoint(self, code, first, last, anchor):
        identity = store.digest([code, str(first), str(last), str(anchor), "historical_recheck_v1"])
        return self.data_dir / "screener" / "preparation" / f"{identity}.json"

    async def _candidate(self, code, first, last, anchor):
        path = self._checkpoint(code, first, last, anchor)
        record = await asyncio.to_thread(self._read, path)
        if record.get("payload"):
            value = await asyncio.to_thread(store.read_object, self.data_dir, record["payload"])
            if store.digest(value) != record["payload"]:
                raise ValueError("수집 체크포인트의 원본 해시가 다릅니다")
            store.pair_value(**value)
            return value
        now = self.clock()
        attempts = record.get("attempts", 0)
        if attempts >= DAILY_ATTEMPTS or now.timestamp() - record.get("attempted_at", 0) < RETRY_SECONDS:
            retry = record.get("attempted_at", 0) + RETRY_SECONDS if (
                attempts < DAILY_ATTEMPTS and record.get("retryable")) else None
            message = ("당일 일봉 재시도 예산을 모두 사용했습니다" if attempts >= DAILY_ATTEMPTS
                       else record.get("error") or "일봉 재확인 대기 중입니다")
            raise PreparationDeferred(message, retry)
        record = {"attempts": attempts + 1, "attempted_at": now.timestamp(), "retryable": True}
        await _finish_disk_write(atomic_write_json, path, record)
        try:
            target = RecoveryTarget(code=code, first=first, last=last, reason="조건검색 자동 준비")
            value = await self.fetch(target, anchor, lambda: self.check(anchor))
            self.check(anchor)
            if value["code"] != code or value["adjusted_as_of"] != anchor.isoformat():
                raise ValueError("수집 응답의 종목·수정 기준일이 다릅니다")
            if any(row.get("code") != code or not first <= dt.date.fromisoformat(row["date"]) <= last
                   for field in ("unadjusted", "adjusted") for row in value[field]):
                raise ValueError("수집 응답이 요청 범위를 벗어났습니다")
            if not value.get("confirmation"):
                raise ValueError("독립 재조회 근거가 없는 일봉입니다")
            store.pair_value(**value)
            record["payload"] = await _finish_disk_write(store._write_object, store.root(self.data_dir), value)
            await _finish_disk_write(atomic_write_json, path, record)
            return value
        except Exception as exc:
            record["error"] = str(exc)[:200]
            record["retryable"] = isinstance(exc, (KiwoomRateLimitError, KiwoomTransportError, httpx.TransportError))
            if str(exc) == "kiwoom_credentials_unavailable":
                record.update(attempts=0, attempted_at=0)
            await _finish_disk_write(atomic_write_json, path, record)
            if record["retryable"] and attempts + 1 < DAILY_ATTEMPTS:
                raise PreparationDeferred(record["error"], record["attempted_at"] + RETRY_SECONDS) from exc
            raise

    @staticmethod
    def _read(path):
        import json  # noqa: PLC0415 — no environment or provider initialization
        return json.loads(path.read_bytes()) if path.exists() else {}

    async def _prepare(self, code, first, last, anchor):
        async with self.sem:
            self.check(anchor)
            value = await self._candidate(code, first, last, anchor)
        done = asyncio.get_running_loop().create_future()
        done.add_done_callback(lambda future: None if future.cancelled() else future.exception())
        await self.queue.put((value, done))
        if self.writer is None or self.writer.done():
            self.writer = asyncio.create_task(self._write_batches())
        return await asyncio.shield(done)

    async def _batch(self, item, first):
        batch = [item]
        if first:
            return batch, False
        deadline = time.monotonic() + BATCH_SECONDS
        while len(batch) < BATCH_SIZE:
            try:
                item = await asyncio.wait_for(self.queue.get(), max(0, deadline - time.monotonic()))
            except TimeoutError:
                break
            if item is None:
                return batch, True
            if item[0]["adjusted_as_of"] != batch[0][0]["adjusted_as_of"]:
                await self.queue.put(item)
                break
            batch.append(item)
        return batch, False

    async def _write_batches(self):
        first = True
        while True:
            item = await self.queue.get()
            if item is None:
                return
            batch, stop = await self._batch(item, first)
            first = False
            try:
                anchor = dt.date.fromisoformat(batch[0][0]["adjusted_as_of"])
                self.check(anchor)
                snapshot = await _finish_disk_write(
                    lambda items=batch, basis=anchor: store.publish_pairs(
                        self.data_dir, [value for value, _ in items], adjusted_as_of=basis.isoformat(),
                        reuse_existing=True))
                for _, future in batch:
                    if not future.done():
                        future.set_result(snapshot)
            except Exception as exc:
                log.exception("automatic daily publication failed")
                for _, future in batch:
                    if not future.done():
                        future.set_exception(exc)
            if stop or self.queue.empty():
                return

    async def close(self):
        self.closing = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.writer is not None and not self.writer.done():
            await self.queue.put(None)
            await self.writer
