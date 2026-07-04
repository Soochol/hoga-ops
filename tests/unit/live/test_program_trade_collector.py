import pytest

import httpx


class _RecordingScheduler:
    def __init__(self, rows_by_code):
        self.rows_by_code = rows_by_code
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key,
        endpoint,
        priority,
        call,
        cooldown_scope=None,
    ):
        self.calls.append(
            {
                "key": key,
                "endpoint": endpoint,
                "priority": priority,
                "cooldown_scope": cooldown_scope,
            }
        )

        class FakeClient:
            async def fetch_program_trade_by_stock(inner_self, code):
                return self.rows_by_code.get(code, [])

        return await call(FakeClient())


def _watchlist_doc():
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder

    return WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_00000001",
                name="저장",
                order=0,
                member_codes=["005930", "000660"],
                capture_enabled=True,
            ),
            WatchlistFolder(
                id="f_00000002",
                name="제외",
                order=1,
                member_codes=["035720"],
                capture_enabled=False,
            ),
        ],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260625"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260625"),
            WatchlistEntry(code="035720", name="카카오", registered_at_kst_date="20260625"),
        ],
    )


@pytest.mark.asyncio
async def test_program_trade_collector_polls_capture_candidates_and_skips_failed_codes(tmp_path, monkeypatch):
    from hoga.live.kis_models import ProgramTradeByStockRow
    from hoga.live.program_trade_collector import ProgramTradeCollector

    calls: list[str] = []

    async def fake_run_with_capacity(
        scheduler,
        *,
        data_dir,
        role,
        key,
        endpoint,
        priority,
        cooldown_scope,
        fetch_fn,
    ):
        assert scheduler is None
        assert role == "background"
        assert endpoint == "program-trade"
        assert priority == "background"
        assert cooldown_scope == "program-trade"
        assert key[0] == "program-trade"

        class FakeClient:
            async def fetch_program_trade_by_stock(self, code):
                calls.append(code)
                if code == "000660":
                    raise RuntimeError("KIS temporary failure")
                return [
                    ProgramTradeByStockRow(
                        code=code,
                        bsop_hour="090000",
                        t_ms=1,
                        price=70000,
                        net_qty=1,
                        net_amount=70000,
                        buy_qty=None,
                        sell_qty=None,
                        buy_amount=None,
                        sell_amount=None,
                        delta_qty=1,
                        delta_amount=70000,
                    )
                ]

        return await fetch_fn(FakeClient())

    monkeypatch.setattr(
        "hoga.live.program_trade_collector.load_document",
        lambda _data_dir: _watchlist_doc(),
    )
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.kis_access.run_with_capacity",
        fake_run_with_capacity,
    )

    collector = ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: "20260625",
        now_ms_fn=lambda: 1000,
    )

    await collector.run_once()

    assert calls == ["005930", "000660"]
    stored = collector.store.load("005930", "20260625")
    assert [r.bsop_hour for r in stored.rows] == ["090000"]
    assert collector.status.last_error_count == 1


@pytest.mark.asyncio
async def test_program_trade_collector_uses_capacity_scheduler(tmp_path, monkeypatch):
    from hoga.live.kis_models import ProgramTradeByStockRow
    from hoga.live.program_trade_collector import ProgramTradeCollector

    row = ProgramTradeByStockRow(
        code="005930",
        bsop_hour="090000",
        t_ms=1,
        price=70000,
        net_qty=1,
        net_amount=70000,
        buy_qty=None,
        sell_qty=None,
        buy_amount=None,
        sell_amount=None,
        delta_qty=1,
        delta_amount=70000,
    )
    scheduler = _RecordingScheduler({"005930": [row], "000660": []})
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.load_document",
        lambda _data_dir: _watchlist_doc(),
    )
    collector = ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: "20260625",
        now_ms_fn=lambda: 1000,
        scheduler=scheduler,
    )

    await collector.run_once()

    assert scheduler.calls == [
        {
            "key": ("program-trade", "005930"),
            "endpoint": "program-trade",
            "priority": "background",
            "cooldown_scope": "program-trade",
        },
        {
            "key": ("program-trade", "000660"),
            "endpoint": "program-trade",
            "priority": "background",
            "cooldown_scope": "program-trade",
        },
    ]
    stored = collector.store.load("005930", "20260625")
    assert [r.bsop_hour for r in stored.rows] == ["090000"]


