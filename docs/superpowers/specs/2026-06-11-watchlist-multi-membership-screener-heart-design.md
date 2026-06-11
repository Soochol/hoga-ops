# 설계: 스크리너 하트 → 관심 그룹 멀티 피커 (watchlist 다중 소속)

- 날짜: 2026-06-11
- 상태: 설계 (구현 전)
- 관련: `2026-05-26-watchlist-daily-scheduler-design.md`(폴더 v2), `2026-05-31` 폴더 CRUD,
  ADR-0065(watchlist = 대체 불가 사용자 데이터, read 경로에서 wipe 금지),
  ADR-0068(heatmap은 watchlist와 별도 저장소 — 본 변경과 무관)
- 영향 없음: heatmap (독립 저장소)

## 1. 문제

스크리너 결과 행의 하트(♥)를 누르면 무조건 "미분류"로 관심종목에 추가된다(`addToWatchlist(code)`).
사용자는 누를 때 **어느 관심 그룹에 넣을지 고르는 팝업**을 원한다(첨부 목업: "내 관심 그룹"
+ 그룹 체크 목록 + "새 그룹 만들기"). 한 종목은 **여러 그룹에 동시에** 속할 수 있어야 한다.

현재 데이터 모델은 종목당 폴더 1개(`folder_id`, nullable)만 지원하므로, 이 기능은
**다중 소속(multi-membership)** 으로의 스키마 전환을 전제로 한다.

### 확정된 제품 결정 (사용자)

| # | 결정 | 값 |
|---|------|-----|
| P1 | 소속 방식 | **다중 소속** — 한 종목이 N개 그룹에 동시 소속 |
| P2 | 0개 그룹 | **관심종목에서 제거** — 어느 그룹에도 없으면 watchlist 탈락(백필 중단). "미분류" 개념 폐지 |
| P3 | 하트 동작 | **채움 표시 + 항상 팝업** — watchlist(≥1 그룹)에 있으면 ♥, 없으면 ♡. 빈/채움 무관 클릭=팝업 |
| P4 | 마이그레이션 보존 폴더 이름 | **"기본"** — 기존 `folder_id=null` 종목을 담음(가역: renameFolder로 변경 가능) |
| P5 | 드로어 행 메뉴 | **그룹 피커 재사용** — 단일 멤버십 primitive를 스크리너 하트 + 드로어 행 두 곳에 마운트 |

## 2. 핵심 아키텍처 결정: 폴더가 정렬된 코드 리스트를 소유

내부 데이터 형태는 **폴더가 `member_codes`(정렬된 코드 리스트)를 소유**하고,
`entry`는 코드당 1개의 순수 백필 레코드로 남긴다.

```
[ v2 — 현재: 종목당 폴더 1개 ]            [ v3 — 다중 소속 ]

WatchlistFolder                          WatchlistFolder
  id, name, order                          id, name, order
                                           member_codes: [code, ...]   ← 추가(폴더 내 표시순 = 인덱스)

WatchlistEntry  (code로 유일)            WatchlistEntry  (code로 유일, 순수 백필 레코드)
  code, name                               code, name
  registered_at_kst_date                   registered_at_kst_date
  last_success_date                        last_success_date
  folder_id: str|null   ← 제거             (folder_id 제거)
  order: int            ← 제거             (order 제거)

불변식(invariant):  { e.code for e in entries }  ==  ⋃ folder.member_codes
                    백필 메타는 entry가,  멤버십·정렬은 폴더가 소유.
```

### 왜 이 형태인가 (Path B)

- P2("그룹이 관심종목 조직의 전부")와 정확히 일치 — 코드의 watchlist 소속이 곧
  "어떤 폴더의 member_codes에 들어 있는가"로 정의된다.
- 폴더별 정렬이 **리스트 인덱스**로 깔끔하다. 기존 `reorder_folders(ordered_ids)`와 동형이라
  대체안(`entry.orders: dict[folder_id,int]` 맵)의 중첩-맵 유지보수 함정을 피한다.
