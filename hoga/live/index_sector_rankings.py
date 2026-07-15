from __future__ import annotations

import datetime as dt
import hashlib
import json
from collections import OrderedDict
from pathlib import Path
from threading import Lock
from typing import Literal

import polars as pl
from pydantic import BaseModel

from hoga.api.heatmap import load_document
from hoga.api.models import HeatmapEntry

RankingSource = Literal["daily_adjusted", "unavailable"]
MissingReason = Literal["no_basis_bar", "no_previous_close", "no_intraday_price"]
UnavailableReason = Literal[
    "screener_daily_corpus_missing",
    "daily_corpus_invalid",
    "no_basis_bars",
]
_CACHE_MAX = 64
_FINGERPRINT_CACHE_MAX = 128
_cache_lock = Lock()
_ranking_cache: OrderedDict[
    tuple[str, str, str, str],
    IndexSectorRankingResponse,
] = OrderedDict()
_fingerprint_cache: OrderedDict[tuple[str, tuple[int, int, int, int, int]], str] = OrderedDict()


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
    unavailable_reason: UnavailableReason | None = None
    sectors: list[IndexSectorGroup]


def _parse_basis_date(value: str) -> dt.date:
    return dt.datetime.strptime(value, "%Y%m%d").date()


def _round_pct(value: float) -> float:
    return round(value, 4)


def _entry_groups(
    entries: list[HeatmapEntry],
    folder_names: dict[str, str],
    folder_orders: dict[str, int],
) -> list[tuple[str, str, int, list[HeatmapEntry]]]:
    grouped: dict[str, list[HeatmapEntry]] = {}
    for entry in entries:
        grouped.setdefault(entry.folder_id, []).append(entry)
    rows: list[tuple[str, str, int, list[HeatmapEntry]]] = []
    for folder_id, group_entries in grouped.items():
        # v3 (ADR-0111): folder_id 는 항상 실폴더(load_document 가 dangling 복구) —
        # 이름 결측은 방어적 폴백으로 id 를 그대로 노출(미분류 render-group 은 폐지).
        name = folder_names.get(folder_id, folder_id)
        order = folder_orders.get(folder_id, 1_000_000)
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


def list_index_sector_ranking_codes(data_dir: Path) -> list[str]:
    doc = load_document(data_dir)
    return [entry.code for entry in doc.entries]


def _stock_from_entry(
    entry: HeatmapEntry,
    *,
    folder_name: str,
    basis: dt.date,
    rows: list[dict],
    intraday_prices: dict[str, int] | None = None,
) -> IndexSectorStock:
    intraday_price = intraday_prices.get(entry.code) if intraday_prices is not None else None
    basis_row = (
        None
        if intraday_price is not None
        else next((row for row in reversed(rows) if row["date"] == basis), None)
    )
    if intraday_prices is not None and intraday_price is None:
        return IndexSectorStock(
            code=entry.code,
            name=entry.name,
            folder_id=entry.folder_id,
            folder_name=folder_name,
            order=entry.order,
            close=None,
            previous_close=None,
            change_pct=None,
            missing_reason="no_intraday_price",
        )
    if basis_row is None and intraday_price is None:
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
    close = float(intraday_price if intraday_price is not None else basis_row["close"])
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


def _latest_available_basis(daily_rows: dict[str, list[dict]], basis: dt.date) -> dt.date | None:
    dates = [
        row["date"]
        for rows in daily_rows.values()
        for row in rows
        if row.get("date") <= basis
    ]
    return max(dates) if dates else None


