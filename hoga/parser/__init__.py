"""Stock-Date TSV → typed Parquet orchestrator."""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import assert_never

from hoga.api.disk_state import has_meaningful_gaps
from hoga.api.timeenc import HogaMs
from hoga.collector.orchestrator import page_sort_key
from hoga.tables import brokers, candles, snapshots, trades
from hoga.tables.brokers import BrokerRow
from hoga.tables.candles import Candle
from hoga.tables.dispatch import FieldCountError, parse_row, split_row
from hoga.tables.snapshots import Orderbook
from hoga.tables.trades import Trade

PARSER_VERSION = "0.1.0"

INFO_MIN_FIELDS = 22


@dataclass(frozen=True)
class StockInfo:
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    prev_close: int
    upper_limit: int
    lower_limit: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    raw_line: str
    unknowns: dict[str, str]


def parse_info_row(line: str) -> StockInfo:
    parts = split_row(line)
    if len(parts) < INFO_MIN_FIELDS:
        raise FieldCountError(f"info row expects >={INFO_MIN_FIELDS} fields, got {len(parts)}")
    unknowns = {
        "f11": parts[10],
        "f16": parts[15],
        "f17": parts[16],
        "f21": parts[20],
        "f22": parts[21],
    }
    return StockInfo(
        code=parts[1],
        name=parts[2],
        regular_session_open_ms=int(parts[4]),
        regular_session_close_ms=int(parts[5]),
        prev_close=int(parts[11]),
        upper_limit=int(parts[12]),
        lower_limit=int(parts[13]),
        today_open=int(parts[14]),
        today_high=int(parts[17]),
        today_low=int(parts[18]),
        today_close=int(parts[19]),
        raw_line=line.rstrip("\n"),
        unknowns=unknowns,
    )


class ParserError(RuntimeError):
    """Raised on strict-mode validation failures."""


def _iter_first_lines(raw_dir: Path) -> Iterable[tuple[Path, int, str]]:
    # Numeric sort: lexical sort breaks past page index 999 (`first_1000.tsv`
    # alphabetically precedes `first_997.tsv`), corrupting dedup-first-wins
    # ordering and ultimately breaking trades.validate cum_vol monotonicity.
    for page_path in sorted(raw_dir.glob("first_*.tsv"), key=page_sort_key):
        text = page_path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(keepends=False), start=1):
            if not line:
                continue
            yield page_path, lineno, line


def _iter_chart_lines(raw_dir: Path) -> Iterable[tuple[Path, int, str]]:
    chart_path = raw_dir / "chart.tsv"
    if not chart_path.exists():
        return
    text = chart_path.read_text(encoding="utf-8")
    for lineno, line in enumerate(text.splitlines(keepends=False), start=1):
        if not line:
            continue
        yield chart_path, lineno, line


def parse_stock_date(
    *,
    code: str,
    date: str,
    data_dir: Path,
    lenient: bool = False,
) -> Path:
    """Parse one Stock-Date's raw TSV into Parquet + meta.json.

    Returns the output directory (data/parquet/{date}/{code}).
    """
    raw_dir = data_dir / "raw" / date / code
    out_dir = data_dir / "parquet" / date / code
    out_dir.mkdir(parents=True, exist_ok=True)

    info_text = (raw_dir / "info.tsv").read_text(encoding="utf-8").strip()
    info = parse_info_row(info_text)

    trades_list, snapshots_list, brokers_list, seen_seqs, skipped = _collect_events(
        raw_dir, lenient=lenient
    )

    candles_list = _collect_candles(raw_dir, skipped=skipped, lenient=lenient)

    # Per-table validation registry: a table module participates by exporting
    # ``validate(entities, *, lenient: bool) -> None``. Tables without
    # invariants (brokers, candles) simply don't define it.
    for table_mod, entities in (
        (trades, trades_list),
        (snapshots, snapshots_list),
        (brokers, brokers_list),
        (candles, candles_list),
    ):
        validate = getattr(table_mod, "validate", None)
        if validate is not None:
            validate(entities, lenient=lenient)

    trades.write_parquet(trades_list, out_dir / "trades.parquet")
    snapshots.write_parquet(snapshots_list, out_dir / "snapshots.parquet")
    brokers.write_parquet(brokers_list, out_dir / "brokers.parquet")
    candles.write_parquet(candles_list, out_dir / "candles.parquet")

    meta = _build_meta(
        info=info,
        seen_seqs=seen_seqs,
        skipped=skipped,
        raw_dir=raw_dir,
        snapshots_list=snapshots_list,
    )

    # ADR-0020 archival hook — record the violations list at write time for
    # diagnostics. Read-paths re-evaluate live from the same catalog, so this
    # field is not load-bearing; absent when there are no violations to record
    # (healthy meta stays clean).
    from hoga.api.invariants import check as _check_invariants
    _violations = _check_invariants(meta)
    if _violations:
        meta["invariant_violations"] = [v.as_dict() for v in _violations]

    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return out_dir


