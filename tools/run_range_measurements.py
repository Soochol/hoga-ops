"""Isolated Range profiler and endpoint evidence orchestration."""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal, NoReturn, TextIO
from urllib.parse import urlencode

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, ValidationError

from hoga.api.models import RangeBundle
from hoga.api.queries import QueryEngine
from hoga.api.routes import build_router

if __package__:
    from tools.profile_live_range import profile_range_case
    from tools.range_measurement_policy import (
        TRADING_CALENDAR_POLICY,
        fixture_only_trading_calendar,
    )
    from tools.range_request_manifest import (
        LoadedRequestManifest,
        RangeRequestManifest,
        load_request_manifest,
    )
else:
    from profile_live_range import profile_range_case  # type: ignore[import-not-found]
    from range_measurement_policy import (  # type: ignore[import-not-found]
        TRADING_CALENDAR_POLICY,
        fixture_only_trading_calendar,
    )
    from range_request_manifest import (  # type: ignore[import-not-found]
        LoadedRequestManifest,
        RangeRequestManifest,
        load_request_manifest,
    )

EvidenceLeg = Literal["profile", "endpoint_identity", "endpoint_gzip"]
TrialKind = Literal["cold", "warm"]
EVIDENCE_LEGS: tuple[EvidenceLeg, ...] = (
    "profile",
    "endpoint_identity",
    "endpoint_gzip",
)
_HTTP_SUCCESS_MIN = 200
_HTTP_SUCCESS_MAX_EXCLUSIVE = 300


class RangeMeasurementError(RuntimeError):
    """A typed, user-facing Range measurement failure."""


class ReflinkCloneError(RangeMeasurementError):
    """The immutable source fixture could not be cloned copy-on-write."""


class ChildMeasurementError(RangeMeasurementError):
    """A fresh measurement child exited without one valid result."""


class SourceFixtureMutationError(RangeMeasurementError):
    """The source fixture changed while an isolated measurement was running."""


@dataclass(frozen=True, slots=True)
class RangeWindow:
    label: str
    from_date: str
    to_date: str

    def __post_init__(self) -> None:
        if re.fullmatch(r"[a-z0-9][a-z0-9-]*", self.label) is None:
            raise ValueError("window label must contain lowercase letters, digits, or hyphens")
        try:
            parsed_from = datetime.strptime(self.from_date, "%Y%m%d")
            parsed_to = datetime.strptime(self.to_date, "%Y%m%d")
        except ValueError as exc:
            raise ValueError("window dates must use YYYYMMDD") from exc
        if parsed_to < parsed_from:
            raise ValueError("window from_date must not be after to_date")


@dataclass(frozen=True, slots=True)
class ChildExecution:
    returncode: int
    result: Mapping[str, object] | None
    stderr: str


def _validate_source_fixture(source: Path) -> None:
    if source.is_symlink():
        raise ReflinkCloneError("source fixture must not be a symlink")
    if not source.is_dir():
        raise ReflinkCloneError("source fixture must be an existing directory")
    try:
        symlink = next((path for path in source.rglob("*") if path.is_symlink()), None)
    except OSError as exc:
        raise ReflinkCloneError("source fixture could not be inspected safely") from exc
    if symlink is not None:
        relative = symlink.relative_to(source).as_posix()
        raise ReflinkCloneError(f"source fixture contains symlink: {relative}")


def _reject_traversed_symlink_components(source: Path) -> None:
    """Walk the lexical path without following any component symlinks."""
    absolute = source.absolute()
    flags = (
        getattr(os, "O_PATH", os.O_RDONLY)
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | os.O_CLOEXEC
    )
    try:
        current_fd = os.open(absolute.anchor, flags)
    except OSError as exc:
        raise ReflinkCloneError(
            "source fixture must be an existing resolvable directory"
        ) from exc
    try:
        for component in absolute.parts[1:]:
            try:
                next_fd = os.open(component, flags, dir_fd=current_fd)
            except OSError as exc:
                try:
                    component_stat = os.stat(
                        component,
                        dir_fd=current_fd,
                        follow_symlinks=False,
                    )
                except OSError:
                    component_stat = None
                if component_stat is not None and stat.S_ISLNK(
                    component_stat.st_mode
                ):
                    raise ReflinkCloneError(
                        "source fixture path traverses a symlink"
                    ) from exc
                raise ReflinkCloneError(
                    "source fixture must be an existing resolvable directory"
                ) from exc
            os.close(current_fd)
            current_fd = next_fd
    finally:
        os.close(current_fd)


