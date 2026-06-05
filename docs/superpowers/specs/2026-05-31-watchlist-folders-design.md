# 관심종목 폴더화 + popover 편집기 — Design

**Date:** 2026-05-31
**Status:** Draft
**Scope:** both — `hoga/api/watchlist.py`, `hoga/api/watchlist_routes.py`, `hoga/api/models.py`, `<data_dir>/watchlist.json` (v1→v2), `frontend/src/watchlist/*`, `frontend/src/api/watchlist.ts`, `frontend/src/rightrail/*`, `frontend/src/pages/Watchlist.tsx` (삭제), 라우팅

## Problem

관심종목 목록이 평평한 단일 리스트라, 종목이 늘면 분류·정리가 불가능하다. 사용자 표현:

> *"오른쪽에 관심종목 패널 아이콘에서 — 관심종목을 폴더화 / 관심종목 추가 삭제 폴더이동 uiux 구조화"*

현재 구조의 두 가지 마찰:

1. **폴더가 없다.** `watchlist.json`은 삽입순 평면 리스트(`entries[]`)뿐 — "스윙", "장기투자" 같은 폴더로 묶을 수 없다.
2. **편집 동선이 분리·빈약하다.** 우측 레일의 **Watchlist Panel**([`WatchlistDrawer.tsx`](../../../frontend/src/watchlist/WatchlistDrawer.tsx))은 의도적으로 **읽기 전용**(행 클릭 → 차트 점프)이고, 추가/삭제는 별도 `/watchlist` 풀 페이지([`pages/Watchlist.tsx`](../../../frontend/src/pages/Watchlist.tsx) → [`WatchlistPanel.tsx`](../../../frontend/src/watchlist/WatchlistPanel.tsx))에서만 가능하다. 폴더 이동·일괄 작업은 어디에도 없다.

사용자는 첨부 이미지로 **2-pane "관심 종목 편집" 편집 화면**(좌: 폴더 목록 + `폴더 추가` / 우: 종목 + `이동`·`삭제`·`종목 추가`·정렬 + 행별 드래그 핸들·체크박스)을 제시했고, **패널로 일원화(풀 페이지 삭제) + 편집은 별도 Modal**을 선택했다. (이미지 라벨 "그룹 추가"는 용어 통일을 위해 "폴더 추가"로, 편집 표면은 codebase 관례상 popover가 아닌 **Modal**(`WatchlistEditModal`)로 확정 — 아래 **Grill resolutions** 참조.)

> **첨부 이미지 해석.** 이미지는 **UX 레이아웃 레퍼런스**다. 거기 보이는 코스피/나스닥 선물 같은 항목은 참고용이며, hoga-ops의 **Watchlist는 6자리 KRX Code 전용**(자동 수집 대상)으로 유지한다. 행의 원형 로고도 레퍼런스일 뿐 — DESIGN.md의 "장식 최소" 원칙에 따라 **심볼 로고는 넣지 않는다**(필요 시 monogram).

## Invariants

이 spec이 건드리거나 확장하는 시스템이 **현재 보존하고 있는** 속성들:

- **Watchlist = 6자리 KRX Code 집합**: entry의 `code`는 `^\d{6}$`. 폴더는 조직화 메타데이터일 뿐 이 제약을 바꾸지 않는다. 근거: [CONTEXT.md "Watchlist"], [`hoga/api/models.py`](../../../hoga/api/models.py) `Field(pattern=r"^\d{6}$")`.
- **Capture independence from organization**: **Daily Scheduler**는 폴더/순서와 무관하게 *모든* WatchlistEntry를 순회해 수집을 enqueue한다. 근거: [CONTEXT.md "Daily Scheduler" / "Watchlist"] — "removing a Code … does not cancel queued jobs"; 폴더는 수집 동작에 영향이 없다.
- **watchlist.json atomic + lock-serialized writes**: `watchlist.json`의 모든 변경은 async `_lock`으로 직렬화되고 `atomic_write_json`으로 원자적으로 기록된다. 근거: [`hoga/api/watchlist.py`](../../../hoga/api/watchlist.py) (`_lock`, `add_entry`/`remove_entry`/`bump_last_success`).
- **last_success_date monotonic forward-only**: `bump_last_success`는 마커를 뒤로 되돌리지 않는다. 근거: [CONTEXT.md "WatchlistEntry"], `bump_last_success` 단조 가드.
- **Single watchlist data source (frontend)**: 모든 관심종목 UI는 TanStack Query 키 `['watchlist']` 하나로 같은 데이터를 읽는다. 근거: [`frontend/src/watchlist/useWatchlist.ts`](../../../frontend/src/watchlist/useWatchlist.ts).
- **Drawer activeCode-driven chart jump**: Watchlist Panel(drawer) 행 클릭 → `activeCode` 세팅 + (필요 시) `/live` 이동. 근거: [`frontend/src/watchlist/WatchlistDrawer.tsx`](../../../frontend/src/watchlist/WatchlistDrawer.tsx).
- **Panel open-state persistence**: 패널 열림 여부가 새로고침을 넘어 보존된다(`rightRail` 스토어 `panelOpen` → localStorage). 근거: [`frontend/src/state/rightRail.ts`](../../../frontend/src/state/rightRail.ts).
- **(교체 대상) Watchlist Panel은 읽기 전용 — editor가 아니다**: 현재 drawer는 추가/삭제 불가. 근거: [CONTEXT.md "Watchlist Panel"]. → 이 spec이 **의도적으로 교체**한다(아래 참조).

