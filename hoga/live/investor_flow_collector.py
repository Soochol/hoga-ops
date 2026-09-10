"""장중 시장·업종 투자자 순매수 수집기 (ka10051 → investor-flow 스토어).

#1105 가 이 수집기의 존재 이유를 정한다: `ka10064` 는 종목 전용이라 **시장 전체 장중
투자자 시계열의 원천이 없다**. `ka10051` 은 장중 잠정치를 주지만 `base_dt` 스냅샷이라
과거 '시각' 을 소급 조회할 수 없다 — 그래서 우리가 찍어 두지 않으면 그 시각의 값은
영원히 사라진다. **재시작 공백을 메울 방법이 없다**(표시만 가능).

그 성질이 설계를 강제한다:

- **페이지 개방 여부와 무관하게 서버에서 돈다.** 화면 수요에 묶으면 시계열이
  "누가 보고 있었는가" 의 함수가 되어 어떤 구멍도 해석할 수 없게 된다.
- **누적값을 그대로 적재한다**(스토어 계약) — 표본을 놓쳐도 다음 표본이 전체 누적을
  다시 들고 오므로 결손이 해상도 손실이지 정합성 손상이 아니다.
- **10초 폴, 동일 값이면 미기록.** 수신 상태는 별도로 기록하고 읽기 캐시로 반복 파싱을 줄인다.

`run_with_capacity` 는 **1 submit = 1 업스트림 콜**이다(ADR-0137). 두 시장을 한
submit 에 묶으면 버킷은 1 을 세고 벤더는 2 를 센다.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from hoga.live import kiwoom_access
from hoga.live.error_policy import classify_live_error, format_live_error
from hoga.live.flow_receipts import DEFAULT_POLL_INTERVAL_S, FlowReceipts
from hoga.live.investor_flow_store import IntradaySample, InvestorFlowStore, rows_equal
from hoga.live.market_overview import market_investor_row
from hoga.live.session_gate import ws_capture_window_async

log = logging.getLogger(__name__)

# 경로는 `kiwoom_rest.TR` 레지스트리가 안다(ka10051 → PATH_SECT) — 여기서 다시 적지 않는다.
API_ID = "ka10051"
#: 10초 수집. 기존 벤더별 호출 제한기를 공유하며 사이클 소요 시간을 관측한다.
POLL_INTERVAL_S = DEFAULT_POLL_INTERVAL_S

# 시장 구분 — 코스닥은 **별도 콜**이다(실측: mrkt_tp=0 은 코스피 28행, 1 은 코스닥 32행).
MARKETS: tuple[str, ...] = ("0", "1")

# 금액 축(억원). 수량 축은 "1"(천주) — TR 마다 코드표가 다르니(ka10064 는 1=금액)
# 이 상수를 다른 TR 에 옮기지 말 것(#1117).
AMT_QTY_AMOUNT_EOK = "0"
STEX_ALL = "3"


class InvestorFlowCollectorStatus:
    """관측 가능한 상태. **liveness 의 근거가 아니다** — 그건 `task` 핸들뿐이다."""

    def __init__(self) -> None:
        self.running = False
        self.last_cycle_duration_ms: int | None = None
        self.last_sampled_at_ms: int | None = None
        self.last_written_at_ms: int | None = None
        self.skipped_duplicates = 0
        self.last_error: str | None = None
        self.last_error_kind: str | None = None


class InvestorFlowCollector:
    def __init__(
        self,
        *,
        data_dir: Path,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int],
        fetch_market_fn: Callable[[str, str], Awaitable[list[dict[str, Any]] | None]],
        should_collect_fn: Callable[[int], Awaitable[bool]] = ws_capture_window_async,
        poll_interval_s: float = POLL_INTERVAL_S,
    ) -> None:
        self.store = InvestorFlowStore(data_dir)
        self.receipts = FlowReceipts(Path(data_dir) / "investor-flow", poll_interval_s)
        self._date_fn = date_fn
        self._now_ms_fn = now_ms_fn
        self._fetch_market_fn = fetch_market_fn
        self._should_collect_fn = should_collect_fn
        self._poll_interval_s = poll_interval_s
        self.status = InvestorFlowCollectorStatus()
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
        self._task = asyncio.create_task(self._loop(), name="investor-flow-collector")
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
            started = asyncio.get_running_loop().time()
            try:
                await self.run_once()
            except Exception as e:  # noqa: BLE001 — 수집 루프의 감독자. 한 사이클의 어떤
                # 예외도 루프를 죽이면 안 된다(죽으면 수집이 조용히 멈춘다). 삼키는 게
                # 아니라 분류해 상태로 노출한다.
                self._record_cycle_error(e)
            elapsed = asyncio.get_running_loop().time() - started
            self.status.last_cycle_duration_ms = round(elapsed * 1000)
            try:
                await asyncio.to_thread(
                    self.receipts.cycle_completed, self._now_ms_fn(), self.status.last_cycle_duration_ms,
                )
            except OSError as exc:
                self._record_cycle_error(exc)
            elapsed = asyncio.get_running_loop().time() - started
            await asyncio.sleep(max(self._poll_interval_s - elapsed, 0.1))

    async def run_once(self) -> None:
        now_ms = self._now_ms_fn()
        if not await self._should_collect_fn(now_ms):
            return
        date = self._date_fn()
        self.status.last_sampled_at_ms = now_ms

        try:
            await asyncio.to_thread(self.receipts.begin, date, now_ms, ["KOSPI", "KOSDAQ"])
        except OSError as exc:
            self._record_cycle_error(exc)  # receipt persistence must not stop raw capture
        for mrkt_tp, key in zip(MARKETS, ["KOSPI", "KOSDAQ"], strict=True):
            try:
                self.receipts.attempt(key, self._now_ms_fn())
                try:
                    rows = await self._fetch_market_fn(mrkt_tp, date)
                except Exception as exc:  # noqa: BLE001 — isolate one market, preserve policy kind
                    self.receipts.failure(key, self._now_ms_fn(), classify_live_error(exc).kind)
                    continue
                received_ms = self._now_ms_fn()
                got = market_investor_row(rows or [])
                if got is None or got[0] != key or any(v is None for v in got[1].values()):
                    self.receipts.failure(key, received_ms, "data_quality")
                    continue
                assert rows is not None
                try:
                    written = await asyncio.to_thread(self._write_sample, date, mrkt_tp, rows, received_ms)
                except Exception as exc:  # noqa: BLE001 — isolate persistence failure
                    self.receipts.failure(key, received_ms, "storage")
                    self._record_cycle_error(exc)
                    continue
                self.receipts.success(key, received_ms, written=written)
            finally:
                try:
                    await asyncio.to_thread(self.receipts.save, self._now_ms_fn())
                except OSError as exc:
                    self._record_cycle_error(exc)

    def _write_sample(self, date: str, mrkt_tp: str, rows: list[dict[str, Any]], now_ms: int) -> bool:
        if rows_equal(self.store.last_sample(date, mrkt_tp), rows):
            self.status.skipped_duplicates += 1
            return False
        self.store.append_sample(date, IntradaySample(
            sampled_at_ms=now_ms, poll_interval_ms=int(self._poll_interval_s * 1000),
            request={"mrkt_tp": mrkt_tp, "amt_qty_tp": AMT_QTY_AMOUNT_EOK,
                     "base_dt": date, "stex_tp": STEX_ALL}, rows=rows,
        ))
        self.status.last_written_at_ms = now_ms
        return True

    def _record_cycle_error(self, exc: Exception) -> None:
        policy = classify_live_error(exc, internal=True)
        self.status.last_error = format_live_error(exc)
        self.status.last_error_kind = policy.kind
        log.warning(
            "investor_flow.collector.cycle_failed kind=%s error=%s",
            policy.kind,
            self.status.last_error,
        )


def make_kiwoom_fetch(scheduler: Any, client: Any) -> Callable[[str, str], Awaitable[list[dict[str, Any]] | None]]:
    """거버너를 거치는 실 fetch. **1 submit = 1 콜** — 두 시장을 묶지 않는다.

    예외는 호출자가 시장별로 분류한다. 확정 수렴도 호출 경계에서 실패를 처리한다.
    """

    async def _fetch(mrkt_tp: str, date: str) -> list[dict[str, Any]] | None:
        body = {
            "mrkt_tp": mrkt_tp,
            "amt_qty_tp": AMT_QTY_AMOUNT_EOK,
            "base_dt": date,
            "stex_tp": STEX_ALL,
        }
        page = await kiwoom_access.run_with_capacity(
            scheduler,
            key=("investor-flow", mrkt_tp, date),
            api_id=API_ID,
            priority="background",
            client=client,
            # 기본인자 바인딩 — late binding 이면 모든 호출이 마지막 값을 본다.
            fetch_fn=lambda c, b=body: c.call(API_ID, b),
        )
        return list(getattr(page, "rows", []) or [])

    return _fetch
