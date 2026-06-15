# Raw Data Retention / Prune Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** parse 완료된 hogaplay raw TSV를 유예 기간 경과 후 자동/수동으로 안전 삭제해 디스크 무한 누적을 막는다.

**Architecture:** 순수 로직 모듈 `hoga/api/prune.py`(부작용 분리, 단위 테스트 용이)에 게이트·탐색·삭제를 두고, `hoga prune` CLI(dry-run 기본)와 Daily Scheduler 일일 훅이 같은 함수를 호출한다. 삭제 게이트는 hogaplay-source `DiskState.COMPLETE` + 날짜 컷오프(today−N 달력일).

**Tech Stack:** Python 3.12, typer(CLI), pytest, asyncio(scheduler), 기존 `hoga.api.disk_state`.

**환경 준비:** 새 worktree에서 처음 실행 시 dev 의존성 설치 필요 — `uv sync --all-extras` (pytest/ruff가 `[project.optional-dependencies] dev`에 있음). 테스트는 반드시 `uv run python -m pytest`로 실행한다(`uv run pytest`는 PATH의 글로벌 pytest를 잡아 `ModuleNotFoundError`로 실패). 린트는 `uv run ruff`.

**참조 문서:** spec `docs/superpowers/specs/2026-06-13-raw-data-retention-design.md`, ADR-0075, CONTEXT.md "Raw Prune".

---

## File Structure

- **Create** `hoga/api/prune.py` — 순수 retention 로직. 책임: 게이트 판정(`_is_complete_hogaplay`), 후보 탐색(`find_prunable`), 삭제 실행(`prune_raw`), 설정 해석(`resolve_retention_days`), 결과 타입(`PruneCandidate`, `PruneResult`).
- **Create** `tests/test_api_prune.py` — 단위 테스트 + 테스트 헬퍼(`_write_meta_flat`, `_write_meta_source`, `_make_raw`).
- **Modify** `hoga/cli.py` — `prune` 명령 추가(파일 끝, 다른 `@app.command()` 뒤).
- **Modify** `hoga/api/scheduler.py:_daily_run` — promotion 직후(L69–71 사이)에 prune 훅 삽입.

핵심 의존 시그니처(확인 완료):
- `classify_stock_date(stock_date_dir: Path) -> dict[str, Classification]` — `parquet/{date}/{code}` 하위 `*/meta.json`(per-source)을 읽어 `{"hogaplay": Classification, ...}` 반환. source subdir 없으면 `{}`.
- `check_disk_state(data_dir: Path, code: str, date: str) -> Classification` — legacy flat `parquet/{date}/{code}/meta.json` 포함 전체 해석.
- `DiskState.COMPLETE` 등 (`hoga.api.disk_state`).
- `now_kst() -> dt.datetime` (`hoga.collector.orchestrator`), `resolve_data_dir() -> Path` (`hoga.config`).
- `tmp_data_dir` 픽스처(`tests/conftest.py:55` → `tmp_path/data`).

---

## Task 1: prune.py 스캐폴드 — 데이터클래스 + `resolve_retention_days`

**Files:**
- Create: `hoga/api/prune.py`
- Test: `tests/test_api_prune.py`

- [ ] **Step 1: 실패 테스트 작성**

`tests/test_api_prune.py` 생성:

```python
"""hoga.api.prune — raw retention/prune 단위 테스트."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest

from hoga.api.prune import (
    PruneCandidate,
    PruneResult,
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


def test_resolve_retention_days_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOGA_RETENTION_DAYS", raising=False)
    assert resolve_retention_days() == 3


def test_resolve_retention_days_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOGA_RETENTION_DAYS", "7")
    assert resolve_retention_days() == 7
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.api.prune'`

- [ ] **Step 3: 최소 구현**

`hoga/api/prune.py` 생성:

```python
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -v`
Expected: PASS (2개 — `test_resolve_retention_days_default`, `test_resolve_retention_days_env_override`)

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/prune.py tests/test_api_prune.py
git commit -F - <<'EOF'
feat(prune): prune 모듈 스캐폴드 + resolve_retention_days

