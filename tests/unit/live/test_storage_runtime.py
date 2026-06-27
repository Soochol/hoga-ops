from __future__ import annotations

from dataclasses import dataclass

import pytest

from hoga.api.models import (
    LiveStoragePolicy,
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolder,
)
from hoga.api.watchlist import save_document
from hoga.live.settings import LiveSettings, save_live_settings
from hoga.live.storage_runtime import sync_storage_runtime


class FakeRest30Recorder:
    created = []

    def __init__(self, **kwargs):
        self.targets: set[str] = set()
        self.started = False
        self.stopped = False
        FakeRest30Recorder.created.append(self)

    def set_targets(self, codes: set[str]) -> None:
        self.targets = set(codes)

    def start(self) -> None:
        self.started = True
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


class FakeProgramTradeCollector:
    created = []

    def __init__(self, **kwargs):
        self.started = False
        self.stopped = False
        FakeProgramTradeCollector.created.append(self)

    def start(self) -> None:
        self.started = True
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


@dataclass
class FakeStorageState:
    rest30_recorder: FakeRest30Recorder | None = None
    program_trade_collector: FakeProgramTradeCollector | None = None
    storage_policy: LiveStoragePolicy = "ws_plus_rest"


def _seed_watchlist(tmp_path):
    save_document(
        tmp_path,
        WatchlistDocument(
            folders=[
                WatchlistFolder(
                    id="f_0000000a",
                    name="스윙",
                    order=0,
                    member_codes=["005930", "000660", "035420"],
                    capture_enabled=True,
                ),
            ],
            entries=[
                WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
                WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
                WatchlistEntry(code="035420", name="NAVER", registered_at_kst_date="20260601"),
            ],
        ),
    )


def _patch_common(monkeypatch):
    class Hit:
        def __init__(self, code: str) -> None:
            self.code = code

    FakeRest30Recorder.created.clear()
    FakeProgramTradeCollector.created.clear()
    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [Hit("005930"), Hit("000660"), Hit("035420")],
    )
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_from_env",
        lambda data_dir: object(),
    )
    monkeypatch.setattr("hoga.live.rest30_recorder.Rest30sRecorder", FakeRest30Recorder)
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.ProgramTradeCollector",
        FakeProgramTradeCollector,
    )


@pytest.mark.asyncio
async def test_storage_runtime_rest_only_starts_api_for_all_capture_candidates(
    tmp_path,
    monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    save_live_settings(tmp_path, LiveSettings(storage_policy="rest_only"))
    state = FakeStorageState()

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.storage_policy == "rest_only"
    assert snapshot.ws_targets == ()
    assert snapshot.kis_api_targets == ("005930", "000660", "035420")
    assert state.rest30_recorder is FakeRest30Recorder.created[0]
    assert state.rest30_recorder.targets == {"005930", "000660", "035420"}
    assert state.rest30_recorder.started is True


@pytest.mark.asyncio
async def test_storage_runtime_ws_plus_rest_excludes_ws_targets_from_api(
    tmp_path,
    monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    monkeypatch.setattr("hoga.live.coverage._PER_ACCOUNT_MAX", 1)
    save_live_settings(tmp_path, LiveSettings(storage_policy="ws_plus_rest"))
    state = FakeStorageState()

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.ws_targets == ("005930",)
    assert snapshot.kis_api_targets == ("000660", "035420")
    assert state.rest30_recorder is not None
    assert state.rest30_recorder.targets == {"000660", "035420"}


@pytest.mark.asyncio
async def test_storage_runtime_ws_only_stops_existing_api_recorder(
    tmp_path,
    monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    existing = FakeRest30Recorder()
    save_live_settings(tmp_path, LiveSettings(storage_policy="ws_only"))
    state = FakeStorageState(rest30_recorder=existing)

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.kis_api_targets == ()
    assert existing.targets == set()
    assert existing.stopped is True


@pytest.mark.asyncio
async def test_storage_runtime_starts_program_trade_collector_for_rest_allowed_toggle(
    tmp_path,
    monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    save_live_settings(
        tmp_path,
        LiveSettings(storage_policy="ws_plus_rest", program_trade_storage_enabled=True),
    )
    state = FakeStorageState()

    await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert state.program_trade_collector is FakeProgramTradeCollector.created[0]
    assert state.program_trade_collector.started is True


@pytest.mark.asyncio
async def test_storage_runtime_stops_program_trade_collector_under_ws_only(
    tmp_path,
    monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    existing = FakeProgramTradeCollector()
    save_live_settings(
        tmp_path,
        LiveSettings(storage_policy="ws_only", program_trade_storage_enabled=True),
    )
    state = FakeStorageState(program_trade_collector=existing)

    await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert existing.stopped is True
