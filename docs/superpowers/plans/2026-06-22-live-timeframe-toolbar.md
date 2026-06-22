# Live Timeframe Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/live` raw timeframe button strip with a compact minute selector plus `일/주/월` controls, matching the approved UX and preserving existing chart/timeframe state contracts.

**Architecture:** Keep the change inside `LiveToolbar`: local UI state owns menu open/close and remembered minute timeframe, while `useLivePageStore().setCandleTimeframe` remains the only active-timeframe writer. Reuse existing `MINUTE_TIMEFRAMES`, `CALENDAR_TIMEFRAMES`, `isMinuteTimeframe`, `useDismissablePopover`, and `useClampedFixedPosition` instead of adding persistence or new global state.

**Tech Stack:** React 18, Zustand, TypeScript, Vitest, React Testing Library, existing live toolbar CSS tokens from `DESIGN.md`.

## Global Constraints

- Do not add `Y`/yearly timeframe support.
- Do not add a persisted `lastMinuteTf` field.
- Do not change chart fetch, aggregation, viewport, or live tab synchronization behavior.
- Use `LiveTimeframe` as the domain term for the full selector value.
- Call the first toolbar control the minute selector in code/test names.
- Render minute options from `MINUTE_TIMEFRAMES` and calendar options from `CALENDAR_TIMEFRAMES`.
- Use `setCandleTimeframe` for every actual timeframe change so existing live tab mirror behavior stays intact.
- Escape and outside mousedown must close the minute menu without changing timeframe.
- Follow `DESIGN.md`: dark toolbar/input surfaces, `--accent`/`--tint-selection` only for active UI state, compact monospace controls.

---

## File Structure

- Modify `frontend/src/live/LiveToolbar.test.tsx`
  - Add behavior tests for the new minute selector state machine.
  - Reset `useLivePageStore` before each test so tests are order-independent.
- Modify `frontend/src/live/LiveToolbar.tsx`
  - Replace the `LIVE_TIMEFRAMES.map` button strip with one minute selector and three calendar buttons.
  - Add local remembered-minute and popover open state.
  - Reuse existing popover dismissal and clamped-position utilities.
- No new source file is required unless the component becomes hard to scan during implementation.

## Task 1: Lock The Toolbar UX With Failing Tests

**Files:**
- Modify: `frontend/src/live/LiveToolbar.test.tsx`
- Test: `frontend/src/live/LiveToolbar.test.tsx`

**Interfaces:**
- Consumes: `useLivePageStore.setState`, `useLivePageStore.getState().setCandleTimeframe`
- Produces: Test expectations that Task 2 must satisfy:
  - minute selector button name changes by state
  - menu role `menu`
  - minute option names `1분`, `3분`, `5분`, `10분`, `15분`, `30분`
  - calendar button names `일`, `주`, `월`

- [ ] **Step 1: Add store reset and imports**

Replace the top of `frontend/src/live/LiveToolbar.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LiveToolbar } from './LiveToolbar';
import { useLivePageStore } from '../state/livePage';

function renderToolbar() {
  return render(<LiveToolbar onOpenIndicators={() => {}} onOpenSettings={() => {}} />);
}

describe('LiveToolbar', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
  });
```

Keep the existing tests below this setup. Remove the old duplicate `describe('LiveToolbar', () => {` line if it remains after editing.

- [ ] **Step 2: Add render shape test**

Add this test inside the `describe` block:

```tsx
  it('renders compact minute selector plus day/week/month controls and no year control', () => {
    renderToolbar();

    expect(screen.getByRole('button', { name: '분봉 선택 열기: 1분' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '일' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '주' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '월' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '년' })).toBeNull();
    expect(screen.queryByText('1m')).toBeNull();
    expect(screen.queryByText('D')).toBeNull();
  });
```

- [ ] **Step 3: Add minute-menu open and select test**

Add this test:

```tsx
  it('opens minute list on minute timeframe and selecting a minute switches timeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    const menu = screen.getByRole('menu', { name: '분봉 목록' });
    expect(within(menu).getByRole('menuitemradio', { name: '3분' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '3분' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('3m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
    expect(screen.getByRole('button', { name: '분봉 선택 열기: 3분' })).toHaveAttribute('aria-expanded', 'false');
  });
```

