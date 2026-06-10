# 관심맵 (Watchlist Heatmap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관심종목 25개 섹터 폴더 120종목을 한 화면에 동시에 펼치고 등락률 히트로 색칠하는 `/heatmap` 페이지 + 경량 인라인 추가(그룹/종목).

**Architecture:** 신규 read-only 보드를 먼저 세우고(Task 1–6, 출시 가능), 그 위에 인라인 추가(Task 7–9)를 얹는다. 데이터는 전부 기존 훅 재사용(`useWatchlist`/`useQuotes`/`useJumpToLive`), 백엔드 무변경. 레이아웃은 CSS multi-column(순수 CSS 메이슨리, 레이아웃 JS 없음).

**Tech Stack:** React 18, react-router 7, @tanstack/react-query 5, zustand 4, Tailwind(토큰 클래스), vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-10-watchlist-heatmap-design.md` (커밋 0131eb5)

**Test runner:** 이 프로젝트엔 `npm test` 스크립트가 없다. 단일 파일은 `cd frontend && npx vitest run <path>` 로 돌린다. 작업 디렉터리는 항상 `frontend/`.

**Commit 주의:** 이 repo의 커밋 훅은 `--no-verify`·`&&`-체이닝 git commit을 차단한다. 각 커밋 스텝은 `git add` 와 `git commit -m "..."` 를 **별도 줄**로(연쇄 `&&` 없이) 실행할 것. 메시지는 한 줄.

---

## File Structure

| 파일 | 책임 | 생성/변경 |
|---|---|---|
| `frontend/src/heatmap/heat.ts` | 순수: `heatBg`, `sortEntries`, `avgPct`, `SortMode` | 생성 |
| `frontend/src/state/heatmapPrefs.ts` | 정렬 토글 zustand 스토어(localStorage 영속) | 생성 |
| `frontend/src/heatmap/HeatmapRow.tsx` | 칼럼형 종목 행(히트 배경 + 색 숫자 + 클릭) | 생성 |
| `frontend/src/heatmap/HeatmapFolder.tsx` | 폴더 블록(헤더 + 정렬된 행들) | 생성 |
| `frontend/src/heatmap/HeatmapBoard.tsx` | CSS multi-column 패킹, 빈 폴더 제외 | 생성 |
| `frontend/src/pages/Heatmap.tsx` | 페이지 셸: 헤더 + 보드 + 상태 | 생성 |
| `frontend/src/main.tsx` | `/heatmap` 라우트 1줄 | 변경 |
| `frontend/src/nav/LeftNav.tsx` | `Heatmap` NavItem 1줄 | 변경 |
| `frontend/src/heatmap/useAddToFolder.ts` | add→move 체이닝 훅 | 생성 |
| `frontend/src/heatmap/FolderAddButton.tsx` | 폴더별 `＋종목` 팝오버 | 생성 |
| (변경) `HeatmapFolder.tsx` | `FolderAddButton` 삽입 | 변경 |
| (변경) `Heatmap.tsx` | `＋새 그룹` + `GroupNameModal` | 변경 |
| `DESIGN.md` | 히트 램프 노트 | 변경 |

각 `*.tsx`/`*.ts` 의 테스트는 같은 폴더에 `*.test.ts(x)`.

---

## Task 1: `heat.ts` — 순수 히트 색상 + 정렬

**Files:**
- Create: `frontend/src/heatmap/heat.ts`
- Test: `frontend/src/heatmap/heat.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/heatmap/heat.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { heatBg, sortEntries, avgPct } from './heat';
import type { WatchlistEntry } from '../api/watchlist';

const E = (code: string, order: number): WatchlistEntry => ({
  code, name: code, registered_at_kst_date: '20260101',
  last_success_date: null, folder_id: 'f1', order,
});

describe('heatBg', () => {
  it('null/0 → transparent', () => {
    expect(heatBg(null)).toBe('transparent');
    expect(heatBg(0)).toBe('transparent');
  });
  it('상승=빨강 / 하락=파랑', () => {
    expect(heatBg(4)).toContain('220,38,38');
    expect(heatBg(-4)).toContain('37,99,235');
  });
  it('±8%에서 max alpha 0.42로 포화', () => {
    expect(heatBg(8)).toBe('rgba(220,38,38,0.420)');
    expect(heatBg(30)).toBe('rgba(220,38,38,0.420)');
    expect(heatBg(4)).toBe('rgba(220,38,38,0.210)');
  });
});

describe('sortEntries', () => {
  const entries = [E('a', 0), E('b', 1), E('c', 2)];
  const pctOf = (c: string): number | null =>
    ({ a: 1.0, b: 5.0, c: null } as Record<string, number | null>)[c] ?? null;
  it('manual = order 오름차순', () => {
    expect(sortEntries(entries, 'manual', pctOf).map((e) => e.code)).toEqual(['a', 'b', 'c']);
  });
  it('change = 등락률 내림차순, null 맨 아래', () => {
    expect(sortEntries(entries, 'change', pctOf).map((e) => e.code)).toEqual(['b', 'a', 'c']);
  });
});

