"""요청 경로 컴퓨트 풀(ADR-0169) — 작업 함수의 프로세스 경계 계약.

프로세스 모드 테스트는 실제로 spawn 한다(각 수 초). 판정 셋:
- **동등성**: 같은 Stock-Date 를 스레드로 계산한 결과와 워커 프로세스가 직렬화해 보낸
  바이트를 파싱한 결과가 같다.
- **예외 왕복**: 워커 안의 `HTTPException(400)` 이 부모에서 400 으로 돌아오고, **그 뒤
  같은 풀의 다음 작업이 성공**한다(껍데기 없이 보냈다면 unpickle 실패 = 깨진 풀).
- **줄 세우기**: 넓은 range 는 wide, 좁은 range 는 narrow 풀로 간다.
"""
from __future__ import annotations

import errno
import json
import os
import threading
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


async def test_faithfully_crossing_exception_is_not_flattened() -> None:
    """원형 그대로 건널 수 있는 예외는 껍데기로 바꾸지 않는다 — 호출자가 타입으로
    분기하기 때문이다(캡처 파이프라인의 관대 재시도·디스크 만수 판정)."""
    guarded = compute_jobs._picklable_errors(_boom)
    with pytest.raises(ValueError, match="worker exploded"):
        await compute_jobs.run_job(ComputeExecutor("thread"), guarded, "x")


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


# ── 남은 인프로세스 CPU 이관 (ADR-0169 후속) ────────────────────────────────────

async def test_stock_dates_job_carries_in_process_fail_streaks_across_the_boundary(
    tmp_path: Path, process_pool,
) -> None:
    """`_fail_streaks` 는 캡처 파이프라인의 **인프로세스** dict 다. 자식은 그것을 못 보므로
    부모가 스냅샷을 떠서 넘겨야 한다 — 넘어갔다면 차단 행이 응답에 실린다.

    파일이 하나도 없는 (code,date) 로 잡는 것이 요점이다: 디스크에서 나올 수 없는 행이
    결과에 있다면 그 근거는 넘긴 dict 뿐이다.
    """
    from hoga.api.fail_streak import ATTEMPT_CAP, streak_key
    from hoga.api.routes import compute_stock_dates

    streaks = {streak_key("000660", "20260602"): ATTEMPT_CAP + 1}
    expected = compute_stock_dates(QueryEngine(tmp_path), streaks)
    assert [(r.code, r.date, r.blocked) for r in expected] == [("000660", "20260602", True)]

    payload = await compute_jobs.run_job(
        process_pool, compute_jobs.stock_dates_job, str(tmp_path), streaks,
    )
    got = json.loads(payload)
    assert [(r["code"], r["date"], r["blocked"]) for r in got] == [("000660", "20260602", True)]
    assert got == json.loads(
        __import__("pydantic").TypeAdapter(list[type(expected[0])]).dump_json(expected, by_alias=True)
    )


async def test_stock_dates_job_empty_when_no_streaks_and_no_data(tmp_path: Path) -> None:
    payload = await compute_jobs.run_job(
        ComputeExecutor("thread"), compute_jobs.stock_dates_job, str(tmp_path), {},
    )
    assert json.loads(payload) == []


async def test_depth_daily_sweep_job_runs_in_a_worker(tmp_path: Path, process_pool) -> None:
    """캡처 파싱 훅이 부르던 스윕 — 앱 스레드 풀에서 9초 CPU 를 태우던 자리(GIL convoy)."""
    (tmp_path / "parquet").mkdir()
    res = await compute_jobs.run_job(
        process_pool, compute_jobs.depth_daily_sweep_job, str(tmp_path), CODE, DATE,
    )
    assert set(res) == {"scanned", "computed", "skipped", "no_data", "total_rows"}
    assert res["scanned"] == 0  # 대상 파케이가 없으니 훑을 것도 없다


async def test_run_default_wide_job_uses_installed_pools_then_falls_back(tmp_path: Path) -> None:
    """풀이 설치돼 있으면 wide 레인, 없으면 종전대로 스레드."""
    class _Recording:
        def __init__(self) -> None:
            self.calls = 0

        async def run(self, fn, /, *args):
            self.calls += 1
            return fn(*args)

    wide, narrow = _Recording(), _Recording()
    compute_pools.install_default(compute_pools.ComputePools(wide=wide, narrow=narrow))  # type: ignore[arg-type]
    try:
        assert await compute_jobs.run_default_wide_job(_worker_pid) == os.getpid()
        assert (wide.calls, narrow.calls) == (1, 0)
    finally:
        compute_pools.install_default(None)
    assert await compute_jobs.run_default_wide_job(_worker_pid) == os.getpid()
    assert wide.calls == 1  # 설치 해제 후에는 풀을 안 탄다


def test_create_app_installs_and_clears_the_default_pools(tmp_path: Path) -> None:
    """lifespan 종료가 기본 풀을 지운다 — 안 지우면 다음 앱 인스턴스가 내려간 풀을 붙잡는다."""
    assert compute_pools.default_pools() is None
    app = create_app(tmp_path)
    assert compute_pools.default_pools() is app.state.compute
    with TestClient(app):
        assert compute_pools.default_pools() is app.state.compute
    assert compute_pools.default_pools() is None


