# Quiet Trading Terminal Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the `/live` Quiet Trading Terminal pilot into the full frontend so every user-visible route feels like the same modern Korean market analysis workstation.

**Architecture:** Move the visual direction from a `/live`-scoped CSS override into global design tokens and shared UI primitives. Then migrate each feature surface route-by-route, preserving existing behavior, layout contracts, and chart canvas logic. Keep the right-rail/drawer/sidebar family visually flat inside a single outer panel, avoiding nested cards.

**Tech Stack:** React 18, TypeScript, Tailwind token classes, Vite, Vitest, React Testing Library, in-app browser visual QA.

## Global Constraints

- Preserve every workflow, API call, store contract, keyboard shortcut, drag/drop interaction, and chart canvas behavior.
- Keep KRX market color convention: price up/buy is red, price down/sell is blue.
- Keep UI accent separate from price/status colors: teal is for focus, selection, active controls, and crosshair only.
- Do not introduce a light theme.
- Do not add new runtime dependencies.
- Do not use decorative blobs, gradients, nested cards, or marketing-page composition.
- Numeric market data must remain monospace with tabular numbers.
- Cards are allowed only for outer panels, modals, and repeated independent items; dense tool panels use flat sections with dividers.
- Use TDD for component contract changes. For pure token/CSS visual changes, run the nearest primitive tests, build, and browser visual verification.
- Keep commits task-sized and reviewable.

---

## File Structure Map

- `DESIGN.md`: Update the source-of-truth design direction from “Modern Trading Lab” to “Quiet Trading Terminal” while retaining existing market-data rules.
- `frontend/src/styles/tokens.css`: Promote the quiet palette, border, surface, tint, and shadow tokens globally.
- `frontend/src/styles/global.css`: Remove temporary `/live` token overrides after the global token migration; keep only scoped structural exceptions that are still live-only.
- `frontend/src/ui/PageShell.tsx`, `frontend/src/ui/RailShell.tsx`, `frontend/src/ui/WorkspaceShell.tsx`, `frontend/src/ui/DataSurface.tsx`: Harden shared primitives so all routes receive the same surface/radius/button/list behavior.
- `frontend/src/nav/*`, `frontend/src/rightrail/*`, `frontend/src/watchlist/*`, `frontend/src/screener/ScreenerDrawer.tsx`, `frontend/src/studyViews/StudyViewsDrawer.tsx`: Make navigation, rail, and drawers match the new single-panel language.
- `frontend/src/live/*`, `frontend/src/live/indicators/*`, `frontend/src/live/settings/*`, `frontend/src/sidebar/*`: Finish the pilot by moving modal/sidebar styles into primitives and removing `/live` one-off CSS.
- `frontend/src/pages/*`, `frontend/src/capture/*`, `frontend/src/inventory/*`, `frontend/src/screener/*`, `frontend/src/heatmap/*`, `frontend/src/studyViews/*`: Apply the global primitives route-by-route.
- Tests live next to the touched components. Keep tests focused on class contracts, accessibility labels, state rendering, and unchanged interactions.

---

### Task 1: Promote Quiet Palette Into Global Design Tokens

**Files:**
- Modify: `DESIGN.md`
- Modify: `frontend/src/styles/tokens.css`
- Modify: `frontend/src/styles/global.css`
- Test: `frontend/src/ui/PageShell.test.tsx`
- Test: `frontend/src/ui/RailShell.test.tsx`
- Test: `frontend/src/ui/WorkspaceShell.test.tsx`
- Test: `frontend/src/ui/DataSurface.test.tsx`

**Interfaces:**
- Consumes: Current `/live` pilot values in `frontend/src/styles/global.css`.
- Produces: Global tokens with the quiet palette: `--bg`, `--bg-card`, `--bg-subtle`, `--bg-input`, `--bg-input-hover`, `--border`, `--border-strong`, `--fg`, `--fg-dim`, `--fg-dimmer`, `--accent`, `--accent-shade`, `--tint-selection`, `--grid`.

- [ ] **Step 1: Update primitive tests to assert the token-backed contracts still exist**