describe('avgPct', () => {
  const entries = [E('a', 0), E('b', 1), E('c', 2)];
  it('비가중 평균; 전부 null이면 null', () => {
    const p = (c: string): number | null => ({ a: 2, b: 4, c: null } as Record<string, number | null>)[c] ?? null;
    expect(avgPct(entries, p)).toBe(3);
    expect(avgPct(entries, () => null)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/heat.test.ts`
Expected: FAIL — `Failed to resolve import "./heat"`.

- [ ] **Step 3: 구현**

`frontend/src/heatmap/heat.ts`:
```ts
import type { WatchlistEntry } from '../api/watchlist';

export type SortMode = 'change' | 'manual';
export const HEAT_SAT = 8;          // 포화 임계(%)
export const HEAT_MAX_ALPHA = 0.42; // 하이브리드 최대 알파(텍스트 가독 한계)

/** 등락률 → 배경 rgba. null/0 = 투명(카드 배경 노출). ±HEAT_SAT% 포화. */
export function heatBg(pct: number | null): string {
  if (pct === null || pct === 0) return 'transparent';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * HEAT_MAX_ALPHA;
  const rgb = pct > 0 ? '220,38,38' : '37,99,235'; // --price-up / --price-down
  return `rgba(${rgb},${a.toFixed(3)})`;
}

/** 폴더 내 정렬. change=등락률 내림차순(null 맨 아래), manual=entry.order. 비파괴(복사). */
export function sortEntries(
  entries: WatchlistEntry[],
  mode: SortMode,
  pctOf: (code: string) => number | null,
): WatchlistEntry[] {
  if (mode === 'manual') return [...entries].sort((a, b) => a.order - b.order);
  return [...entries].sort((a, b) => {
    const pa = pctOf(a.code);
    const pb = pctOf(b.code);
    if (pa === null && pb === null) return a.order - b.order;
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pb - pa;
  });
}

/** 섹터 온도 = 시세 도착 종목의 비가중 평균 등락률. 전부 결측이면 null. */
export function avgPct(
  entries: WatchlistEntry[],
  pctOf: (code: string) => number | null,
): number | null {
  const vals = entries.map((e) => pctOf(e.code)).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/heat.test.ts`
Expected: PASS (3 describe, 7 it).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/heat.ts frontend/src/heatmap/heat.test.ts
git commit -m "feat(heatmap): heat 색상·정렬·평균 순수 함수"
```

---

## Task 2: `heatmapPrefs.ts` — 정렬 토글 스토어

**Files:**
- Create: `frontend/src/state/heatmapPrefs.ts`
- Test: `frontend/src/state/heatmapPrefs.test.ts`

기존 `state/sourcePreference.ts` 패턴을 그대로 따른다(zustand + localStorage, 런타임 검증).

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/state/heatmapPrefs.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useHeatmapPrefsStore, SORT_MODES } from './heatmapPrefs';
import type { SortMode } from '../heatmap/heat';

describe('useHeatmapPrefsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useHeatmapPrefsStore.setState({ sortMode: 'manual' });
  });

  it('기본값 manual (eng-review D2: 안정 보드·큐레이션 순서 유지, change는 옵트인)', () => {
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('manual');
  });
  it('setSortMode 갱신 + 영속', () => {
    useHeatmapPrefsStore.getState().setSortMode('change');
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('change');
    expect(localStorage.getItem('heatmap.sortMode.v1')).toContain('change');
  });
  it('알 수 없는 값 무시', () => {
    const before = useHeatmapPrefsStore.getState().sortMode;
    useHeatmapPrefsStore.getState().setSortMode('bogus' as SortMode);
    expect(useHeatmapPrefsStore.getState().sortMode).toBe(before);
  });
  it('SORT_MODES = [change, manual]', () => {
    expect(SORT_MODES).toEqual(['change', 'manual']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/state/heatmapPrefs.test.ts`
Expected: FAIL — `Failed to resolve import "./heatmapPrefs"`.

- [ ] **Step 3: 구현**

`frontend/src/state/heatmapPrefs.ts`:
```ts
import { create } from 'zustand';
import type { SortMode } from '../heatmap/heat';

export const SORT_MODES = ['change', 'manual'] as const;
const STORAGE_KEY = 'heatmap.sortMode.v1';

interface Store {
  sortMode: SortMode;
  setSortMode: (value: SortMode) => void;
}

function readStorage(): SortMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sortMode: string };
    return SORT_MODES.includes(parsed.sortMode as SortMode)
      ? (parsed.sortMode as SortMode) : null;
  } catch {
    return null;
  }
}

function persist(sortMode: SortMode): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sortMode })); }
  catch { /* localStorage 미가용 — 무시 */ }
}

export const useHeatmapPrefsStore = create<Store>((set) => ({
  // 기본 manual (eng-review D2): 로드 시 안정 보드 + 사용자 큐레이션(주도주 우선)
  // 순서 유지. change(등락률↓)는 옵트인 — 그 모드에선 매 폴링 라이브 재정렬 허용.
  sortMode: readStorage() ?? 'manual',
  setSortMode: (value) => {
    if (!SORT_MODES.includes(value)) return;
    set({ sortMode: value });
    persist(value);
  },
}));
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/state/heatmapPrefs.test.ts`
Expected: PASS (4 it).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/state/heatmapPrefs.ts frontend/src/state/heatmapPrefs.test.ts
git commit -m "feat(heatmap): 정렬 토글 영속 스토어"
```

---

## Task 3: `HeatmapRow.tsx` — 칼럼형 종목 행

**Files:**
- Create: `frontend/src/heatmap/HeatmapRow.tsx`
- Test: `frontend/src/heatmap/HeatmapRow.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/heatmap/HeatmapRow.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { HeatmapRow } from './HeatmapRow';

function row(props: Partial<React.ComponentProps<typeof HeatmapRow>> = {}) {
  return render(
    <HeatmapRow
      name="삼성전자" price={70000} pct={5} changeWon={3000}
      onClick={() => {}} ariaLabel="삼성전자 005930 차트 열기" testId="heatmap-row-005930"
      {...props}
    />,
  );
}

it('등락률·현재가·대비 렌더, 상승=price-up 색', () => {
  row();
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('70,000')).toBeInTheDocument();
  expect(screen.getByText('+3,000')).toBeInTheDocument();
  expect(screen.getByText('▲+5.00')).toHaveClass('text-price-up');
});

it('시세 결측(null) → 가격·대비·등락 모두 —', () => {
  row({ price: null, pct: null, changeWon: null });
  expect(screen.getAllByText('—').length).toBe(3);
});

it('클릭 시 onClick 호출', () => {
  const onClick = vi.fn();
  row({ onClick });
  fireEvent.click(screen.getByTestId('heatmap-row-005930'));
  expect(onClick).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapRow.test.tsx`
Expected: FAIL — `Failed to resolve import "./HeatmapRow"`.

- [ ] **Step 3: 구현**

`frontend/src/heatmap/HeatmapRow.tsx`:
```tsx
import { heatBg } from './heat';
import { priceDirClass } from '../ui/priceDir';

export interface HeatmapRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  changeWon: number | null;
  onClick: () => void;
  ariaLabel: string;
  testId: string;
}

/** 칼럼형 행: 종목명 │ 현재가 │ 대비 │ 등락률. 배경=heatBg(pct), 숫자=priceDirClass.
 *  결측(null)은 '—'·중립. 색+숫자+부호 삼중 표현(색약 보조, ChangeCell 규칙 계승). */
export function HeatmapRow({ name, price, pct, changeWon, onClick, ariaLabel, testId }: HeatmapRowProps) {
  const c = pct === null ? 'text-fg-dim' : priceDirClass(pct);
  const glyph = pct === null ? '' : pct > 0 ? '▲' : pct < 0 ? '▼' : '';
  const sign = (n: number) => (n > 0 ? '+' : '');
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className="grid grid-cols-[1fr_64px_56px_56px] gap-1.5 px-2 py-0.5 items-baseline text-sm cursor-pointer border-b border-border outline-none hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
      style={{ background: heatBg(pct) }}
    >
      <span className="truncate text-fg">{name}</span>
      <span className={`text-right font-mono tabular-nums ${c}`}>
        {price === null ? '—' : price.toLocaleString('ko-KR')}
      </span>
      <span className={`text-right font-mono tabular-nums ${c}`}>
        {changeWon === null ? '—' : `${sign(changeWon)}${changeWon.toLocaleString('ko-KR')}`}
      </span>
      <span className={`text-right font-mono tabular-nums ${c}`}>
        {pct === null ? '—' : `${glyph}${sign(pct)}${pct.toFixed(2)}`}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapRow.test.tsx`
