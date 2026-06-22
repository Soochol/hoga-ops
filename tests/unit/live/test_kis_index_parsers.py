from hoga.live.kis_client import (
    _parse_index_daily_row,
    _parse_index_minute_row,
    _parse_market_investor_daily_row,
)


def test_parse_index_daily_row_preserves_decimal_index_values() -> None:
    row = {
        "stck_bsop_date": "20260619",
        "bstp_nmix_oprc": "2840.12",
        "bstp_nmix_hgpr": "2861.34",
        "bstp_nmix_lwpr": "2833.20",
        "bstp_nmix_prpr": "2855.67",
        "acml_vol": "450000000",
    }

    point = _parse_index_daily_row(row)

    assert point.open == 2840.12
    assert point.high == 2861.34
    assert point.low == 2833.20
    assert point.close == 2855.67
    assert point.volume == 450000000


def test_parse_index_minute_row_preserves_intraday_ohlcv() -> None:
    row = {
        "stck_bsop_date": "20260619",
        "stck_cntg_hour": "093000",
        "bstp_nmix_oprc": "2850.10",
        "bstp_nmix_hgpr": "2852.34",
        "bstp_nmix_lwpr": "2849.87",
        "bstp_nmix_prpr": "2851.67",
        "cntg_vol": "123456",
    }

    point = _parse_index_minute_row(row)

    assert point.t_ms == 1781829000000
    assert point.open == 2850.10
    assert point.high == 2852.34
    assert point.low == 2849.87
    assert point.close == 2851.67
    assert point.volume == 123456


def test_parse_market_investor_daily_row_uses_foreign_and_institution_net_quantity() -> None:
    row = {
        "stck_bsop_date": "20260619",
        "frgn_ntby_qty": "-3519",
        "orgn_ntby_qty": "17184",
    }

    point = _parse_market_investor_daily_row(row)

    assert point.foreign_net == -3519
    assert point.institution_net == 17184
