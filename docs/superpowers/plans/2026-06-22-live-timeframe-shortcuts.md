# Live Timeframe Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/live` `Shift+1..4` shortcuts for minute, daily, weekly, and monthly chart timeframes.

**Architecture:** Store the remembered minute timeframe in `useLivePageStore` so the toolbar and keyboard path share one source of truth. Keep shortcut matching inside `useLiveKeyboard`, and let `LivePage` wire the shortcut callback to store actions the same way it already wires tab callbacks.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, React Testing Library, Vite frontend in `frontend/`.

## Global Constraints

- `Shift+1` switches to the currently remembered minute timeframe.
- `Shift+2` switches to daily (`D`, 일봉).
- `Shift+3` switches to weekly (`W`, 주봉).
- `Shift+4` switches to monthly (`M`, 월봉).
- Plain `1` through `9` continue to select live tabs.
- Ignore shortcuts inside inputs, selects, textareas, contenteditable elements, and `data-prevent-shortcuts`.
- Ignore events with `Ctrl`, `Meta`, or `Alt`, even if `Shift` is also held.
- Do not add yearly candles, backend API changes, visible shortcut labels, per-tab remembered-minute state, or chart fetch/aggregation changes.

---

## File Structure

- Modify `frontend/src/state/livePage.ts`: add `lastMinuteTimeframe`, validate hydration, persist it, and update it only when the active timeframe is a minute timeframe.
- Modify `frontend/src/state/livePage.test.ts`: cover store defaults, mutation, persistence, hydration fallback, and `projectActiveView` behavior.
- Modify `frontend/src/live/LiveToolbar.tsx`: replace private remembered-minute state with `useLivePageStore.lastMinuteTimeframe`.
- Modify `frontend/src/live/LiveToolbar.test.tsx`: assert toolbar clicks use the shared store field.
- Modify `frontend/src/live/useLiveKeyboard.ts`: add a timeframe shortcut callback and make Shift handling explicit.
- Modify `frontend/src/live/useLiveKeyboard.test.tsx`: cover `Shift+1..4`, tab shortcut non-regression, input suppression, and modifier suppression.
- Modify `frontend/src/live/LivePage.tsx`: wire timeframe shortcut callbacks to `useLivePageStore`.

### Task 1: Shared Remembered Minute State

**Files:**
- Modify: `frontend/src/state/livePage.ts`
- Test: `frontend/src/state/livePage.test.ts`

**Interfaces:**
- Produces: `lastMinuteTimeframe: MinuteTimeframe` on `useLivePageStore`.
- Produces: `setCandleTimeframe(tf: LiveTimeframe): void` updates `lastMinuteTimeframe` when `tf` is a minute timeframe.
- Produces: `projectActiveView(view: ActiveViewProjection): void` updates `lastMinuteTimeframe` only when `view.timeframe` is a minute timeframe.
- Consumes: existing `isMinuteTimeframe(tf: LiveTimeframe): tf is MinuteTimeframe`.

- [ ] **Step 1: Write failing store tests**

Add these tests inside the first `describe('livePage store', ...)` block in `frontend/src/state/livePage.test.ts`:

```ts
  it('tracks the last selected minute timeframe', () => {
    useLivePageStore.getState().setCandleTimeframe('10m');
    expect(useLivePageStore.getState().candleTimeframe).toBe('10m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');

    useLivePageStore.getState().setCandleTimeframe('D');
    expect(useLivePageStore.getState().candleTimeframe).toBe('D');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');
  });

  it('persists and hydrates lastMinuteTimeframe', () => {
    useLivePageStore.getState().setCandleTimeframe('15m');
    useLivePageStore.getState().setCandleTimeframe('W');

    const raw = JSON.parse(localStorage.getItem('live.page.v1') ?? '{}');
    expect(raw.candleTimeframe).toBe('W');
    expect(raw.lastMinuteTimeframe).toBe('15m');

    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      historicalFromDate: null,
      lastMinuteTimeframe: '1m',
    });
    useLivePageStore.getState().hydrateFromStorage();
    expect(useLivePageStore.getState().candleTimeframe).toBe('W');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('15m');
  });

  it('derives missing lastMinuteTimeframe from stored minute candleTimeframe', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ activeCode: '000660', candleTimeframe: '5m', historicalFromDate: null }),
    );

    useLivePageStore.getState().hydrateFromStorage();

    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('5m');
  });

  it('falls back to 1m when stored lastMinuteTimeframe is invalid or missing on calendar timeframe', () => {
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({
        activeCode: '000660',
        candleTimeframe: 'D',
        historicalFromDate: null,
        lastMinuteTimeframe: 'bogus',
      }),
    );

    useLivePageStore.getState().hydrateFromStorage();

    expect(useLivePageStore.getState().candleTimeframe).toBe('D');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('1m');
  });

  it('projectActiveView updates lastMinuteTimeframe only for minute projections', () => {
    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: '10m',
      historicalFromDate: null,
    });
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');

    useLivePageStore.getState().projectActiveView({
      code: '005930',
      timeframe: 'M',
      historicalFromDate: null,
    });
    expect(useLivePageStore.getState().candleTimeframe).toBe('M');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');
  });
```