PruneCandidate/PruneResult 데이터클래스, HOGA_RETENTION_DAYS env 해석.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

> **커밋 주의(메모리):** 이 repo의 commit 훅이 `&&`-체이닝/heredoc을 오탐 차단할 수 있다. 막히면 메시지를 파일로 쓰고 단독 `git commit -F <file>`로 우회한다.

---

## Task 2: 게이트 헬퍼 `_is_complete_hogaplay` (per-source + legacy + kis_live 오삭제 방지)

**Files:**
- Modify: `hoga/api/prune.py`
- Test: `tests/test_api_prune.py`

- [ ] **Step 1: 실패 테스트 작성** (`tests/test_api_prune.py`에 추가)

```python
from hoga.api.prune import _is_complete_hogaplay


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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -k gate -v`
Expected: FAIL — `ImportError: cannot import name '_is_complete_hogaplay'`

- [ ] **Step 3: 최소 구현** (`hoga/api/prune.py`에 추가, `resolve_retention_days` 아래)

```python
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -k gate -v`
Expected: PASS (5개)

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/prune.py tests/test_api_prune.py
git commit -F - <<'EOF'
feat(prune): hogaplay-source COMPLETE 삭제 게이트

per-source(classify_stock_date)면 hogaplay만 보고, legacy flat이면
check_disk_state 폴백. kis_live=COMPLETE 때문에 hogaplay partial raw가
오삭제되는 것을 차단 (ADR-0075).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: `find_prunable` — 날짜 컷오프 + 게이트 통합

**Files:**
- Modify: `hoga/api/prune.py`
- Test: `tests/test_api_prune.py`

- [ ] **Step 1: 실패 테스트 작성** (`tests/test_api_prune.py`에 추가)

```python
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -k find_prunable -v`
Expected: FAIL — `find_prunable`가 빈 구현이거나 미정의 (현재 import는 되지만 NameError/미구현)

> 참고: Task 1에서 `find_prunable`을 import만 했고 정의는 없다. import 줄이 이미 있으므로 Step 2는 `AttributeError`/`ImportError`로 실패한다. 정의를 추가한다.

- [ ] **Step 3: 최소 구현** (`hoga/api/prune.py`에 추가)

```python
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -k find_prunable -v`
Expected: PASS (4개)

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/prune.py tests/test_api_prune.py
git commit -F - <<'EOF'
feat(prune): find_prunable — 달력일 컷오프 + COMPLETE 게이트

date < today-N(달력일) AND hogaplay COMPLETE인 raw만 후보. size_bytes는
사전 계산(dry-run 표시 + execute 합산용).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: `prune_raw` — dry-run / execute / 빈 날짜 디렉터리 정리

**Files:**
- Modify: `hoga/api/prune.py`
- Test: `tests/test_api_prune.py`

- [ ] **Step 1: 실패 테스트 작성** (`tests/test_api_prune.py`에 추가)

```python
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
    assert result_scanned_includes_both(tmp_data_dir)


def result_scanned_includes_both(data_dir: Path) -> bool:
    r = prune_raw(data_dir, retention_days=3, now=_NOW, execute=False)
    return r.scanned == 1  # 005930은 이미 삭제됨, 000660만 남아 1
```

