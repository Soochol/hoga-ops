"""Explicit result preservation and exact EOD replay; monitoring scans are temporary."""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import platform
from pathlib import Path

import polars
import pydantic
from fastapi import APIRouter, HTTPException

from hoga.api import screener_series_store as store
from hoga.api.models import ScanRequest, ScreenerResponse
from hoga.api.screener_bar_policy import RANK_TYPES
from hoga.api.screener_depth import DEPTH_TYPES
from hoga.api.screener_expression import active_conditions
from hoga.util.timeenc import KST


def code_revision():
    repo = Path(__file__).resolve().parents[2]
    sources = sorted((repo / "hoga").rglob("*.py")) + [repo / "pyproject.toml", repo / "uv.lock"]
    fingerprint = hashlib.sha256()
    for path in sources:
        fingerprint.update(str(path.relative_to(repo)).encode())
        fingerprint.update(path.read_bytes())
    return store.digest(
        {
            "code": fingerprint.hexdigest(),
            "python": platform.python_version(),
            "polars": polars.__version__,
            "pydantic": pydantic.__version__,
        }
    )


def validate_archivable(req):
    selected = active_conditions(req.conditions, req.expression)
    if (
        req.calculation_policy != "separate_bases_v2"
        or req.basis != "eod"
        or any(leaf.type in RANK_TYPES or leaf.type in DEPTH_TYPES
               or getattr(leaf.params, "timeframe", "D").endswith("m") for leaf in selected)
    ):
        raise ValueError("정확 재실행 보존은 새 기준의 확정 일/주/월봉 조회만 지원합니다")


def archive(data_dir, req, inputs, response):
    validate_archivable(req)
    if response.calculation is None or response.calculation.snapshot_id is None:
        raise ValueError("보존할 스냅샷이 없습니다")
    response.calculation.replayable = True
    execution = {
        "kind": "screener_eod_execution",
        "schema_version": 1,
        "request": req.model_dump(mode="json"),
        "inputs": inputs,
        "code_revision": code_revision(),
        "response": response.model_dump(mode="json"),
    }
    identity = store._write_object(store.root(data_dir), execution)
    response.calculation.execution_id = identity
    return identity


def load_execution(data_dir, identity):
    execution = store.read_object(data_dir, identity)
    if execution.get("kind") != "screener_eod_execution" or execution.get("schema_version") != 1:
        raise ValueError("실행 기록이 아닙니다")
    return execution


def saved_response(data_dir, identity):
    response = ScreenerResponse.model_validate(load_execution(data_dir, identity)["response"])
    response.calculation.execution_id = identity
    return response


async def replay_execution(data_dir, identity):
    from hoga.api.screener_series_runner import run_scan  # noqa: PLC0415 — avoid runner cycle

    execution = await asyncio.to_thread(load_execution, data_dir, identity)
    if execution["code_revision"] != await asyncio.to_thread(code_revision):
        raise ValueError("계산 코드·실행 환경 버전이 달라 정확 재실행할 수 없습니다. 보존된 결과는 열 수 있습니다")
    request = ScanRequest.model_validate(execution["request"])
    request.snapshot_id = execution["response"]["calculation"]["snapshot_id"]
    response = await run_scan(
        data_dir=data_dir,
        req=request,
        replay=execution["inputs"],
        now=dt.datetime.fromisoformat(execution["inputs"]["clock"]),
    )
    expected = execution["response"]
    for field in ("rows", "has_more", "warnings", "basis_at_ms", "bar_coverage"):
        if response.model_dump(mode="json")[field] != expected[field]:
            raise ValueError(f"보존 결과와 재실행 결과가 다릅니다: {field}")
    actual_calculation = response.calculation.model_dump(mode="json")
    expected_calculation = expected["calculation"]
    for field, value in actual_calculation.items():
        if field not in {"execution_id", "replayable"} and value != expected_calculation.get(field):
            raise ValueError(f"보존 결과와 재실행 계산 기준이 다릅니다: {field}")
    response.calculation.replayable = True
    response.calculation.execution_id = identity
    return response


def build_router(data_dir: Path):
    router = APIRouter(prefix="/executions")

    @router.post("", status_code=201)
    async def create(req: ScanRequest) -> ScreenerResponse:
        from hoga.api.screener_series_runner import run_scan  # noqa: PLC0415

        try:
            validate_archivable(req)
            response = await run_scan(data_dir=data_dir, req=req, now=dt.datetime.now(KST), record=True)
            if response.calculation.execution_id is None:
                raise ValueError("새 기준 일봉을 먼저 준비해야 합니다")
            return response
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.get("/{identity}")
    async def read(identity: str) -> ScreenerResponse:
        try:
            return await asyncio.to_thread(saved_response, data_dir, identity)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(404, "보존된 실행 기록을 찾을 수 없습니다") from exc

    @router.post("/{identity}/replay")
    async def replay(identity: str) -> ScreenerResponse:
        try:
            return await replay_execution(data_dir, identity)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(422, str(exc)) from exc

    return router
