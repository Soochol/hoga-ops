"""hoga.api.prune — raw retention/prune 단위 테스트."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest

from hoga.api.prune import (
    PruneCandidate,
    PruneResult,
    _is_complete_hogaplay,
    find_prunable,
    prune_raw,
    resolve_retention_days,
)

# check_disk_state의 meta invariant를 통과하는 최소 필드 집합
# (tests/test_api_disk_state.py:_write_meta와 동일 계열).
_META_BASE = {
    "code": "005930",
    "name": "삼성전자",
    "regular_session_open_ms": 90000000,
    "regular_session_close_ms": 153000000,
    "prev_close": 50000,
    "upper_limit": 65000,
    "lower_limit": 35000,
    "today_open": 50500,
    "today_high": 51000,
    "today_low": 50000,
    "today_close": 50800,
    "pages_collected": 47,
}


def _write_meta_flat(data_dir: Path, code: str, date: str, **fields: object) -> None:
    """Legacy flat 레이아웃: parquet/{date}/{code}/meta.json."""
    p = data_dir / "parquet" / date / code
    p.mkdir(parents=True)
    (p / "meta.json").write_text(
        json.dumps({**_META_BASE, "code": code, **fields}, ensure_ascii=False),
        encoding="utf-8",
    )


def _write_meta_source(data_dir: Path, code: str, date: str, source: str, **fields: object) -> None:
    """Per-source 레이아웃: parquet/{date}/{code}/{source}/meta.json (ADR-0037)."""
    p = data_dir / "parquet" / date / code / source
    p.mkdir(parents=True)
    (p / "meta.json").write_text(
        json.dumps({**_META_BASE, "code": code, **fields}, ensure_ascii=False),
        encoding="utf-8",
    )


def _make_raw(data_dir: Path, code: str, date: str, *, pages: int = 2, content: str = "x" * 100) -> Path:
    """raw/{date}/{code}/first_NNNNN.tsv 디렉터리를 만든다."""
    p = data_dir / "raw" / date / code
    p.mkdir(parents=True)
    for i in range(1, pages + 1):
        (p / f"first_{i:05d}.tsv").write_text(content, encoding="utf-8")
    return p


def test_gate_legacy_flat_complete(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is True


def test_gate_per_source_hogaplay_complete(tmp_data_dir: Path) -> None:
    _write_meta_source(tmp_data_dir, "005930", "20260605", "hogaplay",
                       collection_complete=True, is_partial=False)
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is True


def test_gate_per_source_hogaplay_partial_but_kis_complete(tmp_data_dir: Path) -> None:
    """핵심: aggregate=COMPLETE(kis_live)여도 hogaplay가 partial이면 삭제 금지 (ADR-0075)."""
    _write_meta_source(tmp_data_dir, "005930", "20260605", "hogaplay",
                       collection_complete=True, is_partial=True)   # SOURCE_PARTIAL
    _write_meta_source(tmp_data_dir, "005930", "20260605", "kis_live",
                       collection_complete=True, is_partial=False)  # COMPLETE
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is False


def test_gate_client_incomplete_is_false(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605", collection_complete=False)
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is False


def test_gate_no_parquet_is_false(tmp_data_dir: Path) -> None:
    _make_raw(tmp_data_dir, "005930", "20260605")  # raw만, parquet 없음
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is False


def test_resolve_retention_days_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOGA_RETENTION_DAYS", raising=False)
    assert resolve_retention_days() == 3


def test_resolve_retention_days_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOGA_RETENTION_DAYS", "7")
    assert resolve_retention_days() == 7


# 모든 find_prunable/prune_raw 테스트의 고정 기준 시각: 2026-06-13.
# cutoff(N=3) = 2026-06-10 → date < "20260610"이면 후보.
_NOW = dt.datetime(2026, 6, 13)


def test_find_prunable_old_complete_is_candidate(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")
    cands = find_prunable(tmp_data_dir, retention_days=3, now=_NOW)
    assert [(c.date, c.code) for c in cands] == [("20260605", "005930")]
    assert cands[0].raw_dir == raw
    assert cands[0].size_bytes == 200  # 2 pages × 100 bytes


def test_find_prunable_within_grace_is_kept(tmp_data_dir: Path) -> None:
    # 20260612 >= cutoff 20260610 → 유예 내, 후보 아님
    _write_meta_flat(tmp_data_dir, "005930", "20260612",
                     collection_complete=True, is_partial=False)
    _make_raw(tmp_data_dir, "005930", "20260612")
    assert find_prunable(tmp_data_dir, retention_days=3, now=_NOW) == []


def test_find_prunable_old_but_partial_is_kept(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=True)  # SOURCE_PARTIAL
    _make_raw(tmp_data_dir, "005930", "20260605")
    assert find_prunable(tmp_data_dir, retention_days=3, now=_NOW) == []


def test_find_prunable_no_raw_root(tmp_data_dir: Path) -> None:
    assert find_prunable(tmp_data_dir, retention_days=3, now=_NOW) == []


def test_prune_raw_dry_run_deletes_nothing(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")
    result = prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=False)
    assert result.deleted == 0
    assert result.reclaimed_bytes == 0
    assert len(result.candidates) == 1
    assert raw.exists()  # 디스크 불변


def test_prune_raw_execute_deletes_and_reclaims(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")  # 200 bytes
    result = prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=True)
    assert result.deleted == 1
    assert result.reclaimed_bytes == 200
    assert not raw.exists()
    # parquet은 보존
    assert (tmp_data_dir / "parquet" / "20260605" / "005930" / "meta.json").exists()


def test_prune_raw_execute_removes_empty_date_dir(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    _make_raw(tmp_data_dir, "005930", "20260605")
    prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=True)
    # 날짜 내 유일 code가 삭제됐으므로 빈 raw/{date}/도 제거
    assert not (tmp_data_dir / "raw" / "20260605").exists()


def test_prune_raw_execute_keeps_nonempty_date_dir(tmp_data_dir: Path) -> None:
    # 같은 날짜에 COMPLETE(삭제)와 INCOMPLETE(보존)가 공존 → 날짜 디렉터리 유지
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    _make_raw(tmp_data_dir, "005930", "20260605")
    _make_raw(tmp_data_dir, "000660", "20260605")  # parquet 없음 → 보존
    prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=True)
    assert (tmp_data_dir / "raw" / "20260605" / "000660").exists()
    assert not (tmp_data_dir / "raw" / "20260605" / "005930").exists()
    # 삭제 후 재스캔: 000660만 남아 scanned == 1
    rescan = prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=False)
    assert rescan.scanned == 1