# ── 예외가 프로세스 경계를 원형으로 건너는가 (ADR-0169 후속: 캡처 파싱 이관) ──────
#
# 캡처 파이프라인은 파싱 예외의 **타입으로 분기한다**: 검증 실패 두 종은 관대 모드로
# 재시도하고, 디스크 만수(OSError + errno)는 「머신 탓」이라 fail_streak 를 태우지
# 않는다. 껍데기로 납작해지면 두 분기가 모두 죽고, 후자는 디스크를 비운 뒤에도 그날
# 시도된 모든 (code,date) 가 영구 차단되는 사고가 된다.

@compute_jobs._picklable_errors
def _raise_enospc(_: str) -> None:
    raise OSError(errno.ENOSPC, "No space left on device")


@compute_jobs._picklable_errors
def _raise_trade_validation(msg: str) -> None:
    from hoga.tables.trades import TradeValidationError

    raise TradeValidationError(msg)


class _Unpicklable(Exception):
    def __init__(self) -> None:
        super().__init__()
        self.sock = threading.Lock()  # pickle 불가 — 껍데기 경로로 가야 한다


@compute_jobs._picklable_errors
def _raise_unpicklable(_: str) -> None:
    raise _Unpicklable


async def test_os_error_keeps_its_type_and_errno_across_the_process_boundary(
    process_pool,
) -> None:
    """`isinstance(exc, OSError)` 와 `exc.errno` 로 갈리는 판정이 워커 너머에서도 산다."""
    with pytest.raises(OSError) as info:  # 아래에서 errno 로 좁힌다
        await compute_jobs.run_job(process_pool, _raise_enospc, "x")
    assert info.value.errno == errno.ENOSPC
    from hoga.api.captures import _is_local_disk_failure

    assert _is_local_disk_failure(info.value) is True, "디스크 만수 분류가 죽었다"


async def test_validation_error_keeps_its_type_across_the_process_boundary(
    process_pool,
) -> None:
    """관대 모드 재시도는 이 타입으로 갈린다 — 납작해지면 캡처가 실패로 뜬다."""
    from hoga.tables.trades import TradeValidationError

    with pytest.raises(TradeValidationError, match="cum_vol decreased"):
        await compute_jobs.run_job(
            process_pool, _raise_trade_validation, "cum_vol decreased at ts_ms=1")


async def test_unpicklable_exception_still_becomes_a_flat_runtime_error() -> None:
    """건널 수 없는 예외는 껍데기로 — 부모의 unpickle 실패는 **풀이 깨진 것**으로
    처리돼 뒤따르는 작업을 전부 죽인다."""
    with pytest.raises(RuntimeError) as info:
        await compute_jobs.run_job(ComputeExecutor("thread"), _raise_unpicklable, "x")
    assert "_Unpicklable" in str(info.value)
    assert "worker traceback" in str(info.value)


# ── 캡처 파싱 작업의 시임 ───────────────────────────────────────────────────────

async def test_capture_parse_job_goes_through_the_captures_seam(monkeypatch) -> None:
    """작업 함수는 `captures.parse_stock_date` 를 통해 부른다 — `hoga.parser` 에서 직접
    끌어오면 캡처 테스트들의 monkeypatch 를 지나쳐 진짜 파서가 조용히 돈다."""
    from hoga.api import captures

    seen: list[dict] = []
    monkeypatch.setattr(captures, "parse_stock_date", lambda **kw: seen.append(kw))
    await compute_jobs.run_default_wide_job(
        compute_jobs.capture_parse_job, "/tmp/x", "005930", "20260601", False,
    )
    await compute_jobs.run_default_wide_job(
        compute_jobs.capture_parse_job, "/tmp/x", "005930", "20260601", True,
    )
    assert [kw["lenient"] for kw in seen] == [False, True]
    assert seen[0]["code"] == "005930" and seen[0]["date"] == "20260601"
    assert str(seen[0]["data_dir"]) == "/tmp/x"


def test_captures_keeps_the_parse_seam_attribute() -> None:
    """`captures.parse_stock_date` 는 하중을 받는다 — 린터가 「미사용 import」로 지우면
    프로세스 모드에서 모든 캡처가 AttributeError 로 실패한다."""
    from hoga.api import captures
    from hoga.parser import parse_stock_date

    assert captures.parse_stock_date is parse_stock_date


async def test_capture_parse_job_reaches_the_real_parser_inside_a_worker(
    tmp_path: Path, process_pool,
) -> None:
    """워커가 `hoga.api.captures` 를 import 하고 진짜 파서까지 닿는지 — 원본이 없는
    (code,date) 라 파서가 실패하는데, 그 실패가 **원형 그대로** 부모에 닿는 것까지가
    한 묶음의 증명이다(워커에서 import 가 깨졌다면 다른 예외가 온다)."""
    with pytest.raises(OSError) as info:  # FileNotFoundError ⊂ OSError
        await compute_jobs.run_job(
            process_pool, compute_jobs.capture_parse_job,
            str(tmp_path), "005930", "20260601", False,
        )
    assert isinstance(info.value, FileNotFoundError)
    assert "20260601" in str(info.value) or "005930" in str(info.value)
