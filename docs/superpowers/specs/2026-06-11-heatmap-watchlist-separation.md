# 히트맵 ↔ 관심종목 분리 — 독립 스토어 설계

- **Date**: 2026-06-11
- **Status**: Designed — 데이터 소스 결정 확정(사장님 Q&A 2026-06-11). 구현 전 최종 검토 대기.
- **Topic slug**: `heatmap-watchlist-separation`
- **선행 스펙**: `2026-06-10-watchlist-heatmap-design.md` — 이 스펙은 그 스펙의 **데이터 소스 결정만 반전**한다(아래 §0). 렌더링 설계(레이아웃·히트 색·정렬 토글·인라인 추가·테스트 전략 §2·§6·§7·§9·§11)는 **전부 그대로 유효**.
- **관련 ADR**: **신규 0068**(히트맵 독립 스토어 — 본 스펙의 결정 기록), 0065(watchlist json v2 — 같은 마이그레이션 패턴 재사용), 0004(미분류 render-only 그룹), 0052(activeCode SSOT), 0056(KIS live quote 오버레이).
- **Scope (백엔드, 신규)**: `hoga/api/heatmap.py`(스토어), `hoga/api/heatmap_routes.py`(REST), `hoga/api/models.py`(3 모델 추가), `hoga/api/app.py`(라우터 1줄 마운트), 부팅-시 1회 시드.
- **Scope (프론트, 신규)**: `frontend/src/api/heatmap.ts`, `frontend/src/heatmap/heatmapKeys.ts`, `frontend/src/heatmap/useHeatmap.ts`. **갈아탐 2파일**: `pages/Heatmap.tsx`, `heatmap/useAddToFolder.ts`.
- **영향 없음**: `WatchlistDrawer`(관심종목 단독 홈), `useWatchlistMembership`/`WatchlistToggleButton`(/live·/screener), `hoga/live/live_session.py`(Live Set 랭킹), `hoga/api/scheduler.py`·캡처 파이프라인 — 전부 **watchlist 그대로**.

---

## 0. 무엇이·왜 바뀌나 (선행 스펙과의 차이)

선행 스펙 `2026-06-10`은 관심맵을 **"한 Watchlist의 모든 폴더를 펼친 뷰"**로 설계했다(L7 "백엔드 무변경", L20 "페이지 = `useWatchlist()`가 주는 걸 그릴 뿐", L44 데이터 흐름). 그 결과 **히트맵과 관심종목이 동일한 `watchlist.json` 단일 스토어를 공유**한다 — 히트맵에서 종목/그룹을 추가·이동·삭제하면 관심종목(드로어·라이브·캡처)이 그대로 바뀌고, 그 반대도 같다.

**사장님 결정(2026-06-11)**: 두 리스트는 **완전히 독립**이어야 한다. 관심종목(캡처용)과 히트맵(모니터링용)은 **서로 다른 집합**으로 각자 큐레이션한다. 한쪽에 추가/삭제해도 다른 쪽은 영향받지 않는다.

이 분리는 **버그 수정이 아니라 선행 스펙의 핵심 전제(단일 스토어 공유)를 의도적으로 반전**하는 일이다. ADR-0068이 그 반전을 명문화한다.

### 결정된 5개 항목 (Q&A 2026-06-11 + 권고)

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 1 | 히트맵 초기값 | **현재 watchlist(폴더+234종목)에서 1회 시드 복사** | 사장님 선택. 현재 섹터 레이아웃을 손실 없이 승계, 이후 독립. |
| 2 | 히트맵 entry 캡처 필드 | **제외** (`{code, name, folder_id, order}`만) | 히트맵은 monitoring-only. 캡처 시맨틱(`last_success_date` 등) 보유는 분리 목적을 무효화. |
| 3 | 미분류 종목 히트맵 표시 | **표시**(render-only "미분류" 그룹) | (1)·(3) 상호잠금: 시드+미분류숨김이면 "추가했는데 안 보임" 사일런트 버그. POST는 항상 미분류로 먼저 들어가므로 미분류를 보여야 추가가 보인다. |
| 4 | 라이브 랭킹/캡처 스케줄러 | **watchlist 유지** | 히트맵은 `/api/live/quotes` read-only 폴링 소비자. KIS WS 구독·캡처 enqueue를 구동하지 않음. |
| 5 | 관심종목 전용 풀페이지 뷰 | **신설 안 함**(드로어 유지) | 분리 후 watchlist는 드로어가 단독 홈. 필요해지면 별도 작업으로 `/watchlist` 라우트(HeatmapBoard 재사용) 추가 가능. |

