from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest


def test_startup_runtime_env_defaults_are_safe() -> None:
    from hoga.api.startup_runtime import (
        live_startup_enabled_from_env,
        today_promoter_enabled_from_env,
        today_promoter_interval_from_env,
    )

    env: dict[str, str] = {}

    assert live_startup_enabled_from_env(env) is False
    assert today_promoter_enabled_from_env(env) is True
    assert today_promoter_interval_from_env(env) == 300.0


def test_startup_runtime_env_accepts_explicit_overrides() -> None:
    from hoga.api.startup_runtime import (
        live_startup_enabled_from_env,
        today_promoter_enabled_from_env,
        today_promoter_interval_from_env,
    )

    env = {
        "HOGA_LIVE_STARTUP_ENABLED": "true",
        "HOGA_LIVE_TODAY_PROMOTE_ENABLED": "false",
        "HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S": "42.5",
    }

    assert live_startup_enabled_from_env(env) is True
    assert today_promoter_enabled_from_env(env) is False
    assert today_promoter_interval_from_env(env) == 42.5


@pytest.mark.asyncio
async def test_startup_runtime_starts_safe_default_tasks(tmp_path: Path) -> None:
    from hoga.api.startup_runtime import StartupRuntimeDeps, start_app_runtime

    calls: list[Any] = []

    async def noop_task() -> None:
        await asyncio.sleep(3600)

    def start_scheduler(data_dir: Path) -> list[asyncio.Task]:
        calls.append(("scheduler", data_dir))
        return [asyncio.create_task(noop_task(), name="watchlist-daily-loop")]

    async def start_live_stream(*, data_dir: Path) -> bool:
        calls.append(("live", data_dir))
        return True

    async def start_live_stream_watchdog(*, data_dir: Path) -> asyncio.Task | None:
        calls.append(("watchdog", data_dir))
        return None

    async def start_today_promoter(**kwargs: Any) -> asyncio.Task | None:
        calls.append(("promoter", kwargs["data_dir"], kwargs["interval_s"]))
        return None

    def load_symbol_disk_state(**kwargs: Any) -> None:
        calls.append(("symbols-load", kwargs["data_dir"]))

    async def refresh_symbols(**kwargs: Any) -> None:
        calls.append(("symbols-refresh", kwargs["data_dir"]))

    runtime = await start_app_runtime(
        tmp_path,
        deps=StartupRuntimeDeps(
            env={},
            start_scheduler=start_scheduler,
            start_live_stream=start_live_stream,
            start_live_stream_watchdog=start_live_stream_watchdog,
            start_today_promoter=start_today_promoter,
            stop_today_promoter=lambda task: _record_async(calls, "stop-promoter", task),
            stop_live_stream=lambda: _record_async(calls, "stop-live", None),
            aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-kis-capacity", None),
            aclose_kis_client=lambda: _record_async(calls, "close-kis", None),
            get_active_codes=lambda: ["005930"],
            load_symbol_disk_state=load_symbol_disk_state,
            needs_symbol_boot_refresh=lambda: False,
            refresh_symbols=refresh_symbols,
            resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
        ),
    )

    await runtime.stop()

    assert ("live", tmp_path) not in calls
    assert ("scheduler", tmp_path) in calls
    assert ("watchdog", tmp_path) in calls
    assert ("promoter", tmp_path, 300.0) in calls
    assert ("symbols-load", tmp_path) in calls
    assert not any(call[0] == "symbols-refresh" for call in calls)
    assert ("stop-promoter", None) in calls
    assert ("stop-live", None) in calls
    assert ("close-kis-capacity", None) in calls
    assert ("close-kis", None) in calls
    assert calls.index(("close-kis-capacity", None)) < calls.index(("close-kis", None))


