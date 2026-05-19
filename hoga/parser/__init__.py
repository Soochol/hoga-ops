"""Stock-Date TSV → typed Parquet orchestrator."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path

from hoga.parser.events import BrokerRow, Candle, Orderbook, StockInfo, Trade
from hoga.parser.tsv import (
    FieldCountError,
    parse_candle_row,
    parse_info_row,
    parse_row,
)
from hoga.parser.writer import (
    write_brokers_parquet,
    write_candles_parquet,
    write_snapshots_parquet,
    write_trades_parquet,
)

PARSER_VERSION = "0.1.0"


class ParserError(RuntimeError):
    """Raised on strict-mode validation failures."""


def _iter_first_lines(raw_dir: Path) -> Iterable[tuple[Path, int, str]]:
    for page_path in sorted(raw_dir.glob("first_*.tsv")):
        text = page_path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(keepends=False), start=1):
            if not line:
                continue
            yield page_path, lineno, line


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

    trades, snapshots, brokers, seen_seqs, skipped = _collect_events(raw_dir, lenient=lenient)

    _validate_trades_monotonic(trades, lenient=lenient)
    _validate_snapshot_price_order(snapshots, lenient=lenient)

    candles = _collect_candles(raw_dir, skipped=skipped, lenient=lenient)

    write_trades_parquet(trades, out_dir / "trades.parquet")
    write_snapshots_parquet(snapshots, out_dir / "snapshots.parquet")
    write_brokers_parquet(brokers, out_dir / "brokers.parquet")
    write_candles_parquet(candles, out_dir / "candles.parquet")

    meta = _build_meta(info=info, seen_seqs=seen_seqs, skipped=skipped, raw_dir=raw_dir)
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
    trades: list[Trade] = []
    snapshots: list[Orderbook] = []
    brokers: list[BrokerRow] = []
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

        if parsed is None:
            # Price-tick / heartbeat — no structured data to retain.
            continue

        if isinstance(parsed, list):
            _add_broker_rows(parsed, brokers=brokers, seen_seqs=seen_seqs)
            continue

        if parsed.seq in seen_seqs:
            continue
        seen_seqs.add(parsed.seq)
        if isinstance(parsed, Trade):
            trades.append(parsed)
        elif isinstance(parsed, Orderbook):
            snapshots.append(parsed)

    return trades, snapshots, brokers, seen_seqs, skipped


def _add_broker_rows(
    parsed: list[BrokerRow],
    *,
    brokers: list[BrokerRow],
    seen_seqs: set[int],
) -> None:
    """Dedup broker rows by seq and append to brokers list."""
    sample_seq = parsed[0].seq if parsed else None
    if sample_seq is not None and sample_seq in seen_seqs:
        return
    if sample_seq is not None:
        seen_seqs.add(sample_seq)
    brokers.extend(parsed)


def _collect_candles(
    raw_dir: Path,
    *,
    skipped: list[tuple[str, int, str]],
    lenient: bool,
) -> list[Candle]:
    candles: list[Candle] = []
    chart_path = raw_dir / "chart.tsv"
    if not chart_path.exists():
        return candles
    for line in chart_path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        try:
            candles.append(parse_candle_row(line))
        except (FieldCountError, ValueError) as e:
            if lenient:
                skipped.append(("chart.tsv", 0, str(e)))
                continue
            raise ParserError(f"chart.tsv: {e}") from e
    return candles


def _validate_trades_monotonic(trades: list[Trade], *, lenient: bool) -> None:
    """cum_vol must be non-decreasing across continuous-trading (side != 0) rows.

    Auction Cross trades (side == 0 — opening/closing/pre-market single-price
    matchings) carry cum_vol = 0 and are excluded from this check; their volume
    is folded into the next continuous trade.
    """
    sorted_trades = sorted(
        (t for t in trades if t.side != 0),
        key=lambda t: t.ts_ms,
    )
    prev = -1
    for t in sorted_trades:
        if t.cum_vol < prev:
            msg = f"cum_vol decreased at seq={t.seq}: {prev} -> {t.cum_vol}"
            if lenient:
                continue
            raise ParserError(msg)
        prev = t.cum_vol


def _validate_snapshot_price_order(snapshots: list[Orderbook], *, lenient: bool) -> None:
    for ob in snapshots:
        nz_ask = [p for p in ob.ask_p if p > 0]
        if nz_ask != sorted(nz_ask):
            msg = f"ask prices not sorted at seq={ob.seq}: {nz_ask}"
            if lenient:
                continue
            raise ParserError(msg)
        nz_bid = [p for p in ob.bid_p if p > 0]
        if nz_bid != sorted(nz_bid, reverse=True):
            msg = f"bid prices not sorted at seq={ob.seq}: {nz_bid}"
            if lenient:
                continue
            raise ParserError(msg)


def _build_meta(
    *,
    info: StockInfo,
    seen_seqs: set[int],
    skipped: list[tuple[str, int, str]],
    raw_dir: Path,
) -> dict[str, object]:
    pages = sorted(raw_dir.glob("first_*.tsv"))
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
    }
