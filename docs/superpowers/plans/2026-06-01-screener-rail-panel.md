# 우측 레일 스크리너 패널 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 우측 레일에 `관심` 아래 `스크리너` 항목을 추가해, 저장한 조건검색을 골라 조회하고 결과 행을 클릭하면 차트가 그 종목으로 바뀌는 앱-전역 패널을 만든다.

**Architecture:** `WatchlistDrawer`와 대등한 분리형 패널(`ScreenerDrawer`)을 새로 만들고, 레일 크롬 상태를 boolean `panelOpen` → enum `activePanel: 'watchlist'|'screener'|null`로 바꿔 한 번에 하나의 패널만 열리게 한다(App 그리드의 단일 패널 컬럼 불변량 보존). 스캔은 기존 `useScreener`/저장 목록은 `useSavedScreeners`/신선도는 `useScreenerStatus`를 그대로 재사용한다. 결과는 메모리 스토어(`screenerPanel`)에 보관해 닫기·라우트 이동에는 유지하고 새로고침엔 비운다. 차트 전환은 단일 진실 공급원 `useLivePageStore.setActiveCode`를 거친다. 백엔드 변경 없음.

**Tech Stack:** React 18 + TypeScript, zustand 4, @tanstack/react-query 5, react-router 7, Tailwind(프로젝트 디자인 토큰), vitest 4 + @testing-library/react(jsdom).

**Spec:** [docs/superpowers/specs/2026-06-01-screener-rail-panel-design.md](../specs/2026-06-01-screener-rail-panel-design.md)

**작업 디렉터리:** 모든 명령은 `frontend/`에서 실행한다. 테스트는 `npx vitest run <path>`(이 repo엔 `test` npm 스크립트가 없다), 타입체크는 `npx tsc -b`.

---

## File Structure

| 파일 | 책임 | 신규/수정 |
|---|---|---|
| `src/screener/ChangeCell.tsx` | 등락률 셀(KRX 색 + ▲▼, null→"—"). 페이지·패널 공유 | 신규(추출) |
| `src/screener/ChangeCell.test.tsx` | ChangeCell 3분기 테스트 | 신규 |
| `src/screener/ResultTable.tsx` | 전체 페이지 결과 테이블 — 인라인 ChangeCell 제거, import로 교체 | 수정 |
| `src/ui/FunnelIcon.tsx` | 스크리너 레일 항목 아이콘(HeartIcon 패턴, currentColor) | 신규 |
| `src/ui/FunnelIcon.test.tsx` | filled prop이 fill 속성을 토글하는지 | 신규 |
| `src/state/screenerPanel.ts` | 패널 상태 스토어: 선택 id(영속) + lastScan(메모리) | 신규 |
| `src/state/screenerPanel.test.ts` | 영속/복원/비영속/clear | 신규 |
| `src/screener/ScreenerDrawer.tsx` | 패널 본문(드롭다운·조회·갱신·신선도·결과·행클릭) | 신규 |
| `src/screener/ScreenerDrawer.test.tsx` | 드롭다운·조회·결과클릭·엣지 상태 | 신규 |
| `src/state/rightRail.ts` | 레일 크롬 상태: enum + 레거시 마이그레이션 | 수정 |
| `src/state/rightRail.test.ts` | enum 전환·셰브론·마이그레이션·손상값 | 수정 |
| `src/rightrail/RightRail.tsx` | 레일 항목 2개(관심·스크리너) | 수정 |
| `src/rightrail/RightRail.test.tsx` | 항목 2개·active·aria | 수정 |
| `src/live/useLiveKeyboard.ts` | `w`/`Escape` 단축키를 enum API로 | 수정 |
| `src/live/useLiveKeyboard.test.tsx` | 단축키 테스트 enum 반영 | 수정 |
| `src/App.tsx` | 그리드 컬럼 + 두 드로어 조건부 렌더 | 수정 |
| `docs/adr/0052-global-right-rail-state-store.md` | 항목 2개·enum 노트 | 수정 |

**Task 순서 근거:** Task 5(레일 enum 리팩터)는 `panelOpen`을 쓰는 4개 파일(store·RightRail·useLiveKeyboard·App)을 동시에 깨므로, 컴파일이 다시 초록이 되려면 한 묶음으로 착지해야 한다. 그래서 그 묶음이 의존하는 `FunnelIcon`(Task 2)·`screenerPanel` 스토어(Task 3)·`ScreenerDrawer`(Task 4)를 먼저 만들고, 마지막에 리팩터를 원자적으로 커밋한다. Task 1~4는 각자 독립적으로 초록을 유지한다.

---

## Task 1: ChangeCell 공유 컴포넌트 추출

등락률 포맷이 페이지·패널에서 갈라지지 않도록 `ResultTable`의 인라인 `ChangeCell`을 공유 컴포넌트로 추출한다.

**Files:**
- Create: `frontend/src/screener/ChangeCell.tsx`
- Create: `frontend/src/screener/ChangeCell.test.tsx`
- Modify: `frontend/src/screener/ResultTable.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `frontend/src/screener/ChangeCell.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChangeCell } from './ChangeCell';