@pytest.mark.asyncio
async def test_startup_runtime_can_opt_into_live_and_symbol_refresh(tmp_path: Path) -> None:
    from hoga.api.startup_runtime import StartupRuntimeDeps, start_app_runtime

    calls: list[Any] = []

    async def noop_task() -> None:
        return None

    def start_scheduler(data_dir: Path) -> list[asyncio.Task]:
        calls.append(("scheduler", data_dir))
        return []

    async def start_live_stream(*, data_dir: Path) -> bool:
        calls.append(("live", data_dir))
        return True

    async def start_live_stream_watchdog(*, data_dir: Path) -> asyncio.Task | None:
        calls.append(("watchdog", data_dir))
        return None

    async def start_today_promoter(**kwargs: Any) -> asyncio.Task | None:
        calls.append(("promoter", kwargs["interval_s"]))
        return None

    def load_symbol_disk_state(**kwargs: Any) -> None:
        calls.append(("symbols-load", kwargs["path"]))

    def refresh_symbols(**kwargs: Any):
        calls.append(("symbols-refresh", kwargs["path"], kwargs["data_dir"]))
        return noop_task()

    symbols_path = tmp_path / "symbols.json"
    runtime = await start_app_runtime(
        tmp_path,
        deps=StartupRuntimeDeps(
            env={
                "HOGA_LIVE_STARTUP_ENABLED": "true",
                "HOGA_LIVE_TODAY_PROMOTE_ENABLED": "false",
            },
            start_scheduler=start_scheduler,
            start_live_stream=start_live_stream,
            start_live_stream_watchdog=start_live_stream_watchdog,
            start_today_promoter=start_today_promoter,
            stop_today_promoter=lambda task: _record_async(calls, "stop-promoter", task),
            stop_live_stream=lambda: _record_async(calls, "stop-live", None),
            aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-kis-capacity", None),
            aclose_kis_client=lambda: _record_async(calls, "close-kis", None),
            get_active_codes=lambda: [],
            load_symbol_disk_state=load_symbol_disk_state,
            needs_symbol_boot_refresh=lambda: True,
            refresh_symbols=refresh_symbols,
            resolve_symbol_master_path=lambda: symbols_path,
        ),
    )

    await runtime.stop()

    assert ("live", tmp_path) in calls
    assert not any(call[0] == "promoter" for call in calls)
    assert ("symbols-load", symbols_path) in calls
    assert ("symbols-refresh", symbols_path, tmp_path) in calls


@pytest.mark.asyncio
async def test_startup_runtime_cleans_up_partial_start_on_failure(tmp_path: Path) -> None:
    from hoga.api.startup_runtime import StartupRuntimeDeps, start_app_runtime

    calls: list[Any] = []

    async def long_running() -> None:
        await asyncio.sleep(3600)

    scheduler_task: asyncio.Task | None = None

    def start_scheduler(data_dir: Path) -> list[asyncio.Task]:
        nonlocal scheduler_task
        scheduler_task = asyncio.create_task(long_running(), name="daily-loop")
        calls.append(("scheduler", data_dir))
        return [scheduler_task]

    async def start_live_stream(*, data_dir: Path) -> bool:
        calls.append(("live", data_dir))
        return True

    async def start_live_stream_watchdog(*, data_dir: Path) -> asyncio.Task | None:
        calls.append(("watchdog", data_dir))
        return None

    async def start_today_promoter(**_kwargs: Any) -> asyncio.Task | None:
        calls.append(("promoter", None))
        raise RuntimeError("promoter failed")

    with pytest.raises(RuntimeError, match="promoter failed"):
        await start_app_runtime(
            tmp_path,
            deps=StartupRuntimeDeps(
                env={"HOGA_LIVE_STARTUP_ENABLED": "true"},
                start_scheduler=start_scheduler,
                start_live_stream=start_live_stream,
                start_live_stream_watchdog=start_live_stream_watchdog,
                start_today_promoter=start_today_promoter,
                stop_today_promoter=lambda task: _record_async(calls, "stop-promoter", task),
                stop_live_stream=lambda: _record_async(calls, "stop-live", None),
                aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-kis-capacity", None),
                aclose_kis_client=lambda: _record_async(calls, "close-kis", None),
                get_active_codes=lambda: [],
                load_symbol_disk_state=lambda **_kwargs: None,
                needs_symbol_boot_refresh=lambda: False,
                refresh_symbols=lambda **_kwargs: _record_async(calls, "symbols-refresh", None),
                resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
            ),
        )

    assert scheduler_task is not None
    assert scheduler_task.cancelled()
    assert ("stop-promoter", None) in calls
    assert ("stop-live", None) in calls
    assert ("close-kis-capacity", None) in calls
    assert ("close-kis", None) in calls
    assert calls.index(("close-kis-capacity", None)) < calls.index(("close-kis", None))


