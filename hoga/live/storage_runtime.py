"""Apply Live Storage Policy to WS and KIS API capture runtimes."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from hoga.api.models import LiveStoragePolicy

from . import kis_access, kis_runtime
from .buffer import LiveBuffer
from .coverage import _compute_capture_candidates, plan_storage_targets
from .settings import load_live_settings


class Rest30RecorderLike(Protocol):
    def set_targets(self, codes: set[str]) -> None: ...
    def start(self) -> None: ...
    async def stop(self) -> None: ...


class StorageRuntimeState(Protocol):
    rest30_recorder: Rest30RecorderLike | None
    storage_policy: LiveStoragePolicy


@dataclass(frozen=True, slots=True)
class StorageRuntimeSnapshot:
    storage_policy: LiveStoragePolicy
    ws_targets: tuple[str, ...]
    kis_api_targets: tuple[str, ...]


def _ensure_rest30_recorder(
    state: StorageRuntimeState,
    *,
    data_dir: Path,
    buffer: LiveBuffer,
    date_fn: Callable[[], str],
    now_ms_fn: Callable[[], int],
) -> Rest30RecorderLike | None:
    from .rest30_recorder import Rest30sRecorder  # noqa: PLC0415

    if state.rest30_recorder is not None:
        return state.rest30_recorder
    if kis_runtime.ensure_kis_client_from_env(data_dir) is None:
        return None
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis_access.kis_for_role("background", data_dir),
        buffer=buffer,
        data_dir=data_dir,
        date_fn=date_fn,
        phase_fn=lambda: __import__(
            "hoga.live.session_gate", fromlist=["market_phase"],
        ).market_phase(now_ms_fn()),
    )
    state.rest30_recorder = recorder
    return recorder


async def sync_storage_runtime(
    data_dir: Path,
    *,
    state: StorageRuntimeState,
    buffer: LiveBuffer,
    date_fn: Callable[[], str],
    now_ms_fn: Callable[[], int],
    n_configured: int | None = None,
) -> StorageRuntimeSnapshot:
    """Load settings, plan targets, and sync the persisted REST 30s runtime."""
    settings = load_live_settings(data_dir)
    state.storage_policy = settings.storage_policy
    if n_configured is None:
        n_configured = len(kis_runtime.configured_account_ids(data_dir))
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        n_configured=n_configured,
        storage_policy=settings.storage_policy,
    )
    recorder = (
        _ensure_rest30_recorder(
            state,
            data_dir=data_dir,
            buffer=buffer,
            date_fn=date_fn,
            now_ms_fn=now_ms_fn,
        )
        if targets.kis_api_targets
        else state.rest30_recorder
    )
    if recorder is not None:
        recorder.set_targets(set(targets.kis_api_targets))
        if targets.kis_api_targets:
            recorder.start()
        else:
            await recorder.stop()
    return StorageRuntimeSnapshot(
        storage_policy=settings.storage_policy,
        ws_targets=targets.ws_targets,
        kis_api_targets=targets.kis_api_targets,
    )


async def stop_storage_runtime(state: StorageRuntimeState) -> None:
    recorder = state.rest30_recorder
    if recorder is not None:
        await recorder.stop()
