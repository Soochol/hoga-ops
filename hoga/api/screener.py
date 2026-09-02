from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TypeVar

import polars as pl
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hoga.api import (
    compute_jobs,
    pattern_saves,
    screener_runner,
    screener_saves,
    screener_store,
)
from hoga.api.calendar import TradingDayUnavailableError, trading_days_in_range
from hoga.api.compute_pools import ComputePools, thread_pools
from hoga.api.error_codes import UpstreamCode
from hoga.api.models import (
    PatternSave,
    PatternSavesFile,
    PatternSaveWriteRequest,
    PatternSearchRequest,
    PatternSearchResponse,
    SavedScreener,
    SavedScreenersFile,
    ScanRequest,
    ScreenerResponse,
    ScreenerSaveWriteRequest,
    ScreenerUpdateSkipReason,
)
from hoga.api.mutation_broadcast import mutation_broadcast_route_class
from hoga.api.screener_store import DailyBar
from hoga.collector.orchestrator import next_kst_day, now_kst
from hoga.live import kiwoom_rest_runtime
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

_T = TypeVar("_T")


class _ScanCoalescer:
    """동일 요청 바디의 동시 /scan 을 하나의 실행으로 합친다(결과 공유).

    실시간 모니터링·멀티탭·연타로 같은 조건 스캔이 겹쳐 도착하면 duckdb 스캔 + depth
    평가를 N번 중복 실행한다(장중 키움 시세 fetch 는 screener_intraday 가 이미 15초 TTL 로
    coalesce). 첫 요청이 공유 task 를 만들고, 겹친 요청은 같은 결과를 받는다.

    캐시가 아니라 in-flight 코얼레싱이다 — task 완료 즉시 슬롯을 비워 다음 요청은 새
    스캔을 돈다(결과 stale 방지). await 는 shield 로 감싸 특정 caller(클라이언트
    disconnect)의 취소가 공유 task 를 죽이지 않게 한다(symbols.py RefreshCoordinator 규칙).
    """

    def __init__(self) -> None:
        self._inflight: dict[Hashable, asyncio.Future] = {}

    async def run(self, key: Hashable, factory: Callable[[], Awaitable[_T]]) -> _T:
        fut = self._inflight.get(key)
        if fut is None:
            fut = asyncio.ensure_future(factory())
            self._inflight[key] = fut
            # task 완료 시 슬롯 비움 — caller 의 취소 여부와 무관하게 정확히 한 번.
            fut.add_done_callback(lambda _f, k=key: self._inflight.pop(k, None))
        return await asyncio.shield(fut)


_scan_coalescer = _ScanCoalescer()


@dataclass
class _UpdateProgress:
    done: int
    total: int
    started_ms: int


@dataclass
class _UpdatePlan:
    sdir: Path
    codes: list[str]
    days: list[str]


# 서버-소유 갱신 job. 요청·스케줄러 어느 쪽 awaiter가 취소돼도 job은 살아남는다 —
# 이전 _RefreshCoordinator 는 임의 waiter 의 취소가 공유 future 를 취소시켜
# flight 전체(스케줄러 몫 포함)를 죽였다(브라우저 disconnect → 전량 유실).
# 슬롯 갱신은 전부 단일 이벤트 루프에서 await 없이 일어나므로 락 불필요.
_progress: _UpdateProgress | None = None
_job_task: asyncio.Task[int] | None = None
_module_bus = None  # EventBus | None — build_router 가 주입(스케줄러발 job 도 이벤트 발행)
_PROGRESS_MIN_INTERVAL_S = 1.0  # 진행 이벤트 스로틀(테스트는 0으로 monkeypatch)