## Invariant impact

| Invariant | 영향 | 비고 |
|---|---|---|
| Watchlist = 6자리 KRX Code 집합 | preserves | 폴더는 `code` 제약과 무관한 메타데이터. 추가 진입점(popover)도 동일 검증 경로(symbol-master 조회) 사용. |
| Capture independence from organization | preserves | `folder_id`/`order`는 수집 로직이 읽지 않는다. Scheduler는 변경 없음. 회귀 테스트로 고정. |
| watchlist.json atomic + lock-serialized writes | **preserves (확장)** | 신규 변경(폴더 CRUD·이동·순서·일괄)도 **반드시 동일 `_lock` 경유 + atomic write**. scheduler `bump_last_success`와의 race를 막는다. ⚠️ stage 6 flake 루프에서 동시 mutation을 검증. |
| last_success_date monotonic forward-only | preserves | 폴더화는 `last_success_date`를 건드리지 않는다. 마이그레이션·이동·순서 변경 모두 마커 보존. |
| Single watchlist data source (frontend) | preserves (payload 확장) | `['watchlist']` 응답이 `folders[]` + entry의 `folder_id`/`order`를 추가로 실어 나른다. 새 fetch 경로는 만들지 않는다. |
| Drawer activeCode-driven chart jump | preserves | drawer는 폴더 그룹·접기로 바뀌지만 행 클릭 → activeCode + /live 동작은 그대로. drawer에는 drag 핸들/편집 컨트롤을 넣지 않아 클릭과 충돌 없음. |
| Panel open-state persistence | preserves | `rightRail.panelOpen` 유지. popover 열림 상태는 별도(아래 State). |
| Watchlist Panel 읽기 전용 | **intentionally breaks (교체)** | 사용자 요청의 핵심. drawer 자체는 읽기 전용을 유지하되, 변경은 drawer에서 여는 **편집 popover**가 전담한다. CONTEXT.md의 해당 줄을 새 불변식(아래)으로 교체 — grill 단계에서 문서 갱신. |

**이 spec이 신설하는 invariant:**

- **Drawer/Popover 책임 분리**: **drawer = 읽기 + 네비게이션**(폴더 그룹·접기, 행 클릭 → 차트, drag 핸들 없음); **popover = 모든 변경**(추가/삭제/폴더이동/순서/폴더 CRUD). 클릭(차트 점프)과 드래그(편집)가 서로 다른 표면에 있어 충돌하지 않는다.
- **folder_id 참조 무결성**: 모든 `entry.folder_id`는 `null`(미분류)이거나 `folders[]`에 존재하는 폴더를 가리킨다. 폴더 삭제 시 그 멤버는 `folder_id=null`로 재배치된다(삭제 차단 아님).
- **DnD 토폴로지**: 좌측 폴더 = 드롭 타깃(폴더 간 이동), 우측 리스트 = sortable(폴더 내 순서), 체크박스+`이동` = 일괄 폴더 간 이동. DnD와 일괄 이동은 **상보적**(중복 아님).

## Goals