> **§3(미분류 표시)의 함의**: 선행 스펙 §53 "빈 폴더·미분류 보드 제외(렌더 노이즈 방지)"를 **히트맵에 한해 반전**한다(비어있지 않은 미분류만 표시). 이 변경은 `heatmap/visibleGroups.ts`(히트맵 전용 모듈)에 갇혀 있어 `WatchlistDrawer`(자체 미분류 처리 보유)에는 영향 없다.

---

## 1. 한 줄 요약

`/heatmap`을 watchlist 스토어의 뷰에서 떼어내 **별도 영속 파일(`heatmap.json`) · 별도 REST(`/api/heatmap/*`) · 별도 React Query 키(`['heatmap']`)**를 가진 독립 리스트로 만든다. 부팅 시 1회 watchlist에서 시드 복사하고, 이후 양쪽은 절대 서로를 변경하지 않는다.

---

## 2. 데이터 모델 (백엔드)

### 2.1 영속화
- 신규 `<data_dir>/heatmap.json` (watchlist는 `<data_dir>/watchlist.json`). `data_dir` = `hoga/config.py::resolve_data_dir()` 공유.
- 원자적 쓰기 `hoga/api/_atomic_write.py::atomic_write_json` 공유.
- **per-store `asyncio.Lock()`** — `hoga/api/heatmap.py` 자체 락. watchlist `_lock` 공유 **금지**: watchlist 락은 캡처 핫패스(매일 enqueue, finalize 훅 `bump_last_success`)에 묶여 있어 히트맵 UI 변경이 캡처를 블록하면 안 된다.

### 2.2 모델 (`hoga/api/models.py`에 추가)

| 모델 | 정의 | watchlist 대비 |
|---|---|---|
| `HeatmapEntry` (신규) | `{code, name, folder_id: str\|None, order: int}` | **캡처 필드 제외**: `registered_at_kst_date`·`last_success_date` 없음. `add_entry`에서 `latest_complete_date()` 디스크 시드 안 함. |
| `HeatmapDocument` (신규) | `{schema_version: 2, folders, entries}` + dangling-folder validator | `WatchlistDocument`와 구조 동일, `entries` 타입만 `HeatmapEntry`. |
| `HeatmapResponse` (신규) | `{folders, entries}` | **`next_run_at_ms` 제외**(스케줄러 비구동). |
| `WatchlistFolder` | **공유(import)** `{id, name, order}` | 복제 불필요 — 폴더 구조는 양 스토어 동일·독립. |
| 요청 바디(FolderCreate/Rename/Reorder, EntriesMove/Reorder/Remove, AddRequest`{code}`) | **공유(import)** | 캡처 필드 없음. 복제 불필요. |

### 2.3 `hoga/api/heatmap.py` 서비스 (watchlist.py에서 복제·축소)
- **복제**: `_path`(→`heatmap.json`), `_migrate`, `_reindex`, `load_document`, `save_document`, `load_heatmap`(엔트리만), `create_folder`/`rename_folder`/`delete_folder`/`reorder_folders`, `move_entries`/`reorder_entries`/`remove_entries`, `add_entry`(캡처 시드 제거), `remove_entry`.
- **import 공유(DRY)**: `_mint_folder_id` (watchlist.py에서).
- **삭제(복제 안 함)**: `bump_last_success`, `set_last_success` — 히트맵은 캡처 성공을 추적하지 않음(finalize 훅 의존 0).

### 2.4 ADR-0065 마이그레이션 거버넌스 (독립 적용)
heatmap.py도 동일 패턴을 **독립적으로** 구현: `schema_version 2`, `_migrate` 전진-마이그레이션(quarantine 금지), `_reindex` order 정규화, 손상 시 `heatmap.json.corrupt-<TS>` 백업 후 빈 `HeatmapDocument()` 반환. (단일 watchlist 마이그레이션이 아니라 같은 패턴을 따르는 **두 독립 스토어**.)

