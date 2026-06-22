from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Literal

import polars as pl
from pydantic import BaseModel

from hoga.api.heatmap import load_document
from hoga.api.models import HeatmapEntry

RankingSource = Literal["daily_adjusted", "unavailable"]
MissingReason = Literal["no_basis_bar", "no_previous_close"]


class IndexSectorStock(BaseModel):
    code: str
    name: str
    folder_id: str | None
    folder_name: str
    order: int
    close: float | None
    previous_close: float | None
    change_pct: float | None
    missing_reason: MissingReason | None = None


class IndexSectorGroup(BaseModel):
    folder_id: str | None
    folder_name: str
    order: int
    change_pct: float | None
    finite_count: int
    total_count: int
    stocks: list[IndexSectorStock]


class IndexSectorRankingResponse(BaseModel):
    date: str
    source: RankingSource
    unavailable_reason: Literal["screener_daily_corpus_missing"] | None = None
    sectors: list[IndexSectorGroup]


def _parse_basis_date(value: str) -> dt.date:
    return dt.datetime.strptime(value, "%Y%m%d").date()


def _round_pct(value: float) -> float:
    return round(value, 4)


def _entry_groups(
    entries: list[HeatmapEntry],
    folder_names: dict[str, str],
    folder_orders: dict[str, int],
) -> list[tuple[str | None, str, int, list[HeatmapEntry]]]:
    grouped: dict[str | None, list[HeatmapEntry]] = {}
    for entry in entries:
        grouped.setdefault(entry.folder_id, []).append(entry)
    rows: list[tuple[str | None, str, int, list[HeatmapEntry]]] = []
    for folder_id, group_entries in grouped.items():
        name = folder_names.get(folder_id or "", "미분류") if folder_id is not None else "미분류"
        order = folder_orders.get(folder_id or "", 1_000_000)
        rows.append((folder_id, name, order, sorted(group_entries, key=lambda e: (e.order, e.code))))
    return sorted(rows, key=lambda row: (row[2], row[1]))


def _load_daily_rows(path: Path, codes: list[str], basis: dt.date) -> dict[str, list[dict]]:
    if not codes:
        return {}
    df = (
        pl.scan_parquet(path)
        .filter(pl.col("code").is_in(codes))
        .filter(pl.col("date") <= basis)
        .select(["code", "date", "close"])
        .collect()
        .sort(["code", "date"])
    )
    by_code: dict[str, list[dict]] = {}
    for row in df.iter_rows(named=True):
        by_code.setdefault(str(row["code"]), []).append(row)
    return by_code


def _stock_from_entry(
    entry: HeatmapEntry,
    *,
    folder_name: str,
    basis: dt.date,
    rows: list[dict],
) -> IndexSectorStock:
    basis_row = next((row for row in reversed(rows) if row["date"] == basis), None)
    if basis_row is None:
        return IndexSectorStock(
            code=entry.code,
            name=entry.name,
            folder_id=entry.folder_id,
            folder_name=folder_name,
            order=entry.order,
            close=None,
            previous_close=None,
            change_pct=None,
            missing_reason="no_basis_bar",
        )
    previous_row = next((row for row in reversed(rows) if row["date"] < basis), None)
    close = float(basis_row["close"])
    if previous_row is None or float(previous_row["close"]) == 0:
        return IndexSectorStock(
            code=entry.code,
            name=entry.name,
            folder_id=entry.folder_id,
            folder_name=folder_name,
            order=entry.order,
            close=close,
            previous_close=None,
            change_pct=None,
            missing_reason="no_previous_close",
        )
    previous_close = float(previous_row["close"])
    change_pct = _round_pct((close / previous_close - 1.0) * 100.0)
    return IndexSectorStock(
        code=entry.code,
        name=entry.name,
        folder_id=entry.folder_id,
        folder_name=folder_name,
        order=entry.order,
        close=close,
        previous_close=previous_close,
        change_pct=change_pct,
    )


def _sort_stocks(stocks: list[IndexSectorStock]) -> list[IndexSectorStock]:
    return sorted(
        stocks,
        key=lambda stock: (
            stock.change_pct is None,
            -(stock.change_pct or 0.0),
            stock.order,
            stock.code,
        ),
    )


def _sector_average(stocks: list[IndexSectorStock]) -> tuple[float | None, int]:
    values = [stock.change_pct for stock in stocks if stock.change_pct is not None]
    if not values:
        return None, 0
    return _round_pct(sum(values) / len(values)), len(values)


def _sort_sectors(sectors: list[IndexSectorGroup]) -> list[IndexSectorGroup]:
    return sorted(
        sectors,
        key=lambda sector: (
            sector.change_pct is None,
            -(sector.change_pct or 0.0),
            sector.order,
            sector.folder_name,
        ),
    )


def build_index_sector_rankings(data_dir: Path, basis_date: str) -> IndexSectorRankingResponse:
    basis = _parse_basis_date(basis_date)
    doc = load_document(data_dir)
    corpus_path = data_dir / "screener" / "daily_adjusted.parquet"
    if not corpus_path.exists():
        return IndexSectorRankingResponse(
            date=basis_date,
            source="unavailable",
            unavailable_reason="screener_daily_corpus_missing",
            sectors=[],
        )
    codes = [entry.code for entry in doc.entries]
    daily_rows = _load_daily_rows(corpus_path, codes, basis)
    folder_names = {folder.id: folder.name for folder in doc.folders}
    folder_orders = {folder.id: folder.order for folder in doc.folders}
    sectors: list[IndexSectorGroup] = []
    for folder_id, folder_name, folder_order, entries in _entry_groups(doc.entries, folder_names, folder_orders):
        stocks = _sort_stocks([
            _stock_from_entry(
                entry,
                folder_name=folder_name,
                basis=basis,
                rows=daily_rows.get(entry.code, []),
            )
            for entry in entries
        ])
        avg, finite_count = _sector_average(stocks)
        sectors.append(
            IndexSectorGroup(
                folder_id=folder_id,
                folder_name=folder_name,
                order=folder_order,
                change_pct=avg,
                finite_count=finite_count,
                total_count=len(stocks),
                stocks=stocks,
            ),
        )
    return IndexSectorRankingResponse(
        date=basis_date,
        source="daily_adjusted",
        sectors=_sort_sectors(sectors),
    )
