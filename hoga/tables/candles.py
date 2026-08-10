"""Candles table — 1-minute OHLCV bars parsed from chart.tsv.

Unlike the other table modules, Candles does not register with the first.tsv
dispatcher. Its rows come from a separate endpoint (chart.php) which the
collector saves to chart.tsv. The parser orchestrator calls ``parse_row`` here
directly.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

from hoga.tables.dispatch import FieldCountError, split_row
from hoga.util.atomic_write import atomic_write_parquet_table

CANDLE_MIN_FIELDS = 8

# 9번째 컬럼(0-based 8) = 단일가(동시호가) 체결량. `CANDLE_MIN_FIELDS` 를 9 로
# 올리지 않는 이유는 아래 parse_row docstring 참조.
_AUCTION_VOL_FIELD = 8


# === In-memory entity ===


@dataclass(frozen=True)
class Candle:
    ts_ms: int
    open_: int
    close_: int
    high: int
    low: int
    vol_a: int
    vol_b: int


# === Parser ===


def parse_row(line: str) -> Candle:
    """Parse one chart.tsv row into a Candle.

    chart.tsv columns: relative_ts_ms, HH:MM:SS, open, close, high, low,
    vol_a, vol_b, **auction_vol**, cum_a, cum_b.

    ## 9번째 컬럼은 단일가(동시호가) 체결량이다 — vol_a 에 폴드한다 (#1278)

    이 컬럼은 오래 ``[unknown]`` 으로 적혀 **버려지고 있었다**. 그래서
    ``vol_a + vol_b`` 는 정규장 **연속체결만** 담았고, 시가단일가(09:00)·
    종가단일가(15:30) 체결이 통째로 빠졌다 — 일봉 대비 중앙값 **-5%**,
    p75 -11%, 최대 **-64%**(raw 1,525 파일 실측, 2026-08-10).

    **지문**: ``15:30`` 봉이 ``vol_a=0 vol_b=0`` 인데 **가격은 정상**이다 —
    그 봉의 ``close`` 가 벤더 일봉 종가와 정확히 일치한다(44/44 확인). 단일가
    체결의 가격은 이미 맞게 들어와 있고 **수량만** 버려지고 있었다.

    폴드 후 ``vol_a + vol_b`` 는 벤더 일봉 거래량과 0.5% 이내로 맞는다
    (20260716 24종목 중 23건, 9건은 정확히 일치). 남는 잔차는 chart.php 를
    15:31 까지만 받아 생기는 **장후 시간외**(-0.0~0.3%)다.

    ## 왜 별도 컬럼이 아니라 폴드인가

    ``vol_a``/``vol_b`` 를 **따로 소비하는 곳이 없다** — 백엔드·프론트 전부
    ``vol_a + vol_b`` 로만 읽는다(2026-08-10 grep 확인). 그리고 ``promote.py``
    가 이미 "단일 거래량 채널은 vol_a 에" 관례를 갖고 있다. 세 번째 컬럼을
    만들면 parquet 스키마가 구/신으로 갈려 ``queries.py`` 의 배치
    ``read_parquet([paths])`` 가 혼재 시 깨지고, 합산 사이트를 하나라도
    놓치면 **바로 이 버그와 같은 계급의 조용한 과소계상**이 재발한다.

    ⚠ ``vol_a``/``vol_b`` 가 매수/매도 체결 구분이라면(**미검증 추론**) 이
    폴드는 그 비율을 단일가 체결량만큼 왜곡한다. 그 구분을 실제로 쓰는
    소비처가 생기면 **별도 컬럼으로 승격**할 것 — 원자료는 소실되지 않는다.
    hogaplay ``chart.php`` 는 과거일을 그대로 재서빙한다(20250324 를 17개월 뒤
    재요청해 저장본과 바이트 동일, 20250613 은 raw 가 프룬된 날인데도 정상 수신).

    ## 필드 수 계약

    ``CANDLE_MIN_FIELDS`` 는 **8 로 유지**한다. 이 컬럼은 실측상 항상 있지만
    (raw 전수 335,379 행이 전부 11 필드), 하한을 9 로 올리면 8 필드 행이
    ``FieldCountError`` 로 죽는다 — 없던 행을 새로 거부하는 것은 이 수정의
    범위가 아니다. 없으면 0 으로 읽는다.
    """
    parts = split_row(line)
    if len(parts) < CANDLE_MIN_FIELDS:
        raise FieldCountError(f"candle row expects >={CANDLE_MIN_FIELDS} fields, got {len(parts)}")
    auction_vol = int(parts[_AUCTION_VOL_FIELD]) if len(parts) > _AUCTION_VOL_FIELD else 0
    return Candle(
        ts_ms=int(parts[0]),
        open_=int(parts[2]),
        close_=int(parts[3]),
        high=int(parts[4]),
        low=int(parts[5]),
        vol_a=int(parts[6]) + auction_vol,
        vol_b=int(parts[7]),
    )


# === Wire schema ===


PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),
        pa.field("open", pa.int32()),
        pa.field("close", pa.int32()),
        pa.field("high", pa.int32()),
        pa.field("low", pa.int32()),
        pa.field("vol_a", pa.int32()),
        pa.field("vol_b", pa.int32()),
    ]
)


# === Persist ===


def write_parquet(candles: Iterable[Candle], path: Path) -> None:
    rows = sorted(candles, key=lambda c: c.ts_ms)
    cols = {
        "ts_ms": pa.array([c.ts_ms for c in rows], type=pa.int64()),
        "open": pa.array([c.open_ for c in rows], type=pa.int32()),
        "close": pa.array([c.close_ for c in rows], type=pa.int32()),
        "high": pa.array([c.high for c in rows], type=pa.int32()),
        "low": pa.array([c.low for c in rows], type=pa.int32()),
        "vol_a": pa.array([c.vol_a for c in rows], type=pa.int32()),
        "vol_b": pa.array([c.vol_b for c in rows], type=pa.int32()),
    }
    atomic_write_parquet_table(path, pa.table(cols, schema=PARQUET_SCHEMA))


def read_parquet(path: Path) -> list[Candle]:
    """Symmetric inverse of :func:`write_parquet` — reassemble ``Candle``
    rows from the parquet table.

    Load-bearing column remap: the on-disk columns are ``open`` / ``close``
    (the natural OHLCV names, see ``PARQUET_SCHEMA``) but the ``Candle``
    dataclass fields are ``open_`` / ``close_`` (``open`` shadows the builtin).
    A naive ``Candle(**row)`` therefore raises ``unexpected keyword argument
    'open'`` — which silently degraded ``hoga validate --deep`` (candles never
    loaded, so ``series.candles_ts_monotonic`` was never evaluated) and made
    ``--deep --fix`` actively dangerous (a recompute that skips the candle
    check would CLEAR archived ``candles_ts_monotonic`` errors, re-including
    chart-crashing Stock-Dates). Lives here (not in ``cli.py``'s
    ``_run_series_for``) for the same reason as ``snapshots.read_parquet``:
    reading is the inverse of writing, so the write↔read round-trip stays the
    single test surface for the schema and cannot drift.
    """
    rows = pq.read_table(path).to_pylist()
    return [
        Candle(
            ts_ms=r["ts_ms"], open_=r["open"], close_=r["close"],
            high=r["high"], low=r["low"], vol_a=r["vol_a"], vol_b=r["vol_b"],
        )
        for r in rows
    ]


# === API representation ===


class ApiCandle(BaseModel):
    ts_ms: int
    open: int
    close: int
    high: int
    low: int
    vol_a: int
    vol_b: int


# === Query (returns list[ApiCandle] directly) ===


def query_all(
    con: duckdb.DuckDBPyConnection, *, path: Path, ts_offset_ms: int
) -> list[ApiCandle]:
    """파케이의 ms-from-KST-midnight `ts_ms` 를 **SQL 에서** 이동시켜 읽는다.

    ``ts_offset_ms`` 는 보통 그 Stock-Date 의 자정 Unix ms —
    ``ms_from_midnight_to_unix_ms(date, 0)`` 로 구한다. 오프셋의 정의는 그 함수
    하나에만 두고, 여기서는 받은 값을 더하기만 한다.

    ⚠ **키워드 필수이고 기본값이 없다.** 기본 0 을 주면 호출자가 빠뜨렸을 때 조용히
    자정 기준 ms 가 그대로 나가고, 그건 wire 상 Unix ms 와 구별되지 않는 **1970년대
    타임스탬프**다 — venue 기본값이 만들던 것과 같은 종류의 조용한 오답이다
    (`queries.parquet_dir` 주석 참조). 필수면 누락이 런타임 오답이 아니라 타입 에러다.

    왜 SQL 인가: 호출부가 파이썬에서 `model_copy(update={"ts_ms": ...})` 로 보정하면
    같은 행을 **두 벌** 물질화한다. 5개월치 1분봉이면 36,276개를 만들고 다시 36,276개다.
    실측상 이 경로 시간의 38.7% 가 그 두 번째 벌이었다(`build_candles_slice` 분해).
    """
    rows = con.execute(
        'SELECT ts_ms + ? AS ts_ms, "open", "close", high, low, vol_a, vol_b '
        # ORDER BY 는 **테이블 컬럼**을 가리킨다. 오프셋은 상수라 순서를 바꾸지
        # 않으므로 둘 중 무엇으로 정렬하든 결과가 같지만, 별칭을 달아 투영과
        # 정렬이 모호하게 묶이지 않게 한다.
        "FROM read_parquet(?) ORDER BY ts_ms ASC",
        [ts_offset_ms, str(path)],
    ).fetchall()
    return [
        ApiCandle(ts_ms=r[0], open=r[1], close=r[2], high=r[3], low=r[4], vol_a=r[5], vol_b=r[6])
        for r in rows
    ]


def query_price_range(con: duckdb.DuckDBPyConnection, *, path: Path) -> tuple[int, int] | None:
    """Return ``(MIN(low), MAX(high))`` across the candles, or ``None`` if the
    table is empty (NULL aggregates).

    This owns the ``low`` / ``high`` candle-column knowledge (ADR-0001) so
    callers that need a price grid — e.g. the range bundle's volume-profile
    slice — get the spread without re-deriving the schema. Mirrors
    ``snapshots.query_time_bounds``'s ``tuple | None`` shape.
    """
    row = con.execute(
        "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [str(path)]
    ).fetchone()
    if row is None or row[0] is None or row[1] is None:
        return None
    return int(row[0]), int(row[1])
