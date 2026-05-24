"""Atomic JSON write helper. Extracted per ADR-0015 footer + ADR-0019.

Used by:
- hoga/api/symbols.py (Symbol Master disk cache)
- hoga/api/captures_persistence.py (Capture Queue manifest)
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, payload: Any, *, indent: int = 2) -> None:
    """Write ``payload`` as JSON to ``path`` atomically.

    Pattern: tempfile in target's parent dir → flush + fsync → os.replace.
    The parent dir is created if missing. Korean text is preserved
    (ensure_ascii=False).

    Raises:
        OSError: if disk write fails. Callers decide whether to propagate.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=indent)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)