Expected: PASS (3 it).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/HeatmapRow.tsx frontend/src/heatmap/HeatmapRow.test.tsx
git commit -m "feat(heatmap): 칼럼형 종목 행(히트 배경·결측 — ·클릭)"
```

---

## Task 4: `HeatmapFolder.tsx` — 폴더 블록

**Files:**
- Create: `frontend/src/heatmap/HeatmapFolder.tsx`
- Test: `frontend/src/heatmap/HeatmapFolder.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/heatmap/HeatmapFolder.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { HeatmapFolder } from './HeatmapFolder';
import type { WatchlistEntry, WatchlistFolder } from '../api/watchlist';
import type { LiveQuote } from '../api/liveQuotes';

const folder: WatchlistFolder = { id: 'f1', name: '반도체', order: 0 };
const E = (code: string, name: string, order: number): WatchlistEntry => ({
  code, name, registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order,
});
const entries = [E('005930', '삼성전자', 0), E('000660', 'SK하이닉스', 1)];
const quotes = new Map<string, LiveQuote>([
  ['005930', { code: '005930', price: 70000, change_pct: 2, change_won: 1400 }],
  ['000660', { code: '000660', price: 200000, change_pct: 8, change_won: 16000 }],
]);

it('폴더명 + 평균 등락률 표시, change 모드는 등락률 내림차순', () => {
  render(<HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
    sortMode="change" onPick={() => {}} />);
  expect(screen.getByText('반도체')).toBeInTheDocument();
  expect(screen.getByText('+5.0%')).toBeInTheDocument(); // (2+8)/2
  const names = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(names).toEqual(['SK하이닉스', '삼성전자']); // 8% 먼저
});

it('행 클릭 시 onPick(code)', () => {
  const onPick = vi.fn();
  render(<HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
    sortMode="manual" onPick={onPick} />);
  fireEvent.click(screen.getByTestId('heatmap-row-005930'));
  expect(onPick).toHaveBeenCalledWith('005930');
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapFolder.test.tsx`
Expected: FAIL — `Failed to resolve import "./HeatmapFolder"`.

- [ ] **Step 3: 구현**

`frontend/src/heatmap/HeatmapFolder.tsx`:
```tsx
import type { WatchlistFolder, WatchlistEntry } from '../api/watchlist';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapRow } from './HeatmapRow';
import { sortEntries, avgPct, type SortMode } from './heat';
import { priceDirClass } from '../ui/priceDir';

export interface HeatmapFolderProps {
  folder: WatchlistFolder;
  entries: WatchlistEntry[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string) => void;
}

/** 폴더 블록: 헤더(폴더명 + 평균 등락률) + 정렬된 행들. break-inside-avoid 로
 *  CSS multi-column 패킹 시 블록이 칼럼 경계에서 쪼개지지 않게 한다. */
export function HeatmapFolder({ folder, entries, quoteByCode, sortMode, onPick }: HeatmapFolderProps) {
  const pctOf = (code: string): number | null => quoteByCode.get(code)?.change_pct ?? null;
  const sorted = sortEntries(entries, sortMode, pctOf);
  const avg = avgPct(entries, pctOf);
  return (
    <div className="break-inside-avoid bg-bg-card border border-border rounded mb-2 overflow-hidden">
      <div className="flex justify-between items-center bg-bg-subtle px-2 py-1 border-b border-border-strong">
        <span className="text-sm font-semibold text-fg-dim truncate">{folder.name}</span>
        {avg !== null && (
          <span className={`text-xs font-mono tabular-nums ${priceDirClass(avg)}`}>
            {avg > 0 ? '+' : ''}{avg.toFixed(1)}%
          </span>
        )}
      </div>
      {sorted.map((e) => {
        const q = quoteByCode.get(e.code);
        return (
          <HeatmapRow
            key={e.code}
            name={e.name}
            price={q?.price ?? null}
            pct={q?.change_pct ?? null}
            changeWon={q?.change_won ?? null}
            onClick={() => onPick(e.code)}
            ariaLabel={`${e.name} ${e.code} 차트 열기`}
            testId={`heatmap-row-${e.code}`}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapFolder.test.tsx`
Expected: PASS (2 it).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/HeatmapFolder.tsx frontend/src/heatmap/HeatmapFolder.test.tsx
git commit -m "feat(heatmap): 폴더 블록(정렬·평균 등락률)"
```

---

## Task 5: `HeatmapBoard.tsx` — 멀티칼럼 패킹

**Files:**
- Create: `frontend/src/heatmap/HeatmapBoard.tsx`
- Test: `frontend/src/heatmap/HeatmapBoard.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/heatmap/HeatmapBoard.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { HeatmapBoard } from './HeatmapBoard';
import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';

const groups: FolderGroup[] = [
  { folder: { id: 'f1', name: '반도체', order: 0 }, entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order: 0 }] },
  { folder: { id: 'f2', name: '빈폴더', order: 1 }, entries: [] },     // 빈 → 제외
  { folder: null, entries: [                                            // 미분류 → 제외
    { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 }] },
];

it('빈 폴더와 미분류는 보드에서 제외', () => {
  render(<HeatmapBoard groups={groups} quoteByCode={new Map<string, LiveQuote>()}
    sortMode="change" onPick={() => {}} />);
  expect(screen.getByText('반도체')).toBeInTheDocument();
  expect(screen.queryByText('빈폴더')).not.toBeInTheDocument();
  expect(screen.queryByText('SK하이닉스')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapBoard.test.tsx`
Expected: FAIL — `Failed to resolve import "./HeatmapBoard"`.

- [ ] **Step 3: 구현**

`frontend/src/heatmap/HeatmapBoard.tsx`:
```tsx
import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapFolder } from './HeatmapFolder';
import type { SortMode } from './heat';

export interface HeatmapBoardProps {
  groups: FolderGroup[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string) => void;
}

/** 신문형 멀티칼럼 보드. 빈 폴더·미분류(folder===null) 제외. columnWidth 로
 *  가용 폭만큼 칼럼 수가 자동 결정된다(순수 CSS 메이슨리, 레이아웃 JS 없음). */
export function HeatmapBoard({ groups, quoteByCode, sortMode, onPick }: HeatmapBoardProps) {
  const visible = groups.filter((g) => g.folder !== null && g.entries.length > 0);
  return (
    // eng-review Q6: 스크롤 컨테이너(바깥, 높이 한정)와 multicol 블록(안쪽, height
    // auto)을 분리한다. 같은 요소에 overflow-y-auto + column-width 를 두면 높이
    // 고정 multicol 이 칼럼을 세로로 꽉 채우다 가로 오버플로/단일 칼럼으로 깨진다.
    // 바깥이 세로 스크롤, 안쪽이 콘텐츠 높이 기준 신문형 균형 패킹.
    <div className="flex-1 overflow-y-auto p-2">
      <div style={{ columnWidth: '228px', columnGap: '8px' }}>
        {visible.map((g) => (
          <HeatmapFolder
            key={g.folder!.id}
            folder={g.folder!}
            entries={g.entries}
            quoteByCode={quoteByCode}
            sortMode={sortMode}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapBoard.test.tsx`
Expected: PASS (1 it).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/HeatmapBoard.tsx frontend/src/heatmap/HeatmapBoard.test.tsx
git commit -m "feat(heatmap): 멀티칼럼 보드(빈 폴더·미분류 제외)"
```

---

## Task 6: `Heatmap.tsx` 페이지 + 라우트 + 내비 (read-only 보드 출시)

**Files:**
- Create: `frontend/src/pages/Heatmap.tsx`
- Test: `frontend/src/pages/Heatmap.test.tsx`
- Modify: `frontend/src/main.tsx`, `frontend/src/nav/LeftNav.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/pages/Heatmap.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/watchlist', async (orig) => ({
  ...(await orig<typeof import('../api/watchlist')>()),
  getWatchlist: vi.fn(() => Promise.resolve({
    folders: [{ id: 'f1', name: '반도체', order: 0 }],
    entries: [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order: 0 },
      { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order: 1 },
    ],
    next_run_at_ms: 0,
  })),
}));

// 005930(order0) -2%, 000660(order1) +5% — manual≠change 라 토글이 관측 가능.
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useQuotes: vi.fn(() => ({
    data: { phase: 'open', quotes: [
      { code: '005930', price: 70000, change_pct: -2, change_won: -1400 },
      { code: '000660', price: 200000, change_pct: 5, change_won: 10000 },
    ] },
    dataUpdatedAt: 0,
  })),
}));

