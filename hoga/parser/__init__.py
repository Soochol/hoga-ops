"""Stock-Date TSV → typed Parquet orchestrator."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import assert_never

from hoga.api.disk_state import analyze_gaps
from hoga.api.timeenc import HogaMs
from hoga.collector.orchestrator import raw_pages
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
    for page_path in raw_pages(raw_dir):
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

    Returns the output directory (data/parquet/{date}/{code}/hogaplay).

    Writes under the `hogaplay/` subdir per the ADR-0037 v2 layout. The
    flat `{date}/{code}/` path is invisible to `_resolve_source` once a
    second source (`kis_live`) co-exists on the same day — the resolver
    only scans subdirectories, so a flat-layout capture silently falls
    through to `kis_live`, whose candles.parquet doesn't exist by design.
    """
    raw_dir = data_dir / "raw" / date / code
    out_dir = data_dir / "parquet" / date / code / "hogaplay"
    # mkdir deferred until after parsing + validation succeed: an upstream-empty
    # or malformed raw set otherwise leaves an empty hogaplay/ dir that
    # `resolve_source` cannot distinguish from a real capture, so /api/orderbook
    # and /api/brokers/series 404 instead of returning ADR-0044's graceful empty.

    info_text = (raw_dir / "info.tsv").read_text(encoding="utf-8").strip()
    info = parse_info_row(info_text)

    # 컬럼형 고속 경로 (hoga.parser.frames): type-1/2는 polars 벡터 파싱,
    # 그 외·의심 라인은 python parse_row 폴백 — strict/lenient 오류 의미론
    # 바이트 동일. 리스트 경로(_collect_events)는 폴백·오라클로 상존한다.
    from hoga.parser.frames import collect_event_frames
    collected = collect_event_frames(raw_dir, lenient=lenient)
    skipped = collected.skipped
    brokers_list = collected.brokers
    snapshots_df = collected.snapshots
    # Drop hogaplay page re-send duplicates (continuous trades re-sent with fresh
    # seqs, so seq-dedup misses them). Runs BEFORE validate so the strict cum_vol
    # check passes for dates whose only anomaly was the overlap — no lenient
    # fallback needed — and before write_parquet so the 체결강도 bucket isn't
    # double-counted. No-op for clean dates. See trades.dedup_overlap_resends_frame.
    trades_df = trades.dedup_overlap_resends_frame(collected.trades)

    candles_list = _collect_candles(raw_dir, skipped=skipped, lenient=lenient)

    # Per-table validation: trades/snapshots는 컬럼형(validate_frame — 동일
    # 예외 클래스·메시지), brokers/candles는 invariant 미정의(리스트 경로와 동일).
    trades.validate_frame(trades_df, lenient=lenient)
    snapshots.validate_frame(snapshots_df, lenient=lenient)

    out_dir.mkdir(parents=True, exist_ok=True)
    trades.write_parquet_frame(trades_df, out_dir / "trades.parquet")
    snapshots.write_parquet_frame(snapshots_df, out_dir / "snapshots.parquet")
    brokers.write_parquet(brokers_list, out_dir / "brokers.parquet")
    candles.write_parquet(candles_list, out_dir / "candles.parquet")

    meta = _build_meta(
        info=info,
        unique_event_count=collected.unique_event_count,
        skipped=skipped,
        raw_dir=raw_dir,
        snapshot_ts_ms=snapshots_df["ts_ms"].to_list(),
    )

    # ADR-0020 archival hook — record violations at write time. Meta-level
    # violations are also re-evaluated live by read-paths (self-healing).
    # Series-level violations are archival-only (ADR-0020 §3c) — read-paths
    # trust this field rather than re-loading parquet on every request.
    from hoga.api.invariants import (
        StockDateArtifacts,
        check as _check_meta,
        check_series as _check_series,
    )
    _all_violations = _check_meta(meta) + _check_series(StockDateArtifacts(
        meta=meta,
        candles=candles_list,
        snapshot_ts_ms=snapshots_df["ts_ms"].to_list(),
        trades_frame=trades_df,
    ))
    if _all_violations:
        meta["invariant_violations"] = [v.as_dict() for v in _all_violations]

    # Full Capture Count (CONTEXT.md) + Identical Capture Count (ADR-0093):
    # read prior meta ONCE and derive both counters.
    # Race-safe under the single-process precondition documented at
    # hoga/api/captures.py:69 — the capture queue's `_inflight_paths`
    # set (guarded by `_lock`) serializes same-(code,date) jobs within
    # one worker process. Multi-worker uvicorn would lose this guarantee.
    prior_path = out_dir / "meta.json"
    prior_meta: dict[str, object] | None = None
    if prior_path.exists():
        try:
            prior_meta = json.loads(prior_path.read_text(encoding="utf-8"))
        # ValueError subsumes json.JSONDecodeError AND UnicodeDecodeError
        # (raised by read_text on non-UTF-8 bytes). OSError covers I/O failures.
        except (OSError, ValueError) as exc:
            # Don't silently reset a counter that may have been at 47.
            # Surface the corruption so an operator can investigate;
            # treat as legacy=0 only after warning.
            logging.getLogger("hoga.parser").warning(
                "corrupt prior meta.json at %s — resetting capture counters: %s",
                prior_path, exc,
            )
            prior_meta = None

    prior_count = 0
    if prior_meta is not None:
        prior_value = prior_meta.get("full_capture_count")
        # Reject bool: True/False would silently pass isinstance(_, int).
        if (
            isinstance(prior_value, int)
            and not isinstance(prior_value, bool)
            and prior_value >= 1
        ):
            prior_count = prior_value
    meta["full_capture_count"] = prior_count + 1
    meta["identical_capture_count"] = _identical_capture_count(prior_meta, meta)

    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return out_dir


