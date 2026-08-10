from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Hashable
from typing import Any, Protocol

from hoga.live import kiwoom_access, kiwoom_investor, kiwoom_rest_runtime
from hoga.live.data_warnings import make_data_warning
from hoga.live.error_policy import LiveErrorPolicy, classify_live_error
from hoga.live.index_registry import RepresentativeIndex
from hoga.live.kiwoom_capacity import Priority

log = logging.getLogger(__name__)


class KiwoomRestScheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[Any], Awaitable],
    ) -> Any: ...


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
        """`ka10051` 은 하루치 TR 이라 **날짜 수만큼 콜**이다. 그 반복을 거버너
        **위**에 두어 날짜 하나 = submit 하나로 만든다(ADR-0137).

        이전 판은 90일 요청 하나를 submit 1건으로 제출하고 그 안에서 90콜을 쏘았다 —
        버킷은 1 을 세고 벤더는 90 을 센다. 날짜 수가 사용자 입력이라 상한도 없었다.
        """
        batch_label = f"{from_label}__{to_label}"
        # PR-E(#1041) 칼 컷오버 — 소스는 키움 ka10051 이다.
        client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
        if client is None:
            return self._result(index, from_label, to_label, points=[], warnings=[
                _warning("api_error", "kiwoom client not initialized", batch_label),
            ])

        dates = kiwoom_investor.date_range(from_label, to_label)
        results = await asyncio.gather(
            *(
                kiwoom_access.run_with_capacity(
                    self._scheduler,  # 주입된 거버너 — 테스트가 갈아끼우는 이음매다
                    key=("index-investor-net", index.id, date_s),
                    api_id="ka10051",
                    priority="background",
                    client=client,
                    # 기본인자 바인딩 — late binding 이면 모든 날짜가 마지막 날을 본다.
                    fetch_fn=lambda c, d=date_s: (
                        kiwoom_investor.fetch_market_investor_net_day(c, index, d)
                    ),
                )
                for date_s in dates
            ),
            return_exceptions=True,
        )

        points = []
        failures: list[LiveErrorPolicy] = []
        for result in results:
            if isinstance(result, BaseException):
                failures.append(classify_live_error(result))
            elif result is not None:  # 휴장일은 None — 실패가 아니다
                points.append(result)
        points.sort(key=lambda p: p.t_ms)

        warnings = []
        if failures:
            worst = failures[0]
            # ADR-0137 R3 — 폴백을 고른 층이 **영향**을 로그한다. R5 — 성공한 날짜는
            # 그대로 살린다. 이전 판은 예외 하나로 구간 전체를 0포인트로 버렸다.
            log.warning(
                "지수 투자자 순매수 부분 실패 → %d/%d일 확보 "
                "(index=%s %s · 원인 %s[%s]: %s)",
                len(points), len(dates), index.id, batch_label,
                worst.kind, worst.code, worst.message,
            )
            warnings.append(_warning(
                _reason_for(worst),
                f"{worst.code}: {worst.message} ({len(failures)}/{len(dates)}일 실패)",
                batch_label,
            ))
        return self._result(index, from_label, to_label, points=points, warnings=warnings)

    @staticmethod
    def _result(index, from_label, to_label, *, points, warnings) -> dict:
        return {
            "index_id": index.id,
            "from": from_label,
            "to": to_label,
            # 값의 단위 — 종목 경로(qty_shares)와 다르다(#1119). 프론트 라벨의 진실원.
            "unit": "amt_eok",
            # 종목별(ka10059)과 달리 불변식 위반 개념이 없어 리스트를 그대로 준다.
            "points": [_investor_point_to_dict(p) for p in points],
            "data_warnings": warnings,
        }


def _investor_point_to_dict(p) -> dict:
    return {
        "t_ms": p.t_ms,
        "foreign_net": p.foreign_net,
        "institution_net": p.institution_net,
    }



def _warning(reason: str, msg: str, batch_label: str) -> dict:
    return make_data_warning(reason, msg, batch=batch_label)


def _reason_for(policy: LiveErrorPolicy) -> str:
    """정책 사유를 **프론트 유니온으로 좁힌다**(ADR-0137 R2·R6).

    `liveIndices.ts` 의 `reason` 은 `'rate_limit_upstream' | 'api_error' |
    'invariant_violation' | 'index_minute_depth_limited'` 로 닫혀 있다. 정책이 내는
    `transport_error`·`auth_error` 를 그대로 실으면 UI 에 매핑이 없어 조용히 버려진다.
    그래서 분류는 접되 **원문은 `msg` 에 남긴다** — 접는 것과 버리는 것은 다르다.

    이전 판은 모든 실패를 `rate_limit_upstream` 으로 보고했다. 네트워크 단절도
    "호출 한도" 로 보였다는 뜻이다.
    """
    return "rate_limit_upstream" if policy.kind == "rate_limit" else "api_error"
