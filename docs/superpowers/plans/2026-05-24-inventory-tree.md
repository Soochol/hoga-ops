# Inventory Tree (Master-Detail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/inventory` 페이지를 평탄 테이블에서 Master-Detail 트리(좌측 종목 리스트 + 검색 + 우측 날짜 상세)로 재구성한다. 백엔드 변경 없음.

**Architecture:** 새 `frontend/src/inventory/` 모듈에 `useStockDateGroups` hook(클라이언트 그룹화)과 3개 컴포넌트(List, ListItem, Detail)를 두고, `Inventory.tsx`는 얇은 컨테이너가 되어 좌·우 카드를 grid로 배치한다. 기존 `useStockDates`/`useTabsStore`/라우팅은 무변경.

**Tech Stack:** React 18 + TypeScript + Tailwind(생성 토큰) + React Query(`useStockDates`) + Zustand(`useTabsStore`) + React Router(`useNavigate`) · Vitest + RTL · Playwright(E2E)

**Spec:** [docs/superpowers/specs/2026-05-24-inventory-tree-design.md](../specs/2026-05-24-inventory-tree-design.md)

---

## File Structure

| 경로 | 책임 | 신규/수정 |
|---|---|---|
| `frontend/src/inventory/types.ts` | `StockDateGroup` 도메인 타입 | 신규 |
| `frontend/src/inventory/format.ts` | 날짜·시간·바이트·OHLC 포매터 (Inventory.tsx에서 추출) | 신규 |
| `frontend/src/inventory/format.test.ts` | 포매터 단위 테스트 | 신규 |
| `frontend/src/inventory/useStockDateGroups.ts` | `StockDate[] → StockDateGroup[]` (그룹·집계·정렬·검색) | 신규 |
| `frontend/src/inventory/useStockDateGroups.test.ts` | 순수함수 단위 테스트 | 신규 |
| `frontend/src/inventory/StockDateGroupListItem.tsx` | 좌측 항목 (2줄) — 시각만 | 신규 |
| `frontend/src/inventory/StockDateGroupListItem.test.tsx` | 항목 렌더 테스트 | 신규 |
| `frontend/src/inventory/StockDateGroupList.tsx` | 좌측 카드 (검색창 + 리스트 + 헤더) | 신규 |
| `frontend/src/inventory/StockDateGroupList.test.tsx` | 검색 필터 + 선택 콜백 테스트 | 신규 |
| `frontend/src/inventory/StockDateGroupDetail.tsx` | 우측 카드 (헤더 + 날짜 테이블) | 신규 |
| `frontend/src/inventory/StockDateGroupDetail.test.tsx` | 네비게이션 + 헤더 테스트 | 신규 |
| `frontend/src/pages/Inventory.tsx` | 얇은 grid 컨테이너로 재작성 | 수정 (전면 교체) |
| `frontend/tests/e2e/inventory-tree.spec.ts` | smoke E2E (검색 → 선택 → 날짜 클릭 → /replay) | 신규 |

---

## Task 1: 도메인 타입 + 포매터 추출

**Files:**
- Create: `frontend/src/inventory/types.ts`
- Create: `frontend/src/inventory/format.ts`
- Create: `frontend/src/inventory/format.test.ts`

- [ ] **Step 1: 도메인 타입 작성**

`frontend/src/inventory/types.ts`:

```ts
import type { StockDate } from '../api/types';

/**
 * Inventory 페이지에서 사용하는, Code 단위로 압축된 Stock-Date 묶음.
 * CONTEXT.md 참조 — Stock-Date 위에 compound로 얹은 도메인 용어.
 */
export type StockDateGroup = {
  code: string;
  name: string;
  dates: StockDate[];      // date desc 정렬
  lastCapturedAt: number;  // max(captured_at) — 부모 정렬 키
  totalSizeBytes: number;  // sum(file_size_bytes)
};
```

- [ ] **Step 2: 포매터 테스트 작성 (실패 확인용)**

