# Screener 우측 레일 패널 — Design

**Date**: 2026-06-01 (via `/superpowers:brainstorming`, 디자인 컴패니언 시각 확인 후 승인)
**Status**: Draft
**Scope**: frontend — `state/rightRail.ts`, `rightrail/RightRail.tsx`, `App.tsx`, `screener/ScreenerDrawer.tsx`(신규), `state/screenerPanel.ts`(신규), `screener/ChangeCell.tsx`(신규·추출), `ui/FunnelIcon.tsx`(신규), `screener/ResultTable.tsx`, 관련 테스트; `docs/adr/0052` 갱신

## Problem

사용자 표현:

> "여기서 만든 조건 리스트가 우측 사이드 패널에 관심종목 밑에 스크리너 항목을 신규로 만들고, 여기서는 만든 조건 리스트를 선택하고 조회를 누르면 검색 결과가 리스트로 나오고, 이를 클릭하면 차트가 해당 종목으로 변경하도록 하고 싶어."

현재 스크리너 조회는 `/screener` 전체 페이지에서만 가능하다. 차트(`/live`)를 보면서 "저장한 조건으로 빠르게 스캔 → 결과 클릭해서 차트 전환"하는 경로가 없다. 관심종목은 우측 레일을 통해 앱 전역에서 쓰지만(ADR-0052), 스크리너는 그런 전역 접근 표면이 없다.

## Invariants

