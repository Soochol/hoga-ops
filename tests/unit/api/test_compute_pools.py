"""요청 경로 컴퓨트 풀(ADR-0169) — 작업 함수의 프로세스 경계 계약.

프로세스 모드 테스트는 실제로 spawn 한다(각 수 초). 판정 셋:
- **동등성**: 같은 Stock-Date 를 스레드로 계산한 결과와 워커 프로세스가 직렬화해 보낸
  바이트를 파싱한 결과가 같다.
- **예외 왕복**: 워커 안의 `HTTPException(400)` 이 부모에서 400 으로 돌아오고, **그 뒤
  같은 풀의 다음 작업이 성공**한다(껍데기 없이 보냈다면 unpickle 실패 = 깨진 풀).
- **줄 세우기**: 넓은 range 는 wide, 좁은 range 는 narrow 풀로 간다.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from hoga.api import compute_jobs, compute_pools, routes
from hoga.api.app import create_app
from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine
from hoga.compute_executor import ComputeExecutor, _worker_pid

CODE = "005930"
DATE = "20260601"
OPEN_MS = 90_000_000
CLOSE_MS = 153_000_000


def _hms_native(h: int, m: int, s: int) -> int:
    return h * 10_000_000 + m * 100_000 + s * 1000


def _seed_stock_date(root: Path) -> None:
    """10단 전부 채운 연속거래 호가창 한 날 — `test_range_venue_isolation` 과 같은 모양."""
    d = root / "parquet" / DATE / CODE / "kiwoom_live" / "KRX"
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps({
        "regular_session_open_ms": OPEN_MS,
        "regular_session_close_ms": CLOSE_MS,
        "collection_complete": True,
        "is_partial": False,
    }))
    ts = [_hms_native(9, 0, 10), _hms_native(9, 1, 10), _hms_native(9, 2, 10)]
    n = len(ts)
    cols: dict = {"ts_ms": ts, "seq": list(range(1, n + 1))}
    for i in range(1, 11):
        cols[f"ask_p{i}"] = [100 + i] * n
        cols[f"ask_q{i}"] = [50 + i] * n
        cols[f"ask_d{i}"] = [0] * n
        cols[f"bid_p{i}"] = [100 - i] * n
        cols[f"bid_q{i}"] = [70 + i] * n
        cols[f"bid_d{i}"] = [0] * n
    cols["tot_ask"] = [sum(50 + i for i in range(1, 11))] * n
    cols["tot_ask_d"] = [0] * n
    cols["tot_bid"] = [sum(70 + i for i in range(1, 11))] * n
    cols["tot_bid_d"] = [0] * n
    pq.write_table(pa.table(cols), d / "snapshots.parquet")


def _range_kwargs(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "code": CODE, "from_date": DATE, "to_date": DATE, "bucket_ms": 60_000,
        "source_pref": "kiwoom_live", "venue": "KRX", "mode": "hoga",
    }
    base.update(overrides)
    return base


@pytest.fixture
def process_pool():
    ex = ComputeExecutor("process", max_workers=1, name="test-compute")
    yield ex
    ex.shutdown()


# ── 구성 ────────────────────────────────────────────────────────────────────────

def test_build_compute_pools_reads_env_and_stays_lazy() -> None:
    pools = compute_pools.build_compute_pools({
        compute_pools.ENV_KIND: "thread",
        compute_pools.ENV_WIDE_WORKERS: "5",
        compute_pools.ENV_NARROW_WORKERS: "bogus",  # 파싱 실패 → 기본값
    })
    assert pools.kind == "thread"
    assert (pools.wide.max_workers, pools.narrow.max_workers) == (5, compute_pools.DEFAULT_NARROW_WORKERS)
    default = compute_pools.build_compute_pools({})
    try:
        assert default.kind == "process"
        assert default.worker_pids() == []  # 만들기만 해선 프로세스가 안 뜬다
    finally:
        default.shutdown()


async def test_prewarm_spawns_one_worker_per_pool_and_warms_its_engine(tmp_path: Path) -> None:
    pools = compute_pools.ComputePools(
        wide=ComputeExecutor("process", max_workers=2, name="pw-wide"),
        narrow=ComputeExecutor("process", max_workers=2, name="pw-narrow"),
    )
    try:
        assert pools.worker_pids() == []
        await pools.prewarm(str(tmp_path))
        assert len(pools.wide.worker_pids()) == 1 and len(pools.narrow.worker_pids()) == 1
        # 같은(예열된) 워커가 다음 작업을 받는다 — 엔진이 이미 있어 첫 요청이 싸다.
        assert await pools.narrow.run(_worker_pid) == pools.narrow.worker_pids()[0]
    finally:
        pools.shutdown()


def test_worker_env_carries_duckdb_bounds() -> None:
    pools = compute_pools.build_compute_pools({compute_pools.ENV_WORKER_DUCKDB_MEMORY_LIMIT: "512 MiB"})
    try:
        env = pools.wide._worker_env
        assert env == {
            "HOGA_DUCKDB_MEMORY_LIMIT": "512 MiB",
            compute_pools.ENV_WORKER_DUCKDB_THREADS: compute_pools.DEFAULT_WORKER_DUCKDB_THREADS,
        }
    finally:
        pools.shutdown()


# ── 동등성 ──────────────────────────────────────────────────────────────────────

async def test_range_bundle_job_in_worker_matches_in_process_bundle(tmp_path: Path, process_pool) -> None:
    _seed_stock_date(tmp_path)
    expected = build_range_bundle(QueryEngine(tmp_path), **_range_kwargs()).model_dump(mode="json")

    payload, stats = await compute_jobs.run_job(
        process_pool, compute_jobs.range_bundle_job, str(tmp_path), _range_kwargs(),
    )
    assert process_pool.worker_pids() and await process_pool.run(_worker_pid) != os.getpid()
    assert json.loads(payload) == expected
    assert stats["segments"] == len(expected["segments"]) == 1
    assert stats["quote_ratio"] == len(expected["quote_ratio"]["points"]) > 0


async def test_thread_and_process_jobs_agree_byte_for_byte(tmp_path: Path, process_pool) -> None:
    _seed_stock_date(tmp_path)
    by_thread, _ = await compute_jobs.run_job(
        ComputeExecutor("thread"), compute_jobs.range_bundle_job, str(tmp_path), _range_kwargs(),
    )
    by_process, _ = await compute_jobs.run_job(
        process_pool, compute_jobs.range_bundle_job, str(tmp_path), _range_kwargs(),
    )
    assert by_thread == by_process


# ── 예외 왕복 ────────────────────────────────────────────────────────────────────

async def test_http_exception_in_worker_comes_back_as_400_and_pool_survives(tmp_path: Path, process_pool) -> None:
    _seed_stock_date(tmp_path)
    with pytest.raises(HTTPException) as info:
        await compute_jobs.run_job(
            process_pool, compute_jobs.range_bundle_job, str(tmp_path), _range_kwargs(mode="bogus"),
        )
    assert info.value.status_code == 400
    assert process_pool.respawns == 0
    # 껍데기 없이 HTTPException 을 보냈다면 여기서 BrokenProcessPool 이었다.
    payload, _ = await compute_jobs.run_job(
        process_pool, compute_jobs.range_bundle_job, str(tmp_path), _range_kwargs(),
    )
    assert json.loads(payload)["segments"]


def _boom(_: str) -> None:
    raise ValueError("worker exploded")


async def test_unexpected_worker_exception_becomes_runtime_error_with_traceback(process_pool) -> None:
    guarded = compute_jobs._picklable_errors(_boom)
    # 가드는 모듈 최상위 함수에 데코레이터로 붙어야 pickle 되므로 여기선 스레드로 계약만 본다.
    with pytest.raises(RuntimeError) as info:
        await compute_jobs.run_job(ComputeExecutor("thread"), guarded, "x")
    assert "ValueError('worker exploded')" in str(info.value)
    assert "worker traceback" in str(info.value)


# ── 라우트 배선 ─────────────────────────────────────────────────────────────────

def test_wide_and_narrow_ranges_pick_different_pools() -> None:
    assert routes._is_wide_range("20260101", "20260301") is True
    assert routes._is_wide_range("20260601", "20260601") is False


def test_range_route_in_process_mode_serves_worker_bytes(tmp_path: Path) -> None:
    """프로세스 모드에서 `/api/range` 는 워커가 직렬화한 바이트를 그대로 싣는다 — 스레드
    모드(기본 테스트 경로)의 응답과 파싱 결과가 같다."""
    _seed_stock_date(tmp_path)
    url = (
        f"/api/range?code={CODE}&from={DATE}&to={DATE}&bucket_ms=60000"
        "&source_pref=kiwoom_live&venue=KRX&mode=hoga"
    )
    with TestClient(create_app(tmp_path)) as thread_client:
        by_thread = thread_client.get(url)
    pools = compute_pools.ComputePools(
        wide=ComputeExecutor("process", max_workers=1, name="t-wide"),
        narrow=ComputeExecutor("process", max_workers=1, name="t-narrow"),
    )
    try:
        with TestClient(create_app(tmp_path, compute=pools)) as process_client:
            by_process = process_client.get(url)
            # 예열(lifespan)이 풀마다 워커 하나를 띄우므로 "wide 가 비었다" 로는 못 가른다 —
            # 어느 풀로 갔는지는 `_is_wide_range` 단위 테스트가 고정한다.
            assert pools.narrow.worker_pids() and pools.wide.worker_pids()
    finally:
        pools.shutdown()
    assert by_thread.status_code == by_process.status_code == 200
    assert by_process.headers["content-type"].startswith("application/json")
    assert by_process.json() == by_thread.json()


def test_brokers_series_route_returns_model_json(seed_brokers) -> None:
    """동기 라우트였던 거래원 시계열이 async + 컴퓨트 경로로 바뀌어도 응답 shape 은 그대로다."""
    client = seed_brokers("20260601", "005930", with_kiwoom_live=True)
    with client:
        r = client.get("/api/brokers/series?code=005930&date=20260601&venue=KRX&source_pref=kiwoom_live")
    assert r.status_code == 200
    body = r.json()
    assert body["date"] == "20260601" and body["source"] == "kiwoom_live"
    assert len(body["brokers"]) >= 1 and body["brokers"][0]["points"]
