"""Resource-guarded orchestration for synthetic LiveBuffer scale benchmarks."""

from __future__ import annotations

import argparse
import json
import math
import os
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


class MemoryProbeError(RuntimeError):
    """The host/container memory boundary could not be read safely."""


class MemoryLimitUnavailable(RuntimeError):
    """A child could not be launched with a verified address-space limit."""


@dataclass(frozen=True, slots=True)
class MemoryHeadroom:
    host_available_bytes: int
    cgroup_version: Literal["v1", "v2"] | None
    cgroup_limit_bytes: int | None
    cgroup_current_bytes: int | None
    cgroup_remaining_bytes: int | None
    usable_headroom_bytes: int


@dataclass(frozen=True, slots=True)
class _ControllerProbe:
    finite: tuple[int, int, int] | None
    unlimited_current: int | None
    discovered_paths: frozenset[Path]


def _read_non_negative_int(path: Path) -> int:
    try:
        value = int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError) as exc:
        raise MemoryProbeError(f"cannot read non-negative integer from {path.name}") from exc
    if value < 0:
        raise MemoryProbeError(f"negative memory value in {path.name}")
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


def _process_cgroup_paths(proc_root: Path) -> tuple[Path | None, Path | None]:
    """Return process-relative (v2, v1-memory) paths when procfs exposes them."""
    try:
        lines = (proc_root / "self" / "cgroup").read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise MemoryProbeError("cannot read process cgroup membership") from exc
    v2_path: Path | None = None
    v1_path: Path | None = None
    for line in lines:
        hierarchy, separator, remainder = line.partition(":")
        if not separator:
            continue
        controllers, separator, raw_path = remainder.partition(":")
        if not separator:
            continue
        relative = Path(raw_path.lstrip("/"))
        if hierarchy == "0" and not controllers:
            v2_path = relative
        elif "memory" in controllers.split(","):
            v1_path = relative
    return v2_path, v1_path


def _candidate_cgroup_dirs(
    *,
    cgroup_root: Path,
    v2_path: Path | None,
    v1_path: Path | None,
) -> tuple[list[Path], list[Path]]:
    def ancestors(base: Path, relative: Path) -> list[Path]:
        candidate = base / relative
        result: list[Path] = []
        while candidate == base or base in candidate.parents:
            result.append(candidate)
            if candidate == base:
                break
            candidate = candidate.parent
        return result

    v2_candidates: list[Path] = []
    v1_candidates: list[Path] = []
    if v2_path is not None:
        v2_candidates.extend(ancestors(cgroup_root, v2_path))
    else:
        v2_candidates.append(cgroup_root)
    if v1_path is not None:
        v1_candidates.extend(ancestors(cgroup_root / "memory", v1_path))
        v1_candidates.extend(ancestors(cgroup_root, v1_path))
    v1_candidates.extend((cgroup_root / "memory", cgroup_root))
    return list(dict.fromkeys(v2_candidates)), list(dict.fromkeys(v1_candidates))


def _probe_cgroup_v2(candidates: Sequence[Path]) -> _ControllerProbe:
    finite: list[tuple[int, int, int]] = []
    unlimited_current: int | None = None
    discovered_paths: set[Path] = set()
    for directory in candidates:
        max_path = directory / "memory.max"
        current_path = directory / "memory.current"
        if not max_path.exists() and not current_path.exists():
            continue
        discovered_paths.add(directory)
        if not max_path.exists() or not current_path.exists():
            raise MemoryProbeError("incomplete cgroup v2 memory controller")
        try:
            raw_limit = max_path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise MemoryProbeError("cannot read cgroup v2 memory.max") from exc
        current = _read_non_negative_int(current_path)
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


def _probe_cgroup_v1(candidates: Sequence[Path]) -> _ControllerProbe:
    finite: list[tuple[int, int, int]] = []
    unlimited_current: int | None = None
    discovered_paths: set[Path] = set()
    for directory in candidates:
        limit_path = directory / "memory.limit_in_bytes"
        usage_path = directory / "memory.usage_in_bytes"
        if not limit_path.exists() and not usage_path.exists():
            continue
        discovered_paths.add(directory)
        if not limit_path.exists() or not usage_path.exists():
            raise MemoryProbeError("incomplete cgroup v1 memory controller")
        limit = _read_non_negative_int(limit_path)
        current = _read_non_negative_int(usage_path)
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
    v2_path, v1_path = _process_cgroup_paths(proc_root)
    v2_candidates, v1_candidates = _candidate_cgroup_dirs(
        cgroup_root=cgroup_root,
        v2_path=v2_path,
        v1_path=v1_path,
    )
    v2_probe = _probe_cgroup_v2(v2_candidates)
    v1_probe = _probe_cgroup_v1(v1_candidates)
    if (
        v2_path is not None
        and cgroup_root / v2_path not in v2_probe.discovered_paths
    ):
        raise MemoryProbeError("declared cgroup v2 memory controller could not be resolved")
    v1_process_dirs = {
        cgroup_root / "memory" / v1_path,
        cgroup_root / v1_path,
    } if v1_path is not None else set()
    if v1_path is not None and v1_process_dirs.isdisjoint(v1_probe.discovered_paths):
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
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    except (OSError, ValueError):
        return None
    if hard == resource.RLIM_INFINITY:
        return requested_bytes
    if hard <= 0:
        return None
    return min(requested_bytes, hard)


def _apply_address_space_limit(limit_bytes: int) -> None:
    try:
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        new_hard = limit_bytes if hard == resource.RLIM_INFINITY else min(limit_bytes, hard)
        if new_hard <= 0:
            raise MemoryLimitUnavailable("RLIMIT_AS hard limit is not usable")
        resource.setrlimit(resource.RLIMIT_AS, (new_hard, new_hard))
        verified_soft, _verified_hard = resource.getrlimit(resource.RLIMIT_AS)
    except (OSError, ValueError) as exc:
        raise MemoryLimitUnavailable("could not establish RLIMIT_AS") from exc
    if verified_soft != new_hard:
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
    except (OSError, subprocess.SubprocessError) as exc:
        raise MemoryLimitUnavailable("limited child could not start") from exc
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
    if not scales or any(scale <= 0 for scale in scales):
        raise ValueError("scales must contain positive integers")
    if tuple(scales) != tuple(sorted(set(scales))):
        raise ValueError("scales must be unique and strictly increasing")

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
        if child_limit is None:
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
    args = build_parser().parse_args()
    run_scale_matrix(
        scales=tuple(args.scale or DEFAULT_SCALES),
        ticks_per_code=args.ticks_per_code,
        levels=args.levels,
        retention_ms=args.retention_ms,
        output=sys.stdout,
    )


if __name__ == "__main__":
    main()
