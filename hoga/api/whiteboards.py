"""Server-owned whiteboards and immutable image assets.

One atomic document is the source of truth for each board. Assets are published
first; trash and clones keep their references. No automatic asset deletion.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import re
import tempfile
import time
import warnings
from datetime import date as CalendarDate
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, StringConstraints, ValidationError, field_validator

from hoga.util.atomic_write import atomic_write_json

log = logging.getLogger(__name__)
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
MAX_DOCUMENT_BYTES = 12 * 1024 * 1024
BoardId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
AssetId = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Name = Annotated[str, StringConstraints(min_length=1, max_length=120, strip_whitespace=True)]


class WhiteboardAsset(BaseModel):
    asset_id: AssetId
    mime_type: str
    width: int
    height: int
    size: int


class WhiteboardFile(WhiteboardAsset):
    created: int


class WhiteboardScene(BaseModel):
    elements: list[dict[str, Any]] = Field(default_factory=list, max_length=10_000)
    appState: dict[str, Any] = Field(default_factory=dict)
    files: dict[str, WhiteboardFile] = Field(default_factory=dict)


class ReviewRecord(BaseModel):
    model_config = {"extra": "forbid"}
    id: BoardId
    title: str = Field(default="", max_length=300)
    stock: str = Field(default="", max_length=120)
    code: str = Field(default="", pattern=r"^(?:[0-9]{6})?$")
    timeframe: str = Field(default="", max_length=20)
    captured_at_ms: int | None = Field(default=None, ge=0)
    image_file_id: str | None = Field(default=None, max_length=128)
    judgment: str = Field(default="", max_length=20_000)
    action: str = Field(default="", max_length=20_000)
    result: str = Field(default="", max_length=20_000)


class ReviewSummary(BaseModel):
    model_config = {"extra": "forbid"}
    date: str = Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
    summary: str = Field(default="", max_length=10_000)
    completed: bool = False
    stocks: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("date")
    @classmethod
    def valid_date(cls, value: str) -> str:
        CalendarDate.fromisoformat(value)
        return value


class ReviewNote(ReviewSummary):
    good: str = Field(default="", max_length=10_000)
    change: str = Field(default="", max_length=10_000)
    principle: str = Field(default="", max_length=10_000)
    records: list[ReviewRecord] = Field(default_factory=list, max_length=200)


class WhiteboardSummary(BaseModel):
    id: BoardId
    name: str
    revision: int
    created_at_ms: int
    updated_at_ms: int
    deleted_at_ms: int | None = None
    element_count: int
    review: ReviewSummary | None = None


class WhiteboardDocument(WhiteboardSummary):
    review: ReviewNote | None = None
    schema_version: int = 1
    engine_version: str = "excalidraw/0.18.1"
    scene: WhiteboardScene
    last_mutation_id: str
    last_mutation_hash: str


class WhiteboardList(BaseModel):
    boards: list[WhiteboardSummary]
    unreadable_ids: list[str] = Field(default_factory=list)


class WhiteboardCreate(BaseModel):
    id: BoardId
    mutation_id: BoardId
    name: Name = "새 보드"
    scene: WhiteboardScene = Field(default_factory=WhiteboardScene)
    review: ReviewNote | None = None


class WhiteboardWrite(BaseModel):
    mutation_id: BoardId
    expected_revision: int = Field(ge=1)
    name: Name
    scene: WhiteboardScene
    deleted: bool = False
    review: ReviewNote | None = None


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _review_stocks(review: ReviewNote, scene: WhiteboardScene) -> list[str]:
    stocks = [record.stock or record.code for record in review.records if record.stock or record.code]
    recorded_codes = {record.code for record in review.records if record.code}
    # Free-canvas captures have no legacy structured record. Derive their
    # searchable Codes from visible images instead of discarding them.
    for element in scene.elements:
        if element.get("type") != "image" or element.get("isDeleted"):
            continue
        custom = element.get("customData")
        source = custom.get("chartSource") if isinstance(custom, dict) else None
        code = source.get("code") if isinstance(source, dict) else None
        if isinstance(code, str) and re.fullmatch(r"[A-Z0-9]{6}", code) and code not in recorded_codes:
            stocks.append(code)
    return list(dict.fromkeys(stocks))[:200]


class WhiteboardStore:
    def __init__(self, data_dir: Path):
        self.root = data_dir / "whiteboards"
        self.lock = asyncio.Lock()

    def document_path(self, board_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", board_id):
            raise _error(404, "whiteboard_not_found", "보드를 찾을 수 없습니다")
        return self.root / "boards" / f"{board_id}.json"

    def asset_path(self, asset_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{64}", asset_id):
            raise _error(404, "whiteboard_asset_not_found", "이미지를 찾을 수 없습니다")
        return self.root / "assets" / asset_id

    def read(self, board_id: str) -> WhiteboardDocument:
        try:
            raw = json.loads(self.document_path(board_id).read_text())
        except FileNotFoundError as exc:
            raise _error(404, "whiteboard_not_found", "보드를 찾을 수 없습니다") from exc
        except (OSError, ValueError) as exc:
            raise _error(503, "whiteboard_unreadable", "보드 파일을 읽지 못했습니다. 원본은 보존했습니다") from exc
        if not isinstance(raw, dict):
            raise _error(503, "whiteboard_unreadable", "보드 파일이 손상되었습니다. 원본은 보존했습니다")
        if raw.get("schema_version") not in {1, 2}:
            raise _error(409, "whiteboard_version", "지원하지 않는 보드 버전입니다. 원본은 보존했습니다")
        try:
            doc = WhiteboardDocument.model_validate(raw)
            if doc.id != board_id:
                raise ValueError("document identity mismatch")
            return doc
        except (ValidationError, ValueError) as exc:
            raise _error(503, "whiteboard_unreadable", "보드 파일이 손상되었습니다. 원본은 보존했습니다") from exc

    def list(self, *, deleted: bool) -> WhiteboardList:
        boards, unreadable = [], []
        for path in (self.root / "boards").glob("*.json"):
            try:
                doc = self.read(path.stem)
            except HTTPException:
                unreadable.append(path.stem)
                continue
            if bool(doc.deleted_at_ms) == deleted:
                payload = doc.model_dump()
                payload["review"] = (
                    doc.review.model_dump(include=set(ReviewSummary.model_fields)) if doc.review else None
                )
                boards.append(WhiteboardSummary.model_validate(payload))
        boards.sort(key=lambda b: (-b.updated_at_ms, b.id))
        return WhiteboardList(boards=boards, unreadable_ids=unreadable)

    def validate_scene(self, scene: WhiteboardScene) -> None:
        if len(scene.model_dump_json().encode()) > MAX_DOCUMENT_BYTES:
            raise _error(413, "whiteboard_too_large", "보드 문서는 최대 12MB까지 저장할 수 있습니다")
        for file in scene.files.values():
            path = self.asset_path(file.asset_id)
            if not path.is_file():
                raise _error(409, "whiteboard_missing_asset", "이미지 업로드가 끝난 후 다시 저장해 주세요")
            meta = WhiteboardAsset.model_validate_json(path.with_suffix(".json").read_text())
            if file.model_dump(exclude={"created"}) != meta.model_dump():
                raise _error(422, "whiteboard_invalid_asset", "이미지 정보가 저장된 원본과 일치하지 않습니다")
        for el in scene.elements:
            if el.get("type") == "image" and not el.get("isDeleted") and el.get("fileId") not in scene.files:
                raise _error(422, "whiteboard_missing_asset", "보드에 필요한 이미지가 없습니다")
            if el.get("type") in {"embeddable", "iframe"}:
                raise _error(422, "whiteboard_embed_disabled", "외부 페이지 삽입은 지원하지 않습니다")

    def write(self, req: WhiteboardCreate | WhiteboardWrite, board_id: str) -> WhiteboardDocument:
        path = self.document_path(board_id)
        digest = hashlib.sha256(req.model_dump_json(
            exclude={"review"} if "review" not in req.model_fields_set else set(),
        ).encode()).hexdigest()
        old = self.read(board_id) if path.exists() else None
        if old and old.last_mutation_id == req.mutation_id:
            if old.last_mutation_hash != digest:
                raise _error(409, "whiteboard_mutation_reused", "재시도 식별자가 다른 변경에 사용되었습니다")
            return old
        if isinstance(req, WhiteboardCreate):
            if old:
                raise _error(409, "whiteboard_conflict", "이미 같은 ID의 보드가 있습니다")
        elif old is None:
            raise _error(404, "whiteboard_not_found", "보드를 찾을 수 없습니다")
        elif old.revision != req.expected_revision:
            raise _error(
                409, "whiteboard_conflict", "다른 창에서 보드를 변경했습니다. 내 편집을 새 보드로 보존할 수 있습니다"
            )
        self.validate_scene(req.scene)
        # Clients predating notes may update a legacy canvas. An omitted field
        # never erases structured writing from a newer document.
        review = req.review if "review" in req.model_fields_set or not old else old.review
        if review:
            if len(review.model_dump_json().encode()) + len(req.scene.model_dump_json().encode()) > MAX_DOCUMENT_BYTES:
                raise _error(413, "whiteboard_too_large", "노트 문서는 최대 12MB까지 저장할 수 있습니다")
            ids = [record.id for record in review.records]
            if len(ids) != len(set(ids)):
                raise _error(422, "review_duplicate_record", "기록 ID가 중복되었습니다")
            if any(record.image_file_id and record.image_file_id not in req.scene.files for record in review.records):
                raise _error(422, "whiteboard_missing_asset", "기록에 필요한 이미지가 없습니다")
            review = review.model_copy(update={"stocks": _review_stocks(review, req.scene)})
        now = int(time.time() * 1000)
        doc = WhiteboardDocument(
            id=board_id,
            name=req.name.strip() or "새 보드",
            revision=old.revision + 1 if old else 1,
            created_at_ms=old.created_at_ms if old else now,
            updated_at_ms=now,
            deleted_at_ms=(old.deleted_at_ms or now)
            if old and isinstance(req, WhiteboardWrite) and req.deleted
            else None,
            element_count=sum(not el.get("isDeleted", False) for el in req.scene.elements),
            scene=req.scene,
            schema_version=2 if review else 1,
            review=review,
            last_mutation_id=req.mutation_id,
            last_mutation_hash=digest,
        )
        atomic_write_json(path, doc.model_dump(mode="json"))
        return doc

    def daily(self, review_date: str) -> WhiteboardDocument:
        for board in sorted(self.list(deleted=False).boards, key=lambda b: (b.created_at_ms, b.id)):
            if board.review and board.review.date == review_date:
                return self.read(board.id)
        board_id = uuid4().hex
        return self.write(WhiteboardCreate(
            id=board_id, mutation_id=board_id, name=f"{review_date} 복기",
            review=ReviewNote(date=review_date),
        ), board_id)

    def upload(self, data: bytes) -> WhiteboardAsset:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as image:
                    fmt, width, height = image.format, image.width, image.height
                    if fmt not in {"PNG", "JPEG", "WEBP"} or width * height > MAX_IMAGE_PIXELS:
                        raise ValueError("image format or dimensions")
                    image.verify()
        except (
            UnidentifiedImageError,
            OSError,
            ValueError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ) as exc:
            raise _error(
                422, "whiteboard_invalid_image", "PNG/JPG/WebP, 최대 24메가픽셀 이미지를 선택해 주세요"
            ) from exc
        asset_id = hashlib.sha256(data).hexdigest()
        path = self.asset_path(asset_id)
        meta = WhiteboardAsset(asset_id=asset_id, mime_type=Image.MIME[fmt], width=width, height=height, size=len(data))
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            tmp_name = None
            try:
                with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as tmp:
                    tmp_name = tmp.name
                    tmp.write(data)
                    tmp.flush()
                    os.fsync(tmp.fileno())
                os.replace(tmp_name, path)
            finally:
                if tmp_name:
                    Path(tmp_name).unlink(missing_ok=True)
        atomic_write_json(path.with_suffix(".json"), meta.model_dump())
        return meta


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/whiteboards", tags=["whiteboards"])
    store = WhiteboardStore(data_dir)

    async def disk_call(fn, *args, **kwargs):
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except OSError as exc:
            log.warning("whiteboard disk operation failed", exc_info=True)
            raise _error(
                503, "whiteboard_storage_failed", "저장소를 읽거나 쓰지 못했습니다. 초안을 보존하고 다시 시도해 주세요"
            ) from exc

    @router.get("")
    async def list_boards(deleted: bool = False) -> WhiteboardList:
        return await disk_call(store.list, deleted=deleted)

    @router.post("", status_code=201)
    async def create_board(req: WhiteboardCreate) -> WhiteboardDocument:
        async with store.lock:
            return await disk_call(store.write, req, req.id)

    @router.post("/assets", status_code=201)
    async def upload_asset(request: Request) -> WhiteboardAsset:
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > MAX_IMAGE_BYTES:
                raise _error(413, "whiteboard_image_too_large", "이미지는 한 장당 최대 16MB입니다")
        return await disk_call(store.upload, bytes(data))

    @router.post("/daily/{review_date}")
    async def open_daily(review_date: CalendarDate) -> WhiteboardDocument:
        async with store.lock:
            return await disk_call(store.daily, review_date.isoformat())

    @router.get("/assets/{asset_id}")
    async def get_asset(asset_id: str) -> FileResponse:
        path = store.asset_path(asset_id)
        try:
            meta = WhiteboardAsset.model_validate_json(await asyncio.to_thread(path.with_suffix(".json").read_text))
        except (OSError, ValueError) as exc:
            raise _error(404, "whiteboard_asset_not_found", "이미지를 찾을 수 없습니다") from exc
        return FileResponse(
            path, media_type=meta.mime_type, headers={"Cache-Control": "private, max-age=31536000, immutable"}
        )

    @router.get("/{board_id}")
    async def get_board(board_id: str) -> WhiteboardDocument:
        return await disk_call(store.read, board_id)

    @router.put("/{board_id}")
    async def update_board(board_id: str, req: WhiteboardWrite) -> WhiteboardDocument:
        async with store.lock:
            return await disk_call(store.write, req, board_id)

    return router
