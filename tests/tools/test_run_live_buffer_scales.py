from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from tools.run_live_buffer_scales import (
    MemoryHeadroom,
    MemoryProbeError,
    read_memory_headroom,
    run_scale_matrix,
)


def _write_proc_meminfo(proc_root: Path, available_kib: int) -> None:
    proc_root.mkdir(parents=True)
    (proc_root / "meminfo").write_text(
        f"MemTotal:       999999 kB\nMemAvailable:   {available_kib} kB\n",
        encoding="utf-8",
    )
    (proc_root / "self").mkdir()
    (proc_root / "self" / "cgroup").write_text("", encoding="utf-8")


def test_memory_headroom_uses_host_available_without_cgroup_limit(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    cgroup_root.mkdir()

    result = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert result == MemoryHeadroom(
        host_available_bytes=10 * 1024,
        cgroup_version=None,
        cgroup_limit_bytes=None,
        cgroup_current_bytes=None,
        cgroup_remaining_bytes=None,
        usable_headroom_bytes=10 * 1024,
    )


def test_memory_headroom_uses_smaller_finite_cgroup_v2_remaining(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    cgroup_root.mkdir()
    (cgroup_root / "memory.max").write_text("8000\n", encoding="utf-8")
    (cgroup_root / "memory.current").write_text("3000\n", encoding="utf-8")

    result = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert result.cgroup_version == "v2"
    assert result.cgroup_limit_bytes == 8_000
    assert result.cgroup_current_bytes == 3_000
    assert result.cgroup_remaining_bytes == 5_000
    assert result.usable_headroom_bytes == 5_000


def test_memory_headroom_treats_unlimited_cgroup_v2_as_host_only(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    cgroup_root.mkdir()
    (cgroup_root / "memory.max").write_text("max\n", encoding="utf-8")
    (cgroup_root / "memory.current").write_text("3000\n", encoding="utf-8")

    result = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert result.cgroup_version == "v2"
    assert result.cgroup_limit_bytes is None
    assert result.cgroup_current_bytes == 3_000
    assert result.cgroup_remaining_bytes is None
    assert result.usable_headroom_bytes == 10 * 1024


def test_memory_headroom_uses_finite_cgroup_v2_ancestor_of_unlimited_leaf(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    (proc_root / "self" / "cgroup").write_text(
        "0::/parent/child\n",
        encoding="utf-8",
    )
    leaf = cgroup_root / "parent" / "child"
    leaf.mkdir(parents=True)
    (leaf / "memory.max").write_text("max\n", encoding="utf-8")
    (leaf / "memory.current").write_text("1000\n", encoding="utf-8")
    parent = cgroup_root / "parent"
    (parent / "memory.max").write_text("8000\n", encoding="utf-8")
    (parent / "memory.current").write_text("3000\n", encoding="utf-8")

    result = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert result.cgroup_version == "v2"
    assert result.cgroup_limit_bytes == 8_000
    assert result.cgroup_current_bytes == 3_000
    assert result.cgroup_remaining_bytes == 5_000
    assert result.usable_headroom_bytes == 5_000


def test_memory_headroom_fails_closed_when_declared_cgroup_cannot_be_resolved(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    (proc_root / "self" / "cgroup").write_text(
        "0::/missing/leaf\n",
        encoding="utf-8",
    )
    ancestor = cgroup_root / "missing"
    ancestor.mkdir(parents=True)
    (ancestor / "memory.max").write_text("8000\n", encoding="utf-8")
    (ancestor / "memory.current").write_text("3000\n", encoding="utf-8")

    with pytest.raises(MemoryProbeError, match="declared cgroup v2"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_memory_headroom_fails_closed_when_process_cgroup_is_unreadable(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    (proc_root / "self" / "cgroup").unlink()
    cgroup_root.mkdir()
    (cgroup_root / "memory.max").write_text("8000\n", encoding="utf-8")
    (cgroup_root / "memory.current").write_text("3000\n", encoding="utf-8")

    with pytest.raises(MemoryProbeError, match="process cgroup membership"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_memory_headroom_uses_safe_cgroup_v1_fallback(tmp_path: Path) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    cgroup_root.mkdir()
    (cgroup_root / "memory.limit_in_bytes").write_text("9000\n", encoding="utf-8")
    (cgroup_root / "memory.usage_in_bytes").write_text("4000\n", encoding="utf-8")

    result = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert result.cgroup_version == "v1"
    assert result.cgroup_remaining_bytes == 5_000
    assert result.usable_headroom_bytes == 5_000


def test_scale_matrix_accepts_each_projected_scale_in_its_own_limited_child() -> None:
    output = io.StringIO()
    child_observations: list[tuple[int, int]] = []

    def run_child(scale: int, memory_limit_bytes: int) -> dict[str, int]:
        child_observations.append((scale, memory_limit_bytes))
        return {
            "codes": scale,
            "max_rss_bytes": scale * 10,
            "published_total": scale,
        }

    run_scale_matrix(
        scales=(1, 2, 4),
        ticks_per_code=1,
        levels=1,
        retention_ms=1,
        output=output,
        probe_headroom=lambda: MemoryHeadroom(
            host_available_bytes=1_000,
            cgroup_version=None,
            cgroup_limit_bytes=None,
            cgroup_current_bytes=None,
            cgroup_remaining_bytes=None,
            usable_headroom_bytes=1_000,
        ),
        resolve_memory_limit=lambda requested: requested,
        run_child=run_child,
    )

    rows = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [row["codes"] for row in rows] == [1, 2, 4]
    assert child_observations == [(1, 250), (2, 250), (4, 250)]


def test_scale_matrix_appends_one_skip_row_and_stops_after_first_rejection() -> None:
    output = io.StringIO()
    attempted_scales: list[int] = []

    def run_child(scale: int, memory_limit_bytes: int) -> dict[str, int]:
        attempted_scales.append(scale)
        return {
            "codes": scale,
            "max_rss_bytes": 100,
            "published_total": scale,
        }

    run_scale_matrix(
        scales=(1, 2, 8),
        ticks_per_code=10,
        levels=3,
        retention_ms=1_000,
        output=output,
        probe_headroom=lambda: MemoryHeadroom(
            host_available_bytes=500,
            cgroup_version="v2",
            cgroup_limit_bytes=700,
            cgroup_current_bytes=200,
            cgroup_remaining_bytes=500,
            usable_headroom_bytes=500,
        ),
        resolve_memory_limit=lambda requested: requested,
        run_child=run_child,
    )

    rows = [json.loads(line) for line in output.getvalue().splitlines()]
    assert attempted_scales == [1]
    assert len(rows) == 2
    skipped = rows[-1]
    assert skipped == {
        "record_type": "status",
        "workstream": "live_buffer_synthetic",
        "status": "SKIPPED_RESOURCE_GUARD",
        "reason": "projected_peak_exceeds_guard",
        "scale": 2,
        "host_available_bytes": 500,
        "cgroup_version": "v2",
        "cgroup_limit_bytes": 700,
        "cgroup_current_bytes": 200,
        "cgroup_remaining_bytes": 500,
        "usable_headroom_bytes": 500,
        "projected_peak_bytes": 200,
        "guard_limit_bytes": 125,
        "subprocess_memory_limit_bytes": 125,
        "deferred_command": [
            "uv",
            "run",
            "python",
            "tools/bench_live_buffer.py",
            "--codes",
            "2",
            "--ticks-per-code",
            "10",
            "--levels",
            "3",
            "--retention-ms",
            "1000",
        ],
    }


def test_scale_matrix_fails_closed_when_memory_limit_is_unavailable() -> None:
    output = io.StringIO()
    attempted_scales: list[int] = []

    run_scale_matrix(
        scales=(1, 50),
        ticks_per_code=1,
        levels=1,
        retention_ms=1,
        output=output,
        probe_headroom=lambda: MemoryHeadroom(
            host_available_bytes=1_000,
            cgroup_version=None,
            cgroup_limit_bytes=None,
            cgroup_current_bytes=None,
            cgroup_remaining_bytes=None,
            usable_headroom_bytes=1_000,
        ),
        resolve_memory_limit=lambda requested: None,
        run_child=lambda scale, limit: attempted_scales.append(scale) or {},
    )

    [skipped] = [json.loads(line) for line in output.getvalue().splitlines()]
    assert attempted_scales == []
    assert skipped["status"] == "SKIPPED_RESOURCE_GUARD"
    assert skipped["reason"] == "memory_limit_unavailable"
    assert skipped["scale"] == 1
    assert skipped["projected_peak_bytes"] is None
