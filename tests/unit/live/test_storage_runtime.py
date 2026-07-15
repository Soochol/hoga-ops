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
async def test_storage_runtime_appends_heatmap_codes_as_rest_only_extras(
    tmp_path,
    monkeypatch,
) -> None:
    """Heatmap entries feed the REST 30s recorder (ADR-0097): duplicates of
    watchlist codes dedup, unknown codes drop, and WS targets never change."""
    from hoga.api.heatmap import save_document as save_heatmap_document
    from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder

    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    save_heatmap_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder(id="f_00000aaa", name="히트맵", order=0)],
            entries=[
                HeatmapEntry(code="000660", name="SK하이닉스", folder_id="f_00000aaa"),  # watchlist dup → dedup
                HeatmapEntry(code="005380", name="현대차", folder_id="f_00000aaa"),      # heatmap-only → REST
                HeatmapEntry(code="999999", name="유령", folder_id="f_00000aaa"),        # unknown → dropped
            ],
        ),
    )

    class Hit:
        def __init__(self, code: str) -> None:
            self.code = code

    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [
            Hit("005930"), Hit("000660"), Hit("035420"), Hit("005380"),
        ],
    )
    monkeypatch.setattr("hoga.live.coverage._PER_ACCOUNT_MAX", 1)
    save_live_settings(tmp_path, LiveSettings(storage_policy="ws_plus_rest"))
    state = FakeStorageState()

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260710",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.ws_targets == ("005930",)
    assert snapshot.kis_api_targets == ("000660", "035420", "005380")
    assert state.rest30_recorder is not None
    assert state.rest30_recorder.targets == {"000660", "035420", "005380"}


@pytest.mark.asyncio
async def test_storage_runtime_heatmap_capture_disabled_drops_heatmap_extras(
    tmp_path,
    monkeypatch,
) -> None:
    """heatmap_capture_enabled=False gates ONLY the heatmap extras — the
    watchlist REST spillover is untouched (heatmap-only code drops out)."""
    from hoga.api.heatmap import save_document as save_heatmap_document
    from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder

    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    save_heatmap_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder(id="f_00000aaa", name="히트맵", order=0)],
            entries=[HeatmapEntry(code="005380", name="현대차", folder_id="f_00000aaa")],
        ),
    )

    class Hit:
        def __init__(self, code: str) -> None:
            self.code = code

    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [
            Hit("005930"), Hit("000660"), Hit("035420"), Hit("005380"),
        ],
    )
    monkeypatch.setattr("hoga.live.coverage._PER_ACCOUNT_MAX", 1)
    save_live_settings(
        tmp_path,
        LiveSettings(storage_policy="ws_plus_rest", heatmap_capture_enabled=False),
    )
    state = FakeStorageState()

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260710",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    # Heatmap-only code 005380 is gated out; watchlist spillover survives.
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


@pytest.mark.asyncio
async def test_storage_runtime_bypass_stops_api_recorder_without_mutating_policy(
    tmp_path,
    monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    existing = FakeRest30Recorder()
    save_live_settings(
        tmp_path,
        LiveSettings(storage_policy="rest_only", kis_rest_bypass_enabled=True),
    )
    state = FakeStorageState(rest30_recorder=existing)

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
    assert snapshot.kis_api_targets == ()
    assert existing.targets == set()
    assert existing.stopped is True


@pytest.mark.asyncio
async def test_storage_runtime_bypass_stops_program_trade_collector(
    tmp_path,
    monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    existing = FakeProgramTradeCollector()
    save_live_settings(
        tmp_path,
        LiveSettings(
            storage_policy="ws_plus_rest",
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=True,
        ),
    )
    state = FakeStorageState(program_trade_collector=existing)

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.kis_api_targets == ()
    assert existing.stopped is True


def test_rest30_concurrency_scales_per_account(tmp_path, monkeypatch) -> None:
    """rest30 동시 상한은 configured 계정 수 비례 (ADR-0102): 계정당 10, 상한 48.
    앱키별 독립 예산(ADR-0100)을 다 쓰려면 in-flight가 계정 수에 비례해야 한다."""
    from hoga.live import storage_runtime as sr

    def _ids(n: int):
        return lambda _data_dir: list(range(n))

    monkeypatch.setattr(sr.kis_runtime, "configured_account_ids", _ids(1))
    assert sr._rest30_concurrency(tmp_path) == 10, "단일 계정 = 10 (ADR-0098 포화값)"
    monkeypatch.setattr(sr.kis_runtime, "configured_account_ids", _ids(3))
    assert sr._rest30_concurrency(tmp_path) == 30, "3계정 = 30"
    monkeypatch.setattr(sr.kis_runtime, "configured_account_ids", _ids(4))
    assert sr._rest30_concurrency(tmp_path) == 40, "4계정 = 40 (500종목@10초 전제)"
    monkeypatch.setattr(sr.kis_runtime, "configured_account_ids", _ids(6))
    assert sr._rest30_concurrency(tmp_path) == 48, "6계정 = 48 (상한 clamp)"
    monkeypatch.setattr(sr.kis_runtime, "configured_account_ids", _ids(0))
    assert sr._rest30_concurrency(tmp_path) == 10, "계정 0 = 10 (하한)"


@pytest.mark.asyncio
async def test_storage_runtime_rest_fallback_codes_reach_recorder(
    tmp_path,
    monkeypatch,
) -> None:
    """해결안 ③: rest_fallback_codes가 plan을 관통해 recorder 타깃에 편입된다.
    ws_plus_rest + n=1 + 종목 3개면 계정당 13슬롯이라 전부 WS(REST 잔여 0) —
    폴백이 없으면 recorder 타깃이 비고, 폴백 종목만 REST 타깃이 된다."""
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    save_live_settings(tmp_path, LiveSettings(storage_policy="ws_plus_rest"))
    state = FakeStorageState()

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
        rest_fallback_codes=("000660", "035420"),
    )

    assert snapshot.ws_targets == ("005930", "000660", "035420")
    assert snapshot.kis_api_targets == ("000660", "035420")   # WS 소속이지만 폴백 편입
    assert state.rest30_recorder is not None
    assert state.rest30_recorder.targets == {"000660", "035420"}
    assert state.rest30_recorder.started is True