- [ ] **Step 4: Add calendar-to-minute direct switch test**

Add this test:

```tsx
  it('from calendar timeframe, minute selector switches directly to remembered minute without opening menu', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.click(within(screen.getByRole('menu', { name: '분봉 목록' })).getByRole('menuitemradio', { name: '5분' }));
    fireEvent.click(screen.getByRole('button', { name: '일' }));
    expect(useLivePageStore.getState().candleTimeframe).toBe('D');

    fireEvent.click(screen.getByRole('button', { name: '5분봉으로 전환' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });
```

- [ ] **Step 5: Add calendar close-menu test**

Add this test:

```tsx
  it('calendar buttons switch timeframe and close an open minute menu', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    expect(screen.getByRole('menu', { name: '분봉 목록' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '주' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('W');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });
```

- [ ] **Step 6: Add Escape and outside dismissal tests**

Add these tests:

```tsx
  it('Escape closes the minute list without changing timeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useLivePageStore.getState().candleTimeframe).toBe('1m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('outside mousedown closes the minute list without changing timeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.mouseDown(document.body);

    expect(useLivePageStore.getState().candleTimeframe).toBe('1m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });
```

- [ ] **Step 7: Run tests and verify they fail for the intended reason**

Run:

```bash
cd frontend && npx vitest run src/live/LiveToolbar.test.tsx
```

Expected: failures because `LiveToolbar` still renders raw `1m`, `D`, `W`, `M` buttons and has no `분봉 목록` menu.

- [ ] **Step 8: Commit failing tests**

Only commit if the failures are the expected red state from Step 7.

```bash
git add frontend/src/live/LiveToolbar.test.tsx
git commit -m "test: specify live timeframe toolbar ux"
```

## Task 2: Implement The Minute Selector State Machine

**Files:**
- Modify: `frontend/src/live/LiveToolbar.tsx`
- Test: `frontend/src/live/LiveToolbar.test.tsx`

**Interfaces:**
- Consumes:
  - `MINUTE_TIMEFRAMES`, `CALENDAR_TIMEFRAMES`, `isMinuteTimeframe`, `type MinuteTimeframe`, `type CalendarTimeframe`, `useLivePageStore`
  - `useDismissablePopover(isOpen, anchorRef, onDismiss)`
  - `useClampedFixedPosition(left, top)`
- Produces:
  - `LiveToolbar` renders `[N분 v] [일] [주] [월]`
  - active timeframe still changes only through `setCandleTimeframe(tf)`
  - menu closes on Escape/outside click/calendar click/menu selection

- [ ] **Step 1: Replace imports**

In `frontend/src/live/LiveToolbar.tsx`, replace the first imports with:

```tsx
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CALENDAR_TIMEFRAMES,
  MINUTE_TIMEFRAMES,
  isMinuteTimeframe,
  type CalendarTimeframe,
  type MinuteTimeframe,
  useLivePageStore,
} from '../state/livePage';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import LiveDrawingMenu from './LiveDrawingMenu';
```

- [ ] **Step 2: Add label helpers above `LiveToolbar`**

Add these helpers after the `Props` type:

```tsx
const CALENDAR_LABELS: Record<CalendarTimeframe, string> = {
  D: '일',
  W: '주',
  M: '월',
};

function minuteLabel(tf: MinuteTimeframe): string {
  return `${tf.slice(0, -1)}분`;
}
```

- [ ] **Step 3: Add local toolbar state**

Inside `LiveToolbar`, replace the current `tf`/`setTf` setup with:

```tsx
  const tf = useLivePageStore((s) => s.candleTimeframe);
  const setTf = useLivePageStore((s) => s.setCandleTimeframe);
  const [minuteMenuOpen, setMinuteMenuOpen] = useState(false);
  const [rememberedMinute, setRememberedMinute] = useState<MinuteTimeframe>(
    isMinuteTimeframe(tf) ? tf : '1m',
  );
  const minuteWrapRef = useRef<HTMLDivElement>(null);
  const minuteButtonRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const closeMinuteMenu = useCallback(() => setMinuteMenuOpen(false), []);
  useDismissablePopover(minuteMenuOpen, minuteWrapRef, closeMinuteMenu);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  useEffect(() => {
    if (isMinuteTimeframe(tf)) setRememberedMinute(tf);
  }, [tf]);

  useEffect(() => {
    if (!minuteMenuOpen || !minuteButtonRef.current) return;
    setAnchorRect(minuteButtonRef.current.getBoundingClientRect());
  }, [minuteMenuOpen, rememberedMinute]);
```

- [ ] **Step 4: Add click handlers**

Still inside `LiveToolbar`, before the `return`, add:

```tsx
  const onMinuteSelectorClick = () => {
    if (isMinuteTimeframe(tf)) {
      setAnchorRect(minuteButtonRef.current?.getBoundingClientRect() ?? null);
      setMinuteMenuOpen((open) => !open);
      return;
    }
    setMinuteMenuOpen(false);
    setTf(rememberedMinute);
  };

  const pickMinute = (next: MinuteTimeframe) => {
    setRememberedMinute(next);
    setMinuteMenuOpen(false);
    setTf(next);
  };

  const pickCalendar = (next: CalendarTimeframe) => {
    setMinuteMenuOpen(false);
    setTf(next);
  };

  const minuteButtonLabel = isMinuteTimeframe(tf)
    ? `분봉 선택 열기: ${minuteLabel(rememberedMinute)}`
    : `${minuteLabel(rememberedMinute)}봉으로 전환`;
```

- [ ] **Step 5: Replace the timeframe button group JSX**

Replace the existing block:

```tsx
      <div className="flex gap-1" role="group" aria-label="Timeframe">
        {LIVE_TIMEFRAMES.map((t) => (
          ...
        ))}
      </div>
```

with:

```tsx
      <div className="flex gap-1" role="group" aria-label="LiveTimeframe">
        <div ref={minuteWrapRef} className="relative">
          <button
            ref={minuteButtonRef}
            type="button"
            onClick={onMinuteSelectorClick}
            aria-label={minuteButtonLabel}
            aria-haspopup={isMinuteTimeframe(tf) ? 'menu' : undefined}
            aria-expanded={isMinuteTimeframe(tf) ? minuteMenuOpen : undefined}
            className="inline-flex items-center gap-1 rounded font-mono hover:opacity-90 transition-opacity"
            style={{
              padding: '4px 10px',
              background: isMinuteTimeframe(tf) ? 'var(--tint-selection)' : 'var(--bg-input)',
              color: isMinuteTimeframe(tf) ? 'var(--accent)' : 'var(--fg-dim)',
              fontSize: 'var(--text-xs)',
              border: '1px solid',
              borderColor: isMinuteTimeframe(tf) ? 'var(--accent)' : 'var(--border)',
            }}
          >
            <span>{minuteLabel(rememberedMinute)}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          {minuteMenuOpen && anchorRect && (
            <div
              ref={menuPositionRef}
              role="menu"
              aria-label="분봉 목록"
              className="w-24 bg-bg-card border border-border rounded shadow-lg z-30 py-1"
              style={{ position: 'fixed', left, top }}
            >
              {MINUTE_TIMEFRAMES.map((minute) => {
                const selected = tf === minute;
                return (
                  <button
                    key={minute}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => pickMinute(minute)}
                    className={
                      (selected
                        ? 'bg-bg-input-hover text-accent'
                        : 'text-fg-dim hover:text-fg hover:bg-bg-input-hover') +
                      ' w-full text-left px-3 py-1.5 text-sm font-mono'
                    }
                  >
                    {minuteLabel(minute)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {CALENDAR_TIMEFRAMES.map((calendar) => {
          const active = tf === calendar;
          return (
            <button
              key={calendar}
              type="button"
              onClick={() => pickCalendar(calendar)}
              aria-pressed={active}
              className="px-2 py-1 rounded font-mono hover:opacity-90 transition-opacity"
              style={{
                background: active ? 'var(--tint-selection)' : 'var(--bg-input)',
                color: active ? 'var(--accent)' : 'var(--fg-dim)',
                fontSize: 'var(--text-xs)',
                border: '1px solid',
                borderColor: active ? 'var(--accent)' : 'var(--border)',
              }}
            >
              {CALENDAR_LABELS[calendar]}
            </button>
          );
        })}
      </div>
```

