from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections.abc import Mapping
from pathlib import Path

from hoga.live import kis_runtime
from hoga.live.kis_account_pool import KisAccountPool
from hoga.live.kis_capacity_scheduler import KisCapacityScheduler

log = logging.getLogger(__name__)

_DEFAULT_WORKERS_PER_ACCOUNT = 8
_DEFAULT_MIN_WORKERS = 4
_DEFAULT_MAX_WORKERS = 64
_DEFAULT_MAX_PENDING_REQUESTS = 1000
_DEFAULT_ACCOUNT_COOLDOWN_S = 8.0

_schedulers: dict[Path, KisCapacityScheduler] = {}
_lock = threading.Lock()


def max_workers_for_account_count(
    account_count: int,
    env: Mapping[str, str] | None = None,
) -> int:
    source = os.environ if env is None else env
    override = source.get("HOGA_KIS_CAPACITY_MAX_WORKERS")
    if override:
        try:
            parsed = int(override)
        except ValueError:
            log.warning(
                "invalid HOGA_KIS_CAPACITY_MAX_WORKERS=%r; using account-based default",
                override,
            )
        else:
            if parsed > 0:
                return parsed
            log.warning(
                "non-positive HOGA_KIS_CAPACITY_MAX_WORKERS=%r; using account-based default",
                override,
            )
    return max(
        _DEFAULT_MIN_WORKERS,
        min(_DEFAULT_MAX_WORKERS, max(0, account_count) * _DEFAULT_WORKERS_PER_ACCOUNT),
    )


def max_pending_requests_from_env(env: Mapping[str, str] | None = None) -> int:
    source = os.environ if env is None else env
    override = source.get("HOGA_KIS_CAPACITY_MAX_PENDING")
    if override:
        try:
            parsed = int(override)
        except ValueError:
            log.warning("invalid HOGA_KIS_CAPACITY_MAX_PENDING=%r; using default", override)
        else:
            if parsed > 0:
                return parsed
            log.warning("non-positive HOGA_KIS_CAPACITY_MAX_PENDING=%r; using default", override)
    return _DEFAULT_MAX_PENDING_REQUESTS


def ensure_kis_capacity_scheduler(data_dir: Path) -> KisCapacityScheduler:
    key = _scheduler_key(data_dir)
    with _lock:
        scheduler = _schedulers.get(key)
        if scheduler is None:
            scheduler = KisCapacityScheduler(
                name="kis-capacity",
                account_pool=KisAccountPool(key),
                max_workers=max_workers_for_account_count(
                    len(kis_runtime.configured_account_ids(key))
                ),
                max_pending_requests=max_pending_requests_from_env(),
                account_cooldown_s=_DEFAULT_ACCOUNT_COOLDOWN_S,
            )
            _schedulers[key] = scheduler
        return scheduler


async def aclose_kis_capacity_scheduler(data_dir: Path | None = None) -> None:
    with _lock:
        if data_dir is None:
            schedulers = list(_schedulers.values())
            _schedulers.clear()
        else:
            scheduler = _schedulers.pop(_scheduler_key(data_dir), None)
            schedulers = [scheduler] if scheduler is not None else []
    await asyncio.gather(*(s.aclose() for s in schedulers), return_exceptions=True)


def _scheduler_key(data_dir: Path) -> Path:
    return data_dir.expanduser().resolve()

