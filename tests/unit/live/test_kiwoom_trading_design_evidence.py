"""Executable counterexamples to reusing market-data plumbing for trading.

These characterize current code, not Kiwoom's live order execution. Official
documentation examples are labelled as such; all account/order I/O is synthetic.
When the trading integration lands, replace these counterexamples with its
positive isolation/event-delivery contracts.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hoga.live.kiwoom_access import run_with_capacity
from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler
from hoga.live.kiwoom_errors import KiwoomAuthError, KiwoomRateLimitError
from hoga.live.kiwoom_session import KiwoomSessionManager, _KiwoomConn
from hoga.live.kiwoom_ws_client import KiwoomWsClient
from hoga.trading.models import TossOrder
from hoga.trading.service import CommandJournal, remaining
from hoga.util.timeenc import KST

CONTRACT = json.loads((Path(__file__).parents[2] / "fixtures/kiwoom_trading/official_contract.json").read_text())
NOW = int(datetime(2026, 10, 16, 10, tzinfo=KST).timestamp() * 1000)


async def test_requested_market_client_is_overridden_when_another_bucket_is_ready():
    """Passing client=A does not pin an account with today's public access seam."""
    clients = [SimpleNamespace(account_id=i) for i in range(2)]
    scheduler = KiwoomCapacityScheduler(rate_per_sec=10000)
    scheduler.set_clients(clients)
    scheduler._penalize_if_rate_limited(0, "ka10075", KiwoomRateLimitError("1700"))

    async def identity(client):
        return client.account_id

    try:
        actual = await run_with_capacity(
            scheduler,
            key=("orders", "005930"),
            api_id="ka10075",
            priority="user_visible",
            fetch_fn=identity,
            client=clients[0],
        )
        assert actual == 1  # A trading account must never inherit this failover.
    finally:
        await scheduler.aclose()


async def test_synthetic_order_call_is_retried_on_another_account_after_auth_error():
    """The market scheduler has no read/write distinction; no HTTP is performed."""
    clients = [SimpleNamespace(account_id=i, invalidate_token=AsyncMock()) for i in range(2)]
    scheduler = KiwoomCapacityScheduler(rate_per_sec=10000)
    scheduler.set_clients(clients)
    seen = []

    async def synthetic_order(client):
        seen.append(client.account_id)
        if client.account_id == 0:
            raise KiwoomAuthError("synthetic invalid token")
        return "accepted-by-other-account"

    try:
        result = await run_with_capacity(
            scheduler,
            key="synthetic-command",
            api_id="kt10000",
            priority="user_visible",
            fetch_fn=synthetic_order,
            client=clients[0],
        )
        assert result == "accepted-by-other-account"
        assert seen == [0, 1]
    finally:
        await scheduler.aclose()


async def test_accountless_dedup_key_joins_distinct_account_requests():
    scheduler = KiwoomCapacityScheduler(rate_per_sec=10000)
    gate = asyncio.Event()
    started = asyncio.Event()
    seen = []

    async def read_balance(client):
        seen.append(client.account_id)
        started.set()
        await gate.wait()
        return client.account_id

    def request(account):
        return run_with_capacity(
            scheduler,
            key=("balance", "005930"),
            api_id="kt00018",
            priority="user_visible",
            fetch_fn=read_balance,
            client=SimpleNamespace(account_id=account),
        )

    first = asyncio.create_task(request(0))
    try:
        await started.wait()
        second = asyncio.create_task(request(1))
        await asyncio.sleep(0)
        gate.set()
        assert await asyncio.gather(first, second) == [0, 0]
        assert seen == [0]
    finally:
        gate.set()
        await scheduler.aclose()


@pytest.mark.parametrize("api_id", ["00", "04"])
async def test_official_account_frames_are_not_delivered_by_market_dispatch(api_id):
    callback = AsyncMock()
    client = KiwoomWsClient(token_fn=AsyncMock(return_value="unused"), on_tick=callback, date_fn=lambda: "20261016")
    frame = CONTRACT["apis"][api_id]["frame"]
    assert frame["data"][0]["values"]["9201"]  # Contains an account event.
    await client._dispatch_real(frame, NOW)
    callback.assert_not_awaited()
    assert client.last_tick_ms is None


async def test_empty_market_targets_cancel_an_existing_session(tmp_path):
    async def idle():
        await asyncio.Event().wait()

    manager = KiwoomSessionManager(buffer=object(), data_dir=tmp_path, date_fn=lambda: "20261016", now_fn=lambda: NOW)
    ws_task, flush_task = asyncio.create_task(idle()), asyncio.create_task(idle())
    await asyncio.sleep(0)
    manager._conns[0] = _KiwoomConn(
        account_id=0,
        stream=object(),
        client=SimpleNamespace(kicked_by_peer=False),
        ws_task=ws_task,
        flush_task=flush_task,
        codes=("005930",),
    )
    try:
        await manager.sync((), n_accounts=1)
        assert not manager._conns
        assert ws_task.cancelled() and flush_task.cancelled()
    finally:
        await manager.stop()


def test_bridge_using_toss_quantity_minus_fills_loses_partial_cancel_remainder():
    """Synthetic 100 ordered / 30 filled / 20 cancelled must leave 50, not 70."""
    order = TossOrder.model_validate(
        {
            "orderId": "0000018",
            "symbol": "005930",
            "side": "BUY",
            "orderType": "LIMIT",
            "timeInForce": "DAY",
            "status": "PARTIAL_FILLED",
            "price": "60000",
            "quantity": "100",
            "currency": "KRW",
            "orderedAt": "2026-10-16T10:00:00+09:00",
            "execution": {"filledQuantity": "30"},
            "remaining_quantity": "50",
        }
    )
    assert remaining(order) == 70
    assert remaining(order) != 50  # Explicit broker remainder needs its own field.


def test_legacy_journal_account_number_alone_cannot_isolate_a_second_broker(tmp_path):
    journal = CommandJournal(tmp_path / "commands.sqlite3")
    payload = {"account_seq": 1, "code": "005930", "action": "create", "order_id": ""}
    journal.begin("toss-unknown", payload)
    journal.finish("toss-unknown", "unknown", {})
    assert journal.unresolved(1, "005930") == ["toss-unknown"]
    # A naive Kiwoom account_seq=1 bridge sees precisely this same unresolved set.
    assert "broker" not in payload and "environment" not in payload


def test_kiwoom_contract_needs_remaining_and_operation_lineage():
    apis = CONTRACT["apis"]
    assert CONTRACT["source_kind"] == "official_documentation_examples_not_server_capture"
    assert "clientOrderId" not in apis["kt10000"]["required_request_fields"]
    assert {"ord_no", "base_orig_ord_no"} <= set(apis["kt10002"]["response_fields"])
    assert {"ord_no", "base_orig_ord_no"} <= set(apis["kt10003"]["response_fields"])
    assert "oso_qty" in apis["ka10075"]["response_fields"]
    assert "ord_remnq" in apis["kt00007"]["response_fields"]
