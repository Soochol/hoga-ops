"""워커 프로세스에서 도는 요청 경로 CPU 작업 (ADR-0169).

여기 함수들은 `hoga.compute_executor.ComputeExecutor.run` 으로 넘어간다 — 그래서 전부
**모듈 최상위**이고, 인자·반환값이 pickle 되며, 예외는 아래 가드가 picklable 껍데기로
바꾼다. 라우트는 이 함수들을 부르고 결과 바이트를 그대로 응답한다.

## 왜 바이트를 돌려주나

`RangeBundle` 은 수천 개의 pydantic 객체다. 모델을 pickle 로 나르면 부모가 그걸 다시
풀고(루프 스레드 CPU), FastAPI 가 다시 JSON 으로 직렬화한다 — 그 `dump_json` 이 오늘
로그에 루프 정지 25건으로 찍혀 있다. 워커에서 `model_dump_json(by_alias=True)` 까지
끝내면 부모는 바이트를 `Response` 에 싣기만 한다. 직렬화 결과는 FastAPI 의 것과 같다
(`response_model` 경로도 pydantic 직렬화 → 컴팩트 JSON; 대상 모델에 alias 필드는 없고
`response_model_exclude_none` 도 안 건다 — 테스트가 파싱 결과 동등성으로 고정한다).

## 워커의 DuckDB

워커마다 자기 `QueryEngine` 을 게으르게 만든다(`_engine_for`). 상한은
`hoga.duck.connect_bounded` 가 env 에서 읽으므로 풀이 `worker_env` 로 넘긴
`HOGA_DUCKDB_MEMORY_LIMIT` 가 그대로 먹고, 스레드 수는 첫 연결에 `SET threads` 로 건다
— N 워커 × 기본 8GiB × 전 코어가 ADR-0085 가 태어난 실패 모드다.
"""
from __future__ import annotations

import datetime as dt
import functools
import logging
import os
import threading
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from hoga.api.heatmap_group_flow import HeatmapGroupFlowResponse
    from hoga.api.models import PatternSearchRequest, PatternSearchResponse, RangeBundle
    from hoga.api.queries import QueryEngine
    from hoga.compute_executor import ComputeExecutor

log = logging.getLogger(__name__)

T = TypeVar("T")

ENV_WORKER_DUCKDB_THREADS = "HOGA_COMPUTE_DUCKDB_THREADS"


class ComputeHTTPError(Exception):
    """워커 안의 `HTTPException` 을 부모로 나르는 껍데기.

    Starlette `HTTPException.__init__` 은 `Exception.__init__` 을 부르지 않아 `args` 가
    비어 있다. 그대로 pickle 되면 부모의 unpickle 이 `HTTPException()` 을 불러 TypeError
    가 나고, 풀 관리 스레드는 그것을 **풀이 깨진 것**으로 처리한다 — 400 한 번이
    뒤따르는 모든 요청을 죽인다. 이 클래스는 `args` 를 채워 왕복이 된다.
    """

    def __init__(self, status_code: int, detail: Any = None) -> None:
        super().__init__(status_code, detail)
        self.status_code = status_code
        self.detail = detail


class ComputeJobError(Exception):
    """워커 안의 그 밖의 예외. 원래 타입은 못 나른다(생성자 서명을 모른다) —
    `repr` 과 트레이스백 텍스트만 싣고 부모가 500 으로 올린다."""

    def __init__(self, exc_repr: str, tb_text: str) -> None:
        super().__init__(exc_repr, tb_text)
        self.exc_repr = exc_repr
        self.tb_text = tb_text