def _resolve_source_fixture(source: Path) -> Path:
    _reject_traversed_symlink_components(source)
    try:
        resolved = source.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ReflinkCloneError(
            "source fixture must be an existing resolvable directory"
        ) from exc
    _validate_source_fixture(resolved)
    return resolved


def _assert_outside_source(source: Path, candidate: Path) -> None:
    resolved_candidate = candidate.resolve(strict=False)
    if resolved_candidate == source or source in resolved_candidate.parents:
        raise ReflinkCloneError("measurement temp root must be outside source fixture")


def clone_fixture_reflink(source: Path, destination: Path) -> None:
    """Clone with mandatory reflinks; never fall back to a byte-for-byte copy."""
    source = _resolve_source_fixture(source)
    _assert_outside_source(source, destination)
    if destination.exists():
        raise ReflinkCloneError("reflink destination must not already exist")
    destination.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [
            "cp",
            "--archive",
            "--reflink=always",
            "--",
            str(source),
            str(destination),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0 or not destination.is_dir():
        if destination.exists():
            shutil.rmtree(destination)
        detail = completed.stderr.strip() or "copy-on-write clone was not created"
        raise ReflinkCloneError(f"reflink clone failed: {detail}")


def _source_fixture_identity(source: Path) -> str:
    """Hash relative metadata only, never the source's absolute user path."""
    digest = hashlib.sha256()
    root_stat = source.stat()
    digest.update(
        f"{source.name}\0{root_stat.st_dev}\0{root_stat.st_ino}\0".encode()
    )
    for path in sorted(source.rglob("*"), key=lambda item: item.relative_to(source).as_posix()):
        relative = path.relative_to(source).as_posix()
        stat_result = path.lstat()
        digest.update(
            f"{relative}\0{stat_result.st_mode}\0{stat_result.st_size}\0"
            f"{stat_result.st_mtime_ns}\0".encode()
        )
    return f"sha256:{digest.hexdigest()}"


def _observed_source_fixture_identity(source: Path) -> str | None:
    try:
        return _source_fixture_identity(source)
    except (OSError, RuntimeError):
        return None


def _initial_cache_state(clone: Path) -> dict[str, object]:
    cache_dir = clone / "kis-past-indicators"
    if not cache_dir.exists():
        return {"state": "absent", "file_count": 0, "total_bytes": 0}
    files = [path for path in cache_dir.rglob("*") if path.is_file()]
    return {
        "state": "populated" if files else "empty",
        "file_count": len(files),
        "total_bytes": sum(path.stat().st_size for path in files),
    }


def _range_query_string(
    *,
    request_manifest: RangeRequestManifest,
    code: str,
    from_date: str,
    to_date: str,
) -> bytes:
    kwargs = request_manifest.request_kwargs(
        code=code,
        from_date=from_date,
        to_date=to_date,
    )
    query_items: list[tuple[str, str]] = [
        ("code", code),
        ("from", from_date),
        ("to", to_date),
    ]
    for key, value in kwargs.items():
        if key in {"code", "from_date", "to_date"} or value is None:
            continue
        rendered = str(value).lower() if isinstance(value, bool) else str(value)
        query_items.append((key, rendered))
    return urlencode(query_items).encode()


def _decode_and_validate_body(
    *,
    wire_body: bytes,
    content_encoding: str,
    status: int,
    response_model: type[BaseModel] | None,
) -> tuple[bytes, str, str | None]:
    validation_error: str | None = None
    try:
        raw_body = gzip.decompress(wire_body) if content_encoding == "gzip" else wire_body
    except (EOFError, OSError) as exc:
        raw_body = b""
        validation_error = f"gzip:{type(exc).__name__}"

    if response_model is None:
        return raw_body, "not_requested", validation_error
    if not _HTTP_SUCCESS_MIN <= status < _HTTP_SUCCESS_MAX_EXCLUSIVE:
        return raw_body, "not_success", validation_error
    if validation_error is not None:
        return raw_body, "invalid", validation_error
    try:
        response_model.model_validate_json(raw_body)
    except (ValidationError, ValueError) as exc:
        return raw_body, "invalid", type(exc).__name__
    return raw_body, "valid", None


async def measure_asgi_response(
    app: Callable[
        [dict[str, object], Callable[[], Awaitable[dict]], Callable[[dict], Awaitable[None]]],
        Awaitable[None],
    ],
    *,
    query_string: bytes,
    accept_encoding: Literal["identity", "gzip"],
    response_model: type[BaseModel] | None,
) -> dict[str, object]:
    """Measure the raw ASGI start/body path without client auto-decompression."""
    started = time.perf_counter()
    ttfb_ms: float | None = None
    end_of_body_ms: float | None = None
    status: int | None = None
    response_headers: list[tuple[bytes, bytes]] = []
    body_frames: list[bytes] = []
    final_body_seen = False
    request_sent = False

    async def receive() -> dict[str, object]:
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        nonlocal ttfb_ms, end_of_body_ms, status, response_headers, final_body_seen
        if message["type"] == "http.response.start":
            status = int(message["status"])
            response_headers = list(message.get("headers", []))
            ttfb_ms = (time.perf_counter() - started) * 1_000
        elif message["type"] == "http.response.body":
            body_frames.append(message.get("body", b""))
            if not message.get("more_body", False):
                final_body_seen = True
                end_of_body_ms = (time.perf_counter() - started) * 1_000

    scope: dict[str, object] = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/range",
        "raw_path": b"/api/range",
        "query_string": query_string,
        "root_path": "",
        "headers": [
            (b"host", b"range-measurement.invalid"),
            (b"accept", b"application/json"),
            (b"accept-encoding", accept_encoding.encode()),
        ],
        "client": ("127.0.0.1", 1),
        "server": ("range-measurement.invalid", 80),
    }
    await app(scope, receive, send)
    if status is None or ttfb_ms is None or end_of_body_ms is None or not final_body_seen:
        raise RuntimeError("ASGI response did not complete with start and final body frames")

    headers = {key.lower(): value for key, value in response_headers}
    content_encoding = headers.get(b"content-encoding", b"identity").decode("latin-1")
    wire_body = b"".join(body_frames)
    raw_body, validation_outcome, validation_error = _decode_and_validate_body(
        wire_body=wire_body,
        content_encoding=content_encoding,
        status=status,
        response_model=response_model,
    )

    return {
        "ttfb_ms": round(ttfb_ms, 3),
        "end_of_body_ms": round(end_of_body_ms, 3),
        "status": status,
        "raw_body_bytes": len(raw_body),
        "gzip_body_bytes": len(wire_body) if content_encoding == "gzip" else None,
        "wire_body_bytes": len(wire_body),
        "content_encoding": content_encoding,
        "response_validation_outcome": validation_outcome,
        "response_validation_error": validation_error,
        "body_frame_count": len(body_frames),
    }


