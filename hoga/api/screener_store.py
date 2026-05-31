from __future__ import annotations
from pathlib import Path
import duckdb
import subprocess
import time

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
        ]).with_columns((pl.col("volume") / f).cast(pl.Int64).alias("volume"))
        out.append(adj)
    return pl.concat(out)


def derive_adjusted(unadjusted_path: Path, out_path: Path) -> int:
    """원주가 parquet → 수정주가 parquet. 소요 ms 반환."""
    t0 = time.perf_counter()
    df = pl.read_parquet(unadjusted_path)
    adjust_splits(df).write_parquet(out_path, compression="zstd")
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
    """원주가 신규 거래일 append. (code,date) 멱등(중복 트리거 안전), 정렬 유지."""
    base = pl.read_parquet(unadjusted_path)
    pl.concat([base, new.select(base.columns)]).unique(
        subset=["code", "date"], keep="last").sort(["code", "date"]).write_parquet(
        unadjusted_path, compression="zstd")


def write_status(path: Path, *, last_raw_date: str, universe_size: int,
                 derive_ms: int, now_ms: int) -> None:
    path.write_text(ScreenerStatusFile(
        schema_version=1, last_raw_date=last_raw_date, last_built_ms=now_ms,
        universe_size=universe_size, derive_ms=derive_ms).model_dump_json())


def read_status(path: Path) -> ScreenerStatusFile | None:
    if not path.exists():
        return None
    return ScreenerStatusFile.model_validate_json(path.read_text())
