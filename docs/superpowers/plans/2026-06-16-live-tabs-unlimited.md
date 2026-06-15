# Live Tabs Unlimited Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `/live` 8-tab cap and keep many open tabs navigable with a single-row scrollable tab strip plus a searchable overflow menu.

**Architecture:** Keep `useLiveTabsStore` as the source of tab state, but remove the cap branch from tab creation. Keep `LiveTabBar` as the tab UI owner, with a scrollable tab-strip region and fixed right-side actions. Add `LiveTabOverflowMenu` as a focused child component that filters existing tabs and calls the existing `onFocus(id)` callback.

**Tech Stack:** React 18, Zustand, Testing Library, Vitest, Vite, existing `useDismissablePopover` helper.

---

## File Structure

- Modify `frontend/src/state/liveTabs.ts`
  - Remove `TABS_SOFT_CAP`.
  - Remove the cap no-op from `addBlankTab()`.
  - Keep viewport snapshot behavior unchanged.
- Modify `frontend/src/state/liveTabs.test.ts`
  - Replace the cap no-op test with a “more than 8 tabs are allowed” test.
- Create `frontend/src/live/LiveTabOverflowMenu.tsx`
  - Owns the overflow trigger, popover open state, filter input, filtered list, active marker, and `onFocus` dispatch.
- Create `frontend/src/live/LiveTabOverflowMenu.test.tsx`
  - Covers open/close, label/code filtering, and tab selection.
- Modify `frontend/src/live/LiveTabBar.tsx`
  - Remove `TABS_SOFT_CAP` import and `atCap` prop.
  - Render a horizontally scrollable strip.
  - Keep `+`, overflow menu, and `N open` fixed on the right.
  - Scroll the active tab into view when `activeTabId` changes.
- Modify `frontend/src/live/LiveTabBar.test.tsx`
  - Remove `atCap` setup and disabled button test.
  - Assert `N open`, always-enabled new-tab button, and overflow menu integration.
- Modify `frontend/src/live/LivePage.tsx`
  - Remove `TABS_SOFT_CAP` import and `atCap={...}`.
- Modify `frontend/src/live/useLiveKeyboard.ts`
  - Update the stale comment that references the old 8-tab cap.

---

### Task 1: Remove Store Cap

**Files:**
- Modify: `frontend/src/state/liveTabs.ts:7,216-218`
- Modify: `frontend/src/state/liveTabs.test.ts:1-130`

- [ ] **Step 1: Write the failing store test**

In `frontend/src/state/liveTabs.test.ts`, replace the test named `addBlankTab is a no-op at the soft cap` with:

```ts
  it('addBlankTab allows more than the old 8-tab cap', () => {
    for (let i = 0; i < 9; i++) openTab(`C${String(i).padStart(5, '0')}`);
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(9);
    expect(tabs.map((t) => t.code)).toEqual([
      'C00000', 'C00001', 'C00002', 'C00003', 'C00004',
      'C00005', 'C00006', 'C00007', 'C00008',
    ]);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('C00008');
  });
```

Remove `TABS_SOFT_CAP` from the import at the top:

```ts
import {
  useLiveTabsStore, loadTabs, toTabsSnapshot, initLiveTabsSync,
  registerViewportCapture,
} from './liveTabs';
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd frontend && npx vitest run src/state/liveTabs.test.ts -t "allows more than the old 8-tab cap"
```

Expected: FAIL because `TABS_SOFT_CAP = 8` still makes the 9th `addBlankTab()` a no-op.

- [ ] **Step 3: Remove the cap implementation**

In `frontend/src/state/liveTabs.ts`, delete:

```ts
export const TABS_SOFT_CAP = 8;
```

In `addBlankTab`, delete the cap guard:

```ts
    if (get().tabs.length >= TABS_SOFT_CAP) return;
```

Leave the rest of `addBlankTab()` unchanged:

```ts
  addBlankTab: () => {
    // 나가는 탭의 viewport를 새 탭 추가 전에 스냅샷(ADR-0069 A안), 그 후 tabs를 FRESH로 읽어
    // 스냅샷 쓰기가 stale spread에 덮이지 않게 한다.
    snapshotActiveViewport();
    const tab: LiveTab = {
      id: nanoid(8),
      code: '',
      label: '새 탭',
      timeframe: useLivePageStore.getState().candleTimeframe,
      historicalFromDate: null,
      viewport: null,
    };
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
    applyTabToPage(tab); // code='' → activeCode 비움 → 빈 상태(종목 검색 안내)
  },
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd frontend && npx vitest run src/state/liveTabs.test.ts -t "allows more than the old 8-tab cap"
```