describe('ChangeCell', () => {
  it('renders "—" for null', () => {
    render(<ChangeCell pct={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders a red up cell with ▲ and + sign for positive', () => {
    render(<ChangeCell pct={2.1} />);
    const el = screen.getByText(/▲ \+2\.10%/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-price-up');
  });

  it('renders a blue down cell with ▼ for negative', () => {
    render(<ChangeCell pct={-1.2} />);
    const el = screen.getByText(/▼ -1\.20%/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-price-down');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/screener/ChangeCell.test.tsx`
Expected: FAIL — `Cannot find module './ChangeCell'`.

- [ ] **Step 3: ChangeCell 컴포넌트 생성**

Create `frontend/src/screener/ChangeCell.tsx` (현행 `ResultTable.tsx:13-19`의 로직을 한 글자도 바꾸지 않고 옮긴다):

```tsx
/** change_pct cell — sign-based KRX color (DESIGN DECISION): >0 text-price-up
 *  (red), <0 text-price-down (blue), 0 neutral --fg-dim. ▲▼ glyph for
 *  colorblind redundancy. null → "—". NOT western green=up. */
export function ChangeCell({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-fg-dim">—</span>;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const cls = dir === 'up' ? 'text-price-up' : dir === 'down' ? 'text-price-down' : 'text-fg-dim';
  const glyph = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  return <span className={cls}>{glyph}{glyph && ' '}{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span>;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/screener/ChangeCell.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: ResultTable에서 인라인 정의 제거 후 import**

Modify `frontend/src/screener/ResultTable.tsx`:

1. 파일 상단 import 줄 바로 아래에 추가: `import { ChangeCell } from './ChangeCell';` (현재 1번 줄 `import type { ScreenerRow } from '../api/screener';` 다음).
2. 인라인 `ChangeCell` 정의(주석 포함 `/** change_pct cell ... */`부터 함수 본문 닫는 `}`까지, 현행 10-19줄)를 통째로 삭제.
3. 나머지(`COLS`, `toEok`, `ResultTable`)는 그대로 둔다. `ResultTable` 내부의 `<ChangeCell pct={r.change_pct} />` 사용처는 import된 컴포넌트를 그대로 가리킨다.

- [ ] **Step 6: 타입체크 + 회귀 테스트**

Run: `cd frontend && npx tsc -b && npx vitest run src/screener/ChangeCell.test.tsx src/pages/Screener.test.tsx`
Expected: tsc 무오류, 모든 테스트 PASS (Screener 페이지가 ResultTable을 통해 여전히 정상 렌더).

- [ ] **Step 7: 커밋**

```bash
cd frontend && git add src/screener/ChangeCell.tsx src/screener/ChangeCell.test.tsx src/screener/ResultTable.tsx && \
git commit src/screener/ChangeCell.tsx src/screener/ChangeCell.test.tsx src/screener/ResultTable.tsx -m "refactor(screener): extract shared ChangeCell from ResultTable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: FunnelIcon

스크리너 레일 항목의 아이콘. `HeartIcon`과 동일 패턴(`fill=currentColor`는 2차 강조가 아닌 *모양* 신호).

**Files:**
- Create: `frontend/src/ui/FunnelIcon.tsx`
- Create: `frontend/src/ui/FunnelIcon.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `frontend/src/ui/FunnelIcon.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FunnelIcon } from './FunnelIcon';

describe('FunnelIcon', () => {
  it('fills with currentColor when filled', () => {
    const { container } = render(<FunnelIcon filled className="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('class')).toBe('x');
  });

  it('uses no fill when not filled', () => {
    const { container } = render(<FunnelIcon filled={false} />);
    expect(container.querySelector('svg')!.getAttribute('fill')).toBe('none');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/ui/FunnelIcon.test.tsx`
Expected: FAIL — `Cannot find module './FunnelIcon'`.

- [ ] **Step 3: 컴포넌트 생성**

Create `frontend/src/ui/FunnelIcon.tsx`:

```tsx
/**
 * Shared funnel glyph for the Screener rail item. Fill = currentColor (a *shape*
 * signal, NOT a second accent — mirrors HeartIcon / DESIGN.md color discipline).
 * Sizing is via `className` (e.g. "w-[1.125em] h-[1.125em]").
 */
export function FunnelIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 4.5h18l-7 8v6.5l-4 2v-8.5z" />
    </svg>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/ui/FunnelIcon.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
cd frontend && git add src/ui/FunnelIcon.tsx src/ui/FunnelIcon.test.tsx && \
git commit src/ui/FunnelIcon.tsx src/ui/FunnelIcon.test.tsx -m "feat(ui): add FunnelIcon for screener rail item

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: screenerPanel 스토어

선택한 조건(`selectedSavedId`, localStorage 영속) + 마지막 스캔 결과(`lastScan`, 메모리만). `rightRail.ts`의 "모듈 로드 시 동기 read + 부분 영속" 패턴을 따른다.

**Files:**
- Create: `frontend/src/state/screenerPanel.ts`
- Create: `frontend/src/state/screenerPanel.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `frontend/src/state/screenerPanel.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useScreenerPanelStore, type PanelScan } from './screenerPanel';

const SCAN: PanelScan = {
  savedId: 's1', savedName: '돌파', rows: [], scanStatus: 'ok', warnings: [],
};

describe('screenerPanel store', () => {
  beforeEach(() => {
    localStorage.clear();
    useScreenerPanelStore.setState({ selectedSavedId: null, lastScan: null });
  });

  it('setSelectedSavedId sets and persists', () => {
    useScreenerPanelStore.getState().setSelectedSavedId('s1');
    expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1');
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1')!).selectedSavedId).toBe('s1');
  });

  it('setLastScan stores in memory and does NOT persist', () => {
    useScreenerPanelStore.getState().setLastScan(SCAN);
    expect(useScreenerPanelStore.getState().lastScan).toEqual(SCAN);
    const raw = localStorage.getItem('screenerPanel.v1');
    // lastScan never goes to storage (only selectedSavedId does, and it's null here).
    expect(raw === null || JSON.parse(raw).lastScan === undefined).toBe(true);
  });

  it('clearScan empties lastScan', () => {
    useScreenerPanelStore.getState().setLastScan(SCAN);
    useScreenerPanelStore.getState().clearScan();
    expect(useScreenerPanelStore.getState().lastScan).toBeNull();
  });

  it('hydrates selectedSavedId from storage; lastScan starts null', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ selectedSavedId: 's9' }));
    vi.resetModules();
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().selectedSavedId).toBe('s9');
    expect(fresh.getState().lastScan).toBeNull();
  });

  it('rejects corrupt selectedSavedId (non-string, non-null) → default null', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({ selectedSavedId: 42 }));
    vi.resetModules();
    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');
    expect(fresh.getState().selectedSavedId).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/state/screenerPanel.test.ts`
Expected: FAIL — `Cannot find module './screenerPanel'`.

- [ ] **Step 3: 스토어 구현**

Create `frontend/src/state/screenerPanel.ts`:

```ts
import { create } from 'zustand';
import type { ScreenerRow, ScreenerResponse } from '../api/screener';

const STORAGE_KEY = 'screenerPanel.v1';

export interface PanelScan {
  savedId: string;
  savedName: string;
  rows: ScreenerRow[];
  scanStatus: ScreenerResponse['status']; // 'ok' | 'not_seeded' | 'building'
  warnings: string[];
}

type Persisted = { selectedSavedId: string | null };

type Store = Persisted & {
  lastScan: PanelScan | null;
  setSelectedSavedId: (id: string | null) => void;
  setLastScan: (scan: PanelScan) => void;
  clearScan: () => void;
};

const DEFAULTS: Persisted = { selectedSavedId: null };

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (SSR, privacy mode) — silent fallback.
  }
}

// Only selectedSavedId is persisted. Accept a string id or an explicit null;
// reject anything else (corrupt/hand-edited) so it can't leak into state.
function readStorage(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof parsed !== 'object' || parsed === null) return {};
    if (parsed.selectedSavedId === null) return { selectedSavedId: null };
    if (typeof parsed.selectedSavedId === 'string') return { selectedSavedId: parsed.selectedSavedId };
    return {};
  } catch {
    return {};
  }
}

// lastScan is in-memory only: it survives panel close/reopen and route changes
// (the store outlives the drawer's mount) but is gone on a full reload — a
// screener row is a price snapshot, so showing a stale one after restart misleads.
export const useScreenerPanelStore = create<Store>((set) => ({
  ...DEFAULTS,
  ...readStorage(),
  lastScan: null,

  setSelectedSavedId: (id) => {
    const next: Persisted = { selectedSavedId: id };
    set(next);
    persist(next);
  },
  setLastScan: (scan) => set({ lastScan: scan }),
  clearScan: () => set({ lastScan: null }),
}));
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/state/screenerPanel.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: 타입체크 + 커밋**

```bash
cd frontend && npx tsc -b && git add src/state/screenerPanel.ts src/state/screenerPanel.test.ts && \
git commit src/state/screenerPanel.ts src/state/screenerPanel.test.ts -m "feat(screener): add screenerPanel store (persisted selection + in-memory results)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ScreenerDrawer 컴포넌트

패널 본문. 아직 App에 연결하지 않는다(독립 컴파일·테스트). 기존 훅을 재사용한다.

**Files:**
- Create: `frontend/src/screener/ScreenerDrawer.tsx`
- Create: `frontend/src/screener/ScreenerDrawer.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `frontend/src/screener/ScreenerDrawer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { ScreenerDrawer } from './ScreenerDrawer';
import { useLivePageStore } from '../state/livePage';
import { useScreenerPanelStore } from '../state/screenerPanel';
import * as savesApi from '../api/savedScreeners';
import * as screenerApi from '../api/screener';

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="pathname">{pathname}</div>;
}

function wrap(qc: QueryClient, initial: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        {children}
        <LocationProbe />
        <Routes><Route path="*" element={null} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const SAVE = {
  id: 's1', name: '돌파+거래대금',
  conditions: [{ id: 'c1', type: 'trade_value' as const, params: { min_eok: 100 } }],
  universe: { exclude_etf: true },
  created_at_ms: 0, updated_at_ms: 0,
};
const ROWS = [
  { code: '005930', name: '삼성전자', market: 'KOSPI' as const, price: 70000, trade_value_won: 1e11, change_pct: 2.1 },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI' as const, price: 180000, trade_value_won: 2e11, change_pct: -1.2 },
];

function qc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('ScreenerDrawer', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useLivePageStore.setState({ activeCode: null } as any);
    useScreenerPanelStore.setState({ selectedSavedId: null, lastScan: null });
    vi.restoreAllMocks();
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({ status: 'ok', last_raw_date: '20260530', days_behind: 0 });
  });

  it('lists saved screeners in the dropdown', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByRole('option', { name: '돌파+거래대금' })).toBeInTheDocument());
  });

  it('defaults selection to the first save and 조회 scans with its conditions', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(scan).toHaveBeenCalledWith({ conditions: SAVE.conditions, universe: SAVE.universe }));
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
  });

  it('clicking a result row sets activeCode and navigates to /live from elsewhere', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });

  it('disables 조회 when status is not_seeded', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({ status: 'not_seeded' });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/시드 필요/)).toBeInTheDocument());
    expect((screen.getByRole('button', { name: '조회' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an empty message and disables 조회 when there are no saves', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/저장된 조건이 없습니다/)).toBeInTheDocument());
    expect((screen.getByRole('button', { name: '조회' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders results from the store without re-scanning (persist across reopen)', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(scan).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx`
Expected: FAIL — `Cannot find module './ScreenerDrawer'`.

- [ ] **Step 3: 컴포넌트 구현**

Create `frontend/src/screener/ScreenerDrawer.tsx`:

```tsx
import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { useLivePageStore } from '../state/livePage';
import { useScreenerPanelStore } from '../state/screenerPanel';
import { useSavedScreeners } from './useSavedScreeners';
import { useScreener } from './useScreener';
import { useScreenerStatus } from './useScreenerStatus';
import { StalenessChip } from './StalenessChip';
import { ChangeCell } from './ChangeCell';
import { triggerScreenerUpdate } from '../api/screener';

/**
 * Screener panel (ADR-0052) — app-wide sibling of the Watchlist Panel. Pick a
 * saved condition list, run 조회, click a result to switch the chart symbol via
 * the activeCode single-source-of-truth. Read-only w.r.t. saves (no create/
 * rename/delete — that lives on the /screener page). Results live in the
 * screenerPanel store so they survive close/reopen; cleared on full reload.
 */
export function ScreenerDrawer() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeCode = useLivePageStore((s) => s.activeCode);
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);

  const selectedSavedId = useScreenerPanelStore((s) => s.selectedSavedId);
  const setSelectedSavedId = useScreenerPanelStore((s) => s.setSelectedSavedId);
  const lastScan = useScreenerPanelStore((s) => s.lastScan);
  const setLastScan = useScreenerPanelStore((s) => s.setLastScan);

  const { data: savesData } = useSavedScreeners();
  const saves = savesData?.saves ?? [];
  const { data: status } = useScreenerStatus();
  const screener = useScreener();
  const update = useMutation({ mutationFn: () => triggerScreenerUpdate() });

  // Restore/repair selection once saves are known: keep the persisted id if it
  // still exists, else fall back to the first save, else none.
  useEffect(() => {
    if (saves.length === 0) {
      if (selectedSavedId !== null) setSelectedSavedId(null);
      return;
    }
    if (!saves.some((s) => s.id === selectedSavedId)) setSelectedSavedId(saves[0].id);
  }, [saves, selectedSavedId, setSelectedSavedId]);

  const selected = saves.find((s) => s.id === selectedSavedId) ?? null;
  const notSeeded = status?.status === 'not_seeded' || lastScan?.scanStatus === 'not_seeded';

  const runScan = () => {
    if (!selected) return;
    screener.mutate(
      { conditions: selected.conditions, universe: selected.universe },
      {
        onSuccess: (res) =>
          setLastScan({
            savedId: selected.id, savedName: selected.name,
            rows: res.rows, scanStatus: res.status, warnings: res.warnings,
          }),
      },
    );
  };

  const openLive = (code: string) => {
    setActiveCode(code);
    if (pathname !== '/live') navigate('/live');
  };

  return (
    <div
      id="right-rail-screener-panel"
      data-testid="screener-panel"
      style={{
        width: 'var(--watchlist-panel-w)', height: '100%', background: 'var(--bg-card)',
        borderLeft: '1px solid var(--border)', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Header: label + freshness chip */}
      <div
        style={{
          padding: 'var(--space-sm) var(--space-md)', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
        }}
      >
        <span style={{
          fontSize: 'var(--text-xs)', color: 'var(--fg-dim)', fontFamily: 'monospace',
          textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>스크리너</span>
        <span style={{ flex: 1 }} />
        <StalenessChip status={status} />
      </div>

      {/* Controls: dropdown + 조회 + 갱신 */}
      <div className="flex flex-col gap-sm p-md border-b">
        {saves.length === 0 ? (
          <div className="text-fg-dimmer text-sm">저장된 조건이 없습니다 — Screener 페이지에서 만드세요</div>
        ) : (
          <select
            aria-label="저장한 조건검색 선택"
            value={selectedSavedId ?? ''}
            onChange={(e) => setSelectedSavedId(e.target.value)}
            className="w-full px-2 py-1.5 rounded-lg bg-bg-input border text-fg text-sm"
          >
            {saves.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button" onClick={runScan}
            disabled={screener.isPending || notSeeded || !selected}
            className="flex-1 px-3 py-1.5 rounded-lg bg-accent text-accent-fg font-semibold text-sm hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {screener.isPending ? '조회 중…' : '조회'}
          </button>
          <button
            type="button" aria-label="데이터 갱신" onClick={() => update.mutate()}
            disabled={update.isPending}
            className="px-2.5 py-1.5 rounded-lg bg-bg-input border text-fg-dim text-sm hover:bg-bg-input-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {update.isPending ? '갱신 중…' : '갱신'}
          </button>
        </div>
        {notSeeded && (
          <div className="text-sm" style={{ color: 'var(--warn)' }}>시드 필요 — 운영자 CLI로 시드 후 조회하세요</div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-auto">
        {screener.isError ? (
          <div className="p-md text-sm">
            <div className="font-semibold" style={{ color: 'var(--error)' }}>조회 실패</div>
            {screener.error instanceof Error && screener.error.message && (
              <div className="text-fg-dim">{screener.error.message}</div>
            )}
          </div>
        ) : lastScan ? (
          <>
            <div className="px-md pt-sm pb-1 text-[10.5px] uppercase tracking-[0.08em] text-fg-dimmer">
              결과 {lastScan.rows.length} · {lastScan.savedName}
              {selectedSavedId !== lastScan.savedId && (
                <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
                  · 선택한 조건과 다름 — 조회로 갱신
                </span>
              )}
            </div>
            {lastScan.rows.length === 0 ? (
              <div className="p-md text-fg-dim text-sm">조건에 맞는 종목이 없습니다.</div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {lastScan.rows.map((r) => (
                  <ScreenerResultRow
                    key={r.code} code={r.code} name={r.name} pct={r.change_pct}
                    active={r.code === activeCode} onClick={() => openLive(r.code)}
                  />
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="p-md text-fg-dimmer text-sm">조건을 선택하고 조회하세요.</div>
        )}
      </div>
    </div>
  );
}

function ScreenerResultRow({
  code, name, pct, active, onClick,
}: { code: string; name: string; pct: number | null; active: boolean; onClick: () => void }) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
  return (
    <li
      data-testid={`screener-row-${code}`}
      role="button" tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={`${name} ${code} 차트 열기`}
      onClick={onClick} onKeyDown={onKeyDown}
      className="cursor-pointer px-md py-sm flex items-center gap-2 border-b outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
      style={{
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <span className="font-mono text-xs text-fg-dim" style={{ minWidth: '3.2rem' }}>{code}</span>
      <span className="flex-1 truncate text-sm text-fg">{name}</span>
      <span className="font-mono tabular-nums text-sm text-right"><ChangeCell pct={pct} /></span>
    </li>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: 타입체크 + 커밋**

```bash
cd frontend && npx tsc -b && git add src/screener/ScreenerDrawer.tsx src/screener/ScreenerDrawer.test.tsx && \
git commit src/screener/ScreenerDrawer.tsx src/screener/ScreenerDrawer.test.tsx -m "feat(screener): add ScreenerDrawer panel (saved-condition scan → chart)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 레일 enum 리팩터 (store + RightRail + useLiveKeyboard + App)

`panelOpen: boolean` → `activePanel` enum. 이 타입 변경은 4개 파일을 동시에 깨므로 **한 묶음으로 착지 후 한 번 커밋**한다(중간 단계는 컴파일 불가). 각 하위 단계에서 코드와 그 테스트를 함께 고친다.

**Files:**
- Modify: `frontend/src/state/rightRail.ts`
- Modify: `frontend/src/state/rightRail.test.ts`
- Modify: `frontend/src/live/useLiveKeyboard.ts`
- Modify: `frontend/src/live/useLiveKeyboard.test.tsx`
- Modify: `frontend/src/rightrail/RightRail.tsx`
- Modify: `frontend/src/rightrail/RightRail.test.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: rightRail 스토어를 enum으로 교체**

Replace the entire contents of `frontend/src/state/rightRail.ts` with:

```ts
import { create } from 'zustand';

const STORAGE_KEY = 'rightRail.layout';

export type RailPanel = 'watchlist' | 'screener';
const VALID_PANELS: readonly RailPanel[] = ['watchlist', 'screener'];

type Persisted = {
  activePanel: RailPanel | null;
};

type Store = Persisted & {
  // Which panel the chevron re-opens after a collapse. Memory-only (not
  // persisted) — after a reload it falls back to the hydrated activePanel or
  // 'watchlist'. The rail itself is fixed chrome; only the panel shows/hides.
  lastPanel: RailPanel;
  setActivePanel: (panel: RailPanel | null) => void;
  togglePanel: (panel: RailPanel) => void;
  toggleCollapse: () => void;
};

const DEFAULTS: Persisted = { activePanel: null };

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (SSR, privacy mode) — silent fallback.
  }
}

// Accept only the new enum shape (whitelist) OR migrate the legacy boolean
// shape ({ panelOpen: true } → 'watchlist', else → null). A corrupt/hand-edited
// value must not leak into state (e.g. activePanel: 'foo' or panelOpen: 0).
function readStorage(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof parsed !== 'object' || parsed === null) return {};
    if ('activePanel' in parsed) {
      const v = parsed.activePanel;
      if (v === null) return { activePanel: null };
      if (typeof v === 'string' && (VALID_PANELS as readonly string[]).includes(v)) {
        return { activePanel: v as RailPanel };
      }
      return {}; // corrupt → default
    }
    if (typeof parsed.panelOpen === 'boolean') {
      return { activePanel: parsed.panelOpen ? 'watchlist' : null };
    }
    return {};
  } catch {
    return {};
  }
}

