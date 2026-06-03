# 관심종목 폴더화 + WatchlistEditModal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

scope: both

**Goal:** 관심종목을 사용자 폴더로 묶고, 우측 패널을 폴더-그룹 읽기 뷰로, 모든 편집(추가/삭제/폴더이동/순서/폴더 CRUD)을 2-pane `WatchlistEditModal`로 일원화한다.

**Architecture:** 백엔드 `watchlist.json`을 v2 문서(`{schema_version, folders, entries}`)로 forward-migrate한다(quarantine 금지, ADR-0064). 타입드 `WatchlistDocument` 봉투 + document-level `model_validator`로 참조 무결성을 강제하고, **모든 writer가 단일 `_lock` 아래 전체 문서를 round-trip**한다(folders가 캡처-성공 write에 삭제되지 않음). 프론트는 wire를 verbatim 미러(ADR-0004)하고 폴더 그룹핑은 순수 렌더(미분류 = `folder_id===null`). 편집은 backdrop Modal, 이동/순서는 dnd-kit + 낙관적 업데이트, 폴더 CRUD는 invalidate-only.

**Tech Stack:** Python 3 / FastAPI / Pydantic v2 / pytest · React 18 / TypeScript / Vite / Zustand / TanStack Query / @dnd-kit / vitest.

**참조:** spec `docs/superpowers/specs/2026-05-31-watchlist-folders-design.md` (특히 "Grill resolutions" 섹션이 권위), ADR-0064, CONTEXT.md (Watchlist / Watchlist Folder / 미분류 / Watchlist Edit Modal).

**테스트 실행:** 백엔드 `uv run --extra dev pytest <path>`; 프론트 `cd frontend && npx vitest run <path>`; 빌드 `cd frontend && npm run build`.

---

## File structure

**백엔드 (`hoga/`)**
- `hoga/api/models.py` — `WatchlistFolder`, `WatchlistDocument` 추가; `WatchlistEntry`에 `folder_id`/`order`; `WatchlistResponse`에 `folders`.
- `hoga/api/watchlist.py` — `load_document`/`save_document`/`_migrate`/`_reindex` + 폴더·이동·순서·일괄 mutation. `save_watchlist(entries=)` 제거, `load_watchlist()`는 읽기 wrapper 유지.
- `hoga/api/watchlist_routes.py` — 폴더 CRUD + 이동/순서/일괄삭제 라우트; GET이 folders 반환.

**프론트 (`frontend/src/`)**
- `api/watchlist.ts` — `WatchlistFolder` 타입, `WatchlistEntry`/`WatchlistResponse` 확장, mutation 함수.
- `watchlist/watchlistKeys.ts` — `['watchlist']` 단일 상수 (신규).
- `watchlist/useWatchlist.ts` — 신규 mutation 훅 (폴더 CRUD = invalidate / 이동·순서 = 낙관적).
- `watchlist/grouping.ts` (+`.test.ts`) — 순수 폴더 그룹핑 util (신규).
- `watchlist/useWatchlistFeedback.ts` — RecentAction 리듀서 + 5s 타이머 (WatchlistPanel.tsx에서 추출).
- `watchlist/Banner.tsx` — 배너 컴포넌트 (추출).
- `watchlist/WatchlistAddForm.tsx` — picked+submit+409 래퍼 (추출, drawer·modal 공유).
- `watchlist/rowFormat.tsx` — `fmtDate` + `LastSuccessBadge` (3중 복제 방지).
- `watchlist/WatchlistDrawer.tsx` — 폴더-그룹 + 푸터(카운트다운+전체수집) + 편집 버튼 (재작성).
- `watchlist/WatchlistEditModal.tsx` — 2-pane 편집 Modal (신규, 가장 큼 — F6~F9로 분할).
- 삭제: `pages/Watchlist.tsx`, `watchlist/WatchlistPanel.tsx`, `watchlist/WatchlistRow.tsx`; `main.tsx`의 `/watchlist` Route; `nav/LeftNav.tsx`의 Watchlist NavItem.

## Task dependency / file-glob map (stage-5 DAG용)

| Task | Files (glob) | depends_on |
|---|---|---|
| B1 models | `hoga/api/models.py` | — |
| B2 load/save/migrate | `hoga/api/watchlist.py`, `tests/test_api_watchlist.py` | B1 |
| B3 folder mutations | `hoga/api/watchlist.py`, `tests/test_api_watchlist_folders.py` | B2 |
| B4 entry move/reorder/bulk | `hoga/api/watchlist.py`, `tests/test_api_watchlist_folders.py` | B2, B3 |
| B5 routes | `hoga/api/watchlist_routes.py`, `tests/test_api_watchlist_routes.py` | B3, B4 |
| B6 concurrency test | `tests/test_api_watchlist_concurrency.py` | B3, B4 |
| F1 api types | `frontend/src/api/watchlist.ts`, `frontend/src/watchlist/watchlistKeys.ts` | B5 (shape만) |
| F2 hooks | `frontend/src/watchlist/useWatchlist.ts` | F1 |
| F3 grouping | `frontend/src/watchlist/grouping.ts(.test)` | F1 |
| F4 extracts | `frontend/src/watchlist/{useWatchlistFeedback,Banner,WatchlistAddForm,rowFormat}.*` | F1, F2 |
| F7 entry pane | `frontend/src/watchlist/WatchlistEntryPane.tsx(.test)` | F2, F4 |
| F6 modal shell | `frontend/src/watchlist/WatchlistEditModal.tsx(.test)` | F3, **F7** (shell imports the pane) |
| F8 dnd | `frontend/src/watchlist/{dragHandlers,WatchlistEditModal,WatchlistEntryPane}.*` | F6, F7 |
| F9 folder actions | `frontend/src/watchlist/WatchlistEditModal.tsx` | F6 |
| F5 drawer | `frontend/src/watchlist/WatchlistDrawer.tsx(.test)` | F2, F3, F4, **F6, F7, F8, F9** (imports WatchlistEditModal) |
| F10 deletion | `frontend/src/{pages/Watchlist.tsx,main.tsx,nav/LeftNav.tsx,watchlist/WatchlistPanel.tsx,watchlist/WatchlistRow.tsx}` | F5, F6-F9 |

> 글롭 겹침: B2/B3/B4가 모두 `watchlist.py` → **같은 wave 금지(순차)**. **F5는 `WatchlistEditModal`을 import → F6-F9 뒤에 실행(병렬 불가).** 모달 내부 import 의존: **F7(EntryPane) → F6(shell이 EntryPane import) → F8(DnD, 양쪽 수정) → F9(폴더 액션)**. 글롭 비중첩(WatchlistDrawer.tsx vs WatchlistEditModal*.tsx)은 병렬의 *필요*조건일 뿐 *충분*조건이 아니다 — import 방향이 순서를 강제한다. F10은 모든 프론트 task 뒤(마지막).

---

## Task B1: Pydantic 모델 — WatchlistFolder / WatchlistDocument / 확장

**Files:**
- Modify: `hoga/api/models.py:545-560` (Watchlist 블록)
- Test: `tests/test_api_watchlist_folders.py` (생성)

- [ ] **Step 1: 실패 테스트 작성** — `tests/test_api_watchlist_folders.py`

```python
"""Watchlist v2: folders + document envelope + referential integrity.
See spec 2026-05-31-watchlist-folders-design.md, ADR-0064."""
from __future__ import annotations

import pytest
from pydantic import ValidationError


def test_folder_model_fields():
    from hoga.api.models import WatchlistFolder
    # id must match ^f_[0-9a-f]{8}$ (what _mint_folder_id produces); use a
    # pattern-valid literal in fixtures or Pydantic rejects at construction.
    f = WatchlistFolder(id="f_0000000a", name="스윙", order=0)
    assert f.id == "f_0000000a"
    assert f.name == "스윙"
    assert f.order == 0


def test_entry_defaults_folder_id_null_order_zero():
    from hoga.api.models import WatchlistEntry
    e = WatchlistEntry(code="005930", name="삼성전자",
                       registered_at_kst_date="20260101", last_success_date=None)
    assert e.folder_id is None
    assert e.order == 0


def test_document_rejects_dangling_folder_id():
    from hoga.api.models import WatchlistDocument, WatchlistEntry
    # f_deadbeef is pattern-VALID (8 hex) but absent from folders, so the
    # failure must originate in the document-level _no_dangling_folder_id
    # validator — NOT WatchlistEntry field-pattern validation. match= pins
    # that the referential-integrity validator (the point of B1) actually ran.
    with pytest.raises(ValidationError, match="unknown folder"):
        WatchlistDocument(
            schema_version=2,
            folders=[],
            entries=[WatchlistEntry(code="005930", name="삼성전자",
                                    registered_at_kst_date="20260101",
                                    last_success_date=None, folder_id="f_deadbeef")],
        )


def test_document_accepts_null_and_valid_folder_id():
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        schema_version=2,
        folders=[WatchlistFolder(id="f_0000000b", name="스윙", order=0)],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260101",
                           last_success_date=None, folder_id="f_0000000b", order=0),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260101",
                           last_success_date=None, folder_id=None, order=0),
        ],
    )
    assert len(doc.entries) == 2
```

- [ ] **Step 2: 테스트 실패 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_folders.py -q` → FAIL (`ImportError: cannot import name 'WatchlistFolder'`).

- [ ] **Step 3: 모델 구현** — `hoga/api/models.py`의 기존 Watchlist 블록(545-560)을 아래로 교체. `model_validator`는 파일 상단 import에 추가(`from pydantic import ... model_validator` — 이미 `BaseModel, Field`가 있으니 `model_validator`만 보강).

```python
class WatchlistFolder(BaseModel):
    """A named, ordered grouping of WatchlistEntries. See CONTEXT.md
    "Watchlist Folder". `id` is backend-minted and stable across renames."""

    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)


class WatchlistEntry(BaseModel):
    """One Code in the Watchlist. See CONTEXT.md WatchlistEntry."""

    code: str = Field(pattern=r"^\d{6}$")
    name: str
    registered_at_kst_date: str = Field(pattern=r"^\d{8}$")
    last_success_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    folder_id: str | None = Field(default=None, pattern=r"^f_[0-9a-f]{8}$")
    order: int = Field(default=0, ge=0)