Expected: PASS.

- [ ] **Step 5: Run all live tabs store tests**

Run:

```bash
cd frontend && npx vitest run src/state/liveTabs.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/src/state/liveTabs.ts frontend/src/state/liveTabs.test.ts
git commit -m "feat(live): remove tab creation cap"
```

---

### Task 2: Add Overflow Menu

**Files:**
- Create: `frontend/src/live/LiveTabOverflowMenu.tsx`
- Create: `frontend/src/live/LiveTabOverflowMenu.test.tsx`

- [ ] **Step 1: Write the failing overflow menu tests**

Create `frontend/src/live/LiveTabOverflowMenu.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { LiveTabOverflowMenu } from './LiveTabOverflowMenu';
import type { LiveTab } from '../state/liveTabs';

const tabs: LiveTab[] = [
  { id: 'a', code: '005930', label: '삼성전자', timeframe: '1m', historicalFromDate: null, viewport: null },
  { id: 'b', code: '000660', label: 'SK하이닉스', timeframe: '1m', historicalFromDate: null, viewport: null },
  { id: 'c', code: '035420', label: 'NAVER', timeframe: 'D', historicalFromDate: null, viewport: null },
];

function setup() {
  const onFocus = vi.fn();
  render(<LiveTabOverflowMenu tabs={tabs} activeTabId="b" onFocus={onFocus} />);
  return { onFocus };
}

it('opens a list of all tabs', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  expect(screen.getByText('NAVER')).toBeInTheDocument();
});

it('filters by label and code', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: '005930' } });
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.queryByText('SK하이닉스')).toBeNull();
  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: 'nav' } });
  expect(screen.getByText('NAVER')).toBeInTheDocument();
  expect(screen.queryByText('삼성전자')).toBeNull();
});

it('selects a tab and closes the menu', () => {
  const { onFocus } = setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.click(screen.getByText('NAVER'));
  expect(onFocus).toHaveBeenCalledWith('c');
  expect(screen.queryByRole('menu')).toBeNull();
});

it('marks the active tab', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  expect(screen.getByLabelText('활성 탭: SK하이닉스')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd frontend && npx vitest run src/live/LiveTabOverflowMenu.test.tsx
```

Expected: FAIL because `LiveTabOverflowMenu.tsx` does not exist.

- [ ] **Step 3: Implement the overflow menu**

Create `frontend/src/live/LiveTabOverflowMenu.tsx`:

```tsx
import { useMemo, useRef, useState } from 'react';
import type { LiveTab } from '../state/liveTabs';
import { useDismissablePopover } from '../util/useDismissablePopover';

interface Props {
  tabs: LiveTab[];
  activeTabId: string | null;
  onFocus: (id: string) => void;
}

export function LiveTabOverflowMenu({ tabs, activeTabId, onFocus }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useDismissablePopover(open, rootRef, () => setOpen(false));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabs;
    return tabs.filter((t) =>
      t.label.toLowerCase().includes(q) || t.code.toLowerCase().includes(q)
    );
  }, [query, tabs]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="열린 탭 목록"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-7 h-7 flex items-center justify-center rounded-md"
        style={{ color: 'var(--fg-dim)', border: '1px solid var(--border)' }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-[14px] h-[14px]">
          <line x1="5" y1="7" x2="19" y2="7" />
          <line x1="5" y1="12" x2="19" y2="12" />
          <line x1="5" y1="17" x2="19" y2="17" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-50 w-72 rounded-md p-2 shadow-lg"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="탭 검색"
            data-prevent-shortcuts
            className="w-full h-8 px-2 rounded text-sm outline-none"
            style={{ background: 'var(--bg-input)', color: 'var(--fg)', border: '1px solid var(--border)' }}
          />
          <div className="mt-2 max-h-80 overflow-y-auto">
            {filtered.map((t) => {
              const active = t.id === activeTabId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  aria-label={active ? `활성 탭: ${t.label}` : undefined}
                  onClick={() => {
                    onFocus(t.id);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                  style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)', background: active ? 'var(--bg-input)' : 'transparent' }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: active ? 'var(--success)' : 'transparent', border: active ? 'none' : '1px solid var(--fg-dimmer)' }} />
                  <span className="min-w-0 flex-1 truncate" title={t.label}>{t.label}</span>
                  {t.code && t.code !== t.label && (
                    <span className="font-mono text-xs shrink-0" style={{ color: 'var(--fg-dimmer)' }}>{t.code}</span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-sm" style={{ color: 'var(--fg-dimmer)' }}>일치하는 탭 없음</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the overflow menu tests**

Run:

```bash
cd frontend && npx vitest run src/live/LiveTabOverflowMenu.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add frontend/src/live/LiveTabOverflowMenu.tsx frontend/src/live/LiveTabOverflowMenu.test.tsx
git commit -m "feat(live): add tab overflow menu"
```

---

### Task 3: Wire Unlimited Tabs Into the Tab Bar

**Files:**
- Modify: `frontend/src/live/LiveTabBar.tsx`
- Modify: `frontend/src/live/LiveTabBar.test.tsx`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/useLiveKeyboard.ts`

