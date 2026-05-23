# Settings Modal + Ratio Pane Auction Masking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mask the bid/ask imbalance ratio (호가비) to 0 during the closing Auction Window (15:20–15:30 KST) by default, expose the toggle via a new Settings modal reached from a gear button in the Replay Viewer toolbar.

**Architecture:** Per-tab `auctionWindowMask: boolean` on `ChartViewPrefs` (default `true`) — mirrors the existing `volumeProfileMode` shape. `RatioPane.tsx` reads the flag and gates its `value` field using the `AUCTION_WINDOW_OFFSET_MS` precedent from `CandlePane.tsx`. A new `SettingsModal.tsx` (centered fixed overlay, 180px sidebar + flex-1 content, Escape/backdrop/close-button dismiss) hosts the toggle as the first row under a "차트" sidebar item. `Toolbar.tsx` mounts the modal behind a gear button placed immediately after `<TimeframeSelector />`.

**Tech Stack:** TypeScript, React functional components + hooks, zustand (`useTabsStore`), Tailwind utility classes against existing tokens (`bg-bg-card`, `--border-strong`, `--accent`, `--fg-dimmer`), `lightweight-charts` (unchanged), vitest + @testing-library/react for tests, the `browse` skill for visual verification.

**Spec:** `docs/superpowers/specs/2026-05-23-settings-modal-ratio-auction-masking-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/state/tabs.ts` | Modify | Extend `ChartViewPrefs`/`DEFAULT_PREFS` with `auctionWindowMask`; add `setAuctionWindowMask` action. |
| `frontend/src/state/tabs.test.ts` | Modify | Add coverage for the new default + setter. |
| `frontend/src/chart/RatioPane.tsx` | Modify | Add `AUCTION_WINDOW_OFFSET_MS`; read `auctionWindowMask` via `useTabsStore`; gate the mapped `value`. |
| `frontend/tests/component/RatioPane.test.tsx` | Modify | Reset store in `beforeEach`; add two cases (mask ON, mask OFF) for the auction band. |
| `frontend/src/replay/SettingsModal.tsx` | Create | New centered modal component with sidebar + content + toggle row. |
| `frontend/src/replay/SettingsModal.test.tsx` | Create | Cover render, Escape close, backdrop close, close-button close, toggle writes to store. |
| `frontend/src/replay/Toolbar.tsx` | Modify | Inject the gear button, mount `SettingsModal` behind a local boolean. |
| `frontend/src/replay/Toolbar.test.tsx` | Modify | Add a case for clicking the gear and observing the modal. |

No backend changes. No DESIGN.md changes (all needed tokens already exist).

---

## Task 1: Per-tab `auctionWindowMask` on the tabs store

**Files:**
- Modify: `frontend/src/state/tabs.ts`
- Modify: `frontend/src/state/tabs.test.ts`

### Step 1: Read the current shape

Open `frontend/src/state/tabs.ts`. Confirm:
- `ChartViewPrefs` (line 16) has one field `volumeProfileMode: 'range' | 'per-day'`.
- `DEFAULT_PREFS` (line 20) is `{ volumeProfileMode: 'range' }`.
- Store has `getPrefs(id)` and `setVolumeProfileMode(id, mode)` (lines 109–115).

If any of these diverged from the snapshot above, reconcile before continuing.

- [ ] **Step 1 complete:** file matches expected shape.

### Step 2: Extend `ChartViewPrefs` and defaults

Replace the `ChartViewPrefs` block:

```ts
export type ChartViewPrefs = {
  volumeProfileMode: 'range' | 'per-day';
  /**
   * When `true`, RatioPane masks the 15:20–15:30 KST Auction Window band by
   * forcing each `value` to 0 instead of the raw `quoteImbalance(...)` result.
   * The Window is dominated by one-sided order accumulation, so the derived
   * ratio whips to non-informative extremes there (see CONTEXT.md "Auction
   * Window" entry). Default `true`.
   */
  auctionWindowMask: boolean;
};
```

