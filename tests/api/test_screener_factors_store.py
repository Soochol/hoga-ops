from __future__ import annotations

import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_factors import (
    FactorSegment, read_factors, segments_to_frame, write_factors,
)


def test_write_then_read_roundtrip(tmp_path: Path):
    by_code = {
        "005930": [FactorSegment(dt.date(2018, 4, 20), 0.02),
                   FactorSegment(dt.date(2018, 5, 4), 1.0)],
        "000660": [FactorSegment(dt.date(2015, 1, 2), 1.0)],
    }
    df = segments_to_frame(by_code)
    p = tmp_path / "factors.parquet"
    write_factors(df, p)
    out = read_factors(p)
    assert out is not None
    assert out.columns == ["code", "seg_start", "factor"]
    assert out.filter(pl.col("code") == "005930").height == 2
    assert out.schema["code"] == pl.Utf8
    assert out.schema["seg_start"] == pl.Date


def test_read_missing_returns_none(tmp_path: Path):
    assert read_factors(tmp_path / "nope.parquet") is None


def test_read_corrupt_quarantines_and_returns_none(tmp_path: Path):
    p = tmp_path / "factors.parquet"
    p.write_text("not a parquet file")
    assert read_factors(p) is None
    # 손상본은 격리되어 원래 경로엔 없어야 함
    assert not p.exists()
    assert list(tmp_path.glob("factors.parquet.corrupt*"))


def test_read_wrong_schema_quarantines_and_returns_none(tmp_path: Path):
    """읽기는 성공하지만 스키마 불일치(seg_start 누락) → 격리 후 None 반환.

    부분/버그 프로듀서가 만든 parquet 이 apply_factors 를 통해 ColumnNotFoundError를
    일으키지 않도록 read_factors 단계에서 차단 (Fix #3).
    """
    p = tmp_path / "factors.parquet"
    # seg_start 없는 구조적으로 유효한 parquet
    pl.DataFrame({"code": ["005930"], "factor": [0.02]}).write_parquet(p)
    result = read_factors(p)
    assert result is None
    # 원래 경로엔 없어야 하고, 격리본이 남아야 함
    assert not p.exists()
    assert list(tmp_path.glob("factors.parquet.corrupt*"))
