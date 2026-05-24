# Inventory 우측 캡처 테이블 — 컬럼 정렬 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/inventory` 우측 캡처 테이블의 7개 컬럼(State, Date, Captured, Volume, Pages, Size, OHLC)에 헤더 클릭 정렬을 추가한다. 3-state 토글(unsorted → desc → asc → unsorted), 세션 내 유지, 좌측 그룹 리스트는 영향 없음.

**Architecture:** 정렬 로직은 순수 함수(`sortDates.ts`)로 분리하고, `StockDateGroupDetail`이 로컬 `useState<SortState>`로 상태를 보유한다. `disk_state` enum의 severity 순서는 기존 `aggregateDiskState`의 묵시적 순서를 명시적 상수(`STATE_SEVERITY`)로 격상하여 두 호출자가 같은 SSOT를 공유한다.

**Tech Stack:** React 18, TypeScript, Vitest + @testing-library/react (jsdom), Tailwind + DESIGN.md tokens.

**Spec:** [2026-05-25-inventory-detail-column-sort-design.md](../specs/2026-05-25-inventory-detail-column-sort-design.md)

---

## File Structure

**Create:**
- `frontend/src/inventory/sortDates.ts` — 순수 정렬 함수 + 토글 헬퍼 + `SortKey`/`SortDir`/`SortState` 타입
- `frontend/src/inventory/sortDates.test.ts` — 단위 테스트

**Modify:**
- `frontend/src/inventory/DiskStateBadge.tsx` — `STATE_SEVERITY` 상수 export 추가, `aggregateDiskState` 리팩토링
- `frontend/src/inventory/StockDateGroupDetail.tsx` — `useState<SortState>` 도입, 기존 `<Th>`를 `<SortableTh>`로 교체, `sortedDates` derive
- `frontend/src/inventory/StockDateGroupDetail.test.tsx` — 정렬 인터랙션 + 회귀 가드 테스트 추가

**불변:** `StockDateGroupList.tsx`, `StockDateGroupListItem.tsx`, `useStockDateGroups.ts`, `groupByCode.ts`, `format.ts`, `Inventory.tsx`

---

## Test Commands

- 단일 파일 테스트: `cd frontend && npx vitest run src/inventory/<file>.test.ts(x)`
- 인벤토리 전체: `cd frontend && npx vitest run src/inventory`
- 타입체크: `cd frontend && npx tsc -b --noEmit`

---

## Task 1: Disk State Severity 상수를 도메인 SSOT로 격상

**Why first:** Task 2의 `sortDates`가 이 상수를 import하므로 순서가 강제됨. `aggregateDiskState`의 기존 동작은 행동 등가성을 유지하면서 내부만 리팩토링.

**Files:**
- Modify: `frontend/src/inventory/DiskStateBadge.tsx`
- Test: `frontend/src/inventory/DiskStateBadge.test.tsx` (없으면 신규 생성)

- [ ] **Step 1.1: 회귀 가드 테스트를 먼저 작성**

기존에 `DiskStateBadge.test.tsx`가 있는지 확인:

```bash
ls frontend/src/inventory/DiskStateBadge.test.tsx 2>/dev/null
```

없다면 신규 생성. 있다면 아래 케이스를 추가하라:

`frontend/src/inventory/DiskStateBadge.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { aggregateDiskState, STATE_SEVERITY } from './DiskStateBadge';

describe('STATE_SEVERITY', () => {
  it('orders states from worst (highest rank) to best (lowest)', () => {
    expect(STATE_SEVERITY.invalid).toBeGreaterThan(STATE_SEVERITY.client_incomplete);
    expect(STATE_SEVERITY.client_incomplete).toBeGreaterThan(STATE_SEVERITY.source_partial);
    expect(STATE_SEVERITY.source_partial).toBeGreaterThan(STATE_SEVERITY.complete);
  });
});

describe('aggregateDiskState', () => {
  it('returns invalid when any state is invalid', () => {
    expect(aggregateDiskState(['complete', 'invalid', 'source_partial'])).toBe('invalid');
  });
  it('returns client_incomplete when no invalid but some client_incomplete', () => {
    expect(aggregateDiskState(['complete', 'client_incomplete', 'source_partial'])).toBe('client_incomplete');
  });
  it('returns source_partial when only source_partial is non-complete', () => {
    expect(aggregateDiskState(['complete', 'source_partial', 'complete'])).toBe('source_partial');
  });
  it('returns complete when all are complete', () => {
    expect(aggregateDiskState(['complete', 'complete'])).toBe('complete');
  });
  it('returns complete for empty input', () => {
    expect(aggregateDiskState([])).toBe('complete');
  });
});
```

