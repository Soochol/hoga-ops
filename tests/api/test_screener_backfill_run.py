from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path
from types import SimpleNamespace

import polars as pl
import pytest

from hoga.api import screener_backfill as screener_backfill_mod
from hoga.api.screener_backfill import run_backfill_with
from hoga.api.screener_factors import read_factors
from hoga.api.screener_store import DailyBar
from hoga.util.timeenc import KST

_S = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
      "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


async def _fake_page_fetch(_client):
    """페이크가 러너에 넘기는 페이지 팩토리 — 거버너 경로만 지나게 한다(ADR-0137)."""
    from hoga.live.kiwoom_rest import Page

    return Page(rows=[], cont=False, next_key="")

def test_run_backfill_produces_factors_and_report(tmp_path: Path):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True)
    un = pl.DataFrame([
        {"code": "035720", "date": dt.date(2021, 4, 5), "open": 502000.0, "high": 502000.0,
         "low": 502000.0, "close": 502000.0, "volume": 100},
        {"code": "035720", "date": dt.date(2021, 4, 15), "open": 120500.0, "high": 120500.0,
         "low": 120500.0, "close": 120500.0, "volume": 100},
    ], schema=_S)
    un.write_parquet(sdir / "daily_unadjusted.parquet")
    un.write_parquet(sdir / "daily_adjusted.parquet")  # old == unadjusted (heuristic miss)

    async def fetch_adj(code, frm, to):
        return [(dt.date(2021, 4, 5), 100759.0), (dt.date(2021, 4, 15), 120500.0)]

    async def fetch_raw(code, frm, to):
        return [DailyBar(code, dt.date(2021, 4, 5), 502000.0, 502000.0, 502000.0, 502000.0, 100),
                DailyBar(code, dt.date(2021, 4, 15), 120500.0, 120500.0, 120500.0, 120500.0, 100)]

    report = asyncio.run(run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw))

    assert read_factors(sdir / "factors.parquet") is not None
    adj = pl.read_parquet(sdir / "daily_adjusted.parquet").filter(
        (pl.col("code") == "035720") & (pl.col("date") == dt.date(2021, 4, 5)))
    assert abs(adj["close"][0] - 100759.0) < 1.0  # now KIS-adjusted, not 502000
    assert report["impact"]["changed_codes"] >= 1


def test_rerun_preserves_prebackfill_baseline(tmp_path):
    sdir = tmp_path / "screener"; sdir.mkdir(parents=True)
    un = pl.DataFrame([
        {"code":"035720","date":dt.date(2021,4,5),"open":502000.0,"high":502000.0,"low":502000.0,"close":502000.0,"volume":100},
        {"code":"035720","date":dt.date(2021,4,15),"open":120500.0,"high":120500.0,"low":120500.0,"close":120500.0,"volume":100},
    ], schema=_S)
    un.write_parquet(sdir/"daily_unadjusted.parquet")
    un.write_parquet(sdir/"daily_adjusted.parquet")  # 휴리스틱 baseline(미보정)
    async def fetch_adj(code,frm,to): return [(dt.date(2021,4,5),100759.0),(dt.date(2021,4,15),120500.0)]
    async def fetch_raw(code,frm,to):
        return [DailyBar(code,dt.date(2021,4,5),502000.0,502000.0,502000.0,502000.0,100),
                DailyBar(code,dt.date(2021,4,15),120500.0,120500.0,120500.0,120500.0,100)]
    r1 = asyncio.run(run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw))
    r2 = asyncio.run(run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw))  # 재실행
    assert r1["impact"]["changed_codes"] >= 1
    assert r2["impact"]["changed_codes"] >= 1   # 재실행에도 baseline 보존 → 여전히 변화 보고
    pb = pl.read_parquet(sdir/"daily_adjusted.prebackfill.parquet").filter(
        (pl.col("code")=="035720") & (pl.col("date")==dt.date(2021,4,5)))
    assert pb["close"][0] == 502000.0   # 원본(휴리스틱) 유지, KIS 값으로 안 덮임


