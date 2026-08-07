"""파생 투자자 수급 수집기 (KIS `FHPTJ04030000` → deriv-flow 스토어).

존재 이유는 주식 수집기(#1105)와 같다: **이 값은 소급 조회가 불가능하다.** 이 TR 은
당일 누적 스냅샷이라 과거 '시각' 을 다시 부를 수 없고, 일별 확정본 경로도 파생에는
없다(`FHPTJ04040000` 의 시장구분은 KSP/KSQ 뿐). 우리가 찍어 두지 않으면 그 시각의
값은 영원히 사라진다.

그 성질이 거는 제약도 같다:

- **페이지 개방 여부와 무관하게 서버에서 돈다.** 화면 수요에 묶으면 시계열이
  "누가 보고 있었는가" 의 함수가 되어 어떤 구멍도 해석할 수 없다.
- **누적값을 그대로 적재한다** — 표본을 놓쳐도 다음 표본이 전체 누적을 다시 들고 온다.
- **60초 폴, 동일 값이면 미기록.**

주식 수집기와 **다른 점 둘**:

1. **세션이 15:45 까지다**(주식 15:30). `deriv_capture_window` 를 쓴다.
2. **단위를 검산한다**(`deriv_flow_units`). 벤더가 단위를 말해 주지 않고 문서로도
   확정되지 않아서, 선물 표본에서 역산해 상태로 노출한다. 판정과 무관하게 **원값은
   항상 저장한다** — 저장을 미루면 그 시각이 영영 사라지기 때문이다. 환산을 거부하는
   것은 읽기 경로의 몫이다.

상품 7개는 각각 별도 콜이다. 묶을 방법이 없다 — 이 TR 은 요청 하나가 시장 하나를 답한다.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from hoga.live.deriv_flow_products import BY_KEY, PRODUCTS, UNIT_PROBE_KEY
from hoga.live.deriv_flow_store import DerivFlowStore, DerivSample, rows_equal
from hoga.live.deriv_flow_units import UnitVerdict, infer_units
from hoga.live.error_policy import classify_live_error, format_live_error
from hoga.live.session_gate import deriv_capture_window_async

log = logging.getLogger(__name__)

API_ID = "FHPTJ04030000"
POLL_INTERVAL_S = 60.0


class DerivFlowCollectorStatus:
    """관측 가능한 상태. **liveness 의 근거가 아니다** — 그건 `task` 핸들뿐이다."""

    def __init__(self) -> None:
        self.running = False
        self.last_sampled_at_ms: int | None = None
        self.last_written_at_ms: int | None = None
        self.skipped_duplicates = 0
        self.last_error: str | None = None
        self.last_error_kind: str | None = None
        #: 마지막 단위 판정. 미확정이면 화면이 환산을 못 한다는 뜻이라 관측 대상이다.
        self.units: UnitVerdict | None = None


class DerivFlowCollector:
    def __init__(
        self,
        *,
        data_dir: Path,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int],
        fetch_fn: Callable[[str, str], Awaitable[dict[str, Any] | None]],
        should_collect_fn: Callable[[int], Awaitable[bool]] = deriv_capture_window_async,
        poll_interval_s: float = POLL_INTERVAL_S,
    ) -> None:
        self.store = DerivFlowStore(data_dir)
        self._date_fn = date_fn
        self._now_ms_fn = now_ms_fn
        self._fetch_fn = fetch_fn
        self._should_collect_fn = should_collect_fn
        self._poll_interval_s = poll_interval_s
        self.status = DerivFlowCollectorStatus()
        self._task: asyncio.Task | None = None

    @property
    def task(self) -> asyncio.Task | None:
        """실행 태스크 핸들 — ADR-0088 정직한 liveness 판정의 유일한 근거.

        `status.running` 은 기동 *의도* 만 뜻하고 태스크 사망을 반영하지 않는다.
        """
        return self._task

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="deriv-flow-collector")
        self.status.running = True

    async def stop(self) -> None:
        task = self._task
        self.status.running = False
        if task is not None and not task.done():
            task.cancel()
            try:  # noqa: SIM105 — teardown/idempotent close — 예외 무시가 의도
                await task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _loop(self) -> None:
        """**퍼페추얼 루프다** — 정상 반환이 곧 조용한 죽음이므로 `ONE_SHOT_TASK_NAMES`
        에 넣으면 안 된다(ADR-0064)."""
        while True:
            try:
                await self.run_once()
            except Exception as e:  # noqa: BLE001 — 수집 루프의 감독자. 한 사이클의 어떤
                # 예외도 루프를 죽이면 안 된다(죽으면 수집이 조용히 멈춘다). 삼키는 게
                # 아니라 분류해 상태로 노출한다.
                self._record_cycle_error(e)
            await asyncio.sleep(self._poll_interval_s)

    async def run_once(self) -> None:
        now_ms = self._now_ms_fn()
        if not await self._should_collect_fn(now_ms):
            return
        date = self._date_fn()
        self.status.last_sampled_at_ms = now_ms

        for product in PRODUCTS:
            row = await self._fetch_fn(product.iscd, product.key)
            if row is None:
                # 한 상품만 실패하면 그 상품의 줄만 빠진다 — 커버리지가 비대칭을
                # 그대로 드러내므로 여기서 억지로 메우지 않는다.
                continue
            if product.key == UNIT_PROBE_KEY:
                self._probe_units(row)
            prev = self.store.last_sample(date, product.key)
            if rows_equal(prev, row):
                self.status.skipped_duplicates += 1
                continue
            self.store.append_sample(
                date,
                DerivSample(
                    sampled_at_ms=now_ms,
                    product=product.key,
                    request={"fid_input_iscd": product.iscd, "fid_input_iscd_2": product.key},
                    row=row,
                ),
            )
            self.status.last_written_at_ms = now_ms

    def _probe_units(self, row: dict[str, Any]) -> None:
        """선물 표본으로 단위를 역산해 상태에 싣는다.

        **저장을 막지 않는다.** 판정이 안 서도(장 초반 거래량 부족) 원값은 그대로
        쌓여야 한다 — 이 시각은 다시 못 부른다. 대신 판정이 뒤집히거나 모델 밖으로
        나가면 시끄럽게 남긴다: 조용히 넘기면 그게 #1117 이다.
        """
        probe = BY_KEY[UNIT_PROBE_KEY]
        if probe.multiplier_won is None:  # pragma: no cover — 상품표가 뒤집히면
            return
        verdict = infer_units(row, multiplier_won=probe.multiplier_won)
        prev = self.status.units
        self.status.units = verdict
        if verdict.quantity is not None and verdict.amount is None:
            log.warning("deriv_flow.units.unmatched %s", verdict.reason)
        elif prev is not None and prev.resolved and verdict.resolved and (
            prev.quantity != verdict.quantity or prev.amount != verdict.amount
        ):
            log.warning(
                "deriv_flow.units.changed prev=(%s,%s) now=(%s,%s) %s",
                prev.quantity, prev.amount, verdict.quantity, verdict.amount, verdict.reason,
            )
        elif verdict.resolved and (prev is None or not prev.resolved):
            log.info("deriv_flow.units.resolved %s", verdict.reason)

    def _record_cycle_error(self, exc: Exception) -> None:
        policy = classify_live_error(exc, internal=True)
        self.status.last_error = format_live_error(exc)
        self.status.last_error_kind = policy.kind
        log.warning(
            "deriv_flow.collector.cycle_failed kind=%s error=%s",
            policy.kind,
            self.status.last_error,
        )


def make_kis_fetch(client: Any) -> Callable[[str, str], Awaitable[dict[str, Any] | None]]:
    """실 KIS 클라이언트에 결선된 fetch.

    거버너를 따로 두지 않는 이유: KisClient 는 계정별 토큰버킷을 **자체 보유**한다
    (`kis_runtime._account_rate_limiter`). 키움처럼 `run_with_capacity` 로 감싸면
    유량 회계가 두 곳으로 갈린다.

    실패를 `None` 으로 접는다: 한 사이클의 한 상품 실패는 다음 폴에서 회복되고,
    누적값을 저장하므로 놓친 표본이 정합성을 깨지 않는다.
    """

    async def _fetch(iscd: str, iscd2: str) -> dict[str, Any] | None:
        try:
            return await client.fetch_market_investor(iscd, iscd2)
        except Exception as e:  # noqa: BLE001 — 폴 1회 실패는 다음 주기에 회복된다.
            log.debug("deriv_flow.fetch_failed iscd=%s iscd2=%s error=%s", iscd, iscd2, e)
            return None

    return _fetch
