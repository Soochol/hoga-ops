# 스크리너/관심종목 행 인라인 토글 + 다크 스크롤바 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right Rail의 Screener Panel 결과 행에 관심종목 추가/해제 하트를, Watchlist Panel 행에 인라인 제거(휴지통) 아이콘을 달고, 스크롤바를 다크 테마에 맞게 전역 스타일링한다.

**Architecture:** 공용 `QuoteRow`에 범용 `trailingAction?: ReactNode` 슬롯과 키보드 격리 가드를 추가하고, 각 패널이 affordance(하트/휴지통)를 주입한다. 관심종목 토글은 기존 `useWatchlistMembership`/`useRemoveFromWatchlist` 훅을 재사용(새 API 없음). 스크롤바는 `global.css` 전역 규칙(토큰 기반).

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react, @tanstack/react-query, Tailwind(토큰 매핑), CSS `::-webkit-scrollbar`.

**Spec:** [docs/superpowers/specs/2026-06-02-screener-heart-scrollbar-design.md](../specs/2026-06-02-screener-heart-scrollbar-design.md)

**공통 명령 (worktree 루트에서):**
- 단일 테스트: `cd frontend && npx vitest run <path>`
- 타입 게이트: `cd frontend && npx tsc -b`
- 변경 파일 eslint: `cd frontend && npx eslint <path>` (저장소 전역 `npm run lint`은 기존 부채로 실패하므로 변경 파일만 스코프)

---

### Task 1: `TrashIcon` SVG 컴포넌트 (신규)

Watchlist Panel 제거 버튼이 쓸 SVG. `HeartIcon`/`FunnelIcon`과 동일 패턴.

**Files:**
- Create: `frontend/src/ui/TrashIcon.tsx`
- Test: `frontend/src/ui/TrashIcon.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/ui/TrashIcon.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TrashIcon } from './TrashIcon';

describe('TrashIcon', () => {
  it('renders an svg outlined with currentColor (no fill)', () => {
    const { container } = render(<TrashIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('fill')).toBe('none');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
  });

  it('applies the className for sizing', () => {
    const { container } = render(<TrashIcon className="w-[1em] h-[1em]" />);
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('w-[1em]');
  });

  it('is aria-hidden (decorative — the button carries the label)', () => {
    const { container } = render(<TrashIcon />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/ui/TrashIcon.test.tsx`
Expected: FAIL — `Failed to resolve import "./TrashIcon"`.

- [ ] **Step 3: 구현**

`frontend/src/ui/TrashIcon.tsx`:

```tsx
/**
 * Shared trash glyph for the inline 관심종목 해제 control on Watchlist Panel rows.
 * Stroke = currentColor (neutral shape signal — see DESIGN.md). Size via `className`
 * (e.g. "w-[1em] h-[1em]"). Mirrors HeartIcon/FunnelIcon.
 */
export function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/ui/TrashIcon.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: 타입 체크**

Run: `cd frontend && npx tsc -b`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/ui/TrashIcon.tsx frontend/src/ui/TrashIcon.test.tsx
git commit -m "feat(ui): TrashIcon — 관심종목 인라인 제거용 SVG 글리프"
```

---

### Task 2: `QuoteRow` — `trailingAction` 슬롯 + 키보드 격리

공용 행에 옵트인 슬롯과 `group` 클래스, 중첩 버튼 keydown 버블링 차단 가드를 추가.

**Files:**
- Modify: `frontend/src/rightrail/QuoteRow.tsx`
- Test: `frontend/src/rightrail/QuoteRow.test.tsx`

- [ ] **Step 1: 실패 테스트 추가**

`frontend/src/rightrail/QuoteRow.test.tsx`의 `describe('QuoteRow', ...)` 안에 아래 테스트를 추가하고, 파일 상단 import에 `within`을 더한다 (`import { render, screen, fireEvent, within } from '@testing-library/react';`):

