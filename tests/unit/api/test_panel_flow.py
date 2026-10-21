from __future__ import annotations

import datetime as dt
import json

import polars as pl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import heatmap, panel_flow, watchlist
from hoga.api.compute_pools import thread_pools
from hoga.api.heatmap_group_flow import _kst_ms
from hoga.api.models import (
    HeatmapDocument,
    HeatmapEntry,
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolder,
    WatchlistMemoItem,
    code_items,
)

BASIS = dt.date(2026, 10, 21)
F1, F2 = "f_00000001", "f_00000002"


def seed(root):
    folders = [WatchlistFolder(id=fid, name=fid, order=i, items=code_items(["005930", "000660"]))
               for i, fid in enumerate([F1, F2])]
    folders[0].items.append(WatchlistMemoItem(kind="memo", id="m_00000001", text="메모"))
    watchlist.save_document(root, WatchlistDocument(folders=folders, entries=[
        WatchlistEntry(code=code, name=code, registered_at_kst_date="20261021") for code in ["005930", "000660"]]))
    heatmap.save_document(root, HeatmapDocument(folders=folders, entries=[
        HeatmapEntry(code="005930", name="삼성전자", folder_id=F1, order=0)]))
    directory = root / "screener"
    directory.mkdir(exist_ok=True)
    pl.DataFrame({"code": ["005930", "000660"], "date": [BASIS - dt.timedelta(days=1)] * 2,
                  "close": [100.0, 200.0]}).write_parquet(directory / "daily_adjusted.parquet")
    write(root, "KRX", "005930", [(9, 1, 105), (9, 11, 110), (16, 1, 108)])
    write(root, "KRX", "000660", [(9, 1, 202)])


def write(root, venue, code, records):
    directory = root / "live_kiwoom" / BASIS.strftime("%Y%m%d") / venue
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{code}.jsonl").write_text("".join(json.dumps({
        "kind": "candle", "t_ms": _kst_ms(BASIS, dt.time(h, m)), "payload": {"close": price},
    }) + "\n" for h, m, price in records))


def test_unique_reads_membership_mean_and_missing_buckets(tmp_path, monkeypatch):
    seed(tmp_path)
    read = panel_flow._read_candle_closes
    paths = []

    def observe(path):
        paths.append(path)
        return read(path)

    monkeypatch.setattr(panel_flow, "_read_candle_closes", observe)
    result = panel_flow.build_panel_flow(tmp_path, BASIS, _kst_ms(BASIS, dt.time(10)), "watchlist", "KRX", None)
    assert len(paths) == len(set(paths)) == 2  # Four memberships, only two reads.
    assert len(result.stocks) == 2
    assert result.stocks[0].pct[:4] == [5.0, None, 10.0, None]
    assert result.groups[0].pct[:4] == [3.0, None, 10.0, None]
    assert result.groups[0].counts[:4] == [2, 0, 1, 0]
    assert result.groups[0].total == 2  # Memo is not a stock.
    assert result.groups[0].pct == result.groups[1].pct
    assert all(value is None for value in result.stocks[0].pct[12:])  # Future data is excluded.


def test_sources_venues_and_extended_sessions_are_isolated(tmp_path):
    seed(tmp_path)
    write(tmp_path, "UN", "005930", [(8, 1, 115)])
    result = panel_flow.build_panel_flow(
        tmp_path, BASIS, _kst_ms(BASIS, dt.time(17)), "heatmap", "UN", {"005930": False})
    stock = result.stocks[0]
    assert stock.venue == "KRX"  # Integrated non-NXT stock uses the same fallback as its quote.
    assert len(result.stocks) == 1
    assert stock.pct[0] is None  # KRX must not acquire an 08:00 quote.
    assert stock.pct[12] == 5.0
    assert stock.pct[96] == 8.0  # 16:00 included in the venue's full-day axis.
    other = panel_flow.build_panel_flow(tmp_path, BASIS, _kst_ms(BASIS, dt.time(17)), "heatmap", "UN", {"005930": True})
    assert other.stocks[0].pct[0] == 15.0


def test_http_contract_burst_cache_and_membership_change(tmp_path, monkeypatch):
    seed(tmp_path)
    monkeypatch.setattr(panel_flow.calendar, "is_trading_day", lambda day: True)
    pools = thread_pools()
    app = FastAPI()
    app.include_router(panel_flow.build_router(data_dir=tmp_path, compute=pools))
    original = panel_flow.compute_jobs.panel_flow_job
    calls = []

    def observe(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(panel_flow.compute_jobs, "panel_flow_job", observe)
    try:
        with TestClient(app) as client:
            first = client.get("/api/panel-flow?source=watchlist&venue=KRX")
            assert first.status_code == 200
            body = first.json()
            assert body == panel_flow.PanelFlowResponse.model_validate(body).model_dump(mode="json")
            assert set(body["stocks"][0]) == {"code", "venue", "pct", "last_observed_ms", "missing_reason"}
            assert client.get("/api/panel-flow?source=watchlist&venue=KRX").json() == body
            assert len(calls) == 1
            doc = watchlist.load_document(tmp_path)
            doc.folders[0].items = code_items(["005930"])
            watchlist.save_document(tmp_path, doc)
            changed = client.get("/api/panel-flow?source=watchlist&venue=KRX").json()
            assert changed["groups"][0]["total"] == 1
            assert len(calls) == 2
            assert client.get("/api/panel-flow?source=other").status_code == 422
            assert client.get("/api/panel-flow?source=heatmap&venue=BAD").status_code == 422
    finally:
        pools.shutdown()


def test_unsupported_market_and_missing_baseline_are_explicit(tmp_path):
    seed(tmp_path)
    doc = watchlist.load_document(tmp_path)
    doc.folders[0].items.extend(code_items(["us-stock:NASDAQ:AAPL", "035420"]))
    doc.entries.extend([WatchlistEntry(code=code, name=code, registered_at_kst_date="20261021")
                        for code in ["us-stock:NASDAQ:AAPL", "035420"]])
    watchlist.save_document(tmp_path, doc)
    result = panel_flow.build_panel_flow(tmp_path, BASIS, _kst_ms(BASIS, dt.time(10)), "watchlist", "KRX", None)
    by_code = {stock.code: stock for stock in result.stocks}
    assert by_code["us-stock:NASDAQ:AAPL"].missing_reason == "unsupported_market"
    assert by_code["035420"].missing_reason == "no_baseline"
    assert all(value is None for value in by_code["035420"].pct)
