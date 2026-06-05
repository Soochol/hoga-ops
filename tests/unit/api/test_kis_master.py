"""KIS .mst parser tests (Phase 2). Uses committed real-.mst fixtures."""
from pathlib import Path

import pytest

from hoga.api.kis_master import KisMasterFetchError, parse_master

FIX = Path(__file__).parent / "fixtures"


def test_parse_kospi_classifies_and_filters() -> None:
    rows = parse_master((FIX / "mst_sample_kospi.bin").read_bytes(), "KOSPI")
    types = {r.security_type for r in rows}
    assert "stock" in types
    assert "etf" in types
    assert types <= {"stock", "etf", "etn"}  # 리츠/외국주/펀드 dropped
    for r in rows:
        assert r.code and r.name and r.market == "KOSPI"


def test_parse_kosdaq_uses_222_tail() -> None:
    rows = parse_master((FIX / "mst_sample_kosdaq.bin").read_bytes(), "KOSDAQ")
    assert rows and all(r.market == "KOSDAQ" for r in rows)
    assert any(r.security_type == "stock" for r in rows)


def test_korean_name_not_truncated_or_overrun() -> None:
    rows = parse_master((FIX / "mst_sample_kospi.bin").read_bytes(), "KOSPI")
    assert any("KODEX" in r.name for r in rows)
    assert all("�" not in r.name for r in rows)


def test_parse_empty_raises() -> None:
    with pytest.raises(KisMasterFetchError):
        parse_master(b"", "KOSPI")


def test_parse_html_error_response_raises() -> None:
    with pytest.raises(KisMasterFetchError):
        parse_master(b"<html><body>error</body></html>\n", "KOSPI")
