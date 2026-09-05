"""CPU 작업을 이벤트 루프 프로세스 밖으로 — 공용 워커 프로세스 풀 (ADR-0168 · ADR-0169).

## 왜 프로세스인가 — 스레드로는 안 된다

이 앱은 단일 프로세스·단일 이벤트 루프가 키움 WS 5계정 수신과 브라우저 팬아웃을 다
맡는다(#998 — `--workers` 불가). 그 프로세스 안에서 **순수 파이썬 CPU 작업이 워커
스레드에서 돌면** 루프는 GIL 을 5ms switch interval 단위로 구걸하는 convoy 에 빠진다.
실측(2026-09-02): 루프 GIL 점유 90%대 → 6~11%, 키움 소켓 커널 Recv-Q 1~9MB, 호가 프레임
나이 평균 0.6초 → 3.5~6.5초. `hoga.api.bundle` 의 `_gil_breathe` 가 같은 현상의 이전
처방이었고 `/health` 9.7초가 남았다.

GIL 은 **프로세스 단위**다. 작업을 자식 프로세스로 보내면 루프는 GIL 을 아무와도
나누지 않는다. 이 모듈은 그 자식 프로세스 풀 하나를 `ComputeExecutor` 로 감싼다.
today-promoter(ADR-0168, 워커 1개)와 요청 경로 컴퓨트 풀(ADR-0169, `hoga.api.compute_pools`)
이 같은 클래스를 쓴다.

## 설계 결정

- **`spawn` 명시.** 이 프로세스는 스레드가 250개를 넘는다(anyio·polars·tokio). fork 는
  안전하지 않고, 파이썬 3.14 의 리눅스 기본이 forkserver 로 바뀌었으므로 암묵 기본에
  기대지 않는다. uvicorn `--reload` 자체가 spawn 자식 안에서 앱을 돌리므로 여기서
  또 spawn 하는 것은 **중첩 spawn** 이다(테스트가 그 경로를 재현한다).
- **입력은 부모가 계산한다.** 자식은 심볼 마스터도 달력 오버레이도 없는 빈 프로세스다.
  인프로세스 상태에서 나오는 값은 부모가 인자로 넘긴다. 워커에서 도는 함수는 인자만
  보는 **모듈 최상위 함수**여야 한다(클로저는 pickle 이 안 된다).
- **예외는 껍데기로 나른다.** Starlette `HTTPException` 은 `Exception.__init__` 을 안
  불러 `args` 가 비고, 부모의 unpickle 이 TypeError 를 내면 풀 관리 스레드가 **풀이
  깨진 것으로** 처리한다 — 400 하나가 뒤따르는 모든 요청을 죽인다. 작업 함수는
  `hoga.api.compute_jobs` 의 가드로 감싸 picklable 예외로 바꿔 던진다.
- **깨진 풀은 버린다.** `BrokenProcessPool` 이 나면 참조를 놓아 다음 `run()` 이 새 풀을
  만든다. 안 그러면 남은 요청이 전부 죽은 풀에 실패한다.
- **테스트는 스레드로.** `kind="thread"` 는 `asyncio.to_thread` 그대로다. 프로세스 풀을
  앱 인스턴스마다 띄우면 TestClient 가 앱을 수백 번 만드는 pytest 가 느려지고,
  monkeypatch 도 자식에 안 닿는다.
- **자식 로그.** 자식엔 핸들러가 없어 WARNING 미만이 사라진다. 부모가 쓰는 `hoga.log` 에
  `WatchedFileHandler` 로 붙인다 — 회전은 부모의 `RotatingFileHandler` 가 하고 자식은
  따라가기만 한다(같은 파일에 회전기가 둘이면 경쟁한다).
- **고아 방지는 워커가 스스로.** 부모가 `kill -9` 로 죽으면 풀 워커는 안 죽는다(실측 —
  `_exit_when_orphaned` 참조). ppid 감시 스레드가 1초 안에 워커를 끝낸다.
- **워커 환경변수.** `worker_env` 는 initializer 가 `os.environ` 에 먼저 넣는다 — DuckDB
  상한처럼 env 를 읽는 하위 모듈(`hoga.duck.connect_bounded`)에 값을 전달하는 통로다.
"""
from __future__ import annotations

import asyncio
import gc
import logging
import multiprocessing
import os
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from logging.handlers import WatchedFileHandler
from pathlib import Path
from typing import Literal, TypeVar

_log = logging.getLogger(__name__)

ExecutorKind = Literal["process", "thread"]
DEFAULT_EXECUTOR_KIND: ExecutorKind = "process"

T = TypeVar("T")


