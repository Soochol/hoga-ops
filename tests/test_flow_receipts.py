"""Receipt health must not confuse unchanged prices with a failed request."""

import pytest

from hoga.live.flow_receipts import FlowReceipts, collection_health, read_receipts
from hoga.live.investor_flow_collector import InvestorFlowCollector

DATE = "20260910"


def health(root, now=10_000, expected=True, available=True):
    return collection_health(root, DATE, now_ms=now, expected=expected,
                             available=available, keys=["KOSPI", "KOSDAQ"], open_ms=0)


def test_restart_and_rollover_do_not_inherit_receiving(tmp_path):
    receipts = FlowReceipts(tmp_path, 10)
    receipts.begin(DATE, 0, ["KOSPI", "KOSDAQ"])
    receipts.success("KOSPI", 1000, written=True)
    receipts.save(1000)
    restarted = FlowReceipts(tmp_path, 10)
    restarted.begin(DATE, 10_000, ["KOSPI", "KOSDAQ"])
    assert health(tmp_path).targets["KOSPI"].status == "waiting"
    assert health(tmp_path).targets["KOSPI"].last_written_at_ms == 1000
    assert restarted.state.run_id != receipts.state.run_id
    restarted.begin("20260911", 20_000, ["KOSPI", "KOSDAQ"])
    assert restarted.state.targets["KOSPI"].last_written_at_ms is None


def test_unchanged_receipts_stay_fresh_and_failure_is_per_target(tmp_path):
    receipts = FlowReceipts(tmp_path, 10)
    receipts.begin(DATE, 0, ["KOSPI", "KOSDAQ"])
    receipts.success("KOSPI", 0, written=True)
    receipts.success("KOSDAQ", 0, written=True)
    for now in range(10_000, 610_000, 10_000):
        receipts.attempt("KOSPI", now)
        receipts.success("KOSPI", now, written=False)
    receipts.failure("KOSDAQ", 10_000, "transport")
    receipts.save(600_000)
    result = health(tmp_path, now=600_000)
    assert result.targets["KOSPI"].status == "receiving"
    assert result.targets["KOSPI"].last_written_at_ms == 0
    assert result.targets["KOSDAQ"].status == "delayed"
    receipts.success("KOSDAQ", 610_000, written=False)
    receipts.save(610_000)
    recovered = health(tmp_path, now=610_000).targets["KOSDAQ"]
    assert recovered.status == "receiving"
    assert recovered.error_kind is None
    assert recovered.gaps[0].model_dump() == {"start_ms": 10_000, "end_ms": 610_000}


def test_stale_boundary_and_closed_are_independent_of_old_error(tmp_path):
    receipts = FlowReceipts(tmp_path, 10)
    receipts.begin(DATE, 0, ["KOSPI", "KOSDAQ"])
    receipts.success("KOSPI", 0, written=True)
    receipts.failure("KOSDAQ", 0, "auth")
    receipts.save(0)
    assert health(tmp_path, now=30_000).targets["KOSPI"].status == "receiving"
    assert health(tmp_path, now=30_001).targets["KOSPI"].status == "delayed"
    assert health(tmp_path, now=30_001).targets["KOSDAQ"].status == "delayed"
    assert health(tmp_path, expected=False).targets["KOSDAQ"].status == "closed"
    # A reader without credentials still sees the external writer's receipts.
    assert health(tmp_path, available=False).targets["KOSPI"].status == "receiving"


def test_missing_corrupt_and_wrong_date_state_are_unknown(tmp_path):
    assert health(tmp_path).targets["KOSPI"].status == "unknown"
    assert health(tmp_path, available=False).targets["KOSPI"].status == "unavailable"
    path = tmp_path / "receipts" / f"{DATE}.json"
    path.parent.mkdir()
    path.write_text("{")
    assert read_receipts(tmp_path, DATE) is None
    receipts = FlowReceipts(tmp_path, 30)
    receipts.begin(DATE, 0, ["KOSPI", "KOSDAQ"])
    assert health(tmp_path).poll_interval_ms == 30_000  # rollback follows writer
    text = path.read_text().replace(DATE, "20260909")
    path.write_text(text)
    assert read_receipts(tmp_path, DATE) is None


