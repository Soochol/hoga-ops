from __future__ import annotations

import pytest

import hoga.live.kis_access as kis_access
from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import save_live_settings


class FakeScheduler:
    def __init__(self) -> None:
        self.calls = 0

    async def submit(self, **kwargs):
        self.calls += 1
        return await kwargs["call"](object())


@pytest.mark.asyncio
async def test_run_with_capacity_blocks_before_scheduler_when_bypass_on(tmp_path):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    scheduler = FakeScheduler()
    called = False

    async def fetch_fn(_kis):
        nonlocal called
        called = True
        return "ok"

    with pytest.raises(kis_access.KisRestBypassedError) as err:
        await kis_access.run_with_capacity(
            scheduler,
            data_dir=tmp_path,
            role="background",
            key=("quotes",),
            endpoint=kis_access.KisRestEndpoint.QUOTES,
            priority="background",
            fetch_fn=fetch_fn,
        )

    assert err.value.msg_cd == "KIS_REST_BYPASSED"
    assert scheduler.calls == 0
    assert called is False


@pytest.mark.parametrize(
    "endpoint",
    [
        kis_access.KisRestEndpoint.PAST_MINUTE,
        kis_access.KisRestEndpoint.PAST_DAILY,
        kis_access.KisRestEndpoint.QUOTES,
        kis_access.KisRestEndpoint.LIVE_ORDERBOOK,
        kis_access.KisRestEndpoint.LIVE_TRADES,
        kis_access.KisRestEndpoint.LIVE_BROKERS,
        kis_access.KisRestEndpoint.INVESTOR_NET,
    ],
)
@pytest.mark.asyncio
async def test_run_with_capacity_blocks_representative_endpoints_when_bypass_on(
    tmp_path,
    endpoint,
):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    scheduler = FakeScheduler()

    async def fetch_fn(_kis):
        raise AssertionError("fetch_fn must not run during KIS REST bypass")

    with pytest.raises(kis_access.KisRestBypassedError):
        await kis_access.run_with_capacity(
            scheduler,
            data_dir=tmp_path,
            role="background",
            key=("bypass", endpoint.value),
            endpoint=endpoint,
            priority="background",
            fetch_fn=fetch_fn,
        )

    assert scheduler.calls == 0


@pytest.mark.asyncio
async def test_run_with_capacity_blocks_legacy_fallback_when_bypass_on(tmp_path, monkeypatch):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    kis_for_role_called = False

    def fake_kis_for_role(role, data_dir):
        nonlocal kis_for_role_called
        kis_for_role_called = True
        return object()

    monkeypatch.setattr(kis_access, "kis_for_role", fake_kis_for_role)

    with pytest.raises(kis_access.KisRestBypassedError):
        await kis_access.run_with_capacity(
            None,
            data_dir=tmp_path,
            role="background",
            key=("legacy",),
            endpoint=kis_access.KisRestEndpoint.QUOTES,
            priority="background",
            fetch_fn=lambda _kis: "not awaited",
        )

    assert kis_for_role_called is False


@pytest.mark.asyncio
async def test_run_with_capacity_allows_scheduler_when_bypass_off(tmp_path):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=False))
    scheduler = FakeScheduler()

    async def fetch_fn(_kis):
        return "ok"

    result = await kis_access.run_with_capacity(
        scheduler,
        data_dir=tmp_path,
        role="background",
        key=("quotes",),
        endpoint=kis_access.KisRestEndpoint.QUOTES,
        priority="background",
        fetch_fn=fetch_fn,
    )

    assert result == "ok"
    assert scheduler.calls == 1
