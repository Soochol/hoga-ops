"""Bounded market-data probe; cached token only, no app startup or token refresh.

Run with an idle account confirmed by the existing local server. Only LOGIN,
market-data REG and PING may be sent; HTTP admits two chart-read TRs. Output
contains public prices and connection metadata, never credentials or accounts.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import websockets
from dotenv import dotenv_values
from websockets.exceptions import WebSocketException

NY = ZoneInfo("America/New_York")
FIELDS = {"10", "13", "15", "16", "17", "18", "20", "22", "290", "51020"}
BAR_FIELDS = {"cur_prc", "open_pric", "high_pric", "low_pric", "trde_qty",
              "acc_trde_qty", "cntr_tm", "bus_dt", "dt"}
SUBJECTS = [("ND", "AAPL"), ("ND", "NVDA"), ("NY", "KO"), ("NY", "BRKb"), ("NA", "AAAA")]
RECONNECT_AFTER_READS = 24


def utc():
    return datetime.now(UTC).isoformat()


async def main(args):
    report = {"started_at_utc": utc(), "account_index": args.account_index,
              "tokens_issued": 0, "token_cache_written": False, "orders_sent": 0,
              "ws": {}, "rest": [], "errors": [], "record_limit": 100_000}
    suffix = f"_{args.account_index + 1}" if args.account_index else ""
    key = dotenv_values(args.env_file).get(f"KIWOOM_APP_KEY{suffix}")
    cache = json.loads(args.token_cache.read_text())
    assert key and cache["app_key_sha256"] == hashlib.sha256(key.encode()).hexdigest()[:16]
    expiry = datetime.fromisoformat(cache["expires_at"])
    assert (expiry - datetime.now(UTC)).total_seconds() > args.seconds + 120
    token = cache["access_token"]
    cache_hash = hashlib.sha256(args.token_cache.read_bytes()).hexdigest()
    sockets, tasks = [], []
    async with httpx.AsyncClient(timeout=10, trust_env=False, follow_redirects=False) as http:
        async def health():
            result = {}
            for path in ["/health", "/api/live/status"]:
                d = (await http.get(args.origin + path)).json()
                if path == "/health":
                    result["health"] = d
                else:
                    k = d.get("kiwoom") or {}
                    result["kiwoom"] = {f: k.get(f) for f in
                                         ["connected_accounts", "connection_allowed", "last_recv_ms"]}
                    result["account"] = next((
                        {f: a.get(f) for f in ["account_id", "connected", "connection_generation"]}
                        for a in k.get("accounts", []) if a["account_id"] == args.account_index), None)
            return result

        report["before"] = await health()
        assert report["before"]["account"] and not report["before"]["account"]["connected"]
        last_read = float("-inf")

        async def read(exchange, symbol, period):
            nonlocal last_read
            await asyncio.sleep(max(0, last_read + 1.1 - time.monotonic()))
            last_read = time.monotonic()
            api = "usa06012" if period == "D" else "usa06011"
            assert api in {"usa06011", "usa06012"}
            body = {"stex_tp": exchange, "stk_cd": symbol,
                    "strt_dt": datetime.now(NY).strftime("%Y%m%d"),
                    "upd_stkpc_tp": "0", "exrt_appl_tp": "0"}
            if period != "D":
                body["tic_scope"] = period
            row = {"started_at_utc": utc(), "exchange": exchange, "symbol": symbol, "period": period}
            try:
                r = await http.post("https://api.kiwoom.com/api/us/chart", json=body,
                                    headers={"authorization": f"Bearer {token}", "api-id": api,
                                             "cont-yn": "N", "Content-Type": "application/json;charset=UTF-8"})
                d = r.json()
                row.update(http_status=r.status_code, return_code=d.get("return_code"),
                           elapsed_ms=round((time.monotonic() - last_read) * 1000, 3),
                           rows=[{k: v for k, v in b.items() if k in BAR_FIELDS}
                                 for b in d.get("result_list", [])[:100]])
            except (httpx.HTTPError, ValueError, TypeError) as exc:
                row["error"] = type(exc).__name__
            row["finished_at_utc"] = utc()
            report["rest"].append(row)

        async def connect(label, path, data):
            ws = await websockets.connect("wss://api.kiwoom.com:10000" + path,
                                          open_timeout=12, close_timeout=3, max_size=2**21)
            sockets.append(ws)
            state = report["ws"][label] = {"connected_at_utc": utc(), "controls": [], "pings": 0,
                                           "records": [], "dropped_records": 0}
            await ws.send(json.dumps({"trnm": "LOGIN", "token": token}))
            while True:
                message = json.loads(await asyncio.wait_for(ws.recv(), 12))
                if message.get("trnm") == "PING":
                    await ws.send(json.dumps(message))
                    continue
                if message.get("trnm") == "LOGIN":
                    state["controls"].append({"at": utc(), "trnm": "LOGIN", "code": message.get("return_code")})
                    assert message.get("return_code") == 0
                    break
            await ws.send(json.dumps({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": data}))

            async def receive():
                try:
                    async for raw in ws:
                        m = json.loads(raw)
                        typ = m.get("trnm")
                        if typ == "PING":
                            state["pings"] += 1
                            state["last_ping_at_utc"] = utc()
                            await ws.send(raw)
                        elif typ == "REAL" and label.startswith("us"):
                            for record in m.get("data", []):
                                if record.get("type") != "FE":
                                    continue
                                if len(state["records"]) >= report["record_limit"]:
                                    state["dropped_records"] += 1
                                    continue
                                state["records"].append({"received_at_utc": utc(), "item": record.get("item"),
                                                         "exchange": record.get("stexTp"),
                                                         "values": {k: v for k, v in record.get("values", {}).items()
                                                                    if k in FIELDS}})
                        elif typ in {"LOGIN", "REG", "REMOVE"}:
                            state["controls"].append({"at": utc(), "trnm": typ, "code": m.get("return_code")})
                except (WebSocketException, ValueError, TypeError) as exc:
                    state["receive_error"] = type(exc).__name__
                    state["close_code"] = getattr(exc, "code", None)
                finally:
                    state["receiver_ended_at_utc"] = utc()
                    state["close_code"] = ws.close_code
            task = asyncio.create_task(receive())
            tasks.append(task)
            return ws, task

        try:
            # Both sockets belong to this idle-account probe, never the running app.
            await connect("domestic_control", "/api/dostk/websocket",
                          [{"item": ["005930"], "type": ["0B"]}])
            await asyncio.sleep(2)
            us_ws, us_task = await connect("us", "/api/us/websocket", [{
                "item": [{"jmcode": symbol, "stex_tp": exchange} for exchange, symbol in SUBJECTS],
                "type": ["FE"]}])
            deadline = time.monotonic() + args.seconds
            for exchange, symbol in SUBJECTS:
                await read(exchange, symbol, "1")
                await read(exchange, symbol, "D")
            periods = ["1", "3", "5", "10", "15", "30", "60", "D"]
            i = 0
            while time.monotonic() < deadline:
                period = "1" if i % 2 == 0 else periods[(i // 2) % len(periods)]
                await read("ND", "AAPL", period)
                if i % 8 == 0:
                    print(json.dumps({"elapsed_seconds": round(args.seconds - deadline + time.monotonic()),
                                      "records": len(report["ws"]["us"]["records"]),
                                      "reads": len(report["rest"])}), flush=True)
                i += 1
                # Reconnect our US socket once, leaving our domestic socket intact.
                if i == RECONNECT_AFTER_READS:
                    report["reconnect_at_utc"] = utc()
                    await us_ws.close()
                    await us_task
                    us_ws, us_task = await connect("us_reconnected", "/api/us/websocket", [{
                        "item": [{"jmcode": "AAPL", "stex_tp": "ND"}], "type": ["FE"]}])
                await asyncio.sleep(2.9)
            for exchange, symbol in SUBJECTS:
                await read(exchange, symbol, "1")
                await read(exchange, symbol, "D")
        except (WebSocketException, httpx.HTTPError, ValueError, TypeError,
                AssertionError, OSError, TimeoutError) as exc:
            report["errors"].append(type(exc).__name__)
        finally:
            for ws in reversed(sockets):
                await ws.close()
            await asyncio.gather(*tasks, return_exceptions=True)
            report["after"] = await health()
            report["cache_content_unchanged"] = cache_hash == hashlib.sha256(args.token_cache.read_bytes()).hexdigest()
            report["finished_at_utc"] = utc()
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps({"finished": True, "errors": report["errors"], "reads": len(report["rest"]),
                              "records": {k: len(v["records"]) for k, v in report["ws"].items()},
                              "cache_content_unchanged": report["cache_content_unchanged"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--token-cache", type=Path, required=True)
    parser.add_argument("--account-index", type=int, required=True)
    parser.add_argument("--origin", default="http://127.0.0.1:8000")
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("--out", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