### 2.5 ADR-0004 미분류 처리
`folder_id is None` 엔트리는 합성 폴더 객체를 만들지 않고 **render-only "미분류" 그룹**으로 저장(`folder_id: null`). §5(c) 결정에 따라 히트맵 보드는 비어있지 않은 미분류 그룹을 **표시**한다.

---

## 3. API 표면

신규 `hoga/api/heatmap_routes.py::build_router(*, data_dir)`, prefix `/api/heatmap`. watchlist 라우트와 1:1, 단 **모든 `refresh_live_stream` 호출(watchlist_routes에 15곳)과 `next_run_at_ms`, 캡처 라우트 제거**.

| watchlist | heatmap | 차이 |
|---|---|---|
| `GET /api/watchlist` → `WatchlistResponse` | `GET /api/heatmap` → `HeatmapResponse` | `next_run_at_ms` 없음 |
| `POST /api/watchlist` (add) | `POST /api/heatmap` | symbol-master 검증 동일(404 `unknown_code`/409 **`already_in_heatmap`**), **refresh_live_stream 없음** |
| `DELETE /api/watchlist/{code}` | `DELETE /api/heatmap/{code}` | refresh 없음 |
| `POST /api/watchlist/folders` | `POST /api/heatmap/folders` | 동일 |
| `PATCH /api/watchlist/folders/{id}` | `PATCH /api/heatmap/folders/{id}` | 동일 |
| `DELETE /api/watchlist/folders/{id}` | `DELETE /api/heatmap/folders/{id}` | refresh 없음 |
| `PUT /api/watchlist/folders/order` | `PUT /api/heatmap/folders/order` | refresh 없음 |
| `POST /api/watchlist/move` | `POST /api/heatmap/move` | refresh 없음 |
| `PUT /api/watchlist/reorder` | `PUT /api/heatmap/reorder` | refresh 없음 |
| `POST /api/watchlist/remove` | `POST /api/heatmap/remove` | refresh 없음 |
| `POST /api/watchlist/catchup` 등 캡처 | **복제 안 함** | 히트맵 캡처 비구동 |

**공유 헬퍼/모델**: `_mint_folder_id`, `atomic_write_json`, `CODE_PATTERN`(params), `WatchlistFolder`, 모든 폴더/엔트리 요청 바디, symbol-master 조회. 에러 코드 `already_in_heatmap`은 watchlist의 `already_in_watchlist`와 **별도**(프론트 판정 교차오염 방지).

**마운트**: `hoga/api/app.py`의 `build_watchlist_router` 다음 줄에 `app.include_router(build_heatmap_router(data_dir=data_dir))`(screener 라우터 앞).

### 3.1 부팅-시 1회 시드 (결정 1)
- **트리거**: 앱 시작 시 `heatmap.json` **부재**면(버전 범프 의존 **금지**, 파일 존재 여부만) watchlist `load_document`를 **읽어서**(쓰기 0 → watchlist 무손상) folders + entries를 복사, 각 entry는 `HeatmapEntry`로 **캡처 필드 제거** 후 `heatmap.json`에 1회 저장.
- **멱등**: `heatmap.json` 존재 시 시드 skip.
- **위치**: `app.py` 팩토리 또는 `heatmap.py::seed_from_watchlist_if_absent(data_dir)` 헬퍼. 동기 1회(이벤트루프 시작 전 또는 lock 하에).

### 3.2 캡처/라이브 커플링 (확정 — §0 결정 4)
- `hoga/live/live_session.py` `display_ordered_codes`·`_compute_live_set`(Live Set 상위 13) → **watchlist 전용**. 히트맵은 `/api/live/quotes` read-only 폴링이라 KIS WS 구독 비구동.
- `hoga/api/scheduler.py` `_daily_run`·`catchup_one_entry` → **watchlist 전용**.
- finalize 훅 `bump_last_success`(`captures.py`) → **watchlist 전용**.

---

## 4. 프론트엔드

