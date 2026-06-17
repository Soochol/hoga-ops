from __future__ import annotations

import datetime as dt
import json
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel, ValidationError

ModelT = TypeVar("ModelT", bound=BaseModel)


def quarantine_versioned_json_file(path: Path, reason: str) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    backup = path.with_name(f"{path.name}.corrupt-{stamp}-{reason}")
    path.rename(backup)
    return backup


def load_versioned_json_file(
    path: Path,
    *,
    model: type[ModelT],
    current_version: int,
    empty_factory: Callable[[], ModelT],
    on_quarantine: Callable[[str, Path, OSError | None], None] | None = None,
) -> ModelT:
    if not path.exists():
        return empty_factory()
    reason: str
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        reason = "badjson"
    else:
        if not isinstance(raw, dict):
            reason = "badshape"
        elif isinstance(raw.get("schema_version", 0), int) and raw.get(
            "schema_version", 0
        ) > current_version:
            reason = "future-version"
        else:
            try:
                return model.model_validate(raw)
            except ValidationError:
                reason = "schema"

    try:
        backup = quarantine_versioned_json_file(path, reason)
    except OSError as e:
        if on_quarantine is not None:
            on_quarantine(reason, path, e)
    else:
        if on_quarantine is not None:
            on_quarantine(reason, backup, None)
    return empty_factory()