```tsx
  it('renders no trailing cell when trailingAction is omitted (backward compat)', () => {
    row();
    expect(within(screen.getByTestId('quote-row-005930')).queryByRole('button')).toBeNull();
  });

  it('renders the trailingAction node when provided', () => {
    row({ trailingAction: <button data-testid="act">x</button> });
    expect(within(screen.getByTestId('quote-row-005930')).getByTestId('act')).toBeInTheDocument();
  });

  it('Enter on the trailing action does NOT trigger the row onClick (keyboard isolation)', () => {
    const { onClick } = row({ trailingAction: <button data-testid="act">x</button> });
    fireEvent.keyDown(screen.getByTestId('act'), { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Enter on the row itself still triggers onClick', () => {
    const { onClick } = row({ trailingAction: <button data-testid="act">x</button> });
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/rightrail/QuoteRow.test.tsx`
Expected: FAIL — `trailingAction`은 아직 prop이 아니라 렌더되지 않고, keydown 가드가 없어 "Enter on trailing action" 테스트에서 onClick이 호출됨.

- [ ] **Step 3: 구현 — `QuoteRow.tsx` 전체를 아래로 교체**

`frontend/src/rightrail/QuoteRow.tsx`:

```tsx
import { ChangeCell } from '../screener/ChangeCell';

/** 관심종목·스크리너 드로어 공용 행: 코드 │ 이름 │ 현재가 │ 등락률 │ (선택) 트레일링 액션.
 *  ScreenerResultRow 의 시각/키보드 계약을 그대로 가져오고 현재가 셀을 추가.
 *  trailingAction: 패널이 주입하는 행 우측 affordance(하트/휴지통). 자체적으로
 *  stopPropagation/aria 를 책임진다. <li> 는 group 이라 액션이 group-hover/
 *  group-focus-within 로 등장 처리를 할 수 있다. */
export function QuoteRow({
  code, name, price, pct, active, ariaLabel, testId, onClick, trailingAction,
}: {
  code: string;
  name: string;
  price: number | null;
  pct: number | null;
  active: boolean;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
  trailingAction?: React.ReactNode;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    // 중첩 버튼(trailingAction)에서 올라온 keydown 은 무시 — 행이 직접
    // 포커스됐을 때만 Enter/Space 로 차트를 연다.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
  return (
    <li
      data-testid={testId}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="group cursor-pointer px-md py-sm flex items-center gap-2 border-b outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
      style={{
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <span className="font-mono text-xs text-fg-dim" style={{ minWidth: '3.2rem' }}>{code}</span>
      <span className="flex-1 truncate text-sm text-fg">{name}</span>
      <span className="font-mono tabular-nums text-sm text-fg-dim text-right">
        {price != null ? price.toLocaleString('ko-KR') : '—'}
      </span>
      <span className="font-mono tabular-nums text-sm text-right" style={{ minWidth: '4.5rem' }}>
        <ChangeCell pct={pct} />
      </span>
      {trailingAction != null && (
        <span className="flex items-center justify-center" style={{ minWidth: '1.25rem' }}>
          {trailingAction}
        </span>
      )}
    </li>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/rightrail/QuoteRow.test.tsx`
Expected: PASS (기존 3 + 신규 4 = 7 tests). 기존 "Enter key triggers onClick" 도 그대로 통과(가드의 `e.target === e.currentTarget`).

- [ ] **Step 5: 타입 체크**

