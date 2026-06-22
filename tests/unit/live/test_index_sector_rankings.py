from __future__ import annotations

import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.heatmap import save_document
from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder
from hoga.live.index_sector_rankings import build_index_sector_rankings


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


def test_build_index_sector_rankings_reports_unavailable_when_corpus_missing(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.source == "unavailable"
    assert result.unavailable_reason == "screener_daily_corpus_missing"
    assert result.sectors == []


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