And the defaults:

```ts
const DEFAULT_PREFS: ChartViewPrefs = {
  volumeProfileMode: 'range',
  auctionWindowMask: true,
};
```

- [ ] **Step 2 complete:** prefs type and defaults extended.

### Step 3: Add the setter to the `Store` type and implementation

Inside the `type Store = { ... }` block (around lines 33–47), add the new method signature:

```ts
  setAuctionWindowMask: (id: string, enabled: boolean) => void;
```

Inside `create<Store>((set, get) => ({ ... }))` (around lines 110–115), mirror the `setVolumeProfileMode` shape:

```ts
  setAuctionWindowMask: (id, enabled) =>
    set((s) => {
      const next = new Map(s.prefs);
      next.set(id, { ...DEFAULT_PREFS, ...next.get(id), auctionWindowMask: enabled });
      return { prefs: next };
    }),
```

Place it immediately after `setVolumeProfileMode` so the two ChartViewPrefs setters sit next to each other.

- [ ] **Step 3 complete:** setter added.

### Step 4: Update `frontend/src/state/tabs.test.ts`

Append three new test cases inside the existing `describe('useTabsStore — timeframe + prefs (Map-based, CQ1)', ...)` block, after the existing prefs-related tests:

```ts
  it('getPrefs returns default auctionWindowMask=true if not set', () => {
    const id = useTabsStore.getState().tabs[0].id;
    expect(useTabsStore.getState().getPrefs(id).auctionWindowMask).toBe(true);
  });

  it('setAuctionWindowMask flips the per-tab flag', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setAuctionWindowMask(id, false);
    expect(useTabsStore.getState().getPrefs(id).auctionWindowMask).toBe(false);
    useTabsStore.getState().setAuctionWindowMask(id, true);
    expect(useTabsStore.getState().getPrefs(id).auctionWindowMask).toBe(true);
  });

  it('setAuctionWindowMask preserves volumeProfileMode on the same tab', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    useTabsStore.getState().setAuctionWindowMask(id, false);
    const prefs = useTabsStore.getState().getPrefs(id);
    expect(prefs.volumeProfileMode).toBe('per-day');
    expect(prefs.auctionWindowMask).toBe(false);
  });
```

The third case is the cross-field merge guard — confirms `setAuctionWindowMask` doesn't clobber `volumeProfileMode` (and vice versa).

- [ ] **Step 4 complete:** three new tests added.

### Step 5: Run the tabs tests

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx vitest run src/state/tabs.test.ts
```

Expected: all tests pass (existing five + new three).

- [ ] **Step 5 complete:** tabs.test.ts green.

### Step 6: Type-check

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx tsc -b
```

Expected: exits 0 with no output. If a downstream consumer of `ChartViewPrefs` fails because it didn't expect the new field, the failure message will name the file — open it and supply `auctionWindowMask: true` in any literal `ChartViewPrefs` it constructs (none expected; the type is only constructed via `DEFAULT_PREFS`/`setX` actions).

- [ ] **Step 6 complete:** `tsc -b` clean.

### Step 7: Commit Task 1

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add frontend/src/state/tabs.ts frontend/src/state/tabs.test.ts
git diff --cached --stat
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(state/tabs): auctionWindowMask boolean on ChartViewPrefs

Per-tab toggle (default true) for the RatioPane's 15:20-15:30 KST
auction-window masking. Mirrors the volumeProfileMode pattern:
DEFAULT_PREFS gets the new field, setAuctionWindowMask(id, enabled)
action merges via { ...DEFAULT_PREFS, ...prev, auctionWindowMask }.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7 complete:** commit lands.

---

## Task 2: RatioPane reads `auctionWindowMask` and gates the value

**Files:**
- Modify: `frontend/src/chart/RatioPane.tsx`
- Modify: `frontend/tests/component/RatioPane.test.tsx`

