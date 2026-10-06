"""Persistent completeness checks must never certify changed cache bytes."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from hoga.api.past_indicators_cache import KIND_VERSIONS, PastIndicatorsCache
from hoga.util.atomic_write import atomic_write_json

CODE, DATE, SOURCE, BUCKET = "005930", "20260610", "hogaplay", 60_000


def _seed(root: Path) -> tuple[PastIndicatorsCache, Path, Path]:
    meta = root / "parquet" / DATE / CODE / SOURCE / "meta.json"
    atomic_write_json(meta, {"name": CODE})
    cache = PastIndicatorsCache(root)
    cache.store_ask_peak(CODE, DATE, SOURCE, BUCKET, None)
    cache.store_bid_peak(CODE, DATE, SOURCE, BUCKET, None)
    cache.store_depth(CODE, DATE, SOURCE, BUCKET, [])
    folder = root / "kis-past-indicators" / CODE / SOURCE
    return cache, folder, meta


def _has(cache: PastIndicatorsCache) -> bool:
    return cache.has_prewarm_bundle(CODE, DATE, SOURCE, BUCKET)


def test_fresh_process_uses_receipt_without_decoding_models(tmp_path: Path) -> None:
    cache, _, _ = _seed(tmp_path)
    assert _has(cache), "Null peaks and empty depth are valid cached results"
    fresh = PastIndicatorsCache(tmp_path)
    with (
        patch.object(fresh, "_read_model_cache", side_effect=AssertionError("large payload decoded")),
        patch.object(fresh, "_read_model_list_cache", side_effect=AssertionError("depth decoded")),
    ):
        assert _has(fresh)


@pytest.mark.parametrize("kind", ["ask_peak", "bid_peak", "depth"])
@pytest.mark.parametrize("damage", ["delete", "json", "shape", "version", "model"])
def test_changed_artifact_invalidates_receipt_even_with_warm_memory(
    tmp_path: Path, kind: str, damage: str,
) -> None:
    cache, folder, _ = _seed(tmp_path)
    assert _has(cache)
    path = folder / f"{DATE}.{kind}.{BUCKET}.json"
    before = path.stat()
    body = json.loads(path.read_text())
    if damage == "delete":
        path.unlink()
    else:
        if damage == "version":
            body["version"] -= 1
        elif damage == "model":
            body["points" if kind == "depth" else "value"] = ["invalid"]
        path.write_text("{" if damage == "json" else "[]" if damage == "shape" else json.dumps(body))
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert not _has(cache)


def test_recapture_and_schema_change_invalidate_receipt(tmp_path: Path, monkeypatch) -> None:
    cache, folder, meta = _seed(tmp_path)
    assert _has(cache)
    monkeypatch.setitem(KIND_VERSIONS, "depth", KIND_VERSIONS["depth"] + 1)
    assert not _has(cache)
    monkeypatch.undo()
    assert _has(cache)
    before = meta.stat()
    atomic_write_json(meta, {"name": CODE})
    os.utime(meta, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert not _has(cache)
    assert (folder / f"{DATE}.prewarm.{BUCKET}.json").exists()


def test_corrupt_receipt_falls_back_and_repairs(tmp_path: Path) -> None:
    cache, folder, _ = _seed(tmp_path)
    assert _has(cache)
    receipt = folder / f"{DATE}.prewarm.{BUCKET}.json"
    receipt.write_text("broken")
    with patch.object(cache, "_read_model_list_cache", wraps=cache._read_model_list_cache) as read:
        assert _has(cache)
        assert read.call_count == 1
    assert json.loads(receipt.read_text())["format"] == 1


def test_concurrent_replacement_during_validation_is_not_certified(tmp_path: Path) -> None:
    cache, folder, _ = _seed(tmp_path)
    read = cache._read_model_list_cache

    def replace_after_read(*args, **kwargs):
        result = read(*args, **kwargs)
        path = folder / f"{DATE}.depth.{BUCKET}.json"
        atomic_write_json(path, {"version": -1})
        return result

    with patch.object(cache, "_read_model_list_cache", side_effect=replace_after_read):
        assert not _has(cache)
    assert not (folder / f"{DATE}.prewarm.{BUCKET}.json").exists()


def test_receipt_write_failure_keeps_valid_cache_usable(tmp_path: Path) -> None:
    cache, _, _ = _seed(tmp_path)
    with patch("hoga.api.past_indicators_cache.atomic_write_json", side_effect=OSError("read only")):
        assert _has(cache)


def test_dry_run_validation_does_not_write_receipt(tmp_path: Path) -> None:
    cache, folder, _ = _seed(tmp_path)
    assert cache.has_prewarm_bundle(CODE, DATE, SOURCE, BUCKET, write_receipt=False)
    assert not (folder / f"{DATE}.prewarm.{BUCKET}.json").exists()
