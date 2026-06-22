"""FastAPI router for Live Capture endpoints (spec §6)."""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import re
import time as monotonic_time
from collections.abc import Awaitable, Callable
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.params import CODE_PATTERN
from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisQuote,
    KisRateLimitError,
    KisTransportError,
)
from hoga.live.kis_models import InvestorTrendEstimateRow
from hoga.live.kis_venue import (
    AUTO_DAILY_USES_INTEGRATED_WARNING,
    KisVenue,
    daily_venue_for_policy,
    merge_auto_minute_bars,
    parse_live_venue_policy,
)
from hoga.live.index_registry import (
    UnknownRepresentativeIndex,
    get_representative_index,
    list_representative_indices,
)
from hoga.live.past_candles_cache import PastCandlesCache
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache

from . import kis_access
from .buffer import LiveBuffer
from .lifecycle import LiveStatus
from .index_sector_rankings import IndexSectorRankingResponse, build_index_sector_rankings

if TYPE_CHECKING:
    from .kis_client import KisClient

ControlAction = Literal["start", "stop", "pause"]

log = logging.getLogger(__name__)

_PAST_MAX_DAYS = 250

# past-candles 미캐시 날짜 병렬 fetch 동시 상한 (spec 2026-06-08 §4.1).
# 산식: RTT ~200ms → 슬롯당 ~5콜/초 → 3슬롯이 토큰버킷(15콜/초, kis_client.
# _TokenBucket — 동시 acquirer 안전 설계) 포화점, +2는 RTT 변동 흡수 여유.
# 6+는 처리량 무이득(버킷이 천장)이고 EGW00201 시 동시 재시도(최대 동시수×4,
# ADR-0050)만 증폭. 운용: 로그에 kis_rate_limit/rate_limit_aborted가 자주
# 보이면 3으로 하향. 8 초과 금지 — 버킷 가득 시작이라 첫 순간 15콜 버스트
# 가능, KIS 통상 한도(인용 20/초) 대비 여유 25% 보존.
_PAST_CANDLES_CONCURRENCY = 5
_CODE_RE = re.compile(CODE_PATTERN)
_KST = timezone(timedelta(hours=9))
_INVESTOR_ESTIMATE_MAX_CODES_PER_DAY = 256

# Rate-limit retry policy lives in ``KisClient._get`` (ADR-0050). Handlers
# here just call ``kis.fetch_*`` directly; a ``KisRateLimitError`` that
# reaches the handler's ``except`` block means the client has already
# exhausted its retries — the right move is then to mark the range
# blocked and surface the warning to the wire.


def _today_kst_date() -> date:
    return datetime.now(_KST).date()


def _today_kst_yyyymmdd() -> str:
    return _today_kst_date().strftime("%Y%m%d")


def _parse_yyyymmdd(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y%m%d").date()
    except ValueError:
        return None


def _date_iter(frm: date, to: date):
    cur = frm
    while cur <= to:
        yield cur.strftime("%Y%m%d")
        cur = cur + timedelta(days=1)


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms, "open": c.open, "high": c.high, "low": c.low,
        "close": c.close, "volume": c.volume,
    }


def _hhmmss_from_t_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=_KST).strftime("%H%M%S")


def _investor_point_to_dict(p) -> dict:
    return {
        "t_ms": p.t_ms, "foreign_net": p.foreign_net,
        "institution_net": p.institution_net,
    }


def _validate_past_request(
    code: str, from_: str, to: str,
    *, max_days: int | None = _PAST_MAX_DAYS,
) -> tuple[date, date, date]:
    """Validate past-candles request params, returning parsed (frm, too, today).

    `max_days=None` disables the range cap — used by the daily path, which is
    uncapped per ADR-0048 (KIS retention ~20-30 years is the natural ceiling
    and rate-limit handling surfaces partial responses via data_warnings).

    Raises HTTPException(422) for any constraint violation.
    """
    if not _CODE_RE.match(code):
        raise HTTPException(422, {"code": "invalid_code", "msg": "code must be 6 digits"})
    frm = _parse_yyyymmdd(from_)
    too = _parse_yyyymmdd(to)
    if frm is None or too is None:
        raise HTTPException(422, {"code": "invalid_date", "msg": "from/to must be YYYYMMDD"})
    if frm > too:
        raise HTTPException(422, {"code": "from_after_to", "msg": "from must be <= to"})
    today_d = _today_kst_date()
    if too > today_d:
        raise HTTPException(422, {"code": "date_in_future", "msg": "to must be <= today_kst"})
    if max_days is not None:
        span_days = (too - frm).days + 1
        if span_days > max_days:
            raise HTTPException(
                422,
                {"code": "date_range_too_large", "msg": f"max {max_days} days", "max_days": max_days},
            )
    return frm, too, today_d


def _validate_index_range(index_id: str, from_: str, to: str):
    try:
        index = get_representative_index(index_id)
    except UnknownRepresentativeIndex as e:
        raise HTTPException(
            422,
            {"code": "invalid_index_id", "msg": "unknown representative index"},
        ) from e
    if index.kis_index_code is None:
        raise HTTPException(
            422,
            {"code": "unsupported_index", "msg": f"{index.id} is not supported by KIS index routes"},
        )
    frm = _parse_yyyymmdd(from_)
    too = _parse_yyyymmdd(to)
    if frm is None or too is None:
        raise HTTPException(422, {"code": "invalid_date", "msg": "from/to must be YYYYMMDD"})
    if frm > too:
        raise HTTPException(422, {"code": "from_after_to", "msg": "from must be <= to"})
    today_d = _today_kst_date()
    if too > today_d:
        raise HTTPException(422, {"code": "date_in_future", "msg": "to must be <= today_kst"})
    return index


def _violation_to_warning(v, batch_label: str) -> dict:
    """Render a DailyInvariantViolation as the wire dict the
    /past-daily-candles handler emits in `data_warnings`.

    Locality: one source of truth for the `{batch, date, reason, msg}` shape
    so future frontend additions (e.g. `LivePastDailyCandlesWarning`
    interface widening) only need to touch one builder.
    """
    return {
        "batch": batch_label,
        "date": v.date_yyyymmdd,
        "reason": "invariant_violation",
        "msg": f"{v.date_yyyymmdd}: {v.reason} ({v.detail})",
    }


def _kis_error_to_warning(reason: str, msg: str, batch_label: str) -> dict:
    """Render a KIS rate-limit/api-error as the wire dict the handler emits.

    `date` field is intentionally omitted — these errors apply to the whole
    batch range, not a single date (companion to `_violation_to_warning`).
    """
    return {"batch": batch_label, "reason": reason, "msg": msg}


