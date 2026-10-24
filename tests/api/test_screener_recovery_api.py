"""Exercise accepted jobs, status serialization, cancellation and owner coalescing over HTTP."""

import asyncio

import httpx
from fastapi import FastAPI

from hoga.api import screener_recovery as recovery, screener_recovery_api as api
from tests.api.test_screener_recovery import CODES, NOW, corpus as recovery_corpus, observation, spec

corpus = recovery_corpus


async def test_http_run_coalesces_and_serializes_cancellation(corpus, monkeypatch):
    identity = recovery.create_plan(corpus, spec())
    entered, release = asyncio.Event(), asyncio.Event()
    async def fetch(target, anchor, check):
        entered.set()
        await release.wait()
        check()
        return observation(target, anchor)
    original_run = recovery.run
    async def run(*args, **kwargs):
        return await original_run(*args, **kwargs, now=lambda:NOW)
    monkeypatch.setattr(recovery,"run",run)
    app = FastAPI()
    app.include_router(api.build_router(corpus,fetch=fetch),prefix="/api/screener")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
        path = f"/api/screener/recovery/{identity}"
        response = await client.post(path+"/run",json={"resume":False})
        assert response.status_code == 202 and response.json() == {"plan_id":identity,"started":True}
        await asyncio.wait_for(entered.wait(),timeout=2)
        assert (await client.post(path+"/run",json={})).json()["started"] is False
        current = await client.get(path)
        assert current.status_code == 200 and current.json()["current_code"] == CODES[0]
        assert set(current.json()["items"][CODES[0]]) == set(recovery.RecoveryItem.model_fields)
        cancelled = await client.post(path+"/cancel")
        assert cancelled.json() == {"cancel_requested":True}
        release.set()
        await asyncio.wait_for(api._tasks[str(corpus)][1],timeout=2)
        final = await client.get(path)
        assert final.json()["status"] == "interrupted" and final.json()["error"] == "cancel_requested"
        assert (await client.post(path+"/run",json={})).status_code == 409
        assert (await client.post(path+"/run",json={"resume":True})).status_code == 202
        await asyncio.wait_for(api._tasks[str(corpus)][1],timeout=2)
        assert (await client.get(path)).json()["status"] == "complete"
    await api.shutdown(corpus)


async def test_http_refuses_changed_input_bad_plan_and_conflicting_job(corpus, monkeypatch):
    identity = recovery.create_plan(corpus,spec())
    app = FastAPI()
    app.include_router(api.build_router(corpus),prefix="/api/screener")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
        assert (await client.post("/api/screener/recovery/INVALID/run",json={})).status_code == 404
        path = f"/api/screener/recovery/{identity}/run"
        monkeypatch.setattr(api,"_other_running",lambda _:True)
        assert (await client.post(path,json={})).status_code == 409
        monkeypatch.setattr(api,"_other_running",lambda _:False)
        (corpus/"screener/saves.json").write_text("changed")
        assert (await client.post(path,json={})).status_code == 409
        assert not api.active(corpus)


async def test_shutdown_drains_inflight_job_and_leaves_resumable_stage(corpus,monkeypatch):
    identity = recovery.create_plan(corpus,spec())
    entered = asyncio.Event()
    async def fetch(*_):
        entered.set()
        await asyncio.Event().wait()
    original_run = recovery.run
    async def run(*args,**kwargs):
        return await original_run(*args,**kwargs,now=lambda:NOW)
    monkeypatch.setattr(recovery,"run",run)
    app=FastAPI()
    app.include_router(api.build_router(corpus,fetch=fetch),prefix="/api/screener")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
        await client.post(f"/api/screener/recovery/{identity}/run",json={})
        await asyncio.wait_for(entered.wait(),timeout=2)
        await api.shutdown(corpus)
        assert recovery.load_job(corpus,identity).status == "interrupted"
        assert not api.active(corpus)


async def test_http_preserves_confirmed_and_corrected_job_fields(corpus):
    from tests.api.test_screener_corrections import CODE, prepare, proof_payload
    from tests.api.test_screener_recovery import DAYS

    identity, _job, _request = await prepare(corpus)
    recovery.review_corrections(corpus,identity,proof_payload())
    app=FastAPI()
    app.include_router(api.build_router(corpus),prefix="/api/screener")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
        response=await client.get(f"/api/screener/recovery/{identity}")
        assert response.status_code == 200
        body=response.json()
        item=body["items"][CODE]
        assert item["confirmation_state"] == "confirmed"
        assert item["resolved_conflict_dates"] == [day.isoformat() for day in DAYS[1:]]
        assert item["conflict_dates"] == [] and item["correction_id"] is not None
        restored=recovery.RecoveryJob.model_validate(body).model_dump(mode="json")
        assert restored == body