def parse_executor_kind(raw: str | None, *, var_name: str) -> ExecutorKind:
    """``process``(기본) | ``thread``. 모르는 값은 기본값으로 떨어뜨리고 경고 한 줄 —
    오타로 서버가 안 뜨는 것보다 낫다(`gc_gen0_threshold` 와 같은 규약)."""
    value = (raw or "").strip().lower()
    if value in ("process", "thread"):
        return value  # type: ignore[return-value]
    if value:
        _log.warning(
            "compute.executor.bad_env %s=%r — %s 로 기동", var_name, raw, DEFAULT_EXECUTOR_KIND,
        )
    return DEFAULT_EXECUTOR_KIND


def executor_kind_from_env(var_name: str, env: Mapping[str, str] | None = None) -> ExecutorKind:
    source = os.environ if env is None else env
    return parse_executor_kind(source.get(var_name), var_name=var_name)


# ── 워커 프로세스 쪽 ───────────────────────────────────────────────────────────

def _worker_init(
    gc_thresholds: tuple[int, int, int] | None,
    log_path: str | None,
    worker_env: dict[str, str] | None,
    name: str,
) -> None:
    """spawn 된 워커의 초기화. **여기서 `hoga.api.app` 을 import 하지 말 것** — 앱 전체가
    자식에 올라온다. 필요한 값은 전부 인자로 받는다."""
    if worker_env:
        os.environ.update(worker_env)
    if gc_thresholds is not None:
        gc.set_threshold(*gc_thresholds)
    if log_path:
        handler = WatchedFileHandler(log_path, encoding="utf-8")
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter(
            f"%(asctime)s %(levelname)s %(name)s [{name}-worker pid=%(process)d] %(message)s"
        ))
        logger = logging.getLogger("hoga")
        logger.addHandler(handler)
        if logger.level == logging.NOTSET or logger.level > logging.INFO:
            logger.setLevel(logging.INFO)
    threading.Thread(
        target=_exit_when_orphaned, args=(os.getppid(),), name="parent-watchdog", daemon=True,
    ).start()


def _exit_when_orphaned(parent_pid: int, poll_s: float = 1.0) -> None:
    """부모가 사라지면 워커도 끝낸다.

    `ProcessPoolExecutor` 워커는 부모가 SIGKILL 로 죽어도 **스스로 끝나지 않는다** —
    실측(2026-09-02): 부모를 `kill -9` 한 뒤 20초가 지나도 워커가 살아서 subreaper 에
    입양돼 있었다. 호출 큐의 파이프를 워커도 쥐고 있어 EOF 가 안 오기 때문이다.
    uvicorn `--reload` 가 앱 프로세스를 갈아 끼우는 개발 환경에서 이 고아가 쌓이면
    `pkill -f` 사고(메모리 참조)로 번진다. ppid 가 바뀌는 순간(= 부모 사망 후 입양)
    `os._exit` 한다 — 정리할 것이 없다: 쓰기는 원자적이고 상태는 재계산 가능하다.
    """
    while True:
        time.sleep(poll_s)
        if os.getppid() != parent_pid:
            os._exit(0)


def _worker_pid() -> int:
    """진단·테스트용 — 호출이 어느 프로세스에서 실행됐는지."""
    return os.getpid()


def _nested_spawn_probe(queue) -> None:  # noqa: ANN001 — multiprocessing.Queue 는 컨텍스트별 타입
    """spawn 자식 **안에서** 이 실행기를 만들어 한 번 왕복한다 — uvicorn `--reload` 가
    앱을 spawn 자식에서 돌리는 구조의 재현. 테스트가 `spawn` Process 의 target 으로 쓴다."""
    async def _go() -> dict[str, int]:
        ex = ComputeExecutor("process")
        try:
            return {"outer_pid": os.getpid(), "child_pid": await ex.run(_worker_pid)}
        finally:
            ex.shutdown()

    queue.put(asyncio.run(_go()))


def _orphan_probe(queue) -> None:  # noqa: ANN001 — multiprocessing.Queue 는 컨텍스트별 타입
    """워커를 띄우고 그 pid 를 알린 뒤 **영원히 잔다** — 테스트가 이 프로세스(부모 역)를
    `kill -9` 하고 워커가 스스로 사라지는지 본다(`_exit_when_orphaned`)."""
    async def _go() -> int:
        ex = ComputeExecutor("process")
        return await ex.run(_worker_pid)

    queue.put({"parent": os.getpid(), "worker": asyncio.run(_go())})
    while True:
        time.sleep(3600)


# ── 부모 쪽 ────────────────────────────────────────────────────────────────────