def create_range_measurement_app(
    data_dir: Path,
    *,
    temp_directory: Path | None = None,
) -> tuple[FastAPI, QueryEngine]:
    """Build only the real Range route/model and production GZip middleware."""
    engine = QueryEngine(data_dir, temp_directory=temp_directory)
    app = FastAPI(title="Range measurement app")
    app.add_middleware(GZipMiddleware, minimum_size=1_024)
    app.include_router(build_router(engine))
    return app, engine


async def _measure_range_endpoint_case_on_app(
    *,
    app: FastAPI,
    label: str,
    request_manifest: RangeRequestManifest,
    manifest_source_name: str,
    code: str,
    from_date: str,
    to_date: str,
    accept_encoding: Literal["identity", "gzip"],
) -> dict[str, object]:
    with fixture_only_trading_calendar():
        measurement = await measure_asgi_response(
            app,
            query_string=_range_query_string(
                request_manifest=request_manifest,
                code=code,
                from_date=from_date,
                to_date=to_date,
            ),
            accept_encoding=accept_encoding,
            response_model=RangeBundle,
        )
    return {
        "label": label,
        "configuration_name": request_manifest.name,
        "request_manifest_name": manifest_source_name,
        "request_manifest_sha256": request_manifest.sha256(),
        "request_manifest": request_manifest.normalized(),
        "trading_calendar_policy": TRADING_CALENDAR_POLICY,
        **measurement,
    }