### 4.1 신규 파일
1. `frontend/src/api/heatmap.ts` — 타입(`HeatmapEntry`, `HeatmapFolder`=`WatchlistFolder` 재export 또는 동형, `HeatmapResponse`) + 엔드포인트(`getHeatmap`, `addToHeatmap`, `removeFromHeatmap`, `createHeatmapFolder`, `renameHeatmapFolder`, `deleteHeatmapFolder`, `reorderHeatmapFolders`, `moveHeatmapEntries`, `reorderHeatmapEntries`, `removeHeatmapEntries`).
2. `frontend/src/heatmap/heatmapKeys.ts` — `export const HEATMAP_KEY = ['heatmap'] as const;`(`watchlistKeys.ts` 패턴).
3. `frontend/src/heatmap/useHeatmap.ts` — `useWatchlist.ts` 복제. `useHeatmap()`(queryKey=`HEATMAP_KEY`), `useAddToHeatmap()`, `useMoveHeatmapEntries()`, `useReorderHeatmapEntries()`, `useCreateHeatmapFolder()`, `useRemoveFromHeatmap()` 등. **모든 mutation은 `HEATMAP_KEY`만 무효화**. `useOptimisticWatchlistMutation` 헬퍼 패턴 복제(키만 교체).

### 4.2 갈아타는 파일 (런타임 커플링 — 정확히 2개)
- **`frontend/src/pages/Heatmap.tsx`**
  - `useWatchlist()` → `useHeatmap()`
  - `useCreateFolder()` → `useCreateHeatmapFolder()`
  - `groupByFolder(folders, entries)` — **그대로 재사용**(순수 함수)
  - `GroupNameModal` — **그대로 재사용**, `onSubmit`만 heatmap mutation으로 재지정
  - 문구 5종: `관심맵`→`히트맵`, "관심종목 불러오는 중…"→"히트맵 불러오는 중…", "관심종목을 불러오지 못했습니다."→"히트맵을 불러오지 못했습니다.", "관심종목이 없습니다."→"히트맵이 비어 있습니다.", `{visibleCount}종목` 집계는 §4.4 미분류 포함에 맞춰 동기화
  - `deriveBannerState({status, watchlistSize: entries.length})` — `watchlistSize`를 heatmap entries 길이로(자격증명 배너 신호 그대로 재사용)
- **`frontend/src/heatmap/useAddToFolder.ts`**
  - `import { useAddToWatchlist, useMoveEntries } from '../watchlist/useWatchlist'` → `import { useAddToHeatmap, useMoveHeatmapEntries } from './useHeatmap'`
  - `isAlreadyInWatchlist`(`already_in_watchlist`) → `already_in_heatmap` 판정

### 4.3 공유 유틸 (복제 금지 — 독립성은 store/key/API/mutation 분리이지 순수함수 분리가 아님)
- `watchlist/grouping.ts`(`groupByFolder`, `FolderGroup`, `selectVisibleEntries`, `swapFolderOrder`) — **공유 유지**. (타입 독립을 강하게 원하면 `groupByFolder<TEntry,TFolder>` 제네릭화가 클론보다 나음 — 대안.)
- `heatmap/heat.ts`, `HeatmapRow.tsx` — 변경 불필요.
- `state/heatmapPrefs.ts` — 이미 완전 독립(`heatmap.sortMode`). 무변경.

### 4.4 미분류 표시 (결정 3 — 추가 UI 변경)
- `heatmap/visibleGroups.ts`: `g.folder !== null && g.entries.length > 0` → **`g.entries.length > 0`**(비어있지 않은 미분류 포함). 헤더 카운트도 같은 정의라 자동 동기화.
- `heatmap/HeatmapBoard.tsx`: `key={g.folder!.id}` → `key={g.folder?.id ?? '__uncat__'}`, `folder={g.folder!}` non-null 단언 제거.
- `heatmap/HeatmapFolder.tsx`: 폴더명 `folder?.name ?? '미분류'`, 미분류 그룹은 rename/delete/＋종목 미노출(드로어 패턴과 동일) — null-safe 분기 추가.

### 4.5 Watchlist 영향 없음
- `WatchlistDrawer.tsx`(`App.tsx` `activePanel==='watchlist'` 우측 드로어) — heatmap import 0. **무변경**(관심종목 단독 홈).
- `useWatchlistMembership`·`WatchlistToggleButton`(/live·/screener) — **무변경**.
- `LeftNav` nav 라벨 영문 "Heatmap" — 변경 불필요.

---

## 5. 결정 항목 상세 (사장님 확인용)

§0 표 + 다음 메모. **1·3은 상호잠금** — 시드 복사를 하면서 미분류를 숨기면 시드/추가 종목이 보이지 않으므로, 둘은 함께 채택해야 한다.

