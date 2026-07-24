"""Isolated Range profiler and endpoint evidence orchestration."""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import io
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal
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


class ReflinkCloneError(RuntimeError):
    """The immutable source fixture could not be cloned copy-on-write."""


class ChildMeasurementError(RuntimeError):
    """A fresh measurement child exited without one valid result."""


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


def clone_fixture_reflink(source: Path, destination: Path) -> None:
    """Clone with mandatory reflinks; never fall back to a byte-for-byte copy."""
    _validate_source_fixture(source)
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


def create_range_measurement_app(data_dir: Path) -> tuple[FastAPI, QueryEngine]:
    """Build only the real Range route/model and production GZip middleware."""
    engine = QueryEngine(data_dir)
    app = FastAPI(title="Range measurement app")
    app.add_middleware(GZipMiddleware, minimum_size=1_024)
    app.include_router(build_router(engine))
    return app, engine


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
) -> dict[str, object]:
    app, engine = create_range_measurement_app(data_dir)
    try:
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
    finally:
        engine.close()
    return {
        "label": label,
        "configuration_name": request_manifest.name,
        "request_manifest_name": manifest_source_name,
        "request_manifest_sha256": request_manifest.sha256(),
        "request_manifest": request_manifest.normalized(),
        "trading_calendar_policy": TRADING_CALENDAR_POLICY,
        **measurement,
    }


def _run_child_process(
    leg: str,
    clone_path: Path,
    label: str,
    manifest: LoadedRequestManifest,
    window: RangeWindow,
    code: str,
) -> ChildExecution:
    manifest_path = clone_path.parent / "request-manifest.json"
    manifest_path.write_text(manifest.manifest.canonical_json(), encoding="utf-8")
    command = [
        sys.executable,
        "-m",
        "tools.run_range_measurements",
        "_child",
        "--leg",
        leg,
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


def _profile_evidence_issues(result: Mapping[str, object]) -> list[str]:
    issues: list[str] = []
    if not _is_non_negative_number(result.get("total_ms")):
        issues.append("profile_total_ms")

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
    if not isinstance(functions, Mapping) or not functions:
        issues.append("profile_functions")
    else:
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
    for leg in EVIDENCE_LEGS:
        semantic_issues.extend(
            _manifest_metadata_issues(
                result=leg_results[leg],
                leg=leg,
                expected_label=f"{trial_group}:{leg}",
                loaded=loaded,
            )
        )
    semantic_issues.extend(_profile_evidence_issues(leg_results["profile"]))
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
    commit_sha: str | None = None,
    clone_fixture: Callable[[Path, Path], None] = clone_fixture_reflink,
    run_child: ChildRunner = _run_child_process,
) -> str:
    """Run each evidence leg in a fresh process/reflink clone and join by trial."""
    _validate_source_fixture(source_fixture)
    if not windows or not manifests:
        raise ValueError("at least one window and request manifest are required")
    if cold_trials < 0 or warm_trials < 0 or cold_trials + warm_trials == 0:
        raise ValueError("at least one non-negative cold/warm trial is required")

    fixture_identity = _source_fixture_identity(source_fixture)
    resolved_commit_sha = commit_sha or _commit_sha()
    output = io.StringIO()
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
                    for leg in EVIDENCE_LEGS:
                        with tempfile.TemporaryDirectory(
                            prefix=".hoga-range-measure-",
                            dir=source_fixture.parent,
                        ) as temp_dir:
                            clone_path = Path(temp_dir) / "fixture"
                            clone_fixture(source_fixture, clone_path)
                            cache_states[leg] = _initial_cache_state(clone_path)
                            execution = run_child(
                                leg,
                                clone_path,
                                f"{trial_group}:{leg}",
                                loaded,
                                window,
                                code,
                            )
                            exit_statuses[leg] = execution.returncode
                            if execution.returncode != 0 or execution.result is None:
                                failure = {
                                    "record_type": "range_trial",
                                    "status": "CHILD_FAILED",
                                    "trial_group": trial_group,
                                    "trial_kind": trial_kind,
                                    "failed_leg": leg,
                                    "child_exit_status": exit_statuses,
                                    "child_stderr": execution.stderr,
                                    "source_fixture_identity": fixture_identity,
                                    "configuration_name": loaded.manifest.name,
                                    "request_manifest_name": loaded.source_name,
                                    "request_manifest_sha256": loaded.manifest.sha256(),
                                    "commit_sha": resolved_commit_sha,
                                }
                                print(json.dumps(failure, sort_keys=True), file=output)
                                raise ChildMeasurementError(output.getvalue().rstrip())
                            leg_results[leg] = execution.result
                    if _source_fixture_identity(source_fixture) != fixture_identity:
                        raise RuntimeError("declared immutable source fixture changed")
                    semantic_issues, gate_issues = _evidence_issues(
                        trial_group=trial_group,
                        trial_kind=trial_kind,
                        loaded=loaded,
                        leg_results=leg_results,
                    )
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
                        "source_fixture_identity": fixture_identity,
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
                    print(json.dumps(joined, ensure_ascii=False, sort_keys=True), file=output)
    return output.getvalue()


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
    if args.leg == "profile":
        engine = QueryEngine(args.data_dir)
        try:
            return profile_range_case(
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
    encoding: Literal["identity", "gzip"] = (
        "identity" if args.leg == "endpoint_identity" else "gzip"
    )
    return asyncio.run(
        measure_range_endpoint_case(
            data_dir=args.data_dir,
            label=args.label,
            request_manifest=loaded.manifest,
            manifest_source_name=args.manifest_source_name,
            code=args.code,
            from_date=args.from_date,
            to_date=args.to_date,
            accept_encoding=encoding,
        )
    )


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
        output = run_measurement_matrix(
            source_fixture=args.source_fixture,
            code=args.code,
            windows=tuple(args.window),
            manifests=manifests,
            cold_trials=args.cold_trials,
            warm_trials=args.warm_trials,
        )
    except (ChildMeasurementError, ReflinkCloneError, ValueError) as exc:
        parser.error(str(exc))
    sys.stdout.write(output)


if __name__ == "__main__":
    main()
