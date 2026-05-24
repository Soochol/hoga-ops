# Inventory 우측 캡처 테이블 — 컬럼 정렬

상태: 승인 대기
일자: 2026-05-25
범위: 프론트엔드 (`/inventory` 우측 패널)

## 요약

`/inventory` 페이지의 우측 캡처 테이블([StockDateGroupDetail.tsx](../../../frontend/src/inventory/StockDateGroupDetail.tsx))에 컬럼 헤더 클릭으로 작동하는 정렬 기능을 추가한다.

현재 우측 테이블은 `date desc` 고정 정렬이다. 사용자는 거래량이 큰 날, 가장 오래된 캡처, 또는 디스크 상태가 비정상인 행을 찾을 때마다 시각적으로 스캔해야 한다. 컬럼 정렬은 이 마찰을 제거한다.

## 비범위 (Out of Scope)

- 좌측 종목 그룹 리스트의 정렬 컨트롤
- URL 영속화 (쿼리스트링)
- 다중 컬럼 정렬
- 필터링/검색 (정렬과 별개 작업)
- 사용자별 정렬 기본값 저장 (백엔드 영속화)

## 사용자 가치

- "어제 거래량 폭증한 날 다시 보고 싶다" → Volume desc 한 번 클릭
- "데이터 누락된 날만 빨리 확인하고 싶다" → State desc → invalid/incomplete 가 상단
- "가장 오래된 캡처부터 보고 싶다" → Date asc

## 인터랙션 모델

### 토글 순환 (3-state)

각 컬럼 헤더는 다음 상태를 순환한다.

```
unsorted → desc (▼) → asc (▲) → unsorted → ...
```

- 다른 컬럼 헤더를 클릭하면 그 컬럼이 **desc(첫 단계)**로 점프하고, 이전 컬럼은 unsorted로 복귀
- 단일 컬럼 정렬. **다른 키**(예: Volume, State)로 정렬할 때 동률(tie)이 발생하면 보조 정렬 `date desc`로 안정성 확보. Date 컬럼 자체를 정렬할 때는 보조 정렬을 적용하지 않음(자기 자신과의 모순 회피).
- `unsorted` 상태에서는 **기본 정렬 = `date desc`** (현재 동작과 동일)

### 영속성

- 컴포넌트 lifecycle 내에서 유지 (`useState`)
- 좌측에서 다른 종목을 선택해도 정렬 상태 유지 — `StockDateGroupDetail`은 unmount되지 않음
- 새로고침 / 페이지 재진입 시 기본값(unsorted = date desc)으로 리셋

## 컬럼별 정렬 규칙

| 컬럼 헤더 | 정렬 키 | 첫 클릭 방향 | 비교 방법 |
|---|---|---|---|
| State | `disk_state` (severity) | desc | `STATE_SEVERITY` rank (도메인 순서) |
| Date | `date` | desc | YYYY-MM-DD 문자열 비교 |
| Captured | `captured_at` | desc | number (ms epoch) |
| Volume | `total_volume` | desc | number |
| Pages | `pages_collected` | desc | number |
| Size | `file_size_bytes` | desc | number |
| OHLC | `today_close` | desc | number (OHLC는 **종가 단일 키** — `fmtOHLC`가 종가를 주값으로 표시하는 관행과 일치) |

**State 컬럼의 severity 순서**는 도메인 용어 **Disk State Severity**(CONTEXT.md 참조)를 따른다. [DiskStateBadge.tsx](../../../frontend/src/inventory/DiskStateBadge.tsx)의 `aggregateDiskState`가 이미 묵시적으로 사용하던 순위를 명시적 SSOT로 격상한다.

```
invalid > client_incomplete > source_partial > complete
```

`STATE_SEVERITY: Record<DiskStateValue, number>` 상수를 `DiskStateBadge.ts`에 export하고, `aggregateDiskState`와 `sortDates` 두 곳이 같은 객체를 참조한다 — Disk State Severity 순서를 바꾸려면 한 줄만 수정하면 된다.

## 시각 사양

기존 `<Th>` 컴포넌트를 `<SortableTh>`로 확장한다. DESIGN.md 토큰만 사용하며, 새 아이콘 라이브러리 의존성은 추가하지 않는다.

### 헤더 상태별 표시

| 상태 | 텍스트 색상 | 아이콘 | 비고 |
|---|---|---|---|
| unsorted (기본) | `text-fg-dimmer` (현행) | `▲▼` 미리보기, `opacity-0` | hover 시 `opacity-30` 어포던스 |
| 활성 desc | `text-fg` | `▼` (`accent` 색) | `aria-sort="descending"` |
| 활성 asc | `text-fg` | `▲` (`accent` 색) | `aria-sort="ascending"` |

- 아이콘 자리는 항상 차지하여 layout shift를 방지한다
- 아이콘은 텍스트 문자(`▲`/`▼`) 사용 — 헤더가 이미 `font-mono`이므로 일관됨
- 헤더 셀 전체가 클릭 영역 (`<button type="button">`), 키보드 포커스 가능, `Enter`/`Space`로 토글
- `aria-sort` 속성으로 스크린리더 지원
- **OHLC 헤더는** `title="종가 기준 정렬"` tooltip을 추가하여 정렬 키 모호성 해소

### 우상단 메타 라인

