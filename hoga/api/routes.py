"""FastAPI route handlers. Each per-table handler delegates to the table
module's ``query_*`` function, which returns Pydantic models directly.
This file is the thin glue layer.
"""

from __future__ import annotations

import contextlib
import functools
import json
import logging
import os
import re
from contextlib import AbstractAsyncContextManager
from datetime import datetime
from pathlib import Path

import anyio
import anyio.to_thread
from fastapi import APIRouter, HTTPException, Query, Request, Response
from starlette.requests import ClientDisconnect

from hoga import perf_debug
from hoga.api import compute_jobs
from hoga.api.bundle import build_range_bundle
from hoga.api.compute_pools import ComputePools, thread_pools
from hoga.api.invariants import indicator_session_bounds
from hoga.api.models import (
    BrokerSeriesResponse,
    CandlesResponse,
    GapRange,
    GapRangesResponse,
    Meta,
    OrderbookResponse,
    RangeBundle,
    RangeMode,
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

# `/api/range` 의 **넓은 구간** 동시 compute 상한 — 지금 이 레인에 남은 모드는 **hoga
# 하나뿐이다**(sidecar 는 v3.4, candles 는 v3.5 에서 자기 레인으로 나갔다). 이름이
# "compute" 로 남은 것은 이력 때문이고, 마지막 모드까지 나가면 이 상수는 사라진다.
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
# 실제 이득이다(실서버 HTTP · GC 튜닝 적용 후 · 3회 median):
#
#     상한      wall   가벼운것 중앙   무거운것 중앙   전체 평균
#     무제한   1.46s        0.30s        1.33s      0.56s
#     1        1.57s        0.14s        1.06s      0.38s
#     2        1.32s        0.14s        0.98s      0.34s   ← 채택
#     4        1.44s        0.20s        1.16s      0.42s
#
# ⚠ **이 값은 지금까지 두 번 움직였다 — 상한은 compute 비용의 함수다.**
#   · `model_copy` 로 행을 두 벌 만들던 시절: **2** (compute 가 지금의 2배)
#   · `ts_ms` 보정을 SQL 로 민 뒤(0.63s → 0.29s): **1** — 대기가 싸져 GIL 경합을
#     아예 피하는 쪽이 이겼다
#   · GC gen0 임계를 올린 뒤(ADR-0085 v3.3): 다시 **2** — GC 오버헤드가 빠지자
#     동시 실행의 손해가 줄어 병렬 이득이 살아났다(3회 모두 2가 우세)
#
# 이 경로의 비용을 또 바꾸면 **반드시 이 sweep 을 다시 돌려라.** 성능 개선과 큐
# 정책은 독립이 아니다.
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
RANGE_COMPUTE_CONCURRENCY = int(os.environ.get("HOGA_RANGE_CONCURRENCY", "") or 2)

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

# `mode=sidecar` 의 레인. 위 무게 분리(일수)에 **모드 축**을 더한 것이다(ADR-0085 v3.4).
#
# 왜 sidecar 만 다른가: 6-스레드 팽창이 모드마다 다르다 — candles **6.7×** · hoga 6~8×
# 인데 sidecar 는 **3.8×** 로 **부선형**이다(팽창/N < 1). peak 이 polars 라 그 구간에서
# GIL 을 놓기 때문이고, 즉 sidecar 끼리는 동시성이 **실제 이득**이다. 그런 요청을
# candles 와 같은 줄에 세우면 이득을 버리면서 서로를 막는다.
#
# ⚠ **그렇다고 상한을 푸는 것이 아니다 — 측정이 그쪽을 기각했다.** 부선형인 것은
# sidecar **끼리**일 때고, peak 밖(depth 히트맵 · 1~2MB 응답 생성)은 여전히 파이썬이다.
# 혼합 부하 22 동시(저장뷰 4개분 12 + 하루짜리 10), 교대 대조 4라운드 median:
#
#     변형        wall  뷰완성  h:hoga  h:sidecar  h:candles  l:hoga  l:sidecar  평균
#     공유(현행)  9.35   8.27    6.16     7.06       8.24     0.144    0.277    3.72
#     레인 2      8.46   7.73    4.96     6.19       6.81     0.163    0.233    3.26  ← 채택
#     레인 4      8.95   8.69    6.45     4.75       8.65     0.239    0.317    3.54
#
# ("뷰완성" = 저장뷰 하나의 3모드 중 **가장 느린 것** — `isLoading` 이 OR 라 화면은
#  그때 뜬다. 사용자가 실제로 기다리는 값이고, 클래스별 중앙값으로는 안 보인다.)
#
# **레인 4는 재분배다**: sidecar 를 -33% 얻는 대신 뷰완성 +5% · candles +5% ·
# 가벼운 hoga **+66%** 를 잃는다 — 레인을 넓게 열수록 그쪽이 제한 레인의 candles/hoga
# 와 GIL 을 나눠 갉아먹는다. v3 이 "상한을 모두에게 걸면 손해" 라고 적은 것의 거울상이다.
# **레인 2는 실제 이득**: 가벼운 hoga 만 +14%(절대 **+19ms**, 노이즈 범위) 나빠지고
# 나머지 전 열이 7~19% 개선된다.
#
# ⚠ **단발 sweep 은 이 결론을 뒤집었다.** 3-trial 1회에서는 레인 4가 최선으로 보였고
# (wall 8.30 · 평균 3.165), 교대 대조로 다시 재자 뒤집혔다. 변형 간 차이가 머신 부하
# 드리프트와 같은 크기라 **번갈아 돌리지 않으면 순서가 곧 결과**다.
#
# 값의 의미(sweep 을 서버 재시작만으로 돌리기 위한 노브 — `HOGA_RANGE_CONCURRENCY` 와
# 같은 자리에 둔다):
#   -1 = 공유 레인 (모드 분리 이전 동작)
#    0 = 상한 없음
#   N>0 = 전용 레인 N
#
# 채택값이 공유 상한과 **같은 2**인 것은 우연이 아니다 — 이득의 정체는 "sidecar 를 더
# 돌린다" 가 아니라 **"서로를 막지 않는다"** 다. 두 상수를 한 값으로 합치지 말 것:
# 근거가 다르고(이쪽은 모드 팽창률, 저쪽은 GIL 직렬화) 다음 재측정에서 갈릴 값이다.
#
# ⚠ **peak prefetch(요청 내부 병렬) 도입 후 재측정했다 — 2를 유지한다 (2026-08-29).**
# 그 변경은 실효 스레드를 `상한 × 워커`로 만들어 위 sweep 의 전제(요청당 1 스레드)를
# 깼으므로, 위 명령대로 다시 돌렸다. 혼합 부하 16 동시(콜드 sidecar 4 + hoga 12),
# 교대 대조 2라운드 median:
#
#     상한   wall   heavy중앙  light중앙  전체평균
#     1     15.88s   15.60s     2.40s     5.17s
#     2     15.91s   15.62s     2.47s     5.24s   ← 유지
#     4     16.13s   15.59s     2.50s     5.34s
#
# 세 값의 차이가 wall 1.6% · heavy 0.2% 로 **라운드 간 드리프트(0.6~1.4s)보다 작다** —
# 즉 이 부하에서 상한은 판별력이 없고, 바꿀 근거가 없다는 뜻이지 "1이 최선" 이라는
# 뜻이 아니다. prefetch 워커 쪽 표와 그 판단은 `bundle._PEAK_PREFETCH_WORKERS_ENV`
# 주석에 있다(그쪽은 heavy↔light 재분배가 실제로 보인다).
RANGE_SIDECAR_CONCURRENCY = int(os.environ.get("HOGA_RANGE_SIDECAR_CONCURRENCY", "") or 2)

# `mode=candles` 의 레인. 값 규약은 위 sidecar 노브와 같다(-1 공유 · 0 무제한 · N 레인).
#
# 가르는 근거가 sidecar 와 다르다. sidecar 는 부선형이라 **동시성 이득**을 살리려 갈랐고,
# candles 는 v3.4 가 남긴 **뷰완성 지배자**여서 갈랐다 — 저장뷰 화면은 3모드가 다 와야
# 뜨는데(`isLoading` 이 OR) 그 마지막이 늘 candles 였다.
#
# ⚠ **"가장 초선형이니 레인은 좁을수록 좋다" 는 측정으로 반증됐다.** 그렇게 예상하고
# 레인 1부터 쟀는데 candles 가 오히려 느려졌다(7.11 → 7.46). 초선형은 **총 wall** 의
# 성질이지 **개별 요청 지연**의 성질이 아니다 — 레인 1은 4건을 직렬화해 마지막의 대기가
# 누적되고, 그 누적이 초선형 페널티보다 크다. 사용자가 기다리는 것은 총 wall 이 아니라
# 자기 요청이므로 이쪽이 이긴다. 혼합 22 동시 · 전부 warm · 교대 대조 3라운드 median:
#
#     변형        wall  뷰완성  h:hoga  h:sidecar  h:candles  l:hoga  평균
#     공유(v3.4)  9.54   8.56    5.47     7.10       7.32    0.230   3.65
#     레인 1      9.61   8.42    2.06     7.36       7.46    0.240   3.18  ← 더 느려졌다
#     레인 2     10.03   7.93    2.19     7.89       4.82    0.277   3.07
#     **레인 3**  9.84   7.85    2.29     7.79       2.88    0.269   2.83  ← 채택
#     레인 4      9.77   7.88    2.26     7.88       2.69    0.197   2.45
#
# **레인 3에서 꺾인다** — 4로 넓혀도 뷰완성이 안 움직인다(7.85 ↔ 7.88, 노이즈).
# 병목이 이미 sidecar 로 옮겨갔기 때문이다: 채택 변형의 뷰완성 7.85 는 `h:sidecar`
# 7.79 와 같은 값이다. **candles 를 더 여는 것은 이제 이득이 없고 GIL 만 더 나눈다.**
#
# ⚠ **공짜가 아니다.** wall +3% · `h:sidecar` +10% 는 일관되게 악화된다(병목 이동의
# 대가). 그래도 랜딩하는 근거는 **뷰완성 -8%** 와 전체 평균 -23% 다 — wall 은 "마지막
# 요청까지" 라 사용자가 기다리는 값이 아니다. light 열은 라운드마다 부호가 뒤집혀
# (-14% ↔ +17%) 노이즈로 판정했다.
RANGE_CANDLES_CONCURRENCY = int(os.environ.get("HOGA_RANGE_CANDLES_CONCURRENCY", "") or 3)

# 상한 대기가 이 값을 넘으면 로그에 남긴다. 대기는 TTFB 에 그대로 포함되므로
# (`request_timing`), 이 값이 없으면 다음 조사자가 **큐 대기를 계산 시간으로 읽는다**
# — 이 세션이 정확히 그 오독을 한 번 하고 나서 프로브로 갈랐다.
RANGE_QUEUE_WAIT_LOG_MS = 1000.0

# nginx 관례의 "클라이언트가 먼저 끊었다". 표준 코드는 아니지만 이 상황에 2xx/4xx 를
# 주면 로그에서 정상 응답과 구별되지 않는다 — 받을 사람이 이미 없으므로 값의 유일한
# 소비자는 로그와 메트릭이다.
HTTP_CLIENT_CLOSED_REQUEST = 499


async def _drain_request_stream(request: Request) -> bool:
    """요청 본문을 비운다. 그 사이 클라이언트가 떠났으면 True.

    ⚠ **이 호출이 없으면 아래 `is_disconnected()` 가 조용히 무력화된다.**
    starlette 의 `Request.is_disconnected()` 는 **호출당 receive 메시지 하나**만 읽고
    그것이 `http.disconnect` 인지 본다. 그런데 uvicorn 은 body 가 없는 GET 에도 빈
    `http.request` 를 한 번 보내므로, 큐를 미리 비워 두지 않으면 첫 호출이 그것을
    소비하고 **False** 를 돌려준다 — 바로 뒤에 있는 `http.disconnect` 는 못 본 채로.
    실패 방식이 "감지 못 함" 이라 **증상이 없다**: 이탈 요청이 그냥 예전처럼 끝까지
    계산될 뿐이고 로그에도 흔적이 없다. 그래서 receive 큐 순서를 그대로 재현하는
    테스트를 붙여 뒀다(`test_range_client_disconnect.py`) — 그 테스트는 이 호출을
    지우면 빨개진다.

    GET 이라 즉시 끝나고, `body()` 는 결과를 캐시하므로 중복 호출도 안전하다.
    """
    try:
        await request.body()
    except ClientDisconnect:
        return True
    return False


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


def compute_stock_dates(
    engine: QueryEngine, fail_streaks: dict[str, int],
) -> list[StockDateModel]:
    """`/api/stock-dates` 본체 — 라우트에서 떼어 **모듈 최상위**에 둔 이유는 컴퓨트
    워커 프로세스에서 돌리기 위해서다(ADR-0169, `compute_jobs.stock_dates_job`).

    ADR-0042: annotate each row with its fail_streak / blocked status.
    `fail_streaks` 는 캡처 파이프라인의 인프로세스 dict 스냅샷이다(호출자가 뜬다) —
    `model_copy` 로 새 인스턴스를 만들어 QueryEngine 의 mtime 캐시에 든 StockDate 는
    `fail_streak=0` 인 채로 둔다.
    """
    from hoga.api.fail_streak import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
        ATTEMPT_CAP,
        streak_key,
    )
    rows = engine.list_stock_dates()
    if not fail_streaks:
        return rows
    seen = {(row.code, row.date) for row in rows}
    annotated: list[StockDateModel] = []
    for row in rows:
        streak = fail_streaks.get(streak_key(row.code, row.date), 0)
        if streak == 0:
            annotated.append(row)
        else:
            annotated.append(row.model_copy(update={
                "fail_streak": streak,
                "blocked": streak >= ATTEMPT_CAP,
            }))
    for key, streak in fail_streaks.items():
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


