"""One admission budget per token owner, shared by market and private REST calls."""

from __future__ import annotations

import asyncio
import time
import weakref

_budgets: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_account_budgets: dict[str, KiwoomBudget] = {}


class KiwoomBudget:
    def __init__(self, *, mock: bool = False, interval: float = 0.21) -> None:
        self.mock = mock
        self.interval = interval
        self._next: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, api_id: str, *, write: bool = False, deadline: float | None = None) -> None:
        group = "write" if write else "read"
        async with self._lock:
            now = time.monotonic()
            at = max(now, self._next.get(group, 0), self._next.get(api_id, 0))
            if deadline is not None and at >= deadline:
                raise TimeoutError("admission-deadline")
            self._next[group] = at + self.interval
            self._next[api_id] = at + (max(1.05, self.interval) if self.mock else self.interval)
        if at > now:
            await asyncio.sleep(at - now)
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("admission-deadline")


def budget_for(provider) -> KiwoomBudget:
    budget = _budgets.get(provider)
    if budget is None:
        environment = getattr(getattr(provider, "_creds", None), "environment", "real")
        budget = KiwoomBudget(mock=environment == "mock")
        _budgets[provider] = budget
    return budget


def bind_budget(provider, account_ref: str) -> KiwoomBudget:
    """Credentials verified as the same account must share the stricter group budget."""
    current = budget_for(provider)
    owner = _account_budgets.setdefault(account_ref, current)
    for key, deadline in current._next.items():
        owner._next[key] = max(owner._next.get(key, 0), deadline)
    _budgets[provider] = owner
    return owner