// Read at module load (synchronous) so the panel's persisted state is present
// before the first route paints — no flash of the default state (ADR-0052).
const hydrated = readStorage();

export const useRightRailStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...hydrated,
  lastPanel: hydrated.activePanel ?? 'watchlist',

  setActivePanel: (panel) => {
    const next: Persisted = { activePanel: panel };
    // Opening a panel also remembers it as the chevron's re-open target.
    set(panel ? { ...next, lastPanel: panel } : next);
    persist(next);
  },

  togglePanel: (panel) => {
    get().setActivePanel(get().activePanel === panel ? null : panel);
  },

  toggleCollapse: () => {
    const { activePanel, lastPanel } = get();
    get().setActivePanel(activePanel ? null : lastPanel);
  },
}));
```

- [ ] **Step 2: rightRail 스토어 테스트 교체**

Replace the entire contents of `frontend/src/state/rightRail.test.ts` with:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRightRailStore } from './rightRail';

describe('rightRail store', () => {
  beforeEach(() => {
    localStorage.clear();
    useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
  });

  it('togglePanel opens a panel and persists activePanel', () => {
    useRightRailStore.getState().togglePanel('watchlist');
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).activePanel).toBe('watchlist');
  });

  it('togglePanel on the active panel closes it (null)', () => {
    useRightRailStore.getState().togglePanel('watchlist');
    useRightRailStore.getState().togglePanel('watchlist');
    expect(useRightRailStore.getState().activePanel).toBeNull();
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).activePanel).toBeNull();
  });

  it('togglePanel switches between panels (mutually exclusive)', () => {
    useRightRailStore.getState().togglePanel('watchlist');
    useRightRailStore.getState().togglePanel('screener');
    expect(useRightRailStore.getState().activePanel).toBe('screener');
    expect(useRightRailStore.getState().lastPanel).toBe('screener');
  });

  it('toggleCollapse closes when open and reopens lastPanel when collapsed', () => {
    useRightRailStore.getState().togglePanel('screener'); // lastPanel = 'screener'
    useRightRailStore.getState().toggleCollapse();        // close
    expect(useRightRailStore.getState().activePanel).toBeNull();
    useRightRailStore.getState().toggleCollapse();        // reopen lastPanel
    expect(useRightRailStore.getState().activePanel).toBe('screener');
  });

  it('migrates legacy { panelOpen: true } to activePanel "watchlist"', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ panelOpen: true }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().activePanel).toBe('watchlist');
  });

  it('migrates legacy { panelOpen: false } to null', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ panelOpen: false }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().activePanel).toBeNull();
  });

  it('rejects a corrupt activePanel value → default null', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ activePanel: 'foo' }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().activePanel).toBeNull();
  });
});
```

