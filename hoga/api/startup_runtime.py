"""Startup runtime orchestration for the FastAPI lifespan."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

TaskOrNone = asyncio.Task | None


def live_startup_enabled_from_env(env: Mapping[str, str] | None = None) -> bool:
    """Whether the app should auto-start Live Capture on boot."""
    source = os.environ if env is None else env
    return source.get("HOGA_LIVE_STARTUP_ENABLED") == "true"


def today_promoter_enabled_from_env(env: Mapping[str, str] | None = None) -> bool:
    """Whether Today Promotion should run in the app lifespan."""
    source = os.environ if env is None else env
    return source.get("HOGA_LIVE_TODAY_PROMOTE_ENABLED", "true").lower() != "false"


def today_promoter_interval_from_env(env: Mapping[str, str] | None = None) -> float:
    """Today Promotion interval in seconds."""
    source = os.environ if env is None else env
    return float(source.get("HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S", "300"))


@dataclass(frozen=True)
class StartupRuntimeDeps:
    env: Mapping[str, str]
    start_scheduler: Callable[[Path], list[asyncio.Task]]
    start_live_stream: Callable[..., Awaitable[bool]]
    start_today_promoter: Callable[..., Awaitable[TaskOrNone]]
    stop_today_promoter: Callable[[TaskOrNone], Awaitable[None]]
    stop_live_stream: Callable[[], Awaitable[None]]
    aclose_kis_capacity_scheduler: Callable[[], Awaitable[None]]
    aclose_kis_client: Callable[[], Awaitable[None]]
    load_symbol_disk_state: Callable[..., None]
    needs_symbol_boot_refresh: Callable[[], bool]
    refresh_symbols: Callable[..., Awaitable[None]]
    resolve_symbol_master_path: Callable[[], Path]
    # 키움 WS 승격 대상 콜백(ADR-0116). 기본 None — 미주입이면 promoter가 키움 루프 skip.
    get_kiwoom_capture_codes: Callable[[], Sequence[str]] | None = None
    # 키움 세션 워치독 30s 루프 스포너(ADR-0118 §5). 기본 None — 미주입이면 미기동.
    start_kiwoom_watchdog: Callable[..., Awaitable[TaskOrNone]] | None = None
    # 캡처 워커 풀 태스크 접근자. 풀은 lifespan 이 start_app_runtime **전에** 띄워
    # captures._workers 에 담으므로 런타임이 핸들을 소유하지 않는다 — 매 호출 때 모듈
    # 속성을 다시 읽어야 하니 리스트가 아니라 콜러블로 받는다. 미주입이면 목록에서 생략.
    get_capture_worker_tasks: Callable[[], Sequence[asyncio.Task]] | None = None
    # 프로그램매매 수집기 태스크 접근자. 라이브 런타임 소유라 라이브 시작/정지에 따라
    # 생겼다 사라진다 — 없으면 "죽음"이 아니라 미기동이므로 목록에서 생략한다.
    get_program_trade_task: Callable[[], TaskOrNone] | None = None


def _task_health(name: str, task: TaskOrNone) -> dict[str, object]:
    """한 태스크의 정직한 상태 한 줄. 판정 근거는 supervised_task_health docstring."""
    if task is None:
        state = "not_started"
    elif task.done():
        state = "dead"
    else:
        state = "running"
    return {"name": name, "running": state == "running", "state": state}


@dataclass
class AppStartupRuntime:
    scheduler_tasks: list[asyncio.Task]
    today_promoter_task: TaskOrNone
    deps: StartupRuntimeDeps
    kiwoom_watchdog_task: TaskOrNone = None

    def supervised_task_health(self) -> list[dict[str, object]]:
        """Honest alive/dead snapshot of each lifespan-owned background task.

        판정은 ADR-0064 의 정직한 health 규칙 — `task is not None and not
        task.done()` — 이고 staleness 휴리스틱이 아니다. `watchlist-daily-loop` 는
        폴링 틱 사이에 자고 있으므로 마지막 활동 시각으로 판정하면 종일 오경보가 난다.
        살아서 자는 태스크는 healthy 로 보고해야 한다. `done()` 인 태스크는 조용히 죽은
        루프(ADR-0064 의 실패 모드)이므로 unhealthy 다.

        **`state` 가 `running` 보다 정보량이 많다.** `running=False` 하나로는 "죽었다"
        와 "애초에 안 띄웠다(env 로 비활성 · 미주입)" 를 구별할 수 없다. 예컨대
        `HOGA_LIVE_TODAY_PROMOTE_ENABLED=false` 면 today-promoter 는 정상인데도
        영구히 `running=False` 다 — 이걸 UI 경보로 쓰면 배너가 상시 켜진다. 그래서
        세 값을 낸다:

        - `running`  — 살아 있음
        - `dead`     — 태스크가 있었고 끝났다(조용한 죽음, **경보 대상**)
        - `not_started` — 핸들이 없다(비활성·미주입, 경보 아님)

        `running` 불리언은 하위호환으로 유지한다(`state == "running"` 과 동의).

        이 태스크들에는 설계상 자동 재시작 감독자가 없다(ADR-0088): 캡처 워커 풀과
        KIS 용량 워커는 자가 치유하고 WS 스트림 워치독이 WS/flush 태스크를 되살리지만,
        일일 루프 · today-promoter · 워치독 자신은 프로세스 재시작으로만 부활한다.
        살아 있음을 노출하는 것이 조용한 죽음을 감지 가능하게 만든다.
        """
        tasks: list[tuple[str, TaskOrNone]] = [
            *((t.get_name(), t) for t in self.scheduler_tasks),
            ("kiwoom-session-watchdog", self.kiwoom_watchdog_task),
            ("today-promoter", self.today_promoter_task),
        ]
        if self.deps.get_capture_worker_tasks is not None:
            tasks.extend((t.get_name(), t) for t in self.deps.get_capture_worker_tasks())
        if self.deps.get_program_trade_task is not None:
            # 라이브가 꺼져 있으면 태스크가 없다 — 미기동을 dead 로 보고하지 않기 위해
            # 아예 목록에서 뺀다(not_started 로 넣으면 경보는 안 나지만 UI 가 "정지"
            # 행을 상시 보여 주게 되어 노이즈다).
            program_trade = self.deps.get_program_trade_task()
            if program_trade is not None:
                tasks.append(("program-trade-collector", program_trade))
        return [_task_health(name, task) for name, task in tasks]

    async def stop(self) -> None:
        """Stop runtime-owned background work in shutdown order."""
        await self.deps.stop_today_promoter(self.today_promoter_task)
        await self.deps.stop_today_promoter(self.kiwoom_watchdog_task)
        await self.deps.stop_live_stream()

        for task in self.scheduler_tasks:
            task.cancel()
        for task in self.scheduler_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("scheduler task crashed during shutdown")

        await self.deps.aclose_kis_capacity_scheduler()
        await self.deps.aclose_kis_client()


async def start_app_runtime(
    data_dir: Path,
    *,
    deps: StartupRuntimeDeps,
) -> AppStartupRuntime:
    """Start scheduler, Live Capture helpers, Today Promotion, and symbol boot refresh."""
    runtime = AppStartupRuntime(
        scheduler_tasks=[],
        today_promoter_task=None,
        deps=deps,
    )
    try:
        runtime.scheduler_tasks = deps.start_scheduler(data_dir)

        if live_startup_enabled_from_env(deps.env):
            await deps.start_live_stream(data_dir=data_dir)

        if deps.start_kiwoom_watchdog is not None:
            runtime.kiwoom_watchdog_task = await deps.start_kiwoom_watchdog()

        if today_promoter_enabled_from_env(deps.env):
            runtime.today_promoter_task = await deps.start_today_promoter(
                data_dir=data_dir,
                get_kiwoom_capture_codes=deps.get_kiwoom_capture_codes,
                interval_s=today_promoter_interval_from_env(deps.env),
            )

        symbol_master_path = deps.resolve_symbol_master_path()
        deps.load_symbol_disk_state(path=symbol_master_path, data_dir=data_dir)
        if deps.needs_symbol_boot_refresh():
            runtime.scheduler_tasks.append(
                asyncio.create_task(
                    deps.refresh_symbols(path=symbol_master_path, data_dir=data_dir),
                    name="symbols-boot-refresh",
                )
            )
    except Exception:
        await runtime.stop()
        raise

    return runtime
