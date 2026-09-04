"""FastAPI factory."""

from __future__ import annotations

import asyncio
import contextlib
import functools
import gc
import logging
import os
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from hoga.api import (
    calendar as calendar_module,
    captures as _captures_module,
    gc_probe,
    screener as _screener_module,
    symbols as _symbols_module,
)
from hoga.api.calendar import build_router as build_calendar_router
from hoga.api.captures import build_router as build_captures_router, cancel_all_on_shutdown, set_bus as set_captures_bus
from hoga.api.compute_pools import (
    ComputePools,
    build_compute_pools,
    install_default as install_default_compute_pools,
    thread_pools,
)
from hoga.api.events import build_event_bus
from hoga.api.frontend_static import mount_frontend
from hoga.api.heatmap import seed_from_watchlist_if_absent
from hoga.api.heatmap_routes import build_router as build_heatmap_router
from hoga.api.live_layout_preset_routes import (
    build_router as build_live_layout_preset_router,
)
from hoga.api.market_routes import build_router as build_market_router
from hoga.api.origin_guard import OriginGuardMiddleware
from hoga.api.prune import disk_headroom
from hoga.api.queries import QueryEngine
from hoga.api.request_timing import RequestTimingMiddleware
from hoga.api.routes import build_router
from hoga.api.scheduler import start_scheduler
from hoga.api.screener import build_router as build_screener_router
from hoga.api.sentiment_routes import build_router as build_sentiment_router
from hoga.api.signal_alert_routes import build_router as build_signal_alert_router
from hoga.api.startup_runtime import StartupRuntimeDeps, start_app_runtime
from hoga.api.study_view_routes import build_router as build_study_view_router
from hoga.api.symbols import build_router as build_symbols_router
from hoga.api.test_routes import build_test_router
from hoga.api.watchlist_routes import build_router as build_watchlist_router
from hoga.api.ws import build_ws_router
from hoga.collector.client import HogaplayClient
from hoga.config import Config, resolve_data_dir, resolve_log_dir, resolve_symbol_master_path
from hoga.env import load_env
from hoga.gc_tuning import (  # 값과 근거 표는 아래 주석, 정의는 리프 모듈(ADR-0168)
    GC_GEN0_THRESHOLD_DEFAULT,  # noqa: F401 — 하위호환 재수출(테스트가 이 모듈에서 import)
    GC_UPPER_GEN_THRESHOLDS,
    gc_gen0_threshold,
)
from hoga.live import kiwoom_rest_runtime
from hoga.live.api import build_router as build_live_router
from hoga.live.kis_runtime import aclose_kis_client
from hoga.live.lifecycle import (
    configure_signal_alert_monitor,
    ensure_today_peaks_seeded as live_ensure_today_peaks_seeded,
    get_buffer as live_get_buffer,
    get_kiwoom_capture_codes,
    get_program_trade_task,
    get_status as live_get_status,
    get_today_ask_peak as live_get_today_ask_peak,
    get_today_bid_peak as live_get_today_bid_peak,
    get_vi_status as live_get_vi_status,
    restore_last_ob_from_disk,
    start_kiwoom_session_watchdog,
    start_last_ob_flusher,
    start_live_stream,
    start_sector_broadcast,
    start_today_promoter,
    start_trading_calendar_refresher,
    stop_live_stream,
    stop_today_promoter,
)
from hoga.live.migrate import migrate_to_v2_layout


def _gc_health_section(gc_objects: bool) -> dict:
    """deep health 의 `gc` 절. 상시 층은 카운터, `gc_objects=1` 이면 객체 조사가 더 붙는다.

    조사는 **두 겹의 게이트**를 지나야 돈다: env 옵트인(`HOGA_GC_INTROSPECT_ENABLED`)과
    이 쿼리 파라미터. 하나만으로는 부족한 이유가 서로 다르다 — env 는 "이 인스턴스에서
    허용하는가"(운영 워치독이 도는 prod 에서는 꺼 둔다), 파라미터는 "지금 이 호출이
    의도한 것인가"(같은 인스턴스라도 감독자 폴링은 조사를 원하지 않는다). 거부는 이유를
    실어 돌려준다 — 조용히 빈 값을 주면 부른 쪽이 "객체가 0개" 로 읽는다.
    """
    section = gc_probe.stats_snapshot()
    if not gc_objects:
        return section
    if not gc_probe.introspect_enabled():
        section["objects"] = {
            "skipped": f"{gc_probe.ENV_INTROSPECT_ENABLED}=true 가 아니라 건너뜀",
        }
        return section
    section["objects"] = gc_probe.introspect_objects()
    return section