Keep the existing expectations in these files and add one assertion per primitive family that the relevant root surface class is still present.

```tsx
// frontend/src/ui/PageShell.test.tsx
expect(screen.getByText('body')).toHaveClass('bg-bg-card');
expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('bg-bg-input');

// frontend/src/ui/RailShell.test.tsx
expect(screen.getByTestId('panel')).toHaveClass('border-l');
expect(screen.getByTestId('panel')).toHaveClass('bg-bg-card');

// frontend/src/ui/WorkspaceShell.test.tsx
expect(screen.getByTestId('header')).toHaveClass('border-b');
expect(screen.getByTestId('toolbar')).toHaveClass('border-b');

// frontend/src/ui/DataSurface.test.tsx
expect(screen.getByText('코드').parentElement).toHaveClass('border-b');
```

- [ ] **Step 2: Run tests before token edits**

Run:

```bash
cd frontend
npm test -- PageShell.test.tsx RailShell.test.tsx WorkspaceShell.test.tsx DataSurface.test.tsx --run
```

Expected: PASS. These tests protect class contracts while the visual values underneath change.

- [ ] **Step 3: Replace the global color tokens**

In `frontend/src/styles/tokens.css`, change only the base dark theme token values. Keep the price/status tokens unchanged.

```css
--bg: #090b0f;
--bg-card: #10151b;
--bg-subtle: #0b0f15;
--bg-input: #0c1117;
--bg-input-hover: #151b23;
--border: #1a2431;
--border-strong: #253040;
--fg: #e6edf5;
--fg-dim: #91a0b4;
--fg-dimmer: #59677a;
--accent: #2dd4bf;
--accent-fg: #07100f;
--accent-shade: #13998c;
--grid: #17202b;
--heat-lo: #0b1518;
--heat-hi: #2dd4bf;
--tint-selection: rgba(45, 212, 191, 0.12);
```

- [ ] **Step 4: Remove duplicated `/live` token overrides**

In `frontend/src/styles/global.css`, delete token assignments inside `[data-live-theme='quiet-terminal']` that now match global tokens. Keep structural live-only rules such as `backdrop-filter`, `live-chart-panel`, `live-workarea`, and `Live Detail Panel` until later tasks absorb them into components.

Expected remaining selector shape:

```css
[data-live-theme='quiet-terminal'] {
  background:
    linear-gradient(180deg, rgba(21, 27, 35, 0.76), rgba(9, 11, 15, 0) 9rem),
    var(--bg);
}
```

- [ ] **Step 5: Update `DESIGN.md`**

Change the aesthetic name to `Quiet Trading Terminal`. Preserve the existing “single accent”, KRX price color, dark-only, and density-dial rules. Add this sentence under Layout or Components:

```markdown
Dense tool panels use one outer surface with internal dividers; avoid nested cards inside sidebars, drawers, modals, and detail panels.
```

- [ ] **Step 6: Verify**

Run:

```bash
cd frontend
npm test -- PageShell.test.tsx RailShell.test.tsx WorkspaceShell.test.tsx DataSurface.test.tsx --run
npm run build
```

Expected: all tests PASS and Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add DESIGN.md frontend/src/styles/tokens.css frontend/src/styles/global.css frontend/src/ui/PageShell.test.tsx frontend/src/ui/RailShell.test.tsx frontend/src/ui/WorkspaceShell.test.tsx frontend/src/ui/DataSurface.test.tsx
git commit -m "style: promote quiet terminal tokens"
```

---

### Task 2: Upgrade Shared Shell Primitives

**Files:**
- Modify: `frontend/src/ui/PageShell.tsx`
- Modify: `frontend/src/ui/PageShell.test.tsx`
- Modify: `frontend/src/ui/RailShell.tsx`
- Modify: `frontend/src/ui/RailShell.test.tsx`
- Modify: `frontend/src/ui/WorkspaceShell.tsx`
- Modify: `frontend/src/ui/WorkspaceShell.test.tsx`
- Modify: `frontend/src/ui/DataSurface.tsx`
- Modify: `frontend/src/ui/DataSurface.test.tsx`

**Interfaces:**
- Consumes: Task 1 global tokens.
- Produces: Consistent outer surfaces and flat section primitives:
  - `PanelCard`: outer card only.
  - `RailDrawer`: single drawer surface.
  - `WorkspaceHeader` / `WorkspaceToolbar`: translucent command rows.
  - `DataSection`: flat divider-based section for dense panels.

- [ ] **Step 1: Write failing tests for flat dense sections**

Add to `frontend/src/ui/DataSurface.test.tsx`:

```tsx
import { DataSection } from './DataSurface';