- [ ] **Step 3: 스토어 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/state/rightRail.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 4: useLiveKeyboard를 enum API로**

In `frontend/src/live/useLiveKeyboard.ts`, replace the `'w'` and `'Escape'` case bodies (현행 45-54줄) with:

```ts
        case 'w':
          useRightRailStore.getState().togglePanel('watchlist');
          e.preventDefault();
          break;
        case 'Escape':
          if (useRightRailStore.getState().activePanel) {
            useRightRailStore.getState().setActivePanel(null);
            e.preventDefault();
          }
          break;
```

- [ ] **Step 5: useLiveKeyboard 테스트를 enum으로**

In `frontend/src/live/useLiveKeyboard.test.tsx`:

1. `beforeEach` 본문(19줄)을 교체: `useRightRailStore.setState({ panelOpen: false });` → `useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });`
2. `'w toggles watchlist panel'` 테스트(36-43줄) 본문을 교체:

```tsx
  it('w toggles watchlist panel', () => {
    render(<Harness />);
    expect(useRightRailStore.getState().activePanel).toBeNull();
    fireEvent.keyDown(window, { key: 'w' });
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    fireEvent.keyDown(window, { key: 'w' });
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });
```

3. `'Escape closes panel only when open'` 테스트(45-53줄) 본문을 교체:

```tsx
  it('Escape closes panel only when open', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().activePanel).toBeNull();

    useRightRailStore.setState({ activePanel: 'watchlist' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });
```

- [ ] **Step 6: RightRail을 항목 2개로 교체**

Replace the entire contents of `frontend/src/rightrail/RightRail.tsx` with:

```tsx
import { useRightRailStore, type RailPanel } from '../state/rightRail';
import { HeartIcon } from '../ui/HeartIcon';
import { FunnelIcon } from '../ui/FunnelIcon';

/**
 * Global Right Rail (ADR-0052) — fixed thin right-edge chrome on every route.
 * The rail itself does not collapse. It now holds two items: 관심 (Watchlist)
 * and 스크리너 (Screener); each toggles its own panel (mutually exclusive — one
 * panel slot). The chevron collapses the open panel and re-opens the last one.
 */
export default function RightRail() {
  const activePanel = useRightRailStore((s) => s.activePanel);
  const togglePanel = useRightRailStore((s) => s.togglePanel);
  const toggleCollapse = useRightRailStore((s) => s.toggleCollapse);
  const open = activePanel !== null;

  return (
    <nav
      aria-label="우측 레일"
      className="flex flex-col items-center h-full bg-bg-subtle border-l"
      style={{ width: 'var(--rail-w)' }}
    >
      <button
        type="button"
        onClick={toggleCollapse}
        aria-expanded={open}
        aria-label={open ? '우측 패널 닫기' : '우측 패널 열기'}
        className="w-full py-2 grid place-items-center text-fg-dim hover:text-fg hover:bg-bg-input-hover"
      >
        {open ? '»' : '«'}
      </button>

      <RailItem
        panel="watchlist"
        label="관심"
        ariaLabel="관심종목 패널 토글"
        controls="right-rail-watchlist-panel"
        active={activePanel === 'watchlist'}
        onClick={() => togglePanel('watchlist')}
        icon={<HeartIcon filled={activePanel === 'watchlist'} className="w-[1.125em] h-[1.125em]" />}
      />
      <RailItem
        panel="screener"
        label="스크리너"
        ariaLabel="스크리너 패널 토글"
        controls="right-rail-screener-panel"
        active={activePanel === 'screener'}
        onClick={() => togglePanel('screener')}
        icon={<FunnelIcon filled={activePanel === 'screener'} className="w-[1.125em] h-[1.125em]" />}
      />
    </nav>
  );
}

function RailItem({
  panel, label, ariaLabel, controls, active, onClick, icon,
}: {
  panel: RailPanel; label: string; ariaLabel: string; controls: string;
  active: boolean; onClick: () => void; icon: React.ReactNode;
}) {
  // Active = tint bg + neutral text, matching NavItem (no triple-teal). The icon
  // fill (currentColor=fg) is a shape signal, not a 2nd accent.
  return (
    <button
      type="button"
      data-panel={panel}
      onClick={onClick}
      aria-pressed={active}
      aria-controls={controls}
      aria-label={ariaLabel}
      className={`w-full py-3 flex flex-col items-center gap-1 ${
        active ? 'bg-tint-selection text-fg' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
      }`}
    >
      {icon}
      <span className="text-[10px] leading-tight">{label}</span>
    </button>
  );
}
```