async def _cancel_tasks(*tasks: asyncio.Task) -> None:
    """lifespan 이 소유한 주기 태스크들을 순서대로 취소하고 회수한다.

    취소 예외를 삼키는 것은 종료 경로의 관례다 — 여기서 올리면 뒤따르는 teardown
    (스크리너 job · 심볼 워커 · KIS)이 통째로 건너뛰어진다.
    """
    for task in tasks:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


async def _start_last_ob_persistence(data_dir: Path) -> asyncio.Task:
    """마지막 호가 복원 + flush 태스크 기동 — **재시작이 화면을 비우지 않게** 한다.

    이 값은 프로세스 메모리에만 있어서 재시작에 **전 종목이 함께 죽었다**(2026-08-27
    실측: 장 마감 후 기동한 백엔드에서 005930 포함 전 종목 0 건, 10호가 창이 통째로
    빔). 복원이 WS 수신보다 먼저 끝나든 나중이든 안전하다 — 살아 있는 값을 덮지 않는다.

    두 줄을 굳이 함수로 묶은 이유는 `lifespan` 의 문장 수 상한(PLR0915) 때문이다.
    """
    await restore_last_ob_from_disk(data_dir)
    # 그 뒤로는 이 태스크가 **바뀌었을 때만** 디스크에 내린다(벤더 호출 0).
    return start_last_ob_flusher(data_dir)


# CORS 와 OriginGuard 가 **공유**하는 단일 출처의 정적 기본값. 두 곳에 리터럴을
# 따로 두면 한쪽만 고쳐져 "CORS 는 통과하는데 가드가 막는"(또는 그 반대) 상태가
# 조용히 생긴다. 소비는 create_app 의 allowed_origins() 한 번뿐이어야 한다.
#
# 127.0.0.1 과 localhost 는 브라우저가 서로 다른 origin 으로 취급하므로 둘 다 넣는다.
# 5174 는 5173 이 점유됐을 때 vite 가 자동으로 옮겨 가는 포트다.
ALLOWED_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
)


def _read_app_version() -> str:
    """리포 루트 VERSION 파일을 읽는다 — 실행 인스턴스 식별의 단일 진실 (#998).

    dev/prod 2대 운영에서 "지금 8000 에 뜬 게 새 코드인가" 를 curl 한 줄로
    답하기 위한 것. 이전에는 FastAPI version 이 '0.1.0' 하드코딩이라 답이
    없었다. 파일이 없으면(비정상 설치본) unknown — 식별 실패가 기동을 막을
    이유는 없다.
    """
    try:
        return (Path(__file__).resolve().parents[2] / "VERSION").read_text(
            encoding="utf-8",
        ).strip()
    except OSError:
        return "unknown"


def _read_git_commit() -> str:
    """기동 시점 체크아웃의 짧은 커밋 SHA. 없으면 ``unknown``.

    ``VERSION`` 이 답하지 못하는 질문을 답한다. 그 파일은 사람이 릴리스 때 손으로
    올리는 값인데 2026-07-07 이후 600여 커밋 동안 멈춰 있었다 — 그래서 업그레이드
    러닝북의 유일한 검증 단계("version 이 새 값인지")가 **항상 같은 문자열**을
    돌려주었고, `git pull` 누락 · `systemctl restart` 실패 · 구프로세스 잔존이
    성공과 구분되지 않았다(2026-08-03). 커밋 SHA 는 사람 규율에 의존하지 않는다.

    기동 시 1회만 부른다(모듈 상수) — 응답마다 subprocess 를 띄우면 감독자가
    짧은 주기로 무는 엔드포인트에 fork 비용이 붙는다. 설치본(비-git 체크아웃)이나
    git 부재는 정상 상황이므로 조용히 unknown 이다 — 식별 실패가 기동을 막을
    이유는 없다(VERSION 과 같은 규칙).
    """
    try:
        # 인자는 전부 리터럴이고 셸을 거치지 않는다 — 외부 입력이 닿는 곳이 없다.
        done = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return done.stdout.strip() if done.returncode == 0 else "unknown"


APP_VERSION: str = _read_app_version()
APP_COMMIT: str = _read_git_commit()


