from pathlib import Path

from hoga.duck import connect_bounded


def test_connect_bounded_applies_memory_limit(tmp_path: Path) -> None:
    con = connect_bounded(memory_limit="1.0 GiB", temp_directory=tmp_path / "duck-tmp")
    assert con.execute("SELECT current_setting('memory_limit')").fetchone()[0] == "1.0 GiB"


def test_connect_bounded_sets_temp_directory(tmp_path: Path) -> None:
    tmp = tmp_path / "duck-tmp"
    con = connect_bounded(memory_limit="1.0 GiB", temp_directory=tmp)
    assert con.execute("SELECT current_setting('temp_directory')").fetchone()[0] == str(tmp)
    assert tmp.is_dir()


def test_connect_bounded_env_override(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOGA_DUCKDB_MEMORY_LIMIT", "2.0 GiB")
    con = connect_bounded(temp_directory=tmp_path / "duck-tmp")
    assert con.execute("SELECT current_setting('memory_limit')").fetchone()[0] == "2.0 GiB"


def test_connect_bounded_defaults_land_in_data_dir(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path / "data"))
    con = connect_bounded(memory_limit="1.0 GiB")
    got = con.execute("SELECT current_setting('temp_directory')").fetchone()[0]
    assert got == str(tmp_path / "data" / "duckdb-tmp")
