# Inventory Tree (Master-Detail) — Design

**Date:** 2026-05-24
**Scope:** `frontend/src/pages/Inventory.tsx` 및 신규 `frontend/src/inventory/` 모듈
**Status:** Draft — 사용자 검토 대기

## Problem

현재 `/inventory` 페이지는 `StockDate` 행을 평탄 테이블로 보여준다. 같은 종목을 여러 날 캡처하면 종목명·코드가 반복 노출되어 "이 종목을 며칠치 모았는가" 같은 종목 단위 질문에 답하기 어렵다. 또한 검색 기능이 없어, 많은 종목이 누적되면 원하는 종목을 찾기 위해 스크롤·정렬에 의존해야 한다.

## Goals

1. 같은 종목의 캡처 이력을 한 그룹으로 묶어 종목 단위 탐색을 자연스럽게 한다.
2. 종목명/코드 한 입력창으로 빠르게 좁힐 수 있는 검색을 제공한다.
3. 기존 replay 진입 흐름(행 클릭 → 새 탭 생성 → `/replay`)을 깨지 않는다.
4. DESIGN.md(Modern Trading Lab)의 토큰·밀도·색 절제 원칙을 유지한다.

## Non-Goals

- 백엔드 집계 API 신설 — 클라이언트에서 `StockDate[]`를 그룹화.
- 다중 종목 선택, 다중 정렬축, 컬럼별 정렬, 가상 스크롤, 키보드 네비게이션.
- 좌·우 패널 너비 조절, density 토글, 다중 탭 열기.
- localStorage 기반 마지막 선택 종목 복원 — v1에서는 매 진입마다 정렬 첫 항목 자동 선택.

## Layout — Master-Detail

대체 패턴(클래식 indented tree, collapsible group header)을 비교한 끝에 **Master-Detail**을 채택한다. 종목 탐색(좌)과 날짜별 데이터 비교(우)를 명확히 분리해, 종목 검색과 캡처 상세 보기를 한 화면에서 별도 컨텍스트로 다룰 수 있게 한다.

```
┌──────────────────── /inventory ────────────────────┐
│ ┌────────────────┐ ┌─────────────────────────────┐ │
│ │ 종목 N개 ·     │ │ 005930  삼성전자            │ │
│ │ 캡처 M건       │ │ 3 dates · 142.3M vol · 38.7│ │
│ │ ────────────── │ │ ───────────────────────────│ │
│ │ [search input] │ │ Date  Captured  Vol  Pages │ │
│ │ ────────────── │ │ Size  OHLC                 │ │
│ │ ⬢ 005930      │ │ 2026-05-22 …               │ │
│ │   삼성전자  3  │ │ 2026-05-21 …               │ │
│ │   최근 05-22   │ │ 2026-05-20 …               │ │
│ │ ○ 000660      │ │                            │ │
│ │   SK하이닉스 2 │ │                            │ │
│ │ ○ 035720      │ │                            │ │
│ │   카카오    3  │ │                            │ │
│ └────────────────┘ └─────────────────────────────┘ │
│   320px              1fr                            │
└─────────────────────────────────────────────────────┘
```

### Page shell — `Inventory.tsx`

```tsx
<div className="p-md h-full grid gap-md" style={{ gridTemplateColumns: '320px 1fr' }}>
  <StockDateGroupList … />
  <StockDateGroupDetail … />
</div>
```

좌·우 카드 각자 `overflow-y-auto`. 페이지 자체는 스크롤하지 않는다.

## New Domain Concept — `StockDateGroup`

```ts
// frontend/src/inventory/types.ts
export type StockDateGroup = {
  code: string;               // 그룹 키 (Code = 6-digit KRX ticker)
  name: string;               // 종목명
  dates: StockDate[];         // date desc 정렬된 자식 행
  lastCapturedAt: number;     // max(captured_at) — 좌측 정렬 키
  totalSizeBytes: number;     // sum(file_size_bytes) — 좌측 표시값
  // dateCount는 dates.length로 derive
};
```

`StockDateGroup`은 `StockDate[]`를 `Code` 단위로 압축한 단일 레벨 트리의 루트다. 자식은 `StockDate`(기존 타입) 그대로. 이름은 CONTEXT.md의 canonical `Stock-Date` 위에 compound로 얹는다 — bare "Stock"은 _Avoid_, 무엇이 그룹화되는지 명시한 compound 형태(`StockDateGroup`)를 따른다.

## Module Layout

```
frontend/src/pages/Inventory.tsx        # 얇은 페이지 컨테이너
frontend/src/inventory/
  ├── types.ts                          # StockDateGroup
  ├── useStockDateGroups.ts             # StockDate[] → StockDateGroup[] (그룹화·정렬·필터)
  ├── StockDateGroupList.tsx            # 좌측: 검색창 + 종목 리스트
  ├── StockDateGroupListItem.tsx        # 좌측 항목 (2줄)
  └── StockDateGroupDetail.tsx          # 우측: 헤더 + 날짜 테이블
```

각 모듈의 책임:

- `useStockDateGroups(rows, search)` — 순수 함수형 hook. 그룹화·집계·정렬·검색 필터를 `useMemo`로 1회 계산. 테스트 용이.
- `StockDateGroupList` — 검색 입력 상태와 active 항목 강조 담당. 외부에 `selectedCode`/`onSelect` 노출.
- `StockDateGroupListItem` — 시각 표현만. props로 group + active 받음.
- `StockDateGroupDetail` — `selectedCode`로 그룹을 찾아 헤더 + 날짜 테이블 렌더링. 행 클릭 시 기존 `useTabsStore.newTab()` + `navigate('/replay')` 흐름 재사용.

## Data Flow

```
useStockDates() ── StockDate[] ──┐
                                 ├─► useStockDateGroups(rows, search) ─► StockDateGroup[]
search input (useState) ─────────┘                                  │
                                                                    ▼
                  ┌─── StockDateGroupList ──► StockDateGroupListItem
                  │                       (onSelect(code))
                  ▼
            selectedCode (useState<string | null>)
                  │
                  ▼
            StockDateGroupDetail (해당 그룹의 dates 테이블)
```

## `useStockDateGroups` 동작

1. **그룹화**: `code`를 키로 `Map<string, StockDate[]>` 누적.
2. **자식 정렬**: 각 그룹의 `dates`를 `date desc`로 정렬.
3. **집계**: `lastCapturedAt = max(captured_at)`, `totalSizeBytes = sum(file_size_bytes)`, `name`은 첫 행에서 차용(같은 code면 동일 가정).
4. **부모 정렬**: `lastCapturedAt desc`.
5. **검색 필터**: 검색어를 `trim().toLowerCase()` 정규화 후 `name.toLowerCase().includes(q) || code.includes(q)` 매칭. 한 입력창에서 한글·코드 모두 매칭.

## Search Behavior

- 입력창은 좌측 카드 상단 sticky.
- 디바운스 없음 — 클라이언트 필터링이므로 즉시 반영.
- 입력값 있으면 우측 작은 `×` 클리어 버튼 표시.
- 검색 활성 시 검색창 아래 `"N matches"` (xs · text-fg-dimmer).
- 검색 결과가 0이어도 **우측 패널은 마지막 선택 종목을 유지**(좌측 비어 보여도 컨텍스트 손실 방지).
- 검색이 진행 중일 때 `selectedCode`가 필터 결과에 없어도 우측은 그대로. 검색 클리어 시 자연히 다시 좌측에 나타난다.

## Click / Selection Behavior

| 위치 | 동작 |
|---|---|
| 좌측 종목 항목 | `setSelectedCode(code)` — **선택만**, navigate 안 함. |
| 우측 날짜 행 | 기존과 동일: `useTabsStore.newTab()` → `setSelection({ code, fromDate: date, toDate: date, timeframe: '1m' })` → `navigate('/replay')`. |

좌측 클릭이 replay로 가지 않는 이유: inventory는 "둘러보고 고르는 도구"이며, 다른 날짜로 옮길 때마다 리스트가 사라지면 안 된다.

## Initial Selection

- 마운트 시 `selectedCode === null`. `useEffect`로 `rows.length > 0 && selectedCode === null`이면 **unfiltered 정렬 첫 그룹**(검색 무시 — 마운트 직후 빈 검색어와 동치이지만, 향후 URL 쿼리에서 초기 검색어를 받는 변경이 들어와도 안전하도록 명시적으로 unfiltered groups를 사용)을 세팅.
- 우측 패널은 `selectedCode`를 **전체 `rows`에서 그룹을 다시 만들어** 조회한다(필터된 `groups`가 아님). 따라서 검색으로 좌측에서 사라져도 우측은 그대로 유지된다.
- 검색·데이터 변경 후에도 `selectedCode`가 전체 데이터에 여전히 없으면(예: 다른 곳에서 캡처가 삭제됨) `groups[0].code`로 fallback.

## Visual Spec — DESIGN.md 토큰 매핑

### 좌측 컨테이너

- `bg-bg-card` + `border` + `rounded-lg`
- 검색창: `bg-bg-input` + `border` + `rounded-md` + `px-3 py-1.5` + `font-mono text-sm`, placeholder `"종목명 또는 코드…"`.
- 항목 컨테이너: `px-3 py-2`, hover `bg-bg-input-hover`, active `background: rgba(20,184,166,0.12)` (DESIGN.md selection tint).

### 좌측 항목 — 2 lines

```
[code(accent, mono)] [name(fg)]                       [N(font-mono tabular-nums)]
[최근 MM-DD (xs, fg-dim)]                            [XX.X MB (xs, fg-dim, tabular)]
```

### 우측 컨테이너

