# Page Shell Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/inventory`, `/capture`, `/watchlist` one consistent page frame (token padding + card-framed content + a title-less control bar), fixing `/watchlist`'s card-less outlier; `/live` stays full-bleed.

**Architecture:** A thin `forwardRef` `PageContainer` owns the shared page padding. Card framing + "no redundant page title" are conventions documented in DESIGN.md and applied per page. The left nav is the sole page label (consistent with the just-shipped `/live` header-title removal). New `--tint-*-border` tokens let the Watchlist banners drop inline `rgba()`.

**Tech Stack:** React 19 + TypeScript, Tailwind (tokens extended via `tokens.css` + generated `design-tokens.ts`), Vitest + Testing Library, `/browse` daemon for visual verification.

**Spec:** `docs/superpowers/specs/2026-05-31-page-shell-unification-design.md`

---

## Worktree & commit note

Work happens in the current feature worktree (`feat+frontend5`) so the running dev server (localhost:5173) reflects changes. A **concurrent edit stream touches `frontend/src/capture/useCaptureQueue.ts`** — do NOT touch or stage it. Every commit step uses `git commit --only <paths>` to stage exactly this task's files and bypass the shared index race.

## Verification philosophy

These are visual/structural changes. TDD applies where there is real behavior to assert (PageContainer contract; Watchlist title-removal regression). Pure className/token swaps (rgba→token, padding tokens) are NOT asserted with synthetic failing tests — jsdom does not resolve CSS variables. They are verified by: `tsc --noEmit` clean + the page's **existing** test suite still passing + before/after `/browse` screenshots.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `frontend/src/styles/tokens.css` | CSS custom properties | Modify — add `--tint-success-border`, `--tint-error-border` |
| `frontend/tailwind.config.ts` | Tailwind token exposure | Modify — expose `tint-success-border`, `tint-error-border` |
| `frontend/src/layout/PageContainer.tsx` | Shared page outer frame (padding + sizing) | Create |
| `frontend/src/layout/PageContainer.test.tsx` | PageContainer contract test | Create |
| `frontend/src/watchlist/WatchlistPanel.tsx` | `/watchlist` route body | Modify — PageContainer + single card + drop h1 + token banners |
| `frontend/src/watchlist/WatchlistPanel.test.tsx` | Watchlist tests | Modify — add no-heading regression |
| `frontend/src/pages/Capture.tsx` | `/capture` route shell | Modify — PageContainer (`p-4`→`p-md`) |
| `frontend/src/capture/CaptureForm.tsx` | Capture form + alerts | Modify — alert/button inline styles → tokens |
| `frontend/src/pages/Inventory.tsx` | `/inventory` route shell | Modify — PageContainer + `var(--sidebar-w)` |
| `frontend/src/inventory/StockDateGroupDetail.tsx` | Inventory detail table | Modify — blocked-row `rgba`→`bg-tint-error` |
| `frontend/src/live/LiveToolbar.tsx` | `/live` toolbar | Modify (optional) — inline px → tokens |
| `DESIGN.md` | Design system doc | Modify — add "Page shell" section + border tokens |

---

### Task 1: Tint-border tokens

**Files:**
- Modify: `frontend/src/styles/tokens.css:67-68`
- Modify: `frontend/tailwind.config.ts:46` (colors block)

- [ ] **Step 1: Add the border-alpha CSS vars**

In `frontend/src/styles/tokens.css`, immediately after the `--tint-error` line (currently line 68), add:

```css
  --tint-success-border: rgba(34, 197, 94, 0.30);
  --tint-error-border:   rgba(244, 63, 94, 0.30);
```

- [ ] **Step 2: Expose them to Tailwind**

In `frontend/tailwind.config.ts`, in the `colors` block right after the `'tint-error': 'var(--tint-error)',` line, add:

```ts
        'tint-success-border': 'var(--tint-success-border)',
        'tint-error-border':   'var(--tint-error-border)',
```

- [ ] **Step 3: Verify the build resolves the classes**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git commit --only frontend/src/styles/tokens.css frontend/tailwind.config.ts \
  -m 'feat(tokens): add --tint-success-border / --tint-error-border (0.30 alpha)' \
  -m 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

---

### Task 2: `PageContainer` component