- [ ] **Step 1: Write the failing tab bar tests**

In `frontend/src/live/LiveTabBar.test.tsx`, update `setup` so the props no longer include `atCap`:

```ts
  const props: ComponentProps<typeof LiveTabBar> = {
    tabs, activeTabId: 'a', activeLoading: false,
    onFocus: vi.fn(), onClose: vi.fn(), onReorder: vi.fn(), onNewTab: vi.fn(),
    ...over,
  };
```

Replace the disabled cap test with:

```ts
it('shows an unlimited tab count and keeps the new-tab button enabled', () => {
  setup();
  expect(screen.getByText('2 open')).toBeInTheDocument();
  expect(screen.getByLabelText('새 탭')).toBeEnabled();
});
```

Add this test:

```ts
it('selects a tab through the overflow menu', () => {
  const p = setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.click(screen.getByText('SK하이닉스'));
  expect(p.onFocus).toHaveBeenCalledWith('b');
});
```

Add this scroll behavior test:

```ts
it('scrolls the active tab into view when activeTabId changes', () => {
  const scrollIntoView = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  try {
    const { rerender } = render(
      <LiveTabBar
        tabs={tabs}
        activeTabId="a"
        activeLoading={false}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
      />
    );
    rerender(
      <LiveTabBar
        tabs={tabs}
        activeTabId="b"
        activeLoading={false}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
      />
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});
```

- [ ] **Step 2: Run the focused tab bar tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/live/LiveTabBar.test.tsx
```

Expected: FAIL because `LiveTabBar` still requires `atCap`, shows `N/8 open`, disables the new-tab button at cap, and does not render the overflow menu.

- [ ] **Step 3: Update `LiveTabBar` props and layout**

In `frontend/src/live/LiveTabBar.tsx`, replace the imports with:

```tsx
import { useEffect, useRef, type CSSProperties } from 'react';
import type { LiveTab } from '../state/liveTabs';
import { LiveTabOverflowMenu } from './LiveTabOverflowMenu';
```

Update `Props`:

```tsx
interface Props {
  tabs: LiveTab[];
  activeTabId: string | null;
  /** 활성 탭의 차트 데이터 로딩 중 여부 (상태점). */
  activeLoading: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onNewTab: () => void;
}
```

At the top of `LiveTabBar`, add refs and active-tab scrolling:

```tsx
export function LiveTabBar({ tabs, activeTabId, activeLoading, onFocus, onClose, onReorder, onNewTab }: Props) {
  const activeElRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeElRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);
