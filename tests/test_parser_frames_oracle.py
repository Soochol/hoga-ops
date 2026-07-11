"""컬럼형 수집(hoga.parser.frames) vs 리스트 경로(_collect_events) 차등 오라클.

리스트 경로는 프로덕션에 상존하는 기준 구현(폴백 파서가 기대는 코드)이므로
동결 복사가 필요 없다 — 같은 raw 입력에 두 경로를 돌려 전 필드를 비교한다.

커버: 타입 혼합(1/2/3/4/5), qty 부호 3종, 전 타입 공용 seq dedup(첫 등장 승리),
overlap resend(keep-last per cum_vol), 말미 탭·CR·빈 줄, strict 예외 메시지
동일성, lenient skipped 동일성, 시드 퍼즈. 실데이터 차등은
HOGA_PARSER_ORACLE_RAW_DIR 로 수동 게이트.
"""
from __future__ import annotations


import os
import random
from dataclasses import astuple
from pathlib import Path

import duckdb
import pytest

from hoga.parser import ParserError, _collect_events
from hoga.parser.frames import _SNAPSHOT_COLUMNS, _TRADE_COLUMNS, collect_event_frames
from hoga.tables import snapshots as snapshots_tbl
from hoga.tables import trades as trades_tbl


# ── 라인 빌더 ────────────────────────────────────────────────────────────────


def t1_line(seq: int, ts: int, price: int, qty: str, cum_vol: int) -> str:
    # 18필드: [pad, et, pad, seq, ts, pad, price, chg, qty, cum_vol, cum_trades,
    #          low, high, unk14, netp, unk16, unk17, unk18]
    return "\t".join([
        "x", "1", "x", str(seq), str(ts), "x", str(price), "0.5", qty,
        str(cum_vol), "7", str(price - 50), str(price + 50), "3", "-11",
        "1.0", "2.0", "3.0",
    ])


def t2_line(seq: int, ts: int, base_price: int = 25000, *, tail_tab: bool = False) -> str:
    ask_p = [base_price + 50 * i for i in range(10)]
    bid_p = [base_price - 50 * (i + 1) for i in range(10)]
    parts = (
        ["x", "2", "x", str(seq), str(ts), "x"]
        + [str(p) for p in ask_p] + [str(10 + i) for i in range(10)] + ["0"] * 10
        + [str(p) for p in bid_p] + [str(20 + i) for i in range(10)] + ["0"] * 10
        + ["111", "-1", "222", "2"]
    )
    return "\t".join(parts) + ("\t" if tail_tab else "")


def t3_line(seq: int, ts: int, qty: int) -> str:
    # 10필드: parts[6]=unknown_14(int), [7]=unknown_16(float), [8]=qty, [9]=unknown_17(float)
    return "\t".join(["x", "3", "x", str(seq), str(ts), "x", "4", "1.5", str(qty), "9.0"])


def t4_line(seq: int, ts: int) -> str:
    names_s = [f"셀{i}" for i in range(1, 6)]
    names_b = [f"바이{i}" for i in range(1, 6)]
    parts = (
        ["x", "4", "x", str(seq), str(ts), "x"]
        + names_s + [str(100 + i) for i in range(5)] + [str(i) for i in range(5)]
        + names_b + [str(200 + i) for i in range(5)] + [str(i) for i in range(5)]
        + ["x"] * 6  # EXPECTED_FIELD_COUNTS[4]=42: 6 헤더 + 6×TOP_N + 트레일링 6
    )
    assert len(parts) == 42
    return "\t".join(parts)


def t5_line(seq: int) -> str:
    return "\t".join(["x", "5", "hb", str(seq)])