async def measure_range_endpoint_case(
    *,
    data_dir: Path,
    label: str,
    request_manifest: RangeRequestManifest,
    manifest_source_name: str,
    code: str,
    from_date: str,
    to_date: str,
    accept_encoding: Literal["identity", "gzip"],
    temp_directory: Path | None = None,
) -> dict[str, object]:
    app, engine = create_range_measurement_app(
        data_dir,
        temp_directory=temp_directory,
    )
    try:
        return await _measure_range_endpoint_case_on_app(
            app=app,
            label=label,
            request_manifest=request_manifest,
            manifest_source_name=manifest_source_name,
            code=code,
            from_date=from_date,
            to_date=to_date,
            accept_encoding=accept_encoding,
        )
    finally:
        engine.close()


def _run_child_process(
    leg: str,
    clone_path: Path,
    label: str,
    manifest: LoadedRequestManifest,
    window: RangeWindow,
    code: str,
) -> ChildExecution:
    trial_kind = label.rsplit(":", maxsplit=3)[-3]
    if trial_kind not in {"cold", "warm"}:
        raise ValueError("child label must contain a cold or warm trial kind")
    manifest_path = clone_path.parent / "request-manifest.json"
    manifest_path.write_text(manifest.manifest.canonical_json(), encoding="utf-8")
    command = [
        sys.executable,
        "-m",
        "tools.run_range_measurements",
        "_child",
        "--leg",
        leg,
        "--trial-kind",
        trial_kind,
        "--data-dir",
        str(clone_path),
        "--label",
        label,
        "--request-manifest",
        str(manifest_path),
        "--manifest-source-name",
        manifest.source_name,
        "--code",
        code,
        "--from",
        window.from_date,
        "--to",
        window.to_date,
    ]
    completed = subprocess.run(
        command,
        cwd=Path(__file__).resolve().parents[1],
        check=False,
        capture_output=True,
        text=True,
    )
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    result: Mapping[str, object] | None = None
    if completed.returncode == 0 and len(lines) == 1:
        try:
            parsed = json.loads(lines[0])
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            result = parsed
    return ChildExecution(
        returncode=completed.returncode,
        result=result,
        stderr=completed.stderr.strip(),
    )


ChildRunner = Callable[
    [str, Path, str, LoadedRequestManifest, RangeWindow, str],
    ChildExecution,
]


def _emit_evidence(output: TextIO, row: Mapping[str, object]) -> None:
    print(json.dumps(row, ensure_ascii=False, sort_keys=True), file=output, flush=True)


def _operational_failure_detail(exc: OSError | ReflinkCloneError) -> str:
    if isinstance(exc, OSError):
        detail = exc.strerror
        if detail is None and len(exc.args) == 1 and isinstance(exc.args[0], str):
            detail = exc.args[0]
        return f"{type(exc).__name__}: {detail or 'operation failed'}"
    return f"{type(exc).__name__}: {exc}"


def _raise_if_source_mutated(
    *,
    source_fixture: Path,
    fixture_identity: str,
    output: TextIO,
    record: Mapping[str, object],
    message: str,
    cause: BaseException | None = None,
) -> None:
    observed_identity = _observed_source_fixture_identity(source_fixture)
    if observed_identity == fixture_identity:
        return
    _emit_evidence(
        output,
        {
            **record,
            "status": "SOURCE_MUTATED",
            "source_mutated": True,
            "evidence_issues": ["source_mutated"],
            "observed_source_fixture_identity": observed_identity,
        },
    )
    error = SourceFixtureMutationError(message)
    if cause is None:
        raise error
    raise error from cause


def _raise_leg_failure(
    *,
    source_fixture: Path,
    fixture_identity: str,
    output: TextIO,
    trial_record: Mapping[str, object],
    leg: str,
    exit_statuses: Mapping[str, int],
    detail: str,
    cause: BaseException | None = None,
) -> NoReturn:
    failure = {
        **trial_record,
        "status": "CHILD_FAILED",
        "failed_leg": leg,
        "child_exit_status": dict(exit_statuses),
        "child_stderr": detail,
    }
    _emit_evidence(output, failure)
    _raise_if_source_mutated(
        source_fixture=source_fixture,
        fixture_identity=fixture_identity,
        output=output,
        record=failure,
        message="declared immutable source fixture changed after child failure",
        cause=cause,
    )
    error = ChildMeasurementError(f"{trial_record['trial_group']} child failed: {leg}")
    if cause is None:
        raise error
    raise error from cause