// liveStatus: 기본 running:true → 배너 없음. 자격증명 배너 테스트에서만 override.
vi.mock('../api/liveStatus', async (orig) => ({
  ...(await orig<typeof import('../api/liveStatus')>()),
  useLiveStatus: vi.fn(() => ({ data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } })),
}));

const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { useLiveStatus } from '../api/liveStatus';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  setActiveCode.mockClear();
  useHeatmapPrefsStore.setState({ sortMode: 'manual' });   // eng-review D2: 기본 manual
  vi.mocked(useLiveStatus).mockReturnValue(
    { data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } } as ReturnType<typeof useLiveStatus>,
  );
});

it('폴더·종목·phase 배지 렌더', async () => {
  renderPage();
  expect(await screen.findByText('반도체')).toBeInTheDocument();
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText(/장중/)).toBeInTheDocument();
});

it('행 클릭 → activeCode 설정(jump-to-live)', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'));
  expect(setActiveCode).toHaveBeenCalledWith('005930');
});

it('기본 manual=order 순, 등락률↓ 토글 시 등락률 내림차순', async () => {
  renderPage();
  await screen.findByText('반도체');
  const manual = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(manual).toEqual(['삼성전자', 'SK하이닉스']);          // order 0,1
  fireEvent.click(screen.getByRole('button', { name: '등락률 ↓' }));
  const change = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(change).toEqual(['SK하이닉스', '삼성전자']);          // +5% 먼저
});