- **(1) 시드 ✅확정** — 빈 시작 대안은 234종목+섹터 폴더 수동 재구축 필요. 시드는 watchlist를 **읽기만**(무손상).
- **(2) 캡처 필드 제외 ✅권고** — 필요 시 향후 `schema_version 3+`로 추가 가능.
- **(3) 미분류 표시 ✅권고** — 대안: 계속 숨김 + "추가 시 폴더 강제 지정" UX로 일관성 확보(트레이드오프 명시). 시드 채택 시 숨김은 양립 불가.
- **(4) 캡처/라이브 watchlist 유지 ✅확정** — 히트맵이 라이브 구독을 구동해야 한다는 요구 없음.
- **(5) 관심종목 풀페이지 뷰 미신설 ✅권고** — 분리 후 watchlist는 풀페이지 시각화를 잃음(드로어만). 필요 시 별도 작업으로 `/watchlist` 라우트 추가 가능.

---

## 6. 테스트 계획

### 깨지는 테스트 (수정)
- `pages/Heatmap.test.tsx` — `getWatchlist`/`createFolder` mock → `getHeatmap`/`createHeatmapFolder`, 빈 상태 문구 갱신.
- `pages/Heatmap.newgroup.test.tsx` — `createFolder` → `createHeatmapFolder`.
- `heatmap/useAddToFolder.test.tsx` — `addToWatchlist`+`moveEntries`/`already_in_watchlist` → `addToHeatmap`+`moveHeatmapEntries`/`already_in_heatmap`.

### 살아남는 테스트 (무변경)
`HeatmapBoard.test.tsx`, `HeatmapFolder.test.tsx`(미분류 케이스 추가), `HeatmapRow.test.tsx`, `heat.test.ts`, `FolderAddButton.test.tsx`, `watchlist/grouping.test.ts`, `api/watchlist.test.ts`.

### 신규 테스트
- `heatmap/independence.test.tsx` — `useWatchlist`·`useHeatmap`에 다른 데이터 mock → Heatmap이 heatmap 데이터만 표시.
- `heatmap/heatmapKeys-isolation.test.tsx` — heatmap mutation이 `['watchlist']` 무효화 안 함, watchlist mutation이 `['heatmap']` 무효화 안 함.
- `api/heatmap.test.ts` — `api/watchlist.test.ts` 클론(신규 라우트).
- 백엔드 `tests/test_api_heatmap.py`(+동시성/폴더 클론) — CRUD + **핵심 단언: POST /api/heatmap이 watchlist.json 무변경, refresh_live_stream 미호출, HeatmapEntry에 캡처 필드 없음**.
- `tests/test_heatmap_seed.py` — `heatmap.json` 부재 시 watchlist에서 1회 복사·캡처 필드 제거, 존재 시 미시드(멱등), watchlist 무손상.

---

## 7. 작업량 / 리스크

### 파일 (신규 ~8, 수정 ~8)
- 백엔드 신규: `hoga/api/heatmap.py`, `hoga/api/heatmap_routes.py`, `tests/test_api_heatmap.py`(+동시성/폴더). 수정: `models.py`(3 모델), `app.py`(마운트+시드).
- 프론트 신규: `api/heatmap.ts`, `heatmap/heatmapKeys.ts`, `heatmap/useHeatmap.ts`, 신규 테스트 3개. 수정: `pages/Heatmap.tsx`, `heatmap/useAddToFolder.ts`, `heatmap/visibleGroups.ts`, `heatmap/HeatmapBoard.tsx`, `heatmap/HeatmapFolder.tsx`, 깨지는 테스트 3개.
- 문서: 본 스펙, ADR-0068, CONTEXT.md L186–188(관심맵 정의 "한 Watchlist의" → 독립 리스트), 선행 스펙에 supersede 노트, CHANGELOG + VERSION 범프.

### 리스크
- **데이터 손실**: heatmap.json도 ADR-0065 백업-온-손상. 시드는 watchlist를 **읽기만** → watchlist 무손상.
- **마이그레이션 멱등**: "first run" = `heatmap.json` 부재(버전 범프 의존 금지).
- **VERSION/CHANGELOG 충돌**: 미머지 PR #58/#59가 VERSION 충돌 이력 있음(현재 `0.7.13.3`). 머지 직전 리베이스로 범프 줄 재적용.
- **미분류 가시성 회귀**: 시드+숨김 조합 금지(결정 1·3 동시 채택). §4.4 누락 시 "추가했는데 안 보임" 사일런트 버그.
- **에러 코드 분리**: `already_in_heatmap` ↔ `already_in_watchlist` 교차오염 금지.