# NOTE: 리스트 경로(_collect_events + 테이블 validate/write 리스트 함수들)는
# 컬럼형 고속 경로(hoga.parser.frames)의 폴백 파서(parse_row)가 기대는 기준
# 구현이자 차등 테스트(test_parser_frames_oracle)의 오라클로 상존한다.
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



def _capture_fingerprint(meta: dict[str, object]) -> tuple:
    """Result fingerprint used to decide "same capture again" (ADR-0093).

    ``(total_unique_events, pages_collected, gap_ranges)`` — if all three match
    the prior capture AND both completed collection, the re-capture reproduced
    the identical (gappy) result, which confirms the gap is upstream-missing
    rather than a transient collection failure. gap_ranges is included so a
    same-event-count capture that filled a different window still counts as
    "changed".
    """
    return (
        meta.get("total_unique_events"),
        meta.get("pages_collected"),
        meta.get("gap_ranges"),
    )


def _identical_capture_count(
    prior_meta: dict[str, object] | None, meta: dict[str, object],
) -> int:
    """How many consecutive completed captures produced the identical result
    (ADR-0093). Starts at 1; increments only when the prior capture also
    completed AND its fingerprint matches — so a healed upstream (different
    result) resets it to 1. ``>= 2`` means at least one full re-capture
    reproduced the same gaps → upstream-gap confirmed.
    """
    if prior_meta is None:
        return 1
    if not (bool(prior_meta.get("collection_complete")) and bool(meta.get("collection_complete"))):
        return 1
    if _capture_fingerprint(prior_meta) != _capture_fingerprint(meta):
        return 1
    prior_ic = prior_meta.get("identical_capture_count")
    if isinstance(prior_ic, int) and not isinstance(prior_ic, bool) and prior_ic >= 1:
        return prior_ic + 1
    # Prior existed and matched but predates the counter (legacy) — this is the
    # 2nd identical result we can prove.
    return 2


def _build_meta(
    *,
    info: StockInfo,
    unique_event_count: int,
    skipped: list[tuple[str, int, str]],
    raw_dir: Path,
    snapshot_ts_ms: list[int],
) -> dict[str, object]:
    pages = raw_pages(raw_dir)
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
    # One analyze_gaps pass yields both is_partial (the boolean gate) and the
    # gap boundary ranges surfaced to the user (WS1 / ADR upstream-gap).
    # anchor_edges=True (ADR-0126): identical to the live promote path
    # (promote._completeness_fields) so a hogaplay capture that started late or
    # ended early — e.g. next-morning collection past the ~18h upstream window,
    # losing the AM session — is flagged by the session-edge anchors even with
    # no interior gap. Previously omitted (default False), which let a leading
    # gap slip through as COMPLETE and mis-rank completeness_first.
    gaps = analyze_gaps(
        [HogaMs(ts) for ts in snapshot_ts_ms],
        session_close_ms=HogaMs(info.regular_session_close_ms),
        anchor_edges=True,
    )
    is_partial = gaps.is_partial
    gap_ranges = [
        {"start_ms": int(start), "end_ms": int(end)}
        for start, end in gaps.gap_ranges
    ]

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
        "total_unique_events": unique_event_count,
        "parser_version": PARSER_VERSION,
        "warnings": [{"file": f, "line": ln, "reason": r} for f, ln, r in skipped],
        "collection_complete": collection_complete,
        "is_partial": is_partial,
        # WS1: continuous-trading gap boundaries in HHMMSSmmm (HogaMs), so the
        # inventory drawer can show WHICH windows are missing. Empty when the
        # stream is dense (or too sparse — is_partial then rides the count rule).
        "gap_ranges": gap_ranges,
    }