# 스펙 D6 — 스크리너 EOD ingest 컷오프 = 16:00 KST. 정규장 종가(15:30) 확정 +
# After-Hours(15:30–16:00) 버퍼. 이 시각 전의 "오늘" 일봉은 벤더가 줘도 미확정이므로
# 갭에서 제외한다 — 장중 미확정 행이 아카이브에 박제되는 것을 막는다(그렇게 박제되면
# last_raw_date 가 오늘로 올라가 이후 no_gap 으로 재fetch까지 차단되어, 확정값으로
# 자가 교체되지 않는 오염이 된다). captures 경로의 16:30 is_today_too_early(hogaplay
# 집계 lag 버퍼)와는 목적·값이 다르다.
_SCREENER_EOD_CUTOFF_HOUR = 16


def _gap_trading_days(last_raw_date: str, today: str, *, now: datetime) -> list[str]:
    """last_raw_date 다음날부터 today(KST)까지의 거래일 목록. 갭 없으면 [].
    trading_days_in_range 예외는 전파 — 호출자가 0/None 으로 다르게 매핑한다.
    **그 예외의 의미가 PR-H(#1044) 로 바뀌었다**: 조회 경로에 벤더가 없어졌으므로
    "거래일 원격이 먹통" 이라는 사건은 더 없다. 지금 남은 것은 둘뿐이다 —
    소스 파일을 못 읽음(배포 사고) · 요청 끝이 달력 커버리지 초과(오버레이가 밀려야 함).
    둘 다 재시도로 풀리지 않는다(`calendar.trading_days_in_range` 참조).
    now < 16:00 KST 면 오늘(미확정)을 제외(스펙 D6). trigger_update(갭 캐치업)와
    status(days_behind)가 공유하는 단일 갭 규칙."""
    start = next_kst_day(last_raw_date)
    if start > today:
        return []
    days = trading_days_in_range(start, today)
    if now.hour < _SCREENER_EOD_CUTOFF_HOUR:
        days = [d for d in days if d < today]
    return days


async def _daily_fetch_one(
    client, code: str, frm: str, to: str, *, run_page=None
) -> list[DailyBar]:
    """PR-F(#1042) 칼 컷오버 — 소스는 키움 `ka10081` 이다.

    `adjust=False`(원주가)는 스크리너 코퍼스의 규약이다. **와이어 값 극성은
    어댑터가 뒤집는다** — 키움 `upd_stkpc_tp` 는 KIS 와 반대(1=수정주가)라
    불리언을 그대로 넘기고 변환은 `kiwoom_daily_candles.adjust_flag` 한 곳에 둔다.
    """
    from hoga.live import kiwoom_daily_candles  # noqa: PLC0415 — 지연 import(순환 절단)

    res = await kiwoom_daily_candles.fetch_daily_candles(
        client, code, frm, to,
        # 원주가는 절대값이라 수정주가 기준일(함정 ④)이 무의미하다 → `None` 이
        # 규약이고, 그 덕에 `base_dt=to` 랜덤 액세스를 그대로 쓴다(페이지 낭비 0).
        adjust=False, adjusted_as_of=None,
        run_page=run_page,
    )
    if res.violations:
        log.warning("screener daily violations %s: %d", code, len(res.violations))
    return [DailyBar(code=code,
                     date=datetime.fromtimestamp(c.t_ms / 1000, tz=KST).date(),
                     open=float(c.open), high=float(c.high),
                     low=float(c.low), close=float(c.close), volume=c.volume)
            for c in res.candles]