- [ ] **Step 2: Run store tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/state/livePage.test.ts
```

Expected: FAIL because `lastMinuteTimeframe` does not exist on the store.

- [ ] **Step 3: Implement shared state**

In `frontend/src/state/livePage.ts`, extend the persisted type:

```ts
type Persisted = {
  activeCode: string | null;
  candleTimeframe: LiveTimeframe;
  lastMinuteTimeframe: MinuteTimeframe;
  /** Earliest stock-date the user has scrolled into (YYYYMMDD). null = today
   * only (no /api/range call needed yet). Resets when activeCode or timeframe
   * changes. */
  historicalFromDate: string | null;
};
```

Add the default:

```ts
const DEFAULTS: Persisted = {
  activeCode: null,
  candleTimeframe: '1m',
  lastMinuteTimeframe: '1m',
  historicalFromDate: null,
};
```

Replace `readStorage` with a validated parser:

```ts
function isLiveTimeframe(v: unknown): v is LiveTimeframe {
  return typeof v === 'string' && (LIVE_TIMEFRAMES as readonly string[]).includes(v);
}

function isMinuteFrameValue(v: unknown): v is MinuteTimeframe {
  return typeof v === 'string' && (MINUTE_TIMEFRAMES as readonly string[]).includes(v);
}

function readStorage(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed) return {};
    const candleTimeframe = isLiveTimeframe(parsed.candleTimeframe) ? parsed.candleTimeframe : undefined;
    const derivedMinute = isMinuteFrameValue(parsed.lastMinuteTimeframe)
      ? parsed.lastMinuteTimeframe
      : isMinuteFrameValue(candleTimeframe)
        ? candleTimeframe
        : undefined;
    return {
      activeCode: typeof parsed.activeCode === 'string' ? parsed.activeCode : parsed.activeCode === null ? null : undefined,
      candleTimeframe,
      lastMinuteTimeframe: derivedMinute,
      historicalFromDate: typeof parsed.historicalFromDate === 'string' ? parsed.historicalFromDate : parsed.historicalFromDate === null ? null : undefined,
    };
  } catch {
    return {};
  }
}
```

Update the `projectActiveView`, `setCandleTimeframe`, and `hydrateFromStorage` implementations:

```ts
  projectActiveView: ({ code, timeframe, historicalFromDate }) => {
    // One atomic write — no reset-then-restore. tf is clamped like setCandleTimeframe
    // (belt-and-suspenders; tabs already carry validated timeframes).
    const tf = LIVE_TIMEFRAMES.includes(timeframe) ? timeframe : get().candleTimeframe;
    const next = {
      activeCode: code,
      candleTimeframe: tf,
      lastMinuteTimeframe: isMinuteTimeframe(tf) ? tf : get().lastMinuteTimeframe,
      historicalFromDate,
    };
    set(next);
    persist({ ...get(), ...next });
  },

  setCandleTimeframe: (tf) => {
    if (!LIVE_TIMEFRAMES.includes(tf)) return;
    const next = {
      candleTimeframe: tf,
      lastMinuteTimeframe: isMinuteTimeframe(tf) ? tf : get().lastMinuteTimeframe,
      historicalFromDate: null,
    };
    set(next);
    persist({ ...get(), ...next });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    const merged = { ...DEFAULTS, ...stored };
    const lastMinuteTimeframe = stored.lastMinuteTimeframe
      ?? (isMinuteTimeframe(merged.candleTimeframe) ? merged.candleTimeframe : DEFAULTS.lastMinuteTimeframe);
    set({ ...merged, lastMinuteTimeframe });
  },
```

Update `beforeEach` in `frontend/src/state/livePage.test.ts`:

```ts
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      lastMinuteTimeframe: '1m',
      historicalFromDate: null,
    });
  });
