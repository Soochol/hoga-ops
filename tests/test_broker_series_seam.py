"""거래원 궤적 today-aware 디스크 seam — 순수 함수 (#9).

spec docs/superpowers/specs/2026-06-08-broker-trajectory-today-seam-design.md.
브라우저 실측이 장중 이월이라 이 유닛들이 봉합 정확성의 유일 안전망:
- net 동치(버퍼=parquet) 판별 테스트(린치핀)
- parquet 부재(첫 승격 전) 가드
- ts_ms → unix-ms 변환(today 경로 이중변환 방지)
"""
from __future__ import annotations

from pathlib import Path

import duckdb

from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.tables.brokers import (
    BrokerRow,
    broker_rows_from_snapshots,
    query_day_series,
    query_day_series_today,
    series_entries_from_rows,
    write_parquet,
)

DATE = "20260608"
ENC_0930 = 93000000  # HHMMSSmmm = 09:30:00.000


# ── Task 1: series_entries_from_rows ──────────────────────────────────────────

def test_series_entries_collapses_aliases_and_ranks_top10() -> None:
    rows = [
        ("신한투자증권", 1000, 50),
        ("신한증권", 1000, 30),  # 별칭 → canonical 합산 = 80
        ("키움증권", 1000, -20),
        ("신한투자증권", 2000, 120),
    ]
    entries = series_entries_from_rows(rows)
    by = {e.broker: e for e in entries}
    assert by["신한투자증권"].points[0].net == 80
    assert by["신한투자증권"].final_net == 120
    assert by["신한투자증권"].dominant_side == "buy"
    assert by["키움증권"].dominant_side == "sell"
    assert [e.broker for e in entries][0] == "신한투자증권"  # |120| 최상위


# ── Task 2: broker_rows_from_snapshots + net 동치 린치핀 ───────────────────────

def test_broker_rows_from_snapshots_signs_and_ignores_empty() -> None:
    snaps = [
        {"t_ms": 111, "buy_top": [{"name": "키움증권", "qty": 100}],
         "sell_top": [{"name": "키움증권", "qty": 40}]},
        {"t_ms": 222, "buy_top": [{"name": "미래에셋증권", "qty": 70}], "sell_top": []},
        {"t_ms": 333, "buy_top": [], "sell_top": []},  # 빈 → 무시
    ]
    rows = broker_rows_from_snapshots(snaps)
    assert ("미래에셋증권", 222, 70) in rows
    assert sum(n for _, t, n in rows if t == 111) == 60  # +100 - 40
    assert not [r for r in rows if r[1] == 333]


def test_buffer_net_equals_parquet_net_for_same_tick(tmp_path: Path) -> None:
    """린치핀(advisor): 같은 broker payload를 버퍼 경로와 promote→parquet 경로로
    통과시켜 signed net 동치 — 오프셋 없는 concat 연속성의 직접 증거."""
    payload_buy = [{"name": "키움증권", "qty": 100}, {"name": "미래에셋증권", "qty": 30}]
    payload_sell = [{"name": "키움증권", "qty": 40}]
    # (a) 버퍼 경로
    buf_rows = broker_rows_from_snapshots(
        [{"t_ms": ENC_0930, "buy_top": payload_buy, "sell_top": payload_sell}]
    )
    buf_net = {e.broker: e.final_net for e in series_entries_from_rows(buf_rows)}
    # (b) promote→parquet 경로 (promote.py:189-208 매핑 그대로: qty_today=qty, qty_delta=0)
    brows = [
        BrokerRow(ts_ms=ENC_0930, seq=1, side="sell", rank=i, broker=e["name"],
                  qty_today=e["qty"], qty_delta=0)
        for i, e in enumerate(payload_sell, 1)
    ] + [
        BrokerRow(ts_ms=ENC_0930, seq=1, side="buy", rank=i, broker=e["name"],
                  qty_today=e["qty"], qty_delta=0)
        for i, e in enumerate(payload_buy, 1)
    ]
    out = tmp_path / "brokers.parquet"
    write_parquet(brows, out)
    con = duckdb.connect()
    pq_net = {e.broker: e.final_net for e in query_day_series(con, path=out)}
    assert buf_net == pq_net


# ── Task 3: query_day_series_today 봉합 ───────────────────────────────────────

def _pq(tmp_path: Path, rows: list[BrokerRow]) -> Path:
    out = tmp_path / "brokers.parquet"
    write_parquet(rows, out)
    return out


def test_today_merges_parquet_then_buffer_tail(tmp_path: Path) -> None:
    pq = _pq(tmp_path, [BrokerRow(ts_ms=ENC_0930, seq=1, side="buy", rank=1,
                                  broker="키움증권", qty_today=100, qty_delta=0)])
    unix_0930 = hhmmssms_to_unix_ms(DATE, ENC_0930)
    buf = [{"t_ms": unix_0930 + 300_000, "buy_top": [{"name": "키움증권", "qty": 150}],
            "sell_top": []}]
    con = duckdb.connect()
    entries = query_day_series_today(con, pq, date=DATE, buffer_snapshots=buf)
    pts = {e.broker: e.points for e in entries}["키움증권"]
    assert pts[0].ts_ms == unix_0930 and pts[0].net == 100      # parquet, unix-ms
    assert pts[-1].ts_ms == unix_0930 + 300_000 and pts[-1].net == 150  # 버퍼 꼬리


def test_today_buffer_point_at_seam_is_dropped(tmp_path: Path) -> None:
    pq = _pq(tmp_path, [BrokerRow(ts_ms=ENC_0930, seq=1, side="buy", rank=1,
                                  broker="키움증권", qty_today=100, qty_delta=0)])
    seam_unix = hhmmssms_to_unix_ms(DATE, ENC_0930)
    buf = [{"t_ms": seam_unix, "buy_top": [{"name": "키움증권", "qty": 999}], "sell_top": []}]
    con = duckdb.connect()
    pts = query_day_series_today(con, pq, date=DATE, buffer_snapshots=buf)[0].points
    assert [p.net for p in pts] == [100]  # seam 동률 버퍼 점 제외(parquet 권위)


def test_today_no_parquet_file_uses_buffer_only(tmp_path: Path) -> None:
    """advisor critical #1: 첫 승격 전 파일 부재 → read_parquet raise 회피, 버퍼만."""
    missing = tmp_path / "nope" / "brokers.parquet"
    buf = [{"t_ms": 111, "buy_top": [{"name": "키움증권", "qty": 70}], "sell_top": []}]
    con = duckdb.connect()
    entries = query_day_series_today(con, missing, date=DATE, buffer_snapshots=buf)
    assert entries[0].broker == "키움증권" and entries[0].final_net == 70


def test_today_empty_buffer_equals_parquet_only(tmp_path: Path) -> None:
    pq = _pq(tmp_path, [BrokerRow(ts_ms=ENC_0930, seq=1, side="buy", rank=1,
                                  broker="키움증권", qty_today=100, qty_delta=0)])
    con = duckdb.connect()
    entries = query_day_series_today(con, pq, date=DATE, buffer_snapshots=[])
    assert entries[0].points[0].ts_ms == hhmmssms_to_unix_ms(DATE, ENC_0930)  # unix 변환
    assert entries[0].final_net == 100
