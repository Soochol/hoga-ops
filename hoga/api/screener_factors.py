"""수정주가 보정 계수(factor store). factor = adj_close / raw_close.

계수는 코퍼레이트 액션 때만 바뀌는 계단 함수 — 종목당 변곡점(seg_start, factor) 몇 개로
전 역사를 표현. 수정주가 = 원주가 × 계수 (ADR-0057).
"""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from hoga.api._atomic_write import atomic_write_parquet_df


@dataclass(frozen=True)
class FactorSegment:
    seg_start: dt.date
    factor: float


def compute_factor_segments(
    rows: list[tuple[dt.date, float, float]], *, tol: float = 1e-4
) -> list[FactorSegment]:
    """rows: (date, raw_close, adj_close) — date ASC 정렬 가정.

    factor=adj/raw 를 run-length로 압축: factor가 직전 대비 tol(상대) 넘게 바뀌면 새 세그먼트.
    raw_close==0(불량/결측)은 스킵(직전 세그먼트 유지). 첫 유효행이 첫 세그먼트(seg_start=그 날짜).
    """
    segments: list[FactorSegment] = []
    prev: float | None = None
    for d, raw_c, adj_c in rows:
        if raw_c == 0:
            continue
        f = adj_c / raw_c
        if prev is None or abs(f - prev) / prev > tol:
            segments.append(FactorSegment(d, f))
            # prev = 세그먼트-오픈 factor — sub-threshold 누적 변동엔 새 세그먼트를 안 만든다(안정성)
            prev = f
    return segments


log = logging.getLogger(__name__)

FACTOR_SCHEMA = {
    "code": pl.Utf8, "seg_start": pl.Date, "factor": pl.Float64,
}


def segments_to_frame(by_code: dict[str, list[FactorSegment]]) -> pl.DataFrame:
    """{code: [FactorSegment,...]} → factors DataFrame (code,seg_start,factor). 정렬은 write_factors가 담당."""
    rows = [
        {"code": code, "seg_start": s.seg_start, "factor": s.factor}
        for code, segs in by_code.items() for s in segs
    ]
    return pl.DataFrame(rows, schema=FACTOR_SCHEMA)


def write_factors(df: pl.DataFrame, path: Path) -> None:
    """factors.parquet 원자적 기록(SSOT 계약 — 토막 노출 금지). 컬럼 순서·정렬을 쓰기 경계에서 강제."""
    atomic_write_parquet_df(path, df.select(list(FACTOR_SCHEMA)).sort(["code", "seg_start"]))


def _quarantine(path: Path) -> None:
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    target = path.with_name(f"{path.name}.corrupt-{stamp}")
    try:
        path.rename(target)
        log.warning("factors.parquet unusable; quarantined to %s", target.name)
    except OSError:
        log.exception("could not quarantine corrupt factors.parquet")


def read_factors(path: Path) -> pl.DataFrame | None:
    """factors.parquet 로드. 없으면 None. 손상이면 격리 후 None(폴백 유도)."""
    if not path.exists():
        return None
    try:
        return pl.read_parquet(path)
    except Exception:  # noqa: BLE001 — 손상 parquet은 어떤 예외든 폴백으로 강등
        _quarantine(path)
        return None