- **Right Rail 단일 선택 패널 컬럼**: App 그리드의 패널 컬럼은 0개 또는 1개이고, 그리드 트랙 수 == 렌더된 자식 수(닫힘 3, 열림 4). 근거: [App.tsx:18-21](../../../frontend/src/App.tsx#L18-L21), [ADR-0052](../../adr/0052-global-right-rail-state-store.md).
- **rightRail 영속 상태 엄격 검증**: 손상/수기편집된 값이 상태로 새지 않는다(현재 `panelOpen`은 진짜 boolean만 수용; `0`·`"1"` 등 거부). 근거: [rightRail.ts:30-38](../../../frontend/src/state/rightRail.ts#L30-L38).
- **차트 종목 단일 진실 공급원**: 모든 종목 선택은 `useLivePageStore.setActiveCode(code)` 한 곳으로 라우팅되어 차트가 리렌더된다. 근거: [livePage.ts](../../../frontend/src/state/livePage.ts), [WatchlistDrawer.tsx:22-25](../../../frontend/src/watchlist/WatchlistDrawer.tsx#L22-L25).
- **change_pct 표시 규칙**: KRX 색(>0 빨강 `text-price-up`, <0 파랑 `text-price-down`, 0 중립, `null`→"—") + ▲▼ 글리프(색각 보조). 근거: [ResultTable.tsx:13-19](../../../frontend/src/screener/ResultTable.tsx#L13-L19).
- **저장 조건검색 mutation 안전 의미론**: create/overwrite/rename/delete의 anchor·dirty·data-loss 가드. 근거: [SavedScreenerList.tsx](../../../frontend/src/screener/SavedScreenerList.tsx), [2026-06-01-screener-popover-redesign-design.md](2026-06-01-screener-popover-redesign-design.md).
- **스크리너 캐시 공유**: 저장 목록(`useSavedScreeners`)·상태(`useScreenerStatus`)는 react-query 캐시 키로 공유되어 페이지·표면 간 자동 동기화된다. 근거: [useSavedScreeners.ts](../../../frontend/src/screener/useSavedScreeners.ts).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 단일 선택 패널 컬럼 | preserves | enum도 한 번에 하나만 열림(관심⊕스크리너). 그리드 공식은 `panelOpen` → `activePanel !== null` 한 단어 수정. |
| 영속 상태 엄격 검증 | preserves | 검증을 enum 화이트리스트로 확장; 레거시 boolean을 안전하게 마이그레이션(아래 §1). |
| 차트 단일 공급원 | preserves | 패널 결과 클릭도 동일하게 `setActiveCode` 사용. |
| change_pct 표시 규칙 | preserves | `ChangeCell`을 공유 컴포넌트로 추출 → 페이지·패널이 포맷에서 드리프트 불가(강화). |
| 저장 mutation 안전 | preserves | 패널은 **read-only**: 저장 목록 조회·선택만 하고 create/rename/overwrite/delete를 하지 않음. |
| 캐시 공유 | preserves | 동일 react-query 훅 재사용. 패널 전용 스캔 mutation만 독립. |

*"intentionally breaks" 없음.* 모든 변경이 기존 속성을 보존하며, enum 전환은 단일-패널-컬럼 불변량을 깨지 않는 방식(상호배타)으로 한 것이다.

## Goals

- 우측 레일에 `관심` 아래 `스크리너` 항목 추가. 클릭 시 전용 패널이 열린다(관심 ⊕ 스크리너 = 상호배타, 한 번에 하나).
- 패널에서: 저장한 조건 **드롭다운 선택** → **조회** → 결과 리스트(`코드 · 종목명 · 등락률`) → **행 클릭 시 해당 종목으로 차트 전환**(필요 시 `/live`로 이동).
- 결과는 **패널 닫기·라우트 이동에도 유지**(세션 메모리), **브라우저 새로고침 시 비움**.
- 마지막 선택한 조건은 **영속**(localStorage)되어 재오픈 시 복원.
- **갱신 버튼 + 신선도 칩**을 패널에도 포함(전체 페이지와 기능 동등).
- 백엔드 변경 0(기존 API/훅 전부 재사용).

## Non-Goals (YAGNI)

- 패널 내 조건 편집/저장 — 빌더는 `/screener` 전체 페이지에만 둔다.
- 결과 행의 `♥`(관심추가)·`📥`(캡처) 액션 — 패널 행 클릭은 차트 전환만.
- 결과의 localStorage 영구 저장 — 시세(현재가·등락률) 스냅샷이라 새로고침 후 stale가 오해를 유발.
- 패널과 전체 페이지의 스캔 상태 공유 — 각자 독립 `useScreener` mutation.
- 다중 패널 동시 열림 — 그리드 단일 패널 컬럼 불변량 보존.

## Design

### 1. 레일 크롬 상태 — `state/rightRail.ts`

- `panelOpen: boolean` → **`activePanel: 'watchlist' | 'screener' | null`**.
- `lastPanel: 'watchlist' | 'screener'`(메모리, 기본 `'watchlist'`) — 셰브론 복원용.
- 액션:
  - `setActivePanel(p: 'watchlist' | 'screener' | null)`
  - `togglePanel(p)` — `p === activePanel ? null : p`. 여는 경우 `lastPanel = p`.
  - `toggleCollapse()` — `activePanel ? null : lastPanel`(셰브론 동작).
- 영속: **`activePanel`만** 저장. 검증은 화이트리스트 `'watchlist' | 'screener' | null`만 수용(그 외 무시 — 기존 엄격 검증 정신 유지).
- **레거시 마이그레이션**: 기존 키 `rightRail.layout`의 `{ panelOpen: true }` → `'watchlist'`, `{ panelOpen: false }`·없음·손상 → `null`. (기존 사용자의 "관심 패널 열림" 상태가 깨지지 않게.)
- `lastPanel`은 영속하지 않는다 — 새로고침 후 셰브론 복원은 항상 `watchlist`(단순; §Risks).

### 2. 레일 항목 — `rightrail/RightRail.tsx`

- 기존 `관심` 버튼 아래 `스크리너` 버튼 추가: 신규 `FunnelIcon` + 라벨 `스크리너`.
- 각 항목 버튼: `onClick = togglePanel('watchlist' | 'screener')`; active 하이라이트(틸 배경 `bg-tint-selection` + 중립 텍스트 — 관심과 동일, 트리플-틸 금지); `aria-controls`는 각 패널 id, `aria-pressed = activePanel === <자기>`.
- 셰브론: `onClick = toggleCollapse()`; `aria-expanded = activePanel !== null`; 글리프 `activePanel ? '»' : '«'`.

### 3. App 그리드 — `App.tsx`

- `cols = \`var(--nav-w) 1fr${activePanel ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)\``.
- 렌더: `{activePanel === 'watchlist' && <WatchlistDrawer />}` 와 `{activePanel === 'screener' && <ScreenerDrawer />}`. (트랙 수 == 자식 수 불변량 유지.)

### 4. 스크리너 패널 스토어 — `state/screenerPanel.ts`(신규)

`rightRail.ts`와 동일한 "모듈 로드 시 동기 read + 부분 영속" 패턴.

```
selectedSavedId: string | null                                   // 영속(localStorage)
lastScan: { savedId: string; savedName: string;
            rows: ScreenerRow[];
            scanStatus: ScreenerResponse['status'];              // 'ok'|'not_seeded'|'building'
            warnings: string[] } | null                          // 메모리만
setSelectedSavedId(id: string | null): void                      // 영속 갱신
setLastScan(scan): void
clearScan(): void
```

- `selectedSavedId`만 localStorage에 영속. `lastScan`은 메모리 — 닫기/라우트 이동에는 살아남고 새로고침엔 소실(Goals의 결과 유지 정책).
- **두 status를 구분**: `lastScan.scanStatus`는 **스캔 응답**의 [`ScreenerResponse.status`](../../../frontend/src/api/screener.ts#L42-L46)(`'ok'|'not_seeded'|'building'`)다. 신선도 칩이 쓰는 [`ScreenerStatus`](../../../frontend/src/api/screener.ts#L48-L53)(별도 interface, `last_raw_date`/`days_behind` 등)는 `useScreenerStatus()`로 라이브로 읽으며 스토어에 담지 않는다.

### 5. ScreenerDrawer — `screener/ScreenerDrawer.tsx`(신규)

폭·크롬은 `WatchlistDrawer`와 동일(`--watchlist-panel-w`, `border-left`, `overflow:auto`, `bg-card`).

- **헤더**: `스크리너` 라벨 + `StalenessChip`(재사용, `useScreenerStatus`) + `갱신` 버튼(`triggerScreenerUpdate` mutation — [Screener.tsx:68,84](../../../frontend/src/pages/Screener.tsx#L68) 패턴).
- **드롭다운**(`<select>`): `useSavedScreeners()` → `saves`. `value = selectedSavedId`. `onChange = setSelectedSavedId`.
  - 마운트 시 `selectedSavedId` 복원: 그 id가 `saves`에 존재하면 유지, 삭제됐거나 없으면 **첫 save로 폴백**, `saves`가 0개면 `null`.
- **조회 버튼**: 선택된 save의 `{ conditions, universe }`로 `useScreener().mutate(...)`. `onSuccess` → `setLastScan({ savedId, savedName, rows, scanStatus, warnings })`. 선택 없음이거나 `not_seeded`이면 `disabled`. `not_seeded` 판정은 페이지([Screener.tsx:70](../../../frontend/src/pages/Screener.tsx#L70))처럼 `useScreenerStatus().data?.status === 'not_seeded' || lastScan?.scanStatus === 'not_seeded'`로 OR(첫 조회 전에도 라이브 status로 비활성 가능).
- **결과 영역**: `lastScan.rows` 렌더. 작은 캡션 `결과 N · {savedName}`. `selectedSavedId !== lastScan.savedId`일 때 작은 힌트 `선택한 조건과 다름 — 조회로 갱신`(should-have).
  - 행: `코드 · 종목명 · 등락률`(공유 `ChangeCell`). `role="button"` + `tabIndex={0}` + Enter/Space. `onClick` → `setActiveCode(code); if (pathname !== '/live') navigate('/live')`. active 행 하이라이트(`code === activeCode`) — 관심종목 행 패턴 그대로.
- **빈/엣지 상태**:
  - `saves` 0개: 드롭다운 플레이스홀더 + `저장된 조건이 없습니다 — Screener 페이지에서 만드세요`, 조회 `disabled`.
  - `not_seeded`: 짧은 `시드 필요` 메시지 + 조회 `disabled`.
  - 조회 중: `조회 중…`. 실패: `조회 실패` + `error.message`. 결과 0건: `조건에 맞는 종목이 없습니다.`

### 6. 공유 추출

- [ResultTable.tsx](../../../frontend/src/screener/ResultTable.tsx)의 `ChangeCell`을 `screener/ChangeCell.tsx`로 추출하고 페이지·패널 양쪽에서 import(change_pct 포맷 드리프트 방지 — 최근 커밋들이 보여주듯 finicky).
- `ui/FunnelIcon.tsx` — `HeartIcon` 패턴(`viewBox="0 0 24 24"`, `stroke="currentColor"`, 깔때기/필터 path). 글리프는 DESIGN.md(minimal-intentional) 준수.

### 7. ADR

[ADR-0052](../../adr/0052-global-right-rail-state-store.md) 갱신: 레일이 항목 2개(`관심`·`스크리너`)로 늘고, 크롬 상태가 boolean `panelOpen` → enum `activePanel`로 바뀌며, 레거시 마이그레이션을 한다는 노트. (갱신 vs 신규 ADR 분리는 구현 계획에서 판단.)

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| rightRail 전환 | `togglePanel('screener')` after `'watchlist'` open | `activePanel='screener'`, `lastPanel='screener'` |
| rightRail 동일항목 토글 | `activePanel='watchlist'`, `togglePanel('watchlist')` | `null` |
| rightRail 셰브론 복원 | `lastPanel='screener'`, `activePanel=null`, `toggleCollapse()` | `'screener'` |
| 레거시 마이그레이션 | localStorage `{panelOpen:true}` | `activePanel='watchlist'` |
| 손상값 거부 | localStorage `{activePanel:'foo'}` / `{panelOpen:0}` | `activePanel=null`(기본) |
| screenerPanel 영속 | `setSelectedSavedId('x')` → 재로드 | `selectedSavedId='x'` 복원 |
| screenerPanel lastScan 비영속 | `setLastScan(...)` → 재로드 | `lastScan=null` |
| RightRail 렌더 | — | 항목 2개, 각 active 하이라이트, `aria-controls`/`-pressed`/`-expanded` 정확 |
| ScreenerDrawer 드롭다운 | `useSavedScreeners` mock | saves가 옵션으로 채워짐, 선택 복원/폴백 |
| ScreenerDrawer 조회 | 선택 후 조회 클릭 | 선택 save의 `conditions/universe`로 `mutate` 호출 |
| ScreenerDrawer 결과 클릭 | 결과 행 클릭(현재 `/inventory`) | `setActiveCode(code)` + `navigate('/live')` |
| ScreenerDrawer not_seeded | status `not_seeded` | 조회 `disabled` + 메시지 |
| ScreenerDrawer 저장0 | `saves=[]` | 안내 메시지 + 조회 `disabled` |
| 결과 유지 | 조회 후 패널 닫았다 열기 | 스토어 `lastScan` 기반으로 결과 유지 |
| ChangeCell 추출 | null / +2.1 / -1.2 | "—" / 빨강 ▲ / 파랑 ▼ — 페이지·패널 동일 |

**Invariant 회귀 테스트**: (1) App 그리드 트랙 수 == 자식 수(닫힘 3·열림 4) — `activePanel` 각 값에서. (2) 영속 검증 — 화이트리스트 외 값이 상태로 새지 않음. (3) 결과 클릭이 `setActiveCode`를 거침. (4) 페이지·패널 `ChangeCell` 동일 출력.

기존 watchlist/rail 테스트는 `panelOpen` → `activePanel` enum으로 갱신한다.

### Manual verification

- `/live`에서 레일 `스크` 클릭 → 패널 열림 → 드롭다운 선택 → 조회 → 결과 클릭 → 차트 전환.
- `/inventory` 등 다른 화면에서 조회 → 결과 클릭 → `/live` 이동 + 차트 전환.
- 패널 닫았다 열기 → 결과 유지. 새로고침 → 결과 비고, 선택은 복원.
- 관심 ↔ 스크 상호배타 전환. 셰브론 collapse/복원.
- 기존 사용자(레거시 `panelOpen:true`) → 관심 패널이 열린 채 정상 동작.

## Risks / Open questions

- `lastPanel` 비영속 → 새로고침 후 셰브론 복원이 항상 `watchlist`. 수용(단순); 필요 시 영속으로 보강.
- 패널 unmount 중 in-flight 스캔 → 그 스캔 결과 유실(재조회 필요). 수용(드문 엣지).
- `FunnelIcon` 최종 글리프는 DESIGN.md 준수 — 구현 시 미세 조정.
- ADR-0052 갱신 vs 신규 ADR 분리 — 구현 계획에서 결정.

## Out of Scope (Backlog)

- 패널 결과 정렬/필터.
- 결과 행에 현재가/거래대금 추가 표시(현재 등락률만).
- 패널 폭 조절 / lastPanel 영속.