**Files:**
- Create: `frontend/src/layout/PageContainer.tsx`
- Test: `frontend/src/layout/PageContainer.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/layout/PageContainer.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, it, expect } from 'vitest';
import { PageContainer } from './PageContainer';

describe('PageContainer', () => {
  it('renders children inside the padded frame', () => {
    render(<PageContainer><span>body</span></PageContainer>);
    const child = screen.getByText('body');
    expect(child.parentElement).toHaveClass('p-md');
    expect(child.parentElement).toHaveClass('h-full');
  });

  it('merges extra className and forwards a ref to the frame element', () => {
    const ref = createRef<HTMLDivElement>();
    render(<PageContainer ref={ref} className="grid gap-md"><span>x</span></PageContainer>);
    expect(ref.current).not.toBeNull();
    expect(ref.current).toHaveClass('grid');
    expect(ref.current).toHaveClass('p-md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/layout/PageContainer.test.tsx`
Expected: FAIL — cannot resolve `./PageContainer`.

- [ ] **Step 3: Create the component**

Create `frontend/src/layout/PageContainer.tsx`:

```tsx
import { forwardRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Shared outer frame for feature pages (DESIGN.md "Page shell"). Provides the
 * one canonical page padding token (p-md) + full-height sizing. Does NOT impose
 * a card or a page title — pages compose their own card(s) and a title-less
 * control bar inside. The left nav is the page label, so pages never repeat
 * their own name (matches the /live header decision). Full-bleed pages (the
 * /live chart workspace) do NOT use this; they own their grid.
 *
 * forwardRef so a page that needs the frame element (e.g. Capture's splitter
 * drag math) can read it.
 */
export const PageContainer = forwardRef<
  HTMLDivElement,
  { children: ReactNode; className?: string; style?: CSSProperties }
>(function PageContainer({ children, className = '', style }, ref) {
  return (
    <div ref={ref} className={`p-md h-full min-h-0 ${className}`} style={style}>
      {children}
    </div>
  );
});

export default PageContainer;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/layout/PageContainer.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git commit --only frontend/src/layout/PageContainer.tsx frontend/src/layout/PageContainer.test.tsx \
  -m 'feat(layout): add thin PageContainer frame (token page padding, forwardRef)' \
  -m 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

---

### Task 3: Watchlist — PageContainer + single card + drop title + token banners

**Files:**
- Modify: `frontend/src/watchlist/WatchlistPanel.tsx`
- Test: `frontend/src/watchlist/WatchlistPanel.test.tsx`

- [ ] **Step 1: Add the title-removal regression test**

In `frontend/src/watchlist/WatchlistPanel.test.tsx`, inside the first `describe('WatchlistPanel', ...)` block, add this test (it asserts no static page title remains and the body is carded):

```tsx
  it('renders no redundant page-title heading (nav is the label) and cards the body', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValueOnce({
      entries: [{ code: '003490', name: '대한항공', added_date: '20260528', last_success_date: '20260529' }],
      next_run_at_ms: Date.now() + 60_000,
    } as any);
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => expect(screen.getByText('대한항공')).toBeInTheDocument());
    // No <h1>Watchlist</h1> — the left nav already labels the page.
    expect(screen.queryByRole('heading', { name: 'Watchlist' })).toBeNull();
    // Body is wrapped in the standard card.
    expect(screen.getByTestId('watchlist-card')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistPanel.test.tsx -t 'no redundant page-title'`
Expected: FAIL — `Watchlist` heading still present / no `watchlist-card` testid.

- [ ] **Step 3: Wrap in PageContainer + card and drop the h1**

In `frontend/src/watchlist/WatchlistPanel.tsx`:

(a) Add the import at the top (after the existing imports):

```tsx
import { PageContainer } from '../layout/PageContainer';
```

(b) Replace the root wrapper. The current root (line 122-123) is `<div className="flex flex-col h-full">`. Replace the opening tag and the matching closing `</div>` (the component's outermost) with:

```tsx
return (
  <PageContainer>
    <div
      data-testid="watchlist-card"
      className="bg-bg-card border rounded-lg flex flex-col h-full min-h-0 overflow-hidden"
    >
      {/* ...existing header / banners / form / list children unchanged... */}
    </div>
  </PageContainer>
);
```

(c) In the `<header>` (currently lines 124-150), remove the `<h1>` and rebalance the top row. Replace:

```tsx
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Watchlist</h1>
        <div className="flex items-center gap-2">
```

with (move the count chip to the left anchor where the title was; keep the 전체 수집 button on the right):

```tsx
      <div className="flex items-baseline justify-between">
        <span className="font-mono tabular-nums text-xs text-fg-dimmer px-2 py-0.5 rounded bg-bg-input">
          {data.entries.length}종목
        </span>
        <div className="flex items-center gap-2">
```

Then DELETE the now-duplicate count `<span>...{data.entries.length}종목</span>` that previously sat inside the right-hand actions `<div>` (the first child of `<div className="flex items-center gap-2">`), leaving only the `↻ 지금 전체 수집` button on the right.

- [ ] **Step 4: Convert banners to token classes**

Replace the `BANNER_STYLES` object (lines 24-35) and the `Banner` component (lines 37-43) with:

```tsx
const BANNER_CLASS = {
  success: 'bg-tint-success border-tint-success-border text-success',
  error: 'bg-tint-error border-tint-error-border text-error',
} as const;

function Banner({ kind, children }: { kind: 'success' | 'error'; children: React.ReactNode }) {
  return (
    <div className={`mx-6 mt-3 px-3 py-2 rounded border text-sm ${BANNER_CLASS[kind]}`}>
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Run the full Watchlist suite + tsc**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistPanel.test.tsx && npx tsc --noEmit`
Expected: PASS (all existing tests + the new regression); no type errors.

- [ ] **Step 6: Visual check**

Run: `B=/home/dev/.claude/skills/gstack/browse/dist/browse; $B goto http://localhost:5173/watchlist && $B screenshot /tmp/wl-after.png`
Then Read `/tmp/wl-after.png`. Expected: table sits in a `--bg-card` rounded card with page padding; no "Watchlist" title; count chip top-left, 전체 수집 top-right; countdown line intact.

- [ ] **Step 7: Confirm the rail is unaffected**

Run: `B=/home/dev/.claude/skills/gstack/browse/dist/browse; $B goto http://localhost:5173/live && $B js "!!document.querySelector('[data-testid=watchlist-panel]') || 'panel-closed-ok'"`
Expected: the `WatchlistDrawer` (separate component) is untouched — open it from the rail and confirm it still renders its read-only list.

- [ ] **Step 8: Commit**

```bash
git commit --only frontend/src/watchlist/WatchlistPanel.tsx frontend/src/watchlist/WatchlistPanel.test.tsx \
  -m 'refactor(watchlist): card-frame the /watchlist page, drop redundant title' \
  -m 'Wrap body in PageContainer + bg-bg-card card; remove <h1>Watchlist</h1> (nav labels it); banners use --tint-* tokens. Rail WatchlistDrawer untouched.' \
  -m 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

---

### Task 4: Capture — PageContainer + token alerts

**Files:**
- Modify: `frontend/src/pages/Capture.tsx:57-62`
- Modify: `frontend/src/capture/CaptureForm.tsx:93-142`

- [ ] **Step 1: Adopt PageContainer for the outer shell**

In `frontend/src/pages/Capture.tsx`:

(a) Add import after the existing imports:

```tsx
import { PageContainer } from '../layout/PageContainer';
```

(b) Replace the outer wrapper. Current (lines 57-62):

```tsx
    <div
      ref={containerRef}
      style={{ gridTemplateColumns: `${leftPct}fr 12px ${100 - leftPct}fr` }}
      className="grid gap-0 p-4 h-full bg-bg text-fg"
    >
```

with (drop `p-4`/`h-full` — PageContainer supplies `p-md h-full`; pass the grid + bg via className):

```tsx
    <PageContainer
      ref={containerRef}
      className="grid gap-0 bg-bg text-fg"
      style={{ gridTemplateColumns: `${leftPct}fr 12px ${100 - leftPct}fr` }}
    >
```

Change the matching closing `</div>` of that block (line 78) to `</PageContainer>`.

- [ ] **Step 2: Tokenize the CaptureForm alerts**

In `frontend/src/capture/CaptureForm.tsx`, replace the `blockedMessage` alert (lines 110-125) with:

```tsx
      {blockedMessage !== null && (
        <div
          role="alert"
          className="mt-2 px-3 py-2 rounded border bg-tint-error border-error text-error text-sm"
        >
          {blockedMessage}
        </div>
      )}
```

and the `inlineError` alert (lines 127-142) with:

```tsx
      {inlineError !== null && (
        <div
          role="alert"
          className="mt-2 px-3 py-2 rounded border bg-bg-input border-border text-error text-sm"
        >
          {inlineError}
        </div>
      )}
```

- [ ] **Step 3: Run Capture suites + tsc**

Run: `cd frontend && npx vitest run src/pages/Capture.test.tsx src/capture/CaptureForm.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 4: Visual check**

Run: `B=/home/dev/.claude/skills/gstack/browse/dist/browse; $B goto http://localhost:5173/capture && $B screenshot /tmp/cap-after.png`
Then Read `/tmp/cap-after.png`. Expected: two cards with consistent (`p-md`) outer padding; splitter still draggable; alert styling unchanged visually.

- [ ] **Step 5: Commit**

```bash
git commit --only frontend/src/pages/Capture.tsx frontend/src/capture/CaptureForm.tsx \
  -m 'refactor(capture): adopt PageContainer; alerts use token classes' \
  -m 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

---

### Task 5: Inventory — PageContainer + sidebar-w token + blocked-row token

**Files:**
- Modify: `frontend/src/pages/Inventory.tsx:24-32`
- Modify: `frontend/src/inventory/StockDateGroupDetail.tsx:125-127`

- [ ] **Step 1: Adopt PageContainer + the width token**

In `frontend/src/pages/Inventory.tsx`:

(a) Add import after the existing imports:

```tsx
import { PageContainer } from '../layout/PageContainer';
```

(b) Replace the return wrapper (lines 24-32):

```tsx
    <div
      className="p-md h-full grid gap-md min-h-0"
      style={{ gridTemplateColumns: '320px 1fr' }}
    >
      <StockDateGroupList rows={rows} selectedCode={selectedCode} onSelect={setSelectedCode} />
      <StockDateGroupDetail rows={rows} selectedCode={selectedCode} />
    </div>
```

with:

```tsx
    <PageContainer
      className="grid gap-md"
      style={{ gridTemplateColumns: 'var(--sidebar-w) 1fr' }}
    >
      <StockDateGroupList rows={rows} selectedCode={selectedCode} onSelect={setSelectedCode} />
      <StockDateGroupDetail rows={rows} selectedCode={selectedCode} />
    </PageContainer>
```

- [ ] **Step 2: Tokenize the blocked-row tint**

In `frontend/src/inventory/StockDateGroupDetail.tsx`, replace (lines 125-127):

```tsx
              const trClass = r.blocked
                ? 'border-b bg-[rgba(244,63,94,0.10)]'
                : 'border-b';
```

with:

```tsx
              const trClass = r.blocked
                ? 'border-b bg-tint-error'
                : 'border-b';
```

- [ ] **Step 3: Run Inventory suites + tsc**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx src/inventory/StockDateGroupList.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 4: Visual check (loaded state)**

Run: `B=/home/dev/.claude/skills/gstack/browse/dist/browse; $B goto http://localhost:5173/inventory && $B screenshot /tmp/inv-after.png`
Then Read `/tmp/inv-after.png`. Expected: two cards, `--sidebar-w` left column, unchanged from before (this page was already conformant — confirm no regression). If it shows "Loading"/"no data", note backend/KRX state but confirm the two-card structure renders.

- [ ] **Step 5: Commit**

```bash
git commit --only frontend/src/pages/Inventory.tsx frontend/src/inventory/StockDateGroupDetail.tsx \
  -m 'refactor(inventory): adopt PageContainer; use --sidebar-w + --tint-error token' \
  -m 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

---

### Task 6 (optional, low priority): Live toolbar inline-px → tokens

**Files:**
- Modify: `frontend/src/live/LiveToolbar.tsx:49-50,70-71`

- [ ] **Step 1: Replace inline px on the indicator/settings buttons**

In `frontend/src/live/LiveToolbar.tsx`, the two buttons at lines ~49-50 and ~70-71 use inline `gap: '4px'` and `padding: '4px 10px'`. Replace those inline style entries with the Tailwind classes already used by the timeframe buttons on line 29 (`px-2 py-1`) and a `gap-xs`, removing the off-scale `10px`. Read the exact button markup first; convert only the `gap`/`padding` keys, leaving other inline style (e.g. colors) intact.

- [ ] **Step 2: Run Live toolbar suite + tsc**

Run: `cd frontend && npx vitest run src/live/LiveToolbar.test.tsx && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 3: Visual check**

Run: `B=/home/dev/.claude/skills/gstack/browse/dist/browse; $B goto http://localhost:5173/live && $B screenshot /tmp/live-after.png`
Then Read it. Expected: toolbar buttons visually unchanged.

- [ ] **Step 4: Commit**

```bash
git commit --only frontend/src/live/LiveToolbar.tsx \
  -m 'refactor(live): tokenize toolbar button spacing (drop off-scale inline px)' \
  -m 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

---

### Task 7: Document the Page shell in DESIGN.md

**Files:**
- Modify: `DESIGN.md` (Layout section + App-shell tokens table)

- [ ] **Step 1: Add a "Page shell" subsection**

In `DESIGN.md`, under the `## Layout` section (after the "Max content width" / "Border radius" entries, before `## Motion`), add:

```markdown
### Page shell (feature routes)

Every feature route except the chart workspace follows one shell:

- **Outer padding:** wrap the route in `<PageContainer>` (`frontend/src/layout/PageContainer.tsx`) — the single source of the page padding token (`p-md`). Never hardcode `p-4`/`p-8` at the page root.
- **Content framing:** primary content sits in `bg-bg-card border rounded-lg` cards. Multi-pane pages (master-detail, splitter) use one card per pane; single-content pages use one card. Never nest cards.
- **No redundant page title:** the left nav is the page label, so a page never repeats its own name. Pages expose a *title-less* control bar (search / counts / actions) at the top of their card. (See the `/live` header: search only, symbol shown in the status bar.)
- **Full-bleed exception:** only the chart workspace (`/live`) is full-bleed (no `PageContainer`, no card) — the chart must fill the viewport. Its sidebar still uses `--bg-card` to match other panels.
```

- [ ] **Step 2: Document the new border tokens**

In `DESIGN.md`, in the "Tint backgrounds" bullet list under `## Color`, append:

```markdown
  - Success border: `rgba(34,197,94,0.30)` — `--tint-success-border` (banner/chip borders)
  - Error border: `rgba(244,63,94,0.30)` — `--tint-error-border` (banner/chip borders)
```

- [ ] **Step 3: Commit**

```bash
git commit --only DESIGN.md \
  -m 'docs(design): add Page shell contract + tint-border tokens' \
  -m 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

---

### Task 8: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Type-check the whole frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Run every suite touched by this plan**

Run:
```bash
cd frontend && npx vitest run \
  src/layout/PageContainer.test.tsx \
  src/watchlist/WatchlistPanel.test.tsx \
  src/watchlist/WatchlistDrawer.test.tsx \
  src/pages/Capture.test.tsx src/capture/CaptureForm.test.tsx \
  src/inventory/StockDateGroupDetail.test.tsx src/inventory/StockDateGroupList.test.tsx \
  src/live/LiveToolbar.test.tsx src/live/LivePage.test.tsx
```
Expected: all PASS.

- [ ] **Step 3: Four-page before/after screenshot comparison**

For each of `/live /inventory /capture /watchlist`: `$B goto ...; $B screenshot /tmp/page-<name>-final.png`, then Read each. Expected: all four share consistent page padding; `/watchlist` now carded with no title; `/inventory` + `/capture` unchanged structurally; `/live` unchanged.

- [ ] **Step 4: Confirm no stray uncommitted files of ours**

Run: `git status --short`
Expected: only the concurrent `useCaptureQueue.ts` (if still in flight) — none of this plan's files.

---

## Self-review

- **Spec coverage:** PageContainer (Task 2 ✓), card framing (Tasks 3-5 ✓), no-title rule (Task 3 ✓ + DESIGN.md Task 7 ✓), Watchlist card + banners (Task 3 ✓), Capture padding + alerts (Task 4 ✓), Inventory `--sidebar-w` + blocked tint (Task 5 ✓), Live toolbar px (Task 6 ✓), DESIGN.md "Page shell" + border tokens (Tasks 1, 7 ✓), token-hygiene scoped to touched files ✓, `useCaptureQueue.ts` out of scope ✓.
- **Placeholder scan:** Task 6 Step 1 says "read the exact button markup first" rather than quoting final code — acceptable because the inline-style keys vary and the change is mechanical (convert `gap`/`padding` only); it is explicitly optional/low-priority.
- **Type consistency:** `PageContainer` props `{children, className?, style?}` + forwardRef used identically in Tasks 3/4/5. `watchlist-card` testid defined in Task 3 Step 3 and asserted in Task 3 Step 1. Token class names (`bg-tint-success`, `border-tint-success-border`, `text-success`) match Task 1's exposure.
