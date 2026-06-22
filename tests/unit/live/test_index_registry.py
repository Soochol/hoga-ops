import pytest

from hoga.live.index_registry import (
    UnknownRepresentativeIndex,
    get_representative_index,
    list_representative_indices,
)


def test_core_indices_are_listed_without_unverified_krx_indices() -> None:
    ids = [idx.id for idx in list_representative_indices()]
    assert ids == ["KOSPI", "KOSDAQ", "KOSPI200", "KOSDAQ150", "KRX100"]


def test_krx_indices_are_present_only_when_unverified_requested() -> None:
    ids = [idx.id for idx in list_representative_indices(include_unverified=True)]
    assert ids == ["KOSPI", "KOSDAQ", "KOSPI200", "KOSDAQ150", "KRX100", "KRX300"]


def test_market_investor_scope_is_only_on_kospi_and_kosdaq() -> None:
    assert get_representative_index("KOSPI").investor_scope == "market"
    assert get_representative_index("KOSDAQ").investor_scope == "market"
    assert get_representative_index("KOSPI200").investor_scope == "none"


def test_unknown_index_is_rejected() -> None:
    with pytest.raises(UnknownRepresentativeIndex):
        get_representative_index("005930")