- [ ] **Step 7: RightRail 테스트 교체**

Replace the entire contents of `frontend/src/rightrail/RightRail.test.tsx` with:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import RightRail from './RightRail';
import { useRightRailStore } from '../state/rightRail';

describe('RightRail', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
  });

  it('renders both 관심 and 스크리너 items', () => {
    render(<RightRail />);
    expect(screen.getByLabelText('관심종목 패널 토글')).toBeInTheDocument();
    expect(screen.getByLabelText('스크리너 패널 토글')).toBeInTheDocument();
  });

  it('관심 item opens the watchlist panel', () => {
    render(<RightRail />);
    const btn = screen.getByLabelText('관심종목 패널 토글');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('스크리너 item opens the screener panel (and is mutually exclusive)', () => {
    render(<RightRail />);
    fireEvent.click(screen.getByLabelText('관심종목 패널 토글'));
    fireEvent.click(screen.getByLabelText('스크리너 패널 토글'));
    expect(useRightRailStore.getState().activePanel).toBe('screener');
  });

  it('chevron shows the close affordance and collapses when a panel is open', () => {
    useRightRailStore.setState({ activePanel: 'screener', lastPanel: 'screener' });
    render(<RightRail />);
    const chevron = screen.getByLabelText('우측 패널 닫기');
    expect(chevron).toBeInTheDocument();
    fireEvent.click(chevron);
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });
});
```

- [ ] **Step 8: App 그리드 + 두 드로어 조건부 렌더**

Replace the entire contents of `frontend/src/App.tsx` with:

```tsx
import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { ScreenerDrawer } from './screener/ScreenerDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/eventStream';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';
import { useCaptureQueueSync } from './capture/useCaptureQueue';