@pytest.mark.asyncio
async def test_program_trade_collector_skips_fetches_when_market_window_is_closed(tmp_path, monkeypatch):
    from hoga.live.program_trade_collector import ProgramTradeCollector

    calls: list[str] = []

    async def fake_run_with_capacity(*_args, **_kwargs):
        calls.append("called")
        raise AssertionError("collector should not fetch while the market window is closed")

    monkeypatch.setattr(
        "hoga.live.program_trade_collector.load_document",
        lambda _data_dir: _watchlist_doc(),
    )
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.kis_access.run_with_capacity",
        fake_run_with_capacity,
    )

    collector = ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: "20260626",
        now_ms_fn=lambda: 1000,
        should_collect_fn=lambda _now_ms: False,
    )

    await collector.run_once()

    assert calls == []
    assert collector.status.targets == ("005930", "000660")
    assert collector.status.last_cycle_ms == 1000
    assert collector.store.path("005930", "20260626").exists() is False


@pytest.mark.asyncio
async def test_program_trade_collector_logs_transport_without_traceback_and_sets_kind(
    tmp_path,
    monkeypatch,
    caplog,
) -> None:
    from hoga.live.kis_client import KisTransportError
    from hoga.live.program_trade_collector import ProgramTradeCollector

    async def fake_run_with_capacity(
        scheduler,
        *,
        data_dir,
        role,
        key,
        endpoint,
        priority,
        cooldown_scope,
        fetch_fn,
    ):
        raise KisTransportError(httpx.ConnectError("down"))

    monkeypatch.setattr(
        "hoga.live.program_trade_collector.load_document",
        lambda _data_dir: _watchlist_doc(),
    )
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.kis_access.run_with_capacity",
        fake_run_with_capacity,
    )
    collector = ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: "20260625",
        now_ms_fn=lambda: 1000,
    )

    with caplog.at_level("WARNING", logger="hoga.live.program_trade_collector"):
        await collector.run_once()

    records = [r for r in caplog.records if r.name == "hoga.live.program_trade_collector"]
    assert len(records) == 2
    assert all(r.exc_info is None for r in records)
    assert records[0].getMessage() == (
        "program_trade.collector.code_failed code=005930 "
        "kind=transport error=TRANSPORT/ConnectError"
    )
    assert collector.status.last_error_count == 2
    assert collector.status.last_error_kind == "transport"
    assert collector.status.last_error_code == "TRANSPORT/ConnectError"


@pytest.mark.asyncio
async def test_program_trade_collector_unexpected_errors_keep_traceback(
    tmp_path,
    monkeypatch,
    caplog,
) -> None:
    from hoga.live.program_trade_collector import ProgramTradeCollector

    async def fake_run_with_capacity(
        scheduler,
        *,
        data_dir,
        role,
        key,
        endpoint,
        priority,
        cooldown_scope,
        fetch_fn,
    ):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        "hoga.live.program_trade_collector.load_document",
        lambda _data_dir: _watchlist_doc(),
    )
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.kis_access.run_with_capacity",
        fake_run_with_capacity,
    )
    collector = ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: "20260625",
        now_ms_fn=lambda: 1000,
    )

    with caplog.at_level("ERROR", logger="hoga.live.program_trade_collector"):
        await collector.run_once()

    records = [r for r in caplog.records if r.name == "hoga.live.program_trade_collector"]
    assert len(records) == 2
    assert all(r.exc_info is not None for r in records)
    assert records[0].getMessage() == (
        "program_trade.collector.code_failed code=005930 "
        "kind=unexpected error=RuntimeError"
    )
    assert collector.status.last_error_count == 2
    assert collector.status.last_error_kind == "unexpected"
    assert collector.status.last_error_code == "RuntimeError"