```

- [ ] **Step 4: Run store tests to verify pass**

Run:

```bash
cd frontend && npx vitest run src/state/livePage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/livePage.ts frontend/src/state/livePage.test.ts
git commit -m "feat: remember live minute timeframe"
```

### Task 2: Toolbar Uses Shared Remembered Minute

**Files:**
- Modify: `frontend/src/live/LiveToolbar.tsx`
- Test: `frontend/src/live/LiveToolbar.test.tsx`

**Interfaces:**
- Consumes: `useLivePageStore((s) => s.lastMinuteTimeframe): MinuteTimeframe`.
- Consumes: `setCandleTimeframe(tf: LiveTimeframe): void`.
- Produces: toolbar minute selector behavior that reads the shared remembered minute instead of component-local state.

- [ ] **Step 1: Write failing toolbar tests**

In `frontend/src/live/LiveToolbar.test.tsx`, add these tests in the existing `describe('LiveToolbar', ...)` block:

```ts
  it('from calendar timeframe, minute selector uses shared lastMinuteTimeframe', () => {
    useLivePageStore.setState({
      candleTimeframe: 'D',
      lastMinuteTimeframe: '10m',
      historicalFromDate: null,
    });
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '10분봉으로 전환' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('10m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('10m');
  });

  it('selecting a minute option updates shared lastMinuteTimeframe', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.click(within(screen.getByRole('menu', { name: '분봉 목록' })).getByRole('menuitemradio', { name: '15분' }));

    expect(useLivePageStore.getState().candleTimeframe).toBe('15m');
    expect(useLivePageStore.getState().lastMinuteTimeframe).toBe('15m');
  });
```

Update the `beforeEach` reset in the same file:

```ts
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      lastMinuteTimeframe: '1m',
      historicalFromDate: null,
    });
```

- [ ] **Step 2: Run toolbar tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/live/LiveToolbar.test.tsx
```

Expected: FAIL before implementation because the toolbar still owns local remembered-minute state.

- [ ] **Step 3: Replace local remembered-minute state**

In `frontend/src/live/LiveToolbar.tsx`, remove `useEffect` from the import because anchor measurement can be handled in click handlers:

```ts
import { useCallback, useRef, useState, type ReactNode } from 'react';
```

Replace the local remembered minute state:

```ts
  const rememberedMinute = useLivePageStore((s) => s.lastMinuteTimeframe);
```

Remove this old block:

```ts
  const [rememberedMinute, setRememberedMinute] = useState<MinuteTimeframe>(
    isMinuteTimeframe(tf) ? tf : '1m',
  );
```

Remove this old effect:

```ts
  useEffect(() => {
    if (!minuteMenuOpen || !minuteButtonRef.current) return;
    setAnchorRect(minuteButtonRef.current.getBoundingClientRect());
  }, [minuteMenuOpen, displayedMinute]);
```

Update `onMinuteSelectorClick`:

```ts
  const onMinuteSelectorClick = () => {
    if (isMinuteTimeframe(tf)) {
      setAnchorRect(minuteButtonRef.current?.getBoundingClientRect() ?? null);
      setMinuteMenuOpen((open) => !open);
      return;
    }
    setMinuteMenuOpen(false);
    setTf(rememberedMinute);
  };
```

Update `pickMinute`:

```ts
  const pickMinute = (next: MinuteTimeframe) => {
    setMinuteMenuOpen(false);
    setTf(next);
  };
```

Update `pickCalendar`:

```ts
  const pickCalendar = (next: CalendarTimeframe) => {
    setMinuteMenuOpen(false);
    setTf(next);
  };
```

- [ ] **Step 4: Run toolbar tests to verify pass**

Run:

```bash
cd frontend && npx vitest run src/live/LiveToolbar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveToolbar.tsx frontend/src/live/LiveToolbar.test.tsx
git commit -m "feat: share live toolbar minute memory"
```

### Task 3: Keyboard Shortcut Matching

**Files:**
- Modify: `frontend/src/live/useLiveKeyboard.ts`
- Test: `frontend/src/live/useLiveKeyboard.test.tsx`

**Interfaces:**
- Produces: `onSelectTimeframeShortcut?: (slot: 'minute' | 'D' | 'W' | 'M') => void` option on `UseLiveKeyboardOpts`.
- Consumes: existing `shouldIgnoreEvent(target)` behavior.

- [ ] **Step 1: Write failing keyboard tests**

In `frontend/src/live/useLiveKeyboard.test.tsx`, update `Harness` props and call:

```tsx
function Harness({
  onNextCode,
  onPrevCode,
  onNextTab,
  onPrevTab,
  onSelectTabIndex,
  onSelectTimeframeShortcut,
}: {
  onNextCode?: () => void;
  onPrevCode?: () => void;
  onNextTab?: () => void;
  onPrevTab?: () => void;
  onSelectTabIndex?: (index: number) => void;
  onSelectTimeframeShortcut?: (slot: 'minute' | 'D' | 'W' | 'M') => void;
}) {
  useLiveKeyboard({
    onNextCode,
    onPrevCode,
    onNextTab,
    onPrevTab,
    onSelectTabIndex,
    onSelectTimeframeShortcut,
  });
  return <div data-testid="harness" tabIndex={0} />;
}
```

