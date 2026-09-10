from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from hoga.api.market_routes import build_router
from hoga.live import kiwoom_access, kiwoom_rest_runtime


@pytest.mark.asyncio
async def test_program_walks_with_per_page_capacity_and_preserves_truncation(tmp_path, monkeypatch):
    keys = []
    walks = []

    class Client:
        async def call(self, api_id, body):
            return SimpleNamespace(rows=[{"cntr_tm": "20260909000000", "all_netprps": "100"}])

        async def walk(self, api_id, body, *, max_pages, stop, run_page):
            walks.append((api_id, body["mrkt_tp"], max_pages))
            for i in range(2):
                await run_page(lambda client: client.call(api_id, body), i)
            return [
                {"cntr_tm": "160000", "all_netprps": "200"},
                {"cntr_tm": "160000", "all_netprps": "100"},
                {"cntr_tm": "090000", "all_netprps": "50"},
            ], body["mrkt_tp"] == "P10102"

    async def capacity(scheduler, *, key, api_id, priority, fetch_fn, client):
        keys.append(key)
        assert priority == "background"
        return await fetch_fn(client)

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: Client())
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_a, **_k: object())
    monkeypatch.setattr(kiwoom_access, "run_with_capacity", capacity)
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/market/program")
        assert response.status_code == 200
        data = response.json()
        assert data["truncated"] == {"KOSPI": False, "KOSDAQ": True}
        assert [p["t"] for p in data["markets"]["KOSPI"]] == ["160000", "090000"]
        assert data["markets"]["KOSPI"][0]["total_net_eok"] == 2
        assert walks == [("ka90005", "P00101", 12), ("ka90005", "P10102", 12)]
        assert len(keys) == 4
        await client.get("/api/market/program")
        assert len(keys) == 4  # TTL prevents repeated cursor walks.
        daily = await client.get("/api/market/program?axis=daily")
        assert daily.json()["truncated"] == {}
        assert len(walks) == 2  # Daily remains one page per market.