Run: `cd frontend && npx tsc -b`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/rightrail/QuoteRow.tsx frontend/src/rightrail/QuoteRow.test.tsx
git commit -m "feat(rightrail): QuoteRow trailingAction 슬롯 + 중첩버튼 키보드 격리 가드"
```

---

### Task 3: Screener Panel — 추가/해제 하트 배선

`ScreenerDrawer`가 `useWatchlistMembership()`를 1회 호출하고 각 결과 행에 하트를 주입.

**Files:**
- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
- Test: `frontend/src/screener/ScreenerDrawer.test.tsx`

- [ ] **Step 1: 테스트 갱신 + 하트 테스트 추가**

먼저 기존 테스트 보호: `ScreenerDrawer.test.tsx` 상단 import에 watchlist API/within 추가, `beforeEach`에 `getWatchlist` 모킹 추가(미모킹 시 `useWatchlistMembership`가 `apiCall` 전역 모킹의 `{phase,quotes}`를 받아 `data.entries.map` 에서 throw → 전 테스트 크래시).

import 블록에 추가:
```tsx
import { within } from '@testing-library/react'; // (기존 render/screen/fireEvent/waitFor/cleanup 줄에 within 추가도 가능)
import * as watchlistApi from '../api/watchlist';
```

`beforeEach` 끝에 추가:
```tsx
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: [], next_run_at_ms: 0 });
```

그리고 신규 테스트 2개 추가:
```tsx
  it('clicking a non-member row heart adds it to the watchlist', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const addSpy = vi.spyOn(watchlistApi, 'addToWatchlist').mockResolvedValue({
      code: '005930', name: '삼성전자', registered_at_kst_date: '20260602', last_success_date: null,
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const heart = within(screen.getByTestId('screener-row-005930')).getByRole('button', { name: '관심종목 추가' });
    fireEvent.click(heart);
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith('005930'));
    expect(useLivePageStore.getState().activeCode).toBeNull(); // 행 클릭(차트 열기)은 발화 안 함
  });

  it('clicking a member row heart removes it from the watchlist', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null }],
      next_run_at_ms: 0,
    });
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    const heart = await waitFor(() =>
      within(screen.getByTestId('screener-row-005930')).getByRole('button', { name: '관심종목 해제' }),
    );
    fireEvent.click(heart);
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('005930'));
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx`
Expected: 신규 2 테스트 FAIL — 하트 버튼(`관심종목 추가`/`관심종목 해제`)이 아직 없음. 기존 테스트는 통과(getWatchlist 모킹 추가 덕분).

- [ ] **Step 3: 구현 — `ScreenerDrawer.tsx`**

(a) import 추가 (기존 import 블록):
```tsx
import { HeartIcon } from '../ui/HeartIcon';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
```

(b) 컴포넌트 최상위, 다른 훅들 옆에 1회 호출 추가(예: `setActiveCode` 줄 아래):
```tsx
  const { isMember, toggle } = useWatchlistMembership();
```

(c) 결과 `<ul>` 의 `QuoteRow` 에 `trailingAction` prop 추가. 현재:
```tsx
                  return (
                    <QuoteRow
                      key={r.code}
                      code={r.code}
                      name={r.name}
                      price={q?.price ?? null}
                      pct={q?.change_pct ?? r.change_pct}
                      active={r.code === activeCode}
                      ariaLabel={`${r.name} ${r.code} 차트 열기`}
                      testId={`screener-row-${r.code}`}
                      onClick={() => openLive(r.code)}
                    />
                  );
```
를 아래로 교체:
```tsx
                  const member = isMember(r.code);
                  return (
                    <QuoteRow
                      key={r.code}
                      code={r.code}
                      name={r.name}
                      price={q?.price ?? null}
                      pct={q?.change_pct ?? r.change_pct}
                      active={r.code === activeCode}
                      ariaLabel={`${r.name} ${r.code} 차트 열기`}
                      testId={`screener-row-${r.code}`}
                      onClick={() => openLive(r.code)}
                      trailingAction={
                        <button
                          type="button"
                          aria-label={member ? '관심종목 해제' : '관심종목 추가'}
                          aria-pressed={member}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => { e.stopPropagation(); toggle(r.code); }}
                          className={
                            member
                              ? 'leading-none text-fg transition-[opacity,color] duration-[80ms]'
                              : 'leading-none text-fg-dimmer opacity-45 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-fg focus-visible:text-fg transition-[opacity,color] duration-[80ms]'
                          }
                        >
                          <HeartIcon filled={member} className="w-[1em] h-[1em]" />
                        </button>
                      }
                    />
                  );
```
`q` 는 기존 `const q = quoteByCode.get(r.code);` 줄 그대로 유지(같은 map 콜백 안). `const member = ...` 는 `return` 직전에 둔다.

- [ ] **Step 4: 테스트 통과 확인 (전체 파일)**

Run: `cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx`
Expected: PASS (기존 + 신규 2). 회귀 없음.

- [ ] **Step 5: 타입 체크**

Run: `cd frontend && npx tsc -b`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/screener/ScreenerDrawer.tsx frontend/src/screener/ScreenerDrawer.test.tsx
git commit -m "feat(screener): 결과 행 하트 토글 — 관심종목 추가/해제 (C 트리트먼트)"
```