- `bg-bg-card` + `border` + `rounded-lg` + `p-md`.
- 헤더: `text-accent font-mono` 코드 + `text-fg` 종목명, 우측 small-caps 요약(`text-xs text-fg-dim`).
- 구분선: `border-b border-border`.
- 테이블: 기존 `font-mono text-sm tabular-nums` 그대로. 컬럼 헤더는 비-인터랙티브 라벨(`text-xs uppercase tracking-wider text-fg-dimmer`).
- 컬럼: `Date · Captured · Volume · Pages · Size · OHLC` (Code/Name 제거).

## State Map

| 상황 | 처리 |
|---|---|
| `isLoading` | 좌·우 카드 자리에 각각 `"Loading inventory…"` (`text-fg-dim`). |
| `rows.length === 0` (전체 비어있음) | 두 카드 대신 중앙에 기존 메시지 `"캡처된 데이터가 없습니다."`. |
| `groups.length === 0` (검색 결과 0) | 좌측에 `"검색 결과 없음"`, 우측은 마지막 선택 종목 유지. |
| `selectedCode === null` (초기 1프레임, `useEffect` 발화 전) | 우측 `"종목을 선택하세요"` placeholder. |
| `selectedCode`가 전체 데이터에 없음 (캡처 삭제 등) | 정렬 첫 항목으로 fallback. |

## Migration Impact

- 라우트 `/inventory` 동일.
- `useStockDates()` API 변경 없음. 백엔드 무수정.
- `useTabsStore` 변경 없음. Tab cap(DESIGN.md "Soft cap: 8 tabs") 처리는 기존 store에 위임 — inventory 측에서 별도 분기 없음.
- DESIGN.md 추가 토큰 불필요 — 기존 토큰만 사용.
- 기존 `Inventory.tsx`의 `fmtDate / fmtTime / fmtSize / fmtOHLC` 유틸은 `inventory/format.ts`로 옮겨 두 컴포넌트가 공유.

## Testing

| 레벨 | 파일 | 검증 |
|---|---|---|
| 단위 | `frontend/src/inventory/useStockDateGroups.test.ts` | 그룹화, lastCapturedAt 집계, totalSizeBytes 합, 부모/자식 정렬, 검색 필터(한글·코드·대소문자·trim) |
| 컴포넌트 | `frontend/src/inventory/StockDateGroupList.test.tsx` | 검색 입력 시 필터링, 항목 클릭 시 `onSelect` 호출, active 항목 클래스, 빈 결과 메시지 |
| 컴포넌트 | `frontend/src/inventory/StockDateGroupDetail.test.tsx` | 선택 변경 시 재렌더, 행 클릭 시 `useTabsStore.newTab` + `navigate` 호출 (mock) |
| E2E (smoke) | `frontend/tests/e2e/inventory-tree.spec.ts` | "삼" 입력 → 좌측 필터 → 항목 클릭 → 우측 테이블 표시 → 행 클릭 → `/replay` 이동 |

## Out of Scope (Future)

- 좌측 항목에 volume 스파크라인 (Rich density 패턴) — 디자인 단계에서 제외.
- 검색 퍼지/공백 무시 매칭.
- 좌측 정렬 토글 (이름순/date 수순).
- 컬럼별 정렬 (현재 v1에서는 우측 헤더 비-인터랙티브).
- 키보드 네비게이션 (↑/↓로 종목 이동, Enter로 우측 첫 행 열기).
- 다중 선택, 다중 탭 동시 열기.
- **Grouping 로직 공유** — `StockCombobox.tsx:13-20`이 이미 `Map<code, {code, name, dates}>` 형태의 동일 그룹화를 수행 중. 본 spec의 `useStockDateGroups`는 더 풍부한 집계(`lastCapturedAt`, `totalSizeBytes`)와 검색 필터를 포함하므로 별 hook으로 출발하되, `/improve-codebase-architecture` 단계에서 공통 코어 추출 가능성을 평가한다.

## Decisions Log

| 결정 | 근거 |
|---|---|
| Master-Detail (vs indented tree, collapsible group) | 종목 탐색과 날짜 상세를 명확히 분리. 좌측 검색 시 컨텍스트 손실 없음. |
| 좌측 항목 Medium density (vs Compact, Rich) | 종목 선택 전 컨텍스트(최근 캡처일·총 크기) 제공하면서도 밀도 유지. Rich는 스파크라인 시각 가치 대비 밀도 손실 큼. |
| 검색: 종목명 + 코드 | 한글 부분 매칭과 코드 prefix 매칭을 한 입력창에서 처리. 퍼지 매칭은 노이즈 우려로 제외. |
| 검색 결과 0일 때 우측 유지 | 분석 컨텍스트 손실 방지. 검색은 좁히는 도구, 보고 있던 상세를 지우는 도구가 아님. |
| 좌측 클릭은 선택만 | inventory는 둘러보기 도구. 자동 navigate 시 다른 날짜 탐색마다 리스트가 사라짐. |
| 정렬: lastCapturedAt desc, 단일축 | "최근 작업 이어서"가 주 사용 패턴. 다중 정렬은 YAGNI. |
| 클라이언트 그룹화 (vs 서버 집계) | 종목 수 수천 단위까지 한 번에 받아도 충분. 백엔드 API 변경 비용 회피. |
