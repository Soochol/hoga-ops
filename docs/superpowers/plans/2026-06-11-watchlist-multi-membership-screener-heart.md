# Watchlist 다중 소속 + 스크리너 하트 그룹 피커 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스크리너 하트 클릭 시 관심 그룹을 고르는 팝업을 띄우고, 한 종목이 여러 그룹에 동시에 속할 수 있게 한다.

**Architecture:** watchlist 저장소를 v2(종목당 폴더 1개 `folder_id`)에서 v3(폴더가 정렬된 `member_codes` 리스트 소유)로 전환. **API 응답은 펼친 entries `(code, folder_id, order)`(= v2 와이어 shape)로 백엔드 라우트가 투영**(저장소 Entity ≠ 와이어, ADR-0004; 클라 어댑터 없음 — 옵션 B). 프론트 데이터 계층(타입·`useWatchlist`·`grouping`)은 무변경. 멤버십은 1급 API(`POST/DELETE .../members`)로 토글. heatmap은 별도 저장소(ADR-0068)라 무관. **이 계획의 권위 설계는 ADR-0069**(grill-with-docs 정정 반영) — 아래 "개정 배너"가 커밋된 본문보다 우선.

**Tech Stack:** Python/FastAPI/Pydantic v2 + pytest (백엔드), React/TypeScript/@tanstack/react-query/@dnd-kit/Tailwind + vitest/testing-library (프론트).

**Spec:** `docs/superpowers/specs/2026-06-11-watchlist-multi-membership-screener-heart-design.md`

**불변식(전 구현 관통):** `{e.code for e in entries} == ⋃ folder.member_codes`. 멤버십·정렬은 폴더가, 백필 메타(name·dates)는 entry가 소유. entry 생성은 write 경로에서만(디스크 시드 필요). read 경로에서 drift 발견 시 prune 금지·loud log(ADR-0065).

**커밋 규율:** 메모리의 block-no-verify 훅 회피 — `&&` 체이닝/heredoc git commit 금지. 메시지 파일 작성 후 단독 `git commit -F <file>`.

---

## ⚠️ 개정 배너 (grill-with-docs / ADR-0069) — 본문보다 우선 적용

이 계획은 커밋 후 grill-with-docs로 ADR·CONTEXT와 교차검증해 정정되었다. 아래 델타가
해당 태스크의 커밋된 본문을 **대체**한다(본문은 옵션 C·top-13 등 폐기된 초안을 담고 있음):

1. **옵션 C(클라 어댑터) → 옵션 B(백엔드 투영).** ADR-0004(wire-model-no-adapter) 준수.
   - **Task 6**: `WatchlistResponse`/`WatchlistFolder`/`WatchlistEntry` **TS 타입은 v2 그대로 유지**
     (entries는 `folder_id`+`order` 보유, 와이어=펼친 shape). `WatchlistView`/`WatchlistEntryView`
     타입 **만들지 않음**. `addToWatchlist` 제거, `addMember`/`removeMember` 추가만.
   - **Task 7 (watchlistAdapter.ts) 전체 삭제** — 클라 어댑터 없음. `useWatchlist`에 `select` 없음.
   - **백엔드 투영**은 Task 4의 `get_watchlist` 라우트에서: member_codes 문서 → 펼친
     `WatchlistResponse`(폴더 `{id,name,order}` + entries `{...,folder_id,order}` 폴더×코드 한 행).
     저장소 `WatchlistFolder`는 member_codes 보유하되, **와이어 폴더는 member_codes drop**
     (응답 모델 `WatchlistFolderView{id,name,order}` 별도 — Entity≠Wire, ADR-0004).
   - **Task 8**: 낙관적 캐시는 **와이어(펼친 entries)** 그대로 조작 — `applyAddMember`=펼친 행 삽입
     `{code,name,'',null,folder_id,order:last}`, `applyRemoveMember`=그 폴더 행 삭제(+다른 폴더에도
     없으면 그 코드 전체 행 삭제), `applyReorder`=**기존 applyReorder(folder_id 기준) 그대로**.
     `useWatchlistMembership`: 펼친 entries에서 `code→folder_id 집합` 도출(본문대로).

2. **Live Set W=10 (Task 5).** 본문의 "top-13×n" → **top-W×n, W=`_PER_ACCOUNT_MAX`(=10)**.
   "13-경계" → "W-경계". (CONTEXT.md Live Set _Avoid_: "top-13" 금지.)

3. **하트 5곳 전부 GroupPicker (Task 10 확장, P7).** 스크리너 페이지(`ResultTable`) 외에
   **스크리너 패널(`ScreenerDrawer`)·라이브 상태바(`LiveStatusBar`)·라이브 검색(`LiveSymbolSearch`)·
   편집모달 추가폼(`WatchlistAddForm`)** 의 하트/추가도 GroupPicker를 연다. 각 호출처의
   `useWatchlistMembership.toggle`/`addToWatchlist` 의존을 GroupPicker 오픈으로 교체(미분류 추가 대상
   소멸). `useWatchlistMembership`의 `toggle`은 제거(GroupPicker가 멤버십 관리). 호출처별 1태스크씩.

4. **폴더 삭제 고아 확인 (P6, Task 12/13 영역).** `WatchlistDrawer`의 `deleteM.mutate(folder.id)`
   호출 전, 그 폴더에만 있는 코드(다른 폴더 member 아님)가 있으면 확인 다이얼로그
   ("이 N종목이 관심종목에서 빠집니다 — 계속?"). 고아 코드 수는 프론트가 `data.entries`(펼친)에서
   `folder_id===fid 인데 그 code가 다른 folder_id 행에 없음`으로 계산. 신규 태스크로 추가.

5. **ADR-0069** 가 권위 설계. 본문이 ADR-0069와 어긋나면 ADR-0069·이 배너를 따른다.

---

## Phase 1 — 백엔드 저장소 v3 (모델·마이그레이션·reindex)

### Task 1: v3 Pydantic 모델

**Files:**
- Modify: `hoga/api/models.py:547-590` (WatchlistFolder, WatchlistEntry, WatchlistDocument, WatchlistResponse)
- Test: `tests/test_api_watchlist_v3_model.py` (create)

- [ ] **Step 1: 실패 테스트 작성**

`tests/test_api_watchlist_v3_model.py`:
```python
"""Watchlist v3: 폴더가 member_codes 소유, entry는 순수 백필 레코드."""
from __future__ import annotations


def test_folder_has_member_codes_default_empty():
    from hoga.api.models import WatchlistFolder
    f = WatchlistFolder(id="f_0000000a", name="스윙", order=0)
    assert f.member_codes == []
    f2 = WatchlistFolder(id="f_0000000b", name="장기", order=1, member_codes=["005930", "000660"])
    assert f2.member_codes == ["005930", "000660"]


def test_entry_has_no_folder_fields():
    from hoga.api.models import WatchlistEntry
    e = WatchlistEntry(code="005930", name="삼성전자",
                       registered_at_kst_date="20260101", last_success_date=None)
    assert not hasattr(e, "folder_id")
    assert not hasattr(e, "order")


def test_document_v3_default_version():
    from hoga.api.models import WatchlistDocument
    assert WatchlistDocument().schema_version == 3
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_api_watchlist_v3_model.py -v`
Expected: FAIL (`member_codes` 없음 / `folder_id` 아직 존재 / version==2).

- [ ] **Step 3: 모델 수정**

`hoga/api/models.py` 의 4개 모델을 교체:
```python
class WatchlistFolder(BaseModel):
    """A named, ordered grouping that OWNS its ordered member codes (v3).
    member_codes 순서 = 폴더 내 표시순. `id` 는 backend-minted·rename 불변."""

    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)
    member_codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]] = Field(default_factory=list)


class WatchlistEntry(BaseModel):
    """One Code's backfill record (v3). 폴더 소속/정렬은 WatchlistFolder.member_codes
    가 소유 — entry 는 code·name·capture 마커만 가진다."""

    code: str = Field(pattern=CODE_PATTERN)
    name: str
    registered_at_kst_date: str = Field(pattern=r"^\d{8}$")
    last_success_date: str | None = Field(default=None, pattern=r"^\d{8}$")


class WatchlistDocument(BaseModel):
    """On-disk watchlist.json (v3). 불변식 entries ⟺ ⋃member_codes 는 write 경로/
    마이그레이션이 보장 — read 경로 crash 금지(ADR-0065)라 raising validator 없음."""

    schema_version: int = 3
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[WatchlistEntry] = Field(default_factory=list)


class WatchlistResponse(BaseModel):
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[WatchlistEntry]
    next_run_at_ms: int  # Unix-ms of next KST 17:00 boundary (ADR-0003)
```
주의: 기존 `WatchlistDocument._no_dangling_folder_id` model_validator 는 삭제(folder_id 없음). `model_validator` import 가 다른 모델에서 안 쓰이면 그대로 두어도 무해.

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_api_watchlist_v3_model.py -v`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/models.py tests/test_api_watchlist_v3_model.py
git commit -F <msg>   # "feat(watchlist): v3 모델 — 폴더가 member_codes 소유"
```