- [ ] **Step 1.2: 테스트 실행 — STATE_SEVERITY는 import 실패해야 함**

```bash
cd frontend && npx vitest run src/inventory/DiskStateBadge.test.tsx
```

Expected: FAIL — `STATE_SEVERITY` is not exported.

- [ ] **Step 1.3: `DiskStateBadge.tsx`에 `STATE_SEVERITY` export 추가 + `aggregateDiskState` 리팩토링**

`frontend/src/inventory/DiskStateBadge.tsx` 전체:

```tsx
import type { DiskStateValue } from '../api/types';

/** 같은 어휘로 CalendarCell의 마커와 일치시킨다 (DESIGN.md status semantic 토큰). */
const PRESENTATION: Record<DiskStateValue, { marker: string; color: string; label: string }> = {
  complete:          { marker: '✓', color: 'var(--success)', label: 'complete' },
  source_partial:    { marker: '⚠', color: 'var(--warn)',    label: 'source partial — data gaps' },
  client_incomplete: { marker: '✕', color: 'var(--error)',   label: 'client incomplete — resume on capture' },
  invalid:           { marker: '!', color: 'var(--error)',   label: 'invalid — domain invariant violated' },
};

/**
 * Disk State Severity — 도메인 SSOT (CONTEXT.md 참조).
 * 높은 숫자 = 더 심각한 상태. aggregateDiskState와 inventory 컬럼 정렬이 공유.
 */
export const STATE_SEVERITY: Record<DiskStateValue, number> = {
  complete: 0,
  source_partial: 1,
  client_incomplete: 2,
  invalid: 3,
};

export function DiskStateBadge({ state }: { state: DiskStateValue }) {
  const p = PRESENTATION[state];
  return (
    <span
      title={p.label}
      aria-label={p.label}
      className="font-mono text-sm leading-none"
      style={{ color: p.color }}
    >
      {p.marker}
    </span>
  );
}

/** 그룹 전체의 집계 상태 — 가장 심한 단계 반환. STATE_SEVERITY를 SSOT로 참조. */
export function aggregateDiskState(states: DiskStateValue[]): DiskStateValue {
  let worst: DiskStateValue = 'complete';
  for (const s of states) {
    if (STATE_SEVERITY[s] > STATE_SEVERITY[worst]) worst = s;
  }
  return worst;
}

/** 좌측 리스트용 작은 점. complete면 렌더 안 함(노이즈 방지). */
export function DiskStateDot({ state }: { state: DiskStateValue }) {
  if (state === 'complete') return null;
  const p = PRESENTATION[state];
  return (
    <span
      title={`이 종목의 캡처 중 ${p.label}이 있음`}
      aria-label={p.label}
      className="inline-block w-1.5 h-1.5 rounded-full"
      style={{ backgroundColor: p.color }}
    />
  );
}
```

- [ ] **Step 1.4: 테스트 통과 확인**

```bash
cd frontend && npx vitest run src/inventory/DiskStateBadge.test.tsx
```

Expected: PASS (모든 케이스).

- [ ] **Step 1.5: 기존 호출자 회귀 확인 — Inventory 전체 테스트**

```bash
cd frontend && npx vitest run src/inventory
```

