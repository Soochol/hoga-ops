"""FastAPI factory."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from hoga.api import captures as _captures_module
from hoga.api import symbols as _symbols_module
from hoga.api.calendar import build_router as build_calendar_router
from hoga.api.captures import build_router as build_captures_router
from hoga.api.captures import cancel_all_on_shutdown
from hoga.api.captures import set_bus as set_captures_bus
from hoga.api.queries import QueryEngine
from hoga.api.routes import build_router
from hoga.api.scheduler import start_scheduler
from hoga.api.events import build_event_bus
from hoga.api.ws import build_ws_router
from hoga.api.symbols import build_router as build_symbols_router
from hoga.api.test_routes import build_test_router
from hoga.api.watchlist_routes import build_router as build_watchlist_router
from hoga.api import screener as _screener_module
from hoga.api.screener import build_router as build_screener_router
from hoga.collector.client import HogaplayClient
from hoga.config import Config, resolve_data_dir, resolve_symbol_master_path
from hoga.env import load_env
from hoga.live.api import build_router as build_live_router
from hoga.live.kis_runtime import aclose_kis_client
from hoga.live.kis_runtime import get_kis_client as live_get_kis_client
from hoga.live.lifecycle import get_buffer as live_get_buffer
from hoga.live.lifecycle import get_status as live_get_status
from hoga.live.lifecycle import (
    get_active_codes,
    start_live_poller,
    start_live_poller_watchdog,
    start_today_promoter,
    stop_live_poller,
    stop_today_promoter,
)
from hoga.live.migrate import migrate_to_v2_layout

log = logging.getLogger(__name__)


def create_app(data_dir: Path) -> FastAPI:
    engine = QueryEngine(data_dir)
    bus, observer, inv_handler = build_event_bus(data_dir / "parquet")

    def _real_client_factory():
        cfg = Config.from_cwd()
        return HogaplayClient(cookie=cfg.cookie())

    # Choose client factory: fake when the test env flag is set. The fake
    # module is import-gated too — production processes don't load it.
    if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
        from hoga.api.captures_fake import FakeHogaplayClient  # noqa: PLC0415 — intentionally gated

        def _fake_client_factory():
            return FakeHogaplayClient()

        client_factory = _fake_client_factory
    else:
        client_factory = _real_client_factory

    async def _live_control(action: str) -> None:
        """Dispatch POST /api/live/control actions to the lifecycle layer."""
        if action == "start":
            await start_live_poller(data_dir=data_dir)
        elif action == "stop":
            await stop_live_poller()
        elif action == "pause":
            # Stage 8: treat pause as stop. Future: true pause (freeze loop
            # but keep buffer + status alive).
            await stop_live_poller()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        migrate_to_v2_layout(data_dir)
        loop = asyncio.get_running_loop()
        inv_handler.loop = loop  # ADR-0053: route no longer binds this
        observer.start()
        # bus + loop for thread-safe publishes from the watchdog thread.
        set_captures_bus(bus, loop)
        # Single entry point bundles restore-before-spawn invariant (ADR-0019).
        _captures_module._workers = _captures_module.start_capture_pool(data_dir)
        # ADR-0034: Watchlist scheduler runs alongside the capture pool
        # in the same uvicorn process. Tasks are cancelled in `finally`.
        # Initialize defensively so the `finally` block is safe even if
        # `start_scheduler` raises.
        _scheduler_tasks: list = []
        _scheduler_tasks = start_scheduler(data_dir)
        # Screener startup recovery: catch up any EOD gap the scheduler missed
        # while the process was down. Spawned (NOT awaited) so it never blocks
        # boot and a calendar error inside it can't abort startup. Tracked in
        # _scheduler_tasks so the `finally` block cancels/awaits it on shutdown.
        _scheduler_tasks.append(
            asyncio.create_task(
                _screener_module.trigger_update(data_dir), name="screener-recovery"
            )
        )
        # Stage 8: Start the live poller (graceful degradation: no-op if
        # KIS_APP_KEY/SECRET missing or watchlist is empty).
        await start_live_poller(data_dir=data_dir)
        # ADR-0064: watchdog that restarts the poller if it dies or stops
        # ticking during market hours (defense-in-depth self-heal). Spawned
        # unconditionally — it no-ops when the poller wasn't started.
        live_watchdog_task = await start_live_poller_watchdog(data_dir=data_dir)
        # ADR-0043: Today Promotion task — overwrite today's jsonl to parquet
        # every N minutes so /api/range covers today without waiting for the
        # 17:00 Daily Promotion batch. Optional kill-switch via
        # HOGA_LIVE_TODAY_PROMOTE_ENABLED=false; interval tunable via
        # HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S (default 300 = 5 min).
        today_promoter_task: asyncio.Task | None = None
        if os.environ.get("HOGA_LIVE_TODAY_PROMOTE_ENABLED", "true").lower() != "false":
            today_promote_interval_s = float(
                os.environ.get("HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S", "300")
            )
            today_promoter_task = await start_today_promoter(
                data_dir=data_dir,
                get_active_codes=get_active_codes,
                interval_s=today_promote_interval_s,
            )
        # Symbol Master warm-load: read the KIS .mst disk cache at boot so
        # GET /api/symbols/all is immediately warm without a network call.
        _symbols_module.load_disk_state(
            path=resolve_symbol_master_path(), data_dir=data_dir
        )
        # §4.4: .mst is fast + no-auth, so an empty/legacy cache auto-refreshes
        # in the background (does NOT block startup; load_disk_state already
        # ran). The fire/skip condition lives in symbols.needs_boot_refresh()
        # — one owner instead of a status string-compare at this call site.
        # Routed through refresh()/coordinator → single-flight, so a concurrent
        # manual click won't double-download. Tracked in _scheduler_tasks (same
        # as screener-recovery) so the `finally` block cancels+awaits it at
        # shutdown instead of leaking an in-flight download.
        if _symbols_module.needs_boot_refresh():
            _scheduler_tasks.append(
                asyncio.create_task(
                    _symbols_module.refresh(
                        path=resolve_symbol_master_path(), data_dir=data_dir
                    ),
                    name="symbols-boot-refresh",
                )
            )
        try:
            yield
        finally:
            # ADR-0043: stop Today Promotion before live poller so the loop
            # doesn't observe a half-cancelled poller state.
            await stop_today_promoter(today_promoter_task)
            # ADR-0064: stop the watchdog before the poller so it can't race to
            # "restart" the poller we're deliberately shutting down. (reuses the
            # generic cancel-and-await helper.)
            await stop_today_promoter(live_watchdog_task)
            # Stop the live poller before scheduler to avoid new ticks being
            # written while the scheduler is shutting down.
            await stop_live_poller()
            # Cancel scheduler tasks BEFORE stopping the worker pool: the
            # scheduler enqueues to the workers, so kill the trigger first
            # and then let the workers drain.
            for t in _scheduler_tasks:
                t.cancel()
            for t in _scheduler_tasks:
                try:
                    await t
                except asyncio.CancelledError:
                    pass  # expected outcome of cancel() above
                except Exception:  # noqa: BLE001
                    # Bugs in scheduler teardown must not block shutdown,
                    # but they MUST be logged — otherwise a regression in
                    # bump_last_success/_daily_loop shutdown vanishes.
                    log.exception("scheduler task crashed during shutdown")
            # Task-7 follow-up: close the PROCESS-singleton KisClient (shared
            # 15/s token bucket) only at process shutdown. Closed AFTER every
            # _scheduler_tasks entry (incl. screener-recovery) is cancelled and
            # awaited above, so no task — not the EOD update, not the recovery
            # catch-up — can still be using the client when it's torn down.
            await aclose_kis_client()
            # Stop the worker pool first so in-flight items observe cancellation
            # while bus + observer are still live (they emit terminal events).
            await _captures_module.stop_workers(_captures_module._workers)
            _captures_module._workers = []
            # Best-effort cancel of any in-flight items at shutdown — raw files
            # are preserved on disk for Resume. Spec §9 documents this behavior.
            cancel_all_on_shutdown()
            observer.stop()
            observer.join()
            engine.close()
            set_captures_bus(None, None)

    app = FastAPI(title="hoga-ops API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        # 127.0.0.1 and localhost are treated as separate origins by browsers.
        # Allow both so the dev frontend works regardless of which host the
        # user / harness opens.
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["*"],
    )
    # Liveness probe. Used by the Playwright e2e webServer config and by any
    # process supervisor that needs a no-side-effects 200 OK.
    @app.get("/health")
    def _health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(build_router(engine))
    app.include_router(build_ws_router(bus, live_get_buffer))
    app.include_router(
        build_captures_router(data_dir=data_dir, client_factory=client_factory)
    )
    app.include_router(
        build_symbols_router(path=resolve_symbol_master_path(), data_dir=data_dir)
    )
    app.include_router(build_calendar_router(data_dir=data_dir))
    app.include_router(build_watchlist_router(data_dir=data_dir))
    app.include_router(build_screener_router(data_dir=data_dir, bus=bus))
    app.include_router(
        build_live_router(
            get_status=live_get_status,
            get_buffer=live_get_buffer,
            on_control=_live_control,
            get_kis_client=live_get_kis_client,
            data_dir=data_dir,
        )
    )
    if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
        app.include_router(build_test_router(data_dir))
    app.state.engine = engine
    return app


def default_app() -> FastAPI:
    """Factory used by uvicorn.

    Delegates to ``resolve_data_dir()`` (HOGA_DATA_DIR env →
    XDG_DATA_HOME/hoga-ops/data → ~/.local/share/hoga-ops/data).
    Captures from any branch / worktree share the same store, so heavy
    raw-TSV downloads aren't duplicated.

    Also loads .env so ``uvicorn --reload`` (which bypasses
    ``hoga.cli.serve``) still picks up KIS_APP_KEY / KIS_APP_SECRET. The CLI
    entry point calls ``load_env()`` too; the discovery cache makes the
    second call a no-op.
    """
    load_env()
    data_dir = resolve_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    return create_app(data_dir)
