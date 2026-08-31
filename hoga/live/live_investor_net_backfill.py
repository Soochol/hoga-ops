from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from datetime import date
from typing import Protocol

from hoga.live import kiwoom_access, kiwoom_investor, kiwoom_rest_runtime
from hoga.live.kiwoom_capacity import Priority
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache
from hoga.live.single_flight import SingleFlight


class KiwoomRestScheduler(Protocol):
    """거버너 계약. PR-E(#1041)로 키움을 쓰면서 **계정 차원이 사라졌다** —
    `endpoint`/`cooldown_scope` 대신 `api_id` 가 버킷 키다(#1015)."""

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[], Awaitable],
    ): ...


Walkback = Callable[
    ...,
    Awaitable[dict],
]


class LiveInvestorNetBackfill:
    """Owns Live Investor Net scheduled fetch shape and row conversion."""

    def __init__(
        self,
        *,
        data_dir,
        cache: PastDailyCandlesCache,
        scheduler: KiwoomRestScheduler,
        walkback: Walkback,
        axis: str = kiwoom_investor.AMT_QTY_QUANTITY,
    ) -> None:
        self._data_dir = data_dir
        self._cache = cache
        # 축은 인스턴스 차원이다 — `collect` 도크스트링이 이유를 적는다.
        self._axis = axis
        self._scheduler = scheduler
        self._walkback = walkback
        # Coalesce concurrent same-code cold walk-backs (see single_flight.py):
        # overlapping [from, today] requests share one KIS fetch instead of each
        # walking the background lane independently (the 60–100s storm).
        self._inflight = SingleFlight()

    async def collect(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
    ) -> dict:
        """축은 **인스턴스가 든다**(`self._axis`) — 호출 인자가 아니다.

        캐시가 인스턴스마다 하나라서 그렇다. 축을 인자로 받으면 한 캐시에 두 축의
        배치가 섞여 들어가고, 키에 축이 없으므로 **수량 배치가 금액 요청에 그대로
        응답한다** — 값이 그럴듯해서 화면에서도 안 드러난다.
        """
        async def fetch_batch(code_: str, from_s: str, to_s: str):
            # PR-E(#1041) 칼 컷오버 — 소스는 키움 ka10059 다. 계정 차원(cooldown_scope·
            # data_dir)은 사라졌다: 키움 유량은 TR별이라 고를 계정이 없다(#1015).
            client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
            if client is None:
                return [], [], None
            def _run_page(fetch_fn, page_idx: int):
                """페이지 1장 = 거버너 submit 1건.

                **walk 전체를 감싸던 자리다.** 거버너는 submit 진입 전에 버킷을 한 번만
                소비하므로, 바깥에서 감싸면 커서 walk 의 페이지 N장이 페이싱을 못 받는다
                (ADR-0137). 이중 감싸기도 금지 — 바깥이 토큰을 쥔 채 안쪽이 같은 버킷을
                기다려 자기를 굶긴다.
                """
                return kiwoom_access.run_with_capacity(
                    self._scheduler,   # 주입된 거버너 — 테스트가 갈아끼우는 이음매다
                    # 축이 키에 든다 — 빠지면 두 축의 같은 구간이 서로를 중복제거한다.
                    key=("live-investor-net", self._axis, code_, from_s, to_s, page_idx),
                    api_id="ka10059",
                    priority="background",
                    client=client,
                    fetch_fn=fetch_fn,
                )

            result = await kiwoom_investor.fetch_investor_net(
                client, code_, from_s, to_s, axis=self._axis, run_page=_run_page,
            )
            # 세 번째 칸(`covered_to`)은 `None` 이다 — `ka10059` 커서는 `to` 상대라
            # 요청 구간 밖을 받지 않는다. 일봉만 기준일에서 걸어 내려오며 넓게
            # 받는다(#1228).
            return (
                [_investor_point_to_dict(p) for p in result.points],
                result.violations,
                None,
            )

        async with self._inflight.acquire(code):
            return await self._walkback(
                cache=self._cache,
                fetch_batch=fetch_batch,
                output_key="points",
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
            )


def _investor_point_to_dict(p) -> dict:
    """종목 경로 직렬화. **지수 경로에는 같은 이름의 사본이 따로 있다**
    (`live_index_investor_net.py`) — 그쪽은 주체 분해가 없어 이 키를 싣지 않는다.
    합치지 않는 이유가 그 비대칭이다.
    """
    return {
        "t_ms": p.t_ms,
        "foreign_net": p.foreign_net,
        "institution_net": p.institution_net,
        # 캐시에 그대로 들어가는 dict 다 — 모델 객체를 넣으면 JSON 직렬화가 깨진다.
        "breakdown": p.breakdown.model_dump() if p.breakdown is not None else None,
    }