```

Replace the outer return with this layout, keeping the existing tab rendering body inside the scroll strip:

```tsx
  return (
    <div role="tablist" className="flex items-end h-full px-2 font-ui" style={{ background: 'var(--bg-subtle)' }}>
      <div className="min-w-0 flex-1 h-full overflow-x-auto overflow-y-hidden">
        <div className="flex items-end gap-0.5 h-full w-max pr-2">
          {tabs.map((t, idx) => {
            const active = t.id === activeTabId;
            return (
              <div
                ref={active ? activeElRef : undefined}
                key={t.id}
                data-tab-id={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => onFocus(t.id)}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.id); } }}
                draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/tab-index', String(idx)); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { if (e.dataTransfer.types.includes('text/tab-index')) e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const raw = e.dataTransfer.getData('text/tab-index');
                  if (raw === '') return;
                  const from = Number(raw);
                  if (Number.isInteger(from) && from !== idx) onReorder(from, idx);
                }}
                className={`relative flex items-center gap-1.5 h-8 px-2.5 rounded-t-md cursor-pointer select-none group ${
                  active ? 'bg-bg-card' : 'bg-bg-input hover:bg-bg-input-hover'
                }`}
                style={{
                  border: active ? 'none' : '1px solid var(--border)',
                  borderBottom: 'none',
                }}
              >
                {active && (
                  <span className="absolute left-0 right-0 top-0 h-[2px]" style={{ background: 'var(--accent)' }} />
                )}
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={statusDotStyle(active, activeLoading)} />
                <span className="text-sm shrink-0 max-w-28 truncate" title={t.label} style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)' }}>{t.label}</span>
                <button
                  type="button"
                  draggable={false}
                  aria-label={`${t.code} 닫기`}
                  onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                  className="ml-1 w-[18px] h-[18px] flex items-center justify-center rounded opacity-0 group-hover:opacity-100"
                  style={{ color: 'var(--fg-dimmer)' }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-[11px] h-[11px]">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1 self-center pl-2">
        <button
          type="button"
          aria-label="새 탭"
          onClick={onNewTab}
          className="w-7 h-7 flex items-center justify-center rounded-md"
          style={{ color: 'var(--fg-dim)', border: '1px solid var(--border)' }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="w-[13px] h-[13px]">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <LiveTabOverflowMenu tabs={tabs} activeTabId={activeTabId} onFocus={onFocus} />
        <span className="text-xs font-mono whitespace-nowrap" style={{ color: 'var(--fg-dimmer)' }}>
          {tabs.length} open
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update `LivePage` wiring**

In `frontend/src/live/LivePage.tsx`, remove `TABS_SOFT_CAP` from the import:

```tsx
import { useLiveTabsStore } from '../state/liveTabs';
```

Remove the `atCap` prop from `LiveTabBar`:

```tsx
      <LiveTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        activeLoading={isPastCandlesLoading}
        onFocus={focusTab}
        onClose={closeTab}
        onReorder={reorderTabs}
        onNewTab={() => { addBlankTab(); focusLiveSearch(); }}
      />
```

- [ ] **Step 5: Update stale keyboard comment**

In `frontend/src/live/useLiveKeyboard.ts`, replace:

```ts
          // 1~9 → 0-based 탭 인덱스. '9'→index 8은 의도적으로 도달 가능하나
          // 소프트캡 8(TABS_SOFT_CAP)에선 실재하는 탭이 없어 LivePage가 무시한다.
          // 정규식은 자기설명적이고 다중문자 key(예: 'F1')의 NaN 경로를 원천 차단.
```

with:

```ts
          // 1~9 → 0-based 탭 인덱스. 무제한 탭이어도 숫자 단축키는
          // 첫 9개 탭만 직접 선택한다. 그 이후 탭은 탭 목록/검색을 사용한다.
          // 정규식은 자기설명적이고 다중문자 key(예: 'F1')의 NaN 경로를 원천 차단.
```

- [ ] **Step 6: Run tab bar tests**

Run:

```bash
cd frontend && npx vitest run src/live/LiveTabBar.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Run live page tests**

Run:

```bash
cd frontend && npx vitest run src/live/LivePage.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Run TypeScript build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS with Vite build output.

- [ ] **Step 9: Commit**

Run:

```bash
git add frontend/src/live/LiveTabBar.tsx frontend/src/live/LiveTabBar.test.tsx frontend/src/live/LivePage.tsx frontend/src/live/useLiveKeyboard.ts
git commit -m "feat(live): support unlimited tab bar navigation"
```

---

### Task 4: Browser QA

**Files:**
- No planned source changes unless QA finds a defect.

- [ ] **Step 1: Start the dev server**

Run:

```bash
cd frontend && npm run dev -- --host 127.0.0.1
```

Expected: Vite prints a local URL, usually `http://127.0.0.1:5173/`.

- [ ] **Step 2: Open `/live` and create many tabs**

Use the browser at:

```text
http://127.0.0.1:5173/live
```

Create at least 10 tabs with the `+` button.

Expected:

- The page still has one tab row.
- The chart/workarea row does not move downward as more tabs are added.
- The `+` button remains visible.
- The count reads `10 open` or higher.

- [ ] **Step 3: Verify overflow search navigation**

Open the tab list button, search for an existing tab label/code, and click the result.

Expected:

- The menu closes.
- The selected tab becomes active.
- The selected tab scrolls into view in the strip.

- [ ] **Step 4: Run regression tests**

Run:

```bash
cd frontend && npx vitest run src/state/liveTabs.test.ts src/live/LiveTabBar.test.tsx src/live/LiveTabOverflowMenu.test.tsx src/live/LivePage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit QA fixes if any**

If QA required source changes, commit only those changes:

```bash
git add frontend/src/live frontend/src/state
git commit -m "fix(live): polish unlimited tab navigation"
```

If QA required no changes, do not create an empty commit.
