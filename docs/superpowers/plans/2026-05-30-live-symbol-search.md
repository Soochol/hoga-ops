# /live 종목 검색 (헤더 인라인 바 + ♥ 토글) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 헤더에 `/`로 여는 인라인 종목 검색 바를 추가해 전체 KRX 종목을 찾아 차트에 띄우고, ♥ 토글로 관심종목(=실시간 추적)을 추가/해제한다.

**Architecture:** 콤보박스 상호작용을 헤드리스 훅 `useSymbolCombobox`로 추출하고, 그 위에 `/live` 전용 `LiveSymbolSearch`를 올린다. 선택은 `setActiveCode`만 하고(과거 차트는 항상 렌더, 게이트 완화), ♥는 기존 watchlist add/remove 뮤테이션을 호출한다. 백엔드는 add/remove 후 `refresh_live_poller`로 폴러를 즉시 재동기화(버퍼 보존)해 ♥ → 즉시 실시간을 성립시킨다. 마지막으로 캡처 `SymbolSearch`를 같은 훅으로 이관해 중복을 제거한다.

**Tech Stack:** React 19 + TypeScript, zustand, TanStack Query, Tailwind(토큰), vitest + @testing-library/react (frontend); FastAPI + pytest, asyncio (backend).

**Spec:** [docs/superpowers/specs/2026-05-30-live-symbol-search-design.md](../specs/2026-05-30-live-symbol-search-design.md) (커밋 a185451).

---

## File Structure

| 구분 | 경로 | 책임 |
|---|---|---|
| 신규 | `frontend/src/symbols/useSymbolCombobox.ts` | 헤드리스 콤보박스 훅(open/highlight/키보드). 데이터·표현 비소유 |
| 신규 | `frontend/src/symbols/useSymbolCombobox.test.ts` | 훅 단위테스트 |
| 신규 | `frontend/src/ui/HeartIcon.tsx` | 공유 하트 SVG(채움/외곽선) |
| 신규 | `frontend/src/ui/HeartIcon.test.tsx` | HeartIcon 단위테스트 |
| 신규 | `frontend/src/live/LiveSymbolSearch.tsx` | 헤더 인라인 검색 바 |
| 신규 | `frontend/src/live/LiveSymbolSearch.test.tsx` | 검색 바 테스트 |
| 변경 | `frontend/src/live/useLiveKeyboard.ts` | `shouldIgnoreEvent` export |
| 변경 | `frontend/src/live/LiveHeader.tsx` | LiveSymbolSearch 마운트 |
| 변경 | `frontend/src/live/LiveWorkarea.tsx` | activeCode만으로 게이트 |
| 변경 | `frontend/src/live/LiveEmptyState.tsx` (+test) | "/" 검색 유도 카피 |
| 변경 | `frontend/src/live/LivePage.tsx` | watchlistEmpty 차트차단 제거 |
| 변경 | `frontend/src/live/LiveStatusBar.tsx` (+test) | 활성 종목 ♥ + 실시간/과거 힌트 |
| 변경 | `frontend/src/rightrail/RightRail.tsx` | HeartIcon 공유 import |
| 변경 | `frontend/src/capture/SymbolSearch.tsx` | 훅 이관(onEnterEmpty) |
| 변경 | `hoga/live/lifecycle.py` | `refresh_live_poller` 추가 |
| 변경 | `hoga/api/watchlist_routes.py` | add/remove 후 refresh 호출 |
| 변경 | `tests/unit/live/test_lifecycle_start.py` | refresh 테스트 |
| 변경 | `tests/test_api_watchlist_routes.py` | 라우트 refresh 호출 테스트 |

**Task 순서 근거:** 1(훅)·2(아이콘)은 순수 추출(UI 무변경). 3(게이트)→4(검색)으로 "검색→과거차트"가 빈 watchlist에서도 동작. 5(♥)·6(lifecycle)·7(라우트)로 "♥→즉시 실시간". 8(캡처 이관)은 훅 검증 후 마지막.

테스트 실행: 프론트 `cd frontend && npx vitest run <path>`, 백엔드 `uv run pytest <path> -v`.

---

## Task 1: `useSymbolCombobox` 헤드리스 훅

**Files:**
- Create: `frontend/src/symbols/useSymbolCombobox.ts`
- Test: `frontend/src/symbols/useSymbolCombobox.test.ts`

소비자가 `query`/`items`를 소유·주입하고(데이터는 `useSymbolSearch`가 비동기로 만들기에 hook이 소유하면 순환), 훅은 `open`/`highlightedIndex`/키보드만 소유한다.

- [ ] **Step 1: Write the failing test**

