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
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Literal, NamedTuple

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from hoga.api import symbols
from hoga.api.error_codes import LiveErrorCode
from hoga.api.models import LiveSettingsResponse, LiveSettingsUpdate
from hoga.api.params import CODE_PATTERN
from hoga.live import (
    kis_runtime,
    kiwoom_access,
    kiwoom_index_rest,
    kiwoom_investor,
    kiwoom_minute_candles,
    kiwoom_multi_quote,
    kiwoom_rest_runtime,
    kiwoom_runtime,
)
from hoga.live.error_policy import classify_live_error
from hoga.live.index_candles_cache import (
    IndexCandlesCache,
    collect_index_candles_with_cache,
)
from hoga.live.index_cold_fetch import fetch_index_daily_candles_windowed
from hoga.live.index_minute_candles_cache import (
    IndexMinuteCacheKey,
    IndexMinuteCandlesCache,
    collect_index_minute_candles_with_cache,
)
from hoga.live.index_registry import (
    UnknownRepresentativeIndex,
    get_representative_index,
    list_representative_indices,
)
from hoga.live.investor import InvestorTrendEstimateRow
from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisRateLimitError,
)
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import (
    KiwoomApiError,
    KiwoomAuthError,
    KiwoomRateLimitError,
    KiwoomRestError,
    KiwoomTerminalAuthError,
)
from hoga.live.kiwoom_index_candles import (
    KiwoomIndexCandlesError,
    KiwoomIndexCandlesFetcher,
    supports_bucket_seconds as kiwoom_supports_bucket,
)
from hoga.live.kiwoom_rankings import (
    Direction as RankingDirection,
    KiwoomRankingsError,
    KiwoomRankingsFetcher,
    Market as RankingMarket,
    RankingKind,
)
from hoga.live.kiwoom_rest import KiwoomRestClient, PageFetch
from hoga.live.kiwoom_stock_info import KiwoomStockInfoError, KiwoomStockInfoFetcher
from hoga.live.live_candle_backfill import LiveMinuteCandleBackfill
from hoga.live.live_daily_candle_backfill import LiveDailyCandleBackfill
from hoga.live.live_index_investor_net import LiveIndexInvestorNetFetcher
from hoga.live.live_index_sector_intraday import LiveIndexSectorIntradayOverlay
from hoga.live.live_investor_net_backfill import LiveInvestorNetBackfill
from hoga.live.past_candles_cache import PastCandlesCache
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache
from hoga.live.quote_change_resolver import QuoteChangeResolver
from hoga.live.quote_models import Quote
from hoga.live.screener_daily_candles import read_screener_daily_candles
from hoga.live.venue import LiveVenuePolicy, Venue, parse_live_venue_policy, quote_venue_for_policy
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

from . import settings as live_settings
from .buffer import LiveBuffer
from .index_sector_rankings import (
    IndexSectorRankingResponse,
    build_index_sector_rankings,
)
from .lifecycle import LiveStatus, refresh_live_stream
from .settings import load_live_settings, update_live_settings

if TYPE_CHECKING:
    pass

ControlAction = Literal["start", "stop", "pause"]

log = logging.getLogger(__name__)

_PAST_MAX_DAYS = 250

# past-candles 미캐시 날짜 병렬 fetch 동시 상한 — 계정(앱키)당 슬롯 수 (spec
# 2026-06-08 §4.1; ADR-0100 계정 비례화). 산식: RTT ~200ms → 슬롯당 ~5콜/초 →
# 계정당 3슬롯이 그 계정 15콜/초 토큰버킷의 자연 포화점. REST 유량이 앱키별
# 독립(ADR-0100)이라 configured 계정 수에 비례해 슬롯을 늘려야 aggregate
# 예산(~15콜/초×계정수)을 포화시킨다(3계정=9슬롯). 단일 계정은 3 유지 —
# 계정당 5슬롯은 한 날짜가 여러 분봉 페이지를 호출하는 구조라 EGW00201 상황에서
# 동시 retry 폭을 키웠던 실측이라, 계정당 상한은 3을 넘기지 않는다. 전체 상한 12는
# max_fresh_dates_per_collect(=12)와 정합(한 collect의 fresh 날짜를 다 병렬화).
_PAST_CANDLES_CONCURRENCY_PER_ACCOUNT = 3
_PAST_CANDLES_CONCURRENCY_MAX = 12
_PAST_CANDLES_RATE_LIMIT_COOLDOWN_S = 10.0


def _past_candles_concurrency(data_dir) -> int:
    """계정 수 비례 past-candles 동시 상한 (ADR-0100). 단일 계정 3 → 3계정 9 →
    상한 12. 계정 수는 REST 유량 예산의 배수라 그대로 슬롯 배수로 쓴다."""
    n_accounts = (
        len(kis_runtime.configured_account_ids(data_dir)) if data_dir is not None else 1
    )
    return min(
        _PAST_CANDLES_CONCURRENCY_PER_ACCOUNT * max(1, n_accounts),
        _PAST_CANDLES_CONCURRENCY_MAX,
    )
_CODE_RE = re.compile(CODE_PATTERN)
# 정본은 hoga.util.timeenc.KST 하나다 — 벤더별로 다른 값이 아니다.
_KST = KST
_INVESTOR_ESTIMATE_MAX_CODES_PER_DAY = 256
# 추정 수급 행의 값 필드 — 수량 3 + 금액 3. 관측시각 판정·저장·직렬화가 모두 이
# 목록을 돈다. 축을 추가하면 여기 한 곳만 늘린다.
_INVESTOR_ESTIMATE_VALUE_FIELDS = (
    "foreign_qty", "institution_qty", "sum_qty",
    "foreign_amt_mwon", "institution_amt_mwon", "sum_amt_mwon",
)
index_candles_cache_instance: IndexCandlesCache | None = None
# ka10001 fetcher — 프로세스 싱글톤(httpx.Client 보유). build_router 재호출(테스트)
# 마다 새 클라이언트가 새지 않도록 index_candles_cache_instance 와 같은 패턴.
kiwoom_stock_info_fetcher_instance: KiwoomStockInfoFetcher | None = None
kiwoom_rankings_fetcher_instance: KiwoomRankingsFetcher | None = None
index_minute_candles_cache_instance: IndexMinuteCandlesCache | None = None
# ka20005 fetcher — 지수 **분봉** 전용(ADR-0129). 키움 자격증명이 있을 때만 만들어지고,
# None 이면 지수 분봉이 KIS 로 간다(= ADR-0129 이전 동작). 이 None 여부가 소스 선택의
# 유일한 축이다 — 요청 중에 바뀌지 않는다(D3).
_kiwoom_index_fetcher: KiwoomIndexCandlesFetcher | None = None
_KIWOOM_INDEX_MINUTE_API_ID = "ka20005"


def _index_minute_available(bucket_seconds: int) -> bool:
    """지수 분봉을 받을 수 있나.

    ADR-0129 가 키움으로 이관했고 PR-J(#1046)에서 **KIS 갈래가 사라졌다** — 이제
    소스를 고르는 것이 아니라 "받을 수 있나" 만 남는다. 폴백 사다리를 만들지
    않는다는 ADR-0129 D3 의 판단은 그대로다: 소스 경계에서 값이 튀고(실측 15:30
    종가 불일치) "지금 어느 소스인가" 가 요청마다 달라진다.
    """
    return _kiwoom_index_fetcher is not None and kiwoom_supports_bucket(bucket_seconds)

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


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms, "open": c.open, "high": c.high, "low": c.low,
        "close": c.close, "volume": c.volume,
    }


def _candle_date_yyyymmdd(c) -> str:
    return datetime.fromtimestamp(c.t_ms / 1000, tz=_KST).strftime("%Y%m%d")


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
        raise HTTPException(422, {"code": LiveErrorCode.INVALID_CODE, "message": "code must be 6 digits"})
    frm = _parse_yyyymmdd(from_)
    too = _parse_yyyymmdd(to)
    if frm is None or too is None:
        raise HTTPException(422, {"code": LiveErrorCode.INVALID_DATE, "message": "from/to must be YYYYMMDD"})
    if frm > too:
        raise HTTPException(422, {"code": LiveErrorCode.FROM_AFTER_TO, "message": "from must be <= to"})
    today_d = _today_kst_date()
    if too > today_d:
        raise HTTPException(422, {"code": LiveErrorCode.DATE_IN_FUTURE, "message": "to must be <= today_kst"})
    if max_days is not None:
        span_days = (too - frm).days + 1
        if span_days > max_days:
            raise HTTPException(
                422,
                {"code": LiveErrorCode.DATE_RANGE_TOO_LARGE, "message": f"max {max_days} days", "max_days": max_days},
            )
    return frm, too, today_d


def _validate_index_range(index_id: str, from_: str, to: str):
    try:
        index = get_representative_index(index_id)
    except UnknownRepresentativeIndex as e:
        raise HTTPException(
            422,
            {"code": LiveErrorCode.INVALID_INDEX_ID, "message": "unknown representative index"},
        ) from e
    if index.kis_index_code is None:
        raise HTTPException(
            422,
            {"code": LiveErrorCode.UNSUPPORTED_INDEX, "message": f"{index.id} is not supported by KIS index routes"},
        )
    frm = _parse_yyyymmdd(from_)
    too = _parse_yyyymmdd(to)
    if frm is None or too is None:
        raise HTTPException(422, {"code": LiveErrorCode.INVALID_DATE, "message": "from/to must be YYYYMMDD"})
    if frm > too:
        raise HTTPException(422, {"code": LiveErrorCode.FROM_AFTER_TO, "message": "from must be <= to"})
    today_d = _today_kst_date()
    if too > today_d:
        raise HTTPException(422, {"code": LiveErrorCode.DATE_IN_FUTURE, "message": "to must be <= today_kst"})
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


def _vendor_error_to_warning(exc: BaseException, batch_label: str) -> dict:
    """벤더 실패를 핸들러가 내보내는 와이어 경고로. **사유·원문 모두 정책이 정한다.**

    분봉 경로의 `live_candle_backfill._rest_error_warning` 과 같은 규율이다(ADR-0137) —
    일봉만 손으로 사유를 적고 있어서 두 경로의 분해능이 달랐다. 특히 `msg` 가 벤더
    코드 한 조각(`_vendor_code`)이었던 탓에, 키움 실패는 `return_code` 인 `"3"` 만
    떠서 대괄호 안의 진짜 코드(`8050`·`8005`)와 한글 문구가 **화면에 도달하지 못했다**.
    `policy.message` 는 벤더 원문 그대로라 프론트 칩 툴팁이 그걸 보여 준다.

    `date` field is intentionally omitted — these errors apply to the whole
    batch range, not a single date (companion to `_violation_to_warning`).
    """
    policy = classify_live_error(exc)
    return {"batch": batch_label, "reason": policy.reason, "msg": policy.message}


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


def _kis_rest_bypassed_batch_warning(batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "reason": "rest_bypassed",
        "msg": "KIS REST bypass is enabled; served cache-only data",
    }


def _kis_capacity_degraded_batch_warning(batch_label: str, reason: str) -> dict:
    """/index-candles가 KIS 용량 한계(쿨다운/오버로드)에 걸렸을 때, HTTP 500 대신
    비차단 data_warning으로 강등한다 (2026-07-08 KIS audit Fix C — quotes 핸들러와
    동일 정책). bypass 경고와 별도 reason이라 프론트가 '일시 지연'으로 구분한다."""
    return {
        "batch": batch_label,
        "reason": reason,
        "msg": "KIS 호출 용량 한계로 지수 캔들을 지금 불러오지 못했습니다 — 잠시 후 재시도",
    }


def _collect_daily_series_cache_only(
    *,
    cache: PastDailyCandlesCache,
    output_key: str,
    code: str,
    frm: date,
    too: date,
    today_d: date,
    from_label: str,
    to_label: str,
) -> dict:
    loaded: list[dict] = []
    cached_batches: list[str] = []
    covered: list[tuple[date, date]] = []

    for batch_from, batch_to, rows in cache.list_batches(code):
        if batch_to < frm or batch_from > too:
            continue
        covered.append((batch_from, batch_to))
        loaded.extend(rows)
        cached_batches.append(f"{batch_from.strftime('%Y%m%d')}__{batch_to.strftime('%Y%m%d')}")

    if too >= today_d:
        today_s = today_d.strftime("%Y%m%d")
        state, today_row = cache.get_today(code)
        if state == "hit":
            loaded.append(today_row)  # type: ignore[arg-type]
            covered.append((today_d, today_d))
            cached_batches.append(f"{today_s}__{today_s}")
        elif state == "negative":
            covered.append((today_d, today_d))

    data_warnings = [
        _kis_rest_bypassed_batch_warning(
            f"{gap_from.strftime('%Y%m%d')}__{gap_to.strftime('%Y%m%d')}"
        )
        for gap_from, gap_to in _compute_daily_gaps(frm, too, covered)
    ]

    frm_ms = int(datetime.combine(frm, time(0, 0), tzinfo=_KST).timestamp() * 1000)
    too_ms = int(datetime.combine(too, time(23, 59, 59), tzinfo=_KST).timestamp() * 1000)
    by_ts: dict[int, dict] = {}
    for row in loaded:
        ts = row.get("t_ms")
        if isinstance(ts, int) and frm_ms <= ts <= too_ms:
            by_ts[ts] = row

    return {
        "code": code,
        "from": from_label,
        "to": to_label,
        output_key: [by_ts[t_ms] for t_ms in sorted(by_ts)],
        "cached_batches": cached_batches,
        "fresh_batches": [],
        "data_warnings": data_warnings,
    }