def compute_brokers_series(
    engine: QueryEngine, *, code: str, date: str, source_pref: str, venue: str,
) -> BrokerSeriesResponse:
    """`/api/brokers/series` 본체 — 라우트에서 떼어 **모듈 최상위**에 둔 이유는 컴퓨트
    워커 프로세스에서 돌리기 위해서다(ADR-0169, `compute_jobs.brokers_series_job`).

    ADR-0044: hover spot path honors source_pref via resolve_source + ADR-0039
    preference+fallback semantics. The resolved source is echoed back so
    LiveStatusBar's chip can reflect fallback honestly.
    """
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


async def _run_range_bundle(
    pools: ComputePools,
    engine: QueryEngine,
    bundle_kwargs: dict[str, object],
    *,
    from_date: str,
    to_date: str,
) -> tuple[RangeBundle | None, bytes | None, dict[str, int]]:
    """`/api/range` 의 계산 자리(ADR-0169). 반환은 (번들, 응답 바이트, perf 개수) —
    둘 중 하나만 채워진다.

    프로세스 풀이면 워커가 번들을 만들고 **JSON 까지 직렬화**해 바이트로 돌려준다 —
    루프 스레드에 남는 일은 `Response` 에 싣는 것뿐이다(부모에서 pydantic 을 다시
    직렬화하면 그 `dump_json` 이 루프를 세운다 — 2026-09-02 로그에 25건). 넓은 요청과
    좁은 요청은 다른 풀이라 `/live` 의 하루짜리가 `/study` 의 다섯 달 뒤에 안 선다
    (`_range_gate` 의 불변식과 같은 이유).

    스레드 모드(테스트)는 종전 경로 그대로다 — `build_range_bundle` 을 **이 모듈 이름으로**
    부르는 것이 기존 테스트들의 monkeypatch 이음새다.
    """
    if pools.kind == "thread":
        bundle = await anyio.to_thread.run_sync(
            functools.partial(build_range_bundle, engine, **bundle_kwargs),
        )
        return bundle, None, compute_jobs.range_bundle_stats(bundle)
    pool = pools.wide if _is_wide_range(from_date, to_date) else pools.narrow
    payload, stats = await compute_jobs.run_job(
        pool, compute_jobs.range_bundle_job, str(engine.data_dir), bundle_kwargs,
    )
    return None, payload, stats