Update `HarnessWithInput` similarly:

```tsx
function HarnessWithInput({
  onNextCode,
  onSelectTabIndex,
  onSelectTimeframeShortcut,
}: {
  onNextCode?: () => void;
  onSelectTabIndex?: (index: number) => void;
  onSelectTimeframeShortcut?: (slot: 'minute' | 'D' | 'W' | 'M') => void;
}) {
  useLiveKeyboard({ onNextCode, onSelectTabIndex, onSelectTimeframeShortcut });
  return <input data-testid="input" />;
}
```

Add these tests:

```ts
  it('Shift+1..4 trigger timeframe shortcuts', () => {
    const onSelectTimeframeShortcut = vi.fn();
    render(<Harness onSelectTimeframeShortcut={onSelectTimeframeShortcut} />);

    fireEvent.keyDown(window, { key: '1', shiftKey: true });
    fireEvent.keyDown(window, { key: '2', shiftKey: true });
    fireEvent.keyDown(window, { key: '3', shiftKey: true });
    fireEvent.keyDown(window, { key: '4', shiftKey: true });

    expect(onSelectTimeframeShortcut.mock.calls).toEqual([
      ['minute'],
      ['D'],
      ['W'],
      ['M'],
    ]);
  });

  it('Shift+1 does not select tab index 0', () => {
    const onSelectTabIndex = vi.fn();
    const onSelectTimeframeShortcut = vi.fn();
    render(
      <Harness
        onSelectTabIndex={onSelectTabIndex}
        onSelectTimeframeShortcut={onSelectTimeframeShortcut}
      />,
    );

    fireEvent.keyDown(window, { key: '1', shiftKey: true });

    expect(onSelectTimeframeShortcut).toHaveBeenCalledWith('minute');
    expect(onSelectTabIndex).not.toHaveBeenCalled();
  });

  it('ignores Shift timeframe shortcuts when focus is in an input', () => {
    const onSelectTimeframeShortcut = vi.fn();
    const { getByTestId } = render(<HarnessWithInput onSelectTimeframeShortcut={onSelectTimeframeShortcut} />);

    fireEvent.keyDown(getByTestId('input'), { key: '1', shiftKey: true });

    expect(onSelectTimeframeShortcut).not.toHaveBeenCalled();
  });

  it('ignores Ctrl/Meta/Alt modified Shift timeframe shortcuts', () => {
    const onSelectTimeframeShortcut = vi.fn();
    render(<Harness onSelectTimeframeShortcut={onSelectTimeframeShortcut} />);

    fireEvent.keyDown(window, { key: '1', shiftKey: true, ctrlKey: true });
    fireEvent.keyDown(window, { key: '1', shiftKey: true, metaKey: true });
    fireEvent.keyDown(window, { key: '1', shiftKey: true, altKey: true });

    expect(onSelectTimeframeShortcut).not.toHaveBeenCalled();
  });

  it('plain 1 still selects tab index 0', () => {
    const onSelectTabIndex = vi.fn();
    const onSelectTimeframeShortcut = vi.fn();
    render(
      <Harness
        onSelectTabIndex={onSelectTabIndex}
        onSelectTimeframeShortcut={onSelectTimeframeShortcut}
      />,
    );

    fireEvent.keyDown(window, { key: '1' });

    expect(onSelectTabIndex).toHaveBeenCalledWith(0);
    expect(onSelectTimeframeShortcut).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run keyboard tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/live/useLiveKeyboard.test.tsx
```

Expected: FAIL because `onSelectTimeframeShortcut` does not exist and Shift digits are treated like plain digits.

- [ ] **Step 3: Implement shortcut matching**

In `frontend/src/live/useLiveKeyboard.ts`, add the type and option:

```ts
export type LiveTimeframeShortcutSlot = 'minute' | 'D' | 'W' | 'M';

const TIMEFRAME_SHORTCUTS: Record<string, LiveTimeframeShortcutSlot> = {
  '1': 'minute',
  '2': 'D',
  '3': 'W',
  '4': 'M',
};
```

Update `UseLiveKeyboardOpts`:

```ts
export interface UseLiveKeyboardOpts {
  onNextCode?: () => void;
  onPrevCode?: () => void;
  onNextTab?: () => void;
  onPrevTab?: () => void;
  onSelectTabIndex?: (index: number) => void;
  onSelectTimeframeShortcut?: (slot: LiveTimeframeShortcutSlot) => void;
}
```

Replace the modifier handling at the top of `onKey`:

```ts
      if (shouldIgnoreEvent(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.shiftKey) {
        const slot = TIMEFRAME_SHORTCUTS[e.key];
        if (slot && opts.onSelectTimeframeShortcut) {
          opts.onSelectTimeframeShortcut(slot);
          e.preventDefault();
        }
        return;
      }
```

Update the effect dependency list:

```ts
  }, [
    opts.onNextCode,
    opts.onPrevCode,
    opts.onNextTab,
    opts.onPrevTab,
    opts.onSelectTabIndex,
    opts.onSelectTimeframeShortcut,
  ]);
```

- [ ] **Step 4: Run keyboard tests to verify pass**

Run:

```bash
cd frontend && npx vitest run src/live/useLiveKeyboard.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/useLiveKeyboard.ts frontend/src/live/useLiveKeyboard.test.tsx
git commit -m "feat: add live timeframe keyboard shortcuts"
```

### Task 4: Wire Shortcuts Into LivePage

**Files:**
- Modify: `frontend/src/live/LivePage.tsx`
- Test: `frontend/src/state/livePage.test.ts`, `frontend/src/live/LiveToolbar.test.tsx`, `frontend/src/live/useLiveKeyboard.test.tsx`

**Interfaces:**
- Consumes: `useLiveKeyboard({ onSelectTimeframeShortcut })`.
- Consumes: `useLivePageStore.getState().lastMinuteTimeframe`.
- Produces: `/live` page runtime behavior for `Shift+1..4`.

- [ ] **Step 1: Run current targeted tests before wiring**

```bash
cd frontend && npx vitest run src/state/livePage.test.ts src/live/LiveToolbar.test.tsx src/live/useLiveKeyboard.test.tsx
```

Expected: PASS. Task 1 proves remembered-minute store behavior, Task 2 proves toolbar consumption, and Task 3 proves key matching. This task wires those tested units together in `LivePage`.

- [ ] **Step 2: Wire `LivePage`**

In `frontend/src/live/LivePage.tsx`, add `useLivePageStore.getState()` inside the existing `useLiveKeyboard` call:

```ts
  useLiveKeyboard({
    onNextTab: () => { if (tabs.length) focusTab(tabs[(activeIdx + 1 + tabs.length) % tabs.length].id); },
    onPrevTab: () => { if (tabs.length) focusTab(tabs[(activeIdx - 1 + tabs.length) % tabs.length].id); },
    onSelectTabIndex: (i) => { if (i < tabs.length) focusTab(tabs[i].id); },
    onSelectTimeframeShortcut: (slot) => {
      const page = useLivePageStore.getState();
      const next = slot === 'minute' ? page.lastMinuteTimeframe : slot;
      page.setCandleTimeframe(next);
    },
  });
```

- [ ] **Step 3: Run targeted tests**

Run:

```bash
cd frontend && npx vitest run src/state/livePage.test.ts src/live/LiveToolbar.test.tsx src/live/useLiveKeyboard.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/live/LivePage.tsx
git commit -m "feat: wire live timeframe shortcuts"
```

### Task 5: Final Verification

**Files:**
- Modify: no files in this task.
- Test: targeted frontend suites and build.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: verified implementation ready for review.

- [ ] **Step 1: Run targeted regression tests**

Run:

```bash
cd frontend && npx vitest run src/state/livePage.test.ts src/live/LiveToolbar.test.tsx src/live/useLiveKeyboard.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS with TypeScript and Vite build success.

- [ ] **Step 3: Inspect git diff**

Run:

```bash
git diff --stat
git diff -- frontend/src/state/livePage.ts frontend/src/live/LiveToolbar.tsx frontend/src/live/useLiveKeyboard.ts frontend/src/live/LivePage.tsx
```

Expected: diff only covers shared minute state, toolbar shared state, keyboard matching, and LivePage wiring.

- [ ] **Step 4: Optional manual browser check**

If a dev server is already part of the current workflow, run:

```bash
cd frontend && npm run dev
```

Then open `/live` and verify:

```text
10분 선택 -> Shift+2 -> 일봉
Shift+1 -> 10분
Shift+3 -> 주봉
Shift+4 -> 월봉
plain 1 -> first live tab, not timeframe
typing 005930 in search -> no shortcut fires
```

- [ ] **Step 5: Confirm no uncommitted files remain**

Run:

```bash
git status --short
```

Expected: no output.