def _execute_trial_leg(
    *,
    source_fixture: Path,
    fixture_identity: str,
    output: TextIO,
    trial_record: Mapping[str, object],
    leg: EvidenceLeg,
    label: str,
    loaded: LoadedRequestManifest,
    window: RangeWindow,
    code: str,
    exit_statuses: dict[str, int],
    clone_fixture: Callable[[Path, Path], None],
    run_child: ChildRunner,
) -> tuple[Mapping[str, object], dict[str, object]]:
    try:
        with tempfile.TemporaryDirectory(
            prefix=".hoga-range-measure-",
            dir=source_fixture.parent,
        ) as temp_dir:
            _assert_outside_source(source_fixture, Path(temp_dir))
            clone_path = Path(temp_dir) / "fixture"
            clone_fixture(source_fixture, clone_path)
            cache_state = _initial_cache_state(clone_path)
            execution = run_child(
                leg,
                clone_path,
                label,
                loaded,
                window,
                code,
            )
    except (OSError, ReflinkCloneError) as exc:
        _raise_leg_failure(
            source_fixture=source_fixture,
            fixture_identity=fixture_identity,
            output=output,
            trial_record=trial_record,
            leg=leg,
            exit_statuses=exit_statuses,
            detail=_operational_failure_detail(exc),
            cause=exc,
        )

    exit_statuses[leg] = execution.returncode
    if execution.returncode != 0 or execution.result is None:
        _raise_leg_failure(
            source_fixture=source_fixture,
            fixture_identity=fixture_identity,
            output=output,
            trial_record=trial_record,
            leg=leg,
            exit_statuses=exit_statuses,
            detail=execution.stderr,
        )
    _raise_if_source_mutated(
        source_fixture=source_fixture,
        fixture_identity=fixture_identity,
        output=output,
        record={
            **trial_record,
            "child_exit_status": dict(exit_statuses),
        },
        message="declared immutable source fixture changed after successful child leg",
    )
    return execution.result, cache_state


def _commit_sha() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(__file__).resolve().parents[1],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def _is_non_negative_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def _manifest_metadata_issues(
    *,
    result: Mapping[str, object],
    leg: str,
    expected_label: str,
    loaded: LoadedRequestManifest,
) -> list[str]:
    expected = {
        "label": expected_label,
        "configuration_name": loaded.manifest.name,
        "request_manifest_name": loaded.source_name,
        "request_manifest_sha256": loaded.manifest.sha256(),
        "request_manifest": loaded.manifest.normalized(),
        "trading_calendar_policy": TRADING_CALENDAR_POLICY,
    }
    return [
        f"{leg}_{field}"
        for field, expected_value in expected.items()
        if result.get(field) != expected_value
    ]


def _profile_evidence_issues(
    result: Mapping[str, object],
    *,
    expected_profile_functions: frozenset[str],
) -> list[str]:
    issues: list[str] = []
    if not _is_non_negative_number(result.get("total_ms")):
        issues.append("profile_total_ms")
    if result.get("expected_profile_functions") != sorted(
        expected_profile_functions
    ):
        issues.append("profile_expected_profile_functions")

    result_counts = result.get("result_counts")
    if (
        not isinstance(result_counts, Mapping)
        or not result_counts
        or any(
            not isinstance(value, int) or isinstance(value, bool) or value < 0
            for value in result_counts.values()
        )
    ):
        issues.append("profile_result_counts")

    functions = result.get("functions")
    if not isinstance(functions, Mapping):
        issues.append("profile_functions")
        timed_functions: Mapping[str, object] = {}
    else:
        timed_functions = functions
        for timing in functions.values():
            if (
                not isinstance(timing, Mapping)
                or not _is_non_negative_number(timing.get("total_ms"))
                or not isinstance(timing.get("calls"), int)
                or isinstance(timing.get("calls"), bool)
                or timing["calls"] <= 0
            ):
                issues.append("profile_functions")
                break
    for function_name in sorted(expected_profile_functions):
        timing = timed_functions.get(function_name)
        if (
            not isinstance(timing, Mapping)
            or not isinstance(timing.get("calls"), int)
            or isinstance(timing.get("calls"), bool)
            or timing["calls"] <= 0
        ):
            issues.append(f"missing_profile_function:{function_name}")
    return issues


