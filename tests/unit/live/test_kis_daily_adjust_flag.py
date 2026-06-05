"""Task 6 — parameterize daily-candle adjust flag (ADR-0048).

Verifies that fetch_past_daily_candles passes FID_ORG_ADJ_PRC="0"
by default (수정주가, preserves /live behaviour) and "1" when
adjust=False (원주가, for the screener).
"""
from __future__ import annotations

import httpx
import pytest

from hoga.live.kis_client import KisClient, KisCredentials
from tests.unit.live._fakes import FakeTokenProvider


class _Capture(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.last_params: dict[str, str] | None = None

    async def handle_async_request(self, req: httpx.Request) -> httpx.Response:
        self.last_params = dict(req.url.params)
        return httpx.Response(200, json={"rt_cd": "0", "output1": {}, "output2": []})


@pytest.mark.asyncio
async def test_adjust_flag_default_is_0_and_overridable() -> None:
    t = _Capture()
    c = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=t,
    )

    # Default: adjust=True → FID_ORG_ADJ_PRC should be "0" (수정주가, /live default)
    await c.fetch_past_daily_candles("005930", "20260101", "20260131")
    assert t.last_params is not None
    assert t.last_params["FID_ORG_ADJ_PRC"] == "0", (
        f"Expected '0' (수정주가) by default, got {t.last_params['FID_ORG_ADJ_PRC']!r}"
    )

    # Explicit adjust=False → FID_ORG_ADJ_PRC should be "1" (원주가, screener)
    await c.fetch_past_daily_candles("005930", "20260101", "20260131", adjust=False)
    assert t.last_params is not None
    assert t.last_params["FID_ORG_ADJ_PRC"] == "1", (
        f"Expected '1' (원주가) when adjust=False, got {t.last_params['FID_ORG_ADJ_PRC']!r}"
    )

    await c.aclose()