[StockDateGroupDetail.tsx:50-52](../../../frontend/src/inventory/StockDateGroupDetail.tsx#L50-L52)의 집계 표시(`N dates · vol · size`)는 **변경 없음**. 정렬은 표시 순서만 바꾸고 집계값은 동일하다.

## 아키텍처

### 상태 관리 위치

`StockDateGroupDetail` 컴포넌트 내부의 `useState`.

근거:
- 요구사항이 "세션 내 유지, 새로고침 시 리셋"이므로 zustand store / URL 모두 과한 도구
- `StockDateGroupDetail`은 [Inventory.tsx](../../../frontend/src/pages/Inventory.tsx)에서 `selectedCode` 변경 시 unmount되지 않고 prop만 바뀌므로, 내부 state가 종목 전환 동안 자연스럽게 유지된다

### 모듈 경계

**신규**: `frontend/src/inventory/sortDates.ts` (순수 함수)

```ts
export type SortKey  = 'state' | 'date' | 'captured' | 'volume' | 'pages' | 'size' | 'ohlc';
export type SortDir  = 'asc' | 'desc';
export type SortState = { key: SortKey; dir: SortDir } | null;  // null = 기본(date desc)

export function sortDates(dates: StockDate[], sort: SortState): StockDate[];
export function nextSortState(current: SortState, clicked: SortKey): SortState;
```

- `sortDates`: `sort === null` 이면 입력 그대로 반환 (이미 `useStockDateGroups`가 date desc로 정렬해서 전달함). 그 외에는 새 배열을 반환 (mutation 없음). 동률(tie) 시 보조 키는 `date desc`.
- `nextSortState`: 3-state 토글 로직을 캡슐화. 다른 컬럼 클릭 시 그 컬럼 `desc`로 점프.

**신규**: `frontend/src/inventory/SortableTh.tsx` (또는 같은 파일 내 컴포넌트)

```tsx
type Props = {
  column: SortKey;
  sort: SortState;
  onSort: (next: SortState) => void;
  right?: boolean;
  children: React.ReactNode;
};
```

**수정**: [StockDateGroupDetail.tsx](../../../frontend/src/inventory/StockDateGroupDetail.tsx)
- `useState<SortState>(null)` 추가
- `useMemo`로 `sortedDates` 도출
- 기존 `<Th>` 호출을 `<SortableTh>`로 교체
- `tbody`는 `sortedDates.map(...)`

**수정**: [DiskStateBadge.tsx](../../../frontend/src/inventory/DiskStateBadge.tsx)
- `STATE_SEVERITY: Record<DiskStateValue, number>` 상수 export
- `aggregateDiskState`가 이 상수를 참조하도록 리팩토링 (도메인 순서 SSOT)

**불변**: `StockDateGroupListItem.tsx`, `useStockDateGroups.ts`, `groupByCode.ts`, 좌측 리스트 — 우측 변경의 좌측 누출 없음.

## 데이터 흐름

```
useStockDates() → rows
  └→ useStockDateGroups(rows, '')      [date desc 정렬됨]
      └→ group.dates
          └→ sortDates(group.dates, sort)   [신규 — sort=null이면 그대로]
              └→ sortedDates → <tbody>
```

## 테스트

### `sortDates.test.ts` (단위)

1. `sort === null` → 입력 그대로 반환 (참조 동일성은 보장하지 않으나 순서 보존)
2. `{ key: 'volume', dir: 'desc' }` → `total_volume` 내림차순
3. `{ key: 'volume', dir: 'asc' }` → 오름차순
4. `{ key: 'state', dir: 'desc' }` → `invalid` 맨 앞, `complete` 맨 뒤
5. `{ key: 'ohlc', dir: 'desc' }` → `today_close` 큰 순서
6. 동률 시 보조 정렬: 같은 volume인 두 행은 date desc로 배치됨
7. 입력 배열이 mutate되지 않음 (원본 순서/길이 보존)
8. `nextSortState`: `null + click(volume)` → `{ volume, desc }`; 다시 → `{ volume, asc }`; 다시 → `null`; 다른 컬럼 클릭 → 그 컬럼 `desc`

### `StockDateGroupDetail.test.tsx` (통합 — 기존 파일에 추가)

1. Volume 헤더 클릭 시 행 순서가 desc로 바뀐다
2. 같은 헤더 2회 클릭 시 asc, 3회 시 기본(date desc) 복귀
3. **세션 내 유지 회귀 가드**: 정렬 활성 상태에서 `selectedCode` prop을 다른 코드로 바꿔도 정렬 상태가 유지된다
4. `aria-sort` 속성이 정렬 상태에 맞게 업데이트된다
5. 헤더 클릭이 행 클릭(`onRowClick` → 탭 생성/네비게이션)을 트리거하지 않는다

## 엣지 케이스

- **빈 dates**: 정렬 호출은 무해, 기존 빈 tbody 동작 유지
- **단일 행**: 정렬 토글해도 시각적 변화 없음 — 정상
- **동률**: 같은 키 값인 행들은 `date desc`로 보조 정렬
- **음수/0 값** (volume, close 등): 일반 숫자 비교, 특수 처리 없음

## 접근성

- 헤더는 `<button>` 시맨틱으로 키보드 포커스 가능
- `aria-sort="ascending" | "descending" | "none"` 사용
- 아이콘은 시각 보조 — 정렬 상태는 텍스트 색상 변화로도 식별 가능 (색맹 대비)

## 회귀 가드

- 좌측 그룹 리스트 정렬 (`lastCapturedAt desc`)은 영향 없음 — `useStockDateGroups`는 변경하지 않음
- `StockDateGroupDetail` fallback 선택 로직 (`groups.find(...) ?? groups[0]`)은 영향 없음 — 정렬은 `group.dates`에만 적용
- Replay 탭 생성 동작(`onRowClick`)은 정렬 후에도 클릭한 그 행 데이터로 작동
