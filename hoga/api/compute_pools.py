"""요청 경로 컴퓨트 풀 두 벌 — 넓은 요청과 좁은 요청을 다른 줄에 세운다 (ADR-0169).

`/api/range` 의 `_range_gate` 는 좁은 요청(30일 미만)을 **상한 없이** 통과시킨다.
`/live` 의 하루짜리 요청이 `/study` 의 다섯 달짜리 뒤에 갇히면 안 되기 때문이다(그
docstring). 스레드 시절엔 admitted 요청마다 스레드가 하나씩 있어 그 불변식이 저절로
지켜졌다. 프로세스 풀 하나는 **FIFO** 라 그걸 깬다 — 5분마다 오는 오늘 range 폴링
4건이 20초짜리 넓은 계산 뒤에 줄을 선다. 그래서 풀이 둘이다:

- **wide**: 넓은 range · `/api/brokers/series` · `/api/screener/pattern-search` ·
  `/api/heatmap/group-flow` — 초 단위 작업.
- **narrow**: 좁은 range — 오늘 폴링·스크롤백 청크. 밀리초~수백 ms.

둘 다 `HOGA_COMPUTE_EXECUTOR=thread` 면 종전 동작(스레드)이다 — 그때 `/api/range` 는
라우트의 옛 경로(`anyio.to_thread` + 모델 반환)를 그대로 타서 기존 테스트 이음새
(`hoga.api.routes.build_range_bundle` monkeypatch)가 산다.

워커 수 기본값(wide 3 · narrow 2)의 근거: 스레드 시절 상한 합(공유 2 + sidecar 2 +
candles 3 = 7)은 **GIL 하나**를 나누는 스레드 수였다. 프로세스는 각자 GIL 을 가지므로
3+2 로도 종전보다 처리량이 크고, 메모리는 워커당 DuckDB 상한(기본 2GiB)과 인터프리터
(실측 수백 MB)만큼 든다. 더 필요하면 env 로 올린다.
"""
from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from hoga.compute_executor import ComputeExecutor, ExecutorKind, executor_kind_from_env
from hoga.gc_tuning import gc_thresholds

log = logging.getLogger(__name__)

ENV_KIND = "HOGA_COMPUTE_EXECUTOR"
ENV_WIDE_WORKERS = "HOGA_COMPUTE_WIDE_WORKERS"
ENV_NARROW_WORKERS = "HOGA_COMPUTE_NARROW_WORKERS"
ENV_WORKER_DUCKDB_MEMORY_LIMIT = "HOGA_COMPUTE_DUCKDB_MEMORY_LIMIT"
ENV_WORKER_DUCKDB_THREADS = "HOGA_COMPUTE_DUCKDB_THREADS"

DEFAULT_WIDE_WORKERS = 3
DEFAULT_NARROW_WORKERS = 2
DEFAULT_WORKER_DUCKDB_MEMORY_LIMIT = "2.0 GiB"
DEFAULT_WORKER_DUCKDB_THREADS = "4"


def _int_env(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


@dataclass
class ComputePools:
    wide: ComputeExecutor
    narrow: ComputeExecutor

    @property
    def kind(self) -> ExecutorKind:
        return self.wide.kind

    def worker_pids(self) -> list[int]:
        return [*self.wide.worker_pids(), *self.narrow.worker_pids()]

    async def prewarm(self, data_dir: str | None = None) -> None:
        """풀마다 워커 하나를 미리 띄우고 번들 모듈 import 와 DuckDB 엔진 생성까지 끝내
        둔다 — 첫 요청이 그 비용(실측 +0.4~0.6초)을 내지 않게. 스레드 모드면 앱 프로세스
        안에서 같은 일을 하므로 사실상 no-op 이다. 기동을 붙잡지 않도록 lifespan 이
        백그라운드 태스크로 부른다; 실패해도 다음 요청이 풀을 만들므로 삼킨다."""
        from hoga.api.compute_jobs import warm_worker  # noqa: PLC0415 — 순환 절단(지연)

        for executor in (self.wide, self.narrow):
            try:
                await executor.run(warm_worker, data_dir)
            except Exception:  # noqa: BLE001 — 예열 실패는 첫 요청이 대신 치른다(로그만)
                log.warning("compute.prewarm.failed name=%s", executor.name, exc_info=True)

    def shutdown(self) -> None:
        self.wide.shutdown()
        self.narrow.shutdown()


def thread_pools() -> ComputePools:
    """스레드 모드 두 벌 — `create_app` 이 실행기를 안 받았을 때(테스트)의 기본."""
    return ComputePools(
        wide=ComputeExecutor("thread", name="compute-wide"),
        narrow=ComputeExecutor("thread", name="compute-narrow"),
    )


def build_compute_pools(
    env: Mapping[str, str] | None = None, *, worker_log_path: Path | None = None,
) -> ComputePools:
    """env 로 종류·크기·워커 DuckDB 상한을 정해 두 풀을 만든다. 풀은 게으르다 — 여기서
    프로세스가 뜨지 않는다."""
    source = os.environ if env is None else env
    kind = executor_kind_from_env(ENV_KIND, source)
    worker_env = {
        # `hoga.duck.connect_bounded` 가 이 이름을 읽는다 — 워커마다 상한을 따로 건다.
        "HOGA_DUCKDB_MEMORY_LIMIT": source.get(
            ENV_WORKER_DUCKDB_MEMORY_LIMIT, DEFAULT_WORKER_DUCKDB_MEMORY_LIMIT,
        ),
        ENV_WORKER_DUCKDB_THREADS: source.get(
            ENV_WORKER_DUCKDB_THREADS, DEFAULT_WORKER_DUCKDB_THREADS,
        ),
    }
    common = {
        "worker_gc_thresholds": gc_thresholds(source),
        "worker_log_path": worker_log_path,
        "worker_env": worker_env,
    }
    return ComputePools(
        wide=ComputeExecutor(
            kind, max_workers=_int_env(source, ENV_WIDE_WORKERS, DEFAULT_WIDE_WORKERS),
            name="compute-wide", **common,
        ),
        narrow=ComputeExecutor(
            kind, max_workers=_int_env(source, ENV_NARROW_WORKERS, DEFAULT_NARROW_WORKERS),
            name="compute-narrow", **common,
        ),
    )