def write_raw(tmp_path: Path, pages: list[list[str]]) -> Path:
    raw = tmp_path / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    for i, lines in enumerate(pages, start=1):
        (raw / f"first_{i:05d}.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return raw


# ── 비교 헬퍼 ────────────────────────────────────────────────────────────────


def assert_paths_equal(raw: Path, *, lenient: bool = False) -> None:
    """수집 → dedup → 쓰기 전 구간을 두 경로로 돌려 전 필드 비교."""
    trades_list, snapshots_list, brokers_list, seen_seqs, skipped_py = _collect_events(
        raw, lenient=lenient,
    )
    trades_list = trades_tbl.dedup_overlap_resends(trades_list)

    collected = collect_event_frames(raw, lenient=lenient)
    trades_df = trades_tbl.dedup_overlap_resends_frame(collected.trades)

    assert collected.skipped == skipped_py
    assert collected.unique_event_count == len(seen_seqs)
    assert [astuple(b) for b in collected.brokers] == [astuple(b) for b in brokers_list]

    got_trades = list(trades_df.select(_TRADE_COLUMNS).iter_rows())
    want_trades = [tuple(getattr(t, c) for c in _TRADE_COLUMNS) for t in trades_list]
    assert got_trades == want_trades

    def snap_tuple(o) -> tuple:
        vals: list = [o.ts_ms, o.seq]
        for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
            vals.extend(getattr(o, prefix))
        vals += [o.tot_ask, o.tot_ask_d, o.tot_bid, o.tot_bid_d]
        return tuple(vals)

    got_snaps = list(collected.snapshots.select(_SNAPSHOT_COLUMNS).iter_rows())
    want_snaps = [snap_tuple(o) for o in snapshots_list]
    assert got_snaps == want_snaps

    # 쓰기 경로 동등성: 리스트/프레임 writer가 같은 parquet 내용을 남기는지.
    a, b = raw.parent / "out_list", raw.parent / "out_frame"
    a.mkdir(exist_ok=True); b.mkdir(exist_ok=True)
    trades_tbl.write_parquet(trades_list, a / "trades.parquet")
    snapshots_tbl.write_parquet(snapshots_list, a / "snapshots.parquet")
    trades_tbl.write_parquet_frame(trades_df, b / "trades.parquet")
    snapshots_tbl.write_parquet_frame(collected.snapshots, b / "snapshots.parquet")
    con = duckdb.connect()
    for f in ("trades", "snapshots"):
        ra = con.execute(f"SELECT * FROM read_parquet('{a / f}.parquet')").fetchall()
        rb = con.execute(f"SELECT * FROM read_parquet('{b / f}.parquet')").fetchall()
        assert ra == rb, f"{f}.parquet 내용 불일치"


# ── 고정 시나리오 ────────────────────────────────────────────────────────────


def test_mixed_types_and_sign_variants(tmp_path: Path) -> None:
    raw = write_raw(tmp_path, [[
        t2_line(1, 90000100),
        t1_line(2, 90000200, 25000, "+5", 5),
        t1_line(3, 90000300, 25050, "-3", 8),
        t1_line(4, 90000400, 0, "7", 0),          # side=0 (부호 없음)
        t3_line(5, 90000500, 999),                 # 단일가 요약 → 폴백
        t4_line(6, 90000600),                      # 거래원 fan-out → 폴백
        t5_line(7),                                # 하트비트 스킵
        "",                                        # 빈 줄
        t2_line(8, 90000700, tail_tab=True),       # 말미 탭
    ]])
    assert_paths_equal(raw)


def test_seq_dedup_first_wins_across_types_and_pages(tmp_path: Path) -> None:
    raw = write_raw(tmp_path, [
        [t1_line(10, 90001000, 25000, "+1", 1), t2_line(11, 90001100)],
        [
            t2_line(10, 90001200),                 # 타입 달라도 같은 seq → 드롭
            t1_line(11, 90001300, 25100, "-2", 3),  # 드롭
            t4_line(11, 90001400),                  # broker sample_seq 중복 → 그룹 드롭
            t1_line(12, 90001500, 25200, "+4", 7),  # 생존
            t4_line(13, 90001600),                  # 생존
        ],
    ])
    assert_paths_equal(raw)


def test_overlap_resend_keeps_last_per_cum_vol(tmp_path: Path) -> None:
    raw = write_raw(tmp_path, [[
        t1_line(1, 90000100, 25000, "+5", 100),
        t1_line(2, 90000200, 25000, "+5", 200),
        t1_line(3, 90000300, 25000, "+5", 100),   # resend (fresh seq) → seq 1 드롭
        t1_line(4, 90000400, 0, "9", 0),           # side=0 cum_vol=0 — dedup 제외
        t1_line(5, 90000500, 0, "9", 0),
    ]])
    assert_paths_equal(raw)


def test_strict_error_message_identical(tmp_path: Path) -> None:
    bad = "\t".join(["x", "1", "x", "5", "90000100", "x", "NOPE", "0.5", "+1",
                     "1", "1", "1", "1", "1", "1", "1.0", "1.0", "1.0"])
    raw = write_raw(tmp_path, [[t2_line(1, 90000000), bad]])
    with pytest.raises(ParserError) as e_list:
        _collect_events(raw, lenient=False)
    with pytest.raises(ParserError) as e_frame:
        collect_event_frames(raw, lenient=False)
    assert str(e_frame.value) == str(e_list.value)


def test_lenient_skipped_identical(tmp_path: Path) -> None:
    raw = write_raw(tmp_path, [[
        t1_line(1, 90000100, 25000, "+5", 5),
        "x\t9\tunknown-event-type",               # 미지 타입
        "short",                                   # 필드 부족
        "\t".join(["x", "2"] + ["y"] * 68),        # 필드수는 70이나 캐스트 실패
        t2_line(2, 90000200),
    ]])
    assert_paths_equal(raw, lenient=True)


# ── 시드 퍼즈 ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("seed", range(30))
def test_fuzz_matches_list_path(tmp_path: Path, seed: int) -> None:
    rng = random.Random(seed)
    lines: list[str] = []
    seq = 0
    ts = 90_000_000
    cum = 0
    for _ in range(rng.randrange(5, 120)):
        seq += rng.choice([1, 1, 1, 2])            # 가끔 seq 재사용(중복) 발생
        if rng.random() < 0.15:
            seq -= rng.randrange(1, 3)             # 중복 seq 유도
        ts += rng.randrange(0, 5000)
        kind = rng.random()
        if kind < 0.5:
            cum += rng.randrange(0, 50)
            if rng.random() < 0.1:
                cum -= rng.randrange(0, 30)        # cum_vol 회귀(resend 모사)
            qty = rng.choice(["+", "-", ""]) + str(rng.randrange(0, 500))
            lines.append(t1_line(max(seq, 0), ts, 25000 + 50 * rng.randrange(-5, 6), qty, max(cum, 0)))
        elif kind < 0.85:
            lines.append(t2_line(max(seq, 0), ts, 25000 + 50 * rng.randrange(-3, 4)))
        elif kind < 0.92:
            lines.append(t4_line(max(seq, 0), ts))
        elif kind < 0.97:
            lines.append(t3_line(max(seq, 0), ts, rng.randrange(0, 100)))
        else:
            lines.append(t5_line(max(seq, 0)))
        if rng.random() < 0.05:
            lines.append("malformed\tgarbage")     # lenient 스킵 대상
    n_pages = rng.randrange(1, 4)
    pages: list[list[str]] = [[] for _ in range(n_pages)]
    for i, line in enumerate(lines):
        pages[i % n_pages].append(line)
    raw = write_raw(tmp_path, pages)
    assert_paths_equal(raw, lenient=True)


# ── 실데이터 차등 (수동 게이트) ──────────────────────────────────────────────


@pytest.mark.skipif(
    not os.environ.get("HOGA_PARSER_ORACLE_RAW_DIR"),
    reason="set HOGA_PARSER_ORACLE_RAW_DIR=<data/raw/<date>/<code> dir> for real-data run",
)
def test_real_day_matches_list_path(tmp_path: Path) -> None:
    src = Path(os.environ["HOGA_PARSER_ORACLE_RAW_DIR"])
    raw = tmp_path / "raw"
    raw.symlink_to(src)
    assert_paths_equal(raw, lenient=True)