> 참고: 마지막 테스트의 `result_scanned_includes_both`는 삭제 후 재스캔이라 `scanned==1`을 확인한다(005930은 이미 삭제, 000660만 남음). `scanned`는 "현재 raw에 존재하는 (date,code) 총수"다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -k prune_raw -v`
Expected: FAIL — `prune_raw` 미정의(AttributeError)

- [ ] **Step 3: 최소 구현** (`hoga/api/prune.py`에 추가)

```python
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
    삭제 후 비어 버린 날짜 디렉터리도 정리한다. rmtree 도중 실패해도 멱등 —
    다음 실행이 남은 후보를 이어서 지운다.
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -v`
Expected: PASS (전체 — Task 1~4의 모든 테스트)

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/prune.py tests/test_api_prune.py
git commit -F - <<'EOF'
feat(prune): prune_raw — dry-run/execute + 빈 날짜 디렉터리 정리

execute=False는 후보만 반환(무삭제), execute=True는 rmtree 후 reclaimed
집계 + 빈 raw/{date}/ 제거. rmtree 멱등.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: CLI `hoga prune` (dry-run 기본 / --execute / --days 0 거부)

**Files:**
- Modify: `hoga/cli.py` (파일 끝, 마지막 `@app.command()` 뒤)
- Test: `tests/test_api_prune.py`

- [ ] **Step 1: 실패 테스트 작성** (`tests/test_api_prune.py`에 추가)

```python
from typer.testing import CliRunner

from hoga.cli import app

_runner = CliRunner()


def test_cli_prune_rejects_days_zero() -> None:
    res = _runner.invoke(app, ["prune", "--days", "0"])
    assert res.exit_code != 0
    assert "must be >= 1" in res.output


