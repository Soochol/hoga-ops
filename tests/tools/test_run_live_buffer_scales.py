from __future__ import annotations

import io
import json
import os
import resource
from pathlib import Path

import pytest

from tools import run_live_buffer_scales
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


def _with_synthetic_mount_device(mountinfo: str, *, directory: Path) -> str:
    device = directory.stat().st_dev
    rendered_device = f"{os.major(device)}:{os.minor(device)}"
    rendered_lines: list[str] = []
    for raw_line in mountinfo.splitlines():
        pre_section, separator, post_section = raw_line.partition(" - ")
        pre_fields = pre_section.split()
        rendered_line = raw_line
        if separator and len(pre_fields) >= 3 and pre_fields[2] in {"0:32", "0:33"}:
            pre_fields[2] = rendered_device
            rendered_line = f"{' '.join(pre_fields)} - {post_section}"
        rendered_lines.append(rendered_line)
    suffix = "\n" if mountinfo.endswith("\n") else ""
    return "\n".join(rendered_lines) + suffix


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
    (proc_root / "self" / "mountinfo").write_text(
        _with_synthetic_mount_device(mountinfo, directory=proc_root.parent),
        encoding="utf-8",
    )


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


def test_stacked_cgroup_mount_uses_visible_top_mount(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/docker/lower/hidden\n",
        mountinfo=(
            "36 25 0:32 /docker/lower /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
            "37 36 0:33 /docker/lower/hidden /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
        ),
    )
    _write_v2_limit(cgroup_root / "hidden", limit=900, current=800)
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    headroom = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert headroom.cgroup_remaining_bytes == 600


def test_covering_non_cgroup_mount_hides_cgroup_controller(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/docker/lower/child\n",
        mountinfo=(
            "36 25 0:32 /docker/lower /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
            "37 36 0:33 / /sys/fs/cgroup rw - tmpfs tmpfs rw\n"
        ),
    )
    _write_v2_limit(cgroup_root / "child", limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="mapped|visible"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_ancestor_non_cgroup_overmount_hides_deeper_cgroup(
    tmp_path: Path,
) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/docker/child\n",
        mountinfo=(
            "10 1 0:31 / /sys rw - sysfs sysfs rw\n"
            "36 10 0:32 /docker /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
            "37 10 0:33 / /sys rw - tmpfs tmpfs rw\n"
        ),
    )
    _write_v2_limit(cgroup_root / "child", limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="mapped|visible"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_non_cgroup_filesystem_root_shape_does_not_hide_valid_cgroup(
    tmp_path: Path,
) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/\n",
        mountinfo=(
            "35 25 0:31 mnt:[4026533124] /run/example.mnt rw - "
            "nsfs nsfs rw\n"
            f"{_V2_MOUNTINFO}"
        ),
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    headroom = read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)

    assert headroom.cgroup_remaining_bytes == 600


def test_controller_directory_device_must_match_visible_mount(
    tmp_path: Path,
) -> None:
    device = tmp_path.stat().st_dev
    wrong_device = f"{os.major(device)}:{os.minor(device) + 1}"
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/\n",
        mountinfo=(
            f"36 25 {wrong_device} / /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
        ),
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="identity|device"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_oversized_mount_numeric_field_is_a_typed_probe_error(
    tmp_path: Path,
) -> None:
    oversized = "9" * 5_000
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/\n",
        mountinfo=(
            f"{oversized} 25 0:32 / /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
        ),
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="mountinfo"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_oversized_mount_device_field_is_a_typed_probe_error(
    tmp_path: Path,
) -> None:
    oversized = "9" * 5_000
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/\n",
        mountinfo=(
            f"36 25 {oversized}:32 / /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
        ),
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="mountinfo"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_oversized_membership_hierarchy_is_a_typed_probe_error(
    tmp_path: Path,
) -> None:
    oversized = "9" * 5_000
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership=f"{oversized}:memory:/\n",
        mountinfo=(
            "37 25 0:33 / /sys/fs/cgroup/memory rw - "
            "cgroup cgroup rw,memory\n"
        ),
    )
    _write_v1_limit(cgroup_root / "memory", limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="membership"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


@pytest.mark.parametrize(
    "mountinfo",
    [
        "036 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "٣٦ 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "36 025 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "36 0 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "36 25 00:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "36 25 0:032 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "36 25 -1:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "36 25 0:-1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "36 25 not-a-device / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "36 25 0:32 / /sys/fs/cgroup - cgroup2 cgroup rw\n",
        "36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw extra\n",
    ],
)
def test_noncanonical_or_malformed_mountinfo_fails_closed(
    tmp_path: Path,
    mountinfo: str,
) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/\n",
        mountinfo=mountinfo,
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="mountinfo"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_duplicate_v2_membership_fails_closed(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/\n0::/\n",
        mountinfo=_V2_MOUNTINFO,
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="membership"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


@pytest.mark.parametrize(
    "membership",
    [
        "05:memory:/\n",
        "٥:memory:/\n",
        "5:memory:/\n5:cpu:/\n",
        "5:memory,cpu:/\n6:cpu,memory:/\n",
        "5:memory:/\n6:memory,cpu:/\n",
        "5:memory,memory:/\n",
    ],
)
def test_noncanonical_or_duplicate_v1_membership_fails_closed(
    tmp_path: Path,
    membership: str,
) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership=membership,
        mountinfo=(
            "37 25 0:33 / /sys/fs/cgroup/memory rw - "
            "cgroup cgroup rw,memory\n"
        ),
    )
    _write_v1_limit(cgroup_root / "memory", limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="membership"):
        read_memory_headroom(proc_root=proc_root, cgroup_root=cgroup_root)


def test_duplicate_non_memory_controller_set_fails_closed(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/\n5:cpu:/\n6:cpu:/\n",
        mountinfo=_V2_MOUNTINFO,
    )
    _write_v2_limit(cgroup_root, limit=1_000, current=400)

    with pytest.raises(MemoryProbeError, match="membership"):
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


def test_child_launch_oserror_is_an_operational_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_launch(*args: object, **kwargs: object) -> None:
        raise OSError("exec failed")

    monkeypatch.setattr(run_live_buffer_scales.subprocess, "run", fail_launch)
    output = io.StringIO()

    with pytest.raises(RuntimeError, match="launch"):
        run_scale_matrix(
            scales=(1,),
            ticks_per_code=1,
            levels=1,
            retention_ms=1,
            output=output,
            probe_headroom=lambda: MemoryHeadroom(
                host_available_bytes=1_000,
                cgroup_version="v2",
                cgroup_limit_bytes=1_000,
                cgroup_current_bytes=0,
                cgroup_remaining_bytes=1_000,
                usable_headroom_bytes=1_000,
            ),
            resolve_memory_limit=lambda requested: requested,
        )

    [failure] = [json.loads(line) for line in output.getvalue().splitlines()]
    assert failure["status"] == "CHILD_FAILED"
    assert failure["reason"] == "child_launch_failed"
    assert "SKIPPED_RESOURCE_GUARD" not in output.getvalue()