it('관심종목 있는데 KIS 자격증명 없으면(poller 미기동) 배너', async () => {
  vi.mocked(useLiveStatus).mockReturnValue(
    { data: { running: false, started_at_ms: null, cycle_lag_ms: 0 } } as ReturnType<typeof useLiveStatus>,
  );
  renderPage();
  expect(await screen.findByText('KIS 자격증명이 설정되지 않았습니다')).toBeInTheDocument();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/pages/Heatmap.test.tsx`
Expected: FAIL — `Failed to resolve import "./Heatmap"`.

- [ ] **Step 3: 페이지 구현**

`frontend/src/pages/Heatmap.tsx`:
```tsx
import { useMemo } from 'react';
import { useWatchlist } from '../watchlist/useWatchlist';
import { groupByFolder } from '../watchlist/grouping';
import { useQuotes, type LiveQuote } from '../api/liveQuotes';
import { useLiveStatus } from '../api/liveStatus';
import { deriveBannerState } from '../live/useLiveBannerState';
import { LiveStateBanner } from '../live/LiveStateBanner';
import { useJumpToLive } from '../live/useJumpToLive';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { HeatmapBoard } from '../heatmap/HeatmapBoard';

const PHASE_LABEL: Record<string, string> = { pre_open: '장전', open: '● 장중', closed: '장마감' };

export function Heatmap() {
  const { data, isLoading, error } = useWatchlist();
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const folders = useMemo(() => data?.folders ?? [], [data]);
  const codes = useMemo(() => entries.map((e) => e.code), [entries]);

  const quotesQ = useQuotes(codes);
  const statusQ = useLiveStatus();
  const quoteByCode = useMemo(
    () => new Map<string, LiveQuote>((quotesQ.data?.quotes ?? []).map((q) => [q.code, q])),
    [quotesQ.data],
  );
  const groups = useMemo(() => groupByFolder(folders, entries), [folders, entries]);
  const onPick = useJumpToLive();
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const setSortMode = useHeatmapPrefsStore((s) => s.setSortMode);

  const phase = quotesQ.data?.phase;
  const updated = quotesQ.dataUpdatedAt
    ? new Date(quotesQ.dataUpdatedAt).toLocaleTimeString('ko-KR') : '—';
  const visibleCount = groups
    .filter((g) => g.folder !== null && g.entries.length > 0)
    .reduce((n, g) => n + g.entries.length, 0);
  // eng-review Q4: 자격증명 없음/오프라인 배너는 /live 와 동일 신호 재사용(DRY).
  // watchlist_empty 는 아래 빈-상태가 처리하므로 여기선 kis_credentials_missing 만 뜬다.
  const banner = deriveBannerState({ status: statusQ.data ?? null, watchlistSize: entries.length });

  if (isLoading) return <div className="p-4 text-fg-dim">관심종목 불러오는 중…</div>;
  if (error) return <div className="p-4 text-error">관심종목을 불러오지 못했습니다.</div>;
  if (entries.length === 0) return <div className="p-4 text-fg-dim">관심종목이 없습니다.</div>;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="flex items-center gap-3 px-3 py-2 bg-bg-subtle border-b border-border-strong flex-none">
        <span className="text-md font-semibold text-fg">관심맵</span>
        {phase && <span className="text-xs font-mono text-fg-dim">{PHASE_LABEL[phase] ?? phase}</span>}
        <span className="text-xs font-mono text-fg-dimmer">{updated} 갱신 · {visibleCount}종목</span>
        <div className="flex-1" />
        <div className="flex border border-border rounded overflow-hidden text-xs">
          <button
            className={sortMode === 'change' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
            onClick={() => setSortMode('change')}
          >등락률 ↓</button>
          <button
            className={sortMode === 'manual' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
            onClick={() => setSortMode('manual')}
          >수동</button>
        </div>
      </header>
      <LiveStateBanner primary={banner.primary} stack={banner.stack} />
      <HeatmapBoard groups={groups} quoteByCode={quoteByCode} sortMode={sortMode} onPick={onPick} />
    </div>
  );
}
```

- [ ] **Step 4: 라우트 등록 — `frontend/src/main.tsx`**

import 블록(`import Settings from './pages/Settings';` 아래)에 추가:
```tsx
import { Heatmap } from './pages/Heatmap';
```
`<Route path="live" .../>` 아래에 추가:
```tsx
          <Route path="heatmap" element={<Heatmap />} />
```

- [ ] **Step 5: 내비 등록 — `frontend/src/nav/LeftNav.tsx`**

`<NavItem to="/live" label="Live" />` 아래에 추가:
```tsx
        <NavItem to="/heatmap" label="Heatmap" />
```

- [ ] **Step 6: 통과 확인 + 타입 체크**

Run: `cd frontend && npx vitest run src/pages/Heatmap.test.tsx`
Expected: PASS (4 it — 렌더·jump·정렬토글·자격증명배너).
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "heatmap|pages/Heatmap|state/heatmapPrefs" || echo CLEAN`
Expected: `CLEAN` — 우리 파일(heatmap/·pages/Heatmap·state/heatmapPrefs)에 타입 에러 없음. (주의: `tsc -b` 는 기존 무관 파일 `src/chart/seriesDataDiff.test.ts` 등의 **pre-existing** 에러를 함께 출력하므로 위 grep 으로 우리 파일만 본다.)

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.test.tsx frontend/src/main.tsx frontend/src/nav/LeftNav.tsx
git commit -m "feat(heatmap): /heatmap 페이지 + 라우트 + 내비 (read-only 보드)"
```

---

## Task 7: `useAddToFolder.ts` — add→move 체이닝 훅

**Files:**
- Create: `frontend/src/heatmap/useAddToFolder.ts`
- Test: `frontend/src/heatmap/useAddToFolder.test.tsx`

`POST /api/watchlist` 는 code만 받아 미분류에 추가하므로, 폴더 지정 추가 = add 후 move 2-콜. 이미 관심종목이면(409 `already_in_watchlist`) add는 건너뛰고 move만 해 해당 폴더로 옮긴다.

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/heatmap/useAddToFolder.test.tsx`:
```tsx
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../api/watchlist', async (orig) => ({
  ...(await orig<typeof import('../api/watchlist')>()),
  addToWatchlist: vi.fn(() => Promise.resolve({
    code: '005930', name: '삼성전자', registered_at_kst_date: '20260101',
    last_success_date: null, folder_id: null, order: 0 })),
  moveEntries: vi.fn(() => Promise.resolve()),
}));

import { useAddToFolder } from './useAddToFolder';
import { addToWatchlist, moveEntries } from '../api/watchlist';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => { vi.clearAllMocks(); });

it('추가 후 해당 폴더로 이동', async () => {
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await act(async () => { await result.current.addToFolder('005930', 'f1'); });
  expect(addToWatchlist).toHaveBeenCalledWith('005930');
  expect(moveEntries).toHaveBeenCalledWith(['005930'], 'f1');
});

it('이미 관심종목(409)이면 add 건너뛰고 move만', async () => {
  // 실제 ApiError 형태로 모킹 — .code 가 핵심(message 가 아님).
  vi.mocked(addToWatchlist).mockRejectedValueOnce(
    Object.assign(new Error('Code 005930 is already in the Watchlist.'), {
      code: 'already_in_watchlist', status: 409,
    }),
  );
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await act(async () => { await result.current.addToFolder('005930', 'f1'); });
  expect(moveEntries).toHaveBeenCalledWith(['005930'], 'f1');
});

it('add가 다른 에러면 전파(move 안 함)', async () => {
  vi.mocked(addToWatchlist).mockRejectedValueOnce(new Error('boom'));
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await expect(
    act(async () => { await result.current.addToFolder('005930', 'f1'); }),
  ).rejects.toThrow('boom');
  expect(moveEntries).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/useAddToFolder.test.tsx`
Expected: FAIL — `Failed to resolve import "./useAddToFolder"`.

- [ ] **Step 3: 구현**

`frontend/src/heatmap/useAddToFolder.ts`:
```ts
import { useAddToWatchlist, useMoveEntries } from '../watchlist/useWatchlist';
import type { ApiError } from '../api/client';

// 주의: apiCall(client.ts)은 안정 코드를 ApiError.code 에 둔다 — err.message 는
// 사람용 문구('Code ... is already in the Watchlist.')라 code 문자열을 안 담는다.
// 따라서 message.includes 가 아니라 .code 로 판정해야 한다(검증으로 확인된 버그).
function isAlreadyInWatchlist(e: unknown): boolean {
  return (e as ApiError | null)?.code === 'already_in_watchlist';
}

/** 폴더 지정 추가 = addToWatchlist(미분류 진입) → moveEntries(폴더로).
 *  이미 있으면(409) add는 무시하고 move만. add가 다른 에러면 전파(move 안 함).
 *  부분 실패(add 성공·move 실패) 시 종목은 미분류에 남아 드로어로 복구 가능 — 유실 없음. */
export function useAddToFolder() {
  const addM = useAddToWatchlist();
  const moveM = useMoveEntries();
  const addToFolder = async (code: string, folderId: string) => {
    try {
      await addM.mutateAsync(code);
    } catch (e) {
      if (!isAlreadyInWatchlist(e)) throw e;
    }
    await moveM.mutateAsync({ codes: [code], folderId });
  };
  return {
    addToFolder,
    isPending: addM.isPending || moveM.isPending,
    error: addM.error ?? moveM.error,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/useAddToFolder.test.tsx`
Expected: PASS (3 it).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/useAddToFolder.ts frontend/src/heatmap/useAddToFolder.test.tsx
git commit -m "feat(heatmap): 폴더 지정 추가 훅(add→move, 409 우회)"
```

---

## Task 8: `FolderAddButton.tsx` — 폴더별 `＋종목` + HeatmapFolder 삽입

**Files:**
- Create: `frontend/src/heatmap/FolderAddButton.tsx`
- Test: `frontend/src/heatmap/FolderAddButton.test.tsx`
- Modify: `frontend/src/heatmap/HeatmapFolder.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/heatmap/FolderAddButton.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi, beforeEach } from 'vitest';

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: { code: string; name: string; market: string }) => void }) =>
    <button data-testid="pick" onClick={() => onChange({ code: '005930', name: '삼성전자', market: 'KOSPI' })}>pick</button>,
}));

