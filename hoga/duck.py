"""Central DuckDB connection factory.

Every in-process DuckDB connection must come from here so that a single
runaway query can never take the whole server down: the default
``memory_limit`` for an in-memory DuckDB is 80% of physical RAM and its
default ``temp_directory`` is ``<cwd>/.tmp`` — both caused the 2026-07-05
356GB spill / repeated uvicorn OOM kills.

**설정이 같으면 인스턴스를 공유하고 커서를 내준다** (2026-07-30). 이전에는 호출
때마다 `duckdb.connect(":memory:")` 로 **새 인스턴스**를 만들었는데, DuckDB 의
``memory_limit`` 은 인스턴스마다 따로 적용되므로 위 목적이 달성되지 않았다 —
동시 생존 N 개면 실효 상한은 N × 8 GiB 다. 실측(32코어):

* 인스턴스 1개당 스레드 **+31개**, `memory_limit` **별도** 8 GiB
* 생성+쿼리 7.72 ms vs 기존 인스턴스의 커서 0.25 ms (**31배**)
* 가동 중 백엔드의 스레드 261개 중 98개가 DuckDB 워커 → 인스턴스 약 3개 동시
  생존 → 실효 상한 24 GiB

커서는 같은 인메모리 DB 를 공유하므로 상한·스레드 풀도 공유한다(실측: 커서
양쪽 모두 `current_setting('memory_limit')` = 인스턴스 설정값). 부모 커넥션이
스레드 안전하지 않다는 제약은 그대로라 **호출부에는 항상 커서를 준다** —
`QueryEngine.conn` 이 2026-05-23 동시요청 30건으로 검증한 것과 같은 패턴이다.

트레이드오프(실측, 127 MiB parquet 집계 3회): 인스턴스를 붙들고 있으므로 상주가
**+48 MiB** 늘어난다(36→46→48 로 수렴). 매번 파기하던 예전 방식은 0 이었다. 대신
천장이 24 GiB → 8 GiB 로 내려간다 — 바닥 48 MiB 를 주고 천장 16 GiB 를 받는 거래다.

캐시 키가 (limit, temp_dir, max_temp) 인 이유: 프로덕션은 설정이 하나뿐이라
인스턴스가 정확히 1개가 되고, 테스트는 서로 다른 `temp_directory` 를 주는 것만으로
격리된다(리셋 훅을 잊어서 생기는 결합이 없다).

주의 — 공유 DB 에서 `CREATE VIEW` 는 **전역**이라 동시 호출끼리 이름이 충돌한다
(실측: `Catalog Error: View with name "v" already exists`). 커서 로컬이 필요하면
`CREATE TEMP VIEW` 나 `register()` 를 써라(둘 다 실측으로 격리 확인).
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

import duckdb

from hoga.config import resolve_data_dir

DEFAULT_MEMORY_LIMIT = "8.0 GiB"
DEFAULT_MAX_TEMP_SIZE = "50.0 GiB"

_instances: dict[tuple[str, str, str], duckdb.DuckDBPyConnection] = {}
_instances_lock = threading.Lock()


def connect_bounded(
    *,
    memory_limit: str | None = None,
    temp_directory: Path | None = None,
    max_temp_directory_size: str | None = None,
) -> duckdb.DuckDBPyConnection:
    """설정이 같은 프로세스 공유 인스턴스의 **커서**. 근거는 모듈 docstring.

    호출부는 그대로 `.execute()` / `.close()` 를 쓰면 된다 — 커서를 닫아도 공유
    인스턴스는 살아 있다.
    """
    limit = memory_limit or os.environ.get("HOGA_DUCKDB_MEMORY_LIMIT", DEFAULT_MEMORY_LIMIT)
    tmp = (
        resolve_data_dir() / "duckdb-tmp"
        if temp_directory is None
        else temp_directory
    )
    tmp.mkdir(parents=True, exist_ok=True)
    max_tmp = max_temp_directory_size or os.environ.get(
        "HOGA_DUCKDB_MAX_TEMP_SIZE", DEFAULT_MAX_TEMP_SIZE
    )
    return _instance((limit, str(tmp), max_tmp)).cursor()


def _instance(key: tuple[str, str, str]) -> duckdb.DuckDBPyConnection:
    """설정별 싱글턴. 동기 라우트가 AnyIO 워커 스레드에서 부르므로 락이 필요하다."""
    with _instances_lock:
        con = _instances.get(key)
        if con is None:
            limit, tmp, max_tmp = key
            con = duckdb.connect(
                database=":memory:",
                read_only=False,
                config={
                    "memory_limit": limit,
                    "temp_directory": tmp,
                    "max_temp_directory_size": max_tmp,
                },
            )
            _instances[key] = con
        return con


def reset_instances_for_tests() -> None:
    """공유 인스턴스 해제 — 인스턴스 생성 자체를 검증하는 테스트 전용."""
    with _instances_lock:
        for con in _instances.values():
            con.close()
        _instances.clear()