이 시점에 `hoga/api/watchlist.py` 등은 아직 folder_id 를 참조해 import 에러/테스트 실패가 난다 — Task 2에서 정리. 단일 커밋 단위로는 모델만 격리.

---

### Task 2: `_migrate` v2→v3 + `_reindex` v3

**Files:**
- Modify: `hoga/api/watchlist.py:44-91` (`_migrate`, `_reindex`), 상단에 상수 추가
- Test: `tests/test_api_watchlist_migrate_v3.py` (create)

- [ ] **Step 1: 실패 테스트 작성**

`tests/test_api_watchlist_migrate_v3.py`:
```python
"""v2→v3 마이그레이션: folder_id/order → member_codes, null → '기본' 보존 폴더."""
from __future__ import annotations
import json


def test_migrate_v2_folds_folder_id_into_member_codes(tmp_path):
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 2,
        "folders": [{"id": "f_0000000a", "name": "스윙", "order": 0}],
        "entries": [
            {"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101",
             "last_success_date": None, "folder_id": "f_0000000a", "order": 1},
            {"code": "000660", "name": "SK", "registered_at_kst_date": "20260101",
             "last_success_date": None, "folder_id": "f_0000000a", "order": 0},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 3
    swing = next(f for f in doc.folders if f.id == "f_0000000a")
    assert swing.member_codes == ["000660", "005930"]  # by order
    assert {e.code for e in doc.entries} == {"005930", "000660"}


def test_migrate_v2_nulls_go_to_default_folder(tmp_path):
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 2, "folders": [],
        "entries": [
            {"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101",
             "last_success_date": None, "folder_id": None, "order": 0},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 3
    assert len(doc.folders) == 1
    assert doc.folders[0].name == "기본"
    assert doc.folders[0].member_codes == ["005930"]


def test_migrate_v2_no_nulls_no_default_folder(tmp_path):
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 2,
        "folders": [{"id": "f_0000000a", "name": "스윙", "order": 0}],
        "entries": [{"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101",
                     "last_success_date": None, "folder_id": "f_0000000a", "order": 0}],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert [f.name for f in doc.folders] == ["스윙"]  # no '기본'


def test_migrate_v3_passthrough_is_idempotent(tmp_path):
    from hoga.api.watchlist import load_document, save_document
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0, member_codes=["005930"])],
        entries=[WatchlistEntry(code="005930", name="삼성",
                                registered_at_kst_date="20260101", last_success_date=None)],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert reloaded.schema_version == 3
    assert reloaded.folders[0].member_codes == ["005930"]


def test_migrate_rejects_future_version(tmp_path):
    import pytest
    from hoga.api.watchlist import load_document, UnsupportedWatchlistSchema
    (tmp_path / "watchlist.json").write_text(json.dumps({"schema_version": 4, "folders": [], "entries": []}),
                                             encoding="utf-8")
    with pytest.raises(UnsupportedWatchlistSchema):
        load_document(tmp_path)
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_api_watchlist_migrate_v3.py -v`
Expected: FAIL.

- [ ] **Step 3: `_migrate`/`_reindex` 교체**

`hoga/api/watchlist.py` 상단(상수)·`_migrate`·`_reindex` 를 교체:
```python
# 마이그레이션 보존 폴더의 결정적 id — random mint 를 피해 v2 파일을 매 load 마다
# 같은 id 로 접는다(미persist 상태에서 collapse-state/localStorage thrash 방지).
_DEFAULT_FOLDER_ID = "f_00000000"
_DEFAULT_FOLDER_NAME = "기본"


def _migrate(raw: dict) -> dict:
    """어떤 on-disk 모양이든 v3 dict 로 정규화(데이터 보존, ADR-0065).
    - v3: 방어적 통과(member_codes 보장, entry slim).
    - v1/v2: folder_id/order 를 member_codes 로 접고, null 종목은 '기본' 폴더로 보존.
    - schema_version>3: UnsupportedWatchlistSchema(loud halt)."""
    version = raw.get("schema_version", raw.get("version", 1))
    if version > 3:
        raise UnsupportedWatchlistSchema(f"unsupported watchlist schema_version {version}")
    if version >= 3:
        return {
            "schema_version": 3,
            "folders": [{"id": f["id"], "name": f["name"], "order": f.get("order", 0),
                         "member_codes": list(f.get("member_codes", []))}
                        for f in raw.get("folders", [])],
            "entries": [_slim(e) for e in raw.get("entries", [])],
        }
    # v1/legacy/v2 → v2-shaped (folder_id, order) 행 먼저
    folders_v2 = raw.get("folders", []) if version >= 2 else []
    valid_ids = {f.get("id") for f in folders_v2}
    v2_entries: list[dict] = []
    for i, e in enumerate(raw.get("entries", [])):
        e = dict(e)
        fid = e.get("folder_id")
        e["folder_id"] = fid if fid in valid_ids else None
        e["order"] = e.get("order", i)
        v2_entries.append(e)
    # v2 → v3: 폴더별 member_codes(order순), null → '기본'
    by_fid: dict[str | None, list[dict]] = {}
    for e in v2_entries:
        by_fid.setdefault(e["folder_id"], []).append(e)

    def codes_in(fid: str | None) -> list[str]:
        return [e["code"] for e in sorted(by_fid.get(fid, []), key=lambda r: r["order"])]

    folders_v3 = [{"id": f["id"], "name": f["name"], "order": f.get("order", i),
                   "member_codes": codes_in(f["id"])}
                  for i, f in enumerate(folders_v2)]
    nulls = codes_in(None)
    if nulls:
        folders_v3.append({"id": _DEFAULT_FOLDER_ID, "name": _DEFAULT_FOLDER_NAME,
                           "order": len(folders_v3), "member_codes": nulls})
    return {"schema_version": 3, "folders": folders_v3,
            "entries": [_slim(e) for e in v2_entries]}


def _slim(e: dict) -> dict:
    """Wire/legacy entry dict → v3 slim store entry dict (백필 마커만)."""
    return {"code": e["code"], "name": e["name"],
            "registered_at_kst_date": e["registered_at_kst_date"],
            "last_success_date": e.get("last_success_date")}


def _reindex(doc: WatchlistDocument) -> WatchlistDocument:
    """folders[].order 를 0..N-1 로 정규화(현재 order 후 위치순; 물리 리스트 순서는
    보존 — reorder_folders 계약). 각 폴더 member_codes 중복 제거(첫 등장 유지).
    entry 는 손대지 않음(불변식은 write/마이그레이션 책임). Idempotent."""
    fsorted = sorted(range(len(doc.folders)), key=lambda i: (doc.folders[i].order, i))
    fo = {orig: rank for rank, orig in enumerate(fsorted)}

    def dedupe(codes: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for c in codes:
            if c not in seen:
                seen.add(c)
                out.append(c)
        return out

    new_folders = [f.model_copy(update={"order": fo[i], "member_codes": dedupe(f.member_codes)})
                   for i, f in enumerate(doc.folders)]
    return doc.model_copy(update={"folders": new_folders})
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_api_watchlist_migrate_v3.py -v`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/watchlist.py tests/test_api_watchlist_migrate_v3.py
git commit -F <msg>   # "feat(watchlist): _migrate v2→v3 (member_codes·'기본' 보존)"
```

---

## Phase 2 — 백엔드 멤버십 ops + 라우트

### Task 3: `add_member`/`remove_member` + 기존 mutation 적응

**Files:**
- Modify: `hoga/api/watchlist.py` (add_entry/remove_entry/move_entries/reorder_entries/delete_folder 재작성, add_member/remove_member 추가)
- Test: `tests/test_api_watchlist_membership.py` (create)

- [ ] **Step 1: 실패 테스트 작성**

`tests/test_api_watchlist_membership.py`:
```python
"""멤버십 1급 ops: add_member(생성·시드), remove_member(마지막 폴더→entry 삭제)."""
from __future__ import annotations
import pytest


async def _seed_folder(tmp_path, fid="f_0000000a", name="스윙"):
    from hoga.api.watchlist import create_folder
    f = await create_folder(tmp_path, name=name)
    return f.id


@pytest.mark.asyncio
async def test_add_member_creates_entry_and_membership(tmp_path):
    from hoga.api.watchlist import add_member, load_document
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    doc = load_document(tmp_path)
    assert [e.code for e in doc.entries] == ["005930"]
    assert next(f for f in doc.folders if f.id == fid).member_codes == ["005930"]