---

## 8. 단계별 구현 순서 (의존순)

1. **백엔드 모델** — `models.py`에 `HeatmapEntry`/`HeatmapDocument`/`HeatmapResponse`(캡처 필드 제외, `WatchlistFolder`·요청 바디 재사용).
2. **백엔드 스토어** — `heatmap.py`: watchlist.py 복제 → `_path`=heatmap.json, 자체 `_lock`, migrate/reindex/load/save/folder·entry mutation, `add_entry` 캡처 시드 제거, `bump/set_last_success` 삭제, `_mint_folder_id` import.
3. **시드 헬퍼** — `seed_from_watchlist_if_absent(data_dir)` 멱등 1회 복사 + 그 테스트.
4. **백엔드 API** — `heatmap_routes.py`: watchlist_routes 복제 → 모든 `refresh_live_stream`·`next_run_at_ms`·catchup 제거, `already_in_heatmap`. `app.py` 마운트 + 시드 호출.
5. **백엔드 테스트** — `tests/test_api_heatmap.py`(+동시성/폴더) + `test_heatmap_seed.py`: CRUD + 독립성(watchlist 무영향, refresh 미호출, 캡처 필드 부재) + 시드 멱등.
6. **프론트 store 레이어** — `api/heatmap.ts` → `heatmapKeys.ts` → `useHeatmap.ts`(모든 mutation `HEATMAP_KEY`만 무효화).
7. **프론트 UI 전환** — `Heatmap.tsx`(`useHeatmap`/`useCreateHeatmapFolder`/문구 5종), `useAddToFolder.ts`(heatmap 훅 + `already_in_heatmap`), 미분류 표시(visibleGroups/HeatmapBoard/HeatmapFolder §4.4).
8. **프론트 테스트** — 깨지는 3개 수정 + 신규(independence, key-isolation, api 클론).
9. **문서/버전** — CONTEXT.md L186–188 반전, 선행 스펙 supersede 노트, ADR-0068 accepted, CHANGELOG + VERSION 범프(머지 직전 리베이스).

> **착수 차단 해소됨**: 결정 1·2·3·4·5 모두 확정/권고. 1·3 동시 채택으로 사일런트 버그 회피.

---

## 9. 그릴링 결정 로그 (`/grill-with-docs`, 2026-06-11)

스펙 작성 후 그릴링에서 해소·추가된 결정. 위 본문보다 **이 로그가 우선**.

- **G1 — 정식 명칭 = "히트맵"** (사장님 확정). "관심맵"의 "관심"을 떼서 watchlist 연상을 끊는다. CONTEXT.md L186 용어 `관심맵(Watchlist Heatmap)` → `히트맵`으로 교체(구현 단계), watchlist 정의와 분리. §4.2 헤더 문구 변경(관심맵→히트맵)과 일치.

### `/plan-eng-review` 결정 (G2–G8, 2026-06-11, 코드 그라운딩 워크플로 근거)

각 항목은 **권고(=최적 답)**. ⚠️ 표시는 사장님 veto 권할 만한 항목.

