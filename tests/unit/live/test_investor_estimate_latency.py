"""Visible estimate requests: axis pacing, deadlines and late-result recovery."""
import asyncio

import httpx
import pytest
from fastapi import FastAPI

from hoga.live import api, kiwoom_rest_runtime, lifecycle
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded, KiwoomCapacityScheduler
from hoga.live.kiwoom_rest import Page


class Client:
    def __init__(self):
        self.axes = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()

    async def call(self, api_id, body):
        assert api_id == "ka10064"
        self.axes.append(body["amt_qty_tp"])
        self.started.set()
        await self.release.wait()
        return Page(rows=[{"tm": "090000", "frgnr_invsr": "100", "orgn": "200"}],
                    cont=False, next_key="")


def app_for(tmp_path, monkeypatch, client, scheduler):
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_: client)
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_: scheduler)
    app = FastAPI()
    app.include_router(api.build_router(data_dir=tmp_path, get_status=lifecycle.get_status))
    return app


@pytest.mark.asyncio
async def test_visible_estimate_overtakes_queued_capture_and_paces_both_axes(tmp_path, monkeypatch):
    vendor = Client()
    scheduler = KiwoomCapacityScheduler(workers=1, rate_per_sec=10_000)
    gate, started, visible = asyncio.Event(), asyncio.Event(), asyncio.Event()
    order, submitted = [], []
    real_submit, real_call = scheduler.submit, vendor.call

    async def submit(**kwargs):
        if isinstance(kwargs["key"], tuple) and kwargs["key"][0] == "investor-trend-estimate":
            submitted.append((kwargs["key"], kwargs["priority"]))
            visible.set()
        return await real_submit(**kwargs)

    async def call(api_id, body):
        order.append(body["amt_qty_tp"])
        return await real_call(api_id, body)

    async def block(_):
        started.set()
        await gate.wait()

    async def capture(_):
        order.append("capture")

    monkeypatch.setattr(scheduler, "submit", submit)
    monkeypatch.setattr(vendor, "call", call)
    app = app_for(tmp_path, monkeypatch, vendor, scheduler)
    try:
        blocker = asyncio.create_task(real_submit(key="block", api_id="ka10064", priority="background", call=block))
        await started.wait()
        background = asyncio.create_task(real_submit(
            key="capture", api_id="ka10064", priority="background", call=capture))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            response = asyncio.create_task(client.get("/api/live/investor-trend-estimate?code=005930"))
            await visible.wait()
            gate.set()
            _, _, result = await asyncio.gather(blocker, background, response)
        assert order[0] == "2"
        assert vendor.axes == ["2", "1"]
        assert submitted == [(("investor-trend-estimate", "005930", axis), "user_visible") for axis in ("2", "1")]
        assert result.json()["status"] == "ok"
        assert result.json()["latest"]["foreign_qty"] == 100
        assert result.json()["latest"]["foreign_amt_mwon"] == 100
    finally:
        gate.set()
        await scheduler.aclose()


@pytest.mark.asyncio
async def test_deadline_keeps_shared_work_and_followup_reads_late_success(tmp_path, monkeypatch):
    vendor = Client()
    vendor.release.clear()
    scheduler = KiwoomCapacityScheduler(workers=1, rate_per_sec=10_000)
    app = app_for(tmp_path, monkeypatch, vendor, scheduler)
    # An accelerated deadline exercises the real HTTP timeout/cancellation path.
    monkeypatch.setattr(api, "_INVESTOR_ESTIMATE_RESPONSE_WAIT_SECONDS", 0.02)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            first = await client.get("/api/live/investor-trend-estimate?code=005930")
            assert vendor.started.is_set()
            assert first.status_code == 200
            assert first.json()["data_warning"]["reason"] == "request_pending"
            assert first.json()["rows"] == []
            vendor.release.set()
            second = await client.get("/api/live/investor-trend-estimate?code=005930")
            third = await client.get("/api/live/investor-trend-estimate?code=005930")
        assert second.json()["status"] == "ok"
        assert second.json()["data_warning"] is None
        assert third.json() == second.json()
        assert vendor.axes == ["2", "1"]  # no duplicate upstream work after timeout
    finally:
        vendor.release.set()
        await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_failure_is_not_pending_and_keeps_cause(tmp_path, monkeypatch):
    class Full:
        async def submit(self, **_):
            raise KiwoomCapacityOverloaded("queue full")

    app = app_for(tmp_path, monkeypatch, Client(), Full())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.get("/api/live/investor-trend-estimate?code=005930")
    assert response.json()["data_warning"] == {"reason": "rate_limit_upstream", "msg": "queue full"}


@pytest.mark.asyncio
async def test_upstream_timeout_is_not_mislabelled_as_shared_work_still_pending(tmp_path, monkeypatch):
    class Broken:
        async def submit(self, **_):
            raise TimeoutError("upstream task stopped")

    app = app_for(tmp_path, monkeypatch, Client(), Broken())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        with pytest.raises(TimeoutError, match="upstream task stopped"):
            await client.get("/api/live/investor-trend-estimate?code=005930")
