from __future__ import annotations

import datetime as dt
import logging
import subprocess
import time
from pathlib import Path

import duckdb
from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json, atomic_write_parquet_df

log = logging.getLogger(__name__)

# parquet 컬럼 dtype 계약. code 는 전 구간 VARCHAR (leading-zero 보존).
_DAILY_COLS = {
    "code": "VARCHAR", "date": "DATE", "open": "DOUBLE", "high": "DOUBLE",
    "low": "DOUBLE", "close": "DOUBLE", "volume": "BIGINT",
}


def seed_daily_from_csv(csv_path: Path, out_path: Path) -> int:
    """CSV(원주가 일봉) → daily_unadjusted.parquet. code VARCHAR 강제, count 반환."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(":memory:")
    csv_s = str(csv_path).replace("'", "''")
    out_s = str(out_path).replace("'", "''")
    con.execute(
        f"COPY (SELECT code, CAST(date AS DATE) date, open, high, low, close, volume "
        f"FROM read_csv('{csv_s}', header=true, types={{'code':'VARCHAR'}})) "
        f"TO '{out_s}' (FORMAT parquet, COMPRESSION zstd)"
    )
    return con.execute(f"SELECT count(*) FROM '{out_s}'").fetchone()[0]


def export_db_to_csv(csv_path: Path, *, container: str = "tradingview-db",
                     db: str = "tradingview", user: str = "tradingview") -> None:
    """docker exec psql \\copy ohlcv_daily → CSV (운영 1회 시드용)."""
    sql = ("\\copy (SELECT code, date, open, high, low, close, volume "
           "FROM ohlcv_daily ORDER BY code, date) TO STDOUT WITH CSV HEADER")
    with csv_path.open("wb") as f:
        subprocess.run(["docker", "exec", container, "psql", "-U", user, "-d", db, "-c", sql],
                       stdout=f, check=True)


def seed_stocks_from_csv(csv_path: Path, out_path: Path) -> int:
    """CSV(code,name,market,is_etf,is_halted) → stocks.parquet. code VARCHAR 강제."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(":memory:")
    csv_s = str(csv_path).replace("'", "''")
    out_s = str(out_path).replace("'", "''")
    con.execute(
        f"COPY (SELECT code, name, market, is_etf, is_halted "
        f"FROM read_csv('{csv_s}', header=true, types={{'code':'VARCHAR'}})) "
        f"TO '{out_s}' (FORMAT parquet, COMPRESSION zstd)"
    )
    return con.execute(f"SELECT count(*) FROM '{out_s}'").fetchone()[0]


def export_stocks_from_db(csv_path: Path, *, container: str = "tradingview-db",
                          db: str = "tradingview", user: str = "tradingview") -> None:
    """docker exec psql \\copy stocks → CSV (운영 1회 시드용)."""
    sql = ("\\copy (SELECT code, name, market, is_etf, is_halted "
           "FROM stocks ORDER BY code) TO STDOUT WITH CSV HEADER")
    with csv_path.open("wb") as f:
        subprocess.run(["docker", "exec", container, "psql", "-U", user, "-d", db, "-c", sql],
                       stdout=f, check=True)


import polars as pl  # noqa: E402 — appended after stdlib imports

# 깨끗한 분할 비율(신주/구주) 후보 + 역수. ratio = close[d]/close[d-1].
_SPLIT_RATIOS = [1/2, 1/3, 1/4, 1/5, 1/10, 1/20, 1/50, 2, 3, 4, 5, 10]
_SPLIT_TOL = 0.03  # ±3%


def _detect_factor(ratio: float) -> float | None:
    """ratio 가 깨끗한 분할 비율에 가까우면 그 비율, 아니면 None."""
    for r in _SPLIT_RATIOS:
        if abs(ratio - r) / r <= _SPLIT_TOL:
            return r
    return None


def adjust_splits(df: pl.DataFrame) -> pl.DataFrame:
    """원주가 일봉 → 수정주가(최신일 basis). per-code back-adjust."""
    out = []
    for (code,), g in df.sort("date").group_by(["code"], maintain_order=True):
        g = g.sort("date")
        closes = g["close"].to_list()
        n = len(closes)
        factor = [1.0] * n              # 각 날 d 의 누적계수(d 이후 분할 비율 곱). 최신일=1.
        cum = 1.0
        for d in range(n - 1, 0, -1):
            ratio = closes[d] / closes[d - 1] if closes[d - 1] else 1.0
            split = _detect_factor(ratio)
            if split is not None:
                cum *= split            # d 에 split → d 이전에 split 곱
            factor[d - 1] = cum
        f = pl.Series("f", factor)
        adj = g.with_columns([
            (pl.col(c) * f).alias(c) for c in ("open", "high", "low", "close")
        ]).with_columns((pl.col("volume") / f).round(0).cast(pl.Int64).alias("volume"))
        out.append(adj)
    return pl.concat(out)


