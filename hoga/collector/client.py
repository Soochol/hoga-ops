"""HTTP client for hogaplay.com player endpoints."""

from __future__ import annotations

import time
from typing import Final

import httpx

BASE_URL: Final = "https://hogaplay.com/player"

DEFAULT_HEADERS: Final = {
    "Accept": "*/*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": f"{BASE_URL}/",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    ),
}

HTTP_STATUS_BAD_REQUEST: Final = 400
HTTP_STATUS_UNAUTHORIZED: Final = 401
HTTP_STATUS_FORBIDDEN: Final = 403
HTTP_STATUS_SERVER_ERROR: Final = 500


class HogaplayHTTPError(RuntimeError):
    """HTTP error from hogaplay. `status_code` is None for low-level errors
    (timeout, connection reset) that never received a response."""
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class CookieExpiredError(HogaplayHTTPError):
    """401/403 from hogaplay — session cookie expired."""


class HogaplayClient:
    """Thin httpx wrapper. Sync, single connection, manual retries on 5xx."""

    def __init__(
        self,
        cookie: str,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
    ) -> None:
        headers = {**DEFAULT_HEADERS, "Cookie": cookie}
        self._client = httpx.Client(headers=headers, transport=transport, timeout=timeout)
        self._max_retries = max_retries
        self._backoff_base = backoff_base

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HogaplayClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def fetch_info(self, code: str, date: str) -> str:
        return self._get("info.php", {"date": date, "code": code})

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        return self._get("first.php", {"date": date, "code": code, "time": str(time_ms)})

    def fetch_chart(
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000
    ) -> str:
        return self._get(
            "chart.php",
            {
                "date": date,
                "code": code,
                "time": str(time_ms),
                "bong": str(bong),
                "gap": str(gap),
            },
        )

    def _get(self, endpoint: str, params: dict[str, str]) -> str:
        url = f"{BASE_URL}/{endpoint}"
        last_error: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                r = self._client.get(url, params=params)
            except httpx.HTTPError as e:
                last_error = e
                time.sleep(self._backoff_base * (2**attempt))
                continue
            if r.status_code in (HTTP_STATUS_UNAUTHORIZED, HTTP_STATUS_FORBIDDEN):
                raise CookieExpiredError(
                    f"hogaplay returned {r.status_code} for {endpoint}. "
                    "Refresh your .cookie from a logged-in browser session.",
                    status_code=r.status_code,
                )
            if r.status_code >= HTTP_STATUS_SERVER_ERROR:
                last_error = HogaplayHTTPError(
                    f"{r.status_code} from {endpoint}: {r.text[:200]}",
                    status_code=r.status_code,
                )
                time.sleep(self._backoff_base * (2**attempt))
                continue
            if r.status_code >= HTTP_STATUS_BAD_REQUEST:
                raise HogaplayHTTPError(
                    f"{r.status_code} from {endpoint}: {r.text[:500]}",
                    status_code=r.status_code,
                )
            return r.text
        assert last_error is not None
        raise HogaplayHTTPError(f"exhausted retries for {endpoint}: {last_error}")