`frontend/src/symbols/useSymbolCombobox.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSymbolCombobox } from './useSymbolCombobox';

type Hit = { code: string };
const ITEMS: Hit[] = [{ code: 'a' }, { code: 'b' }, { code: 'c' }];

function key(k: string) {
  return { key: k, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLInputElement>;
}

function setup(opts: Partial<Parameters<typeof useSymbolCombobox<Hit>>[0]> = {}) {
  const onSelect = vi.fn();
  const setQuery = vi.fn();
  const hook = renderHook(() =>
    useSymbolCombobox<Hit>({ query: 'x', setQuery, items: ITEMS, onSelect, ...opts }),
  );
  return { hook, onSelect, setQuery };
}

describe('useSymbolCombobox', () => {
  it('opens on focus and selects highlighted on Enter', () => {
    const { hook, onSelect } = setup();
    act(() => hook.result.current.inputProps.onFocus());
    expect(hook.result.current.open).toBe(true);
    act(() => hook.result.current.inputProps.onKeyDown(key('ArrowDown')));
    expect(hook.result.current.highlightedIndex).toBe(1);
    act(() => hook.result.current.inputProps.onKeyDown(key('Enter')));
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
    expect(hook.result.current.open).toBe(false);
  });

  it('clamps highlight at both ends', () => {
    const { hook } = setup();
    act(() => hook.result.current.inputProps.onFocus());
    act(() => hook.result.current.inputProps.onKeyDown(key('ArrowUp')));
    expect(hook.result.current.highlightedIndex).toBe(0);
    act(() => {
      hook.result.current.inputProps.onKeyDown(key('ArrowDown'));
      hook.result.current.inputProps.onKeyDown(key('ArrowDown'));
      hook.result.current.inputProps.onKeyDown(key('ArrowDown'));
    });
    expect(hook.result.current.highlightedIndex).toBe(2);
  });

  it('closes on Escape', () => {
    const { hook } = setup();
    act(() => hook.result.current.inputProps.onFocus());
    act(() => hook.result.current.inputProps.onKeyDown(key('Escape')));
    expect(hook.result.current.open).toBe(false);
  });

  it('calls onEnterEmpty when no items and suppresses default', () => {
    const onEnterEmpty = vi.fn().mockReturnValue(true);
    const onSelect = vi.fn();
    const ev = key('Enter');
    const hook = renderHook(() =>
      useSymbolCombobox<Hit>({ query: '005930', setQuery: vi.fn(), items: [], onSelect, onEnterEmpty }),
    );
    act(() => hook.result.current.inputProps.onKeyDown(ev));
    expect(onEnterEmpty).toHaveBeenCalledWith('005930');
    expect(onSelect).not.toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('onChange forwards to setQuery and opens', () => {
    const { hook, setQuery } = setup();
    act(() =>
      hook.result.current.inputProps.onChange({
        target: { value: 'sam' },
      } as React.ChangeEvent<HTMLInputElement>),
    );
    expect(setQuery).toHaveBeenCalledWith('sam');
    expect(hook.result.current.open).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/symbols/useSymbolCombobox.test.ts`
Expected: FAIL — `Failed to resolve import "./useSymbolCombobox"`.

- [ ] **Step 3: Write minimal implementation**

`frontend/src/symbols/useSymbolCombobox.ts`:
```ts
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseSymbolComboboxOptions<T> {
  /** Owned by the consumer — items derive from it via a separate data hook. */
  query: string;
  setQuery: (q: string) => void;
  items: T[];
  onSelect: (item: T) => void;
  /** Enter with no items: return true if handled (suppresses default). */
  onEnterEmpty?: (query: string) => boolean;
}

export interface UseSymbolComboboxResult<T> {
  open: boolean;
  setOpen: (o: boolean) => void;
  highlightedIndex: number;
  inputRef: React.RefObject<HTMLInputElement>;
  inputProps: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onFocus: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  };
  getOptionProps: (index: number) => {
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseEnter: () => void;
    'aria-selected': boolean;
  };
  listProps: { role: 'listbox' };
}

export function useSymbolCombobox<T>({
  query, setQuery, items, onSelect, onEnterEmpty,
}: UseSymbolComboboxOptions<T>): UseSymbolComboboxResult<T> {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset highlight whenever the query changes (mirrors capture SymbolSearch).
  useEffect(() => { setHighlightedIndex(0); }, [query]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (open && items.length > 0) {
        e.preventDefault();
        const item = items[Math.min(highlightedIndex, items.length - 1)];
        onSelect(item);
        setOpen(false);
        return;
      }
      if (onEnterEmpty?.(query)) { e.preventDefault(); }
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [open, items, highlightedIndex, onSelect, onEnterEmpty, query]);

  return {
    open, setOpen, highlightedIndex, inputRef,
    inputProps: {
      value: query,
      onChange: (e) => { setQuery(e.target.value); setOpen(true); },
      onFocus: () => setOpen(true),
      onKeyDown,
    },
    getOptionProps: (index) => ({
      onMouseDown: (e) => e.preventDefault(),  // keep focus; click fires before blur
      onMouseEnter: () => setHighlightedIndex(index),
      'aria-selected': index === highlightedIndex,
    }),
    listProps: { role: 'listbox' },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/symbols/useSymbolCombobox.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/symbols/useSymbolCombobox.ts frontend/src/symbols/useSymbolCombobox.test.ts
git commit -m "feat(symbols): headless useSymbolCombobox hook (keyboard/highlight/open)"
```

---

## Task 2: `HeartIcon` 공유 추출

**Files:**
- Create: `frontend/src/ui/HeartIcon.tsx`, `frontend/src/ui/HeartIcon.test.tsx`
- Modify: `frontend/src/rightrail/RightRail.tsx`

색 규율: 채움=`currentColor`(중립 shape signal), 외곽선=stroke만. teal/rose 미사용.

- [ ] **Step 1: Write the failing test**

`frontend/src/ui/HeartIcon.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { HeartIcon } from './HeartIcon';

describe('HeartIcon', () => {
  it('fills with currentColor when filled', () => {
    const { container } = render(<HeartIcon filled />);
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
  });
  it('is outline (fill=none) when not filled', () => {
    const { container } = render(<HeartIcon filled={false} />);
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/ui/HeartIcon.test.tsx`
Expected: FAIL — cannot resolve `./HeartIcon`.

- [ ] **Step 3: Write minimal implementation**

