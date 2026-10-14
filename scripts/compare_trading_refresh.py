"""Isolated MockTransport comparison; never authenticates or contacts a real broker.

Compare account-wide read suspension, continuous coalesced REST refreshes, and
validated order-event display updates. All policies keep fresh REST prechecks,
command journaling, identical quotas, wire latency, and broker fill schedules.
Run: PYTHONPATH=. uv run python scripts/compare_trading_refresh.py --repeat 3
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import tempfile
import time
from pathlib import Path

import httpx

from hoga.trading.models import ModifyTradingOrder, TradingCommand
from hoga.trading.service import TradingService
from hoga.trading.toss import TossClient

CODE = "005930"
ORDER_COUNT = 5


def order(oid: str, price: str = "67200") -> dict:
    return {"orderId": oid, "symbol": CODE, "side": "BUY", "orderType": "LIMIT", "timeInForce": "DAY",
            "status": "PARTIAL_FILLED", "price": price, "quantity": "100", "currency": "KRW",
            "orderedAt": "2026-10-14T10:00:00+09:00", "execution": {"filledQuantity": "30"}}


async def sample(policy: str, action: str, rtt: float) -> dict:  # noqa: PLR0915 - one isolated, identical policy fixture
    inventory = {f"item-{i}": order(f"item-{i}") for i in range(ORDER_COUNT)}
    inventory["other"] = order("other", "67100")
    counts = {"GET": 0, "POST": 0}
    last_read = {}
    payload_checks = []
    started = 0.0
    measured = False
    fills = []
    seen = {}
    reads_task = None
    dirty = False
    writing = True
    service = None

    def display(snapshot):
        if snapshot.orderId != "other":
            return
        filled = int(snapshot.execution.filledQuantity)
        for qty, at in fills:
            if filled >= qty and qty not in seen:
                seen[qty] = (time.perf_counter() - at) * 1000

    def render(state):
        for snapshot in state.orders:
            display(snapshot)

    async def refresh():
        nonlocal dirty, reads_task
        try:
            while dirty:
                dirty = False
                await asyncio.sleep(0.08)  # Same burst coalescing window as the UI.
                render(await service.order_state(1, CODE))
        finally:
            reads_task = None

    def changed(_revision):
        nonlocal dirty, reads_task
        if not measured or (writing and policy != "continuous_rest"):
            return
        dirty = True
        if reads_task is None:
            reads_task = asyncio.create_task(refresh())

    def stream(_account, snapshot, _revision):
        if measured:
            display(snapshot)

    def event(snapshot):
        service.order_event({"topic": "personal:order:1", "data": {"accountSeq": "1", "order": snapshot}})

    async def transport(request):
        await asyncio.sleep(rtt)
        path = request.url.path
        if path == "/oauth2/token":
            return httpx.Response(200, json={"access_token": "fake", "expires_in": 86400})
        if measured:
            counts[request.method] += 1
        if path == "/api/v1/accounts":
            value = [{"accountType": "BROKERAGE", "accountSeq": 1, "accountNo": "test"}]
        elif path == "/api/v1/stocks":
            value = [{"symbol": CODE, "market": "KOSPI", "currency": "KRW"}]
        elif path == "/api/v1/buying-power":
            value = {"cashBuyingPower": "100000000"}
        elif path == "/api/v1/sellable-quantity":
            value = {"sellableQuantity": "100"}
        elif path == "/api/v1/holdings":
            value = {"items": []}
        elif request.method == "POST":
            oid = path.split("/")[-2]
            current = inventory[oid]
            body = json.loads(request.content)
            if action == "modify":
                payload_checks.append(int(body["quantity"]) == last_read[oid])
            current["status"] = "CANCELED" if action == "cancel" else "REPLACED"
            event(current)
            operation = f"op-{oid}"
            inventory[operation] = {**current, "orderId": operation}
            value = {"orderId": operation}
        elif path == "/api/v1/orders":
            is_open = request.url.params["status"] == "OPEN"
            value = {"orders": [o.copy() for o in inventory.values()
                                 if (o["status"] in {"PENDING", "PARTIAL_FILLED"}) == is_open]}
        else:
            value = inventory[path.rsplit("/", 1)[-1]]
            last_read[value["orderId"]] = int(value["quantity"]) - int(value["execution"]["filledQuantity"])
        return httpx.Response(200, json={"result": value})

    client = TossClient("fake", "fake", transport=httpx.MockTransport(transport))
    with tempfile.TemporaryDirectory() as directory:
        service = TradingService(Path(directory), client, on_change=changed,
                                 on_order_change=stream if policy == "event_overlay" else None)
        service.start_events = lambda: None
        await service.state(1, CODE)
        await asyncio.sleep(0.45)
        measured = True
        started = time.perf_counter()

        async def feed():
            for at, qty in [(0.05, "40"), (0.35, "50"), (0.65, "60")]:
                await asyncio.sleep(max(0, started + at - time.perf_counter()))
                inventory["other"]["execution"] = {"filledQuantity": qty}
                if qty == "50":
                    inventory["item-2"]["execution"] = {"filledQuantity": "40"}
                    event(inventory["item-2"])
                fills.append((int(qty), time.perf_counter()))
                event(inventory["other"])

        feed_task = asyncio.create_task(feed())
        commands = []
        for i in range(ORDER_COUNT):
            common = {"account_seq": 1, "code": CODE, "command_id": f"{action}-{i}"}
            command = ModifyTradingOrder(**common, price=67000) if action == "modify" else TradingCommand(**common)
            commands.append(command)
            await service.execute(command, action, f"item-{i}")
        write_ms = (time.perf_counter() - started) * 1000
        writing = False
        await feed_task
        if reads_task:
            await reads_task
        render(await service.order_state(1, CODE))
        counts_before_dedup = counts.copy()
        await service.execute(commands[0], action, "item-0")
        dedup = counts == counts_before_dedup
        await service.close()
    assert len(seen) == len(fills)
    assert counts["POST"] == ORDER_COUNT and dedup and all(payload_checks)
    return {"policy": policy, "action": action, "broker_rtt_ms": rtt * 1000,
            "write_complete_ms": round(write_ms, 1), "fill_to_display_max_ms": round(max(seen.values()), 1),
            "fill_to_display_median_ms": round(statistics.median(seen.values()), 1),
            "vendor_gets": counts["GET"], "vendor_posts": counts["POST"],
            "fresh_remainder_validated": all(payload_checks), "same_command_not_replayed": dedup}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--rtt", type=float, default=0.08)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    results = []
    for action in ["cancel", "modify"]:
        for policy in ["pause_reads", "continuous_rest", "event_overlay"]:
            for _ in range(args.repeat):
                result = await sample(policy, action, args.rtt)
                results.append(result)
                print(json.dumps(result), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        "note": "Isolated mock broker; display-data latency, not browser paint or real-account latency.",
        "samples": results,
    }, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