async def _plan_update(data_dir: Path) -> _UpdatePlan | str:
    """갱신 사전 체크. 작업이 없으면 skip reason 문자열을 반환한다.

    unseeded 체크가 가장 먼저 — 시드되지 않은 테스트/부트 데이터 디렉토리에서
    달력·벤더 작업이 돌지 않는 기존 계약 유지.
    """
    sdir = data_dir / "screener"
    # 동기 duckdb/polars read 는 to_thread 로 — 이벤트 루프 블로킹 방지(_commit 과 동일 규칙).
    last = await asyncio.to_thread(
        screener_store.last_raw_date, sdir / "daily_unadjusted.parquet")
    if last is None:
        return "not_seeded"

    now = now_kst()
    today = now.strftime("%Y%m%d")
    try:
        # to_thread: 시드/오버레이 파일 sync read(+파싱) — duckdb read 와 같은 규칙으로
        # 이벤트 루프 밖에서. **근거가 PR-H(#1044) 로 바뀌었다**: 예전엔 콜드 월이
        # KIS chk-holiday sync HTTP 였고 지금은 파일 IO 다. 비용은 줄었지만 동기 IO 인
        # 것은 그대로라 규칙은 유지한다.
        days = await asyncio.to_thread(_gap_trading_days, last, today, now=now)
    except TradingDayUnavailableError as e:
        # **두 실패를 갈라서 내보낸다.** 뭉치면 화면만 보고 조치를 고를 수 없다.
        if e.code is UpstreamCode.TRADING_DAYS_STALE:
            log.warning("screener update: 달력 커버리지가 %s 를 못 덮는다 — 오버레이 확인", today)
            return "calendar_coverage_behind"
        log.warning("screener update: 거래일 소스를 읽을 수 없다 (%s)", e.code.value)
        return "calendar_source_missing"
    except Exception:
        # 위 둘 밖의 무엇이든. 예상 밖 예외도 결국 "달력을 쓸 수 없다" 이고 사용자
        # 조치는 소스 결여와 같다(로그를 본다). 그래서 같은 사유로 접되 **traceback 은
        # 남긴다** — 그게 이 갈래와 진짜 배포 사고를 사후에 가르는 유일한 단서다.
        # (`noqa: BLE001` 이 없는 이유: `log.exception` 이 곧 "제대로 처리했다" 라
        # BLE001 이 애초에 발화하지 않는다 — 붙이면 RUF100 이 죽은 noqa 로 잡는다.)
        log.exception("screener update: 거래일 조회가 예상 밖 예외로 실패")
        return "calendar_source_missing"
    if not days:
        return "no_gap"

    # EOD 갭 캐치업은 배경 배치(종목 다수 daily fetch)이므로 Capacity Scheduler에 맡긴다.
    # creds가 없으면 기존처럼 skip하고, 있으면 per-code 요청이 키움 거버너 정책을 탄다.
    # PR-F(#1042) 칼 컷오버 — 자격 게이트도 키움을 본다. wire reason 은 벤더 중립
    # (`creds_missing`)이라 프론트 union 도 그대로다 — 표시 문구만 벤더를 말한다.
    if kiwoom_rest_runtime.ensure_rest_client(data_dir) is None:
        log.warning("screener update: 키움 자격증명 없음, skip")
        return "creds_missing"

    stocks_df = await asyncio.to_thread(pl.read_parquet, sdir / "stocks.parquet")
    codes = stocks_df["code"].to_list()   # 무거운 read 는 스레드로; 인메모리 추출만 루프
    return _UpdatePlan(sdir=sdir, codes=codes, days=days)


def _ensure_job(data_dir: Path, plan: _UpdatePlan, *, bus) -> asyncio.Task[int]:
    """살아있는 job 이 있으면 join, 없으면 스폰. await 없는 동기 함수라 race-free."""
    global _job_task, _progress  # noqa: PLW0603
    if _job_task is not None and not _job_task.done():
        return _job_task
    _progress = _UpdateProgress(
        done=0, total=len(plan.codes), started_ms=int(time.time() * 1000))
    _job_task = asyncio.create_task(
        _run_update_job(data_dir, plan, bus=bus), name="screener-update")
    return _job_task