const { addToFolder } = vi.hoisted(() => ({ addToFolder: vi.fn(() => Promise.resolve()) }));
vi.mock('./useAddToFolder', () => ({
  useAddToFolder: () => ({ addToFolder, isPending: false, error: null }),
}));

import { FolderAddButton } from './FolderAddButton';

beforeEach(() => { addToFolder.mockClear(); });

it('＋종목 → 종목 선택 → 추가 시 addToFolder(code, folderId)', async () => {
  render(<FolderAddButton folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  fireEvent.click(screen.getByTestId('pick'));
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
  await waitFor(() => expect(addToFolder).toHaveBeenCalledWith('005930', 'f1'));
});

it('미선택 시 추가 버튼 비활성', () => {
  render(<FolderAddButton folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  expect(screen.getByRole('button', { name: '추가' })).toBeDisabled();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/FolderAddButton.test.tsx`
Expected: FAIL — `Failed to resolve import "./FolderAddButton"`.

- [ ] **Step 3: 구현**

`frontend/src/heatmap/FolderAddButton.tsx`:
```tsx
import { useState } from 'react';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddToFolder } from './useAddToFolder';

/** 폴더 헤더의 ＋종목: SymbolSearch 팝오버 → useAddToFolder(code, folderId).
 *  성공 시 닫고 선택 초기화. 무거운 편집(삭제·이동·재정렬)은 관심종목 드로어. */
export function FolderAddButton({ folderId }: { folderId: string }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<SymbolHit | null>(null);
  const { addToFolder, isPending } = useAddToFolder();

  const close = () => { setOpen(false); setPicked(null); };
  const submit = async () => {
    if (!picked) return;
    await addToFolder(picked.code, folderId);
    close();
  };

  return (
    <div className="relative">
      <button aria-label="종목 추가" className="text-xs text-fg-dimmer hover:text-accent"
        onClick={() => setOpen((v) => !v)}>＋종목</button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-64 bg-bg-card border border-border-strong rounded p-2 flex flex-col gap-2">
          <SymbolSearch value={picked} onChange={setPicked} />
          <div className="flex justify-end gap-2">
            <button className="text-xs px-2 py-1 text-fg-dim" onClick={close}>닫기</button>
            <button className="text-xs px-2 py-1 rounded bg-accent text-accent-fg disabled:opacity-40"
              disabled={!picked || isPending} onClick={submit}>추가</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: HeatmapFolder 헤더에 삽입 — `frontend/src/heatmap/HeatmapFolder.tsx`**

상단 import에 추가:
```tsx
import { FolderAddButton } from './FolderAddButton';
```
헤더의 평균 등락률 `<span>` 을 우측 그룹으로 감싸 `FolderAddButton` 을 나란히 둔다. 기존:
```tsx
      <div className="flex justify-between items-center bg-bg-subtle px-2 py-1 border-b border-border-strong">
        <span className="text-sm font-semibold text-fg-dim truncate">{folder.name}</span>
        {avg !== null && (
          <span className={`text-xs font-mono tabular-nums ${priceDirClass(avg)}`}>
            {avg > 0 ? '+' : ''}{avg.toFixed(1)}%
          </span>
        )}
      </div>
```
교체:
```tsx
      <div className="flex justify-between items-center bg-bg-subtle px-2 py-1 border-b border-border-strong">
        <span className="text-sm font-semibold text-fg-dim truncate">{folder.name}</span>
        <span className="flex items-center gap-2">
          {avg !== null && (
            <span className={`text-xs font-mono tabular-nums ${priceDirClass(avg)}`}>
              {avg > 0 ? '+' : ''}{avg.toFixed(1)}%
            </span>
          )}
          <FolderAddButton folderId={folder.id} />
        </span>
      </div>
```

- [ ] **Step 5: 컴포넌트 테스트에 FolderAddButton 목 추가 (필수 — 안 하면 회귀 실패)**

이제 `HeatmapFolder` 가 `FolderAddButton` 을 렌더한다. `FolderAddButton` → `useAddToFolder` → `useAddToWatchlist`(useMutation) → `useQueryClient` 라, **QueryClientProvider 없이 bare render 하는** `HeatmapFolder.test.tsx`·`HeatmapBoard.test.tsx`(Task 4·5)가 "No QueryClient set" 로 깨진다. 두 테스트를 폴더/보드 로직에 집중시키기 위해 FolderAddButton 을 stub 으로 목한다.

`frontend/src/heatmap/HeatmapFolder.test.tsx` 상단 import 위(파일 맨 위)에 추가:
```tsx
import { vi } from 'vitest';
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));
```
(이미 `vi` 를 import 중이면 `import { vi }` 줄은 중복 추가하지 말 것 — `vi.mock(...)` 한 줄만 최상단에 둔다. vitest 는 `vi.mock` 을 파일 상단으로 호이스트한다.)

`frontend/src/heatmap/HeatmapBoard.test.tsx` 에도 동일하게 최상단에 추가:
```tsx
import { vi } from 'vitest';
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));
```

- [ ] **Step 6: 통과 확인 + 회귀**

Run: `cd frontend && npx vitest run src/heatmap/FolderAddButton.test.tsx src/heatmap/HeatmapFolder.test.tsx src/heatmap/HeatmapBoard.test.tsx`
Expected: PASS (2 + 2 + 1 it). 페이지 테스트(`Heatmap.test.tsx`)는 QueryClientProvider 로 감싸므로 목 없이도 그대로 통과(확인용으로 함께 돌려도 됨).

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/heatmap/FolderAddButton.tsx frontend/src/heatmap/FolderAddButton.test.tsx frontend/src/heatmap/HeatmapFolder.tsx frontend/src/heatmap/HeatmapFolder.test.tsx frontend/src/heatmap/HeatmapBoard.test.tsx
git commit -m "feat(heatmap): 폴더별 ＋종목 인라인 추가"
```

---

## Task 9: `＋새 그룹` — Heatmap 헤더 + GroupNameModal

**Files:**
- Modify: `frontend/src/pages/Heatmap.tsx`
- Test: `frontend/src/pages/Heatmap.newgroup.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/pages/Heatmap.newgroup.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/watchlist', async (orig) => ({
  ...(await orig<typeof import('../api/watchlist')>()),
  getWatchlist: vi.fn(() => Promise.resolve({
    folders: [{ id: 'f1', name: '반도체', order: 0 }],
    entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order: 0 }],
    next_run_at_ms: 0,
  })),
  createFolder: vi.fn(() => Promise.resolve({ id: 'f2', name: '방산', order: 1 })),
}));
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useQuotes: vi.fn(() => ({ data: { phase: 'open', quotes: [] }, dataUpdatedAt: 0 })),
}));
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));

