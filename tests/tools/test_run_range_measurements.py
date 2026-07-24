from __future__ import annotations

import argparse
import asyncio
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware

from hoga.api import queries
from hoga.api.bundle import _empty_range_bundle
from hoga.api.models import QuoteRatio, QuoteRatioPoint, RangeBundle
from hoga.api.queries import QueryEngine
from tools import run_range_measurements
from tools.range_request_manifest import (
    LoadedRequestManifest,
    RangeRequestManifest,
)
from tools.run_range_measurements import (
    ChildExecution,
    ChildMeasurementError,
    RangeWindow,
    ReflinkCloneError,
    _run_child_command,
    clone_fixture_reflink,
    create_range_measurement_app,
    measure_asgi_response,
    measure_range_endpoint_case,
    run_measurement_matrix,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _manifest(*, name: str = "frontend-default-sidecar") -> RangeRequestManifest:
    return RangeRequestManifest.model_validate(
        {
            "schema_version": 1,
            "name": name,
            "request": {
                "bucket_ms": 60_000,
                "source_pref": "hogaplay_first",
                "mode": "sidecar",
                "broker_late_entries_enabled": False,
                "broker_late_entry_start_hhmm": 930,
                "volume_distribution_bins": None,
                "trade_volume_poc_bins": None,
                "volume_distribution_price_min": None,
                "volume_distribution_price_max": None,
                "volume_distribution_cutoff_ms": None,
                "ask_peaks_enabled": False,
                "bid_peaks_enabled": False,
                "program_trade_enabled": False,
                "trade_volume_poc_enabled": False,
                "depth_heatmap_enabled": False,
                "depth_delta_enabled": False,
            },
        }
    )


def _successful_child(
    leg: str,
    clone_path: Path,
    label: str,
    manifest: LoadedRequestManifest,
    window: RangeWindow,
    code: str,
) -> ChildExecution:
    metadata = {
        "configuration_name": manifest.manifest.name,
        "request_manifest_name": manifest.source_name,
        "request_manifest_sha256": manifest.manifest.sha256(),
        "request_manifest": manifest.manifest.normalized(),
        "trading_calendar_policy": "fixture-weekday-lenient-v1",
        "label": label,
        "warmup_runs": 1 if ":warm:" in label else 0,
    }
    if leg == "profile":
        result = {
            **metadata,
            "total_ms": 2.0,
            "result_counts": {"segments": 1},
            "functions": {"slice": {"total_ms": 1.0, "calls": 1}},
        }
    else:
        result = {
            **metadata,
            "status": 200,
            "ttfb_ms": 1.0,
            "end_of_body_ms": 2.0,
            "raw_body_bytes": 2_000,
            "gzip_body_bytes": 200 if leg == "endpoint_gzip" else None,
            "wire_body_bytes": 200 if leg == "endpoint_gzip" else 2_000,
            "content_encoding": "gzip" if leg == "endpoint_gzip" else "identity",
            "response_validation_outcome": "valid",
            "response_validation_error": None,
            "body_frame_count": 1,
        }
    return ChildExecution(returncode=0, result=result, stderr="")


def test_query_engine_uses_explicit_clone_local_temp_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[Path | None] = []
    fake_conn = SimpleNamespace(close=lambda: None)
    monkeypatch.setattr(
        queries,
        "connect_bounded",
        lambda *, temp_directory=None, **_: seen.append(temp_directory) or fake_conn,
    )

    temp_directory = tmp_path / "fixture" / ".measurement" / "duckdb-tmp"
    engine = QueryEngine(tmp_path / "fixture", temp_directory=temp_directory)
    engine.close()

    assert seen == [temp_directory]


def test_query_engine_preserves_default_temp_directory_when_omitted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[Path | None] = []
    fake_conn = SimpleNamespace(close=lambda: None)
    monkeypatch.setattr(
        queries,
        "connect_bounded",
        lambda *, temp_directory=None, **_: seen.append(temp_directory) or fake_conn,
    )

    engine = QueryEngine(tmp_path / "fixture")
    engine.close()

    assert seen == [None]


@pytest.mark.parametrize(
    "leg",
    ["profile", "endpoint_identity", "endpoint_gzip"],
)
def test_child_leg_uses_clone_local_temp_and_never_resolves_default_data(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    leg: str,
) -> None:
    clone = tmp_path / leg
    clone.mkdir()
    manifest = _manifest()
    manifest_path = tmp_path / f"{leg}-manifest.json"
    manifest_path.write_text(manifest.canonical_json(), encoding="utf-8")

    def forbidden_default_data_dir() -> Path:
        raise AssertionError("measurement child must not resolve the default data dir")

    monkeypatch.setattr("hoga.duck.resolve_data_dir", forbidden_default_data_dir)

    result = _run_child_command(
        argparse.Namespace(
            leg=leg,
            data_dir=clone,
            label=f"range:test:5d:cold:1:{leg}",
            request_manifest=manifest_path,
            manifest_source_name="test-manifest.json",
            code="005930",
            from_date="20260701",
            to_date="20260701",
            trial_kind="cold",
        )
    )

    assert result["warmup_runs"] == 0
    assert (clone / ".measurement" / "duckdb-tmp").is_dir()


@pytest.mark.asyncio
async def test_asgi_measurement_waits_for_final_body_frame() -> None:
    async def app(scope, receive, send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": b'{"a":', "more_body": True})
        await asyncio.sleep(0)
        await send({"type": "http.response.body", "body": b"1}", "more_body": False})

    result = await measure_asgi_response(
        app,
        query_string=b"",
        accept_encoding="identity",
        response_model=None,
    )

    assert result["status"] == 200
    assert result["raw_body_bytes"] == len(b'{"a":1}')
    assert result["wire_body_bytes"] == len(b'{"a":1}')
    assert result["gzip_body_bytes"] is None
    assert result["content_encoding"] == "identity"
    assert result["end_of_body_ms"] >= result["ttfb_ms"]
    assert result["body_frame_count"] == 2


@pytest.mark.asyncio
async def test_asgi_measurement_collects_identity_and_gzip_wire_bytes() -> None:
    bundle = _empty_range_bundle(
        "005930",
        "20260701",
        "20260701",
        60_000,
        excluded=[],
    )
    points = [
        QuoteRatioPoint(
            t=1_780_000_000_000 + index,
            bid_total=10_000 + index,
            ask_total=9_000 + index,
            bid_max=11_000 + index,
            ask_max=10_000 + index,
            imb_max_bid=12_000 + index,
            imb_max_ask=8_000 + index,
        )
        for index in range(100)
    ]
    bundle = bundle.model_copy(
        update={"quote_ratio": QuoteRatio(bucket_ms=60_000, points=points)}
    )
    app = FastAPI()

    @app.get("/api/range", response_model=RangeBundle)
    def _range() -> RangeBundle:
        return bundle

    app.add_middleware(GZipMiddleware, minimum_size=1_024)

    identity = await measure_asgi_response(
        app,
        query_string=b"",
        accept_encoding="identity",
        response_model=RangeBundle,
    )
    compressed = await measure_asgi_response(
        app,
        query_string=b"",
        accept_encoding="gzip",
        response_model=RangeBundle,
    )

    assert identity["content_encoding"] == "identity"
    assert identity["gzip_body_bytes"] is None
    assert identity["response_validation_outcome"] == "valid"
    assert compressed["content_encoding"] == "gzip"
    assert compressed["gzip_body_bytes"] == compressed["wire_body_bytes"]
    assert compressed["gzip_body_bytes"] < compressed["raw_body_bytes"]
    assert compressed["raw_body_bytes"] == identity["raw_body_bytes"]
    assert compressed["response_validation_outcome"] == "valid"


@pytest.mark.asyncio
async def test_range_measurement_app_uses_actual_route_without_production_lifespan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    startup_called = False

    async def forbidden_startup(*args: object, **kwargs: object) -> None:
        nonlocal startup_called
        startup_called = True
        raise AssertionError("production startup must not run")

    monkeypatch.setattr("hoga.api.app.start_app_runtime", forbidden_startup)

    result = await measure_range_endpoint_case(
        data_dir=tmp_path,
        label="cold:identity:1",
        request_manifest=_manifest(),
        manifest_source_name="frontend-default-sidecar.json",
        code="005930",
        from_date="20260701",
        to_date="20260701",
        accept_encoding="identity",
    )

    assert startup_called is False
    assert result["status"] == 200
    assert result["response_validation_outcome"] == "valid"
    assert result["request_manifest_name"] == "frontend-default-sidecar.json"
    assert result["configuration_name"] == "frontend-default-sidecar"

    app, engine = create_range_measurement_app(tmp_path)
    try:
        assert app.router.lifespan_context is not None
        assert not hasattr(app.state, "startup_runtime")
    finally:
        engine.close()


@pytest.mark.asyncio
async def test_range_endpoint_uses_fixture_only_calendar_for_populated_weekday_inventory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "parquet" / "20260701").mkdir(parents=True)
    calendar_called = False

    def forbidden_calendar_call(date: str) -> bool:
        nonlocal calendar_called
        calendar_called = True
        raise AssertionError("Range measurements must not call the external calendar")

    monkeypatch.setattr("hoga.api.calendar.is_trading_day", forbidden_calendar_call)

    result = await measure_range_endpoint_case(
        data_dir=tmp_path,
        label="cold:identity:1",
        request_manifest=_manifest(),
        manifest_source_name="frontend-default-sidecar.json",
        code="005930",
        from_date="20260701",
        to_date="20260701",
        accept_encoding="identity",
    )

    assert calendar_called is False
    assert result["status"] == 200
    assert result["response_validation_outcome"] == "valid"
    assert result["trading_calendar_policy"] == "fixture-weekday-lenient-v1"


def test_reflink_clone_fails_without_falling_back_to_full_copy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    (source / "sentinel").write_text("immutable", encoding="utf-8")
    destination = tmp_path / "destination"

    monkeypatch.setattr(
        "tools.run_range_measurements.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=1,
            stdout="",
            stderr="reflink not supported",
        ),
    )

    with pytest.raises(ReflinkCloneError, match="reflink"):
        clone_fixture_reflink(source, destination)

    assert destination.exists() is False
    assert (source / "sentinel").read_text(encoding="utf-8") == "immutable"