def _build_sector_groups(
    entries: list[HeatmapEntry],
    *,
    folder_names: dict[str, str],
    folder_orders: dict[str, int],
    daily_rows: dict[str, list[dict]],
    basis: dt.date,
    intraday_prices: dict[str, int] | None = None,
) -> list[IndexSectorGroup]:
    sectors: list[IndexSectorGroup] = []
    for folder_id, folder_name, folder_order, group_entries in _entry_groups(entries, folder_names, folder_orders):
        stocks = _sort_stocks([
            _stock_from_entry(
                entry,
                folder_name=folder_name,
                basis=basis,
                rows=daily_rows.get(entry.code, []),
                intraday_prices=intraday_prices,
            )
            for entry in group_entries
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
    return sectors


def _all_stocks_missing_basis(sectors: list[IndexSectorGroup]) -> bool:
    all_stocks = [stock for sector in sectors for stock in sector.stocks]
    return bool(all_stocks) and all(stock.missing_reason == "no_basis_bar" for stock in all_stocks)


def _read_file_fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "unreadable"
    return digest.hexdigest()


def _file_fingerprint(path: Path) -> str:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "unreadable"
    stat_key = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    cache_key = (str(path.resolve()), stat_key)
    with _cache_lock:
        cached = _fingerprint_cache.get(cache_key)
        if cached is not None:
            _fingerprint_cache.move_to_end(cache_key)
            return cached
    fingerprint = _read_file_fingerprint(path)
    with _cache_lock:
        _fingerprint_cache[cache_key] = fingerprint
        _fingerprint_cache.move_to_end(cache_key)
        while len(_fingerprint_cache) > _FINGERPRINT_CACHE_MAX:
            _fingerprint_cache.popitem(last=False)
    return fingerprint


def _ranking_disk_cache_path(
    data_dir: Path,
    basis_date: str,
    heatmap_fingerprint: str,
    corpus_fingerprint: str,
) -> Path:
    filename = f"{basis_date}-heatmap_{heatmap_fingerprint}-daily_{corpus_fingerprint}.json"
    return data_dir / "cache" / "index_sector_rankings" / filename


def _read_disk_cache(path: Path) -> IndexSectorRankingResponse | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return IndexSectorRankingResponse.model_validate(raw)
    except (OSError, ValueError):
        return None


def _write_disk_cache(path: Path, value: IndexSectorRankingResponse) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        tmp_path.write_text(value.model_dump_json(), encoding="utf-8")
        tmp_path.replace(path)
    except OSError:
        return


def _unavailable(basis_date: str, reason: UnavailableReason) -> IndexSectorRankingResponse:
    return IndexSectorRankingResponse(
        date=basis_date,
        source="unavailable",
        unavailable_reason=reason,
        sectors=[],
    )


def _cache_get(key: tuple[str, str, str, str]) -> IndexSectorRankingResponse | None:
    with _cache_lock:
        cached = _ranking_cache.get(key)
        if cached is not None:
            _ranking_cache.move_to_end(key)
        return cached


def _cache_put(
    key: tuple[str, str, str, str],
    value: IndexSectorRankingResponse,
) -> IndexSectorRankingResponse:
    with _cache_lock:
        _ranking_cache[key] = value
        _ranking_cache.move_to_end(key)
        while len(_ranking_cache) > _CACHE_MAX:
            _ranking_cache.popitem(last=False)
    return value


def _cache_put_with_disk(
    key: tuple[str, str, str, str],
    disk_path: Path,
    value: IndexSectorRankingResponse,
) -> IndexSectorRankingResponse:
    _write_disk_cache(disk_path, value)
    return _cache_put(key, value)


def build_index_sector_rankings(
    data_dir: Path,
    basis_date: str,
    *,
    intraday_prices: dict[str, int] | None = None,
) -> IndexSectorRankingResponse:
    basis = _parse_basis_date(basis_date)
    corpus_path = data_dir / "screener" / "daily_adjusted.parquet"
    heatmap_path = data_dir / "heatmap.json"
    use_cache = intraday_prices is None
    cache_key = (
        str(data_dir.resolve()),
        basis_date,
        _file_fingerprint(heatmap_path),
        _file_fingerprint(corpus_path),
    )
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    disk_cache_path = _ranking_disk_cache_path(
        data_dir,
        basis_date,
        heatmap_fingerprint=cache_key[2],
        corpus_fingerprint=cache_key[3],
    )
    if use_cache:
        disk_cached = _read_disk_cache(disk_cache_path)
        if disk_cached is not None:
            return _cache_put(cache_key, disk_cached)

    doc = load_document(data_dir)
    if not corpus_path.exists():
        return _cache_put_with_disk(
            cache_key,
            disk_cache_path,
            _unavailable(basis_date, "screener_daily_corpus_missing"),
        )
    codes = [entry.code for entry in doc.entries]
    try:
        daily_rows = _load_daily_rows(corpus_path, codes, basis)
    except Exception:
        return _cache_put_with_disk(
            cache_key,
            disk_cache_path,
            _unavailable(basis_date, "daily_corpus_invalid"),
        )
    folder_names = {folder.id: folder.name for folder in doc.folders}
    folder_orders = {folder.id: folder.order for folder in doc.folders}
    try:
        sectors = _build_sector_groups(
            doc.entries,
            folder_names=folder_names,
            folder_orders=folder_orders,
            daily_rows=daily_rows,
            basis=basis,
            intraday_prices=intraday_prices,
        )
        if intraday_prices is None and _all_stocks_missing_basis(sectors):
            fallback_basis = _latest_available_basis(daily_rows, basis)
            if fallback_basis is not None and fallback_basis != basis:
                sectors = _build_sector_groups(
                    doc.entries,
                    folder_names=folder_names,
                    folder_orders=folder_orders,
                    daily_rows=daily_rows,
                    basis=fallback_basis,
                )
    except (KeyError, TypeError, ValueError):
        return _cache_put_with_disk(
            cache_key,
            disk_cache_path,
            _unavailable(basis_date, "daily_corpus_invalid"),
        )
    if _all_stocks_missing_basis(sectors):
        return _cache_put_with_disk(
            cache_key,
            disk_cache_path,
            _unavailable(basis_date, "no_basis_bars"),
        )
    response = IndexSectorRankingResponse(
        date=basis_date,
        source="daily_adjusted",
        sectors=_sort_sectors(sectors),
    )
    if not use_cache:
        return response
    return _cache_put_with_disk(cache_key, disk_cache_path, response)
