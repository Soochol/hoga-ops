"""프로모터 전용 워커 프로세스(ADR-0168) — 실행기 계약.

프로세스 모드 테스트는 실제로 spawn 한다(각 수 초 — 자식이 pyarrow/polars 를 import
한다). 판정은 **어느 프로세스에서 돌았는가**(pid)와 **결과가 스레드 모드와 같은가**
(polars 프레임 비교)다. 바이트 비교는 안 한다 — parquet 메타데이터에 시각이 실린다.
"""
from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import signal
import time
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import polars as pl
import pytest

from hoga.api import startup_runtime
from hoga.live import lifecycle, promote as promote_mod, promote_executor as pe
from hoga.live.promote import _TODAY_PARSE_STATES, _today_kst_yyyymmdd, promote_kiwoom_today
from hoga.util.timeenc import hhmmssms_to_unix_ms


def _seed_jsonl(root: Path, code: str, today: str) -> Path:
    """`test_promote_kiwoom` 골든과 같은 모양의 하루치 JSONL(ob 2 · trade 2)."""
    jsonl_path = root / "live_kiwoom" / today / "KRX" / f"{code}.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    base_t = hhmmssms_to_unix_ms(today, 90000000)
    lines = []
    for tick in range(2):
        t = base_t + tick * 10_000
        lines.append(json.dumps({"t_ms": t, "kind": "ob", "payload": {
            "code": code, "t_ms": t,
            "asks": [{"price": 75000 + i, "qty": 100 + i} for i in range(10)],
            "bids": [{"price": 74990 - i, "qty": 200 + i} for i in range(10)],
            "total_ask_qty": 1500, "total_bid_qty": 2500, "phase": "regular",
        }}))
        lines.append(json.dumps({"t_ms": t, "kind": "trade", "payload": {
            "trades": [{"t_ms": t, "price": 75000, "qty": 5, "side": 1,
                        "side_source": "kiwoom_ws"}],
            "phase": "regular",
        }}))
    jsonl_path.write_text("\n".join(lines) + "\n")
    return jsonl_path


