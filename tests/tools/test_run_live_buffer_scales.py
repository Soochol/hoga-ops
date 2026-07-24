from __future__ import annotations

import io
import json
import resource
from pathlib import Path

import pytest

from tools.run_live_buffer_scales import (
    MemoryHeadroom,
    MemoryProbeError,
    _apply_address_space_limit,
    read_memory_headroom,
    resolve_reliable_memory_limit,
    run_scale_matrix,
)

_V2_MOUNTINFO = (
    "36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
)


def _write_proc_meminfo(
    proc_root: Path,
    available_kib: int,
    *,
    membership: str = "0::/\n",
    mountinfo: str = _V2_MOUNTINFO,
) -> None:
    proc_root.mkdir(parents=True)
    (proc_root / "meminfo").write_text(
        f"MemTotal:       999999 kB\nMemAvailable:   {available_kib} kB\n",
        encoding="utf-8",
    )
    (proc_root / "self").mkdir()
    (proc_root / "self" / "cgroup").write_text(membership, encoding="utf-8")
    (proc_root / "self" / "mountinfo").write_text(mountinfo, encoding="utf-8")


def _write_proc_and_cgroup(
    tmp_path: Path,
    *,
    membership: str,
    mountinfo: str,
) -> tuple[Path, Path]:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(
        proc_root,
        available_kib=10,
        membership=membership,
        mountinfo=mountinfo,
    )
    cgroup_root.mkdir()
    return proc_root, cgroup_root


def _write_v2_limit(directory: Path, *, limit: int | str, current: int) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "memory.max").write_text(f"{limit}\n", encoding="utf-8")
    (directory / "memory.current").write_text(f"{current}\n", encoding="utf-8")


def _write_v1_limit(directory: Path, *, limit: int, current: int) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "memory.limit_in_bytes").write_text(
        f"{limit}\n",
        encoding="utf-8",
    )
    (directory / "memory.usage_in_bytes").write_text(
        f"{current}\n",
        encoding="utf-8",
    )


