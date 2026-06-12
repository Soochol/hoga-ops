# 0070 — Watchlist v3: 미분류 폐지, 폴더가 멤버십 소유, 다중 소속

**Status:** accepted (2026-06-11)

**Supersedes (부분):** ADR-0065 의 v2 모델 가정(종목당 폴더 1개 `folder_id`)을 v3 로 확장.
ADR-0004(wire-model-no-adapter)·ADR-0065(forward-migration·no-silent-loss)는 유지·준수.

## Decision

Watchlist 저장 모델을 v2 → v3 로 전환한다.

1. **다중 소속.** 한 **Code** 가 여러 **Watchlist Folder** 에 동시에 속한다. 폴더가 자기
   멤버를 소유한다 — `WatchlistFolder.member_codes: list[str]`(폴더 내 표시순 = 인덱스).
   (CONTEXT.md 의 종전 "folders do NOT embed their members" 는 단일 소속 전제의 산물로
   폐기 — 다중 소속에선 폴더가 순서 있는 멤버 집합을 소유하는 게 자연스럽다.)

2. **미분류 폐지.** Watchlist 멤버십 = **폴더들의 합집합**. 어느 폴더에도 없는 Code 는
   Watchlist 에 없다(= 백필 대상 아님). `folder_id=null` "미분류" 버킷 개념을 제거한다.
   (CONTEXT.md 종전 불변식 "폴더 삭제는 비파괴적, 종목은 미분류로 폴백, 절대 Watchlist 에서
   제거 안 됨" 을 의도적으로 반전.)

3. **파괴적 폴더 삭제 + 명시적 확인.** 폴더 삭제는 그 폴더에만 있던 Code 를 Watchlist 에서
   탈락시킨다(파괴적). 단 **고아가 발생하는 삭제는 UI 가 명시적으로 확인**한다
   ("이 N종목이 관심종목에서 빠집니다 — 계속?"). ADR-0065 의 "사용자 데이터를 조용히
   잃지 않는다" 정신을 UI 확인으로 보존.

4. **저장소(Entity) ≠ 와이어(Wire Model), 클라 어댑터 없음 (ADR-0004).**
   - 저장소: 폴더가 `member_codes` 소유 + per-Code `WatchlistEntry`(백필 마커: code·name·
     registered_at·last_success). 한 Code = 한 entry(중복 없음 — 백필 루프가 1회만 본다).
   - 와이어(`WatchlistResponse`): 폴더 `{id,name,order}` + **펼친** entries
     `{code,name,dates,folder_id,order}`(폴더×멤버로 한 행씩; 한 Code 가 N폴더면 N행,
     order=member_codes 인덱스). 즉 v2 와이어와 같은 shape(다중 소속이라 Code 중복 가능,
     `folder_id=null` 행 없음). 펼치기는 **백엔드 라우트가 WatchlistResponse 를 만들 때**
     일어난다 — 프론트는 그 shape 를 그대로 소비(groupByFolder 렌더), **클라 어댑터 없음**.

5. **Live Set 평탄화.** display 순서 = 폴더 `order` 오름차순 → 각 폴더 `member_codes` 순 →
   **첫 등장으로 dedup**(Code rank = 가장 위 폴더에서의 등장 위치). 상위
   `_PER_ACCOUNT_MAX × n_configured`(W=10/계좌) 절단. (종전 평탄화는 entry.folder_id/order
   기반·미분류 뒤로 — v3 에선 미분류 없음.)

## Why

- **다중 소속**은 사용자 요구(스크리너 하트 → 여러 관심 그룹에 동시 분류). 단일 `folder_id`
  로는 표현 불가.
- **미분류 폐지**는 "그룹이 곧 관심종목 조직의 전부" 라는 깔끔한 모델(토스/키움식). 사용자가
  trade-off 를 보고 선택. 빈 그룹 상태가 곧 미등록과 같아 개념이 하나 줄어든다.
- **확인 안전망**은 미분류 폐지의 유일한 실질 위험(폴더 삭제로 종목+백필 이력 유실)을 막는다.
  ADR-0065 의 데이터-보존 원칙을 모델 단순화와 양립시킨다.
- **와이어를 v2 shape 로 유지(옵션 B)** 는 ADR-0004 준수다. 대안이던 "클라 어댑터로
  member_codes → 펼친 entries 변환"(옵션 C)은 ADR-0004 가 정확히 거부하는 패턴
  (pass-through reshape, two shapes for one concept)이라 기각. 백엔드 라우트 투영은 모든
  라우트가 하는 producer-owns-the-consumer-shape 일 뿐 어댑터가 아니다. 덤으로 프론트
  데이터 계층(타입·useWatchlist)이 무변경이라 디프도 작다.

## Considered alternatives

- **옵션 C: 클라 어댑터(`useWatchlist.select` 가 member_codes 를 펼침).** 기각 — ADR-0004
  위반(API 경계 어댑터·두 shape). 처음엔 "백엔드가 denormalize 하면 거짓말" 이라며 옵션 C 를
  권고했으나, ADR-0004 의 Entity/Wire-Model 분리 원칙상 저장소(member_codes)≠와이어(펼친
  entries)가 정석이고 클라 어댑터가 금지 패턴임을 grill-with-docs 교차검증에서 발견·정정.

- **옵션 A: 와이어도 member_codes 네이티브 + 프론트 grouping 을 member_codes 로 재작성.**
  ADR-0004 준수이긴 하나, 와이어 shape 가 바뀌어 grouping·드로어·편집모달과 그 테스트를
  전면 재작성해야 함. 옵션 B 가 같은 ADR 준수를 더 작은 디프로 달성(와이어 shape 불변)하므로 기각.

- **미분류 유지(0폴더면 미분류로 폴백).** CONTEXT 종전 불변식 보존이지만, 사용자가 토스식
  깔끔한 모델을 명시적으로 선택해 기각.

- **`WatchlistEntry.folder_ids: list[str]` + per-folder order map(entry 가 멤버십 소유).**
  폴더별 정렬이 중첩 맵이라 유지보수 난해. 폴더가 순서 있는 `member_codes` 를 소유하는 편이
  기존 `reorder_folders(ordered_ids)` 와 동형이라 채택.

## Consequences worth flagging for future readers

- **마이그레이션(v2→v3, 의무).** `_migrate` 가 폴더별 member_codes(folder_id+order 순)를
  접고, 기존 `folder_id=null` 종목은 신규 **"기본"** 폴더로 보존(안 옮기면 0폴더=유실).
  null 0개면 "기본" 미생성. v3 첫 쓰기 전 1회 백업. `schema_version>3` 은 loud halt
  (ADR-0065 rule 1) 유지. "기본" 보존 폴더 id 는 결정적(`f_00000000`)으로 매 load thrash 방지.

- **불변식.** `{e.code for e in entries} == ⋃ folder.member_codes`. 멤버십·정렬은 폴더가,
  백필 마커는 entry 가 소유. entry 생성은 write 경로(디스크 시드 필요)에서만 —
  순수 `_reindex` 에 못 넣음. read 경로에서 drift 발견 시 prune 금지·loud log(ADR-0065).

- **멤버십 1급 API.** `POST/DELETE /api/watchlist/folders/{fid}/members[/{code}]`. 토글당
  1콜. 종전 `POST /api/watchlist`(미분류 추가)·`POST /api/watchlist/move`(folder_id 교체)는
  제거 — 미분류·단일 folder_id 가 없으므로.

- **하트는 전부 그룹 피커.** 종전 "하트=미분류 토글 추가" 5곳(스크리너 페이지·스크리너 패널·
  라이브 상태바·라이브 검색·편집모달 추가폼)이 모두 `WatchlistGroupPicker`(그룹 선택 팝업)을
  연다 — 미분류라는 단일 추가 대상이 사라졌으므로 "어디에 넣을지" 를 항상 고른다.

- **드로어 다중 소속.** 한 Code 가 N폴더면 드로어에 N행. 한 `DndContext` 안에서 sortable id
  충돌을 막으려 entry id 를 `${folderId}:${code}` composite 로.

- **Live Set "top-13" 금지어 재확인.** v3 평탄화도 상수 W=`_PER_ACCOUNT_MAX`(현재 10) 사용 —
  "top-13" 표기는 옛 값(13/계좌, 2026-06-10 실측보정 전)이라 쓰지 않는다.
