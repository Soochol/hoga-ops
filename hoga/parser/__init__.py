"""Stock-Date TSV → typed Parquet orchestrator."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import assert_never

from hoga.api.disk_state import analyze_gaps
from hoga.collector.orchestrator import raw_pages
from hoga.tables import brokers, candles, snapshots, trades
from hoga.tables.brokers import BrokerRow
from hoga.tables.candles import Candle
from hoga.tables.dispatch import FieldCountError, parse_row, split_row
from hoga.tables.snapshots import Orderbook
from hoga.tables.trades import Trade
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import HogaMs

PARSER_VERSION = "0.2.0"

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
    """hogaplay `info.tsv` 한 줄 → :class:`StockInfo`.

    **위치 인덱스 표 (0-based `parts` / 괄호는 1-based hogaplay 필드번호)**::

        11 (f12) 당일 시가      15 (f16) 상한가      18 (f19) 전일 시가
        12 (f13) 당일 고가      16 (f17) 하한가      19 (f20) 전일 고가
        13 (f14) 당일 저가      17 (f18) 기준가      20 (f21) 전일 저가
        14 (f15) 당일 종가                           21 (f22) 전일 종가

    이 표는 **추측이 아니라 실측이다**(2026-08-12, 디스크의 raw info 행 1,869건):

    - OHLC 불변식(`high >= low`, `high >= open/close`, `low <= open/close`)이
      11~14 에서 **0건 위반**, 18~21 에서도 0건 위반.
    - 상·하한가는 기준가(17)의 ±30% 를 호가단위로 반올림한 값 — 퇴화행(전 필드 0)
      429건을 뺀 **1,440건 전부**가 일치.
    - 11~14·18~21 을 KIS 원주가 일봉(`daily_unadjusted.parquet`)의 당일/전일
      OHLC 와 대조해 각 인덱스가 해당 축에서 최다 매칭.

    ⚠ **두 블록 모두 "확정값" 이 아니라 스냅샷이다.** 캡처 시점의 값이 실린다:

    - 11~14 는 info 행을 뜬 **그 순간의** 시/고/저/**현재가**다. 종가가 아니다 —
      장 종료 후 캡처(1,538건)는 일봉 종가와 일치하지만 장초반 캡처(333건,
      종료시각 중앙값 09:08)는 어긋난다. 그 불일치는 결함이 아니다.
    - 18~21 도 마찬가지로 stale 할 수 있다. 실측 23건에서 전일 시가는 맞는데
      고가는 낮고 저가는 높고 종가는 어긋났다 — 전일 **장중** 스냅샷의 지문이다.
      그래서 ``prev_close`` 는 21 이 아니라 **기준가(17)** 를 쓴다. 둘이 갈리는
      비퇴화 23건에서 17 이 일봉 전일 종가와 **23:0** 으로 일치했다.

    18~21(전일 OHLC)은 위 stale 위험 때문에 필드로 노출하지 않는다. 필요하면
    ``raw_info_tsv`` 가 원문을 통째로 보존하므로 거기서 다시 판단할 것.
    """
    parts = split_row(line)
    if len(parts) < INFO_MIN_FIELDS:
        raise FieldCountError(f"info row expects >={INFO_MIN_FIELDS} fields, got {len(parts)}")
    # 아직 이름을 못 붙인 필드만 남긴다. f16·f17·f21·f22 는 위 표로 확정돼
    # 빠졌다(f21·f22 = 전일 저가·종가는 확정됐지만 stale 위험 때문에 미노출).
    # f10(parts[9])은 거래량으로 보이나 장 종료 후 캡처 1,558건 중 1,192건만
    # 일봉 거래량과 일치해 단정하지 않는다.
    unknowns = {"f11": parts[10]}
    return StockInfo(
        code=parts[1],
        name=parts[2],
        regular_session_open_ms=int(parts[4]),
        regular_session_close_ms=int(parts[5]),
        prev_close=int(parts[17]),
        upper_limit=int(parts[15]),
        lower_limit=int(parts[16]),
        today_open=int(parts[11]),
        today_high=int(parts[12]),
        today_low=int(parts[13]),
        today_close=int(parts[14]),
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
    second source (a live promotion) co-exists on the same day — the resolver
    only scans subdirectories, so a flat-layout capture silently falls through
    to that promotion, which may carry no candles.parquet at all.
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
    from hoga.parser.frames import (  # noqa: PLC0415 — 지연 import(순환/heavy)
        collect_event_frames,
    )
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
    from hoga.api.invariants import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
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

    # 원자적 쓰기 필수: meta.json 은 분류 SSOT 이면서 **캡처 완료 신호**다 —
    # inotify watchdog 이 이 파일의 등장을 inventory_added 트리거로 쓴다
    # (hoga/api/events.py). write_text 는 먼저 truncate 하므로 디스크가 꽉 차면
    # 잘린 meta 가 그 자리에 남고, 그건 곧 잘못된 완료 이벤트다.
    atomic_write_json(out_dir / "meta.json", meta)
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
    # hogaplay 는 KRX 전용 업스트림이므로(ADR-0003) 하한이 정규장 개장이다 —
    # venue 축을 타지 않는 유일한 소비자라 값을 여기서 명시한다.
    gaps = analyze_gaps(
        [HogaMs(ts) for ts in snapshot_ts_ms],
        session_open_ms=HogaMs(info.regular_session_open_ms),
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
