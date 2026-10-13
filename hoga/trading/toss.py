"""Official contract: https://developers.tossinvest.com/llms.txt (2026-10-13).

Credentials never leave the backend. Writes are never implicitly retried.
Unknown write outcomes are distinct from rejected writes.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

HTTP_UNAUTHORIZED = 401
HTTP_SERVER_ERROR = 500


class TradingError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class TossClient:
    BASE_URL = "https://openapi.tossinvest.com"
    WS_URL = "wss://openapi-ws.tossinvest.com/ws/v1"

    def __init__(
        self, client_id: str, client_secret: str, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self.http = httpx.AsyncClient(base_url=self.BASE_URL, timeout=12, transport=transport)
        self._token = ""
        self._expires_at = 0.0
        self._token_lock = asyncio.Lock()
        self._rate_lock = asyncio.Lock()
        self._next: dict[str, float] = {}

    async def close(self) -> None:
        await self.http.aclose()

    def invalidate_token(self) -> None:
        self._expires_at = 0

    async def token(self) -> str:
        async with self._token_lock:
            if self._token and time.monotonic() < self._expires_at:
                return self._token
            try:
                response = await self.http.post(
                    "/oauth2/token",
                    data={
                        "grant_type": "client_credentials",
                        "client_id": self._client_id,
                        "client_secret": self._client_secret,
                    },
                )
                response.raise_for_status()
                body = response.json()
                self._token = body["access_token"]
                self._expires_at = time.monotonic() + max(0, int(body["expires_in"]) - 60)
                return self._token
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                # Never expose token responses, credentials, or HTTP exception reprs.
                raise TradingError(
                    503, "toss-auth-unavailable", "토스증권 인증을 확인하세요. 허용 IP와 API 설정을 확인해주세요."
                ) from exc

    async def _pace(self, path: str, method: str) -> None:
        group, interval = ("order", 0.12) if method == "POST" else ("history", 0.25)
        if path == "/api/v1/accounts":
            group, interval = "account", 1.05
        elif path in ("/api/v1/buying-power", "/api/v1/sellable-quantity"):
            group, interval = "info", 0.4
        elif path == "/api/v1/stocks":
            group, interval = "stock", 0.25
        elif path == "/api/v1/holdings":
            group, interval = "asset", 0.25
        async with self._rate_lock:
            slot = max(time.monotonic(), self._next.get(group, 0))
            self._next[group] = slot + interval
        await asyncio.sleep(max(0, slot - time.monotonic()))

    async def request(
        self,
        method: str,
        path: str,
        *,
        account: int | None = None,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        token = await self.token()  # Auth failure is known to precede order submission.
        await self._pace(path, method)
        headers = {"Authorization": f"Bearer {token}"}
        if account is not None:
            headers["X-Tossinvest-Account"] = str(account)
        try:
            response = await self.http.request(method, path, headers=headers, params=params, json=body)
        except httpx.HTTPError as exc:
            raise TradingError(
                503,
                "order-outcome-unknown" if method == "POST" else "toss-unavailable",
                "주문 결과를 확인할 수 없습니다. 미체결·체결 내역을 확인하세요."
                if method == "POST"
                else "토스증권 조회 연결을 확인하세요.",
            ) from exc
        if response.status_code == HTTP_UNAUTHORIZED:
            self._expires_at = 0  # Refresh on the next call, never replay this write.
        try:
            payload = response.json()
        except ValueError as exc:
            raise TradingError(
                503,
                "order-outcome-unknown" if method == "POST" else "invalid-toss-response",
                "토스증권 응답을 확인할 수 없습니다.",
            ) from exc
        if not isinstance(payload, dict):
            raise TradingError(
                503,
                "order-outcome-unknown" if method == "POST" else "invalid-toss-response",
                "토스증권 응답 형식이 올바르지 않습니다.",
            )
        if not response.is_success:
            error = payload.get("error", {})
            if response.status_code >= HTTP_SERVER_ERROR:
                raise TradingError(
                    503,
                    "order-outcome-unknown" if method == "POST" else "toss-unavailable",
                    "토스증권 처리 결과를 확인할 수 없습니다.",
                )
            raise TradingError(
                response.status_code,
                str(error.get("code", "toss-rejected")),
                str(error.get("message", "토스증권이 요청을 거절했습니다.")),
            )
        if "result" not in payload or (method == "POST" and not isinstance(payload["result"], dict)):
            raise TradingError(
                503,
                "order-outcome-unknown" if method == "POST" else "invalid-toss-response",
                "토스증권 응답에 처리 결과가 없습니다.",
            )
        return payload["result"]