- `entry`가 순수 백필 레코드가 되어 백필 루프(`load_watchlist` → 스케줄러/catch-up)는
  코드 리스트만 보면 되고 폴더와 독립적으로 유지된다.

### 와이어 형식: 네이티브 + 클라 어댑터 (옵션 C, 2026-06-11 정련)

API 응답도 **저장소와 동일한 member_codes 네이티브**로 보낸다(저장소=와이어, 거짓 없음).
프론트엔드는 `useWatchlist`의 **단일 `select` 어댑터**로 네이티브를 기존 레거시 형태
`(code, folder_id, order)`로 펼쳐 레거시 컴포넌트(`grouping.ts`·`WatchlistDrawer`·
`WatchlistEntryPane`·`WatchlistEditModal`)에 그대로 공급한다.

```
wire(native)                          adapter(useWatchlist.select)        legacy(컴포넌트가 보는 형태)
folders:[{id,name,order,             ──projectToLegacy()──▶              folders:[{id,name,order}]
          member_codes:[c..]}]                                          entries:[{code,name,dates,
entries:[{code,name,dates}]                                              folder_id, order}]  ← 폴더×코드로 펼침
                                                                        (한 코드 N폴더 → N행, order=member_codes 인덱스)
```

- 변환은 **삭제 가능한 단일 순수 함수**에 격리(향후 컴포넌트를 네이티브로 점진 이주 시 제거).
- react-query 캐시는 **네이티브**를 보관, `select`가 파생. 낙관적 mutation은 네이티브 캐시
  (member_codes 배열)를 조작 → `select` 재파생. 폴더 내 reorder = member_codes 배열 재정렬
  (기존 `reorderFolders(ordered_ids)`와 동형, order-필드 juggling보다 깔끔).
- (기각된 옵션 A: 와이어도 네이티브 + 모든 컴포넌트를 member_codes로 재작성 — 디프·blast
  radius 큼. 기각된 옵션 B: 백엔드가 펼친 응답 — API가 denormalize "거짓말".)

### 구현 함정 (반드시 지킬 것)

1. **entry 생성은 write 경로에서만.** 새 entry의 `last_success_date`는 디스크
   (`latest_complete_date(data_dir, code)`)에서 시드해야 하므로 `data_dir`이 필요하다.
   `_reindex`는 순수 함수(doc→doc)라 여기에 생성 로직을 넣을 수 없다. 멤버십 추가 mutation에서
   entry가 없으면 생성한다.
2. **read 경로에서 orphan을 조용히 prune 금지.** 불변식 위반(member_codes에 있으나 entry 없음,
   또는 그 역)을 read에서 발견하면 **loud log**만 하고 데이터를 그대로 둔다(ADR-0065:
   read 경로에서 wipe·crash 금지). 정정은 write 경로/마이그레이션에서.
3. 불변식 보장 지점은 **모든 write(save_document)** — 멤버십이 빈 코드는 entry 삭제,
   member_codes에 처음 등장한 코드는 entry 생성.

## 3. 마이그레이션 (v2 → v3, 의무)

실측(2026-06-11, XDG 기본 `~/.local/share/hoga-ops/data/watchlist.json`):
schema v2, 폴더 1개("스윙"), 엔트리 15(스윙 14 + null 1).
⚠️ 메모리엔 "관심종목 234·반도체 미분류 30" 기록이 있어 **운영 `data_dir`이 다를 수 있다**
(`HOGA_DATA_DIR`). **실제 마이그레이션 직전 진짜 경로의 폴더 수·null 수를 재확인**한다.

```
_migrate(raw):
  v2 dict 도달 후 →
    각 folder f:  f.member_codes = [e.code for e in entries
                                    if e.folder_id == f.id]  (e.order 오름차순)
    null 종목:    nulls = [e for e in entries if e.folder_id is None]  (e.order순)
                  if nulls:
                    "기본" 폴더를 신규 생성(order = len(folders))  ← P4
                    기본.member_codes = [e.code for e in nulls]
                  if not nulls: "기본" 폴더 만들지 않음(빈 폴더 금지)
    entry:        folder_id·order 필드 제거 → {code, name, dates}만 남김
    schema_version = 3
```