def _collect_index_daily_candles_cache_only(
    *,
    cache: IndexCandlesCache,
    key: tuple[str, str],
    index_id: str,
    timeframe: str,
    from_s: str,
    to_s: str,
) -> dict:
    frm = _parse_yyyymmdd(from_s)
    too = _parse_yyyymmdd(to_s)
    assert frm is not None and too is not None
    covered: list[tuple[date, date]] = []
    candles = []
    violations = []
    for batch_from, batch_to, batch_candles, batch_violations in cache.list_batches(key):
        if batch_to < frm or batch_from > too:
            continue
        covered.append((batch_from, batch_to))
        candles.extend(batch_candles)
        violations.extend(batch_violations)

    batch_label = f"{from_s}__{to_s}"
    data_warnings = [
        _violation_to_warning(v, batch_label)
        for v in violations
        if from_s <= v.date_yyyymmdd <= to_s
    ]
    data_warnings.extend(
        _kis_rest_bypassed_batch_warning(
            f"{gap_from.strftime('%Y%m%d')}__{gap_to.strftime('%Y%m%d')}"
        )
        for gap_from, gap_to in _compute_daily_gaps(frm, too, covered)
    )
    by_ts = {
        candle.t_ms: candle
        for candle in candles
        if from_s <= _candle_date_yyyymmdd(candle) <= to_s
    }
    return {
        "index_id": index_id,
        "from": from_s,
        "to": to_s,
        "timeframe": timeframe,
        "candles": [_candle_to_dict(by_ts[t_ms]) for t_ms in sorted(by_ts)],
        "data_warnings": data_warnings,
    }


def _collect_index_minute_candles_cache_only(
    *,
    cache: IndexMinuteCandlesCache,
    key: IndexMinuteCacheKey,
    index_id: str,
    timeframe: str,
    from_s: str,
    to_s: str,
) -> dict:
    batch_label = f"{from_s}__{to_s}"
    # TTL 없음(ttl_seconds 생략): 우회 모드는 KIS 를 호출하지 않으므로 오늘 창을
    # 만료시키면 다시 채울 소스가 없다 — 만료는 재fetch 가 가능한 경로만의 것이다.
    result = cache.get_exact(key, from_s, to_s)
    if result is None:
        candles = []
        data_warnings = [_kis_rest_bypassed_batch_warning(batch_label)]
    else:
        candles = result.candles
        data_warnings = [_violation_to_warning(v, batch_label) for v in result.violations]
    return {
        "index_id": index_id,
        "from": from_s,
        "to": to_s,
        "timeframe": timeframe,
        "candles": [_candle_to_dict(c) for c in candles],
        "data_warnings": data_warnings,
    }


# 이 오케스트레이터를 **두 벤더가 공유한다**(일봉·투자자 모두 키움으로 이관됐지만
# KIS 타입은 파생 경로 존치로 남아 있다). 한쪽만 잡으면 다른 쪽 실패가 data_warnings
# 로 안 내려가고 500 으로 샌다 — 실제로 그렇게 샜다(#1226, 오늘 프로브의 8050).
#
# **잡을 타입만 나열하고 사유는 `_vendor_error_to_warning` 이 정한다.** 예전엔 transport
# 튜플이 따로 있었는데, 그건 사유 문자열을 손으로 고르기 위한 것이었고 이제 정책이
# 고른다. 타입으로만 보면 transport·batch-limit 은 api-error 의 하위 타입이라 아래
# 한 줄에 이미 들어 있다(실측: `KiwoomTransportError`·`KiwoomBatchLimitError` ⊂
# `KiwoomApiError`, `KisTransportError` ⊂ `KisApiError`).
#
# 인증 계열은 **하위 타입이 아니라 별도 갈래**다(`KiwoomAuthError` ⊄ `KiwoomApiError`).
# 거버너 과부하(`KiwoomCapacityOverloaded`)는 아예 `RuntimeError` 다. 둘 다 빠뜨리면
# 8005 토큰 무효화·큐 포화가 그대로 500 이 된다 — 8050 과 같은 사고가 코드만 바꿔
# 반복된다(투자자 경로는 실제로 그 상태였다).
#
# **가르는 축은 벤더가 아니라 "더 걸어도 같은 결과인가" 다.**
#   멈춘다: 유량 초과·큐 포화(창이 열려야 한다) · 인증 실패(설정을 고쳐야 한다).
#           남은 gap 을 두드려 봐야 같은 거절이고, 경고만 N 개로 불어난다.
#   계속:   그 배치 고유의 거절(1504 등)·전송 실패. 다음 배치는 성공할 수 있다.
#
# `KiwoomTerminalAuthError` ⊂ `KiwoomApiError` 라 **이 튜플의 except 절이 먼저 와야**
# 8050 이 "계속" 팔로 새지 않는다.
_STOP_WALK_ERRORS = (
    KisRateLimitError, KiwoomRateLimitError, KiwoomCapacityOverloaded,
    KisAuthError, KiwoomAuthError, KiwoomTerminalAuthError,
)
_DEGRADABLE_ERRORS = (KisApiError, KiwoomApiError)