def build_router(  # noqa: PLR0915 — ADR 이 지정한 단일 조립점 — 문장 분할이 설계에 반한다
    engine: QueryEngine, *, compute: ComputePools | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api")
    # 요청 경로 CPU 작업이 도는 자리(ADR-0169). 안 넘기면 스레드 두 벌 — 종전 동작.
    pools: ComputePools = compute if compute is not None else thread_pools()

    @router.get("/stock-dates", response_model=list[StockDateModel])
    async def stock_dates() -> list[StockDateModel]:
        # 본체는 `compute_stock_dates`(모듈 최상위) — 컴퓨트 워커에서 돈다(ADR-0169).
        # 파케이 트리 순회 + 캐시 미스분 DuckDB 읽기라 콜드에서 40초를 넘겼고
        # (2026-09-04 실측 41.3초) 그동안 동기 라우트 스레드가 앱 전체를 세웠다.
        # `_fail_streaks` 는 인프로세스 상태라 **부모가 스냅샷을 떠서** 넘긴다.
        from hoga.api import captures  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

        payload = await compute_jobs.run_job(
            pools.wide, compute_jobs.stock_dates_job,
            str(engine.data_dir), dict(captures._fail_streaks),
        )
        return Response(content=payload, media_type="application/json")  # type: ignore[return-value]

    @router.get("/meta", response_model=Meta)
    def meta(code: Code, date: StockDate) -> Meta:
        # venue 를 안 넘기는 것이 맞다 — 이 표면엔 venue 축이 **없다**(#1133).
        # 근거가 두 겹이다: ① 라우트에 venue 파라미터가 없고, 응답 `Meta` 도 venue 별로
        # 갈리는 필드를 싣지 않는다(`regular_session_close_ms` 는 세 venue 가 같은 값이고
        # `indicator_session_*`(KRX 09:00~15:30 vs NXT/UN 08:00~20:00)는 애초에 노출하지
        # 않는다). ② **source 도 축이 아니다** — 이 라우트는 `get_meta` 의 기본
        # source(`hogaplay`)로 고정이고, hogaplay 는 **KRX 전용 source** 다
        # (`source_covers_venue`). 그래서 KRX 는 폴백이 아니라 **사실**이다.
        # ⚠ 여기서 `venue="KRX"` 를 명시하지 말 것 — 명시는 "선택이 있다" 는 뜻이라
        # 축 없는 표면에 축이 있는 것처럼 읽힌다. 이 라우트가 venue 선택을 받게
        # 되는 날, 그때 명시가 **필수**가 된다.
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
        # `compute_gap_ranges` 에 venue 를 안 넘겨 기본값 KRX 를 쓰는 것이 맞다 —
        # 이 표면의 venue 축은 **두 단계로 이미 닫혀 있다**(#1133): ① 바로 위 가드가
        # `source != "hogaplay"` 를 400 으로 거부하고, ② hogaplay 는 KRX 전용
        # source 다(`source_covers_venue`). 그래서 KRX 는 폴백이 아니라 **사실**이다.
        #
        # 이 경로가 venue 별로 갈리는 필드를 **실제로 읽는다**는 점은 짚어 둔다 —
        # legacy meta 재계산 분기가 `indicator_session_bounds()` 를 탄다(queries.py).
        # 그래도 값이 갈리지 않는 이유는 우연이 아니다: hogaplay meta 에는
        # `indicator_session_*` 키가 **없어서** 그 헬퍼가 `regular_session_*` 로
        # 폴백한다(하위호환 계약). venue 를 넘겨도 글자 그대로 같은 값이 나온다.
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
            # 마감 시각은 **venue 별 지표 구간**에서 온다. `regular_session_close_ms`
            # 는 venue 와 무관하게 KRX 정규장(15:30)이고(promote 가 의도적으로 그렇게
            # 싣는다), 그걸 쓰면 08:00–20:00 을 도는 NXT·UN 의 시간외 book 이 통째로
            # 잘린다 — 캔들은 있는데 10호가 창만 비는 증상이었다(실측 2026-08-14,
            # 000720 16:00). 지표·일별 최대벽 경로는 이미 이 헬퍼로 옮겨 왔고
            # (`depth_daily`·`compute_gap_ranges`), 이 라우트만 남아 있었다.
            #
            # meta 는 **실제로 읽는 그 디렉터리**의 것을 본다 — venue 해석은
            # `_resolved_parquet_dir` 가 이미 했으므로 여기서 다시 하면 두 벌이 갈린다
            # (`engine.get_meta` 는 venue 기본값이 KRX 라 UN 강등을 못 따라간다).
            try:
                _, session_close_ms = indicator_session_bounds(
                    json.loads((sd_dir / "meta.json").read_text(encoding="utf-8"))
                )
            except (OSError, json.JSONDecodeError, KeyError):
                # 경계 키가 아예 없는 meta — 시간 임계 없이 **깊이 조건만** 남긴다.
                # 종가 동시호가는 3 단 book 이라 깊이에서 걸리므로(ADR-0062) 이 폴백이
                # 그걸 새게 하지는 않는다(corpus 23,913 조합 실측 누출 0).
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
    async def brokers_series(
        code: Code,
        date: StockDate,
        source_pref: str = Query(""),
        # venue 는 **필수**다(ADR-0140) — 기본값은 곧 "빠뜨리면 조용히 KRX" 다.
        venue: str = Query(...),
    ) -> BrokerSeriesResponse | Response:
        # 본체는 `compute_brokers_series`(모듈 최상위). 큰 날은 포인트마다 `model_copy`
        # 를 도는 순수 파이썬이 10초를 넘겨(실측 10.3초) 동기 라우트 스레드에서 앱 전체를
        # 세웠다 — 컴퓨트 워커(ADR-0169)에서 돌리고 워커가 직렬화한 JSON 을 그대로 싣는다.
        # body 는 `BrokerSeriesResponse.model_dump_json` 이라 wire 계약은 모델 그대로다.
        payload = await compute_jobs.run_job(
            pools.wide, compute_jobs.brokers_series_job,
            str(engine.data_dir), code, date, source_pref, venue,
        )
        return Response(content=payload, media_type="application/json")

    # 이 라우터(=이 앱 인스턴스)의 `/api/range` compute 상한. 모듈 전역이 아니라
    # 클로저에 두는 이유는 테스트 격리다 — 앱을 새로 만들면 상한도 새것이라, 어느
    # 테스트가 permit 을 흘려도 다음 테스트로 번지지 않는다.
    #
    # `anyio.CapacityLimiter` 는 **생성 시점에 이벤트 루프를 붙잡지 않는다**(실측:
    # 루프 밖에서 만들어 서로 다른 `asyncio.run` 두 번에서 재사용 가능). 팩토리는
    # uvicorn 루프가 뜨기 전에 돌고 `TestClient` 는 인스턴스마다 루프를 만드므로,
    # 이 성질이 없으면 여기 두는 것 자체가 성립하지 않는다.
    range_compute_limiter = anyio.CapacityLimiter(RANGE_COMPUTE_CONCURRENCY)

    def _dedicated_lane(limit: int) -> AbstractAsyncContextManager[object] | None:
        """전용 레인 하나. `None` = 이 모드는 공유 레인을 쓴다.

        값 규약은 상수 주석과 같다: `-1` 공유 · `0` 무제한 · `N>0` 레인 N.
        `nullcontext` 는 상태가 없어 여러 요청이 같은 인스턴스를 써도 안전하다.
        """
        if limit == 0:
            return contextlib.nullcontext()
        if limit > 0:
            return anyio.CapacityLimiter(limit)
        return None

    # 모드 → 전용 레인 **표**. if 사다리로 두지 않는 이유: 모드가 셋인데 이미 둘을
    # 갈랐고, 남은 hoga 를 가르는 날 사다리는 분기가 또 늘지만 표는 줄이 하나 는다.
    mode_lanes = {
        mode: lane
        for mode, limit in (
            ("sidecar", RANGE_SIDECAR_CONCURRENCY),
            ("candles", RANGE_CANDLES_CONCURRENCY),
        )
        if (lane := _dedicated_lane(limit)) is not None
    }
    lane_limits = {
        "sidecar": RANGE_SIDECAR_CONCURRENCY,
        "candles": RANGE_CANDLES_CONCURRENCY,
    }

    def _range_gate(mode: str, from_date: str, to_date: str) -> tuple[
        AbstractAsyncContextManager[object], str,
    ]:
        """이 요청이 설 줄과 그 이름. 이름은 `queue_wait` 로그에 실린다.

        좁은 요청은 **모드와 무관하게** 그냥 지나간다 — 모드 분리는 넓은 요청 안에서
        무게를 다시 가르는 것이지, 일수 분리를 대체하는 것이 아니다. `/live` 의
        하루짜리 sidecar 가 `/study` 5개월 sidecar 뒤에 갇히면 안 되는 것은 그대로다.
        """
        if not _is_wide_range(from_date, to_date):
            return contextlib.nullcontext(), "none"
        lane = mode_lanes.get(mode)
        if lane is not None:
            return lane, mode
        return range_compute_limiter, "shared"

    @router.get("/range", response_model=RangeBundle)
    async def api_range(
        request: Request,
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
        # 값 목록은 `RangeMode`(models.py)가 유일 출처다 — 여기 정규식을 손으로 다시
        # 적으면 그 사본이 곧 드리프트 지점이 된다(퇴역한 `full` 이 프론트에 남은 것이
        # 정확히 그 사고였다).
        mode: RangeMode = Query(...),
    ) -> RangeBundle:
        # 반환 애노테이션은 모델 그대로 둔다 — wire 계약(ADR-0004)의 표면이고, 슬라이스
        # 레지스트리 계약 테스트가 `-> RangeBundle:` 까지를 시그니처로 자른다. 프로세스
        # 모드에선 워커가 그 모델을 직렬화한 바이트를 `Response` 로 그대로 싣는다.
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
        #
        # 줄을 서기 **전에** 요청 스트림을 비운다 — 이유는 `_drain_request_stream`.
        client_gone = await _drain_request_stream(request)
        t0 = perf_debug.now()
        # 넓은 요청만 줄을 선다(상수 주석의 실측표 참조). 좁은 요청까지 같은 큐에
        # 넣으면 하루짜리가 5개월짜리 뒤에 갇혀 **중앙값이 7배 나빠진다.**
        # 그 안에서 sidecar 는 자기 레인을 쓴다 — `RANGE_SIDECAR_CONCURRENCY`.
        gate: AbstractAsyncContextManager[object]
        gate, lane = _range_gate(mode, from_date, to_date)
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
                    "lane=%s queue_wait_ms=%.1f limit=%d",
                    code, from_date, to_date, mode, lane, queue_wait_ms,
                    lane_limits.get(lane, RANGE_COMPUTE_CONCURRENCY),
                )
            # 기다리는 동안 화면이 이 요청을 버렸을 수 있다 — `/study` 저장뷰에서는
            # 흔하다(봉·지표를 바꾸면 react-query 가 in-flight 를 abort 한다). 그런
            # 요청을 그대로 계산하면 **아무도 안 읽을 결과**를 만드는 데 permit 하나를
            # 수 분간 쓰고, 그만큼 살아 있는 요청이 밀린다. 실측(2026-08-11): 저장뷰
            # 하나에 같은 URL 이 최대 4벌 완주했고 뒤의 요청은 큐에서 180초를 기다렸다.
            #
            # ⚠ **이미 계산에 들어간 요청은 여기서 못 살린다.** `to_thread.run_sync` 는
            # 취소되지 않으므로 스레드가 끝나야 permit 이 풀린다. 그렇다고 permit 만
            # 먼저 반납하면 **더 나빠진다** — 스레드는 계속 GIL 을 먹는데 대기자까지
            # 들어와 동시 계산이 상한을 넘는다. 그래서 처방은 "취소" 가 아니라
            # **"시작하지 않기"** 다.
            if client_gone or await request.is_disconnected():
                log.warning(
                    "hoga_perf api_range status=abandoned code=%s from=%s to=%s mode=%s "
                    "queue_wait_ms=%.1f",
                    code, from_date, to_date, mode, queue_wait_ms,
                )
                raise HTTPException(HTTP_CLIENT_CLOSED_REQUEST, "client disconnected")
            t_compute = perf_debug.now()
            bundle_kwargs: dict[str, object] = {
                "code": code,
                "from_date": from_date,
                "to_date": to_date,
                "bucket_ms": bucket_ms,
                "source_pref": source_pref,
                "venue": venue,
                "broker_late_entries_enabled": broker_late_entries_enabled,
                "broker_late_entry_start_hhmm": broker_late_entry_start_hhmm,
                "volume_distribution_bins": volume_distribution_bins,
                "volume_distribution_price_min": volume_distribution_price_min,
                "volume_distribution_price_max": volume_distribution_price_max,
                "volume_distribution_cutoff_ms": volume_distribution_cutoff_ms,
                "trade_volume_poc_bins": trade_volume_poc_bins,
                "ask_peaks_enabled": ask_peaks_enabled,
                "bid_peaks_enabled": bid_peaks_enabled,
                "program_trade_enabled": program_trade_enabled,
                "trade_volume_poc_enabled": trade_volume_poc_enabled,
                "depth_heatmap_enabled": depth_heatmap_enabled,
                "mode": mode,
            }
            try:
                bundle, payload, stats = await _run_range_bundle(
                    pools, engine, bundle_kwargs, from_date=from_date, to_date=to_date,
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
                stats["segments"],
                stats["candles"],
                stats["quote_ratio"],
                stats["fill_strength"],
                stats["excluded"],
                stats["warnings"],
                perf_debug.elapsed_ms(t0),
                queue_wait_ms,
                perf_debug.elapsed_ms(t_compute),
            )
        if payload is not None:
            # 워커가 `RangeBundle.model_dump_json` 으로 만든 body — 반환 애노테이션과
            # `response_model` 은 그대로라 wire 계약(ADR-0004)의 표면은 모델이다.
            return Response(content=payload, media_type="application/json")  # type: ignore[return-value]
        return _bundle_or_fail(bundle)

    return router


def _bundle_or_fail(bundle: RangeBundle | None) -> RangeBundle:
    """스레드 경로(`_run_range_bundle`)는 번들을 반드시 채운다 — None 이면 결함이다.
    `api_range` 의 분기 수 상한(PLR0912) 때문에 함수로 뺐고, **`build_router` 뒤에** 둔
    이유는 `test_range_slice_registry_contract` 가 파일에서 첫 `-> RangeBundle:` 까지를
    `api_range` 시그니처로 자르기 때문이다 — 앞에 두면 그 절단이 빈 문자열이 된다."""
    if bundle is None:
        raise RuntimeError("api_range: thread path produced no bundle")
    return bundle