### Step 1: Read the current `RatioPane.tsx`

Confirm:
- `useEffect` runs `resolveTokens`, calls `chart.addSeries(BaselineSeries, { ... }, paneIndex)`, then maps `bundle.quote_ratio.points` with `.filter(axis.contains).map(p => ({ time, value: quoteImbalance(...) }))`, then `series.setData(data)` and `series.createPriceLine(...)`.
- The current `.map` arrow body is a one-liner returning an object literal.
- The effect's deps array is `[chart, bundle, axis, paneIndex]`.

If the file diverges materially, reconcile against this plan before editing.

- [ ] **Step 1 complete:** file matches expected shape.

### Step 2: Import `useTabsStore`

Add the import alongside the existing imports at the top of the file:

```ts
import { useTabsStore } from '../state/tabs';
```

- [ ] **Step 2 complete:** import added.

### Step 3: Add the `AUCTION_WINDOW_OFFSET_MS` constant

Below the existing `TOKEN_SPEC` block (and the `rgba` helper) but above the `type Props` declaration, add:

```ts
/**
 * Closing Auction Window starts at sessionOpenMs + 6h 20m (KST 15:20).
 * Mirrors CandlePane.tsx's per-segment threshold (CONTEXT.md "Auction
 * Window"). During this band, derived ratios are dominated by one-sided
 * accumulation and read as misleading extremes; the toggle on the tabs
 * store gates the mask on a per-tab basis.
 */
const AUCTION_WINDOW_OFFSET_MS = (6 * 3600 + 20 * 60) * 1000;
```

- [ ] **Step 3 complete:** constant declared.

### Step 4: Read the flag inside the component body

Inside `RatioPane({ chart, bundle, axis, paneIndex = 0 })` but BEFORE the `useEffect`, read the active tab's flag via two selectors:

```ts
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const auctionWindowMask = useTabsStore((s) => s.getPrefs(activeTabId).auctionWindowMask);
```

Two separate selectors (rather than one composite) keep the subscription cheap — the component only re-renders when either value actually changes.

- [ ] **Step 4 complete:** flag read.

### Step 5: Gate the mapped `value`

Rewrite the existing `bundle.quote_ratio.points.filter(...).map(...)` block to resolve each point's segment and conditionally zero the value:

```ts
    const data = bundle.quote_ratio.points
      .filter((p) => axis.contains(p.t))
      .map((p) => {
        const segIdx = axis.findByReal(p.t);
        const seg = axis.segments[segIdx];
        const inAuctionWindow =
          p.t >= seg.sessionOpenMs + AUCTION_WINDOW_OFFSET_MS;
        return {
          time: (axis.toVirtual(p.t) / 1000) as any,
          value: auctionWindowMask && inAuctionWindow
            ? 0
            : quoteImbalance(p.bid_total, p.ask_total),
        };
      });
```

`axis.contains(p.t)` guarantees `findByReal` returns a valid (non-negative) index, so no defensive guard is needed. The variable is `inAuctionWindow` (not `inAuctionOrAfter`) because `axis.contains` has already removed everything past `sessionCloseMs` (see spec § Problem) — the "or After-Hours" half from CandlePane's naming would be dead code here.

- [ ] **Step 5 complete:** map body rewritten.

### Step 6: Extend the effect deps

The `useEffect` deps array currently reads `[chart, bundle, axis, paneIndex]`. Append `auctionWindowMask` so toggling the flag re-runs the effect (remount the series with fresh data):

```ts
  }, [chart, bundle, axis, paneIndex, auctionWindowMask]);
```

The effect already handles cleanup via `chart.removeSeries(series)`, so the remount path is safe.

- [ ] **Step 6 complete:** deps array updated.

### Step 7: Update `RatioPane.test.tsx`

