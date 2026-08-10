"""FastAPI route handlers. Each per-table handler delegates to the table
module's ``query_*`` function, which returns Pydantic models directly.
This file is the thin glue layer.
"""

from __future__ import annotations

import contextlib
import functools
import logging
import os
import re
from contextlib import AbstractAsyncContextManager
from datetime import datetime
from pathlib import Path

import anyio
import anyio.to_thread
from fastapi import APIRouter, HTTPException, Query

from hoga import perf_debug
from hoga.api.bundle import build_range_bundle
from hoga.api.models import (
    BrokerSeriesResponse,
    CandlesResponse,
    GapRange,
    GapRangesResponse,
    Meta,
    OrderbookResponse,
    RangeBundle,
    StockDate as StockDateModel,
    validate_bucket_ms,
)
from hoga.api.params import CODE_PATTERN, Code, StockDate
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.api.sources import SourceName, resolve_source_result
from hoga.tables import brokers as brokers_tbl, candles as candles_tbl, snapshots as snapshots_tbl
from hoga.util.timeenc import (
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
    unix_ms_to_hhmmssms,
)

log = logging.getLogger(__name__)

# `/api/range` 의 **넓은 구간** 동시 compute 상한.
#
# 왜 상한이 필요한가: 이 경로는 시간의 대부분이 행→pydantic 모델 생성이라 GIL 을
# 놓지 않는다. 32코어에서 스레드 6개로 돌려도 wall 이 **7.1배**로 늘어나고(스레드마다
# 별도 DuckDB 커넥션을 줘도 7.8배라 커넥션 락은 부차적이다), 그래서 동시에 던진 넓은
# 요청은 서로를 그 수만큼 늦출 뿐 처리량을 늘리지 못한다.
#
# **왜 좁은 요청은 이 상한을 타지 않는가 — 이게 이 설계의 핵심이고, 측정이 시켰다.**
# 처음에는 모든 `/api/range` 를 한 큐에 넣었다. 같은 요청 12개(전부 5개월)로 재면
# 상한 1이 모든 지표에서 최선이었다 — 균일한 작업에는 FIFO 단일 큐가 최적이다.
# 그런데 **운영 부하는 균일하지 않다**: `/study` 의 5개월과 `/live` 의 하루가 같은
# 엔드포인트를 탄다. 그 혼합(무거운 것 6 + 가벼운 것 16 = 22 동시)으로 재자 결론이
# 뒤집혔다 — 아래는 **무게 분리 없이** 전부 한 큐에 넣었을 때다
# (`HOGA_RANGE_WIDE_SPAN_DAYS=0` 으로 재현 가능):
#
#     상한      wall   가벼운것 중앙   무거운것 중앙   전체 평균
#     무제한   1.95s        0.25s        1.73s      0.62s
#     1        1.87s        1.85s        1.15s      1.61s   ← 가벼운 것이 7배 느려진다
#     2        1.72s        1.48s        1.20s      1.39s
#     4        1.82s        1.52s        1.31s      1.44s
#
# 상한이 무거운 것의 중앙값은 낮추지만(1.73 → 1.15), 그 이득을 가벼운 요청에서
# 그보다 크게 뺏어 온다. 총 wall 은 어느 쪽이든 비슷하다 — 즉 **단일 큐의 상한은
# 이득이 아니라 재분배**였고, 재분배가 손해 쪽이었다. head-of-line blocking:
# 하루짜리가 5개월짜리 뒤에 갇힌다.
#
# 그래서 큐를 무게로 나눴다(`_is_wide_range`). 넓은 요청만 줄을 서고 좁은 요청은
# 곧장 지나간다. 같은 부하를 다시 재면 **모든 열이 개선된다** — 재분배가 아니라
# 실제 이득이다(2회 측정, 순서 재현됨):
#
#     상한      wall   가벼운것 중앙   무거운것 중앙   전체 평균
#     무제한   1.93s        0.25s        1.81s      0.62s
#     1        1.90s        0.16s        1.24s      0.44s   ← 채택
#     2        1.90s        0.21s        1.40s      0.50s
#     4        2.07s        0.21s        1.70s      0.62s
#
# ⚠ 1인 이유가 바뀐 적이 있다. `model_copy` 로 행을 두 벌 만들던 시절에는 compute 가
# 지금의 2배여서 상한 2가 최적이었다(넓은 것끼리 완전 직렬이면 그쪽 중앙값이 올라갔다).
# `ts_ms` 보정을 SQL 로 밀어 그 두 번째 벌을 없애자(0.63s → 0.29s) compute 가 짧아져
# 대기 자체가 싸졌고, GIL 경합을 아예 피하는 1이 다시 최적이 됐다. **compute 비용이
# 바뀌면 이 값을 다시 재라** — 상한은 compute 시간의 함수다.
#
# ⚠ **이 상한은 "polars 로 옮기면 없앨 수 있는 임시방편" 이 아니다** — 그렇게 적었다가
# 측정으로 반증했다(ADR-0085 v3.1). candles 를 컬럼화해도 이득은 모델을 **아예 안
# 만들 때만** 나오고(4.0× → 2.2×), 그건 `RangeBundle.candles` wire 계약을 걷어내는
# 일이라 성능과 맞바꿀 문제가 아니다. 없애려면 별도 ADR 로 의도를 먼저 세울 것.
#
# 운영 조건(engine 공유 = 캐시 1벌) 6-스레드 팽창: candles **6.7×** · hoga 6~8× ·
# sidecar **3.8×**. sidecar 가 가장 잘 병렬화되는데(peak 가 polars 라 GIL 을 놓는다)
# **부선형**이기까지 하다 — 즉 그쪽은 동시성이 실제 이득이다. 무게를 일수가 아니라
# **모드**로 가르면 sidecar 를 상한 밖에 둘 여지가 있다(ADR-0085 v3.2, 미착수).
#
# ⚠ 그리고 팽창의 **약 절반은 GIL 이 아니라 GC** 다(`gc.disable()` 로 candles +49% ·
# sidecar +51%). stop-the-world 수집이 모든 스레드를 멈추기 때문이다. 이 상한을
# 재검토할 때는 GC 쪽을 먼저 볼 것 — 코드 구조를 안 건드리고 같은 크기를 겨냥한다.
RANGE_COMPUTE_CONCURRENCY = int(os.environ.get("HOGA_RANGE_CONCURRENCY", "") or 1)

