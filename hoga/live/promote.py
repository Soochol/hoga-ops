"""Live Capture JSONL → captures Parquet conversion (ADR-0038 cold path).

This module IS allowed to import polars/pyarrow — it's the cold-path
converter that runs at 17:00 KST after Live Session ends, not the hot
write path. The hot path (writer.py, stream.py) must stay polars-free.

Idempotency: presence of {target}/meta.json marks this (date, code) as
already promoted; subsequent calls skip silently.

Partial-line tolerance: a JSONL line that fails to parse is logged and
skipped. This handles the case where a crash mid-cycle left a torn last
line on disk — per ADR-0038 the rest of the file is still recoverable.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from hoga.api.disk_state import analyze_gaps
from hoga.api.timeenc import HogaMs, unix_ms_to_hhmmssms
from hoga.tables.brokers import BrokerRow
from hoga.tables.brokers import write_parquet as write_brokers_parquet
from hoga.tables.fills import Fill, write_fills_parquet
from hoga.tables.snapshots import Orderbook
from hoga.tables.snapshots import write_parquet as write_snapshots_parquet
from hoga.tables.trades import Trade
from hoga.tables.trades import write_parquet as write_trades_parquet

_ZERO_LEVELS: tuple[int, ...] = (0,) * 10

# Live promotions hardcode the Regular Session boundaries (09:00 / 15:30). This
# mirrors the existing `_build_meta` constants and the promote-path assumption
# that KIS live capture only runs the Regular Session — Half-Day sessions are a
# known, pre-existing limitation shared with the rest of this module.
_REGULAR_SESSION_CLOSE_MS: HogaMs = HogaMs(153000000)  # 15:30:00.000 (HHMMSSmmm)
_KST = timezone(timedelta(hours=9))
# Session close 15:30 + 5-min settle buffer: the first Today-Promoter cycle at or
# after 15:35 KST finalizes today's meta to collection_complete=True.
_SESSION_FINALIZE_HHMM: tuple[int, int] = (15, 35)

_log = logging.getLogger(__name__)


def _collection_finished(date: str, *, now: datetime | None = None) -> bool:
    """Time-based completeness verdict for a live (kis_live/kis_api) promotion.

    A live stream has no ``_progress.json`` cursor (that's hogaplay's finished
    flag), so "did collection finish" is decided by the clock instead:

    - ``date < today_kst`` → True: a past day's stream has ended; whatever was
      captured is final (its data-quality is carried separately by is_partial).
    - ``date == today_kst`` → True only once KST is at/after 15:35 (Regular
      Session close 15:30 + a 5-min settle buffer). Intraday cycles return
      False → the Stock-Date stays CLIENT_INCOMPLETE, so an early COMPLETE flip
      can't make the hogaplay worker skip today as ``already_complete``.
    - ``date > today_kst`` → False (conservative; e.g. a midnight-race jsonl).

    ``now`` is injectable for tests; production reads the KST wall clock.
    """
    now = now or datetime.now(_KST)
    today = now.strftime("%Y%m%d")
    if date < today:
        return True
    if date > today:
        return False
    return (now.hour, now.minute) >= _SESSION_FINALIZE_HHMM


def _completeness_fields(
    ts_values: Iterable[HogaMs], *, collection_complete: bool,
) -> dict:
    """The completeness block for a live promotion — the SAME gap analysis
    hogaplay's parser runs (``analyze_gaps``), with ``anchor_edges=True`` so a
    stream that started late (13:00) or died mid-session is flagged by the
    session-edge anchors even with no interior gap.

    Shared by :func:`_build_meta` (live promote) and ``meta_backfill`` (retro-fit),
    so the two paths can't drift on gap semantics or the ``gap_ranges`` wire shape
    (same {start_ms, end_ms} form hogaplay's parser emits). ``ts_values`` are
    snapshot ``ts_ms`` in HHMMSSmmm (entity native, already HogaMs-compatible).
    """
    gaps = analyze_gaps(
        ts_values, session_close_ms=_REGULAR_SESSION_CLOSE_MS, anchor_edges=True,
    )
    return {
        "collection_complete": collection_complete,
        "is_partial": gaps.is_partial,
        "gap_ranges": [
            {"start_ms": int(start), "end_ms": int(end)}
            for start, end in gaps.gap_ranges
        ],
    }


def _atomic_write_table(writer, records, path: Path) -> None:
    """Bridge: call the canonical table writer if non-empty, else unlink.

    ADR-0043 today_promoter's contract is "no records → no file" (DuckDB
    chokes on zero-row parquet in some configs; readers handle missing
    file via FileNotFoundError, which is the standard pattern). The
    canonical writers always emit a row group, so apply the unlink-on-
    empty policy at this seam instead of inside the table modules.
    """
    if records:
        writer(records, path)
    else:
        path.unlink(missing_ok=True)



@dataclass
class _JsonlParseState:
    """증분 파싱 상태 — (source, code, date)별로 오프셋·누적 레코드·seq 유지.

    Today Promotion(5분 주기)이 자라는 JSONL을 매번 0바이트부터 재파싱하던
    일중 O(n²)를 제거한다: 이전 사이클이 소비한 바이트 오프셋 이후만 읽고,
    누적 리스트에 이어붙인다. **개행으로 끝나지 않은 꼬리는 소비하지 않는다** —
    쓰기 도중의 부분 라인을 오프셋 너머로 넘겨 영구 유실하는 일이 없도록
    (다음 사이클에 완성분으로 재시도; 구 전량-재파싱의 회복 의미론과 동일).
    파일이 줄어들면(회전·수동 삭제) 상태를 버리고 전량 재파싱으로 복귀한다.
    """
    offset: int = 0
    snap_seq: int = 0
    trade_seq: int = 0
    broker_seq: int = 0
    fill_seq: int = 0
    broker_snapshot_count: int = 0
    snapshots: list[Orderbook] = field(default_factory=list)
    trades: list[Trade] = field(default_factory=list)
    broker_rows: list[BrokerRow] = field(default_factory=list)
    fills: list[Fill] = field(default_factory=list)


# Today Promotion 전용 증분 상태. 프로모터 루프는 코드를 순차 await하므로
# 단일 스레드 접근(뮤텍스 불필요). 과거 날짜 키는 사이클마다 정리된다.
# 키에 경로를 포함한다: (source, code, date)가 같아도 data_dir이 다르면
# (테스트 tmp_path, 샌드박스) 오프셋이 남의 파일을 가리키면 안 된다.
_TODAY_PARSE_STATES: dict[tuple[str, str, str, str], _JsonlParseState] = {}


def _apply_jsonl_line(
    state: _JsonlParseState, line: str, *, code: str, date: str,
) -> None:
    """JSONL 한 줄을 상태에 적용 — 전량/증분 두 경로가 공유하는 유일한 파서."""
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        _log.warning("live.promote.partial_line code=%s date=%s", code, date)
        return
    kind = row.get("kind")
    t_ms_raw = row.get("t_ms")
    # ADR-0049: convert Unix ms → HHMMSSmmm so the on-disk `ts_ms`
    # column honors the ADR-0010 invariant (series-builder SQL
    # decodes ts_ms as HHMMSSmmm via hhmmssms_to_intra_ms_sql).
    try:
        t_ms_int = int(t_ms_raw)
    except (TypeError, ValueError):
        _log.warning(
            "live.promote.malformed_t_ms_skip code=%s date=%s t_ms_raw=%r",
            code, date, t_ms_raw,
        )
        return
    try:
        ts_ms_encoded = unix_ms_to_hhmmssms(date, t_ms_int)
    except ValueError:
        _log.warning(
            "live.promote.midnight_race_skip code=%s date=%s t_ms=%d",
            code, date, t_ms_int,
        )
        return
    p = row.get("payload") or {}
    # `phase` ("regular" / "premarket" / "afterhours") is preserved in
    # the JSONL forensic record but not in canonical parquet — no
    # downstream reader queries it.
    if kind == "ob":
        bids = p.get("bids") or []
        asks = p.get("asks") or []
        state.snap_seq += 1
        state.snapshots.append(Orderbook(
            ts_ms=ts_ms_encoded,
            seq=state.snap_seq,
            ask_p=tuple(asks[i]["price"] if i < len(asks) else 0 for i in range(10)),
            ask_q=tuple(asks[i]["qty"] if i < len(asks) else 0 for i in range(10)),
            ask_d=_ZERO_LEVELS,
            bid_p=tuple(bids[i]["price"] if i < len(bids) else 0 for i in range(10)),
            bid_q=tuple(bids[i]["qty"] if i < len(bids) else 0 for i in range(10)),
            bid_d=_ZERO_LEVELS,
            tot_ask=int(p.get("total_ask_qty") or 0),
            tot_ask_d=0,
            tot_bid=int(p.get("total_bid_qty") or 0),
            tot_bid_d=0,
        ))
    elif kind == "trade":
        for tr in p.get("trades") or []:
            state.trade_seq += 1
            state.trades.append(Trade(
                ts_ms=ts_ms_encoded,
                seq=state.trade_seq,
                price=int(tr.get("price") or 0),
                change_pct=0.0,
                qty=int(tr.get("qty") or 0),
                side=int(tr.get("side") or 0),
                cum_vol=0,
                cum_trades=0,
                low_so_far=0,
                high_so_far=0,
                net_pressure=0,
                unknown_14=0,
                unknown_16=0.0,
                unknown_17=0.0,
                unknown_18=0.0,
            ))
    elif kind == "broker":
        buy = p.get("buy_top") or []
        sell = p.get("sell_top") or []
        state.broker_snapshot_count += 1
        state.broker_seq += 1
        for rank, e in enumerate(sell[:5], start=1):
            state.broker_rows.append(BrokerRow(
                ts_ms=ts_ms_encoded,
                seq=state.broker_seq,
                side="sell",
                rank=rank,
                broker=str(e.get("name") or ""),
                qty_today=int(e.get("qty") or 0),
                qty_delta=0,
            ))
        for rank, e in enumerate(buy[:5], start=1):
            state.broker_rows.append(BrokerRow(
                ts_ms=ts_ms_encoded,
                seq=state.broker_seq,
                side="buy",
                rank=rank,
                broker=str(e.get("name") or ""),
                qty_today=int(e.get("qty") or 0),
                qty_delta=0,
            ))
    elif kind == "fill":
        state.fill_seq += 1
        state.fills.append(Fill(
            ts_ms=ts_ms_encoded,
            seq=state.fill_seq,
            buy_qty=int(p.get("buy_qty") or 0),
            sell_qty=int(p.get("sell_qty") or 0),
        ))


def _consume_complete_lines(state: _JsonlParseState, jsonl_path: Path, *, code: str, date: str) -> None:
    """오프셋 이후의 '완결된' 라인만 상태에 적용하고 오프셋을 전진시킨다."""
    size = jsonl_path.stat().st_size
    if size < state.offset:
        # 파일 축소(회전/삭제 후 재생성) → 전량 재파싱으로 복귀.
        fresh = _JsonlParseState()
        state.__dict__.update(fresh.__dict__)
    if size == state.offset:
        return
    with jsonl_path.open("rb") as f:
        f.seek(state.offset)
        data = f.read()
    cut = data.rfind(b"\n")
    if cut < 0:
        return  # 완결 라인 없음 — 다음 사이클로 이월
    consumed = data[: cut + 1]
    state.offset += len(consumed)
    for line in consumed.decode("utf-8").splitlines():
        if line:
            _apply_jsonl_line(state, line, code=code, date=date)


def _parse_jsonl_incremental(
    jsonl_path: Path, *, code: str, date: str, source: str = "kis_live",
) -> tuple[list[Orderbook], list[Trade], list[BrokerRow], list[Fill], dict]:
    """Today Promotion용 증분 파서 — 전량 파서와 결과 동등(패리티 테스트 고정)."""
    key = (source, code, date, str(jsonl_path))
    # 날짜가 넘어간(또는 경로가 바뀐) 같은 (source, code) 키 정리 — 장기 구동
    # 서버에서 상태가 코드당 하루치만 살도록.
    for stale in [
        k for k in _TODAY_PARSE_STATES
        if k[0] == source and k[1] == code and k != key
    ]:
        del _TODAY_PARSE_STATES[stale]
    state = _TODAY_PARSE_STATES.get(key)
    if state is None:
        state = _JsonlParseState()
        _TODAY_PARSE_STATES[key] = state
    _consume_complete_lines(state, jsonl_path, code=code, date=date)
    meta = _build_meta(
        code, date, state.snapshots, state.trades, state.broker_snapshot_count,
        fill_count=len(state.fills), source=source,
    )
    return state.snapshots, state.trades, state.broker_rows, state.fills, meta


def _parse_jsonl_to_records(  # noqa: PLR0912, PLR0915
    jsonl_path: Path,
    *,
    code: str,
    date: str,
    source: str = "kis_live",
) -> tuple[list[Orderbook], list[Trade], list[BrokerRow], list[Fill], dict]:
    """Parse one Live Capture JSONL into typed table records + meta.

    Shared by promote_one (ADR-0038 daily batch) and promote_today
    (ADR-0043 in-session N-minute overwrite). Torn last lines are skipped
    with a `live.promote.partial_line` warn log.

    Returns canonical dataclasses (Orderbook / Trade / BrokerRow / Fill), not
    dicts — the table writers enforce PARQUET_SCHEMA at construction time,
    so a missing column or wrong dtype fails fast here instead of as a
    DuckDB BinderException in a downstream reader.

    KIS REST doesn't carry hogaplay's forensic fields (depth deltas,
    cum_vol, change_pct, unknown_*); they are synthesized as 0 / 0.0 so
    the wire schema stays uniform across sources (ADR-0049).

    `meta` is the JSON dict ready to write to meta.json — caller decides
    when/how to persist it. If `jsonl_path` does not exist, returns empty
    lists and meta with row_counts=0.
    """
    state = _JsonlParseState()

    if not jsonl_path.exists():
        meta = _build_meta(
            code,
            date,
            state.snapshots,
            state.trades,
            state.broker_snapshot_count,
            fill_count=0,
            source=source,
        )
        return state.snapshots, state.trades, state.broker_rows, state.fills, meta

    # 라인 의미론(스킵 로그·인코딩 변환·seq 부여)은 _apply_jsonl_line 한 곳에
    # 산다 — 전량(이 함수)·증분(_parse_jsonl_incremental) 경로가 공유한다.
    with jsonl_path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if line:
                _apply_jsonl_line(state, line, code=code, date=date)

    snapshots = state.snapshots
    trades = state.trades
    broker_rows = state.broker_rows
    fills = state.fills
    broker_snapshot_count = state.broker_snapshot_count
    meta = _build_meta(
        code,
        date,
        snapshots,
        trades,
        broker_snapshot_count,
        fill_count=len(fills),
        source=source,
    )
    return snapshots, trades, broker_rows, fills, meta


def _build_meta(
    code: str, date: str, snapshots: list, trades: list, broker_snapshot_count: int,
    fill_count: int = 0,
    *,
    source: str = "kis_live",
) -> dict:
    meta = {
        "source": source,
        "code": code,
        "date": date,
        "promoted_at": datetime.now(UTC).isoformat(),
        "row_counts": {
            "snapshots": len(snapshots),
            "trades": len(trades),
            "brokers": broker_snapshot_count,
            "fills": fill_count,
        },
        # ADR-0003 HHMMSSmmm encoding.
        "regular_session_open_ms": 90000000,    # 09:00:00.000
        "regular_session_close_ms": int(_REGULAR_SESSION_CLOSE_MS),  # 15:30:00.000
        # Completeness routed through the SAME classifier hogaplay uses. Orderbook
        # .ts_ms is already HHMMSSmmm (entity native); cast to HogaMs at this seam.
        **_completeness_fields(
            [HogaMs(s.ts_ms) for s in snapshots],
            collection_complete=_collection_finished(date),
        ),
    }
    if source == "kis_api":
        meta["sampling_ms"] = 30000
        meta["created_from"] = "kis_rest"
    return meta


def _today_kst_yyyymmdd() -> str:
    """오늘 날짜 YYYYMMDD KST."""
    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


async def promote_today(data_dir: Path, *, code: str) -> str | None:
    """ADR-0043 Today Promotion — overwrite, no archive move.

    Returns the promoted date (YYYYMMDD) on a real promotion, or None when the
    code had nothing to promote (no jsonl this cycle). The promoter loop uses
    this to publish a `promotion_completed` event only on a real promotion — a
    None (skip) must not fire a spurious refetch on the frontend.

    promote_one과 다른 점:
      - idempotent skip 안 함 (meta.json 있어도 다시 처리)
      - archive 이동 안 함 (jsonl 계속 polling 중)
      - parquet 파일들은 atomic_write_parquet으로 원자 교체

    Midnight race protection (eng-review Blocker 1):
      - today_kst를 함수 진입 시점에 한 번만 evaluate.
      - 그 시점 이후 자정이 지나도 이 사이클은 "yesterday" jsonl을 처리.
      - 다음 사이클(5분 후)이 새 today_kst를 picking → 어제는 Daily Promotion 담당.

    Candles invariant (ADR-0040): snapshots/trades/brokers/fills.parquet만 생성.
    candles는 Live Candle Backfill의 별도 캐시가 담당하므로 절대 생성하지 않는다.
    """
    from hoga.api._atomic_write import atomic_write_json

    # CRITICAL: today_kst를 한 번만 evaluate해서 자정 race 회피
    today = _today_kst_yyyymmdd()
    jsonl_path = data_dir / "live" / today / f"{code}.jsonl"
    parquet_root = data_dir / "parquet"
    target = parquet_root / today / code / "kis_live"

    if not jsonl_path.exists():
        return None

    start_ms = int(time.time() * 1000)
    _log.info("live.today_promote.start code=%s date=%s", code, today)

    def _sync_parse_and_write() -> dict:
        # 증분 파싱(직전 사이클 오프셋 이후만) + parquet 재작성. sync 디스크/CPU
        # 작업 전체를 스레드로 격리 — 종전엔 이벤트 루프에서 인라인 실행되어
        # 5분마다 코드당 수백 ms씩 루프를 블로킹했다.
        try:
            snapshots, trades, broker_rows, fills, meta = _parse_jsonl_incremental(
                jsonl_path, code=code, date=today,
            )
        except Exception:
            _log.exception(
                "live.today_promote.parse_failed code=%s date=%s", code, today,
            )
            raise

        target.mkdir(parents=True, exist_ok=True)
        try:
            _atomic_write_table(write_snapshots_parquet, snapshots, target / "snapshots.parquet")
            _atomic_write_table(write_trades_parquet, trades, target / "trades.parquet")
            _atomic_write_table(write_brokers_parquet, broker_rows, target / "brokers.parquet")
            _atomic_write_table(write_fills_parquet, fills, target / "fills.parquet")
            atomic_write_json(target / "meta.json", meta, indent=2)
        except OSError as e:
            _log.warning(
                "live.today_promote.write_failed code=%s date=%s reason=%s",
                code, today, e,
            )
            raise
        return meta

    meta = await asyncio.to_thread(_sync_parse_and_write)

    elapsed = int(time.time() * 1000) - start_ms
    _log.info(
        "live.today_promote.done code=%s date=%s row_counts=%s elapsed_ms=%d",
        code, today, meta["row_counts"], elapsed,
    )

    # design-review B2 — 사용자가 /api/live/status에서 마지막 promote 시각 확인 가능
    # Task 5에서 lifecycle.record_today_promote_success가 추가되면 작동.
    # 그 전엔 ImportError fallback으로 noop.
    try:
        from hoga.live import lifecycle
        record_fn = getattr(lifecycle, "record_today_promote_success", None)
        if record_fn is not None:
            record_fn(code, int(time.time() * 1000))
    except ImportError:
        pass

    return today


async def promote_api_today(data_dir: Path, *, code: str) -> None:
    from hoga.api._atomic_write import atomic_write_json

    today = _today_kst_yyyymmdd()
    jsonl_path = data_dir / "live_api" / today / f"{code}.jsonl"
    target = data_dir / "parquet" / today / code / "kis_api"
    if not jsonl_path.exists():
        return

    def _sync_parse_and_write() -> None:
        snapshots, trades, broker_rows, fills, meta = _parse_jsonl_incremental(
            jsonl_path,
            code=code,
            date=today,
            source="kis_api",
        )
        target.mkdir(parents=True, exist_ok=True)
        _atomic_write_table(write_snapshots_parquet, snapshots, target / "snapshots.parquet")
        _atomic_write_table(write_trades_parquet, trades, target / "trades.parquet")
        _atomic_write_table(write_brokers_parquet, broker_rows, target / "brokers.parquet")
        _atomic_write_table(write_fills_parquet, fills, target / "fills.parquet")
        atomic_write_json(target / "meta.json", meta, indent=2)

    await asyncio.to_thread(_sync_parse_and_write)


async def promote_kiwoom_today(data_dir: Path, *, code: str) -> None:
    """키움 WS 승격 (ADR-0116) — live_kiwoom JSONL → parquet/{date}/{code}/kiwoom_live.

    promote_api_today의 키움판. 소스만 다르고(kiwoom_live) 나머지는 동일: 실시간
    WS라 kis_live처럼 sampling 메타 없음(_build_meta의 kis_api 분기 밖). 별도 루트
    (live_kiwoom)라 KIS live JSONL과 무충돌. record/return 없음(promote_api_today와 동일).
    """
    from hoga.api._atomic_write import atomic_write_json

    today = _today_kst_yyyymmdd()
    jsonl_path = data_dir / "live_kiwoom" / today / f"{code}.jsonl"
    target = data_dir / "parquet" / today / code / "kiwoom_live"
    if not jsonl_path.exists():
        return

    def _sync_parse_and_write() -> None:
        snapshots, trades, broker_rows, fills, meta = _parse_jsonl_incremental(
            jsonl_path,
            code=code,
            date=today,
            source="kiwoom_live",
        )
        target.mkdir(parents=True, exist_ok=True)
        _atomic_write_table(write_snapshots_parquet, snapshots, target / "snapshots.parquet")
        _atomic_write_table(write_trades_parquet, trades, target / "trades.parquet")
        _atomic_write_table(write_brokers_parquet, broker_rows, target / "brokers.parquet")
        _atomic_write_table(write_fills_parquet, fills, target / "fills.parquet")
        atomic_write_json(target / "meta.json", meta, indent=2)

    await asyncio.to_thread(_sync_parse_and_write)


async def promote_one(
    jsonl_path: Path,
    parquet_root: Path,
    *,
    code: str,
    date: str,
    source: str = "kis_live",
) -> None:
    """Convert one JSONL file to Parquet artifacts under `parquet/{date}/{code}/{source}/`.

    Idempotent: if `meta.json` already exists at the target, skip.
    ``source`` = "kis_live"(기본) 또는 "kiwoom_live"(ADR-0116 일배치 승격). 실시간 WS라
    양쪽 모두 sampling 메타 없음(_build_meta의 kis_api 분기 밖).
    See ADR-0038 (deferred batch promotion) and ADR-0043 (sister Today
    Promotion that this helper coexists with).
    """
    target = parquet_root / date / code / source
    meta_path = target / "meta.json"
    if meta_path.exists():
        # Skip ONLY a finalized promotion. A meta left by an intraday cycle whose
        # server died mid-session carries collection_complete=False; re-promoting
        # it (full re-parse) lets the next-day batch finalize the Stock-Date
        # (True + a tail gap → SOURCE_PARTIAL) instead of freezing it at ✕.
        # Unreadable meta → re-promote (conservative).
        try:
            prior = json.loads(meta_path.read_text(encoding="utf-8"))
            already_final = prior.get("collection_complete") is True
        except (ValueError, OSError):
            already_final = False
        if already_final:
            _log.info(
                "live.promote.skip code=%s date=%s reason=already_promoted", code, date
            )
            return
    if not jsonl_path.exists():
        return

    snapshots, trades, broker_rows, fills, meta = _parse_jsonl_to_records(
        jsonl_path, code=code, date=date, source=source,
    )

    target.mkdir(parents=True, exist_ok=True)
    _atomic_write_table(write_snapshots_parquet, snapshots, target / "snapshots.parquet")
    _atomic_write_table(write_trades_parquet, trades, target / "trades.parquet")
    _atomic_write_table(write_brokers_parquet, broker_rows, target / "brokers.parquet")
    _atomic_write_table(write_fills_parquet, fills, target / "fills.parquet")
    meta_path.write_text(json.dumps(meta, indent=2))
    _log.info(
        "live.promote.done code=%s date=%s row_counts=%s",
        code, date, meta["row_counts"],
    )


# 일배치 승격 대상 (JSONL 루트, 승격 소스). live=KIS WS, live_kiwoom=키움 WS(ADR-0116).
# 키움을 누락하면 크래시/이탈로 남은 과거일 live_kiwoom JSONL이 영영 미승격+디스크
# 무한 증가하고, kiwoom_live가 read-path 소스라 완결 플래그가 ✕로 고착된다(리뷰 Major).
_PROMOTE_ROOTS: tuple[tuple[str, str], ...] = (
    ("live", "kis_live"),
    ("live_kiwoom", "kiwoom_live"),
)


async def promote_pending(data_dir: Path) -> None:
    """Walk `<data_dir>/{live,live_kiwoom}/{date}/*.jsonl` and promote each, then archive.

    Skipped entries:
    - `_archive/` subdirectory (we don't re-promote our own backup).
    - **Today's date** — owned by Today Promotion (ADR-0043). Skipping prevents
      archive-move from racing the still-appending jsonl writer.
    - Non-jsonl files.
    - (date, code) pairs already promoted (handled by promote_one's idempotency).
    """
    today = _today_kst_yyyymmdd()
    parquet_root = data_dir / "parquet"
    for subdir, source in _PROMOTE_ROOTS:
        live_root = data_dir / subdir
        archive_root = live_root / "_archive"
        if not live_root.exists():
            continue
        for date_dir in live_root.iterdir():
            if not date_dir.is_dir() or date_dir.name == "_archive":
                continue
            if date_dir.name == today:  # ADR-0043 — owned by Today Promotion
                continue
            for jsonl in date_dir.iterdir():
                if jsonl.suffix != ".jsonl" or not jsonl.is_file():
                    continue
                code = jsonl.stem
                await promote_one(
                    jsonl, parquet_root, code=code, date=date_dir.name, source=source,
                )
                arch_target = archive_root / date_dir.name / jsonl.name
                arch_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(jsonl), str(arch_target))


async def cleanup_archive(data_dir: Path, retention_days: int = 7) -> None:
    """Remove archived JSONL files older than `retention_days` under every promote root.

    Called by Daily Scheduler at 17:00 KST after promote_pending. Keeps the
    `_archive` trees (live·live_kiwoom) from growing unbounded.
    """
    cutoff = time.time() - retention_days * 86400
    for subdir, _source in _PROMOTE_ROOTS:
        archive_root = data_dir / subdir / "_archive"
        if not archive_root.exists():
            continue
        for path in archive_root.rglob("*.jsonl"):
            if path.stat().st_mtime < cutoff:
                path.unlink()