def test_cli_prune_dry_run_reports_without_deleting(
    tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")
    monkeypatch.setattr("hoga.cli.resolve_data_dir", lambda: tmp_data_dir)
    monkeypatch.setattr("hoga.api.prune.now_kst", lambda: _NOW)
    res = _runner.invoke(app, ["prune", "--days", "3"])
    assert res.exit_code == 0
    assert "dry-run" in res.output
    assert raw.exists()  # 삭제 안 됨


def test_cli_prune_execute_deletes(
    tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")
    monkeypatch.setattr("hoga.cli.resolve_data_dir", lambda: tmp_data_dir)
    monkeypatch.setattr("hoga.api.prune.now_kst", lambda: _NOW)
    res = _runner.invoke(app, ["prune", "--days", "3", "--execute"])
    assert res.exit_code == 0
    assert "pruned" in res.output
    assert not raw.exists()
```

> 참고: CLI는 `now_kst`를 `hoga.api.prune`에서 호출하도록 구현한다(아래 Step 3). 그래야 테스트가 `hoga.api.prune.now_kst`를 패치해 시각을 고정할 수 있다. `resolve_data_dir`는 `hoga.cli`의 이름공간에서 패치한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -k cli_prune -v`
Expected: FAIL — `prune` 명령 없음 (`Usage: ... No such command 'prune'`, exit≠0이나 메시지 불일치)

- [ ] **Step 3: 최소 구현**

먼저 `hoga/api/prune.py` 상단 import에 `now_kst`를 추가한다(파일 내 기본 시각 출처를 prune 모듈로 통일 → 테스트 패치 지점 단일화):

```python
from hoga.collector.orchestrator import now_kst
```

그리고 모듈에 얇은 진입 헬퍼를 추가한다(`prune_raw` 아래):

```python
def prune_default_now() -> dt.datetime:
    """CLI/scheduler가 쓰는 기본 시각. 테스트는 이 심볼을 패치한다."""
    return now_kst()
```

`hoga/cli.py` 파일 끝(마지막 `@app.command()` 뒤)에 추가:

```python
@app.command()
def prune(
    days: int | None = typer.Option(
        None, "--days",
        help="Retention window in CALENDAR days (default: HOGA_RETENTION_DAYS or 3).",
    ),
    execute: bool = typer.Option(
        False, "--execute",
        help="Actually delete. Default is dry-run (report only).",
    ),
) -> None:
    """Prune hogaplay raw older than the retention window when its parquet is COMPLETE.

    Read-only by default — prints what WOULD be deleted. Pass ``--execute`` to
    delete. Only hogaplay-source COMPLETE raw past the window is removed; resume
    sources, partials, and sentinels are preserved (ADR-0075).
    """
    from hoga.api.prune import prune_default_now, prune_raw, resolve_retention_days
    from hoga.config import resolve_data_dir

    retention = days if days is not None else resolve_retention_days()
    if retention < 1:
        raise typer.BadParameter(
            "--days must be >= 1 (a 0-day window would race in-flight captures)."
        )

    result = prune_raw(
        resolve_data_dir(), retention_days=retention, now=prune_default_now(), execute=execute,
    )
    if execute:
        gib = result.reclaimed_bytes / 1024**3
        console.print(f"[green]pruned[/green] {result.deleted} dirs, {gib:.1f} GiB reclaimed")
    else:
        cand_gib = sum(c.size_bytes for c in result.candidates) / 1024**3
        console.print(
            f"[yellow]dry-run[/yellow]: would delete {len(result.candidates)} dirs, "
            f"~{cand_gib:.1f} GiB (pass --execute to delete)"
        )
```

> 테스트가 `hoga.api.prune.now_kst`를 패치하므로, `prune_default_now()`가 그 `now_kst`를 호출해야 한다. 즉 prune.py 안에서 `now_kst`를 모듈 전역으로 import해 두고 `prune_default_now`가 그것을 부르면 패치가 먹는다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -v`
Expected: PASS (전체)

- [ ] **Step 5: 커밋**

```bash
git add hoga/cli.py hoga/api/prune.py tests/test_api_prune.py
git commit -F - <<'EOF'
feat(prune): hoga prune CLI — dry-run 기본, --execute, --days 0 거부

validate --fix 관례를 따라 read-only 기본. --days < 1은 race guard 보호로
거부. 시각 출처를 prune.prune_default_now로 통일(테스트 패치 지점).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Scheduler 일일 훅

**Files:**
- Modify: `hoga/api/scheduler.py:_daily_run` (promotion try/except 직후, L69–71 사이)

- [ ] **Step 1: 실패 테스트 작성** (`tests/test_api_prune.py`에 추가)

scheduler `_daily_run`이 promotion 직후 `prune_raw(execute=True)`를 호출하는지 검증한다(거래일 게이트 전이라 비거래일에도 prune이 돈다).

```python
import asyncio


def test_daily_run_calls_prune_before_trading_gate(
    tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hoga.api.scheduler as sched

    calls: dict[str, bool] = {"pruned": False}

    # promotion no-op
    monkeypatch.setattr(sched, "load_watchlist", lambda _d: [])
    # 비거래일로 만들어 enqueue 단계는 건너뛰게 함 → prune이 그 '전에' 불렸는지 본다
    monkeypatch.setattr(sched, "trading_days_in_range", lambda _s, _e: set())

    import hoga.api.prune as prune_mod
    real_prune = prune_mod.prune_raw

    def _spy(data_dir, **kw):
        calls["pruned"] = True
        return real_prune(data_dir, **kw)

    monkeypatch.setattr(prune_mod, "prune_raw", _spy)

    async def _fake_promote(_d):  # promotion no-op
        return None
    monkeypatch.setattr("hoga.live.promote.promote_pending", _fake_promote)
    monkeypatch.setattr("hoga.live.promote.cleanup_archive", _fake_promote)

    asyncio.run(sched._daily_run(tmp_data_dir))
    assert calls["pruned"] is True
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -k daily_run -v`
Expected: FAIL — `_daily_run`이 prune을 호출하지 않음(`calls["pruned"]` False)

- [ ] **Step 3: 최소 구현**

`hoga/api/scheduler.py`의 `_daily_run`에서 promotion try/except 블록(현재 L63–69) **직후, `now = now_kst()`(L71) 직전**에 삽입:

```python
    # Stage 9: Prune COMPLETE hogaplay raw past the retention window (ADR-0075).
    # Scheduler-owned, queue-untouching (like Promotion) — runs every day,
    # before the trading-day gate, so weekends/holidays still reclaim disk.
    from hoga.api.prune import prune_raw, resolve_retention_days
    try:
        pruned = await asyncio.to_thread(
            prune_raw, data_dir,
            retention_days=resolve_retention_days(), now=now_kst(), execute=True,
        )
        log.info(
            "daily prune: removed %d dirs, reclaimed %.2f GiB",
            pruned.deleted, pruned.reclaimed_bytes / 1024**3,
        )
    except Exception:  # noqa: BLE001 — prune 실패가 enqueue를 막으면 안 됨
        log.exception("daily run: prune failed; continuing")
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run python -m pytest tests/test_api_prune.py -v`
Expected: PASS (전체)

- [ ] **Step 5: 전체 스위트 + 린트 + 커밋**

```bash
uv run python -m pytest tests/test_api_prune.py -v
uv run ruff check hoga/api/prune.py hoga/cli.py hoga/api/scheduler.py
```
Expected: 테스트 PASS, ruff 통과(또는 자동수정 후 통과)

```bash
git add hoga/api/scheduler.py tests/test_api_prune.py
git commit -F - <<'EOF'
feat(prune): Daily Scheduler 일일 자동 prune 훅

promotion 직후·거래일 게이트 전에 prune_raw(execute=True)를 asyncio.to_thread로
실행하고 회수량을 로깅. 실패는 swallow(enqueue를 막지 않음). ADR-0075.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: 회귀 확인 + 수동 검증

**Files:** 없음(검증만)

- [ ] **Step 1: 전체 백엔드 테스트 회귀**

Run: `uv run python -m pytest tests/ -q`
Expected: 기존 스위트 그린(신규 prune 테스트 포함). 실패 시 해당 테스트를 분석 — prune 변경이 disk_state/scheduler 기존 동작을 깨지 않았는지 확인.

- [ ] **Step 2: 수동 dry-run (실데이터)**

Run: `uv run hoga prune`
Expected: `dry-run: would delete N dirs, ~X GiB` — N·X가 합리적인지(현재 raw에 today−3 이전 COMPLETE가 거의 없으면 0에 가까움) 육안 확인. **삭제되지 않아야 함.**

- [ ] **Step 3: 게이트 안전 재확인 (선택, 실데이터)**

`uv run hoga prune --days 1`로 후보를 넓혀 출력만 보고, 후보에 보존 대상(미완성/sentinel)이 섞이지 않았는지 표본 확인. 실삭제(`--execute`)는 사용자 판단에 맡긴다.

- [ ] **Step 4: 완료 보고**

plan의 모든 체크박스가 체크됐고 전체 테스트가 그린이면 구현 완료. 사용자에게 `hoga prune --execute` 첫 수동 실행 또는 다음 일일 스케줄러 자동 실행 로그(`daily prune: removed ...`) 확인을 안내한다.

---

## Self-Review (작성자 점검 완료)

**Spec 커버리지:**
- 게이트 hogaplay-source COMPLETE → Task 2 ✓
- 날짜 컷오프(달력일) → Task 3 ✓
- dry-run/execute → Task 4, 5 ✓
- 빈 날짜 디렉터리 정리 → Task 4 ✓
- `--days 0` 거부 → Task 5 ✓
- reclaimed_bytes 정확성 → Task 4 ✓
- 설정 `HOGA_RETENTION_DAYS` → Task 1 ✓
- scheduler 자동 + 로깅 → Task 6 ✓
- 보존 케이스(SOURCE_PARTIAL/CLIENT_INCOMPLETE/no-parquet) → Task 2, 3 ✓
- NO_UPSTREAM/INVALID 보존 → `_is_complete_hogaplay`가 COMPLETE만 True이므로 자동 커버(별도 테스트는 Backlog: sentinel/INVALID 케이스 추가 가능)

**타입 일관성:** `PruneCandidate`(date,code,raw_dir,size_bytes) / `PruneResult`(candidates,deleted,reclaimed_bytes,scanned) — 모든 Task에서 동일 필드명 사용 ✓. 게이트 함수명 `_is_complete_hogaplay` 일관 ✓.

**미해결(Backlog):** spec Testing 표의 INVALID/NO_UPSTREAM 명시 케이스는 게이트가 COMPLETE-only라 자동 보존되므로 회귀 테스트 우선순위는 낮음 — 필요 시 Task 2에 2케이스 추가.