# 이 일수 이상을 요청하면 "넓은 구간" 으로 보고 상한을 태운다.
#
# 30일은 두 사용처 사이의 빈 구간이다: `/live` 는 하루~수일을 잘게 요청하고
# (오늘 · 스크롤백 청크), `/study` 저장뷰는 수개월을 한 번에 요청한다. 경계가
# 정확할 필요는 없다 — 틀리면 좁은 요청이 상한을 타거나(약간 느려짐) 넓은 요청이
# 안 타는(예전 동작) 것뿐이고, 둘 다 정상 동작이다.
#
# ⚠ 무게 대리(proxy)로 **일수**를 쓴다. 실제 비용은 그 구간에 캡처가 얼마나
# 있는지에 달렸으므로, 데이터가 없는 넓은 구간은 싼데도 줄을 선다. 그 요청은
# 어차피 빨리 끝나 뒤를 오래 막지 않는다.
RANGE_WIDE_SPAN_DAYS = int(os.environ.get("HOGA_RANGE_WIDE_SPAN_DAYS", "") or 30)

# 상한 대기가 이 값을 넘으면 로그에 남긴다. 대기는 TTFB 에 그대로 포함되므로
# (`request_timing`), 이 값이 없으면 다음 조사자가 **큐 대기를 계산 시간으로 읽는다**
# — 이 세션이 정확히 그 오독을 한 번 하고 나서 프로브로 갈랐다.
RANGE_QUEUE_WAIT_LOG_MS = 1000.0


def _is_wide_range(from_date: str, to_date: str) -> bool:
    """이 요청이 상한을 타는 "넓은 구간" 인가.

    파싱 실패는 **좁은 것으로 본다**(= 상한 없음). 여기서 막아 봐야 얻는 것이 없고,
    형식 오류는 바로 아래 `build_range_bundle` 이 400 으로 답하는 것이 계약이다.
    이 함수가 그 판정을 앞당겨 흉내 내면 두 곳이 같은 규칙을 들고 갈라진다.
    """
    try:
        d_from = datetime.strptime(from_date, "%Y%m%d").date()
        d_to = datetime.strptime(to_date, "%Y%m%d").date()
    except ValueError:
        return False
    return (d_to - d_from).days >= RANGE_WIDE_SPAN_DAYS