async def batched_daily_walkback(  # noqa: PLR0912, PLR0915
    *,
    cache: PastDailyCandlesCache,
    fetch_batch: Callable[
        [str, str, str], Awaitable[tuple[list[dict], list, date | None]]
    ],
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
    fetches one date range and returns
    `(rows: list[dict], violations, covered_to: date | None)` — it may
    raise the vendor error families in ``_STOP_WALK_ERRORS`` /
    ``_DEGRADABLE_ERRORS`` (this orchestrator catches them and turns them into
    ``data_warnings``). 걷기를 멈추는 축은 벤더도 유량도 아니라 **"더 걸어도 같은
    결과인가"** 다 — 유량 초과·큐 포화·인증 실패가 멈추는 쪽이고, 그 배치 고유의
    거절과 전송 실패가 계속하는 쪽이다(각 튜플 위 주석).
    **과거 gap 루프와 오늘 프로브가 같은 튜플을 본다** — 벤더별로 적으면 한쪽만
    갱신돼 나머지가 500 으로 샌다. 경고의 ``reason``·``msg`` 는 손으로 정하지 않고
    ``error_policy`` 가 정한다(분봉 경로와 같은 규율, ADR-0137).

    Everything else — batch-cache intersect, gap compute, per-gap
    fetch + persist, today tri-state, dedupe-by-``t_ms`` / sort / [frm,too]
    filter — lives here, tested once in ``test_batched_daily_walkback.py``.

    ``covered_to`` 는 **fetch 가 실제로 덮은 끝 날짜**다. 요청한 `to_s` 보다 뒤일
    수 있다: 일봉 수정주가는 기준일에서 걸어 내려와야 하므로(#1228 함정 ④) 그
    사이 행을 어차피 받는다. 그걸 캐시 커버리지로 인정하면 **다음 갭이 사라진다**
    — 안 그러면 좌측 스크롤마다 오늘부터 다시 걷는다. `None` 은 "요청 구간만
    덮었다"(투자자 순매수 경로 — 커서가 `to` 상대라 넓힐 것이 없다).
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
    # 과거 배치는 **오늘 직전까지만** 담는다. 오늘 봉은 진행 중이라 TTL 슬롯이
    # 따로 있고(step 5), TTL 없는 과거 배치에 섞이면 그 값이 얼어붙는다.
    cache_ceiling = today_d - timedelta(days=1)
    # 이번 요청 안에서 이미 덮은 최대 날짜. 넓은 fetch 하나가 뒤쪽 갭들을
    # 통째로 덮으므로, 그걸 모르면 같은 구간을 갭 개수만큼 다시 받는다.
    covered_through: date | None = None
    if frm <= req_to_past:
        # `_compute_daily_gaps` 는 오름차순(오래된 것부터)이다 — 그래야 첫 fetch 의
        # 넓은 커버리지가 뒤 갭들을 덮는다. 순서가 뒤집히면 스킵이 무력해진다.
        for gap_from, gap_to in _compute_daily_gaps(frm, req_to_past, existing_relevant):
            gap_from_s = gap_from.strftime("%Y%m%d")
            gap_to_s = gap_to.strftime("%Y%m%d")
            label = f"{gap_from_s}__{gap_to_s}"
            if covered_through is not None and gap_to <= covered_through:
                # 앞선 fetch 가 이미 이 갭을 넘어 덮었다 — 그 행들은 `loaded` 에
                # 들어 있고 캐시에도 기록됐다. 조용히 건너뛰지 않고 남기지 않는
                # 이유: `fresh_batches` 는 벤더 왕복 기록이라 안 한 왕복을 적으면
                # 거짓이 된다. 스킵 자체는 정상 경로라 경고도 아니다.
                continue
            try:
                rows, violations, covered_to = await fetch_batch(
                    code, gap_from_s, gap_to_s
                )
            except _STOP_WALK_ERRORS as e:
                # 뒤 배치를 두드려 봐야 같은 거절이라 걷기를 **중단**한다. 경고 하나면
                # 충분하고, N 개로 불어나면 원인이 오히려 안 보인다.
                warnings.append(_vendor_error_to_warning(e, label))
                break
            except _DEGRADABLE_ERRORS as e:
                # 전송 실패·배치 상한이 각자의 사유로 갈리는 것은 이제
                # `classify_live_error` 의 isinstance 순서가 보장한다 — 여기서 팔을
                # 나눌 이유가 없다. 전송 실패는 클라이언트가 이미 1회 재시도했다(ADR-0050).
                warnings.append(_vendor_error_to_warning(e, label))
                continue
            # 확장의 근거는 **"그 행을 실제로 받았다"** 이다. 빈 응답까지 넓게
            # 주장하면, 일시적 빈 응답 하나가 오늘까지의 큰 구간을 "조회 완료" 로
            # 굳혀 다음 롤오버까지 재시도를 막는다. 빈 갭 캐싱(휴일 구간 무한
            # 재조회 방지)은 요청 갭 폭 그대로 유지된다.
            batch_to = (
                max(min(covered_to, cache_ceiling), gap_to)
                if rows and covered_to is not None
                else gap_to
            )
            # **행도 같이 자른다.** `_normalize_batch` 는 *경계*만 실제 행 범위로
            # 조이고 bars 는 그대로 담으므로, 안 자르면 오늘의 진행 중 봉이 과거
            # 배치 안에 얼어붙는다. step 6 의 today 슬롯 덮어쓰기가 보통 가려주지만
            # today fetch 가 실패하면 그 가림이 사라진다.
            ceiling_ms = int(
                datetime.combine(cache_ceiling, time(23, 59, 59), tzinfo=_KST).timestamp()
                * 1000
            )
            cache.append_batch(
                code, gap_from, batch_to,
                [r for r in rows if not isinstance(r.get("t_ms"), int)
                 or r["t_ms"] <= ceiling_ms],
            )
            loaded.extend(rows)
            # 라벨은 **요청한 갭** 그대로다 — 이 필드는 벤더 왕복 기록이지 캐시
            # 커버리지 기록이 아니다. 게다가 캐시는 `_normalize_batch` 로 경계를
            # 실제 행 범위까지 다시 조이므로, 넓힌 값을 여기 적으면 실제 저장된
            # 구간과 어긋날 수 있다. 넓어진 커버리지는 다음 요청의
            # `cached_batches` 에 드러난다.
            fresh_batches.append(label)
            if covered_through is None or batch_to > covered_through:
                covered_through = batch_to
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
                # `covered_to` 는 여기서 무의미하다 — 오늘 슬롯은 하루짜리 tri-state 라
                # 커버리지를 넓힐 대상이 없다.
                rows, violations, _covered_to = await fetch_batch(code, today_s, today_s)
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
            # 위 gap 루프와 **같은 튜플**을 쓴다. 예전엔 여기만 `Kis*` 를 직접 적어서
            # 두 브랜치의 포착 폭이 갈렸고, 일봉이 키움으로 이관된 뒤로는 오늘 프로브의
            # `KiwoomApiError` 만 그대로 탈출해 500 이 됐다(#1226, 8050 지정단말기 인증 실패).
            # 그 500 은 FastAPI detail 이 아니라 Starlette 의 plain text 라 프론트가
            # 에러 코드를 못 읽고, 캔들이 이미 그려져 있으면 **아무 표시도 안 났다**.
            # 브로커를 늘릴 때 여기를 잊지 않도록 튜플 공유가 유일한 규율이다.
            #
            # 여기는 배치가 하나뿐이라 멈출 것도 계속할 것도 없다 — 두 튜플을 한 팔로
            # 합친다. 합쳤으므로 gap 루프와 달리 순서 함정이 없다.
            except (*_STOP_WALK_ERRORS, *_DEGRADABLE_ERRORS) as e:
                warnings.append(_vendor_error_to_warning(e, today_label))

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
    baseline_price: int | None = None
    baseline_date: str | None = None
    change_pct_source: str | None = None
    warnings: list[str] = Field(default_factory=list)
    stale: bool = False
    stale_reason: str | None = None


class LiveQuotesResponse(BaseModel):
    phase: Literal["pre_open", "open", "closed"]
    quotes: list[LiveQuote]


LiveTabMetricHogaReason = Literal[
    "not_collected",
    "stale",
    "index",
    "pre_open",
    "invalid_book",
]


class LiveTabMetric(BaseModel):
    code: str
    change_pct: float | None
    hoga_ratio_x: float | None
    hoga_available: bool
    hoga_reason: LiveTabMetricHogaReason | None = None
    source: Literal["live", "quote_cache"]


class LiveTabMetricsResponse(BaseModel):
    phase: Literal["pre_open", "open", "closed"]
    metrics: list[LiveTabMetric]


class LiveIndexEntry(BaseModel):
    kind: Literal["index"] = "index"
    id: str
    label: str
    investor_scope: Literal["market", "index", "none"]


class LiveIndicesResponse(BaseModel):
    indices: list[LiveIndexEntry]


class LiveIndexQuote(BaseModel):
    """하단 시장지표 바 1항목 — 대표지수 현재지수 + 전일대비."""
    id: str
    label: str
    value: float
    change: float
    change_rate: float
    t_ms: int


class LiveIndexQuotesResponse(BaseModel):
    quotes: list[LiveIndexQuote]


InvestorEstimateWarningReason = Literal[
    "credentials_missing",
    "rest_bypassed",
    "rate_limit_upstream",
    "api_error",
    "parse_error",
]


class LiveInvestorTrendEstimateWarning(BaseModel):
    reason: InvestorEstimateWarningReason
    msg: str


class LiveInvestorTrendEstimateRow(BaseModel):
    """한 슬롯의 추정 수급 — **수량·금액 두 축을 함께** 싣는다.

    두 축을 한 응답에 담는 이유는 관측시각 때문이다. 아래 `_InvestorEstimateObservedAtStore`
    는 "값이 이전과 같으면 최초 관측시각을 유지" 로 차수 시각을 만든다. 축을 요청마다
    갈아 끼우면 값이 통째로 달라져 **모든 슬롯이 새로 관측된 것으로 판정**되고, 오전
    슬롯의 차수 시각이 축을 바꾼 순간으로 덮인다. 프론트 토글이 서버 왕복 없이 도는
    것은 그 제약에서 따라온 결과다.
    """

    slot: str
    observed_at_ms: int
    foreign_qty: int | None       # 주(株) — 가집계라 천주 단위 반올림
    institution_qty: int | None
    sum_qty: int | None
    foreign_amt_mwon: int | None       # 백만원
    institution_amt_mwon: int | None
    sum_amt_mwon: int | None


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
                if stored is not None and _investor_estimate_same_values(stored, row):
                    observed_at_ms = stored.get("observed_at_ms")
                    if isinstance(observed_at_ms, int):
                        out.append(row.model_copy(update={"observed_at_ms": observed_at_ms}))
                        continue
                code_state[row.slot] = {
                    "observed_at_ms": fetched_at_ms,
                    **{field: getattr(row, field) for field in _INVESTOR_ESTIMATE_VALUE_FIELDS},
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
                        **_investor_estimate_stored_values(slot_raw),
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


def _quote_phase(now: datetime, venue_policy: LiveVenuePolicy = "KRX") -> Literal["pre_open", "open", "closed"]:
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
    if venue_policy in ("NXT", "UN"):
        if t < time(8, 0) or t >= time(20, 0):
            return "closed"
        return "open"
    if t < time(8, 50) or t >= time(16, 0):
        return "closed"
    return "pre_open" if t < time(9, 0) else "open"


class ControlRequest(BaseModel):
    action: ControlAction


class _QuoteSample(NamedTuple):
    """마지막-시세 캐시 1건 + **그 표본이 어디서 왔는지**.

    quote 만 담으면 closed 서빙이 "이 값이 종가인가"를 물을 수 없다. 그게 장중
    폴링이 끊긴 시점의 값을 종가로 서빙하던 결함의 근인이었다 — 캐시를 채우는
    유일한 주체가 프론트 폴링이라(/quotes 요청 외에 갱신 스케줄러가 없다), 탭이
    가려져 폴링이 멈추면 그 순간 값이 캐시에 남고 closed 경로가 그걸 종가로
    내보냈다. 실측 2026-08-01: 07/31 오전 10시대 247,000 이 종가(262,500) 자리에.

    phase/day 를 함께 남기면 그 질문에 답할 수 있다 — `is_closing_sample` 참조.
    """
    quote: Quote
    phase: str
    day: date


class LiveQuoteFetcher:
    """`/quotes` 오버레이의 시세 fetch + 마지막-시세 캐시 + phase 게이팅을 한 곳에 모은
    모듈. 라우트는 phase 계산·코드 파싱·KisClient 획득만 하고 이 모듈을 호출한다 —
    캐시·게이팅·graceful-fallback 의 business logic 이 라우트(infra)에서 분리된다.

    청킹(최대 30종목/콜, FHKST11300006)은 그대로 `kis.fetch_multi_price` 내부에 둔다
    (여기선 캐시·게이팅만 소유). 마지막-시세는 표시 전용·디스크 미영속(ADR-0056),
    단일 워커라 dict 로 충분(ADR-0038). FastAPI 없이 fake kis 로 단독 테스트 가능."""

    def __init__(self, *, change_resolver: QuoteChangeResolver | None = None) -> None:
        # 장중 마지막 quotes — closed 서빙용(스펙 2026-06-08 ⑧ '마지막 시세 유지').
        # 키가 **(venue, code)** 인 이유: OHLC 는 venue 마다 다르다(실측 2026-07-31,
        # 005930 시가 KRX 257,000 vs UN 225,500 — UN 은 프리마켓 체결이 시가가 된다).
        # code 만으로 키잉하면 마지막에 조회된 venue 의 봉이 다른 venue 요청에 그대로
        # 서빙된다 — 장마감(closed)·KIS 실패(stale) 경로가 캐시만 보기 때문이다. 실제
        # 증상: 장 마감 후 venue 를 바꿔도 히트맵 행의 캔들·시가가 그대로.
        self._last_quotes: dict[tuple[str, str], _QuoteSample] = {}
        self._change_resolver = change_resolver or QuoteChangeResolver(adjusted_daily_path=None)

    @staticmethod
    def is_closing_sample(sample: _QuoteSample | None, today: date) -> bool:
        """이 표본을 **종가로서** 서빙해도 되는가.

        두 조건을 모두 요구한다:
          - `phase == "closed"` — 마감 후에 찍혔다. 장중 표본은 그 시각의 값일 뿐
            종가가 아니다(폴링이 언제 끊겼는지 알 수 없으므로 나이도 알 수 없다).
          - `day == today` — 오늘 찍혔다. 어제 밤 표본을 오늘 밤에 서빙하면 하루
            묵은 종가가 된다(앱을 하루 걸러 켜는 사용 패턴에서 실제로 발생).

        `open` 표본이 마감 직전(예: KRX 15:59)이라 사실상 종가와 같은 경우에도
        재조회를 시킨다 — 같은 값이면 KIS 가 같은 값을 돌려줄 뿐이라 비용은 요청
        1회이고, "같을 것"이라는 추측 위에 종가 표시를 세우지 않는 편이 옳다.
        """
        return sample is not None and sample.phase == "closed" and sample.day == today

    def _to_live_quote(
        self,
        q: Quote,
        *,
        phase: str,
        today: date | None = None,
    ) -> LiveQuote:
        resolved = self._change_resolver.resolve_quote(q, phase=phase, today=today)
        pre = phase == "pre_open"
        return LiveQuote(
            code=q.code,
            price=q.price,
            change_pct=resolved.change_pct,
            change_won=resolved.change_won,
            open=(None if pre else q.open),
            high=(None if pre else q.high),
            low=(None if pre else q.low),
            baseline_price=resolved.baseline_price,
            baseline_date=resolved.baseline_date,
            change_pct_source=resolved.change_pct_source,
            warnings=resolved.warnings,
        )

    async def fetch_and_gate(
        self,
        client: KiwoomRestClient,
        code_list: list[str],
        phase: str,
        today: date | None = None,
        *,
        venue: Venue = "KRX",
        fetch_chunk_fn: kiwoom_multi_quote.ChunkFetcher | None = None,
    ) -> list[LiveQuote]:
        """code_list 의 시세를 phase 에 맞춰 반환. closed=마지막 **종가** 시세(표본이
        종가가 아니면 재조회 — is_closing_sample), open=라이브, pre_open=등락률 숨김.
        벤더 실패는 절대 전파하지 않는다(오버레이는 500 금지).

        PR-D(#1040) 칼 컷오버로 소스는 키움 `ka10095` 다. venue 는 KIS 처럼
        파라미터가 아니라 **종목코드 접미**로 표현된다."""
        day = today or _today_kst_date()
        if phase == "closed":
            # 장외: 마지막 시세 서빙. 단 **종가 표본일 때만** 캐시를 신뢰한다.
            # 판정 기준이 "캐시에 있는가"였을 때, 장중에 폴링이 끊기면 그 시점 값이
            # 종가 자리에 영구히 눌러앉았다(is_closing_sample 참조). KIS는 장외에도
            # 종가를 반환하므로 재조회가 정확한 복구 경로다. 프론트는 closed에 600s
            # 하트비트라 이 경로의 KIS 콜은 마감 후 첫 요청 1회로 수렴한다.
            refetch = [
                c for c in code_list
                if not self.is_closing_sample(self._last_quotes.get((venue, c)), day)
            ]
            if refetch:
                try:
                    for q in await kiwoom_multi_quote.fetch_multi_price(
                        client, code_list, venue=venue,
                        fetch_chunk_fn=fetch_chunk_fn,
                    ):
                        self._last_quotes[(venue, q.code)] = _QuoteSample(q, phase, day)
                except KiwoomCapacityOverloaded:
                    raise   # 사유 보존 — 아래 open 경로와 같은 이유다
                except Exception as e:  # noqa: BLE001 — 오버레이는 절대 500 금지
                    log.warning("live quotes cold fetch failed (%d codes): %s",
                                len(code_list), e)
            rows: list[LiveQuote] = []
            for code in code_list:
                sample = self._last_quotes.get((venue, code))
                if sample is None:
                    continue
                row = self._to_live_quote(sample.quote, phase=phase, today=today)
                # 재조회가 실패해 장중/전일 표본이 남았다면 숨기지 않고 stale 로
                # 표시한다. 값 자체는 목록에 계속 보여 주되(빈 칸보다 낫다), 정밀
                # 소비자(현재가 라인·탭 제목)는 isStaleLiveQuote 로 이걸 거른다.
                if not self.is_closing_sample(sample, day):
                    row = row.model_copy(
                        update={"stale": True, "stale_reason": "pre_close_sample"}
                    )
                rows.append(row)
            return rows
        try:
            quotes = await kiwoom_multi_quote.fetch_multi_price(
                client, code_list, venue=venue, fetch_chunk_fn=fetch_chunk_fn,
            )
        except KiwoomCapacityOverloaded:
            # **재전파한다.** 청킹이 거버너 위로 올라가면서 이 예외가 여기 안쪽에서
            # 발생하게 됐는데, 여기서 stale 로 접으면 라우트가 붙이는
            # `capacity_overloaded_upstream` 사유가 사라지고 `fetch_failed` 로
            # 뭉개진다 — 과부하와 벤더 실패는 처방이 다르다(ADR-0137).
            raise
        except Exception as e:  # noqa: BLE001 — 10초 폴링 오버레이는 절대 500 금지;
            # KIS rate-limit/api-error/네트워크 타임아웃 등 무엇이든 빈 결과로 graceful
            # (프론트는 '—' 표시). retry-exhausted 신호는 warning 으로만 남긴다.
            log.warning("live quotes fetch failed (%d codes): %s", len(code_list), e)
            return self.stale_last_good(
                code_list,
                phase,
                today=today,
                stale_reason="fetch_failed",
            )
        for q in quotes:
            self._last_quotes[(venue, q.code)] = _QuoteSample(q, phase, day)
        return [self._to_live_quote(q, phase=phase, today=today) for q in quotes]

    def stale_last_good(
        self,
        code_list: list[str],
        phase: str,
        today: date | None = None,
        *,
        stale_reason: str = "rest_bypassed",
        venue: Venue = "KRX",
    ) -> list[LiveQuote]:
        """캐시된 마지막 시세를 stale 표시로 서빙. venue 는 캐시 키의 일부다 —
        요청 venue 의 표본이 없으면 **다른 venue 것을 대신 주지 않고 비운다**(그쪽
        OHLC 는 이 venue 의 봉이 아니다). 프론트는 그 코드를 '—' 로 렌더한다."""
        rows: list[LiveQuote] = []
        for code in code_list:
            sample = self._last_quotes.get((venue, code))
            if sample is None:
                continue
            rows.append(
                self._to_live_quote(sample.quote, phase=phase, today=today).model_copy(
                    update={
                        "stale": True,
                        "stale_reason": stale_reason,
                    }
                )
            )
        return rows


_TAB_METRIC_HOGA_STALE_MS = 15_000


def _extract_tab_hoga_ratio(
    latest_ob: dict | None,
    *,
    now_ms: int,
    stale_ms: int = _TAB_METRIC_HOGA_STALE_MS,
) -> tuple[float | None, bool, LiveTabMetricHogaReason | None]:
    if latest_ob is None:
        return None, False, "not_collected"
    age_ms = now_ms - int(latest_ob.get("t_ms") or 0)
    if age_ms > stale_ms:
        return None, False, "stale"
    bid_total = int(latest_ob.get("total_bid_qty") or 0)
    ask_total = int(latest_ob.get("total_ask_qty") or 0)
    if bid_total <= 0 or ask_total <= 0:
        return None, False, "invalid_book"
    return max(bid_total, ask_total) / min(bid_total, ask_total), True, None


def _investor_estimate_row_to_wire(
    row: InvestorTrendEstimateRow,
    *,
    observed_at_ms: int,
) -> LiveInvestorTrendEstimateRow:
    return LiveInvestorTrendEstimateRow(
        slot=row.slot,
        observed_at_ms=observed_at_ms,
        **{field: getattr(row, field) for field in _INVESTOR_ESTIMATE_VALUE_FIELDS},
    )


def _investor_estimate_has_value(row: LiveInvestorTrendEstimateRow) -> bool:
    return any(getattr(row, field) is not None for field in _INVESTOR_ESTIMATE_VALUE_FIELDS)


def _investor_estimate_same_values(
    previous: LiveInvestorTrendEstimateRow | dict[str, int | None],
    current: LiveInvestorTrendEstimateRow,
) -> bool:
    """두 축 **전부**를 비교한다 — 한 축만 보면 차수 시각이 틀린다.

    금액은 백만원 단위라 수량(천주 반올림)보다 잘게 움직인다. 수량만 비교하면
    금액이 갱신된 슬롯을 "그대로" 로 읽어 최초 관측시각을 계속 물고 간다.
    """
    if isinstance(previous, LiveInvestorTrendEstimateRow):
        return all(
            getattr(previous, field) == getattr(current, field)
            for field in _INVESTOR_ESTIMATE_VALUE_FIELDS
        )
    return all(
        previous.get(field) == getattr(current, field)
        for field in _INVESTOR_ESTIMATE_VALUE_FIELDS
    )


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) else None


def _investor_estimate_stored_values(slot_raw: dict[str, object]) -> dict[str, int | None]:
    """디스크에 저장된 슬롯 값을 읽는다 — **구포맷은 금액으로 이관한다**.

    2026-08-04 이전 판은 `amt_qty_tp="1"`(금액, 백만원) 응답을 `foreign_qty` 등
    수량 이름에 담아 저장했다. 그 값 자체는 멀쩡하고 **단위 라벨만 틀렸으므로**,
    금액 축으로 옮겨 읽으면 값도 관측시각도 그대로 살아난다. 수량 이름 그대로
    읽으면 다음 폴링의 진짜 수량과 어긋나 하루치 차수 시각이 통째로 리셋된다.

    구포맷 판별은 금액 키의 부재다 — 신포맷은 값이 None 이어도 6키를 모두 쓴다.
    """
    if "foreign_amt_mwon" not in slot_raw:
        return {
            "foreign_qty": None, "institution_qty": None, "sum_qty": None,
            "foreign_amt_mwon": _optional_int(slot_raw.get("foreign_qty")),
            "institution_amt_mwon": _optional_int(slot_raw.get("institution_qty")),
            "sum_amt_mwon": _optional_int(slot_raw.get("sum_qty")),
        }
    return {field: _optional_int(slot_raw.get(field)) for field in _INVESTOR_ESTIMATE_VALUE_FIELDS}


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
    usable = [r for r in rows if _investor_estimate_has_value(r)]
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
                reason="credentials_missing",
                msg="KIS credentials are not configured",
            ),
        )

    async def fetch(
        self,
        client: KiwoomRestClient,
        code: str,
        *,
        run_call: kiwoom_investor.EstimateCallRunner | None = None,
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
            task = asyncio.create_task(
                self._fetch_uncached(client, code, trading_day, run_call=run_call)
            )
            self._inflight[key] = task
            task.add_done_callback(lambda _t, k=key: self._inflight.pop(k, None))
        # shield: 대기자 취소가 공유 태스크로 전파되면 같은 키에 올라탄 다른
        # 대기자까지 CancelledError로 죽는다 (live_candle_backfill과 동일 규약).
        return await asyncio.shield(task)

    async def _fetch_uncached(
        self,
        client: KiwoomRestClient,
        code: str,
        trading_day: str,
        *,
        run_call: kiwoom_investor.EstimateCallRunner | None = None,
    ) -> LiveInvestorTrendEstimateResponse:
        """PR-E(#1041) 칼 컷오버 — 소스는 키움 `ka10064`(장중투자자별매매차트)다.

        `reason` 문자열(`kis_*`)은 프론트 계약이라 지금 바꾸지 않는다 —
        #1046(PR-J)에서 벤더명과 함께 정리한다.
        """
        key = (trading_day, code)
        try:
            raw_rows = await kiwoom_investor.fetch_investor_trend_estimate(
                client, code, run_call=run_call
            )
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
        except KiwoomAuthError:
            log.warning("investor trend estimate auth failed for %s", code, exc_info=True)
            response = self._error_response(
                code,
                trading_day,
                "credentials_missing",
                "KIS authentication failed",
            )
            return self._cache_response(key, response)
        except KiwoomRateLimitError as e:
            response = self._error_response(code, trading_day, "rate_limit_upstream", str(e))
            return self._cache_response(key, response)
        except KiwoomApiError as e:
            # KiwoomTransportError 도 이 팔이 흡수한다(KiwoomApiError 상속).
            response = self._error_response(code, trading_day, "api_error", str(e.code))
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
            "ok" if any(_investor_estimate_has_value(row) for row in merged) else "empty"
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
    if _investor_estimate_same_values(previous, current):
        return current.model_copy(update={"observed_at_ms": previous.observed_at_ms})
    return current


# ── 과거·지수·스냅샷 wire models (ADR-0004 · 동결선 배치 2) ────────────────────
#
# 수집·조립 함수는 그대로 dict 를 만든다. 라우트 애노테이션만 바꿔 FastAPI 가 검증·
# 직렬화하게 한다 — `response_model` 은 선언 안 된 키를 **에러 없이 버리므로**, 모델은
# 실응답에서 관측한 키를 그대로 옮긴 것이다(추측 금지).
#
# ⚠ `data_warnings` 항목은 **일부러 `dict` 로 남긴다.** shape 이 라우트마다 다르고
# (`{date,reason,msg}` vs `{batch,date?,reason,msg}`), 진단용이라 앞으로도 갈린다.
# 모델로 좁히면 (a) 없는 키에 `null` 이 새로 실려 FE 의 `?:` 계약과 어긋나거나
# (b) 좁힌 shape 밖의 키가 조용히 사라진다. 둘 다 이 작업이 막으려는 실패다.


class LiveControlResponse(BaseModel):
    """POST /api/live/control — ack. `ok` 가 bool 이 아니라 문자열인 것은 기존 wire 다."""

    action: str
    ok: str


# `/snapshot` 계열은 **모든 필드가 optional** 이다. 버퍼는 스트림이 만든 dict 를
# 그대로 보관하는데 그 dict 가 부분적일 수 있다 — 실서버 응답은 정상 스트림이라
# 완전했지만, 기존 단위 테스트가 `{"total_bid_qty": 1000}` 같은 부분 호가를 넣어
# 그 사실을 이미 문서화하고 있었다. 필수로 선언했다가 그 케이스에서 **500** 이 났다.
#
# 부분 dict 를 허용하면 없는 키에 `null` 이 새로 실리므로 라우트에
# `response_model_exclude_none=True` 를 건다 — 부재가 그대로 부재로 나간다.
class LiveOrderbookLevel(BaseModel):
    price: int | None = None
    qty: int | None = None


class LiveSnapshotOrderbook(BaseModel):
    code: str | None = None
    venue: str | None = None
    asks: list[LiveOrderbookLevel] = Field(default_factory=list)
    bids: list[LiveOrderbookLevel] = Field(default_factory=list)
    total_ask_qty: int | None = None
    total_bid_qty: int | None = None


class LiveBrokerTop(BaseModel):
    name: str | None = None
    qty: int | None = None


class LiveSnapshotBrokers(BaseModel):
    code: str | None = None
    venue: str | None = None
    buy_top: list[LiveBrokerTop] = Field(default_factory=list)
    sell_top: list[LiveBrokerTop] = Field(default_factory=list)


class LiveRecentTrade(BaseModel):
    t_ms: int | None = None
    price: int | None = None
    qty: int | None = None
    # +1/−1. 벤더 원값이 아니라 스트림이 파생한 부호다.
    side: int | None = None
    side_source: str | None = None


class LiveSnapshotResponse(BaseModel):
    """GET /api/live/snapshot — 버퍼 최신 스냅샷.

    호가·거래원이 없는 순간(개장 직후·미구독)이 정상이라 둘 다 optional 이다.
    """

    code: str | None = None
    t_ms: int | None = None
    phase: str | None = None
    orderbook: LiveSnapshotOrderbook | None = None
    brokers: LiveSnapshotBrokers | None = None
    recent_trades: list[LiveRecentTrade] = Field(default_factory=list)


class LiveViStatusResponse(BaseModel):
    """GET /api/live/vi-status — 이벤트가 없거나 키움 미배선이면 ``vi=null``.

    `vi` 를 모델로 좁히지 않는다: shape 을 소유한 곳이 `kiwoom_vi_state.parse_vi_row`
    이고 legend 가 실측으로 확정된 자리라(2026-07-21), 여기서 한 벌 더 선언하면
    미러가 3벌이 된다.
    """

    code: str
    vi: dict | None = None


class LiveSeriesResponse(BaseModel):
    """GET /api/live/series — 차트 초기 hydration(실측 464KB · 키 경로 114개).

    **이 응답의 계약은 최상위에만 있다.** 네 배열(snapshots·trades·brokers·programs)은
    프론트가 ``Array<Record<string, unknown>>`` 로 받아 그대로 버퍼에 넘긴다 — 즉
    항목 shape 은 애초에 선언된 적이 없고, 스트림이 소유한다. 여기서 새로 좁히면
    미러가 한 벌 더 생기고 **조용한 스트립 위험만 늘어난다**. peak 두 개도 같은
    이유다(파생 구조라 커버리지에 따라 조건부 필드가 붙는다).

    그래서 이 모델이 고정하는 것은 **최상위 키 집합과 그 타입**이다. 그것만으로도
    "필드가 사라지거나 이름이 바뀌면 안다" 는 계약이 선다.

    ``extra="allow"`` 는 안전장치다. 이 라우트는 버퍼 dict 를 ``**series`` 로 펼쳐
    조립하므로 스트림이 키를 늘리면 여기 선언이 뒤처질 수 있는데, 그때 **조용히
    버리는 대신 그대로 통과**시킨다. 이 작업 전체가 막으려던 실패가 바로 그 스트립이라,
    아직 모르는 키에 대해서도 같은 원칙을 적용한다.
    """

    model_config = ConfigDict(extra="allow")

    code: str
    date: str
    # 장 중이면 close 가 아직 없다 — 정당한 null 이라 지우지 않는다.
    session_open_ms: int | None = None
    session_close_ms: int | None = None
    is_open: bool = False
    snapshots: list[dict] = Field(default_factory=list)
    trades: list[dict] = Field(default_factory=list)
    brokers: list[dict] = Field(default_factory=list)
    programs: list[dict] = Field(default_factory=list)
    ask_peak_today: dict | None = None
    bid_peak_today: dict | None = None


class LiveCandleRow(BaseModel):
    """OHLCV 한 봉. 분·일·지수·스크리너 네 경로가 같은 shape 을 공유한다."""

    t_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class LiveEffectiveSession(BaseModel):
    date: str
    venue: str
    open_ms: int
    close_ms: int


class LivePastCandlesResponse(BaseModel):
    code: str
    # `from` 은 파이썬 예약어라 alias 로 받는다 — wire 는 그대로 `from` 이다
    # (FastAPI 가 `by_alias=True` 로 직렬화한다).
    from_: str = Field(alias="from")
    to: str
    venue: str | None = None
    bucket_ms: int | None = None
    candles: list[LiveCandleRow] = Field(default_factory=list)
    cached_dates: list[str] = Field(default_factory=list)
    fresh_dates: list[str] = Field(default_factory=list)
    data_warnings: list[dict] = Field(default_factory=list)
    effective_sessions: list[LiveEffectiveSession] = Field(default_factory=list)


class LivePastDailyCandlesResponse(BaseModel):
    code: str
    from_: str = Field(alias="from")
    to: str
    venue: str | None = None
    candles: list[LiveCandleRow] = Field(default_factory=list)
    cached_batches: list[str] = Field(default_factory=list)
    fresh_batches: list[str] = Field(default_factory=list)
    data_warnings: list[dict] = Field(default_factory=list)


class ScreenerDailyCandlesResponse(BaseModel):
    code: str
    from_: str = Field(alias="from")
    to: str
    source: str
    candles: list[LiveCandleRow] = Field(default_factory=list)
    data_warnings: list[dict] = Field(default_factory=list)


class LiveInvestorNetPoint(BaseModel):
    """단위는 **응답의 `unit` 이 정한다**(#1119) — 종목 경로 qty_shares(주),
    지수 경로 amt_eok(억원). 같은 모양인데 물리량이 다르다."""

    t_ms: int
    foreign_net: float
    institution_net: float


class LivePastInvestorNetResponse(BaseModel):
    code: str
    from_: str = Field(alias="from")
    to: str
    unit: str
    points: list[LiveInvestorNetPoint] = Field(default_factory=list)
    cached_batches: list[str] = Field(default_factory=list)
    fresh_batches: list[str] = Field(default_factory=list)
    data_warnings: list[dict] = Field(default_factory=list)


class LiveIndexCandlesResponse(BaseModel):
    index_id: str
    from_: str = Field(alias="from")
    to: str
    timeframe: str
    candles: list[LiveCandleRow] = Field(default_factory=list)
    data_warnings: list[dict] = Field(default_factory=list)


class LiveIndexInvestorNetResponse(BaseModel):
    index_id: str
    from_: str = Field(alias="from")
    to: str
    unit: str
    points: list[LiveInvestorNetPoint] = Field(default_factory=list)
    data_warnings: list[dict] = Field(default_factory=list)


class StockLimitsResponse(BaseModel):
    """GET /api/live/stock-limits — 키움 ka10001 부분집합(kiwoom_stock_info)."""

    code: str
    base_price: int | None
    upper_limit: int | None
    lower_limit: int | None
    high_250: int | None
    low_250: int | None
    high_250_date: str | None
    low_250_date: str | None
    fetched_at_ms: int
    source: Literal["kiwoom"] = "kiwoom"


class RankingRowModel(BaseModel):
    """순위 드로어 행 — 기준값 열 제거로 code/name/price/change_pct 만(순서=순위)."""

    rank: int
    code: str
    name: str
    price: int | None
    change_pct: float | None


class RankingsResponse(BaseModel):
    """GET /api/live/rankings — 키움 순위 TR 4종(kiwoom_rankings). market_open 이
    False 면 프론트는 폴링을 멈추고 "장 외" 라벨을 단다(그릴링 결정 9)."""

    kind: Literal["change", "surge", "volume", "value"]
    market: Literal["all", "kospi", "kosdaq"]
    direction: Literal["up", "down"]
    rows: list[RankingRowModel]
    market_open: bool
    fetched_at_ms: int
    #: 이 순위를 뽑은 거래소(KRX/NXT/UN). NXT 는 유동성이 얕아 상위 종목이 KRX 와
    #: 크게 다르다 — 화면이 **무엇을 보고 있는지** 알 수 있어야 한다.
    venue: str = "KRX"
    source: Literal["kiwoom"] = "kiwoom"
    # 비치명 경고(스크리너 ScreenerResponse.warnings 와 같은 관용구). 현재 유일한
    # 값은 "etf_filter_unavailable" — exclude_etf 를 요청했으나 심볼 마스터가
    # 미로드라 걸러내지 못했다는 뜻. 조용한 fail-open 을 UI 가 볼 수 있게 만든다.
    warnings: list[str] = Field(default_factory=list)


def build_router(  # noqa: PLR0915 — ADR 이 지정한 단일 조립점 — 문장 분할이 설계에 반한다
    get_status: Callable[[], LiveStatus],
    get_buffer: Callable[[], LiveBuffer] | None = None,
    on_control: Callable[[str], Awaitable[None]] | None = None,
    get_today_ask_peak: Callable[[str, str], dict | None] | None = None,
    get_today_bid_peak: Callable[[str, str], dict | None] | None = None,
    *,
    get_vi_status: Callable[[str], dict | None] | None = None,
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
    async def _get_status(request: Request) -> LiveStatus:
        status = get_status()
        update: dict[str, object] = {}
        # 거버너 관측 표면 — PR-J(#1046)에서 KIS 스케줄러가 사라지고 키움 거버너가
        # 대신한다. 키는 프론트 계약이라 유지한다(#1046 관측 절에서 정리).
        snapshot = kiwoom_rest_runtime.snapshot()
        if snapshot:
            update["rest_capacity_scheduler"] = snapshot
        # ADR-0088: lifespan-owned task liveness (set on app.state at startup).
        runtime = getattr(request.app.state, "startup_runtime", None)
        if runtime is not None:
            update["supervised_tasks"] = runtime.supervised_task_health()
        if data_dir is not None:
            # statvfs 한 번 — 마이크로초 단위라 5초 폴링에 얹어도 무해하다.
            from hoga.api.prune import disk_headroom  # noqa: PLC0415 — 순환 절단
            head = disk_headroom(data_dir)
            if head is not None:
                update["disk"] = {
                    "free_pct": round(head.free_pct, 1),
                    "free_gib": round(head.free_bytes / 1024**3, 1),
                    "low": head.is_low,
                }
        # 수급 수집기 소유권(ADR-0094 확장) — 락을 못 잡아 수집기를 안 띄운 인스턴스는
        # 읽기 경로가 멀쩡해서 화면상 정상과 구별되지 않는다. 그 강등의 유일한 신호다.
        from hoga.api.scheduler import collector_ownership_state  # noqa: PLC0415 — 순환 절단
        update["collectors"] = collector_ownership_state()
        cache_stats = await _collect_cache_stats(request)
        if cache_stats:
            update["cache_stats"] = cache_stats
        return status.model_copy(update=update) if update else status

    async def _collect_cache_stats(request: Request) -> dict[str, object]:
        """Per-cache observability (PR-1). Reads closure-reachable cache
        instances — the same closure path the governor snapshot uses above."""
        from hoga.api import (  # noqa: PLC0415 — 지연 import(순환/heavy)
            today_ttl_cache,  # late import: conftest swaps TODAY_TTL
        )

        out: dict[str, object] = {}
        if cache_instance is not None:
            out["past_candles"] = cache_instance.stats_snapshot()
        if minute_backfill is not None:
            out["minute_backfill"] = minute_backfill.stats_snapshot()
        if daily_cache_instance is not None:
            out["past_daily_candles"] = daily_cache_instance.stats_snapshot()
        if investor_cache_instance is not None:
            out["investor_net_daily"] = investor_cache_instance.stats_snapshot()
        if index_candles_cache_instance is not None:
            out["index_candles"] = index_candles_cache_instance.stats_snapshot()
        if index_minute_candles_cache_instance is not None:
            out["index_minute_candles"] = index_minute_candles_cache_instance.stats_snapshot()
        out["today_ttl"] = today_ttl_cache.TODAY_TTL.stats_snapshot()
        if get_buffer is not None:
            out["live_buffer"] = await get_buffer().stats_snapshot()
        # Indicators cache is engine-owned and built lazily on the first /range
        # request — read it only if it exists (don't force-create an empty one).
        engine = getattr(request.app.state, "engine", None)
        indicators = getattr(engine, "_indicators_cache", None) if engine is not None else None
        if indicators is not None:
            out["past_indicators"] = indicators.stats_snapshot()
        return out

    @router.get("/settings", response_model=LiveSettingsResponse)
    async def _get_settings() -> LiveSettingsResponse:
        if data_dir is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "live settings not wired"})
        return load_live_settings(data_dir)

    @router.patch("/settings", response_model=LiveSettingsResponse)
    async def _patch_settings(req: LiveSettingsUpdate) -> LiveSettingsResponse:
        if data_dir is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "live settings not wired"})
        settings = update_live_settings(
            data_dir,
            rest_bypass_enabled=req.rest_bypass_enabled,
            screener_depth_autocollect=req.screener_depth_autocollect,
            krx_prefer_hogaplay=req.krx_prefer_hogaplay,
        )
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:
            log.exception("live.settings: refresh_live_stream failed")
        return settings

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

    # ── /index-quotes: 하단 시장지표 바 ──────────────────────────────
    # 서버 TTL 로 N 클라이언트 폴링이 KIS 콜을 공유하고(30s 프론트 폴 ↔ 20s TTL),
    # 락이 첫 동시 요청들을 single-flight 로 직렬화한다. 실패한 지수는 last-good
    # 을 유지해 바가 항목 단위로 깜빡이지 않는다. 자격증명/용량 부재 시에도
    # last-good(없으면 빈 배열)을 돌려주고 프론트가 바를 숨긴다.
    _INDEX_QUOTES_TTL_S = 20.0
    _index_quotes_cache: dict[str, LiveIndexQuote] = {}
    _index_quotes_meta = {"fetched_at": float("-inf")}
    _index_quotes_lock = asyncio.Lock()

    @router.get("/index-quotes", response_model=LiveIndexQuotesResponse)
    async def _get_index_quotes() -> LiveIndexQuotesResponse:
        indices = list_representative_indices()

        def snapshot() -> LiveIndexQuotesResponse:
            return LiveIndexQuotesResponse(
                quotes=[
                    _index_quotes_cache[index.id]
                    for index in indices
                    if index.id in _index_quotes_cache
                ],
            )

        # PR-C(#1039) 칼 컷오버 — 이 표면의 소스는 키움 하나다. 런타임 폴백을 두지
        # 않는 이유는 #683 이 관심종목 전환에서 세운 것과 같다: 두 벤더가 동시에
        # 살아있으면 유량이 합산되고 "어느 소스였나" 가 응답에 안 드러나 진단이 흐려진다.
        # 되돌림은 이 PR 을 revert 하면 된다(플랜 원칙 1 — KIS 코드는 남아 있다).
        kiwoom_client = (
            kiwoom_rest_runtime.ensure_rest_client(data_dir) if data_dir is not None else None
        )
        if (
            data_dir is None
            or kiwoom_client is None
            # bypass 는 과도기에 "REST 우회" 로 읽는다 — 벤더가 바뀌어도 사용자가
            # 보는 동작(캐시로 강등)은 같다. 토글 자체는 PR-J 에서 사라진다.
            or live_settings.rest_bypass_enabled(data_dir)
        ):
            return snapshot()
        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)

        async with _index_quotes_lock:
            if monotonic_time.monotonic() - _index_quotes_meta["fetched_at"] < _INDEX_QUOTES_TTL_S:
                return snapshot()

            async def fetch_one(index) -> LiveIndexQuote | None:
                try:
                    _, value, change, change_rate, t_ms = await kiwoom_access.run_with_capacity(
                        scheduler,
                        key=("index-price", index.id),
                        api_id="ka20001",
                        priority="background",
                        fetch_fn=lambda c, index=index: kiwoom_index_rest.fetch_index_price(
                            c, index
                        ),
                        client=kiwoom_client,
                    )
                except (KiwoomRestError, KiwoomCapacityOverloaded) as e:
                    # 20s 주기 배경 폴 — 개별 WARN 은 로그벽이 된다(EGW00201 교훈).
                    log.debug("index-quote fetch failed: %s (%s)", index.id, e)
                    return None
                except (KeyError, ValueError, TypeError) as e:
                    log.warning("index-quote parse failed: %s (%s)", index.id, e)
                    return None
                return LiveIndexQuote(
                    id=index.id,
                    label=index.label,
                    value=value,
                    change=change,
                    change_rate=change_rate,
                    t_ms=t_ms,
                )

            results = await asyncio.gather(*(fetch_one(index) for index in indices))
            for quote in results:
                if quote is not None:
                    _index_quotes_cache[quote.id] = quote
            # 부분 실패여도 fetched_at 은 갱신 — KIS 저하 시 TTL 간격으로만 재시도.
            _index_quotes_meta["fetched_at"] = monotonic_time.monotonic()
            return snapshot()

    @router.get("/index-candles")
    async def _get_index_candles(  # noqa: PLR0912 — ADR 이 지정한 단일 조립점 — 분기 분할이 설계에 반한다
        index_id: str = Query(...),
        timeframe: Literal["1m", "3m", "5m", "10m", "15m", "30m", "D", "W", "M"] = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> LiveIndexCandlesResponse:
        index = _validate_index_range(index_id, from_, to)
        if data_dir is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "KIS client not wired"})
        if timeframe in {"D", "W", "M"}:
            if index_candles_cache_instance is None:
                raise HTTPException(
                    503,
                    {"code": LiveErrorCode.NOT_WIRED, "message": "index-candles cache not wired (data_dir missing)"},
                )
            if live_settings.rest_bypass_enabled(data_dir):
                return _collect_index_daily_candles_cache_only(
                    cache=index_candles_cache_instance,
                    key=(index.id, timeframe),
                    index_id=index.id,
                    timeframe=timeframe,
                    from_s=from_,
                    to_s=to,
                )
            # PR-C(#1039) 칼 컷오버 — 이 표면의 소스는 키움 하나다(위 지수 현재가와 동일).
            daily_client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
            if daily_client is None:
                raise HTTPException(
                    503,
                    {"code": LiveErrorCode.NOT_WIRED, "message": "kiwoom client not initialized"},
                )
            daily_scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)

            async def fetch_batch(from_s: str, to_s: str):
                async def direct_fetch(inner_from_s: str, inner_to_s: str):
                    def _run_page(fetch_fn, page_idx: int):
                        """페이지 1장 = 거버너 submit 1건.

                        **walk 전체를 감싸던 자리다.** 감싸는 위치가 walk 밖이면
                        커서 페이지 N장이 페이싱을 못 받는다(ADR-0137).
                        """
                        return kiwoom_access.run_with_capacity(
                            daily_scheduler,
                            key=("index-daily", index.id, timeframe,
                                 inner_from_s, inner_to_s, page_idx),
                            api_id=kiwoom_index_rest.PERIOD_TO_API_ID[timeframe],
                            priority="user_visible",
                            fetch_fn=fetch_fn,
                            client=daily_client,
                        )

                    return await kiwoom_index_rest.fetch_index_daily_candles(
                        daily_client, index, inner_from_s, inner_to_s,
                        period=timeframe, run_page=_run_page,
                    )

                return await fetch_index_daily_candles_windowed(
                    from_s,
                    to_s,
                    timeframe,
                    direct_fetch,
                )

            try:
                result = await collect_index_candles_with_cache(
                    index_candles_cache_instance,
                    (index.id, timeframe),
                    from_,
                    to,
                    fetch_batch,
                )
            except KiwoomCapacityOverloaded:
                # 계정별 쿨다운(`KisCapacityCooldown`)은 사라졌다 — 키움 유량은
                # TR별이라 "이 계정만 쉰다" 는 개념이 없다(#1015). 남는 강등 사유는
                # 큐 과부하 하나다. `reason` 문자열은 프론트 계약이라 유지한다.
                reason = "index_kis_capacity_overloaded"
                return {
                    "index_id": index.id,
                    "from": from_,
                    "to": to,
                    "timeframe": timeframe,
                    "candles": [],
                    "data_warnings": [
                        _kis_capacity_degraded_batch_warning(f"{from_}__{to}", reason)
                    ],
                }
        else:
            bucket_seconds = {
                "1m": 60,
                "3m": 180,
                "5m": 300,
                "10m": 600,
                "15m": 900,
                "30m": 1800,
            }[timeframe]
            if index_minute_candles_cache_instance is None:
                raise HTTPException(
                    503,
                    {
                        "code": LiveErrorCode.NOT_WIRED,
                        "message": "index-minute-candles cache not wired (data_dir missing)",
                    },
                )
            # 소스는 여기(조립 지점)서 한 번만 정해진다 — 요청마다 폴백하지 않는다
            # (ADR-0129 D3). 아래 두 클로저 중 하나만 살아 캐시로 내려가고, 그 아래
            # 파이프라인은 누가 fetch 했는지 모른다.
            # 캐시 키의 소스 성분은 `"kiwoom"` 고정이다 — PR-J(#1046)에서 KIS 갈래가
            # 사라졌다. 성분 자체는 남긴다: 기존 캐시 항목과 키가 갈리지 않아야 한다.
            cache_key = ("kiwoom", index.id, timeframe, bucket_seconds)

            # REST 우회 토글 — **가용성 검사보다 앞에 온다.** 우회 중에는 업스트림을
            # 아예 만지지 않는 것이 계약이라, fetcher 미배선으로 503 을 내면 안 된다.
            if live_settings.rest_bypass_enabled(data_dir):
                return _collect_index_minute_candles_cache_only(
                    cache=index_minute_candles_cache_instance,
                    key=cache_key,
                    index_id=index.id,
                    timeframe=timeframe,
                    from_s=from_,
                    to_s=to,
                )

            if not _index_minute_available(bucket_seconds):
                raise HTTPException(
                    503,
                    {
                        "code": LiveErrorCode.NOT_WIRED,
                        "message": "kiwoom index-minute fetcher not wired",
                    },
                )
            fetcher = _kiwoom_index_fetcher
            assert fetcher is not None  # _index_minute_available 가 보장

            async def fetch_batch(from_s: str, to_s: str):
                # 동기 httpx + 페이지당 1s 페이싱이라 스레드로 뺀다
                # (kiwoom_rankings 와 같은 패턴).
                return await asyncio.to_thread(
                    fetcher.fetch,
                    index.id,
                    from_s,
                    to_s,
                    bucket_seconds=bucket_seconds,
                )

            try:
                result = await collect_index_minute_candles_with_cache(
                    index_minute_candles_cache_instance,
                    cache_key,
                    from_,
                    to,
                    fetch_batch,
                    today_yyyymmdd=_today_kst_yyyymmdd(),
                )
            except KiwoomIndexCandlesError:
                # 키움 실패는 KIS 로 떨어지지 않는다(D3) — 값 경계 튐과 진단 어려움을
                # 피하려는 의도적 선택이다. 대신 원인을 경고로 드러내고 빈 응답을 준다.
                log.exception("kiwoom index-minute fetch failed: %s %s", index.id, timeframe)
                return {
                    "index_id": index.id,
                    "from": from_,
                    "to": to,
                    "timeframe": timeframe,
                    "candles": [],
                    "data_warnings": [{
                        "batch": f"{from_}__{to}",
                        "reason": "api_error",
                        "msg": f"kiwoom {_KIWOOM_INDEX_MINUTE_API_ID} fetch failed",
                    }],
                }
            except KiwoomCapacityOverloaded:
                # 계정별 쿨다운(`KisCapacityCooldown`)은 사라졌다 — 키움 유량은
                # TR별이라 "이 계정만 쉰다" 는 개념이 없다(#1015). 남는 강등 사유는
                # 큐 과부하 하나다. `reason` 문자열은 프론트 계약이라 유지한다.
                reason = "index_kis_capacity_overloaded"
                return {
                    "index_id": index.id,
                    "from": from_,
                    "to": to,
                    "timeframe": timeframe,
                    "candles": [],
                    "data_warnings": [
                        _kis_capacity_degraded_batch_warning(f"{from_}__{to}", reason)
                    ],
                }
        batch_label = f"{from_}__{to}"
        data_warnings = [
            _violation_to_warning(v, batch_label) for v in result.violations
        ]
        if timeframe not in {"D", "W", "M"} and result.candles:
            earliest_returned = min(_candle_date_yyyymmdd(c) for c in result.candles)
            if from_ < earliest_returned:
                data_warnings.append({
                    "batch": batch_label,
                    "date": earliest_returned,
                    "reason": "index_minute_depth_limited",
                    "msg": (
                        "KIS index minute REST returned no candles before "
                        f"{earliest_returned} for this source unit"
                    ),
                })
        return {
            "index_id": index.id,
            "from": from_,
            "to": to,
            "timeframe": timeframe,
            "candles": [_candle_to_dict(c) for c in result.candles],
            "data_warnings": data_warnings,
        }

    @router.get("/index-investor-net")
    async def _get_index_investor_net(
        index_id: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> LiveIndexInvestorNetResponse:
        index = _validate_index_range(index_id, from_, to)
        if index.investor_scope != "market":
            raise HTTPException(
                422,
                {
                    "code": LiveErrorCode.UNSUPPORTED_INDEX_INVESTOR_NET,
                    "message": f"{index.id} does not support market investor net",
                },
            )
        if data_dir is not None and live_settings.rest_bypass_enabled(data_dir):
            return {
                "index_id": index.id,
                "from": from_,
                "to": to,
                "unit": "amt_eok",
                "points": [],
                "data_warnings": [
                    _kis_rest_bypassed_batch_warning(f"{from_}__{to}"),
                ],
            }
        # PR-E(#1041) 칼 컷오버 — 게이트도 키움을 본다. KIS 계정 후보 개념은
        # 사라졌다: 키움 유량은 TR별이라 고를 계정이 없다(#1015).
        if data_dir is None or kiwoom_rest_runtime.ensure_rest_client(data_dir) is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "kiwoom client not initialized"},
            )
        if _index_investor_net_fetcher is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "index-investor-net fetcher not wired"},
            )
        return await _index_investor_net_fetcher.fetch(
            index=index,
            from_label=from_,
            to_label=to,
        )

    @router.get("/index-sector-rankings", response_model=IndexSectorRankingResponse)
    async def _get_index_sector_rankings(date: str = Query(...)) -> IndexSectorRankingResponse:
        basis = _parse_yyyymmdd(date)
        if basis is None:
            raise HTTPException(422, {"code": LiveErrorCode.INVALID_DATE, "message": "date must be YYYYMMDD"})
        today = _today_kst_yyyymmdd()
        if date > today:
            raise HTTPException(422, {"code": LiveErrorCode.DATE_IN_FUTURE, "message": "date must be <= today_kst"})
        if data_dir is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "live data dir not wired"})
        intraday_prices: dict[str, int] | None = {} if date == today else None
        if date == today and _index_sector_intraday_overlay is not None:
            intraday_prices = await _index_sector_intraday_overlay.fetch_prices(
                phase=_quote_phase(datetime.now(_KST)),
            )
        # to_thread 필수: build_index_sector_rankings 는 히트맵 전 종목에 대해
        # scan_parquet 을 돌리는 동기 함수다. 루프에서 직접 부르면 그 동안 이 프로세스의
        # 모든 요청·WS 프레임 송출·KIS 스케줄러가 정지한다(60초 폴링 엔드포인트).
        # 대상 모듈은 _cache_lock(threading.Lock) 으로 캐시 변이를 이미 감싸고 있어
        # 스레드 실행이 안전하다.
        rankings = await asyncio.to_thread(
            build_index_sector_rankings,
            data_dir,
            date,
            intraday_prices=intraday_prices,
        )
        return rankings.model_dump()

    @router.post("/control")
    async def _post_control(req: ControlRequest) -> LiveControlResponse:
        if on_control is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "live control not wired (Stage 8)"})
        await on_control(req.action)
        return {"action": req.action, "ok": "true"}

    # 부분 스냅샷의 부재를 부재로 내보낸다(모델 주석 참조).
    @router.get("/snapshot", response_model_exclude_none=True)
    async def _get_snapshot(code: str) -> LiveSnapshotResponse:
        if get_buffer is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "live buffer not wired"})
        buf = get_buffer()
        latest = await buf.get_latest(code)
        if latest is None:
            raise HTTPException(
                404,
                {
                    "code": LiveErrorCode.NO_LIVE_DATA,
                    "message": f"no live data for {code}",
                },
            )
        return latest

    @router.get("/series")
    async def _get_series(code: str, date: str, venue: str = Query("KRX")) -> LiveSeriesResponse:
        if get_buffer is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "live buffer not wired"})
        buf = get_buffer()
        series = await buf.get_series(code)
        kst = KST
        dt = datetime.strptime(date, "%Y%m%d").replace(tzinfo=kst)
        session_open_ms = int(dt.replace(hour=9, minute=0).timestamp() * 1000)
        return {
            **series,
            "date": date,
            "session_open_ms": session_open_ms,
            "session_close_ms": None,
            "is_open": True,
            # 최대벽은 스트림이 **(code, venue)** 로 키잉해 들고 있다(ADR-0140 §2).
            # 여기서 "KRX" 를 못박고 있었던 탓에 NXT·통합을 골라도 KRX 벽이 떴다 —
            # 그 자리를 표시하려고 남겨 둔 주석이 PR-J 에서 안 걷혔다.
            #
            # ⚠ `venue` 기본값이 "KRX" 인 것은 다른 라우트와 규율이 다르다. 이 라우트는
            # 표시 버퍼 hydrate 용이고 프레임마다 venue 태그가 실려 프론트가 거르므로,
            # 필수화하면 구 프론트가 통째로 빈 화면이 된다. 최대벽만 venue 를 탄다.
            "ask_peak_today": (
                get_today_ask_peak(code, venue) if get_today_ask_peak is not None else None
            ),
            "bid_peak_today": (
                get_today_bid_peak(code, venue) if get_today_bid_peak is not None else None
            ),
        }

    # 시세 오버레이 fetch+캐시+게이팅은 LiveQuoteFetcher 가 소유. build_router 호출마다
    # 새 인스턴스라 마지막-시세 캐시 스코프는 종전(per-router 클로저)과 동일.
    quote_change_resolver = QuoteChangeResolver(
        adjusted_daily_path=(
            data_dir / "screener" / "daily_adjusted.parquet"
            if data_dir is not None
            else None
        )
    )
    _quote_fetcher = LiveQuoteFetcher(change_resolver=quote_change_resolver)
    _investor_estimate_fetcher = LiveInvestorEstimateFetcher(
        observed_at_store_path=(
            data_dir / "live" / "investor-trend-estimate-observed-at.json"
            if data_dir is not None
            else None
        )
    )
    # PR-E(#1041) 칼 컷오버 — 투자자 3표면은 키움 거버너를 쓴다. KIS 스케줄러가
    # 없어도 구성된다: 두 스케줄러는 이제 서로 무관한 축이다.
    _index_investor_net_fetcher: LiveIndexInvestorNetFetcher | None = (
        LiveIndexInvestorNetFetcher(
            data_dir=data_dir, scheduler=kiwoom_rest_runtime.ensure_scheduler(data_dir)
        )
        if data_dir is not None
        else None
    )
    _index_sector_intraday_overlay: LiveIndexSectorIntradayOverlay | None = (
        LiveIndexSectorIntradayOverlay(
            data_dir=data_dir,
            scheduler=kiwoom_rest_runtime.ensure_scheduler(data_dir),
            quote_fetcher=_quote_fetcher,
        )
        if data_dir is not None
        else None
    )

    @router.get("/quotes", response_model=LiveQuotesResponse)
    async def _get_quotes(
        codes: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> LiveQuotesResponse:
        now = datetime.now(_KST)
        try:
            venue_policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": LiveErrorCode.INVALID_VENUE, "message": str(e)}) from e
        quote_venue = quote_venue_for_policy(venue_policy, now)
        phase = _quote_phase(now, venue_policy)
        code_list = [c for c in codes.split(",") if _CODE_RE.match(c)]
        if not code_list:
            return LiveQuotesResponse(phase=phase, quotes=[])
        if data_dir is not None and live_settings.rest_bypass_enabled(data_dir):
            return LiveQuotesResponse(
                phase=phase,
                quotes=_quote_fetcher.stale_last_good(
                    code_list,
                    phase,
                    today=now.date(),
                    venue=quote_venue,
                ),
            )
        quote_client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if quote_client is None:
            return LiveQuotesResponse(phase=phase, quotes=[])
        def _quotes_chunk_fn(chunk: list[str]):
                    # 청크 1개 = 거버너 submit 1건. **바깥에서 fetch_and_gate 를
                    # 통째로 감싸면 안 된다** — 거버너는 submit 진입 전에 버킷을 한 번만
                    # 소비하므로 그 안의 청크 N개가 페이싱을 못 받는다(#1063 실측:
                    # 43청크 0.23초 → `1700 유량=5`). 이중 감싸기도 금지다: 바깥이
                    # ka10095 토큰을 쥔 채 안쪽이 같은 버킷을 기다려 자기를 굶긴다.
            return kiwoom_access.run_with_capacity(
                kiwoom_rest_runtime.ensure_scheduler(data_dir),
                key=("quotes", quote_venue, tuple(chunk), phase),
                api_id="ka10095",
                priority="background",
                client=quote_client,
                fetch_fn=lambda c: kiwoom_multi_quote.fetch_chunk(
                    c, chunk, venue=quote_venue,
                ),
            )

        try:
            quotes = await asyncio.wait_for(
                asyncio.shield(
                    _quote_fetcher.fetch_and_gate(
                        quote_client,
                        code_list,
                        phase,
                        today=now.date(),
                        venue=quote_venue,
                        fetch_chunk_fn=_quotes_chunk_fn,
                    )
                ),
                timeout=1.0,
            )
        except TimeoutError:
            quotes = _quote_fetcher.stale_last_good(
                code_list,
                phase,
                today=now.date(),
                stale_reason="capacity_timeout",
                venue=quote_venue,
            )
        # 계정별 쿨다운(`KisCapacityCooldown`) 분기는 사라졌다 — 그건 KIS 계정 풀의
        # 개념이고 키움 유량은 TR별이라 고를 계정이 없다(#1015). 남는 강등은
        # 타임아웃과 큐 과부하 둘뿐이다. `stale_reason` 문자열은 프론트 계약이라
        # 지금 바꾸지 않는다 — #1046(PR-J)에서 벤더명과 함께 정리한다.
        except KiwoomCapacityOverloaded:
            quotes = _quote_fetcher.stale_last_good(
                code_list,
                phase,
                today=now.date(),
                stale_reason="capacity_overloaded_upstream",
                venue=quote_venue,
            )
        return LiveQuotesResponse(
            phase=phase,
            quotes=quotes,
        )

    @router.get("/tab-metrics", response_model=LiveTabMetricsResponse)
    async def _get_tab_metrics(
        codes: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> LiveTabMetricsResponse:
        now = datetime.now(_KST)
        now_ms = int(now.timestamp() * 1000)
        try:
            venue_policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": LiveErrorCode.INVALID_VENUE, "message": str(e)}) from e
        quote_venue = quote_venue_for_policy(venue_policy, now)
        phase = _quote_phase(now, venue_policy)
        code_list = list(dict.fromkeys(c for c in codes.split(",") if _CODE_RE.match(c)))
        if not code_list:
            return LiveTabMetricsResponse(phase=phase, metrics=[])

        quotes: list[LiveQuote] = []
        if data_dir is not None and live_settings.rest_bypass_enabled(data_dir):
            quotes = []
        elif (tab_client := kiwoom_rest_runtime.ensure_rest_client(data_dir)) is not None:
            def _tab_chunk_fn(chunk: list[str]):
                """청크 1개 = 거버너 submit 1건 (`/quotes` 와 같은 이유)."""
                return kiwoom_access.run_with_capacity(
                    kiwoom_rest_runtime.ensure_scheduler(data_dir),
                    key=("tab-metrics-quotes", quote_venue, tuple(chunk), phase),
                    api_id="ka10095",
                    priority="background",
                    client=tab_client,
                    fetch_fn=lambda c: kiwoom_multi_quote.fetch_chunk(
                        c, chunk, venue=quote_venue,
                    ),
                )

            try:
                quotes = await asyncio.wait_for(
                    asyncio.shield(
                        _quote_fetcher.fetch_and_gate(
                            tab_client,
                            code_list,
                            phase,
                            today=now.date(),
                            venue=quote_venue,
                            fetch_chunk_fn=_tab_chunk_fn,
                        )
                    ),
                    timeout=1.0,
                )
            except (TimeoutError, KiwoomCapacityOverloaded):
                quotes = []
        quote_by_code = {quote.code: quote for quote in quotes}

        buf = get_buffer() if get_buffer is not None else None
        metrics: list[LiveTabMetric] = []
        for code in code_list:
            quote = quote_by_code.get(code)
            series = await buf.get_series(code) if buf is not None else None
            snapshots = series.get("snapshots", []) if series is not None else []
            latest_ob = snapshots[-1] if snapshots else None
            ratio, hoga_available, hoga_reason = _extract_tab_hoga_ratio(latest_ob, now_ms=now_ms)
            metrics.append(
                LiveTabMetric(
                    code=code,
                    change_pct=quote.change_pct if quote is not None else None,
                    hoga_ratio_x=ratio,
                    hoga_available=hoga_available,
                    hoga_reason=hoga_reason,
                    source="quote_cache" if phase == "closed" else "live",
                )
            )
        return LiveTabMetricsResponse(phase=phase, metrics=metrics)

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
                {"code": LiveErrorCode.INVALID_CODE, "message": "code must be 6 digits"},
            )
        if data_dir is not None and live_settings.rest_bypass_enabled(data_dir):
            return _investor_estimate_fetcher._error_response(
                code,
                _investor_estimate_fetcher._today_fn(),
                "rest_bypassed",
                "KIS REST bypass is enabled",
            )
        # PR-E(#1041) 칼 컷오버 — 소스는 키움 ka10064 다.
        est_client = (
            kiwoom_rest_runtime.ensure_rest_client(data_dir) if data_dir is not None else None
        )
        if est_client is None:
            return _investor_estimate_fetcher.credentials_missing(code)
        # 거버너가 fetch **바깥**이 아니라 **축별 콜마다** 걸린다. ka10064 는 수량·금액이
        # 별개의 콜이라(ADR-0137) 바깥에서 한 번 감싸면 버킷은 1 을 세고 벤더는 2 를
        # 센다. key 에 축을 넣는 것도 필수다 — 빠뜨리면 두 축이 같은 중복제거 key 로
        # 조인해 한 축의 응답이 다른 축 자리에 앉는다.
        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)

        def _run_axis_call(fetch: PageFetch, axis: str):
            return kiwoom_access.run_with_capacity(
                scheduler,
                key=("investor-trend-estimate", code, axis),
                api_id="ka10064",
                priority="background",
                client=est_client,
                fetch_fn=fetch,
            )

        try:
            return await asyncio.wait_for(
                asyncio.shield(
                    _investor_estimate_fetcher.fetch(est_client, code, run_call=_run_axis_call),
                ),
                timeout=1.5,
            )
        except (TimeoutError, KiwoomCapacityOverloaded):
            return _investor_estimate_fetcher._error_response(
                code,
                _investor_estimate_fetcher._today_fn(),
                "rate_limit_upstream",
                "kiwoom capacity scheduler unavailable",
            )

    cache_instance: PastCandlesCache | None = (
        PastCandlesCache(data_dir=data_dir) if data_dir is not None else None
    )

    minute_backfill: LiveMinuteCandleBackfill | None = (
        LiveMinuteCandleBackfill(
            data_dir=data_dir,
            cache=cache_instance,
            # PR-G(#1043): 키움 거버너다 — KIS 스케줄러와 무관한 축이다.
            scheduler=kiwoom_rest_runtime.ensure_scheduler(data_dir),
            concurrency=_past_candles_concurrency(data_dir),
            rate_limit_cooldown_s=_PAST_CANDLES_RATE_LIMIT_COOLDOWN_S,
        )
        if data_dir is not None and cache_instance is not None
        else None
    )
    daily_cache_instance: PastDailyCandlesCache | None = (
        PastDailyCandlesCache() if data_dir is not None else None
    )
    daily_backfill: LiveDailyCandleBackfill | None = (
        LiveDailyCandleBackfill(
            data_dir=data_dir,
            cache=daily_cache_instance,
            # PR-F(#1042): 키움 거버너다 — KIS 스케줄러와 무관한 축이다.
            scheduler=kiwoom_rest_runtime.ensure_scheduler(data_dir),
            walkback=batched_daily_walkback,
        )
        if data_dir is not None and daily_cache_instance is not None
        else None
    )
    global index_candles_cache_instance  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    if data_dir is not None and index_candles_cache_instance is None:
        index_candles_cache_instance = IndexCandlesCache()
    global kiwoom_stock_info_fetcher_instance, kiwoom_rankings_fetcher_instance  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    global _kiwoom_index_fetcher  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    if data_dir is not None and kiwoom_stock_info_fetcher_instance is None:
        _kiwoom_prov = kiwoom_runtime.ensure_token_provider_for_account(0, data_dir)
        if _kiwoom_prov is not None:
            kiwoom_stock_info_fetcher_instance = KiwoomStockInfoFetcher(_kiwoom_prov)
            # 순위 fetcher 는 같은 account-0 토큰 provider 를 재사용(스펙: rkinfo 4종).
            kiwoom_rankings_fetcher_instance = KiwoomRankingsFetcher(_kiwoom_prov)
            # 지수 분봉 fetcher (ADR-0129) — 같은 provider. 이 대입이 곧 소스 선택이다:
            # 자격증명이 없으면 None 으로 남아 지수 분봉이 KIS 로 간다(현행 동작 유지).
            _kiwoom_index_fetcher = KiwoomIndexCandlesFetcher(_kiwoom_prov)
    global index_minute_candles_cache_instance  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    if data_dir is not None and index_minute_candles_cache_instance is None:
        index_minute_candles_cache_instance = IndexMinuteCandlesCache()
    # Investor net-buy reuses the daily candle cache (ADR-0055): same date-cursor
    # walk-back + batch/gap memory cache shape, just storing point dicts.
    investor_cache_instance: PastDailyCandlesCache | None = (
        PastDailyCandlesCache() if data_dir is not None else None
    )
    investor_net_backfill: LiveInvestorNetBackfill | None = (
        LiveInvestorNetBackfill(
            data_dir=data_dir,
            cache=investor_cache_instance,
            # PR-E(#1041): 키움 거버너다 — KIS 스케줄러와 무관한 축이다.
            scheduler=kiwoom_rest_runtime.ensure_scheduler(data_dir),
            walkback=batched_daily_walkback,
        )
        if data_dir is not None and investor_cache_instance is not None
        else None
    )

    @router.get("/past-candles")
    async def _get_past_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
        venue: str | None = Query("KRX"),
        bucket_ms: int | None = Query(None),
    ) -> LivePastCandlesResponse:
        """`bucket_ms` 는 **과거분을 벤더에서 어느 주기로 받을지**를 고른다.

        미지정이면 1분이다 — 이 파라미터가 생기기 전 동작과 같아서 기존 소비자가
        그대로 돈다. 지정하면 키움 `ka10080` 의 `tic_scope` 로 직접 요청하므로 콜당
        커버리지가 배수로 늘어난다(10분 = 900행에 약 23 거래일, 1분의 10배).

        오늘분은 이 값과 무관하게 1분이다(`collect_minute` docstring 참고).
        """
        frm, too, today_d = _validate_past_request(code, from_, to)
        try:
            policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": LiveErrorCode.INVALID_VENUE, "message": str(e)}) from e
        # 응답에 되싣는다 — 소비자가 **받은 봉의 해상도**를 알아야 캐시/병합을
        # 해상도별로 가를 수 있다. 프론트는 이 값으로 placeholder 재사용 여부를
        # 판단한다(다른 해상도를 잠깐 그리면 축이 어긋난다).
        resolved_bucket_ms = 60_000 if bucket_ms is None else bucket_ms
        if bucket_ms is None:
            tic_scope = kiwoom_minute_candles.TIC_SCOPE_1MIN
        else:
            resolved = kiwoom_minute_candles.tic_scope_for_bucket_ms(bucket_ms)
            if resolved is None:
                supported = sorted(kiwoom_minute_candles.BUCKET_MS_TO_TIC_SCOPE)
                raise HTTPException(422, {
                    "code": LiveErrorCode.UNSUPPORTED_BUCKET_MS,
                    "message": f"bucket_ms={bucket_ms} is not a vendor minute scope; supported: {supported}",
                })
            tic_scope = resolved
        if minute_backfill is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "past-candles cache not wired (data_dir missing)"},
            )
        if data_dir is not None and live_settings.rest_bypass_enabled(data_dir):
            out = await minute_backfill.collect_minute_cache_only(
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
                policy=policy,
                tic_scope=tic_scope,
            )
            return {
                "code": code, "from": from_, "to": to, "venue": policy,
                "bucket_ms": resolved_bucket_ms, **out.model_dump(),
            }
        if data_dir is None or kiwoom_rest_runtime.ensure_rest_client(data_dir) is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "kiwoom client not initialized"},
            )

        out = await minute_backfill.collect_minute(
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
            policy=policy,
            tic_scope=tic_scope,
        )
        return {
            "code": code, "from": from_, "to": to, "venue": policy,
            "bucket_ms": resolved_bucket_ms, **out.model_dump(),
        }

    @router.get("/past-daily-candles")
    async def _get_past_daily_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> LivePastDailyCandlesResponse:
        frm, too, today_d = _validate_past_request(code, from_, to, max_days=None)
        try:
            policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": LiveErrorCode.INVALID_VENUE, "message": str(e)}) from e
        if daily_backfill is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "past-daily-candles cache not wired (data_dir missing)"},
            )
        if data_dir is not None and live_settings.rest_bypass_enabled(data_dir):
            return await daily_backfill.collect_daily_cache_only(
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
                policy=policy,
                from_label=from_,
                to_label=to,
            )
        if data_dir is None or kiwoom_rest_runtime.ensure_rest_client(data_dir) is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "kiwoom client not initialized"},
            )
        return await daily_backfill.collect_daily(
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
            policy=policy,
            from_label=from_,
            to_label=to,
        )

    @router.get("/screener-daily-candles")
    async def _get_screener_daily_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> ScreenerDailyCandlesResponse:
        frm, too, _today_d = _validate_past_request(code, from_, to, max_days=None)
        if data_dir is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "screener daily corpus not wired (data_dir missing)"},
            )
        # to_thread 필수: 전체 유니버스 × 전체 이력 parquet 을 스캔하는 동기 함수다.
        # 루프에서 직접 부르면 그 동안 프로세스 전체가 멈춘다. 순수 함수(공유 상태 없음)라
        # 스레드 실행이 안전하다.
        return await asyncio.to_thread(
            read_screener_daily_candles,
            data_dir,
            code=code,
            frm=frm,
            too=too,
            from_label=from_,
            to_label=to,
        )

    @router.get("/past-investor-net")
    async def _get_past_investor_net(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> LivePastInvestorNetResponse:
        """Daily foreign/institution net-buy quantities across [from, to].

        KIS investor-trade-by-stock-daily (FHPTJ04160001) supports date-cursor
        walk-back (ADR-0055), so this mirrors /past-daily-candles: batch/gap
        memory cache + per-gap walk-back fetch + today tri-state. Net-buy is
        signed (+ buy / − sell). Today's row is provisional until ~15:40 (가집계).
        """
        frm, too, today_d = _validate_past_request(code, from_, to, max_days=None)
        # 종목 경로의 축은 **수량(주)** (ka10059, AMT_QTY_QUANTITY). 지수 경로(amt_eok)와
        # 다르므로 응답이 스스로 말한다(#1119).
        unit = {"unit": "qty_shares"}
        if (
            data_dir is not None
            and investor_cache_instance is not None
            and live_settings.rest_bypass_enabled(data_dir)
        ):
            return unit | _collect_daily_series_cache_only(
                cache=investor_cache_instance,
                output_key="points",
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
                from_label=from_,
                to_label=to,
            )
        # PR-E(#1041) 칼 컷오버 — 게이트도 키움을 본다(#1015).
        if data_dir is None or kiwoom_rest_runtime.ensure_rest_client(data_dir) is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "kiwoom client not initialized"},
            )
        if investor_net_backfill is None:
            raise HTTPException(
                503,
                {"code": LiveErrorCode.NOT_WIRED, "message": "past-investor-net cache not wired (data_dir missing)"},
            )
        return unit | await investor_net_backfill.collect(
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
        )

    @router.get("/vi-status")
    async def _get_vi_status(code: str = Query(...)) -> LiveViStatusResponse:
        """종목의 최신 VI 이벤트 상태(키움 1h). 이벤트 없음/미배선이면 vi=null.

        legend·shape 는 kiwoom_vi_state.parse_vi_row(실측 확정 2026-07-21,
        docs/research/2026-07-21-kiwoom-vi-price-sources.md). BookPanel 이
        정규장 중 짧은 주기로 폴링해 발동 강조 + 발동 후 기준가 근사에 쓴다 —
        VI 는 2분 지속이라 폴링 지연이 실용 범위다.
        """
        if not _CODE_RE.match(code):
            raise HTTPException(422, {"code": LiveErrorCode.INVALID_CODE, "message": "code must be 6 digits"})
        vi = get_vi_status(code) if get_vi_status is not None else None
        return {"code": code, "vi": vi}

    @router.get("/stock-limits", response_model=StockLimitsResponse)
    async def _get_stock_limits(code: str = Query(...)) -> StockLimitsResponse:
        """상하한가·기준가·250일 최고/최저 (키움 ka10001, KST 날짜 단위 캐시).

        10호가 요약 패널의 상한가/하한가/52주 행 소스. 키움은 52주가 아니라
        250거래일 기준을 쓴다 — 프론트 라벨도 그에 맞춘다. 미제공 필드(신규상장
        등)는 null 로 내려가고 패널이 대시로 렌더한다.
        """
        if not _CODE_RE.match(code):
            raise HTTPException(422, {"code": LiveErrorCode.INVALID_CODE, "message": "code must be 6 digits"})
        if kiwoom_stock_info_fetcher_instance is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "kiwoom credentials not configured"})
        try:
            limits, fetched_at_ms = await kiwoom_stock_info_fetcher_instance.get(code)
        except KiwoomStockInfoError as e:
            raise HTTPException(502, {"code": LiveErrorCode.KIWOOM_API_ERROR, "message": str(e)}) from e
        except httpx.HTTPError as e:
            raise HTTPException(502, {"code": LiveErrorCode.KIWOOM_HTTP_ERROR, "message": str(e)}) from e
        return StockLimitsResponse(
            code=limits.code,
            base_price=limits.base_price,
            upper_limit=limits.upper_limit,
            lower_limit=limits.lower_limit,
            high_250=limits.high_250,
            low_250=limits.low_250,
            high_250_date=limits.high_250_date,
            low_250_date=limits.low_250_date,
            fetched_at_ms=fetched_at_ms,
        )

    @router.get("/rankings", response_model=RankingsResponse)
    async def _get_rankings(
        kind: RankingKind = Query(...),
        market: RankingMarket = Query("all"),
        direction: RankingDirection = Query("up"),
        exclude_etf: bool = Query(False),
        # 순위 TR 은 `stex_tp`(거래소구분)로 시장을 가른다 — `mrkt_tp`(코스피/코스닥)와
        # 직교하는 별개 축이다. 기본값을 두는 이유는 구 프론트가 이 값을 안 보내기
        # 때문이고, 그 경우 예전과 같은 KRX 순위가 나온다.
        venue: str = Query("KRX"),
    ) -> RankingsResponse:
        """시장 전체 순위 (키움 rkinfo 4종, kind 별 api-id 분기, TTL ~8s 캐시).

        우측 RightRail "순위" 드로어 소스. kind=change 만 direction(상승/하락)이
        의미 있고 나머지는 무시된다. market_open=False 면 프론트가 폴링을 멈추고
        "장 외" 라벨을 단다 — 비거래일엔 상류를 건너뛰고 빈(또는 웜) 목록을 준다.

        exclude_etf=True 면 심볼 마스터의 security_type(etf/etn) 종목을 응답에서
        제거한다. 필터는 라우트 후처리 — fetcher 캐시는 전체 리스트를 그대로 캐싱해
        캐시 효율·조합 자유를 유지한다. 제거 후 rank 는 1부터 재부여(연속 순위)한다.

        마스터가 미로드면 거를 수 없다. 그때는 조용히 통과시키지 않고
        warnings=["etf_filter_unavailable"] 를 실어 보낸다 — 순위 목록 자체는
        보여주되(503 으로 목록을 통째로 잃는 것보다 낫다) 필터가 듣지 않았음을
        사용자가 알 수 있어야 한다.
        """
        if kiwoom_rankings_fetcher_instance is None:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED, "message": "kiwoom credentials not configured"})
        try:
            snap = await kiwoom_rankings_fetcher_instance.get(kind, market, direction, venue)
        except KiwoomRankingsError as e:
            raise HTTPException(502, {"code": LiveErrorCode.KIWOOM_API_ERROR, "message": str(e)}) from e
        except httpx.HTTPError as e:
            raise HTTPException(502, {"code": LiveErrorCode.KIWOOM_HTTP_ERROR, "message": str(e)}) from e
        rows = snap.rows
        warnings: list[str] = []
        if exclude_etf:
            drop = symbols.all_etf_etn_codes()
            if drop is None:
                warnings.append("etf_filter_unavailable")
            else:
                rows = tuple(r for r in rows if r.code not in drop)
        return RankingsResponse(
            kind=snap.kind,
            market=snap.market,
            direction=snap.direction,
            rows=[
                RankingRowModel(
                    rank=i, code=r.code, name=r.name,
                    price=r.price, change_pct=r.change_pct,
                )
                for i, r in enumerate(rows, start=1)
            ],
            market_open=snap.market_open,
            fetched_at_ms=snap.fetched_at_ms,
            # 요청 venue 가 아니라 **스냅샷이 들고 있는 값**을 되싣는다 — 둘이 갈릴
            # 여지를 남기지 않는다(캐시 히트가 다른 venue 를 줬다면 여기서 드러난다).
            venue=snap.venue,
            warnings=warnings,
        )

    return router
