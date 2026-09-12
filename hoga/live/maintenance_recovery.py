"""Bounded read-only recovery probe after a sourced maintenance window ends."""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from hoga.util.atomic_write import atomic_write_json

from . import kiwoom_access, kiwoom_rest_runtime
from .service_status import MaintenanceNotice, _load_notice

_log = logging.getLogger(__name__)
INTERVAL_S = 60
TIMEOUT_S = 15
_attempts: dict[Path, tuple[str, float]] = {}
_inflight: set[Path] = set()


async def check_recovery(data_dir: Path, notice: MaintenanceNotice) -> None:
    """FastAPI BackgroundTasks owns lifetime; polling never waits for the vendor call."""
    key = data_dir.resolve()
    now = time.monotonic()
    previous = _attempts.get(key)
    if key in _inflight or (previous and previous[0] == notice.id and now - previous[1] < INTERVAL_S):
        return
    if int(time.time() * 1000) < notice.ends_at_ms:
        return
    _attempts[key] = (notice.id, now)
    _inflight.add(key)
    try:
        clients = kiwoom_rest_runtime.ensure_rest_clients(data_dir)
        if not clients:
            return
        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
        result = await asyncio.wait_for(kiwoom_access.run_with_capacity(
            scheduler, key=('maintenance-recovery', notice.id), api_id='ka10001',
            priority='background', client=clients[0],
            fetch_fn=lambda client: client.call('ka10001', {'stk_cd': '005930'}),
        ), timeout=TIMEOUT_S)
        # A cached/empty shell or HTTP success alone does not establish API recovery.
        if not any(row.get('cur_prc') not in (None, '') for row in result.rows):
            return
        current, invalid = _load_notice(data_dir)
        if invalid or current != notice:
            return  # A notice edited while the request ran must be checked again.
        atomic_write_json(data_dir / 'kiwoom-maintenance-recovered.json', {
            'id': notice.id, 'rest_recovered_at_ms': int(time.time() * 1000),
            'evidence': 'ka10001 valid response',
        })
    except Exception as exc:  # noqa: BLE001 — probe failure keeps notice and permits the next bounded attempt
        _log.info('Kiwoom maintenance recovery not confirmed: %s', type(exc).__name__)
    finally:
        _inflight.discard(key)
