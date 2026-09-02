"""봉 패턴 검색 저장 — 영속 + async-safe CRUD (ADR-0166).

`screener_saves.py` 와 **같은 형태**다: 파일이 SSOT, 모듈 `_lock`, 잠금 없는 읽기,
원자적 쓰기(OSError 는 전파 — 삼키면 조용한 유실이다).

저장되는 것은 **질문이지 답이 아니다** — 기준 종목·창·조건만 담고 결과(매치)는
담지 않는다. 코퍼스가 매일 자라므로 「그때 나온 매치」 는 재현이 아니라 스냅샷이고,
스냅샷은 별도 기능이다.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from hoga.api.models import PatternSave, PatternSavesFile, PatternSaveWriteRequest
from hoga.api.versioned_json_file import load_versioned_json_file
from hoga.util.atomic_write import atomic_write_json

log = logging.getLogger(__name__)
_lock = asyncio.Lock()
_CURRENT_VERSION = 1


def _path(data_dir: Path) -> Path:
    #: 스크리너 저장(`screener/saves.json`)과 **다른 파일**이다 — 같은 디렉터리를 쓰면
    #: 두 기능의 격리·백업 단위가 엉킨다.
    return data_dir / "pattern" / "saves.json"


def _log_quarantine(reason: str, path: Path, error: OSError | None) -> None:
    if error is not None:
        log.exception("could not back up corrupt pattern saves.json")
        return
    log.warning("pattern saves.json unusable (%s); backed up to %s", reason, path)


def load_saves(data_dir: Path) -> PatternSavesFile:
    """순수 읽기: 없으면 빈 파일, 미래 버전·손상이면 격리 후 빈 파일."""
    return load_versioned_json_file(
        _path(data_dir),
        model=PatternSavesFile,
        current_version=_CURRENT_VERSION,
        empty_factory=PatternSavesFile,
        on_quarantine=_log_quarantine,
    )


def save_saves(data_dir: Path, file: PatternSavesFile) -> None:
    """원자적 쓰기. OSError 는 **전파한다**(파일이 SSOT 라 삼키면 조용한 유실)."""
    atomic_write_json(_path(data_dir), file.model_dump(mode="json"))


class PatternSaveNotFoundError(Exception):
    """저장 id 가 없을 때."""


async def list_saves(data_dir: Path) -> list[PatternSave]:
    return load_saves(data_dir).saves


async def get_save(data_dir: Path, *, id: str) -> PatternSave:
    for s in load_saves(data_dir).saves:
        if s.id == id:
            return s
    raise PatternSaveNotFoundError(id)


async def create_save(
    data_dir: Path, *, req: PatternSaveWriteRequest, id: str, now_ms: int
) -> PatternSave:
    async with _lock:
        f = load_saves(data_dir)
        s = PatternSave(id=id, created_at_ms=now_ms, updated_at_ms=now_ms, **req.model_dump())
        # 최신이 위로 — 목록이 종목별로 묶이지만 그룹 안에서는 시간 역순이 기본이다.
        f.saves.insert(0, s)
        save_saves(data_dir, f)
        return s


async def update_save(
    data_dir: Path, *, id: str, req: PatternSaveWriteRequest, now_ms: int
) -> PatternSave:
    async with _lock:
        f = load_saves(data_dir)
        for idx, old in enumerate(f.saves):
            if old.id == id:
                new = PatternSave(
                    id=id,
                    created_at_ms=old.created_at_ms,
                    updated_at_ms=now_ms,
                    **req.model_dump(),
                )
                f.saves[idx] = new
                save_saves(data_dir, f)
                return new
        raise PatternSaveNotFoundError(id)


async def delete_save(data_dir: Path, *, id: str) -> None:
    async with _lock:
        f = load_saves(data_dir)
        if not any(s.id == id for s in f.saves):
            raise PatternSaveNotFoundError(id)
        f.saves = [s for s in f.saves if s.id != id]
        save_saves(data_dir, f)
