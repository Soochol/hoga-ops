"""Design invariants; synthetic tests, not proof of vendor semantics."""
import json
from decimal import Decimal

from scripts.analyze_us_stock_realtime import aggregate, patch_bar, price


def test_collect_before_broadcast_preserves_an_intrasecond_extreme():
    raw = [Decimal(s) for s in ["100", "110", "90", "101"]]
    observed = aggregate(raw)
    assert observed == dict(open=100, high=110, low=90, close=101)
    assert aggregate(raw[-1:])["high"] != observed["high"]


def test_signed_fe_ohlc_is_positive_price_magnitude():
    # A real KO frame uses '-' even for its open/high/low, unlike REST bars.
    assert price("-94.8000") == Decimal("94.8000")
    assert price("+348.0450") == Decimal("348.0450")


def test_equal_minute_labels_do_not_mean_duplicate_prices():
    # Captured FE timestamps all end in 00; receipt order owns the close.
    frames = [("112600", Decimal(p)) for p in ["347.9550", "348.4100", "348.1700"]]
    folded = aggregate([p for _stamp, p in frames])
    assert folded["high"] == Decimal("348.4100")
    assert folded["close"] == Decimal("348.1700")


def test_rest_volume_open_are_not_double_counted_by_overlay():
    base = dict(open=99, high=102, low=98, close=101, volume=500)
    observed = dict(open=101, high=104, low=97, close=103, volume=200)
    once = patch_bar(base, observed, newer=True)
    assert once == dict(open=99, high=104, low=97, close=103, volume=500)
    assert patch_bar(once, observed, newer=True) == once


def test_observation_older_than_rest_does_not_undo_a_vendor_correction():
    rest = dict(open=99, high=102, low=98, close=100, volume=500)
    old = dict(open=100, high=110, low=90, close=108)
    assert patch_bar(rest, old, newer=False) == rest


def test_latest_observation_can_be_reapplied_to_a_late_rest_response():
    response = dict(open=99, high=102, low=98, close=100, volume=500)
    during_request = dict(open=101, high=105, low=101, close=104)
    assert patch_bar(response, during_request, newer=True)["close"] == during_request["close"]


def test_render_cost_does_not_require_retransmitting_past_history():
    bar = dict(t_ms=1_000_000, open=99, high=102, low=98, close=100, volume=500)
    recent = [dict(bar, t_ms=bar["t_ms"] + i * 60_000) for i in range(800)]
    full = json.dumps(dict(candles=recent)).encode()
    patch = json.dumps(dict(key="us-stock:NASDAQ:AAPL", sequence=1, candle=recent[-1])).encode()
    assert len(full) > 300 * len(patch)
