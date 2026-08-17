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
from hoga.util.atomic_write import atomic_write_text

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
    # v3 (ADR-0112): heatmap folder_id 는 항상 실폴더 — null 미분류 와이어는 폐지.
    folder_id: str
    folder_name: str
    order: int
    close: float | None
    previous_close: float | None
    change_pct: float | None
    missing_reason: MissingReason | None = None


class IndexSectorGroup(BaseModel):
    folder_id: str
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
        # v3 (ADR-0112): folder_id 는 항상 실폴더(load_document 가 dangling 복구) —
        # 이름 결측은 방어적 폴백으로 id 를 그대로 노출(미분류 render-group 은 폐지).
        name = folder_names.get(folder_id, folder_id)
        order = folder_orders.get(folder_id, 1_000_000)
        rows.append((folder_id, name, order, sorted(group_entries, key=lambda e: (e.order, e.code))))
    return sorted(rows, key=lambda row: (row[2], row[1]))


def _load_prev_closes(path: Path, codes: list[str], basis: dt.date) -> dict[str, float]:
    """코드별 **basis 직전 거래일 종가** 하나씩. 필요한 출력이 코드당 1행일 때 쓴다.

    `_load_daily_rows` 는 코드별 **전 이력**을 파이썬 dict 리스트로 물질화한다. 히트맵
    그룹 플로우는 그중 코드당 1행(basis 직전 종가)만 쓰는데, 296종목 × 평균 2,943일 =
    **871,099행**을 만들어 그중 296개를 골랐다. 필요 출력은 종목 수 고정인데 입력은
    코퍼스가 하루 자랄 때마다 296행, 종목을 더할 때마다 ~3,000행씩 는다.

    실측(2026-08-16, 실데이터 133.9MB / 8,692,057행, 실히트맵 296유니크, basis 20260814):

        종전 453 ms (파이썬 dict 871,099행) → 현행 **19 ms** (296행) = **23.6배**
        두 경로의 반환 dict 는 **완전 일치**(296항목).

    60초 폴링 경로라 그 시간 동안 GIL 을 쥔 순수 파이썬 구간이 그대로 이벤트 루프
    지연이 된다 — `--workers` 금지 구조(#998: 프로세스 내 싱글턴)라 단일 루프가
    REST·WS·스케줄러를 전부 처리하기 때문이다. 즉 이건 이 라우트만의 비용이 아니다.

    ⚠ **`close > 0` 검사는 "마지막 행을 고른 뒤"다** — SQL 술어로 앞당기면 안 된다.
    종전 소비처는 basis 직전 마지막 행의 종가가 0 이면 그 종목을 **통째로 제외**했지,
    더 이전의 양수 종가로 폴백하지 않았다. 실코퍼스에 `close <= 0` 행이 실제로 있어
    (2026-08-16 실측 1건) 이건 이론적 차이가 아니다. 순서를 그대로 보존한다.

    `_load_daily_rows` 자체는 건드리지 않는다 — 다른 호출부
    (`build_index_sector_rankings`)는 `_latest_available_basis` 폴백 때문에 넓은 집합이
    필요하다. 시그니처를 바꾸면 그쪽이 조용히 깨진다.
    """
    if not codes:
        return {}
    df = (
        pl.scan_parquet(path)
        .filter(pl.col("code").is_in(codes))
        .filter(pl.col("date") < basis)
        .group_by("code")
        # `sort_by("date").last()` 는 입력 순서에 의존하지 않는다(정렬 후 group_by 의
        # 그룹 내 순서에 기대는 관용구보다 명시적). 실코퍼스에 (code,date) 중복은
        # 0건이라 동률 tie-breaking 은 정의상 발생하지 않는다(2026-08-16 실측).
        .agg(pl.col("close").sort_by("date").last())
        .collect()
    )
    out: dict[str, float] = {}
    for code, close in zip(df["code"].to_list(), df["close"].to_list(), strict=True):
        if close is None:
            continue
        value = float(close)
        if value > 0:
            out[str(code)] = value
    return out