- 관심종목을 **사용자 정의 폴더**로 묶는다(생성/이름변경/삭제/순서, 빈 폴더 허용). `미분류`는 폴더 없는 entry의 기본 버킷.
- 우측 레일 **Watchlist Panel**이 폴더별로 그룹핑(접기/펴기 + 멤버 수)되어 보인다. 행 클릭 → 차트 점프는 유지.
- 패널에서 여는 **"관심 종목 편집" popover**가 추가/삭제/폴더이동/순서변경/폴더 CRUD를 전담한다(2-pane, DnD + 체크박스 일괄작업).
- 폴더 정보는 **백엔드 `watchlist.json` v2**에 영속화 — 단일 진실원, 브라우저 초기화에도 유지.
- 기존 `/watchlist` 풀 페이지는 제거하고, 그 기능(추가/삭제 + catch-up + 17:00 카운트다운 + 등록일/마지막성공일)을 패널·popover로 재배치한다.

## Non-Goals

- **중첩(트리) 폴더** — 단일 사용자 관심종목엔 YAGNI. 폴더는 1-depth.
- **수동 외 정렬 모드**(이름순/코드순/등록순) — deferred. v1은 **수동 DnD 순서만**. **등락률순은 범위 외**(관심종목 경로에 라이브 시세가 없다).
- **심볼 로고/아이콘 이미지** — DESIGN.md 장식 최소. monogram 이상은 하지 않는다.
- **다중 사용자/다중 Watchlist** — hoga-ops는 단일 사용자 로컬 툴. `<data_dir>`당 Watchlist 하나 유지.
- **폴더 단위 수집 정책**(폴더별 일정/on-off) — 폴더는 조직화 전용. Scheduler 동작 불변.

## Design

### 도메인 모델 (CONTEXT.md 갱신 대상)

- **Watchlist Folder** (신규 용어): 단일 Watchlist 안의 named·ordered 그룹. 조직화 전용. `{id, name, order}`.
- **미분류 (Uncategorized)**: `folder_id=null` entry가 모이는 암묵 버킷. 실제 폴더 객체가 아니며 UI 기본 그룹으로 렌더.
- **WatchlistEntry** 확장: 기존 `{code, name, registered_at_kst_date, last_success_date}`에 `folder_id: str|null`, `order: int`(폴더 내 수동 순서) 추가.

> grill 단계에서 CONTEXT.md "Watchlist Panel" 항목의 "읽기 전용/editor 아님" 문장을 **Drawer/Popover 책임 분리** 불변식으로 교체하고, "Watchlist Folder"/"미분류" 용어와 WatchlistEntry 필드 2개를 추가한다.

### 백엔드 — `watchlist.json` v2

```jsonc
{
  "version": 2,
  "folders": [
    { "id": "f_a1b2c3", "name": "스윙",    "order": 0 },
    { "id": "f_d4e5f6", "name": "장기투자1", "order": 1 }
  ],
  "entries": [
    { "code": "005930", "name": "삼성전자",
      "registered_at_kst_date": "20260528", "last_success_date": "20260529",
      "folder_id": "f_a1b2c3", "order": 0 }
  ]
}
```

- **마이그레이션 v1→v2** (load 경로): `version == 1`이면 — 모든 entry에 `folder_id=null`, `order=`(현재 인덱스) 부여, `folders=[]`로 채우고 즉시 v2로 **atomic write-back**. 단일 사용자 → **forward-only, idempotent**(이미 v2면 no-op).
- **동시성**: 폴더 CRUD·이동·순서·일괄 변경 함수는 전부 기존 `_lock`을 취득하고 `atomic_write_json`으로 기록. scheduler `bump_last_success`와 같은 락을 공유해 race-free.
- **참조 무결성**: 폴더 삭제 → 멤버 entry `folder_id=null`. add/move는 대상 폴더 존재를 검증.
- **API capabilities** (정확한 단건 vs 일괄 endpoint 분할은 **plan 단계**에서 확정):
  - `GET /api/watchlist` 응답에 `folders[]` + entry의 `folder_id`/`order` 포함.
  - 폴더: 생성 / 이름변경 / 삭제 / 순서 변경.
  - 종목: 추가(기존) / 삭제(기존, + 일괄) / 폴더 이동(단건 + 일괄) / 폴더 내 순서 변경.
  - 모든 변경 후 응답은 갱신된 전체 스냅샷(또는 frontend가 `['watchlist']` invalidate).

### 프론트엔드

**(a) Watchlist Panel — drawer (`--watchlist-panel-w` 350px), 읽기+네비**
- 폴더별 접기/펴기 그룹(헤더에 폴더명 + 멤버 수), `미분류` 그룹 하단.
- 행: 코드(mono) + 이름. 클릭 → `activeCode` + `/live`(기존 유지). **drag 핸들/편집 컨트롤 없음.**
- 헤더: `+ 종목 추가`(빠른 추가) + `편집`(popover 열기).
- **푸터**: "다음 수집 17:00" 카운트다운 + `↻ 전체 수집`(catch-up all) ← *풀 페이지에서 흡수*.