async def test_run_backfill_fetches_daily_rows_through_capacity_scheduler(tmp_path, monkeypatch):
    """PR-F(#1042) 칼 컷오버 — 소스는 키움 `ka10081` 이다.

    계정 차원(`data_dir`·`endpoint`·`cooldown_scope`)이 사라졌다: 키움 유량은
    TR별이라 고를 계정이 없다(#1015). 버킷 키는 `api_id` 다.

    **수정주가/원주가 2벌이 이 테스트의 핵심**이다. 키움 `upd_stkpc_tp` 는 KIS 의
    `FID_ORG_ADJ_PRC` 와 극성이 반대라(1=수정주가) 옮기다 뒤집히기 쉽다. 여기서는
    불리언이 어댑터까지 그대로 도달하는지만 보고, 와이어 값 변환은
    `test_kiwoom_daily_candles.py` 가 액면분할 리트머스로 못 박는다.
    """
    from hoga.live import kiwoom_access, kiwoom_daily_candles, kiwoom_rest_runtime

    scheduler = object()
    client = object()
    calls = []
    t_ms = int(dt.datetime(2026, 6, 1, tzinfo=KST).timestamp() * 1000)

    async def fake_fetch_daily_candles(client_arg, code, frm, to, *, venue="KRX",
                                       adjust, adjusted_as_of, run_page=None):
        calls.append(("adapter", client_arg, code, frm, to, adjust, adjusted_as_of))
        if run_page is not None:
            await run_page(_fake_page_fetch, 0)
        return SimpleNamespace(candles=[
            SimpleNamespace(
                t_ms=t_ms, open=1.0, high=2.0, low=1.0,
                close=3.0 if adjust else 2.0, volume=10,
            )
        ])

    async def fake_run_with_capacity(scheduler_arg, *, key, api_id, priority, fetch_fn, client):
        calls.append({
            "scheduler": scheduler_arg, "key": key,
            "api_id": api_id, "priority": priority,
        })
        return await fetch_fn(client)

    # `factors_only` 를 **받기만 하고 쓰지 않는다** — 이 테스트가 재는 것은 어댑터까지
    # 가는 배선이지 그 플래그의 동작이 아니다(그건 아래 전용 테스트가 잰다).
    async def fake_run_backfill_with(sdir, *, fetch_adj, fetch_raw, now_ms=None,
                                     factors_only=False):
        adj = await fetch_adj("005930", "20260601", "20260601")
        raw = await fetch_raw("005930", "20260601", "20260601")
        return {"adj": adj, "raw": raw, "sdir": sdir}

    monkeypatch.setattr(
        kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: client
    )
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_a, **_k: scheduler)
    monkeypatch.setattr(kiwoom_access, "run_with_capacity", fake_run_with_capacity)
    monkeypatch.setattr(
        kiwoom_daily_candles, "fetch_daily_candles", fake_fetch_daily_candles
    )
    monkeypatch.setattr(screener_backfill_mod, "run_backfill_with", fake_run_backfill_with)

    result = await screener_backfill_mod.run_backfill(tmp_path)

    assert result["sdir"] == tmp_path / "screener"
    assert result["adj"] == [(dt.date(2026, 6, 1), 3.0)]
    assert result["raw"] == [DailyBar("005930", dt.date(2026, 6, 1), 1.0, 2.0, 1.0, 2.0, 10)]
    assert [call for call in calls if isinstance(call, dict)] == [
        {
            "scheduler": scheduler,
            # 끝의 0 은 **페이지 인덱스** — 거버너 단위가 walk 전체가 아니라 페이지다.
            "key": ("screener-backfill-adj", "005930", "20260601", "20260601", 0),
            "api_id": "ka10081",
            "priority": "background",
        },
        {
            "scheduler": scheduler,
            # 끝의 0 은 **페이지 인덱스** — 거버너 단위가 walk 전체가 아니라 페이지다.
            "key": ("screener-backfill-raw", "005930", "20260601", "20260601", 0),
            "api_id": "ka10081",
            "priority": "background",
        },
    ]
    assert [c[5] for c in calls if isinstance(c, tuple)] == [True, False], (
        "수정주가 1벌 · 원주가 1벌 — 극성이 뒤집히면 여기서 걸린다"
    )