- `_migrate`의 미래버전 가드를 `version > 2` → `version > 3`으로 올린다.
  v3를 구버전 빌드가 읽으면 기존대로 `UnsupportedWatchlistSchema`로 loud halt(ADR-0065 rule 1).
- **첫 v3 쓰기 전 1회 백업**: `watchlist.json.v2-backup-<stamp>`(다운그레이드 불가하므로 안전망).
- 위험도: 현재 null 1개라 낮음. 그러나 로직은 N개 일반 케이스로 작성·테스트.

## 4. 백엔드 API — 멤버십 1급 primitive

체크박스 토글당 1콜로 반응성·낙관적 업데이트를 쉽게 한다.
(heatmap의 add-then-move idiom은 **단일 소속**용·부분실패 상태를 남기므로 모방하지 않는다.)

| Method | Path | 동작 |
|--------|------|------|
| POST | `/api/watchlist/folders/{fid}/members` `{code}` | 폴더에 코드 추가. entry 없으면 생성(last_success 시드). 이미 멤버면 **멱등 no-op**(토글 UX 안전). 폴더 없으면 404, symbol-master에 없는 code면 404(기존 add 검증 재사용) |
| DELETE | `/api/watchlist/folders/{fid}/members/{code}` | 폴더에서 제거. 제거 후 어느 폴더에도 없으면 entry 삭제(= watchlist 탈락) |

기존 엔드포인트 적응:
- `reorder_entries(fid, ordered_codes)` → `folder.member_codes` 재배열로 유지(의미 동일).
- `move`(`folder_id` 교체) → 다중에선 의미 약화. "추가/제거"로 대체하거나, 드로어 요구에 맞춰
  내부적으로 (remove from src) + (add to dst)로 재정의. 단일 진실: member_codes 조작.
- `create_folder` 그대로. "새 그룹 만들기 + 이 종목" = create 후 members POST 2콜(프론트 조합).
- `POST /api/watchlist`(미분류 추가), `DELETE /api/watchlist/{code}`(단건 제거):
  미분류 개념 폐지로 의미 변경. 단건 제거는 "모든 폴더에서 빼고 entry 삭제"로 재정의 가능.
  스크리너 하트는 더 이상 `POST /api/watchlist`를 호출하지 않는다.
- 모든 변경 후 기존대로 `refresh_live_stream(data_dir)` 호출(표시 순서 변경 → Live Set 재산출).

## 5. 프론트엔드 — 단일 멤버십 primitive, 마운트 지점 둘

### `WatchlistGroupPicker({ code })` (신규, 캐논 컴포넌트)

```
┌─ 내 관심 그룹 ──────────────┐
│ ✓  스윙                     │  ← code ∈ folder.member_codes → 체크(밝게)
│    장기투자1                │  ← 미소속 → 빈 체크(클릭=추가)
│ ─────────────────────────── │
│ +  새 그룹 만들기            │  ← 인라인 입력/GroupNameModal → create + 추가
└─────────────────────────────┘
```

- `useWatchlist()` 단일 쿼리에서 `code → 소속 folder_ids` 맵을 계산.
- 폴더 행 클릭 = 토글: 미소속이면 `POST .../members`, 소속이면 `DELETE .../members/{code}`.
  낙관적 업데이트 + 실패 롤백(`useMoveEntries` 패턴 참조), 성공 시 `WATCHLIST_KEY` invalidate.
- 팝오버 인프라 재사용: `useDismissablePopover` + `useClampedFixedPosition` + Tailwind 토큰
  (DESIGN.md 준수 — `bg-bg-card`, `border-border`, `text-fg-dim`, shadow-lg 등).

### 마운트 1: 스크리너 하트 (핵심 요청)

