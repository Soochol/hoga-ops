"""이미 쓰인 kiwoom_live candles 파케이의 조각 봉 접기(1회 스윕)의 계약.

생산자 수정(`merge_split_candles` 를 승격에 물린 것)은 **새로 쓰이는 파일**만 고친다.
디스크의 7,069개는 이 스윕이 고친다 — 읽기 병합이 있어 화면은 이미 멀쩡하므로 이
스윕이 지키는 것은 화면이 아니라 ``series.candles_ts_monotonic``(Severity.error) 이다.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from hoga.live.candle_repair import CandleRepairResult, repair_split_candles
from hoga.tables.candles import Candle, read_parquet, write_parquet
from hoga.util.timeenc import KST

CODE = "005930"
# 스윕의 "과거만" 경계를 고정한다 — 실제 오늘에 의존하면 테스트가 날마다 다르게 돈다.
NOW = datetime(2026, 8, 22, 11, 0, tzinfo=KST)
PAST = "20260820"
TODAY = "20260822"

# 실측 조각(005930/20260820 09:08 = 32,880,000ms).
FRAG_A = Candle(ts_ms=32880000, open_=252750, close_=253000,
                high=253500, low=252500, vol_a=107264, vol_b=0)
FRAG_B = Candle(ts_ms=32880000, open_=253250, close_=253500,
                high=254000, low=253000, vol_a=39722, vol_b=0)
CLEAN = Candle(ts_ms=32820000, open_=252000, close_=252750,
               high=253000, low=251500, vol_a=50000, vol_b=0)


def _write(data_dir: Path, date: str, venue: str, candles: list[Candle]) -> Path:
    target = data_dir / "parquet" / date / CODE / "kiwoom_live" / venue
    target.mkdir(parents=True, exist_ok=True)
    path = target / "candles.parquet"
    write_parquet(candles, path)
    return path


def test_repair_folds_fragments_in_past_files(tmp_path: Path) -> None:
    path = _write(tmp_path, PAST, "KRX", [CLEAN, FRAG_A, FRAG_B])

    res = repair_split_candles(tmp_path, now=NOW)

    assert (res.scanned, res.repaired, res.skipped_clean) == (1, 1, 0)
    assert (res.rows_before, res.rows_after) == (3, 2)
    rows = read_parquet(path)
    assert [c.ts_ms for c in rows] == [32820000, 32880000]
    assert rows[1].open_ == 252750    # 첫 조각
    assert rows[1].close_ == 253500   # 마지막 조각
    assert rows[1].high == 254000
    assert rows[1].low == 252500
    assert rows[1].vol_a == 146986    # 합
    assert rows[0] == CLEAN           # 단일 조각은 손대지 않는다


def test_repair_leaves_todays_file_alone(tmp_path: Path) -> None:
    """**막는 방향**: 아직 쓰이고 있는 파일을 고치는 것.

    Today Promoter 는 증분 상태에서 오늘 파케이를 주기마다 **통째로 다시 쓴다** —
    여기서 고쳐도 다음 주기가 되돌리고, 생산자 수정 이후엔 그 재작성이 곧 치유다.
    즉 오늘을 건드리는 것은 이득이 0이고 writer 와의 경주만 남는다.
    """
    today_path = _write(tmp_path, TODAY, "KRX", [FRAG_A, FRAG_B])
    _write(tmp_path, PAST, "KRX", [FRAG_A, FRAG_B])

    res = repair_split_candles(tmp_path, now=NOW)

    assert res.scanned == 1   # 오늘 파일은 세지도 않는다
    assert res.repaired == 1  # 과거 파일만
    assert len(read_parquet(today_path)) == 2  # 오늘 파일은 조각 그대로


def test_repair_walks_every_venue(tmp_path: Path) -> None:
    """ADR-0140 이후 저장 창이 venue 별로 갈렸다 — KRX 만 훑으면 NXT·UN 이 남는다."""
    paths = [_write(tmp_path, PAST, v, [FRAG_A, FRAG_B]) for v in ("KRX", "NXT", "UN")]

    res = repair_split_candles(tmp_path, now=NOW)

    assert (res.scanned, res.repaired) == (3, 3)
    assert all(len(read_parquet(p)) == 1 for p in paths)


def test_repair_skips_clean_files_and_is_idempotent(tmp_path: Path) -> None:
    _write(tmp_path, PAST, "KRX", [CLEAN, FRAG_A, FRAG_B])

    first = repair_split_candles(tmp_path, now=NOW)
    second = repair_split_candles(tmp_path, now=NOW)

    assert first.repaired == 1
    assert (second.scanned, second.repaired, second.skipped_clean) == (1, 0, 1)
    assert (second.rows_before, second.rows_after) == (0, 0)


def test_dry_run_counts_without_writing(tmp_path: Path) -> None:
    path = _write(tmp_path, PAST, "KRX", [FRAG_A, FRAG_B])
    before = path.read_bytes()

    res = repair_split_candles(tmp_path, dry_run=True, now=NOW)

    assert (res.repaired, res.rows_before, res.rows_after) == (1, 2, 1)
    assert path.read_bytes() == before


def test_missing_parquet_root_is_not_an_error(tmp_path: Path) -> None:
    assert repair_split_candles(tmp_path / "nope", now=NOW) == CandleRepairResult()


def test_unreadable_file_is_counted_not_fatal(tmp_path: Path) -> None:
    """손상 1건이 남은 수천 개의 복구를 막지 않는다."""
    bad = _write(tmp_path, PAST, "KRX", [FRAG_A, FRAG_B])
    bad.write_bytes(b"not a parquet file")
    good = _write(tmp_path, PAST, "NXT", [FRAG_A, FRAG_B])

    res = repair_split_candles(tmp_path, now=NOW)

    assert (res.scanned, res.repaired, res.unreadable) == (2, 1, 1)
    assert len(read_parquet(good)) == 1
