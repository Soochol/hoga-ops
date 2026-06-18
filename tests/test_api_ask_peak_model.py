from hoga.api.models import AskPeak


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
