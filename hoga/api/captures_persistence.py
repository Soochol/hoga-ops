"""Capture Queue manifest persistence.

Writes ``<data_dir>/.queue.json`` on every queue mutation; reads once at
lifespan startup to restore the queue. See ADR-0019 for design rationale.
"""
from __future__ import annotations

import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api.models import QueueManifest
from hoga.collector.orchestrator import now_kst
from hoga.util.atomic_write import atomic_write_json

logger = logging.getLogger(__name__)

MANIFEST_FILENAME = ".queue.json"
_SCHEMA_VERSION = 1


def manifest_path(data_dir: Path) -> Path:
    return data_dir / MANIFEST_FILENAME


def save_manifest(data_dir: Path, manifest: QueueManifest) -> bool:
    """Atomic write. OSError is caught + logged so disk failure does NOT
    break in-memory queue operations. Return whether persistence succeeded.
    Caller holds any relevant locks.
    """
    try:
        atomic_write_json(manifest_path(data_dir), manifest.model_dump(mode="json"))
        return True
    except OSError as e:
        logger.warning(
            "queue manifest write failed (%s); in-memory queue continues, "
            "restart recovery may lose state",
            e,
        )
        return False


def load_manifest(data_dir: Path, *, strict: bool = False) -> QueueManifest | None:
    """Return the manifest, or None if missing / corrupt / version-mismatched.
    Corrupt files are quarantined to ``.queue.json.corrupt-<ts>-<reason>``
    for forensic inspection in the legacy compatibility path. Production
    ownership recovery uses strict=True: only a missing file is empty; other
    failures raise and preserve the original file for repair.
    """
    target = manifest_path(data_dir)
    try:
        raw = target.read_text(encoding="utf-8")
        manifest = QueueManifest.model_validate_json(raw)
    except FileNotFoundError:
        return None
    except (OSError, ValueError, ValidationError) as e:
        if strict:
            raise
        _quarantine(target, reason=f"parse_error_{type(e).__name__}")
        return None
    if manifest.schema_version != _SCHEMA_VERSION:
        if strict:
            raise ValueError(f"unsupported queue schema: {manifest.schema_version}")
        _quarantine(target, reason=f"version_mismatch_{manifest.schema_version}")
        return None
    return manifest


def _quarantine(path: Path, *, reason: str) -> None:
    ts = now_kst().strftime("%Y%m%dT%H%M%S")
    backup = path.with_name(f"{path.name}.corrupt-{ts}-{reason}")
    try:
        path.rename(backup)
        logger.warning("queue manifest quarantined: %s → %s", path, backup.name)
    except OSError as e:
        logger.warning("queue manifest quarantine rename failed: %s", e)