**(b) "관심 종목 편집" popover/modal — 모든 변경 (첨부 이미지 기준)**
- **헤더**: "관심 종목 편집" + 닫기(×).
- **2-pane**:
  - 좌: 폴더 목록. `+ 그룹 추가`, 선택(강조), hover/⋯로 이름변경·삭제·순서. 멤버 수. 상단 `전체` pseudo-folder(모든 entry).
  - 우: 선택 폴더의 종목.
- **우 툴바**: 전체선택 체크박스 · `⇄ 이동`(선택 항목 일괄 → 대상 폴더 선택) · `🗑 삭제`(선택 일괄) · `+ 종목 추가`(`SymbolSearch`) · 정렬 = `직접 설정한 순`(수동 DnD; 다른 모드 deferred).
- **우 행**: 드래그 핸들(⠿) + 체크박스(다중선택) + 코드·이름 + 마지막성공일(dim) + hover/overflow `↻`(행별 catch-up). 로고 없음.
- **DnD (dnd-kit, 이미 설치)**: 우 리스트 = `SortableContext`(폴더 내 순서), 좌 폴더 = droppable(폴더 간 이동). 낙관적 업데이트로 부드럽게, 실패 시 롤백 + `['watchlist']` 재검증.

**(c) 상태 / 데이터**
- `useWatchlist`(React Query, `['watchlist']`) 응답 타입에 `folders` 추가. entry 타입에 `folder_id`/`order`.
- 신규 mutation 훅: 폴더 CRUD, 이동(단건/일괄), 삭제(일괄), 순서. onSuccess `['watchlist']` invalidate(낙관적 업데이트 시 onError 롤백).
- popover 열림 상태는 로컬 컴포넌트 state(또는 `rightRail` 스토어에 `editorOpen` 추가) — 영속화는 불필요.

**(d) 제거**
- `/watchlist` 라우트 + [`pages/Watchlist.tsx`](../../../frontend/src/pages/Watchlist.tsx) + 풀페이지 [`WatchlistPanel.tsx`](../../../frontend/src/watchlist/WatchlistPanel.tsx) 삭제. 거기 있던 add 폼/SymbolSearch는 popover·panel에서 재사용(공용 컴포넌트로 추출해 중복 제거). LeftNav의 `/watchlist` 항목 제거. 잔존 죽은 이름/모듈은 naming 렌즈로 정리.

## Testing strategy

- **백엔드 (pytest)**: v1→v2 마이그레이션(idempotent, 마커 보존) / 폴더 CRUD / 단건·일괄 이동 / 순서 변경 / 참조 무결성(폴더 삭제 → 미분류) / **동시성**(여러 mutation + `bump_last_success` 동시 — 같은 락) / Scheduler가 폴더 무관하게 전 entry enqueue.
- **프론트 (vitest)**: panel 폴더 그룹 렌더·접기·멤버수·행 클릭(activeCode 유지) / popover 폴더 CRUD·추가·일괄 이동/삭제 / DnD 순서·폴더 간 이동(낙관 업데이트·롤백) / 정렬=수동.
- **flake 게이트 (stage 6)**: watchlist.json 동시 mutation을 여러 번 반복 실행해 락 직렬화 검증(sleep/retry 미봉책 금지).

## Open assumptions (게이트에서 거부 가능)

1. 이미지의 비-KRX 항목은 레퍼런스 — entry는 6자리 KRX Code 유지.
2. 심볼 로고 없음(monogram or none).
3. 정렬은 수동 DnD 순서만(나머지 deferred / 등락률순 범위 외).
4. **삭제되는 기능 재배치 (사용자 승인됨 2026-05-31)**: 카운트다운 + 전체수집 → 패널 푸터; 마지막성공일 + 행별 catch-up → Modal 행.

## Grill resolutions (2026-05-31)

completeness-critic 패널(17개 발견: Blocker 1 + Critical 7 + Suggestion 9)에 대한 결정. **이 섹션이 위 본문과 충돌하면 이 섹션이 우선한다.** 문서(CONTEXT.md / ADR-0065) 변경은 적용 완료; 코드형 결정은 stage 3 writing-plans 입력(`→ plan`).

