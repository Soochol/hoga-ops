"""Tests for three-source display-priority resolution."""
from __future__ import annotations

from pathlib import Path
from typing import get_args
from unittest.mock import MagicMock

import pytest

from hoga.api.sources import SourceName, ordered_sources, resolve_source


def _make_engine(tmp_path: Path) -> MagicMock:
    engine = MagicMock()
    engine.data_dir = tmp_path
    return engine


def _seed_source(tmp_path: Path, date: str, code: str, source: str) -> None:
    sd = tmp_path / "parquet" / date / code / source
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text('{"collection_complete": true, "is_partial": false}')


def test_source_name_literal_includes_kis_api() -> None:
    assert set(get_args(SourceName)) == {"hogaplay", "kis_live", "kis_api"}


@pytest.mark.parametrize(
    ("policy", "expected"),
    [
        ("hogaplay", ("hogaplay", "kis_live", "kis_api")),
        ("hogaplay_first", ("hogaplay", "kis_live", "kis_api")),
        ("kis_live", ("kis_live", "kis_api", "hogaplay")),
        ("kis_ws_first", ("kis_live", "kis_api", "hogaplay")),
        ("kis_api", ("kis_api", "kis_live", "hogaplay")),
        ("kis_api_first", ("kis_api", "kis_live", "hogaplay")),
    ],
)
def test_ordered_sources_maps_legacy_and_policy_names(policy, expected) -> None:
    assert ordered_sources(policy) == expected


def test_resolve_source_uses_ordered_policy(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")
    _seed_source(tmp_path, "20260622", "005930", "kis_live")
    _seed_source(tmp_path, "20260622", "005930", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "hogaplay_first") == "hogaplay"
    assert resolve_source(engine, "20260622", "005930", "kis_ws_first") == "kis_live"
    assert resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"


def test_resolve_source_falls_back_to_second_source(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "hogaplay_first") == "kis_api"


def test_resolve_source_returns_first_policy_source_when_none_exist(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"


@pytest.mark.parametrize("bad", ["", "kis_ws", "HOGAPLAY"])
def test_ordered_sources_rejects_unknown_policy(bad: str) -> None:
    with pytest.raises(ValueError, match="unknown source policy"):
        ordered_sources(bad)