def _endpoint_evidence_issues(
    result: Mapping[str, object],
    *,
    leg: Literal["endpoint_identity", "endpoint_gzip"],
) -> list[str]:
    issues: list[str] = []
    status = result.get("status")
    if (
        not isinstance(status, int)
        or isinstance(status, bool)
        or not _HTTP_SUCCESS_MIN <= status < _HTTP_SUCCESS_MAX_EXCLUSIVE
    ):
        issues.append(f"{leg}_status")
    if result.get("response_validation_outcome") != "valid":
        issues.append(f"{leg}_validation")
    if result.get("response_validation_error") is not None:
        issues.append(f"{leg}_validation_error")

    ttfb_ms = result.get("ttfb_ms")
    end_of_body_ms = result.get("end_of_body_ms")
    if (
        not _is_non_negative_number(ttfb_ms)
        or not _is_non_negative_number(end_of_body_ms)
        or (
            _is_non_negative_number(ttfb_ms)
            and _is_non_negative_number(end_of_body_ms)
            and end_of_body_ms < ttfb_ms
        )
    ):
        issues.append(f"{leg}_timings")

    raw_body_bytes = result.get("raw_body_bytes")
    wire_body_bytes = result.get("wire_body_bytes")
    body_frame_count = result.get("body_frame_count")
    if (
        not isinstance(raw_body_bytes, int)
        or isinstance(raw_body_bytes, bool)
        or raw_body_bytes <= 0
        or not isinstance(wire_body_bytes, int)
        or isinstance(wire_body_bytes, bool)
        or wire_body_bytes <= 0
        or not isinstance(body_frame_count, int)
        or isinstance(body_frame_count, bool)
        or body_frame_count <= 0
    ):
        issues.append(f"{leg}_body")

    expected_encoding = "gzip" if leg == "endpoint_gzip" else "identity"
    if result.get("content_encoding") != expected_encoding:
        issues.append(f"{leg}_content_encoding")
    gzip_body_bytes = result.get("gzip_body_bytes")
    if leg == "endpoint_gzip":
        if (
            not isinstance(gzip_body_bytes, int)
            or isinstance(gzip_body_bytes, bool)
            or gzip_body_bytes <= 0
            or wire_body_bytes != gzip_body_bytes
        ):
            issues.append(f"{leg}_gzip_body")
    elif gzip_body_bytes is not None or wire_body_bytes != raw_body_bytes:
        issues.append(f"{leg}_identity_body")
    return issues


def _evidence_issues(
    *,
    trial_group: str,
    trial_kind: TrialKind,
    loaded: LoadedRequestManifest,
    leg_results: Mapping[str, Mapping[str, object]],
) -> tuple[list[str], list[str]]:
    semantic_issues: list[str] = []
    expected_warmup_runs = 1 if trial_kind == "warm" else 0
    for leg in EVIDENCE_LEGS:
        semantic_issues.extend(
            _manifest_metadata_issues(
                result=leg_results[leg],
                leg=leg,
                expected_label=f"{trial_group}:{leg}",
                loaded=loaded,
            )
        )
        if leg_results[leg].get("warmup_runs") != expected_warmup_runs:
            semantic_issues.append(f"{leg}_warmup_runs")
    semantic_issues.extend(
        _profile_evidence_issues(
            leg_results["profile"],
            expected_profile_functions=loaded.manifest.expected_profile_functions(),
        )
    )
    semantic_issues.extend(
        _endpoint_evidence_issues(
            leg_results["endpoint_identity"],
            leg="endpoint_identity",
        )
    )
    semantic_issues.extend(
        _endpoint_evidence_issues(
            leg_results["endpoint_gzip"],
            leg="endpoint_gzip",
        )
    )
    if (
        leg_results["endpoint_identity"].get("raw_body_bytes")
        != leg_results["endpoint_gzip"].get("raw_body_bytes")
    ):
        semantic_issues.append("endpoint_raw_body_bytes_mismatch")
    gate_issues = [*semantic_issues]
    if trial_kind != "cold":
        gate_issues.append("trial_kind_not_cold")
    return semantic_issues, gate_issues


