import datetime as dt

import pytest

from hoga.api.market_routes import InvestorFlowResponse, _flow_collection, _investor_flow_payload
from hoga.live import deriv_flow_runtime, investor_flow_runtime
from hoga.live.flow_receipts import FlowReceipts
from hoga.live.investor_flow_store import IntradaySample, InvestorFlowStore
from hoga.util.timeenc import KST


@pytest.mark.parametrize(("deriv", "hour", "minute", "expected"), [
    (False, 7, 59, False), (False, 8, 0, True), (True, 8, 59, False),
    (True, 9, 0, True), (False, 15, 31, True), (True, 15, 31, True),
    (True, 15, 45, False), (False, 16, 29, True), (False, 16, 30, False),
])
def test_collection_uses_its_own_window(tmp_path, monkeypatch, deriv, hour, minute, expected):
    now = dt.datetime(2026, 9, 10, hour, minute, tzinfo=KST)
    monkeypatch.setattr("hoga.collector.orchestrator.now_kst", lambda: now)
    monkeypatch.setattr(investor_flow_runtime, "is_available", lambda _: True)
    monkeypatch.setattr(deriv_flow_runtime, "is_available", lambda _: True)
    result = _flow_collection(tmp_path, "20260910", deriv=deriv)
    assert result["collection_expected"] is expected
    assert result["poll_interval_ms"] == 10_000


@pytest.mark.parametrize("day", [12, 13])
def test_weekend_is_closed(tmp_path, monkeypatch, day):
    monkeypatch.setattr("hoga.collector.orchestrator.now_kst", lambda: dt.datetime(2026, 9, day, 10, tzinfo=KST))
    assert _flow_collection(tmp_path, f"202609{day}", deriv=False)["collection_expected"] is False


def test_receipt_changes_without_price_file_change_reach_response(tmp_path, monkeypatch):
    now = dt.datetime(2026, 9, 10, 10, tzinfo=KST)
    monkeypatch.setattr("hoga.collector.orchestrator.now_kst", lambda: now)
    monkeypatch.setattr(investor_flow_runtime, "is_available", lambda _: True)
    stamp = int(now.timestamp() * 1000)
    store = InvestorFlowStore(tmp_path)
    store.append_sample("20260910", IntradaySample(
        sampled_at_ms=stamp, poll_interval_ms=10_000, request={"mrkt_tp": "0"},
        rows=[{"inds_cd": "001_AL", "ind_netprps": "100", "frgnr_netprps": "-90", "orgn_netprps": "-10"}],
    ))
    receipts = FlowReceipts(tmp_path / "investor-flow", 10)
    receipts.begin("20260910", stamp, ["KOSPI", "KOSDAQ"])
    receipts.success("KOSPI", stamp, written=True)
    receipts.save(stamp)
    initial = InvestorFlowResponse.model_validate(_investor_flow_payload(tmp_path))
    now += dt.timedelta(seconds=50)
    assert _investor_flow_payload(tmp_path)["collection"]["targets"]["KOSPI"]["status"] == "delayed"
    receipts.success("KOSPI", stamp + 50_000, written=False)
    receipts.save(stamp + 50_000)
    latest = InvestorFlowResponse.model_validate(_investor_flow_payload(tmp_path))
    assert initial.markets == latest.markets
    assert latest.collection.targets["KOSPI"].status == "receiving"
    assert latest.collection.targets["KOSPI"].last_success_at_ms == stamp + 50_000
    assert latest.collection.targets["KOSPI"].last_written_at_ms == stamp
