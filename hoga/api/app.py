"""FastAPI factory."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from hoga.api import captures as _captures_module
from hoga.api import screener as _screener_module
from hoga.api import symbols as _symbols_module
from hoga.api.calendar import build_router as build_calendar_router
from hoga.api.captures import build_router as build_captures_router
from hoga.api.captures import cancel_all_on_shutdown
from hoga.api.captures import set_bus as set_captures_bus
from hoga.api.events import build_event_bus
from hoga.api.heatmap import seed_from_watchlist_if_absent
from hoga.api.heatmap_routes import build_router as build_heatmap_router
from hoga.api.queries import QueryEngine
from hoga.api.routes import build_router
from hoga.api.scheduler import start_scheduler
from hoga.api.screener import build_router as build_screener_router
from hoga.api.startup_runtime import StartupRuntimeDeps, start_app_runtime
from hoga.api.symbols import build_router as build_symbols_router
from hoga.api.test_routes import build_test_router
from hoga.api.watchlist_routes import build_router as build_watchlist_router
from hoga.api.study_view_routes import build_router as build_study_view_router
from hoga.api.ws import build_ws_router
from hoga.collector.client import HogaplayClient
from hoga.config import Config, resolve_data_dir, resolve_symbol_master_path
from hoga.env import load_env
from hoga.live.api import build_router as build_live_router
from hoga.live.kis_capacity_runtime import aclose_kis_capacity_scheduler
from hoga.live.kis_runtime import aclose_kis_client
from hoga.live.lifecycle import (
    get_active_codes,
    start_live_stream,
    start_live_stream_watchdog,
    start_today_promoter,
    stop_live_stream,
    stop_today_promoter,
)
from hoga.live.lifecycle import (
    get_buffer as live_get_buffer,
)
from hoga.live.lifecycle import (
    get_status as live_get_status,
)
from hoga.live.lifecycle import (
    get_today_ask_peak as live_get_today_ask_peak,
)
from hoga.live.lifecycle import (
    get_today_bid_peak as live_get_today_bid_peak,
)
from hoga.live.migrate import migrate_to_v2_layout

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
            await start_live_stream(data_dir=data_dir)
        elif action == "stop":
            await stop_live_stream()
        elif action == "pause":
            # Stage 8: treat pause as stop. Future: true pause (freeze loop
            # but keep buffer + status alive).
            await stop_live_stream()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        migrate_to_v2_layout(data_dir)
        # ADR-0068: one-time seed of the independent heatmap.json from the
        # watchlist (folders+entries, capture fields stripped) the first boot
        # it's absent AND the watchlist is non-empty. Idempotent; reads the
        # watchlist read-only so it's never at risk. Sync, pre-task-spawn.
        seed_from_watchlist_if_absent(data_dir)
        loop = asyncio.get_running_loop()
        inv_handler.loop = loop  # ADR-0053: route no longer binds this
        observer.start()
        # bus + loop for thread-safe publishes from the watchdog thread.
        set_captures_bus(bus, loop)
        # Single entry point bundles restore-before-spawn invariant (ADR-0019).
        _captures_module._workers = _captures_module.start_capture_pool(data_dir)
        startup_runtime = await start_app_runtime(
            data_dir,
            deps=StartupRuntimeDeps(
                env=os.environ,
                start_scheduler=start_scheduler,
                start_live_stream=start_live_stream,
                start_live_stream_watchdog=start_live_stream_watchdog,
                start_today_promoter=start_today_promoter,
                stop_today_promoter=stop_today_promoter,
                stop_live_stream=stop_live_stream,
                aclose_kis_capacity_scheduler=aclose_kis_capacity_scheduler,
                aclose_kis_client=aclose_kis_client,
                get_active_codes=get_active_codes,
                load_symbol_disk_state=_symbols_module.load_disk_state,
                needs_symbol_boot_refresh=_symbols_module.needs_boot_refresh,
                refresh_symbols=_symbols_module.refresh,
                resolve_symbol_master_path=resolve_symbol_master_path,
            ),
        )
        try:
            yield
        finally:
            await startup_runtime.stop()
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
            "http://localhost:5174",
            "http://127.0.0.1:5174",
        ],
        allow_methods=["*"],
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
    app.include_router(build_heatmap_router(data_dir=data_dir))
    app.include_router(build_screener_router(data_dir=data_dir, bus=bus))
    app.include_router(build_study_view_router(data_dir=data_dir))
    app.include_router(
        build_live_router(
            get_status=live_get_status,
            get_buffer=live_get_buffer,
            on_control=_live_control,
            get_today_ask_peak=live_get_today_ask_peak,
            get_today_bid_peak=live_get_today_bid_peak,
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
