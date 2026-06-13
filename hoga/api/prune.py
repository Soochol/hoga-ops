"""Raw data retention — parse 완료(COMPLETE) hogaplay raw를 유예 후 삭제한다.

게이트: raw는 hogaplay 전용(flat first_*.tsv)이므로 aggregate가 아니라
hogaplay-source가 DiskState.COMPLETE일 때만 삭제 (ADR-0075, ADR-0039).
순수 로직 — CLI(`hoga prune`)와 Daily Scheduler가 공유한다.
"""
from __future__ import annotations

import datetime as dt  # noqa: F401
import os
import shutil  # noqa: F401
from dataclasses import dataclass, field
from pathlib import Path

from hoga.api.disk_state import DiskState, check_disk_state, classify_stock_date

RETENTION_DAYS_DEFAULT = 3


def resolve_retention_days() -> int:
    """HOGA_RETENTION_DAYS env(없으면 기본 3)를 정수로 해석한다."""
    return int(os.environ.get("HOGA_RETENTION_DAYS", RETENTION_DAYS_DEFAULT))


@dataclass(frozen=True)
class PruneCandidate:
    date: str          # YYYYMMDD
    code: str
    raw_dir: Path
    size_bytes: int    # 회수 예상량(dry-run 표시 + execute 합산)


@dataclass(frozen=True)
class PruneResult:
    candidates: list[PruneCandidate] = field(default_factory=list)
    deleted: int = 0
    reclaimed_bytes: int = 0
    scanned: int = 0


def _is_complete_hogaplay(data_dir: Path, code: str, date: str) -> bool:
    """이 (date,code)의 hogaplay raw를 삭제해도 되는가?

    raw/는 hogaplay 전용이므로 aggregate가 아니라 hogaplay-source의 상태로
    판정한다. per-source 레이아웃이면 hogaplay Classification이 COMPLETE인지
    보고, legacy flat 레이아웃(source subdir 없음)이면 단일 hogaplay이므로
    check_disk_state로 폴백한다. (ADR-0075, ADR-0039)
    """
    parquet_dir = data_dir / "parquet" / date / code
    per_source = classify_stock_date(parquet_dir)
    if per_source:
        cls = per_source.get("hogaplay")
        return cls is not None and cls.state == DiskState.COMPLETE
    return check_disk_state(data_dir, code, date).state == DiskState.COMPLETE


def find_prunable(data_dir: Path, *, retention_days: int, now: dt.datetime) -> list[PruneCandidate]:
    raise NotImplementedError  # Task 3


def prune_raw(
    data_dir: Path, *, retention_days: int, now: dt.datetime, execute: bool
) -> PruneResult:
    raise NotImplementedError  # Task 4