async def _run_update_job(data_dir: Path, plan: _UpdatePlan, *, bus) -> int:
    global _job_task, _progress  # noqa: PLW0603
    total = len(plan.codes)
    try:
        from hoga.live import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈)
            kiwoom_access,
            kiwoom_daily_candles,
            kiwoom_rest_runtime,
        )

        scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            raise RuntimeError("키움 자격증명 없음 — 스크리너 갱신 불가")

        async def fetch_one(c: str, f: str, t: str) -> list[DailyBar]:
            def _run_page(fetch_fn, page_idx: int):
                """페이지 1장 = 거버너 submit 1건.

                **walk 전체를 감싸던 자리다.** 갱신은 종목 수만큼 도는데 각 종목이
                다시 페이지 N장이라, 바깥에서 감싸면 페이지 축이 통째로 페이싱
                밖으로 샌다(ADR-0137).
                """
                return kiwoom_access.run_with_capacity(
                    scheduler,
                    key=("screener-update", c, f, t, page_idx),
                    api_id=kiwoom_daily_candles.API_ID,
                    priority="background",
                    client=client,
                    fetch_fn=fetch_fn,
                )

            return await _daily_fetch_one(client, c, f, t, run_page=_run_page)

        last_pub = 0.0

        async def counting_fetch_one(c: str, f: str, t: str) -> list[DailyBar]:
            nonlocal last_pub
            try:
                return await fetch_one(c, f, t)
            finally:
                if _progress is not None:
                    _progress.done += 1
                    now_mono = time.monotonic()
                    if bus is not None and (
                            now_mono - last_pub >= _PROGRESS_MIN_INTERVAL_S
                            or _progress.done == total):
                        last_pub = now_mono
                        bus.publish({"type": "screener_update_progress",
                                     "done": _progress.done, "total": total})

        if bus is not None:  # 시작 즉시 0/total — 클릭하지 않은 서피스도 바로 표시 전환
            bus.publish({"type": "screener_update_progress", "done": 0, "total": total})
        n = await screener_store.run_update(
            plan.sdir, codes=plan.codes, fetch_one=counting_fetch_one,
            trading_days=plan.days, now_ms=int(time.time() * 1000))
        if bus is not None:
            bus.publish({"type": "screener_update_finished",
                         "updated": n, "total": total, "reason": None})
        return n
    except asyncio.CancelledError:
        if bus is not None:
            bus.publish({"type": "screener_update_finished",
                         "updated": 0, "total": total, "reason": "cancelled"})
        raise
    except Exception:
        log.exception("screener update job failed")
        if bus is not None:
            bus.publish({"type": "screener_update_finished",
                         "updated": 0, "total": total, "reason": "error"})
        raise
    finally:
        _progress = None
        _job_task = None


async def trigger_update(data_dir: Path, *, bus=None) -> int:
    """스케줄러 경로 — EOD 갭 캐치업을 실제 완료까지 await. 추가된 거래일 수 반환.

    작업이 없으면(unseeded/no-gap/creds/calendar) 0 — 기존 계약 유지. 동시
    트리거(스케줄러 EOD + 수동 POST)는 _ensure_job 이 단일 job 으로 join 한다.
    """
    plan = await _plan_update(data_dir)
    if isinstance(plan, str):
        return 0
    task = _ensure_job(data_dir, plan, bus=bus if bus is not None else _module_bus)
    # shield: awaiter(스케줄러 셧다운, 버려진 caller) 취소가 공유 job 을 죽이지
    # 않는다. job 자체의 예외는 그대로 전파 — 스케줄러 try/except 로깅 의미론 유지.
    return await asyncio.shield(task)


async def start_update(data_dir: Path, *, bus=None) -> dict:
    """엔드포인트 경로 — job 을 스폰만 하고 즉시 반환(완료를 await 하지 않음).

    핸들러가 job 을 await 하지 않으므로 클라이언트 disconnect 로 인한 핸들러
    취소가 job 에 닿지 않는다. 진행/완료는 bus 이벤트와 status.updating 으로 전달.
    """
    if _job_task is not None and not _job_task.done() and _progress is not None:
        return {"running": True, "done": _progress.done, "total": _progress.total}
    plan = await _plan_update(data_dir)
    if isinstance(plan, str):
        return {"running": False, "updated": 0, "reason": plan}
    _ensure_job(data_dir, plan, bus=bus if bus is not None else _module_bus)
    return {"running": True, "done": 0, "total": len(plan.codes)}


