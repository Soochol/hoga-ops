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
            start_today_promoter=start_today_promoter,
            stop_today_promoter=lambda task: _record_async(calls, "stop-promoter", task),
            stop_live_stream=lambda: _record_async(calls, "stop-live", None),
            aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-kis-capacity", None),
            aclose_kis_client=lambda: _record_async(calls, "close-kis", None),
            load_symbol_disk_state=load_symbol_disk_state,
            needs_symbol_boot_refresh=lambda: False,
            refresh_symbols=refresh_symbols,
            resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
        ),
    )

    await runtime.stop()

    assert ("live", tmp_path) not in calls
    assert ("scheduler", tmp_path) in calls
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
            start_today_promoter=start_today_promoter,
            stop_today_promoter=lambda task: _record_async(calls, "stop-promoter", task),
            stop_live_stream=lambda: _record_async(calls, "stop-live", None),
            aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-kis-capacity", None),
            aclose_kis_client=lambda: _record_async(calls, "close-kis", None),
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
                start_today_promoter=start_today_promoter,
                stop_today_promoter=lambda task: _record_async(calls, "stop-promoter", task),
                stop_live_stream=lambda: _record_async(calls, "stop-live", None),
                aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-kis-capacity", None),
                aclose_kis_client=lambda: _record_async(calls, "close-kis", None),
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
    watchdog = asyncio.create_task(finished(), name="kiwoom-session-watchdog")
    await watchdog  # let it complete → done() == True (silent death)

    deps = StartupRuntimeDeps(
        env={},
        start_scheduler=lambda _d: [],
        start_live_stream=None,  # type: ignore[arg-type]
        start_today_promoter=None,  # type: ignore[arg-type]
        stop_today_promoter=None,  # type: ignore[arg-type]
        stop_live_stream=None,  # type: ignore[arg-type]
        aclose_kis_capacity_scheduler=None,  # type: ignore[arg-type]
        aclose_kis_client=None,  # type: ignore[arg-type]

        load_symbol_disk_state=lambda **_k: None,
        needs_symbol_boot_refresh=lambda: False,
        refresh_symbols=None,  # type: ignore[arg-type]
        resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
    )
    runtime = AppStartupRuntime(
        scheduler_tasks=[daily],
        today_promoter_task=None,  # never started → reported unhealthy
        deps=deps,
        kiwoom_watchdog_task=watchdog,
    )

    health = {row["name"]: row["running"] for row in runtime.supervised_task_health()}
    assert health["watchlist-daily-loop"] is True  # alive-but-sleeping = healthy
    assert health["kiwoom-session-watchdog"] is False  # done() = silent death
    assert health["today-promoter"] is False  # None handle = not running

    # `state` 는 running 불리언이 접어 버리는 구별을 보존한다 — UI 경보는 dead 만
    # 봐야 한다. 이게 없으면 today-promoter 를 env 로 끈 사용자에게 배너가 상시 켜진다.
    state = {row["name"]: row["state"] for row in runtime.supervised_task_health()}
    assert state["watchlist-daily-loop"] == "running"
    assert state["kiwoom-session-watchdog"] == "dead"
    assert state["today-promoter"] == "not_started"

    daily.cancel()


