from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from typing import Protocol

from hoga.live import kis_access
from hoga.live.kis_capacity_scheduler import (
    KisCapacityCooldown,
    KisCapacityOverloaded,
)
from hoga.live.kis_client import KisClient, KisRateLimitError
from hoga.live.index_registry import RepresentativeIndex


class KisRestScheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: kis_access.KisRequestPriority,
        call: Callable[[KisClient], Awaitable],
        cooldown_scope: Hashable | None = None,
    ): ...


class LiveIndexInvestorNetFetcher:
    """Owns scheduled KIS fetch shape for market-level index investor net."""

    def __init__(
        self,
        *,
        data_dir,
        scheduler: KisRestScheduler,
    ) -> None:
        self._data_dir = data_dir
        self._scheduler = scheduler

    async def fetch(
        self,
        *,
        index: RepresentativeIndex,
        from_label: str,
        to_label: str,
    ) -> dict:
        batch_label = f"{from_label}__{to_label}"
        try:
            result = await kis_access.run_with_capacity(
                self._scheduler,
                data_dir=self._data_dir,
                role="background",
                key=("index-investor-net", index.id, from_label, to_label),
                endpoint=kis_access.KisRestEndpoint.INDEX_INVESTOR_NET,
                priority="background",
                cooldown_scope="index-investor-net",
                fetch_fn=lambda kis: kis.fetch_market_investor_net(
                    index,
                    from_label,
                    to_label,
                ),
            )
        except (KisCapacityCooldown, KisCapacityOverloaded, KisRateLimitError) as e:
            return {
                "index_id": index.id,
                "from": from_label,
                "to": to_label,
                "points": [],
                "data_warnings": [
                    _kis_error_to_warning("kis_rate_limit", str(e), batch_label),
                ],
            }

        return {
            "index_id": index.id,
            "from": from_label,
            "to": to_label,
            "points": [_investor_point_to_dict(p) for p in result.points],
            "data_warnings": [
                _violation_to_warning(v, batch_label) for v in result.violations
            ],
        }


def _investor_point_to_dict(p) -> dict:
    return {
        "t_ms": p.t_ms,
        "foreign_net": p.foreign_net,
        "institution_net": p.institution_net,
    }


def _violation_to_warning(v, batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "date": v.date_yyyymmdd,
        "reason": "invariant_violation",
        "msg": f"{v.date_yyyymmdd}: {v.reason} ({v.detail})",
    }


def _kis_error_to_warning(reason: str, msg: str, batch_label: str) -> dict:
    return {"batch": batch_label, "reason": reason, "msg": msg}