import { Heatmap } from './Heatmap';
import { createFolder } from '../api/watchlist';

beforeEach(() => { vi.clearAllMocks(); });

it('＋새 그룹 → 이름 입력 → 만들기 시 createFolder 호출', async () => {
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '＋ 새 그룹' }));
  fireEvent.change(screen.getByPlaceholderText('그룹 이름 입력'), { target: { value: '방산' } });
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() => expect(createFolder).toHaveBeenCalledWith('방산'));
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/pages/Heatmap.newgroup.test.tsx`
Expected: FAIL — `＋ 새 그룹` 버튼 없음(`Unable to find role="button" name "＋ 새 그룹"`).

- [ ] **Step 3: Heatmap.tsx 수정**

상단 import에 추가:
```tsx
import { useState } from 'react';
import { useCreateFolder } from '../watchlist/useWatchlist';
import { GroupNameModal } from '../watchlist/GroupNameModal';
```
(`import { useMemo } from 'react';` 는 `import { useMemo, useState } from 'react';` 로 합친다.)

컴포넌트 본문 훅 선언부(`const setSortMode = ...` 아래)에 추가:
```tsx
  const [showNewGroup, setShowNewGroup] = useState(false);
  const createFolderM = useCreateFolder();
```

헤더의 정렬 토글 `<div className="flex border ...">` **앞**에 ＋새 그룹 버튼 추가:
```tsx
        <button className="text-xs px-2 py-1 rounded border border-border text-fg-dim hover:text-accent"
          onClick={() => setShowNewGroup(true)}>＋ 새 그룹</button>
```

`</header>` 와 `<HeatmapBoard .../>` 사이(또는 컴포넌트 return 최상위 div 안 끝)에 모달 추가:
```tsx
      {showNewGroup && (
        <GroupNameModal
          title="새 그룹 만들기"
          submitLabel="만들기"
          busy={createFolderM.isPending}
          onSubmit={async (name) => { await createFolderM.mutateAsync(name); }}
          onClose={() => setShowNewGroup(false)}
        />
      )}
```

- [ ] **Step 4: 통과 확인 + 회귀 + 타입**

Run: `cd frontend && npx vitest run src/pages/Heatmap.newgroup.test.tsx src/pages/Heatmap.test.tsx`
Expected: PASS (1 + 3 it).
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "heatmap|pages/Heatmap|state/heatmapPrefs" || echo CLEAN`
Expected: `CLEAN` — 우리 파일(heatmap/·pages/Heatmap·state/heatmapPrefs)에 타입 에러 없음. (주의: `tsc -b` 는 기존 무관 파일 `src/chart/seriesDataDiff.test.ts` 등의 **pre-existing** 에러를 함께 출력하므로 위 grep 으로 우리 파일만 본다.)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.newgroup.test.tsx
git commit -m "feat(heatmap): ＋새 그룹 인라인 생성"
```

---

## Task 10: DESIGN.md/CONTEXT.md 노트 + 전체 회귀 + 수동 스모크

**Files:**
- Modify: `DESIGN.md`, `CONTEXT.md`

- [ ] **Step 1: DESIGN.md 히트 램프 노트 추가**

`DESIGN.md` 의 "## Color" 절 끝(`- **Dark mode:** Only mode in v1.` 줄 앞)에 추가:
```markdown
- **Price-direction heat ramp (히트맵 보드 전용):** `frontend/src/heatmap/heat.ts::heatBg()` 가
  `--price-up`/`--price-down` 을 |등락률| 비례 가변 알파(±8% 포화, max 0.42)로 배경에 사용한다.
  단일 0.10 칩 토큰의 확장이며 색상 카테고리(가격 방향)는 준수. 숫자는 `priceDirClass()` 색을
  유지해 배경+숫자+부호 삼중 표현(색약 보조).