export default function App() {
  useEventStream();
  useInventoryRecaptureOriginsCleanup();
  // Single owner of the capture-queue push subscription (was fanned out across
  // ~5 useCaptureQueue mounts); the read side now only reads the shared cache.
  useCaptureQueueSync();
  const activePanel = useRightRailStore((s) => s.activePanel);

  // The Right Rail is fixed (always --rail-w); one panel column appears between
  // main and the rail when a panel is open. Grid track count always equals
  // rendered child count: 3 when no panel, 4 when one is open. Panels are
  // mutually exclusive (enum activePanel), so there is never a 2nd panel column.
  const cols = `var(--nav-w) 1fr${activePanel ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)`;

  return (
    <div
      className="grid h-screen w-screen overflow-hidden"
      style={{ gridTemplateColumns: cols }}
    >
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
      {activePanel === 'watchlist' && <WatchlistDrawer />}
      {activePanel === 'screener' && <ScreenerDrawer />}
      <RightRail />
    </div>
  );
}
```

- [ ] **Step 9: 전체 타입체크 + 영향 테스트**

Run:
```bash
cd frontend && npx tsc -b && npx vitest run \
  src/state/rightRail.test.ts \
  src/rightrail/RightRail.test.tsx \
  src/live/useLiveKeyboard.test.tsx \
  src/watchlist/WatchlistDrawer.test.tsx \
  src/screener/ScreenerDrawer.test.tsx
```
Expected: tsc 무오류, 모든 테스트 PASS.

- [ ] **Step 10: 커밋**

```bash
cd frontend && git add src/state/rightRail.ts src/state/rightRail.test.ts src/live/useLiveKeyboard.ts src/live/useLiveKeyboard.test.tsx src/rightrail/RightRail.tsx src/rightrail/RightRail.test.tsx src/App.tsx && \
git commit src/state/rightRail.ts src/state/rightRail.test.ts src/live/useLiveKeyboard.ts src/live/useLiveKeyboard.test.tsx src/rightrail/RightRail.tsx src/rightrail/RightRail.test.tsx src/App.tsx -m "feat(rightrail): add Screener panel item; rail state boolean→enum

panelOpen → activePanel ('watchlist'|'screener'|null), mutually exclusive
panels preserve App's single optional panel column. Legacy panelOpen
persisted state migrates to the enum. Wires ScreenerDrawer into the shell.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: ADR-0052 갱신 + 전체 검증

**Files:**
- Modify: `docs/adr/0052-global-right-rail-state-store.md`

- [ ] **Step 1: ADR-0052에 변경 노트 추가**

`docs/adr/0052-global-right-rail-state-store.md`의 맨 아래에 다음 섹션을 추가한다(파일 끝에 이어붙임):

```markdown

## Update (2026-06-01): Screener panel — boolean → enum

The rail now holds **two items** (관심 Watchlist, 스크리너 Screener). The chrome
state moved from `panelOpen: boolean` to `activePanel: 'watchlist' | 'screener' | null`.
Panels are **mutually exclusive** — exactly one optional panel column in the App
grid is preserved (track count == child count: 3 closed, 4 open). A memory-only
`lastPanel` drives the chevron's re-open target.

Legacy persisted state (`{ panelOpen: true|false }` under `rightRail.layout`)
migrates on read: `true → 'watchlist'`, `false`/absent/corrupt → `null`. The
strict-validation guard now whitelists the enum (`'watchlist'|'screener'|null`).

The Screener panel (`ScreenerDrawer`) is **read-only** w.r.t. saved screeners
(select + scan only); create/rename/delete stay on the `/screener` page. Results
live in a separate `screenerPanel` store (in-memory; survives close/reopen,
cleared on full reload). See spec `2026-06-01-screener-rail-panel-design.md`.
```

- [ ] **Step 2: 전체 스위트 + 타입체크 + 린트**

Run:
```bash
cd frontend && npx tsc -b && npx vitest run && npm run lint
```
Expected: tsc 무오류, 전체 vitest PASS, eslint 무오류.

