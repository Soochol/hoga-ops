"""Repeated tick-state access must reuse objects, including seeded state and day rollover."""
from unittest.mock import Mock

from hoga.live import stream as M


def test_peak_state_allocates_once_per_code_venue_day(monkeypatch):
    ask_factory = Mock(wraps=M.TodayAskPeakState)
    bid_factory = Mock(wraps=M.TodayBidPeakState)
    monkeypatch.setattr(M, "TodayAskPeakState", ask_factory)
    monkeypatch.setattr(M, "TodayBidPeakState", bid_factory)
    date = ["20261001"]
    stream = object.__new__(M.LiveStream)
    stream._date_fn = lambda: date[0]
    stream._ask_peak_date = None
    stream._ask_peak_by_code = {}
    stream._bid_peak_by_code = {}
    ask = stream._ask_peak_state("005930", "KRX")
    bid = stream._bid_peak_state("005930", "KRX")
    for _ in range(1_000):
        assert stream._ask_peak_state("005930", "KRX") is ask
        assert stream._bid_peak_state("005930", "KRX") is bid
    assert ask_factory.call_count == bid_factory.call_count == 1
    assert stream._ask_peak_state("005930", "NXT") is not ask
    assert stream._ask_peak_state("000660", "KRX") is not ask
    assert ask_factory.call_count == 3
    date[0] = "20261002"
    assert stream._ask_peak_state("005930", "KRX") is not ask
    assert stream._bid_peak_state("005930", "KRX") is not bid
    assert ask_factory.call_count == 4
    assert bid_factory.call_count == 2
