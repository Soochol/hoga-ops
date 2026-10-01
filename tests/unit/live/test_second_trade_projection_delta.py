"""Incremental raw projection parity, replacement safety and bounded work."""
from copy import deepcopy
from datetime import datetime
from unittest.mock import patch

import pytest

from hoga.live.second_trade_agg import SecondTradeBar
from hoga.live.second_trade_delta import SecondResponseRevisions
from hoga.live.second_trade_projection import _project_response
from hoga.util.timeenc import KST

DAY = int(datetime(2026, 9, 30, tzinfo=KST).timestamp() * 1000)
OPEN = DAY + 9 * 3_600_000


def _row(t, price=100, qty=2):
    bar = SecondTradeBar(t)
    bar.ingest(t_ms=t, seq=t, price=price, qty=qty, side=1)
    return bar.record()


def _apply(prior, delta):
    if delta.reset:
        return delta.model_copy(update={"revision": None})
    changed = set(delta.changed_ms)
    bars = {bar.t_ms: bar for bar in prior.bars if bar.t_ms not in changed}
    bars.update({bar.t_ms: bar for bar in delta.bars})
    prices = [p for p in prior.prices if p.t_ms not in changed] + delta.prices
    return delta.model_copy(update={"revision": None, "reset": True, "changed_ms": [],
                                    "bars": [bars[t] for t in sorted(bars)],
                                    "prices": sorted(prices, key=lambda p: p.t_ms)})


@pytest.mark.parametrize("seconds", [1, 5, 10, 30])
@pytest.mark.parametrize("prices", [False, True])
@pytest.mark.parametrize("regular", [False, True])
def test_raw_delta_matches_full_with_coarse_buckets_corrections_deletions_and_ranges(seconds, prices, regular):
    scope = ("005930", "KRX", "20260930", seconds, OPEN, OPEN + 60_000, prices, regular, DAY)
    rows = {t: _row(t) for t in [OPEN - 1000, *range(OPEN, OPEN + 60_000, 1000), OPEN + 61_000]}
    cache = SecondResponseRevisions()
    first = cache.project_rows(scope, rows, "second_trades", None, None)
    expected = _project_response(rows, scope, "second_trades", None)
    assert first.model_copy(update={"revision": None}) == expected
    reconstructed, token = expected, first.revision
    # Mutating original records deliberately checks defensive nested signatures.
    for action in range(7):
        if action == 0:
            rows[OPEN + 59_000]["close"] = 110
        elif action == 1:
            rows[OPEN + 1000]["prices"][0][2] = 99
        elif action == 2:
            rows[OPEN + 1000] = _row(OPEN + 1000, 95)  # Same raw revision, new contents.
        elif action == 3:
            del rows[OPEN + 2000]
        elif action == 4:
            rows[OPEN + 2000] = _row(OPEN + 2000, 120)
        elif action == 5:
            rows[OPEN + 61_000]["last"][0] += 300  # Metadata outside requested range.
        else:
            rows.clear()
        delta = cache.project_rows(scope, rows, "second_trades", None, token)
        reconstructed = _apply(reconstructed, delta)
        assert reconstructed == _project_response(rows, scope, "second_trades", None)
        token = delta.revision
    assert cache.project_rows(scope, rows, "hogaplay", None, token).reset is True
    assert cache.project_rows((*scope[:1], "NXT", *scope[2:]), rows, "second_trades", None, token).reset is True

    # Exercise actual session boundaries as well as the narrow request above.
    close = DAY + 930 * 60_000
    edge_rows = {t: _row(t) for t in [OPEN - 1000, OPEN, close - 1000, close, close + 1000]}
    edge_scope = (*scope[:4], DAY, DAY + 86_400_000, *scope[6:])
    edge = cache.project_rows(edge_scope, edge_rows, "second_trades", None, None)
    assert _apply(None, edge) == _project_response(edge_rows, edge_scope, "second_trades", None)
    assert edge.first_observed_ms == (OPEN if regular else OPEN - 1000)
    assert edge.last_observed_ms == (close if regular else close + 1000)
    edge_rows[close]["volume"] += 2
    closing = cache.project_rows(edge_scope, edge_rows, "second_trades", None, edge.revision)
    assert close in closing.changed_ms
    assert _apply(edge, closing) == _project_response(edge_rows, edge_scope, "second_trades", None)
    range_reset = cache.project_rows(scope, edge_rows, "second_trades", None, closing.revision)
    assert range_reset.reset is True
    assert _apply(None, range_reset) == _project_response(edge_rows, scope, "second_trades", None)


def test_raw_delta_models_only_changed_seconds_and_keeps_unchanged_revision():
    from hoga.live import second_trade_delta as delta_module

    rows = {t: _row(t) for t in range(OPEN, OPEN + 1000_000, 1000)}
    scope = ("005930", "KRX", "20260930", 1, DAY, DAY + 86_400_000, True, True, DAY)
    cache = SecondResponseRevisions(limit=2)
    full = cache.project_rows(scope, rows, "second_trades", None, None)
    with patch.object(delta_module, "aggregate_bars", wraps=delta_module.aggregate_bars) as aggregate:
        same = cache.project_rows(scope, deepcopy(rows), "second_trades", None, full.revision)
        assert same.revision == full.revision and same.changed_ms == []
        aggregate.assert_not_called()
        rows[OPEN + 999_000]["volume"] += 1
        rows[OPEN + 999_000]["prices"][0][2] += 1
        changed = cache.project_rows(scope, rows, "second_trades", None, full.revision)
        assert changed.changed_ms == [OPEN + 999_000]
        assert len(aggregate.call_args.args[0]) == 1
        assert len(changed.bars) == len(changed.prices) == 1
    for _ in range(3):
        rows[OPEN + 999_000]["close"] += 1
        cache.project_rows(scope, rows, "second_trades", None, None)
    assert len(cache._raw_snapshots) <= 2
    assert cache.project_rows(scope, rows, "second_trades", None, full.revision).reset is True