class HealthResponse(BaseModel):
    """GET /health 의 wire model — 얕은·부팅중·deep 세 형태를 한 모델로 담는다.

    소비자가 사람만이 아니다: 감독자가 `?deep=1` 의 **status code** 로 재시작을
    판정하고, 업그레이드 러닝북이 `version`·`commit` 으로 배포 성공을 판정한다.

    **검증만 하고 body 는 원본을 그대로 내보낸다**(`model_validate` 후 원래 dict 를
    `JSONResponse` 에 넘긴다). 이 라우트는 `status_code=503 if degraded` 로 상태
    코드를 body 에 따라 바꾸므로 `JSONResponse` 를 직접 만들어야 하고, 그러면
    `response_model` 이 걸리지 않는다. 모델을 통과시킨 dict 를 다시 덤프하면
    세 형태의 키 구성이 미묘하게 달라질 수 있어서, **바이트를 못 바꾸는 쪽**을 골랐다.

    중첩 필드(`queue`·`disk`·`supervised_tasks`)는 `dict`/`list[dict]` 로 둔다 —
    각각 `queue_ownership_state()`·`disk_headroom()`·`supervised_task_health()` 가
    소유한 shape 이라 여기서 한 벌 더 선언하면 미러만 늘어난다.
    """

    status: str
    version: str
    commit: str
    # 아래는 형태별로만 실린다. 얕은 응답엔 셋 다 없다.
    checks: dict | None = None          # 부팅 중(lifespan 밖) — 판정 근거 없음
    dead_tasks: list[str] | None = None
    queue: dict | None = None
    disk: dict | None = None
    supervised_tasks: list[dict] | None = None
    #: GC 정지 계측(ADR-0169 후속, `hoga.api.gc_probe`). `queue`·`disk` 와 같은 관측
    #: 전용 필드다 — 값이 나빠도 503 을 내지 않는다. 상시 층은 카운터 읽기라 값싸고,
    #: `?gc_objects=1` 을 준 경우에만 **앱을 수 초 멈추는** 객체 조사 결과가 더 붙는다.
    gc: dict | None = None


# GC gen0 임계 기본값. CPython 기본은 700 이다.
#
# **왜 올리나 — 팽창의 절반이 GIL 이 아니라 GC 였다.** CPython 의 세대별 수집은
# stop-the-world 라, `/api/range` 처럼 요청당 수만 개의 모델을 만드는 경로에서는
# 스레드를 늘릴수록 수집이 잦아지고 매 수집이 **모든 스레드를** 멈춘다. 그래서
# 팽창이 초선형이 된다(ADR-0085 v3.2).
#
# 실측(064350 · 5개월 · engine 공유 · 3회 median · 모든 변형이 같은 지점에서
# `gc.collect()` 후 측정):
#
#     변형            candles 6스레드   gen0 수집    sidecar 6스레드   gen0 수집
#     기본(700)          2.263s          869          3.778s         1442
#     gen0 상향          1.428s (+37%)    12          1.705s (+55%)     7
#     gc.freeze() 만     1.929s          869          3.600s         1673
#     freeze + 상향      1.655s           12          1.925s            6
#
# **`gc.freeze()` 는 빼기로 했다** — 수집 횟수를 전혀 바꾸지 않고(869→869,
# 613→613), 상향과 조합하면 오히려 나빴다. 이득이 있다는 근거가 없다.
#
# 값에는 **둔감하다**: 2,000 부터 200,000 까지 전부 +28~45% 대역이고 서로의 차이는
# 노이즈다. 즉 중요한 것은 "임계를 올린다" 는 사실이지 정확한 값이 아니다.
# 아래 값은 위 표를 잰 조합 그대로다.
#
# ⚠ **메모리**: peak RSS 는 446→448MB(candles) · 501→514MB(sidecar) 로 사실상
# 그대로였다. 다만 이것은 **한 워크로드의 peak** 이지 장기 운영 RSS 가 아니다.
# 이 ADR 계열이 애초에 OOM 사고에서 태어났으므로(ADR-0085), 운영 RSS 가 예전보다
# 뚜렷이 높아지면 이 값을 먼저 의심할 것. `0` 을 넣으면 튜닝이 꺼진다.
#
# 값 자체(`GC_GEN0_THRESHOLD_DEFAULT` 50_000 · `GC_UPPER_GEN_THRESHOLDS` (50, 50) ·
# `gc_gen0_threshold()`)는 `hoga.gc_tuning` 리프 모듈에 있고 위 import 가 여기로
# 재수출한다. 내린 이유: 프로모터 **워커 프로세스**(ADR-0168)가 같은 임계를 걸어야
# 하는데, 그쪽에서 이 모듈을 import 하면 앱 전체가 자식 프로세스에 올라온다.
# gen1/gen2 — 위 표를 잰 조합의 나머지 두 자리(기본은 10/10). gen0 이 덜 도는 만큼
# 상위 세대 승격도 줄어 이 둘의 영향은 작다.


