from hoga.api.models import AskPeak, AskPeakCandidate


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


def test_peak_models_allow_nullable_post_touch_scalars() -> None:
    from hoga.api.models import BidPeak

    ask_peak = AskPeak(
        date="20260617",
        price=None,
        qty=None,
        t_ms=None,
        max_price=None,
        max_qty=None,
        max_t_ms=None,
        all_price=26000,
        all_qty=9000,
        all_t_ms=1781658000000,
        all_max_price=26100,
        all_max_qty=9100,
        all_max_t_ms=1781658060000,
    )
    bid_peak = BidPeak(
        date="20260619",
        price=None,
        qty=None,
        t_ms=None,
        max_price=None,
        max_qty=None,
        max_t_ms=None,
        all_price=69800,
        all_qty=9000,
        all_t_ms=1781827200000,
        all_max_price=69700,
        all_max_qty=9100,
        all_max_t_ms=1781827260000,
    )

    assert ask_peak.price is None
    assert ask_peak.max_t_ms is None
    assert bid_peak.price is None
    assert bid_peak.max_t_ms is None