```

- [ ] **Step 2: CONTEXT.md 용어 등재 — 관심맵 (eng-review Q7·Q1)**

`CONTEXT.md` 의 **Watchlist Edit Modal** 항목 바로 뒤에 새 용어를 추가한다(글로서리 일관성). `＋종목`/`＋새 그룹` 인라인 추가가 **Watchlist Panel** 의 2026-06-05 "추가는 편집 모달로만" 결정과 모순돼 보이지 않도록, 그 결정은 **패널 한정**임을 _Avoid_ 에 명시:
```markdown
**관심맵 (Watchlist Heatmap)**:
`/heatmap` 풀페이지 보드 — 한 **Watchlist** 의 모든 **Watchlist Folder**(섹터) 종목을 동시에
신문형 멀티칼럼(CSS multi-column)으로 펼쳐 **Live Quote**(현재가·전일대비·등락률) 를 등락률
히트(±8% 포화 가변 알파, `--price-up`/`--price-down`; `heat.ts::heatBg`)로 칠한 시장-온도 스캔
화면. 행 클릭 → **activeCode** 설정 + `/live` 점프(**Watchlist Panel**·**Screener Panel** 과 같은
jump-to-chart). 정렬 토글 manual(=`entry.order`, **기본** — 안정 보드·큐레이션 순서)↔change(등락률↓,
**옵트인** 라이브 재정렬). 폴더 헤더에 **인라인 ＋종목**(SymbolSearch 팝오버 → add 후 move 2-콜),
상단 **＋새 그룹**(GroupNameModal). `useWatchlist`+`useQuotes`(10s)+`useLiveStatus` 재사용,
백엔드 무변경. KIS 자격증명 없음/오프라인은 **Live Quote** 미도착으로 셀이 `—`, `LiveStateBanner`
재사용으로 자격증명 배너 표시. Implemented as `pages/Heatmap.tsx` + `heatmap/*`.
_Avoid_: **Watchlist Panel** 과 혼동(패널은 우측 레일의 한 폴더 read+navigate 스트립; 관심맵은 전
폴더 동시 풀페이지 보드); 관심맵의 인라인 추가를 "패널 빠른추가 부활"로 읽기 — 패널의 추가-일원화
(2026-06-05, 추가는 **Watchlist Edit Modal** 로만)는 **패널 한정** 결정이고, 관심맵(넓은 보드)은
별도 표면이라 자체 인라인 추가를 가진다.
```

- [ ] **Step 3: 전체 히트맵 테스트 회귀**

Run: `cd frontend && npx vitest run src/heatmap src/state/heatmapPrefs.test.ts src/pages/Heatmap.test.tsx src/pages/Heatmap.newgroup.test.tsx`
Expected: 전부 PASS.

- [ ] **Step 4: 린트 + 타입**

Run: `cd frontend && npx tsc -b 2>&1 | grep -E "heatmap|pages/Heatmap|state/heatmapPrefs" || echo CLEAN`
Expected: `CLEAN` — 우리 파일(heatmap/·pages/Heatmap·state/heatmapPrefs)에 타입 에러 없음. (주의: `tsc -b` 는 기존 무관 파일 `src/chart/seriesDataDiff.test.ts` 등의 **pre-existing** 에러를 함께 출력하므로 위 grep 으로 우리 파일만 본다.)
Run: `cd frontend && npm run lint`
Expected: heatmap 관련 신규 파일에 에러 없음.

- [ ] **Step 5: 수동 브라우저 스모크**

백엔드 + 프론트 dev 서버 기동(루트 CLAUDE.md 참고) 후 `/browse` 로:
```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/heatmap
$B console --errors      # 0건 기대
$B text                  # 폴더명·종목·등락률 보이는지
```
확인 항목: ① 25개 폴더가 신문형 칼럼으로 한 화면(가로 오버플로/단일칼럼 깨짐 없음 — Q6), ② 등락률 배경 틴트(상승 빨강/하락 파랑), ③ 정렬 토글 manual(기본)↔등락률↓ 동작, ④ 행 클릭 → /live 차트 전환, ⑤ ＋새 그룹·＋종목 동작(테스트 후 추가분은 드로어에서 정리), ⑥ phase 배지·갱신 시각, ⑦ (가능하면) KIS 자격증명 미설정 시 배너.

- [ ] **Step 6: 커밋**

```bash
git add DESIGN.md CONTEXT.md
git commit -m "docs: 히트 램프(DESIGN) + 관심맵 용어(CONTEXT) 등재"
```

---

## Self-Review 결과 (작성자 점검)

- **Spec 커버리지**: §2 레이아웃→T3–6, §6 히트→T1, §7 정렬→T1·T2·T6, §8 phase/결측→T3·T6, §9 인라인 추가→T7–9, §10 DESIGN→T10, §11 테스트→각 태스크. §12 구축은 명시적 비범위(별도 작업). 누락 없음.
- **Placeholder 스캔**: 모든 스텝에 실제 코드·명령·기대 출력. TBD/TODO 없음.
- **타입 일관성**: `SortMode`(heat.ts) ← heatmapPrefs·HeatmapFolder·HeatmapBoard·Heatmap 동일 import. `heatBg`/`sortEntries`/`avgPct` 시그니처 호출부와 일치. `useAddToFolder().addToFolder(code, folderId)` 호출부(FolderAddButton)와 일치. `LiveQuote`/`WatchlistEntry`/`WatchlistFolder`/`FolderGroup` 전부 기존 export.
- **출시 분할**: T1–6 = read-only 보드(단독 동작), T7–9 = 인라인 추가, T10 = 문서·검증. 각 태스크 커밋 시 테스트 green.

## 대조 검증 결과 (코드베이스 4-슬라이스 병렬, 49건 중 45 OK)

실행 전 임베드 코드를 실제 코드베이스와 대조해 3건을 수정 반영했다:
1. **(wrong, 2개 에이전트 독립 검출) T7 `useAddToFolder` 409 우회** — `apiCall` 의 `ApiError` 는 안정 코드를 `.code` 에 두고 `.message` 는 사람용 문구다. `message.includes('already_in_watchlist')` 는 항상 false → 409에서 move 미실행. `.code === 'already_in_watchlist'` 로 수정 + 테스트 모킹을 `ApiError` 형태로 교체.
2. **(risky) T8 후 `HeatmapFolder.test`·`HeatmapBoard.test` 회귀 실패** — `FolderAddButton`(→`useQueryClient`)이 두 bare-render 테스트를 깬다. 두 테스트에 `vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }))` 추가(Step 5 신설).
3. **(risky, 보류) `FolderAddButton.test` 의 SymbolHit 목 불완전** — 목 팩토리 내부라 컴파일/런타임 무해(`.code` 만 사용). 수정 불요.

나머지 45건(임포트·시그니처·tailwind 토큰·react-query 반환·테스트 하네스·heatBg 산술·sortEntries null 처리)은 실제 코드와 일치 확인.

## 엔지니어링 리뷰(plan-eng-review) 반영 — 7개 열린 질문 결정

그릴링에서 식별한 7개를 eng 리뷰로 해소(코드 근거 포함). 반영 위치 명시:

| # | 질문 | 결정 | 반영 |
|---|---|---|---|
| Q1 | 인라인 ＋종목 vs 2026-06-05 "추가는 편집모달로만"(패널) | **인라인 팝오버 유지**(D1) — 패널 결정은 패널 한정, 히트맵은 별도 표면. SymbolSearch 재사용(DRY) | T8 유지, CONTEXT.md _Avoid_ 스코프(T10 Step2) |
| Q2 | change 정렬 churn / 기본 모드 | **기본 manual**(D2) — 안정·큐레이션 순서. change는 옵트인 라이브 재정렬 | T2 기본값 manual, T6 토글 테스트 |
| Q3 | 120종목 폴링 cadence | **10s 유지** — 30개×4청크=0.4 req/s vs 15/s 공유버킷(`kis_client.py:56`), /heatmap선 /live 언마운트로 경합 없음 | 변경 없음 |
| Q4 | 오프라인/자격증명 배너 | **`deriveBannerState`+`LiveStateBanner` 재사용**(DRY) — `kis_credentials_missing` 배너 | T6 페이지+테스트 |
| Q5 | 히트 채도 고정 vs 적응 | **고정 ±8%** — 절대 의미 보존(boring by default), `HEAT_SAT` 튜너블 | 변경 없음 |
| Q6 | CSS multi-column 패킹 | **스크롤 컨테이너↔multicol 블록 분리**(실 버그) — 같은 요소 overflow+column-width는 깨짐 | T5 HeatmapBoard 수정 |
| Q7 | phase 배지 색 + 용어 | **중립 회색 유지**(가격색 오용 아님) + **"관심맵" CONTEXT.md 등재** | T10 Step2 |

eng-manager 렌즈: Q2/Q6은 systems-over-heroes(안정 보드·3am 클릭)·reversibility, Q3/Q5는 boring-by-default, Q4는 DRY 재사용, Q1은 surface-difference로 모순 해소.