def derive_adjusted(unadjusted_path: Path, out_path: Path) -> int:
    """원주가 parquet → 수정주가 parquet. 소요 ms 반환."""
    t0 = time.perf_counter()
    df = pl.read_parquet(unadjusted_path)
    # run_scan 가 읽는 파생본 — 중도 종료가 손상본을 노출하면 모든 스캔이 깨지므로 원자적.
    atomic_write_parquet_df(out_path, adjust_splits(df))
    return int((time.perf_counter() - t0) * 1000)


from hoga.api.models import ScreenerStatusFile  # noqa: E402


def last_raw_date(unadjusted_path: Path) -> str | None:
    """아카이브 최신 거래일(YYYYMMDD) 또는 None(파일 없음)."""
    if not unadjusted_path.exists():
        return None
    r = duckdb.connect(":memory:").execute(
        f"SELECT max(date) FROM '{unadjusted_path}'").fetchone()[0]
    return r.strftime("%Y%m%d") if r else None


def append_rows(unadjusted_path: Path, new: pl.DataFrame) -> None:
    """원주가 신규 거래일 append. (code,date) 멱등(중복 트리거 안전), 정렬 유지.
    무백업 SSOT 이므로 원자적 기록(tempfile→os.replace) — 중도 종료가 부분/손상
    parquet 를 readers 에게 노출하지 않는다."""
    base = pl.read_parquet(unadjusted_path)
    merged = pl.concat([base, new.select(base.columns)]).unique(
        subset=["code", "date"], keep="last").sort(["code", "date"])
    atomic_write_parquet_df(unadjusted_path, merged)


def write_status(path: Path, *, last_raw_date: str | None, universe_size: int,
                 derive_ms: int, now_ms: int) -> None:
    # 원자적 기록(saves.json 과 동일 계약) — 중도 종료가 잘린 status.json 을 남기지
    # 않는다. last_raw_date 는 None 허용(빈/NULL-date 아카이브에서도 안 죽고 표현).
    atomic_write_json(path, ScreenerStatusFile(
        schema_version=1, last_raw_date=last_raw_date, last_built_ms=now_ms,
        universe_size=universe_size, derive_ms=derive_ms).model_dump(mode="json"))


def _quarantine_status(path: Path) -> None:
    """손상/잘린 status.json 격리(saves.json _quarantine 과 동일 계약). 실패는 로깅만."""
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    try:
        path.rename(path.with_name(f"{path.name}.corrupt-{stamp}"))
        log.warning("screener status.json unusable; backed up to %s.corrupt-%s",
                    path.name, stamp)
    except OSError:
        log.exception("could not back up corrupt status.json")


def read_status(path: Path) -> ScreenerStatusFile | None:
    if not path.exists():
        return None
    try:
        return ScreenerStatusFile.model_validate_json(path.read_text())
    except ValidationError:
        # 부분쓰기/수동편집으로 손상된 status.json → 격리 후 None(not_seeded)으로 강등.
        # /status 가 500 대신 not_seeded 를 돌려주고, 다음 update/seed 가 재생성한다.
        _quarantine_status(path)
        return None


def seed_all(data_dir: Path, *, now_ms: int) -> int:
    """운영 1회 시드: dev-tradingview DB → screener/ parquet 전체 빌드. 종목 수 반환.
    daily + stocks export(CSV) → seed parquet(VARCHAR code) → derive 수정주가 → status."""
    sdir = data_dir / "screener"
    sdir.mkdir(parents=True, exist_ok=True)
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        export_db_to_csv(td / "daily.csv")
        seed_daily_from_csv(td / "daily.csv", sdir / "daily_unadjusted.parquet")
        export_stocks_from_db(td / "stocks.csv")
        seed_stocks_from_csv(td / "stocks.csv", sdir / "stocks.parquet")
    ms = derive_adjusted(sdir / "daily_unadjusted.parquet", sdir / "daily_adjusted.parquet")
    n = pl.read_parquet(sdir / "stocks.parquet").height
    write_status(sdir / "status.json",
                 last_raw_date=last_raw_date(sdir / "daily_unadjusted.parquet"),
                 universe_size=n, derive_ms=ms, now_ms=now_ms)
    return n


import asyncio  # noqa: E402 — appended orchestration block
from collections.abc import Awaitable, Callable  # noqa: E402

FetchOne = Callable[[str, str, str], Awaitable[list[dict]]]


async def run_update(sdir: Path, *, codes: list[str], fetch_one: FetchOne,
                     trading_days: list[str], now_ms: int) -> int:
    """gap 거래일 행을 await fetch_one 으로 모아 append→derive→status. 추가 거래일 수 반환."""
    rows: list[dict] = []
    for code in codes:
        rows += await fetch_one(code, trading_days[0], trading_days[-1])
    if not rows:
        return 0
    up = sdir / "daily_unadjusted.parquet"

    def _commit() -> int:                  # 동기 polars는 to_thread로 (루프 블로킹 방지)
        append_rows(up, pl.DataFrame(rows))
        ms = derive_adjusted(up, sdir / "daily_adjusted.parquet")
        n = pl.read_parquet(up).select(pl.col("code").n_unique()).item()
        write_status(sdir / "status.json", last_raw_date=last_raw_date(up),
                     universe_size=n, derive_ms=ms, now_ms=now_ms)
        return ms

    await asyncio.to_thread(_commit)
    return len(trading_days)
