from __future__ import annotations

import httpx
import pytest

from hoga.collector.client import (
    CookieExpiredError,
    HogaplayClient,
    HogaplayHTTPError,
)

RETRY_THRESHOLD: int = 3


def make_client(handler: httpx.MockTransport) -> HogaplayClient:
    return HogaplayClient(cookie="k_=test; n_=user", transport=handler)


def test_fetch_info_builds_correct_url() -> None:
    captured: dict[str, httpx.Request] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(200, content=b"info-body")

    c = make_client(httpx.MockTransport(handler))
    body = c.fetch_info("003490", "20260519")
    assert body == "info-body"
    req = captured["req"]
    assert req.url.path == "/player/info.php"
    assert dict(req.url.params) == {"date": "20260519", "code": "003490"}
    assert req.headers["cookie"] == "k_=test; n_=user"
    assert req.headers["x-requested-with"] == "XMLHttpRequest"
    assert req.headers["referer"] == "https://hogaplay.com/player/"


def test_fetch_first_includes_time() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"first-body")

    c = make_client(httpx.MockTransport(handler))
    body = c.fetch_first("003490", "20260519", time_ms=90000000)
    assert body == "first-body"


def test_fetch_chart_includes_bong_gap() -> None:
    captured: dict[str, httpx.Request] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(200, content=b"chart-body")

    c = make_client(httpx.MockTransport(handler))
    body = c.fetch_chart("003490", "20260519", time_ms=153100000, bong=1, gap=60000)
    assert body == "chart-body"
    assert dict(captured["req"].url.params) == {
        "date": "20260519",
        "code": "003490",
        "time": "153100000",
        "bong": "1",
        "gap": "60000",
    }


def test_401_raises_cookie_expired() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, content=b"unauthorized")

    c = make_client(httpx.MockTransport(handler))
    with pytest.raises(CookieExpiredError):
        c.fetch_info("003490", "20260519")


def test_403_raises_cookie_expired() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, content=b"forbidden")

    c = make_client(httpx.MockTransport(handler))
    with pytest.raises(CookieExpiredError):
        c.fetch_info("003490", "20260519")


def test_500_retries_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < RETRY_THRESHOLD:
            return httpx.Response(500, content=b"server error")
        return httpx.Response(200, content=b"ok")

    c = make_client(httpx.MockTransport(handler))
    body = c.fetch_info("003490", "20260519")
    assert body == "ok"
    assert calls["n"] == RETRY_THRESHOLD


def test_500_persistent_raises_http_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"server error")

    c = make_client(httpx.MockTransport(handler))
    with pytest.raises(HogaplayHTTPError):
        c.fetch_info("003490", "20260519")


def test_400_other_4xx_raises_http_error_no_retry() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, content=b"bad request")

    c = make_client(httpx.MockTransport(handler))
    with pytest.raises(HogaplayHTTPError):
        c.fetch_info("003490", "20260519")
    assert calls["n"] == 1
