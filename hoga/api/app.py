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
from hoga.api import symbols as _symbols_module
from hoga.api.captures import build_router as build_captures_router
from hoga.api.captures import cancel_all_on_shutdown
from hoga.api.captures import set_bus as set_captures_bus
from hoga.api.queries import QueryEngine
from hoga.api.routes import build_router
from hoga.api.sse import build_sse
from hoga.api.symbols import build_router as build_symbols_router
from hoga.api.test_routes import build_test_router
from hoga.collector.client import HogaplayClient
from hoga.config import Config


def create_app(data_dir: Path) -> FastAPI:
    engine = QueryEngine(data_dir)
    sse_router, bus, observer = build_sse(data_dir / "parquet")

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

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        observer.start()
        # bus + loop for thread-safe publishes from the watchdog thread.
        set_captures_bus(bus, asyncio.get_running_loop())
        # Start the Plan B worker pool. Sits alongside the legacy _latest
        # shutdown hook until Task 13 retires the singleton path.
        _captures_module._workers = _captures_module.start_workers()
        # Tier 1 of the pykrx 3-tier cache policy: prefetch the symbol master
        # cache fire-and-forget so the first GET /api/symbols/all is warm.
        # Failure is tolerated — Tier 3 stale-fallback covers boot-time KRX outages.
        asyncio.create_task(_symbols_module.ensure_cache_warm(data_dir))
        try:
            yield
        finally:
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
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )
    app.include_router(build_router(engine))
    app.include_router(sse_router)
    app.include_router(
        build_captures_router(data_dir=data_dir, client_factory=client_factory)
    )
    app.include_router(build_symbols_router(data_dir=data_dir))
    if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
        app.include_router(build_test_router(data_dir))
    app.state.engine = engine
    return app


def default_app() -> FastAPI:
    """Factory used by uvicorn.

    Data dir resolution:
      * ``HOGA_DATA_DIR`` env var if set (used by E2E harness to point at a
        clean, throwaway directory).
      * Otherwise the ``data/`` dir under ``Config.from_cwd()``.
    """
    env_dir = os.environ.get("HOGA_DATA_DIR")
    if env_dir:
        return create_app(Path(env_dir))
    cfg = Config.from_cwd()
    return create_app(cfg.data_dir)
