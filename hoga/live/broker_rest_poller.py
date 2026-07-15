"""거래원(회원사) REST 폴러 — live_set 종목의 거래원 데이터를 KIS REST로 수집.

WS 등록 상한(연결당 41, ADR-0101) 압박을 풀기 위해 거래원 TR(H0STMBC0)을 WS 구독에서
빼고(ADR-0111) 그 자리를 이 폴러가 메운다. 종목당 WS TR이 3→2로 줄어 계좌당 수용이
13→19종목으로 늘어난다.

설계 핵심 — **기존 저장 경로 무변경**: fetch_brokers 결과를 `_parse_member`(ws_frames.py)와
byte-identical한 합성 `WsTick(kind=BROKER)`로 만들어 스트림의 `on_tick`에 주입한다. 데이터가
LiveBuffer 표시 → 다운샘플러(BROKER last-wins, 10초 창) → JSONL(live root) → promote →
kis_live/brokers.parquet의 **동일 파이프라인**을 타므로 /api/brokers/series·거래원등장 마커·
사이드바 카드 등 소비자는 한 줄도 바뀌지 않는다.

parity 세부:
- 게이트 = 거래일(캘린더 SSOT) && target_ws_venue=='KRX'(08:50–15:31). 거래원 TR은 KRX
  전용이라 WS 시절에도 이 창에서만 프레임이 도착했다. 저장 컷오프(정규장 09:00–15:30)는
  스트림의 `_gate_open`이 자동 처리하므로 여기서 재구현하지 않는다.
- payload 키 순서는 `_parse_member`와 일치(code, t_ms, sell_top, buy_top) — JSONL byte-parity.
- H0STMBC0엔 시간 필드가 없어 WS도 수신 시각(now_ms)을 썼다. REST도 응답 수신 시각을 쓴다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from hoga.live.error_policy import classify_live_error, format_live_error
from hoga.live.kis_models import KisBrokers
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import WsTick

_log = logging.getLogger(__name__)

# rest30_recorder와 동일한 이탈 임계(설계상 정상 바운스율 ~9-12%, ADR-0100 위 여유).
_BOUNCE_RATE_ANOMALY = 0.25
_ANOMALY_CONSECUTIVE = 2

# 폴링 주기(초). 사용자 결정(2026-07-15): 30초 — REST 예산 절약 우선. 76종목@30s=2.5 req/s
# (4키 합산 ~53/s의 5%). 다운샘플러가 어차피 10초 창 last-wins라, 30초 주기는 거래원등장
# 마커/사이드바 갱신의 시간 해상도를 최대 30초로 만든다(수용, ADR-0111).
BROKER_POLL_INTERVAL_S = 30.0

# 코드 간 동시 fetch 상한(코드 내부 순차). 실제 콜레이트는 계정별 토큰버킷이 클램프하므로
# 게이트를 채우기 충분한 in-flight면 된다(rest30_recorder와 동일 논리).
_DEFAULT_CONCURRENCY = 10


@runtime_checkable
class KisBrokerFetchProto(Protocol):
    async def fetch_brokers(self, code: str) -> KisBrokers: ...


def brokers_to_ws_tick(brokers: KisBrokers, *, now_ms: int) -> WsTick:
    """KisBrokers(REST) → 합성 WsTick(kind=BROKER). `_parse_member`(ws_frames.py)와
    payload 키·순서가 동일해 저장 JSONL이 byte-identical하다(소비자 무변경 계약의 근거).

    ⚠ rest_buffer_build.brokers_to_snapshot을 재사용하지 않는 이유: 그건 payload에 'phase'
    키를 주입하고 LiveSnapshot을 반환한다(표시 전용 계약). WS member 틱은 phase가 없고
    (다운샘플러 flush가 저장 시점에 박음), 여기선 그 무-phase 형태를 정확히 재현해야 한다.
    """
    payload = {
        "code": brokers.code,
        "t_ms": now_ms,  # H0STMBC0엔 시간 필드 없음 — 수신 시각 사용(_parse_member 미러)
        "sell_top": [{"name": e.name, "qty": e.qty} for e in brokers.sell_top],
        "buy_top": [{"name": e.name, "qty": e.qty} for e in brokers.buy_top],
    }
    return WsTick(
        code=brokers.code, t_ms=now_ms, kind=SnapshotKind.BROKER, payload=payload
    )


@dataclass(frozen=True)
class BrokerPollStatus:
    running: bool
    target_count: int
    targets: tuple[str, ...]
    last_cycle_ms: int | None
    last_cycle_duration_ms: int | None
    last_error: str | None
    last_error_kind: str | None
    last_error_code: str | None
    last_error_count: int
    degraded: bool
    backoff_remaining: int
    # 직전 사이클에 관측된 EGW00201 바운스 수(프로세스 전역 델타 — rest30와 동일 의미).
    rate_limit_bounces: int | None


class BrokerRestPoller:
    """live_set 거래원 데이터를 KIS REST로 폴링해 스트림 on_tick에 주입한다.

    set_targets(codes) : 폴링 대상(= live_set) 관리 — lifecycle이 start/refresh 시 동기화.
    start() / stop()   : asyncio task 생명주기.
    alive              : task 생사(ADR-0064 정직 health).
    status()           : 관측 스냅샷.
    """

    def __init__(
        self,
        *,
        kis_resolver: Callable[[], KisBrokerFetchProto | None],
        dispatch_fn: Callable[[WsTick], Awaitable[None]],
        now_ms_fn: Callable[[], int] | None = None,
        trading_day_fn: Callable[[], bool] | None = None,
        venue_fn: Callable[[], str] | None = None,
        interval_s: float = BROKER_POLL_INTERVAL_S,
        concurrency: int = _DEFAULT_CONCURRENCY,
        backoff_cycles: int = 3,
        bounce_counter_fn: Callable[[], int] | None = None,
    ) -> None:
        self._resolve_kis = kis_resolver
        self._dispatch = dispatch_fn
        self._now_ms = now_ms_fn or (lambda: int(time.time() * 1000))
        # 거래일 게이트(캘린더 SSOT) — 비거래일 폴링 금지. blocking 계약이라 to_thread 봉인.
        self._trading_day_fn = trading_day_fn or self._default_trading_day_fn
        # venue 게이트(순수 시계) — 거래원 TR KRX 전용이라 KRX 창(08:50–15:31)에만 폴링.
        self._venue_fn = venue_fn or self._default_venue_fn
        self._bounce_counter_fn = bounce_counter_fn or self._default_bounce_counter_fn
        self._interval_s = interval_s
        self._concurrency = max(1, concurrency)
        self._backoff_cycles = max(0, backoff_cycles)

        self._targets: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        self._last_cycle_ms: int | None = None
        self._last_cycle_duration_ms: int | None = None
        self._last_error: str | None = None
        self._last_error_kind: str | None = None
        self._last_error_code: str | None = None
        self._last_error_count = 0
        self._backoff_remaining = 0
        self._last_cycle_bounces: int | None = None
        self._anomaly_streak = 0

    def _default_trading_day_fn(self) -> bool:
        from hoga.live.session_gate import is_trading_day_now  # noqa: PLC0415

        return is_trading_day_now(self._now_ms())

    def _default_venue_fn(self) -> str:
        from hoga.live.session_gate import target_ws_venue  # noqa: PLC0415

        return target_ws_venue(self._now_ms())

    def _default_bounce_counter_fn(self) -> int:
        from hoga.live.kis_client import rate_limit_bounces_total  # noqa: PLC0415

        return rate_limit_bounces_total()

    # ── Public interface ─────────────────────────────────────────────────────────

    def set_targets(self, codes: set[str]) -> None:
        self._targets = set(codes)

    @property
    def alive(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> BrokerPollStatus:
        return BrokerPollStatus(
            running=self.alive,
            target_count=len(self._targets),
            targets=tuple(sorted(self._targets)),
            last_cycle_ms=self._last_cycle_ms,
            last_cycle_duration_ms=self._last_cycle_duration_ms,
            last_error=self._last_error,
            last_error_kind=self._last_error_kind,
            last_error_code=self._last_error_code,
            last_error_count=self._last_error_count,
            degraded=self._last_error_count > 0,
            backoff_remaining=self._backoff_remaining,
            rate_limit_bounces=self._last_cycle_bounces,
        )

    def start(self) -> None:
        if self.alive:
            return
        self._task = asyncio.create_task(
            self._run_loop(), name="live-broker-poller"
        )

    async def stop(self) -> None:
        if self._task is None or self._task.done():
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    # ── Loop ───────────────────────────────────────────────────────────────────

    async def _run_loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except Exception as e:
                self._record_cycle_error(e)
            await asyncio.sleep(self._next_delay_s())

    def _next_delay_s(self) -> float:
        """다음 벽시계 interval 경계까지의 지연(초). rest30_recorder._next_delay_s 미러 —
        사이클 시작을 경계에 정렬해 위상 밀림을 없앤다."""
        now_s = self._now_ms() / 1000.0
        return self._interval_s - (now_s % self._interval_s)

    def _mark_cycle_complete(self, cycle_start_ms: int) -> None:
        self._last_cycle_ms = self._now_ms()
        self._last_cycle_duration_ms = self._last_cycle_ms - cycle_start_ms

    def _clear_error(self) -> None:
        self._last_error = None
        self._last_error_kind = None
        self._last_error_code = None
        self._last_error_count = 0

    def _record_cycle_error(self, exc: Exception) -> None:
        policy = classify_live_error(exc, internal=True)
        self._last_error = format_live_error(exc)
        self._last_error_kind = policy.kind
        self._last_error_code = policy.code
        self._last_error_count = 1
        self._backoff_remaining = max(self._backoff_remaining, policy.backoff_cycles)
        if policy.include_traceback:
            _log.error(
                "live.broker_poll.cycle_failed kind=%s error=%s",
                policy.kind, policy.code, exc_info=True,
            )
        else:
            _log.warning(
                "live.broker_poll.cycle_failed kind=%s error=%s",
                policy.kind, policy.code,
            )

    def _record_cycle_bounces(self, bounces: int, dispatched: int) -> None:
        """사이클 EGW00201 바운스 델타를 관측에 반영(rest30_recorder 미러). 개별 바운스는
        kis_client에서 DEBUG로 강등됐고, 신호는 여기서 율로 집계한다."""
        self._last_cycle_bounces = bounces
        rate = bounces / dispatched if dispatched else 0.0
        if bounces > 0:
            _log.info(
                "live.broker_poll.cycle_done targets=%d bounces=%d (%.1f%%) duration_ms=%s",
                dispatched, bounces, rate * 100.0, self._last_cycle_duration_ms,
            )
        else:
            _log.debug(
                "live.broker_poll.cycle_done targets=%d bounces=0 duration_ms=%s",
                dispatched, self._last_cycle_duration_ms,
            )
        if rate > _BOUNCE_RATE_ANOMALY:
            self._anomaly_streak += 1
            if self._anomaly_streak >= _ANOMALY_CONSECUTIVE:
                _log.warning(
                    "live.broker_poll.rate_limit_anomaly rate=%.1f%% cycles=%d targets=%d",
                    rate * 100.0, self._anomaly_streak, dispatched,
                )
        else:
            self._anomaly_streak = 0

    async def poll_once(self) -> None:
        cycle_start_ms = self._now_ms()
        if self._backoff_remaining > 0:
            self._backoff_remaining -= 1
            self._mark_cycle_complete(cycle_start_ms)
            return

        # 거래일 게이트(캘린더 SSOT, blocking 계약이라 to_thread 봉인). 비거래일 폴링 금지.
        is_trading = await asyncio.to_thread(self._trading_day_fn)
        if not is_trading:
            self._mark_cycle_complete(cycle_start_ms)
            self._clear_error()
            return

        # venue 게이트(순수 시계): 거래원 TR은 KRX 전용 — WS 시절에도 KRX 구독창
        # (08:50–15:31)에만 member 프레임이 도착했다. 그 밖(NXT 시간대)엔 폴링 안 함.
        if self._venue_fn() != "KRX":
            self._mark_cycle_complete(cycle_start_ms)
            self._clear_error()
            return

        targets = sorted(self._targets)
        if not targets:
            self._mark_cycle_complete(cycle_start_ms)
            self._clear_error()
            return

        kis = self._resolve_kis()
        if kis is None:
            self._mark_cycle_complete(cycle_start_ms)
            self._last_error = "kis_unavailable"
            self._last_error_kind = "auth"
            self._last_error_code = "kis_unavailable"
            self._last_error_count = 1
            return

        sem = asyncio.Semaphore(self._concurrency)

        async def _run_one(code: str) -> tuple[str, Exception | None]:
            async with sem:
                try:
                    brokers = await kis.fetch_brokers(code)
                    # 수신 시각을 t_ms로(_parse_member 미러). 코드별로 응답 완료 시점.
                    tick = brokers_to_ws_tick(brokers, now_ms=self._now_ms())
                    await self._dispatch(tick)
                    return code, None
                except Exception as e:  # noqa: BLE001
                    return code, e

        # EGW00201 바운스 델타(프로세스 전역 — rest30와 동일 근사).
        bounces_before = self._bounce_counter_fn()
        results = await asyncio.gather(*(_run_one(code) for code in targets))
        cycle_bounces = self._bounce_counter_fn() - bounces_before

        error_count = 0
        last_error: str | None = None
        last_error_kind: str | None = None
        last_error_code: str | None = None
        for code, err in results:
            if err is None:
                continue
            policy = classify_live_error(err)
            error_count += 1
            last_error = format_live_error(err)
            last_error_kind = policy.kind
            last_error_code = policy.code
            if policy.backoff_cycles > 0:
                self._backoff_remaining = max(
                    self._backoff_remaining,
                    max(self._backoff_cycles, policy.backoff_cycles),
                )
            if policy.include_traceback:
                _log.error(
                    "live.broker_poll.code_failed code=%s kind=%s error=%s",
                    code, policy.kind, policy.code, exc_info=err,
                )
            else:
                _log.warning(
                    "live.broker_poll.api_code_failed code=%s kind=%s error=%s",
                    code, policy.kind, policy.code,
                )

        self._mark_cycle_complete(cycle_start_ms)
        self._record_cycle_bounces(cycle_bounces, len(targets))
        self._last_error = last_error
        self._last_error_kind = last_error_kind
        self._last_error_code = last_error_code
        self._last_error_count = error_count