def stock_row(market):
    return [{"inds_cd": "001_AL" if market == "0" else "101_AL",
             "ind_netprps": "-100", "frgnr_netprps": "80", "orgn_netprps": "20"}]


@pytest.mark.asyncio
async def test_collector_records_actual_receipt_and_dedup_success(tmp_path):
    now = [0]

    async def gate(_):
        return True

    async def fetch(market, _):
        now[0] += 100
        return stock_row(market)

    collector = InvestorFlowCollector(data_dir=tmp_path, date_fn=lambda: DATE,
                                     now_ms_fn=lambda: now[0], fetch_market_fn=fetch, should_collect_fn=gate)
    await collector.run_once()
    now[0] = 10_000
    await collector.run_once()
    state = read_receipts(tmp_path / "investor-flow", DATE)
    assert state.targets["KOSPI"].last_success_at_ms == 10_100
    assert state.targets["KOSDAQ"].last_success_at_ms == 10_200
    assert state.targets["KOSDAQ"].last_written_at_ms == 200
    samples = collector.store.load_samples(DATE)
    assert len(samples) == 2
    assert samples[1].sampled_at_ms == 200
    assert samples[1].poll_interval_ms == 10_000


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [None, [], [{"inds_cd": "001_AL"}], stock_row("1")])
async def test_invalid_market_does_not_count_as_success(tmp_path, bad):
    async def gate(_):
        return True

    async def fetch(market, _):
        return bad if market == "0" else stock_row("1")

    collector = InvestorFlowCollector(data_dir=tmp_path, date_fn=lambda: DATE,
                                     now_ms_fn=lambda: 100, fetch_market_fn=fetch, should_collect_fn=gate)
    await collector.run_once()
    state = read_receipts(tmp_path / "investor-flow", DATE)
    assert state.targets["KOSPI"].last_success_at_ms is None
    assert state.targets["KOSPI"].error_kind == "data_quality"
    assert state.targets["KOSDAQ"].last_success_at_ms == 100


@pytest.mark.asyncio
async def test_storage_failure_does_not_publish_success_or_block_next_market(tmp_path, monkeypatch):
    async def gate(_):
        return True

    async def fetch(market, _):
        return stock_row(market)

    collector = InvestorFlowCollector(data_dir=tmp_path, date_fn=lambda: DATE,
                                     now_ms_fn=lambda: 100, fetch_market_fn=fetch, should_collect_fn=gate)
    append = collector.store.append_sample

    def write(date, sample):
        if sample.request["mrkt_tp"] == "0":
            raise OSError("disk full")
        append(date, sample)

    monkeypatch.setattr(collector.store, "append_sample", write)
    await collector.run_once()
    state = read_receipts(tmp_path / "investor-flow", DATE)
    assert state.targets["KOSPI"].error_kind == "storage"
    assert state.targets["KOSPI"].last_written_at_ms is None
    assert state.targets["KOSDAQ"].last_success_at_ms == 100


@pytest.mark.asyncio
async def test_receipt_disk_failure_does_not_stop_raw_collection(tmp_path, monkeypatch):
    async def gate(_):
        return True

    async def fetch(market, _):
        return stock_row(market)

    collector = InvestorFlowCollector(data_dir=tmp_path, date_fn=lambda: DATE,
                                     now_ms_fn=lambda: 100, fetch_market_fn=fetch, should_collect_fn=gate)

    def fail_save(_):
        raise OSError("receipt directory read-only")

    monkeypatch.setattr(collector.receipts, "save", fail_save)
    await collector.run_once()
    assert len(collector.store.load_samples(DATE)) == 2
    assert collector.status.last_error_kind == "internal"