def _daily_fallback_to_krx_warning(primary_venue: KisVenue, batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "reason": "daily_fallback_to_krx",
        "msg": (
            f"{primary_venue} daily returned no candles; using KRX daily candles "
            "for this batch"
        ),
    }


def _compute_daily_gaps(
    frm: date, too: date,
    existing: list[tuple[date, date]],
) -> list[tuple[date, date]]:
    """Compute non-overlapping gap intervals within [frm, too] not covered by
    existing batches.

    Algorithm:
    1. Filter `existing` to entries intersecting [frm, too].
    2. Sort by start.
    3. Merge overlapping/adjacent intervals (touching = same continuous day line).
    4. Walk and emit complement against [frm, too].

    Two existing batches `(a1, a2)` and `(b1, b2)` are *adjacent* when
    `b1 == a2 + 1 day` — in that case no day gap exists between them.
    """
    relevant = [(s, e) for (s, e) in existing if e >= frm and s <= too]
    if not relevant:
        return [(frm, too)]
    relevant.sort()
    merged: list[tuple[date, date]] = [relevant[0]]
    for s, e in relevant[1:]:
        last_s, last_e = merged[-1]
        if s <= last_e + timedelta(days=1):
            merged[-1] = (last_s, max(last_e, e))
        else:
            merged.append((s, e))

    gaps: list[tuple[date, date]] = []
    cursor = frm
    for s, e in merged:
        if s > cursor:
            gap_end = min(s - timedelta(days=1), too)
            if cursor <= gap_end:
                gaps.append((cursor, gap_end))
        cursor = max(cursor, e + timedelta(days=1))
        if cursor > too:
            break
    if cursor <= too:
        gaps.append((cursor, too))
    return gaps


async def batched_daily_walkback(
    *,
    cache: PastDailyCandlesCache,
    fetch_batch: Callable[[str, str, str], Awaitable[tuple[list[dict], list]]],
    output_key: str,
    code: str,
    frm: date,
    too: date,
    today_d: date,
) -> dict:
    """Shared gap/cache/today/dedupe walk-back orchestration for the daily KIS
    series endpoints — `/past-daily-candles` (**Live Candle Backfill** 일봉) and
    `/past-investor-net` (**Live Investor Net**), which used to copy-paste this
    body verbatim (the only differences were the cache instance, fetch method,
    row→dict converter, and output key).

    The caller supplies a thin `fetch_batch(code, from_s, to_s)` closure that
    fetches one date range and returns `(rows: list[dict], violations)` — it may
    raise ``KisRateLimitError`` / ``KisApiError`` (this orchestrator catches them
    and turns them into ``data_warnings``, breaking on rate-limit, continuing on
    api-error). Everything else — batch-cache intersect, gap compute, per-gap
    fetch + persist, today tri-state, dedupe-by-``t_ms`` / sort / [frm,too]
    filter — lives here, tested once in ``test_batched_daily_walkback.py``.
    """
    today_s = today_d.strftime("%Y%m%d")
    from_s = frm.strftime("%Y%m%d")
    to_s = too.strftime("%Y%m%d")

    warnings: list[dict] = []
    cached_batches: list[str] = []
    fresh_batches: list[str] = []
    loaded: list[dict] = []

    # 1+2. Read existing batches intersecting the request.
    existing_relevant: list[tuple[date, date]] = []
    for b_from, b_to, b_rows in cache.list_batches(code):
        if b_to < frm or b_from > too:
            continue
        existing_relevant.append((b_from, b_to))
        loaded.extend(b_rows)
        cached_batches.append(f"{b_from.strftime('%Y%m%d')}__{b_to.strftime('%Y%m%d')}")

    # 3. Compute gaps (past-only — today handled separately).
    req_to_past = min(too, today_d - timedelta(days=1))
    if frm <= req_to_past:
        for gap_from, gap_to in _compute_daily_gaps(frm, req_to_past, existing_relevant):
            gap_from_s = gap_from.strftime("%Y%m%d")
            gap_to_s = gap_to.strftime("%Y%m%d")
            label = f"{gap_from_s}__{gap_to_s}"
            try:
                rows, violations = await fetch_batch(code, gap_from_s, gap_to_s)
            except KisRateLimitError as e:
                warnings.append(_kis_error_to_warning("kis_rate_limit", str(e), label))
                break
            except KisTransportError as e:
                # Subtype of KisApiError — must precede the generic arm so a
                # network blip (TCP disconnect) carries its own reason and an
                # operator can tell it apart from a KIS rejection (different
                # remediation). Skip this batch, keep walking back. The client
                # already retried connection-level failures once (ADR-0050).
                warnings.append(_kis_error_to_warning("kis_transport", e.msg_cd, label))
                continue
            except KisApiError as e:
                warnings.append(_kis_error_to_warning("kis_api_error", e.msg_cd, label))
                continue
            cache.append_batch(code, gap_from, gap_to, rows)
            loaded.extend(rows)
            fresh_batches.append(label)
            for v in violations:
                warnings.append(_violation_to_warning(v, label))

    # 5. Today handling (separate from past — memory only, tri-state).
    if too >= today_d:
        state, today_row = cache.get_today(code)
        if state == "hit":
            loaded.append(today_row)  # type: ignore[arg-type]
            cached_batches.append(f"{today_s}__{today_s}")
        elif state == "negative":
            pass  # known non-trading day; skip KIS, no row
        else:  # miss
            today_label = f"{today_s}__{today_s}"
            try:
                rows, violations = await fetch_batch(code, today_s, today_s)
                if rows:
                    today_row = rows[0]
                    cache.store_today(code, today_row)
                    loaded.append(today_row)
                    fresh_batches.append(today_label)
                else:
                    # Non-trading day — negative cache, still record the fetch
                    # in fresh_batches for parity with the gap branch (operator
                    # visibility for the KIS round-trip).
                    cache.store_today(code, None)
                    fresh_batches.append(today_label)
                for v in violations:
                    warnings.append(_violation_to_warning(v, today_label))
            except KisRateLimitError as e:
                warnings.append(_kis_error_to_warning("kis_rate_limit", str(e), today_label))
            except KisTransportError as e:
                warnings.append(_kis_error_to_warning("kis_transport", e.msg_cd, today_label))
            except KisApiError as e:
                warnings.append(_kis_error_to_warning("kis_api_error", e.msg_cd, today_label))

    # 6. Dedupe by t_ms, sort, filter to [frm, too].
    frm_ms = int(datetime.combine(frm, time(0, 0), tzinfo=_KST).timestamp() * 1000)
    too_ms = int(datetime.combine(too, time(23, 59, 59), tzinfo=_KST).timestamp() * 1000)
    by_ts: dict[int, dict] = {}
    for row in loaded:
        ts = row.get("t_ms")
        if isinstance(ts, int):
            by_ts[ts] = row
    rows_out = sorted(
        (r for ts, r in by_ts.items() if frm_ms <= ts <= too_ms),
        key=lambda r: r["t_ms"],
    )

    return {
        "code": code,
        "from": from_s,
        "to": to_s,
        output_key: rows_out,
        "cached_batches": cached_batches,
        "fresh_batches": fresh_batches,
        "data_warnings": warnings,
    }


