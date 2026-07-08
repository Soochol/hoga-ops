from __future__ import annotations

import time
from collections.abc import Callable, Hashable
from dataclasses import dataclass
from pathlib import Path

from hoga.live import account_health, kis_runtime
from hoga.live.kis_client import KisClient


@dataclass(frozen=True)
class KisAccountLease:
    account_id: int
    client: KisClient


@dataclass(frozen=True)
class KisAccountSnapshot:
    account_id: int
    healthy: bool
    inflight: int
    cooldowns: dict[str, float]


class KisNoAccountAvailable(RuntimeError):
    pass


class KisAccountPool:
    def __init__(
        self,
        data_dir: Path,
        *,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._data_dir = data_dir
        account_ids = kis_runtime.configured_account_ids(data_dir)
        if not account_ids:
            account_ids = [0]
        self._account_ids = tuple(account_ids)
        self._now = now
        self._inflight: dict[int, int] = {}
        self._cooldown_until: dict[tuple[int, Hashable], float] = {}

    def configured_accounts(self) -> list[int]:
        return list(self._account_ids)

    def eligible_accounts(self) -> list[int]:
        return [
            account_id
            for account_id in self._account_ids
            if not account_health.is_rest_degraded(account_id)
        ]

    def cooldown_active(self, account_id: int, cooldown_key: Hashable) -> bool:
        return self._now() < self._cooldown_until.get((account_id, cooldown_key), 0.0)

    def mark_cooldown(
        self,
        account_id: int,
        cooldown_key: Hashable,
        seconds: float,
    ) -> None:
        until = self._now() + max(0.0, seconds)
        key = (account_id, cooldown_key)
        self._cooldown_until[key] = max(self._cooldown_until.get(key, 0.0), until)

    async def lease(
        self,
        *,
        cooldown_key: Hashable | None,
    ) -> KisAccountLease:
        candidates = self._candidates(cooldown_key)
        if not candidates:
            raise KisNoAccountAvailable("no KIS account available")

        account_id = min(candidates, key=lambda a: (self._inflight.get(a, 0), a))
        client = kis_runtime.get_kis_client(account_id)
        if client is None and account_id == 0:
            client = kis_runtime.ensure_kis_client_from_env(self._data_dir)
        if client is None:
            client = kis_runtime.ensure_kis_client_for_account(account_id, self._data_dir)
        if client is None:
            raise KisNoAccountAvailable(f"KIS account {account_id} client unavailable")
        self._inflight[account_id] = self._inflight.get(account_id, 0) + 1
        return KisAccountLease(account_id=account_id, client=client)

    def release(self, account_id: int) -> None:
        current = self._inflight.get(account_id, 0)
        if current <= 1:
            self._inflight.pop(account_id, None)
        else:
            self._inflight[account_id] = current - 1

    def snapshot(self) -> list[KisAccountSnapshot]:
        now = self._now()
        out: list[KisAccountSnapshot] = []
        for account_id in self._account_ids:
            cooldowns = {
                repr(cooldown_key): until
                for (cooldown_account_id, cooldown_key), until in self._cooldown_until.items()
                if cooldown_account_id == account_id and now < until
            }
            out.append(
                KisAccountSnapshot(
                    account_id=account_id,
                    healthy=not account_health.is_rest_degraded(account_id),
                    inflight=self._inflight.get(account_id, 0),
                    cooldowns=cooldowns,
                )
            )
        return out

    def _candidates(self, cooldown_key: Hashable | None) -> list[int]:
        candidates = self.eligible_accounts()
        if cooldown_key is None:
            return candidates
        return [
            account_id
            for account_id in candidates
            if not self.cooldown_active(account_id, cooldown_key)
        ]