@pytest.mark.parametrize("symlink_at_root", [False, True])
def test_reflink_clone_rejects_source_symlink_escape(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    symlink_at_root: bool,
) -> None:
    external = tmp_path / "external"
    external.mkdir()
    (external / "sentinel").write_text("immutable", encoding="utf-8")
    if symlink_at_root:
        source = tmp_path / "source"
        source.symlink_to(external, target_is_directory=True)
    else:
        source = tmp_path / "source"
        source.mkdir()
        (source / "kis-past-indicators").symlink_to(
            external,
            target_is_directory=True,
        )
    child_started = False

    def forbidden_copy(*args: object, **kwargs: object) -> None:
        nonlocal child_started
        child_started = True

    monkeypatch.setattr("tools.run_range_measurements.subprocess.run", forbidden_copy)

    with pytest.raises(ReflinkCloneError, match="symlink"):
        clone_fixture_reflink(source, tmp_path / "clone")

    assert child_started is False
    assert (external / "sentinel").read_text(encoding="utf-8") == "immutable"


@pytest.mark.parametrize("source_argument", [".", "lexical-child/.."])
def test_orchestrator_resolves_source_before_placing_sibling_temp_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    source_argument: str,
) -> None:
    source = tmp_path / "source"
    (source / "lexical-child").mkdir(parents=True)
    loaded = LoadedRequestManifest(
        manifest=_manifest(),
        source_name="frontend-default-sidecar.json",
    )
    clone_destinations: list[Path] = []

    def clone_fixture(source_path: Path, destination: Path) -> None:
        assert source_path == source.resolve()
        assert not destination.is_relative_to(source_path)
        clone_destinations.append(destination)
        destination.mkdir()

    monkeypatch.chdir(source)
    output = io.StringIO()
    run_measurement_matrix(
        source_fixture=Path(source_argument),
        code="005930",
        windows=(RangeWindow("5d", "20260701", "20260707"),),
        manifests=(loaded,),
        cold_trials=1,
        warm_trials=0,
        output=output,
        commit_sha="0123456789abcdef",
        clone_fixture=clone_fixture,
        run_child=_successful_child,
    )

    assert len(clone_destinations) == 3
    assert all(destination.parent.parent == source.parent for destination in clone_destinations)
    [row] = [json.loads(line) for line in output.getvalue().splitlines()]
    assert row["gate_eligible"] is True