it('renders flat data sections without nested card chrome', () => {
  render(<DataSection title="10호가">rows</DataSection>);

  const section = screen.getByRole('region', { name: '10호가' });
  expect(section).toHaveClass('border-t');
  expect(section).not.toHaveClass('rounded-lg');
  expect(section).not.toHaveClass('bg-bg-card');
  expect(screen.getByText('10호가')).toHaveClass('uppercase');
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
cd frontend
npm test -- DataSurface.test.tsx --run
```

Expected: FAIL because `DataSection` is not exported.

- [ ] **Step 3: Implement `DataSection`**

Add to `frontend/src/ui/DataSurface.tsx`:

```tsx
export function DataSection({
  title,
  children,
  className = '',
  contentClassName = '',
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section
      aria-label={typeof title === 'string' ? title : undefined}
      className={`border-t border-border first:border-t-0 ${className}`.trim()}
    >
      <header className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-dimmer">
        {title}
      </header>
      <div className={contentClassName}>{children}</div>
    </section>
  );
}
```

- [ ] **Step 4: Make shell primitives match the new visual language**

Use these class changes:

```tsx
// PanelCard
className={`bg-bg-card border border-border rounded-lg min-w-0 shadow-[0_18px_60px_rgba(0,0,0,0.22)] ${className}`.trim()}

// RailDrawer
className={`h-full min-w-0 overflow-hidden border-l border-border bg-bg-card ${className}`.trim()}

// WorkspaceHeader
className={`flex items-center gap-3 border-b border-border bg-bg-subtle/80 px-3 backdrop-blur ${className}`.trim()}

// WorkspaceToolbar
className={`flex items-center gap-2 overflow-x-auto border-b border-border bg-bg-card/80 px-3 backdrop-blur ${className}`.trim()}

// IconToolbarButton
className={`inline-flex items-center gap-1 rounded-md border border-border-strong bg-bg-input px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg disabled:opacity-50 ${className}`.trim()}
```

- [ ] **Step 5: Update primitive tests for new class contracts**

Add or update assertions:

```tsx
expect(screen.getByText('body')).toHaveClass('shadow-[0_18px_60px_rgba(0,0,0,0.22)]');
expect(screen.getByTestId('header')).toHaveClass('backdrop-blur');
expect(screen.getByTestId('toolbar')).toHaveClass('backdrop-blur');
expect(screen.getByRole('button', { name: '설정' })).toHaveClass('border-border-strong');
```

- [ ] **Step 6: Verify**

Run:

```bash
cd frontend
npm test -- PageShell.test.tsx RailShell.test.tsx WorkspaceShell.test.tsx DataSurface.test.tsx --run
npm run build
```

Expected: all tests PASS and Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ui/PageShell.tsx frontend/src/ui/PageShell.test.tsx frontend/src/ui/RailShell.tsx frontend/src/ui/RailShell.test.tsx frontend/src/ui/WorkspaceShell.tsx frontend/src/ui/WorkspaceShell.test.tsx frontend/src/ui/DataSurface.tsx frontend/src/ui/DataSurface.test.tsx
git commit -m "refactor: align shared shell primitives"
```

---

### Task 3: Finish `/live` Pilot and Remove One-Off Styling

**Files:**
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveDetailPanel.tsx`
- Modify: `frontend/src/live/LiveDetailPanel.test.tsx`
- Modify: `frontend/src/live/LiveToolbar.tsx`
- Modify: `frontend/src/live/LiveToolbar.test.tsx`
- Modify: `frontend/src/live/TimeframeControl.tsx`
- Modify: `frontend/src/live/LiveStatusBar.tsx`
- Modify: `frontend/src/live/LiveStatusBar.test.tsx`
- Modify: `frontend/src/styles/global.css`

**Interfaces:**
- Consumes: Task 2 `DataSection`, `WorkspaceToolbar`, `IconToolbarButton`.
- Produces: `/live` with global tokens and component-level styles, not broad CSS overrides.

- [ ] **Step 1: Extend `LiveDetailPanel` tests to protect flat sections**

Add to `frontend/src/live/LiveDetailPanel.test.tsx`:

```tsx
it('renders detail sections as flat sections inside the outer panel', () => {
  render(
    <LiveDetailPanel
      orderbook={<div>orderbook</div>}
      brokers={<div>brokers</div>}
      volumeDistribution={<div>volume</div>}
      program={<div>program</div>}
      investor={<div>investor</div>}
    />,
  );

  const orderbook = screen.getByTestId('live-detail-card-orderbook');
  expect(orderbook).not.toHaveClass('rounded');
  expect(orderbook).not.toHaveClass('bg-bg-card');
  expect(orderbook).not.toHaveClass('overflow-hidden');
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run:

```bash
cd frontend
npm test -- LiveDetailPanel.test.tsx --run
```

Expected: PASS if the current local pilot flattening is present; FAIL if the branch starts before that change. In either case, continue by implementing through `DataSection`.

- [ ] **Step 3: Replace detail card markup with `DataSection`**

In `frontend/src/live/LiveDetailPanel.tsx`, import and use:

```tsx
import { DataSection } from '../ui/DataSurface';
```

Replace the section wrapper with:

```tsx
<DataSection
  title={card.label}
  className="flex flex-col"
  contentClassName="flex-1"
>
  <div data-testid={`live-detail-content-${card.key}`} className="flex-1">
    <div data-testid={card.contentTestId}>{card.content}</div>
  </div>
</DataSection>
```

Keep these attributes on the rendered section by wrapping `DataSection` if needed:

```tsx
data-testid={card.testId}
data-card={card.key}
style={{
  minHeight: Math.max(
    LIVE_CARD_MIN_HEIGHT_PX[card.key],
    Math.round(weights[card.key] * WEIGHT_TO_MIN_HEIGHT_PX),
  ),
}}
```

- [ ] **Step 4: Move live structural CSS into components**

Remove from `frontend/src/styles/global.css` selectors that only restyle live children:

```css
[data-live-theme='quiet-terminal'] [data-testid='live-header']
[data-live-theme='quiet-terminal'] [data-testid='live-status-bar']
[data-live-theme='quiet-terminal'] [data-testid='live-toolbar']
[data-live-theme='quiet-terminal'] [role='tab']
[data-live-theme='quiet-terminal'] [data-testid='live-chart-panel']
[data-live-theme='quiet-terminal'] [role='complementary'][aria-label='Live Detail Panel']
```

Move required classes/styles into:
- `WorkspaceShell.tsx` for header/toolbar.
- `ChartTabBar.tsx` for tabs if tabs need the visual change globally.
- `LiveWorkarea.tsx` for chart/detail outer panel borders.

- [ ] **Step 5: Keep `/live` root only as a visual QA hook or remove it**

If no CSS selector depends on `data-live-theme`, remove it from `LivePage.tsx`. If browser QA still uses it, keep it temporarily with no visual effect:

```tsx
<div data-testid="live-page" className="h-full grid" style={{ ... }}>
```

- [ ] **Step 6: Verify**

Run:

```bash
cd frontend
npm test -- LiveDetailPanel.test.tsx LiveToolbar.test.tsx LiveStatusBar.test.tsx LivePage.test.tsx --run
npm run build
```

Expected: all tests PASS and Vite build succeeds.

- [ ] **Step 7: Browser QA**

Open:

```text
http://127.0.0.1:5174/live
```

Check:
- The right detail panel has one outer surface.
- `10호가`, `거래원`, `매물대`, `프로그램 순매수`, `잠정투자자` are flat sections.
- Header, tab bar, status bar, toolbar, chart panel, and detail panel share the same surface family.
- No text overlaps in the toolbar at the current viewport.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/live/LivePage.tsx frontend/src/live/LiveDetailPanel.tsx frontend/src/live/LiveDetailPanel.test.tsx frontend/src/live/LiveToolbar.tsx frontend/src/live/LiveToolbar.test.tsx frontend/src/live/TimeframeControl.tsx frontend/src/live/LiveStatusBar.tsx frontend/src/live/LiveStatusBar.test.tsx frontend/src/styles/global.css
git commit -m "refactor: finish live quiet terminal surfaces"
```

---

### Task 4: Redesign Live Indicator and Settings Modals

**Files:**
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.test.tsx`
- Modify: `frontend/src/live/LiveSettingsModal.tsx`
- Modify: `frontend/src/live/LiveSettingsModal.test.tsx`
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Modify: `frontend/src/live/LiveSettingsSections.test.tsx`
- Modify: `frontend/src/live/settings/SettingsRow.tsx`
- Modify: `frontend/src/live/settings/NumericPrefRow.tsx`
- Modify: `frontend/src/live/settings/IndicatorPrefRows.tsx`

**Interfaces:**
- Consumes: Task 2 shell primitives and `DataSection`.
- Produces: Indicator/settings dialogs that match the same quiet terminal surface language.

- [ ] **Step 1: Write failing modal structure tests**

Add to `frontend/src/live/indicators/IndicatorPanel.test.tsx`:

```tsx
it('uses a flat section layout for indicator settings', () => {
  render(<IndicatorPanel onClose={() => {}} capabilities={{ hogaPanes: true, investorNet: 'stock' }} />);

  expect(screen.getByRole('dialog')).toHaveClass('bg-bg-card');
  expect(screen.getByRole('navigation', { name: '지표 카테고리' })).toHaveClass('border-r');
  expect(screen.getByText('10호가 지표')).toHaveClass('uppercase');
});
```

Add to `frontend/src/live/LiveSettingsModal.test.tsx`:

```tsx
it('uses the quiet terminal modal surface', () => {
  render(<LiveSettingsModal onClose={() => {}} />);

  expect(screen.getByRole('dialog')).toHaveClass('bg-bg-card');
  expect(screen.getByRole('navigation', { name: '설정 카테고리' })).toHaveClass('border-r');
});
```

- [ ] **Step 2: Run tests to verify RED or current contract gap**

Run:

```bash
cd frontend
npm test -- IndicatorPanel.test.tsx LiveSettingsModal.test.tsx --run
```

Expected: FAIL if classes are not yet aligned.

- [ ] **Step 3: Convert modal shells**

Use this structure in both modal roots:

```tsx
<div
  role="dialog"
  aria-modal="true"
  className="fixed inset-0 z-50 grid place-items-center bg-black/45"
>
  <div className="grid max-h-[min(820px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] grid-cols-[200px_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
    ...
  </div>
</div>
```

- [ ] **Step 4: Convert left category rows**

Use quiet list row classes:

```tsx
className={`flex w-full items-center justify-between rounded-none border-l-2 px-4 py-2 text-left text-sm transition-colors ${
  isSelected
    ? 'border-accent bg-tint-selection text-fg'
    : 'border-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg'
}`}
```

- [ ] **Step 5: Convert settings content to flat sections**

Replace inner card-like containers with:

```tsx
<DataSection title="10호가 지표" contentClassName="space-y-3 p-4">
  {children}
</DataSection>
```

For row controls, keep existing inputs but align classes:

```tsx
className="rounded-md border border-border-strong bg-bg-input px-2 py-1 text-sm tabular-nums text-fg focus:border-accent focus:outline-none"
```

- [ ] **Step 6: Verify**

Run:

```bash
cd frontend
npm test -- IndicatorPanel.test.tsx LiveSettingsModal.test.tsx LiveSettingsSections.test.tsx --run
npm run build
```

Expected: all tests PASS and Vite build succeeds.

- [ ] **Step 7: Browser QA**

Open `/live`, click `보조지표`, then `설정`. Check:
- Modal shell matches the right panel and page surfaces.
- Left nav does not look like a SaaS settings menu.
- Color swatches, numeric inputs, toggles, and checkboxes remain usable.
- No section contains card-in-card chrome.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx frontend/src/live/LiveSettingsModal.tsx frontend/src/live/LiveSettingsModal.test.tsx frontend/src/live/LiveSettingsSections.tsx frontend/src/live/LiveSettingsSections.test.tsx frontend/src/live/settings/SettingsRow.tsx frontend/src/live/settings/NumericPrefRow.tsx frontend/src/live/settings/IndicatorPrefRows.tsx
git commit -m "style: align live dialogs with terminal theme"
```

---

### Task 5: Apply the Theme to Navigation, Right Rail, and Drawers

**Files:**
- Modify: `frontend/src/nav/LeftNav.tsx`
- Modify: `frontend/src/nav/NavItem.tsx`
- Modify: `frontend/src/nav/LeftNav.test.tsx`
- Modify: `frontend/src/rightrail/RightRail.tsx`
- Modify: `frontend/src/rightrail/RightRail.test.tsx`
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Modify: `frontend/src/watchlist/WatchlistDrawer.test.tsx`
- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
- Modify: `frontend/src/screener/ScreenerDrawer.test.tsx`
- Modify: `frontend/src/studyViews/StudyViewsDrawer.tsx`
- Modify: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`
- Modify: `frontend/src/ui/RailShell.tsx`
- Modify: `frontend/src/ui/RailShell.test.tsx`

**Interfaces:**
- Consumes: Task 2 `RailShell`.
- Produces: Left nav, icon rail, and drawers with the same rail vocabulary.

- [ ] **Step 1: Add tests for active rail/nav states**

Add to `frontend/src/nav/LeftNav.test.tsx`:

```tsx
expect(screen.getByRole('link', { name: 'Live' })).toHaveClass('text-fg');
```

Add to `frontend/src/ui/RailShell.test.tsx`:

```tsx
expect(screen.getByRole('button', { name: '관심' })).toHaveClass('bg-tint-selection');
expect(screen.getByRole('button', { name: '관심' })).toHaveClass('border-l-2');
```

- [ ] **Step 2: Run tests to verify RED for new rail active style**

Run:

```bash
cd frontend
npm test -- LeftNav.test.tsx RailShell.test.tsx RightRail.test.tsx --run
```

Expected: FAIL for new active rail style until implementation lands.

- [ ] **Step 3: Update `RailButton`**

In `frontend/src/ui/RailShell.tsx`, change `RailButton` to:

```tsx
className={`w-full border-l-2 py-3 flex flex-col items-center gap-1 transition-colors ${
  active
    ? 'border-accent bg-tint-selection text-fg font-medium'
    : 'border-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg'
} ${className}`.trim()}
```

- [ ] **Step 4: Update `NavItem` active state**

Use a left spine instead of a heavy filled menu block:

```tsx
className={`relative grid h-9 grid-cols-[24px_1fr] items-center gap-2 rounded-md border px-2 text-sm transition-colors ${
  active
    ? 'border-border-strong bg-tint-selection text-fg before:absolute before:left-[-1px] before:top-2 before:bottom-2 before:w-[2px] before:rounded before:bg-accent'
    : 'border-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg'
}`}
```

- [ ] **Step 5: Convert drawer headers and sections**

All drawers should use:

```tsx
<RailDrawerHeader title="..." />
<RailDrawerSection />
<RailDrawerBody />
```

Avoid adding `PanelCard` inside `RailDrawer`. Use `DataSection` or plain dividers for dense grouped controls.

- [ ] **Step 6: Verify**

Run:

```bash
cd frontend
npm test -- LeftNav.test.tsx RailShell.test.tsx RightRail.test.tsx WatchlistDrawer.test.tsx ScreenerDrawer.test.tsx StudyViewsDrawer.test.tsx --run
npm run build
```

Expected: all tests PASS and Vite build succeeds.

- [ ] **Step 7: Browser QA**

Open `/live`, toggle each right rail panel. Check:
- Drawer surface is one panel.
- Group headers stick correctly.
- Active rail icon uses the same teal spine language as nav.
- Watchlist, screener, and saved-view rows do not feel like nested cards.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/nav/LeftNav.tsx frontend/src/nav/NavItem.tsx frontend/src/nav/LeftNav.test.tsx frontend/src/rightrail/RightRail.tsx frontend/src/rightrail/RightRail.test.tsx frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx frontend/src/screener/ScreenerDrawer.tsx frontend/src/screener/ScreenerDrawer.test.tsx frontend/src/studyViews/StudyViewsDrawer.tsx frontend/src/studyViews/StudyViewsDrawer.test.tsx frontend/src/ui/RailShell.tsx frontend/src/ui/RailShell.test.tsx
git commit -m "style: align nav rail and drawers"
```

---

### Task 6: Apply Route-Level Surfaces to Capture, Inventory, Screener, Settings, Study, and Heatmap

**Files:**
- Modify: `frontend/src/pages/Capture.tsx`
- Modify: `frontend/src/pages/Capture.test.tsx`
- Modify: `frontend/src/pages/Inventory.tsx`
- Modify: `frontend/src/pages/Settings.tsx`
- Modify: `frontend/src/pages/Settings.test.tsx`
- Modify: `frontend/src/pages/Screener.tsx`
- Modify: `frontend/src/pages/Screener.test.tsx`
- Modify: `frontend/src/pages/Heatmap.tsx`
- Modify: `frontend/src/pages/Heatmap.test.tsx`
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`
- Modify: existing route child components only when page-level primitives cannot cover the visual mismatch.

**Interfaces:**
- Consumes: Task 2 `PanelCard`, `DataSection`, `DataTableShell`, `ListRow`, `InlineState`, `FormField`.
- Produces: All non-live routes following the same surface rules.

- [ ] **Step 1: Update route tests to protect top-level shell usage**

For each page test, assert the primary page container has either a `PanelCard` surface or an intentional full-bleed exception.

Example for `frontend/src/pages/Capture.test.tsx`:

```tsx
expect(screen.getByTestId('capture-page-primary')).toHaveClass('bg-bg-card');
expect(screen.getByTestId('capture-page-primary')).toHaveClass('border');
```

Example for `frontend/src/pages/Heatmap.test.tsx`:

```tsx
expect(screen.getByTestId('heatmap-board')).toBeInTheDocument();
expect(screen.queryByTestId('heatmap-nested-card')).not.toBeInTheDocument();
```

- [ ] **Step 2: Run route tests to find missing test IDs**

Run:

```bash
cd frontend
npm test -- Capture.test.tsx Inventory.test.tsx Settings.test.tsx Screener.test.tsx Heatmap.test.tsx StudyPage.test.tsx --run
```

Expected: FAIL where test IDs or surfaces are not present yet.

- [ ] **Step 3: Apply `PanelCard` only to page-level primary panes**

Use this page pattern:

```tsx
<PageContainer>
  <PanelCard data-testid="capture-page-primary" className="flex min-h-0 flex-col">
    <ControlBar>...</ControlBar>
    <DataSection title="...">...</DataSection>
  </PanelCard>
</PageContainer>
```

Do not wrap existing cards inside `PanelCard`. If a child already has a card, flatten the child or leave the parent unframed.

- [ ] **Step 4: Apply dense flat sections within pages**

Use `DataSection` for repeated page sections:

```tsx
<DataSection title="캡처 대기열" contentClassName="min-h-0">
  <CaptureQueue />
</DataSection>
```

Use `DataTableShell` for tables and `ListRow` for selectable rows. Keep heatmap folder blocks as the existing transparent flat exception described in `DESIGN.md`.

- [ ] **Step 5: Verify route tests**

Run:

```bash
cd frontend
npm test -- Capture.test.tsx Inventory.test.tsx Settings.test.tsx Screener.test.tsx Heatmap.test.tsx StudyPage.test.tsx --run
```

Expected: all route tests PASS.

- [ ] **Step 6: Browser QA route sweep**

Open and inspect:

```text
http://127.0.0.1:5174/live
http://127.0.0.1:5174/study
http://127.0.0.1:5174/heatmap
http://127.0.0.1:5174/screener
http://127.0.0.1:5174/inventory
http://127.0.0.1:5174/capture
http://127.0.0.1:5174/settings
```

Check:
- One top-level surface per pane.
- No card inside card unless it is a repeated independent item.
- Dense sections use dividers.
- Tables remain readable.
- No button text overflows at the current browser width.

- [ ] **Step 7: Full verify**

Run:

```bash
cd frontend
npm run build
```

Expected: Vite build succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Capture.tsx frontend/src/pages/Capture.test.tsx frontend/src/pages/Inventory.tsx frontend/src/pages/Settings.tsx frontend/src/pages/Settings.test.tsx frontend/src/pages/Screener.tsx frontend/src/pages/Screener.test.tsx frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.test.tsx frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "style: apply terminal surfaces to routes"
```

---

### Task 7: Final Visual QA, Cleanup, and Documentation

**Files:**
- Modify: `DESIGN.md`
- Modify: `frontend/src/styles/global.css`
- Modify: touched tests if QA reveals missing coverage.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: A verified full-frontend visual migration with no temporary `/live`-only concept CSS.

- [ ] **Step 1: Search for leftover pilot CSS**

Run:

```bash
rg "quiet-terminal|data-live-theme|ui-modern-concept|card-in-card|nested card" frontend/src docs -n
```

Expected:
- No `ui-modern-concept`.
- No `data-live-theme` unless deliberately retained only as a QA hook.
- No broad route-scoped CSS carrying the global theme.

- [ ] **Step 2: Search for likely nested card patterns**

Run:

```bash
rg "bg-bg-card.*bg-bg-card|rounded.*rounded|PanelCard.*PanelCard|<PanelCard[\\s\\S]*<PanelCard" frontend/src -n
```

Expected: No obvious nested-card pattern in sidebars, drawers, modals, or page sections. Repeated independent item cards may remain where visually justified.

- [ ] **Step 3: Run full frontend tests**

Run:

```bash
cd frontend
npm test -- --run
```

Expected: all tests PASS.

- [ ] **Step 4: Run production build**

Run:

```bash
cd frontend
npm run build
```

Expected: Vite build succeeds.

- [ ] **Step 5: Browser QA desktop**

With the dev server running, open the seven route URLs from Task 6. For each route, record pass/fail for:
- Surface hierarchy.
- Text fit.
- Scroll containment.
- Active/focus states.
- Modal/drawer consistency.
- Market red/blue meaning.
- Teal UI accent meaning.

- [ ] **Step 6: Browser QA narrow desktop**

Set the browser width near 1120px and inspect:
- `/live`
- `/screener`
- `/capture`
- `/settings`

Expected: controls fit without incoherent overlap. Horizontal scrolling is acceptable only for dense data tables.

- [ ] **Step 7: Update `DESIGN.md` final notes**

Add a short implementation note:

```markdown
Quiet Trading Terminal migration completed across app shell, route surfaces, rail drawers, live dialogs, and dense data panels. Nested-card chrome is prohibited in sidebars, drawers, modals, and detail panels; use `DataSection` dividers inside a single outer surface.
```

- [ ] **Step 8: Final commit**

```bash
git add DESIGN.md frontend/src/styles/global.css frontend/src
git commit -m "style: complete quiet terminal frontend migration"
```

---

## Self-Review

- **Spec coverage:** The plan covers global tokens, shared shell primitives, `/live` cleanup, live dialogs, nav/rail/drawers, every top-level route, and final browser QA.
- **Placeholder scan:** No task uses empty placeholder markers or undefined future work. Each task names exact files and commands.
- **Type consistency:** `DataSection` is introduced in Task 2 and consumed by Tasks 3, 4, and 6. Existing primitives keep their current names.
- **Scope check:** This is broad but still one cohesive subsystem: frontend visual system migration. It is split into independently testable tasks so implementation can stop after any task with a usable app.