async def shutdown_update_job() -> None:
    """lifespan 셧다운: 벤더 클라이언트 teardown 전에 detached job 을 cancel+await."""
    task = _job_task
    if task is not None and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


def reset_update_job_for_tests() -> None:
    global _job_task, _progress, _module_bus  # noqa: PLW0603
    if _job_task is not None and not _job_task.done():
        # 이전 테스트의 (이미 닫힌) 루프에 속한 태스크면 cancel 이 RuntimeError.
        with contextlib.suppress(RuntimeError):
            _job_task.cancel()
    _job_task = None
    _progress = None
    _module_bus = None


def _save_not_found(save_id: str) -> HTTPException:
    return HTTPException(
        404, {"code": "save_not_found", "message": f"No saved screener {save_id}"})


# ── wire models (ADR-0004 · 동결선 배치 4) ────────────────────────────────────


class ScreenerUpdatingProgress(BaseModel):
    done: int
    total: int
    started_ms: int


class ScreenerStatusResponse(BaseModel):
    """GET /api/screener/status — 두 형태를 한 모델로 받는다.

    시드 전이면 ``{"status": "not_seeded"}`` 만 나오고, 시드 후엔 status.json 의
    필드가 합쳐진다. 그래서 `status` 외 전부 optional 이다.

    **`exclude_none` 을 쓰지 않는다.** `days_behind: null`(신선도 불명)과
    `updating: null`(갱신 job 없음)은 **값이 있는 null** 이라 지우면 뜻이 사라진다 —
    프론트도 `days_behind?: number | null` 로 그 구분을 받는다. 대신 시드 전 응답에
    null 필드가 몇 개 붙는데, 프론트 타입이 전부 optional 이라 무해하다.
    """

    status: str
    schema_version: int | None = None
    last_raw_date: str | None = None
    last_built_ms: int | None = None
    universe_size: int | None = None
    derive_ms: int | None = None
    days_behind: int | None = None
    updating: ScreenerUpdatingProgress | None = None


class ScreenerUpdateResponse(BaseModel):
    """POST /api/screener/update — 프론트가 **판별 유니온**으로 받는 응답이다:

    ``{running: true, done, total} | {running: false, updated: 0, reason}``

    그래서 라우트에 ``response_model_exclude_none=True`` 가 **필수**다. 기본 직렬화면
    양쪽 가지의 키가 전부 실려(`updated: null` 등) 유니온 판별이 깨진다.

    `reason` 은 `models.ScreenerUpdateSkipReason` 으로 좁혀 두었다 — 그 이름이
    프론트 union 이름과 같아 ADR-0004 **2층 미러 대조**가 이 쌍을 지킨다
    (`tests/unit/api/test_rest_wire_schema_contract.py::WIRE_ENUM_MIRRORS`).
    *(오래 `str` 이었다. 그때 사유는 "BE 에 타입 별칭이 없다" 였는데, 별칭이 없다는
    것이 곧 이 enum 이 무방비라는 뜻이었다 — 값 드리프트는 타입이 원리적으로 못
    잡는다(#1183). 사유를 둘로 쪼개면서 함께 닫았다.)*
    """

    running: bool
    done: int | None = None
    total: int | None = None
    updated: int | None = None
    reason: ScreenerUpdateSkipReason | None = None