def _parquet_path(
    engine: QueryEngine, date: str, code: str, filename: str
) -> Path:
    """Resolve a parquet file path inside a captured Stock-Date dir.

    Raises HTTP 404 if the Stock-Date isn't captured. Centralises the
    try/except pattern repeated across every per-Stock-Date handler.

    venue="KRX" 는 폴백이 아니라 **사실**이다 — 이 헬퍼를 쓰는 per-Stock-Date
    라우트들은 venue 축이 없다(#1133 에서 명시화).
    """
    try:
        return engine.parquet_dir(date, code, venue="KRX") / filename
    except StockDateNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


def _resolved_parquet_dir(
    engine: QueryEngine, date: str, code: str, source_pref: str, venue: str
) -> tuple[Path | None, SourceName]:
    """Resolve source preference per ADR-0044 and return (parquet_dir, resolved_source).

    Returns (None, source_pref) when the Stock-Date or source dir is missing
    on disk — the spot routes (/api/orderbook, /api/brokers/series) surface
    that as an empty 200 response rather than 404. This mirrors the empty-
    bundle semantics /api/range adopted, and matches ADR-0044's intent: a
    candle whose source dir was never captured should render as an empty
    sidebar, not a console error on every hover.

    /api/candles continues to use the simpler _parquet_path because it
    doesn't honor source_pref and keeps strict 404 semantics. /api/meta
    is the same.

    ⚠ 그 "strict 404" 는 **디렉터리 층에만** 걸린다. `/api/candles` 도 파케이
    **파일** 부재는 빈 200 으로 답한다 — 부재는 0행의 다른 이름이고, 0행 파일이
    남아 있는 경우가 이미 빈 200 이라 그래야 응답이 디스크 모양에 안 흔들린다.
    """
    # `kis_api` 억제 분기는 제거됐다(2026-08-07) — 그 소스 자체가 사라져 승자가 될 수
    # 없다. 남은 둘은 호가·체결을 정상 서빙한다.
    resolution = resolve_source_result(engine, date, code, source_pref, venue)
    # ⚠ 경로 **존재**까지 본다. 위 docstring 이 약속하는 계약인데 구현이 안 따라가고
    # 있었다 — venue 축이 생기기 전엔 `resolve_source_result` 가 meta.json 을 가진
    # source 에만 경로를 줘서 디렉터리가 늘 존재했다. 지금은 분류가 **source 단위**
    # (venue 중 가장 심한 상태)라 `kiwoom_live` 가 healthy 로 뽑히고, 경로엔 없는
    # venue 세그먼트가 붙는다.
    #
    # 실측 2026-08-06: `venue=UN` 으로 NXT 미상장 종목(028670 팬오션)을 호버하면
    # `kiwoom_live/UN/` 이 없는데 그대로 DuckDB 로 넘어가 **`/api/orderbook` ·
    # `/api/brokers/series` 가 500** 이었다. 정상적으로 없는 것을 장애로 답한 셈이다.
    if resolution.path is not None and not resolution.path.is_dir():
        return None, resolution.source
    return resolution.path, resolution.source


def _spot_table_path(sd_dir: Path, filename: str) -> Path | None:
    """스팟 라우트용 테이블 경로 — **파일이 없으면 None**(빈 200 으로 이어진다).

    디렉터리 존재(`_resolved_parquet_dir`)만으로는 부족하다. writer 의 계약이
    **"0행이면 파일을 안 남긴다"** 이기 때문이다 — `live/promote._atomic_write_table`
    이 DuckDB 의 0행 parquet 문제를 피하려고 unlink 하고, 그 docstring 이 부재 처리를
    명시적으로 **리더의 몫**으로 넘긴다. 그래서 파일 부재는 장애가 아니라 **정상
    상태**다: 거래원 첫 스냅샷이 붙기 전의 종목은 `brokers.parquet` 이 아예 없다.

    실측 2026-08-07: 08:00 대에 `009150` 을 호버하면 `kiwoom_live/UN/` 은 있는데
    `brokers.parquet` 만 없어 **`/api/brokers/series` 가 500** 이었다. 같은 순간
    `meta.json` 은 `row_counts.brokers: 0` 으로 "0건"이라 정직하게 말하고 있었다.
    08:04 에 거래원이 붙자 같은 요청이 200 이 됐다 — 즉 **매일 아침 전 종목이
    지나는 창**이지 특정 종목의 결함이 아니다.

    이 층은 위 `_resolved_parquet_dir` 의 디렉터리 층과 같은 교훈의 한 칸 아래다.
    #1133 이 디렉터리 층을 고치면서 파일 층은 범위 밖으로 남겼고, 그게 여기서 터졌다.
    번들 경로(`api/bundle.py`)는 호출 지점마다 `.exists()` 로 이미 지키고 있었다 —
    이 헬퍼는 스팟 경로에 같은 규약을 준다.
    """
    path = sd_dir / filename
    return path if path.is_file() else None