Open `frontend/tests/component/RatioPane.test.tsx`. Update the imports and add a `beforeEach` reset:

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RatioPane from '../../src/chart/RatioPane';
import { createVirtualAxis } from '../../src/util/virtualAxis';
import { useTabsStore } from '../../src/state/tabs';
```

Inside `describe('RatioPane', () => { ... })`, immediately above the first `it(...)`, add:

```tsx
  beforeEach(() => {
    // Reset to a clean single-tab state with empty prefs so each case starts
    // from the default auctionWindowMask=true and doesn't inherit prior state.
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });
```

Add two new test cases at the end of the `describe` block:

```tsx
  it('zeros auction-window ratio values when auctionWindowMask is true (default)', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const auctionStart = sessionOpenMs + (6 * 3600 + 20 * 60) * 1000; // 15:20
    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs + 60_000,  bid_total: 100, ask_total: 200 }, // 09:01 → +1.0
          { t: auctionStart,            bid_total: 50,  ask_total: 500 }, // 15:20:00 → masked
          { t: auctionStart + 60_000,   bid_total: 100, ask_total: 100 }, // 15:21    → masked
        ],
      },
    };
    render(
      <RatioPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
        ])}
      />,
    );
    const data = series.setData.mock.calls[0][0];
    expect(data).toHaveLength(3);
    expect(data[0].value).toBeCloseTo(1.0, 5); // normal-band
    expect(data[1].value).toBe(0);             // auction-band → masked
    expect(data[2].value).toBe(0);             // auction-band → masked
  });

  it('passes raw imbalance when auctionWindowMask is false', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const auctionStart = sessionOpenMs + (6 * 3600 + 20 * 60) * 1000;
    // Flip the per-tab flag BEFORE rendering so the component picks it up.
    const activeId = useTabsStore.getState().activeTabId;
    useTabsStore.getState().setAuctionWindowMask(activeId, false);

    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: auctionStart,          bid_total: 50, ask_total: 500 }, // raw: +9
          { t: auctionStart + 60_000, bid_total: 100, ask_total: 100 }, // raw: 0
        ],
      },
    };
    render(
      <RatioPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
        ])}
      />,
    );
    const data = series.setData.mock.calls[0][0];
    expect(data[0].value).toBeCloseTo(9, 5);    // 500/50 - 1
    expect(data[1].value).toBe(0);              // raw balance
  });
```

- [ ] **Step 7 complete:** tests added.

### Step 8: Run the chart tests

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx vitest run tests/component/RatioPane.test.tsx
```

Expected: all four tests pass (existing two + new two). If the existing "drops pre-open auction quote_ratio points" test fails, double-check the `beforeEach` reset isn't breaking it — that test uses a different `sessionOpenMs` and should still work with the reset.

- [ ] **Step 8 complete:** RatioPane.test.tsx green.

### Step 9: Type-check + full chart suite

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx tsc -b
npx vitest run src/chart/
```

Expected: `tsc -b` clean. Chart suite green (no regressions in CandlePane / VolumePane / FillStrengthPane tests).

- [ ] **Step 9 complete:** types + full chart suite green.

### Step 10: Commit Task 2

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add frontend/src/chart/RatioPane.tsx frontend/tests/component/RatioPane.test.tsx
git diff --cached --stat
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(chart/RatioPane): mask Auction Window values via per-tab toggle

15:20-15:30 KST is the closing Auction Window — matching is paused so
the ask/bid totals accumulate one-sidedly, and the derived imbalance
ratio whips to misleading extremes that dominate the BaselineSeries
autoscale.

Gate the .map's `value` field: when the per-tab auctionWindowMask flag
is true (default), return 0 instead of quoteImbalance(...) for any
point whose ts_ms >= seg.sessionOpenMs + 6h20m. The constant mirrors
CandlePane.tsx's existing AUCTION_WINDOW_OFFSET_MS precedent.

Two new tests: mask-on zeros the auction band (default), mask-off
passes raw imbalance through.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10 complete:** commit lands.

---

## Task 3: New `SettingsModal` component

**Files:**
- Create: `frontend/src/replay/SettingsModal.tsx`
- Create: `frontend/src/replay/SettingsModal.test.tsx`

### Step 1: Create the component

Write `frontend/src/replay/SettingsModal.tsx` with the following content:

```tsx
import { useEffect, useState } from 'react';
import { useTabsStore } from '../state/tabs';