Expected: 기존 `StockDateGroupListItem.test.tsx`, `StockDateGroupList.test.tsx`, `StockDateGroupDetail.test.tsx` 모두 PASS — `aggregateDiskState`의 외부 동작이 행동 등가이기 때문.

- [ ] **Step 1.6: 타입체크**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: 에러 없음.

- [ ] **Step 1.7: Commit**

```bash
git add frontend/src/inventory/DiskStateBadge.tsx frontend/src/inventory/DiskStateBadge.test.tsx
git commit -m "refactor(inventory): extract STATE_SEVERITY constant as Disk State Severity SSOT

aggregateDiskState now reads severity ranks from a shared constant
(CONTEXT.md Disk State Severity). Behavior unchanged; the constant
will be reused by the upcoming column-sort feature."
```

---

## Task 2: 순수 정렬 함수 `sortDates` + 토글 헬퍼 `nextSortState`

**Why second:** UI 레이어가 의존하기 전에 순수 로직을 완성해 빠른 피드백을 얻는다. 모든 엣지 케이스(동률, mutation 회피, null=기본)를 단위 테스트로 잠근다.

**Files:**
- Create: `frontend/src/inventory/sortDates.ts`
- Test: `frontend/src/inventory/sortDates.test.ts`

- [ ] **Step 2.1: 테스트 파일 작성 (TDD)**