@pytest.mark.asyncio
async def test_supervised_health_includes_capture_workers_and_program_trade(
    tmp_path: Path,
) -> None:
    """ADR-0088 확장: 캡처 워커 풀과 프로그램매매 수집기도 liveness 를 노출한다.

    둘은 감시 목록에서 빠져 있었다 — 조용히 죽으면 캡처 큐가 N-1 로 줄거나
    프로그램매매 수집이 멈추는데 어떤 표면에도 나타나지 않았다.
    """
    from hoga.api.startup_runtime import AppStartupRuntime, StartupRuntimeDeps

    async def sleeping() -> None:
        await asyncio.sleep(3600)

    async def finished() -> None:
        return None

    worker_alive = asyncio.create_task(sleeping(), name="capture-worker-0")
    worker_dead = asyncio.create_task(finished(), name="capture-worker-1")
    await worker_dead
    program_trade = asyncio.create_task(sleeping(), name="program-trade-collector")

    deps = StartupRuntimeDeps(
        env={},
        start_scheduler=lambda _d: [],
        start_live_stream=None,  # type: ignore[arg-type]
        start_today_promoter=None,  # type: ignore[arg-type]
        stop_today_promoter=None,  # type: ignore[arg-type]
        stop_live_stream=None,  # type: ignore[arg-type]
        aclose_kis_capacity_scheduler=None,  # type: ignore[arg-type]
        aclose_kis_client=None,  # type: ignore[arg-type]
        load_symbol_disk_state=lambda **_k: None,
        needs_symbol_boot_refresh=lambda: False,
        refresh_symbols=None,  # type: ignore[arg-type]
        resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
        get_capture_worker_tasks=lambda: [worker_alive, worker_dead],
        get_program_trade_task=lambda: program_trade,
    )
    runtime = AppStartupRuntime(
        scheduler_tasks=[], today_promoter_task=None, deps=deps,
    )

    state = {row["name"]: row["state"] for row in runtime.supervised_task_health()}
    assert state["capture-worker-0"] == "running"
    assert state["capture-worker-1"] == "dead"
    assert state["program-trade-collector"] == "running"

    worker_alive.cancel()
    program_trade.cancel()


@pytest.mark.asyncio
async def test_absent_program_trade_task_is_omitted_not_reported_dead(
    tmp_path: Path,
) -> None:
    """라이브가 꺼져 있으면 수집기 태스크가 없다 — 미기동을 dead 로 보고하면 안 된다.

    이 구별이 없으면 라이브를 안 켠 사용자에게 UI 경보가 영구히 뜬다.
    """
    from hoga.api.startup_runtime import AppStartupRuntime, StartupRuntimeDeps

    deps = StartupRuntimeDeps(
        env={},
        start_scheduler=lambda _d: [],
        start_live_stream=None,  # type: ignore[arg-type]
        start_today_promoter=None,  # type: ignore[arg-type]
        stop_today_promoter=None,  # type: ignore[arg-type]
        stop_live_stream=None,  # type: ignore[arg-type]
        aclose_kis_capacity_scheduler=None,  # type: ignore[arg-type]
        aclose_kis_client=None,  # type: ignore[arg-type]
        load_symbol_disk_state=lambda **_k: None,
        needs_symbol_boot_refresh=lambda: False,
        refresh_symbols=None,  # type: ignore[arg-type]
        resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
        get_capture_worker_tasks=lambda: [],
        get_program_trade_task=lambda: None,
    )
    runtime = AppStartupRuntime(
        scheduler_tasks=[], today_promoter_task=None, deps=deps,
    )

    names = [row["name"] for row in runtime.supervised_task_health()]
    assert "program-trade-collector" not in names


@pytest.mark.asyncio
async def test_startup_runtime_spawns_and_stops_kiwoom_watchdog(tmp_path: Path) -> None:
    """PR-B(ADR-0118 §5): start_kiwoom_watchdog 주입 시 기동·health 노출·shutdown 정지.
    미주입(기본 None)이면 미기동 — KIS watchdog과 별개 태스크로 배선된다."""
    from hoga.api.startup_runtime import StartupRuntimeDeps, start_app_runtime

    calls: list[Any] = []

    async def noop_task() -> None:
        await asyncio.sleep(3600)

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
            start_today_promoter=start_today_promoter,
            stop_today_promoter=lambda task: _record_async(calls, "stop", task),
            stop_live_stream=lambda: _record_async(calls, "stop-live", None),
            aclose_kis_capacity_scheduler=lambda: _record_async(calls, "close-cap", None),
            aclose_kis_client=lambda: _record_async(calls, "close-kis", None),
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


