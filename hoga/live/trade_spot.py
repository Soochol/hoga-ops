"""Bounded candle-range reads: original hogaplay ticks or observed WS seconds.

Source selection is day-scoped, never dependent on the hovered bucket's row count.
Legacy 10-second rows cannot reconstruct event boundaries and are not tape input.
"""
from __future__ import annotations

import hashlib
import json
import os
from itertools import islice
from pathlib import Path

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.models import TradeSpotResponse, TradeSpotRow
from hoga.api.sources import ordered_sources, source_covers_venue, source_venue_dir
from hoga.duck import connect_bounded
from hoga.util.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms

from .second_trade_agg import SecondTradeBar
from .second_trade_store import second_trade_store


def _meta(path: Path) -> dict:
    target = path / "meta.json"
    return json.loads(target.read_text()) if target.is_file() else {}


def _identity(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_ino}:{stat.st_mtime_ns}:{stat.st_size}"


def _seconds(root: Path, code: str, venue: str, date: str, snapshot: dict) -> dict:
    merged = {r["t_ms"]: r for r in second_trade_store(root).disk_rows(code, venue, date)}
    for row in snapshot.get("live", []):
        old = merged.get(row["t_ms"])
        if old is None or row["revision"] >= old["revision"]:
            merged[row["t_ms"]] = row
    for correction in snapshot.get("pending", []):
        trade, seq = correction["trade"], correction["seq"]
        t = trade["t_ms"] // 1000 * 1000
        bar = SecondTradeBar.restore(merged[t]) if t in merged else SecondTradeBar(t)
        if seq > bar.applied_late_seq:
            bar.ingest(seq=seq, **trade)
            bar.applied_late_seq = seq
            merged[t] = bar.record()
    return merged


def _hogaplay(root: Path, path: Path, date: str, start: int, end: int,
              amount: int, limit: int, offset: int) -> tuple[list[TradeSpotRow], str, int | None]:
    before = _identity(path)
    # End can be the next KST midnight, which is outside date's encoder domain.
    last_ms = unix_ms_to_hhmmssms(date, end - 1) + 1
    con = connect_bounded(temp_directory=root / "duckdb-tmp")
    try:
        threads = os.environ.get("HOGA_COMPUTE_DUCKDB_THREADS", "")
        if threads.isdigit() and int(threads) > 0:
            con.execute(f"SET threads TO {int(threads)}")
        rows = con.execute(
            "SELECT ts_ms, seq, price, qty, side FROM read_parquet(?) "
            "WHERE ts_ms >= ? AND ts_ms < ? AND price > 0 AND qty > 0 "
            "AND side IN (-1, 0, 1) AND CAST(price AS BIGINT) * qty >= ? "
            "ORDER BY ts_ms DESC, seq DESC LIMIT ? OFFSET ?",
            [str(path), unix_ms_to_hhmmssms(date, start), last_ms, amount * 10_000, limit + 1, offset],
        ).fetchall()
        previous = con.execute(
            "SELECT max(ts_ms) FROM read_parquet(?) WHERE ts_ms < ? AND price > 0 AND qty > 0 "
            "AND side IN (-1, 0, 1) AND CAST(price AS BIGINT) * qty >= ?",
            [str(path), unix_ms_to_hhmmssms(date, start), amount * 10_000],
        ).fetchone()[0]
    finally:
        con.close()
    if before != _identity(path):
        raise ValueError("체결 데이터가 교체되었습니다. 다시 조회하세요")
    return [TradeSpotRow(event_id=f"hogaplay:{r[0]}:{r[1]}", t_ms=hhmmssms_to_unix_ms(date, r[0]),
                         price=r[2], qty=r[3], side=r[4], count=1) for r in rows], before, (
                             hhmmssms_to_unix_ms(date, previous) if previous is not None else None)


def read_trade_spot(root: Path, params: dict, snapshot: dict) -> TradeSpotResponse:
    code, date, venue = (params[k] for k in ("code", "date", "venue"))
    start, end, limit, offset = (params[k] for k in ("from_ms", "to_ms", "limit", "offset"))
    sd = root / "parquet" / date / code
    result = TradeSpotResponse(
        code=code, date=date, venue=venue, source_pref=params["source_pref"], from_ms=start, to_ms=end,
        source=None, representation=None, status="unavailable", rows=[], prev_close=None,
        revision="missing", has_more=False,
    )
    legacy = False
    for source in ordered_sources(params["source_pref"]):
        if not source_covers_venue(source, venue):
            continue
        path = source_venue_dir(sd, source, venue)
        meta = _meta(path)
        if meta and classify_from_meta(meta).state == DiskState.INVALID:
            continue
        if source == "hogaplay":
            target = path / "trades.parquet"
            if not target.is_file():
                continue
            rows, revision, previous = _hogaplay(root, target, date, start, end,
                                        params["min_amount_manwon"], limit, offset)
            result.previous_observed_ms = previous
            result.representation = "ticks"
        else:
            merged = _seconds(root, code, venue, date, snapshot)
            legacy = (path / "trades.parquet").is_file()
            if not merged:
                if snapshot.get("error"):
                    raise ValueError("WS 체결 저장 상태를 확인할 수 없습니다")
                continue
            selected = {t: row for t, row in merged.items() if start <= t < end}
            result.previous_observed_ms = max((t for t, row in merged.items() if t < start
                and any(p > 0 and qty > 0 for p, _side, qty, _count in row["prices"])), default=None)
            # Changes outside this range cannot invalidate its pagination.
            revision = hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            items = (TradeSpotRow(event_id=f"ws-second:{t}:{p}:{side}", t_ms=t,
                                 price=p, side=side, qty=qty, count=count)
                    for t, row in sorted(selected.items(), reverse=True)
                    for p, side, qty, count in sorted(row["prices"])
                    if p > 0 and qty > 0)
            rows = list(islice(items, offset, offset + limit + 1))
            result.representation = "second_price_aggregate"
            result.storage_error = snapshot.get("error")
        previous = meta.get("prev_close")
        result.prev_close = previous if type(previous) is int and previous > 0 else None
        result.source = source
        result.rows = rows[:limit]
        result.has_more = len(rows) > limit
        result.status = "observed" if rows else "empty"
        result.revision = revision
        return result
    if legacy:
        result.status = "insufficient_resolution"
    return result
