from __future__ import annotations

import datetime as dt
import os
from pathlib import Path

import polars as pl
import pytest

from hoga.live import index_sector_rankings as rankings
from hoga.api.heatmap import save_document
from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder
from hoga.live.index_sector_rankings import build_index_sector_rankings


@pytest.fixture(autouse=True)
def clear_ranking_cache() -> None:
    rankings._ranking_cache.clear()
    rankings._fingerprint_cache.clear()
    yield
    rankings._ranking_cache.clear()
    rankings._fingerprint_cache.clear()


def _seed_heatmap(tmp_path: Path) -> None:
    semi_id = "f_00000001"
    bio_id = "f_00000002"
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[
                WatchlistFolder.model_construct(id=semi_id, name="반도체", order=0),
                WatchlistFolder.model_construct(id=bio_id, name="바이오", order=1),
            ],
            entries=[
                HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=semi_id, order=0),
                HeatmapEntry.model_construct(code="000660", name="SK하이닉스", folder_id=semi_id, order=1),
                HeatmapEntry.model_construct(code="068270", name="셀트리온", folder_id=bio_id, order=0),
                HeatmapEntry.model_construct(code="999999", name="없는종목", folder_id=bio_id, order=1),
            ],
        ),
    )


def _seed_daily(tmp_path: Path) -> None:
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["005930", "005930", "000660", "000660", "068270", "068270"],
            "date": [
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
            ],
            "open": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "high": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "low": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "close": [100.0, 110.0, 200.0, 210.0, 100.0, 98.0],
            "volume": [1, 1, 1, 1, 1, 1],
        },
    ).write_parquet(sdir / "daily_adjusted.parquet")


def test_build_index_sector_rankings_sorts_sectors_and_stocks(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.date == "20260619"
    assert result.source == "daily_adjusted"
    assert result.unavailable_reason is None
    assert [s.folder_id for s in result.sectors] == ["f_00000001", "f_00000002"]
    assert result.sectors[0].change_pct == 7.5
    assert [s.code for s in result.sectors[0].stocks] == ["005930", "000660"]
    assert result.sectors[0].stocks[0].change_pct == 10.0
    assert result.sectors[0].stocks[1].change_pct == 5.0
    assert result.sectors[1].change_pct == -2.0
    assert result.sectors[1].stocks[-1].code == "999999"
    assert result.sectors[1].stocks[-1].change_pct is None
    assert result.sectors[1].stocks[-1].missing_reason == "no_basis_bar"


def test_build_index_sector_rankings_uses_current_heatmap_membership(tmp_path: Path) -> None:
    _seed_daily(tmp_path)
    moved_id = "f_00000003"
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder.model_construct(id=moved_id, name="이동후", order=0)],
            entries=[HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=moved_id, order=0)],
        ),
    )

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert [s.folder_id for s in result.sectors] == ["f_00000003"]
    assert result.sectors[0].folder_name == "이동후"
    assert [s.code for s in result.sectors[0].stocks] == ["005930"]


def test_build_index_sector_rankings_uses_new_disk_cache_after_heatmap_changes(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    first = build_index_sector_rankings(tmp_path, "20260619")

    moved_id = "f_00000003"
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder.model_construct(id=moved_id, name="이동후", order=0)],
            entries=[HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=moved_id, order=0)],
        ),
    )
    second = build_index_sector_rankings(tmp_path, "20260619")
    cache_files = list((tmp_path / "cache" / "index_sector_rankings").glob("20260619-*.json"))

    assert first.sectors[0].folder_name == "반도체"
    assert second.sectors[0].folder_name == "이동후"
    assert len(cache_files) == 2


def test_build_index_sector_rankings_reports_unavailable_when_corpus_missing(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)

    result = build_index_sector_rankings(tmp_path, "20260619")
    cache_files = list((tmp_path / "cache" / "index_sector_rankings").glob("20260619-*.json"))

    assert result.source == "unavailable"
    assert result.unavailable_reason == "screener_daily_corpus_missing"
    assert result.sectors == []
    assert len(cache_files) == 1
    assert rankings._read_disk_cache(cache_files[0]) == result


def test_build_index_sector_rankings_falls_back_to_latest_available_basis_when_requested_day_missing(
    tmp_path: Path,
) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)

    result = build_index_sector_rankings(tmp_path, "20260620")

    assert result.date == "20260620"
    assert result.source == "daily_adjusted"
    assert result.unavailable_reason is None
    assert result.sectors[0].change_pct == 7.5
    assert result.sectors[0].stocks[0].change_pct == 10.0


def test_build_index_sector_rankings_reports_unavailable_when_corpus_invalid(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame({
        "code": ["005930"],
        "date": [dt.date(2026, 6, 19)],
    }).write_parquet(sdir / "daily_adjusted.parquet")

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.source == "unavailable"
    assert result.unavailable_reason == "daily_corpus_invalid"
    assert result.sectors == []


def test_build_index_sector_rankings_reports_unavailable_when_close_value_invalid(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["005930", "005930"],
            "date": [dt.date(2026, 6, 18), dt.date(2026, 6, 19)],
            "close": [100.0, None],
        },
    ).write_parquet(sdir / "daily_adjusted.parquet")

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.source == "unavailable"
    assert result.unavailable_reason == "daily_corpus_invalid"
    assert result.sectors == []