---

### Task 4: Watchlist Panel — 인라인 제거(휴지통) 배선

`WatchlistDrawer`가 `useRemoveFromWatchlist`로 각 행에 휴지통 제거 버튼을 주입.

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

- [ ] **Step 1: 제거 테스트 추가**

`WatchlistDrawer.test.tsx` 상단 import 줄에 `within` 추가(`import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';`). `describe` 안에 추가:

```tsx
  it('clicking a row trash icon removes it from the watchlist', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const trash = within(screen.getByTestId('watchlist-row-005930')).getByRole('button', { name: '삼성전자 관심종목 해제' });
    fireEvent.click(trash);
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('005930'));
    expect(useLivePageStore.getState().activeCode).toBeNull(); // 행 클릭(차트 열기)은 발화 안 함
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: FAIL — 휴지통 버튼(`삼성전자 관심종목 해제`)이 아직 없음.

- [ ] **Step 3: 구현 — `WatchlistDrawer.tsx`**

(a) import 추가:
```tsx
import { useRemoveFromWatchlist } from './useWatchlist';
import { TrashIcon } from '../ui/TrashIcon';
```

(b) 컴포넌트 안, `quoteByCode` useMemo 아래에 추가:
```tsx
  const removeM = useRemoveFromWatchlist();
```

(c) 결과 `<ul>` 의 `QuoteRow` 에 `trailingAction` 추가. 현재 map 의 반환:
```tsx
            <QuoteRow
              key={entry.code}
              code={entry.code}
              name={entry.name}
              price={q?.price ?? null}
              pct={q?.change_pct ?? null}
              active={entry.code === activeCode}
              ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
              testId={`watchlist-row-${entry.code}`}
              onClick={() => onPick(entry.code)}
            />
```
를 아래로 교체(닫는 `/>` 앞에 `trailingAction` 추가):
```tsx
            <QuoteRow
              key={entry.code}
              code={entry.code}
              name={entry.name}
              price={q?.price ?? null}
              pct={q?.change_pct ?? null}
              active={entry.code === activeCode}
              ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
              testId={`watchlist-row-${entry.code}`}
              onClick={() => onPick(entry.code)}
              trailingAction={
                <button
                  type="button"
                  aria-label={`${entry.name} 관심종목 해제`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); removeM.mutate(entry.code); }}
                  className="leading-none text-fg-dimmer opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-error focus-visible:text-error transition-[opacity,color] duration-[80ms]"
                >
                  <TrashIcon className="w-[1em] h-[1em]" />
                </button>
              }
            />
```

- [ ] **Step 4: 테스트 통과 확인 (전체 파일)**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: PASS (기존 + 신규 1). 회귀 없음.

- [ ] **Step 5: 타입 체크**

Run: `cd frontend && npx tsc -b`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat(watchlist): Watchlist Panel 행 인라인 제거(휴지통) — hover/focus reveal"
```

---

### Task 5: 다크 스크롤바 전역 스타일 (A: Thin 8px)

CSS-only. jsdom 단위 테스트는 의미가 없으므로 타입/빌드 sanity + 수동 확인으로 검증.

**Files:**
- Modify: `frontend/src/styles/global.css`

- [ ] **Step 1: 구현 — `global.css` 끝에 추가**

`frontend/src/styles/global.css` 파일 맨 끝(마지막 `@keyframes`/`.live-pulse` 블록 뒤)에 추가:

```css
/* 다크 테마 스크롤바 — 전역. 토큰만 사용(DESIGN.md, 그라데이션/장식 금지).
   실제 렌더 환경은 WebKit/Chromium(Vite dev + /browse). lightweight-charts
   캔버스는 자체 캔버스라 영향 없음. */
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
*::-webkit-scrollbar-thumb:hover { background: var(--fg-dimmer); }

/* Firefox 폴백 — 폭/색만 제어 가능 */
* { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
```