def run_measurement_matrix(
    *,
    source_fixture: Path,
    code: str,
    windows: Sequence[RangeWindow],
    manifests: Sequence[LoadedRequestManifest],
    cold_trials: int,
    warm_trials: int,
    output: TextIO,
    commit_sha: str | None = None,
    clone_fixture: Callable[[Path, Path], None] = clone_fixture_reflink,
    run_child: ChildRunner = _run_child_process,
) -> None:
    """Run each evidence leg in a fresh process/reflink clone and join by trial."""
    source_fixture = _resolve_source_fixture(source_fixture)
    _assert_outside_source(source_fixture, source_fixture.parent)
    if not windows or not manifests:
        raise ValueError("at least one window and request manifest are required")
    if cold_trials < 0 or warm_trials < 0 or cold_trials + warm_trials == 0:
        raise ValueError("at least one non-negative cold/warm trial is required")

    fixture_identity = _source_fixture_identity(source_fixture)
    resolved_commit_sha = commit_sha or _commit_sha()
    trial_counts: tuple[tuple[TrialKind, int], ...] = (
        ("cold", cold_trials),
        ("warm", warm_trials),
    )
    for window in windows:
        for loaded in manifests:
            for trial_kind, count in trial_counts:
                for ordinal in range(1, count + 1):
                    trial_group = (
                        f"range:{loaded.manifest.name}:{window.label}:"
                        f"{trial_kind}:{ordinal}"
                    )
                    leg_results: dict[str, Mapping[str, object]] = {}
                    exit_statuses: dict[str, int] = {}
                    cache_states: dict[str, dict[str, object]] = {}
                    source_cache_state = _initial_cache_state(source_fixture)
                    trial_record = {
                        "record_type": "range_trial",
                        "trial_group": trial_group,
                        "trial_kind": trial_kind,
                        "source_fixture_identity": fixture_identity,
                        "configuration_name": loaded.manifest.name,
                        "request_manifest_name": loaded.source_name,
                        "request_manifest_sha256": loaded.manifest.sha256(),
                        "commit_sha": resolved_commit_sha,
                    }
                    for leg in EVIDENCE_LEGS:
                        result, cache_state = _execute_trial_leg(
                            source_fixture=source_fixture,
                            fixture_identity=fixture_identity,
                            output=output,
                            trial_record=trial_record,
                            leg=leg,
                            label=f"{trial_group}:{leg}",
                            loaded=loaded,
                            window=window,
                            code=code,
                            exit_statuses=exit_statuses,
                            clone_fixture=clone_fixture,
                            run_child=run_child,
                        )
                        leg_results[leg] = result
                        cache_states[leg] = cache_state
                    _raise_if_source_mutated(
                        source_fixture=source_fixture,
                        fixture_identity=fixture_identity,
                        output=output,
                        record={
                            **trial_record,
                            "child_exit_status": dict(exit_statuses),
                        },
                        message="declared immutable source fixture changed",
                    )
                    semantic_issues, gate_issues = _evidence_issues(
                        trial_group=trial_group,
                        trial_kind=trial_kind,
                        loaded=loaded,
                        leg_results=leg_results,
                    )
                    if trial_kind == "cold" and (
                        source_cache_state["state"] == "populated"
                        or any(
                            state["state"] == "populated"
                            for state in cache_states.values()
                        )
                    ):
                        gate_issues.append("cold_cache_not_empty")
                    joined = {
                        "record_type": "range_trial",
                        "status": "ok" if not semantic_issues else "EVIDENCE_INVALID",
                        "gate_eligible": not gate_issues,
                        "evidence_issues": gate_issues,
                        "trial_group": trial_group,
                        "trial_kind": trial_kind,
                        "trial_ordinal": ordinal,
                        "window": {
                            "label": window.label,
                            "from": window.from_date,
                            "to": window.to_date,
                        },
                        "configuration_name": loaded.manifest.name,
                        "request_manifest_name": loaded.source_name,
                        "request_manifest_sha256": loaded.manifest.sha256(),
                        "request_manifest": loaded.manifest.normalized(),
                        "expected_profile_functions": sorted(
                            loaded.manifest.expected_profile_functions()
                        ),
                        "source_fixture_identity": fixture_identity,
                        "source_cache_state": source_cache_state,
                        "initial_cache_state": cache_states,
                        "os_cache_state": "uncontrolled",
                        "child_exit_status": exit_statuses,
                        "commit_sha": resolved_commit_sha,
                        "profile": leg_results["profile"],
                        "endpoint": {
                            "identity": leg_results["endpoint_identity"],
                            "gzip": leg_results["endpoint_gzip"],
                        },
                    }
                    _emit_evidence(output, joined)