def _build_pattern_saves_router(data_dir: Path, bus) -> APIRouter:
    """패턴 검색 저장 CRUD.

    스크리너 저장과 **같은 형태**이나 파일(`pattern/saves.json`)과 브로드캐스트
    채널이 다르다 — 같은 채널을 쓰면 한쪽 변경이 다른 쪽 목록을 무의미하게 갱신한다.
    """
    pat_saves = APIRouter(
        route_class=mutation_broadcast_route_class(bus, "pattern_saves_changed"),
    )

    def _pattern_save_not_found(save_id: str) -> HTTPException:
        return HTTPException(status_code=404, detail=f"pattern save not found: {save_id}")

    @pat_saves.post("", status_code=201, response_model=PatternSave)
    async def create_pattern_save(req: PatternSaveWriteRequest) -> PatternSave:
        return await pattern_saves.create_save(
            data_dir, req=req, id=uuid.uuid4().hex, now_ms=int(time.time() * 1000))

    @pat_saves.get("", response_model=PatternSavesFile)
    async def list_pattern_saves() -> PatternSavesFile:
        # 파일 전체를 낸다 — `schema_version` 이 모델 기본값이라는 단일 출처에서 오고
        # 하드코딩 리터럴과 갈릴 수 없다(스크리너 저장과 같은 이유).
        return pattern_saves.load_saves(data_dir)

    @pat_saves.put("/{save_id}", response_model=PatternSave)
    async def update_pattern_save(save_id: str, req: PatternSaveWriteRequest) -> PatternSave:
        try:
            return await pattern_saves.update_save(
                data_dir, id=save_id, req=req, now_ms=int(time.time() * 1000))
        except pattern_saves.PatternSaveNotFoundError as e:
            raise _pattern_save_not_found(save_id) from e

    @pat_saves.delete("/{save_id}", status_code=204)
    async def delete_pattern_save(save_id: str) -> None:
        try:
            await pattern_saves.delete_save(data_dir, id=save_id)
        except pattern_saves.PatternSaveNotFoundError as e:
            raise _pattern_save_not_found(save_id) from e

    return pat_saves


