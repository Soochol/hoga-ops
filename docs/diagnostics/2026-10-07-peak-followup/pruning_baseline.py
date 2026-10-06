"""Frozen unrestricted pruning helpers used before the small-frame follow-up."""
import polars as pl

from hoga.tables.snapshots import _PEAK_RANK_BY, _PEAK_RANK_DESC


def _peak_bucket_dedup(df: pl.DataFrame) -> pl.DataFrame:
    """Best per (price, bucket_id) — mirrors ``{side}_all_peak_candidates`` price_rn=1."""
    # Lower quantities cannot win a group. Keep every maximum-quantity tie so
    # the existing time/sequence/price ranking still chooses the same row.
    return df.lazy().filter(pl.col("qty") == pl.col("qty").max().over(["price", "bucket_id"])).sort(
        _PEAK_RANK_BY, descending=_PEAK_RANK_DESC,
    ).unique(
        subset=["price", "bucket_id"], keep="first", maintain_order=True,
    ).collect()


def _peak_price_distinct(classified: pl.DataFrame) -> pl.DataFrame:
    """가격당 rank-1 — `_peak_touched_distinct` 의 터치 필터 없는 판(미도달 top-3 용)."""
    # Prune before sorting, with the same tie policy as _peak_bucket_dedup.
    return classified.lazy().filter(pl.col("qty") == pl.col("qty").max().over("price")).sort(
        _PEAK_RANK_BY, descending=_PEAK_RANK_DESC,
    ).unique(
        subset=["price"], keep="first", maintain_order=True,
    ).collect()


def _peak_touched_distinct(classified: pl.DataFrame) -> pl.DataFrame:
    """터치된 이벤트만 남기고 **가격당 rank-1** — 같은 가격이 top-N 슬롯을 독식하지
    않게 한다.

    ADR-0084 시절의 per-(price, lifecycle) 중간 dedup 은 대응물이 없다: lifecycle 은
    "지배 터치 사이의 구간" 이라는 전역 시간 관계였고, ADR-0156 의 판정은 분 안에서
    닫힌다. 가격당 rank-1 로 직접 붕괴한다."""
    # Maxima must be computed AFTER filtering touches; an untouched larger
    # wall must not displace the best touched candidate at the same price.
    return classified.lazy().filter(pl.col("touched")).filter(
        pl.col("qty") == pl.col("qty").max().over("price"),
    ).sort(_PEAK_RANK_BY, descending=_PEAK_RANK_DESC).unique(
        subset=["price"], keep="first", maintain_order=True,
    ).collect()