- [ ] **Step 3: 수동 검증 (dev 서버)**

CLAUDE.md의 dev 서버 절차로 백엔드+프론트를 띄운 뒤 [/browse](file:///home/dev/.claude/skills/gstack/browse/SKILL.md)로 확인:

1. `/live`에서 우측 레일 `스크리너` 클릭 → 패널 열림(관심 패널은 닫힘 = 상호배타).
2. 드롭다운에서 저장한 조건 선택 → `조회` → 결과 리스트 표시.
3. 결과 행 클릭 → 차트가 해당 종목으로 전환.
4. `/inventory`로 이동 후 레일 `스크리너` → `조회` → 결과 클릭 → `/live`로 이동 + 차트 전환.
5. 패널 닫았다 다시 열기 → 결과 유지. 브라우저 새로고침 → 결과 비움 + 선택 조건 복원.
6. 키보드 `w` → 관심 패널 토글, `Escape` → 열린 패널 닫힘.
7. (마이그레이션) DevTools에서 `localStorage['rightRail.layout'] = '{"panelOpen":true}'` 설정 후 새로고침 → 관심 패널이 열린 채 정상.

- [ ] **Step 4: ADR 커밋**

```bash
git commit docs/adr/0052-global-right-rail-state-store.md -m "docs(adr-0052): note rail two-item enum + screener panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (계획 작성자 체크 — 완료)

**1. Spec 커버리지:**
- 레일에 관심 아래 스크리너 항목 → Task 5(RightRail). ✓
- 드롭다운 선택 → 조회 → 결과 → 행 클릭 차트 전환 → Task 4(ScreenerDrawer). ✓
- 결과 닫기/이동 유지·새로고침 비움 → Task 3(screenerPanel 메모리 lastScan) + Task 4 테스트. ✓
- 선택 영속 → Task 3(selectedSavedId localStorage). ✓
- 갱신 버튼 + 신선도 칩 → Task 4(update mutation + StalenessChip). ✓
- enum + 레거시 마이그레이션 + 단일 패널 컬럼 → Task 5. ✓
- ChangeCell 공유 추출 → Task 1. ✓
- FunnelIcon → Task 2. ✓
- ADR 갱신 → Task 6. ✓
- 두 status 구분(scanStatus vs 신선도 ScreenerStatus) → Task 3 타입 + Task 4 notSeeded 판정. ✓

**2. Placeholder 스캔:** 모든 코드 단계에 완전한 코드/명령/기대값 포함. "TBD"·"적절히 처리" 없음.

**3. 타입 일관성:** `activePanel`/`lastPanel`/`RailPanel`(Task 5), `PanelScan`/`scanStatus`/`selectedSavedId`(Task 3·4), `setActivePanel`/`togglePanel(panel)`/`toggleCollapse`(Task 5에서 정의·사용), `ChangeCell` props `{ pct }`(Task 1·4 일치) 모두 정의처와 사용처가 일치.

---

## 구현 중 정정 (review-driven deltas)

실행 중 spec/code 리뷰에서 잡혀 **실제 코드에 반영된** 차이. 위 Task 본문의 코드 블록보다 이 절이 우선한다(계획을 resume/재실행할 경우 아래를 반영할 것).

- **[Task 4 — CRITICAL]** 선택-복구 `useEffect`가 `useSavedScreeners` 로딩 창에서 `savesData === undefined → saves === []`라 `setSelectedSavedId(null)`을 실행, **영속된 비-첫번째 선택을 파괴**(저장 ≥2개일 때)하던 버그. 수정: `const { data: savesData, isSuccess: savesLoaded } = useSavedScreeners();` 로 받고 effect 첫 줄에 `if (!savesLoaded) return;`, deps에 `savesLoaded` 추가. 회귀 테스트 `preserves a persisted non-first selection when saves load` 추가. (커밋 `b4fe9d9`)
- **[Task 4]** 결과 캡션 `text-[10.5px]` → `text-xs`(밀도 다이얼과 함께 스케일되도록, DESIGN.md 토큰). (`b4fe9d9`)
- **[Task 4]** `const saves = savesData?.saves ?? []` → `const saves = useMemo(() => savesData?.saves ?? [], [savesData])`(effect deps 안정화, `react-hooks/exhaustive-deps` 경고 해소). 테스트의 불필요한 `as any` 제거(`@typescript-eslint/no-explicit-any` 에러). (`ff00208`)
- **[Task 4]** 테스트 6건 추가(다중 save 선택 보존, 갱신, 조회 실패, 빈 결과, /live에서 클릭 시 비-내비, 선택 불일치 힌트) → 총 12건.
- **[Task 5]** 셰브론에 `aria-controls="right-rail-watchlist-panel right-rail-screener-panel"` 추가(두 패널 명시). 미사용 `data-panel` QA seam과 `panel` prop·`RailPanel` import 제거(YAGNI·데드코드). 활성 상태에 `font-medium`(NavItem 일치). `useLiveKeyboard.ts` JSDoc의 Esc 설명을 "open panel"로 갱신. 셰브론 재오픈 테스트 추가. (`137c214`)
- **[Task 1]** `ChangeCell` 보합(`pct === 0`) 분기 테스트 추가 + `toHaveClass`로 단언 전환. (`37047a9`)
- **[Task 3]** `lastScan` 미영속 단언을 무조건적으로 강화(`setSelectedSavedId` 선행 후 `persisted.lastScan` undefined 확인). (`2c28ac0`)

전체 검증(최종): `npx tsc -b` clean · `npx vitest run` 143 파일 / 1171 테스트 PASS · 변경 파일 eslint 0 error.