class LiveQuote(BaseModel):
    code: str
    price: int
    change_pct: float | None
    change_won: int | None
    open: int | None = None
    high: int | None = None
    low: int | None = None


class LiveQuotesResponse(BaseModel):
    phase: Literal["pre_open", "open", "closed"]
    quotes: list[LiveQuote]


class LiveIndexEntry(BaseModel):
    kind: Literal["index"] = "index"
    id: str
    label: str
    investor_scope: Literal["market", "index", "none"]


class LiveIndicesResponse(BaseModel):
    indices: list[LiveIndexEntry]


InvestorEstimateWarningReason = Literal[
    "kis_credentials_missing",
    "kis_rate_limit",
    "kis_api_error",
    "parse_error",
]


class LiveInvestorTrendEstimateWarning(BaseModel):
    reason: InvestorEstimateWarningReason
    msg: str


class LiveInvestorTrendEstimateRow(BaseModel):
    slot: str
    observed_at_ms: int
    foreign_qty: int | None
    institution_qty: int | None
    sum_qty: int | None


class LiveInvestorTrendEstimateResponse(BaseModel):
    code: str
    trading_day: str
    fetched_at_ms: int | None
    rows: list[LiveInvestorTrendEstimateRow]
    latest: LiveInvestorTrendEstimateRow | None
    source: Literal["kis"]
    status: Literal["ok", "empty", "error"]
    data_warning: LiveInvestorTrendEstimateWarning | None