- `ResultTable` 하트: `code`의 멤버십을 받아 ♥(≥1 그룹) / ♡(0 그룹) 표시(P3).
  글리프를 공유 `HeartIcon`(채움/빈 상태)로 교체 권장.
- 클릭 → 하트에 앵커된 `WatchlistGroupPicker` 오픈(빈/채움 무관).
- `Screener.tsx`: `watch.mutate` 제거. `useWatchlist()`로 행별 멤버십 계산
  (스크리너 행 N개는 단일 watchlist 쿼리로 충분 — 행마다 fetch 금지).

### 마운트 2: 관심종목 드로어 행 메뉴 (P5)

- `WatchlistRowMenu`의 깨진 "그룹으로 이동"을 **"그룹 편집"**으로 교체 → 같은 피커 마운트.
- 효과: "이동" 모호성 소멸 + **스캔 밖 종목도 2번째 그룹에 추가 가능**(기능 구멍 차단).
- 행 "이 폴더에서 빼기" 원클릭은 가역 편의로 유지 가능(피커 체크 해제와 동치).

## 6. Live Set 규칙 (스펙 명시 — 틀리면 KIS 구독 조용히 깨짐)

`display_ordered_codes`(live_session.py)를 다중 소속용으로 재작성한다.

```
평탄화:  for folder in sorted(folders, key=order):
           for code in folder.member_codes:     # 폴더 내 순서
             emit(code)                          # ⚠️ N폴더 코드는 N번 등장
dedup:   첫 등장만 유지(= 코드의 "가장 위 폴더"에서의 위치가 rank)
필터:    symbol-master에 있는 코드만(cold cache면 무필터 폴백 — 기존 동작)
절단:    상위 (LIVE_SET_MAX_CODES * n_configured)   # =13×n, KIS 연결당 ~32 한도
```

규칙 한 줄: **"코드 rank = 가장 위(최상위 폴더·그 안 최상위 위치) 등장 지점."**
"미분류 뒤로" 특례는 폐지(미분류 없음). `_compute_live_set` 파이프라인 구조는 유지.

## 7. 드로어 동작 변화 (사용자 확인됨 — P5)

- 한 종목이 N폴더에 있으면 드로어에 **N번 표시**(각 폴더 그룹 아래). 의도된 동작.
- 드로어 "제거" 의미 분리: 폴더 컨텍스트에서 제거 = 그 폴더에서만 빼기(타 폴더 잔류).
  마지막 폴더면 entry 삭제 = watchlist 탈락.
- **옵션 C 덕에 `grouping.ts`/`WatchlistEntryPane`/`WatchlistEditModal`은 거의 무수정**
  (어댑터가 레거시 `(code, folder_id, order)` 형태로 공급). `WatchlistDrawer`만 다중 소속
  고정 비용 2개를 흡수: ① **composite sortable id** — 같은 코드가 N그룹이면 한 `DndContext`에
  `useSortable({id: code})`가 N번 → 충돌. id를 `${folderId}:${code}`로, `onDragEnd`·`resolveDrag`·
  `dragHandlers` 파싱을 그에 맞게. ② **미분류 제거** — `groupByFolder`의 null 그룹 push와
  `WatchlistEntryPane`/`WatchlistRowMenu`의 "미분류 이동" 옵션 삭제(P2로 null 엔트리 없음).

## 8. 영향 받는 파일 (구현 지도)

백엔드:
- `hoga/api/models.py` — `WatchlistFolder`(+member_codes), `WatchlistEntry`(-folder_id,-order), 요청 모델
- `hoga/api/watchlist.py` — `_migrate`(v3), `_reindex`(member_codes 정규화·orphan loud-log),
  `add_member`/`remove_member`(신규), `move_entries`/`reorder_entries` 재작성, 불변식 보장
- `hoga/api/watchlist_routes.py` — members POST/DELETE 라우트, 기존 라우트 적응
- `hoga/live/live_session.py` — `display_ordered_codes` 다중 소속 dedup

