from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from zoneinfo import ZoneInfo

import polars as pl

from hoga.api.heatmap import save_document
from hoga.api.heatmap_group_flow import BUCKET_MS, build_group_flow
from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder

_KST = ZoneInfo("Asia/Seoul")
BASIS = dt.date(2026, 6, 19)
SEMI = "f_00000001"
BIO = "f_00000002"


def _ms(h: int, m: int) -> int:
    return int(dt.datetime(BASIS.year, BASIS.month, BASIS.day, h, m, tzinfo=_KST).timestamp() * 1000)


def _seed_heatmap(tmp_path: Path) -> None:
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[
                WatchlistFolder.model_construct(id=SEMI, name="반도체", order=0),
                WatchlistFolder.model_construct(id=BIO, name="바이오", order=1),
            ],
            entries=[
                HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=SEMI, order=0),
                HeatmapEntry.model_construct(code="000660", name="SK하이닉스", folder_id=SEMI, order=1),
                HeatmapEntry.model_construct(code="068270", name="셀트리온", folder_id=BIO, order=0),
            ],
        ),
    )


def _seed_daily(tmp_path: Path) -> None:
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["005930", "005930", "000660", "000660", "068270"],
            # 005930·000660 은 basis 전날(6/18) 종가가 prev_close; 068270 은 basis 이전 행 없음.
            "date": [dt.date(2026, 6, 17), dt.date(2026, 6, 18),
                     dt.date(2026, 6, 17), dt.date(2026, 6, 18),
                     dt.date(2026, 6, 19)],
            "close": [90.0, 100.0, 180.0, 200.0, 50.0],
        },
    ).write_parquet(sdir / "daily_adjusted.parquet")


def _write_candles(tmp_path: Path, code: str, records: list[tuple[int, float]]) -> None:
    root = tmp_path / "live_kiwoom" / BASIS.strftime("%Y%m%d")
    root.mkdir(parents=True, exist_ok=True)
    with (root / f"{code}.jsonl").open("w", encoding="utf-8") as fh:
        for t_ms, close in records:
            fh.write(json.dumps({
                "t_ms": t_ms, "kind": "candle",
                "payload": {"open": close, "high": close, "low": close, "close": close, "volume": 1},
            }) + "\n")


def test_group_flow_averages_member_change_pct(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    # 반도체: 두 종목 모두 09:03 에 +5%(prev 100→105, 200→210). 그룹 평균 bucket0 = 5%.
    _write_candles(tmp_path, "005930", [(_ms(9, 3), 105.0)])
    _write_candles(tmp_path, "000660", [(_ms(9, 3), 210.0)])

    resp = build_group_flow(tmp_path, BASIS, now_ms=_ms(9, 10))

    assert resp.date == "2026-06-19"
    assert resp.bucket_ms == BUCKET_MS
    assert resp.t_base_ms == _ms(9, 0)
    semi = next(g for g in resp.groups if g.folder_id == SEMI)
    # bucket0(09:00–09:05) 에 +5%, 이후 현재 버킷까지 carry-forward 로 +5% 유지.
    # now=09:10 은 bucket2([09:10,09:15)) 시작 → 현재 버킷 포함이 맞다(라인이 현재까지).
    assert semi.pct[0] == 5.0
    assert semi.pct[1] == 5.0
    assert semi.pct[2] == 5.0
    # 미도래 버킷(09:15 이후)은 null.
    assert semi.pct[3] is None
    assert semi.pct[-1] is None


def test_group_flow_null_when_no_candles_or_no_baseline(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    # 바이오(068270): basis 이전 daily 행 없음 → prev_close 결측 → 전 버킷 null.
    _write_candles(tmp_path, "068270", [(_ms(9, 3), 55.0)])

    resp = build_group_flow(tmp_path, BASIS, now_ms=_ms(9, 10))

    bio = next(g for g in resp.groups if g.folder_id == BIO)
    assert all(v is None for v in bio.pct)
    # 반도체는 캔들 파일이 없어(이 테스트는 미기록) 역시 전부 null.
    semi = next(g for g in resp.groups if g.folder_id == SEMI)
    assert all(v is None for v in semi.pct)


def test_group_flow_tolerates_torn_last_line(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    root = tmp_path / "live_kiwoom" / BASIS.strftime("%Y%m%d")
    root.mkdir(parents=True, exist_ok=True)
    good = json.dumps({"t_ms": _ms(9, 3), "kind": "candle",
                       "payload": {"open": 105, "high": 105, "low": 105, "close": 105, "volume": 1}})
    # 마지막 줄이 찢긴 채(부분 write) — 파서는 그때까지를 반환해야 한다.
    (root / "005930.jsonl").write_text(good + '\n{"t_ms": 178485', encoding="utf-8")

    resp = build_group_flow(tmp_path, BASIS, now_ms=_ms(9, 10))
    semi = next(g for g in resp.groups if g.folder_id == SEMI)
    assert semi.pct[0] == 5.0