def _cursor_to_native(date: str, unix_ms: int) -> int:
    """Translate a request **Cursor** (Unix-ms, ADR-0003) into the native
    HHMMSSmmm encoding the snapshot/trade/broker tables store.

    Out-of-day cursors (a cursor falling on a different Stock-Date than
    ``date``) become HTTP 400 instead of leaking ``timeenc``'s ValueError
    as a 500. ``timeenc`` stays pure (no FastAPI dependency); the HTTP
    mapping lives at this route-handler seam.
    """
    try:
        return unix_ms_to_hhmmssms(date, unix_ms)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _blocked_manifest_stock_date(
    *, code: str, date: str, fail_streak: int
) -> StockDateModel | None:
    if re.fullmatch(CODE_PATTERN, code) is None or re.fullmatch(r"\d{8}", date) is None:
        return None
    try:
        open_ms = hhmmssms_to_unix_ms(date, 90_000_000)
        close_ms = hhmmssms_to_unix_ms(date, 153_000_000)
    except ValueError:
        return None
    return StockDateModel(
        date=date,
        code=code,
        name=code,
        regular_session_open_ms=open_ms,
        regular_session_close_ms=close_ms,
        data_window_first_ms=open_ms,
        data_window_last_ms=close_ms,
        price_min=0,
        price_max=0,
        captured_at=0,
        total_volume=0,
        pages_collected=0,
        file_size_bytes=0,
        today_open=0,
        today_high=0,
        today_low=0,
        today_close=0,
        collection_complete=False,
        is_partial=True,
        disk_state="client_incomplete",
        full_capture_count=None,
        fail_streak=fail_streak,
        blocked=True,
    )


