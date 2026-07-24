"""Resource-guarded orchestration for synthetic LiveBuffer scale benchmarks."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import resource
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from functools import partial
from pathlib import Path
from typing import Literal, TextIO

DEFAULT_SCALES = (1, 50, 200, 800)
_V1_UNLIMITED_AT_OR_ABOVE = 1 << 60
_DEFAULT_CGROUP_ROOT = Path("/sys/fs/cgroup")
_MOUNTINFO_ESCAPE_DIGITS = 3
_MOUNTINFO_PRE_FIELD_COUNT = 6
_MOUNTINFO_POST_FIELD_COUNT = 3
_MAX_CONTROLLER_VALUE_BYTES = 4_096
_MOUNTINFO_PATH_ESCAPES = {
    "040": " ",
    "011": "\t",
    "012": "\n",
    "134": "\\",
}
_CANONICAL_POSITIVE_DECIMAL = re.compile(r"[1-9][0-9]*", re.ASCII)
_CANONICAL_NON_NEGATIVE_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)", re.ASCII)
_CANONICAL_DEVICE = re.compile(
    r"(0|[1-9][0-9]*):(0|[1-9][0-9]*)",
    re.ASCII,
)


class MemoryProbeError(RuntimeError):
    """The host/container memory boundary could not be read safely."""


class MemoryLimitUnavailable(RuntimeError):
    """A child could not be launched with a verified address-space limit."""


class ChildExecutionError(RuntimeError):
    """A limited child encountered an operational execution failure."""


@dataclass(frozen=True, slots=True)
class MemoryHeadroom:
    host_available_bytes: int
    cgroup_version: Literal["v1", "v2"] | None
    cgroup_limit_bytes: int | None
    cgroup_current_bytes: int | None
    cgroup_remaining_bytes: int | None
    usable_headroom_bytes: int


@dataclass(frozen=True, slots=True)
class CgroupMount:
    mount_id: int
    parent_id: int
    device: tuple[int, int]
    root: Path
    mount_point: Path
    filesystem: str
    source: str
    super_options: frozenset[str]
    order: int
    version: Literal["v1", "v2"] | None
    controllers: frozenset[str]


@dataclass(frozen=True, slots=True)
class _ControllerCandidate:
    path: Path
    mount_id: int
    device: tuple[int, int]
    verify_mount_id: bool


@dataclass(frozen=True, slots=True)
class _CgroupMembership:
    version: Literal["v1", "v2"]
    path: Path
    controllers: frozenset[str]


@dataclass(frozen=True, slots=True)
class _ControllerProbe:
    finite: tuple[int, int, int] | None
    unlimited_current: int | None
    discovered_paths: frozenset[Path]


def _parse_non_negative_memory_value(raw_value: str, *, source: str) -> int:
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise MemoryProbeError(f"cannot read non-negative integer from {source}") from exc
    if value < 0:
        raise MemoryProbeError(f"negative memory value in {source}")
    return value


def _read_host_available(proc_root: Path) -> int:
    try:
        lines = (proc_root / "meminfo").read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise MemoryProbeError("cannot read host MemAvailable") from exc
    for line in lines:
        key, separator, value = line.partition(":")
        if key != "MemAvailable" or not separator:
            continue
        parts = value.split()
        if len(parts) != len(("value", "unit")) or parts[1] != "kB":
            break
        try:
            available_bytes = int(parts[0]) * 1024
        except ValueError as exc:
            raise MemoryProbeError("invalid host MemAvailable") from exc
        if available_bytes < 0:
            break
        return available_bytes
    raise MemoryProbeError("host MemAvailable is missing or invalid")


def _absolute_cgroup_path(raw_path: str, *, source: str) -> Path:
    if raw_path == "/":
        return Path("/")
    if not raw_path.startswith("/") or raw_path.endswith("/"):
        raise MemoryProbeError(f"malformed {source}")
    parts = raw_path[1:].split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise MemoryProbeError(f"malformed {source}")
    return Path(raw_path)


def _decode_mountinfo_path(raw_path: str) -> str:
    decoded: list[str] = []
    index = 0
    while index < len(raw_path):
        if raw_path[index] != "\\":
            decoded.append(raw_path[index])
            index += 1
            continue
        escape_end = index + 1 + _MOUNTINFO_ESCAPE_DIGITS
        escape = raw_path[index + 1 : escape_end]
        if (
            len(escape) != _MOUNTINFO_ESCAPE_DIGITS
            or escape not in _MOUNTINFO_PATH_ESCAPES
        ):
            raise MemoryProbeError("malformed process cgroup mountinfo")
        decoded.append(_MOUNTINFO_PATH_ESCAPES[escape])
        index = escape_end
    return "".join(decoded)


def _positive_ascii_decimal(raw_value: str) -> int:
    if _CANONICAL_POSITIVE_DECIMAL.fullmatch(raw_value) is None:
        raise MemoryProbeError("malformed process cgroup mountinfo")
    try:
        return int(raw_value)
    except ValueError as exc:
        raise MemoryProbeError("malformed process cgroup mountinfo") from exc


def _non_negative_ascii_decimal(raw_value: str, *, source: str) -> int:
    if _CANONICAL_NON_NEGATIVE_DECIMAL.fullmatch(raw_value) is None:
        raise MemoryProbeError(f"malformed {source}")
    try:
        return int(raw_value)
    except ValueError as exc:
        raise MemoryProbeError(f"malformed {source}") from exc


def _mount_device(raw_device: str) -> tuple[int, int]:
    match = _CANONICAL_DEVICE.fullmatch(raw_device)
    if match is None:
        raise MemoryProbeError("malformed process cgroup mountinfo")
    try:
        return int(match.group(1)), int(match.group(2))
    except ValueError as exc:
        raise MemoryProbeError("malformed process cgroup mountinfo") from exc


def _process_cgroup_mounts(proc_root: Path) -> tuple[CgroupMount, ...]:
    try:
        lines = (proc_root / "self" / "mountinfo").read_text(
            encoding="utf-8"
        ).splitlines()
    except OSError as exc:
        raise MemoryProbeError("cannot read process cgroup mountinfo") from exc

    mounts: list[CgroupMount] = []
    mount_ids: set[int] = set()
    for order, line in enumerate(lines):
        try:
            pre_section, post_section = line.split(" - ")
        except ValueError:
            raise MemoryProbeError("malformed process cgroup mountinfo") from None
        pre_separator = pre_section.split()
        post_separator = post_section.split()
        if (
            len(pre_separator) < _MOUNTINFO_PRE_FIELD_COUNT
            or len(post_separator) != _MOUNTINFO_POST_FIELD_COUNT
        ):
            raise MemoryProbeError("malformed process cgroup mountinfo")
        mount_id = _positive_ascii_decimal(pre_separator[0])
        parent_id = _positive_ascii_decimal(pre_separator[1])
        if mount_id in mount_ids:
            raise MemoryProbeError("malformed process cgroup mountinfo")
        mount_ids.add(mount_id)
        device = _mount_device(pre_separator[2])
        filesystem = post_separator[0]
        decoded_root = _decode_mountinfo_path(pre_separator[3])
        root = (
            _absolute_cgroup_path(
                decoded_root,
                source="process cgroup mount root",
            )
            if filesystem in {"cgroup", "cgroup2"}
            else Path(decoded_root)
        )
        mount_point = _absolute_cgroup_path(
            _decode_mountinfo_path(pre_separator[4]),
            source="process cgroup mount point",
        )
        source = post_separator[1]
        raw_super_options = post_separator[2].split(",")
        if any(
            not option or option.strip() != option
            for option in raw_super_options
        ):
            raise MemoryProbeError("malformed process cgroup mountinfo")
        super_options = frozenset(raw_super_options)
        if filesystem == "cgroup2":
            version: Literal["v1", "v2"] | None = "v2"
            controllers = frozenset()
        elif filesystem == "cgroup" and "memory" in super_options:
            version = "v1"
            controllers = super_options
        else:
            version = None
            controllers = frozenset()
        mounts.append(
            CgroupMount(
                mount_id=mount_id,
                parent_id=parent_id,
                device=device,
                root=root,
                mount_point=mount_point,
                filesystem=filesystem,
                source=source,
                super_options=super_options,
                order=order,
                version=version,
                controllers=controllers,
            )
        )
    return tuple(mounts)


def _process_cgroup_memberships(proc_root: Path) -> tuple[_CgroupMembership, ...]:
    try:
        lines = (proc_root / "self" / "cgroup").read_text(
            encoding="utf-8"
        ).splitlines()
    except OSError as exc:
        raise MemoryProbeError("cannot read process cgroup membership") from exc
    if not lines:
        raise MemoryProbeError("process cgroup membership is empty")

    memberships: list[_CgroupMembership] = []
    hierarchy_ids: set[int] = set()
    controller_sets: set[frozenset[str]] = set()
    v2_seen = False
    memory_seen = False
    for line in lines:
        try:
            hierarchy, raw_controllers, raw_path = line.split(":")
        except ValueError:
            raise MemoryProbeError("malformed process cgroup membership") from None
        hierarchy_id = _non_negative_ascii_decimal(
            hierarchy,
            source="process cgroup membership",
        )
        if hierarchy_id in hierarchy_ids:
            raise MemoryProbeError("malformed process cgroup membership")
        hierarchy_ids.add(hierarchy_id)
        path = _absolute_cgroup_path(
            raw_path,
            source="process cgroup membership",
        )
        if hierarchy_id == 0:
            if raw_controllers or v2_seen:
                raise MemoryProbeError("malformed process cgroup membership")
            v2_seen = True
            version: Literal["v1", "v2"] = "v2"
            controllers = frozenset()
        else:
            controller_parts = raw_controllers.split(",")
            if any(
                not controller
                or controller.strip() != controller
                for controller in controller_parts
            ) or len(controller_parts) != len(set(controller_parts)):
                raise MemoryProbeError("malformed process cgroup membership")
            version = "v1"
            controllers = frozenset(controller_parts)
            if controllers in controller_sets:
                raise MemoryProbeError("malformed process cgroup membership")
            controller_sets.add(controllers)
            if "memory" in controllers:
                if memory_seen:
                    raise MemoryProbeError("malformed process cgroup membership")
                memory_seen = True
        memberships.append(
            _CgroupMembership(
                version=version,
                path=path,
                controllers=controllers,
            )
        )
    return tuple(memberships)


def _mount_is_ancestor(
    ancestor: CgroupMount,
    descendant: CgroupMount,
    *,
    mounts_by_id: Mapping[int, CgroupMount],
) -> bool:
    parent_id = descendant.parent_id
    visited = {descendant.mount_id}
    while parent_id in mounts_by_id:
        if parent_id in visited:
            raise MemoryProbeError("malformed process cgroup mountinfo")
        if parent_id == ancestor.mount_id:
            return True
        visited.add(parent_id)
        parent_id = mounts_by_id[parent_id].parent_id
    return False


def _visible_mount_for_path(
    path: Path,
    *,
    mounts: Sequence[CgroupMount],
) -> CgroupMount | None:
    covering_mounts = [
        mount
        for mount in mounts
        if path == mount.mount_point or mount.mount_point in path.parents
    ]
    if not covering_mounts:
        return None
    mounts_by_id = {mount.mount_id: mount for mount in mounts}
    mount_points = sorted(
        {mount.mount_point for mount in covering_mounts},
        key=lambda mount_point: len(mount_point.parts),
    )
    visible_mount: CgroupMount | None = None
    for mount_point in mount_points:
        stack = [
            mount
            for mount in covering_mounts
            if mount.mount_point == mount_point
        ]
        if visible_mount is not None:
            stack = [
                mount
                for mount in stack
                if _mount_is_ancestor(
                    visible_mount,
                    mount,
                    mounts_by_id=mounts_by_id,
                )
            ]
        if not stack:
            continue
        visible = [
            mount
            for mount in stack
            if not any(
                other.mount_id != mount.mount_id
                and _mount_is_ancestor(
                    mount,
                    other,
                    mounts_by_id=mounts_by_id,
                )
                for other in stack
            )
        ]
        if not visible:
            raise MemoryProbeError("malformed process cgroup mountinfo")
        visible_mount = max(visible, key=lambda mount: mount.order)
    return visible_mount


def _mounted_controller_root(
    *,
    cgroup_root: Path,
    mount: CgroupMount,
) -> Path:
    if cgroup_root == _DEFAULT_CGROUP_ROOT:
        return mount.mount_point
    try:
        relative_mount = mount.mount_point.relative_to(_DEFAULT_CGROUP_ROOT)
    except ValueError:
        if mount.mount_point == cgroup_root or cgroup_root in mount.mount_point.parents:
            return mount.mount_point
        raise MemoryProbeError(
            "process cgroup mount point cannot be mapped to cgroup root"
        ) from None
    return cgroup_root / relative_mount


def _mapped_controller_dirs(
    *,
    proc_root: Path,
    cgroup_root: Path,
) -> tuple[
    list[_ControllerCandidate],
    list[_ControllerCandidate],
    frozenset[Path],
    frozenset[Path],
]:
    mounts = _process_cgroup_mounts(proc_root)
    memberships = _process_cgroup_memberships(proc_root)
    mapped: dict[
        Literal["v1", "v2"],
        list[tuple[Path, Path, CgroupMount]],
    ] = {
        "v1": [],
        "v2": [],
    }
    for membership in memberships:
        if membership.version == "v1" and "memory" not in membership.controllers:
            continue
        for mount in mounts:
            if mount.version is None:
                continue
            if mount.version != membership.version:
                continue
            if mount.version == "v1" and "memory" not in mount.controllers:
                continue
            try:
                relative_membership = membership.path.relative_to(mount.root)
            except ValueError:
                continue
            virtual_process_dir = mount.mount_point / relative_membership
            visible_mount = _visible_mount_for_path(
                virtual_process_dir,
                mounts=mounts,
            )
            if visible_mount is None or visible_mount.mount_id != mount.mount_id:
                continue
            controller_root = _mounted_controller_root(
                cgroup_root=cgroup_root,
                mount=mount,
            )
            process_dir = controller_root / relative_membership
            mapped[membership.version].append(
                (process_dir, controller_root, mount)
            )

    if not mapped["v1"] and not mapped["v2"]:
        raise MemoryProbeError(
            "process cgroup membership could not be mapped to a memory mount"
        )

    def candidates(
        mappings: Sequence[tuple[Path, Path, CgroupMount]],
    ) -> tuple[list[_ControllerCandidate], frozenset[Path]]:
        result: list[_ControllerCandidate] = []
        process_dirs: set[Path] = set()
        for process_dir, controller_root, mount in mappings:
            process_dirs.add(process_dir)
            candidate = process_dir
            while candidate == controller_root or controller_root in candidate.parents:
                result.append(
                    _ControllerCandidate(
                        path=candidate,
                        mount_id=mount.mount_id,
                        device=mount.device,
                        verify_mount_id=proc_root == Path("/proc"),
                    )
                )
                if candidate == controller_root:
                    break
                candidate = candidate.parent
        return list(dict.fromkeys(result)), frozenset(process_dirs)

    v2_candidates, v2_process_dirs = candidates(mapped["v2"])
    v1_candidates, v1_process_dirs = candidates(mapped["v1"])
    return (
        v2_candidates,
        v1_candidates,
        v2_process_dirs,
        v1_process_dirs,
    )


def _opened_mount_id(fd: int) -> int:
    try:
        lines = Path(f"/proc/self/fdinfo/{fd}").read_text(
            encoding="utf-8"
        ).splitlines()
    except OSError as exc:
        raise MemoryProbeError("cannot verify opened controller mount identity") from exc
    for line in lines:
        key, separator, raw_value = line.partition(":")
        if key != "mnt_id" or not separator:
            continue
        try:
            return _positive_ascii_decimal(raw_value.strip())
        except MemoryProbeError as exc:
            raise MemoryProbeError(
                "cannot verify opened controller mount identity"
            ) from exc
    raise MemoryProbeError("cannot verify opened controller mount identity")


def _verify_opened_controller_identity(
    fd: int,
    *,
    candidate: _ControllerCandidate,
) -> None:
    try:
        opened_stat = os.fstat(fd)
    except OSError as exc:
        raise MemoryProbeError("cannot verify opened controller identity") from exc
    opened_device = (
        os.major(opened_stat.st_dev),
        os.minor(opened_stat.st_dev),
    )
    if opened_device != candidate.device:
        raise MemoryProbeError("opened controller device does not match visible mount")
    if candidate.verify_mount_id and _opened_mount_id(fd) != candidate.mount_id:
        raise MemoryProbeError("opened controller mount identity does not match")


def _open_controller_directory(candidate: _ControllerCandidate) -> int | None:
    try:
        fd = os.open(
            candidate.path,
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise MemoryProbeError("cannot open cgroup controller directory") from exc
    try:
        _verify_opened_controller_identity(fd, candidate=candidate)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _read_controller_file(
    directory_fd: int,
    *,
    candidate: _ControllerCandidate,
    name: str,
) -> str | None:
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise MemoryProbeError(f"cannot open cgroup controller {name}") from exc
    try:
        _verify_opened_controller_identity(fd, candidate=candidate)
        raw_value = os.read(fd, _MAX_CONTROLLER_VALUE_BYTES + 1)
        if len(raw_value) > _MAX_CONTROLLER_VALUE_BYTES:
            raise MemoryProbeError(f"oversized cgroup controller {name}")
        return raw_value.decode("utf-8").strip()
    except (OSError, UnicodeError) as exc:
        raise MemoryProbeError(f"cannot read cgroup controller {name}") from exc
    finally:
        os.close(fd)


def _probe_cgroup_v2(
    candidates: Sequence[_ControllerCandidate],
) -> _ControllerProbe:
    finite: list[tuple[int, int, int]] = []
    unlimited_current: int | None = None
    discovered_paths: set[Path] = set()
    for candidate in candidates:
        directory_fd = _open_controller_directory(candidate)
        if directory_fd is None:
            continue
        try:
            raw_limit = _read_controller_file(
                directory_fd,
                candidate=candidate,
                name="memory.max",
            )
            raw_current = _read_controller_file(
                directory_fd,
                candidate=candidate,
                name="memory.current",
            )
        finally:
            os.close(directory_fd)
        if raw_limit is None and raw_current is None:
            continue
        discovered_paths.add(candidate.path)
        if raw_limit is None or raw_current is None:
            raise MemoryProbeError("incomplete cgroup v2 memory controller")
        current = _parse_non_negative_memory_value(
            raw_current,
            source="memory.current",
        )
        if raw_limit == "max":
            if unlimited_current is None:
                unlimited_current = current
            continue
        try:
            limit = int(raw_limit)
        except ValueError as exc:
            raise MemoryProbeError("invalid cgroup v2 memory.max") from exc
        if limit < 0:
            raise MemoryProbeError("negative cgroup v2 memory.max")
        finite.append((max(0, limit - current), limit, current))
    return _ControllerProbe(
        finite=min(finite) if finite else None,
        unlimited_current=unlimited_current,
        discovered_paths=frozenset(discovered_paths),
    )


def _probe_cgroup_v1(
    candidates: Sequence[_ControllerCandidate],
) -> _ControllerProbe:
    finite: list[tuple[int, int, int]] = []
    unlimited_current: int | None = None
    discovered_paths: set[Path] = set()
    for candidate in candidates:
        directory_fd = _open_controller_directory(candidate)
        if directory_fd is None:
            continue
        try:
            raw_limit = _read_controller_file(
                directory_fd,
                candidate=candidate,
                name="memory.limit_in_bytes",
            )
            raw_current = _read_controller_file(
                directory_fd,
                candidate=candidate,
                name="memory.usage_in_bytes",
            )
        finally:
            os.close(directory_fd)
        if raw_limit is None and raw_current is None:
            continue
        discovered_paths.add(candidate.path)
        if raw_limit is None or raw_current is None:
            raise MemoryProbeError("incomplete cgroup v1 memory controller")
        limit = _parse_non_negative_memory_value(
            raw_limit,
            source="memory.limit_in_bytes",
        )
        current = _parse_non_negative_memory_value(
            raw_current,
            source="memory.usage_in_bytes",
        )
        if limit >= _V1_UNLIMITED_AT_OR_ABOVE:
            if unlimited_current is None:
                unlimited_current = current
            continue
        finite.append((max(0, limit - current), limit, current))
    return _ControllerProbe(
        finite=min(finite) if finite else None,
        unlimited_current=unlimited_current,
        discovered_paths=frozenset(discovered_paths),
    )


def _finite_headroom(
    *,
    host_available: int,
    version: Literal["v1", "v2"],
    finite: tuple[int, int, int],
) -> MemoryHeadroom:
    remaining, limit, current = finite
    return MemoryHeadroom(
        host_available_bytes=host_available,
        cgroup_version=version,
        cgroup_limit_bytes=limit,
        cgroup_current_bytes=current,
        cgroup_remaining_bytes=remaining,
        usable_headroom_bytes=min(host_available, remaining),
    )


def read_memory_headroom(
    *,
    proc_root: Path = Path("/proc"),
    cgroup_root: Path = Path("/sys/fs/cgroup"),
) -> MemoryHeadroom:
    """Use the tighter of host MemAvailable and a finite process cgroup limit."""
    host_available = _read_host_available(proc_root)
    (
        v2_candidates,
        v1_candidates,
        v2_process_dirs,
        v1_process_dirs,
    ) = _mapped_controller_dirs(
        proc_root=proc_root,
        cgroup_root=cgroup_root,
    )
    v2_probe = _probe_cgroup_v2(v2_candidates)
    v1_probe = _probe_cgroup_v1(v1_candidates)
    v1_controller_resolved = not v1_process_dirs.isdisjoint(
        v1_probe.discovered_paths
    )
    if (
        v2_process_dirs
        and v2_process_dirs.isdisjoint(v2_probe.discovered_paths)
        and not v1_controller_resolved
    ):
        raise MemoryProbeError("declared cgroup v2 memory controller could not be resolved")
    if v1_process_dirs and v1_process_dirs.isdisjoint(v1_probe.discovered_paths):
        raise MemoryProbeError("declared cgroup v1 memory controller could not be resolved")

    finite_probes = [
        (version, probe.finite)
        for version, probe in (("v2", v2_probe), ("v1", v1_probe))
        if probe.finite is not None
    ]
    if finite_probes:
        version, finite = min(finite_probes, key=lambda item: item[1][0])
        return _finite_headroom(
            host_available=host_available,
            version=version,
            finite=finite,
        )

    if v2_probe.unlimited_current is not None:
        return MemoryHeadroom(
            host_available_bytes=host_available,
            cgroup_version="v2",
            cgroup_limit_bytes=None,
            cgroup_current_bytes=v2_probe.unlimited_current,
            cgroup_remaining_bytes=None,
            usable_headroom_bytes=host_available,
        )
    if v1_probe.unlimited_current is not None:
        return MemoryHeadroom(
            host_available_bytes=host_available,
            cgroup_version="v1",
            cgroup_limit_bytes=None,
            cgroup_current_bytes=v1_probe.unlimited_current,
            cgroup_remaining_bytes=None,
            usable_headroom_bytes=host_available,
        )
    return MemoryHeadroom(
        host_available_bytes=host_available,
        cgroup_version=None,
        cgroup_limit_bytes=None,
        cgroup_current_bytes=None,
        cgroup_remaining_bytes=None,
        usable_headroom_bytes=host_available,
    )


def project_peak_rss(
    *,
    next_scale: int,
    completed: Sequence[Mapping[str, object]],
) -> int | None:
    """Conservatively scale the largest completed per-code peak RSS."""
    if not completed:
        return None
    per_code_peaks: list[float] = []
    for row in completed:
        codes = int(row["codes"])
        peak_rss = int(row["max_rss_bytes"])
        if codes <= 0 or peak_rss <= 0:
            raise ValueError("completed rows require positive codes and max_rss_bytes")
        per_code_peaks.append(peak_rss / codes)
    return math.ceil(next_scale * max(per_code_peaks))


def _deferred_command(
    *,
    scale: int,
    ticks_per_code: int,
    levels: int,
    retention_ms: int,
) -> list[str]:
    return [
        "uv",
        "run",
        "python",
        "tools/bench_live_buffer.py",
        "--codes",
        str(scale),
        "--ticks-per-code",
        str(ticks_per_code),
        "--levels",
        str(levels),
        "--retention-ms",
        str(retention_ms),
    ]


def resolve_reliable_memory_limit(requested_bytes: int) -> int | None:
    """Return an enforceable RLIMIT_AS value, or None when it cannot be set."""
    if os.name != "posix" or not hasattr(resource, "RLIMIT_AS") or requested_bytes <= 0:
        return None
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    except (OSError, ValueError):
        return None

    if soft == resource.RLIM_INFINITY:
        resolved = requested_bytes
    elif soft > 0:
        resolved = min(requested_bytes, soft)
    else:
        return None

    if hard == resource.RLIM_INFINITY:
        return resolved
    if hard <= 0:
        return None
    return min(resolved, hard)


def _apply_address_space_limit(limit_bytes: int) -> None:
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        new_soft = (
            limit_bytes
            if soft == resource.RLIM_INFINITY
            else min(limit_bytes, soft)
        )
        if hard != resource.RLIM_INFINITY:
            new_soft = min(new_soft, hard)
        if new_soft <= 0:
            raise MemoryLimitUnavailable("RLIMIT_AS soft limit is not usable")
        resource.setrlimit(resource.RLIMIT_AS, (new_soft, hard))
        verified_soft, verified_hard = resource.getrlimit(resource.RLIMIT_AS)
    except (OSError, ValueError) as exc:
        raise MemoryLimitUnavailable("could not establish RLIMIT_AS") from exc
    if verified_soft != new_soft or verified_hard != hard:
        raise MemoryLimitUnavailable("RLIMIT_AS verification failed")


def _run_limited_child(
    *,
    scale: int,
    memory_limit_bytes: int,
    ticks_per_code: int,
    levels: int,
    retention_ms: int,
) -> dict[str, object]:
    command = [
        sys.executable,
        "-m",
        "tools.bench_live_buffer",
        "--codes",
        str(scale),
        "--ticks-per-code",
        str(ticks_per_code),
        "--levels",
        str(levels),
        "--retention-ms",
        str(retention_ms),
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=Path(__file__).resolve().parents[1],
            check=False,
            capture_output=True,
            text=True,
            preexec_fn=partial(_apply_address_space_limit, memory_limit_bytes),
        )
    except OSError as exc:
        raise ChildExecutionError("limited child launch failed") from exc
    except subprocess.SubprocessError as exc:
        raise MemoryLimitUnavailable("limited child could not establish RLIMIT_AS") from exc
    if completed.returncode != 0:
        raise RuntimeError(
            f"LiveBuffer child failed for scale {scale}: {completed.stderr.strip()}"
        )
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError("LiveBuffer child must emit exactly one JSON row")
    try:
        result = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise RuntimeError("LiveBuffer child emitted invalid JSON") from exc
    if not isinstance(result, dict):
        raise RuntimeError("LiveBuffer child JSON must be an object")
    return result


def _skip_row(
    *,
    reason: str,
    scale: int,
    headroom: MemoryHeadroom,
    projected_peak_bytes: int | None,
    guard_limit_bytes: int,
    subprocess_memory_limit_bytes: int | None,
    deferred_command: list[str],
) -> dict[str, object]:
    return {
        "record_type": "status",
        "workstream": "live_buffer_synthetic",
        "status": "SKIPPED_RESOURCE_GUARD",
        "reason": reason,
        "scale": scale,
        **asdict(headroom),
        "projected_peak_bytes": projected_peak_bytes,
        "guard_limit_bytes": guard_limit_bytes,
        "subprocess_memory_limit_bytes": subprocess_memory_limit_bytes,
        "deferred_command": deferred_command,
    }


def _validate_scales(scales: Sequence[int]) -> None:
    if not scales or any(scale <= 0 for scale in scales):
        raise ValueError("scales must contain positive integers")
    if tuple(scales) != tuple(sorted(set(scales))):
        raise ValueError("scales must be unique and strictly increasing")
    if scales[0] != 1:
        raise ValueError("first scale must be 1")


def run_scale_matrix(
    *,
    scales: Sequence[int],
    ticks_per_code: int,
    levels: int,
    retention_ms: int,
    output: TextIO,
    probe_headroom: Callable[[], MemoryHeadroom] = read_memory_headroom,
    resolve_memory_limit: Callable[[int], int | None] = resolve_reliable_memory_limit,
    run_child: Callable[[int, int], Mapping[str, object]] | None = None,
) -> None:
    """Guard, isolate, execute, and stream one JSONL row per considered scale."""
    _validate_scales(scales)

    completed_rows: list[Mapping[str, object]] = []
    for scale in scales:
        headroom = probe_headroom()
        guard_limit = headroom.usable_headroom_bytes // 4
        projected_peak = project_peak_rss(next_scale=scale, completed=completed_rows)
        child_limit = resolve_memory_limit(guard_limit)
        deferred = _deferred_command(
            scale=scale,
            ticks_per_code=ticks_per_code,
            levels=levels,
            retention_ms=retention_ms,
        )
        rejection_reason: str | None = None
        if child_limit is None or child_limit <= 0:
            rejection_reason = "memory_limit_unavailable"
        elif projected_peak is not None and projected_peak > guard_limit:
            rejection_reason = "projected_peak_exceeds_guard"
        elif projected_peak is not None and projected_peak > child_limit:
            rejection_reason = "projected_peak_exceeds_subprocess_limit"

        if rejection_reason is not None:
            print(
                json.dumps(
                    _skip_row(
                        reason=rejection_reason,
                        scale=scale,
                        headroom=headroom,
                        projected_peak_bytes=projected_peak,
                        guard_limit_bytes=guard_limit,
                        subprocess_memory_limit_bytes=child_limit,
                        deferred_command=deferred,
                    ),
                    sort_keys=True,
                ),
                file=output,
            )
            return

        assert child_limit is not None
        try:
            if run_child is None:
                result = _run_limited_child(
                    scale=scale,
                    memory_limit_bytes=child_limit,
                    ticks_per_code=ticks_per_code,
                    levels=levels,
                    retention_ms=retention_ms,
                )
            else:
                result = dict(run_child(scale, child_limit))
        except MemoryLimitUnavailable:
            print(
                json.dumps(
                    _skip_row(
                        reason="memory_limit_unavailable",
                        scale=scale,
                        headroom=headroom,
                        projected_peak_bytes=projected_peak,
                        guard_limit_bytes=guard_limit,
                        subprocess_memory_limit_bytes=child_limit,
                        deferred_command=deferred,
                    ),
                    sort_keys=True,
                ),
                file=output,
            )
            return
        except ChildExecutionError:
            print(
                json.dumps(
                    {
                        "record_type": "status",
                        "workstream": "live_buffer_synthetic",
                        "status": "CHILD_FAILED",
                        "reason": "child_launch_failed",
                        "scale": scale,
                        **asdict(headroom),
                        "projected_peak_bytes": projected_peak,
                        "guard_limit_bytes": guard_limit,
                        "subprocess_memory_limit_bytes": child_limit,
                    },
                    sort_keys=True,
                ),
                file=output,
                flush=True,
            )
            raise
        if int(result.get("codes", -1)) != scale:
            raise RuntimeError("LiveBuffer child result scale does not match request")
        if int(result.get("max_rss_bytes", 0)) <= 0:
            raise RuntimeError("LiveBuffer child result lacks a positive max_rss_bytes")
        print(json.dumps(result, sort_keys=True), file=output)
        completed_rows.append(result)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be a positive integer")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run resource-guarded synthetic LiveBuffer scales in isolated children."
    )
    parser.add_argument("--scale", action="append", type=_positive_int)
    parser.add_argument("--ticks-per-code", type=_positive_int, default=1_000)
    parser.add_argument("--levels", type=_positive_int, default=10)
    parser.add_argument("--retention-ms", type=_positive_int, default=1_000_000_000)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        run_scale_matrix(
            scales=tuple(args.scale or DEFAULT_SCALES),
            ticks_per_code=args.ticks_per_code,
            levels=args.levels,
            retention_ms=args.retention_ms,
            output=sys.stdout,
        )
    except ChildExecutionError as exc:
        parser.exit(1, f"{parser.prog}: error: {exc}\n")


if __name__ == "__main__":
    main()