`frontend/src/inventory/sortDates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StockDate } from '../api/types';
import { sortDates, nextSortState, type SortState } from './sortDates';

const row = (
  date: string,
  overrides: Partial<StockDate> = {},
): StockDate => ({
  date,
  code: '005930',
  name: '삼성전자',
  regular_session_open_ms: 0,
  regular_session_close_ms: 0,
  data_window_first_ms: 0,
  data_window_last_ms: 0,
  price_min: 0,
  price_max: 0,
  captured_at: 1_000,
  total_volume: 10_000,
  pages_collected: 100,
  file_size_bytes: 1_000_000,
  today_open: 70_000,
  today_high: 71_000,
  today_low: 69_000,
  today_close: 70_500,
  disk_state: 'complete',
  ...overrides,
});

const baseRows: StockDate[] = [
  row('20260522', { total_volume: 30, today_close: 72_000, captured_at: 3_000, pages_collected: 30, file_size_bytes: 3_000, disk_state: 'complete' }),
  row('20260521', { total_volume: 10, today_close: 70_000, captured_at: 1_000, pages_collected: 10, file_size_bytes: 1_000, disk_state: 'invalid' }),
  row('20260520', { total_volume: 20, today_close: 71_000, captured_at: 2_000, pages_collected: 20, file_size_bytes: 2_000, disk_state: 'source_partial' }),
];

describe('sortDates', () => {
  it('returns input as-is when sort is null', () => {
    const out = sortDates(baseRows, null);
    expect(out.map(r => r.date)).toEqual(['20260522', '20260521', '20260520']);
  });

  it('sorts by volume desc', () => {
    const out = sortDates(baseRows, { key: 'volume', dir: 'desc' });
    expect(out.map(r => r.total_volume)).toEqual([30, 20, 10]);
  });

  it('sorts by volume asc', () => {
    const out = sortDates(baseRows, { key: 'volume', dir: 'asc' });
    expect(out.map(r => r.total_volume)).toEqual([10, 20, 30]);
  });

  it('sorts by state desc using Disk State Severity (invalid first, complete last)', () => {
    const out = sortDates(baseRows, { key: 'state', dir: 'desc' });
    expect(out.map(r => r.disk_state)).toEqual(['invalid', 'source_partial', 'complete']);
  });

  it('sorts by state asc using Disk State Severity (complete first)', () => {
    const out = sortDates(baseRows, { key: 'state', dir: 'asc' });
    expect(out.map(r => r.disk_state)).toEqual(['complete', 'source_partial', 'invalid']);
  });

  it('sorts by date asc (string compare on YYYYMMDD)', () => {
    const out = sortDates(baseRows, { key: 'date', dir: 'asc' });
    expect(out.map(r => r.date)).toEqual(['20260520', '20260521', '20260522']);
  });

  it('sorts by captured timestamp desc', () => {
    const out = sortDates(baseRows, { key: 'captured', dir: 'desc' });
    expect(out.map(r => r.captured_at)).toEqual([3_000, 2_000, 1_000]);
  });

  it('sorts by ohlc using today_close', () => {
    const out = sortDates(baseRows, { key: 'ohlc', dir: 'desc' });
    expect(out.map(r => r.today_close)).toEqual([72_000, 71_000, 70_000]);
  });

  it('sorts by pages and size', () => {
    const byPages = sortDates(baseRows, { key: 'pages', dir: 'desc' });
    expect(byPages.map(r => r.pages_collected)).toEqual([30, 20, 10]);
    const bySize = sortDates(baseRows, { key: 'size', dir: 'desc' });
    expect(bySize.map(r => r.file_size_bytes)).toEqual([3_000, 2_000, 1_000]);
  });

  it('breaks ties by date desc when sort key is not date', () => {
    const tied: StockDate[] = [
      row('20260520', { total_volume: 100 }),
      row('20260522', { total_volume: 100 }),
      row('20260521', { total_volume: 100 }),
    ];
    const out = sortDates(tied, { key: 'volume', dir: 'desc' });
    expect(out.map(r => r.date)).toEqual(['20260522', '20260521', '20260520']);
  });

  it('does not apply secondary date sort when sort key is date itself', () => {
    // Equal dates would be a contradiction; this just guards the branch.
    // Use distinct dates to verify the primary sort still works without
    // a secondary tie-breaker collapsing the order.
    const out = sortDates(baseRows, { key: 'date', dir: 'desc' });
    expect(out.map(r => r.date)).toEqual(['20260522', '20260521', '20260520']);
  });

  it('does not mutate the input array', () => {
    const original = [...baseRows];
    sortDates(baseRows, { key: 'volume', dir: 'asc' });
    expect(baseRows.map(r => r.date)).toEqual(original.map(r => r.date));
  });
});

describe('nextSortState', () => {
  it('null + click goes to desc', () => {
    expect(nextSortState(null, 'volume')).toEqual({ key: 'volume', dir: 'desc' });
  });

  it('desc + same key goes to asc', () => {
    expect(nextSortState({ key: 'volume', dir: 'desc' }, 'volume')).toEqual({ key: 'volume', dir: 'asc' });
  });

  it('asc + same key goes to null (unsorted)', () => {
    expect(nextSortState({ key: 'volume', dir: 'asc' }, 'volume')).toBeNull();
  });

  it('any state + different key jumps to that key desc', () => {
    expect(nextSortState({ key: 'volume', dir: 'asc' }, 'state')).toEqual({ key: 'state', dir: 'desc' });
    expect(nextSortState({ key: 'volume', dir: 'desc' }, 'date')).toEqual({ key: 'date', dir: 'desc' });
    expect(nextSortState(null, 'ohlc')).toEqual({ key: 'ohlc', dir: 'desc' });
  });
});
```

- [ ] **Step 2.2: 테스트 실행 — 전부 실패해야 함**

```bash
cd frontend && npx vitest run src/inventory/sortDates.test.ts
```

Expected: FAIL — `Cannot find module './sortDates'`.

- [ ] **Step 2.3: `sortDates.ts` 구현**

`frontend/src/inventory/sortDates.ts`:

```ts
import type { StockDate } from '../api/types';
import { STATE_SEVERITY } from './DiskStateBadge';

export type SortKey = 'state' | 'date' | 'captured' | 'volume' | 'pages' | 'size' | 'ohlc';
export type SortDir = 'asc' | 'desc';
/** null = unsorted = 기본 date desc (useStockDateGroups가 이미 적용한 순서). */
export type SortState = { key: SortKey; dir: SortDir } | null;

type Comparable = number | string;

function keyOf(row: StockDate, key: SortKey): Comparable {
  switch (key) {
    case 'state':    return STATE_SEVERITY[row.disk_state];
    case 'date':     return row.date; // YYYYMMDD — 문자열 비교가 정확
    case 'captured': return row.captured_at;
    case 'volume':   return row.total_volume;
    case 'pages':    return row.pages_collected;
    case 'size':     return row.file_size_bytes;
    case 'ohlc':     return row.today_close;
  }
}

function compare(a: Comparable, b: Comparable): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * sort === null이면 입력 그대로 반환(useStockDateGroups가 이미 date desc로 줌).
 * 그 외엔 새 배열 반환(입력 mutation 없음). 동률(tie)은 sort.key가 'date'가 아닐 때만
 * date desc로 깬다.
 */
export function sortDates(dates: StockDate[], sort: SortState): StockDate[] {
  if (sort === null) return dates;
  const copy = [...dates];
  const mult = sort.dir === 'asc' ? 1 : -1;
  copy.sort((a, b) => {
    const cmp = compare(keyOf(a, sort.key), keyOf(b, sort.key));
    if (cmp !== 0) return cmp * mult;
    if (sort.key === 'date') return 0;
    // 보조 정렬: date desc
    return compare(b.date, a.date);
  });
  return copy;
}

/**
 * 3-state 토글:
 *   null + click(X)        → { X, desc }
 *   { X, desc } + click(X) → { X, asc }
 *   { X, asc }  + click(X) → null
 *   any         + click(Y) → { Y, desc }   (다른 컬럼은 desc로 점프)
 */
export function nextSortState(current: SortState, clicked: SortKey): SortState {
  if (current === null || current.key !== clicked) {
    return { key: clicked, dir: 'desc' };
  }
  if (current.dir === 'desc') return { key: clicked, dir: 'asc' };
  return null;
}
```

- [ ] **Step 2.4: 테스트 통과 확인**

```bash
cd frontend && npx vitest run src/inventory/sortDates.test.ts
```

Expected: 모든 케이스 PASS.

- [ ] **Step 2.5: 타입체크**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: 에러 없음.

- [ ] **Step 2.6: Commit**

```bash
git add frontend/src/inventory/sortDates.ts frontend/src/inventory/sortDates.test.ts
git commit -m "feat(inventory): add sortDates + nextSortState pure helpers

Single-column sort across 7 inventory columns. State sort reuses
STATE_SEVERITY (Disk State Severity SSOT). 3-state toggle:
unsorted -> desc -> asc -> unsorted; clicking a different column
jumps to that column's desc first."
```

---

## Task 3: `<SortableTh>` 컴포넌트 + `StockDateGroupDetail` 통합

**Files:**
- Modify: `frontend/src/inventory/StockDateGroupDetail.tsx`
- Modify: `frontend/src/inventory/StockDateGroupDetail.test.tsx`

- [ ] **Step 3.1: 통합 테스트 작성 (TDD)**

기존 `StockDateGroupDetail.test.tsx`의 `describe` 블록 끝에 다음 케이스들을 추가:

```tsx
import { act } from '@testing-library/react';
// ... 기존 imports 유지

// 기존 row() 헬퍼 옆에 — 컬럼별로 값이 분명히 다른 행 셋
const sortableRows: StockDate[] = [
  { ...row('005930', '삼성전자', '20260522'), total_volume: 30, today_close: 72_000, captured_at: 3_000 },
  { ...row('005930', '삼성전자', '20260521'), total_volume: 10, today_close: 70_000, captured_at: 1_000 },
  { ...row('005930', '삼성전자', '20260520'), total_volume: 20, today_close: 71_000, captured_at: 2_000 },
];

describe('StockDateGroupDetail column sorting', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useTabsStore.setState({ tabs: [] });
  });

  function getDateOrder(): string[] {
    return screen.getAllByText(/2026-05-\d{2}/).map(el => el.textContent ?? '');
  }

  it('default order is date desc (unchanged from current behavior)', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-21', '2026-05-20']);
  });

  it('clicking Volume header sorts by volume desc, then asc, then back to default', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    const volumeHeader = screen.getByRole('button', { name: /volume/i });

    fireEvent.click(volumeHeader); // desc → volume 30/20/10 → dates 22/20/21
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-20', '2026-05-21']);

    fireEvent.click(volumeHeader); // asc → volume 10/20/30 → dates 21/20/22
    expect(getDateOrder()).toEqual(['2026-05-21', '2026-05-20', '2026-05-22']);

    fireEvent.click(volumeHeader); // unsorted → default date desc
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-21', '2026-05-20']);
  });

  it('clicking a different header jumps to that column desc', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    fireEvent.click(screen.getByRole('button', { name: /volume/i })); // volume desc
    fireEvent.click(screen.getByRole('button', { name: /ohlc/i }));   // ohlc desc
    // today_close desc: 72_000(22), 71_000(20), 70_000(21)
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-20', '2026-05-21']);
  });

  it('aria-sort attribute reflects current sort state', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    const volumeHeader = screen.getByRole('button', { name: /volume/i });
    const th = volumeHeader.closest('th')!;

    expect(th.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(volumeHeader);
    expect(th.getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(volumeHeader);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(volumeHeader);
    expect(th.getAttribute('aria-sort')).toBe('none');
  });

  it('preserves sort state across selectedCode changes (session-lifetime)', () => {
    const twoCodeRows: StockDate[] = [
      ...sortableRows,
      { ...row('000660', 'SK하이닉스', '20260522'), total_volume: 5, today_close: 100_000, captured_at: 4_000 },
      { ...row('000660', 'SK하이닉스', '20260521'), total_volume: 50, today_close: 99_000, captured_at: 5_000 },
    ];
    const { rerender } = renderWithRouter(
      <StockDateGroupDetail rows={twoCodeRows} selectedCode="005930" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /volume/i })); // volume desc on 005930
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-20', '2026-05-21']);

    // Swap selected code — same component instance, prop change only
    rerender(
      <MemoryRouter>
        <StockDateGroupDetail rows={twoCodeRows} selectedCode="000660" />
      </MemoryRouter>,
    );
    // 000660 has 2 rows with vol 5(22) and 50(21); volume desc -> 50 first -> date 21 first
    expect(getDateOrder()).toEqual(['2026-05-21', '2026-05-22']);
  });

  it('header click does not trigger row click (no navigation)', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    fireEvent.click(screen.getByRole('button', { name: /volume/i }));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('OHLC header has tooltip explaining it sorts by close', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    const ohlcHeader = screen.getByRole('button', { name: /ohlc/i });
    expect(ohlcHeader.getAttribute('title')).toMatch(/종가/);
  });
});
```

- [ ] **Step 3.2: 테스트 실행 — 새 케이스들이 실패해야 함**

```bash
cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx
```

Expected: 기존 테스트는 PASS, 새 "column sorting" 블록은 FAIL (헤더에 button role 없음 / 동작 미구현).

- [ ] **Step 3.3: `StockDateGroupDetail.tsx` 수정 — `SortableTh` 도입 + state 연결**

`frontend/src/inventory/StockDateGroupDetail.tsx` 전체:

```tsx
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { StockDate } from '../api/types';
import { useTabsStore } from '../state/tabs';
import { useStockDateGroups } from './useStockDateGroups';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';
import { DiskStateBadge } from './DiskStateBadge';
import { sortDates, nextSortState, type SortKey, type SortState } from './sortDates';

type Props = {
  rows: StockDate[];
  selectedCode: string | null;
};

export function StockDateGroupDetail({ rows, selectedCode }: Props) {
  const navigate = useNavigate();
  const groups = useStockDateGroups(rows, '');
  const group = useMemo(() => {
    if (selectedCode === null) return null;
    return groups.find(g => g.code === selectedCode) ?? groups[0] ?? null;
  }, [groups, selectedCode]);

  const [sort, setSort] = useState<SortState>(null);
  const sortedDates = useMemo(
    () => (group ? sortDates(group.dates, sort) : []),
    [group, sort],
  );

  if (group === null) {
    return (
      <section className="bg-bg-card border rounded-lg p-md text-fg-dim">
        종목을 선택하세요
      </section>
    );
  }

  const totalVolume = group.dates.reduce((s, d) => s + d.total_volume, 0);

  const onRowClick = (r: StockDate) => {
    const tabId = useTabsStore.getState().newTab();
    useTabsStore.getState().setSelection(tabId, {
      code: r.code,
      fromDate: r.date,
      toDate: r.date,
      timeframe: '1m',
    });
    navigate('/replay');
  };

  const onSort = (column: SortKey) => setSort(prev => nextSortState(prev, column));

  return (
    <section className="bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-hidden">
      <header className="px-4 py-3 border-b flex items-baseline justify-between">
        <h2 className="text-md font-semibold">
          <span className="text-accent font-mono">{group.code}</span>{' '}
          <span className="text-fg">{group.name}</span>
        </h2>
        <span className="text-xs text-fg-dim font-mono tabular-nums">
          {group.dates.length} dates · {fmtVolume(totalVolume)} vol · {fmtSize(group.totalSizeBytes)}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse font-mono text-sm tabular-nums">
          <thead className="bg-bg-subtle sticky top-0">
            <tr>
              <SortableTh column="state"    sort={sort} onSort={onSort}>State</SortableTh>
              <SortableTh column="date"     sort={sort} onSort={onSort}>Date</SortableTh>
              <SortableTh column="captured" sort={sort} onSort={onSort}>Captured</SortableTh>
              <SortableTh column="volume"   sort={sort} onSort={onSort} right>Volume</SortableTh>
              <SortableTh column="pages"    sort={sort} onSort={onSort} right>Pages</SortableTh>
              <SortableTh column="size"     sort={sort} onSort={onSort} right>Size</SortableTh>
              <SortableTh column="ohlc"     sort={sort} onSort={onSort} right title="종가 기준 정렬">OHLC</SortableTh>
            </tr>
          </thead>
          <tbody>
            {sortedDates.map((r) => (
              <tr
                key={`${r.code}-${r.date}`}
                onClick={() => onRowClick(r)}
                className="border-b hover:bg-bg-input-hover cursor-pointer"
              >
                <td className="px-3 py-1.5 text-center"><DiskStateBadge state={r.disk_state} /></td>
                <td className="px-3 py-1.5">{fmtDate(r.date)}</td>
                <td className="px-3 py-1.5 text-fg-dim">{fmtTime(r.captured_at)}</td>
                <td className="px-3 py-1.5 text-right">{r.total_volume.toLocaleString('ko-KR')}</td>
                <td className="px-3 py-1.5 text-right text-fg-dim">{r.pages_collected}</td>
                <td className="px-3 py-1.5 text-right text-fg-dim">{fmtSize(r.file_size_bytes)}</td>
                <td className="px-3 py-1.5 text-right">{fmtOHLC(r.today_open, r.today_close)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type SortableThProps = {
  column: SortKey;
  sort: SortState;
  onSort: (column: SortKey) => void;
  right?: boolean;
  title?: string;
  children: React.ReactNode;
};

function SortableTh({ column, sort, onSort, right, title, children }: SortableThProps) {
  const active = sort?.key === column;
  const dir = active ? sort.dir : null;
  const ariaSort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  const indicator = dir === 'desc' ? '▼' : dir === 'asc' ? '▲' : '▾';
  const indicatorClass = active ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-30';
  const labelClass = active ? 'text-fg' : 'text-fg-dimmer';

  return (
    <th
      aria-sort={ariaSort}
      className={`px-3 py-2 border-b text-xs uppercase tracking-wider font-semibold ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      <button
        type="button"
        title={title}
        onClick={() => onSort(column)}
        className={`group inline-flex items-center gap-1 select-none ${labelClass} ${
          right ? 'flex-row-reverse' : 'flex-row'
        }`}
      >
        <span>{children}</span>
        <span className={`font-mono ${indicatorClass}`} aria-hidden="true">
          {indicator}
        </span>
      </button>
    </th>
  );
}
```

핵심 결정 사항:
- `<button>`은 `<th>` 안에 nesting — 버튼 클릭만 `onSort` 호출, `<tr>` 행 클릭과 이벤트 충돌 없음 (헤더는 `<thead>` 안 `<tr>`이고 row click 핸들러는 `<tbody>` 행에만 부착됨).
- `indicator`는 항상 자리를 차지(layout shift 방지). `active=false`일 때 `▾` placeholder는 `opacity-0`이라 비활성 헤더는 보이지 않고, `group-hover`로 `opacity-30` 어포던스가 뜬다.
- `right` 컬럼은 `flex-row-reverse`로 라벨-아이콘 순서를 좌우 반전.

- [ ] **Step 3.4: 테스트 통과 확인**

```bash
cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx
```

Expected: 모든 케이스 PASS (기존 5개 + 새로 추가한 7개).

- [ ] **Step 3.5: 좌측 리스트 회귀 가드 — Inventory 전체 테스트**

```bash
cd frontend && npx vitest run src/inventory
```

Expected: 모두 PASS. 좌측 리스트(`StockDateGroupList.test.tsx`, `StockDateGroupListItem.test.tsx`)는 변경 없음.

- [ ] **Step 3.6: 타입체크 + 린트**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: 에러 없음.

- [ ] **Step 3.7: 수동 검증 (한 번만)**

`http://localhost:5173/inventory` 열기:
1. 한 종목 선택 — 기본 date desc 확인
2. Volume 헤더 클릭 — 거래량 큰 순으로 재정렬, `▼` 아이콘 표시
3. 같은 헤더 두 번 더 클릭 — asc → unsorted 순환
4. 다른 컬럼(State, Pages 등) 클릭 — 그 컬럼 desc로 점프
5. 좌측에서 다른 종목 선택 — 정렬 상태 유지됨
6. 새로고침 — 정렬 초기화되어 date desc로 복귀
7. OHLC 헤더에 마우스 hover — "종가 기준 정렬" tooltip 확인