`frontend/src/inventory/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fmtDate, fmtShortDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';

describe('format', () => {
  it('fmtDate: YYYYMMDD → YYYY-MM-DD', () => {
    expect(fmtDate('20260522')).toBe('2026-05-22');
  });

  it('fmtShortDate: YYYYMMDD → MM-DD', () => {
    expect(fmtShortDate('20260522')).toBe('05-22');
  });

  it('fmtTime: ms → ko-KR short datetime in Asia/Seoul', () => {
    const result = fmtTime(Date.UTC(2026, 4, 22, 6, 30)); // 15:30 KST
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/15:30|3:30/);
  });

  it('fmtSize: bytes → "X.X MB"', () => {
    expect(fmtSize(13_421_772)).toBe('12.8 MB');
    expect(fmtSize(0)).toBe('0.0 MB');
  });

  it('fmtOHLC: close >= open uses ↑, else ↓', () => {
    expect(fmtOHLC(70_000, 72_400)).toBe('72,400 ↑');
    expect(fmtOHLC(72_000, 70_900)).toBe('70,900 ↓');
    expect(fmtOHLC(72_000, 72_000)).toBe('72,000 ↑'); // tie → up
  });

  it('fmtVolume: large numbers → K/M/B with ko-KR-style separators when small', () => {
    expect(fmtVolume(52_100_000)).toBe('52.1M');
    expect(fmtVolume(1_240_000_000)).toBe('1.24B');
    expect(fmtVolume(750)).toBe('750');
  });
});
```

- [ ] **Step 3: 테스트 실행 (실패 예상)**

Run: `cd frontend && npx vitest run src/inventory/format.test.ts`
Expected: FAIL — `format` 모듈 없음.

- [ ] **Step 4: 포매터 구현**

`frontend/src/inventory/format.ts`:

```ts
export function fmtDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function fmtShortDate(d: string): string {
  return `${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export function fmtSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtOHLC(open: number, close: number): string {
  const dir = close >= open ? '↑' : '↓';
  return `${close.toLocaleString('ko-KR')} ${dir}`;
}

export function fmtVolume(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
```

- [ ] **Step 5: 테스트 실행 (통과 확인)**

Run: `cd frontend && npx vitest run src/inventory/format.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/inventory/types.ts frontend/src/inventory/format.ts frontend/src/inventory/format.test.ts
git commit -m "feat(frontend/inventory): scaffold types and format utils"
```

---

## Task 2: `useStockDateGroups` hook

**Files:**
- Create: `frontend/src/inventory/useStockDateGroups.ts`
- Create: `frontend/src/inventory/useStockDateGroups.test.ts`

- [ ] **Step 1: 테스트 작성**

`frontend/src/inventory/useStockDateGroups.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStockDateGroups } from './useStockDateGroups';
import type { StockDate } from '../api/types';

const row = (code: string, name: string, date: string, capturedAt: number, sizeBytes: number): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: capturedAt,
  total_volume: 0, pages_collected: 0, file_size_bytes: sizeBytes,
  today_open: 0, today_high: 0, today_low: 0, today_close: 0,
});