def _gone(pid: int, timeout_s: float = 15.0) -> bool:
    """프로세스가 사라졌거나 좀비(부모가 아직 회수 안 함)면 True."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            state = Path(f"/proc/{pid}/status").read_text().split("State:")[1].split()[0]
        except (FileNotFoundError, IndexError, ProcessLookupError):
            return True
        if state == "Z":
            return True
        time.sleep(0.1)
    return False


# ── 종류 선택 ───────────────────────────────────────────────────────────────────

def test_executor_kind_from_env_defaults_to_process_and_tolerates_junk() -> None:
    assert pe.executor_kind_from_env({}) == "process"
    assert pe.executor_kind_from_env({pe.ENV_EXECUTOR_KIND: "thread"}) == "thread"
    assert pe.executor_kind_from_env({pe.ENV_EXECUTOR_KIND: " Process "}) == "process"
    # 모르는 값은 서버를 안 세우고 기본값으로 — gc_gen0_threshold 와 같은 규약.
    assert pe.executor_kind_from_env({pe.ENV_EXECUTOR_KIND: "bogus"}) == "process"


def test_startup_builds_executor_kind_from_env() -> None:
    ex = startup_runtime._build_promote_executor({pe.ENV_EXECUTOR_KIND: "thread"})
    assert ex.kind == "thread"
    default = startup_runtime._build_promote_executor({})
    try:
        assert default.kind == "process"
        assert default.worker_pids() == []  # 풀은 게으르다 — 만들기만 해선 프로세스가 안 뜬다
    finally:
        default.shutdown()


# ── 실행 위치 ───────────────────────────────────────────────────────────────────

async def test_thread_kind_runs_in_this_process() -> None:
    ex = pe.PromoteExecutor("thread")
    assert await ex.run(pe._worker_pid) == os.getpid()
    assert ex.worker_pids() == []


async def test_process_kind_runs_in_a_child_and_shutdown_ends_it() -> None:
    ex = pe.PromoteExecutor("process")
    try:
        pid = await ex.run(pe._worker_pid)
        assert pid != os.getpid()
        assert ex.worker_pids() == [pid]
        # 같은 워커가 재사용된다 — 워커가 하나라는 것이 증분 오프셋 의미의 전제다.
        assert await ex.run(pe._worker_pid) == pid
    finally:
        ex.shutdown()
    assert _gone(pid), "shutdown 뒤에도 워커 프로세스가 살아 있다"


async def test_run_promote_job_prefers_explicit_then_installed_then_thread() -> None:
    class _Recording:
        def __init__(self) -> None:
            self.calls = 0

        async def run(self, fn, /, *args):
            self.calls += 1
            return fn(*args)

    explicit, installed = _Recording(), _Recording()
    pe.install_default(installed)  # type: ignore[arg-type]
    try:
        assert await pe.run_promote_job(pe._worker_pid, executor=explicit) == os.getpid()  # type: ignore[arg-type]
        assert (explicit.calls, installed.calls) == (1, 0)
        assert await pe.run_promote_job(pe._worker_pid) == os.getpid()
        assert (explicit.calls, installed.calls) == (1, 1)
    finally:
        pe.install_default(None)
    assert await pe.run_promote_job(pe._worker_pid) == os.getpid()  # 아무것도 없으면 스레드


# ── 결과 동등성 + 부모가 계산한 입력 ─────────────────────────────────────────────

async def test_process_promotion_matches_thread_promotion_and_nxt_comes_from_parent(
    tmp_path: Path, monkeypatch,
) -> None:
    """같은 JSONL → 두 실행기 → 같은 parquet. `nxt_enabled` 를 부모에서 False 로 패치해도
    **자식 결과**에 실려야 한다 — 자식은 패치를 못 보므로, 실리면 부모가 계산한 것이다."""
    today = _today_kst_yyyymmdd()
    monkeypatch.setattr(promote_mod, "_nxt_enabled_now", lambda code: False)
    _TODAY_PARSE_STATES.clear()
    root_thread, root_proc = tmp_path / "thread", tmp_path / "proc"
    _seed_jsonl(root_thread, "005930", today)
    _seed_jsonl(root_proc, "005930", today)

    by_thread = pe.PromoteExecutor("thread")
    by_process = pe.PromoteExecutor("process")
    try:
        assert await promote_kiwoom_today(root_thread, code="005930", executor=by_thread) == today
        assert await promote_kiwoom_today(root_proc, code="005930", executor=by_process) == today
        assert by_process.worker_pids() and by_process.worker_pids()[0] != os.getpid()
    finally:
        by_process.shutdown()

    venue_dir_thread = root_thread / "parquet" / today / "005930" / "kiwoom_live" / "KRX"
    venue_dir_proc = root_proc / "parquet" / today / "005930" / "kiwoom_live" / "KRX"
    written = sorted(p.name for p in venue_dir_thread.glob("*.parquet"))
    assert {"snapshots.parquet", "trades.parquet"} <= set(written)
    assert sorted(p.name for p in venue_dir_proc.glob("*.parquet")) == written
    for name in written:
        assert pl.read_parquet(venue_dir_thread / name).equals(
            pl.read_parquet(venue_dir_proc / name)
        ), name
    for root in (root_thread, root_proc):
        meta = json.loads((root / "parquet" / today / "005930" / "kiwoom_live" / "meta.json").read_text())
        assert meta["nxt_enabled"] is False, root.name
        assert meta["expected_venues"] == ["KRX"], root.name


async def test_promote_one_uses_installed_default_executor(tmp_path: Path) -> None:
    """17:00 일배치 경로(`promote_one`)는 인자 자리가 없어 설치된 기본 실행기를 탄다."""
    class _Recording:
        def __init__(self) -> None:
            self.fns: list[str] = []

        async def run(self, fn, /, *args):
            self.fns.append(fn.__name__)
            return fn(*args)

    today = _today_kst_yyyymmdd()
    jsonl_path = _seed_jsonl(tmp_path, "005930", today)
    rec = _Recording()
    pe.install_default(rec)  # type: ignore[arg-type]
    try:
        await promote_mod.promote_one(
            jsonl_path, tmp_path / "parquet", code="005930", date=today,
        )
    finally:
        pe.install_default(None)
    assert rec.fns == ["_promote_one_sync"]
    assert (tmp_path / "parquet" / today / "005930" / "kiwoom_live" / "KRX" / "meta.json").exists()


# ── 죽은 풀 · 중첩 spawn ─────────────────────────────────────────────────────────

async def test_broken_pool_is_rebuilt_on_next_call() -> None:
    """워커가 죽으면 그 호출은 실패하되 **다음 호출은 새 풀로 성공**해야 한다 — 안 그러면
    그 사이클의 나머지 종목이 전부 죽은 풀에 실패한다."""
    ex = pe.PromoteExecutor("process")
    try:
        pid1 = await ex.run(pe._worker_pid)
        os.kill(pid1, signal.SIGKILL)
        assert _gone(pid1)
        with pytest.raises(BrokenProcessPool):
            await ex.run(pe._worker_pid)
        pid2 = await ex.run(pe._worker_pid)
        assert pid2 != pid1 and pid2 != os.getpid()
        assert ex.respawns == 1
    finally:
        ex.shutdown()


def test_worker_exits_on_its_own_when_parent_is_killed() -> None:
    """부모(앱 프로세스 역)를 `kill -9` 하면 워커가 몇 초 안에 스스로 사라져야 한다.
    풀 워커는 부모 사망에 반응하지 않으므로(실측 20초 생존) `_exit_when_orphaned` 가 한다."""
    ctx = multiprocessing.get_context("spawn")
    queue = ctx.Queue()
    parent = ctx.Process(target=pe._orphan_probe, args=(queue,))
    parent.start()
    try:
        info = queue.get(timeout=120)
        assert info["parent"] == parent.pid and info["worker"] != parent.pid
        os.kill(parent.pid, signal.SIGKILL)  # type: ignore[arg-type]
        parent.join(10)
        assert _gone(info["worker"], timeout_s=10.0), "부모가 죽었는데 워커가 살아 있다"
    finally:
        if parent.is_alive():
            parent.kill()
            parent.join(10)


def test_nested_spawn_roundtrip() -> None:
    """uvicorn `--reload` 는 앱을 spawn 자식에서 돌린다 — 그 안에서 또 spawn 하는 구조를
    재현한다. 워크트리 백엔드는 자격증명이 없어 프로모터를 안 띄우므로 이것이 유일한 증명."""
    ctx = multiprocessing.get_context("spawn")
    queue = ctx.Queue()
    proc = ctx.Process(target=pe._nested_spawn_probe, args=(queue,))
    proc.start()
    try:
        result = queue.get(timeout=120)
    finally:
        proc.join(30)
    assert result["outer_pid"] != os.getpid()
    assert result["child_pid"] not in (os.getpid(), result["outer_pid"])


# ── 루프 배선 ───────────────────────────────────────────────────────────────────

async def test_lifecycle_forwards_executor_only_when_given(tmp_path: Path, monkeypatch) -> None:
    """실행기가 없으면 종전 서명 그대로 부른다(기존 계약 테스트들이 `(data_dir, *, code)`
    로 대체하므로) — 있으면 `executor=` 로 넘긴다."""
    seen: list[dict] = []

    async def fake_promote(data_dir, *, code, **kwargs):  # noqa: ARG001 — 루프 계약 서명 그대로
        seen.append(kwargs)

    monkeypatch.setattr(lifecycle, "promote_kiwoom_today", fake_promote)
    sentinel = pe.PromoteExecutor("thread")

    task = await lifecycle.start_today_promoter(
        data_dir=tmp_path, get_kiwoom_capture_codes=lambda: ["005930"], interval_s=0.05,
    )
    await asyncio.sleep(0.08)
    await lifecycle.stop_today_promoter(task)
    assert seen and all(k == {} for k in seen)

    seen.clear()
    task = await lifecycle.start_today_promoter(
        data_dir=tmp_path, get_kiwoom_capture_codes=lambda: ["005930"], interval_s=0.05,
        executor=sentinel,
    )
    await asyncio.sleep(0.08)
    await lifecycle.stop_today_promoter(task)
    assert seen and all(k == {"executor": sentinel} for k in seen)