@pytest.mark.asyncio
async def test_add_member_second_folder_keeps_single_entry(tmp_path):
    from hoga.api.watchlist import add_member, create_folder, load_document
    f1 = await _seed_folder(tmp_path, name="스윙")
    f2 = (await create_folder(tmp_path, name="장기")).id
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f1)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f2)
    doc = load_document(tmp_path)
    assert [e.code for e in doc.entries] == ["005930"]  # 단일 entry
    assert next(f for f in doc.folders if f.id == f1).member_codes == ["005930"]
    assert next(f for f in doc.folders if f.id == f2).member_codes == ["005930"]


@pytest.mark.asyncio
async def test_add_member_idempotent(tmp_path):
    from hoga.api.watchlist import add_member, load_document
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    doc = load_document(tmp_path)
    assert next(f for f in doc.folders if f.id == fid).member_codes == ["005930"]  # 중복 없음


@pytest.mark.asyncio
async def test_remove_member_last_folder_drops_entry(tmp_path):
    from hoga.api.watchlist import add_member, remove_member, load_document
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    await remove_member(tmp_path, code="005930", folder_id=fid)
    doc = load_document(tmp_path)
    assert doc.entries == []  # 마지막 폴더 제거 → watchlist 탈락
    assert next(f for f in doc.folders if f.id == fid).member_codes == []


@pytest.mark.asyncio
async def test_remove_member_other_folder_keeps_entry(tmp_path):
    from hoga.api.watchlist import add_member, remove_member, create_folder, load_document
    f1 = await _seed_folder(tmp_path, name="스윙")
    f2 = (await create_folder(tmp_path, name="장기")).id
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f1)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f2)
    await remove_member(tmp_path, code="005930", folder_id=f1)
    doc = load_document(tmp_path)
    assert [e.code for e in doc.entries] == ["005930"]  # 잔여 폴더로 유지
    assert next(f for f in doc.folders if f.id == f2).member_codes == ["005930"]


@pytest.mark.asyncio
async def test_add_member_unknown_folder_raises(tmp_path):
    from hoga.api.watchlist import add_member, FolderNotFoundError
    with pytest.raises(FolderNotFoundError):
        await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id="f_deadbeef")
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_api_watchlist_membership.py -v`
Expected: FAIL (`add_member` 없음).

- [ ] **Step 3: ops 구현 + 기존 적응**

`hoga/api/watchlist.py` 에 추가/교체. 먼저 신규 ops:
```python
async def add_member(
    data_dir: Path, *, code: str, name: str, today_kst_date: str, folder_id: str,
) -> WatchlistEntry:
    """code 를 folder_id 의 멤버로 추가. entry 가 없으면 생성(last_success 디스크 시드).
    이미 멤버면 멱등 no-op. 폴더 없으면 FolderNotFoundError."""
    from hoga.api.disk_state import latest_complete_date  # 지역 import: 사이클 회피
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        entries = list(doc.entries)
        entry = next((e for e in entries if e.code == code), None)
        if entry is None:
            entry = WatchlistEntry(
                code=code, name=name, registered_at_kst_date=today_kst_date,
                last_success_date=latest_complete_date(data_dir, code),
            )
            entries.append(entry)
        new_folders = doc.folders
        if code not in folder.member_codes:
            new_folders = [f.model_copy(update={"member_codes": [*f.member_codes, code]})
                           if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders, "entries": entries}))
        return entry


async def remove_member(data_dir: Path, *, code: str, folder_id: str) -> None:
    """code 를 folder_id 에서 제거. 제거 후 어느 폴더에도 없으면 entry 삭제(watchlist 탈락).
    폴더 없으면 FolderNotFoundError. 멤버 아니면 멱등 no-op."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        new_folders = [f.model_copy(update={"member_codes": [c for c in f.member_codes if c != code]})
                       if f.id == folder_id else f for f in doc.folders]
        still_member = any(code in f.member_codes for f in new_folders)
        new_entries = doc.entries if still_member else [e for e in doc.entries if e.code != code]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders, "entries": new_entries}))
```

`reorder_entries` 를 member_codes 재배열로 교체:
```python
async def reorder_entries(data_dir: Path, *, folder_id: str,
                          ordered_codes: list[str]) -> None:
    """folder_id 의 member_codes 를 ordered_codes 로 재배열. ordered_codes 는 현재
    멤버 집합과 정확히 일치해야 함(아니면 WatchlistSetMismatchError → 409)."""
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        if len(ordered_codes) != len(folder.member_codes) or set(ordered_codes) != set(folder.member_codes):
            raise WatchlistSetMismatchError(
                f"reorder set {ordered_codes} != folder {folder_id} members {folder.member_codes}")
        new_folders = [f.model_copy(update={"member_codes": list(ordered_codes)})
                       if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))
```

`delete_folder` 를 v3 로 교체(reparent 폐지 → member 제거 후 orphan entry 삭제):
```python
async def delete_folder(data_dir: Path, *, folder_id: str) -> None:
    """폴더 삭제. 폴더에만 있던 코드는 orphan → entry 삭제(watchlist 탈락);
    다른 폴더에도 있으면 entry 유지(P2)."""
    async with _lock:
        doc = load_document(data_dir)
        target = next((f for f in doc.folders if f.id == folder_id), None)
        if target is None:
            raise FolderNotFoundError(folder_id)
        new_folders = [f for f in doc.folders if f.id != folder_id]
        survivors = {c for f in new_folders for c in f.member_codes}
        new_entries = [e for e in doc.entries if e.code in survivors]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders, "entries": new_entries}))
```

`add_entry`/`remove_entry`/`move_entries` 정리:
- `add_entry`(POST /api/watchlist) 는 v3 에서 "폴더 없는 추가"가 불가하므로 **삭제**. 호출처(WatchlistAddForm·useAddToWatchlist)는 Task 11에서 멤버십으로 전환. catchup/스케줄러는 `load_watchlist`(entries) 만 쓰므로 무관.
- `remove_entry`(DELETE /api/watchlist/{code}) 는 "모든 폴더에서 빼고 entry 삭제"로 재정의:
```python
async def remove_entry(data_dir: Path, *, code: str) -> None:
    """code 를 watchlist 에서 완전 제거(모든 폴더 member_codes 에서 빼고 entry 삭제)."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(e.code == code for e in doc.entries):
            raise NotInWatchlistError(code)
        new_folders = [f.model_copy(update={"member_codes": [c for c in f.member_codes if c != code]})
                       for f in doc.folders]
        new_entries = [e for e in doc.entries if e.code != code]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders, "entries": new_entries}))
```
- `move_entries`/`remove_entries`(bulk) 와 `AlreadyInWatchlistError`: `move_entries` 는 Task 4에서 라우트와 함께 제거(편집 모달이 멤버십 호출로 대체, Task 13). bulk `remove_entries` 는 위 remove_entry 와 동형으로 member_codes 정리 포함하도록 교체:
```python
async def remove_entries(data_dir: Path, *, codes: list[str]) -> None:
    async with _lock:
        doc = load_document(data_dir)
        drop = set(codes)
        new_folders = [f.model_copy(update={"member_codes": [c for c in f.member_codes if c not in drop]})
                       for f in doc.folders]
        new_entries = [e for e in doc.entries if e.code not in drop]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders, "entries": new_entries}))
```
`add_entry`/`move_entries` 삭제로 `bump_last_success`·`set_last_success`(entry by code) 는 변경 불필요. `AlreadyInWatchlistError` 는 더 이상 raise 안 되면 정의만 남겨도 무해(또는 제거).

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_api_watchlist_membership.py -v`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/watchlist.py tests/test_api_watchlist_membership.py
git commit -F <msg>   # "feat(watchlist): add_member/remove_member + v3 mutation 적응"
```

---

### Task 4: 라우트 (members POST/DELETE + 기존 적응)

**Files:**
- Modify: `hoga/api/watchlist_routes.py` (members 라우트 추가, add/move 라우트 제거·적응)
- Modify: `hoga/api/models.py` (MemberAddRequest 추가, EntriesMoveRequest 제거 가능)
- Test: `tests/test_api_watchlist_routes_membership.py` (create)

- [ ] **Step 1: 실패 테스트 작성**

기존 `tests/test_api_watchlist_routes.py` 의 앱 구성 픽스처 패턴을 따른다(`build_router(data_dir=...)` + FastAPI TestClient + symbols 시드). `tests/test_api_watchlist_routes_membership.py`:
```python
"""members 라우트: POST 추가(entry 생성), DELETE 제거(마지막 폴더→탈락)."""
from __future__ import annotations
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from hoga.api import symbols
    from hoga.api.watchlist_routes import build_router
    from hoga.api.models import SymbolHit  # 실제 SymbolHit 위치에 맞춰 조정

    monkeypatch.setattr(symbols, "search",
                        lambda q, limit=1: [SymbolHit(code="005930", name="삼성전자", market="KOSPI")]
                        if q == "005930" else [])
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