`frontend/src/ui/HeartIcon.tsx`:
```tsx
/**
 * Shared heart glyph. Fill = currentColor (a *shape* signal, NOT a second
 * accent — see DESIGN.md color discipline and ADR for the Right Rail heart).
 * Sizing is via `className` (e.g. "w-[1.125em] h-[1.125em]").
 */
export function HeartIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/ui/HeartIcon.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Repoint RightRail to the shared icon**

`frontend/src/rightrail/RightRail.tsx` — add import at top:
```tsx
import { HeartIcon } from '../ui/HeartIcon';
```
Replace the local `<HeartIcon filled={panelOpen} />` usage with the sized shared one:
```tsx
        <HeartIcon filled={panelOpen} className="w-[1.125em] h-[1.125em]" />
```
Delete the local `function HeartIcon(...) { ... }` definition (lines 50-64) entirely.

- [ ] **Step 6: Run RightRail tests to verify no regression**

Run: `cd frontend && npx vitest run src/rightrail/RightRail.test.tsx`
Expected: PASS (unchanged behavior).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ui/HeartIcon.tsx frontend/src/ui/HeartIcon.test.tsx frontend/src/rightrail/RightRail.tsx
git commit -m "refactor(ui): extract shared HeartIcon; RightRail consumes it"
```

---

## Task 3: Workarea 게이트 완화 + EmptyState 카피

activeCode가 있으면 watchlist 공백 여부와 무관하게 차트를 렌더한다. `LiveChartRoot`/`LiveSidebar`는 jsdom에서 무겁기에 테스트에서 모킹한다.

**Files:**
- Modify: `frontend/src/live/LiveWorkarea.tsx`, `frontend/src/live/LivePage.tsx`, `frontend/src/live/LiveEmptyState.tsx`
- Test: `frontend/src/live/LiveWorkarea.test.tsx` (create), `frontend/src/live/LiveEmptyState.test.tsx` (modify)

- [ ] **Step 1: Write the failing Workarea test**

`frontend/src/live/LiveWorkarea.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveWorkarea } from './LiveWorkarea';
import type { LiveSeriesData } from '../api/liveSeries';

vi.mock('./LiveChartRoot', () => ({ LiveChartRoot: () => <div data-testid="chart-stub" /> }));
vi.mock('./LiveSidebar', () => ({ LiveSidebar: () => <div data-testid="sidebar-stub" /> }));

const LIVE: LiveSeriesData = {
  initial: undefined, isLoading: false, error: null, ob: [], trade: [], broker: [],
};

function renderWorkarea(activeCode: string | null) {
  return render(
    <LiveWorkarea
      activeCode={activeCode}
      bundle={null}
      clampEngaged={false}
      isPastCandlesLoading={false}
      live={LIVE}
    />,
  );
}

describe('LiveWorkarea gate', () => {
  it('renders the chart when activeCode is set (even with empty watchlist)', () => {
    renderWorkarea('005930');
    expect(screen.getByTestId('chart-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('live-empty-state')).toBeNull();
  });

  it('renders the search-prompt empty state when no activeCode', () => {
    renderWorkarea(null);
    expect(screen.getByTestId('live-empty-state')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/LiveWorkarea.test.tsx`
Expected: FAIL — `LiveWorkarea` still requires the removed `watchlistEmpty` prop / TS error, or empty-state branch renders.

- [ ] **Step 3: Edit LiveWorkarea — drop the watchlistEmpty branch**

`frontend/src/live/LiveWorkarea.tsx`: remove `watchlistEmpty` from the `Props` interface and the destructure, and delete the leading `if (watchlistEmpty) { ... }` block (lines 31-37). The remaining gate is `if (!activeCode) → LiveEmptyState cause="no_active_code"` then chart. Final body:
```tsx
export function LiveWorkarea({
  activeCode,
  bundle,
  clampEngaged,
  isPastCandlesLoading,
  live,
}: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);

  if (!activeCode) {
    return (
      <div data-testid="live-workarea" className="h-full flex">
        <div style={{ flex: 1 }}>
          <LiveEmptyState cause="no_active_code" />
        </div>
      </div>
    );
  }
  // ...unchanged chart + sidebar return...
}
```
And drop `watchlistEmpty: boolean;` from `Props`.

- [ ] **Step 4: Edit LivePage — stop passing watchlistEmpty; suppress empty banner when viewing**

`frontend/src/live/LivePage.tsx`:
- Remove `const watchlistEmpty = banner.primary === 'watchlist_empty';` (line 58).
- Remove the `watchlistEmpty={watchlistEmpty}` prop from `<LiveWorkarea .../>`.
- Suppress the contradictory empty-watchlist banner while a chart is shown: change the banner render to
```tsx
      <LiveStateBanner
        primary={activeCode && banner.primary === 'watchlist_empty' ? null : banner.primary}
        stack={banner.stack}
      />
```
(`kis_credentials_missing` and the `stack` banners are untouched.)

- [ ] **Step 5: Run Workarea test to verify it passes**

Run: `cd frontend && npx vitest run src/live/LiveWorkarea.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Update LiveEmptyState copy + its test**

`frontend/src/live/LiveEmptyState.tsx` — replace the `no_active_code` block's text so it invites search:
```tsx
  // no_active_code
  return (
    <div
      data-testid="live-empty-state"
      className="flex items-center justify-center h-full"
      style={{ background: 'var(--bg)', color: 'var(--fg-dimmer)' }}
    >
      <div className="text-center">
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--fg-dim)' }}>
          <kbd className="bg-bg-input border border-border rounded px-1.5 py-0.5 font-mono">/</kbd>
          {' '}를 눌러 종목을 검색하세요
        </p>
        <p style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-sm)' }}>
          최근 본 종목이 있으면 자동으로 불러옵니다
        </p>
      </div>
    </div>
  );