def allowed_origins() -> tuple[str, ...]:
    """최종 허용 출처 = 정적 기본 4개 + ``HOGA_ALLOWED_ORIGINS``(콤마 구분).

    prod 는 자기 origin 을 여기 명시한다(예: ``http://hoga-prod:8000`` — ADR-0134
    의 same-origin 배포도 예외가 아니다). Sec-Fetch-Site 나 Origin==Host 비교로
    same-origin 을 **추론해 통과시키는 안은 기각됐다**: DNS rebinding 페이지는
    rebound 호스트 기준으로 진짜 same-origin 이라 두 신호를 모두 통과한다.
    명시 목록만이 rebound Origin(공격자 도메인)을 구분한다.

    모듈 상수가 아니라 함수인 이유: env 는 default_app() 의 load_env() 이후에야
    확정되는데, 모듈 상수는 import 시점(그 이전)에 굳는다.
    """
    extra = tuple(
        o.strip().rstrip("/")
        for o in os.environ.get("HOGA_ALLOWED_ORIGINS", "").split(",")
        if o.strip()
    )
    return ALLOWED_ORIGINS + extra


def create_app(  # noqa: PLR0915 — ADR 이 지정한 단일 조립점 — 문장 분할이 설계에 반한다
    data_dir: Path, *, compute: ComputePools | None = None,
) -> FastAPI:
    engine = QueryEngine(data_dir)
    # 요청 경로 CPU 작업(range 번들·거래원 시계열·패턴 검색·그룹 흐름)이 도는 자리
    # (ADR-0169). 안 넘기면 스레드 두 벌 — 테스트가 그 경로다. 운영(`default_app`)은
    # env 로 만든 프로세스 풀을 넘긴다.
    pools: ComputePools = compute if compute is not None else thread_pools()
    # 라우터 클로저 밖에서 도는 코드(캡처 파이프라인의 `depth_daily` 스윕)가 쓰는 모듈
    # 기본 풀. lifespan 종료가 지운다 — 남겨 두면 다음 앱 인스턴스가 이미 내려간 풀을
    # 붙잡는다(TestClient 는 한 프로세스에서 앱을 수백 번 만든다).
    install_default_compute_pools(pools)
    bus, observer, inv_handler = build_event_bus(data_dir / "parquet")
    configure_signal_alert_monitor(data_dir, bus.publish)

    def _real_client_factory():
        cfg = Config.from_cwd()
        return HogaplayClient(cookie=cfg.cookie())

    # Choose client factory: fake when the test env flag is set. The fake
    # module is import-gated too — production processes don't load it.
    if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
        from hoga.api.captures_fake import FakeHogaplayClient  # noqa: PLC0415 — intentionally gated

        def _fake_client_factory():
            return FakeHogaplayClient()

        client_factory = _fake_client_factory
    else:
        client_factory = _real_client_factory

    async def _live_control(action: str) -> None:
        """Dispatch POST /api/live/control actions to the lifecycle layer."""
        if action == "start":
            await start_live_stream(data_dir=data_dir)
        elif action == "stop":
            await stop_live_stream()
        elif action == "pause":
            # Stage 8: treat pause as stop. Future: true pause (freeze loop
            # but keep buffer + status alive).
            await stop_live_stream()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        migrate_to_v2_layout(data_dir)
        # ADR-0068: one-time seed of the independent heatmap.json from the
        # watchlist (folders+entries, capture fields stripped) the first boot
        # it's absent AND the watchlist is non-empty. Idempotent; reads the
        # watchlist read-only so it's never at risk. Sync, pre-task-spawn.
        seed_from_watchlist_if_absent(data_dir)
        loop = asyncio.get_running_loop()
        inv_handler.loop = loop  # ADR-0053: route no longer binds this
        observer.start()
        # bus + loop for thread-safe publishes from the watchdog thread.
        set_captures_bus(bus, loop)
        # Single entry point bundles restore-before-spawn invariant (ADR-0019).
        _captures_module._workers = _captures_module.start_capture_pool(data_dir)
        lifespan_tasks: list[asyncio.Task] = []
        startup_runtime = await start_app_runtime(
            data_dir,
            deps=StartupRuntimeDeps(
                env=os.environ,
                start_scheduler=start_scheduler,
                start_live_stream=start_live_stream,
                start_kiwoom_watchdog=start_kiwoom_session_watchdog,
                # 0J/0U 오버레이 — signal alert·today promoter 와 같은 bus.publish 주입.
                start_sector_broadcast=functools.partial(
                    start_sector_broadcast, bus.publish,
                ),
                # Inject the event bus so a real Today Promotion fires a
                # promotion_completed event (WS 푸시 승격 무효화). Same
                # bus.publish injection shape as configure_signal_alert_monitor.
                start_today_promoter=functools.partial(
                    start_today_promoter, on_promoted=bus.publish,
                ),
                stop_today_promoter=stop_today_promoter,
                stop_live_stream=stop_live_stream,
                aclose_kis_capacity_scheduler=kiwoom_rest_runtime.aclose,
                aclose_kis_client=aclose_kis_client,
                get_kiwoom_capture_codes=get_kiwoom_capture_codes,
                # 아래에서 채워지는 리스트를 **늦게** 읽는다 — 이 시점엔 아직 비어 있다.
                get_lifespan_tasks=lambda: lifespan_tasks,
                # ADR-0088 확장: 캡처 워커 풀과 프로그램매매 수집기도 liveness 를
                # 노출한다. 둘은 lifespan/라이브 런타임이 각각 소유해 런타임이 핸들을
                # 들고 있지 않으므로 접근자로 주입한다(호출 시점에 다시 읽는다).
                get_capture_worker_tasks=lambda: _captures_module._workers,
                get_program_trade_task=get_program_trade_task,
                get_inventory_observer=lambda: observer,
                load_symbol_disk_state=_symbols_module.load_disk_state,
                needs_symbol_boot_refresh=_symbols_module.needs_boot_refresh,
                refresh_symbols=_symbols_module.refresh,
                resolve_symbol_master_path=resolve_symbol_master_path,
            ),
        )
        # ADR-0088: expose lifespan-owned task liveness at GET /api/live/status.
        _app.state.startup_runtime = startup_runtime
        # 거래일 달력 오버레이 갱신(PR-H·#1044). **배선이 빠져 있었다** — 함수만
        # 만들고 lifespan 에 안 달아 오버레이가 자라지 않았고, 정적 시드 생성일
        # 다음 날부터 오늘이 커버리지 밖이 됐다(실측 2026-08-04).
        # lifespan 이 소유하는 주기 태스크들. `start_app_runtime` 이 **이보다 먼저**
        # 불리므로 liveness 접근자(`get_lifespan_tasks`)가 이 리스트를 늦게 읽는다.
        lifespan_tasks.extend([
            start_trading_calendar_refresher(data_dir),
            await _start_last_ob_persistence(data_dir),
        ])
        # 컴퓨트 풀 예열(ADR-0169) — 첫 range 요청이 spawn+import(실측 ≈0.4초)를 내지
        # 않게 워커 하나씩 미리 띄운다. `lifespan_tasks` 에 넣지 않는 이유: 그 목록은
        # 감독 대상이라 one-shot 이 끝나면 `dead` 로 읽혀 deep health 가 503 이 된다.
        # 참조만 붙들어 GC 를 막는다. 실패는 prewarm 이 삼키고 첫 요청이 대신 치른다.
        _app.state.compute_prewarm = asyncio.create_task(
            pools.prewarm(str(data_dir)), name="compute-prewarm",
        )

        # GC gen0 임계 상향 — **기동이 끝난 뒤** 건다(상주 객체가 다 올라온 시점).
        gc_prev_threshold = gc.get_threshold()
        gc_gen0 = gc_gen0_threshold()
        if gc_gen0 > 0:
            gc.set_threshold(gc_gen0, *GC_UPPER_GEN_THRESHOLDS)
        # 임계를 **거는 곳에서 재기도 한다**. 이 값이 정지 시간을 좌우하는데 지금까지
        # 그 결과를 보는 눈이 없었다 — 2026-09-04 에 GC 정지를 손으로 재야 했다.
        gc_probe.install(warn_ms=gc_probe.pause_warn_ms_from_env())
        try:
            yield
        finally:
            # 복원은 **프로덕션이 아니라 테스트를 위한 것**이다. 프로세스가 오래 사는
            # 운영에서는 의미가 없지만, `TestClient` 는 한 pytest 프로세스 안에서
            # 앱을 수백 번 만든다 — 복원이 없으면 이 전역 설정이 그 프로세스 전체로
            # 새어 GC 동작에 의존하는 다른 테스트를 흔든다.
            gc.set_threshold(*gc_prev_threshold)
            # 콜백도 임계와 같은 이유로 뗀다 — TestClient 가 앱을 수백 번 만들면
            # 콜백이 그만큼 쌓여 수집마다 전부 불린다.
            gc_probe.uninstall()
            await _cancel_tasks(*lifespan_tasks)
            # 컴퓨트 워커 프로세스(ADR-0169). **예열 태스크를 먼저 취소한다** — 아직 spawn
            # 을 기다리는 중에 풀을 내리면 그 future 가 BrokenProcessPool 로 끝나
            # `run()` 이 풀을 버리며 경고를 남긴다(정상 종료·TestClient teardown 마다
            # 가짜 경고). 취소는 CancelledError 라 prewarm 의 `except Exception` 을
            # 지나쳐 조용히 끝난다. 그다음 동기 shutdown — 진행 중 작업은 기다리지
            # 않는다(요청은 어차피 서버와 함께 끊긴다).
            await _cancel_tasks(_app.state.compute_prewarm)
            install_default_compute_pools(None)
            pools.shutdown()
            _app.state.startup_runtime = None
            # 스크리너 갱신 job 은 KIS capacity scheduler/client 를 쓰므로
            # startup_runtime.stop()(KIS teardown 포함)보다 먼저 cancel+await.
            await _screener_module.shutdown_update_job()
            # 심볼 .mst 리프레시 워커는 코디네이터-소유(호출자와 분리)라
            # symbols-boot-refresh 태스크 취소만으론 멈추지 않는다. KIS/스케줄러
            # teardown 전에 명시적으로 cancel+await(worker-owned lifecycle).
            await _symbols_module.aclose_refresh()
            await startup_runtime.stop()
            # Stop the worker pool first so in-flight items observe cancellation
            # while bus + observer are still live (they emit terminal events).
            await _captures_module.stop_workers(_captures_module._workers)
            _captures_module._workers = []
            # Best-effort cancel of any in-flight items at shutdown — raw files
            # are preserved on disk for Resume. Spec §9 documents this behavior.
            cancel_all_on_shutdown()
            # ADR-0094: release the queue flock so a successor (e.g. --reload
            # restart) can acquire it. flock also auto-releases on process exit,
            # but explicit release makes handoff prompt.
            # 큐를 포함한 **모든** writer 락을 놓는다. --reload 재기동이 앞선
            # 프로세스의 teardown 과 겹치는데, 후임이 재시도 창(4×0.5s) 안에
            # 잡으려면 해제가 즉시여야 한다.
            from hoga.api.ownership import release_all  # noqa: PLC0415
            release_all()
            observer.stop()
            observer.join()
            engine.close()
            set_captures_bus(None, None)

    app = FastAPI(title="hoga-ops API", version=APP_VERSION, lifespan=lifespan)
    # 허용 출처는 여기서 한 번만 확정해 CORS 와 OriginGuard 양쪽에 넘긴다 —
    # 두 방어층이 다른 목록을 보는 상태를 구조적으로 못 만들게.
    origins = allowed_origins()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # **HTTP 응답 압축은 없다 — GZipMiddleware 를 의도적으로 제거했다(ADR-0154).**
    # 되돌리기 전에 그 ADR 을 읽을 것. 요지는 압축이 **막지 않는 전송 시간을 막는
    # CPU 시간으로 바꾸는** 거래라는 것이다: 이 앱은 `--workers` 를 못 써서(#998)
    # 단일 이벤트 루프가 REST·WS·스케줄러를 전부 처리하므로, 압축이 도는 동안
    # **그 요청만이 아니라 앱 전체**가 멈춘다. 반면 전송은 async 소켓 쓰기라 아무도
    # 안 막는다. 2026-08-21 실측(sidecar 3개월 29.2MB): 압축 CPU 813ms 로 루프백
    # 전송 9.3ms 를 아꼈다 — 87배 손해다.
    #
    # 다시 넣고 싶으면 **레벨을 낮추는 것이 아니라 바인드 주소로 분기**하는 형태여야
    # 한다(루프백=끔, tailscale=켬). 무조건 켜기는 dev 에서 항상 손해다.
    # 상태 변경 요청의 Origin 검사. **CORSMiddleware 보다 바깥**이어야 한다 —
    # add_middleware 는 나중에 추가한 것이 바깥이므로 CORS 뒤에 온다.
    #
    # CORS 는 이걸 못 막는다: Starlette 은 OPTIONS + access-control-request-method
    # 일 때만 preflight 로 차단하고, 나머지는 origin 이 화이트리스트 밖이어도
    # 핸들러를 실행한 뒤 응답 헤더만 뺀다. 게다가 이 API 에는 파라미터가 없는
    # 상태변경 라우트가 6개 있어(cancel-all·catchup 등) body 파싱이 없고, 그러면
    # form-urlencoded 로 도달해 **preflight 자체가 생기지 않는다**. 자세한 근거는
    # hoga/api/origin_guard.py docstring 참고.
    app.add_middleware(OriginGuardMiddleware, allowed_origins=origins)
    # WS5: 요청 TTFB 타이밍 — 마지막에 추가해 최외곽(전 구간 측정)으로 배선.
    # OriginGuard 보다 바깥이라 차단된 요청도 타이밍 로그에 남는다.
    app.add_middleware(RequestTimingMiddleware)
    # Liveness probe. Used by the Playwright e2e webServer config and by any
    # process supervisor that needs a no-side-effects 200 OK.
    #
    # `?deep=1` 은 **readiness** 다: 프로세스가 살아 있다는 것만으로는 부족한 질문에
    # 답한다. 배경 태스크가 전멸해도 얕은 /health 는 200 이므로, 감독자가 그걸 물면
    # "살아 있지만 아무 일도 안 하는" 프로세스를 영원히 방치한다(ADR-0064 실패 모드).
    # deep 은 조용히 죽은 태스크가 하나라도 있으면 503 을 내 감독자가 재시작할 수
    # 있게 한다 — 미기동(env 로 끈 기능)은 실패로 세지 않는다.
    #
    # 부작용 없음(메모리 상태 읽기)이므로 감독자가 짧은 주기로 물어도 안전하다.
    @app.get("/health")
    def _health(deep: bool = False, gc_objects: bool = False) -> JSONResponse:
        # version·commit 은 얕은 쪽에도 싣는다(#998) — dev/prod 2대 운영에서 "이
        # 포트에 뜬 게 어느 코드인가" 는 liveness 만큼 자주 묻는 질문이다.
        # 업그레이드 성공 판정은 commit 으로 한다: VERSION 은 손으로 올리는 값이라
        # 갱신을 빠뜨리면 '항상 같은 값' 이 되어 검증이 무신호가 된다.
        if not deep:
            shallow = {"status": "ok", "version": APP_VERSION, "commit": APP_COMMIT}
            HealthResponse.model_validate(shallow)  # 계약 검사 — body 는 원본 그대로 나간다
            return JSONResponse(shallow)
        runtime = getattr(app.state, "startup_runtime", None)
        if runtime is None:
            # lifespan 밖(부팅 중·종료 중·테스트) — 판정 근거가 없다. 감독자가
            # 부팅 중을 실패로 오해하지 않도록 200 + 미확정을 명시한다.
            booting = {
                "status": "ok", "version": APP_VERSION, "commit": APP_COMMIT,
                "checks": {"supervised_tasks": "unknown"},
            }
            HealthResponse.model_validate(booting)
            return JSONResponse(booting)
        tasks = runtime.supervised_task_health()
        dead = [t["name"] for t in tasks if t.get("state") == "dead"]
        # 큐 소유권(#998): 비소유 부팅은 이전엔 deep 어디에도 안 드러났다 —
        # 워커 행이 "dead" 가 아니라 **생략**되는 형태라(captures.py 비소유 부팅
        # 시 워커 0개) 감독자가 read-only prod 를 영원히 방치했다. env 옵트아웃
        # (도그푸딩 read-only)은 의도이므로 실패로 세지 않는다 — 세면
        # HOGA_CAPTURE_QUEUE_DISABLED=1 인스턴스가 무한 재시작된다(미기동을
        # 실패로 안 세는 위 원칙과 같은 이유).
        queue = _captures_module.queue_ownership_state()
        queue_anomaly = not queue["owned"] and not queue["disabled_by_env"]
        # 디스크(#998): 관측 전용 — is_low 여도 503 을 내지 않는다. 503 은
        # 워치독의 재시작 신호인데 재시작은 디스크를 비우지 못한다(경고는
        # 스케줄러 일일 prune 로그가 담당).
        head = disk_headroom(data_dir)
        degraded = bool(dead) or queue_anomaly
        body: dict[str, object] = {
            "status": "degraded" if degraded else "ok",
            "version": APP_VERSION,
            "commit": APP_COMMIT,
            "dead_tasks": dead,
            "queue": queue,
            "disk": None if head is None else {
                "free_pct": round(head.free_pct, 1),
                "free_gib": round(head.free_bytes / 1024**3, 1),
                "low": head.is_low,
            },
            "supervised_tasks": tasks,
            "gc": _gc_health_section(gc_objects),
        }
        HealthResponse.model_validate(body)
        return JSONResponse(body, status_code=503 if degraded else 200)

    app.include_router(build_router(engine, compute=pools))
    app.include_router(build_ws_router(bus, live_get_buffer))
    app.include_router(
        build_captures_router(data_dir=data_dir, client_factory=client_factory)
    )
    app.include_router(
        build_symbols_router(path=resolve_symbol_master_path(), data_dir=data_dir)
    )
    # PR-H(#1044): 거래일 달력이 data_dir 오버레이를 보게 한다. 시드는 패키지에
    # 붙어 있어 이 호출 없이도 답하지만, 커밋 이후의 새 거래일은 오버레이에 있다.
    calendar_module.set_data_dir(data_dir)
    app.include_router(build_calendar_router(data_dir=data_dir))
    app.include_router(build_watchlist_router(data_dir=data_dir, bus=bus))
    app.include_router(build_heatmap_router(data_dir=data_dir, bus=bus, compute=pools))
    app.include_router(build_screener_router(data_dir=data_dir, bus=bus, compute=pools))
    app.include_router(build_signal_alert_router(data_dir=data_dir))
    app.include_router(build_sentiment_router(data_dir=data_dir))
    app.include_router(build_market_router(data_dir=data_dir))
    # 저장뷰 캡처-공백 자동 복구 훅은 제거됐다(2026-08-07) — 복구본 네임스페이스
    # (`kis_api`)와 함께 기능을 접었다. 근거는 `sources.SourceName` 주석: 복구본이
    # 메우던 것은 **캔들뿐**이고 캔들은 벤더가 과거를 다시 준다(우회 OFF 기본 경로).
    app.include_router(build_study_view_router(data_dir=data_dir, bus=bus))
    app.include_router(build_live_layout_preset_router(data_dir=data_dir, bus=bus))
    app.include_router(
        build_live_router(
            get_status=live_get_status,
            get_buffer=live_get_buffer,
            on_control=_live_control,
            get_today_ask_peak=live_get_today_ask_peak,
            get_today_bid_peak=live_get_today_bid_peak,
            get_vi_status=live_get_vi_status,
            # data_dir 은 여기서 닫는다 — 라우터는 경로 조립을 몰라도 되고,
            # live_root 규약(`<data_dir>/live_kiwoom`)은 lifecycle 한 곳에만 있다.
            ensure_today_peaks_seeded=lambda code, venue, date: (
                live_ensure_today_peaks_seeded(code, venue, date, data_dir=data_dir)
            ),
            data_dir=data_dir,
        )
    )
    if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
        app.include_router(build_test_router(data_dir))
    # prod 프론트 서빙(ADR-0134 §4). env opt-in — dev 는 vite 가 서빙한다.
    # 모든 라우터 include 뒤에 마운트해야 /api·/health 가 정적에 안 가린다.
    frontend_dist = os.environ.get("HOGA_FRONTEND_DIST")
    if frontend_dist:
        mount_frontend(app, Path(frontend_dist))
    app.state.engine = engine
    app.state.compute = pools
    return app


