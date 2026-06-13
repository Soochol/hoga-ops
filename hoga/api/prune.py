"""Raw data retention — parse 완료(COMPLETE) hogaplay raw를 유예 후 삭제한다.

게이트: raw는 hogaplay 전용(flat first_*.tsv)이므로 aggregate가 아니라
hogaplay-source가 DiskState.COMPLETE일 때만 삭제 (ADR-0075, ADR-0039).
순수 로직 — CLI(`hoga prune`)와 Daily Scheduler가 공유한다.
"""
from __future__ import annotations

import datetime as dt
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from hoga.api.disk_state import DiskState, check_disk_state, classify_stock_date
from hoga.collector.orchestrator import now_kst

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


def _dir_size(path: Path) -> int:
    """디렉터리 내 모든 파일 크기 합(바이트)."""
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def find_prunable(data_dir: Path, *, retention_days: int, now: dt.datetime) -> list[PruneCandidate]:
    """raw/ 순회 → 날짜 컷오프 통과(date < today−N 달력일) + hogaplay-source
    COMPLETE인 (date,code)만 PruneCandidate로 반환한다. 부작용 없음.
    """
    raw_root = data_dir / "raw"
    if not raw_root.is_dir():
        return []
    cutoff = (now.date() - dt.timedelta(days=retention_days)).strftime("%Y%m%d")
    out: list[PruneCandidate] = []
    for date_dir in sorted(raw_root.iterdir()):
        if not date_dir.is_dir():
            continue
        date = date_dir.name
        if date >= cutoff:  # 유예 내 → 보존
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            code = code_dir.name
            if not _is_complete_hogaplay(data_dir, code, date):
                continue
            out.append(PruneCandidate(
                date=date, code=code, raw_dir=code_dir, size_bytes=_dir_size(code_dir),
            ))
    return out


def _count_stock_dates(raw_root: Path) -> int:
    """raw/에 현재 존재하는 (date,code) 총수."""
    if not raw_root.is_dir():
        return 0
    n = 0
    for date_dir in raw_root.iterdir():
        if not date_dir.is_dir():
            continue
        for code_dir in date_dir.iterdir():
            if code_dir.is_dir():
                n += 1
    return n


def _remove_empty_date_dirs(raw_root: Path) -> None:
    """비어 버린 raw/{date}/ 디렉터리를 제거한다(raw/ 루트는 유지)."""
    if not raw_root.is_dir():
        return
    for date_dir in raw_root.iterdir():
        if date_dir.is_dir() and not any(date_dir.iterdir()):
            date_dir.rmdir()


def prune_raw(
    data_dir: Path, *, retention_days: int, now: dt.datetime, execute: bool
) -> PruneResult:
    """find_prunable 후보를 (execute면) rmtree로 삭제하고 결과를 반환한다.

    dry-run(execute=False)이면 후보만 채운 PruneResult를 돌려준다(디스크 불변).
    삭제 후 비어 버린 날짜 디렉터리도 정리한다. 단일 rmtree 실패 시 예외가
    전파된다(loop 중단). 스케줄러는 이를 swallow하고 다음 일일 실행이 남은
    후보를 재시도한다.
    """
    raw_root = data_dir / "raw"
    candidates = find_prunable(data_dir, retention_days=retention_days, now=now)
    deleted = 0
    reclaimed = 0
    if execute:
        for c in candidates:
            shutil.rmtree(c.raw_dir)
            deleted += 1
            reclaimed += c.size_bytes
        _remove_empty_date_dirs(raw_root)
    return PruneResult(
        candidates=candidates,
        deleted=deleted,
        reclaimed_bytes=reclaimed,
        scanned=_count_stock_dates(raw_root),
    )


def prune_default_now() -> dt.datetime:
    """CLI/scheduler가 쓰는 기본 시각. 테스트는 hoga.api.prune.now_kst를 패치한다."""
    return now_kst()