class _InvestorEstimateObservedAtStore:
    """Persist per-slot observed times for the display-only investor estimate card."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock_path = path.with_suffix(path.suffix + ".lock")
        self._state: dict[str, dict[str, dict[str, dict[str, int | None]]]] = {}

    def apply(
        self,
        *,
        trading_day: str,
        code: str,
        rows: list[LiveInvestorTrendEstimateRow],
        fetched_at_ms: int,
        full_history: bool,
    ) -> list[LiveInvestorTrendEstimateRow]:
        with self._locked():
            self._load()
            changed = self._prune_to_day(trading_day)
            code_state = self._state.setdefault(trading_day, {}).setdefault(code, {})
            out: list[LiveInvestorTrendEstimateRow] = []
            seen_slots: set[str] = set()
            for row in rows:
                seen_slots.add(row.slot)
                stored = code_state.get(row.slot)
                if stored is not None and _investor_estimate_same_quantities(stored, row):
                    observed_at_ms = stored.get("observed_at_ms")
                    if isinstance(observed_at_ms, int):
                        out.append(row.model_copy(update={"observed_at_ms": observed_at_ms}))
                        continue
                code_state[row.slot] = {
                    "observed_at_ms": fetched_at_ms,
                    "foreign_qty": row.foreign_qty,
                    "institution_qty": row.institution_qty,
                    "sum_qty": row.sum_qty,
                }
                changed = True
                out.append(row)
            if full_history:
                stale_slots = [slot for slot in code_state if slot not in seen_slots]
                for slot in stale_slots:
                    code_state.pop(slot, None)
                changed = changed or bool(stale_slots)
            changed = self._evict_over_capacity(trading_day) or changed
            if changed:
                self._save()
            return out

    def clear(self, *, trading_day: str, code: str) -> None:
        with self._locked():
            self._load()
            changed = self._prune_to_day(trading_day)
            day_state = self._state.get(trading_day)
            if day_state is None or code not in day_state:
                if changed:
                    self._save()
                return
            day_state.pop(code, None)
            self._save()

    @contextlib.contextmanager
    def _locked(self):
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock_path.open("a", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            self._state = {}
            return
        self._state = self._sanitize(raw)

    def _sanitize(
        self,
        raw: object,
    ) -> dict[str, dict[str, dict[str, dict[str, int | None]]]]:
        if not isinstance(raw, dict):
            return {}
        state: dict[str, dict[str, dict[str, dict[str, int | None]]]] = {}
        for day, day_raw in raw.items():
            if not isinstance(day, str) or not isinstance(day_raw, dict):
                continue
            day_state: dict[str, dict[str, dict[str, int | None]]] = {}
            for code, code_raw in day_raw.items():
                if not isinstance(code, str) or not isinstance(code_raw, dict):
                    continue
                code_state: dict[str, dict[str, int | None]] = {}
                for slot, slot_raw in code_raw.items():
                    if not isinstance(slot, str) or not isinstance(slot_raw, dict):
                        continue
                    observed_at_ms = slot_raw.get("observed_at_ms")
                    if not isinstance(observed_at_ms, int):
                        continue
                    code_state[slot] = {
                        "observed_at_ms": observed_at_ms,
                        "foreign_qty": _optional_int(slot_raw.get("foreign_qty")),
                        "institution_qty": _optional_int(slot_raw.get("institution_qty")),
                        "sum_qty": _optional_int(slot_raw.get("sum_qty")),
                    }
                if code_state:
                    day_state[code] = code_state
            if day_state:
                state[day] = day_state
        return state

    def _prune_to_day(self, trading_day: str) -> bool:
        stale_days = [day for day in self._state if day != trading_day]
        for day in stale_days:
            self._state.pop(day, None)
        return bool(stale_days)

    def _evict_over_capacity(self, trading_day: str) -> bool:
        day_state = self._state.get(trading_day)
        if day_state is None:
            return False
        overflow = len(day_state) - _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY
        if overflow <= 0:
            return False
        oldest = sorted(
            day_state,
            key=lambda code: _max_observed_at(day_state[code]),
        )[:overflow]
        for code in oldest:
            day_state.pop(code, None)
        return True

    def _save(self) -> None:
        try:
            atomic_write_json(self._path, self._state)
        except OSError:
            log.warning("failed to persist investor estimate observed_at store", exc_info=True)


def _quote_phase(now: datetime) -> Literal["pre_open", "open", "closed"]:
    """/quotes 오버레이의 폴링·표시 게이트(스펙 2026-06-08 ⑧).

    closed: 주말 또는 평일 08:50 이전·16:00 이후 — 프론트가 폴링을 600s로
    줄이고 백엔드는 마지막 시세 캐시로 응답한다('마지막 시세 유지' 결정).
    pre_open: 08:50–09:00 동시호가(KRX 08:50 시작) — 등락률 숨김(기존 계약).
    시계 기반 — 평일 공휴일의 드문 낭비는 수용(캘린더 게이트는 동기 KIS HTTP
    재도입이라 배제). session_gate.market_phase(16:00-aware 3-way 세션
    phase)와 계약이 달라 이름을 분리한다."""
    if now.weekday() >= 5:  # noqa: PLR2004 — 토/일
        return "closed"
    t = now.time()
    if t < time(8, 50) or t >= time(16, 0):
        return "closed"
    return "pre_open" if t < time(9, 0) else "open"


class ControlRequest(BaseModel):
    action: ControlAction


class LiveQuoteFetcher:
    """`/quotes` 오버레이의 시세 fetch + 마지막-시세 캐시 + phase 게이팅을 한 곳에 모은
    모듈. 라우트는 phase 계산·코드 파싱·KisClient 획득만 하고 이 모듈을 호출한다 —
    캐시·게이팅·graceful-fallback 의 business logic 이 라우트(infra)에서 분리된다.

    청킹(최대 30종목/콜, FHKST11300006)은 그대로 `kis.fetch_multi_price` 내부에 둔다
    (여기선 캐시·게이팅만 소유). 마지막-시세는 표시 전용·디스크 미영속(ADR-0056),
    단일 워커라 dict 로 충분(ADR-0038). FastAPI 없이 fake kis 로 단독 테스트 가능."""

    def __init__(self) -> None:
        # 장중 마지막 quotes — closed 서빙용(스펙 2026-06-08 ⑧ '마지막 시세 유지').
        self._last_quotes: dict[str, KisQuote] = {}

    async def fetch_and_gate(
        self, kis: KisClient, code_list: list[str], phase: str,
    ) -> list[LiveQuote]:
        """code_list 의 시세를 phase 에 맞춰 반환. closed=마지막 시세(캐시 미스면 1회 채움),
        open=라이브, pre_open=등락률 숨김. KIS 실패는 절대 전파하지 않는다(오버레이는 500 금지)."""
        if phase == "closed":
            # 장외: 마지막 시세 서빙. 캐시 미스(재시작 직후)면 1회만 KIS를 불러
            # 채운다 — KIS는 장외에도 종가를 반환. 프론트는 closed에 600s
            # 하트비트라 이 경로의 KIS 콜은 사실상 드로어 마운트 시 1회뿐.
            missing = [c for c in code_list if c not in self._last_quotes]
            if missing:
                try:
                    for q in await kis.fetch_multi_price(code_list):
                        self._last_quotes[q.code] = q
                except Exception as e:  # noqa: BLE001 — 오버레이는 절대 500 금지
                    log.warning("live quotes cold fetch failed (%d codes): %s",
                                len(code_list), e)
            return [
                LiveQuote(code=q.code, price=q.price,
                          change_pct=q.change_pct, change_won=q.change_won,
                          open=q.open, high=q.high, low=q.low)
                for c in code_list
                if (q := self._last_quotes.get(c)) is not None
            ]
        try:
            quotes = await kis.fetch_multi_price(code_list)
        except Exception as e:  # noqa: BLE001 — 10초 폴링 오버레이는 절대 500 금지;
            # KIS rate-limit/api-error/네트워크 타임아웃 등 무엇이든 빈 결과로 graceful
            # (프론트는 '—' 표시). retry-exhausted 신호는 warning 으로만 남긴다.
            log.warning("live quotes fetch failed (%d codes): %s", len(code_list), e)
            return []
        for q in quotes:
            self._last_quotes[q.code] = q
        pre = phase == "pre_open"
        return [
            LiveQuote(code=q.code, price=q.price,
                      change_pct=(None if pre else q.change_pct),
                      change_won=(None if pre else q.change_won),
                      open=(None if pre else q.open),
                      high=(None if pre else q.high),
                      low=(None if pre else q.low))
            for q in quotes
        ]


def _investor_estimate_row_to_wire(
    row: InvestorTrendEstimateRow,
    *,
    observed_at_ms: int,
) -> LiveInvestorTrendEstimateRow:
    return LiveInvestorTrendEstimateRow(
        slot=row.slot,
        observed_at_ms=observed_at_ms,
        foreign_qty=row.foreign_qty,
        institution_qty=row.institution_qty,
        sum_qty=row.sum_qty,
    )


def _investor_estimate_has_quantity(row: LiveInvestorTrendEstimateRow) -> bool:
    return (
        row.foreign_qty is not None
        or row.institution_qty is not None
        or row.sum_qty is not None
    )


def _investor_estimate_same_quantities(
    previous: LiveInvestorTrendEstimateRow | dict[str, int | None],
    current: LiveInvestorTrendEstimateRow,
) -> bool:
    if isinstance(previous, LiveInvestorTrendEstimateRow):
        return (
            previous.foreign_qty == current.foreign_qty
            and previous.institution_qty == current.institution_qty
            and previous.sum_qty == current.sum_qty
        )
    return (
        previous.get("foreign_qty") == current.foreign_qty
        and previous.get("institution_qty") == current.institution_qty
        and previous.get("sum_qty") == current.sum_qty
    )


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) else None


def _max_observed_at(rows: dict[str, dict[str, int | None]]) -> int:
    values = [
        observed_at_ms
        for row in rows.values()
        if isinstance((observed_at_ms := row.get("observed_at_ms")), int)
    ]
    return max(values, default=-1)


def _latest_investor_estimate_row(
    rows: list[LiveInvestorTrendEstimateRow],
) -> LiveInvestorTrendEstimateRow | None:
    usable = [r for r in rows if _investor_estimate_has_quantity(r)]
    numeric = [(int(r.slot), r) for r in usable if r.slot.isdecimal()]
    if numeric:
        return max(numeric, key=lambda pair: pair[0])[1]
    return usable[-1] if usable else None


class LiveInvestorEstimateFetcher:
    """Fetch/cache intraday investor trend estimates for one process.

    KIS sometimes returns a full intraday history and sometimes only the
    newest slot. Full-history responses replace same-day state. Latest-only
    responses merge by slot so repeated polling reconstructs the day locally.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = 60.0,
        today_fn: Callable[[], str] = _today_kst_yyyymmdd,
        observed_at_store_path: Path | None = None,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._today_fn = today_fn
        self._observed_at_store = (
            _InvestorEstimateObservedAtStore(observed_at_store_path)
            if observed_at_store_path is not None
            else None
        )
        self._cache: dict[
            tuple[str, str],
            tuple[float, LiveInvestorTrendEstimateResponse],
        ] = {}
        self._accumulator: dict[
            tuple[str, str],
            dict[str, LiveInvestorTrendEstimateRow],
        ] = {}
        self._last_success_fetched_at_ms: dict[tuple[str, str], int] = {}
        self._inflight: dict[
            tuple[str, str],
            asyncio.Task[LiveInvestorTrendEstimateResponse],
        ] = {}

    def credentials_missing(self, code: str) -> LiveInvestorTrendEstimateResponse:
        trading_day = self._today_fn()
        return self._response(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=None,
            rows=[],
            status="error",
            warning=LiveInvestorTrendEstimateWarning(
                reason="kis_credentials_missing",
                msg="KIS credentials are not configured",
            ),
        )

    async def fetch(
        self,
        kis: "KisClient",
        code: str,
    ) -> LiveInvestorTrendEstimateResponse:
        trading_day = self._today_fn()
        key = (trading_day, code)
        now = monotonic_time.monotonic()
        self._evict_stale(now=now, trading_day=trading_day)
        cached = self._cache.get(key)
        if cached is not None:
            expires_at, response = cached
            if now < expires_at:
                return response

        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._fetch_uncached(kis, code, trading_day))
            self._inflight[key] = task
            task.add_done_callback(lambda _t, k=key: self._inflight.pop(k, None))
        return await task

    async def _fetch_uncached(
        self,
        kis: "KisClient",
        code: str,
        trading_day: str,
    ) -> LiveInvestorTrendEstimateResponse:
        key = (trading_day, code)
        try:
            raw_rows = await kis.fetch_investor_trend_estimate(code)
            fetched_at_ms = int(monotonic_time.time() * 1000)
            rows = [
                _investor_estimate_row_to_wire(r, observed_at_ms=fetched_at_ms)
                for r in raw_rows
            ]
            if self._observed_at_store is not None:
                rows = self._observed_at_store.apply(
                    trading_day=trading_day,
                    code=code,
                    rows=rows,
                    fetched_at_ms=fetched_at_ms,
                    full_history=len(rows) > 1,
                )
        except KisAuthError:
            log.warning("investor trend estimate auth failed for %s", code, exc_info=True)
            response = self._error_response(
                code,
                trading_day,
                "kis_credentials_missing",
                "KIS authentication failed",
            )
            return self._cache_response(key, response)
        except KisRateLimitError as e:
            response = self._error_response(code, trading_day, "kis_rate_limit", str(e))
            return self._cache_response(key, response)
        except KisTransportError as e:
            response = self._error_response(code, trading_day, "kis_api_error", e.msg_cd)
            return self._cache_response(key, response)
        except KisApiError as e:
            response = self._error_response(code, trading_day, "kis_api_error", e.msg_cd)
            return self._cache_response(key, response)
        except ValidationError as e:
            response = self._error_response(code, trading_day, "parse_error", str(e))
            return self._cache_response(key, response)

        if not rows:
            self._accumulator[key] = {}
            if self._observed_at_store is not None:
                self._observed_at_store.clear(trading_day=trading_day, code=code)
            response = self._response(
                code=code,
                trading_day=trading_day,
                fetched_at_ms=fetched_at_ms,
                rows=[],
                status="empty",
                warning=None,
            )
            return self._cache_response(key, response)

        if len(rows) > 1:
            prior = self._accumulator.get(key, {})
            self._accumulator[key] = {
                row.slot: _preserve_investor_estimate_observed_at(
                    previous=prior.get(row.slot),
                    current=row,
                )
                for row in rows
            }
        else:
            current = self._accumulator.setdefault(key, {})
            for row in rows:
                current[row.slot] = _preserve_investor_estimate_observed_at(
                    previous=current.get(row.slot),
                    current=row,
                )

        merged = list(self._accumulator.get(key, {}).values())
        status: Literal["ok", "empty"] = (
            "ok" if any(_investor_estimate_has_quantity(row) for row in merged) else "empty"
        )
        if status == "ok":
            self._last_success_fetched_at_ms[key] = fetched_at_ms
        response = self._response(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=fetched_at_ms,
            rows=merged,
            status=status,
            warning=None,
        )
        return self._cache_response(key, response)

    def _cache_response(
        self,
        key: tuple[str, str],
        response: LiveInvestorTrendEstimateResponse,
    ) -> LiveInvestorTrendEstimateResponse:
        self._cache[key] = (monotonic_time.monotonic() + self._ttl_seconds, response)
        self._evict_over_capacity(trading_day=key[0])
        return response

    def _evict_stale(self, *, now: float, trading_day: str) -> None:
        for key, (expires_at, _response) in list(self._cache.items()):
            if key[0] != trading_day or now >= expires_at:
                self._cache.pop(key, None)
        for state in (self._accumulator, self._last_success_fetched_at_ms):
            for key in list(state):
                if key[0] != trading_day:
                    state.pop(key, None)

    def _evict_over_capacity(self, *, trading_day: str) -> None:
        day_keys = [
            key
            for key in set(self._cache) | set(self._accumulator) | set(self._last_success_fetched_at_ms)
            if key[0] == trading_day
        ]
        overflow = len(day_keys) - _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY
        if overflow <= 0:
            return
        oldest = sorted(
            day_keys,
            key=lambda key: (
                self._last_success_fetched_at_ms.get(key, -1),
                self._cache.get(key, (0.0, None))[0],
            ),
        )[:overflow]
        for key in oldest:
            self._cache.pop(key, None)
            self._accumulator.pop(key, None)
            self._last_success_fetched_at_ms.pop(key, None)

    def _error_response(
        self,
        code: str,
        trading_day: str,
        reason: InvestorEstimateWarningReason,
        msg: str,
    ) -> LiveInvestorTrendEstimateResponse:
        key = (trading_day, code)
        fetched_at_ms = self._last_success_fetched_at_ms.get(key)
        rows = list(self._accumulator.get(key, {}).values())
        return self._response(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=fetched_at_ms,
            rows=rows,
            status="error",
            warning=LiveInvestorTrendEstimateWarning(reason=reason, msg=msg),
        )

    def _response(
        self,
        *,
        code: str,
        trading_day: str,
        fetched_at_ms: int | None,
        rows: list[LiveInvestorTrendEstimateRow],
        status: Literal["ok", "empty", "error"],
        warning: LiveInvestorTrendEstimateWarning | None,
    ) -> LiveInvestorTrendEstimateResponse:
        return LiveInvestorTrendEstimateResponse(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=fetched_at_ms,
            rows=rows,
            latest=_latest_investor_estimate_row(rows),
            source="kis",
            status=status,
            data_warning=warning,
        )