# Logger namespaces that get the durable file sink.
#
# ``hoga`` — our own modules.
# ``uvicorn.error`` — where uvicorn logs "Exception in ASGI application" with
#   the traceback for anything that escapes a route. uvicorn configures this
#   logger with ``propagate: False``, so it never reaches the root logger and
#   a handler on ``hoga`` alone does not see it. Result before this: an
#   unhandled 500 left its traceback on stderr only, and stderr is gone the
#   moment the terminal scrolls or the process is restarted by a supervisor.
#   That is the single most valuable line in the file and it was the one line
#   guaranteed not to be in it.
_FILE_LOG_NAMESPACES = ("hoga", "uvicorn.error")


def _ensure_file_logging() -> None:
    """Attach a rotating file handler to the durable log namespaces.

    Called from default_app() (the uvicorn factory) — NOT create_app(), so
    the test app never writes log files. Idempotent per namespace: skips a
    logger that already has a RotatingFileHandler for the same file, so
    ``uvicorn --reload`` re-imports don't stack handlers.

    propagate is left untouched so console output (uvicorn's default) is
    unchanged — this only adds a durable file sink. Terminal-only logs meant
    KIS WS rejection codes couldn't be confirmed post-hoc (2026-07-15).
    """
    log_dir = resolve_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "hoga.log"
    target = str(log_path)
    for name in _FILE_LOG_NAMESPACES:
        logger = logging.getLogger(name)
        if any(
            isinstance(h, RotatingFileHandler) and h.baseFilename == target
            for h in logger.handlers
        ):
            continue
        handler = RotatingFileHandler(
            log_path, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        handler.setLevel(logging.INFO)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
        )
        logger.addHandler(handler)
        # Only lower the threshold — never raise it above a caller's explicit level.
        if logger.level == logging.NOTSET or logger.level > logging.INFO:
            logger.setLevel(logging.INFO)


def default_app() -> FastAPI:
    """Factory used by uvicorn.

    Delegates to ``resolve_data_dir()`` (HOGA_DATA_DIR env →
    XDG_DATA_HOME/hoga-ops/data → ~/.local/share/hoga-ops/data).
    Captures from any branch / worktree share the same store, so heavy
    raw-TSV downloads aren't duplicated.

    Also loads .env so ``uvicorn --reload`` (which bypasses
    ``hoga.cli.serve``) still picks up KIS_APP_KEY / KIS_APP_SECRET. The CLI
    entry point calls ``load_env()`` too; the discovery cache makes the
    second call a no-op.
    """
    load_env()
    _ensure_file_logging()
    data_dir = resolve_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    # 요청 경로 CPU 작업용 워커 프로세스 풀(ADR-0169). `create_app` 이 아니라 여기서
    # 만드는 이유는 promoter 와 같다 — TestClient 는 앱을 수백 번 만들고, 그쪽은 스레드다.
    compute = build_compute_pools(worker_log_path=resolve_log_dir() / "hoga.log")
    return create_app(data_dir, compute=compute)
