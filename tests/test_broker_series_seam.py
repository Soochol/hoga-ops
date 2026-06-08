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


# ── Task 4: 라우트 today 봉합 배선 ────────────────────────────────────────────

import json  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from hoga.api.queries import QueryEngine  # noqa: E402
from hoga.api.routes import build_router  # noqa: E402

CODE = "005930"
_KST = timezone(timedelta(hours=9))


class _FakeBuffer:
    """라이브 버퍼 스텁 — get_series(code)["brokers"]만 노출."""

    def __init__(self, brokers: list[dict]) -> None:
        self._brokers = brokers

    async def get_series(self, code: str) -> dict:
        return {"code": code, "snapshots": [], "trades": [], "brokers": self._brokers}


def _kis_live_engine(tmp_path: Path, rows: list[BrokerRow]) -> QueryEngine:
    # parquet_dir는 존재 검증(없으면 raise)이라 디렉터리를 직접 만든다.
    sd = tmp_path / "parquet" / DATE / CODE / "kis_live"
    sd.mkdir(parents=True, exist_ok=True)
    (sd / "meta.json").write_text(
        json.dumps({"source": "kis_live", "row_counts": {"brokers": len(rows)}})
    )
    write_parquet(rows, sd / "brokers.parquet")
    return QueryEngine(tmp_path)


def _client(engine: QueryEngine, get_buffer) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(engine, get_buffer=get_buffer))
    return TestClient(app)


def test_route_today_default_pref_falls_back_to_kis_live_and_merges(
    tmp_path: Path, monkeypatch
) -> None:
    # 실제 프론트 경로(advisor): 기본 source_pref=hogaplay지만 today엔 hogaplay
    # 디렉터리가 없어 resolve_source가 kis_live로 폴백 → 게이트 통과 → 꼬리 병합.
    # source_pref를 명시하지 않아 프론트 기본값과 동일.
    monkeypatch.setattr("hoga.api.routes.now_kst",
                        lambda: datetime(2026, 6, 8, 10, 0, tzinfo=_KST))
    engine = _kis_live_engine(tmp_path, [BrokerRow(ts_ms=ENC_0930, seq=1, side="buy",
                              rank=1, broker="키움증권", qty_today=100, qty_delta=0)])
    unix_0930 = hhmmssms_to_unix_ms(DATE, ENC_0930)
    buf = _FakeBuffer([{"t_ms": unix_0930 + 300_000,
                        "buy_top": [{"name": "키움증권", "qty": 150}], "sell_top": []}])
    r = _client(engine, lambda: buf).get(
        "/api/brokers/series", params={"code": CODE, "date": DATE})  # 기본 hogaplay
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "kis_live"  # 폴백 확인
    pts = {e["broker"]: e["points"] for e in body["brokers"]}["키움증권"]
    assert pts[0] == {"ts_ms": unix_0930, "net": 100}            # parquet, unix-ms
    assert pts[-1] == {"ts_ms": unix_0930 + 300_000, "net": 150}  # 버퍼 꼬리(이중변환 아님)


def test_route_today_hogaplay_present_serves_hogaplay_no_tail(
    tmp_path: Path, monkeypatch
) -> None:
    # advisor 경고 케이스: today에 hogaplay 디렉터리도 있으면 source_pref=hogaplay가
    # hogaplay로 resolve → 게이트(source==kis_live) 실패 → 버퍼 꼬리 미병합(소스 혼합
    # 방지). hogaplay parquet만 서빙. (실무상 today intraday엔 hogaplay 미존재라 드묾.)
    monkeypatch.setattr("hoga.api.routes.now_kst",
                        lambda: datetime(2026, 6, 8, 10, 0, tzinfo=_KST))
    engine = _kis_live_engine(tmp_path, [BrokerRow(ts_ms=ENC_0930, seq=1, side="buy",
                              rank=1, broker="키움증권", qty_today=100, qty_delta=0)])
    hg = tmp_path / "parquet" / DATE / CODE / "hogaplay"
    hg.mkdir(parents=True, exist_ok=True)
    (hg / "meta.json").write_text(json.dumps({"source": "hogaplay", "row_counts": {"brokers": 1}}))
    write_parquet([BrokerRow(ts_ms=ENC_0930, seq=1, side="buy", rank=1,
                             broker="키움증권", qty_today=50, qty_delta=0)], hg / "brokers.parquet")
    unix_0930 = hhmmssms_to_unix_ms(DATE, ENC_0930)
    buf = _FakeBuffer([{"t_ms": unix_0930 + 300_000,
                        "buy_top": [{"name": "키움증권", "qty": 150}], "sell_top": []}])
    r = _client(engine, lambda: buf).get(
        "/api/brokers/series", params={"code": CODE, "date": DATE, "source_pref": "hogaplay"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "hogaplay"
    pts = body["brokers"][0]["points"]
    assert pts == [{"ts_ms": unix_0930, "net": 50}]  # hogaplay parquet만, 버퍼 꼬리 없음


def test_route_no_buffer_is_parquet_only(tmp_path: Path, monkeypatch) -> None:
    # 버퍼 미배선(get_buffer=None) → today라도 parquet-only, unix 변환, 500 안 남.
    monkeypatch.setattr("hoga.api.routes.now_kst",
                        lambda: datetime(2026, 6, 8, 10, 0, tzinfo=_KST))
    engine = _kis_live_engine(tmp_path, [BrokerRow(ts_ms=ENC_0930, seq=1, side="buy",
                              rank=1, broker="키움증권", qty_today=100, qty_delta=0)])
    r = _client(engine, None).get(
        "/api/brokers/series", params={"code": CODE, "date": DATE, "source_pref": "kis_live"})
    assert r.status_code == 200
    pts = r.json()["brokers"][0]["points"]
    assert pts == [{"ts_ms": hhmmssms_to_unix_ms(DATE, ENC_0930), "net": 100}]  # 꼬리 없음


def test_route_past_date_ignores_buffer(tmp_path: Path, monkeypatch) -> None:
    # now_kst가 DATE보다 미래 → DATE는 과거 → 버퍼 있어도 parquet-only.
    monkeypatch.setattr("hoga.api.routes.now_kst",
                        lambda: datetime(2026, 6, 9, 10, 0, tzinfo=_KST))
    engine = _kis_live_engine(tmp_path, [BrokerRow(ts_ms=ENC_0930, seq=1, side="buy",
                              rank=1, broker="키움증권", qty_today=100, qty_delta=0)])
    buf = _FakeBuffer([{"t_ms": 9_999_999_999_999,
                        "buy_top": [{"name": "키움증권", "qty": 150}], "sell_top": []}])
    r = _client(engine, lambda: buf).get(
        "/api/brokers/series", params={"code": CODE, "date": DATE, "source_pref": "kis_live"})
    assert r.status_code == 200
    pts = r.json()["brokers"][0]["points"]
    assert pts == [{"ts_ms": hhmmssms_to_unix_ms(DATE, ENC_0930), "net": 100}]  # 꼬리 미병합
