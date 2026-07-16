import datetime as dt

import polars as pl
import pytest

from hoga.api import screener_runner
from hoga.api.models import ScanRequest
from hoga.api.screener_intraday import IntradayDailyOverlay
from hoga.live.settings import update_live_settings


def _seed(tmp_path):
    sd = tmp_path / "screener"
    sd.mkdir()
    pl.DataFrame({
        "code": ["000001", "000002"],
        "date": ["2026-05-14", "2026-05-14"],
        "open": [100.0, 100.0],
        "high": [100.0, 100.0],
        "low": [100.0, 100.0],
        "close": [100.0, 100.0],
        "volume": [10, 10],
    }).with_columns(pl.col("date").str.to_date()).write_parquet(sd / "daily_adjusted.parquet")
    pl.DataFrame({
        "code": ["000001", "000002"],
        "name": ["에이", "비"],
        "market": ["KOSPI", "KOSDAQ"],
        "is_etf": [False, False],
        "is_halted": [False, False],
    }).write_parquet(sd / "stocks.parquet")
    (sd / "status.json").write_text('{"schema_version":1,"last_raw_date":"20260514",'
        '"last_built_ms":1,"universe_size":2,"derive_ms":1}')


@pytest.mark.asyncio
async def test_runner_not_seeded_returns_not_seeded(tmp_path):
    res = await screener_runner.run_screener_scan(
        data_dir=tmp_path,
        req=ScanRequest.model_validate({"conditions": [], "universe": {}}),
        now=dt.datetime(2026, 5, 15, 10, 0),
    )

    assert res.status == "not_seeded"
    assert res.rows == []


@pytest.mark.asyncio
async def test_runner_eod_basis_does_not_build_intraday_overlay(tmp_path, monkeypatch):
    _seed(tmp_path)

    async def fail_overlay(**kwargs):
        raise AssertionError("EOD scan must not build intraday overlay")

    monkeypatch.setattr(screener_runner.screener_intraday, "build_intraday_overlay", fail_overlay)

    res = await screener_runner.run_screener_scan(
        data_dir=tmp_path,
        req=ScanRequest.model_validate({
            "conditions": [{"id": "a", "type": "price_range", "params": {"min": 100}}],
            "universe": {"markets": ["KOSPI"]},
        }),
        now=dt.datetime(2026, 5, 15, 10, 0),
    )

    assert res.status == "ok"
    assert [r.code for r in res.rows] == ["000001"]
    assert res.warnings == []


@pytest.mark.asyncio
async def test_runner_intraday_basis_builds_overlay_and_falls_back_with_warning(tmp_path, monkeypatch):
    _seed(tmp_path)
    seen_codes = []

    async def fake_overlay(**kwargs):
        seen_codes.extend(kwargs["codes"])
        return IntradayDailyOverlay(
            rows=pl.DataFrame(schema={
                "code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
                "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64,
            }),
            fetched_at_ms=None,
            warnings=["intraday_kis_unavailable"],
        )

    monkeypatch.setattr(screener_runner.screener_intraday, "build_intraday_overlay", fake_overlay)

    res = await screener_runner.run_screener_scan(
        data_dir=tmp_path,
        req=ScanRequest.model_validate({
            "basis": "intraday",
            "conditions": [{"id": "a", "type": "price_range", "params": {"min": 100}}],
            "universe": {"markets": ["KOSPI"]},
        }),
        now=dt.datetime(2026, 5, 15, 10, 0),
    )

    assert seen_codes == ["000001"]
    assert [r.code for r in res.rows] == ["000001"]
    assert res.warnings == ["intraday_kis_unavailable", "intraday_fallback_eod"]


@pytest.mark.asyncio
async def test_runner_intraday_bypass_skips_overlay_and_uses_eod(tmp_path, monkeypatch):
    _seed(tmp_path)
    update_live_settings(tmp_path, kis_rest_bypass_enabled=True)

    async def fail_overlay(**kwargs):
        raise AssertionError("intraday overlay must not be built during KIS REST bypass")

    monkeypatch.setattr(screener_runner.screener_intraday, "build_intraday_overlay", fail_overlay)

    res = await screener_runner.run_screener_scan(
        data_dir=tmp_path,
        req=ScanRequest.model_validate({
            "basis": "intraday",
            "conditions": [{"id": "a", "type": "price_range", "params": {"min": 100}}],
            "universe": {"markets": ["KOSPI"]},
        }),
        now=dt.datetime(2026, 5, 15, 10, 0),
    )

    assert [r.code for r in res.rows] == ["000001"]
    assert "kis_rest_bypassed_intraday_overlay_skipped" in res.warnings
    assert "intraday_fallback_eod" in res.warnings


def _seed_heatmap(tmp_path, codes):
    from hoga.api.heatmap import save_document
    from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder
    save_document(tmp_path, HeatmapDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="A", order=0)],
        entries=[HeatmapEntry(code=c, name=c, folder_id="f_0000000a") for c in codes]))


@pytest.mark.asyncio
async def test_runner_scope_narrows_universe(tmp_path):
    # scopes=["heatmap"]에 000002만 담기면, 000001은 조건을 통과해도 스코프 밖이라 배제.
    _seed(tmp_path)
    _seed_heatmap(tmp_path, ["000002"])

    res = await screener_runner.run_screener_scan(
        data_dir=tmp_path,
        req=ScanRequest.model_validate({
            "conditions": [{"id": "a", "type": "price_range", "params": {"min": 100}}],
            "universe": {"scopes": ["heatmap"]},
        }),
        now=dt.datetime(2026, 5, 15, 10, 0),
    )

    assert [r.code for r in res.rows] == ["000002"]
    assert "scope_universe_empty" not in res.warnings


@pytest.mark.asyncio
async def test_runner_empty_scope_warns_and_zero_rows(tmp_path):
    # 스코프는 켰으나(관심·히트맵 모두 비어) 대상 0종목 → scope_universe_empty + 0행.
    _seed(tmp_path)

    res = await screener_runner.run_screener_scan(
        data_dir=tmp_path,
        req=ScanRequest.model_validate({
            "conditions": [{"id": "a", "type": "price_range", "params": {"min": 100}}],
            "universe": {"scopes": ["watchlist", "heatmap"]},
        }),
        now=dt.datetime(2026, 5, 15, 10, 0),
    )

    assert res.rows == []
    assert "scope_universe_empty" in res.warnings