@pytest.mark.parametrize(
    ("cache_layout", "expected_state", "expected_eligible"),
    [
        ("absent", "absent", True),
        ("empty", "empty", True),
        ("populated", "populated", False),
    ],
)
def test_cold_trial_eligibility_reflects_source_and_clone_cache_state(
    tmp_path: Path,
    cache_layout: str,
    expected_state: str,
    expected_eligible: bool,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    if cache_layout != "absent":
        cache = source / "kis-past-indicators"
        cache.mkdir()
        if cache_layout == "populated":
            (cache / "synthetic.json").write_text("{}", encoding="utf-8")
    loaded = LoadedRequestManifest(
        manifest=_manifest(),
        source_name="frontend-default-sidecar.json",
    )
    output = io.StringIO()

    run_measurement_matrix(
        source_fixture=source,
        code="005930",
        windows=(RangeWindow("5d", "20260701", "20260707"),),
        manifests=(loaded,),
        cold_trials=1,
        warm_trials=0,
        output=output,
        commit_sha="0123456789abcdef",
        clone_fixture=shutil.copytree,
        run_child=_successful_child,
    )

    [row] = [json.loads(line) for line in output.getvalue().splitlines()]
    assert row["source_cache_state"]["state"] == expected_state
    assert {
        state["state"] for state in row["initial_cache_state"].values()
    } == {expected_state}
    assert row["gate_eligible"] is expected_eligible
    if expected_eligible:
        assert "cold_cache_not_empty" not in row["evidence_issues"]
    else:
        assert row["evidence_issues"].count("cold_cache_not_empty") == 1
    assert (source / "kis-past-indicators" / "synthetic.json").exists() is (
        cache_layout == "populated"
    )


@pytest.mark.parametrize(
    ("leg", "expected_encoding"),
    [
        ("profile", None),
        ("endpoint_identity", "identity"),
        ("endpoint_gzip", "gzip"),
    ],
)
def test_warm_child_runs_unmeasured_warmup_before_measured_invocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    leg: str,
    expected_encoding: str | None,
) -> None:
    clone = tmp_path / "clone"
    clone.mkdir()
    loaded = LoadedRequestManifest(
        manifest=_manifest(),
        source_name="frontend-default-sidecar.json",
    )
    invocations: list[tuple[Path, Path, str | None]] = []

    if leg == "profile":
        class FakeEngine:
            def __init__(
                self,
                data_dir: Path,
                *,
                temp_directory: Path,
            ) -> None:
                self.data_dir = data_dir
                self.temp_directory = temp_directory

            def close(self) -> None:
                return None

        def profile_case(
            engine: FakeEngine,
            **kwargs: object,
        ) -> dict[str, object]:
            invocations.append((engine.data_dir, engine.temp_directory, None))
            return {"invocation": len(invocations)}

        monkeypatch.setattr(run_range_measurements, "QueryEngine", FakeEngine)
        monkeypatch.setattr(run_range_measurements, "profile_range_case", profile_case)
    else:
        async def endpoint_case(
            *,
            data_dir: Path,
            temp_directory: Path,
            accept_encoding: str,
            **kwargs: object,
        ) -> dict[str, object]:
            invocations.append((data_dir, temp_directory, accept_encoding))
            return {"invocation": len(invocations)}

        monkeypatch.setattr(
            run_range_measurements,
            "measure_range_endpoint_case",
            endpoint_case,
        )

    monkeypatch.setattr(
        run_range_measurements,
        "load_request_manifest",
        lambda _: loaded,
    )
    result = _run_child_command(
        argparse.Namespace(
            leg=leg,
            data_dir=clone,
            label=f"range:test:5d:warm:1:{leg}",
            request_manifest=tmp_path / "unused.json",
            manifest_source_name="frontend-default-sidecar.json",
            code="005930",
            from_date="20260701",
            to_date="20260707",
            trial_kind="warm",
        )
    )

    expected_temp = clone / ".measurement" / "duckdb-tmp"
    assert invocations == [
        (clone, expected_temp, expected_encoding),
        (clone, expected_temp, expected_encoding),
    ]
    assert result["invocation"] == 2
    assert result["warmup_runs"] == 1


