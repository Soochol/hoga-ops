"""Occurrence exclusions: condition meaning × code × trading date, independent of saves."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from pathlib import Path

from fastapi import APIRouter, Response

from hoga.api.models import (
    ConditionLeaf,
    ScreenerExclusion,
    ScreenerExclusionsFile,
    ScreenerExclusionWrite,
)
from hoga.util.atomic_write import atomic_write_json

_lock = asyncio.Lock()


def condition_key(leaf: ConditionLeaf) -> str:
    params = leaf.params.model_dump(mode="json")
    # These fields select the search window, not the predicate on a given day.
    for key in ("mode", "start_date", "end_date"):
        params.pop(key, None)
    if leaf.type in {"new_high", "new_high_vol", "trade_value_period",
                     "ask_depth_new_high_period", "bid_depth_new_high_period"}:
        params.pop("lookback", None)
    record_period = params.get("record_period")
    if record_period and record_period["unit"] == "trading_days":
        params["period"] = record_period["value"]
        del params["record_period"]
    value = json.dumps({"type": leaf.type, "params": params}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode()).hexdigest()


def load_exclusions(data_dir: Path) -> ScreenerExclusionsFile:
    path = data_dir / "screener" / "exclusions.json"
    if not path.exists():
        return ScreenerExclusionsFile()
    # Fail closed: corrupt/future files must not silently reintroduce dismissed events.
    result = ScreenerExclusionsFile.model_validate_json(path.read_text())
    if result.schema_version != 1:
        raise ValueError("지원하지 않는 발생 건 제외 파일 버전입니다")
    return result


def exclusion_keys(file: ScreenerExclusionsFile) -> set[tuple[str, str, str]]:
    return {(e.condition_key, e.code, e.date.isoformat()) for e in file.exclusions}


async def put_exclusion(data_dir: Path, req: ScreenerExclusionWrite) -> ScreenerExclusion:
    key = condition_key(req.condition)
    identity = hashlib.sha256(f"{key}:{req.code}:{req.date.isoformat()}".encode()).hexdigest()
    async with _lock:
        file = load_exclusions(data_dir)
        for item in file.exclusions:
            if item.id == identity:
                return item
        item = ScreenerExclusion(id=identity, condition_key=key,
                                 created_at_ms=int(time.time() * 1000), **req.model_dump())
        file.exclusions.append(item)
        atomic_write_json(data_dir / "screener" / "exclusions.json", file.model_dump(mode="json"))
        return item


async def restore_exclusion(data_dir: Path, identity: str) -> None:
    async with _lock:
        file = load_exclusions(data_dir)
        remaining = [item for item in file.exclusions if item.id != identity]
        if len(remaining) != len(file.exclusions):
            file.exclusions = remaining
            atomic_write_json(data_dir / "screener" / "exclusions.json", file.model_dump(mode="json"))


def build_router(data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/exclusions")

    @router.get("")
    async def list_exclusions() -> ScreenerExclusionsFile:
        return await asyncio.to_thread(load_exclusions, data_dir)

    @router.put("")
    async def exclude(req: ScreenerExclusionWrite) -> ScreenerExclusion:
        return await put_exclusion(data_dir, req)

    @router.delete("/{identity}", status_code=204)
    async def restore(identity: str) -> Response:
        await restore_exclusion(data_dir, identity)
        return Response(status_code=204)

    return router


def revision(data_dir: Path) -> tuple[int, int, int] | None:
    try:
        stat = (data_dir / "screener" / "exclusions.json").stat()
        return stat.st_ino, stat.st_mtime_ns, stat.st_size
    except FileNotFoundError:
        return None
