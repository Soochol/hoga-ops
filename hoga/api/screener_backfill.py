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