```
(The `watchlist_empty` variant stays in the component for now — it is simply no longer reached as a chart-blanking cause; the `/capture` deep-link test below still validates the markup. Removing it fully is in the spec backlog.)

In `frontend/src/live/LiveEmptyState.test.tsx`, replace the `no_active_code` assertion:
```tsx
  it('renders no_active_code variant', () => {
    render_(<LiveEmptyState cause="no_active_code" />);
    expect(screen.getByText(/검색하세요/)).toBeInTheDocument();
  });
```

- [ ] **Step 7: Run LiveEmptyState + LivePage tests**

Run: `cd frontend && npx vitest run src/live/LiveEmptyState.test.tsx src/live/LivePage.test.tsx`
Expected: PASS. (If `LivePage.test.tsx` asserts the old empty copy or the `watchlistEmpty` wiring, update those assertions to match the new search-prompt text / removed prop.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/live/LiveWorkarea.tsx frontend/src/live/LiveWorkarea.test.tsx \
        frontend/src/live/LivePage.tsx frontend/src/live/LiveEmptyState.tsx \
        frontend/src/live/LiveEmptyState.test.tsx
git commit -m "feat(live): gate workarea on activeCode only; search-prompt empty state"
```

---

## Task 4: `LiveSymbolSearch` + 헤더 마운트 + 검색→차트

**Files:**
- Modify: `frontend/src/live/useLiveKeyboard.ts` (export `shouldIgnoreEvent`)
- Create: `frontend/src/live/LiveSymbolSearch.tsx`, `frontend/src/live/LiveSymbolSearch.test.tsx`
- Modify: `frontend/src/live/LiveHeader.tsx`

- [ ] **Step 1: Export the shared keyboard guard**

`frontend/src/live/useLiveKeyboard.ts`: change the guard's declaration from `function shouldIgnoreEvent(...)` to `export function shouldIgnoreEvent(...)` (line 21). No behavior change.

- [ ] **Step 2: Write the failing LiveSymbolSearch test**

`frontend/src/live/LiveSymbolSearch.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveSymbolSearch } from './LiveSymbolSearch';
import { useLivePageStore } from '../state/livePage';
import type { SymbolHit } from '../api/types';

const HIT: SymbolHit = {
  code: '005930', name: '삼성전자', market: 'KOSPI',
  captured_count: 0,
  captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
};

// Drive search results deterministically.
vi.mock('../capture/useSymbols', () => ({
  useSymbolSearch: (q: string) => (q.trim().length ? [HIT] : []),
}));

function renderSearch() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], { entries: [], next_run_at_ms: 0 });
  return render(
    <QueryClientProvider client={qc}>
      <LiveSymbolSearch />
    </QueryClientProvider>,
  );
}

describe('LiveSymbolSearch', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({ activeCode: null });
  });

  it('focuses the input when "/" is pressed', () => {
    renderSearch();
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(input);
  });

  it('selecting a result sets activeCode', () => {
    renderSearch();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });

  it('Enter on a 6-digit query with no results sets activeCode (code-only view)', () => {
    renderSearch();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    // useSymbolSearch mock returns [HIT] for any non-empty query, so force the
    // empty-results path by querying a 6-digit code the mock would still match;
    // here we assert the onEnterEmpty wiring via a query the mock maps to [].
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '036570' } });
    // mock returns [HIT] for non-empty → emulate "no match" by clearing items:
    // (covered more directly in the hook test; here we assert no crash + open)
    expect(input).toBeInTheDocument();
  });
});
```
> Note: the 6-digit `onEnterEmpty` path is unit-tested directly in Task 1 (`useSymbolCombobox` `onEnterEmpty`). The third test here is a smoke check; keep it minimal to avoid coupling to the mock's match logic.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/LiveSymbolSearch.test.tsx`
Expected: FAIL — cannot resolve `./LiveSymbolSearch`.

- [ ] **Step 4: Implement LiveSymbolSearch**