def _preserve_investor_estimate_observed_at(
    previous: LiveInvestorTrendEstimateRow | None,
    current: LiveInvestorTrendEstimateRow,
) -> LiveInvestorTrendEstimateRow:
    if previous is None:
        return current
    if _investor_estimate_same_quantities(previous, current):
        return current.model_copy(update={"observed_at_ms": previous.observed_at_ms})
    return current


def build_router(
    get_status: Callable[[], LiveStatus],
    get_buffer: Callable[[], LiveBuffer] | None = None,
    on_control: Callable[[str], Awaitable[None]] | None = None,
    get_today_ask_peak: Callable[[str], dict | None] | None = None,
    get_today_bid_peak: Callable[[str], dict | None] | None = None,
    *,
    data_dir: Path | None = None,
) -> APIRouter:
    """Build the /api/live router.

    Args:
        get_status: zero-arg callable returning the current `LiveStatus`.
        get_buffer: optional zero-arg callable returning the `LiveBuffer`
            singleton. None → /snapshot and /series return 503.
        on_control: optional handler invoked with the action string when
            POST /control is called. None → returns 503 for control requests.
        get_today_ask_peak: optional callable returning the current
            ask-peak-today snapshot for a code. None → /series returns null.
        get_today_bid_peak: optional callable returning the current
            bid-peak-today snapshot for a code. None → /series returns null.
    """
    router = APIRouter(prefix="/api/live")

    @router.get("/status", response_model=LiveStatus)
    async def _get_status() -> LiveStatus:
        return get_status()

    @router.get("/indices", response_model=LiveIndicesResponse)
    async def _get_indices() -> LiveIndicesResponse:
        return LiveIndicesResponse(
            indices=[
                LiveIndexEntry(
                    id=index.id,
                    label=index.label,
                    investor_scope=index.investor_scope,
                )
                for index in list_representative_indices()
            ],
        )

    @router.get("/index-candles")
    async def _get_index_candles(
        index_id: str = Query(...),
        timeframe: Literal["1m", "3m", "5m", "10m", "15m", "30m", "D", "W", "M"] = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        index = _validate_index_range(index_id, from_, to)
        if data_dir is None:
            raise HTTPException(503, "KIS client not wired")
        kis = kis_access.kis_for_role("foreground", data_dir)
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if timeframe in {"D", "W", "M"}:
            result = await kis.fetch_index_daily_candles(
                index,
                from_,
                to,
                period=timeframe,
                foreground=True,
            )
        else:
            bucket_seconds = {
                "1m": 60,
                "3m": 180,
                "5m": 300,
                "10m": 600,
                "15m": 900,
                "30m": 1800,
            }[timeframe]
            result = await kis.fetch_index_minute_candles(
                index,
                from_,
                to,
                bucket_seconds=bucket_seconds,
                foreground=True,
            )
        batch_label = f"{from_}__{to}"
        return {
            "index_id": index.id,
            "from": from_,
            "to": to,
            "timeframe": timeframe,
            "candles": [_candle_to_dict(c) for c in result.candles],
            "data_warnings": [
                _violation_to_warning(v, batch_label) for v in result.violations
            ],
        }

    @router.get("/index-investor-net")
    async def _get_index_investor_net(
        index_id: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        index = _validate_index_range(index_id, from_, to)
        if index.investor_scope != "market":
            raise HTTPException(
                422,
                {
                    "code": "unsupported_index_investor_net",
                    "msg": f"{index.id} does not support market investor net",
                },
            )
        if data_dir is None:
            raise HTTPException(503, "KIS client not wired")
        kis = kis_access.kis_for_role("background", data_dir)
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        result = await kis.fetch_market_investor_net(index, from_, to)
        batch_label = f"{from_}__{to}"
        return {
            "index_id": index.id,
            "from": from_,
            "to": to,
            "points": [_investor_point_to_dict(p) for p in result.points],
            "data_warnings": [
                _violation_to_warning(v, batch_label) for v in result.violations
            ],
        }

    @router.get("/index-sector-rankings", response_model=IndexSectorRankingResponse)
    async def _get_index_sector_rankings(date: str = Query(...)) -> IndexSectorRankingResponse:
        basis = _parse_yyyymmdd(date)
        if basis is None:
            raise HTTPException(422, {"code": "invalid_date", "msg": "date must be YYYYMMDD"})
        if date > _today_kst_yyyymmdd():
            raise HTTPException(422, {"code": "date_in_future", "msg": "date must be <= today_kst"})
        return build_index_sector_rankings(data_dir, date).model_dump()

    @router.post("/control")
    async def _post_control(req: ControlRequest) -> dict[str, str]:
        if on_control is None:
            raise HTTPException(503, "live control not wired (Stage 8)")
        await on_control(req.action)
        return {"action": req.action, "ok": "true"}

    @router.get("/snapshot")
    async def _get_snapshot(code: str) -> dict:
        if get_buffer is None:
            raise HTTPException(503, "live buffer not wired")
        buf = get_buffer()
        latest = await buf.get_latest(code)
        if latest is None:
            raise HTTPException(404, f"no live data for {code}")
        return latest

    @router.get("/series")
    async def _get_series(code: str, date: str) -> dict:
        if get_buffer is None:
            raise HTTPException(503, "live buffer not wired")
        buf = get_buffer()
        series = await buf.get_series(code)
        kst = timezone(timedelta(hours=9))
        dt = datetime.strptime(date, "%Y%m%d").replace(tzinfo=kst)
        session_open_ms = int(dt.replace(hour=9, minute=0).timestamp() * 1000)
        return {
            **series,
            "date": date,
            "session_open_ms": session_open_ms,
            "session_close_ms": None,
            "is_open": True,
            "ask_peak_today": (
                get_today_ask_peak(code) if get_today_ask_peak is not None else None
            ),
            "bid_peak_today": (
                get_today_bid_peak(code) if get_today_bid_peak is not None else None
            ),
        }

    # 시세 오버레이 fetch+캐시+게이팅은 LiveQuoteFetcher 가 소유. build_router 호출마다
    # 새 인스턴스라 마지막-시세 캐시 스코프는 종전(per-router 클로저)과 동일.
    _quote_fetcher = LiveQuoteFetcher()
    _investor_estimate_fetcher = LiveInvestorEstimateFetcher(
        observed_at_store_path=(
            data_dir / "live" / "investor-trend-estimate-observed-at.json"
            if data_dir is not None
            else None
        )
    )

    def _kis_for_background() -> "KisClient | None":
        """배경 REST(quotes·investor-net·investor-trend-estimate)용 KisClient — N=2면 account 1(직전엔 유휴였던
        REST 버킷), 아니면 account 0 폴백(kis_access.kis_for_role, 계정 분리 2026-06-09).
        foreground(past-candles/daily)는 account 0 전용이라 이 헬퍼를 쓰지 않는다.
        data_dir 미배선(베어 단위테스트)이면 None — kis_for_role은 env/싱글톤(프로세스
        전역)을 보므로 data_dir이 client 라우팅 활성화 신호다(C1b 2026-06-10: 이중 주입
        seam을 role 하나로 접어 get_kis_client else 폴백 잔재 소멸)."""
        if data_dir is None:
            return None
        return kis_access.kis_for_role("background", data_dir)

    @router.get("/quotes", response_model=LiveQuotesResponse)
    async def _get_quotes(codes: str = Query(...)) -> LiveQuotesResponse:
        phase = _quote_phase(datetime.now(_KST))
        code_list = [c for c in codes.split(",") if _CODE_RE.match(c)]
        if not code_list:
            return LiveQuotesResponse(phase=phase, quotes=[])
        # 배경 라우트: N=2면 account 1, 아니면 account 0(env 지연 생성 포함, kis_for_role).
        kis = _kis_for_background()
        if kis is None:
            return LiveQuotesResponse(phase=phase, quotes=[])
        return LiveQuotesResponse(
            phase=phase,
            quotes=await _quote_fetcher.fetch_and_gate(kis, code_list, phase),
        )

    @router.get(
        "/investor-trend-estimate",
        response_model=LiveInvestorTrendEstimateResponse,
    )
    async def _get_investor_trend_estimate(
        code: str = Query(...),
    ) -> LiveInvestorTrendEstimateResponse:
        if not _CODE_RE.match(code):
            raise HTTPException(
                422,
                {"code": "invalid_code", "msg": "code must be 6 digits"},
            )
        kis = _kis_for_background()
        if kis is None:
            return _investor_estimate_fetcher.credentials_missing(code)
        return await _investor_estimate_fetcher.fetch(kis, code)

    # past-candles 병렬 fetch의 총량 제어 — 라우터(=프로세스, ADR-0038 단일
    # 워커) 수준 공유: 동시 요청 2건이 떠도 KIS in-flight 합계 ≤ 5.
    # py3.11의 asyncio.Semaphore는 첫 acquire에서 루프를 lazy-bind하므로
    # 앱 생성 시점(루프 밖) 생성이 안전하다.
    _past_fetch_sem = asyncio.Semaphore(_PAST_CANDLES_CONCURRENCY)

    # 싱글플라이트(spec 2026-06-08 §4.3): 같은 (code, date)의 동시 fetch를 한
    # KIS 콜로 공유 — 두 탭/60초 refetch 경합의 쿼터 절약(파일 안전성은
    # atomic_write_json이 이미 보장하므로 목적이 아님). ADR-0038 단일 워커라
    # in-process dict로 충분. done_callback이 항상 entry를 회수한다.
    _past_inflight: dict[tuple[KisVenue, str, str], asyncio.Task[tuple[list[dict], str | None]]] = {}

    async def _fetch_past_shared(
        kis: KisClient, venue: KisVenue, code: str, date_s: str
    ) -> tuple[list[dict], str | None]:
        """(bars, cache_write_failed_msg) 반환. 진행 중인 동일 키 fetch가 있으면
        그 결과를 공유한다. 예외(KisRateLimitError 등)는 공유자 전원에 동일
        전파 — 각 요청의 except 분기가 각자 warning을 만든다. 리더 요청이
        취소돼도 create_task로 분리된 공유 task는 완주한다."""
        key = (venue, code, date_s)
        task = _past_inflight.get(key)
        if task is None:
            async def _do() -> tuple[list[dict], str | None]:
                raw = await kis.fetch_past_minute_candles(
                    code, date_s, venue=venue, foreground=True,
                )
                bars = [_candle_to_dict(c) for c in raw]
                try:
                    cache_instance.store_past(venue, code, date_s, bars)  # type: ignore[union-attr]
                except OSError as e:
                    return bars, str(e)
                return bars, None

            task = asyncio.create_task(_do())
            _past_inflight[key] = task
            task.add_done_callback(lambda _t, k=key: _past_inflight.pop(k, None))
        return await task

    cache_instance: PastCandlesCache | None = (
        PastCandlesCache(data_dir=data_dir) if data_dir is not None else None
    )
    daily_cache_instance: PastDailyCandlesCache | None = (
        PastDailyCandlesCache() if data_dir is not None else None
    )
    # Investor net-buy reuses the daily candle cache (ADR-0055): same date-cursor
    # walk-back + batch/gap memory cache shape, just storing point dicts.
    investor_cache_instance: PastDailyCandlesCache | None = (
        PastDailyCandlesCache() if data_dir is not None else None
    )

    @router.get("/past-candles")
    async def _get_past_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> dict:
        frm, too, today_d = _validate_past_request(code, from_, to)
        today_s = today_d.strftime("%Y%m%d")
        try:
            policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": "invalid_venue", "msg": str(e)}) from e
        # foreground(사용자 차트 백필): account 0 전용(15/s, 배경과 비경합). C1b 2026-06-10:
        # get_kis_client 주입 대신 kis_access 단일 seam 경유(data_dir이 라우팅 신호).
        if data_dir is None:
            raise HTTPException(503, "KIS client not wired")
        kis = kis_access.kis_for_role("foreground", data_dir)
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if cache_instance is None:
            raise HTTPException(503, "past-candles cache not wired (data_dir missing)")
        cache = cache_instance

        async def _collect_for_venue(kis_venue: KisVenue) -> dict:
            # ── 1차 패스(동기, KIS 콜 없음): 캐시 히트 수집 + 병렬 fetch 대상 분류.
            rows: dict[str, list[dict]] = {}
            cached_dates: list[str] = []
            pending: list[str] = []
            warnings_by_date: dict[str, dict] = {}
            fresh: set[str] = set()

            for date_s in _date_iter(frm, too):
                if date_s >= today_s:
                    continue
                bars = cache.get_past(kis_venue, code, date_s)
                if bars is None:
                    pending.append(date_s)
                else:
                    rows[date_s] = bars
                    cached_dates.append(date_s)

            blocked = asyncio.Event()

            async def _one(date_s: str) -> None:
                async with _past_fetch_sem:
                    if blocked.is_set():
                        warnings_by_date[date_s] = {
                            "date": date_s, "reason": "rate_limit_aborted",
                            "msg": "previous date hit rate limit",
                        }
                        return
                    try:
                        bars, write_err = await _fetch_past_shared(kis, kis_venue, code, date_s)
                    except KisRateLimitError as e:
                        blocked.set()
                        warnings_by_date[date_s] = {
                            "date": date_s, "reason": "kis_rate_limit", "msg": str(e),
                        }
                        return
                    except KisApiError as e:
                        warnings_by_date[date_s] = {
                            "date": date_s, "reason": "kis_api_error", "msg": e.msg_cd,
                        }
                        return
                    rows[date_s] = bars
                    fresh.add(date_s)
                    if write_err is not None:
                        warnings_by_date[date_s] = {
                            "date": date_s, "reason": "cache_write_failed", "msg": write_err,
                        }

            await asyncio.gather(*(_one(d) for d in pending))

            candles_all: list[dict] = []
            fresh_dates: list[str] = []
            warnings: list[dict] = []
            kis_blocked = blocked.is_set()

            for date_s in _date_iter(frm, too):
                if date_s < today_s:
                    if date_s in rows:
                        candles_all.extend(rows[date_s])
                        if date_s in fresh:
                            fresh_dates.append(date_s)
                    if date_s in warnings_by_date:
                        warnings.append(warnings_by_date[date_s])
                    continue
                try:
                    state, today_bars = cache.get_today_tri(kis_venue, code)
                    if state == "hit":
                        assert today_bars is not None
                        bars = today_bars
                        cached_dates.append(date_s)
                    elif state == "negative":
                        bars = []
                    else:
                        if kis_blocked:
                            warnings.append({"date": date_s, "reason": "rate_limit_aborted", "msg": "previous date hit rate limit"})
                            continue
                        raw = await kis.fetch_past_minute_candles(
                            code, date_s, venue=kis_venue, foreground=True,
                        )
                        bars = [_candle_to_dict(c) for c in raw]
                        if bars:
                            cache.store_today(kis_venue, code, bars)
                            fresh_dates.append(date_s)
                        else:
                            cache.store_today(kis_venue, code, None)
                    candles_all.extend(bars)
                except KisRateLimitError as e:
                    warnings.append({"date": date_s, "reason": "kis_rate_limit", "msg": str(e)})
                    kis_blocked = True
                except KisApiError as e:
                    warnings.append({"date": date_s, "reason": "kis_api_error", "msg": e.msg_cd})

            return {
                "candles": candles_all,
                "cached_dates": cached_dates,
                "fresh_dates": fresh_dates,
                "data_warnings": warnings,
            }

        if policy == "AUTO":
            krx_out, nxt_out = await asyncio.gather(
                _collect_for_venue("KRX"),
                _collect_for_venue("NXT"),
            )
            return {
                "code": code,
                "from": from_,
                "to": to,
                "venue": policy,
                "candles": merge_auto_minute_bars(
                    krx_out["candles"],
                    nxt_out["candles"],
                    hhmmss_for_t_ms=_hhmmss_from_t_ms,
                ),
                "cached_dates": sorted(set(krx_out["cached_dates"]) | set(nxt_out["cached_dates"])),
                "fresh_dates": sorted(set(krx_out["fresh_dates"]) | set(nxt_out["fresh_dates"])),
                "data_warnings": krx_out["data_warnings"] + nxt_out["data_warnings"],
            }

        out = await _collect_for_venue(policy)
        return {"code": code, "from": from_, "to": to, "venue": policy, **out}

    @router.get("/past-daily-candles")
    async def _get_past_daily_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> dict:
        frm, too, today_d = _validate_past_request(code, from_, to, max_days=None)
        try:
            policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": "invalid_venue", "msg": str(e)}) from e
        kis_venue = daily_venue_for_policy(policy)
        # foreground(사용자 일봉 백필): account 0 전용. C1b 2026-06-10: kis_access 단일 seam.
        if data_dir is None:
            raise HTTPException(503, "KIS client not wired")
        kis = kis_access.kis_for_role("foreground", data_dir)
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if daily_cache_instance is None:
            raise HTTPException(503, "past-daily-candles cache not wired (data_dir missing)")

        fallback_warnings: list[dict] = []

        async def fetch_batch(code_: str, from_s: str, to_s: str):
            # foreground=True: 사용자 일봉 차트 백필 (우선순위 레인). 스크리너 EOD
            # 배치(screener*.py)는 default background로 사용자 fetch에 양보.
            result = await kis.fetch_past_daily_candles(
                code_, from_s, to_s, venue=kis_venue, foreground=True,
            )
            if kis_venue != "KRX" and not result.candles and not result.violations:
                fallback = await kis.fetch_past_daily_candles(
                    code_, from_s, to_s, venue="KRX", foreground=True,
                )
                if fallback.candles:
                    fallback_warnings.append(
                        _daily_fallback_to_krx_warning(kis_venue, f"{from_s}__{to_s}")
                    )
                    result = fallback
            return [_candle_to_dict(c) for c in result.candles], result.violations

        class _VenueDailyCacheAdapter:
            def __init__(self, inner: PastDailyCandlesCache, venue_: KisVenue) -> None:
                self._inner = inner
                self._venue = venue_

            def list_batches(self, code_: str):
                return self._inner.list_batches(self._venue, code_)

            def append_batch(self, code_: str, frm_: date, to_: date, bars: list[dict]) -> None:
                self._inner.append_batch(self._venue, code_, frm_, to_, bars)

            def get_today(self, code_: str):
                return self._inner.get_today(self._venue, code_)

            def store_today(self, code_: str, bar: dict | None) -> None:
                self._inner.store_today(self._venue, code_, bar)

        out = await batched_daily_walkback(
            cache=_VenueDailyCacheAdapter(daily_cache_instance, kis_venue),  # type: ignore[arg-type]
            fetch_batch=fetch_batch,
            output_key="candles",
            code=code, frm=frm, too=too, today_d=today_d,
        )
        out["venue"] = policy
        out["data_warnings"].extend(fallback_warnings)
        if policy == "AUTO":
            warning = AUTO_DAILY_USES_INTEGRATED_WARNING.copy()
            warning["batch"] = f"{from_}__{to}"
            out["data_warnings"].append(warning)
        return out

    @router.get("/past-investor-net")
    async def _get_past_investor_net(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        """Daily foreign/institution net-buy quantities across [from, to].

        KIS investor-trade-by-stock-daily (FHPTJ04160001) supports date-cursor
        walk-back (ADR-0055), so this mirrors /past-daily-candles: batch/gap
        memory cache + per-gap walk-back fetch + today tri-state. Net-buy is
        signed (+ buy / − sell). Today's row is provisional until ~15:40 (가집계).
        """
        frm, too, today_d = _validate_past_request(code, from_, to, max_days=None)
        # 배경 라우트(2차 오버레이): N=2면 account 1, 아니면 account 0 폴백.
        kis = _kis_for_background()
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if investor_cache_instance is None:
            raise HTTPException(503, "past-investor-net cache not wired (data_dir missing)")

        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await kis.fetch_investor_net(code_, from_s, to_s)
            return [_investor_point_to_dict(p) for p in result.points], result.violations

        return await batched_daily_walkback(
            cache=investor_cache_instance, fetch_batch=fetch_batch, output_key="points",
            code=code, frm=frm, too=too, today_d=today_d,
        )

    return router