def test_orchestrator_streams_success_and_child_failure_before_raising(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    loaded = LoadedRequestManifest(
        manifest=_manifest(),
        source_name="frontend-default-sidecar.json",
    )
    child_invocation = 0

    def run_child(
        leg: str,
        clone_path: Path,
        label: str,
        manifest: LoadedRequestManifest,
        window: RangeWindow,
        code: str,
    ) -> ChildExecution:
        nonlocal child_invocation
        child_invocation += 1
        if child_invocation == 5:
            return ChildExecution(returncode=23, result=None, stderr="synthetic failure")
        return _successful_child(leg, clone_path, label, manifest, window, code)

    output = io.StringIO()
    with pytest.raises(ChildMeasurementError, match="endpoint_identity"):
        run_measurement_matrix(
            source_fixture=source,
            code="005930",
            windows=(RangeWindow("5d", "20260701", "20260707"),),
            manifests=(loaded,),
            cold_trials=2,
            warm_trials=0,
            output=output,
            commit_sha="0123456789abcdef",
            clone_fixture=shutil.copytree,
            run_child=run_child,
        )

    rows = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [row["status"] for row in rows] == ["ok", "CHILD_FAILED"]
    assert rows[1]["failed_leg"] == "endpoint_identity"
    assert rows[1]["child_exit_status"] == {"profile": 0, "endpoint_identity": 23}
    assert rows[1]["child_stderr"] == "synthetic failure"


def test_orchestrator_isolates_every_leg_and_keeps_warm_labels_out_of_cold_rows(
    tmp_path: Path,
) -> None:
    source = tmp_path / "immutable-fixture"
    source.mkdir()
    (source / "sentinel").write_text("immutable", encoding="utf-8")
    loaded = LoadedRequestManifest(
        manifest=_manifest(),
        source_name="frontend-default-sidecar.json",
    )
    clone_paths: list[Path] = []

    def clone_fixture(source_path: Path, destination: Path) -> None:
        clone_paths.append(destination)
        shutil.copytree(source_path, destination)

    def run_child(
        leg: str,
        clone_path: Path,
        label: str,
        manifest: LoadedRequestManifest,
        window: RangeWindow,
        code: str,
    ) -> ChildExecution:
        assert clone_path != source
        assert (clone_path / "sentinel").read_text(encoding="utf-8") == "immutable"
        (clone_path / "kis-past-indicators").mkdir()
        (clone_path / "kis-past-indicators" / f"{leg}.json").write_text(
            label,
            encoding="utf-8",
        )
        metadata = {
            "configuration_name": manifest.manifest.name,
            "request_manifest_name": manifest.source_name,
            "request_manifest_sha256": manifest.manifest.sha256(),
            "request_manifest": manifest.manifest.normalized(),
            "trading_calendar_policy": "fixture-weekday-lenient-v1",
            "label": label,
            "warmup_runs": 1 if ":warm:" in label else 0,
        }
        if leg == "profile":
            result = {
                **metadata,
                "total_ms": 2.0,
                "result_counts": {"segments": 1},
                "functions": {"slice": {"total_ms": 1.0, "calls": 1}},
            }
        else:
            result = {
                **metadata,
                "status": 200,
                "ttfb_ms": 1.0,
                "end_of_body_ms": 2.0,
                "raw_body_bytes": 2_000,
                "gzip_body_bytes": 200 if leg == "endpoint_gzip" else None,
                "wire_body_bytes": 200 if leg == "endpoint_gzip" else 2_000,
                "content_encoding": "gzip"
                if leg == "endpoint_gzip"
                else "identity",
                "response_validation_outcome": "valid",
                "response_validation_error": None,
                "body_frame_count": 1,
            }
        return ChildExecution(returncode=0, result=result, stderr="")

    output = io.StringIO()
    run_measurement_matrix(
        source_fixture=source,
        code="005930",
        windows=(RangeWindow("5d", "20260701", "20260707"),),
        manifests=(loaded,),
        cold_trials=2,
        warm_trials=1,
        output=output,
        commit_sha="0123456789abcdef",
        clone_fixture=clone_fixture,
        run_child=run_child,
    )

    rows = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [row["trial_kind"] for row in rows] == ["cold", "cold", "warm"]
    cold_rows = [row for row in rows if row["trial_kind"] == "cold"]
    assert len(cold_rows) == 2
    assert all(":cold:" in row["trial_group"] for row in cold_rows)
    assert ":warm:" in rows[-1]["trial_group"]
    assert all(
        row["child_exit_status"]
        == {"profile": 0, "endpoint_identity": 0, "endpoint_gzip": 0}
        for row in rows
    )
    assert len(clone_paths) == 9
    assert len(set(clone_paths)) == 9
    assert all(path.exists() is False for path in clone_paths)
    assert (source / "sentinel").read_text(encoding="utf-8") == "immutable"
    assert (source / "kis-past-indicators").exists() is False
    serialized = json.dumps(rows)
    assert str(source) not in serialized
    assert rows[0]["initial_cache_state"]["profile"]["state"] == "absent"
    assert rows[0]["configuration_name"] == "frontend-default-sidecar"
    assert rows[0]["commit_sha"] == "0123456789abcdef"
    assert [row["gate_eligible"] for row in rows] == [True, True, False]
    assert rows[-1]["evidence_issues"] == ["trial_kind_not_cold"]


def test_orchestrator_marks_http_or_validation_failures_ineligible(
    tmp_path: Path,
) -> None:
    source = tmp_path / "immutable-fixture"
    source.mkdir()
    loaded = LoadedRequestManifest(
        manifest=_manifest(),
        source_name="frontend-default-sidecar.json",
    )

    def clone_fixture(source_path: Path, destination: Path) -> None:
        shutil.copytree(source_path, destination)

    def run_child(
        leg: str,
        clone_path: Path,
        label: str,
        manifest: LoadedRequestManifest,
        window: RangeWindow,
        code: str,
    ) -> ChildExecution:
        metadata = {
            "configuration_name": manifest.manifest.name,
            "request_manifest_name": manifest.source_name,
            "request_manifest_sha256": manifest.manifest.sha256(),
            "request_manifest": manifest.manifest.normalized(),
            "trading_calendar_policy": "fixture-weekday-lenient-v1",
            "label": label,
            "warmup_runs": 0,
        }
        if leg == "profile":
            result = {
                **metadata,
                "total_ms": 1.0,
                "result_counts": {"segments": 1},
                "functions": {"slice": {"total_ms": 0.5, "calls": 1}},
            }
        else:
            result = {
                **metadata,
                "status": 500,
                "ttfb_ms": 1.0,
                "end_of_body_ms": 2.0,
                "raw_body_bytes": 100,
                "gzip_body_bytes": None,
                "wire_body_bytes": 100,
                "content_encoding": "identity",
                "response_validation_outcome": "invalid",
                "response_validation_error": "HTTPError",
                "body_frame_count": 1,
            }
        return ChildExecution(returncode=0, result=result, stderr="")

    output = io.StringIO()
    run_measurement_matrix(
        source_fixture=source,
        code="005930",
        windows=(RangeWindow("5d", "20260701", "20260707"),),
        manifests=(loaded,),
        cold_trials=1,
        warm_trials=0,
        output=output,
        commit_sha="0123456789abcdef",
        clone_fixture=clone_fixture,
        run_child=run_child,
    )

    [row] = [json.loads(line) for line in output.getvalue().splitlines()]
    assert row["status"] == "EVIDENCE_INVALID"
    assert row["gate_eligible"] is False
    assert "endpoint_identity_status" in row["evidence_issues"]
    assert "endpoint_identity_validation" in row["evidence_issues"]
    assert "endpoint_gzip_content_encoding" in row["evidence_issues"]


@pytest.mark.parametrize(
    "script",
    [
        "tools/profile_live_range.py",
        "tools/run_range_measurements.py",
    ],
)
def test_range_tool_entrypoints_support_direct_script_help(script: str) -> None:
    completed = subprocess.run(
        [sys.executable, script, "--help"],
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert "usage:" in completed.stdout
