from hoga.api.models import AskPeak, AskPeakCandidate


def test_ask_peak_accepts_untraded_fields() -> None:
    peak = AskPeak(
        date="20260617",
        price=25000,
        qty=1000,
        t_ms=1781658000000,
        max_price=25000,
        max_qty=1000,
        max_t_ms=1781658000000,
        all_price=26000,
        all_qty=9000,
        all_t_ms=1781658000000,
        all_max_price=26000,
        all_max_qty=9000,
        all_max_t_ms=1781658000000,
        untraded_price=27000,
        untraded_qty=100,
        untraded_t_ms=1781658000000,
        untraded_max_price=27000,
        untraded_max_qty=100,
        untraded_max_t_ms=1781658000000,
    )

    assert peak.untraded_price == 27000
    assert peak.untraded_qty == 100


def test_bid_peak_accepts_untraded_fields() -> None:
    from hoga.api.models import BidPeak

    peak = BidPeak(
        date="20260619",
        price=70000,
        qty=5000,
        t_ms=1,
        max_price=69900,
        max_qty=7000,
        max_t_ms=2,
        all_price=69800,
        all_qty=9000,
        all_t_ms=3,
        all_max_price=69700,
        all_max_qty=11000,
        all_max_t_ms=4,
        untraded_price=69000,
        untraded_qty=12000,
        untraded_t_ms=5,
        untraded_max_price=68900,
        untraded_max_qty=13000,
        untraded_max_t_ms=6,
    )

    assert peak.untraded_price == 69000
    assert peak.untraded_max_qty == 13000


def test_bid_peak_model_accepts_ranked_candidates():
    from hoga.api.models import BidPeak

    peak = BidPeak(
        date="20260613",
        price=24900,
        qty=9000,
        t_ms=1,
        max_price=24900,
        max_qty=9000,
        max_t_ms=1,
        traded_peaks=[AskPeakCandidate(price=24900, qty=9000, t_ms=1)],
        traded_max_peaks=[AskPeakCandidate(price=24900, qty=9000, t_ms=1)],
    )

    assert peak.traded_peaks[0].price == 24900
    assert peak.traded_max_peaks[0].qty == 9000