describe('useStockDateGroups', () => {
  const rows: StockDate[] = [
    row('005930', '삼성전자', '20260520', 1_000, 12_700_000),
    row('005930', '삼성전자', '20260522', 3_000, 13_200_000),
    row('005930', '삼성전자', '20260521', 2_000, 12_800_000),
    row('000660', 'SK하이닉스', '20260521', 4_000, 11_400_000),
    row('035720', '카카오',     '20260522', 5_000, 4_700_000),
  ];

  it('groups by code', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    expect(result.current).toHaveLength(3);
    const samsung = result.current.find(g => g.code === '005930')!;
    expect(samsung.dates).toHaveLength(3);
  });

  it('sorts children dates desc', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    const samsung = result.current.find(g => g.code === '005930')!;
    expect(samsung.dates.map(d => d.date)).toEqual(['20260522', '20260521', '20260520']);
  });

  it('aggregates lastCapturedAt = max(captured_at) and totalSizeBytes = sum', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    const samsung = result.current.find(g => g.code === '005930')!;
    expect(samsung.lastCapturedAt).toBe(3_000);
    expect(samsung.totalSizeBytes).toBe(12_700_000 + 13_200_000 + 12_800_000);
  });

  it('sorts parent groups by lastCapturedAt desc', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    expect(result.current.map(g => g.code)).toEqual(['035720', '000660', '005930']);
  });

  it('search by name (한글 부분 매칭)', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, '삼성'));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].code).toBe('005930');
  });

  it('search by code (prefix)', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, '0059'));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].code).toBe('005930');
  });

  it('search is case-insensitive and trimmed', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, '  삼성  '));
    expect(result.current).toHaveLength(1);
  });

  it('empty search returns all groups', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, ''));
    expect(result.current).toHaveLength(3);
  });

  it('no match returns empty array', () => {
    const { result } = renderHook(() => useStockDateGroups(rows, 'NOMATCH_XYZ'));
    expect(result.current).toHaveLength(0);
  });

  it('empty rows returns empty array', () => {
    const { result } = renderHook(() => useStockDateGroups([], ''));
    expect(result.current).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트 실행 (실패 예상)**

Run: `cd frontend && npx vitest run src/inventory/useStockDateGroups.test.ts`
Expected: FAIL — `useStockDateGroups` 모듈 없음.

- [ ] **Step 3: hook 구현**

`frontend/src/inventory/useStockDateGroups.ts`:

```ts
import { useMemo } from 'react';
import type { StockDate } from '../api/types';
import type { StockDateGroup } from './types';

export function useStockDateGroups(rows: StockDate[], search: string): StockDateGroup[] {
  return useMemo(() => {
    const map = new Map<string, StockDate[]>();
    for (const r of rows) {
      const arr = map.get(r.code);
      if (arr) arr.push(r);
      else map.set(r.code, [r]);
    }

    const groups: StockDateGroup[] = [];
    for (const [code, dates] of map) {
      dates.sort((a, b) => b.date.localeCompare(a.date));
      const lastCapturedAt = dates.reduce((m, d) => Math.max(m, d.captured_at), 0);
      const totalSizeBytes = dates.reduce((s, d) => s + d.file_size_bytes, 0);
      groups.push({
        code,
        name: dates[0].name,
        dates,
        lastCapturedAt,
        totalSizeBytes,
      });
    }
    groups.sort((a, b) => b.lastCapturedAt - a.lastCapturedAt);

    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(g => g.name.toLowerCase().includes(q) || g.code.includes(q));
  }, [rows, search]);
}
```

- [ ] **Step 4: 테스트 실행 (통과 확인)**

Run: `cd frontend && npx vitest run src/inventory/useStockDateGroups.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/inventory/useStockDateGroups.ts frontend/src/inventory/useStockDateGroups.test.ts
git commit -m "feat(frontend/inventory): useStockDateGroups hook (group + sort + filter)"
```

---

## Task 3: `StockDateGroupListItem` 컴포넌트

**Files:**
- Create: `frontend/src/inventory/StockDateGroupListItem.tsx`
- Create: `frontend/src/inventory/StockDateGroupListItem.test.tsx`

- [ ] **Step 1: 테스트 작성**

`frontend/src/inventory/StockDateGroupListItem.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StockDateGroupListItem } from './StockDateGroupListItem';
import type { StockDateGroup } from './types';

const sampleGroup: StockDateGroup = {
  code: '005930',
  name: '삼성전자',
  dates: [],
  lastCapturedAt: Date.UTC(2026, 4, 22, 6, 0),
  totalSizeBytes: 38_700_000,
};
const groupWithThree: StockDateGroup = { ...sampleGroup };
// dates.length는 view에서 별도 prop 또는 group.dates.length로 결정 — view가 group을 받으므로 length를 정확하게 세팅한다
const groupForView: StockDateGroup = {
  ...sampleGroup,
  dates: [{} as never, {} as never, {} as never], // 3 dates
};

describe('StockDateGroupListItem', () => {
  it('shows code, name, and date count', () => {
    render(<StockDateGroupListItem group={groupForView} active={false} onClick={() => {}} />);
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText('3 dates')).toBeTruthy();
  });

  it('shows formatted last-captured date (MM-DD) and total size', () => {
    render(<StockDateGroupListItem group={groupForView} active={false} onClick={() => {}} />);
    expect(screen.getByText(/최근 05-22/)).toBeTruthy();
    expect(screen.getByText('36.9 MB')).toBeTruthy();
  });

  it('applies active styling when active=true', () => {
    const { container } = render(
      <StockDateGroupListItem group={groupForView} active={true} onClick={() => {}} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/bg-tint-selection/);
  });

  it('fires onClick with the group code', () => {
    const onClick = vi.fn();
    const { container } = render(
      <StockDateGroupListItem group={groupForView} active={false} onClick={onClick} />,
    );
    (container.firstElementChild as HTMLElement).click();
    expect(onClick).toHaveBeenCalledWith('005930');
  });

  it('shows "1 date" singular for one-date group', () => {
    const single: StockDateGroup = { ...groupForView, dates: [{} as never] };
    render(<StockDateGroupListItem group={single} active={false} onClick={() => {}} />);
    expect(screen.getByText('1 date')).toBeTruthy();
  });

  it('renders last-captured date in Asia/Seoul (uses fmtShortDate from lastCapturedAt)', () => {
    // 2026-05-22 06:00 UTC == 15:00 KST → MM-DD = "05-22"
    render(<StockDateGroupListItem group={groupForView} active={false} onClick={() => {}} />);
    expect(screen.getByText(/05-22/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 테스트 실행 (실패 예상)**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupListItem.test.tsx`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 컴포넌트 구현**

`frontend/src/inventory/StockDateGroupListItem.tsx`:

```tsx
import { fmtSize } from './format';
import type { StockDateGroup } from './types';

type Props = {
  group: StockDateGroup;
  active: boolean;
  onClick: (code: string) => void;
};

export function StockDateGroupListItem({ group, active, onClick }: Props) {
  const n = group.dates.length;
  const last = lastCapturedShort(group.lastCapturedAt);
  return (
    <div
      onClick={() => onClick(group.code)}
      className={[
        'px-3 py-2 cursor-pointer rounded select-none',
        active ? 'bg-tint-selection text-fg' : 'text-fg-dim hover:bg-bg-input-hover',
      ].join(' ')}
    >
      <div className="flex justify-between items-baseline">
        <span>
          <span className="text-accent font-mono">{group.code}</span>{' '}
          <span className="text-fg">{group.name}</span>
        </span>
        <span className="font-mono tabular-nums text-sm">{n} {n === 1 ? 'date' : 'dates'}</span>
      </div>
      <div className="flex justify-between text-xs text-fg-dim mt-1">
        <span>최근 {last}</span>
        <span className="font-mono tabular-nums">{fmtSize(group.totalSizeBytes)}</span>
      </div>
    </div>
  );
}

function lastCapturedShort(ms: number): string {
  // captured_at는 절대 시각 → KST 기준 MM-DD
  const kst = new Date(ms).toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
  });
  // ko-KR: "05. 22." → "05-22"
  return kst.replace(/\.\s?/g, '-').replace(/-$/, '');
}
```

- [ ] **Step 4: 테스트 실행 (통과 확인)**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupListItem.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/inventory/StockDateGroupListItem.tsx frontend/src/inventory/StockDateGroupListItem.test.tsx
git commit -m "feat(frontend/inventory): StockDateGroupListItem (left list row)"
```

---

## Task 4: `StockDateGroupList` 컴포넌트 (검색 + 리스트)

**Files:**
- Create: `frontend/src/inventory/StockDateGroupList.tsx`
- Create: `frontend/src/inventory/StockDateGroupList.test.tsx`

- [ ] **Step 1: 테스트 작성**

`frontend/src/inventory/StockDateGroupList.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockDateGroupList } from './StockDateGroupList';
import type { StockDate } from '../api/types';

const row = (code: string, name: string, date: string, capturedAt = 1000, size = 1_000_000): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: capturedAt,
  total_volume: 0, pages_collected: 0, file_size_bytes: size,
  today_open: 0, today_high: 0, today_low: 0, today_close: 0,
});

