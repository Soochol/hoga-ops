from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Generic, Protocol, TypeVar

from pydantic import BaseModel

from hoga.api._atomic_write import atomic_write_json
from hoga.api.versioned_json_file import load_versioned_json_file

# 화면 구성 프리셋 저장소의 **공용 뼈대** — study_views 와 동일한 versioned-JSON-manifest
# 패턴(asyncio.Lock + load_versioned_json_file + atomic_write_json, ADR-0114 §4).
#
# `/live`(창·그룹·종목)와 `/study`(창 배치) 두 리소스가 이 위에 얹힌다. 복제하지 않는
# 이유는 낙관적 동시성(expected_updated_at_ms → conflict)이다 — 검사-후-쓰기를 한 락
# 안에 두는 코드가 두 벌로 갈라지면 정확히 그 지점이 아프다. 리소스별로 다른 것은
# 저장 루트·스키마 버전·모델 세 가지뿐이라 그것만 주입받는다.


class PresetNotFoundError(Exception):
    pass


class PresetConflictError(Exception):
    """PUT 의 expected_updated_at_ms 가 저장본과 다름 — 그 사이 누가 먼저 저장했다.

    프리셋 payload 는 워크스페이스 스냅샷이라 병합이 불가능하다(창 배열의 3-way
    merge). 조용히 덮어쓰는 대신 거절하고 클라이언트가 최신 목록을 다시 읽게 한다.
    검사와 쓰기가 같은 락 안에서 일어나므로 검사-후-쓰기 경합은 없다.
    """

    def __init__(self, id: str, *, expected_ms: int, actual_ms: int) -> None:
        super().__init__(id)
        self.id = id
        self.expected_ms = expected_ms
        self.actual_ms = actual_ms


class PresetWriteRequestLike(Protocol):
    """리소스별 WriteRequest 가 공통으로 갖는 필드. payload 형식은 리소스마다 다르다."""

    name: str
    payload: Any
    expected_updated_at_ms: int | None


PresetT = TypeVar("PresetT", bound=BaseModel)
FileT = TypeVar("FileT", bound=BaseModel)


class PresetStore(Generic[PresetT, FileT]):
    def __init__(
        self,
        *,
        root_name: str,
        current_version: int,
        preset_model: type[PresetT],
        file_model: type[FileT],
    ) -> None:
        self._root_name = root_name
        self._current_version = current_version
        self._preset_model = preset_model
        self._file_model = file_model
        self._lock = asyncio.Lock()

    # ── 경로 ──────────────────────────────────────────────────────────────────

    def root(self, data_dir: Path) -> Path:
        return data_dir / self._root_name

    def manifest_path(self, data_dir: Path) -> Path:
        return self.root(data_dir) / "saves.json"

    # ── 파일 입출력 ───────────────────────────────────────────────────────────

    def load(self, data_dir: Path) -> FileT:
        # 파일 모델은 리소스마다 다르므로(FileT) 필드 접근은 Any 로 본다 — 공개
        # 시그니처는 정확하고, `presets`/`schema_version` 계약은 리소스 모델이 진다.
        file: Any = load_versioned_json_file(
            self.manifest_path(data_dir),
            model=self._file_model,
            current_version=self._current_version,
            empty_factory=self._file_model,
        )
        # 구버전 파일(schema_version < 현재)은 폐기 — payload 형식이 바뀌어 변환하지
        # 않는다(#699 PR-D). 폐기의 단일 기준: 빈 목록을 반환하고(다음 쓰기가 현재
        # 버전으로 덮어쓴다) 구 매니페스트는 손대지 않는다.
        if file.schema_version < self._current_version:
            return self._file_model()
        return file

    def save(self, data_dir: Path, file: FileT) -> None:
        atomic_write_json(self.manifest_path(data_dir), file.model_dump(mode="json"))

    # ── CRUD (동기) ───────────────────────────────────────────────────────────

    def _from_req(
        self,
        *,
        req: PresetWriteRequestLike,
        id: str,
        created_at_ms: int,
        updated_at_ms: int,
    ) -> PresetT:
        return self._preset_model(
            id=id,
            name=req.name,
            payload=req.payload,
            created_at_ms=created_at_ms,
            updated_at_ms=updated_at_ms,
        )

    def list_sync(self, data_dir: Path) -> list[PresetT]:
        file: Any = self.load(data_dir)
        return file.presets

    def create_sync(
        self, data_dir: Path, *, req: PresetWriteRequestLike, id: str, now_ms: int
    ) -> PresetT:
        file: Any = self.load(data_dir)
        preset = self._from_req(req=req, id=id, created_at_ms=now_ms, updated_at_ms=now_ms)
        file.presets.append(preset)
        file.presets.sort(key=lambda p: p.updated_at_ms, reverse=True)
        self.save(data_dir, file)
        return preset

    def update_sync(
        self, data_dir: Path, *, id: str, req: PresetWriteRequestLike, now_ms: int
    ) -> PresetT:
        file: Any = self.load(data_dir)
        for idx, old in enumerate(file.presets):
            if old.id == id:
                expected = req.expected_updated_at_ms
                if expected is not None and expected != old.updated_at_ms:
                    raise PresetConflictError(
                        id, expected_ms=expected, actual_ms=old.updated_at_ms
                    )
                preset = self._from_req(
                    req=req,
                    id=id,
                    created_at_ms=old.created_at_ms,
                    updated_at_ms=now_ms,
                )
                file.presets[idx] = preset
                file.presets.sort(key=lambda p: p.updated_at_ms, reverse=True)
                self.save(data_dir, file)
                return preset
        raise PresetNotFoundError(id)

    def delete_sync(self, data_dir: Path, *, id: str) -> None:
        file: Any = self.load(data_dir)
        if not any(p.id == id for p in file.presets):
            raise PresetNotFoundError(id)
        file.presets = [p for p in file.presets if p.id != id]
        self.save(data_dir, file)

    # ── CRUD (락) ─────────────────────────────────────────────────────────────

    async def create(
        self, data_dir: Path, *, req: PresetWriteRequestLike, id: str, now_ms: int
    ) -> PresetT:
        async with self._lock:
            return self.create_sync(data_dir, req=req, id=id, now_ms=now_ms)

    async def update(
        self, data_dir: Path, *, id: str, req: PresetWriteRequestLike, now_ms: int
    ) -> PresetT:
        async with self._lock:
            return self.update_sync(data_dir, id=id, req=req, now_ms=now_ms)

    async def delete(self, data_dir: Path, *, id: str) -> None:
        async with self._lock:
            self.delete_sync(data_dir, id=id)