def build_router(engine: QueryEngine) -> APIRouter:  # noqa: PLR0915 — ADR 이 지정한 단일 조립점 — 문장 분할이 설계에 반한다
    router = APIRouter(prefix="/api")

    @router.get("/stock-dates", response_model=list[StockDateModel])
    def stock_dates() -> list[StockDateModel]:
        # ADR-0042: annotate each row with its fail_streak / blocked status.
        # Read the in-memory _fail_streaks dict once (no I/O); model_copy
        # produces a non-cached instance so QueryEngine's mtime-cached
        # StockDate objects keep fail_streak=0 internally.
        from hoga.api import captures  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
        from hoga.api.fail_streak import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
            ATTEMPT_CAP,
            streak_key,
        )
        rows = engine.list_stock_dates()
        if not captures._fail_streaks:
            return rows
        seen = {(row.code, row.date) for row in rows}
        annotated: list[StockDateModel] = []
        for row in rows:
            streak = captures._fail_streaks.get(streak_key(row.code, row.date), 0)
            if streak == 0:
                annotated.append(row)
            else:
                annotated.append(row.model_copy(update={
                    "fail_streak": streak,
                    "blocked": streak >= ATTEMPT_CAP,
                }))
        for key, streak in captures._fail_streaks.items():
            if streak < ATTEMPT_CAP:
                continue
            try:
                code, date = key.split("|", 1)
            except ValueError:
                continue
            if (code, date) in seen:
                continue
            blocked_row = _blocked_manifest_stock_date(
                code=code, date=date, fail_streak=streak
            )
            if blocked_row is not None:
                annotated.append(blocked_row)
        return annotated

    @router.get("/meta", response_model=Meta)
    def meta(code: Code, date: StockDate) -> Meta:
        try:
            m = engine.get_meta(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return Meta(**{k: m[k] for k in Meta.model_fields})

    @router.get("/gaps", response_model=GapRangesResponse)
    def gaps(
        code: Code,
        date: StockDate,
        source: str = Query("hogaplay"),
    ) -> GapRangesResponse:
        """WS1: continuous-trading data-gap boundaries for a Stock-Date source.

        A ``source_partial`` Stock-Date whose collection completed still has
        these gaps → the upstream archive is missing them (re-capture won't
        recover). Only ``hogaplay`` snapshots use HHMMSSmmm ts encoding; other
        sources (live promotions store Unix ms) are rejected 400.
        """
        if source != "hogaplay":
            raise HTTPException(
                status_code=400,
                detail=f"gap analysis only supported for hogaplay, got {source!r}",
            )
        try:
            ranges_hoga, sparse, origin = engine.compute_gap_ranges(date, code, source)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return GapRangesResponse(
            code=code,
            date=date,
            source=source,
            gap_ranges=[
                GapRange(
                    start_ms=hhmmssms_to_unix_ms(date, start),
                    end_ms=hhmmssms_to_unix_ms(date, end),
                )
                for start, end in ranges_hoga
            ],
            sparse=sparse,
            origin=origin,
        )

    @router.get("/orderbook", response_model=OrderbookResponse)
    def orderbook(
        code: Code,
        date: StockDate,
        t: int = Query(...),
        bucket_ms: int | None = Query(None),
        source_pref: str = Query(""),
        # venue 는 **필수**다(ADR-0140) — 기본값은 곧 "빠뜨리면 조용히 KRX" 다.
        venue: str = Query(...),
    ) -> OrderbookResponse:
        # ADR-0044: hover spot path honors source_pref via resolve_source +
        # ADR-0039 preference+fallback semantics. The resolved source is
        # echoed back so LiveStatusBar's chip can reflect fallback honestly.
        # bucket_ms aligns the sidebar's 10호가 view with the candle-close
        # convention used by QuoteTotalsPane (and downsample_candles): for a
        # cursor sitting on candle T's start (= bucket_start), return the last
        # snapshot inside [t, t + bucket_ms) — the same snapshot the indicator
        # labels at t. Without bucket_ms the legacy "latest ≤ t" semantics
        # apply, so the parameter is backward-compatible.
        sd_dir, source = _resolved_parquet_dir(engine, date, code, source_pref, venue)
        if sd_dir is None:
            return OrderbookResponse(available_from=None, snapshot=None, source=source)
        # 디렉터리가 있어도 파일은 없을 수 있다(0행 → 파일 없음, `_spot_table_path`).
        path = _spot_table_path(sd_dir, "snapshots.parquet")
        if path is None:
            return OrderbookResponse(available_from=None, snapshot=None, source=source)
        if bucket_ms is not None:
            try:
                validate_bucket_ms(bucket_ms)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            # The bucket representative is the last *continuous-trading* book in
            # [t, t+bucket_ms), EXCLUDING the closing-auction 3-level book — the
            # same snapshot the 호가비·총잔량 indicator labels at t
            # (query_bucketed_ratio, ADR-0062). Without the structural exclusion a
            # straddle bucket (e.g. 3m [15:18,15:21)) would show the 15:20+ auction
            # book here while the indicator shows the last pre-auction book.
            try:
                session_close_ms = engine.get_meta(date, code, source).get(
                    "regular_session_close_ms"
                )
            except (FileNotFoundError, StockDateNotFound):
                session_close_ms = None
            snap = snapshots_tbl.query_bucket_representative(
                engine.conn,
                path=path,
                lo_native=_cursor_to_native(date, t),
                hi_native=_cursor_to_native(date, t + bucket_ms - 1),
                session_close_ms=session_close_ms,
            )
        else:
            snap = snapshots_tbl.query_at(
                engine.conn, path=path, t_ms=_cursor_to_native(date, t)
            )
        if snap is None:
            first_ts = snapshots_tbl.query_first_ts(engine.conn, path=path)
            available_from = (
                hhmmssms_to_unix_ms(date, first_ts) if first_ts is not None else None
            )
            return OrderbookResponse(available_from=available_from, snapshot=None, source=source)
        snap = snap.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, snap.ts_ms)})
        return OrderbookResponse(available_from=None, snapshot=snap, source=source)

    @router.get("/candles", response_model=CandlesResponse)
    def candles(code: Code, date: StockDate) -> CandlesResponse:
        """캡처된 Stock-Date 의 1분봉 전량.

        **404 는 "미캡처", 빈 200 은 "캡처됐고 캔들 0개"** — 두 층이 다른 사실을
        말한다. 앞 층은 ADR-0051 이 못박은 계약 그대로 `_parquet_path` 가 낸다
        (`/api/meta` 와 함께 스팟 라우트의 200-empty 와 **의도된 비대칭**).

        뒤 층이 이 가드다. 파일 부재는 장애가 아니라 정상 상태이기 때문이다 —
        writer 계약이 **"0행이면 파일을 안 남긴다"** 이고(`live/promote.
        _atomic_write_table`), 그 docstring 이 부재 처리를 리더의 몫으로 넘긴다.

        가드 없이는 **같은 논리 상태가 디스크 모양에 따라 갈렸다**(실측 2026-08-07,
        캔들 0개인 hogaplay Stock-Date): 0행 파일이 남아 있으면 `200 {"candles":[]}`,
        같은 0개인데 파일이 없으면 DuckDB `IOException` 으로 **500**. 응답이 어느
        writer 세대가 그 디렉터리를 만들었는지에 달려 있던 셈이다. 그래서 파일 층을
        404 로 올리지 **않는다** — 그러면 0행이면 200, 없으면 404 라는 새 비대칭이
        같은 자리에 생긴다.

        스팟 라우트 두 개(`/api/orderbook`·`/api/brokers/series`)가 같은 결손에서
        같은 이유로 500 이었고 #1176 이 `_spot_table_path` 로 고쳤다. 그 헬퍼를
        재사용하지 않는 이유는 규약이 다르기 때문이다 — 저쪽은 디렉터리 부재도 빈
        200 이고, 여기는 그게 404 다.
        """
        path = _parquet_path(engine, date, code, "candles.parquet")
        # 디렉터리·meta.json 이 있어도 파케이 파일은 없을 수 있다(0행 → 파일 없음).
        if not path.is_file():
            return CandlesResponse(candles=[])
        # 자정→Unix 보정은 SQL 이 한다(`candles.query_all`) — 파이썬에서 다시 씌우면
        # 같은 행을 두 벌 만든다.
        return CandlesResponse(
            candles=candles_tbl.query_all(
                engine.conn, path=path, ts_offset_ms=ms_from_midnight_to_unix_ms(date, 0),
            ),
        )

    @router.get("/brokers/series", response_model=BrokerSeriesResponse)
    def brokers_series(
        code: Code,
        date: StockDate,
        source_pref: str = Query(""),
        # venue 는 **필수**다(ADR-0140) — 기본값은 곧 "빠뜨리면 조용히 KRX" 다.
        venue: str = Query(...),
    ) -> BrokerSeriesResponse:
        # ADR-0044: hover spot path honors source_pref via resolve_source +
        # ADR-0039 preference+fallback semantics. The resolved source is
        # echoed back so LiveStatusBar's chip can reflect fallback honestly.
        sd_dir, source = _resolved_parquet_dir(engine, date, code, source_pref, venue)
        if sd_dir is None:
            return BrokerSeriesResponse(date=date, brokers=[], source=source)
        # 디렉터리가 있어도 파일은 없을 수 있다(0행 → 파일 없음, `_spot_table_path`).
        # 장 초반 거래원 첫 스냅샷 전이 그 창이다 — 결함이 아니라 빈 사이드바다.
        path = _spot_table_path(sd_dir, "brokers.parquet")
        if path is None:
            return BrokerSeriesResponse(date=date, brokers=[], source=source)
        raw_entries = brokers_tbl.query_day_series_cached(engine.conn, path=path)
        # Convert each point's ts_ms from HH:MM:SS.ms-encoded to Unix ms,
        # mirroring the /api/brokers and /api/candles handlers.
        entries = [
            e.model_copy(
                update={
                    "points": [
                        p.model_copy(
                            update={"ts_ms": hhmmssms_to_unix_ms(date, p.ts_ms)}
                        )
                        for p in e.points
                    ],
                }
            )
            for e in raw_entries
        ]
        return BrokerSeriesResponse(date=date, brokers=entries, source=source)

    # 이 라우터(=이 앱 인스턴스)의 `/api/range` compute 상한. 모듈 전역이 아니라
    # 클로저에 두는 이유는 테스트 격리다 — 앱을 새로 만들면 상한도 새것이라, 어느
    # 테스트가 permit 을 흘려도 다음 테스트로 번지지 않는다.
    #
    # `anyio.CapacityLimiter` 는 **생성 시점에 이벤트 루프를 붙잡지 않는다**(실측:
    # 루프 밖에서 만들어 서로 다른 `asyncio.run` 두 번에서 재사용 가능). 팩토리는
    # uvicorn 루프가 뜨기 전에 돌고 `TestClient` 는 인스턴스마다 루프를 만드므로,
    # 이 성질이 없으면 여기 두는 것 자체가 성립하지 않는다.
    range_compute_limiter = anyio.CapacityLimiter(RANGE_COMPUTE_CONCURRENCY)

    @router.get("/range", response_model=RangeBundle)
    async def api_range(
        code: Code,
        from_date: str = Query(..., alias="from"),
        to_date: str = Query(..., alias="to"),
        bucket_ms: int = Query(...),
        source_pref: str = Query(""),
        # venue 는 **필수**다(ADR-0140). 기본값을 주면 호출자가 빠뜨렸을 때 조용히
        # KRX 를 읽고, 그게 곧 "실시간 꼬리는 NXT 인데 과거 본체는 KRX" 인 섞인
        # 차트다 — 이 한 라우트가 매물대·최대벽·프로그램·depth 히트맵·잔량 증감·
        # 거래원 늦은 진입 **지표 6~7개**의 과거 시계열을 실어 나른다.
        venue: str = Query(...),
        broker_late_entries_enabled: bool = Query(True),
        broker_late_entry_start_hhmm: int = Query(930),
        volume_distribution_bins: int | None = Query(None, ge=5, le=30),
        volume_distribution_price_min: int | None = Query(None, ge=0),
        volume_distribution_price_max: int | None = Query(None, ge=0),
        volume_distribution_cutoff_ms: int | None = Query(None, ge=0),
        trade_volume_poc_bins: int | None = Query(None, ge=5, le=30),
        ask_peaks_enabled: bool = Query(True),
        bid_peaks_enabled: bool = Query(True),
        program_trade_enabled: bool = Query(True),
        trade_volume_poc_enabled: bool = Query(True),
        depth_heatmap_enabled: bool = Query(True),
        depth_delta_enabled: bool = Query(True),
        mode: str = Query(..., pattern="^(hoga|sidecar|candles)$"),
    ) -> RangeBundle:
        try:
            validate_bucket_ms(bucket_ms)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        if (volume_distribution_price_min is None) != (volume_distribution_price_max is None):
            raise HTTPException(400, "volume_distribution_price_min/max must be supplied together")
        if (
            volume_distribution_price_min is not None
            and volume_distribution_price_max is not None
            and volume_distribution_price_max < volume_distribution_price_min
        ):
            raise HTTPException(400, "volume_distribution_price_max < volume_distribution_price_min")
        if volume_distribution_cutoff_ms is not None:
            if mode != "sidecar":
                raise HTTPException(
                    400,
                    "volume_distribution_cutoff_ms requires mode=sidecar",
                )
            if from_date != to_date:
                raise HTTPException(
                    400,
                    "volume_distribution_cutoff_ms requires a single Stock-Date range",
                )
            _cursor_to_native(from_date, volume_distribution_cutoff_ms)
        hh = broker_late_entry_start_hhmm // 100
        mm = broker_late_entry_start_hhmm % 100
        if hh < 9 or hh > 15 or mm < 0 or mm > 59 or (hh == 15 and mm > 20):  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            raise HTTPException(
                400,
                "broker_late_entry_start_hhmm must be between 900 and 1520",
            )
        # 위 검증(400)은 **상한 밖**이다 — 잘못된 요청이 큐를 기다릴 이유가 없고,
        # 기다리면 그 자리만큼 정상 요청이 밀린다.
        t0 = perf_debug.now()
        # 넓은 요청만 줄을 선다(상수 주석의 실측표 참조). 좁은 요청까지 같은 큐에
        # 넣으면 하루짜리가 5개월짜리 뒤에 갇혀 **중앙값이 7배 나빠진다.**
        gate: AbstractAsyncContextManager[object] = (
            range_compute_limiter
            if _is_wide_range(from_date, to_date)
            else contextlib.nullcontext()
        )
        # 대기는 **이벤트 루프에서** 한다. 이 라우트가 `async def` 인 것이 그 조건이다:
        # 동기 `def` 였다면 FastAPI 가 요청마다 스레드풀 스레드를 잡은 뒤 그 스레드
        # 위에서 상한을 기다려, 대기자들이 40 토큰짜리 공용 풀을 채우고 **다른 동기
        # 라우트까지 굶긴다**(/api/live/status 폴링 등이 같은 풀을 쓴다). 이제 스레드를
        # 쥐는 것은 실제로 계산 중인 `RANGE_COMPUTE_CONCURRENCY` 개뿐이다.
        async with gate:
            queue_wait_ms = perf_debug.elapsed_ms(t0)
            if queue_wait_ms >= RANGE_QUEUE_WAIT_LOG_MS:
                # perf_debug 게이트를 걸지 않는다 — 이 줄이 없으면 slow-log 의
                # duration 이 왜 큰지 알 길이 없고, 그건 조사자를 계산 최적화로
                # 잘못 보낸다(상수 주석 참조).
                log.warning(
                    "hoga_perf api_range status=queued code=%s from=%s to=%s mode=%s "
                    "queue_wait_ms=%.1f limit=%d",
                    code, from_date, to_date, mode, queue_wait_ms,
                    RANGE_COMPUTE_CONCURRENCY,
                )
            t_compute = perf_debug.now()
            try:
                bundle = await anyio.to_thread.run_sync(
                    functools.partial(
                        build_range_bundle,
                        engine,
                        code=code,
                        from_date=from_date,
                        to_date=to_date,
                        bucket_ms=bucket_ms,
                        source_pref=source_pref,
                        venue=venue,
                        broker_late_entries_enabled=broker_late_entries_enabled,
                        broker_late_entry_start_hhmm=broker_late_entry_start_hhmm,
                        volume_distribution_bins=volume_distribution_bins,
                        volume_distribution_price_min=volume_distribution_price_min,
                        volume_distribution_price_max=volume_distribution_price_max,
                        volume_distribution_cutoff_ms=volume_distribution_cutoff_ms,
                        trade_volume_poc_bins=trade_volume_poc_bins,
                        ask_peaks_enabled=ask_peaks_enabled,
                        bid_peaks_enabled=bid_peaks_enabled,
                        program_trade_enabled=program_trade_enabled,
                        trade_volume_poc_enabled=trade_volume_poc_enabled,
                        depth_heatmap_enabled=depth_heatmap_enabled,
                        depth_delta_enabled=depth_delta_enabled,
                        mode=mode,
                    ),
                )
            except Exception:
                # NOT gated on perf_debug. The success log below is performance
                # instrumentation and belongs behind the flag; a failure is a
                # defect report and must survive the default configuration.
                # Gating both meant the traceback for a 500 existed only when a
                # developer had already suspected this endpoint and restarted with
                # HOGA_PERF_DEBUG set — i.e. the log was absent exactly when it
                # was needed. ADR-0120 records four days lost to this failure class.
                #
                # duration_ms 는 예전처럼 **요청 전체**(큐 대기 포함)이고,
                # compute_ms 가 실제 계산이다. 둘을 나눠 두지 않으면 상한을 건 뒤의
                # 느린 요청이 계산 결함처럼 읽힌다.
                log.exception(
                    "hoga_perf api_range status=error code=%s from=%s to=%s bucket_ms=%s "
                    "mode=%s source_pref=%s duration_ms=%.1f queue_wait_ms=%.1f compute_ms=%.1f",
                    code, from_date, to_date, bucket_ms, mode, source_pref,
                    perf_debug.elapsed_ms(t0), queue_wait_ms,
                    perf_debug.elapsed_ms(t_compute),
                )
                raise
        if perf_debug.enabled():
            log.warning(
                "hoga_perf api_range status=ok code=%s from=%s to=%s bucket_ms=%s "
                "mode=%s source_pref=%s segments=%d candles=%d quote_ratio=%d "
                "fill_strength=%d excluded=%d warnings=%d duration_ms=%.1f "
                "queue_wait_ms=%.1f compute_ms=%.1f",
                code,
                from_date,
                to_date,
                bucket_ms,
                mode,
                source_pref,
                len(bundle.segments),
                len(bundle.candles),
                len(bundle.quote_ratio.points),
                len(bundle.fill_strength.points),
                len(bundle.excluded_dates),
                len(bundle.data_warnings),
                perf_debug.elapsed_ms(t0),
                queue_wait_ms,
                perf_debug.elapsed_ms(t_compute),
            )
        return bundle

    return router
