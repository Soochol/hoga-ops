"""FastAPI factory."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from hoga.api.queries import QueryEngine
from hoga.api.routes import build_router
from hoga.api.sse import build_sse
from hoga.api.test_routes import build_test_router
from hoga.config import Config


def create_app(data_dir: Path) -> FastAPI:
    engine = QueryEngine(data_dir)
    sse_router, _bus, observer = build_sse(data_dir / "parquet")

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        observer.start()
        try:
            yield
        finally:
            observer.stop()
            observer.join()
            engine.close()

    app = FastAPI(title="hoga-ops API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )
    app.include_router(build_router(engine))
    app.include_router(sse_router)
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