@pytest.mark.asyncio
async def test_completed_one_shot_is_not_reported_dead(tmp_path: Path) -> None:
    """one-shot 의 정상 완료는 죽음이 아니다 — 이 구별이 없으면 README 무인 운영
    구성(부팅 캐치업 + 5분 워치독)이 건강한 서버를 영구히 재시작한다(2026-08-03).

    기존 테스트가 전부 dict 스텁이라 **실제 Task 의 정상-완료 경로를 한 번도 통과
    시키지 않았다** — 그래서 버그가 커버리지 안에서 살아 있었다. 여기서는 진짜
    asyncio.Task 로 네 상태를 전부 만든다.
    """
    from hoga.api.startup_runtime import AppStartupRuntime, StartupRuntimeDeps

    async def sleeping() -> None:
        await asyncio.sleep(3600)

    async def one_sweep() -> None:
        return None

    async def crashing() -> None:
        raise RuntimeError("catchup upstream refused")

    daily = asyncio.create_task(sleeping(), name="watchlist-daily-loop")
    catchup = asyncio.create_task(one_sweep(), name="watchlist-catchup")
    boot_refresh = asyncio.create_task(crashing(), name="symbols-boot-refresh")
    await catchup
    await asyncio.gather(boot_refresh, return_exceptions=True)

    deps = StartupRuntimeDeps(
        env={},
        start_scheduler=lambda _d: [],
        start_live_stream=None,  # type: ignore[arg-type]
        start_today_promoter=None,  # type: ignore[arg-type]
        stop_today_promoter=None,  # type: ignore[arg-type]
        stop_live_stream=None,  # type: ignore[arg-type]
        aclose_kis_capacity_scheduler=None,  # type: ignore[arg-type]
        aclose_kis_client=None,  # type: ignore[arg-type]
        load_symbol_disk_state=lambda **_k: None,
        needs_symbol_boot_refresh=lambda: False,
        refresh_symbols=None,  # type: ignore[arg-type]
        resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
    )
    runtime = AppStartupRuntime(
        scheduler_tasks=[daily, catchup, boot_refresh],
        today_promoter_task=None,
        deps=deps,
    )

    state = {row["name"]: row["state"] for row in runtime.supervised_task_health()}
    assert state["watchlist-daily-loop"] == "running"
    # 계약대로 한 번 일하고 끝났다 — 경보 아님.
    assert state["watchlist-catchup"] == "completed"
    # one-shot 이라도 예외로 끝났으면 보여야 한다. 실패한 부팅 갱신을 숨기면
    # completed 분리가 관측을 깎아먹는 순수 손해가 된다.
    assert state["symbols-boot-refresh"] == "dead"

    daily.cancel()


@pytest.mark.asyncio
async def test_perpetual_loop_returning_normally_is_still_dead(tmp_path: Path) -> None:
    """영구 루프에게 '정상 반환' 은 ADR-0064 가 지목한 조용한 죽음 그 자체다.

    completed 를 '예외 없이 끝났나' 로 판정했다면 이 케이스가 통째로 안 보이게
    된다 — 그래서 기준은 예외 여부가 아니라 계약(ONE_SHOT_TASK_NAMES)이다.
    """
    from hoga.api.startup_runtime import AppStartupRuntime, StartupRuntimeDeps

    async def returns_without_raising() -> None:
        return None

    daily = asyncio.create_task(returns_without_raising(), name="watchlist-daily-loop")
    await daily

    deps = StartupRuntimeDeps(
        env={},
        start_scheduler=lambda _d: [],
        start_live_stream=None,  # type: ignore[arg-type]
        start_today_promoter=None,  # type: ignore[arg-type]
        stop_today_promoter=None,  # type: ignore[arg-type]
        stop_live_stream=None,  # type: ignore[arg-type]
        aclose_kis_capacity_scheduler=None,  # type: ignore[arg-type]
        aclose_kis_client=None,  # type: ignore[arg-type]
        load_symbol_disk_state=lambda **_k: None,
        needs_symbol_boot_refresh=lambda: False,
        refresh_symbols=None,  # type: ignore[arg-type]
        resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
    )
    runtime = AppStartupRuntime(
        scheduler_tasks=[daily], today_promoter_task=None, deps=deps,
    )

    state = {row["name"]: row["state"] for row in runtime.supervised_task_health()}
    assert state["watchlist-daily-loop"] == "dead"