def _load_prev_rows(path: Path, codes: list[str], basis: dt.date) -> dict[str, list[dict]]:
    """코드별 **basis 직전 행 하나씩**. `_load_daily_rows` 와 같은 모양이되 행이 1개다.

    **당일 경로 전용이다.** 그 경로가 `rows` 를 쓰는 곳은 `_stock_from_entry` 의
    `previous_row` 하나뿐이기 때문이다 — 나머지는 전부 닫혀 있다:

    - `basis_row` 는 `intraday_price is not None` 이면 **아예 안 읽는다**(단락).
    - `intraday_price` 가 없으면 그 앞에서 `no_intraday_price` 로 조기 반환해 `rows` 를
      건드리지 않는다.
    - 그래서 `no_basis_bar` 는 당일 경로에서 **도달 불가**이고, `_all_stocks_missing_basis`
      (그 사유만 본다)의 판정도 달라지지 않는다.
    - `_latest_available_basis` 폴백은 `intraday_prices is None` 안에만 있다
      (`build_index_sector_rankings` 의 `if intraday_prices is None and ...`) — 즉 **과거
      날짜 경로 전용**이라 당일에는 넓은 집합이 필요 없다.

    왜 필요한가: 당일 경로는 응답 캐시가 통째로 꺼져 있다(`use_cache = intraday_prices is
    None`). 장중 시세 오버레이가 매 폴링 달라지므로 완성 응답을 캐시하면 시세가 얼어붙어
    **그 결정 자체는 옳다.** 문제는 비싼 부분(일봉 코퍼스)과 변하는 부분(장중 시세)이 같은
    결정에 묶여, 60초마다 코퍼스 전 이력이 파이썬 dict 로 다시 물질화되던 것이다
    (296종목 × 평균 2,943일 = 871,099행).

    실측(2026-08-17, 실데이터 133.9MB / 8,692,057행, 실히트맵 296종목, basis 20260814):

        종전 423 ms (871,099행) → 현행 **23 ms** (296행) = **18.4배**
        소비처가 뽑는 `previous_row` 는 296종목 **전수 일치**(불일치 0건).

    캐시를 손대지 않고 **읽는 양을 줄이는** 쪽을 택했다. 캐시 축을 쪼개면 메모된 dict 를
    호출부가 공유하게 되어 변형·스테일 위험이 새로 생기는데, 이쪽은 그 표면이 없다.

    ⚠ 과거 날짜 경로(`_load_daily_rows`)는 **그대로 둔다** — 폴백이 `basis` 가 아닌 다른
    날짜로 재계산하므로 그때는 넓은 집합이 실제로 필요하다.
    """
    if not codes:
        return {}
    df = (
        pl.scan_parquet(path)
        .filter(pl.col("code").is_in(codes))
        .filter(pl.col("date") < basis)
        .group_by("code")
        # `date.max()` 와 `close.sort_by(date).last()` 는 같은 행을 가리킨다.
        # 종전 소비처가 `reversed(rows)` 로 **마지막 행**을 집던 것과 같은 선택이다.
        .agg(
            pl.col("date").max().alias("date"),
            pl.col("close").sort_by("date").last().alias("close"),
        )
        .collect()
    )
    out: dict[str, list[dict]] = {}
    for code, date, close in zip(
        df["code"].to_list(), df["date"].to_list(), df["close"].to_list(), strict=True,
    ):
        # `close` 가 null 이어도 **그대로 싣는다** — 소비처의 `float(...) == 0` 이
        # TypeError 를 내고 그것이 `daily_corpus_invalid` 로 잡히는 것이 종전 동작이다.
        # 여기서 걸러 내면 그 신호가 조용히 `no_previous_close` 로 바뀐다.
        out[str(code)] = [{"code": str(code), "date": date, "close": close}]
    return out


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
    # 원래도 tmp+replace 였지만 tmp 이름이 고정(``<name>.tmp``)이라 같은 날짜를 동시에
    # 쓰는 두 요청이 서로의 tmp 를 덮을 수 있었고 fsync 도 없었다. 공용 헬퍼는 고유
    # tempfile + fsync 를 쓴다. 실패는 그대로 삼킨다 — 이건 캐시이고, 못 쓰면 다음
    # 요청이 다시 계산하면 된다.
    try:
        atomic_write_text(path, value.model_dump_json())
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
        # 당일(오버레이 있음) 경로는 코드당 1행이면 충분하다 — 근거는 `_load_prev_rows`
        # docstring. 과거 날짜는 `_latest_available_basis` 폴백이 다른 날짜로 재계산하므로
        # 넓은 집합을 그대로 쓴다.
        daily_rows = (
            _load_daily_rows(corpus_path, codes, basis)
            if intraday_prices is None
            else _load_prev_rows(corpus_path, codes, basis)
        )
    except Exception:  # noqa: BLE001 — 코퍼스 parquet 은 외부 산출물이라 스키마·인코딩
        # 어떤 식으로도 깨질 수 있다. 실패를 daily_corpus_invalid 로 응답에 실어 보내므로
        # 위의 screener_daily_corpus_missing 과 같은 층위의 "이유 있는 unavailable" 이다.
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