def _make_folder(client, name="스윙"):
    r = client.post("/api/watchlist/folders", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def test_post_member_creates_and_returns_entry(client):
    fid = _make_folder(client)
    r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "005930"})
    assert r.status_code == 201
    assert r.json()["code"] == "005930"
    got = client.get("/api/watchlist").json()
    assert next(f for f in got["folders"] if f["id"] == fid)["member_codes"] == ["005930"]


def test_post_member_unknown_folder_404(client):
    r = client.post("/api/watchlist/folders/f_deadbeef/members", json={"code": "005930"})
    assert r.status_code == 404


def test_post_member_unknown_code_404(client):
    fid = _make_folder(client)
    r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "999999"})
    assert r.status_code == 404


def test_delete_member_last_folder_removes_from_watchlist(client):
    fid = _make_folder(client)
    client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "005930"})
    r = client.delete(f"/api/watchlist/folders/{fid}/members/005930")
    assert r.status_code == 204
    got = client.get("/api/watchlist").json()
    assert got["entries"] == []
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_api_watchlist_routes_membership.py -v`
Expected: FAIL (라우트 없음).

- [ ] **Step 3: 모델 + 라우트 구현**

`hoga/api/models.py` 에 추가:
```python
class MemberAddRequest(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
```

`hoga/api/watchlist_routes.py`:
- import 에서 `add_entry, move_entries, AlreadyInWatchlistError` 제거, `add_member, remove_member` 추가.
- `POST ""`(add_to_watchlist) 핸들러와 `POST /move`(move_watchlist_entries) 핸들러 **삭제**.
- members 라우트 추가(symbol-master 검증은 기존 add 패턴 재사용):
```python
    @router.post("/folders/{folder_id}/members", status_code=201, response_model=WatchlistEntry)
    async def add_folder_member(folder_id: str, req: MemberAddRequest) -> WatchlistEntry:
        hits = symbols.search(req.code, limit=1)
        match = next((h for h in hits if h.code == req.code), None)
        if match is None:
            raise HTTPException(status_code=404, detail={
                "code": "unknown_code",
                "message": f"Code {req.code} is not in the symbol master."})
        today = now_kst().strftime("%Y%m%d")
        try:
            entry = await add_member(data_dir, code=req.code, name=match.name,
                                     today_kst_date=today, folder_id=folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — stream re-sync best-effort
            log.exception("watchlist.add_member: refresh_live_stream failed code=%s", req.code)
        return entry

    @router.delete("/folders/{folder_id}/members/{code}", status_code=204)
    async def remove_folder_member(folder_id: str, code: CodePathParam) -> None:
        try:
            await remove_member(data_dir, code=code, folder_id=folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort
            log.exception("watchlist.remove_member: refresh_live_stream failed code=%s", code)
```
`/reorder` 라우트는 `reorder_entries(folder_id, ordered_codes)` 시그니처가 유지되나 `folder_id: str`(non-null) 로 좁아짐 — `EntriesReorderRequest.folder_id` 를 `str` 로 변경(기존 `str | None`).

- [ ] **Step 4: 통과 확인 + 기존 라우트 테스트 회귀**

Run: `uv run pytest tests/test_api_watchlist_routes_membership.py tests/test_api_watchlist_routes.py tests/test_api_watchlist_folders.py -v`
Expected: 신규 PASS. 기존 테스트 중 add/move 를 쓰던 케이스는 **삭제/갱신 필요** — folder_id 기반 기대를 member_codes 로 갱신하거나, add→add_member 로 치환. 깨지는 테스트를 이 단계에서 함께 수정(같은 커밋).

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/watchlist_routes.py hoga/api/models.py tests/test_api_watchlist_routes_membership.py tests/test_api_watchlist_routes.py tests/test_api_watchlist_folders.py
git commit -F <msg>   # "feat(watchlist): members 라우트 + add/move 라우트 제거"
```

---

## Phase 3 — 백엔드 Live Set

### Task 5: `display_ordered_codes` 다중 소속 dedup

**Files:**
- Modify: `hoga/live/live_session.py:59-77` (`display_ordered_codes`)
- Test: `tests/unit/live/test_display_ordered_codes_v3.py` (create)

- [ ] **Step 1: 실패 테스트 작성**

`tests/unit/live/test_display_ordered_codes_v3.py`:
```python
"""다중 소속 평탄화: 폴더 order순 → member_codes순, 첫 등장으로 dedup."""
from __future__ import annotations


def _doc(folders, entries_codes):
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    return WatchlistDocument(
        folders=[WatchlistFolder(**f) for f in folders],
        entries=[WatchlistEntry(code=c, name=c, registered_at_kst_date="20260101",
                                last_success_date=None) for c in entries_codes],
    )


def test_flatten_dedup_topmost_folder_wins():
    from hoga.live.live_session import display_ordered_codes
    doc = _doc(
        folders=[
            {"id": "f_0000000a", "name": "A", "order": 0, "member_codes": ["005930", "000660"]},
            {"id": "f_0000000b", "name": "B", "order": 1, "member_codes": ["000660", "035720"]},
        ],
        entries_codes=["005930", "000660", "035720"],
    )
    # A: 005930,000660 ; B: 000660(중복,skip),035720 → 005930,000660,035720
    assert display_ordered_codes(doc) == ["005930", "000660", "035720"]


def test_folders_sorted_by_order():
    from hoga.live.live_session import display_ordered_codes
    doc = _doc(
        folders=[
            {"id": "f_0000000b", "name": "B", "order": 1, "member_codes": ["035720"]},
            {"id": "f_0000000a", "name": "A", "order": 0, "member_codes": ["005930"]},
        ],
        entries_codes=["005930", "035720"],
    )
    assert display_ordered_codes(doc) == ["005930", "035720"]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_display_ordered_codes_v3.py -v`
Expected: FAIL (현재 entry.folder_id 참조).

- [ ] **Step 3: 함수 교체**

`hoga/live/live_session.py` 의 `display_ordered_codes`:
```python
def display_ordered_codes(doc: WatchlistDocument) -> list[str]:
    """Watchlist Panel 표시 순서로 코드 평탄화 (v3 다중 소속, 2026-06-11).

    폴더 order 오름차순 → 각 폴더 member_codes 순 → **첫 등장으로 dedup**
    (코드 rank = 가장 위 폴더에서의 등장 위치). 미분류 개념 폐지(v3).
    """
    seen: set[str] = set()
    out: list[str] = []
    for folder in sorted(doc.folders, key=lambda f: f.order):
        for code in folder.member_codes:
            if code not in seen:
                seen.add(code)
                out.append(code)
    return out
```
`_compute_live_set`(symbol-master 필터 + top-13×n 절단)·`live_set_codes` 는 `display_ordered_codes` 만 호출하므로 변경 불필요.

- [ ] **Step 4: 통과 확인 + 회귀**

Run: `uv run pytest tests/unit/live/test_display_ordered_codes_v3.py tests/unit/live/test_live_session_characterization.py -v`
Expected: 신규 PASS. characterization 테스트가 folder_id fixture 를 쓰면 member_codes 로 갱신(같은 커밋).

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/live_session.py tests/unit/live/test_display_ordered_codes_v3.py tests/unit/live/test_live_session_characterization.py
git commit -F <msg>   # "feat(live): display_ordered_codes 다중 소속 dedup"
```

- [ ] **Step 6: 백엔드 전체 스위트 그린 확인**

Run: `uv run pytest tests/ -q`
Expected: PASS (남은 folder_id 의존 테스트가 있으면 member_codes 로 갱신).

---

## Phase 4 — 프론트 데이터 계층 (어댑터 + 훅)

### Task 6: API 타입 + addMember/removeMember

**Files:**
- Modify: `frontend/src/api/watchlist.ts` (와이어 타입 + 멤버십 fn, add/move 제거)
- Test: `frontend/src/api/watchlist.test.ts` (기존에 케이스 추가)

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/api/watchlist.test.ts` 에 추가(기존 apiCall mock 패턴 따름):
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addMember, removeMember } from './watchlist';
import * as client from './client';

describe('membership api', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('addMember POSTs code to folder members', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ code: '005930', name: '삼성' } as never);
    await addMember('f_0000000a', '005930');
    expect(spy).toHaveBeenCalledWith('/api/watchlist/folders/f_0000000a/members', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ code: '005930' }),
    }));
  });
  it('removeMember DELETEs code from folder members', async () => {
    const spy = vi.spyOn(client, 'apiAction').mockResolvedValue(undefined as never);
    await removeMember('f_0000000a', '005930');
    expect(spy).toHaveBeenCalledWith('/api/watchlist/folders/f_0000000a/members/005930', { method: 'DELETE' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/api/watchlist.test.ts`
Expected: FAIL.

- [ ] **Step 3: 타입·fn 수정**

`frontend/src/api/watchlist.ts`:
- `WatchlistFolder` 에 `member_codes: string[]` 추가.
- `WatchlistEntry` 의 `folder_id`·`order` 제거(와이어 슬림). 레거시 형태는 어댑터가 만든다(Task 7) — 그 타입은 `WatchlistEntryView` 로 별도 선언:
```typescript
export interface WatchlistFolder {
  id: string;
  name: string;
  order: number;
  member_codes: string[];   // 폴더 내 표시순 = 인덱스
}

/** 와이어 entry = 순수 백필 레코드(폴더 소속/정렬 없음). */
export interface WatchlistEntry {
  code: string;
  name: string;
  registered_at_kst_date: string;
  last_success_date: string | null;
}

/** 어댑터(projectToLegacy)가 만드는 레거시 형태 — 기존 컴포넌트가 보는 행. */
export interface WatchlistEntryView extends WatchlistEntry {
  folder_id: string;   // v3: null 없음
  order: number;       // member_codes 인덱스
}

export interface WatchlistResponse {   // 와이어(네이티브)
  folders: WatchlistFolder[];
  entries: WatchlistEntry[];
  next_run_at_ms: number;
}

/** 어댑터 산출(레거시) — 컴포넌트가 useWatchlist().data 로 받는 형태. */
export interface WatchlistView {
  folders: WatchlistFolder[];
  entries: WatchlistEntryView[];
  next_run_at_ms: number;
}
```
- `addToWatchlist` 제거. `moveEntries` 제거. `reorderEntries` 시그니처를 `(folderId: string, ...)` 로 좁힘. 멤버십 fn 추가:
```typescript
export function addMember(folderId: string, code: string): Promise<WatchlistEntry> {
  return apiCall<WatchlistEntry>(`/api/watchlist/folders/${folderId}/members`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}
export function removeMember(folderId: string, code: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}/members/${code}`, { method: 'DELETE' });
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/api/watchlist.test.ts`
Expected: PASS. (이 시점 `useWatchlist.ts` 등은 타입 에러 — Task 7-8 에서 정리. tsc 는 Task 8 후 그린.)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/api/watchlist.ts frontend/src/api/watchlist.test.ts
git commit -F <msg>   # "feat(watchlist): 와이어 타입 v3(member_codes) + 멤버십 api"
```

---

### Task 7: `watchlistAdapter.ts` (projectToLegacy) + useWatchlist select

**Files:**
- Create: `frontend/src/watchlist/watchlistAdapter.ts`
- Modify: `frontend/src/watchlist/useWatchlist.ts` (`useWatchlist` 에 select)
- Test: `frontend/src/watchlist/watchlistAdapter.test.ts` (create)

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/watchlist/watchlistAdapter.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { projectToLegacy } from './watchlistAdapter';
import type { WatchlistResponse } from '../api/watchlist';

const wire: WatchlistResponse = {
  folders: [
    { id: 'f_a', name: 'A', order: 0, member_codes: ['005930', '000660'] },
    { id: 'f_b', name: 'B', order: 1, member_codes: ['000660'] },  // 000660 다중 소속
  ],
  entries: [
    { code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null },
    { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: '20260601' },
  ],
  next_run_at_ms: 123,
};

describe('projectToLegacy', () => {
  it('explodes member_codes into (code, folder_id, order) rows, one per membership', () => {
    const v = projectToLegacy(wire);
    expect(v.entries).toEqual([
      { code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
      { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: '20260601', folder_id: 'f_a', order: 1 },
      { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: '20260601', folder_id: 'f_b', order: 0 },
    ]);
    expect(v.folders).toEqual(wire.folders);
    expect(v.next_run_at_ms).toBe(123);
  });
  it('drops a member code with no backing entry (drift) — loud, not crash', () => {
    const drift: WatchlistResponse = {
      ...wire,
      folders: [{ id: 'f_a', name: 'A', order: 0, member_codes: ['005930', 'ZZZZZZ'] }],
      entries: [{ code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null }],
    };
    const v = projectToLegacy(drift);
    expect(v.entries.map((e) => e.code)).toEqual(['005930']);  // ZZZZZZ skip
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/watchlistAdapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: 어댑터 구현**

`frontend/src/watchlist/watchlistAdapter.ts`:
```typescript
import type { WatchlistResponse, WatchlistView, WatchlistEntryView } from '../api/watchlist';

/**
 * 네이티브 와이어(폴더가 member_codes 소유) → 레거시 형태(폴더×코드로 펼친 entries).
 * 기존 컴포넌트(grouping/drawer/editmodal)가 보는 (code, folder_id, order) 행을 만든다.
 * 한 코드가 N폴더면 N행. order = 그 폴더 member_codes 의 인덱스.
 *
 * 변환은 삭제 가능한 단일 순수 함수 — 향후 컴포넌트를 네이티브로 점진 이주 시 제거.
 * 드리프트(member_codes 에 있으나 entry 없는 code)는 조용히 건너뛰되(crash 금지),
 * console.warn 으로 알린다(ADR-0065 정신: read 에서 wipe·crash 안 함).
 */
export function projectToLegacy(wire: WatchlistResponse): WatchlistView {
  const byCode = new Map(wire.entries.map((e) => [e.code, e] as const));
  const entries: WatchlistEntryView[] = [];
  for (const f of wire.folders) {
    f.member_codes.forEach((code, order) => {
      const base = byCode.get(code);
      if (!base) {
        console.warn(`watchlist drift: member ${code} in folder ${f.id} has no entry; skipping`);
        return;
      }
      entries.push({ ...base, folder_id: f.id, order });
    });
  }
  return { folders: wire.folders, entries, next_run_at_ms: wire.next_run_at_ms };
}
```

- [ ] **Step 4: useWatchlist select 적용**

`frontend/src/watchlist/useWatchlist.ts` 의 `useWatchlist` 와 import:
```typescript
import { projectToLegacy } from './watchlistAdapter';
import { getWatchlist, /* ... */, type WatchlistResponse, type WatchlistView } from '../api/watchlist';

export function useWatchlist() {
  return useQuery<WatchlistResponse, Error, WatchlistView>({
    queryKey: WATCHLIST_KEY,
    queryFn: getWatchlist,
    select: projectToLegacy,
    refetchInterval: 60_000,
  });
}
```
react-query 캐시는 네이티브(`WatchlistResponse`), 컴포넌트가 보는 `data` 는 `WatchlistView`(레거시). 기존 컴포넌트의 `e.folder_id`/`e.order` 접근이 그대로 동작.

- [ ] **Step 5: 통과 확인**

Run: `cd frontend && npx vitest run src/watchlist/watchlistAdapter.test.ts src/watchlist/grouping.test.ts`
Expected: PASS (grouping 테스트는 레거시 형태를 직접 만들어 쓰므로 무영향).

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/watchlist/watchlistAdapter.ts frontend/src/watchlist/watchlistAdapter.test.ts frontend/src/watchlist/useWatchlist.ts
git commit -F <msg>   # "feat(watchlist): projectToLegacy 어댑터 + useWatchlist select"
```

---

### Task 8: 멤버십 mutation 훅(네이티브 캐시 낙관적) + 기존 훅 정리

**Files:**
- Modify: `frontend/src/watchlist/useWatchlist.ts` (멤버십 훅 추가, useAddToWatchlist/useMoveEntries 제거, optimistic appliers 를 네이티브로)
- Modify: `frontend/src/watchlist/useWatchlistMembership.ts` (멤버십 기반으로)
- Test: `frontend/src/watchlist/useWatchlistMembership.optimistic.test.tsx` (create 또는 기존 갱신)

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/watchlist/useMembershipMutation.test.tsx`(기존 optimistic 테스트의 QueryClientProvider wrapper 패턴 따름):
```typescript
import { describe, it, expect } from 'vitest';
import { applyAddMember, applyRemoveMember } from './useWatchlist';
import type { WatchlistResponse } from '../api/watchlist';

const base: WatchlistResponse = {
  folders: [
    { id: 'f_a', name: 'A', order: 0, member_codes: ['005930'] },
    { id: 'f_b', name: 'B', order: 1, member_codes: [] },
  ],
  entries: [{ code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null }],
  next_run_at_ms: 0,
};

describe('optimistic membership appliers (native cache)', () => {
  it('applyAddMember appends code to the target folder member_codes', () => {
    const next = applyAddMember(base, { folderId: 'f_b', code: '005930', name: '삼성' });
    expect(next.folders.find((f) => f.id === 'f_b')!.member_codes).toEqual(['005930']);
  });
  it('applyRemoveMember removes code and drops orphan entry when last folder', () => {
    const next = applyRemoveMember(base, { folderId: 'f_a', code: '005930' });
    expect(next.folders.find((f) => f.id === 'f_a')!.member_codes).toEqual([]);
    expect(next.entries).toEqual([]);  // 마지막 폴더 → entry 탈락
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/useMembershipMutation.test.tsx`
Expected: FAIL.

- [ ] **Step 3: 훅·applier 구현**

`frontend/src/watchlist/useWatchlist.ts`:
- import 에 `addMember, removeMember` 추가, `addToWatchlist, moveEntries` 제거.
- 낙관적 appliers 를 **네이티브(WatchlistResponse) 기준**으로 교체. `applyReorder`(폴더 member_codes 재정렬)·`applyAddMember`·`applyRemoveMember` 작성, `applyMove` 제거:
```typescript
type AddMemberVars = { folderId: string; code: string; name: string };
type RemoveMemberVars = { folderId: string; code: string };
type ReorderVars = { folderId: string; orderedCodes: string[] };

export function applyAddMember(data: WatchlistResponse, v: AddMemberVars): WatchlistResponse {
  const hasEntry = data.entries.some((e) => e.code === v.code);
  return {
    ...data,
    folders: data.folders.map((f) =>
      f.id === v.folderId && !f.member_codes.includes(v.code)
        ? { ...f, member_codes: [...f.member_codes, v.code] } : f),
    entries: hasEntry ? data.entries
      : [...data.entries, { code: v.code, name: v.name, registered_at_kst_date: '', last_success_date: null }],
  };
}
export function applyRemoveMember(data: WatchlistResponse, v: RemoveMemberVars): WatchlistResponse {
  const folders = data.folders.map((f) =>
    f.id === v.folderId ? { ...f, member_codes: f.member_codes.filter((c) => c !== v.code) } : f);
  const still = folders.some((f) => f.member_codes.includes(v.code));
  return { ...data, folders, entries: still ? data.entries : data.entries.filter((e) => e.code !== v.code) };
}
export function applyReorder(data: WatchlistResponse, v: ReorderVars): WatchlistResponse {
  return {
    ...data,
    folders: data.folders.map((f) =>
      f.id === v.folderId ? { ...f, member_codes: [...v.orderedCodes] } : f),
  };
}
```
`useOptimisticWatchlistMutation` 의 제네릭은 그대로(`WatchlistResponse` 캐시 조작). 훅:
```typescript
export function useAddMember() {
  return useOptimisticWatchlistMutation<AddMemberVars>(
    (v) => addMember(v.folderId, v.code).then(() => undefined), applyAddMember);
}
export function useRemoveMember() {
  return useOptimisticWatchlistMutation<RemoveMemberVars>(
    (v) => removeMember(v.folderId, v.code), applyRemoveMember);
}
export function useReorderEntries() {
  return useOptimisticWatchlistMutation<ReorderVars>(
    (v) => reorderEntries(v.folderId, v.orderedCodes), applyReorder);
}
```
`useAddToWatchlist`·`useMoveEntries`·`applyFolderReorder`(유지)·`useReorderFolders`(유지) 정리. `useRemoveFromWatchlist`(DELETE /{code}) 는 유지(전체 제거).

`frontend/src/watchlist/useWatchlistMembership.ts` 를 멤버십 인지로 교체 — 스크리너/검색 하트가 "어느 폴더든 ≥1 소속" 을 isMember 로:
```typescript
import { useMemo } from 'react';
import { useWatchlist } from './useWatchlist';

/** code → 소속 folder_id 집합. 하트 채움 판정(≥1 소속) + GroupPicker 체크 상태원. */
export function useWatchlistMembership() {
  const { data } = useWatchlist();   // WatchlistView (legacy exploded)
  const foldersByCode = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of data?.entries ?? []) {
      (m.get(e.code) ?? m.set(e.code, new Set()).get(e.code)!).add(e.folder_id);
    }
    return m;
  }, [data]);
  const isMember = (code: string) => (foldersByCode.get(code)?.size ?? 0) > 0;
  const folderIdsOf = (code: string) => foldersByCode.get(code) ?? new Set<string>();
  return { isMember, folderIdsOf };
}
```
주의: 기존 `useWatchlistMembership` 의 `toggle`(add/remove 단일) 호출처(검색 드롭다운 하트 등)는 GroupPicker 또는 기본 폴더 토글로 전환 필요 — 호출처를 grep(`useWatchlistMembership`)해 Task 10/13 에서 정리.

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/watchlist/useMembershipMutation.test.tsx`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/useWatchlist.ts frontend/src/watchlist/useWatchlistMembership.ts frontend/src/watchlist/useMembershipMutation.test.tsx
git commit -F <msg>   # "feat(watchlist): 멤버십 낙관적 훅 + membership 인지 isMember"
```

---

## Phase 5 — GroupPicker + 스크리너 하트

### Task 9: `WatchlistGroupPicker` 컴포넌트

**Files:**
- Create: `frontend/src/watchlist/WatchlistGroupPicker.tsx`
- Test: `frontend/src/watchlist/WatchlistGroupPicker.test.tsx` (create)

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/watchlist/WatchlistGroupPicker.test.tsx`(testing-library; 훅 모두 mock — 컴포넌트는 훅을 직접 호출):
```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WatchlistGroupPicker } from './WatchlistGroupPicker';

const addMutate = vi.fn();
const removeMutate = vi.fn();

vi.mock('./useWatchlist', () => ({
  useWatchlist: () => ({ data: { folders: [
    { id: 'f_a', name: '스윙', order: 0, member_codes: ['005930'] },
    { id: 'f_b', name: '장기', order: 1, member_codes: [] },
  ], entries: [{ code: '005930', name: '삼성', registered_at_kst_date: '', last_success_date: null, folder_id: 'f_a', order: 0 }], next_run_at_ms: 0 } }),
  useAddMember: () => ({ mutate: addMutate }),
  useRemoveMember: () => ({ mutate: removeMutate }),
  useCreateFolder: () => ({ mutateAsync: vi.fn().mockResolvedValue({ id: 'f_c', name: '신규' }) }),
}));
vi.mock('./useWatchlistMembership', () => ({
  useWatchlistMembership: () => ({
    isMember: (c: string) => c === '005930',
    folderIdsOf: (c: string) => new Set(c === '005930' ? ['f_a'] : []),
  }),
}));

describe('WatchlistGroupPicker', () => {
  it('renders folders with the membership check state', () => {
    render(<WatchlistGroupPicker code="005930" x={0} y={0} onClose={() => {}} />);
    expect(screen.getByRole('menuitemcheckbox', { name: /스윙/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemcheckbox', { name: /장기/ })).toHaveAttribute('aria-checked', 'false');
  });
  it('toggling an unchecked folder calls useAddMember.mutate', () => {
    render(<WatchlistGroupPicker code="005930" x={0} y={0} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /장기/ }));
    expect(addMutate).toHaveBeenCalledWith({ folderId: 'f_b', code: '005930', name: '삼성' });
  });
  it('toggling a checked folder calls useRemoveMember.mutate', () => {
    render(<WatchlistGroupPicker code="005930" x={0} y={0} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /스윙/ }));
    expect(removeMutate).toHaveBeenCalledWith({ folderId: 'f_a', code: '005930' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistGroupPicker.test.tsx`
Expected: FAIL.

- [ ] **Step 3: 컴포넌트 구현**

`frontend/src/watchlist/WatchlistGroupPicker.tsx`(위치 처리는 `WatchlistRowMenu` 패턴 그대로 — 커서/앵커 (x,y) 받아 `useClampedFixedPosition` 으로 클램프):
```typescript
import { useMemo, useState } from 'react';
import { useWatchlist, useAddMember, useRemoveMember, useCreateFolder } from './useWatchlist';
import { useWatchlistMembership } from './useWatchlistMembership';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { CheckIcon } from '../ui/CheckIcon';

/**
 * 단일 멤버십 primitive. code 의 그룹 소속을 체크박스로 토글 + 새 그룹 생성.
 * 스크리너 하트와 드로어 행 메뉴('그룹 편집') 두 곳에 마운트(DRY). 호출처는 앵커
 * (x,y)만 넘기고, 위치 클램프·디스미스·멤버십 토글은 이 컴포넌트가 책임진다.
 */
export function WatchlistGroupPicker({ code, x, y, onClose }: {
  code: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);
  const { data } = useWatchlist();
  const { folderIdsOf } = useWatchlistMembership();
  const addM = useAddMember();
  const removeM = useRemoveMember();
  const createM = useCreateFolder();
  const [newName, setNewName] = useState('');
  const folders = useMemo(
    () => [...(data?.folders ?? [])].sort((a, b) => a.order - b.order), [data]);
  const member = folderIdsOf(code);
  // 종목명: view 에서 첫 등장 행이 들고 있다(없으면 code 폴백).
  const name = data?.entries.find((e) => e.code === code)?.name ?? code;

  const toggle = (folderId: string) => {
    if (member.has(folderId)) removeM.mutate({ folderId, code });
    else addM.mutate({ folderId, code, name });
  };
  const createAndAdd = async () => {
    const n = newName.trim();
    if (!n) return;
    const f = await createM.mutateAsync(n);
    addM.mutate({ folderId: f.id, code, name });
    setNewName('');
  };

  return (
    <div ref={ref} role="menu" aria-label="내 관심 그룹"
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1 min-w-[200px]"
      style={{ position: 'fixed', left, top }}>
      <div className="px-3 py-1 text-xs text-fg-dimmer">내 관심 그룹</div>
      {folders.map((f) => {
        const checked = member.has(f.id);
        return (
          <button key={f.id} type="button" role="menuitemcheckbox" aria-checked={checked}
            onClick={() => toggle(f.id)}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2">
            <span className="w-4 grid place-items-center"><CheckIcon filled={checked} size={16} /></span>
            <span className="truncate">{f.name}</span>
          </button>
        );
      })}
      <div className="mt-1 border-t border-border px-3 py-1.5 flex items-center gap-1">
        <span className="text-accent">＋</span>
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createAndAdd(); }}
          maxLength={40} placeholder="새 그룹 만들기"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-fg-dimmer" />
      </div>
    </div>
  );
}
```
주의: `useDismissablePopover(true, ref, onClose)` 는 WatchlistRowMenu 와 동일 호출(2번째 인자 = 팝오버 자기 ref). CheckIcon 의 props(`filled`,`size`)는 EntryPane 사용처와 동일.

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistGroupPicker.test.tsx`
Expected: PASS(테스트 mock 을 최종 컴포넌트 훅 사용에 맞춰 조정).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/WatchlistGroupPicker.tsx frontend/src/watchlist/WatchlistGroupPicker.test.tsx
git commit -F <msg>   # "feat(watchlist): WatchlistGroupPicker 멤버십 primitive"
```

---

### Task 10: 스크리너 하트(채움 + 팝업) + Screener 배선

**Files:**
- Modify: `frontend/src/screener/ResultTable.tsx` (하트 → 멤버십 채움 + 팝업 트리거)
- Modify: `frontend/src/pages/Screener.tsx` (watch.mutate 제거, GroupPicker 상태)
- Test: `frontend/src/screener/ResultTable.test.tsx` (create 또는 갱신)

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/screener/ResultTable.test.tsx`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResultTable } from './ResultTable';
import type { ScreenerRowLive } from './useScreenerRowsLive';

const rows: ScreenerRowLive[] = [{
  code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000,
  change_pct: 1.2, trade_value_won: 5e11,
} as ScreenerRowLive];

describe('ResultTable heart', () => {
  it('fires onWatch with the code + anchor when the heart is clicked', () => {
    const onWatch = vi.fn();
    render(<ResultTable rows={rows} onActivate={() => {}} onWatch={onWatch}
      onCapture={() => {}} isMember={() => false} />);
    fireEvent.click(screen.getByRole('button', { name: /관심종목/ }));
    expect(onWatch).toHaveBeenCalledWith('005930', expect.anything());
  });
  it('shows a filled heart for a member code', () => {
    render(<ResultTable rows={rows} onActivate={() => {}} onWatch={() => {}}
      onCapture={() => {}} isMember={(c) => c === '005930'} />);
    expect(screen.getByRole('button', { name: /관심종목/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/screener/ResultTable.test.tsx`
Expected: FAIL.

- [ ] **Step 3: ResultTable 수정**

`frontend/src/screener/ResultTable.tsx`:
- Props 에 `isMember: (code: string) => boolean` 추가, `onWatch` 시그니처를 `(code, anchorEl) => void` 로.
- 리터럴 `♥` 버튼을 `HeartIcon` + 멤버십 채움으로 교체:
```typescript
import { HeartIcon } from '../ui/HeartIcon';
// Props 에:  isMember: (code: string) => boolean;
//            onWatch: (code: string, anchor: HTMLElement) => void;

// 행 액션 셀의 하트 버튼:
<button type="button" aria-label="관심종목 그룹 편집" aria-pressed={isMember(r.code)}
  onClick={(e) => { e.stopPropagation(); onWatch(r.code, e.currentTarget); }}
  className={`bg-transparent border-none cursor-pointer leading-none p-0 ${isMember(r.code) ? 'text-fg' : 'text-fg-dimmer hover:text-fg'}`}>
  <HeartIcon filled={isMember(r.code)} className="w-[1em] h-[1em]" />
</button>
```

- [ ] **Step 4: Screener 배선**

`frontend/src/pages/Screener.tsx`:
- `useMutation(addToWatchlist)` 제거. `useWatchlistMembership` 으로 `isMember` 공급, GroupPicker 는 앵커 (x,y)만 받아 자체 클램프:
```typescript
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import { WatchlistGroupPicker } from '../watchlist/WatchlistGroupPicker';
import { useState } from 'react';
// ...
const { isMember } = useWatchlistMembership();
const [picker, setPicker] = useState<{ code: string; x: number; y: number } | null>(null);
// ResultTable: 하트 클릭 시 앵커 rect 로 (x,y) 산출(좌측·하단 + 4)
<ResultTable rows={liveRows} onActivate={openLive} isMember={isMember}
  onWatch={(code, anchor) => {
    const r = anchor.getBoundingClientRect();
    setPicker({ code, x: r.left, y: r.bottom + 4 });
  }}
  onCapture={(code) => navigate(`/capture?code=${encodeURIComponent(code)}`)} />
{picker && (
  <WatchlistGroupPicker code={picker.code} x={picker.x} y={picker.y}
    onClose={() => setPicker(null)} />
)}
```

- [ ] **Step 5: 통과 확인 + tsc + 빌드**

Run: `cd frontend && npx vitest run src/screener/ResultTable.test.tsx && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: PASS / 타입 그린 / 빌드 그린.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/screener/ResultTable.tsx frontend/src/pages/Screener.tsx frontend/src/screener/ResultTable.test.tsx
git commit -F <msg>   # "feat(screener): 하트 채움 + 관심 그룹 피커 팝업"
```

---

## Phase 6 — 드로어/편집모달 다중 소속 하드닝

### Task 11: 드로어 composite sortable id (`folderId:code`)

**Files:**
- Modify: `frontend/src/watchlist/dragHandlers.ts` (entry id codec + resolveDrag)
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx` (SortableContext items / useSortable id / onDragEnd 파싱)
- Test: `frontend/src/watchlist/dragHandlers.test.ts` (케이스 추가)

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/watchlist/dragHandlers.test.ts` 에 추가:
```typescript
import { entrySortableId, parseEntrySortableId } from './dragHandlers';

describe('entry sortable id codec (multi-membership)', () => {
  it('encodes folderId:code and decodes back', () => {
    expect(entrySortableId('f_a', '005930')).toBe('f_a:005930');
    expect(parseEntrySortableId('f_a:005930')).toEqual({ folderId: 'f_a', code: '005930' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/dragHandlers.test.ts`
Expected: FAIL.

- [ ] **Step 3: codec + drawer 적용**

`frontend/src/watchlist/dragHandlers.ts` 에 추가:
```typescript
/** 다중 소속에서 한 코드가 여러 폴더 행으로 등장 → 한 DndContext 안에서 sortable id
 *  충돌. 폴더 스코프 composite id 로 유일화한다. */
export function entrySortableId(folderId: string, code: string): string {
  return `${folderId}:${code}`;
}
export function parseEntrySortableId(id: string): { folderId: string; code: string } {
  const i = id.indexOf(':');
  return { folderId: id.slice(0, i), code: id.slice(i + 1) };
}
```
`frontend/src/watchlist/WatchlistDrawer.tsx`:
- `SortableQuoteRow` 의 `useSortable({ id: entry.code, ... })` → `id: entrySortableId(entry.folder_id, entry.code)`.
- 그룹별 `<SortableContext items={g.entries.map((e) => e.code)}>` → `items={g.entries.map((e) => entrySortableId(e.folder_id, e.code))}`.
- `onDragEnd` 의 entry 분기: `ev.active.id`/`ev.over.id` 를 `parseEntrySortableId` 로 풀어 같은 폴더 내 reorder 로 매핑:
```typescript
const { folderId, code: activeCode } = parseEntrySortableId(String(ev.active.id));
const { code: overCode } = parseEntrySortableId(String(ev.over.id));
const group = (data?.entries ?? []).filter((e) => e.folder_id === folderId)
  .sort((a, b) => a.order - b.order);
const r = resolveDrag(group, folderId, activeCode, overCode);
if (r.kind === 'reorder') reorderEntriesM.mutate({ folderId: r.folderId!, orderedCodes: r.orderedCodes });
```
(`SortableQuoteRow` 의 `key` 도 `entrySortableId(entry.folder_id, entry.code)` 로 — 같은 코드가 두 그룹 ul 에 있어도 형제 충돌 없지만 일관성 위해 composite key.)

- [ ] **Step 4: 통과 확인 + 드래그 테스트 회귀**

Run: `cd frontend && npx vitest run src/watchlist/dragHandlers.test.ts src/watchlist/WatchlistDrawer.drag.test.tsx`
Expected: PASS(드래그 테스트가 `id: code` 를 가정하면 composite 로 갱신).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/dragHandlers.ts frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/dragHandlers.test.ts frontend/src/watchlist/WatchlistDrawer.drag.test.tsx
git commit -F <msg>   # "fix(watchlist): 드로어 composite sortable id(다중 소속 충돌 해소)"
```

---

### Task 12: `WatchlistRowMenu` → "그룹 편집"(GroupPicker) + 미분류 제거

**Files:**
- Modify: `frontend/src/watchlist/WatchlistRowMenu.tsx` ("그룹으로 이동" → "그룹 편집" 트리거)
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx` (행 메뉴에서 GroupPicker 마운트)
- Test: `frontend/src/watchlist/WatchlistRowMenu.test.tsx` (갱신)

- [ ] **Step 1: 실패 테스트 작성**

`WatchlistRowMenu.test.tsx` 에 "그룹 편집" 메뉴 항목이 onEditGroups 를 부르고, 기존 "그룹으로 이동" 섹션이 사라졌음을 검증하는 케이스로 갱신:
```typescript
it('renders 그룹 편집 and no legacy move-to-group section', () => {
  const onEditGroups = vi.fn();
  render(<WatchlistRowMenu x={0} y={0} name="삼성" code="005930"
    onRemove={() => {}} onClose={() => {}} onEditGroups={onEditGroups} />);
  fireEvent.click(screen.getByTestId('watchlist-menu-edit-groups'));
  expect(onEditGroups).toHaveBeenCalled();
  expect(screen.queryByText('그룹으로 이동')).toBeNull();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistRowMenu.test.tsx`
Expected: FAIL.

- [ ] **Step 3: RowMenu + Drawer 수정**

`frontend/src/watchlist/WatchlistRowMenu.tsx`:
- Props 에서 `folders/currentFolderId/onMove` 제거, `onEditGroups: () => void` 추가.
- `items` 에 "그룹 편집" 항목 추가(remove 위/아래), `moveTargets`/move 섹션 전체 삭제:
```typescript
const items: MenuItem[] = [
  { key: 'edit-groups', label: '그룹 편집',
    icon: <CheckIcon filled size={16} />,
    onClick: () => { onEditGroups(); onClose(); } },
  { key: 'remove', label: '관심 해제',
    icon: <HeartIcon filled className="w-[1em] h-[1em]" />,
    onClick: () => { onRemove(); onClose(); } },
];
```
`frontend/src/watchlist/WatchlistDrawer.tsx`:
- `menu` state 의 onMove 사용처를 GroupPicker 오픈으로 전환. `WatchlistRowMenu` 호출을 `onEditGroups={() => setGroupPicker({ code: menu.code, x: menu.x, y: menu.y })}` 로, 별도 `groupPicker` state + GroupPicker 마운트(스크리너와 동일 앵커 래퍼). "그룹으로 이동" 의 `moveM` 의존 제거.

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistRowMenu.test.tsx src/watchlist/WatchlistDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/WatchlistRowMenu.tsx frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistRowMenu.test.tsx
git commit -F <msg>   # "feat(watchlist): 행 메뉴 '그룹 편집'(GroupPicker 통일)"
```

---

### Task 13: 미분류 잔재 제거 + 추가폼 폴더 타깃 + 편집모달 적응

**Files:**
- Modify: `frontend/src/watchlist/grouping.ts` (groupByFolder null 그룹 push 제거)
- Modify: `frontend/src/watchlist/WatchlistEntryPane.tsx` (move 메뉴의 미분류 옵션 제거)
- Modify: `frontend/src/watchlist/WatchlistAddForm.tsx` (selected 폴더로 add_member)
- Modify: `frontend/src/watchlist/WatchlistEditModal.tsx` (미분류 FolderButton 제거, countIn 갱신, move→멤버십)
- Test: `grouping.test.ts`, `WatchlistEntryPane.test.tsx`, `WatchlistEditModal.test.tsx` (갱신)

- [ ] **Step 1: 실패 테스트 작성/갱신**

`grouping.test.ts` 의 groupByFolder 기대에서 '미분류' 그룹 제거:
```typescript
it('orders folders by .order; no 미분류 group in v3', () => {
  const groups = groupByFolder(folders, entries.filter((e) => e.folder_id !== null));
  expect(groups.map((g) => g.folder!.name)).toEqual(['장기', '스윙']);  // no 미분류
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/grouping.test.ts`
Expected: FAIL.

- [ ] **Step 3: 미분류 제거 + 적응**

`frontend/src/watchlist/grouping.ts`:
- `groupByFolder` 의 `groups.push({ folder: null, ... })` 블록 삭제. `FolderGroup.folder` 를 `WatchlistFolder`(non-null)로 좁힘. `selectVisibleEntries` 의 `Selected` 를 `string` 으로(null 제거) — 호출처 영향 점검.

`frontend/src/watchlist/WatchlistEntryPane.tsx`:
- move 메뉴의 `{selected !== null && (...'미분류'...)}` 블록 삭제. `selected` 타입 `string` 화. `moveM`(useMoveEntries) 의존을 멤버십(useAddMember/useRemoveMember) 또는 GroupPicker 로 전환 — "이동"은 (현재 폴더 remove + 대상 add) 조합.

`frontend/src/watchlist/WatchlistAddForm.tsx`:
- `useAddToWatchlist`(삭제됨) → `useAddMember`. Props 에 `folderId: string`(현재 보는 폴더) 추가, submit 에서 `addM.mutateAsync({ folderId, code: picked.code, name: picked.name })`. 호출처(EntryPane)가 `selected` 를 folderId 로 전달.

`frontend/src/watchlist/WatchlistEditModal.tsx`:
- `countIn(null)`/미분류 `FolderButton` 제거. `countIn(id)` 는 `data.entries.filter(e => e.folder_id === id).length`(어댑터 view 라 그대로 동작). `Selected` null 경로 제거.

- [ ] **Step 4: 통과 확인 + 전체 프론트 스위트 + 빌드**

Run: `cd frontend && npx vitest run && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: PASS / 타입 그린 / 빌드 그린(남은 null/미분류 의존 갱신).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/grouping.ts frontend/src/watchlist/WatchlistEntryPane.tsx frontend/src/watchlist/WatchlistAddForm.tsx frontend/src/watchlist/WatchlistEditModal.tsx frontend/src/watchlist/grouping.test.ts frontend/src/watchlist/WatchlistEntryPane.test.tsx frontend/src/watchlist/WatchlistEditModal.test.tsx
git commit -F <msg>   # "refactor(watchlist): 미분류 잔재 제거 + 추가폼 폴더 타깃"
```

---

## 최종 검증

- [ ] **백엔드 전체:** `uv run pytest tests/ -q` → 그린
- [ ] **프론트 전체:** `cd frontend && npx vitest run` → 그린
- [ ] **타입/빌드:** `cd frontend && npx tsc -p tsconfig.app.json --noEmit && npm run build` → 그린
- [ ] **마이그레이션 실측:** 운영 `data_dir`(`HOGA_DATA_DIR` 확인) 의 `watchlist.json` 을 백업(`cp watchlist.json watchlist.json.v2-backup-$(date)`) 후 서버 1회 기동 → v3 저장 확인, "기본" 폴더에 기존 null 종목 보존 확인.
- [ ] **수동 e2e:** dev 서버(CLAUDE.md 핫리로드) → 스크리너 하트 클릭 → 팝업에서 두 그룹 체크 → 드로어에 두 그룹 모두 표시 → 한 그룹 체크 해제 시 그 그룹에서만 빠짐 → 마지막 그룹 해제 시 watchlist 탈락. `/browse` 로 콘솔 에러 0 확인.

## 범위 / 비범위

범위: 위 13 태스크(백엔드 v3 저장소·마이그레이션·멤버십 API·Live Set + 프론트 어댑터·GroupPicker·스크리너 하트·드로어 하드닝).

비범위: heatmap(별도 저장소, ADR-0068). 폴더 간 드래그 이동 UX 신규(드로어 DnD 는 폴더 내 reorder 만; 그룹 추가는 GroupPicker). 다중 계정 Live 확장. 검색 드롭다운 하트의 GroupPicker 전환(별도 — 현재 단일 토글 유지하되 기본 폴더 대상으로 동작하게 최소 조정, 호출처 grep 후 결정).