async def test_run_backfill_fails_loudly_without_kiwoom_credentials(tmp_path, monkeypatch):
    """무자격이면 조용히 skip 하지 않고 loud fail 한다 — KIS 시절 규약을 유지한다."""
    from hoga.live import kiwoom_rest_runtime

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: None)
    with pytest.raises(RuntimeError, match="자격증명"):
        await screener_backfill_mod.run_backfill(tmp_path)


# ── `--factors-only` — 장중에 돌릴 수 있는 형태 ────────────────────────────────────


def test_factors_only_skips_reconcile_and_never_touches_raw(tmp_path: Path):
    """⚠ **`factors_only` 는 reconcile 경로를 아예 안 탄다.**

    reconcile 은 최근 14일의 불일치를 벤더 값으로 **덮어쓴다**. 장중에는 그 「최근」에
    진행 중인 **오늘 봉**이 들어 있고, 미확정 봉이 확정본으로 굳으면 갱신기가 그
    날짜를 갭으로 안 봐서 **영원히 안 고쳐진다**(2026-06-18 사고 — 3,541종목이
    장전 스냅샷으로 굳어 두 달간 남았다).

    가드 방식: `fetch_raw` 를 **터지는 것으로** 준다. 「호출 수가 0이더라」를 우연히
    통과하는 것이 아니라 **경로를 안 탄다는 것 자체**를 잰다. 원주가 파일이 바이트
    단위로 그대로인지도 함께 본다 — reconcile 의 유일한 부작용이 그 파일이라서다.
    """
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True)
    un = pl.DataFrame([
        {"code": "035720", "date": dt.date(2021, 4, 5), "open": 502000.0, "high": 502000.0,
         "low": 502000.0, "close": 502000.0, "volume": 100},
        {"code": "035720", "date": dt.date(2021, 4, 15), "open": 120500.0, "high": 120500.0,
         "low": 120500.0, "close": 120500.0, "volume": 100},
    ], schema=_S)
    un.write_parquet(sdir / "daily_unadjusted.parquet")
    un.write_parquet(sdir / "daily_adjusted.parquet")
    raw_before = (sdir / "daily_unadjusted.parquet").read_bytes()

    async def fetch_adj(_code, _frm, _to):
        return [(dt.date(2021, 4, 5), 100759.0), (dt.date(2021, 4, 15), 120500.0)]

    async def fetch_raw(_code, _frm, _to):
        raise AssertionError("factors_only 가 reconcile(원주가 조회)을 탔다")

    report = asyncio.run(run_backfill_with(
        sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw, factors_only=True))

    # reconcile 은 **안 돈 것**이지 0건이 아니다 — 그 구별이 리포트에 남아야 호출부가
    # 「대조했는데 전부 일치」와 섞어 적지 않는다.
    assert report["reconcile"] is None
    assert (sdir / "daily_unadjusted.parquet").read_bytes() == raw_before
    # 그러면서 **목적은 달성한다** — 계수가 생기고 수정주가가 다시 파생된다.
    assert report["factors_added"] > 0
    assert read_factors(sdir / "factors.parquet") is not None
    adj = pl.read_parquet(sdir / "daily_adjusted.parquet").filter(
        (pl.col("code") == "035720") & (pl.col("date") == dt.date(2021, 4, 5)))
    assert adj.height == 1
    assert adj["close"][0] == pytest.approx(100759.0, rel=1e-6)