def test_build_index_sector_rankings_caches_unchanged_heatmap_and_corpus(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    calls = 0
    original = rankings._load_daily_rows

    def counting_load_daily_rows(path, codes, basis):
        nonlocal calls
        calls += 1
        return original(path, codes, basis)

    monkeypatch.setattr(rankings, "_load_daily_rows", counting_load_daily_rows)

    assert build_index_sector_rankings(tmp_path, "20260619").source == "daily_adjusted"
    assert build_index_sector_rankings(tmp_path, "20260619").source == "daily_adjusted"
    assert calls == 1


def test_index_sector_ranking_disk_cache_path_uses_input_fingerprint(tmp_path: Path) -> None:
    path = rankings._ranking_disk_cache_path(tmp_path, "20260619", "heatmap123", "daily456")

    assert path.parent == tmp_path / "cache" / "index_sector_rankings"
    assert path.name == "20260619-heatmap_heatmap123-daily_daily456.json"


def test_build_index_sector_rankings_writes_disk_cache(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)

    result = build_index_sector_rankings(tmp_path, "20260619")
    cache_files = list((tmp_path / "cache" / "index_sector_rankings").glob("20260619-*.json"))

    assert result.source == "daily_adjusted"
    assert len(cache_files) == 1
    cached = rankings._read_disk_cache(cache_files[0])
    assert cached == result


def test_build_index_sector_rankings_reads_valid_disk_cache_on_memory_miss(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    first = build_index_sector_rankings(tmp_path, "20260619")
    rankings._ranking_cache.clear()

    def fail_load_daily_rows(path, codes, basis):
        raise AssertionError("disk cache hit should not scan parquet")

    monkeypatch.setattr(rankings, "_load_daily_rows", fail_load_daily_rows)

    second = build_index_sector_rankings(tmp_path, "20260619")

    assert second == first
    assert second.source == "daily_adjusted"


def test_build_index_sector_rankings_reuses_file_fingerprints_for_hot_memory_hit(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    calls = 0
    original = rankings._read_file_fingerprint

    def counting_read_file_fingerprint(path):
        nonlocal calls
        calls += 1
        return original(path)

    monkeypatch.setattr(rankings, "_read_file_fingerprint", counting_read_file_fingerprint)

    assert build_index_sector_rankings(tmp_path, "20260619").source == "daily_adjusted"
    assert build_index_sector_rankings(tmp_path, "20260619").source == "daily_adjusted"
    assert calls == 2


def test_build_index_sector_rankings_ignores_corrupt_disk_cache(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    heatmap_path = tmp_path / "heatmap.json"
    corpus_path = tmp_path / "screener" / "daily_adjusted.parquet"
    cache_path = rankings._ranking_disk_cache_path(
        tmp_path,
        "20260619",
        heatmap_fingerprint=rankings._file_fingerprint(heatmap_path),
        corpus_fingerprint=rankings._file_fingerprint(corpus_path),
    )
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text("{not json", encoding="utf-8")

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.source == "daily_adjusted"
    assert result.sectors[0].change_pct == 7.5
    assert rankings._read_disk_cache(cache_path) == result


def test_build_index_sector_rankings_invalidates_disk_cache_when_heatmap_changes_with_same_mtime(
    tmp_path: Path,
) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    heatmap_path = tmp_path / "heatmap.json"
    original_stat = heatmap_path.stat()
    first = build_index_sector_rankings(tmp_path, "20260619")
    rankings._ranking_cache.clear()

    moved_id = "f_00000003"
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder.model_construct(id=moved_id, name="이동후", order=0)],
            entries=[HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=moved_id, order=0)],
        ),
    )
    os.utime(heatmap_path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    second = build_index_sector_rankings(tmp_path, "20260619")
    cache_files = list((tmp_path / "cache" / "index_sector_rankings").glob("20260619-*.json"))

    assert first.sectors[0].folder_name == "반도체"
    assert second.sectors[0].folder_name == "이동후"
    assert len(cache_files) == 2


def test_build_index_sector_rankings_invalidates_disk_cache_when_daily_corpus_changes_with_same_mtime(
    tmp_path: Path,
) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    corpus_path = tmp_path / "screener" / "daily_adjusted.parquet"
    original_stat = corpus_path.stat()
    first = build_index_sector_rankings(tmp_path, "20260619")
    rankings._ranking_cache.clear()

    pl.DataFrame(
        {
            "code": ["005930", "005930", "000660", "000660", "068270", "068270"],
            "date": [
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
            ],
            "open": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "high": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "low": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "close": [100.0, 120.0, 200.0, 220.0, 100.0, 98.0],
            "volume": [1, 1, 1, 1, 1, 1],
        },
    ).write_parquet(corpus_path)
    os.utime(corpus_path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    second = build_index_sector_rankings(tmp_path, "20260619")
    cache_files = list((tmp_path / "cache" / "index_sector_rankings").glob("20260619-*.json"))

    assert first.sectors[0].change_pct == 7.5
    assert second.sectors[0].change_pct == 15.0
    assert len(cache_files) == 2


def test_build_index_sector_rankings_reports_unavailable_when_corpus_path_is_unreadable(
    tmp_path: Path,
) -> None:
    _seed_heatmap(tmp_path)
    corpus_path = tmp_path / "screener" / "daily_adjusted.parquet"
    corpus_path.mkdir(parents=True)

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.source == "unavailable"
    assert result.unavailable_reason == "daily_corpus_invalid"


def test_build_index_sector_rankings_marks_missing_previous_close(tmp_path: Path) -> None:
    solo_id = "f_00000004"
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder.model_construct(id=solo_id, name="단일", order=0)],
            entries=[HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=solo_id, order=0)],
        ),
    )
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["005930"],
            "date": [dt.date(2026, 6, 19)],
            "open": [0.0],
            "high": [0.0],
            "low": [0.0],
            "close": [110.0],
            "volume": [1],
        },
    ).write_parquet(sdir / "daily_adjusted.parquet")

    result = build_index_sector_rankings(tmp_path, "20260619")

    stock = result.sectors[0].stocks[0]
    assert stock.change_pct is None
    assert stock.missing_reason == "no_previous_close"
    assert result.sectors[0].change_pct is None