def _collect_events(
    raw_dir: Path,
    *,
    lenient: bool,
) -> tuple[
    list[Trade],
    list[Orderbook],
    list[BrokerRow],
    set[int],
    list[tuple[str, int, str]],
]:
    seen_seqs: set[int] = set()
    trades_list: list[Trade] = []
    snapshots_list: list[Orderbook] = []
    brokers_list: list[BrokerRow] = []
    skipped: list[tuple[str, int, str]] = []

    for page_path, lineno, line in _iter_first_lines(raw_dir):
        try:
            parsed = parse_row(line)
        except (FieldCountError, ValueError) as e:
            msg = f"{page_path.name}:{lineno} {e}"
            if lenient:
                skipped.append((page_path.name, lineno, str(e)))
                continue
            raise ParserError(msg) from e

        match parsed:
            case None:
                # Price-tick / heartbeat — no structured data to retain.
                continue
            case list():
                _add_broker_rows(parsed, brokers_list=brokers_list, seen_seqs=seen_seqs)
            case Trade() if parsed.seq not in seen_seqs:
                seen_seqs.add(parsed.seq)
                trades_list.append(parsed)
            case Orderbook() if parsed.seq not in seen_seqs:
                seen_seqs.add(parsed.seq)
                snapshots_list.append(parsed)
            case Trade() | Orderbook():
                # Duplicate seq — drop.
                continue
            case _:
                assert_never(parsed)

    return trades_list, snapshots_list, brokers_list, seen_seqs, skipped


def _add_broker_rows(
    parsed: list[BrokerRow],
    *,
    brokers_list: list[BrokerRow],
    seen_seqs: set[int],
) -> None:
    """Dedup broker rows by seq and append to brokers list."""
    sample_seq = parsed[0].seq if parsed else None
    if sample_seq is not None and sample_seq in seen_seqs:
        return
    if sample_seq is not None:
        seen_seqs.add(sample_seq)
    brokers_list.extend(parsed)


def _collect_candles(
    raw_dir: Path,
    *,
    skipped: list[tuple[str, int, str]],
    lenient: bool,
) -> list[Candle]:
    candles_list: list[Candle] = []
    for chart_path, lineno, line in _iter_chart_lines(raw_dir):
        try:
            candles_list.append(candles.parse_row(line))
        except (FieldCountError, ValueError) as e:
            if lenient:
                skipped.append((chart_path.name, lineno, str(e)))
                continue
            raise ParserError(f"{chart_path.name}:{lineno} {e}") from e
    return candles_list


def _snapshot_ts_hhmmssms(snapshots: list[Orderbook]) -> list[HogaMs]:
    """Extract HHMMSSmmm timestamps from Orderbook entities (encoding seam).

    Orderbook.ts_ms is stored as plain ``int`` on the entity for now (entity-
    level HogaMs adoption is a separate sweep). This helper is the single
    place where the encoding is asserted by casting to HogaMs, so any future
    schema drift surfaces here rather than silently breaking has_meaningful_gaps.
    """
    return [HogaMs(s.ts_ms) for s in snapshots]


def _build_meta(
    *,
    info: StockInfo,
    seen_seqs: set[int],
    skipped: list[tuple[str, int, str]],
    raw_dir: Path,
    snapshots_list: list[Orderbook],
) -> dict[str, object]:
    pages = sorted(raw_dir.glob("first_*.tsv"), key=page_sort_key)
    progress_path = raw_dir / "_progress.json"
    collection_complete = False
    if progress_path.exists():
        try:
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            collection_complete = bool(progress.get("finished", False))
        except (ValueError, OSError):
            collection_complete = False

    # Encoding seam: Orderbook.ts_ms is HHMMSSmmm (entity native); cast to
    # HogaMs at this single extraction point so future entity changes break
    # here loudly rather than silently producing wrong is_partial values.
    is_partial = has_meaningful_gaps(_snapshot_ts_hhmmssms(snapshots_list))

    return {
        "code": info.code,
        "name": info.name,
        "regular_session_open_ms": info.regular_session_open_ms,
        "regular_session_close_ms": info.regular_session_close_ms,
        "prev_close": info.prev_close,
        "upper_limit": info.upper_limit,
        "lower_limit": info.lower_limit,
        "today_open": info.today_open,
        "today_high": info.today_high,
        "today_low": info.today_low,
        "today_close": info.today_close,
        "info_unknowns": info.unknowns,
        "raw_info_tsv": info.raw_line,
        "pages_collected": len(pages),
        "total_unique_events": len(seen_seqs),
        "parser_version": PARSER_VERSION,
        "warnings": [{"file": f, "line": ln, "reason": r} for f, ln, r in skipped],
        "collection_complete": collection_complete,
        "is_partial": is_partial,
    }
