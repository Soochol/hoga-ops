"""Startup runtime orchestration for the FastAPI lifespan."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

TaskOrNone = asyncio.Task | None


def live_startup_enabled_from_env(env: Mapping[str, str] | None = None) -> bool:
    """Whether the app should auto-start Live Capture on boot."""
    source = os.environ if env is None else env
    return source.get("HOGA_LIVE_STARTUP_ENABLED") == "true"


def today_promoter_enabled_from_env(env: Mapping[str, str] | None = None) -> bool:
    """Whether Today Promotion should run in the app lifespan."""
    source = os.environ if env is None else env
    return source.get("HOGA_LIVE_TODAY_PROMOTE_ENABLED", "true").lower() != "false"


def today_promoter_interval_from_env(env: Mapping[str, str] | None = None) -> float:
    """Today Promotion interval in seconds."""
    source = os.environ if env is None else env
    return float(source.get("HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S", "300"))


@dataclass(frozen=True)
class StartupRuntimeDeps:
    env: Mapping[str, str]
    start_scheduler: Callable[[Path], list[asyncio.Task]]
    start_live_stream: Callable[..., Awaitable[bool]]
    start_today_promoter: Callable[..., Awaitable[TaskOrNone]]
    stop_today_promoter: Callable[[TaskOrNone], Awaitable[None]]
    stop_live_stream: Callable[[], Awaitable[None]]
    aclose_kis_capacity_scheduler: Callable[[], Awaitable[None]]
    aclose_kis_client: Callable[[], Awaitable[None]]
    load_symbol_disk_state: Callable[..., None]
    needs_symbol_boot_refresh: Callable[[], bool]
    refresh_symbols: Callable[..., Awaitable[None]]
    resolve_symbol_master_path: Callable[[], Path]
    # 키움 WS 승격 대상 콜백(ADR-0116). 기본 None — 미주입이면 promoter가 키움 루프 skip.
    get_kiwoom_capture_codes: Callable[[], Sequence[str]] | None = None
    # 키움 세션 워치독 30s 루프 스포너(ADR-0118 §5). 기본 None — 미주입이면 미기동.
    start_kiwoom_watchdog: Callable[..., Awaitable[TaskOrNone]] | None = None
    #: 0J/0U 업종·지수 오버레이 브로드캐스트. 워치독과 같은 수명이다 — 키움 세션이
    #: 없으면 매 패스 no-op 이라 무자격 dev 에서도 안전하다.
    start_sector_broadcast: Callable[..., Awaitable[TaskOrNone]] | None = None
    # 캡처 워커 풀 태스크 접근자. 풀은 lifespan 이 start_app_runtime **전에** 띄워
    # captures._workers 에 담으므로 런타임이 핸들을 소유하지 않는다 — 매 호출 때 모듈
    # 속성을 다시 읽어야 하니 리스트가 아니라 콜러블로 받는다. 미주입이면 목록에서 생략.
    get_capture_worker_tasks: Callable[[], Sequence[asyncio.Task]] | None = None
    # 프로그램매매 수집기 태스크 접근자. 라이브 런타임 소유라 라이브 시작/정지에 따라
    # 생겼다 사라진다 — 없으면 "죽음"이 아니라 미기동이므로 목록에서 생략한다.
    get_program_trade_task: Callable[[], TaskOrNone] | None = None
    # 인벤토리 watchdog 옵서버(스레드). asyncio 태스크가 아니라 별도 판정이 필요하다.
    # 미주입이면 목록에서 생략.
    get_inventory_observer: Callable[[], object | None] | None = None


# 한 번 일하고 끝나는 것이 **계약**인 감독 태스크들. 이 이름들만 정상 반환을
# `completed`(경보 아님)로 센다 — 나머지는 영구 루프가 계약이므로 정상 반환도
# 조용한 죽음(ADR-0064)이다. 판정을 "예외로 끝났나"로만 두면 루프의 조용한 죽음이
# 통째로 안 보이게 되고, 반대로 "끝났나"로만 두면 one-shot 완료가 영구 503 이 된다.
#
# 이름을 키로 쓰는 이유: health 행 자체가 이미 이름으로 식별되고(테스트·UI·워치독
# 로그가 전부 이름을 읽는다) 태스크 객체는 생성처에서 여기까지 계약을 실어 나를
# 채널이 없다. 새 one-shot 을 감독 목록에 넣으면 **여기에도 등록**해야 한다.
ONE_SHOT_TASK_NAMES: frozenset[str] = frozenset({
    "watchlist-catchup",      # scheduler.start_scheduler — 부팅 캐치업 1회 스윕
    "symbols-boot-refresh",   # start_app_runtime — 심볼 마스터 1회 갱신
    "deriv-flow-catchup",     # scheduler.start_scheduler — 파생 마감 후 스냅샷 1회
})


def _task_health(name: str, task: TaskOrNone) -> dict[str, object]:
    """한 태스크의 정직한 상태 한 줄. 판정 근거는 supervised_task_health docstring."""
    if task is None:
        state = "not_started"
    elif not task.done():
        state = "running"
    elif task.cancelled() or task.exception() is not None:
        # cancelled() 를 먼저 본다 — 취소된 태스크에 exception() 을 물으면
        # CancelledError 를 되던진다. 실행 중 취소는 아무도 시키지 않았어야 할
        # 일이므로(정상 취소는 stop() 안에서만, 그때는 health 를 묻지 않는다)
        # one-shot 이라도 조용한 죽음과 같은 등급이다.
        state = "dead"
    elif name in ONE_SHOT_TASK_NAMES:
        state = "completed"
    else:
        state = "dead"
    return {"name": name, "running": state == "running", "state": state}


def _observer_health(name: str, observer: object | None) -> dict[str, object]:
    """watchdog 옵서버 **스레드**의 상태 한 줄. 값 어휘는 `_task_health` 와 같다.

    이 감독이 없으면 인벤토리 SSE 가 조용히 멈춘다. 옵서버는 parquet 트리 전체를
    recursive 로 watch 하는데, 트리가 커져 inotify watch 한도(`max_user_watches`)를
    소진하면 스레드가 죽고 — 그 뒤로 캡처가 끝나도 화면이 갱신되지 않는다. HTTP 는
    멀쩡하므로 얕은 health 로도, 태스크 목록으로도(스레드라 asyncio 태스크가 아니다)
    드러나지 않던 사각이었다.

    `is_alive()` 가 없는 객체는 판정 불가 → `not_started`(경보 아님). 감독 목적의
    코드가 타입 가정으로 죽으면 안 된다.
    """
    alive = getattr(observer, "is_alive", None)
    if observer is None or not callable(alive):
        return {"name": name, "running": False, "state": "not_started"}
    state = "running" if alive() else "dead"
    return {"name": name, "running": state == "running", "state": state}


@dataclass
class AppStartupRuntime:
    scheduler_tasks: list[asyncio.Task]
    today_promoter_task: TaskOrNone
    deps: StartupRuntimeDeps
    kiwoom_watchdog_task: TaskOrNone = None
    sector_broadcast_task: TaskOrNone = None

    def supervised_task_health(self) -> list[dict[str, object]]:
        """Honest alive/dead snapshot of each lifespan-owned background task.

        판정은 ADR-0064 의 정직한 health 규칙 — `task is not None and not
        task.done()` — 이고 staleness 휴리스틱이 아니다. `watchlist-daily-loop` 는
        폴링 틱 사이에 자고 있으므로 마지막 활동 시각으로 판정하면 종일 오경보가 난다.
        살아서 자는 태스크는 healthy 로 보고해야 한다. `done()` 인 태스크는 조용히 죽은
        루프(ADR-0064 의 실패 모드)이므로 unhealthy 다.

        **`state` 가 `running` 보다 정보량이 많다.** `running=False` 하나로는 "죽었다"
        와 "애초에 안 띄웠다(env 로 비활성 · 미주입)" 를 구별할 수 없다. 예컨대
        `HOGA_LIVE_TODAY_PROMOTE_ENABLED=false` 면 today-promoter 는 정상인데도
        영구히 `running=False` 다 — 이걸 UI 경보로 쓰면 배너가 상시 켜진다. 그래서
        네 값을 낸다:

        - `running`  — 살아 있음
        - `dead`     — 계약을 어기고 끝났다(조용한 죽음, **경보 대상**)
        - `completed` — one-shot 이 할 일을 마치고 정상 반환했다(경보 아님)
        - `not_started` — 핸들이 없다(비활성·미주입, 경보 아님)

        **`completed` 를 `dead` 에서 떼어내는 것이 load-bearing 이다.** 감독 목록에는
        루프뿐 아니라 one-shot 이 섞여 있다 — `watchlist-catchup`(부팅 캐치업,
        `HOGA_STARTUP_CATCHUP_ENABLED` 옵트인)과 `symbols-boot-refresh` 는 한 번
        일하고 정상 반환한다. `done()` 하나로 판정하던 판(2026-08-03 이전)에서는
        이들이 완료되는 순간 deep health 가 **영구 503** 이 되고, README 무인 운영
        절이 지시하는 워치독 타이머(5분)가 완벽히 건강한 서버를 무한 재시작했다 —
        장중이면 재시작마다 실시간 틱이 영구 소실된다. `not_started` 를 `dead` 에서
        떼어낸 것과 같은 이유이고, 같은 축의 반대쪽 끝이다.

        **단 "정상 반환 = 무사"가 아니다.** 영구 루프에게 정상 반환은 ADR-0064 가
        지목한 바로 그 조용한 죽음이다. 그래서 판정 기준은 예외 여부가 아니라
        태스크의 **계약**이고, 계약은 `ONE_SHOT_TASK_NAMES` 가 이름으로 못박는다.
        one-shot 이라도 예외·취소로 끝났으면 `dead` 다 — 실패한 캐치업은 계속
        보여야 한다.

        `running` 불리언은 하위호환으로 유지한다(`state == "running"` 과 동의).

        이 태스크들에는 설계상 자동 재시작 감독자가 없다(ADR-0088): 캡처 워커 풀과
        KIS 용량 워커는 자가 치유하고 WS 스트림 워치독이 WS/flush 태스크를 되살리지만,
        일일 루프 · today-promoter · 워치독 자신은 프로세스 재시작으로만 부활한다.
        살아 있음을 노출하는 것이 조용한 죽음을 감지 가능하게 만든다.
        """
        tasks: list[tuple[str, TaskOrNone]] = [
            *((t.get_name(), t) for t in self.scheduler_tasks),
            ("kiwoom-session-watchdog", self.kiwoom_watchdog_task),
            # 오버레이라 죽어도 화면이 안 비므로 **무증상**이다 — health 에 실어야
            # 조용한 죽음이 보인다(그게 이 목록의 취지다).
            ("kiwoom-sector-broadcast", self.sector_broadcast_task),
            ("today-promoter", self.today_promoter_task),
        ]
        if self.deps.get_capture_worker_tasks is not None:
            tasks.extend((t.get_name(), t) for t in self.deps.get_capture_worker_tasks())
        if self.deps.get_program_trade_task is not None:
            # 라이브가 꺼져 있으면 태스크가 없다 — 미기동을 dead 로 보고하지 않기 위해
            # 아예 목록에서 뺀다(not_started 로 넣으면 경보는 안 나지만 UI 가 "정지"
            # 행을 상시 보여 주게 되어 노이즈다).
            program_trade = self.deps.get_program_trade_task()
            if program_trade is not None:
                tasks.append(("program-trade-collector", program_trade))
        rows = [_task_health(name, task) for name, task in tasks]
        if self.deps.get_inventory_observer is not None:
            rows.append(
                _observer_health(
                    "inventory-observer", self.deps.get_inventory_observer()
                )
            )
        return rows

    async def stop(self) -> None:
        """Stop runtime-owned background work in shutdown order."""
        await self.deps.stop_today_promoter(self.today_promoter_task)
        await self.deps.stop_today_promoter(self.kiwoom_watchdog_task)
        await self.deps.stop_today_promoter(self.sector_broadcast_task)
        await self.deps.stop_live_stream()

        for task in self.scheduler_tasks:
            task.cancel()
        for task in self.scheduler_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("scheduler task crashed during shutdown")

        # 야간선물 WS — 스케줄러 태스크를 취소한 **뒤에** 닫는다. 먼저 닫으면 keeper 의
        # 다음 틱이 곧바로 다시 열어서 소켓이 종료를 넘어 살아남는다.
        from hoga.live.futures_runtime import aclose_runtime  # noqa: PLC0415 — 지연(순환)

        await aclose_runtime()

        await self.deps.aclose_kis_capacity_scheduler()
        await self.deps.aclose_kis_client()


async def start_app_runtime(
    data_dir: Path,
    *,
    deps: StartupRuntimeDeps,
) -> AppStartupRuntime:
    """Start scheduler, Live Capture helpers, Today Promotion, and symbol boot refresh."""
    runtime = AppStartupRuntime(
        scheduler_tasks=[],
        today_promoter_task=None,
        deps=deps,
    )
    try:
        runtime.scheduler_tasks = deps.start_scheduler(data_dir)

        # **심볼 마스터 로드가 라이브 기동보다 먼저다 — 순서가 계약이다.**
        # `coverage._compute_heatmap_codes`/`_compute_capture_candidates`는 심볼 마스터
        # 캐시가 비면 필터를 통째로 생략한다(fail-open). 라이브를 먼저 띄우면 부팅 첫
        # sync가 항상 그 무필터 경로를 타서, 같은 설정이 부팅 시점의 캐시 상태에 따라
        # 다른 저장셋을 만든다 — 그 크기는 키움 WS 슬롯 예산의 입력이다. 디스크 로드는
        # 순수 디스크 읽기(네트워크 없음)라 여기서 앞당겨도 새 실패 모드가 없고, 파일이
        # 없으면 커밋된 시드로 부팅하므로 자격증명 없이도 캐시가 찬다.
        symbol_master_path = deps.resolve_symbol_master_path()
        deps.load_symbol_disk_state(path=symbol_master_path, data_dir=data_dir)

        if live_startup_enabled_from_env(deps.env):
            await deps.start_live_stream(data_dir=data_dir)

        if deps.start_kiwoom_watchdog is not None:
            runtime.kiwoom_watchdog_task = await deps.start_kiwoom_watchdog()

        if deps.start_sector_broadcast is not None:
            runtime.sector_broadcast_task = await deps.start_sector_broadcast()

        # Today Promotion 은 JSONL → parquet **쓰기**라 data_dir 당 한 프로세스여야
        # 한다(ADR-0094 확장). 프로그램매매 사이드카와 `ws` 락을 공유한다 — 둘 다
        # 전제가 "살아 있는 키움 WS" 하나뿐이라 판정이 늘 같이 간다.
        #
        # 여기서 `available=True` 인 이유: 이 블록은 이미 자격·게이트를 통과한
        # 라이브 기동 경로 안이다(위 `start_live_stream` 성공 뒤). 무자격이면
        # 애초에 여기 오지 않으므로 무자격 선점 위험이 없다.
        from hoga.api import ownership  # noqa: PLC0415 — 지연 import(순환 절단)

        if today_promoter_enabled_from_env(deps.env) and ownership.acquire("ws", data_dir):
            runtime.today_promoter_task = await deps.start_today_promoter(
                data_dir=data_dir,
                get_kiwoom_capture_codes=deps.get_kiwoom_capture_codes,
                interval_s=today_promoter_interval_from_env(deps.env),
            )

        # 마스터 최신화(네트워크)는 라이브 뒤에 그대로 둔다 — 디스크/시드 로드와 달리
        # 벤더 호출이라 기동을 붙잡으면 안 된다. 부팅 저장셋은 위의 디스크 로드분으로 정해진다.
        if deps.needs_symbol_boot_refresh():
            runtime.scheduler_tasks.append(
                asyncio.create_task(
                    deps.refresh_symbols(path=symbol_master_path, data_dir=data_dir),
                    name="symbols-boot-refresh",
                )
            )
    except Exception:
        await runtime.stop()
        raise

    return runtime