def build_router(*, data_dir: Path, bus=None, compute: ComputePools | None = None) -> APIRouter:
    global _module_bus  # noqa: PLW0603
    _module_bus = bus   # 스케줄러발 trigger_update(bus 미전달)도 같은 버스로 발행
    # 패턴 검색이 도는 자리(ADR-0169). 안 넘기면 스레드 — 종전 `asyncio.to_thread` 와 같다.
    pools: ComputePools = compute if compute is not None else thread_pools()
    router = APIRouter(prefix="/api/screener", tags=["screener"])
    sdir = data_dir / "screener"

    @router.post("/scan")
    async def scan(req: ScanRequest) -> ScreenerResponse:
        # 동일 바디의 동시 요청은 하나의 스캔으로 합친다(모니터링·멀티탭 중복 제거).
        key = req.model_dump_json()
        return await _scan_coalescer.run(
            key, lambda: screener_runner.run_screener_scan(data_dir=data_dir, req=req))

    @router.post("/pattern-search")
    async def pattern_search(req: PatternSearchRequest) -> PatternSearchResponse:
        """봉 패턴 검색(ADR-0166).

        `to_thread` 는 필수다 — 콜드 캐시 1.5s + history 0.4s 를 이벤트 루프에서
        돌리면 그동안 프로세스 전체가 멎는다(`screener-daily-candles` 와 같은 이유).
        순수 함수라 스레드 실행이 안전하다(공유 상태는 읽기 전용 코퍼스 캐시뿐).
        """
        # 컴퓨트 워커(ADR-0169) — 스레드로 내려도 GIL 은 이 프로세스에 남아(실측 95초 요청
        # 동안 루프 굶주림) 프로세스 풀에서 돈다. 코퍼스 캐시는 워커마다 따로 데워진다.
        return await compute_jobs.run_job(
            pools.wide, compute_jobs.pattern_search_job, str(data_dir), req,
        )

    @router.get("/status")
    def status() -> ScreenerStatusResponse:
        s = screener_store.read_status(sdir / "status.json")
        if s is None:
            return {"status": "not_seeded"}
        # TRADING-day freshness for the frontend StalenessChip: count trading
        # days from the day AFTER last_raw_date through today KST. A calendar-
        # day proxy shows false-amber on weekends. Mirror trigger_update's gap
        # logic (same next_kst_day + start>today short-circuit) so the
        # inverted-range ValueError never fires. KRX outage → None (frontend
        # treats None as unknown), never crash the status route.
        now = now_kst()
        today = now.strftime("%Y%m%d")
        if s.last_raw_date is None:
            days_behind = None  # 유효 거래일 없음(빈/NULL-date 아카이브) → 신선도 불명
        else:
            try:
                days_behind = len(_gap_trading_days(s.last_raw_date, today, now=now))
            except Exception:  # noqa: BLE001 — TradingDayUnavailableError or worse
                days_behind = None
        return {
            **s.model_dump(),
            "status": "ok",
            "days_behind": days_behind,
            # 진행 중 갱신 job — 재진입/드로어가 WS 이벤트 없이도 상태를 복원한다.
            "updating": (
                {"done": _progress.done, "total": _progress.total,
                 "started_ms": _progress.started_ms}
                if _progress is not None else None
            ),
        }

    # 판별 유니온이라 exclude_none 이 필수다(모델 docstring 참조).
    @router.post("/update", response_model_exclude_none=True)
    async def update() -> ScreenerUpdateResponse:
        return await start_update(data_dir, bus=bus)

    # 저장 목록만 **별도 서브라우터**로 묶는다 — 교차 창 브로드캐스트를 여기에만
    # 걸기 위해서다(mutation_broadcast). 메인 라우터에 걸면 `POST /scan` 이 함께
    # 발행되는데, 스캔은 사용자가 조건을 만질 때마다 나가는 **조회성 POST** 라
    # 열려 있는 모든 창이 그 횟수만큼 저장 목록을 다시 읽는다. 관심목록의
    # `/catchup`(가끔 누르는 버튼)과는 빈도 등급이 다르다 — 거기서 스퓨리어스를
    # 감수한 논리가 이쪽으로 이식되지 않는다.
    #
    # ⚠ **저장 계열 라우트는 이 서브라우터에 추가할 것.** 메인 라우터에
    # `/saves...` 를 달면 브로드캐스트가 빠진 채 조용히 동작한다(다른 창이
    # 안 따라오는 무증상 실패). 테스트가 경로 prefix 로 양방향을 다 잰다.
    saves = APIRouter(
        route_class=mutation_broadcast_route_class(bus, "screener_saves_changed"),
    )

    @saves.post("", status_code=201, response_model=SavedScreener)
    async def create_save(req: ScreenerSaveWriteRequest) -> SavedScreener:
        return await screener_saves.create_save(
            data_dir, req=req, id=uuid.uuid4().hex, now_ms=int(time.time() * 1000))

    @saves.get("", response_model=SavedScreenersFile)
    async def list_saves() -> SavedScreenersFile:
        # Return the whole file so schema_version comes from the single
        # source of truth (the model default) and can't drift from a
        # hardcoded literal. Response shape stays {schema_version, saves}.
        return screener_saves.load_saves(data_dir)

    @saves.get("/{save_id}", response_model=SavedScreener)
    async def get_save(save_id: str) -> SavedScreener:
        try:
            return await screener_saves.get_save(data_dir, id=save_id)
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise _save_not_found(save_id) from e

    @saves.put("/{save_id}", response_model=SavedScreener)
    async def update_save(save_id: str, req: ScreenerSaveWriteRequest) -> SavedScreener:
        try:
            return await screener_saves.update_save(
                data_dir, id=save_id, req=req, now_ms=int(time.time() * 1000))
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise _save_not_found(save_id) from e

    @saves.delete("/{save_id}", status_code=204)
    async def delete_save(save_id: str) -> None:
        try:
            await screener_saves.delete_save(data_dir, id=save_id)
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise _save_not_found(save_id) from e

    router.include_router(saves, prefix="/saves")

    router.include_router(
        _build_pattern_saves_router(data_dir, bus), prefix="/pattern-saves")
    return router
