"""프로모터 전용 워커 프로세스 (ADR-0168).

## 왜 프로세스인가 — 스레드로는 안 된다

today-promoter(ADR-0043)는 5분마다 키움 수집 종목 전부(실측 314개)의 JSONL 을 파싱해
하루치 parquet 을 다시 쓴다. 순수 파이썬 CPU 라 `asyncio.to_thread` 로 내려도 **GIL 은
그대로 이 프로세스 안**에 있다. 실측(2026-09-02, 사용자 dev 백엔드): 사이클이 도는
45~140초 동안 워커 스레드가 코어 하나를 다 쓰고, 이벤트 루프의 GIL 점유율이 90%대에서
6~11% 로 떨어졌다. 그동안 키움 WS 소켓의 커널 Recv-Q 가 1~9MB 쌓였고, 브라우저에 닿는
호가 프레임의 나이(거래소 시각 대비)가 평균 0.6초 → 3.5~6.5초가 됐다. 루프가 5ms
switch interval 단위로 GIL 을 구걸하는 convoy 다 — `hoga.api.bundle` 의 `_gil_breathe`
주석이 같은 현상을 `/health` 9.7초로 적어 두었다. 이 앱은 `--workers` 를 못 쓰므로(#998)
그 루프 하나가 곧 앱 전체다.

GIL 은 **프로세스 단위**다. 작업을 자식 프로세스로 보내면 루프는 GIL 을 아무와도
나누지 않는다. 그래서 이 모듈은 `ProcessPoolExecutor` 하나를 든다.

## 설계 결정

- **워커 1개.** 증분 파싱 오프셋(`promote._TODAY_PARSE_STATES`)이 워커 프로세스 안에
  산다. 워커가 여럿이면 같은 종목이 다른 워커에 떨어져 각자 처음부터 다시 읽는다.
  하나면 지금과 같은 의미다. 워커가 죽어 재생성되면 오프셋이 0 으로 돌아가 다음
  사이클에 하루치를 다시 읽는다 — 결과는 같고 그 사이클만 느리다(쓰기는
  tempfile+rename 이라 찢어진 parquet 은 안 남는다).
- **`spawn` 명시.** 이 프로세스는 스레드가 250개를 넘는다(anyio·polars·tokio). fork 는
  안전하지 않고, 파이썬 3.14 의 리눅스 기본이 forkserver 로 바뀌었으므로 암묵 기본에
  기대지 않는다. uvicorn `--reload` 자체가 spawn 자식 안에서 앱을 돌리므로 여기서
  또 spawn 하는 것은 **중첩 spawn** 이다(테스트가 그 경로를 재현한다).
- **입력은 부모가 계산한다.** 자식은 심볼 마스터도 달력 오버레이도 없는 빈 프로세스다.
  `nxt_enabled` 처럼 인프로세스 상태에서 나오는 값은 부모가 인자로 넘긴다
  (`promote.promote_kiwoom_today`). 자식에서 마스터를 조회하면 전 종목이 「모름」이 돼
  meta 의 `expected_venues` 판정이 조용히 바뀐다.
- **깨진 풀은 버린다.** `BrokenProcessPool` 이 나면 참조를 놓아 다음 `run()` 이 새 풀을
  만든다. 안 그러면 그 사이클의 나머지 종목이 전부 죽은 풀에 실패한다.
- **테스트는 스레드로.** `kind="thread"` 는 종전 `asyncio.to_thread` 그대로다. 프로세스
  풀을 앱 인스턴스마다 띄우면 TestClient 가 앱을 수백 번 만드는 pytest 가 느려지고,
  monkeypatch 도 자식에 안 닿는다. 운영 기본은 `process` 이고
  `HOGA_LIVE_TODAY_PROMOTE_EXECUTOR=thread` 가 종전 동작으로 되돌리는 스위치다.
- **자식 로그.** 자식엔 핸들러가 없어 WARNING 미만이 사라진다. 부모가 쓰는 `hoga.log` 에
  `WatchedFileHandler` 로 붙인다 — 회전은 부모의 `RotatingFileHandler` 가 하고 자식은
  따라가기만 한다(같은 파일에 회전기가 둘이면 경쟁한다).
- **고아 방지는 워커가 스스로.** 부모가 `kill -9` 로 죽으면 풀 워커는 안 죽는다(실측 —
  `_exit_when_orphaned` 참조). ppid 감시 스레드가 1초 안에 워커를 끝낸다.
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
ENV_EXECUTOR_KIND = "HOGA_LIVE_TODAY_PROMOTE_EXECUTOR"
DEFAULT_EXECUTOR_KIND: ExecutorKind = "process"

T = TypeVar("T")


def executor_kind_from_env(env: Mapping[str, str] | None = None) -> ExecutorKind:
    """`HOGA_LIVE_TODAY_PROMOTE_EXECUTOR` → ``process``(기본) | ``thread``.

    모르는 값은 기본값으로 떨어뜨리고 경고 한 줄을 남긴다 — 오타로 서버가 안 뜨는
    것보다 낫다(`gc_gen0_threshold` 와 같은 규약).
    """
    source = os.environ if env is None else env
    raw = source.get(ENV_EXECUTOR_KIND, "").strip().lower()
    if raw in ("process", "thread"):
        return raw  # type: ignore[return-value]
    if raw:
        _log.warning(
            "live.promote.executor.bad_env %s=%r — %s 로 기동",
            ENV_EXECUTOR_KIND, raw, DEFAULT_EXECUTOR_KIND,
        )
    return DEFAULT_EXECUTOR_KIND


# ── 워커 프로세스 쪽 ───────────────────────────────────────────────────────────

def _worker_init(gc_thresholds: tuple[int, int, int] | None, log_path: str | None) -> None:
    """spawn 된 워커의 초기화. **여기서 `hoga.api.app` 을 import 하지 말 것** — 앱 전체가
    자식에 올라온다. 필요한 값은 전부 인자로 받는다."""
    if gc_thresholds is not None:
        gc.set_threshold(*gc_thresholds)
    if log_path:
        handler = WatchedFileHandler(log_path, encoding="utf-8")
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s [promote-worker pid=%(process)d] %(message)s"
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
        ex = PromoteExecutor("process")
        try:
            return {"outer_pid": os.getpid(), "child_pid": await ex.run(_worker_pid)}
        finally:
            ex.shutdown()

    queue.put(asyncio.run(_go()))


def _orphan_probe(queue) -> None:  # noqa: ANN001 — multiprocessing.Queue 는 컨텍스트별 타입
    """워커를 띄우고 그 pid 를 알린 뒤 **영원히 잔다** — 테스트가 이 프로세스(부모 역)를
    `kill -9` 하고 워커가 스스로 사라지는지 본다(`_exit_when_orphaned`)."""
    async def _go() -> int:
        ex = PromoteExecutor("process")
        return await ex.run(_worker_pid)

    queue.put({"parent": os.getpid(), "worker": asyncio.run(_go())})
    while True:
        time.sleep(3600)


# ── 부모 쪽 ────────────────────────────────────────────────────────────────────

class PromoteExecutor:
    """프로모터 작업을 돌릴 자리 — 프로세스 풀(기본) 또는 스레드(종전 동작).

    풀은 첫 `run()` 에서 게으르게 만든다. 기동을 spawn 비용(수 초)으로 붙잡지 않고,
    테스트처럼 한 번도 안 부르는 인스턴스는 프로세스를 아예 안 띄운다.
    """

    def __init__(
        self,
        kind: ExecutorKind = DEFAULT_EXECUTOR_KIND,
        *,
        worker_gc_thresholds: tuple[int, int, int] | None = None,
        worker_log_path: Path | None = None,
    ) -> None:
        self.kind: ExecutorKind = kind
        self._gc_thresholds = worker_gc_thresholds
        self._log_path = str(worker_log_path) if worker_log_path is not None else None
        self._pool: ProcessPoolExecutor | None = None
        self._lock = threading.Lock()
        #: 깨진 풀을 버리고 새로 만든 횟수 — 워커가 반복해서 죽으면 이 값이 자란다.
        self.respawns = 0

    def _ensure_pool(self) -> ProcessPoolExecutor:
        with self._lock:
            if self._pool is None:
                self._pool = ProcessPoolExecutor(
                    max_workers=1,
                    mp_context=multiprocessing.get_context("spawn"),
                    initializer=_worker_init,
                    initargs=(self._gc_thresholds, self._log_path),
                )
            return self._pool

    async def run(self, fn: Callable[..., T], /, *args: object) -> T:
        """`fn(*args)` 를 실행기에서 돌린다. 프로세스 모드에서는 `fn` 이 **모듈 최상위
        함수**여야 하고 인자·반환값이 pickle 돼야 한다(클로저 불가)."""
        if self.kind == "thread":
            return await asyncio.to_thread(fn, *args)
        pool = self._ensure_pool()
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(pool, fn, *args)
        except BrokenProcessPool:
            _log.warning(
                "live.promote.executor.broken — 워커 프로세스가 죽었다. 이 풀을 버리고 "
                "다음 호출에서 새로 만든다(증분 오프셋은 0 으로 돌아간다).",
                exc_info=True,
            )
            self._discard_pool()
            raise

    def _discard_pool(self) -> None:
        with self._lock:
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
        상태일 수 있고, 쓰기는 원자적이라 중간에 끊겨도 반쪽 파일이 안 남는다."""
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)


# ── 모듈 기본 실행기 ────────────────────────────────────────────────────────────
#
# 17:00 일배치(`promote.promote_pending` ← scheduler)는 today-promoter 와 배선이 달라
# 실행기를 인자로 받을 자리가 없다. 기동 시 설치된 기본 실행기를 쓰고, 설치된 것이
# 없으면(테스트·프로모터 비활성 기동) 종전대로 스레드다.

class _DefaultSlot:
    """모듈 기본 실행기를 담는 한 칸 — `global` 재대입 대신 속성 갱신(PLW0603)."""

    executor: PromoteExecutor | None = None


_slot = _DefaultSlot()


def install_default(executor: PromoteExecutor | None) -> None:
    _slot.executor = executor


def default_executor() -> PromoteExecutor | None:
    return _slot.executor


async def run_promote_job(
    fn: Callable[..., T], /, *args: object, executor: PromoteExecutor | None = None,
) -> T:
    """명시 실행기 > 설치된 기본 실행기 > `asyncio.to_thread` 순으로 `fn(*args)` 를 돌린다."""
    chosen = executor if executor is not None else _slot.executor
    if chosen is None:
        return await asyncio.to_thread(fn, *args)
    return await chosen.run(fn, *args)
