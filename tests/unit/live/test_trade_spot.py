import json
from datetime import datetime

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import compute_jobs
from hoga.api.models import TradeSpotResponse
from hoga.compute_executor import ComputeExecutor
from hoga.live import trade_spot_api
from hoga.live.second_trade_agg import SecondTradeBar
from hoga.live.second_trade_store import second_trade_store
from hoga.live.trade_spot_api import build_router
from hoga.util.timeenc import KST, hhmmssms_to_unix_ms

DATE, CODE = "20260929", "042700"
T = hhmmssms_to_unix_ms(DATE, 90000000)


def save(root, rows, source="hogaplay"):
    path = root / "parquet" / DATE / CODE / source
    path.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), path / "trades.parquet")
    (path / "meta.json").write_text(json.dumps({"prev_close": 95}))
    return path


def row(t=90000100, seq=1, price=100, qty=2, side=1):
    return dict(ts_ms=t, seq=seq, price=price, qty=qty, side=side)


def seconds(root, t=T, venue="KRX", quantities=(2, 8)):
    bar = SecondTradeBar(t)
    for seq, qty in enumerate(quantities, 1):
        bar.ingest(t_ms=t, seq=seq, price=200, qty=qty, side=1)
    store = second_trade_store(root)
    store._append(store.path(CODE, venue, DATE), [{"kind": "bar", "bar": bar.record()}])
    return bar.record()


