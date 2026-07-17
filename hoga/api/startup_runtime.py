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
    start_live_stream_watchdog: Callable[..., Awaitable[TaskOrNone]]
    start_today_promoter: Callable[..., Awaitable[TaskOrNone]]
    stop_today_promoter: Callable[[TaskOrNone], Awaitable[None]]
    stop_live_stream: Callable[[], Awaitable[None]]
    aclose_kis_capacity_scheduler: Callable[[], Awaitable[None]]
    aclose_kis_client: Callable[[], Awaitable[None]]
    get_active_codes: Callable[[], Sequence[str]]
    load_symbol_disk_state: Callable[..., None]
    needs_symbol_boot_refresh: Callable[[], bool]
    refresh_symbols: Callable[..., Awaitable[None]]
    resolve_symbol_master_path: Callable[[], Path]
    # 키움 WS 승격 대상 콜백(ADR-0116). 기본 None — 미주입이면 promoter가 키움 루프 skip.
    get_kiwoom_capture_codes: Callable[[], Sequence[str]] | None = None
    # 키움 세션 워치독 30s 루프 스포너(ADR-0118 §5). 기본 None — 미주입이면 미기동.
    start_kiwoom_watchdog: Callable[..., Awaitable[TaskOrNone]] | None = None


@dataclass
class AppStartupRuntime:
    scheduler_tasks: list[asyncio.Task]
    live_watchdog_task: TaskOrNone
    today_promoter_task: TaskOrNone
    deps: StartupRuntimeDeps
    kiwoom_watchdog_task: TaskOrNone = None

    def supervised_task_health(self) -> list[dict[str, object]]:
        """Honest alive/dead snapshot of each lifespan-owned background task.

        `running` uses the ADR-0064 honest-health rule — `task is not None and
        not task.done()` — NOT a staleness check. `watchlist-daily-loop` sleeps
        ~23h between fires, so a last-activity signal would false-alarm all day;
        a task that is alive-but-sleeping must report healthy. A `done()` task is
        a silently dead loop (the ADR-0064 failure mode) and reports unhealthy.

        These tasks have no auto-restart supervisor by design (ADR-0088): the
        capture worker pool and KIS capacity workers self-heal, and the WS
        stream watchdog restarts the WS/flush tasks, but the once-a-day loop,
        today-promoter, and the watchdog itself are only revived by a process
        restart. Exposing their liveness makes a silent death detectable.
        """
        tasks: list[tuple[str, TaskOrNone]] = [
            *((t.get_name(), t) for t in self.scheduler_tasks),
            ("live-stream-watchdog", self.live_watchdog_task),
            ("kiwoom-session-watchdog", self.kiwoom_watchdog_task),
            ("today-promoter", self.today_promoter_task),
        ]
        return [
            {"name": name, "running": task is not None and not task.done()}
            for name, task in tasks
        ]

    async def stop(self) -> None:
        """Stop runtime-owned background work in shutdown order."""
        await self.deps.stop_today_promoter(self.today_promoter_task)
        await self.deps.stop_today_promoter(self.live_watchdog_task)
        await self.deps.stop_today_promoter(self.kiwoom_watchdog_task)
        await self.deps.stop_live_stream()

        for task in self.scheduler_tasks:
            task.cancel()
        for task in self.scheduler_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
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
        live_watchdog_task=None,
        today_promoter_task=None,
        deps=deps,
    )
    try:
        runtime.scheduler_tasks = deps.start_scheduler(data_dir)

        if live_startup_enabled_from_env(deps.env):
            await deps.start_live_stream(data_dir=data_dir)

        runtime.live_watchdog_task = await deps.start_live_stream_watchdog(data_dir=data_dir)

        if deps.start_kiwoom_watchdog is not None:
            runtime.kiwoom_watchdog_task = await deps.start_kiwoom_watchdog()

        if today_promoter_enabled_from_env(deps.env):
            runtime.today_promoter_task = await deps.start_today_promoter(
                data_dir=data_dir,
                get_active_codes=deps.get_active_codes,
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