- **G2 — clone vs generalize ⚠️: FULL CLONE(백엔드+프론트), 순수 헬퍼만 import 공유.**
  - 근거: `watchlist.py`(373줄) 70% generic이지만, 일반화하려면 **캡처-크리티컬** 경로를 리팩터해야 함 — `captures.py:887` finalize 훅 `bump_last_success`(매 캡처 성공마다), `scheduler.py:138` reconcile `set_last_success`, lock topology(ADR-0068 rule 1 자체락 요구). → 높은 blast radius. **rule-of-three 미충족**(foldered-list 인스턴스 #2; screener는 시계열·inventory는 read-only, 3번째 없음 → premature abstraction). clone은 **additive·zero-risk**(watchlist.py/captures/scheduler/live_session 무변경), 3번째 리스트 생기면 그때 추출(reversible).
  - DRY 절충(사장님 #1 원칙): generic ~250줄 중복은 `_reindex`·`_mint_folder_id` 같은 **순수·캡처무관 헬퍼를 import 공유**해 일부 상쇄(`_migrate`는 heatmap에 v1 레거시가 없어 불필요). 프론트 중복(useWatchlist 11훅)이 과하면 **hybrid**(훅 팩토리 `(queryKey, apiModule)` 파라미터화, 백엔드는 그대로 clone)로 후퇴 가능 — 백엔드 위험 0으로 DRY 회복.

- **G3 — 히트맵 편집 수단 ⚠️(신규 스코프): 옵션 A, 인라인 보드 편집.**
  - 분리 후 드로어는 watchlist 전용 → 히트맵은 삭제·폴더간이동·폴더rename/delete를 잃음. 보드에 **행 컨텍스트 메뉴(삭제 + 폴더이동)** + **폴더 헤더 메뉴**를 추가. `WatchlistRowMenu`가 watchlist 훅 비의존·준-generic이라 파라미터화 재사용. 재정렬은 이미 인라인. **메뉴 기반 이동이라 멀티칼럼 DnD 복잡도 회피.**
  - 우선순위: **삭제 = MVP 필수**(종목 제거 불가하면 안 됨). 폴더 rename/delete는 2차 패스로 연기 가능(스펙 필수 아님, "heavy"로만 명시). 비용: human ~3–4일 / CC 훨씬 적음.

- **G4 — 우측 레일 코히런스: rightRail 패널 'watchlist'|'screener' 그대로(heatmap 패널 신설 안 함).**
  - /heatmap에선 보드가 편집 표면(G3). 드로어를 열면 watchlist(다른 리스트)를 보여주나 React Query 키 분리로 상호 간섭 0 — 분리 후엔 "두 독립 리스트가 둘 다 접근 가능"이 정상. G3로 드로어 불요. 혼동 우려 시 /heatmap에서 watchlist 토글 숨김은 후속 폴리시(reversible).

- **G5 — 시드 folder-id: verbatim 복사(재발급 안 함).** folder_id는 문서 스코프(`_no_dangling_folder_id` 검증), 크로스-스토어 레지스트리/캐시/로그 키 없음 → 동일 id 안전. 재발급은 entry.folder_id remap 복잡도만 추가.

- **G6 — 시드 "first run" 정의: `heatmap.json` 부재 AND watchlist 비어있지 않을 때만 시드.**
  - 빈 watchlist에 시드하면 `heatmap.json`이 빈 채 생성돼 **영구 미재시드되는 footgun**. 빈 watchlist면 skip, 다음 부팅 재시도. 기존 사용자(235종목)는 즉시 시드, fresh 머신은 watchlist 첫 구성 후 1회 미러(수용 가능).
  - 위치: `app.py` lifespan, `migrate_to_v2_layout` 직후. 로직: `hoga/api/heatmap_store.py::seed_heatmap_from_watchlist(data_dir)`, `load_document`(read-only) 읽어 캡처필드 제거 후 `atomic_write_json`, 멱등(가드 = heatmap.json 존재). 폴더/엔트리 order는 **보존**.

- **G7 — 시세 폴링 스케일: 캡 없음 + 명시 TODO(사일런트 캡 금지).** 235종목=~0.5 req/s로 15-토큰 버킷 여유. 변곡점 ~450종목(15 동시 청크 → 버킷 포화). 구조적 수정 준비됨: `fetch_multi_price`의 gather를 `asyncio.Semaphore(12)`로 바운드(past-candles `kis_client.py:454` 패턴, ~1줄, /live 시세도 공유 혜택). ~350–400 접근 시 적용. 그 전까지 graceful degradation('—')이 커버. **히트맵 종목 수 하드캡은 두지 않음**(독립 큐레이션 자유).

- **G8 — 캡처/라이브 결합(확정·검증): heatmap 라우트는 `refresh_live_stream` 전부 제외.** watchlist_routes의 7개 호출(add/remove/folder-reorder/folder-delete/move/reorder/bulk-remove)은 watchlist 전속. `live_session.display_ordered_codes`(WS live_set 13×N 하드캡)·`scheduler` 일일 enqueue·`captures` finalize 훅 모두 watchlist만 읽음. heatmap은 `/api/live/quotes` read-only 폴링 소비자.