def test_memory_headroom_fails_closed_without_mapped_controller_files(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    cgroup_root.mkdir()

    with pytest.raises(MemoryProbeError, match="cgroup v2 memory controller"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_memory_headroom_uses_smaller_finite_cgroup_v2_remaining(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(proc_root, available_kib=10)
    cgroup_root.mkdir()
    _write_v2_limit(cgroup_root, limit=8_000, current=3_000)

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
    _write_v2_limit(cgroup_root, limit="max", current=3_000)

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
    _write_v2_limit(leaf, limit="max", current=1_000)
    parent = cgroup_root / "parent"
    _write_v2_limit(parent, limit=8_000, current=3_000)

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
    _write_v2_limit(ancestor, limit=8_000, current=3_000)

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
    _write_v2_limit(cgroup_root, limit=8_000, current=3_000)

    with pytest.raises(MemoryProbeError, match="process cgroup membership"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_memory_headroom_uses_safe_cgroup_v1_fallback(tmp_path: Path) -> None:
    proc_root = tmp_path / "proc"
    cgroup_root = tmp_path / "cgroup"
    _write_proc_meminfo(
        proc_root,
        available_kib=10,
        membership="5:memory:/\n",
        mountinfo=(
            "37 25 0:33 / /sys/fs/cgroup/memory rw - "
            "cgroup cgroup rw,memory\n"
        ),
    )
    cgroup_root.mkdir()
    _write_v1_limit(cgroup_root / "memory", limit=9_000, current=4_000)

    result = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert result.cgroup_version == "v1"
    assert result.cgroup_remaining_bytes == 5_000
    assert result.usable_headroom_bytes == 5_000


def test_v2_membership_is_mapped_relative_to_mount_root(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/docker/parent/child\n",
        mountinfo=(
            "36 25 0:32 /docker/parent /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
        ),
    )
    _write_v2_limit(cgroup_root / "child", limit=1_000, current=400)

    headroom = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert headroom.cgroup_remaining_bytes == 600


def test_malformed_membership_fails_closed(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="not-a-cgroup-membership\n",
        mountinfo=_V2_MOUNTINFO,
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="membership"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_empty_membership_fails_closed(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="",
        mountinfo=_V2_MOUNTINFO,
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="membership"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_hybrid_v1_is_used_when_mapped_v2_has_no_memory_controller(
    tmp_path: Path,
) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership=(
            "0::/unified/child\n"
            "5:memory:/docker/parent/child\n"
        ),
        mountinfo=(
            "36 25 0:32 /unified /sys/fs/cgroup/unified rw - "
            "cgroup2 cgroup rw\n"
            "37 25 0:33 /docker/parent /sys/fs/cgroup/memory rw - "
            "cgroup cgroup rw,memory\n"
        ),
    )
    _write_v1_limit(cgroup_root / "memory" / "child", limit=1_000, current=400)

    headroom = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert headroom.cgroup_version == "v1"
    assert headroom.cgroup_remaining_bytes == 600


def test_hybrid_partial_v2_memory_controller_fails_closed(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership=(
            "0::/unified/child\n"
            "5:memory:/docker/parent/child\n"
        ),
        mountinfo=(
            "36 25 0:32 /unified /sys/fs/cgroup/unified rw - "
            "cgroup2 cgroup rw\n"
            "37 25 0:33 /docker/parent /sys/fs/cgroup/memory rw - "
            "cgroup cgroup rw,memory\n"
        ),
    )
    v2_leaf = cgroup_root / "unified" / "child"
    v2_leaf.mkdir(parents=True)
    (v2_leaf / "memory.max").write_text("max\n", encoding="utf-8")
    _write_v1_limit(cgroup_root / "memory" / "child", limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="incomplete cgroup v2"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_membership_outside_mount_root_fails_closed(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/outside/child\n",
        mountinfo=(
            "36 25 0:32 /docker/parent /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
        ),
    )
    _write_v2_limit(cgroup_root / "outside" / "child", limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="mapped"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


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


def test_resolve_limit_never_exceeds_inherited_soft_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(resource, "getrlimit", lambda _: (128, 512))

    assert resolve_reliable_memory_limit(256) == 128


def test_apply_limit_never_raises_inherited_soft_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[int, int]] = []
    monkeypatch.setattr(resource, "getrlimit", lambda _: (128, 512))
    monkeypatch.setattr(resource, "setrlimit", lambda _, value: seen.append(value))

    _apply_address_space_limit(256)

    assert seen == [(128, 512)]


def test_matrix_rejects_arbitrary_unprojected_first_scale() -> None:
    with pytest.raises(ValueError, match="first scale must be 1"):
        run_scale_matrix(
            scales=(800,),
            ticks_per_code=1_000,
            levels=10,
            retention_ms=1_000_000_000,
            output=io.StringIO(),
            probe_headroom=lambda: pytest.fail(
                "validation must happen before probing memory"
            ),
        )


def test_scale_one_bootstrap_receives_finite_child_limit_before_execution() -> None:
    observed: list[tuple[int, int]] = []

    def run_child(scale: int, memory_limit_bytes: int) -> dict[str, int]:
        observed.append((scale, memory_limit_bytes))
        return {
            "codes": scale,
            "max_rss_bytes": 100,
            "published_total": scale,
        }

    run_scale_matrix(
        scales=(1,),
        ticks_per_code=1,
        levels=1,
        retention_ms=1,
        output=io.StringIO(),
        probe_headroom=lambda: MemoryHeadroom(
            host_available_bytes=1_000,
            cgroup_version="v2",
            cgroup_limit_bytes=1_000,
            cgroup_current_bytes=0,
            cgroup_remaining_bytes=1_000,
            usable_headroom_bytes=1_000,
        ),
        resolve_memory_limit=lambda requested: requested,
        run_child=run_child,
    )

    assert observed == [(1, 250)]