class ComputeExecutor:
    """CPU 작업을 돌릴 자리 — 프로세스 풀(기본) 또는 스레드(종전 동작).

    풀은 첫 `run()` 에서 게으르게 만든다. 기동을 spawn 비용(수 초)으로 붙잡지 않고,
    테스트처럼 한 번도 안 부르는 인스턴스는 프로세스를 아예 안 띄운다.
    """

    def __init__(
        self,
        kind: ExecutorKind = DEFAULT_EXECUTOR_KIND,
        *,
        max_workers: int = 1,
        name: str = "compute",
        worker_gc_thresholds: tuple[int, int, int] | None = None,
        worker_log_path: Path | None = None,
        worker_env: Mapping[str, str] | None = None,
    ) -> None:
        self.kind: ExecutorKind = kind
        self.max_workers = max(1, int(max_workers))
        self.name = name
        self._gc_thresholds = worker_gc_thresholds
        self._log_path = str(worker_log_path) if worker_log_path is not None else None
        self._worker_env = dict(worker_env) if worker_env else None
        self._pool: ProcessPoolExecutor | None = None
        self._lock = threading.Lock()
        # 프로세스의 내부 큐에 미리 넣으면 Future가 실행 전에도 RUNNING이 되어
        # 취소할 수 없다. 워커 자리만큼만 제출하고 나머지는 취소 가능한 await로 둔다.
        self._slots = asyncio.Semaphore(self.max_workers)
        #: 깨진 풀을 버리고 새로 만든 횟수 — 워커가 반복해서 죽으면 이 값이 자란다.
        self.respawns = 0

    def _ensure_pool(self) -> ProcessPoolExecutor:
        with self._lock:
            if self._pool is None:
                self._pool = ProcessPoolExecutor(
                    max_workers=self.max_workers,
                    mp_context=multiprocessing.get_context("spawn"),
                    initializer=_worker_init,
                    initargs=(self._gc_thresholds, self._log_path, self._worker_env, self.name),
                )
            return self._pool

    async def run(self, fn: Callable[..., T], /, *args: object) -> T:
        """`fn(*args)` 를 실행기에서 돌린다. 프로세스 모드에서는 `fn` 이 **모듈 최상위
        함수**여야 하고 인자·반환값·예외가 pickle 돼야 한다(클로저 불가)."""
        if self.kind == "thread":
            return await asyncio.to_thread(fn, *args)
        await self._slots.acquire()
        pool = None
        try:
            pool = self._ensure_pool()
            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(pool, fn, *args)
        except BrokenProcessPool:
            self._slots.release()
            self._discard_pool(pool)
            raise
        except BaseException:
            self._slots.release()
            raise
        # 호출자가 떠나도 실행 중인 작업의 자리는 실제 완료 때 반환한다. 먼저
        # 반납하면 취소된 CPU 작업 위에 새 작업을 계속 쌓게 된다.
        future.add_done_callback(lambda done: self._release_slot(done, pool))
        return await asyncio.shield(future)

    def _release_slot(self, future: asyncio.Future, pool: ProcessPoolExecutor) -> None:
        # 이탈한 호출자의 작업이 풀을 깨뜨린 경우도 회수한다. 새 대기자를 깨우기
        # 전에 죽은 풀을 버리고, 옛 작업이 교체된 새 풀을 버리지 않게 신원을 확인한다.
        error = None if future.cancelled() else future.exception()
        if isinstance(error, BrokenProcessPool):
            _log.warning(
                "compute.executor.broken name=%s — 워커 프로세스가 죽었다. 이 풀을 버리고 "
                "다음 호출에서 새로 만든다.", self.name,
                exc_info=(type(error), error, error.__traceback__),
            )
            self._discard_pool(pool)
        self._slots.release()

    def _discard_pool(self, expected: ProcessPoolExecutor | None = None) -> None:
        with self._lock:
            if expected is not None and self._pool is not expected:
                return
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
            self.respawns += 1

    def worker_pids(self) -> list[int]:
        """살아 있는 워커 프로세스 PID — 진단·테스트용(스레드 모드면 빈 목록)."""
        pool = self._pool
        if pool is None:
            return []
        procs = getattr(pool, "_processes", None) or {}
        return [p.pid for p in procs.values() if p.pid is not None]

    def shutdown(self) -> None:
        """풀을 내린다. 진행 중인 작업은 기다리지 않는다 — 종료 경로는 이미 취소
        상태일 수 있고, 워커 쪽 쓰기는 원자적이라 중간에 끊겨도 반쪽 파일이 안 남는다."""
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
