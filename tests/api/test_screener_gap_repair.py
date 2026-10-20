"""A vendor correction must not turn a gap repair into an implicit overwrite."""
import datetime as dt

import polars as pl
import pytest

from hoga.api.screener_history_storage import commit_verified, commit_verified_gaps
from hoga.api.screener_store import _DAILY_PL_SCHEMA


def frame(volumes):
    return pl.DataFrame([
        dict(code="0220W0", date=dt.date(2026, 9, day), open=100., high=100.,
             low=100., close=100., volume=volume)
        for day, volume in volumes
    ], schema=_DAILY_PL_SCHEMA)


def test_gaps_preserve_existing_observations_and_adjustments(tmp_path):
    stored = frame([(16, 100), (17, 200)])
    commit_verified(tmp_path, [(stored, stored)])
    vendor = frame([(14, 90), (15, 80), (16, 101), (17, 202)])
    # Normal collection continues to reject disagreement on existing dates.
    rejected = commit_verified(tmp_path, [(vendor, vendor)])
    assert rejected.errors == {"0220W0": "adjusted_volume_mismatch"}

    result = commit_verified_gaps(tmp_path, [(vendor, vendor)])

    assert not result.errors and result.written_rows == 2
    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet"):
        actual = pl.read_parquet(tmp_path / "screener" / name).sort("date")
        assert actual["volume"].to_list() == [90, 80, 100, 200]
    assert commit_verified_gaps(tmp_path, [(vendor, vendor)]).written_rows == 0


@pytest.mark.parametrize("problem", ["factor_change", "invalid_vendor_pair", "truncated_history"])
def test_unsafe_gap_repairs_leave_all_files_unchanged(tmp_path, problem):
    stored = frame([(16, 100), (17, 200)])
    commit_verified(tmp_path, [(stored, stored)])
    sdir = tmp_path / "screener"
    before = {p.name: p.read_bytes() for p in sdir.glob("*.parquet")}
    raw = frame([(14, 90), (15, 80), (16, 100), (17, 200)])
    adjusted = raw
    if problem == "factor_change":
        adjusted = raw.with_columns(
            [pl.col(c) * .5 for c in ("open", "high", "low", "close")]
            + [(pl.col("volume") * 2).alias("volume")])
    elif problem == "invalid_vendor_pair":
        adjusted = raw.with_columns((pl.col("volume") + 1).alias("volume"))
    else:
        raw = adjusted = raw.filter(pl.col("date") < dt.date(2026, 9, 17))

    result = commit_verified_gaps(tmp_path, [(raw, adjusted)])

    assert result.errors and result.written_rows == 0
    assert {p.name: p.read_bytes() for p in sdir.glob("*.parquet")} == before