def _parse_window(value: str) -> RangeWindow:
    try:
        label, from_date, to_date = value.split(":", maxsplit=2)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("window must be LABEL:FROM:TO") from exc
    try:
        return RangeWindow(label, from_date, to_date)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must be non-negative")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Collect isolated Range profiler and endpoint evidence."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--source-fixture", type=Path, required=True)
    run_parser.add_argument("--code", required=True)
    run_parser.add_argument("--window", type=_parse_window, action="append", required=True)
    run_parser.add_argument(
        "--request-manifest",
        type=Path,
        action="append",
        required=True,
    )
    run_parser.add_argument("--cold-trials", type=_non_negative_int, default=3)
    run_parser.add_argument("--warm-trials", type=_non_negative_int, default=0)

    child_parser = subparsers.add_parser("_child")
    child_parser.add_argument("--leg", choices=EVIDENCE_LEGS, required=True)
    child_parser.add_argument("--trial-kind", choices=("cold", "warm"), required=True)
    child_parser.add_argument("--data-dir", type=Path, required=True)
    child_parser.add_argument("--label", required=True)
    child_parser.add_argument("--request-manifest", type=Path, required=True)
    child_parser.add_argument("--manifest-source-name", required=True)
    child_parser.add_argument("--code", required=True)
    child_parser.add_argument("--from", dest="from_date", required=True)
    child_parser.add_argument("--to", dest="to_date", required=True)
    return parser


def _run_child_command(args: argparse.Namespace) -> dict[str, object]:
    loaded = load_request_manifest(args.request_manifest)
    temp_directory = args.data_dir / ".measurement" / "duckdb-tmp"
    warmup_runs = 1 if args.trial_kind == "warm" else 0
    if args.leg == "profile":
        engine = QueryEngine(args.data_dir, temp_directory=temp_directory)
        try:
            if warmup_runs:
                profile_range_case(
                    engine,
                    label=args.label,
                    request_manifest=loaded.manifest,
                    code=args.code,
                    from_date=args.from_date,
                    to_date=args.to_date,
                    manifest_source_name=args.manifest_source_name,
                )
            result = profile_range_case(
                engine,
                label=args.label,
                request_manifest=loaded.manifest,
                code=args.code,
                from_date=args.from_date,
                to_date=args.to_date,
                manifest_source_name=args.manifest_source_name,
            )
        finally:
            engine.close()
        return {**result, "warmup_runs": warmup_runs}
    encoding: Literal["identity", "gzip"] = (
        "identity" if args.leg == "endpoint_identity" else "gzip"
    )

    async def run_endpoint_child() -> dict[str, object]:
        app, engine = create_range_measurement_app(
            args.data_dir,
            temp_directory=temp_directory,
        )
        kwargs = {
            "app": app,
            "label": args.label,
            "request_manifest": loaded.manifest,
            "manifest_source_name": args.manifest_source_name,
            "code": args.code,
            "from_date": args.from_date,
            "to_date": args.to_date,
            "accept_encoding": encoding,
        }
        try:
            if warmup_runs:
                await _measure_range_endpoint_case_on_app(**kwargs)
            return await _measure_range_endpoint_case_on_app(**kwargs)
        finally:
            engine.close()

    result = asyncio.run(run_endpoint_child())
    return {**result, "warmup_runs": warmup_runs}


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "_child":
        print(json.dumps(_run_child_command(args), ensure_ascii=False, sort_keys=True))
        return
    if not args.source_fixture.is_dir():
        parser.error("--source-fixture must be an existing directory")
    try:
        manifests = tuple(load_request_manifest(path) for path in args.request_manifest)
    except ValueError as exc:
        parser.error(str(exc))
    try:
        run_measurement_matrix(
            source_fixture=args.source_fixture,
            code=args.code,
            windows=tuple(args.window),
            manifests=manifests,
            cold_trials=args.cold_trials,
            warm_trials=args.warm_trials,
            output=sys.stdout,
        )
    except RangeMeasurementError as exc:
        parser.exit(1, f"{parser.prog}: error: {exc}\n")


if __name__ == "__main__":
    main()