문제 발견 시 그 자리에서 수정 후 위 테스트 재실행.

- [ ] **Step 3.8: Commit**

```bash
git add frontend/src/inventory/StockDateGroupDetail.tsx frontend/src/inventory/StockDateGroupDetail.test.tsx
git commit -m "feat(inventory): column sort on detail capture table

7 columns sortable via SortableTh header buttons (3-state toggle).
Sort state lives in component-local useState so it survives
selectedCode changes within a session but resets on page reload.
Left group list and useStockDateGroups are unchanged."
```

---

## Self-Review Checklist (실행 직후 확인)

**Spec coverage:**
- 우측 캡처 테이블 7컬럼 정렬 → Task 3 ✓
- 3-state 토글 → Task 2 (`nextSortState`) + Task 3 ✓
- State 컬럼 = Disk State Severity → Task 1 + Task 2 ✓
- 세션 내 유지 → Task 3 (preserves sort across selectedCode 테스트) ✓
- 새로고침 시 리셋 → `useState` 디폴트 `null`이 자연스럽게 충족 ✓
- 기본 정렬 = date desc → Task 2 (sort=null 분기) ✓
- OHLC 정렬 키 = today_close + tooltip → Task 2/3 ✓
- aria-sort 접근성 → Task 3 ✓
- 좌측 리스트 영향 없음 → 좌측 파일 불변 + Task 1.5/3.5 회귀 가드 ✓
- 동률 시 보조 정렬 date desc (Date 키 제외) → Task 2 테스트 ✓

**Placeholder scan:** 모든 step에 실제 코드 / 명령 / expected output 포함. "implement later" 없음.

**Type consistency:** `SortKey`/`SortDir`/`SortState`는 `sortDates.ts`에 정의되어 Task 3에서 import. `STATE_SEVERITY` 시그니처(`Record<DiskStateValue, number>`)는 Task 1 → Task 2에서 일관.
