from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from typing import Protocol

from hoga.live import kiwoom_access, kiwoom_investor, kiwoom_rest_runtime
from hoga.live.index_registry import RepresentativeIndex
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded, Priority
from hoga.live.kiwoom_errors import KiwoomRestError


class KiwoomRestScheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[], Awaitable],
    ): ...


class LiveIndexInvestorNetFetcher:
    """Owns scheduled KIS fetch shape for market-level index investor net."""

    def __init__(
        self,
        *,
        data_dir,
        scheduler: KiwoomRestScheduler,
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
            # PR-E(#1041) 칼 컷오버 — 소스는 키움 ka10051 이다. 계정 차원
            # (cooldown_scope·data_dir)은 사라졌다(#1015).
            client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
            if client is None:
                raise KiwoomRestError("kiwoom client not initialized")
            result = await kiwoom_access.run_with_capacity(
                self._scheduler,   # 주입된 거버너 — 테스트가 갈아끼우는 이음매다
                key=("index-investor-net", index.id, from_label, to_label),
                api_id="ka10051",
                priority="background",
                client=client,
                fetch_fn=lambda c: kiwoom_investor.fetch_market_investor_net(
                    c, index, from_label, to_label,
                ),
            )
        except (KiwoomCapacityOverloaded, KiwoomRestError) as e:
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
            # ka10051 은 날짜당 한 콜이고 휴장일은 빈 응답으로 자연히 걸러진다 —
            # 종목별(ka10059)과 달리 불변식 위반 개념이 없어 리스트를 그대로 준다.
            "points": [_investor_point_to_dict(p) for p in result],
            "data_warnings": [],
        }


def _investor_point_to_dict(p) -> dict:
    return {
        "t_ms": p.t_ms,
        "foreign_net": p.foreign_net,
        "institution_net": p.institution_net,
    }



def _kis_error_to_warning(reason: str, msg: str, batch_label: str) -> dict:
    return {"batch": batch_label, "reason": reason, "msg": msg}