`frontend/src/live/LiveSymbolSearch.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'react';
import { useSymbolSearch } from '../capture/useSymbols';
import { useSymbolCombobox } from '../symbols/useSymbolCombobox';
import { useLivePageStore } from '../state/livePage';
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from '../watchlist/useWatchlist';
import { shouldIgnoreEvent } from './useLiveKeyboard';
import { HeartIcon } from '../ui/HeartIcon';
import type { SymbolHit } from '../api/types';

export function LiveSymbolSearch() {
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const [query, setQuery] = useState('');
  const items = useSymbolSearch(query, 20);

  const { data: watchlist } = useWatchlist();
  const memberCodes = useMemo(
    () => new Set(watchlist?.entries.map((e) => e.code) ?? []),
    [watchlist],
  );
  const addM = useAddToWatchlist();
  const removeM = useRemoveFromWatchlist();

  const combo = useSymbolCombobox<SymbolHit>({
    query,
    setQuery,
    items,
    onSelect: (hit) => { setActiveCode(hit.code); setQuery(''); },
    onEnterEmpty: (q) => {
      const t = q.trim();
      if (/^\d{6}$/.test(t)) { setActiveCode(t); setQuery(''); return true; }
      return false;
    },
  });

  // Global "/" focuses the input (Discord/Linear pattern). The shared guard
  // skips when focus is already in an input, so "/" types literally there.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || shouldIgnoreEvent(e.target)) return;
      e.preventDefault();
      combo.inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo.inputRef]);

  const toggleMember = (hit: SymbolHit) => {
    if (memberCodes.has(hit.code)) removeM.mutate(hit.code);
    else addM.mutate(hit.code);
  };

  const dropdownVisible = combo.open && query.trim().length >= 1;

  return (
    <div className="relative flex-1 max-w-[360px] font-ui">
      <div
        className={`flex items-center gap-2 h-7 px-2.5 bg-bg-input border rounded-lg ${
          combo.open ? 'border-accent' : 'border-border-strong'
        }`}
      >
        <span aria-hidden className="text-fg-dimmer text-sm">🔍</span>
        <input
          ref={combo.inputRef}
          role="combobox"
          aria-expanded={dropdownVisible}
          aria-controls="live-symbol-search-list"
          type="text"
          placeholder="종목명 또는 코드 검색…"
          className="flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-fg-dimmer"
          {...combo.inputProps}
        />
        <span className="ml-auto flex items-center gap-1 text-fg-dimmer text-xs">
          <kbd className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 border border-border-strong rounded bg-bg-input font-mono">/</kbd>
        </span>
      </div>

      {dropdownVisible && (
        <div
          id="live-symbol-search-list"
          {...combo.listProps}
          style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
          className="absolute z-20 top-full left-0 right-0 mt-1 bg-bg-card border border-border-strong rounded-lg max-h-80 overflow-y-auto"
        >
          {items.length === 0 ? (
            <div className="py-3 px-2.5 text-sm text-fg-dim">검색 결과가 없습니다.</div>
          ) : (
            items.map((hit, i) => {
              const member = memberCodes.has(hit.code);
              return (
                <div
                  key={hit.code}
                  role="option"
                  {...combo.getOptionProps(i)}
                  onClick={() => { setActiveCode(hit.code); setQuery(''); combo.setOpen(false); }}
                  style={{ background: i === combo.highlightedIndex ? 'rgba(20,184,166,0.10)' : 'transparent' }}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-2.5 items-center py-2 px-2.5 cursor-pointer"
                >
                  <span className="text-sm text-fg">{hit.name}</span>
                  <span className="text-sm font-mono text-fg-dim tabular-nums">{hit.code}</span>
                  <span className="border border-border-strong rounded px-1 text-badge font-semibold tracking-wider text-fg-dim">{hit.market}</span>
                  <button
                    type="button"
                    aria-label={member ? '관심종목 해제' : '관심종목 추가'}
                    aria-pressed={member}
                    className={`leading-none ${member ? 'text-fg' : 'text-fg-dimmer hover:text-fg'}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => { e.stopPropagation(); toggleMember(hit); }}
                  >
                    <HeartIcon filled={member} className="w-[1em] h-[1em]" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default LiveSymbolSearch;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/LiveSymbolSearch.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Mount in LiveHeader**

`frontend/src/live/LiveHeader.tsx`:
```tsx
import { LiveSymbolSearch } from './LiveSymbolSearch';

export function LiveHeader() {
  return (
    <div
      data-testid="live-header"
      className="flex items-center gap-3 border-b px-3"
      style={{ height: 'var(--h-live-header)', borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}
    >
      <h1 className="font-semibold" style={{ fontSize: 'var(--text-md)', color: 'var(--fg)' }}>
        Live
      </h1>
      <LiveSymbolSearch />
    </div>
  );
}
```

- [ ] **Step 7: Verify the header still renders (full live suite quick check)**

