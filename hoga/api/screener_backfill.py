"""Screener Phase-2 one-time ops: KIS factor backfill, 원주가 reconcile, impact report.

Reuses the Phase-1 factor store (screener_factors) and daily store (screener_store).
KIS fetches are injected so the logic is unit-testable without live calls (ADR-0057).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

import polars as pl

from hoga.api import screener_factors

log = logging.getLogger(__name__)

# (code, from_yyyymmdd, to_yyyymmdd) -> [(date, adj_close)] (order-agnostic; pair_raw_adj sorts)
FetchAdj = Callable[[str, str, str], Awaitable[list[tuple[dt.date, float]]]]

_BACKFILL_CONCURRENCY = 8  # KIS _get caps HTTP at 15/s; this just fills the bucket


def _raw_close_by_code(unadjusted: pl.DataFrame) -> dict[str, list[tuple[dt.date, float]]]:
    """daily_unadjusted → {code: [(date, close), ...]} (sorted by date)."""
    out: dict[str, list[tuple[dt.date, float]]] = {}
    for code, sub in unadjusted.select(["code", "date", "close"]).sort(["code", "date"]).group_by(
        "code", maintain_order=True
    ):
        key = code[0] if isinstance(code, tuple) else code
        out[key] = list(zip(sub["date"].to_list(), sub["close"].to_list()))
    return out


async def factor_backfill(
    sdir: Path, *, fetch_adj: FetchAdj, codes: list[str] | None = None,
    batch: int = 200, concurrency: int = _BACKFILL_CONCURRENCY,
) -> int:
    """전 종목 KIS 수정주가로 factors.parquet 구축. 이미 있는 종목은 skip(resumable).

    각 종목: 원주가 종가 + KIS 수정주가 종가를 date-join(pair_raw_adj) → compute_factor_segments.
    batch 마다 (기존 ∪ 신규) 를 원자적으로 기록 → 중단돼도 완료분 보존. 신규 추가 종목 수 반환.
    """
    up = sdir / "daily_unadjusted.parquet"
    fpath = sdir / "factors.parquet"
    raw_by_code = _raw_close_by_code(pl.read_parquet(up))
    all_codes = codes if codes is not None else sorted(raw_by_code)

    existing = screener_factors.read_factors(fpath)
    done = set(existing["code"].unique().to_list()) if existing is not None else set()
    todo = [c for c in all_codes if c in raw_by_code and c not in done]

    sem = asyncio.Semaphore(concurrency)
    new_by_code: dict[str, list[screener_factors.FactorSegment]] = {}

    async def _one(code: str):
        rr = raw_by_code[code]
        try:
            async with sem:
                adj = await fetch_adj(code, rr[0][0].strftime("%Y%m%d"), rr[-1][0].strftime("%Y%m%d"))
            return code, screener_factors.compute_factor_segments(screener_factors.pair_raw_adj(rr, adj))
        except Exception:  # noqa: BLE001 — 한 종목 실패가 멀티시간 백필을 중단시키면 안 됨
            log.warning("factor_backfill: %s fetch/compute 실패, skip(다음 run 재시도)", code, exc_info=True)
            return code, []

    def _flush() -> None:
        frame = screener_factors.segments_to_frame(new_by_code)
        if existing is not None and existing.height:
            frame = pl.concat([existing.select(frame.columns), frame])
        screener_factors.write_factors(frame, fpath)

    for i in range(0, len(todo), batch):
        results = await asyncio.gather(*(_one(c) for c in todo[i:i + batch]))
        for code, segs in results:
            if segs:
                new_by_code[code] = segs
        _flush()  # incremental atomic write (resumable)
    return len(new_by_code)


from dataclasses import dataclass  # noqa: E402 — appended reconcile block

from hoga.api.screener_store import DailyBar, _DAILY_PL_SCHEMA, append_rows  # noqa: E402

# (code, from_yyyymmdd, to_yyyymmdd) -> list[DailyBar] (full 원주가 rows)
FetchRaw = Callable[[str, str, str], Awaitable[list["DailyBar"]]]


@dataclass(frozen=True)
class ReconcileReport:
    codes_checked: int
    value_matches: int
    value_mismatches: int
    filled_rows: int
    mismatch_sample: list[tuple[str, str]]  # (code, YYYY-MM-DD) up to 20
    recent_overwrites: int = 0  # bars corrected in-place (within overwrite_recent_days window)


async def reconcile_raw(
    sdir: Path, *, fetch_raw: FetchRaw, codes: list[str] | None = None,
    concurrency: int = _BACKFILL_CONCURRENCY,
    overwrite_recent_days: int = 0,
) -> ReconcileReport:
    """기존 원주가를 KIS(원주가)와 대조: 겹치는 날 값 검증 + 디스크 결측일을 KIS로 보충(합집합).

    값 불일치: 기본은 '기록만'하고 덮어쓰지 않는다(디스크 SSOT 보존). 단 최근
    overwrite_recent_days 일 이내(disk 최대일 기준)의 불일치는 장중 데이터 오염으로 간주해
    KIS 값으로 덮어쓴다 — append_rows 의 keep="last" 가 신규 행을 우선한다.
    결측일(KIS엔 있고 디스크엔 없음)만 append_rows 로 union — (code,date) 멱등이 중복을 막는다.
    원자적 기록.  recent_overwrites 는 덮어쓴 행 수(height 변화 없음).
    """
    up = sdir / "daily_unadjusted.parquet"
    disk = pl.read_parquet(up)
    disk_keys = {(c, d) for c, d in zip(disk["code"].to_list(), disk["date"].to_list())}
    disk_close = {(c, d): cl for c, d, cl in
                  zip(disk["code"].to_list(), disk["date"].to_list(), disk["close"].to_list())}
    all_codes = codes if codes is not None else sorted(disk["code"].unique().to_list())

    # recent_cutoff: bars on or after this date are eligible for in-place overwrite
    disk_max = disk["date"].max() if disk.height > 0 else None
    recent_cutoff: dt.date | None = (
        disk_max - dt.timedelta(days=overwrite_recent_days)
        if disk_max is not None and overwrite_recent_days > 0 else None
    )

    sem = asyncio.Semaphore(concurrency)

    async def _one(code: str) -> list[DailyBar]:
        sub = disk.filter(pl.col("code") == code)
        first, last = sub["date"].min(), sub["date"].max()
        if first is None:           # corpus에 없는 코드 → reconcile 대상 아님
            return []
        frm, to = first.strftime("%Y%m%d"), last.strftime("%Y%m%d")
        try:
            async with sem:
                return await fetch_raw(code, frm, to)
        except Exception:  # noqa: BLE001 — 한 종목 실패가 전체 reconcile 을 중단시키면 안 됨
            log.warning("reconcile_raw: %s fetch 실패, skip", code, exc_info=True)
            return []

    fetched = await asyncio.gather(*(_one(c) for c in all_codes))

    matches = mismatches = recent_overwrites = 0
    sample: list[tuple[str, str]] = []
    fill: list[DailyBar] = []
    for bars in fetched:
        for b in bars:
            key = (b.code, b.date)
            if key in disk_keys:
                if abs(disk_close[key] - b.close) < 1e-6:
                    matches += 1
                else:
                    mismatches += 1
                    if len(sample) < 20:
                        sample.append((b.code, b.date.strftime("%Y-%m-%d")))
                    # overwrite recent days: KIS is authoritative for intraday-stale raw
                    if recent_cutoff is not None and b.date >= recent_cutoff:
                        fill.append(b)
                        recent_overwrites += 1
            else:
                fill.append(b)

    filled = 0
    if fill:
        new = pl.DataFrame([vars(b) for b in fill], schema=_DAILY_PL_SCHEMA)
        n_before = disk.height
        _, _, merged = append_rows(up, new)
        # filled_rows = net new rows (overwrites don't change height)
        filled = merged.height - n_before

    return ReconcileReport(
        codes_checked=len(all_codes), value_matches=matches, value_mismatches=mismatches,
        filled_rows=filled, mismatch_sample=sample, recent_overwrites=recent_overwrites,
    )


from hoga.api._atomic_write import atomic_write_json  # noqa: E402 — appended impact-report block
from hoga.api.screener_store import derive_adjusted, last_raw_date, write_status  # noqa: E402


def build_impact_report(sdir: Path, *, old_path: Path) -> dict:
    """구(휴리스틱) vs 신(KIS 계수) 수정주가를 종목별로 비교 → 어떤 종목이 바뀌었는지.

    new = 현재 daily_adjusted.parquet (factor_backfill 후 derive_adjusted 가 재생성한 것).
    old = 백필 전 보관해둔 사본(old_path). (code,date) 기준 close 가 달라진 종목을 센다.
    screener/impact-report.json 으로 산출. 반환은 같은 dict.
    """
    new = pl.read_parquet(sdir / "daily_adjusted.parquet").select(["code", "date", "close"])
    old = pl.read_parquet(old_path).select(["code", "date", "close"]).rename({"close": "old_close"})
    joined = new.join(old, on=["code", "date"], how="inner")
    changed = joined.filter((pl.col("close") - pl.col("old_close")).abs() > 1e-6)
    changed_codes = sorted(changed["code"].unique().to_list())
    report = {
        "rows_compared": joined.height,
        "changed_rows": changed.height,
        "changed_codes": len(changed_codes),
        "changed_code_sample": changed_codes[:50],
    }
    atomic_write_json(sdir / "impact-report.json", report)
    return report


import shutil  # noqa: E402 — appended orchestrator block
import time  # noqa: E402


async def run_backfill_with(sdir: Path, *, fetch_adj: FetchAdj, fetch_raw: FetchRaw,
                            now_ms: int | None = None) -> dict:
    """Plan-2 1회 백필 오케스트레이션(주입된 fetch — 테스트/프로덕션 공용).

    ① reconcile_raw(원주가 검증+결측 보충) ② factor_backfill(factors.parquet)
    ③ 기존 daily_adjusted 사본 보관 ④ derive_adjusted(이제 factors 적용→ KIS 정확 수정주가)
    ⑤ build_impact_report. 반환: {reconcile, factors_added, impact}.
    """
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    rec = await reconcile_raw(sdir, fetch_raw=fetch_raw, overwrite_recent_days=14)
    added = await factor_backfill(sdir, fetch_adj=fetch_adj)

    # write-once baseline: 재실행 시 KIS-보정본이 휴리스틱 baseline 을 덮어쓰면
    # impact 리포트가 0 으로 무력화되므로, prebackfill 사본은 최초 1회만 보관한다.
    old_path = sdir / "daily_adjusted.prebackfill.parquet"
    if (sdir / "daily_adjusted.parquet").exists() and not old_path.exists():
        shutil.copyfile(sdir / "daily_adjusted.parquet", old_path)

    derive_ms = derive_adjusted(sdir / "daily_unadjusted.parquet", sdir / "daily_adjusted.parquet",
                                factors_path=sdir / "factors.parquet")
    write_status(sdir / "status.json",
                 last_raw_date=last_raw_date(sdir / "daily_unadjusted.parquet"),
                 universe_size=pl.read_parquet(sdir / "daily_unadjusted.parquet")["code"].n_unique(),
                 derive_ms=derive_ms, now_ms=now_ms)

    impact = build_impact_report(sdir, old_path=old_path) if old_path.exists() else {"changed_codes": 0}
    return {"reconcile": rec, "factors_added": added, "impact": impact}


async def run_backfill(data_dir: Path) -> dict:
    """프로덕션 진입: KIS 클라이언트로 fetch_adj/fetch_raw 를 묶어 run_backfill_with 실행."""
    from datetime import datetime

    from hoga.live import kis_access
    from hoga.live.kis_capacity_runtime import ensure_kis_capacity_scheduler
    from hoga.live.kis_client import KIS_KST

    sdir = data_dir / "screener"
    # 전체 백필도 배경 배치이므로 Capacity Scheduler에 맡긴다. creds 게이트만 먼저
    # 유지해서 기존처럼 백필은 조용히 skip하지 않고 loud fail 한다.
    if not kis_access.has_rest_capacity(data_dir):
        raise RuntimeError("KIS creds missing (KIS_APP_KEY/SECRET) — cannot backfill")
    scheduler = ensure_kis_capacity_scheduler(data_dir)

    async def fetch_adj(code: str, frm: str, to: str):
        async def _do(client):
            res = await client.fetch_past_daily_candles(code, frm, to, adjust=True)   # 수정주가
            return [(datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).date(), float(c.close))
                    for c in res.candles]
        return await kis_access.run_with_capacity(
            scheduler,
            data_dir=data_dir,
            key=("screener-backfill-adj", code, frm, to),
            endpoint=kis_access.KisRestEndpoint.SCREENER_DAILY,
            priority="background",
            cooldown_scope="screener-daily",
            fetch_fn=_do,
        )

    async def fetch_raw(code: str, frm: str, to: str):
        async def _do(client):
            res = await client.fetch_past_daily_candles(code, frm, to, adjust=False)  # 원주가
            return [DailyBar(code, datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).date(),
                             float(c.open), float(c.high), float(c.low), float(c.close), c.volume)
                    for c in res.candles]
        return await kis_access.run_with_capacity(
            scheduler,
            data_dir=data_dir,
            key=("screener-backfill-raw", code, frm, to),
            endpoint=kis_access.KisRestEndpoint.SCREENER_DAILY,
            priority="background",
            cooldown_scope="screener-daily",
            fetch_fn=_do,
        )

    return await run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw)
