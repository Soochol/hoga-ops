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
    raw/adj 둘 중 하나라도 0(불량/결측)이면 스킵(직전 세그먼트 유지) — adj==0 은 factor==0 을
    만들어 apply_factors 의 volume/factor 0나눗셈을 유발하므로 명시 가드. 첫 유효행이 첫 세그먼트.
    """
    segments: list[FactorSegment] = []
    prev: float | None = None
    for d, raw_c, adj_c in rows:
        if raw_c == 0 or adj_c == 0:
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
    """factors.parquet 로드. 없으면 None. 손상이면 격리 후 None(폴백 유도).

    읽기 성공 후에도 FACTOR_SCHEMA 필수 컬럼이 빠져 있으면 격리(부분/버그 프로듀서 방어).
    """
    if not path.exists():
        return None
    try:
        df = pl.read_parquet(path)
    except Exception:  # noqa: BLE001 — 손상 parquet은 어떤 예외든 폴백으로 강등
        _quarantine(path)
        return None
    if not (set(FACTOR_SCHEMA) <= set(df.columns)):
        _quarantine(path)
        return None
    return df


_PRICE_COLS = ("open", "high", "low", "close")


def apply_factors(unadjusted: pl.DataFrame, factors: pl.DataFrame) -> pl.DataFrame:
    """원주가 × 계수 → 수정주가. backward ASOF(code별, date >= seg_start).

    가격 ×factor, 거래량 ÷factor (거래대금 보존). 가장 오래된 seg_start 이전 날짜(계수 null)는
    그 종목의 최古 factor로 채움(extend backward). 반환은 입력과 동일한 7개 기본 컬럼.

    전제: (1) unadjusted의 각 code는 factors에 최소 1개 세그먼트가 있어야 한다(없으면 null→오염;
    derive_adjusted가 미커버 종목을 adjust_splits로 분리). (2) factor > 0 — compute_factor_segments가
    raw/adj==0 행을 스킵해 보장.
    """
    # join_asof 전제: 양 프레임을 asof 키(date/seg_start)로 by-그룹 내 정렬
    u = unadjusted.sort(["code", "date"])
    f = factors.select(["code", "seg_start", "factor"]).sort(["code", "seg_start"])
    joined = u.join_asof(f, left_on="date", right_on="seg_start", by="code", strategy="backward")
    joined = joined.with_columns(
        pl.col("factor").fill_null(strategy="backward").over("code")
    )
    # 전 행이 earliest seg_start 이전이면 fill_null(backward).over("code") 도 anchor 없음
    # → factor 여전히 null. 코드의 最古 factor 로 채워 extend-backward 계약을 완성한다.
    if joined["factor"].null_count():
        earliest = (
            f.group_by("code", maintain_order=False)
            .agg(pl.col("factor").sort_by("seg_start").first().alias("_ef"))
        )
        joined = (
            joined.join(earliest, on="code", how="left")
            .with_columns(pl.col("factor").fill_null(pl.col("_ef")))
            .drop("_ef")
        )
    return joined.with_columns(
        [(pl.col(c) * pl.col("factor")).alias(c) for c in _PRICE_COLS]
        + [(pl.col("volume") / pl.col("factor")).round(0).cast(pl.Int64).alias("volume")]
    ).select(["code", "date", *_PRICE_COLS, "volume"])


def pair_raw_adj(
    raw_close: list[tuple[dt.date, float]],
    adj_close: list[tuple[dt.date, float]],
) -> list[tuple[dt.date, float, float]]:
    """원주가·수정주가 종가를 날짜로 inner-join → compute_factor_segments 입력.

    양쪽에 모두 있는 날짜만, date ASC 정렬해 (date, raw_close, adj_close) 로 반환.
    KIS 수정주가가 원주가만큼 과거로 안 닿는 날짜는 자연히 제외(그 깊은 구간은
    apply_factors 의 extend-backward 가 최古 계수로 채운다, ADR-0057).
    """
    adj_by = dict(adj_close)
    return [
        (d, rc, adj_by[d]) for d, rc in sorted(raw_close) if d in adj_by
    ]
