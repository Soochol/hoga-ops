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


def test_pre_v3_files_are_rejected(tmp_path: Path) -> None:
    """**v3 에서 하한을 올렸다**(PR-I·#1045).

    v1·v2 는 KIS `.mst` 산이라 ETN 코드에 `Q` 접두가 붙어 있다(`Q500061`).
    키움 `ka10099` 는 `500061` 을 준다. 받아들이면 stale 캐시와 새 fetch 가
    **같은 종목을 다른 코드로** 내보내 검색이 이원화된다(기존 캐시 380건).

    "거부하면 오프라인 부팅에서 검색이 빈다" 는 옛 이유는 **시드 스냅샷**이
    메운다 — `load_disk_state` 가 거부 후 시드로 부팅한다.
    """
    import json

    path = tmp_path / "symbol-master.json"
    for version in (1, 2):
        path.write_text(json.dumps({
            "schema_version": version,
            "fetched_at_ms": 123,
            "entries": [{"code": "005930", "name": "삼성전자", "market": "KOSPI"}],
        }), encoding="utf-8")
        assert symbols._load_from_disk(path) is None, f"v{version} 는 거부해야 한다"


def test_rejected_legacy_file_still_boots_from_the_seed(tmp_path: Path) -> None:
    """거부가 곧 빈 검색이 되면 안 된다 — 시드가 받아 준다."""
    import json

    path = tmp_path / "symbol-master.json"
    path.write_text(json.dumps({
        "schema_version": 2, "fetched_at_ms": 123,
        "entries": [{"code": "Q500061", "name": "구 ETN", "market": "KOSPI"}],
    }), encoding="utf-8")
    symbols.reset_state_for_tests()
    try:
        symbols.load_disk_state(path=path, data_dir=tmp_path)
        codes = {h.code for h in symbols._cache}
        assert len(codes) > 4000, "시드로 부팅해야 한다"
        assert "Q500061" not in codes, "거부된 v2 항목이 새어 나오면 안 된다"
        assert symbols.current_status() == "stale"
    finally:
        symbols.reset_state_for_tests()


def test_needs_boot_refresh_fires_for_seed_boot(tmp_path: Path) -> None:
    """시드 부팅(stale)은 boot refresh 를 예약해야 한다 — 시드는 정의상 낡았다.
    최신 스키마의 디스크 캐시(fresh)면 예약하지 않는다."""
    symbols.reset_state_for_tests()
    path = tmp_path / "symbol-master.json"
    try:
        symbols.load_disk_state(path=path, data_dir=tmp_path)   # 파일 없음 → 시드
        assert symbols.current_status() == "stale"
        assert symbols.needs_boot_refresh() is True

        symbols._write_to_disk(
            path, [_hit("005930", "삼성전자", "KOSPI", "stock")], fetched_at_ms=456
        )
        symbols.load_disk_state(path=path, data_dir=tmp_path)
        assert symbols.needs_boot_refresh() is False
    finally:
        symbols.reset_state_for_tests()
