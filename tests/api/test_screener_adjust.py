import polars as pl
from hoga.api.screener_store import adjust_splits


def test_5to1_split_backadjusts_history():
    df = pl.DataFrame({
        "code": ["A"] * 3,
        "date": ["2021-04-13", "2021-04-14", "2021-04-15"],
        "open": [500.0, 500.0, 100.0], "high": [510.0, 510.0, 102.0],
        "low": [495.0, 495.0, 99.0], "close": [500.0, 500.0, 100.0],
        "volume": [1000, 1000, 5000],
    }).with_columns(pl.col("date").str.to_date())
    out = adjust_splits(df).sort("date")
    closes = out["close"].to_list()
    assert abs(closes[0] - 100.0) < 1.0   # 분할 전이 1/5로 내려와 연속
    assert abs(closes[2] - 100.0) < 1.0   # 마지막은 그대로
    assert out.sort("date")["volume"].to_list()[0] == 5000  # 거래량 5배로 연속


def test_split_adjust_is_order_independent():
    # #H4: 전역 date 정렬 + group_by(maintain_order) 로 각 그룹이 date 오름차순이 되므로
    # group 별 재정렬은 불요 — 셔플 입력이 정렬 입력과 동일 결과여야 그 제거가 안전.
    rows = {
        "code": ["A", "A", "A"],
        "date": ["2021-04-13", "2021-04-14", "2021-04-15"],
        "open": [500.0, 500.0, 100.0], "high": [510.0, 510.0, 102.0],
        "low": [495.0, 495.0, 99.0], "close": [500.0, 500.0, 100.0],
        "volume": [1000, 1000, 5000],
    }
    ordered = pl.DataFrame(rows).with_columns(pl.col("date").str.to_date())
    shuffled = ordered[[2, 0, 1]]   # 입력 행 순서를 섞음
    assert (adjust_splits(ordered).sort("date")["close"].to_list()
            == adjust_splits(shuffled).sort("date")["close"].to_list())


def test_no_split_is_identity():
    df = pl.DataFrame({
        "code": ["B"] * 2, "date": ["2026-05-13", "2026-05-14"],
        "open": [300.0, 305.0], "high": [310.0, 312.0],
        "low": [298.0, 303.0], "close": [305.0, 310.0], "volume": [100, 120],
    }).with_columns(pl.col("date").str.to_date())
    out = adjust_splits(df).sort("date")
    assert out["close"].to_list() == [305.0, 310.0]
