"""Symbol Master disk round-trip with security_type (Phase 2)."""
from pathlib import Path

from hoga.api import symbols
from hoga.api.models import SymbolHit


def _hit(code: str, name: str, market: str, st: str) -> SymbolHit:
    return SymbolHit(
        code=code, name=name, market=market, security_type=st,  # type: ignore[arg-type]
        captured_count=0,
        captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
    )


def test_disk_roundtrip_preserves_security_type(tmp_path: Path) -> None:
    path = tmp_path / "symbol-master.json"
    entries = [_hit("005930", "삼성전자", "KOSPI", "stock"),
               _hit("069500", "KODEX 200", "KOSPI", "etf")]
    symbols._write_to_disk(path, entries, fetched_at_ms=123)
    loaded = symbols._load_from_disk(path)
    assert loaded is not None
    got, _, schema_version = loaded
    assert schema_version == symbols.SCHEMA_VERSION
    by_code = {h.code: h for h in got}
    assert by_code["005930"].security_type == "stock"
    assert by_code["069500"].security_type == "etf"


def test_v1_legacy_file_loads_with_stock_default(tmp_path: Path) -> None:
    """Upgrade path: a populated v1 file (pykrx era, no security_type) must
    load — rejecting it left symbol search EMPTY on an offline upgrade boot
    while a usable catalog sat on disk. needs_boot_refresh() then converges
    the file to v2 in the background when the network allows."""
    import json

    path = tmp_path / "symbol-master.json"
    path.write_text(json.dumps({
        "schema_version": 1,
        "fetched_at_ms": 123,
        "source": "krx",
        "entries": [{"code": "005930", "name": "삼성전자", "market": "KOSPI"}],
    }), encoding="utf-8")
    loaded = symbols._load_from_disk(path)
    assert loaded is not None
    got, fetched_at_ms, schema_version = loaded
    assert schema_version == 1
    assert fetched_at_ms == 123
    assert got[0].security_type == "stock"  # defaulted


def test_needs_boot_refresh_fires_for_legacy_schema(tmp_path: Path) -> None:
    """fresh-but-v1 must still schedule the boot refresh; fresh v2 must not."""
    import json

    path = tmp_path / "symbol-master.json"
    path.write_text(json.dumps({
        "schema_version": 1,
        "fetched_at_ms": 123,
        "entries": [{"code": "005930", "name": "삼성전자", "market": "KOSPI"}],
    }), encoding="utf-8")
    symbols.reset_state_for_tests()
    try:
        symbols.load_disk_state(path=path, data_dir=tmp_path)
        assert symbols.current_status() == "fresh"
        assert symbols.needs_boot_refresh() is True

        symbols._write_to_disk(
            path, [_hit("005930", "삼성전자", "KOSPI", "stock")], fetched_at_ms=456
        )
        symbols.load_disk_state(path=path, data_dir=tmp_path)
        assert symbols.needs_boot_refresh() is False
    finally:
        symbols.reset_state_for_tests()