def _picklable_errors(fn: Callable[..., T]) -> Callable[..., T]:
    """작업 함수의 예외를 전부 picklable 로 바꾼다(위 두 클래스 docstring)."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> T:
        try:
            return fn(*args, **kwargs)
        except (ComputeHTTPError, ComputeJobError):
            raise
        except Exception as e:  # noqa: BLE001 — 전 예외를 picklable 껍데기로 바꿔 **다시 던진다**(삼키지 않는다)
            from fastapi import HTTPException  # noqa: PLC0415 — 워커 import 를 가볍게

            if isinstance(e, HTTPException):
                raise ComputeHTTPError(e.status_code, e.detail) from None
            raise ComputeJobError(repr(e), traceback.format_exc()) from None

    return wrapper


# ── 워커별 DuckDB 엔진 ──────────────────────────────────────────────────────────

_engines: dict[str, QueryEngine] = {}
_engines_lock = threading.Lock()


def _engine_for(data_dir: str) -> QueryEngine:
    """이 프로세스의 `QueryEngine` — data_dir 마다 하나, 첫 작업에서 만든다.

    스레드 모드(테스트)에서는 앱 프로세스 안에서 불리므로 앱의 엔진과 **별개**
    인스턴스가 생긴다. 같은 설정 키면 `hoga.duck` 이 DuckDB 인스턴스를 공유하므로
    비용은 커서 하나다.
    """
    with _engines_lock:
        engine = _engines.get(data_dir)
        if engine is None:
            from hoga.api.queries import QueryEngine  # noqa: PLC0415 — 워커 import 를 가볍게

            engine = QueryEngine(Path(data_dir))
            threads = os.environ.get(ENV_WORKER_DUCKDB_THREADS, "").strip()
            if threads.isdigit() and int(threads) > 0:
                engine.conn.execute(f"SET threads TO {int(threads)}")
            _engines[data_dir] = engine
        return engine


# ── 작업 함수 ───────────────────────────────────────────────────────────────────

def warm_worker(data_dir: str | None) -> int:
    """예열 작업 — 첫 요청이 내던 비용을 미리 치른다: `hoga.api.bundle` import(pydantic·
    polars 사슬)와 이 프로세스의 DuckDB 엔진 생성(실측 합 0.4~0.6초). 반환은 워커 pid."""
    import hoga.api.bundle  # noqa: F401, PLC0415 — import 자체가 목적(부작용: 모듈 로드)

    if data_dir:
        _engine_for(data_dir)
    return os.getpid()


def range_bundle_stats(bundle: RangeBundle) -> dict[str, int]:
    """`hoga_perf api_range` 로그 줄에 실리는 개수들 — 두 실행 경로(스레드·프로세스)가
    같은 표를 쓴다."""
    return {
        "segments": len(bundle.segments),
        "candles": len(bundle.candles),
        "quote_ratio": len(bundle.quote_ratio.points),
        "fill_strength": len(bundle.fill_strength.points),
        "excluded": len(bundle.excluded_dates),
        "warnings": len(bundle.data_warnings),
    }


@_picklable_errors
def range_bundle_job(data_dir: str, kwargs: dict[str, Any]) -> tuple[bytes, dict[str, int]]:
    """`/api/range` 본체. 반환은 (응답 JSON 바이트, perf 로그용 개수)."""
    from hoga.api.bundle import build_range_bundle  # noqa: PLC0415 — 워커 import 를 가볍게

    bundle = build_range_bundle(_engine_for(data_dir), **kwargs)
    return bundle.model_dump_json(by_alias=True).encode("utf-8"), range_bundle_stats(bundle)


@_picklable_errors
def brokers_series_job(
    data_dir: str, code: str, date: str, source_pref: str, venue: str,
) -> bytes:
    """`/api/brokers/series` 본체(응답 JSON 바이트). 포인트마다 `model_copy` 를 도는
    순수 파이썬이라 큰 날은 10초를 넘겼다(실측 10.3초 — 앱 전체 정지)."""
    from hoga.api.routes import compute_brokers_series  # noqa: PLC0415 — 순환 절단(지연)

    response = compute_brokers_series(
        _engine_for(data_dir), code=code, date=date, source_pref=source_pref, venue=venue,
    )
    return response.model_dump_json(by_alias=True).encode("utf-8")


@_picklable_errors
def pattern_search_job(data_dir: str, req: PatternSearchRequest) -> PatternSearchResponse:
    """`/api/screener/pattern-search` 본체. 응답이 작아(수백 KB) 모델을 그대로 나른다.
    코퍼스 캐시(ADR-0166 §6, 프로세스 상주)는 워커마다 따로 데워진다."""
    from hoga.api import screener_pattern  # noqa: PLC0415 — 워커 import 를 가볍게

    return screener_pattern.run_pattern_search(Path(data_dir), req)


#: `list[StockDate]` 직렬화기. `TypeAdapter` 생성이 싸지 않아 워커마다 한 번만 만든다.
_stock_dates_adapter: Any = None


@_picklable_errors
def stock_dates_job(data_dir: str, fail_streaks: dict[str, int]) -> bytes:
    """`/api/stock-dates` 본체(응답 JSON 바이트).

    비싼 부분은 `QueryEngine.list_stock_dates` 의 파케이 트리 순회 + 캐시 미스분
    DuckDB 읽기다. 콜드 캐시에서 40초를 넘겨(2026-09-04 실측 41.3초) 동기 라우트
    스레드가 앱 전체를 세웠다. `_fail_streaks` 는 캡처 파이프라인의 **인프로세스**
    상태라 부모가 스냅샷을 떠서 넘긴다 — 자식은 그 dict 를 못 본다(ADR-0168 의
    `nxt_enabled` 와 같은 규율).
    """
    global _stock_dates_adapter  # noqa: PLW0603 — 워커 프로세스 지역 메모이제이션
    from pydantic import TypeAdapter  # noqa: PLC0415 — 워커 import 를 가볍게

    from hoga.api.models import StockDate as StockDateModel  # noqa: PLC0415
    from hoga.api.routes import compute_stock_dates  # noqa: PLC0415 — 순환 절단(지연)

    rows = compute_stock_dates(_engine_for(data_dir), fail_streaks)
    if _stock_dates_adapter is None:
        _stock_dates_adapter = TypeAdapter(list[StockDateModel])
    return _stock_dates_adapter.dump_json(rows, by_alias=True)


@_picklable_errors
def depth_daily_sweep_job(data_dir: str, code: str, date: str) -> dict[str, int]:
    """캡처 파싱 직후의 `depth_daily` 증분 스윕.

    (code, date) 한 쌍만 다시 계산하지만 매번 depth_daily 파케이 전체를 읽고 쓴다 —
    2026-09-04 실측: 이 작업이 앱 스레드 풀에서 **9.05초** CPU 를 태우는 동안 이벤트
    루프는 0.1초만 얻어 앱 전체가 8.9초 멎었다(GIL convoy). 순수 파일 작업이라 워커
    프로세스로 그대로 넘어간다.
    """
    from hoga.api import depth_daily  # noqa: PLC0415 — 순환 절단(지연)

    res = depth_daily.sweep(Path(data_dir), codes={code}, dates={date})
    return {
        "scanned": res.scanned, "computed": res.computed, "skipped": res.skipped,
        "no_data": res.no_data, "total_rows": res.total_rows,
    }


@_picklable_errors
def group_flow_job(
    data_dir: str, basis: dt.date, now_ms: int, venue: str,
) -> HeatmapGroupFlowResponse:
    """`/api/heatmap/group-flow` 본체. JSONL 꼬리 증분 오프셋(모듈 전역)은 워커마다
    따로 산다 — 워커 수만큼 꼬리를 중복해 읽는다(꼬리는 작다)."""
    from hoga.api.heatmap_group_flow import build_group_flow  # noqa: PLC0415 — 워커 import 를 가볍게

    return build_group_flow(Path(data_dir), basis, now_ms=now_ms, venue=venue)


# ── 부모 쪽 진입점 ──────────────────────────────────────────────────────────────

async def run_job(executor: ComputeExecutor, fn: Callable[..., T], /, *args: object) -> T:
    """작업을 실행기에서 돌리고 껍데기 예외를 원래 의미로 되돌린다.

    `ComputeHTTPError` → `HTTPException`(같은 status·detail). `ComputeJobError` → 워커
    트레이스백을 실은 `RuntimeError` — 라우트의 기존 `except Exception: log.exception`
    경로가 그대로 기록하고 FastAPI 가 500 으로 답한다(종전과 같은 실패 모양).
    """
    from fastapi import HTTPException  # noqa: PLC0415 — 순환 절단(지연)

    try:
        return await executor.run(fn, *args)
    except ComputeHTTPError as e:
        raise HTTPException(e.status_code, e.detail) from None
    except ComputeJobError as e:
        raise RuntimeError(
            f"compute worker failed: {e.exc_repr}\n--- worker traceback ---\n{e.tb_text}"
        ) from None


async def run_default_wide_job(fn: Callable[..., T], /, *args: object) -> T:
    """설치된 기본 풀의 wide 레인에서 돌린다. 없으면 `asyncio.to_thread`(종전 동작).

    라우터 클로저 밖에서 도는 코드(캡처 파이프라인)가 쓴다 — 거기엔 풀을 받을 인자
    자리가 없다. `promote_executor.run_promote_job` 과 같은 모양이다.
    """
    import asyncio  # noqa: PLC0415 — 워커 import 를 가볍게

    from hoga.api import compute_pools  # noqa: PLC0415 — 순환 절단(지연)

    pools = compute_pools.default_pools()
    if pools is None:
        return await asyncio.to_thread(fn, *args)
    return await run_job(pools.wide, fn, *args)