class WatchlistDocument(BaseModel):
    """On-disk watchlist.json (v2). Typed envelope, validated on load via
    model_validate. Every writer round-trips the WHOLE document under one
    lock so folders survive a capture-success write (ADR-0064)."""

    schema_version: int = 2
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[WatchlistEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def _no_dangling_folder_id(self) -> "WatchlistDocument":
        valid = {f.id for f in self.folders}
        for e in self.entries:
            if e.folder_id is not None and e.folder_id not in valid:
                raise ValueError(
                    f"entry {e.code} references unknown folder {e.folder_id}"
                )
        return self


class WatchlistResponse(BaseModel):
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[WatchlistEntry]
    next_run_at_ms: int  # Unix-ms of next KST 17:00 boundary (ADR-0003)


class WatchlistAddRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
```

- [ ] **Step 4: import 보강** — `hoga/api/models.py` 상단에 `model_validator`가 없으면 추가:

Run: `grep -n "from pydantic import" hoga/api/models.py`
필요 시: `from pydantic import BaseModel, Field, model_validator`

- [ ] **Step 5: 테스트 통과 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_folders.py -q` → PASS.

- [ ] **Step 6: 커밋**

```bash
git add hoga/api/models.py tests/test_api_watchlist_folders.py
git commit -m "feat(watchlist): v2 models — WatchlistFolder, WatchlistDocument, entry folder_id/order"
```

---

## Task B2: load/save/migrate — forward-migrate, whole-document round-trip

**Files:**
- Modify: `hoga/api/watchlist.py:35-185` (load/save + 4 writers)
- Modify: `tests/test_api_watchlist.py` (시그니처 변경 반영)
- Test: `tests/test_api_watchlist_folders.py` (마이그레이션 케이스 추가)

- [ ] **Step 1: 실패 테스트 작성** — `tests/test_api_watchlist_folders.py`에 append.

```python
def test_migrate_v1_seeds_order_and_empty_folders(tmp_path):
    import json
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자", "registered_at_kst_date": "20260101", "last_success_date": None},
            {"code": "000660", "name": "SK하이닉스", "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 2
    assert doc.folders == []
    assert [e.code for e in doc.entries] == ["005930", "000660"]
    assert [e.order for e in doc.entries] == [0, 1]  # 미분류 group reindexed
    assert all(e.folder_id is None for e in doc.entries)


def test_migrate_is_idempotent(tmp_path):
    from hoga.api.watchlist import load_document, save_document
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0)],
        entries=[WatchlistEntry(code="005930", name="삼성전자",
                                registered_at_kst_date="20260101", last_success_date=None,
                                folder_id="f_0000000a", order=0)],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert reloaded.schema_version == 2
    assert reloaded.folders[0].id == "f_0000000a"
    assert reloaded.entries[0].folder_id == "f_0000000a"


def test_load_repairs_dangling_folder_id_without_wiping(tmp_path):
    import json
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 2,
        "folders": [],
        "entries": [{"code": "005930", "name": "삼성전자", "registered_at_kst_date": "20260101",
                     "last_success_date": None, "folder_id": "f_ghost", "order": 0}],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    # repaired (folder_id nulled), NOT backed-up-and-emptied
    assert len(doc.entries) == 1
    assert doc.entries[0].folder_id is None
    assert not list(tmp_path.glob("watchlist.json.corrupt-*"))


def test_bump_last_success_preserves_folders(tmp_path):
    """Blocker #1 regression: the Scheduler's bump must NOT drop folders."""
    import asyncio
    from hoga.api.watchlist import load_document, save_document, bump_last_success
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    save_document(tmp_path, WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0)],
        entries=[WatchlistEntry(code="005930", name="삼성전자",
                                registered_at_kst_date="20260101", last_success_date=None,
                                folder_id="f_0000000a", order=0)],
    ))
    asyncio.run(bump_last_success(tmp_path, code="005930", date="20260102"))
    doc = load_document(tmp_path)
    assert doc.folders[0].id == "f_0000000a"          # folder survived
    assert doc.entries[0].folder_id == "f_0000000a"   # membership survived
    assert doc.entries[0].last_success_date == "20260102"


def test_future_version_raises_not_downgrades(tmp_path):
    """ADR-0064 rule 1: a future schema_version must raise, not be clobbered to v2."""
    import json
    import pytest
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 3, "folders": [], "entries": [],
    }), encoding="utf-8")
    with pytest.raises(ValueError, match="unsupported watchlist schema_version"):
        load_document(tmp_path)
```

- [ ] **Step 2: 테스트 실패 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_folders.py -q` → FAIL (`ImportError: load_document`).

- [ ] **Step 3: load/save/migrate/reindex 구현** — `hoga/api/watchlist.py`에서 `load_watchlist`/`save_watchlist`(35-71)를 아래로 교체. import에 `WatchlistDocument, WatchlistFolder`(models) 추가.

```python
from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder


def _migrate(raw: dict) -> dict:
    """Normalise any on-disk shape to a v2 dict, repairing (not wiping) drift.

    - v1 (`{version:1, entries:[...]}`) or field-less legacy → seed
      `folder_id=null`, `order` by index, `folders=[]`.
    - Dangling `folder_id` (references a missing folder) → repaired to null
      rather than rejected (watchlist = irreplaceable user data, ADR-0064).
    Genuine corruption (bad JSON / field-pattern violations) is NOT handled
    here — it surfaces as ValidationError to load_document's backup path.
    """
    version = raw.get("schema_version", raw.get("version", 1))
    if version > 2:
        # ADR-0064 rule 1: an unrecognised FUTURE version must RAISE, not be
        # silently downgraded — never clobber data a newer build wrote. This
        # ValueError is NOT caught by load_document's backup path (which only
        # catches JSONDecodeError/ValidationError), so it propagates loudly.
        raise ValueError(f"unsupported watchlist schema_version {version}")
    folders = raw.get("folders", []) if version >= 2 else []
    valid_ids = {f.get("id") for f in folders}
    entries: list[dict] = []
    for i, e in enumerate(raw.get("entries", [])):
        e = dict(e)
        fid = e.get("folder_id")
        e["folder_id"] = fid if fid in valid_ids else None
        e["order"] = e.get("order", i)
        entries.append(e)
    return {"schema_version": 2, "folders": folders, "entries": entries}


def _reindex(doc: WatchlistDocument) -> WatchlistDocument:
    """Reassign entry.order to 0..N-1 within each folder group (incl. null),
    ranking by current order then flat position; folders[].order to 0..N-1.
    Flat list order is preserved. Idempotent."""
    groups: dict[str | None, list[int]] = {}
    for idx, e in enumerate(doc.entries):
        groups.setdefault(e.folder_id, []).append(idx)
    order_for: dict[int, int] = {}
    for idxs in groups.values():
        for rank, i in enumerate(sorted(idxs, key=lambda i: (doc.entries[i].order, i))):
            order_for[i] = rank
    new_entries = [e.model_copy(update={"order": order_for[i]})
                   for i, e in enumerate(doc.entries)]
    fsorted = sorted(range(len(doc.folders)),
                     key=lambda i: (doc.folders[i].order, i))
    fo = {orig: rank for rank, orig in enumerate(fsorted)}
    new_folders = [f.model_copy(update={"order": fo[i]})
                   for i, f in enumerate(doc.folders)]
    return doc.model_copy(update={"folders": new_folders, "entries": new_entries})


def load_document(data_dir: Path) -> WatchlistDocument:
    """Read watchlist.json as a v2 WatchlistDocument. Missing → empty doc.
    Forward-migrates v1 in place (never quarantines — ADR-0064). Genuine
    corruption (invalid JSON / schema-violating entries) → backup + empty,
    matching the prior behaviour; OSError propagates."""
    p = _path(data_dir)
    if not p.exists():
        return WatchlistDocument()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return _reindex(WatchlistDocument.model_validate(_migrate(raw)))
    except (json.JSONDecodeError, ValidationError) as e:
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = p.with_name(f"watchlist.json.corrupt-{stamp}")
        try:
            p.rename(backup)
        except OSError:
            log.exception("could not back up corrupt watchlist.json")
        log.warning("watchlist.json was corrupt (%s); backed up to %s", e, backup)
        return WatchlistDocument()


def save_document(data_dir: Path, doc: WatchlistDocument) -> None:
    """Atomic write of the WHOLE v2 document. The only write path."""
    atomic_write_json(_path(data_dir), _reindex(doc).model_dump())


def load_watchlist(data_dir: Path) -> list[WatchlistEntry]:
    """Read-only convenience for callers that only need the entry list
    (Daily Scheduler, catch-up routes, live poller). Writers MUST use
    load_document/save_document to preserve folders."""
    return load_document(data_dir).entries
```

> **삭제**: 기존 `save_watchlist(data_dir, *, entries=...)` 함수 전체 삭제. entries-only write 경로는 더 이상 없다(Blocker #1).

- [ ] **Step 4: 4개 writer를 전체-문서 round-trip으로 재작성** — `hoga/api/watchlist.py`의 `add_entry`/`remove_entry`/`bump_last_success`/`set_last_success` 본문에서 `entries = load_watchlist(...)` → `doc = load_document(...)`, `save_watchlist(..., entries=X)` → `save_document(..., doc.model_copy(update={"entries": X}))`로 교체.

```python
async def add_entry(data_dir, *, code, name, today_kst_date) -> WatchlistEntry:
    from hoga.api.disk_state import latest_complete_date
    async with _lock:
        doc = load_document(data_dir)
        if any(e.code == code for e in doc.entries):
            raise AlreadyInWatchlistError(code)
        entry = WatchlistEntry(
            code=code, name=name, registered_at_kst_date=today_kst_date,
            last_success_date=latest_complete_date(data_dir, code),
            folder_id=None, order=0,  # appended to 미분류; _reindex sets order
        )
        save_document(data_dir, doc.model_copy(update={"entries": [*doc.entries, entry]}))
        return entry


async def remove_entry(data_dir, *, code) -> None:
    async with _lock:
        doc = load_document(data_dir)
        if not any(e.code == code for e in doc.entries):
            raise NotInWatchlistError(code)
        save_document(data_dir, doc.model_copy(
            update={"entries": [e for e in doc.entries if e.code != code]}))


async def bump_last_success(data_dir, *, code, date) -> None:
    async with _lock:
        doc = load_document(data_dir)
        new, changed = [], False
        for e in doc.entries:
            if e.code == code and (e.last_success_date is None or date > e.last_success_date):
                new.append(e.model_copy(update={"last_success_date": date})); changed = True
            else:
                new.append(e)
        if changed:
            save_document(data_dir, doc.model_copy(update={"entries": new}))


async def set_last_success(data_dir, *, code, date) -> None:
    async with _lock:
        doc = load_document(data_dir)
        new, changed = [], False
        for e in doc.entries:
            if e.code == code and e.last_success_date != date:
                new.append(e.model_copy(update={"last_success_date": date})); changed = True
            else:
                new.append(e)
        if changed:
            save_document(data_dir, doc.model_copy(update={"entries": new}))
```

> docstring은 기존 것을 유지(축약 표기). `add_entry`의 `latest_complete_date` 로컬 import도 유지.

- [ ] **Step 5: 기존 테스트의 변경된 시그니처 반영** — `save_watchlist`를 직접 부르는 3곳을 `save_document`로 교체.

`tests/test_api_watchlist.py:18-27` (`test_save_then_load_round_trip`): `save_watchlist(tmp_path, entries=[entry])` → 
```python
from hoga.api.watchlist import load_watchlist, save_document
from hoga.api.models import WatchlistDocument
save_document(tmp_path, WatchlistDocument(entries=[entry]))
```
`tests/test_api_watchlist.py:233` (spy `save_watchlist`) → spy `save_document` 대신:
```python
monkeypatch.setattr(watchlist, "save_document", spy_save)
```
`tests/test_api_watchlist_marker_sync.py:130` (`save_watchlist(tmp_path, entries=stale)`) 및 `tests/test_api_scheduler.py:219` (`save_watchlist(tmp_path, entries=forced)`) → 둘 다:
```python
watchlist.save_document(tmp_path, watchlist.WatchlistDocument(entries=...))
```
(필요한 곳에 `from hoga.api.models import WatchlistDocument` 또는 `watchlist.WatchlistDocument` 노출 import 추가.)

- [ ] **Step 6: 전체 watchlist 백엔드 테스트 통과 확인**

Run: `uv run --extra dev pytest tests/test_api_watchlist.py tests/test_api_watchlist_folders.py tests/test_api_watchlist_marker_sync.py tests/test_api_scheduler.py -q`
Expected: PASS (마이그레이션·folder 보존·기존 동작 모두 green).

- [ ] **Step 7: 커밋**

```bash
git add hoga/api/watchlist.py tests/test_api_watchlist.py tests/test_api_watchlist_folders.py tests/test_api_watchlist_marker_sync.py tests/test_api_scheduler.py
git commit -m "feat(watchlist): v2 document load/save, forward-migrate, whole-doc round-trip"
```

---

## Task B3: 폴더 mutation — create/rename/delete/reorder

**Files:**
- Modify: `hoga/api/watchlist.py` (mutation 추가)
- Test: `tests/test_api_watchlist_folders.py` (append)

- [ ] **Step 1: 실패 테스트 작성** — append

```python
def test_create_folder_mints_id_and_appends(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    assert f.id.startswith("f_") and len(f.id) == 10
    assert f.name == "스윙" and f.order == 0
    f2 = asyncio.run(create_folder(tmp_path, name="장기투자"))
    assert f2.order == 1
    assert [x.id for x in load_document(tmp_path).folders] == [f.id, f2.id]


def test_rename_folder_keeps_id(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, rename_folder, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(rename_folder(tmp_path, folder_id=f.id, name="단타"))
    folders = load_document(tmp_path).folders
    assert folders[0].id == f.id and folders[0].name == "단타"


def test_delete_folder_reparents_members_to_null(tmp_path):
    import asyncio
    from hoga.api.watchlist import (create_folder, add_entry, move_entries,
                                    delete_folder, load_document)
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260101"))
    asyncio.run(move_entries(tmp_path, codes=["005930"], folder_id=f.id))
    asyncio.run(delete_folder(tmp_path, folder_id=f.id))
    doc = load_document(tmp_path)
    assert doc.folders == []
    assert doc.entries[0].folder_id is None   # reparented, not deleted


def test_reorder_folders(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, reorder_folders, load_document
    a = asyncio.run(create_folder(tmp_path, name="A"))
    b = asyncio.run(create_folder(tmp_path, name="B"))
    asyncio.run(reorder_folders(tmp_path, ordered_ids=[b.id, a.id]))
    assert [f.name for f in load_document(tmp_path).folders] == ["B", "A"]
```

- [ ] **Step 2: 실패 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_folders.py -q` → FAIL (`ImportError: create_folder`).

- [ ] **Step 3: 폴더 mutation 구현** — `hoga/api/watchlist.py`에 추가. 상단에 `import secrets` 추가, 예외 클래스 추가.

```python
import secrets


class FolderNotFoundError(Exception):
    """Raised when a folder_id is absent from the Watchlist."""


def _mint_folder_id() -> str:
    return "f_" + secrets.token_hex(4)


async def create_folder(data_dir: Path, *, name: str) -> WatchlistFolder:
    async with _lock:
        doc = load_document(data_dir)
        folder = WatchlistFolder(id=_mint_folder_id(), name=name.strip(),
                                 order=len(doc.folders))
        save_document(data_dir, doc.model_copy(update={"folders": [*doc.folders, folder]}))
        return folder


async def rename_folder(data_dir: Path, *, folder_id: str, name: str) -> None:
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        new = [f.model_copy(update={"name": name.strip()}) if f.id == folder_id else f
               for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new}))


async def delete_folder(data_dir: Path, *, folder_id: str) -> None:
    """Delete the folder and reparent its members to 미분류 (folder_id=null)."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        new_folders = [f for f in doc.folders if f.id != folder_id]
        new_entries = [e.model_copy(update={"folder_id": None}) if e.folder_id == folder_id else e
                       for e in doc.entries]
        save_document(data_dir, doc.model_copy(
            update={"folders": new_folders, "entries": new_entries}))


async def reorder_folders(data_dir: Path, *, ordered_ids: list[str]) -> None:
    """Set folders[].order to match ordered_ids. Unknown / missing ids are
    rejected so the client and server can't drift."""
    async with _lock:
        doc = load_document(data_dir)
        current = {f.id for f in doc.folders}
        if set(ordered_ids) != current:
            raise FolderNotFoundError(f"ordered_ids {ordered_ids} != {current}")
        rank = {fid: i for i, fid in enumerate(ordered_ids)}
        new = [f.model_copy(update={"order": rank[f.id]}) for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new}))
```

- [ ] **Step 4: 통과 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_folders.py -q` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/watchlist.py tests/test_api_watchlist_folders.py
git commit -m "feat(watchlist): folder create/rename/delete(reparent)/reorder mutations"
```

---

## Task B4: entry mutation — move(bulk) / reorder / bulk remove

**Files:**
- Modify: `hoga/api/watchlist.py`
- Test: `tests/test_api_watchlist_folders.py` (append)

- [ ] **Step 1: 실패 테스트 작성** — append

```python
def test_move_entries_sets_folder_and_appends_order(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, add_entry, move_entries, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    for c, n in [("005930", "삼성전자"), ("000660", "SK하이닉스")]:
        asyncio.run(add_entry(tmp_path, code=c, name=n, today_kst_date="20260101"))
    asyncio.run(move_entries(tmp_path, codes=["000660", "005930"], folder_id=f.id))
    doc = load_document(tmp_path)
    moved = {e.code: e for e in doc.entries}
    assert moved["000660"].folder_id == f.id and moved["005930"].folder_id == f.id
    # contiguous 0..1 within the target folder
    assert sorted(e.order for e in doc.entries if e.folder_id == f.id) == [0, 1]


def test_move_to_null_uncategorizes(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, add_entry, move_entries, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260101"))
    asyncio.run(move_entries(tmp_path, codes=["005930"], folder_id=f.id))
    asyncio.run(move_entries(tmp_path, codes=["005930"], folder_id=None))
    assert load_document(tmp_path).entries[0].folder_id is None


def test_move_to_unknown_folder_raises(tmp_path):
    import asyncio
    import pytest
    from hoga.api.watchlist import add_entry, move_entries, FolderNotFoundError
    asyncio.run(add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260101"))
    with pytest.raises(FolderNotFoundError):
        asyncio.run(move_entries(tmp_path, codes=["005930"], folder_id="f_deadbeef"))


def test_reorder_entries_within_folder(tmp_path):
    import asyncio
    from hoga.api.watchlist import add_entry, reorder_entries, load_document
    for c, n in [("005930", "삼성"), ("000660", "SK"), ("035720", "카카오")]:
        asyncio.run(add_entry(tmp_path, code=c, name=n, today_kst_date="20260101"))
    asyncio.run(reorder_entries(tmp_path, folder_id=None, ordered_codes=["035720", "005930", "000660"]))
    doc = load_document(tmp_path)
    by_order = sorted(doc.entries, key=lambda e: e.order)
    assert [e.code for e in by_order] == ["035720", "005930", "000660"]


def test_remove_entries_bulk(tmp_path):
    import asyncio
    from hoga.api.watchlist import add_entry, remove_entries, load_document
    for c, n in [("005930", "삼성"), ("000660", "SK")]:
        asyncio.run(add_entry(tmp_path, code=c, name=n, today_kst_date="20260101"))
    asyncio.run(remove_entries(tmp_path, codes=["005930", "000660"]))
    assert load_document(tmp_path).entries == []
```

- [ ] **Step 2: 실패 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_folders.py -q` → FAIL.

- [ ] **Step 3: entry mutation 구현** — `hoga/api/watchlist.py`에 추가

```python
async def move_entries(data_dir: Path, *, codes: list[str], folder_id: str | None) -> None:
    """Move the given codes into folder_id (null = 미분류), appended after the
    target folder's current members. _reindex compacts order to 0..N-1."""
    async with _lock:
        doc = load_document(data_dir)
        if folder_id is not None and not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        base = max((e.order for e in doc.entries if e.folder_id == folder_id), default=-1) + 1
        moving = [c for c in codes]  # preserve caller order for the tail
        new = []
        for e in doc.entries:
            if e.code in moving:
                e = e.model_copy(update={"folder_id": folder_id,
                                         "order": base + moving.index(e.code)})
            new.append(e)
        save_document(data_dir, doc.model_copy(update={"entries": new}))


async def reorder_entries(data_dir: Path, *, folder_id: str | None,
                          ordered_codes: list[str]) -> None:
    """Authoritative reorder within one folder: ordered_codes must be exactly
    the codes currently in folder_id. Server reassigns order = position."""
    async with _lock:
        doc = load_document(data_dir)
        in_folder = {e.code for e in doc.entries if e.folder_id == folder_id}
        if set(ordered_codes) != in_folder:
            raise NotInWatchlistError(
                f"reorder set {ordered_codes} != folder {folder_id} members {in_folder}")
        rank = {c: i for i, c in enumerate(ordered_codes)}
        new = [e.model_copy(update={"order": rank[e.code]}) if e.folder_id == folder_id else e
               for e in doc.entries]
        save_document(data_dir, doc.model_copy(update={"entries": new}))


async def remove_entries(data_dir: Path, *, codes: list[str]) -> None:
    """Bulk remove. Absent codes are ignored (idempotent bulk delete)."""
    async with _lock:
        doc = load_document(data_dir)
        keep = [e for e in doc.entries if e.code not in set(codes)]
        save_document(data_dir, doc.model_copy(update={"entries": keep}))
```

- [ ] **Step 4: 통과 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_folders.py -q` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/watchlist.py tests/test_api_watchlist_folders.py
git commit -m "feat(watchlist): entry move(bulk)/reorder/bulk-remove mutations"
```

---

## Task B5: API routes — folders + move/reorder/bulk + GET folders

**Files:**
- Modify: `hoga/api/watchlist_routes.py`
- Modify: `hoga/api/models.py` (request 모델 추가)
- Test: `tests/test_api_watchlist_routes.py` (append)

- [ ] **Step 1: request 모델 추가** — `hoga/api/models.py` Watchlist 블록 근처에 추가

```python
class FolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class FolderRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class FolderReorderRequest(BaseModel):
    ordered_ids: list[str]


class EntriesMoveRequest(BaseModel):
    codes: list[str]
    folder_id: str | None = None


class EntriesReorderRequest(BaseModel):
    folder_id: str | None = None
    ordered_codes: list[str]


class EntriesRemoveRequest(BaseModel):
    codes: list[str]
```

- [ ] **Step 2: 실패 테스트 작성** — `tests/test_api_watchlist_routes.py`에 append. (기존 파일의 app fixture 패턴을 그대로 사용 — 파일 상단의 client/app 구성 방식을 따른다.)

```python
def test_get_returns_folders_and_entry_folder_id(client, tmp_path_data):
    # create folder, add code, move it, then GET
    fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
    client.post("/api/watchlist", json={"code": "005930"})
    client.post("/api/watchlist/move", json={"codes": ["005930"], "folder_id": fid})
    body = client.get("/api/watchlist").json()
    assert body["folders"][0]["id"] == fid
    assert next(e for e in body["entries"] if e["code"] == "005930")["folder_id"] == fid


def test_folder_crud_routes(client, tmp_path_data):
    fid = client.post("/api/watchlist/folders", json={"name": "A"}).json()["id"]
    assert client.patch(f"/api/watchlist/folders/{fid}", json={"name": "B"}).status_code == 200
    assert client.get("/api/watchlist").json()["folders"][0]["name"] == "B"
    assert client.delete(f"/api/watchlist/folders/{fid}").status_code == 204
    assert client.get("/api/watchlist").json()["folders"] == []


def test_folder_reorder_route(client, tmp_path_data):
    a = client.post("/api/watchlist/folders", json={"name": "A"}).json()["id"]
    b = client.post("/api/watchlist/folders", json={"name": "B"}).json()["id"]
    assert client.put("/api/watchlist/folders/order", json={"ordered_ids": [b, a]}).status_code == 200
    assert [f["name"] for f in client.get("/api/watchlist").json()["folders"]] == ["B", "A"]


def test_reorder_and_bulk_remove_routes(client, tmp_path_data):
    for c in ("005930", "000660"):
        client.post("/api/watchlist", json={"code": c})
    client.put("/api/watchlist/reorder",
               json={"folder_id": None, "ordered_codes": ["000660", "005930"]})
    assert client.post("/api/watchlist/remove",
                       json={"codes": ["005930", "000660"]}).status_code == 200
    assert client.get("/api/watchlist").json()["entries"] == []
```

> 기존 `tests/test_api_watchlist_routes.py`의 fixture 이름(`client`, `tmp_path_data` 등)에 맞춰 인자 시그니처를 조정한다. 파일 상단을 먼저 읽고 동일 패턴 사용.

- [ ] **Step 3: 실패 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_routes.py -q` → FAIL (404 on new routes).

- [ ] **Step 4: 라우트 구현** — `hoga/api/watchlist_routes.py`. GET을 folders 포함으로 바꾸고, import + 신규 라우트 추가.

GET 교체 (53-58):
```python
    @router.get("", response_model=WatchlistResponse)
    async def get_watchlist() -> WatchlistResponse:
        doc = load_document(data_dir)
        return WatchlistResponse(
            folders=doc.folders,
            entries=doc.entries,
            next_run_at_ms=_next_run_at_ms(now_kst()),
        )
```

import 보강 (33-39 블록):
```python
from hoga.api.watchlist import (
    AlreadyInWatchlistError,
    FolderNotFoundError,
    NotInWatchlistError,
    add_entry,
    create_folder,
    delete_folder,
    load_document,
    load_watchlist,
    move_entries,
    remove_entries,
    remove_entry,
    rename_folder,
    reorder_entries,
    reorder_folders,
)
from hoga.api.models import (
    EntriesMoveRequest, EntriesRemoveRequest, EntriesReorderRequest,
    FolderCreateRequest, FolderRenameRequest, FolderReorderRequest,
    WatchlistFolder,
    # ...기존 import 유지...
)
```

신규 라우트 (`return router` 직전에 추가):
```python
    @router.post("/folders", status_code=201, response_model=WatchlistFolder)
    async def create_watchlist_folder(req: FolderCreateRequest) -> WatchlistFolder:
        return await create_folder(data_dir, name=req.name)

    @router.patch("/folders/{folder_id}", status_code=200)
    async def rename_watchlist_folder(folder_id: str, req: FolderRenameRequest) -> dict:
        try:
            await rename_folder(data_dir, folder_id=folder_id, name=req.name)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        return {"ok": True}

    @router.delete("/folders/{folder_id}", status_code=204)
    async def delete_watchlist_folder(folder_id: str) -> None:
        try:
            await delete_folder(data_dir, folder_id=folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e

    @router.put("/folders/order", status_code=200)
    async def reorder_watchlist_folders(req: FolderReorderRequest) -> dict:
        try:
            await reorder_folders(data_dir, ordered_ids=req.ordered_ids)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=409, detail={
                "code": "folder_set_mismatch", "message": str(e)}) from e
        return {"ok": True}

    @router.post("/move", status_code=200)
    async def move_watchlist_entries(req: EntriesMoveRequest) -> dict:
        try:
            await move_entries(data_dir, codes=req.codes, folder_id=req.folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": str(e)}) from e
        return {"ok": True}

    @router.put("/reorder", status_code=200)
    async def reorder_watchlist_entries(req: EntriesReorderRequest) -> dict:
        try:
            await reorder_entries(data_dir, folder_id=req.folder_id,
                                  ordered_codes=req.ordered_codes)
        except NotInWatchlistError as e:
            raise HTTPException(status_code=409, detail={
                "code": "reorder_set_mismatch", "message": str(e)}) from e
        return {"ok": True}

    @router.post("/remove", status_code=200)
    async def bulk_remove_watchlist_entries(req: EntriesRemoveRequest) -> dict:
        await remove_entries(data_dir, codes=req.codes)
        try:
            await refresh_live_poller(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort, mutation already succeeded
            log.exception("watchlist.bulk_remove: refresh_live_poller failed")
        return {"ok": True}
```

> **라우트 충돌 없음**: 기존 `DELETE /{code}`는 `CodePathParam`(`^\d{6}$`) 단일 세그먼트라 `/folders/...`와 절대 매칭되지 않고, `/folders/order`는 PUT 전용이라 `{folder_id}`(PATCH/DELETE) 형제와 메서드가 달라 등록 순서가 무관하다. (가독성상 `/folders/order`를 `{folder_id}` 위에 두는 것은 권장.)

- [ ] **Step 5: 통과 확인** — Run: `uv run --extra dev pytest tests/test_api_watchlist_routes.py -q` → PASS.

- [ ] **Step 6: 커밋**

```bash
git add hoga/api/watchlist_routes.py hoga/api/models.py tests/test_api_watchlist_routes.py
git commit -m "feat(watchlist): folder CRUD + move/reorder/bulk-remove routes; GET returns folders"
```

---

## Task B6: 동시성 회귀 테스트 (lock 직렬화)

**Files:**
- Test: `tests/test_api_watchlist_concurrency.py` (생성)

- [ ] **Step 1: 테스트 작성** — 동시 mutation + bump가 같은 락에서 직렬화되어 folders/entries가 손상되지 않음을 검증.

```python
"""Concurrent watchlist mutation must serialize under the single _lock and
never drop folders or leave dangling folder_id. See ADR-0064, Blocker #1."""
from __future__ import annotations

import asyncio
from pathlib import Path


def test_concurrent_bump_and_move_preserve_folders(tmp_path: Path):
    from hoga.api.watchlist import (create_folder, add_entry, move_entries,
                                    bump_last_success, load_document)

    async def scenario():
        f = await create_folder(tmp_path, name="스윙")
        for c, n in [("005930", "삼성"), ("000660", "SK"), ("035720", "카카오")]:
            await add_entry(tmp_path, code=c, name=n, today_kst_date="20260101")
        # fire many writers concurrently: bumps (Scheduler-like) + moves
        await asyncio.gather(
            bump_last_success(tmp_path, code="005930", date="20260102"),
            move_entries(tmp_path, codes=["005930"], folder_id=f.id),
            bump_last_success(tmp_path, code="000660", date="20260103"),
            move_entries(tmp_path, codes=["000660"], folder_id=f.id),
            bump_last_success(tmp_path, code="035720", date="20260104"),
        )
        return f.id

    fid = asyncio.run(scenario())
    doc = load_document(tmp_path)
    assert doc.folders[0].id == fid            # folder survived all writers
    assert {e.code for e in doc.entries} == {"005930", "000660", "035720"}
    moved = {e.code: e for e in doc.entries}
    assert moved["005930"].folder_id == fid
    assert moved["000660"].folder_id == fid
    assert moved["005930"].last_success_date == "20260102"
    # no dangling folder_id (model_validator would have raised on load)
    valid = {f.id for f in doc.folders} | {None}
    assert all(e.folder_id in valid for e in doc.entries)
    # per-folder order contiguous
    fids = {}
    for e in doc.entries:
        fids.setdefault(e.folder_id, []).append(e.order)
    for orders in fids.values():
        assert sorted(orders) == list(range(len(orders)))
```

- [ ] **Step 2: 실행** — Run: `uv run --extra dev pytest tests/test_api_watchlist_concurrency.py -q` → PASS (락이 직렬화하므로 손상 없음).

- [ ] **Step 3: flake 반복 (stage 6 예고)** — Run: `for i in $(seq 1 10); do uv run --extra dev pytest tests/test_api_watchlist_concurrency.py -q || break; done` → 10/10 PASS.

- [ ] **Step 4: 커밋**

```bash
git add tests/test_api_watchlist_concurrency.py
git commit -m "test(watchlist): concurrent mutation serializes under _lock, folders survive"
```

---

## Task F1: 프론트 API 타입 + 함수 + query-key 상수

**Files:**
- Create: `frontend/src/watchlist/watchlistKeys.ts`
- Modify: `frontend/src/api/watchlist.ts`
- Test: `frontend/src/watchlist/grouping.test.ts` (F3에서; 여기선 타입만)

- [ ] **Step 1: query-key 상수 생성** — `frontend/src/watchlist/watchlistKeys.ts`

```typescript
/** Single source of the watchlist query key — was inlined in WatchlistDrawer
 *  and constant'd in useWatchlist; unify so new mutations don't re-sprinkle it. */
export const WATCHLIST_KEY = ['watchlist'] as const;
```

- [ ] **Step 2: API 타입/함수 확장** — `frontend/src/api/watchlist.ts`. 타입 확장 + mutation 함수 추가.

```typescript
export interface WatchlistFolder {
  id: string;
  name: string;
  order: number;
}

export interface WatchlistEntry {
  code: string;
  name: string;
  registered_at_kst_date: string;  // YYYYMMDD
  last_success_date: string | null;
  folder_id: string | null;        // null = 미분류
  order: number;                   // 0-based, per-folder
}

export interface WatchlistResponse {
  folders: WatchlistFolder[];
  entries: WatchlistEntry[];
  next_run_at_ms: number;
}
```
(기존 `getWatchlist`/`addToWatchlist`/`removeFromWatchlist`/catchup 함수는 유지.) 아래 함수 추가:
```typescript
export function createFolder(name: string): Promise<WatchlistFolder> {
  return apiCall<WatchlistFolder>('/api/watchlist/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
export function renameFolder(folderId: string, name: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
export function deleteFolder(folderId: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}`, { method: 'DELETE' });
}
export function reorderFolders(orderedIds: string[]): Promise<void> {
  return apiAction('/api/watchlist/folders/order', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_ids: orderedIds }),
  });
}
export function moveEntries(codes: string[], folderId: string | null): Promise<void> {
  return apiAction('/api/watchlist/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes, folder_id: folderId }),
  });
}
export function reorderEntries(folderId: string | null, orderedCodes: string[]): Promise<void> {
  return apiAction('/api/watchlist/reorder', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_id: folderId, ordered_codes: orderedCodes }),
  });
}
export function removeEntries(codes: string[]): Promise<void> {
  return apiAction('/api/watchlist/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
}
```

> `apiAction(path, init?: RequestInit)`는 전체 `RequestInit`을 fetch로 그대로 전달하므로 PATCH/PUT + headers + body가 동작한다(client.ts 확인됨 — 별도 조정 불필요).

- [ ] **Step 3: 타입체크 (스코프 제한)** — 전체-프로젝트 `tsc -b`는 **F1~F10 사이엔 빨간 게 정상**(옛 소비처 WatchlistPanel/WatchlistRow/pages/Watchlist + pre-F5 drawer가 옛 타입을 쓰며, F10에서 삭제됨). 따라서 이 단계에선 전체 tsc를 게이트로 쓰지 말 것. 대신 `cd frontend && npx vitest run`이 green이고 `api/watchlist.ts`에 문법/타입 에러가 없음만 확인. **유일한 권위 있는 전체-프로젝트 `tsc -b --noEmit → 0 errors` 게이트는 F10 Step4(`npm run build`)다.**

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/api/watchlist.ts frontend/src/watchlist/watchlistKeys.ts
git commit -m "feat(watchlist): v2 wire types (folders, folder_id, order) + folder/move/reorder API fns"
```

---

## Task F2: mutation 훅 — 폴더 CRUD(invalidate) / 이동·순서(낙관적)

**Files:**
- Modify: `frontend/src/watchlist/useWatchlist.ts`
- Test: `frontend/src/watchlist/useWatchlist.optimistic.test.tsx` (생성)

- [ ] **Step 1: 실패 테스트 작성** — 낙관적 reorder가 invalidate 전에 캐시를 즉시 갱신함을 검증.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WATCHLIST_KEY } from './watchlistKeys';
import { useReorderEntries } from './useWatchlist';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useReorderEntries (optimistic)', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('reorders the cached entries before the request resolves', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(WATCHLIST_KEY, {
      folders: [], next_run_at_ms: 0,
      entries: [
        { code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
        { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 1 },
      ],
    });
    let resolve!: () => void;
    vi.spyOn(api, 'reorderEntries').mockReturnValue(new Promise<void>((r) => { resolve = () => r(); }));
    const { result } = renderHook(() => useReorderEntries(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: null, orderedCodes: ['000660', '005930'] });
    await waitFor(() => {
      const data = qc.getQueryData(WATCHLIST_KEY) as api.WatchlistResponse;
      const byOrder = [...data.entries].sort((a, b) => a.order - b.order);
      expect(byOrder.map((e) => e.code)).toEqual(['000660', '005930']);
    });
    resolve();
  });

  it('rolls back the optimistic cache when the request rejects', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(WATCHLIST_KEY, {
      folders: [], next_run_at_ms: 0,
      entries: [
        { code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
        { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 1 },
      ],
    });
    vi.spyOn(api, 'reorderEntries').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useReorderEntries(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: null, orderedCodes: ['000660', '005930'] });
    // optimistic flips to 000660,005930 then onError restores ctx.prev (005930,000660)
    await waitFor(() => {
      const data = qc.getQueryData(WATCHLIST_KEY) as api.WatchlistResponse;
      expect([...data.entries].sort((a, b) => a.order - b.order).map((e) => e.code)).toEqual(['005930', '000660']);
    });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/watchlist/useWatchlist.optimistic.test.tsx` → FAIL (`useReorderEntries` 미정).

- [ ] **Step 3: 훅 구현** — `frontend/src/watchlist/useWatchlist.ts`. `KEY` 상수를 `WATCHLIST_KEY` import로 교체하고, 신규 훅 추가.

```typescript
import { WATCHLIST_KEY } from './watchlistKeys';
import {
  // 기존 + 신규:
  createFolder, renameFolder, deleteFolder, reorderFolders,
  moveEntries, reorderEntries, removeEntries,
  type WatchlistResponse, type WatchlistEntry,
} from '../api/watchlist';

// 기존 KEY 상수 선언 줄 삭제, 모든 KEY → WATCHLIST_KEY.

// --- folder CRUD: invalidate-only (consistent with add/remove) ---
export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createFolder(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
export function useRenameFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { folderId: string; name: string }) => renameFolder(v.folderId, v.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => deleteFolder(folderId),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

// --- move / reorder: optimistic + rollback (DnD smoothness) ---
type ReorderVars = { folderId: string | null; orderedCodes: string[] };
type MoveVars = { codes: string[]; folderId: string | null };

// no-jump invariant: 서버가 target 그룹을 0..N-1로 compact 유지하므로(_reindex), 아래 낙관적
// order는 invalidate 후 서버 값과 같은 *상대순서*에 안착 → 화면 jump 없음. 렌더는 .order로
// 정렬하므로 절대값 차이는 무해. (이 불변식이 깨지면 낙관적 업데이트가 깜빡일 수 있으니 유지.)
function applyReorder(data: WatchlistResponse, v: ReorderVars): WatchlistResponse {
  const rank = new Map(v.orderedCodes.map((c, i) => [c, i] as const));
  return {
    ...data,
    entries: data.entries.map((e) =>
      e.folder_id === v.folderId && rank.has(e.code)
        ? { ...e, order: rank.get(e.code)! } : e),
  };
}
function applyMove(data: WatchlistResponse, v: MoveVars): WatchlistResponse {
  const base = Math.max(-1, ...data.entries.filter((e) => e.folder_id === v.folderId).map((e) => e.order)) + 1;
  const set = new Set(v.codes);
  return {
    ...data,
    entries: data.entries.map((e) =>
      set.has(e.code) ? { ...e, folder_id: v.folderId, order: base + v.codes.indexOf(e.code) } : e),
  };
}

function optimistic<V>(apply: (d: WatchlistResponse, v: V) => WatchlistResponse, fn: (v: V) => Promise<void>) {
  return { apply, fn };
}

function useOptimisticEntryMutation<V>(
  mutationFn: (v: V) => Promise<void>,
  apply: (d: WatchlistResponse, v: V) => WatchlistResponse,
) {
  const qc = useQueryClient();
  return useMutation<void, Error, V, { prev?: WatchlistResponse }>({
    mutationFn,
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: WATCHLIST_KEY });
      const prev = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY);
      if (prev) qc.setQueryData(WATCHLIST_KEY, apply(prev, v));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(WATCHLIST_KEY, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

export function useReorderEntries() {
  return useOptimisticEntryMutation<ReorderVars>(
    (v) => reorderEntries(v.folderId, v.orderedCodes), applyReorder);
}
export function useMoveEntries() {
  return useOptimisticEntryMutation<MoveVars>(
    (v) => moveEntries(v.codes, v.folderId), applyMove);
}
export function useReorderFolders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => reorderFolders(orderedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
export function useRemoveEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (codes: string[]) => removeEntries(codes),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
```
(미사용 `optimistic` 헬퍼는 넣지 말 것 — 위 스니펫의 `optimistic` 함수 정의는 제거하고 `useOptimisticEntryMutation`만 사용.)

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/watchlist/useWatchlist.optimistic.test.tsx` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/useWatchlist.ts frontend/src/watchlist/useWatchlist.optimistic.test.tsx frontend/src/watchlist/watchlistKeys.ts
git commit -m "feat(watchlist): folder-CRUD (invalidate) + move/reorder (optimistic) hooks"
```

---

## Task F3: 순수 폴더 그룹핑 util

**Files:**
- Create: `frontend/src/watchlist/grouping.ts`
- Test: `frontend/src/watchlist/grouping.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/watchlist/grouping.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { groupByFolder } from './grouping';
import type { WatchlistFolder, WatchlistEntry } from '../api/watchlist';

const folders: WatchlistFolder[] = [
  { id: 'f_b', name: '스윙', order: 1 },
  { id: 'f_a', name: '장기', order: 0 },
];
const entries: WatchlistEntry[] = [
  { code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 1 },
  { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 0 },
  { code: '035720', name: '카카오', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
];

describe('groupByFolder', () => {
  it('orders folders by .order and 미분류 last; sorts entries by .order; 미분류 is a render group, not a synthetic folder', () => {
    const groups = groupByFolder(folders, entries);
    expect(groups.map((g) => g.folder?.name ?? '미분류')).toEqual(['장기', '스윙', '미분류']);
    const swing = groups.find((g) => g.folder?.id === 'f_b')!;
    expect(swing.entries.map((e) => e.code)).toEqual(['000660', '005930']);  // by order
    const uncat = groups.find((g) => g.folder === null)!;
    expect(uncat.folder).toBeNull();           // null, NOT a {id:'uncategorized'} object
    expect(uncat.entries.map((e) => e.code)).toEqual(['035720']);
  });
  it('includes empty folders', () => {
    const groups = groupByFolder([{ id: 'f_x', name: '빈', order: 0 }], []);
    expect(groups.map((g) => g.folder?.name ?? '미분류')).toEqual(['빈', '미분류']);
    expect(groups[0].entries).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/watchlist/grouping.test.ts` → FAIL.

- [ ] **Step 3: 구현** — `frontend/src/watchlist/grouping.ts`

```typescript
import type { WatchlistFolder, WatchlistEntry } from '../api/watchlist';

export interface FolderGroup {
  /** null = 미분류 (a render-only group; NOT a synthetic folder object — ADR-0004) */
  folder: WatchlistFolder | null;
  entries: WatchlistEntry[];
}

/** Group entries by folder for display. Folders sorted by `.order`; 미분류
 *  (folder_id===null) always last. Entries within a group sorted by `.order`.
 *  Empty folders are included. Pure — no fetch, no synthetic objects. */
export function groupByFolder(
  folders: WatchlistFolder[],
  entries: WatchlistEntry[],
): FolderGroup[] {
  const sortedFolders = [...folders].sort((a, b) => a.order - b.order);
  const byOrder = (a: WatchlistEntry, b: WatchlistEntry) => a.order - b.order;
  const groups: FolderGroup[] = sortedFolders.map((folder) => ({
    folder,
    entries: entries.filter((e) => e.folder_id === folder.id).sort(byOrder),
  }));
  groups.push({
    folder: null,
    entries: entries.filter((e) => e.folder_id === null).sort(byOrder),
  });
  return groups;
}
```

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/watchlist/grouping.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/grouping.ts frontend/src/watchlist/grouping.test.ts
git commit -m "feat(watchlist): pure groupByFolder util (미분류 = null render group)"
```

---

## Task F4: 공용 조각 추출 — Banner / useWatchlistFeedback / WatchlistAddForm / rowFormat

**Files:**
- Create: `frontend/src/watchlist/Banner.tsx`, `useWatchlistFeedback.ts`, `WatchlistAddForm.tsx`, `rowFormat.tsx`
- Test: `frontend/src/watchlist/WatchlistAddForm.test.tsx`

> 이 조각들은 삭제될 `WatchlistPanel.tsx`(23-61, 67-77, 175-190) 인라인 코드의 단일-소유자 추출이다. drawer 푸터와 Modal이 공유한다.

- [ ] **Step 1: Banner 추출** — `frontend/src/watchlist/Banner.tsx` (WatchlistPanel.tsx:25-36 그대로 이전)

```tsx
const BANNER_CLASS = {
  success: 'bg-tint-success border-tint-success-border text-success',
  error: 'bg-tint-error border-tint-error-border text-error',
} as const;

export function Banner({ kind, children }: { kind: 'success' | 'error'; children: React.ReactNode }) {
  return (
    <div className={`px-3 py-2 rounded border text-sm ${BANNER_CLASS[kind]}`}>
      {children}
    </div>
  );
}
```
(여백 `mx-6 mt-3`는 소비처에서 래퍼로 부여 — 추출된 컴포넌트는 위치 중립.)

- [ ] **Step 2: useWatchlistFeedback 추출** — `frontend/src/watchlist/useWatchlistFeedback.ts` (RecentAction + 5s 타이머)

```typescript
import { useEffect, useState } from 'react';
import type { ManualCatchupAllResponse } from '../api/watchlist';

const JUST_ADDED_MS = 5000;

export type RecentAction =
  | { kind: 'added';         code: string; name: string }
  | { kind: 'caught_up_one'; code: string; name: string; enqueued: number; deduped: number; error?: string }
  | { kind: 'caught_up_all'; summary: ManualCatchupAllResponse['results'] };

/** Single owner of the add/catch-up success/failure feedback + its 5s auto-clear.
 *  Shared by the panel footer and the edit modal (was inline in WatchlistPanel). */
export function useWatchlistFeedback() {
  const [recentAction, setRecentAction] = useState<RecentAction | null>(null);
  useEffect(() => {
    if (!recentAction) return;
    const id = setTimeout(() => setRecentAction(null), JUST_ADDED_MS);
    return () => clearTimeout(id);
  }, [recentAction]);
  return { recentAction, setRecentAction };
}
```

- [ ] **Step 3: rowFormat 추출** — `frontend/src/watchlist/rowFormat.tsx` (WatchlistRow.tsx:3-5 + 35-39 마지막성공일 배지)

```tsx
export function fmtDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

export function LastSuccessBadge({ date }: { date: string | null }) {
  return (
    <span className="font-mono text-xs">
      {date
        ? <span className="text-success">{fmtDate(date)}</span>
        : <span className="text-fg-dimmer italic">아직 없음</span>}
    </span>
  );
}
```

- [ ] **Step 4: WatchlistAddForm 테스트 작성** — `frontend/src/watchlist/WatchlistAddForm.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WatchlistAddForm } from './WatchlistAddForm';

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: any) => void }) => (
    <button onClick={() => onChange({ code: '005930', name: '삼성전자' })}>pick</button>
  ),
}));

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('WatchlistAddForm', () => {
  beforeEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('adds the picked code and fires onAdded', async () => {
    const add = vi.spyOn(api, 'addToWatchlist').mockResolvedValue({
      code: '005930', name: '삼성전자', registered_at_kst_date: '20260101',
      last_success_date: null, folder_id: null, order: 0 });
    const onAdded = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistAddForm onAdded={onAdded} />, { wrapper: wrap(qc) });
    fireEvent.click(screen.getByText('pick'));
    fireEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('005930'));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ code: '005930', name: '삼성전자' }));
  });
});
```

- [ ] **Step 5: 실패 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistAddForm.test.tsx` → FAIL.

- [ ] **Step 6: WatchlistAddForm 구현** — `frontend/src/watchlist/WatchlistAddForm.tsx` (WatchlistPanel.tsx의 picked+submit+409(addM.error) 로직 단일 소유자)

```tsx
import { useState } from 'react';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddToWatchlist } from './useWatchlist';
import { Banner } from './Banner';

/** Shared add-form: SymbolSearch + submit + 409 already_in_watchlist banner.
 *  onAdded fires after a successful add (caller drives feedback/highlight). */
export function WatchlistAddForm({ onAdded }: { onAdded: (hit: { code: string; name: string }) => void }) {
  const addM = useAddToWatchlist();
  const [picked, setPicked] = useState<SymbolHit | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    try {
      await addM.mutateAsync(picked.code);
      onAdded({ code: picked.code, name: picked.name });
      setPicked(null);
    } catch {
      /* surfaces via addM.error */
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex gap-2 items-center">
        <div className="flex-1"><SymbolSearch value={picked} onChange={setPicked} /></div>
        <button type="submit" disabled={addM.isPending || picked === null}
                className="px-3 py-1.5 rounded bg-accent text-bg text-sm font-medium disabled:opacity-40">
          ＋ 종목 추가
        </button>
      </form>
      {addM.error && <Banner kind="error">{(addM.error as Error).message}</Banner>}
    </div>
  );
}
```

- [ ] **Step 7: 통과 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistAddForm.test.tsx` → PASS.

- [ ] **Step 8: 커밋**

```bash
git add frontend/src/watchlist/Banner.tsx frontend/src/watchlist/useWatchlistFeedback.ts frontend/src/watchlist/rowFormat.tsx frontend/src/watchlist/WatchlistAddForm.tsx frontend/src/watchlist/WatchlistAddForm.test.tsx
git commit -m "refactor(watchlist): extract Banner, useWatchlistFeedback, rowFormat, WatchlistAddForm (single owners)"
```

---

## Task F5: WatchlistDrawer 재작성 — 폴더 그룹 + 푸터 + 편집 버튼

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx` (기존 + 신규 케이스)

- [ ] **Step 0: 기존 mock을 v2 shape로 (필수 — 안 하면 TS+런타임 크래시)**
  - `WatchlistDrawer.test.tsx`의 `ENTRIES` 각 항목에 `folder_id: null, order: i` 추가.
  - **기존 5개 `getWatchlist` mock 모두에 `folders: []` 추가** (현재 `{ entries, next_run_at_ms }`만 반환 → `folders`가 required라 TS 에러 + `groupByFolder([...undefined])` 런타임 크래시). guard: `grep -n "next_run_at_ms" frontend/src/watchlist/WatchlistDrawer.test.tsx` 의 모든 매치에 `folders:`가 함께 있어야 함.
  - `frontend/src/api/watchlist.test.ts:23`의 `const fake: WatchlistResponse = { entries: [], next_run_at_ms: 0 }` 에도 `folders: []` 추가(F10이 삭제하지 않는 파일 — F1이 `folders`를 required로 만든 뒤 TS 깨짐). guard: `grep -rn "next_run_at_ms" frontend/src | grep -v "folders"` → 빈 출력.

- [ ] **Step 1: 신규 테스트 작성** — 폴더 그룹 + 편집 버튼 케이스 추가.

```tsx
// ENTRIES 갱신: 각 항목에 folder_id: null, order: i 추가.
it('renders folder groups with member counts and 미분류 last', async () => {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
    folders: [{ id: 'f_a', name: '스윙', order: 0 }],
    entries: [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
      { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
    ],
    next_run_at_ms: 0,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
  await waitFor(() => expect(screen.getByText('스윙')).toBeInTheDocument());
  expect(screen.getByText('미분류')).toBeInTheDocument();
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
});

it('opens the edit modal when 편집 is clicked', async () => {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ folders: [], entries: [], next_run_at_ms: 0 });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
  await waitFor(() => expect(screen.getByLabelText('관심종목 편집 열기')).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('관심종목 편집 열기'));
  expect(await screen.findByRole('dialog', { name: '관심 종목 편집' })).toBeInTheDocument();
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx` → FAIL.

- [ ] **Step 3: Drawer 재작성** — `frontend/src/watchlist/WatchlistDrawer.tsx`. 폴더 그룹(접기/펴기) + 헤더(`관심종목` 라벨 + `편집` 버튼 + **공용 `WatchlistAddForm` 빠른 추가** — spec:111/grill:166 준수, 'added' Banner 렌더) + 푸터(Countdown + 전체 수집) + 편집 버튼(Modal 토글). 행 클릭=차트 점프 유지. `useState`로 collapse 상태 + editOpen.

```tsx
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useLivePageStore } from '../state/livePage';
import { useWatchlist, useCatchupAll } from './useWatchlist';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { groupByFolder } from './grouping';
import { Countdown } from './Countdown';
import { Banner } from './Banner';
import { WatchlistAddForm } from './WatchlistAddForm';
import { symbolLabel, summarizeCaughtUpAll, formatCaughtUpAllHeader } from './banners';
import { WatchlistEditModal } from './WatchlistEditModal';
import type { WatchlistEntry } from '../api/watchlist';

export function WatchlistDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data, isLoading, error } = useWatchlist();
  const catchupAllM = useCatchupAll();
  const { recentAction, setRecentAction } = useWatchlistFeedback();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editOpen, setEditOpen] = useState(false);

  const onPick = (code: string) => {
    setActiveCode(code);
    if (pathname !== '/live') navigate('/live');
  };
  const toggle = (key: string) =>
    setCollapsed((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const groups = data ? groupByFolder(data.folders, data.entries) : [];

  return (
    <div id="right-rail-watchlist-panel" data-testid="watchlist-panel"
      style={{ width: 'var(--watchlist-panel-w)', height: '100%', background: 'var(--bg-card)',
               borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ borderBottom: '1px solid var(--border)' }}>
        <div style={{ padding: 'var(--space-sm) var(--space-md)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-dim)', fontFamily: 'monospace',
                         textTransform: 'uppercase', letterSpacing: '0.08em' }}>관심종목</span>
          <button type="button" aria-label="관심종목 편집 열기" onClick={() => setEditOpen(true)}
                  className="text-fg-dim hover:text-accent text-xs">편집</button>
        </div>
        {/* 빠른 추가 — spec:111 / grill:166: drawer 헤더와 Modal 툴바가 같은 WatchlistAddForm 공유 */}
        <div style={{ padding: '0 var(--space-md) var(--space-sm)' }}>
          <WatchlistAddForm onAdded={(hit) => setRecentAction({ kind: 'added', code: hit.code, name: hit.name })} />
        </div>
        {recentAction?.kind === 'added' && (
          <div className="mx-3 mb-2"><Banner kind="success">{`✓ ${symbolLabel(recentAction)} 추가됨`}</Banner></div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {isLoading && <div className="p-3 text-fg-dimmer text-sm">불러오는 중</div>}
        {error && <div className="p-3 text-error text-sm">관심종목을 불러올 수 없습니다</div>}
        {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0 && (
          <div className="p-3 text-fg-dimmer text-sm">관심종목이 없습니다</div>
        )}
        {groups.map((g) => {
          const key = g.folder?.id ?? '__uncat__';
          const label = g.folder?.name ?? '미분류';
          if (g.entries.length === 0 && g.folder === null) return null; // 빈 미분류는 숨김
          const isCollapsed = collapsed.has(key);
          return (
            <div key={key}>
              <button type="button" onClick={() => toggle(key)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-fg-dim hover:bg-bg-input-hover">
                <span>{isCollapsed ? '▸' : '▾'} {label}</span>
                <span className="font-mono tabular-nums text-fg-dimmer">{g.entries.length}</span>
              </button>
              {!isCollapsed && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {g.entries.map((entry) => (
                    <DrawerRow key={entry.code} entry={entry}
                      active={entry.code === activeCode} onClick={() => onPick(entry.code)} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {recentAction?.kind === 'caught_up_all' && (
        <div className="px-3 py-2 border-t border-border">
          <Banner kind="success">{formatCaughtUpAllHeader(summarizeCaughtUpAll(recentAction.summary))}</Banner>
        </div>
      )}
      <div style={{ borderTop: '1px solid var(--border)', padding: 'var(--space-sm) var(--space-md)' }}
           className="text-xs text-fg-dim flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">다음 수집{' '}
          {data && <span className="text-accent"><Countdown targetMs={data.next_run_at_ms} /></span>}</span>
        <button type="button"
          onClick={() => catchupAllM.mutate(undefined, {
            onSuccess: (r) => setRecentAction({ kind: 'caught_up_all', summary: r.results }),
          })}
          disabled={catchupAllM.isPending || (data?.entries.length ?? 0) === 0}
          className="px-2 py-0.5 rounded border border-border hover:text-accent hover:border-accent disabled:opacity-40">
          {/* spin only the glyph, not the text label (DESIGN.md motion) */}
          <span className={`inline-block ${catchupAllM.isPending ? 'animate-spin' : ''}`}>↻</span> 전체 수집
        </button>
      </div>

      {editOpen && <WatchlistEditModal onClose={() => setEditOpen(false)} />}
    </div>
  );
}

function DrawerRow({ entry, active, onClick }: { entry: WatchlistEntry; active: boolean; onClick: () => void }) {
  return (
    <li data-testid={`watchlist-row-${entry.code}`} aria-current={active ? 'true' : undefined} onClick={onClick}
      style={{ cursor: 'pointer', padding: 'var(--space-xs) var(--space-md)', paddingLeft: 'var(--space-lg)',
               background: active ? 'var(--tint-selection)' : 'transparent',
               borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
               display: 'flex', flexDirection: 'column', gap: 'var(--space-2xs)' }}>
      <span style={{ fontFamily: 'monospace', color: 'var(--fg-dim)', fontSize: 'var(--text-xs)' }}>{entry.code}</span>
      <span style={{ color: 'var(--fg)', fontSize: 'var(--text-sm)' }}>{entry.name}</span>
    </li>
  );
}
```

> WatchlistEditModal은 F6에서 생성하므로, F5와 F6은 **순서상 F6을 먼저** 구현하거나, F5 Step3에서 모달 import를 stub로 두지 말 것 — stage-5에서 F6-F9를 F5보다 먼저 실행하도록 DAG에 반영(아래 self-review 참조). 단일-세션 실행이면 F6→F9→F5 순서로.

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat(watchlist): folder-grouped drawer + footer (countdown/전체수집) + 편집 launcher"
```

---

## Task F6: WatchlistEditModal — shell + 좌측 폴더 pane

> **전제(DAG): F7(WatchlistEntryPane)을 먼저 구현**한다. 이 shell이 `./WatchlistEntryPane`을 실제로 import하므로(F6 depends_on F7), F7이 없으면 빌드/테스트가 module-not-found로 깨진다. stub 임시방편 쓰지 말 것 — F7이 실재 모듈로 먼저 존재해야 한다.

**Files:**
- Create: `frontend/src/watchlist/WatchlistEditModal.tsx`
- Test: `frontend/src/watchlist/WatchlistEditModal.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WatchlistEditModal } from './WatchlistEditModal';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const DATA = {
  folders: [{ id: 'f_a', name: '스윙', order: 0 }],
  entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 }],
  next_run_at_ms: 0,
};

describe('WatchlistEditModal', () => {
  beforeEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('renders dialog with folder list + member counts, and a 전체 pseudo-folder labelled 모든 종목', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    expect(await screen.findByRole('dialog', { name: '관심 종목 편집' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('스윙')).toBeInTheDocument());
    expect(screen.getByText('모든 종목')).toBeInTheDocument();
  });
  it('creates a folder via 폴더 추가', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const create = vi.spyOn(api, 'createFolder').mockResolvedValue({ id: 'f_new', name: '장기', order: 1 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    fireEvent.click(screen.getByRole('button', { name: /폴더 추가/ }));
    fireEvent.change(screen.getByPlaceholderText('폴더 이름'), { target: { value: '장기' } });
    fireEvent.submit(screen.getByTestId('folder-create-form'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('장기'));
  });
  it('closes on Escape and backdrop click', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={onClose} />, { wrapper: wrap(qc) });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistEditModal.test.tsx` → FAIL (`WatchlistEditModal` 미생성; F7은 이미 존재하므로 import는 깨지지 않음).

- [ ] **Step 3: Modal shell + 폴더 pane 구현** — `frontend/src/watchlist/WatchlistEditModal.tsx`. backdrop/Escape는 LiveSettingsModal 패턴. 우측 entry pane은 placeholder div(F7에서 채움). 좌측 폴더 pane: `모든 종목` pseudo + 폴더들 + 미분류 + `폴더 추가` 폼.

```tsx
import { useEffect, useState } from 'react';
import { useWatchlist, useCreateFolder } from './useWatchlist';
import { WatchlistEntryPane } from './WatchlistEntryPane';

/** ALL = 전체(pseudo-folder), null = 미분류, string = folder id. */
type Selected = 'ALL' | null | string;

export function WatchlistEditModal({ onClose }: { onClose: () => void }) {
  const { data } = useWatchlist();
  const createM = useCreateFolder();
  const [selected, setSelected] = useState<Selected>('ALL');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const folders = [...(data?.folders ?? [])].sort((a, b) => a.order - b.order);
  const countIn = (id: string | null) => (data?.entries ?? []).filter((e) => e.folder_id === id).length;

  const submitFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await createM.mutateAsync(newName.trim());
    setNewName(''); setAdding(false);
  };

  const FolderButton = ({ sel, label, count }: { sel: Selected; label: string; count: number | null }) => (
    <button type="button" onClick={() => setSelected(sel)}
      className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm ${
        selected === sel ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input-hover'}`}>
      <span className="truncate">{label}</span>
      {count !== null && <span className="font-mono tabular-nums text-fg-dimmer text-xs">{count}</span>}
    </button>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label="관심 종목 편집" onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[860px] max-w-[92vw] h-[600px] max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">관심 종목 편집</h2>
          <button type="button" aria-label="닫기" onClick={onClose} className="text-fg-dim hover:text-fg text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 grid grid-cols-[220px_1fr] min-h-0">
          {/* 좌: 폴더 pane */}
          <div className="border-r border-border flex flex-col min-h-0">
            <div className="p-2">
              {adding ? (
                <form data-testid="folder-create-form" onSubmit={submitFolder} className="flex gap-1">
                  <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="폴더 이름" maxLength={40}
                    className="flex-1 min-w-0 px-2 py-1 rounded bg-bg-input text-sm border border-border" />
                  <button type="submit" className="px-2 rounded bg-accent text-bg text-sm">추가</button>
                </form>
              ) : (
                <button type="button" onClick={() => setAdding(true)}
                  className="w-full px-3 py-2 rounded border border-border text-sm text-fg-dim hover:text-accent hover:border-accent">
                  ＋ 폴더 추가
                </button>
              )}
            </div>
            <div className="flex-1 overflow-auto px-2 pb-2 flex flex-col gap-px">
              <FolderButton sel="ALL" label="모든 종목" count={data?.entries.length ?? 0} />
              {folders.map((f) => <FolderButton key={f.id} sel={f.id} label={f.name} count={countIn(f.id)} />)}
              <FolderButton sel={null} label="미분류" count={countIn(null)} />
            </div>
          </div>

          {/* 우: entry pane (F7) */}
          <WatchlistEntryPane selected={selected} />
        </div>
      </div>
    </div>
  );
}
```

> `WatchlistEntryPane`은 **F7에서 이미 생성**되어 있다(DAG: F6 depends_on F7). 이 import는 실재 모듈을 가리킨다 — stub 불필요.

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistEditModal.test.tsx` → shell 3개 테스트 PASS (F7 EntryPane 실재하므로 import 깨짐 없음).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/WatchlistEditModal.tsx frontend/src/watchlist/WatchlistEditModal.test.tsx
git commit -m "feat(watchlist): edit modal shell + folder pane (모든 종목/folders/미분류, 폴더 추가)"
```

---

## Task F7: WatchlistEntryPane — 종목 목록 + 툴바(추가/전체선택/일괄 이동·삭제)

**Files:**
- Create: `frontend/src/watchlist/WatchlistEntryPane.tsx`
- Test: `frontend/src/watchlist/WatchlistEntryPane.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WatchlistEntryPane } from './WatchlistEntryPane';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const DATA = {
  folders: [{ id: 'f_a', name: '스윙', order: 0 }],
  entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: '20260102', folder_id: 'f_a', order: 0 },
    { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
  ],
  next_run_at_ms: 0,
};

describe('WatchlistEntryPane', () => {
  beforeEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows only the selected folder entries (미분류)', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected={null} />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.queryByText('삼성전자')).not.toBeInTheDocument();
  });

  it('bulk-deletes checked rows', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const rm = vi.spyOn(api, 'removeEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="ALL" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: /삭제/ }));
    await waitFor(() => expect(rm).toHaveBeenCalledWith(['005930']));
  });

  it('bulk-moves checked rows to a chosen folder', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const mv = vi.spyOn(api, 'moveEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected={null} />, { wrapper: wrap(qc) });
    await screen.findByText('SK하이닉스');
    fireEvent.click(screen.getByLabelText('000660 선택'));
    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '스윙' }));
    await waitFor(() => expect(mv).toHaveBeenCalledWith(['000660'], 'f_a'));
  });

  it('per-row ↻ triggers catch-up and shows a result banner', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const c = vi.spyOn(api, 'catchupNow').mockResolvedValue({ enqueued: ['x'], deduped: [] } as any);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="ALL" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('삼성전자 수집'));
    await waitFor(() => expect(c).toHaveBeenCalledWith('005930'));
    await waitFor(() => expect(screen.getByText(/삼성전자/)).toBeInTheDocument());  // banner rendered
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistEntryPane.test.tsx` → FAIL.

- [ ] **Step 3: 구현** — `frontend/src/watchlist/WatchlistEntryPane.tsx`. 선택된 폴더(ALL=전체)의 종목, 툴바(전체선택·이동·삭제·종목추가), 다중선택 체크박스, 행(코드·이름·마지막성공일). DnD는 F8에서 덧붙임.

```tsx
import { useMemo, useState } from 'react';
import { useWatchlist, useRemoveEntries, useMoveEntries, useCatchupOne } from './useWatchlist';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { WatchlistAddForm } from './WatchlistAddForm';
import { Banner } from './Banner';
import { LastSuccessBadge } from './rowFormat';
import { formatCaughtUpOneMessage, symbolLabel } from './banners';
import type { WatchlistEntry } from '../api/watchlist';

type Selected = 'ALL' | null | string;

export function WatchlistEntryPane({ selected }: { selected: Selected }) {
  const { data } = useWatchlist();
  const removeM = useRemoveEntries();
  const moveM = useMoveEntries();
  const catchupOneM = useCatchupOne();
  const { recentAction, setRecentAction } = useWatchlistFeedback();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [moveMenu, setMoveMenu] = useState(false);

  const onCatchup = (code: string, name: string) =>
    catchupOneM.mutate(code, {
      onSuccess: (r) => setRecentAction({ kind: 'caught_up_one', code, name,
        enqueued: r.enqueued.length, deduped: r.deduped.length }),
      onError: (err) => setRecentAction({ kind: 'caught_up_one', code, name,
        enqueued: 0, deduped: 0, error: (err as Error).message }),
    });

  const entries = useMemo(() => {
    const all = data?.entries ?? [];
    const list = selected === 'ALL' ? all : all.filter((e) => e.folder_id === selected);
    return [...list].sort((a, b) => a.order - b.order);
  }, [data, selected]);

  const folders = [...(data?.folders ?? [])].sort((a, b) => a.order - b.order);
  const allChecked = entries.length > 0 && entries.every((e) => checked.has(e.code));
  const toggle = (code: string) =>
    setChecked((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });
  const toggleAll = () =>
    setChecked(allChecked ? new Set() : new Set(entries.map((e) => e.code)));
  const selectedCodes = [...checked].filter((c) => entries.some((e) => e.code === c));

  const doMove = async (folderId: string | null) => {
    await moveM.mutateAsync({ codes: selectedCodes, folderId });
    setChecked(new Set()); setMoveMenu(false);
  };
  const doDelete = async () => {
    await removeM.mutateAsync(selectedCodes);
    setChecked(new Set());
  };

  return (
    <div className="flex flex-col min-h-0">
      {/* 툴바 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <input type="checkbox" aria-label="전체 선택" checked={allChecked} onChange={toggleAll} />
        <div className="relative">
          <button type="button" disabled={selectedCodes.length === 0} onClick={() => setMoveMenu((v) => !v)}
            className="px-2 py-1 rounded border border-border text-xs text-fg-dim hover:text-accent disabled:opacity-40">⇄ 이동</button>
          {moveMenu && (
            <div role="menu" className="absolute z-10 mt-1 bg-bg-card border border-border rounded shadow-lg min-w-[140px]">
              {folders.map((f) => (
                <button key={f.id} role="menuitem" onClick={() => doMove(f.id)}
                  className="block w-full text-left px-3 py-1.5 text-sm hover:bg-bg-input-hover">{f.name}</button>
              ))}
              <button role="menuitem" onClick={() => doMove(null)}
                className="block w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:bg-bg-input-hover">미분류</button>
            </div>
          )}
        </div>
        <button type="button" disabled={selectedCodes.length === 0} onClick={doDelete}
          className="px-2 py-1 rounded border border-border text-xs text-fg-dim hover:text-error disabled:opacity-40">🗑 삭제</button>
        <div className="flex-1" />
        <span className="text-xs text-fg-dimmer">직접 설정한 순</span>
      </div>

      {/* add form */}
      <div className="px-3 py-2 border-b border-border">
        <WatchlistAddForm onAdded={(hit) => setRecentAction({ kind: 'added', code: hit.code, name: hit.name })} />
      </div>

      {/* feedback banner (added / caught_up_one) — modal owns this feedback instance */}
      {recentAction?.kind === 'added' && (
        <div className="mx-3 mt-2"><Banner kind="success">{`✓ ${symbolLabel(recentAction)} 추가됨`}</Banner></div>
      )}
      {recentAction?.kind === 'caught_up_one' && (
        <div className="mx-3 mt-2">
          <Banner kind={recentAction.error ? 'error' : 'success'}>{formatCaughtUpOneMessage(recentAction)}</Banner>
        </div>
      )}

      {/* list */}
      <ul className="flex-1 overflow-auto" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {entries.map((e) => (
          <EntryRow key={e.code} entry={e} checked={checked.has(e.code)} onToggle={() => toggle(e.code)}
            onCatchup={() => onCatchup(e.code, e.name)}
            catchingUp={catchupOneM.isPending && catchupOneM.variables === e.code} />
        ))}
        {entries.length === 0 && <li className="p-4 text-sm text-fg-dimmer">이 폴더에 종목이 없습니다</li>}
      </ul>
    </div>
  );
}

function EntryRow({ entry, checked, onToggle, onCatchup, catchingUp }: {
  entry: WatchlistEntry; checked: boolean; onToggle: () => void;
  onCatchup: () => void; catchingUp: boolean;
}) {
  return (
    <li data-testid={`edit-row-${entry.code}`}
      className="grid grid-cols-[2ch_1ch_6ch_1fr_8ch_2.5ch] items-center gap-2 px-3 py-2 border-b border-border text-sm hover:bg-bg-input">
      <input type="checkbox" aria-label={`${entry.code} 선택`} checked={checked} onChange={onToggle} />
      <span className="text-fg-dimmer cursor-grab select-none" aria-hidden>⠿</span>
      <span className="font-mono text-fg-dim text-xs">{entry.code}</span>
      <span className="truncate">{entry.name}</span>
      <LastSuccessBadge date={entry.last_success_date} />
      <button type="button" aria-label={`${entry.name} 수집`} onClick={onCatchup} disabled={catchingUp}
        className={`text-fg-dimmer hover:text-accent disabled:opacity-40 ${catchingUp ? 'animate-spin' : ''}`}>↻</button>
    </li>
  );
}
```

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistEntryPane.test.tsx src/watchlist/WatchlistEditModal.test.tsx` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/WatchlistEntryPane.tsx frontend/src/watchlist/WatchlistEntryPane.test.tsx
git commit -m "feat(watchlist): entry pane — list + toolbar (전체선택/일괄 이동·삭제/종목 추가)"
```

---

## Task F8: dnd-kit — 폴더 내 순서변경 + 폴더로 드래그 이동

**Files:**
- Modify: `frontend/src/watchlist/WatchlistEntryPane.tsx` (sortable rows)
- Modify: `frontend/src/watchlist/WatchlistEditModal.tsx` (folder droppables + DndContext)
- Test: `frontend/src/watchlist/WatchlistEntryPane.test.tsx` (reorder 케이스 — onDragEnd 핸들러를 직접 호출하는 단위 테스트)

> dnd-kit의 실제 포인터 드래그는 jsdom에서 시뮬레이트하기 어렵다. **순수 핸들러 함수**(`onEntryDragEnd`)를 분리해 단위 테스트하고, 컴포넌트는 그 핸들러를 DndContext에 연결한다.

- [ ] **Step 1: 핸들러 + 실패 테스트** — `frontend/src/watchlist/dragHandlers.ts` + `dragHandlers.test.ts`

```typescript
// dragHandlers.ts
import { arrayMove } from '@dnd-kit/sortable';
import type { WatchlistEntry } from '../api/watchlist';

export type DragResult =
  | { kind: 'reorder'; folderId: string | null; orderedCodes: string[] }
  | { kind: 'move'; codes: string[]; folderId: string | null }
  | { kind: 'none' };

/** activeCode dragged; `over` is either a folder droppable id ("folder:<id>"
 *  or "folder:__uncat__") = cross-folder move, or another row code = reorder. */
export function resolveDrag(
  visibleSorted: WatchlistEntry[],   // entries currently shown (one folder), by order
  selectedFolder: string | null,
  activeCode: string,
  overId: string,
): DragResult {
  if (overId.startsWith('folder:')) {
    const raw = overId.slice('folder:'.length);
    const folderId = raw === '__uncat__' ? null : raw;
    if (folderId === selectedFolder) return { kind: 'none' };
    return { kind: 'move', codes: [activeCode], folderId };
  }
  const from = visibleSorted.findIndex((e) => e.code === activeCode);
  const to = visibleSorted.findIndex((e) => e.code === overId);
  if (from < 0 || to < 0 || from === to) return { kind: 'none' };
  const orderedCodes = arrayMove(visibleSorted, from, to).map((e) => e.code);
  return { kind: 'reorder', folderId: selectedFolder, orderedCodes };
}
```

```typescript
// dragHandlers.test.ts
import { describe, it, expect } from 'vitest';
import { resolveDrag } from './dragHandlers';
import type { WatchlistEntry } from '../api/watchlist';
const mk = (code: string, order: number, folder_id: string | null = null): WatchlistEntry =>
  ({ code, name: code, registered_at_kst_date: '20260101', last_success_date: null, folder_id, order });

describe('resolveDrag', () => {
  const list = [mk('005930', 0), mk('000660', 1), mk('035720', 2)];
  it('reorders within the folder when dropped on a row', () => {
    expect(resolveDrag(list, null, '035720', '005930'))
      .toEqual({ kind: 'reorder', folderId: null, orderedCodes: ['035720', '005930', '000660'] });
  });
  it('moves to a folder when dropped on a folder droppable', () => {
    expect(resolveDrag(list, null, '005930', 'folder:f_a'))
      .toEqual({ kind: 'move', codes: ['005930'], folderId: 'f_a' });
  });
  it('move onto 미분류 droppable yields folderId null', () => {
    expect(resolveDrag(list, 'f_a', '005930', 'folder:__uncat__'))
      .toEqual({ kind: 'move', codes: ['005930'], folderId: null });
  });
  it('no-op when dropped on its own folder or itself', () => {
    expect(resolveDrag(list, null, '005930', 'folder:__uncat__')).toEqual({ kind: 'none' });
    expect(resolveDrag(list, null, '005930', '005930')).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/watchlist/dragHandlers.test.ts` → FAIL.

- [ ] **Step 3: 핸들러 구현** — 위 `dragHandlers.ts` 작성. Run → PASS.

- [ ] **Step 4: DndContext 배선** — `WatchlistEditModal.tsx`를 `DndContext`(PointerSensor + closestCenter)로 감싸고, 좌측 `FolderButton`을 `useDroppable({ id: 'folder:'+ (sel ?? '__uncat__') })`로(ALL 제외), 우측 행을 `useSortable({ id: code })`로 만든다. `onDragEnd`에서 `resolveDrag` → `useMoveEntries`/`useReorderEntries` 호출.

```tsx
// WatchlistEditModal.tsx (배선 골자)
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useReorderEntries, useMoveEntries } from './useWatchlist';
import { resolveDrag } from './dragHandlers';
// ...
const reorderM = useReorderEntries();
const moveM = useMoveEntries();
const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

const visible = (selected === 'ALL'
  ? (data?.entries ?? [])
  : (data?.entries ?? []).filter((e) => e.folder_id === selected)
).slice().sort((a, b) => a.order - b.order);

const onDragEnd = (ev: DragEndEvent) => {
  if (!ev.over) return;
  const r = resolveDrag(visible, selected === 'ALL' ? null : selected, String(ev.active.id), String(ev.over.id));
  if (r.kind === 'reorder' && selected !== 'ALL') reorderM.mutate({ folderId: r.folderId, orderedCodes: r.orderedCodes });
  else if (r.kind === 'move') moveM.mutate({ codes: r.codes, folderId: r.folderId });
};
// JSX: <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}> ...전체 2-pane... </DndContext>
// FolderButton: ALL이 아닐 때 useDroppable로 감싸 ref/className(isOver 강조) 부여.
// EntryRow: selected!=='ALL'일 때만 SortableContext(items=visible codes)+useSortable로 ⠿ 핸들에 listeners 부여.
//           ALL 뷰에선 ⠿ 핸들 미렌더(읽기 순서) — render-draggable-then-noop 금지.
```
> `selected==='ALL'`에서는 reorder/cross-folder가 모호하므로 **ALL 뷰에서는 행을 sortable로 만들지 말고 ⠿ 드래그 핸들도 렌더하지 않는다**(구조적 차단 — 들렸다 조용히 no-op하면 혼란). `selected !== 'ALL'`일 때만 `SortableContext`/`useSortable`/핸들을 건다. `onDragEnd`의 `selected !== 'ALL'` 가드는 2차 방어. 테스트는 순수 핸들러 `resolveDrag`로 커버(jsdom 드래그 시뮬레이션 생략).

- [ ] **Step 5: 테스트 통과** — Run: `cd frontend && npx vitest run src/watchlist/` → PASS. (전체-프로젝트 `tsc -b`는 옛 소비처가 아직 살아 있어 빨간 게 정상 — 권위 게이트는 F10 `npm run build`.)

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/watchlist/dragHandlers.ts frontend/src/watchlist/dragHandlers.test.ts frontend/src/watchlist/WatchlistEditModal.tsx frontend/src/watchlist/WatchlistEntryPane.tsx
git commit -m "feat(watchlist): dnd-kit reorder (within folder) + drag-to-folder move"
```

---

## Task F9: 폴더 rename/delete/reorder UI (좌측 pane 액션)

**Files:**
- Modify: `frontend/src/watchlist/WatchlistEditModal.tsx`
- Test: `frontend/src/watchlist/WatchlistEditModal.test.tsx` (append)

- [ ] **Step 1: 실패 테스트 작성** — 폴더 hover 액션(이름변경/삭제) 호출 검증.

```tsx
it('renames and deletes a folder via its row actions', async () => {
  vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
  const ren = vi.spyOn(api, 'renameFolder').mockResolvedValue();
  const del = vi.spyOn(api, 'deleteFolder').mockResolvedValue();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
  await screen.findByText('스윙');
  fireEvent.click(screen.getByLabelText('스윙 이름변경'));
  const input = screen.getByDisplayValue('스윙');
  fireEvent.change(input, { target: { value: '단타' } });
  fireEvent.blur(input);
  await waitFor(() => expect(ren).toHaveBeenCalledWith('f_a', '단타'));
  fireEvent.click(screen.getByLabelText('스윙 삭제'));
  await waitFor(() => expect(del).toHaveBeenCalledWith('f_a'));
});

it('reorders folders via ▼ (move down) — authoritative ordered_ids', async () => {
  vi.spyOn(api, 'getWatchlist').mockResolvedValue({
    folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
    entries: [], next_run_at_ms: 0,
  });
  const ro = vi.spyOn(api, 'reorderFolders').mockResolvedValue();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
  await screen.findByText('스윙');
  fireEvent.click(screen.getByLabelText('스윙 아래로'));
  await waitFor(() => expect(ro).toHaveBeenCalledWith(['f_b', 'f_a']));
});
```

- [ ] **Step 2: 실패 확인** → FAIL.

- [ ] **Step 3: 구현** — 실제 folders 행(`'ALL'`·미분류 pseudo 제외)에 hover 액션 추가: ✎(이름변경: inline input, blur/Enter→`useRenameFolder`), 🗑(삭제: `useDeleteFolder`), ▲/▼(순서: `useReorderFolders`). 세 훅 import. 이름변경 중 폴더 id는 로컬 state.

```tsx
import { useRenameFolder, useDeleteFolder, useReorderFolders } from './useWatchlist';
// renameM, deleteM, reorderM; const [editingId, setEditingId] = useState<string|null>(null); const [editName,setEditName]=...
// folders는 .order로 정렬된 `folders`(F6의 sortedFolders) 배열. 폴더 행 idx와 함께 렌더:
//   editingId===f.id ? <input value={editName} onBlur={commit} onKeyDown={Enter→commit}/> : <span>{f.name}</span>
//   ✎: <button aria-label={`${f.name} 이름변경`} onClick={()=>{setEditingId(f.id);setEditName(f.name);}}>✎</button>
//   🗑: <button aria-label={`${f.name} 삭제`} onClick={()=>deleteM.mutate(f.id)}>🗑</button>
//   순서(▲▼) — 권위 ordered_ids 리스트를 서버에 보내고 서버가 0..N-1 재부여:
//     const moveFolder = (idx, dir) => {
//       const ids = folders.map((x) => x.id); const j = idx + dir;
//       if (j < 0 || j >= ids.length) return;
//       [ids[idx], ids[j]] = [ids[j], ids[idx]];
//       reorderM.mutate(ids);
//     };
//     <button aria-label={`${f.name} 위로`}  disabled={idx===0}                onClick={()=>moveFolder(idx,-1)}>▲</button>
//     <button aria-label={`${f.name} 아래로`} disabled={idx===folders.length-1} onClick={()=>moveFolder(idx,+1)}>▼</button>
// commit: renameM.mutate({folderId:f.id, name:editName.trim()}); setEditingId(null);
// 주의: ▲▼·✎·🗑는 실제 folders 행에만. 'ALL'(모든 종목)·미분류 pseudo 행에는 액션 없음.
```

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/watchlist/WatchlistEditModal.test.tsx` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/WatchlistEditModal.tsx frontend/src/watchlist/WatchlistEditModal.test.tsx
git commit -m "feat(watchlist): folder rename/delete actions in edit modal"
```

---

## Task F10: `/watchlist` 풀 페이지 + 죽은 모듈 삭제 + 라우팅/nav 정리

**Files:**
- Delete: `frontend/src/pages/Watchlist.tsx`, `frontend/src/watchlist/WatchlistPanel.tsx`, `frontend/src/watchlist/WatchlistPanel.test.tsx`, `frontend/src/watchlist/WatchlistRow.tsx`
- Modify: `frontend/src/main.tsx` (Route + import 제거), `frontend/src/nav/LeftNav.tsx` (NavItem 제거)

- [ ] **Step 1: 라우트/nav 제거**
  - `main.tsx`: `import Watchlist from './pages/Watchlist';` (8행) 삭제, `<Route path="watchlist" element={<Watchlist />} />` (23행) 삭제.
  - `nav/LeftNav.tsx`: `<NavItem to="/watchlist" label="Watchlist" />` 줄 삭제.

- [ ] **Step 2: 죽은 파일 삭제**

```bash
git rm frontend/src/pages/Watchlist.tsx \
       frontend/src/watchlist/WatchlistPanel.tsx \
       frontend/src/watchlist/WatchlistPanel.test.tsx \
       frontend/src/watchlist/WatchlistRow.tsx
```

> `WatchlistRow.tsx`(풀페이지 행)는 drawer/modal이 자체 행을 쓰므로 소비처가 없어진다(grep로 재확인). 공통 조각은 F4의 `rowFormat.tsx`로 이미 이전됨.

- [ ] **Step 3: 잔존 참조 확인** — Run: `cd frontend && grep -rnE "WatchlistPanel|pages/Watchlist|WatchlistRow|/watchlist'" src/ | grep -v WatchlistEditModal` → **빈 출력**이어야 함(WatchlistDrawer/WatchlistEditModal만 남음). 남으면 그 import 제거.

- [ ] **Step 4: 전체 빌드 + 테스트 통과** — Run: `cd frontend && npm run build && npx vitest run src/watchlist/ src/rightrail/` → 빌드 0 errors, 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/main.tsx frontend/src/nav/LeftNav.tsx
git commit -m "refactor(watchlist): delete /watchlist page + dead WatchlistPanel/WatchlistRow; nav cleanup"
```

---

## Self-review

**1. Spec coverage (Grill resolutions 대조):**
- 폴더/Watchlist Folder 용어 → B1/F1 (folder_id/order) ✓
- WatchlistDocument 봉투 + schema_version + model_validator → B1 ✓
- forward-migrate, never quarantine → B2 `_migrate`/`load_document` ✓
- 전체문서 round-trip(4 writer) → B2 Step4 ✓ (Blocker #1: B2 `test_bump_last_success_preserves_folders` + B6 동시성)
- 참조 무결성(model_validator + 락 + 삭제→null 재배치) → B1 validator + B3 delete_folder + B6 ✓
- folder id 백엔드 mint + rename 보존 → B3 `_mint_folder_id`/`rename_folder` ✓
- order 계약(권위 ordered list → 0..N-1) → B4 `reorder_entries` + `_reindex` ✓
- 미분류 = null, 합성 객체 없음 → F3 groupByFolder(folder:null) ✓
- mutation 정책(이동·순서 낙관적 / CRUD invalidate) → F2 ✓
- 단일 query key 상수 → F1 watchlistKeys ✓
- add-form 래퍼 / 피드백 훅 / 행 공통조각 추출 → F4 ✓
- drawer 폴더그룹 + 푸터(카운트다운/전체수집) + 편집 → F5 ✓
- Modal 2-pane (폴더 CRUD / 종목 + 일괄 이동·삭제 + 종목추가 + DnD) → F6/F7/F8/F9 ✓
- '전체' 분화(모든 종목/전체 선택/전체 수집) → F5 푸터 '전체 수집' + F6 '모든 종목' + F7 '전체 선택' ✓
- 풀페이지 삭제 + 죽은 이름 정리 → F10 ✓

**2. Placeholder scan:** 모든 코드 step에 실제 코드. F8/F9는 배선 골자 + 핵심 핸들러 전체 코드(테스트는 순수 핸들러로). "stub" 명시 지점(F6 EntryPane)은 F7에서 교체하도록 순서 명시.

**3. Type consistency:** `WatchlistResponse{folders,entries,next_run_at_ms}` (B1/F1 일치), `folder_id: str|null`, `order: int`, mutation 함수 시그니처(F1)와 훅(F2)·소비처(F7/F8) 일치. `resolveDrag` 반환 union이 F2 훅 vars(`{folderId, orderedCodes}`/`{codes, folderId}`)와 일치.

**4. 실행 순서 주의(stage-5):** 프론트 의존성상 **F1 → F2,F3,F4 → (F7→F6→F8→F9) → F5 → F10**. 모달 내부 import 순서: **F7(EntryPane) 먼저 → F6(shell이 EntryPane import) → F8(DnD) → F9(폴더 액션)**. F5(drawer)가 `WatchlistEditModal`을 import하므로 모달(F6-F9) 완성 후 F5. 백엔드 B1→B2→B3→B4→B5, B6은 B4 후. B5(routes)는 F1 전(프론트가 wire shape 의존).

**5. 피드백 표면(plan-critic f005 반영):** `useWatchlistFeedback`는 두 표면이 각자 인스턴스를 소유 — Modal(F7 pane)이 `added`/`caught_up_one`을 Banner로, drawer(F5 footer)가 `caught_up_all`을 요약 Banner로 렌더. 행별 `↻` catch-up은 F7 EntryRow에 존재(spec line 120 / assumption #4). banners.ts 포맷터(symbolLabel/formatCaughtUpOneMessage/summarizeCaughtUpAll/formatCaughtUpAllHeader) 모두 소비처 있음.

## Deferred review notes

plan-critic(`wg85qpdhm`) Suggestion/Nit 중 plan에 반영하지 않고 남긴 항목. Findings Ledger `docs/superpowers/plans/2026-05-31-watchlist-folders-findings.jsonl` 참조.

- **f008 (Suggestion, type-design, deferred):** 디스크의 entry `folder_id`가 **잘못된 *형식***(예 hand-edit `"f_x"`)일 때 — `_migrate`는 `fid in valid_ids` else `None` 규칙으로 **이미 null 복구**한다(형식 불량 id는 valid_ids에 없으므로). 잔여 엣지는 디스크 *폴더* 객체의 id 자체가 형식 불량인 경우뿐인데, 그때 `WatchlistFolder` 필드 검증 실패 → load_document의 backup+empty(=ADR-0064이 꺼리는 wipe)로 빠진다. **발생 경로는 hand-edit뿐**(코드가 쓰는 id는 항상 minted 8-hex). 구현 시 여력 있으면 `_migrate`에서 형식 불량 폴더도 드롭+멤버 null 처리하고 회귀 테스트 추가; 아니면 load 경로에 "folder-id 형식 drift는 의도적으로 corruption 취급" 1줄 주석. 지금은 deferred.
- **f019 (Nit, design, deferred):** `WatchlistEditModal`이 토큰 없는 고정 크기 `w-[860px] h-[600px]` 사용 — `LiveSettingsModal`의 `w-[640px]` 선례처럼 모달 크기 토큰이 시스템에 없고, 2-pane 편집기는 settings 리스트보다 넓을 정당한 이유가 있어 **수용**. `max-w-[92vw]/max-h-[88vh]` 캡이 작은 뷰포트를 처리. 글리프(↻ ✕ 🗑 ✎ ▾ ▲▼)·raw Tailwind spacing(px-3/py-2/gap-2)은 기존 코드베이스 지배적 관례(42/65 컴포넌트)와 일치 — 신규 이탈 아님.