- [ ] **Step 2: 빌드/타입 sanity (회귀 없음 확인)**

Run: `cd frontend && npx tsc -b`
Expected: 에러 없음 (CSS 변경은 타입 무관 — 다른 변경이 안 깨졌는지 확인용).

Run: `cd frontend && npx vitest run`
Expected: 전체 스위트 PASS (CSS 변경이 컴포넌트 테스트를 깨지 않음).

- [ ] **Step 3: 수동 확인 (브라우저)**

dev 서버가 떠 있다고 가정(`http://localhost:5173`). 없으면 `cd frontend && npm run dev` 후:
```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B js "getComputedStyle(document.documentElement).getPropertyValue('--border-strong')"   # 토큰 존재 확인
```
육안: Screener/Watchlist 패널·검색 드롭다운에서 8px 다크 thumb, 투명 트랙, thumb hover 시 밝아짐. 밝은 회색 기본 스크롤바가 사라졌는지 확인.

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/styles/global.css
git commit -m "style(fe): 다크 테마 전역 스크롤바 — thin 8px, --border-strong thumb (A)"
```

---

### Task 6: 최종 검증 (전체 게이트)

- [ ] **Step 1: 전체 프런트 테스트**

Run: `cd frontend && npx vitest run`
Expected: 전체 PASS (회귀 0).

- [ ] **Step 2: 타입 게이트**

Run: `cd frontend && npx tsc -b`
Expected: 에러 없음.

- [ ] **Step 3: 변경 파일 eslint (스코프)**

Run: `cd frontend && npx eslint src/ui/TrashIcon.tsx src/rightrail/QuoteRow.tsx src/screener/ScreenerDrawer.tsx src/watchlist/WatchlistDrawer.tsx`
Expected: 변경 파일 0 errors (저장소 전역 `npm run lint`은 기존 부채로 실패 — 변경 파일만 게이트).

- [ ] **Step 4: 도메인 용어 점검**

`git diff main...HEAD` 가 CONTEXT.md의 용어(Watchlist/관심종목, Screener Panel/Watchlist Panel, Live Quote)와 일치하는지 확인. 하트 aria-label은 `관심종목 추가`/`관심종목 해제`(기존 검색·상태바 하트와 동일), 제거는 `… 관심종목 해제`로 통일됐는지 확인.

---

## Self-Review (작성자 점검 결과)

**1. Spec coverage**
- Goal ① 스크리너 하트 추가/해제 → Task 3 ✓
- Goal ② 관심종목 인라인 제거(휴지통) → Task 1(아이콘) + Task 4 ✓
- Goal ③ 액션 클릭/Enter가 행과 비간섭(마우스·키보드) → Task 2(키보드 가드) + Task 3·4(버튼 stopPropagation) ✓
- Goal ④ 다크 스크롤바 전역 → Task 5 ✓
- Goal ⑤ 신규 prop 미전달 시 회귀 없음 → Task 2 "backward compat" 테스트 ✓
- Spec Design §1 trailingAction 슬롯 + group + 키보드 가드 → Task 2 ✓; §2 하트 C 트리트먼트 → Task 3 ✓; §3 휴지통 reveal + hover:text-error → Task 4 ✓; §4 TrashIcon → Task 1 ✓; §5 스크롤바 → Task 5 ✓
- Spec Testing 표의 모든 케이스가 Task 2~4 테스트로 매핑됨 ✓

**2. Placeholder scan**: "TBD/TODO/적절히 처리" 없음. 모든 코드 단계에 실제 코드 포함 ✓

**3. Type consistency**: prop명 `trailingAction`(Task 2 정의 → Task 3·4 사용) 일치; `isMember`/`toggle`(useWatchlistMembership 실제 시그니처) 일치; `removeM.mutate(code)`(useRemoveFromWatchlist 실제) 일치; `HeartIcon filled`/`TrashIcon className` 실제 시그니처 일치; aria-label 문자열이 테스트 셀렉터와 정확히 일치(`관심종목 추가`/`관심종목 해제`/`${name} 관심종목 해제`) ✓