프론트엔드:
- `frontend/src/api/watchlist.ts` — 와이어 타입(folders+member_codes, entries 슬림), `WatchlistEntryView`
  (어댑터 산출 레거시 형태), `addMember`/`removeMember` API
- `frontend/src/watchlist/watchlistAdapter.ts` — **신규** `projectToLegacy()` 순수 어댑터(member_codes→펼친 entries)
- `frontend/src/watchlist/useWatchlist.ts` — `select: projectToLegacy` + 멤버십 mutation 훅(네이티브 캐시 낙관적)
- `frontend/src/watchlist/WatchlistGroupPicker.tsx` — **신규** 캐논 멤버십 컴포넌트
- `frontend/src/screener/ResultTable.tsx` + `pages/Screener.tsx` — 하트 채움(useWatchlistMembership)·GroupPicker 팝업
- `frontend/src/watchlist/WatchlistRowMenu.tsx` — "그룹으로 이동" → "그룹 편집"(GroupPicker 마운트), 미분류 옵션 제거
- `frontend/src/watchlist/WatchlistDrawer.tsx` — composite sortable id(`${folderId}:${code}`), 미분류 그룹 제거
- `frontend/src/watchlist/grouping.ts` + `dragHandlers.ts` — composite id 파싱 보조, null 그룹 push 제거(소폭)
- `frontend/src/watchlist/WatchlistEntryPane.tsx` — "미분류 이동" 옵션 제거(소폭)

## 9. 테스트 (잘 테스트된 코드 = 비협상)

백엔드:
- `_migrate` v2→v3: null 종목 → "기본" 폴더 보존, null 0개면 "기본" 미생성, 폴더별 order→인덱스,
  v1→v2→v3 연쇄, `version>3` halt 유지.
- 멤버십: add(신규 entry 생성·last_success 시드 / 기존 entry 재사용), remove(마지막 폴더 →
  entry 삭제 / 잔여 폴더 → entry 유지), 중복 add(409/no-op), 없는 폴더(404).
- 불변식: 임의 mutation 후 `{e.code} == ⋃ member_codes`. read 경로 orphan = loud log·무변경.
- `display_ordered_codes`: N폴더 코드 dedup, rank=최상위 등장, top-13×n 절단,
  13-경계 넘는 멤버십 변경 시 구독 스왑(기존 live 테스트 회귀).
- 격리 e2e: `HOGA_DATA_DIR=temp` + KIS creds 비움 + 알트포트(메모리 패턴).

프론트엔드:
- `WatchlistGroupPicker`: 체크 상태=멤버십, 토글 add/remove 호출, 새 그룹 생성+추가,
  낙관적 롤백, 디스미스(외부 클릭·Esc).
- 하트: ♥/♡ 멤버십 반영, 클릭=팝업.
- `tsc -p tsconfig.app.json` 그린 + `npm run build` 그린(메모리: 권위 타입체크).

## 10. 엣지 케이스

- 같은 종목을 동시에 두 탭에서 토글 → `_lock` 직렬화 + invalidate로 수렴.
- 폴더 삭제 시 member_codes의 코드가 다른 폴더에 없으면 entry orphan → 삭제(write 경로).
  (기존 `delete_folder`의 "미분류로 reparent"는 폐지 → "member에서 제거 후 orphan이면 entry 삭제".)
- 마지막 그룹에서 제거 = watchlist 탈락 → `refresh_live_stream`로 Live Set 축소.
- cold symbol-master(필터 무력) → 기존 무필터 폴백 유지.

## 11. 범위 / 비범위

범위: 위 8절 파일. 구현 단계 순서 — (1) 백엔드 모델+마이그레이션+멤버십 API →
(2) 드로어 member_codes 적응(모델 깨짐 방지, 필수) → (3) 스크리너 하트 팝업 →
(4) 그룹 피커 드로어 행 메뉴 마운트.

비범위: heatmap(별도 저장소, ADR-0068). 드로어 드래그 reorder UX 재설계(member_codes
reorder는 유지하되 신규 인터랙션 추가 없음). 폴더 자체의 다중 계정 Live 확장.