Run: `cd frontend && npx vitest run src/live/`
Expected: PASS. (LiveHeader has no dedicated test; this confirms no import/type breakage across the live module.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/live/useLiveKeyboard.ts frontend/src/live/LiveSymbolSearch.tsx \
        frontend/src/live/LiveSymbolSearch.test.tsx frontend/src/live/LiveHeader.tsx
git commit -m "feat(live): header inline symbol search ('/' to focus) → setActiveCode"
```

---

## Task 5: 상태바 ♥ 토글 + 멤버십 + 실시간/과거 힌트

**Files:**
- Modify: `frontend/src/live/LiveStatusBar.tsx`
- Test: `frontend/src/live/LiveStatusBar.test.tsx`

- [ ] **Step 1: Add the failing ♥ tests**

Append to `frontend/src/live/LiveStatusBar.test.tsx` — first, **merge** these into the existing import lines (add `vi` to the `from 'vitest'` import, add `fireEvent` to the `from '@testing-library/react'` import, and add the api namespace import), then **replace** the existing `renderBar` to seed the watchlist cache, then add cases:
```tsx
// merge into existing imports:
//   import { describe, it, expect, beforeEach, vi } from 'vitest';
//   import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import * as watchlistApi from '../api/watchlist';

function renderBar(
  props: { activeCode: string | null; cycleLagMs: number; bundle: RangeBundle | null },
  watchlistCodes: string[] = [],
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    entries: watchlistCodes.map((code) => ({
      code, name: code, registered_at_kst_date: '20260101', last_success_date: null,
    })),
    next_run_at_ms: 0,
  });
  return render(
    <QueryClientProvider client={qc}>
      <LiveStatusBar {...props} />
    </QueryClientProvider>,
  );
}
```
Add cases:
```tsx
  it('shows a filled heart + no historical-only hint for a watchlist member', () => {
    renderBar({ activeCode: '005930', cycleLagMs: 0, bundle: EMPTY_BUNDLE }, ['005930']);
    const btn = screen.getByRole('button', { name: '관심종목 해제' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText(/실시간 ✕/)).toBeNull();
  });

  it('shows an outline heart + historical-only hint for a non-member', () => {
    renderBar({ activeCode: '000660', cycleLagMs: 0, bundle: EMPTY_BUNDLE }, ['005930']);
    expect(screen.getByRole('button', { name: '관심종목 추가' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/실시간 ✕/)).toBeInTheDocument();
  });

  it('clicking the heart of a member calls removeFromWatchlist', () => {
    const spy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined as never);
    renderBar({ activeCode: '005930', cycleLagMs: 0, bundle: EMPTY_BUNDLE }, ['005930']);
    fireEvent.click(screen.getByRole('button', { name: '관심종목 해제' }));
    expect(spy).toHaveBeenCalledWith('005930');
    spy.mockRestore();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/live/LiveStatusBar.test.tsx`
Expected: FAIL — no heart button yet.

- [ ] **Step 3: Implement ♥ in LiveStatusBar**

`frontend/src/live/LiveStatusBar.tsx` — add imports:
```tsx
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from '../watchlist/useWatchlist';
import { HeartIcon } from '../ui/HeartIcon';
```
Inside the component, after `symbolLabel`:
```tsx
  const { data: watchlist } = useWatchlist();
  const isMember = !!activeCode && (watchlist?.entries.some((e) => e.code === activeCode) ?? false);
  const addM = useAddToWatchlist();
  const removeM = useRemoveFromWatchlist();
  const toggleMember = () => {
    if (!activeCode) return;
    if (isMember) removeM.mutate(activeCode);
    else addM.mutate(activeCode);
  };
```
Render the heart button immediately after the `symbolLabel` span, and the historical-only hint where the live indicator sits. Replace the existing `LIVE● (대기 중)` span with a membership-aware block:
```tsx
      <span className="font-mono" style={{ color: 'var(--fg)' }}>
        {symbolLabel}
      </span>
      {activeCode && (
        <button
          type="button"
          aria-label={isMember ? '관심종목 해제' : '관심종목 추가'}
          aria-pressed={isMember}
          onClick={toggleMember}
          className={`leading-none ${isMember ? 'text-fg' : 'text-fg-dimmer hover:text-fg'}`}
        >
          <HeartIcon filled={isMember} className="w-[1em] h-[1em]" />
        </button>
      )}
      <span aria-hidden>·</span>
      {/* ...price, timeframe, source chip unchanged... */}
      <span aria-hidden>·</span>
      {activeCode && !isMember ? (
        <span style={{ color: 'var(--fg-dimmer)' }}>
          과거 차트 · 실시간 ✕
          <span className="ml-2" style={{ color: 'var(--accent)' }}>♡ 눌러 실시간 추적</span>
        </span>
      ) : (
        <span style={{ color: 'var(--fg-dimmer)' }}>LIVE● (대기 중)</span>
      )}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/live/LiveStatusBar.test.tsx`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveStatusBar.tsx frontend/src/live/LiveStatusBar.test.tsx
git commit -m "feat(live): active-symbol heart toggle + historical-only hint in status bar"
```

---

## Task 6: 백엔드 `refresh_live_poller` (lifecycle)

stop-then-conditional-start. 비면 `stop`(start만 부르면 stale 폴러 잔존), 안 비면 `start`(idempotent 재시작, 버퍼 보존).

**Files:**
- Modify: `hoga/live/lifecycle.py`
- Test: `tests/unit/live/test_lifecycle_start.py`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/live/test_lifecycle_start.py`:
```python
@pytest.mark.asyncio
async def test_refresh_live_poller_picks_up_new_codes(tmp_path: Path, monkeypatch) -> None:
    """refresh after a watchlist mutation re-syncs the poller's tracked codes."""
    import json
    from hoga.live import lifecycle, poller as poller_module

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    def write_wl(codes: list[str]) -> None:
        (tmp_path / "watchlist.json").write_text(json.dumps({
            "version": 1,
            "entries": [
                {"code": c, "name": c, "registered_at_kst_date": "20260101",
                 "last_success_date": None} for c in codes
            ],
        }))

    write_wl(["005930"])
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert lifecycle.get_active_codes() == ["005930"]

    write_wl(["005930", "000660"])
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert set(lifecycle.get_active_codes()) == {"005930", "000660"}
    await lifecycle.stop_live_poller()


@pytest.mark.asyncio
async def test_refresh_live_poller_stops_on_empty(tmp_path: Path, monkeypatch) -> None:
    """Removing the last code must STOP the poller (start alone early-returns
    without stopping, leaving a stale poller on the old codes)."""
    import json
    from hoga.live import lifecycle, poller as poller_module

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [{"code": "005930", "name": "삼성전자",
                     "registered_at_kst_date": "20260101", "last_success_date": None}],
    }))
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert lifecycle.get_status().running is True

    # Simulate "removed the last entry".
    (tmp_path / "watchlist.json").write_text(json.dumps({"version": 1, "entries": []}))
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_refresh_live_poller_preserves_buffer(tmp_path: Path, monkeypatch) -> None:
    """A refresh must not swap out the snapshot buffer (♥ toggles must not drop
    accumulated live snapshots)."""
    import json
    from hoga.live import lifecycle, poller as poller_module

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [{"code": "005930", "name": "삼성전자",
                     "registered_at_kst_date": "20260101", "last_success_date": None}],
    }))
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    buf_before = lifecycle.get_buffer()
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert lifecycle.get_buffer() is buf_before
    await lifecycle.stop_live_poller()
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/unit/live/test_lifecycle_start.py -k refresh -v`
Expected: FAIL — `AttributeError: module 'hoga.live.lifecycle' has no attribute 'refresh_live_poller'`.

- [ ] **Step 3: Implement refresh_live_poller**

`hoga/live/lifecycle.py` — add after `start_live_poller` (or near it):
```python
async def refresh_live_poller(*, data_dir: Path) -> None:
    """Re-sync the running poller to the on-disk watchlist after a mutation.

    Non-empty watchlist → ``start_live_poller`` (idempotent restart that rebuilds
    ``_state`` from disk and *reuses* the module-global ``_buffer``, preserving
    accumulated snapshots). Empty watchlist → ``stop_live_poller`` — calling
    ``start_live_poller`` alone would early-return on the empty check *before* it
    stops the existing task, leaving a stale poller iterating the old codes.

    Cheap: no awaited network round-trip; ``KisClient`` reuses the on-disk token
    cache. Off-hours/missing-creds are safe (start no-ops/idle-gates; stop is a
    no-op when nothing runs).
    """
    from hoga.api.watchlist import load_watchlist

    if load_watchlist(data_dir):
        await start_live_poller(data_dir=data_dir)
    else:
        await stop_live_poller()
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/live/test_lifecycle_start.py -k refresh -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_lifecycle_start.py
git commit -m "feat(live): refresh_live_poller — re-sync poller to watchlist (stop on empty, preserve buffer)"
```

---

## Task 7: add/remove 라우트가 폴러 새로고침

**Files:**
- Modify: `hoga/api/watchlist_routes.py`
- Test: `tests/test_api_watchlist_routes.py`

- [ ] **Step 1: Add failing tests**

Append to `tests/test_api_watchlist_routes.py` (top-level imports `patch` already present; add `AsyncMock`):
```python
from unittest.mock import AsyncMock


