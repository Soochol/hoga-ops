"""Observe Kiwoom account contracts without orders, token issuance, or WebSockets.

This is a research probe, not a trading adapter. Even with real credentials its
transport admits only the seven allowlisted read TRs. It reuses an unexpired,
key-matching token cache without modifying that cache or loading the repo .env.
Reports contain schema/count evidence, never account numbers, balances, or tokens.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import time
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import dotenv_values

REAL_HOST = "api.kiwoom.com"
MOCK_HOST = "mockapi.kiwoom.com"
MIN_TOKEN_LIFETIME_SECONDS = 60
KST = timezone(timedelta(hours=9))
READ_PATHS = {
    "ka00001": "/api/dostk/acnt",
    "ka10001": "/api/dostk/stkinfo",
    "ka10075": "/api/dostk/acnt",
    "kt00007": "/api/dostk/acnt",
    "kt00018": "/api/dostk/acnt",
    "kt00010": "/api/dostk/acnt",
    "kt00011": "/api/dostk/acnt",
}


class ProbeError(RuntimeError):
    """Only non-sensitive diagnostics may cross this boundary."""


class ReadOnlyTransport(httpx.AsyncBaseTransport):
    """Enforce the read allowlist at the final HTTP boundary, including redirects."""

    def __init__(self, host: str, inner: httpx.AsyncBaseTransport) -> None:
        if host not in {REAL_HOST, MOCK_HOST}:
            raise ProbeError("host-not-allowed")
        self.host = host
        self.inner = inner
        self.dispatched = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        api_id = request.headers.get("api-id", "")
        if (
            request.method != "POST"
            or request.url.scheme != "https"
            or request.url.host != self.host
            or request.url.port not in {None, 443}
            or request.url.path != READ_PATHS.get(api_id)
            or request.url.query
            or request.url.username
            or request.url.password
        ):
            raise ProbeError("read-only-transport-blocked")
        self.dispatched += 1
        return await self.inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self.inner.aclose()


def cached_token(path: Path, app_key: str, *, now: datetime | None = None) -> str:
    """Read only. In particular, never call the production token provider to refresh."""
    try:
        data = json.loads(path.read_text())
        expected = hashlib.sha256(app_key.encode()).hexdigest()[:16]
        if data["app_key_sha256"] != expected:
            raise ProbeError("token-key-mismatch")
        expires = datetime.fromisoformat(data["expires_at"])
        if expires.tzinfo is None:
            raise ProbeError("token-expiry-timezone-missing")
        if (expires - (now or datetime.now(UTC))).total_seconds() < MIN_TOKEN_LIFETIME_SECONDS:
            raise ProbeError("token-expired-no-refresh")
        token = data["access_token"]
        if not isinstance(token, str) or not token:
            raise ProbeError("token-missing")
        return token
    except (OSError, KeyError, ValueError, TypeError) as exc:
        raise ProbeError("token-cache-unavailable") from exc


def shape(body: dict[str, Any]) -> dict[str, Any]:
    """Retain field names, types, and row counts, not customer data."""
    result: dict[str, Any] = {"fields": sorted(body), "lists": {}}
    for key, value in body.items():
        if isinstance(value, list):
            fields = sorted({k for row in value if isinstance(row, dict) for k in row})
            result["lists"][key] = {"rows": len(value), "row_fields": fields}
    return result


class ReadOnlyProbe:
    def __init__(
        self,
        token: str,
        *,
        host: str = REAL_HOST,
        transport: httpx.AsyncBaseTransport | None = None,
        pace: float = 1.1,
    ) -> None:
        self.transport = ReadOnlyTransport(host, transport or httpx.AsyncHTTPTransport(retries=0))
        self.client = httpx.AsyncClient(
            base_url=f"https://{host}",
            transport=self.transport,
            follow_redirects=False,
            trust_env=False,
            timeout=12,
            headers={"authorization": f"Bearer {token}"},
        )
        self.pace = pace
        self.last = float("-inf")
        self.records: list[dict[str, Any]] = []

    async def close(self) -> None:
        await self.client.aclose()

    async def page(
        self,
        api_id: str,
        body: dict[str, str],
        *,
        next_key: str = "",
    ) -> tuple[dict[str, Any], str | None]:
        if api_id not in READ_PATHS:
            raise ProbeError("read-tr-not-allowed")
        delay = self.last + self.pace - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        self.last = time.monotonic()
        started = self.last
        try:
            response = await self.client.post(
                READ_PATHS[api_id],
                json=body,
                headers={
                    "api-id": api_id,
                    "cont-yn": "Y" if next_key else "N",
                    "next-key": next_key,
                    "Content-Type": "application/json;charset=UTF-8",
                },
            )
        except httpx.HTTPError as exc:
            raise ProbeError(f"read-transport-failed:{api_id}:{type(exc).__name__}") from exc
        record: dict[str, Any] = {
            "api_id": api_id,
            "http_status": response.status_code,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 1),
            "venue": body.get("dmst_stex_tp", body.get("stex_tp")),
        }
        self.records.append(record)
        if not response.is_success:
            raise ProbeError(f"read-http-failed:{api_id}:{response.status_code}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProbeError(f"read-invalid-json:{api_id}") from exc
        if not isinstance(payload, dict):
            raise ProbeError(f"read-invalid-envelope:{api_id}")
        code = payload.get("return_code")
        record["return_code"] = code if isinstance(code, (int, str)) and re.fullmatch(r"-?\d+", str(code)) else None
        record["shape"] = shape(payload)
        if type(code) not in {int, str} or str(code) != "0":
            # Vendor text can contain account data. Keep only its short error IDs.
            message = payload.get("return_msg", "")
            if isinstance(message, str):
                record["vendor_reason_codes"] = re.findall(r"(?:\[|\()(\d{4,6})(?=:|\])", message)[:20]
            raise ProbeError(f"read-vendor-rejected:{api_id}")
        if response.headers.get("cont-yn") == "Y":
            cursor = response.headers.get("next-key")
            if not cursor:
                raise ProbeError(f"read-missing-cursor:{api_id}")
            return payload, cursor
        return payload, None

    async def walk(self, api_id: str, body: dict[str, str]) -> list[dict[str, Any]]:
        pages = []
        seen: set[str] = set()
        cursor = ""
        for _ in range(20):
            payload, next_key = await self.page(api_id, body, next_key=cursor)
            pages.append(payload)
            if next_key is None:
                return pages
            if next_key in seen:
                raise ProbeError(f"read-repeated-cursor:{api_id}")
            seen.add(next_key)
            cursor = next_key
        raise ProbeError(f"read-incomplete-pagination:{api_id}")


async def inspect_account(probe: ReadOnlyProbe, code: str, order_date: str, host: str) -> dict[str, Any]:
    result: dict[str, Any] = {"queries": {}, "binding": {}}
    account, _ = await probe.page("ka00001", {})
    acct = account.get("acctNo")
    if not isinstance(acct, str) or not re.fullmatch(r"\d{10}", acct):
        raise ProbeError("unexpected-account-identity-shape")
    result["binding"] = {"verified_from_token": True, "account_number_length": len(acct)}
    quote, _ = await probe.page("ka10001", {"stk_cd": code})
    try:
        price = abs(int(quote["cur_prc"]))
        if price <= 0:
            raise ValueError("nonpositive")
    except (KeyError, ValueError, TypeError) as exc:
        raise ProbeError("quote-price-unavailable") from exc
    reads = [
        ("ka10075", {"all_stk_tp": "0", "trde_tp": "0", "stk_cd": "", "stex_tp": "0"}),
        (
            "kt00007",
            {
                "ord_dt": order_date,
                "qry_tp": "1",
                "stk_bond_tp": "1",
                "sell_tp": "0",
                "stk_cd": "",
                "fr_ord_no": "",
                "dmst_stex_tp": "%",
            },
        ),
        ("kt00018", {"qry_tp": "2", "dmst_stex_tp": "KRX"}),
        ("kt00011", {"stk_cd": code, "uv": str(price)}),
        ("kt00010", {"stk_cd": code, "trde_tp": "2", "trde_qty": "1", "uv": str(price)}),
    ]
    if host == REAL_HOST:
        reads.append(("kt00018", {"qry_tp": "2", "dmst_stex_tp": "NXT"}))
    for api_id, body in reads:
        label = f"{api_id}:{body.get('dmst_stex_tp', '')}"
        try:
            pages = await probe.walk(api_id, body)
            result["queries"][label] = {"status": "ok", "pages": len(pages)}
        except ProbeError as exc:
            result["queries"][label] = {"status": "failed", "reason": str(exc)}
    return result


async def run(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    values = {**(dotenv_values(args.env_file) if args.env_file else {}), **os.environ}
    suffix = f"_{args.account_index + 1}" if args.account_index else ""
    key_name = "KIWOOM_MOCK_APP_KEY" if args.environment == "mock" else f"KIWOOM_APP_KEY{suffix}"
    report: dict[str, Any] = {
        "observed_at": datetime.now(KST).isoformat(),
        "environment": args.environment,
        "credential_alias": key_name,
        "code": args.code,
        "order_date": args.order_date,
        "orders_sent": 0,
        "websockets_opened": 0,
        "tokens_issued": 0,
    }
    probe = None
    try:
        key = values.get(key_name)
        if not key:
            raise ProbeError("credential-key-missing")
        token = cached_token(args.token_cache, key)
        host = REAL_HOST if args.environment == "real" else MOCK_HOST
        probe = ReadOnlyProbe(token, host=host)
        report["account"] = await inspect_account(probe, args.code, args.order_date, host)
        failed = any(v["status"] != "ok" for v in report["account"]["queries"].values())
        report["status"] = "partial" if failed else "ok"
        return report, 1 if failed else 0
    except ProbeError as exc:
        report.update(status="blocked", reason=str(exc))
        return report, 2
    finally:
        if probe:
            report["requests"] = probe.records
            report["read_requests_sent"] = probe.transport.dispatched
            await probe.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--token-cache", type=Path, required=True)
    parser.add_argument("--environment", choices=["real", "mock"], default="mock")
    parser.add_argument("--account-index", type=int, choices=range(100), default=0)
    parser.add_argument("--code", default="005930")
    parser.add_argument("--order-date", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9]{6}", args.code):
        parser.error("--code must be a six-character domestic stock code")
    try:
        datetime.strptime(args.order_date, "%Y%m%d")
    except ValueError:
        parser.error("--order-date must be YYYYMMDD")
    report, status = asyncio.run(run(args))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    summary = {k: report[k] for k in ("status", "orders_sent", "websockets_opened", "tokens_issued")}
    print(json.dumps(summary, ensure_ascii=False))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