const rows: StockDate[] = [
  row('005930', '삼성전자', '20260522', 3000),
  row('005930', '삼성전자', '20260521', 2000),
  row('000660', 'SK하이닉스', '20260521', 4000),
  row('035720', '카카오',    '20260522', 5000),
];

describe('StockDateGroupList', () => {
  it('renders the header summary (groups count and dates count)', () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    expect(screen.getByText(/종목 3개/)).toBeTruthy();
    expect(screen.getByText(/캡처 4건/)).toBeTruthy();
  });

  it('renders all groups sorted by lastCapturedAt desc', () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const codes = screen.getAllByText(/^0\d{5}$|^03\d{4}$/).map(el => el.textContent);
    expect(codes).toEqual(['035720', '000660', '005930']);
  });

  it('filters by name when search input changes', async () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const search = screen.getByPlaceholderText('종목명 또는 코드…');
    await userEvent.type(search, '삼성');
    expect(screen.queryByText('SK하이닉스')).toBeNull();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText('1 matches')).toBeTruthy();
  });

  it('filters by code prefix', async () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const search = screen.getByPlaceholderText('종목명 또는 코드…');
    await userEvent.type(search, '0059');
    expect(screen.queryByText('SK하이닉스')).toBeNull();
    expect(screen.getByText('삼성전자')).toBeTruthy();
  });

  it('shows "검색 결과 없음" when filter returns 0 groups', async () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const search = screen.getByPlaceholderText('종목명 또는 코드…');
    await userEvent.type(search, 'NOMATCH_XYZ');
    expect(screen.getByText('검색 결과 없음')).toBeTruthy();
  });

  it('calls onSelect with the group code when an item is clicked', () => {
    const onSelect = vi.fn();
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('삼성전자'));
    expect(onSelect).toHaveBeenCalledWith('005930');
  });

  it('clear button (×) appears when input has value and clears the search', async () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const search = screen.getByPlaceholderText('종목명 또는 코드…') as HTMLInputElement;
    await userEvent.type(search, '삼성');
    const clear = screen.getByRole('button', { name: /clear search/i });
    fireEvent.click(clear);
    expect(search.value).toBe('');
    expect(screen.getByText('SK하이닉스')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 테스트 실행 (실패 예상)**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupList.test.tsx`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 컴포넌트 구현**

`frontend/src/inventory/StockDateGroupList.tsx`:

```tsx
import { useState } from 'react';
import type { StockDate } from '../api/types';
import { useStockDateGroups } from './useStockDateGroups';
import { StockDateGroupListItem } from './StockDateGroupListItem';

type Props = {
  rows: StockDate[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
};

export function StockDateGroupList({ rows, selectedCode, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const groups = useStockDateGroups(rows, search);
  const allGroupsCount = new Set(rows.map(r => r.code)).size;
  const isSearching = search.trim().length > 0;

  return (
    <section className="bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-hidden">
      <header className="px-3 py-2 border-b text-xs uppercase tracking-wider text-fg-dimmer font-semibold">
        종목 {allGroupsCount}개 · 캡처 {rows.length}건
      </header>
      <div className="p-2 border-b sticky top-0 bg-bg-card z-10">
        <div className="relative">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="종목명 또는 코드…"
            className="bg-bg-input border rounded px-3 py-1.5 font-mono text-sm text-fg w-full pr-7"
          />
          {search && (
            <button
              type="button"
              aria-label="clear search"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dimmer hover:text-fg text-sm leading-none"
            >
              ×
            </button>
          )}
        </div>
        {isSearching && (
          <div className="text-xs text-fg-dimmer mt-1 font-mono">{groups.length} matches</div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {groups.length === 0 ? (
          <div className="px-3 py-4 text-fg-dim text-sm">검색 결과 없음</div>
        ) : (
          groups.map((g) => (
            <StockDateGroupListItem
              key={g.code}
              group={g}
              active={g.code === selectedCode}
              onClick={onSelect}
            />
          ))
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: 테스트 실행 (통과 확인)**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupList.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/inventory/StockDateGroupList.tsx frontend/src/inventory/StockDateGroupList.test.tsx
git commit -m "feat(frontend/inventory): StockDateGroupList (search + list)"
```

---

## Task 5: `StockDateGroupDetail` 컴포넌트 (헤더 + 날짜 테이블)

**Files:**
- Create: `frontend/src/inventory/StockDateGroupDetail.tsx`
- Create: `frontend/src/inventory/StockDateGroupDetail.test.tsx`

- [ ] **Step 1: 테스트 작성**

`frontend/src/inventory/StockDateGroupDetail.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { StockDateGroupDetail } from './StockDateGroupDetail';
import { useTabsStore } from '../state/tabs';
import type { StockDate } from '../api/types';

const navigateMock = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

const row = (code: string, name: string, date: string): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: 1000,
  total_volume: 52_100_000, pages_collected: 1240, file_size_bytes: 13_200_000,
  today_open: 70_000, today_high: 73_000, today_low: 69_000, today_close: 72_400,
});

const rows: StockDate[] = [
  row('005930', '삼성전자', '20260522'),
  row('005930', '삼성전자', '20260521'),
  row('000660', 'SK하이닉스', '20260521'),
];

function renderWithRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('StockDateGroupDetail', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useTabsStore.setState({ tabs: [], activeId: null });
  });

  it('renders the selected group header (code + name + summary)', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode="005930" />);
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText(/2 dates/)).toBeTruthy();
  });

  it('renders one row per date, sorted desc', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode="005930" />);
    const dateCells = screen.getAllByText(/2026-05-\d{2}/);
    expect(dateCells.map(el => el.textContent)).toEqual(['2026-05-22', '2026-05-21']);
  });

  it('shows placeholder when selectedCode is null', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode={null} />);
    expect(screen.getByText('종목을 선택하세요')).toBeTruthy();
  });

  it('falls back to first group when selectedCode is not in rows', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode="999999" />);
    // 첫 그룹(lastCapturedAt desc로 정렬 후 첫 항목)이 표시되어야 한다 — 여기서는 모두 capturedAt=1000이므로 Map insertion 순서.
    // 동률일 경우 안정 정렬에 의해 005930이 먼저, 그 다음 000660.
    expect(screen.getByText('005930')).toBeTruthy();
  });

  it('row click opens a new tab and navigates to /replay', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode="005930" />);
    fireEvent.click(screen.getByText('2026-05-22'));
    expect(navigateMock).toHaveBeenCalledWith('/replay');
    const { tabs, activeId } = useTabsStore.getState();
    expect(tabs).toHaveLength(1);
    const created = tabs.find(t => t.id === activeId)!;
    expect(created.selection).toMatchObject({
      code: '005930',
      fromDate: '20260522',
      toDate: '20260522',
      timeframe: '1m',
    });
  });
});
```

- [ ] **Step 2: 테스트 실행 (실패 예상)**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 컴포넌트 구현**

`frontend/src/inventory/StockDateGroupDetail.tsx`:

```tsx
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { StockDate } from '../api/types';
import { useTabsStore } from '../state/tabs';
import { useStockDateGroups } from './useStockDateGroups';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';

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
              <Th>Date</Th>
              <Th>Captured</Th>
              <Th right>Volume</Th>
              <Th right>Pages</Th>
              <Th right>Size</Th>
              <Th right>OHLC</Th>
            </tr>
          </thead>
          <tbody>
            {group.dates.map((r) => (
              <tr
                key={`${r.code}-${r.date}`}
                onClick={() => onRowClick(r)}
                className="border-b hover:bg-bg-input-hover cursor-pointer"
              >
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

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`px-3 py-2 border-b text-xs uppercase tracking-wider font-semibold text-fg-dimmer ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
```

- [ ] **Step 4: 테스트 실행 (통과 확인)**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/inventory/StockDateGroupDetail.tsx frontend/src/inventory/StockDateGroupDetail.test.tsx
git commit -m "feat(frontend/inventory): StockDateGroupDetail (right panel + replay nav)"
```

---

## Task 6: `Inventory.tsx` 전면 교체

**Files:**
- Modify: `frontend/src/pages/Inventory.tsx` (전체 교체)

- [ ] **Step 1: 새 Inventory.tsx 작성**

기존 [Inventory.tsx](frontend/src/pages/Inventory.tsx)를 다음으로 완전히 대체:

```tsx
import { useEffect, useState } from 'react';
import { useStockDates } from '../api/stock-dates';
import { StockDateGroupList } from '../inventory/StockDateGroupList';
import { StockDateGroupDetail } from '../inventory/StockDateGroupDetail';
import { useStockDateGroups } from '../inventory/useStockDateGroups';

export default function Inventory() {
  const { data: rows = [], isLoading } = useStockDates();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const unfilteredGroups = useStockDateGroups(rows, '');

  useEffect(() => {
    if (selectedCode !== null || unfilteredGroups.length === 0) return;
    setSelectedCode(unfilteredGroups[0].code);
  }, [unfilteredGroups, selectedCode]);

  if (isLoading) {
    return <div className="p-8 text-fg-dim">Loading inventory…</div>;
  }
  if (rows.length === 0) {
    return <div className="p-8 text-fg-dim">캡처된 데이터가 없습니다.</div>;
  }

  return (
    <div
      className="p-md h-full grid gap-md min-h-0"
      style={{ gridTemplateColumns: '320px 1fr' }}
    >
      <StockDateGroupList rows={rows} selectedCode={selectedCode} onSelect={setSelectedCode} />
      <StockDateGroupDetail rows={rows} selectedCode={selectedCode} />
    </div>
  );
}
```

- [ ] **Step 2: 변경된 페이지에 대한 통합 sanity 테스트**

전체 vitest 실행해서 인접 영향(Inventory.tsx를 import하는 곳 등)이 없는지 확인:

Run: `cd frontend && npx vitest run`
Expected: 모든 기존 테스트 + 신규 inventory 테스트 PASS.

- [ ] **Step 3: 타입체크**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: 빌드 sanity**

Run: `cd frontend && npm run build`
Expected: vite 빌드 성공.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/pages/Inventory.tsx
git commit -m "feat(frontend/inventory): swap Inventory page to Master-Detail tree"
```

---

## Task 7: E2E smoke 테스트

**Files:**
- Create: `frontend/tests/e2e/inventory-tree.spec.ts`

- [ ] **Step 1: E2E 작성**

`frontend/tests/e2e/inventory-tree.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

/**
 * STATUS: 데이터 의존적 — 백엔드 inventory에 적어도 2종목·3 dates가 있어야
 * 검색·정렬 동작을 검증할 수 있다. 일부 환경에서는 skip될 수 있다.
 */
test.describe('Inventory tree (Master-Detail)', () => {
  test('search filters left list and row click navigates to /replay', async ({ page }) => {
    await page.goto('/inventory');

    // 좌측 카드 헤더 확인
    await expect(page.getByText(/종목 \d+개/)).toBeVisible({ timeout: 5000 });

    // 우측 카드가 자동 선택된 종목 헤더를 보여야 함
    const detailHeader = page.locator('section h2').first();
    await expect(detailHeader).toBeVisible();

    // 검색 입력 — 한 글자만 쳐도 좁혀져야 함
    const search = page.getByPlaceholder('종목명 또는 코드…');
    await search.fill('0');
    await expect(page.getByText(/\d+ matches/)).toBeVisible();

    // 검색 클리어
    await search.fill('');

    // 우측 첫 행 클릭 → /replay로 이동
    const firstDateRow = page.locator('table tbody tr').first();
    await firstDateRow.click();
    await expect(page).toHaveURL(/\/replay/, { timeout: 5000 });
  });
});
```

- [ ] **Step 2: 백엔드 + 프론트엔드 dev 서버 가동 확인**

(이미 가동 중이면 skip) — CLAUDE.md의 dev server 섹션 참조:
- Backend: `uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga`
- Frontend: `cd frontend && npm run dev`

`curl -s http://127.0.0.1:8000/api/stock-dates | head -c 200`로 데이터 존재 확인.

- [ ] **Step 3: E2E 실행**

Run: `cd frontend && npx playwright test tests/e2e/inventory-tree.spec.ts`
Expected: PASS — 백엔드에 데이터가 있을 경우. 데이터 부재 시 timeout으로 fail → 그 경우 `test.skip(condition)` 처리 추가 검토.

- [ ] **Step 4: 커밋**

```bash
git add frontend/tests/e2e/inventory-tree.spec.ts
git commit -m "test(frontend/e2e): inventory tree smoke"
```

---

## Final Verification

- [ ] **Step 1: 전체 단위/컴포넌트 테스트**

Run: `cd frontend && npx vitest run`
Expected: 모두 PASS.

- [ ] **Step 2: 타입체크 + 빌드**

Run: `cd frontend && npx tsc -b --noEmit && npm run build`
Expected: 모두 PASS.

- [ ] **Step 3: 수동 검증 (브라우저)**

`http://localhost:5173/inventory`를 열어 다음을 확인:
1. 좌·우 카드가 grid로 배치됨 (320px + 1fr)
2. 좌측에 종목 리스트 — 항목당 2줄(코드+이름 / 최근 + 크기) + 우측 dates 배지
3. 첫 항목이 자동 선택되어 우측에 dates 테이블이 보임
4. 좌측 검색창에 "삼" 입력 시 좌측 좁혀짐 + 우측 패널은 그대로 유지
5. 검색 입력에 코드 prefix("0059") 입력 시도 매칭
6. `×` 버튼으로 검색 클리어
7. 우측 dates 행 클릭 시 `/replay`로 이동 + 새 tab 생성

- [ ] **Step 4: 최종 커밋(이미 모두 분리 커밋되어 있다면 skip)**