- [ ] **Step 6: Run the toolbar tests**

Run:

```bash
cd frontend && npx vitest run src/live/LiveToolbar.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Run related state mirror tests**

Run:

```bash
cd frontend && npx vitest run src/state/liveTabs.test.ts src/state/livePage.test.ts
```

Expected: PASS. This checks that toolbar-driven `setCandleTimeframe` still flows through existing page/tab synchronization.

- [ ] **Step 8: Commit implementation**

```bash
git add frontend/src/live/LiveToolbar.tsx frontend/src/live/LiveToolbar.test.tsx
git commit -m "feat: compact live timeframe toolbar"
```

## Task 3: Verify Build And Visual Behavior

**Files:**
- Modify: none expected
- Test: local browser/dev server only if available

**Interfaces:**
- Consumes: Task 2 implementation
- Produces: Verification evidence that the toolbar renders and basic interactions work in `/live`

- [ ] **Step 1: Run the frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: TypeScript and Vite build complete without errors.

- [ ] **Step 2: Start dev server if none is already running**

Check whether Vite is already listening:

```bash
curl -I -s http://localhost:5173 >/dev/null && echo "vite up" || echo "vite down"
```

If it prints `vite down`, start:

```bash
cd frontend && npm run dev
```

Expected: Vite serves `http://localhost:5173`.

- [ ] **Step 3: Browser smoke check**

Using the repo-preferred browser helper from `CLAUDE.md`, run:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B text
```

Expected: The live page text includes the compact controls `1분`, `일`, `주`, `월` and does not include a `년` timeframe control.

- [ ] **Step 4: Manual interaction smoke check**

In the browser:

1. Open `/live`.
2. Click the minute selector while on a minute timeframe.
3. Confirm the dropdown lists `1분`, `3분`, `5분`, `10분`, `15분`, `30분`.
4. Pick `3분`.
5. Click `일`.
6. Click the `3분` minute selector.

Expected: Step 2 opens the list. Step 4 switches to `3분` and closes the list. Step 5 switches to 일봉. Step 6 switches directly back to `3분` without opening the list.

- [ ] **Step 5: Commit verification-only fixes if needed**

If visual verification exposes a small polish bug, fix only that bug and rerun:

```bash
cd frontend && npx vitest run src/live/LiveToolbar.test.tsx
cd frontend && npm run build
```

Then commit:

```bash
git add frontend/src/live/LiveToolbar.tsx frontend/src/live/LiveToolbar.test.tsx
git commit -m "fix: polish live timeframe toolbar"
```

Skip this step if no fixes are needed.

## Self-Review

- Spec coverage:
  - Compact `[N분] [일] [주] [월]` toolbar: Task 2.
  - No `년/Y`: Task 1 render test and global constraints.
  - Calendar-to-minute direct switch: Task 1 and Task 2.
  - Minute-on-minute opens list: Task 1 and Task 2.
  - Local remembered minute, no persistence: Task 2 local state only.
  - Existing `setCandleTimeframe` path: Task 2 handlers and Task 2 state mirror tests.
  - Escape/outside dismissal: Task 1 tests and Task 2 `useDismissablePopover`.
  - Existing constants/utilities reuse: Task 2 imports.
  - Visual verification: Task 3.
- Placeholder scan: no unfinished markers or unspecified test directives.
- Type consistency:
  - `MinuteTimeframe`, `CalendarTimeframe`, `LiveTimeframe` come from `frontend/src/state/livePage.ts`.
  - `minuteLabel(tf: MinuteTimeframe): string` is defined before use.
  - `pickMinute(next: MinuteTimeframe)` and `pickCalendar(next: CalendarTimeframe)` match the constants they map over.