**용어 확정 (CONTEXT.md 적용 완료):**
- 조직 단위 = **폴더 / Watchlist Folder / `folder`·`folder_id`**. "그룹/Group" 금지 — `StockDateGroup`(Inventory rollup)이 이미 선점. UI 라벨도 "폴더 추가".
- 편집 표면 = **Modal (`WatchlistEditModal`)**, "popover" 아님 (codebase 관례: popover = 앵커드 outside-click mini-affordance `useDismissablePopover`; Modal = backdrop 중앙 다이얼로그 `LiveSettingsModal`).
- **미분류 = `folder_id === null`** 단일 진실원. 합성 폴더 객체 금지 (ADR-0004 / ADR-0065).
- drawer 컴포넌트는 **`WatchlistDrawer` 이름 유지** — 풀페이지 삭제로 비는 `WatchlistPanel` 이름을 회수하지 않는다(churn 최소; 새 컴포넌트가 그 이름을 가져가지도 않음). CONTEXT.md "Watchlist Panel" 정의 + _Avoid_ 두 줄 모두 재작성 완료.
- "전체" 3중 과부하 분화: pseudo-folder = **"모든 종목"**, 체크박스 = **"전체 선택"**, 푸터 = **"전체 수집"**.

**백엔드 / 영속화 (ADR-0065 적용 완료 + → plan):**
- v2 문서 봉투 = **`WatchlistDocument` Pydantic 모델**(`QueueManifest` 선례), 필드명 **`schema_version`**(자매 통일), `model_validate_json` 검증. → plan
- **forward-migrate, quarantine 금지** (ADR-0065): v1→v2 idempotent in-place write-back. → plan
- **모든 writer가 전체 문서 round-trip** — `add_entry`/`remove_entry`/`bump_last_success`/`set_last_success` + 신규 mutation 전부 동일 `_lock` 경유. **entries-only save 경로 제거** (Blocker #1: 안 그러면 17:00 스케줄러가 매 캡처 성공마다 folders를 삭제). → plan
- **참조 무결성**: `entry.folder_id ∈ folders[].id ∪ {null}`. 로드 시 document `model_validator` + 변경 함수가 `_lock` 아래 유지(폴더 삭제 → 멤버 `folder_id=null` 재배치, 삭제 차단 아님). → plan
- **folder id**: 백엔드가 mint하는 opaque id(클라이언트 생성 금지), rename에도 보존되어 참조 안정. 신규 `Folder` 모델. → plan
- **order 계약**: reorder endpoint는 "폴더 내 code 권위 순서 리스트"를 받아 서버가 `0..N-1` 재부여(gap/충돌 구조적 불가). 불변식 = `folder_id` 그룹별 contiguous + unique + 0-based. → plan

**프론트엔드 (→ plan):**
- 프론트 타입 = wire verbatim 미러(`WatchlistResponse.folders: Folder[]` + entry `folder_id`/`order`); 미분류·모든-종목은 **순수 렌더 그룹핑**(합성 객체 금지, ADR-0004).
- **mutation 정책 경계**: 이동·순서 = **낙관적 업데이트 + 롤백**(DnD 부드러움); 폴더 CRUD·추가·삭제 = **invalidate-only**(기존 4훅과 일관). `['watchlist']` 키 + 폴더 id 접두사 `f_`는 **단일 상수**로(현 `WatchlistDrawer.tsx:17`의 인라인 키도 상수화).
- **add-form 공용 단위** = `picked` state + submit + 409(`already_in_watchlist`) 처리까지 포함한 래퍼(`WatchlistAddForm`) — SymbolSearch 입력만 공유하면 로직이 2~3벌 복제됨. drawer 헤더·Modal 툴바가 이 래퍼 공유.
- **피드백 기구 단일 소유자**: `RecentAction` 리듀서 + `Banner` + 5s 타이머를 공용 훅(예 `useWatchlistFeedback`)으로 추출 — 패널·Modal 중복 금지, 누락 금지. `banners.ts`(순수 포맷터)는 그대로 공유 안전.
- **행 공통 조각**: drawer 읽기-행 / Modal 편집-행은 **책임 분리상 별개 유지**(Drawer/Modal 분리 불변식)하되 `fmtDate` + 마지막성공일 배지 렌더는 공용 util/컴포넌트로 추출(3중 복제 방지). 풀페이지 `WatchlistRow.tsx`는 페이지와 함께 삭제.

이 결정들은 stage 3 writing-plans의 입력이며, Blocker/Critical은 Findings Ledger(provenance=plan-3)에 기록된다.
