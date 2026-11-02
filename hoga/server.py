"""Single-worker API runner with selective read retirement before connection drain."""
from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path

import uvicorn
from uvicorn.supervisors import ChangeReload

from hoga.api.read_shutdown import STATE_KEY, ReadShutdown

log = logging.getLogger("uvicorn.error")
SUPPORTED_UVICORN = "0.47.0"
STARTUP_FAILURE = 3


class ReadDrainServer(uvicorn.Server):
    async def _wait_tasks_to_complete(self) -> None:
        try:
            reads = self.lifespan.state[STATE_KEY]
            if not isinstance(reads, ReadShutdown):
                raise TypeError("application did not publish a ReadShutdown boundary")
            reads.begin()
        except Exception:
            log.exception("reload.read_retirement_unavailable; ordinary drain continues")
        await super()._wait_tasks_to_complete()


def run_server(*, host: str, port: int, reload: bool = False,
               reload_dirs: Sequence[Path] = (), app: str = "hoga.api.app:default_app") -> None:
    config = uvicorn.Config(app, factory=True, host=host, port=port, workers=1, reload=reload,
        reload_dirs=[str(path) for path in (reload_dirs or (Path(__file__).resolve().parent,))] if reload else None)
    if uvicorn.__version__ == SUPPORTED_UVICORN:
        server = ReadDrainServer(config)
    else:
        log.warning("reload.read_retirement_unsupported uvicorn=%s supported=%s; ordinary drain continues",
                    uvicorn.__version__, SUPPORTED_UVICORN)
        server = uvicorn.Server(config)
    try:
        if config.should_reload:
            sock = config.bind_socket()
            try:
                ChangeReload(config, target=server.run, sockets=[sock]).run()
            finally:
                sock.close()
        else:
            server.run()
    except KeyboardInterrupt:
        pass
    if not config.should_reload and not server.started:
        raise SystemExit(STARTUP_FAILURE)
