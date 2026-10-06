"""Pruning must preserve the previous full-sort winners, including all ties."""
from __future__ import annotations

import random

import polars as pl
import pytest
from polars.testing import assert_frame_equal

from hoga.tables import snapshots as s


@pytest.mark.parametrize("seed", range(12))
@pytest.mark.parametrize("size", [1500, 4095, 4096, 4097])
@pytest.mark.parametrize("kind", ["bucket", "price", "touched"])
def test_pruned_candidates_match_full_sort(seed: int, size: int, kind: str) -> None:
    rng = random.Random(seed)
    rows = [
        {
            "price": rng.randrange(10, 30),
            "qty": rng.randrange(1, 8),
            "intra_ms": rng.randrange(0, 20) * 60_000,
            "seq": i,
            "touched": rng.choice([True, False]),
        }
        for i in range(size)
    ]
    df = pl.DataFrame(rows).with_columns((pl.col("intra_ms") // 60_000).alias("bucket_id"))
    source = df.filter(pl.col("touched")) if kind == "touched" else df
    keys = ["price", "bucket_id"] if kind == "bucket" else ["price"]
    expected = source.sort(
        ["qty", "intra_ms", "seq", "price"], descending=[True, False, False, False],
    ).unique(subset=keys, keep="first", maintain_order=True)
    function = {
        "bucket": s._peak_bucket_dedup,
        "price": s._peak_price_distinct,
        "touched": s._peak_touched_distinct,
    }[kind]
    assert_frame_equal(function(df), expected)


@pytest.mark.parametrize("size", [0, 1, 4096])
def test_pruned_touched_candidates_handle_no_candidates(size: int) -> None:
    frame = pl.DataFrame(
        [(100, 5, 60_000, 1, 1, False)] * size,
        schema={"price": pl.Int64, "qty": pl.Int64, "intra_ms": pl.Int64,
                "seq": pl.Int64, "bucket_id": pl.Int64, "touched": pl.Boolean},
        orient="row",
    )
    assert s._peak_touched_distinct(frame).height == 0
    if size == 0:
        assert_frame_equal(s._peak_bucket_dedup(frame), frame)
        assert_frame_equal(s._peak_price_distinct(frame), frame)