@pytest.fixture
def api(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    with TestClient(app) as client:
        yield client


def get(api, **params):
    return api.get("/api/trades/spot", params=dict(code=CODE, date=DATE, venue="KRX",
                   from_ms=T, to_ms=T+60_000) | params)


@pytest.mark.parametrize("pref,source,price,representation", [
    ("hogaplay", "hogaplay", 100, "ticks"),
    ("kiwoom_live", "kiwoom_live", 200, "second_price_aggregate"),
])
def test_preference_selects_one_source_without_double_volume(tmp_path, api, pref, source, price, representation):
    save(tmp_path, [row()])
    seconds(tmp_path)
    response = get(api, source_pref=pref)
    assert response.status_code == 200
    data = TradeSpotResponse.model_validate(response.json())
    assert (data.source, data.representation) == (source, representation)
    assert len(data.rows) == 1 and data.rows[0].price == price
    assert data.rows[0].qty == (2 if pref == "hogaplay" else 10)
    assert data.rows[0].count == (1 if pref == "hogaplay" else 2)
    assert data.coverage == "unverified"


@pytest.mark.parametrize("seconds_count", [1, 5, 10, 30, 60, 180, 300])
def test_half_open_ranges_duplicate_ticks_order_and_auction_summary(tmp_path, api, seconds_count):
    native_end = int(datetime.fromtimestamp((T+seconds_count*1000)/1000, KST).strftime("%H%M%S"))*1000
    save(tmp_path, [row(90000000, 1), row(90000000, 2), row(native_end, 3),
                    row(90000000, 4, price=0), row(90000000, 5, qty=0), row(90000000, 6, side=0)])
    data = get(api, source_pref="hogaplay", to_ms=T+seconds_count*1000).json()
    assert [r["event_id"] for r in data["rows"]] == [
        "hogaplay:90000000:6", "hogaplay:90000000:2", "hogaplay:90000000:1",
    ]
    assert all(T <= r["t_ms"] < T+seconds_count*1000 for r in data["rows"])
    assert data["prev_close"] == 95


def test_filter_before_limit_and_page_generation_and_request_binding(tmp_path, api):
    path = save(tmp_path, [row(seq=i, qty=100 if i < 3 else 1) for i in range(210)])
    data = get(api, source_pref="hogaplay", min_amount_manwon=1, limit=2).json()
    assert len(data["rows"]) == 2 and data["has_more"]
    more = get(api, source_pref="hogaplay", min_amount_manwon=1, limit=2, cursor=data["next_cursor"])
    assert len(more.json()["rows"]) == 1 and not more.json()["has_more"]
    assert get(api, source_pref="hogaplay", min_amount_manwon=2, limit=2, cursor=data["next_cursor"]).status_code == 422
    assert get(api, cursor="invalid").status_code == 422
    pq.write_table(pa.Table.from_pylist([row(qty=999)]), path / "trades.parquet")
    assert get(api, source_pref="hogaplay", min_amount_manwon=1, limit=2, cursor=data["next_cursor"]).status_code == 409


def test_ws_aggregate_does_not_use_individual_trade_filter(tmp_path, api):
    seconds(tmp_path)
    data = get(api, source_pref="kiwoom_live", min_amount_manwon=1_000_000).json()
    assert data["rows"][0]["qty"] == 10


@pytest.mark.parametrize("venue", ["NXT", "UN"])
def test_market_isolation_and_ws_only_storage(tmp_path, api, venue):
    save(tmp_path, [row()])
    assert get(api, venue=venue, source_pref="hogaplay").json()["status"] == "unavailable"
    seconds(tmp_path, venue=venue)
    data = get(api, venue=venue, source_pref="hogaplay").json()
    assert data["source"] == "kiwoom_live" and data["rows"][0]["price"] == 200


def test_empty_range_does_not_switch_day_source(tmp_path, api):
    save(tmp_path, [row()])
    seconds(tmp_path, t=T+600_000)
    data = get(api, source_pref="kiwoom_live").json()
    assert data["source"] == "kiwoom_live" and data["status"] == "empty"
    assert get(api, source_pref="hogaplay").json()["rows"][0]["price"] == 100


def test_missing_legacy_only_fallback_and_corruption(tmp_path, api):
    assert get(api).json()["status"] == "unavailable"
    save(tmp_path, [row()], "kiwoom_live/KRX")
    assert get(api).json()["status"] == "insufficient_resolution"
    path = save(tmp_path, [row()])
    assert get(api).json()["source"] == "hogaplay"
    (path / "trades.parquet").write_bytes(b"invalid")
    assert get(api, source_pref="hogaplay").status_code == 503


@pytest.mark.parametrize("params", [
    dict(date="20260230"), dict(from_ms=T+1), dict(to_ms=T), dict(to_ms=T+86_400_000), dict(limit=201),
])
def test_validation(api, params):
    assert get(api, **params).status_code == 422


def test_live_revision_replaces_disk_and_late_correction_is_not_reapplied(tmp_path, api, monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 29, 9, 1, tzinfo=KST)

    monkeypatch.setattr(trade_spot_api, "datetime", Clock)
    monkeypatch.setattr("hoga.live.lifecycle.get_capture_session", lambda: None)
    seconds(tmp_path, quantities=(2,))
    live = SecondTradeBar(T)
    live.ingest(t_ms=T, seq=1, price=200, qty=2, side=1)
    live.ingest(t_ms=T, seq=2, price=200, qty=8, side=1)
    store = second_trade_store(tmp_path)
    store._bars[(CODE, "KRX", T)] = live
    store._late[(CODE, "KRX", DATE)] = [{"seq": 10, "trade": {"t_ms": T, "price": 200, "qty": 3, "side": 1}}]
    for _ in range(2):
        data = get(api).json()
        assert data["rows"][0]["qty"] == 13
        assert data["rows"][0]["count"] == 3


def test_preferred_hogaplay_does_not_wait_for_today_collector(tmp_path, api, monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 29, 9, 1, tzinfo=KST)

    monkeypatch.setattr(trade_spot_api, "datetime", Clock)
    save(tmp_path, [row()])

    def forbidden():
        raise AssertionError("hogaplay read must not depend on collector availability")

    monkeypatch.setattr("hoga.live.lifecycle.get_capture_session", forbidden)
    assert get(api, source_pref="hogaplay").json()["source"] == "hogaplay"


@pytest.mark.asyncio
async def test_worker_process_can_read_and_return_the_typed_spot(tmp_path):
    save(tmp_path, [row()])
    executor = ComputeExecutor("process", max_workers=1, worker_env={
        "HOGA_DUCKDB_MEMORY_LIMIT": "512 MiB", "HOGA_COMPUTE_DUCKDB_THREADS": "1",
    })
    try:
        result = await compute_jobs.run_job(executor, compute_jobs.trade_spot_job, str(tmp_path), {
            "code": CODE, "date": DATE, "venue": "KRX", "source_pref": "hogaplay",
            "from_ms": T, "to_ms": T+60_000, "limit": 200, "offset": 0, "min_amount_manwon": 0,
        }, {})
        assert isinstance(result, TradeSpotResponse)
        assert result.rows[0].qty == 2
    finally:
        executor.shutdown()


def test_previous_observation_skips_empty_bars_filters_invalid_ticks_and_respects_amount(tmp_path, api):
    save(tmp_path, [row(90000000, 1, qty=100), row(90030000, 2, qty=1),
                    row(90040000, 3, qty=100, price=0), row(90050000, 4, qty=100, side=9),
                    row(90200000, 5, qty=100), row(90200000, 6, qty=100)])
    first = get(api, from_ms=T+120_000, to_ms=T+180_000, limit=1, min_amount_manwon=1).json()
    assert first['has_more'] and first['previous_observed_ms'] == T
    tail = get(api, from_ms=T+120_000, to_ms=T+180_000, limit=1, min_amount_manwon=1,
               cursor=first['next_cursor']).json()
    assert not tail['has_more'] and tail['previous_observed_ms'] == T
    assert get(api, from_ms=T, to_ms=T+60_000).json()['previous_observed_ms'] is None


def test_ws_previous_observation_uses_selected_venue_and_ignores_individual_amount(tmp_path, api):
    seconds(tmp_path, t=T)
    seconds(tmp_path, t=T+9000, venue='NXT')
    seconds(tmp_path, t=T+30000)
    data = get(api, from_ms=T+10000, to_ms=T+15000, source_pref='kiwoom_live', min_amount_manwon=999999).json()
    assert data['status'] == 'empty' and data['previous_observed_ms'] == T
    assert get(api, from_ms=T, to_ms=T+1000, source_pref='kiwoom_live').json()['previous_observed_ms'] is None
