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
            key=("bypass", endpoint.value),
            endpoint=endpoint,
            priority="background",
            fetch_fn=fetch_fn,
        )

    assert scheduler.calls == 0


@pytest.mark.asyncio
async def test_run_with_capacity_blocks_user_visible_before_submit_when_bypass_on(tmp_path):
    # Bypass is enforced before any submit regardless of priority (ADR-0083).
    # The legacy scheduler=None fallback was removed (ADR-0082 amendment): the
    # scheduler path is now the only path, so this is the sole bypass ingress.
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    scheduler = FakeScheduler()

    async def fetch_fn(_kis):
        raise AssertionError("fetch_fn must not run during KIS REST bypass")

    with pytest.raises(kis_access.KisRestBypassedError):
        await kis_access.run_with_capacity(
            scheduler,
            data_dir=tmp_path,
            key=("user-visible",),
            endpoint=kis_access.KisRestEndpoint.PAST_MINUTE,
            priority="user_visible",
            fetch_fn=fetch_fn,
        )

    assert scheduler.calls == 0


@pytest.mark.asyncio
async def test_run_with_capacity_allows_scheduler_when_bypass_off(tmp_path):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=False))
    scheduler = FakeScheduler()

    async def fetch_fn(_kis):
        return "ok"

    result = await kis_access.run_with_capacity(
        scheduler,
        data_dir=tmp_path,
        key=("quotes",),
        endpoint=kis_access.KisRestEndpoint.QUOTES,
        priority="background",
        fetch_fn=fetch_fn,
    )

    assert result == "ok"
    assert scheduler.calls == 1
