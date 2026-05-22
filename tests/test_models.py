from hoga.api.models import SymbolMasterInfo
from hoga.api.error_codes import UpstreamCode


def test_symbol_master_info_minimal():
    info = SymbolMasterInfo(count=0, fetched_at_ms=None, status="unavailable", reason=None)
    assert info.count == 0
    assert info.fetched_at_ms is None
    assert info.status == "unavailable"
    assert info.reason is None


def test_symbol_master_info_with_reason():
    info = SymbolMasterInfo(
        count=0,
        fetched_at_ms=None,
        status="unavailable",
        reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED,
    )
    assert info.reason == UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED


def test_symbol_master_info_populated():
    info = SymbolMasterInfo(count=6012, fetched_at_ms=1747900000000, status="fresh", reason=None)
    assert info.count == 6012
    assert info.status == "fresh"
