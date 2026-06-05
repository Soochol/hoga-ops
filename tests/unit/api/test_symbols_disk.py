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
    got, _ = loaded
    by_code = {h.code: h for h in got}
    assert by_code["005930"].security_type == "stock"
    assert by_code["069500"].security_type == "etf"