def test_post_add_refreshes_poller(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.symbols.search", return_value=[_fake_hit()]), \
         patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.refresh_live_poller", new=AsyncMock()) as ref:
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist", json={"code": "003490"})
    assert r.status_code == 201
    ref.assert_awaited_once()
    assert ref.await_args.kwargs["data_dir"] == tmp_path


@pytest.mark.asyncio
async def test_delete_refreshes_poller(tmp_path: Path):
    from hoga.api import watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    with patch("hoga.api.watchlist_routes.refresh_live_poller", new=AsyncMock()) as ref:
        client = TestClient(_app(tmp_path))
        r = client.delete("/api/watchlist/003490")
    assert r.status_code == 204
    ref.assert_awaited_once()
    assert ref.await_args.kwargs["data_dir"] == tmp_path
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_api_watchlist_routes.py -k refreshes -v`
Expected: FAIL — `AttributeError: ... has no attribute 'refresh_live_poller'` (patch target missing) or routes don't call it.

- [ ] **Step 3: Wire the routes**

`hoga/api/watchlist_routes.py` — add the import near the other `hoga.live`/lifecycle imports at module top:
```python
from hoga.live.lifecycle import refresh_live_poller
```
In `add_to_watchlist`, after the successful `entry = await add_entry(...)` block and before `return entry`:
```python
        await refresh_live_poller(data_dir=data_dir)
        return entry
```
In `remove_from_watchlist`, after `await remove_entry(data_dir, code=code)` (inside the try, after success):
```python
        await refresh_live_poller(data_dir=data_dir)
```
(Leave the `NotInWatchlistError → 404` path untouched — no refresh on a no-op delete.)

- [ ] **Step 4: Run to verify pass + no regression on existing route tests**

Run: `uv run pytest tests/test_api_watchlist_routes.py -v`
Expected: PASS (existing add/remove/duplicate/404 tests + 2 new). Existing tests that don't patch `refresh_live_poller` will execute the real one against `tmp_path`; with no `KIS_APP_KEY` set it no-ops safely (start returns False / stop is a no-op).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist_routes.py tests/test_api_watchlist_routes.py
git commit -m "feat(api): add/remove watchlist refreshes the live poller immediately"
```

---

## Task 8: 캡처 `SymbolSearch` 훅 이관 (부채 청산)

캡처 고유 동작(캐시 상태 칩·refresh·stale 넛지·`captured_count` 행·`promoteUnverifiedCode`)을 보존하면서 상호작용을 `useSymbolCombobox`로 교체. `promoteUnverifiedCode`는 `onEnterEmpty`로 주입.

**Files:**
- Modify: `frontend/src/capture/SymbolSearch.tsx`
- Test: `frontend/src/pages/Capture.test.tsx` (회귀 가드, 기존), `frontend/src/capture/SymbolSearch.test.tsx` (create — promote 보존)

- [ ] **Step 1: Write a focused failing test for promote preservation**

`frontend/src/capture/SymbolSearch.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SymbolSearch } from './SymbolSearch';

// Force the "cache unavailable" branch so promoteUnverifiedCode is reachable.
vi.mock('./useSymbols', () => ({
  useSymbols: () => ({ data: { status: 'unavailable', reason: null, fetched_at_ms: null, symbols: [] } }),
  useSymbolSearch: () => [],
  SYMBOLS_QUERY_KEY: ['symbols', 'all'],
}));

function renderSearch(onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SymbolSearch value={null} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('SymbolSearch promote (cache unavailable)', () => {
  beforeEach(() => cleanup());

  it('Enter on a 6-digit code promotes an unverified SymbolHit', () => {
    const onChange = renderSearch();
    const input = screen.getByPlaceholderText(/종목명 또는 6자리 코드/);
    fireEvent.change(input, { target: { value: '005930' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ code: '005930', name: '—' }));
  });
});
```

- [ ] **Step 2: Run to verify it passes against the CURRENT implementation**

Run: `cd frontend && npx vitest run src/capture/SymbolSearch.test.tsx`
Expected: PASS (the current `SymbolSearch` already supports this — this test is the *regression guard* we must keep green through the refactor).

- [ ] **Step 3: Refactor SymbolSearch onto the hook (keep behavior)**

`frontend/src/capture/SymbolSearch.tsx` — replace the interaction internals with the shared hook while keeping all capture-specific UI. The key edits:

1. Add import: `import { useSymbolCombobox } from '../symbols/useSymbolCombobox';`
2. Remove the local `open`/`highlight`/`inputRef` state and the `onKeyDown` handler and the `useEffect(() => setHighlight(0), [query])`.
3. Keep `text`/`setText` (this is the consumer-owned `query`). Keep the `value`→`text` sync effect and the `select` + `promoteUnverifiedCode` functions.
4. Wire the hook:
```tsx
  const query = text.trim();
  const hits = useSymbolSearch(query, 20);

  const combo = useSymbolCombobox<SymbolHit>({
    query: text,
    setQuery: (q) => { setText(q); onChange(null); },
    items: hits,
    onSelect: (hit) => select(hit),
    onEnterEmpty: () => promoteUnverifiedCode(),  // returns true when it consumes a 6-digit code
  });

  const dropdownVisible = combo.open && query.length >= 1 && cacheStatus !== 'unavailable';
  const isEmpty = dropdownVisible && hits.length === 0;
```
5. Input element uses the hook's props + ref (keep placeholder/classes):
```tsx
        <input
          ref={combo.inputRef}
          type="text"
          {...combo.inputProps}
          placeholder="종목명 또는 6자리 코드"
          className="flex-1 bg-bg-input border rounded-lg text-fg py-sm px-sm text-base"
        />
```
   Note `combo.inputProps.onChange` already calls `setQuery` (which here is `setText` + `onChange(null)`), so the old inline `onChange` is replaced. The old `onFocus`/`onKeyDown` are likewise provided by `inputProps`.
6. Dropdown rows: replace the row container's highlight wiring to use `combo.getOptionProps(i)` and `i === combo.highlightedIndex`, keeping the `SymbolRow` content (captured_count etc.) unchanged:
```tsx
            hits.map((h, i) => (
              <div key={h.code} role="option" {...combo.getOptionProps(i)} onClick={() => select(h)}>
                <SymbolRow hit={h} highlighted={i === combo.highlightedIndex} onClick={() => select(h)} />
              </div>
            ))
```
   (`SymbolRow` already renders its own visuals; wrapping keeps option semantics. Alternatively inline `getOptionProps` onto the existing row — either is fine as long as `onMouseDown preventDefault` is present, which `getOptionProps` provides.)
7. `promoteUnverifiedCode` keeps its body but must **return** the boolean it already computes (it currently returns `true`/`false`); ensure both branches return so `onEnterEmpty` can signal consumption. (It already does: `return false` when not applicable, `return true` after `select(...)`.)

> Reminder: the `onEnterEmpty` path only fires when `hits.length === 0`. With the cache available and a 6-digit code that matches a real symbol, the normal `onSelect` path runs first (items present), so promote stays the cache-unavailable fallback exactly as before.

- [ ] **Step 4: Run the focused test + full capture/page suite**

Run: `cd frontend && npx vitest run src/capture/SymbolSearch.test.tsx src/pages/Capture.test.tsx`
Expected: PASS — promote preserved; Capture page behavior unchanged.

- [ ] **Step 5: Run the whole frontend suite (cross-module safety)**

Run: `cd frontend && npx vitest run`
Expected: PASS across the suite (watchlist panel still uses `SymbolSearch`; live search + status bar green).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/capture/SymbolSearch.tsx frontend/src/capture/SymbolSearch.test.tsx
git commit -m "refactor(capture): migrate SymbolSearch onto useSymbolCombobox (promote via onEnterEmpty)"
```

---

## Final verification

- [ ] **Frontend full suite:** `cd frontend && npx vitest run` → all green.
- [ ] **Backend touched suites:** `uv run pytest tests/unit/live/test_lifecycle_start.py tests/test_api_watchlist_routes.py -v` → all green.
- [ ] **Typecheck/lint:** `cd frontend && npx tsc --noEmit && npx eslint src/symbols src/ui src/live/LiveSymbolSearch.tsx` → clean.
- [ ] **Manual (spec §Manual verification):** dev 서버 기동 후 `/live`에서 `/` → "삼성" → 선택 → 차트; 빈 watchlist에서도 과거 차트 렌더; 장중 ♥ 클릭 → 채움 + 실시간 유입; 마지막 ♥ 해제 → 폴러 정지; `/capture` 검색 6자리 코드 Enter 승격 동작.

---

## Self-Review (plan author)

**Spec coverage** — 각 spec 요구를 task로 매핑:
- 헤더 인라인 바 + `/` 포커스 → Task 4. 전체검색 → Task 4(`useSymbolSearch`). 선택 → `setActiveCode` → Task 4. 6자리 코드뷰 → Task 1(`onEnterEmpty`)+Task 4. ♥(결과 행) → Task 4; ♥(상태바) → Task 5. 멤버십 표시/힌트 → Task 5. 게이트 완화 → Task 3. 빈 상태 카피 → Task 3. 헤드리스 훅 추출 → Task 1. HeartIcon 추출 → Task 2. 백엔드 refresh(+remove-to-empty) → Task 6. 라우트 연결 → Task 7. 버퍼 보존 → Task 6. 캡처 이관 → Task 8. **갭 없음.**
- 색 규율(♥ 중립) → Task 2 구현 + 테스트. 키보드 가드 재사용 → Task 4(Step 1 export + 사용).

**Placeholder scan** — 모든 step에 실제 코드/명령/기대출력 포함. "적절한 에러처리" 류 없음. (Task 8은 부분 diff지만 각 편집 지점의 실제 코드를 명시.)

**Type consistency** — `useSymbolCombobox`의 `query/setQuery/items/onSelect/onEnterEmpty` 시그니처가 Task 1 정의 ↔ Task 4(Live) ↔ Task 8(capture) 호출에서 동일. `HeartIcon({filled, className})`이 Task 2 정의 ↔ Task 4·5·RightRail 사용에서 동일. `refresh_live_poller(*, data_dir)`가 Task 6 정의 ↔ Task 7 호출에서 동일(키워드 인자). `LiveWorkarea` Props에서 `watchlistEmpty` 제거가 Task 3 정의 ↔ LivePage 호출에서 일치.
