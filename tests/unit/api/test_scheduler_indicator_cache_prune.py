"""Daily cleanup deletes obsolete caches before the trading-day gate."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from hoga.api import indicator_cache_prune, prune, scheduler
from hoga.api.past_indicators_cache import KIND_VERSIONS


@pytest.fixture
def daily_stages(monkeypatch):
    monkeypatch.setattr("hoga.live.promote.promote_pending", AsyncMock())
    monkeypatch.setattr("hoga.live.promote.cleanup_archive", AsyncMock())
    trading = AsyncMock(return_value=False)
    monkeypatch.setattr(scheduler, "run_trading_stage", trading)
    return trading


@pytest.mark.parametrize("failed_stage", [None, "prune_raw", "prune_derived"])
async def test_daily_prunes_both_namespaces_independently_of_other_cleanup(
    tmp_path, monkeypatch, daily_stages, failed_stage, caplog,
):
    old_paths = []
    kept_paths = []
    for root in ("kis-past-indicators", "kis-past-indicators-regular"):
        folder = tmp_path / root / "005930" / "hogaplay" / "KRX"
        folder.mkdir(parents=True)
        for day, version in enumerate((1, KIND_VERSIONS["ask_peak"], KIND_VERSIONS["ask_peak"] + 1), 1):
            path = folder / f"2026100{day}.ask_peak.60000.json"
            path.write_text(json.dumps({"version": version}))
            (old_paths if version == 1 else kept_paths).append(path)

    if failed_stage:
        def fail(*_args, **_kwargs):
            raise OSError("simulated cleanup failure")
        monkeypatch.setattr(prune, failed_stage, fail)

    async def non_trading_day(_data_dir):
        assert all(not path.exists() for path in old_paths)
        assert all(path.exists() for path in kept_paths)
        return False

    daily_stages.side_effect = non_trading_day
    assert await scheduler._daily_run(tmp_path) is False
    daily_stages.assert_awaited_once_with(tmp_path)


async def test_indicator_cleanup_failure_does_not_block_raw_or_trading(
    tmp_path, monkeypatch, daily_stages, caplog,
):
    def fail(*_args, **_kwargs):
        raise OSError("cache unavailable")

    monkeypatch.setattr(indicator_cache_prune, "prune", fail)
    real_raw = prune.prune_raw
    raw_called = []

    def raw(*args, **kwargs):
        raw_called.append(True)
        return real_raw(*args, **kwargs)

    monkeypatch.setattr(prune, "prune_raw", raw)
    assert await scheduler._daily_run(tmp_path) is False
    assert raw_called == [True]
    daily_stages.assert_awaited_once_with(tmp_path)
    assert "indicator cache prune failed; continuing" in caplog.text