@pytest.mark.asyncio
async def test_supervised_task_health_reports_alive_sleeping_and_dead(tmp_path: Path) -> None:
    """ADR-0088: honest liveness — a sleeping (alive) daily loop is healthy, a
    finished (silently dead) loop is unhealthy. No staleness heuristic."""
    from hoga.api.startup_runtime import AppStartupRuntime, StartupRuntimeDeps

    async def sleeping() -> None:
        await asyncio.sleep(3600)  # a ~daily loop between fires

    async def finished() -> None:
        return None

    daily = asyncio.create_task(sleeping(), name="watchlist-daily-loop")
    watchdog = asyncio.create_task(finished(), name="live-stream-watchdog")
    await watchdog  # let it complete → done() == True (silent death)

    deps = StartupRuntimeDeps(
        env={},
        start_scheduler=lambda _d: [],
        start_live_stream=None,  # type: ignore[arg-type]
        start_live_stream_watchdog=None,  # type: ignore[arg-type]
        start_today_promoter=None,  # type: ignore[arg-type]
        stop_today_promoter=None,  # type: ignore[arg-type]
        stop_live_stream=None,  # type: ignore[arg-type]
        aclose_kis_capacity_scheduler=None,  # type: ignore[arg-type]
        aclose_kis_client=None,  # type: ignore[arg-type]
        get_active_codes=lambda: [],
        load_symbol_disk_state=lambda **_k: None,
        needs_symbol_boot_refresh=lambda: False,
        refresh_symbols=None,  # type: ignore[arg-type]
        resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
    )
    runtime = AppStartupRuntime(
        scheduler_tasks=[daily],
        live_watchdog_task=watchdog,
        today_promoter_task=None,  # never started → reported unhealthy
        deps=deps,
    )

    health = {row["name"]: row["running"] for row in runtime.supervised_task_health()}
    assert health["watchlist-daily-loop"] is True  # alive-but-sleeping = healthy
    assert health["live-stream-watchdog"] is False  # done() = silent death
    assert health["today-promoter"] is False  # None handle = not running

    daily.cancel()


@pytest.mark.asyncio
async def test_startup_runtime_spawns_and_stops_kiwoom_watchdog(tmp_path: Path) -> None:
    """PR-B(ADR-0118 §5): start_kiwoom_watchdog 주입 시 기동·health 노출·shutdown 정지.
    미주입(기본 None)이면 미기동 — KIS watchdog과 별개 태스크로 배선된다."""
    from hoga.api.startup_runtime import StartupRuntimeDeps, start_app_runtime

    calls: list[Any] = []

    async def noop_task() -> None:
        await asyncio.sleep(3600)

    async def start_live_stream_watchdog(*, data_dir: Path) -> asyncio.Task | None:
        return None

    async def start_today_promoter(**_kwargs: Any) -> asyncio.Task | None:
        return None

    async def start_kiwoom_watchdog() -> asyncio.Task | None:
        calls.append(("kiwoom-start",))
        return asyncio.create_task(noop_task(), name="kiwoom-session-watchdog")

    runtime = await start_app_runtime(
        tmp_path,
        deps=StartupRuntimeDeps(
            env={},
            start_scheduler=lambda _d: [],
            start_live_stream=lambda *, data_dir: _record_async(calls, "live", data_dir),
            start_live_stream_watchdog=start_live_stream_watchdog,
            start_today_promoter=start_today_promoter,
            stop_today_promoter=lambda task: _record_async(calls, "stop", task),
            stop_live_stream=lambda: _record_async(calls, "stop-live", None),
            aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-cap", None),
            aclose_kis_client=lambda: _record_async(calls, "close-kis", None),
            get_active_codes=lambda: [],
            load_symbol_disk_state=lambda **_k: None,
            needs_symbol_boot_refresh=lambda: False,
            refresh_symbols=lambda **_k: _record_async(calls, "refresh", None),
            resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
            start_kiwoom_watchdog=start_kiwoom_watchdog,
        ),
    )

    task = runtime.kiwoom_watchdog_task
    assert ("kiwoom-start",) in calls          # 기동됨
    assert task is not None
    health = {row["name"]: row["running"] for row in runtime.supervised_task_health()}
    assert health["kiwoom-session-watchdog"] is True  # 살아있음 노출

    await runtime.stop()
    assert ("stop", task) in calls             # shutdown이 정지 훅에 위임
    if not task.done():
        task.cancel()  # 페이크 stop은 기록만 — 누수 방지 정리


async def _record_async(calls: list[Any], name: str, value: Any) -> None:
    calls.append((name, value))
