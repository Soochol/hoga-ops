import pytest


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

    async def fake_fetch_for_role(role, data_dir, fn):
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

        return await fn(FakeClient())

    monkeypatch.setattr(
        "hoga.live.program_trade_collector.load_document",
        lambda _data_dir: _watchlist_doc(),
    )
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.kis_access.fetch_for_role",
        fake_fetch_for_role,
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
