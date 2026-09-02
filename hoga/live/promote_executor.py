"""프로모터 전용 워커 프로세스 (ADR-0168) — `hoga.compute_executor` 의 1워커 특수화.

풀 자체의 설계(spawn 명시 · 깨진 풀 재생성 · 고아 방지 · 자식 로그)는 공용 모듈로
올라갔다(ADR-0169 가 요청 경로에도 같은 풀을 쓴다). 여기 남은 것은 프로모터 고유의
결정 둘이다:

- **워커 1개.** 증분 파싱 오프셋(`promote._TODAY_PARSE_STATES`)이 워커 프로세스 안에
  산다. 워커가 여럿이면 같은 종목이 다른 워커에 떨어져 각자 처음부터 다시 읽는다.
  하나면 지금과 같은 의미다. 워커가 죽어 재생성되면 오프셋이 0 으로 돌아가 다음
  사이클에 하루치를 다시 읽는다 — 결과는 같고 그 사이클만 느리다.
- **모듈 기본 실행기.** 17:00 일배치(`promote.promote_pending` ← scheduler)는
  today-promoter 와 배선이 달라 실행기를 인자로 받을 자리가 없다. 기동 시 설치된 기본
  실행기를 쓰고, 설치된 것이 없으면(테스트·프로모터 비활성 기동) 종전대로 스레드다.

운영 기본은 `process`, `HOGA_LIVE_TODAY_PROMOTE_EXECUTOR=thread` 가 종전 동작이다.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TypeVar

from hoga.compute_executor import (
    DEFAULT_EXECUTOR_KIND,
    ComputeExecutor,
    ExecutorKind,
    _nested_spawn_probe,
    _orphan_probe,
    _worker_pid,
    executor_kind_from_env as _executor_kind_from_env,
)

__all__ = [
    "DEFAULT_EXECUTOR_KIND",
    "ENV_EXECUTOR_KIND",
    "ExecutorKind",
    "PromoteExecutor",
    "_nested_spawn_probe",
    "_orphan_probe",
    "_worker_pid",
    "default_executor",
    "executor_kind_from_env",
    "install_default",
    "run_promote_job",
]

ENV_EXECUTOR_KIND = "HOGA_LIVE_TODAY_PROMOTE_EXECUTOR"

T = TypeVar("T")


def executor_kind_from_env(env: Mapping[str, str] | None = None) -> ExecutorKind:
    """`HOGA_LIVE_TODAY_PROMOTE_EXECUTOR` → ``process``(기본) | ``thread``."""
    return _executor_kind_from_env(ENV_EXECUTOR_KIND, env)


class PromoteExecutor(ComputeExecutor):
    """프로모터 실행기 — 워커 **1개**로 고정한 `ComputeExecutor`(위 docstring)."""

    def __init__(
        self,
        kind: ExecutorKind = DEFAULT_EXECUTOR_KIND,
        *,
        worker_gc_thresholds: tuple[int, int, int] | None = None,
        worker_log_path: Path | None = None,
    ) -> None:
        super().__init__(
            kind,
            max_workers=1,
            name="promote",
            worker_gc_thresholds=worker_gc_thresholds,
            worker_log_path=worker_log_path,
        )


# ── 모듈 기본 실행기 ────────────────────────────────────────────────────────────

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
