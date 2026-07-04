from __future__ import annotations

import asyncio

import pytest


class FakeRest30Recorder:
    created = []

    def __init__(self, **kwargs):
        self.targets = set()
        self.started = False
        self.stopped = False
        FakeRest30Recorder.created.append(self)

    def set_targets(self, codes):
        self.targets = set(codes)

    def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True

    @property
    def alive(self):
        return self.started and not self.stopped

    def status(self):
        from hoga.live.rest30_recorder import Rest30sStatus

        return Rest30sStatus(
            running=self.alive,
            target_count=len(self.targets),
            targets=tuple(sorted(self.targets)),
            last_cycle_ms=None,
            last_error=None,
            last_error_count=0,
            degraded=False,
        )


@pytest.mark.asyncio
async def test_rest_only_stops_ws_and_starts_api_recorder(tmp_path, monkeypatch):
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist import save_document
    from hoga.live.settings import LiveSettings, save_live_settings
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    FakeRest30Recorder.created.clear()
    save_live_settings(tmp_path, LiveSettings(storage_policy="rest_only"))
    save_document(
        tmp_path,
        WatchlistDocument(
            folders=[
                WatchlistFolder(
                    id="f_0000000a",
                    name="스윙",
                    order=0,
                    member_codes=["005930", "000660"],
                    capture_enabled=True,
                )
            ],
            entries=[
                WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
                WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            ],
        ),
    )

    class Hit:
        def __init__(self, code):
            self.code = code

    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [Hit("005930"), Hit("000660")],
    )
    monkeypatch.setattr("hoga.live.kis_runtime.configured_account_ids", lambda data_dir: [0])
    monkeypatch.setattr("hoga.live.kis_runtime.ensure_kis_client_from_env", lambda data_dir: object())
    monkeypatch.setattr("hoga.live.rest30_recorder.Rest30sRecorder", FakeRest30Recorder)

    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True

    status = lifecycle.get_status()
    assert status.live_set == []
    assert status.storage_policy == "rest_only"
    assert status.kis_api_targets == ["000660", "005930"]
    assert FakeRest30Recorder.created[0].started is True

    await lifecycle.stop_live_stream()
    assert FakeRest30Recorder.created[0].stopped is True


@pytest.mark.asyncio
async def test_ws_plus_rest_excludes_ws_targets_from_api_recorder(tmp_path, monkeypatch):
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist import save_document
    from hoga.live.settings import LiveSettings, save_live_settings
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    FakeRest30Recorder.created.clear()
    save_live_settings(tmp_path, LiveSettings(storage_policy="ws_plus_rest"))
    save_document(
        tmp_path,
        WatchlistDocument(
            folders=[
                WatchlistFolder(
                    id="f_0000000a",
                    name="스윙",
                    order=0,
                    member_codes=["005930", "000660"],
                    capture_enabled=True,
                )
            ],
            entries=[
                WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
                WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            ],
        ),
    )

    class Hit:
        def __init__(self, code):
            self.code = code

    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [Hit("005930"), Hit("000660")],
    )
    monkeypatch.setattr("hoga.live.coverage._PER_ACCOUNT_MAX", 1)
    monkeypatch.setattr("hoga.live.kis_runtime.configured_account_ids", lambda data_dir: [0])
    monkeypatch.setattr("hoga.live.kis_runtime.ensure_kis_client_from_env", lambda data_dir: object())
    monkeypatch.setattr("hoga.live.rest30_recorder.Rest30sRecorder", FakeRest30Recorder)

    def fake_build_conn(account_id, codes, data_dir):
        from hoga.live.lifecycle import _StreamConn

        async def _forever():
            await asyncio.sleep(60)

        return _StreamConn(
            account_id=account_id,
            stream_obj=object(),
            ws_task=asyncio.create_task(_forever()),
            flush_task=asyncio.create_task(_forever()),
            codes=tuple(codes),
        )

    monkeypatch.setattr("hoga.live.lifecycle._build_conn", fake_build_conn)

    await lifecycle.start_live_stream(data_dir=tmp_path)

    assert lifecycle.get_status().live_set == ["005930"]
    assert lifecycle.get_status().kis_api_targets == ["000660"]
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_kis_rest_bypass_prevents_api_recorder_start(tmp_path, monkeypatch):
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist import save_document
    from hoga.live.settings import LiveSettings, save_live_settings
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    FakeRest30Recorder.created.clear()
    save_live_settings(
        tmp_path,
        LiveSettings(storage_policy="rest_only", kis_rest_bypass_enabled=True),
    )
    save_document(
        tmp_path,
        WatchlistDocument(
            folders=[
                WatchlistFolder(
                    id="f_0000000a",
                    name="스윙",
                    order=0,
                    member_codes=["005930", "000660"],
                    capture_enabled=True,
                )
            ],
            entries=[
                WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
                WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            ],
        ),
    )

    class Hit:
        def __init__(self, code):
            self.code = code

    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [Hit("005930"), Hit("000660")],
    )
    monkeypatch.setattr("hoga.live.kis_runtime.configured_account_ids", lambda data_dir: [0])
    monkeypatch.setattr("hoga.live.kis_runtime.ensure_kis_client_from_env", lambda data_dir: object())
    monkeypatch.setattr("hoga.live.rest30_recorder.Rest30sRecorder", FakeRest30Recorder)

    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True

    status = lifecycle.get_status()
    assert status.storage_policy == "rest_only"
    assert status.kis_rest_bypass_enabled is True
    assert status.kis_api_targets == []
    assert status.kis_api_running is False
    assert FakeRest30Recorder.created == []
