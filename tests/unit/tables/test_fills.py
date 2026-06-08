from pathlib import Path

import duckdb

from hoga.tables.fills import Fill, query_fill_strength, write_fills_parquet


def test_roundtrip_and_bucket_reaggregation(tmp_path: Path):
    # 10초 구간합 3장: 09:00:00 / 09:00:10 / 09:01:00 (HHMMSSmmm 인코딩)
    rows = [
        Fill(ts_ms=90000000, seq=1, buy_qty=10, sell_qty=2),
        Fill(ts_ms=90010000, seq=2, buy_qty=5, sell_qty=3),
        Fill(ts_ms=90100000, seq=3, buy_qty=7, sell_qty=1),
    ]
    path = tmp_path / "fills.parquet"
    write_fills_parquet(rows, path)

    con = duckdb.connect()
    out = query_fill_strength(con, path=path, bucket_ms=60_000)
    # 09:00 버킷 = 두 장의 합(합의 합), 09:01 버킷 = 한 장
    # 09:00 = 9h → 32,400,000 ms-from-midnight (선형화 후 버킷)
    assert [(r.bucket_intra_ms, r.buy_qty, r.sell_qty) for r in out] == [
        (32_400_000, 15, 5),
        (32_460_000, 7, 1),
    ]


def test_query_fill_strength_empty_parquet_returns_no_rows(tmp_path: Path):
    # trades 미러: atomic_write_parquet_table은 빈 테이블도 파일로 쓴다
    # (atomic_write_parquet의 빈-삭제와 다름) — zero-row parquet → [].
    path = tmp_path / "fills.parquet"
    write_fills_parquet([], path)
    assert path.exists()

    con = duckdb.connect()
    assert query_fill_strength(con, path=path, bucket_ms=60_000) == []
