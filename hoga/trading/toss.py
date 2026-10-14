"""Official contract: https://developers.tossinvest.com/llms.txt (2026-10-13).

Credentials never leave the backend. Writes are never implicitly retried.
Unknown write outcomes are distinct from rejected writes.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import time
from collections import defaultdict
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

HTTP_UNAUTHORIZED = 401
HTTP_SERVER_ERROR = 500
HTTP_TOO_MANY_REQUESTS = 429
INFO_PEAK_HOUR = 9
INFO_PEAK_END_MINUTE = 10


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
        self._rate_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._next: dict[str, float] = {}
        self._last: dict[str, float] = {}
        self._limits: dict[str, int] = {}

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

    @staticmethod
    def _rate_group(path: str, method: str) -> str:
        if path == "/api/v1/accounts":
            return "account"
        if path in ("/api/v1/buying-power", "/api/v1/sellable-quantity"):
            return "info"
        if path == "/api/v1/stocks":
            return "stock"
        if path == "/api/v1/holdings":
            return "asset"
        return "order" if method == "POST" else "history"

    @staticmethod
    def _info_peak() -> bool:
        now = datetime.now(ZoneInfo("Asia/Seoul"))
        return now.hour == INFO_PEAK_HOUR and now.minute < INFO_PEAK_END_MINUTE

    def _interval(self, group: str) -> float:
        # Official group quotas, with 5% headroom. Lower response limits always win.
        limit = {"order": 10, "history": 5, "info": 3 if self._info_peak() else 6,
                 "account": 1, "stock": 5, "asset": 5}[group]
        return 1.05 / min(limit, self._limits.get(group, limit))

    async def _pace(self, path: str, method: str) -> None:
        group = self._rate_group(path, method)
        async with self._rate_locks[group]:
            # Recheck after waking: a response may lower the quota while we wait.
            while True:
                now = time.monotonic()
                deadline = max(self._next.get(group, 0), self._last.get(group, -math.inf) + self._interval(group))
                if deadline <= now:
                    break
                await asyncio.sleep(deadline - now)
            self._last[group] = now
            self._next[group] = now + self._interval(group)

    @staticmethod
    def _seconds(value: str | None) -> float | None:
        if value is None:
            return None
        try:
            seconds = float(value)
            return seconds if math.isfinite(seconds) and seconds >= 0 else None
        except (TypeError, ValueError):
            return None

    def _observe_rate(self, path: str, method: str, response: httpx.Response) -> None:
        group = self._rate_group(path, method)
        try:
            limit = int(response.headers.get("X-RateLimit-Limit", ""))
            if limit > 0:
                self._limits[group] = limit
        except ValueError:
            pass
        delay = None
        if response.headers.get("X-RateLimit-Remaining") == "0":
            delay = self._seconds(response.headers.get("X-RateLimit-Reset"))
        if response.status_code == HTTP_TOO_MANY_REQUESTS:
            retry = response.headers.get("Retry-After")
            after = self._seconds(retry)
            if after is None and retry:
                with contextlib.suppress(TypeError, ValueError, OverflowError):
                    after = max(0, parsedate_to_datetime(retry).timestamp() - time.time())
            delay = max(delay or 0, after or self._interval(group))
        now = time.monotonic()
        self._next[group] = max(self._next.get(group, 0), self._last.get(group, now) + self._interval(group),
                                now + (delay or 0))

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
        self._observe_rate(path, method, response)
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