def test_one_shot_registry_matches_the_tasks_actually_spawned() -> None:
    """ONE_SHOT_TASK_NAMES 는 생성처와 떨어져 있다 — 이름이 갈리면 조용히 의미가
    바뀌므로(캐치업 rename → 다시 영구 503) 생성처 리터럴과 대조해 못박는다."""
    import inspect

    from hoga.api import scheduler, startup_runtime

    spawn_sites = inspect.getsource(scheduler.start_scheduler) + inspect.getsource(
        startup_runtime.start_app_runtime
    )
    for name in startup_runtime.ONE_SHOT_TASK_NAMES:
        assert f'name="{name}"' in spawn_sites, f"{name} 이 생성처에 없다"


@pytest.mark.asyncio
async def test_inventory_observer_liveness_is_reported(tmp_path: Path) -> None:
    """인벤토리 옵서버(watchdog **스레드**)도 감독 대상이다.

    이 감독이 없으면 옵서버가 죽어도 아무 표면에 안 나타난다 — HTTP 는 멀쩡하고
    (얕은 health 통과), asyncio 태스크가 아니라 태스크 목록에도 안 잡힌다. 그 뒤로
    캡처가 끝나도 인벤토리 SSE 가 조용히 멈춘다. parquet 트리가 커져 inotify
    watch 한도를 소진하면 실제로 그렇게 된다.
    """
    from hoga.api.startup_runtime import AppStartupRuntime, StartupRuntimeDeps

    class _Observer:
        def __init__(self, alive: bool) -> None:
            self._alive = alive

        def is_alive(self) -> bool:
            return self._alive

    def _runtime(observer: object | None) -> AppStartupRuntime:
        deps = StartupRuntimeDeps(
            env={},
            start_scheduler=lambda _d: [],
            start_live_stream=None,  # type: ignore[arg-type]
            start_today_promoter=None,  # type: ignore[arg-type]
            stop_today_promoter=None,  # type: ignore[arg-type]
            stop_live_stream=None,  # type: ignore[arg-type]
            aclose_kis_capacity_scheduler=None,  # type: ignore[arg-type]
            aclose_kis_client=None,  # type: ignore[arg-type]
            load_symbol_disk_state=lambda **_k: None,
            needs_symbol_boot_refresh=lambda: False,
            refresh_symbols=None,  # type: ignore[arg-type]
            resolve_symbol_master_path=lambda: tmp_path / "symbols.json",
            get_inventory_observer=lambda: observer,
        )
        return AppStartupRuntime(
            scheduler_tasks=[], today_promoter_task=None, deps=deps,
        )

    def _state(observer: object | None) -> str:
        rows = _runtime(observer).supervised_task_health()
        return next(r["state"] for r in rows if r["name"] == "inventory-observer")

    assert _state(_Observer(alive=True)) == "running"
    assert _state(_Observer(alive=False)) == "dead"
    # 미주입·판정 불가는 경보가 아니다 — 감독 코드가 타입 가정으로 죽으면 안 된다.
    assert _state(None) == "not_started"
    assert _state(object()) == "not_started"


def test_app_wires_the_inventory_observer_into_supervision() -> None:
    """배선 봉인 — 접근자를 만들고 안 꽂으면 사각이 그대로 남는다."""
    import inspect

    from hoga.api import app as app_mod

    assert "get_inventory_observer=" in inspect.getsource(app_mod.create_app)