type Props = {
  onClose: () => void;
};

type Category = 'chart';

/**
 * Centered modal overlay for chart settings. First category "차트" hosts the
 * Auction Window masking toggle; future categories slot in alongside without
 * a layout rewrite (sidebar + content split).
 *
 * Close paths: Escape key, backdrop click, header ✕, footer 닫기.
 * Toggle changes persist immediately to the per-tab prefs (no save button) —
 * mirrors CursorSidebar's volumeProfileMode live-write pattern.
 */
export default function SettingsModal({ onClose }: Props) {
  const [category, setCategory] = useState<Category>('chart');
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const auctionWindowMask = useTabsStore(
    (s) => s.getPrefs(activeTabId).auctionWindowMask,
  );
  const setAuctionWindowMask = useTabsStore((s) => s.setAuctionWindowMask);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="설정"
      onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[640px] max-w-[90vw] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">설정</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex">
          <nav className="w-[180px] py-2 border-r border-border" aria-label="설정 카테고리">
            <button
              type="button"
              onClick={() => setCategory('chart')}
              aria-pressed={category === 'chart'}
              className={
                category === 'chart'
                  ? 'block w-full text-left px-4 py-2 text-sm bg-bg-input text-fg font-medium border-l-2 border-accent'
                  : 'block w-full text-left px-4 py-2 text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg'
              }
            >
              차트
            </button>
          </nav>

          <div className="flex-1 px-5 py-4">
            {category === 'chart' && (
              <>
                <h3 className="text-fg text-base font-medium pb-2 mb-2 border-b border-border">
                  차트
                </h3>
                <div className="flex items-center justify-between py-2">
                  <div className="flex-1 pr-4">
                    <div className="text-fg text-sm">호가비 동시호가 마스킹</div>
                    <div className="text-fg-dim text-xs mt-0.5">
                      15:20–15:30 KST 동시호가 구간의 호가비를 0 으로 처리합니다.
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={auctionWindowMask}
                    aria-label="호가비 동시호가 마스킹"
                    onClick={() => setAuctionWindowMask(activeTabId, !auctionWindowMask)}
                    className={
                      auctionWindowMask
                        ? 'relative inline-flex h-5 w-9 items-center rounded-full bg-accent transition-colors'
                        : 'relative inline-flex h-5 w-9 items-center rounded-full bg-bg-input-hover transition-colors'
                    }
                  >
                    <span
                      className={
                        auctionWindowMask
                          ? 'inline-block h-4 w-4 transform rounded-full bg-accent-fg translate-x-[18px] transition-transform'
                          : 'inline-block h-4 w-4 transform rounded-full bg-fg-dim translate-x-[2px] transition-transform'
                      }
                    />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
```

Key implementation notes encoded in the code above:
- `role="dialog"` + `aria-modal="true"` on the backdrop element. `onClick={onClose}` on the backdrop, `onClick={(e) => e.stopPropagation()}` on the inner card — so clicking outside the card closes, clicking inside doesn't.
- Escape via `document.addEventListener('keydown', ...)` mounted while the component is mounted, cleaned up on unmount.
- `z-[60]` (Tailwind arbitrary value) sits above the existing `z-50` dropdowns.
- Toggle uses `role="switch"` + `aria-checked` — semantically correct for a binary on/off (vs `aria-pressed` which is for toggle-buttons).
- Slider transform: `translate-x-[2px]` (OFF) vs `translate-x-[18px]` (ON). 16px slider in a 36px (`w-9`) track leaves 2px padding on each side at the endpoints.
- The sidebar `차트` button reuses the active-state shape from `Tab.tsx:20`: `bg-bg-input` + `border-l-2 border-accent`. One item only; rendering it as a button (not a static label) keeps the future-multi-item layout consistent.

- [ ] **Step 1 complete:** SettingsModal.tsx written.

### Step 2: Create the test file

Write `frontend/src/replay/SettingsModal.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SettingsModal from './SettingsModal';
import { useTabsStore } from '../state/tabs';

describe('SettingsModal', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('renders dialog with the auction-window toggle defaulting to ON', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    const sw = screen.getByRole('switch', { name: '호가비 동시호가 마스킹' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('Escape key invokes onClose', () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click invokes onClose; inner click does not', () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose} />);
    // Backdrop is the dialog element itself.
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Clicking the toggle inside should NOT close.
    fireEvent.click(screen.getByRole('switch', { name: '호가비 동시호가 마스킹' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('header ✕ and footer 닫기 both invoke onClose', () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose} />);
    // Both header ✕ (aria-label="닫기") and footer "닫기" share the same
    // accessible name, so `getByRole` would throw on ambiguity. Use
    // `getAllByRole` to retrieve both and click each in turn.
    const closers = screen.getAllByRole('button', { name: '닫기' });
    expect(closers).toHaveLength(2);
    fireEvent.click(closers[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(closers[1]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('toggle click flips the per-tab flag in the store', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    const sw = screen.getByRole('switch', { name: '호가비 동시호가 마스킹' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    // Re-query because the className/aria-checked re-renders.
    const swAfter = screen.getByRole('switch', { name: '호가비 동시호가 마스킹' });
    expect(swAfter.getAttribute('aria-checked')).toBe('false');
    const activeId = useTabsStore.getState().activeTabId;
    expect(useTabsStore.getState().getPrefs(activeId).auctionWindowMask).toBe(false);
  });
});
```

The fourth test (`header ✕ and footer 닫기`) catches the close button labeled by `aria-label="닫기"` (header ✕) AND the text-content `닫기` (footer). Both have accessible name `닫기`, so `getAllByRole('button', { name: '닫기' })` returns both.

- [ ] **Step 2 complete:** SettingsModal.test.tsx written.

### Step 3: Run the SettingsModal tests

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx vitest run src/replay/SettingsModal.test.tsx
```

Expected: all five tests pass.

- [ ] **Step 3 complete:** modal tests green.

### Step 4: Type-check

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx tsc -b
```

Expected: `tsc -b` exits 0.

- [ ] **Step 4 complete:** types clean.

### Step 5: Commit Task 3

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add frontend/src/replay/SettingsModal.tsx frontend/src/replay/SettingsModal.test.tsx
git diff --cached --stat
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(replay/SettingsModal): centered settings modal with sidebar + toggle

New component for the Replay Viewer's settings hub. Centered fixed
overlay (z-[60]), 640px card with a 180px sidebar (categories) + flex-1
content. Currently one category "차트" with one row: the Auction Window
masking toggle wired to ChartViewPrefs.auctionWindowMask via the tabs
store. Escape / backdrop click / header ✕ / footer 닫기 all close.
Toggle changes persist immediately (no save button).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5 complete:** commit lands.

---

## Task 4: Toolbar gear button + modal mount

**Files:**
- Modify: `frontend/src/replay/Toolbar.tsx`
- Modify: `frontend/src/replay/Toolbar.test.tsx`

### Step 1: Read the current `Toolbar.tsx`

Confirm the return JSX (around lines 70–85) reads:

```tsx
return (
  <div className="flex items-center gap-2.5 px-4 bg-bg-card border-b h-toolbar">
    <StockCombobox value={draft.code} onChange={setCode} />
    <DateRangePicker code={draft.code} from={draft.from} to={draft.to} onChange={setDates} />
    <TimeframeSelector value={draft.timeframe ?? '1m'} onChange={setTimeframe} />
    <span className="flex-1" />
    {rangeError && <span className="text-down text-sm ml-2">{rangeError}</span>}
    <button
      disabled={!ready}
      onClick={onLoad}
      ...
```

If the structure has materially changed, reconcile before editing.

- [ ] **Step 1 complete:** file matches expected shape.

### Step 2: Import `SettingsModal`

Add the import alongside the existing imports:

```ts
import SettingsModal from './SettingsModal';
```

- [ ] **Step 2 complete:** import added.

### Step 3: Add the `settingsOpen` state

Inside the component body, near the existing `useState`, add:

```ts
  const [settingsOpen, setSettingsOpen] = useState(false);
```

- [ ] **Step 3 complete:** state declared.

### Step 4: Inject the gear button + modal mount

Replace the JSX block:

```tsx
    <TimeframeSelector value={draft.timeframe ?? '1m'} onChange={setTimeframe} />
    <span className="flex-1" />
```

with:

```tsx
    <TimeframeSelector value={draft.timeframe ?? '1m'} onChange={setTimeframe} />
    <button
      type="button"
      aria-label="설정"
      onClick={() => setSettingsOpen(true)}
      className="px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg border border-border rounded"
    >
      ⚙
    </button>
    {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    <span className="flex-1" />
```

- [ ] **Step 4 complete:** button + modal mount injected.

### Step 5: Update `Toolbar.test.tsx`

Open `frontend/src/replay/Toolbar.test.tsx`. Verify the existing pattern (how it renders Toolbar, whether it mocks any of `StockCombobox` / `DateRangePicker` / `TimeframeSelector`). Append one new test case at the end of the existing `describe` block:

```tsx
  it('opens the SettingsModal when the gear button is clicked', () => {
    // Re-render Toolbar; existing render helper or inline render works either way.
    // Adjust the surrounding setup to match the file's existing pattern.
    render(<Toolbar />);
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
  });
```

If `render` or `screen` is not already imported at the top of the file, add:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
```

If the existing tests use a custom render helper (e.g. wrapping in providers), use the same helper here.

- [ ] **Step 5 complete:** test added.

### Step 6: Run the toolbar tests

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx vitest run src/replay/Toolbar.test.tsx
```

Expected: all tests pass (existing + new one).

- [ ] **Step 6 complete:** Toolbar.test.tsx green.

### Step 7: Type-check + full replay-folder suite

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
npx tsc -b
npx vitest run src/replay/
```

Expected: `tsc -b` clean. Replay suite green (Workarea, RangeAdjustmentNotice, TimeframeSelector tests unchanged).

- [ ] **Step 7 complete:** types + replay suite green.

### Step 8: Commit Task 4

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add frontend/src/replay/Toolbar.tsx frontend/src/replay/Toolbar.test.tsx
git diff --cached --stat
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(replay/Toolbar): settings gear button opens SettingsModal

Gear button (⚙) injected immediately right of the TimeframeSelector
(left of the flex-1 spacer). Matches the inactive-timeframe styling
(px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg border) for
visual rhythm. Modal mounts conditionally behind a local useState; the
modal owns its own dismiss paths.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8 complete:** commit lands.

---

## Task 5: Visual verification via `browse`

**Files:** none modified — observational.

### Step 1: Confirm the dev server is up

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/replay
```

Expected: `200`. Start the dev server with `(cd frontend && npm run dev &)` if needed.

- [ ] **Step 1 complete:** dev server returns 200.

### Step 2: Load a populated chart

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B goto "http://localhost:5173/replay?tabs=003490:20260519:20260520:1m&active=0"
sleep 4
$B screenshot /tmp/before-mask.png
```

Read `/tmp/before-mask.png`. The Ratio pane (third from top) should look like the prior commits' state with the auction-band spikes already absent IF the default `auctionWindowMask=true` took effect on first render. Confirm visually that the spike at the 5/20 day boundary that previously dominated the BaselineSeries autoscale is gone and the rest of the day reads at full pane height.

- [ ] **Step 2 complete:** default-mask-on baseline captured.

### Step 3: Open the modal

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B snapshot -i  # confirm @e ref for the 설정 button
```

Find the `@eN [button] "설정"` line in the snapshot output and substitute the ref:

```bash
$B click @eN  # replace N with the actual snapshot ref
sleep 0.3
$B screenshot /tmp/settings-open.png
```

Read `/tmp/settings-open.png`. Confirm:
- Modal is centered on the viewport (not stuck in a corner).
- Header reads "설정" with a ✕ on the right.
- Sidebar shows "차트" with the active styling (left teal accent + filled background).
- Content area shows the section heading "차트" + the toggle row with title "호가비 동시호가 마스킹", description "15:20–15:30 KST 동시호가 구간의 호가비를 0 으로 처리합니다.", and an ON-state switch (slider on the right, teal background).
- Footer has a "닫기" button on the right.

- [ ] **Step 3 complete:** modal opens correctly.

### Step 4: Toggle OFF and confirm Ratio pane changes

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B snapshot -i
# Locate the @eN ref for the role=switch "호가비 동시호가 마스킹" — usually @eM with [switch] role.
$B click @eM   # replace M with the actual switch ref
sleep 0.5
$B screenshot /tmp/mask-off.png
```

Read `/tmp/mask-off.png`. The Ratio pane should now show the raw (unmasked) imbalance ratio — the previously-dominant 15:20–15:30 spike at the 5/20 boundary returns, compressing the rest of the day's signal.

- [ ] **Step 4 complete:** OFF path verified.

### Step 5: Close paths

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
# Press Escape
$B press Escape
sleep 0.2
$B snapshot -i | grep -i "dialog\|설정" || echo "MODAL CLOSED"
```

Expected: snapshot does not contain a `[dialog]` or open-modal control. The line `MODAL CLOSED` indicates the Escape path worked.

Repeat for backdrop click and footer 닫기 click — re-open the modal, click outside the card / click the footer button, snapshot, confirm closure each time.

- [ ] **Step 5 complete:** all three close paths verified.

### Step 6: Cross-tab persistence spot-check

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
# Click the "+ 새 분석" button to spawn a fresh tab.
$B snapshot -i
$B click @eN  # the "+ 새 분석" button's ref
sleep 0.5
# Open settings on the new tab.
$B click @eM  # the 설정 button's ref (snapshot again if needed)
sleep 0.3
$B screenshot /tmp/new-tab-settings.png
```

Read `/tmp/new-tab-settings.png`. Confirm the new tab's toggle reads ON (per-tab default) regardless of the first tab being toggled OFF in step 4. This validates the per-tab scope.

- [ ] **Step 6 complete:** per-tab independence confirmed.

### Step 7: Regression spot-check

In the active tab, confirm by visual inspection of the chart that the following are unchanged outside the masking band:
- 0-baseline gray reference line on the Ratio pane.
- Right-axis last-value chip (e.g., "0" or "Nx S" / "Nx B").
- `--ratio-ask` / `--down` color split outside the auction band.
- Day-boundary dotted lines (5/20 chip).
- Volume pane bars unchanged.
- Candle pane unchanged.

- [ ] **Step 7 complete:** no visual regression on adjacent panes.

---

## Out of Scope (do NOT extend this plan)

- `persist` middleware on the tabs store (cross-refresh persistence).
- Focus trap inside the modal.
- Keyboard navigation between sidebar items (arrow keys).
- A separate setting for the 15:30–16:00 after-hours band (would require Virtual Axis structural change — separate spec).
- CandlePane comment cleanup ("Auction Window or After-Hours Trading muted" → drop the dead "or After-Hours Trading" half) — flagged in the spec's "Adjacent drift" section; separate commit.
- IntensityPane retirement cleanup — flagged in the spec's "Adjacent drift" section; separate commit.

If the user requests any of these during execution, STOP and brainstorm a new spec.
