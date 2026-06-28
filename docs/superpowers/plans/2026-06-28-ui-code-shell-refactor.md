# UI Code Shell Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Phase 1 frontend UI code so feature routes share common page primitives while preserving current workflows and visual direction.

**Architecture:** Add thin token-backed primitives in `frontend/src/ui` for page cards, control bars, buttons, segmented controls, page states, and definition rows. Adopt them first in low-risk feature routes, then make shallow mechanical replacements in Heatmap and Screener without changing their data flow or layout contracts.

**Tech Stack:** React 18, TypeScript, Tailwind CSS token classes, Vitest, React Testing Library, Vite.

## Global Constraints

- Follow `DESIGN.md`; do not introduce a new visual direction.
- No backend, API, store, or data model changes.
- No chart canvas policy changes.
- No large UX redesign of Screener, Heatmap, Capture, Inventory, Settings, Live, or Study.
- Keep extracted components thin: structure and styling only, no feature behavior.
- Preserve route-specific sizing where it encodes layout behavior, especially splitters, tables, drag/drop, and chart-adjacent layout math.

---

## File Structure

- Create `frontend/src/ui/PageShell.tsx`: shared primitives `PanelCard`, `ControlBar`, `ToolbarButton`, `SegmentedControl`, `PageState`, and `DefinitionRow`.
- Create `frontend/src/ui/PageShell.test.tsx`: class contract and accessible behavior tests for the primitives.
- Modify `frontend/src/pages/Settings.tsx`: adopt `PageContainer`, `PanelCard`, `ToolbarButton`, and `DefinitionRow`.
- Modify `frontend/src/pages/Settings.test.tsx`: assert the page no longer renders a redundant `Settings` heading and still renders Symbol Master behavior.
- Modify `frontend/src/pages/Capture.tsx`: replace direct section card classes with `PanelCard`, preserving splitter grid.
- Modify `frontend/src/pages/Capture.test.tsx`: assert the two capture panels still render.
- Modify `frontend/src/pages/Inventory.tsx`: normalize loading/empty states through `PageContainer` and `PageState`.
- Modify `frontend/src/pages/Heatmap.tsx`: adopt `PageState`, `ControlBar`, `ToolbarButton`, and `SegmentedControl` for the header/control row only.
- Modify `frontend/src/pages/Heatmap.test.tsx`: assert sorting and row click behavior stay intact.
- Modify `frontend/src/pages/Screener.tsx`: shallowly adopt `ControlBar` and `ToolbarButton` in the top action row only.
- Modify `frontend/src/pages/Screener.test.tsx`: keep existing workflow tests passing; add one shared top-action button assertion.

---

### Task 1: Add Shared Page Primitives

**Files:**
- Create: `frontend/src/ui/PageShell.tsx`
- Create: `frontend/src/ui/PageShell.test.tsx`

**Interfaces:**
- Produces:
  - `PanelCard(props: { as?: 'div' | 'section' | 'article'; className?: string; children: ReactNode; style?: CSSProperties }): JSX.Element`
  - `ControlBar(props: { className?: string; children: ReactNode }): JSX.Element`
  - `ToolbarButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'secondary' | 'primary' | 'destructive' }): JSX.Element`
  - `SegmentedControl(props: { 'aria-label': string; className?: string; children: ReactNode }): JSX.Element`
  - `PageState(props: { tone?: 'neutral' | 'error' | 'warn'; children: ReactNode; className?: string }): JSX.Element`
  - `DefinitionRow(props: { label: ReactNode; value: ReactNode; className?: string }): JSX.Element`
- Consumes: React, existing Tailwind token classes.

- [ ] **Step 1: Write the failing primitive tests**

Add `frontend/src/ui/PageShell.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ControlBar,
  DefinitionRow,
  PageState,
  PanelCard,
  SegmentedControl,
  ToolbarButton,
} from './PageShell';

describe('PageShell primitives', () => {
  it('renders a token-backed panel card and merges caller classes', () => {
    render(<PanelCard className="min-h-0">body</PanelCard>);
    const panel = screen.getByText('body');
    expect(panel).toHaveClass('bg-bg-card');
    expect(panel).toHaveClass('border');
    expect(panel).toHaveClass('rounded-lg');
    expect(panel).toHaveClass('min-h-0');
  });

  it('can render PanelCard as a section', () => {
    render(<PanelCard as="section">section body</PanelCard>);
    expect(screen.getByText('section body').tagName).toBe('SECTION');
  });

  it('renders control bars and toolbar button tones', () => {
    render(
      <ControlBar>
        <ToolbarButton>Cancel</ToolbarButton>
        <ToolbarButton tone="primary">Run</ToolbarButton>
        <ToolbarButton tone="destructive">Delete</ToolbarButton>
      </ControlBar>,
    );
    expect(screen.getByText('Cancel').parentElement).toHaveClass('flex');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('bg-bg-input');
    expect(screen.getByRole('button', { name: 'Run' })).toHaveClass('bg-accent');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveStyle({ background: 'var(--error)' });
  });

  it('renders a segmented control with an accessible group label', () => {
    render(
      <SegmentedControl aria-label="정렬">
        <button type="button">A</button>
      </SegmentedControl>,
    );
    expect(screen.getByRole('group', { name: '정렬' })).toHaveClass('bg-bg-input');
  });

  it('renders page states by tone', () => {
    render(
      <>
        <PageState>empty</PageState>
        <PageState tone="error">failed</PageState>
        <PageState tone="warn">warning</PageState>
      </>,
    );
    expect(screen.getByText('empty')).toHaveClass('text-fg-dim');
    expect(screen.getByText('failed')).toHaveClass('text-error');
    expect(screen.getByText('warning')).toHaveStyle({ color: 'var(--warn)' });
  });

  it('renders Settings-style definition rows', () => {
    render(<DefinitionRow label="API URL" value="http://test" />);
    expect(screen.getByText('API URL')).toHaveClass('uppercase');
    expect(screen.getByText('http://test')).toHaveClass('font-mono');
  });
});
```

- [ ] **Step 2: Run the failing primitive tests**

Run:

```bash
cd frontend
npx vitest run src/ui/PageShell.test.tsx
```

Expected: FAIL because `./PageShell` does not exist.

- [ ] **Step 3: Implement the primitives**

Create `frontend/src/ui/PageShell.tsx`:

```tsx
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ElementType,
  ReactNode,
} from 'react';

type PanelCardProps = {
  as?: 'div' | 'section' | 'article';
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

export function PanelCard({ as = 'div', className = '', style, children }: PanelCardProps) {
  const Tag = as as ElementType;
  return (
    <Tag
      className={`bg-bg-card border rounded-lg min-w-0 ${className}`.trim()}
      style={style}
    >
      {children}
    </Tag>
  );
}

export function ControlBar({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 flex items-center gap-md ${className}`.trim()}>
      {children}
    </div>
  );
}

const BUTTON_TONE_CLASS = {
  secondary: 'bg-bg-input border border-border text-fg-dim hover:bg-bg-input-hover hover:text-fg',
  primary: 'bg-accent text-accent-fg font-semibold hover:brightness-110',
  destructive: 'text-fg font-semibold hover:brightness-110',
} as const;

export function ToolbarButton({
  tone = 'secondary',
  className = '',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof BUTTON_TONE_CLASS }) {
  const destructiveStyle = tone === 'destructive'
    ? { background: 'var(--error)', ...style }
    : style;
  return (
    <button
      type="button"
      {...props}
      style={destructiveStyle}
      className={`px-3 py-[7px] rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_TONE_CLASS[tone]} ${className}`.trim()}
    />
  );
}

export function SegmentedControl({
  className = '',
  children,
  ...props
}: { 'aria-label': string; className?: string; children: ReactNode }) {
  return (
    <div
      role="group"
      {...props}
      className={`inline-flex rounded-lg border border-border bg-bg-input overflow-hidden ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function PageState({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: 'neutral' | 'error' | 'warn';
  className?: string;
  children: ReactNode;
}) {
  const toneClass = tone === 'error' ? 'text-error' : tone === 'warn' ? '' : 'text-fg-dim';
  const style = tone === 'warn' ? { color: 'var(--warn)' } : undefined;
  return (
    <div className={`p-md text-sm ${toneClass} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

export function DefinitionRow({
  label,
  value,
  className = '',
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-[120px_1fr] gap-3 items-center ${className}`.trim()}>
      <span className="text-xs uppercase tracking-wider text-fg-dimmer">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run primitive tests**

Run:

```bash
cd frontend
npx vitest run src/ui/PageShell.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/PageShell.tsx frontend/src/ui/PageShell.test.tsx
git commit -m "feat: add shared page shell primitives"
```

---

### Task 2: Align Low-Risk Feature Routes

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`
- Modify: `frontend/src/pages/Settings.test.tsx`
- Modify: `frontend/src/pages/Capture.tsx`
- Modify: `frontend/src/pages/Capture.test.tsx`
- Modify: `frontend/src/pages/Inventory.tsx`

**Interfaces:**
- Consumes: `PanelCard`, `ToolbarButton`, `DefinitionRow`, and `PageState` from `frontend/src/ui/PageShell.tsx`.
- Produces: Settings, Capture, and Inventory routes that use common page-shell primitives without changing behavior.

- [ ] **Step 1: Write failing route-shell assertions**

Update `frontend/src/pages/Settings.test.tsx` inside the existing `describe` block:

```tsx
  it('uses the feature page shell without repeating the nav page title', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'unavailable',
      reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText(/Symbol Master/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    expect(screen.getByText('API URL').closest('.bg-bg-card')).not.toBeNull();
  });
```

Update `frontend/src/pages/Capture.test.tsx` in the first test after the existing assertions:

```tsx
    expect(screen.getByPlaceholderText(/종목/i).closest('.bg-bg-card')).not.toBeNull();
    expect(screen.getByTestId('queue-empty').closest('.bg-bg-card')).not.toBeNull();
```

- [ ] **Step 2: Run the failing route tests**

Run:

```bash
cd frontend
npx vitest run src/pages/Settings.test.tsx src/pages/Capture.test.tsx
```

Expected: Settings shell test FAILS because Settings still uses a custom root and heading. Capture may already pass visually, but the implementation still needs to use `PanelCard`.

- [ ] **Step 3: Refactor Settings**

Modify `frontend/src/pages/Settings.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../config';
import { getSymbolMasterInfo, refreshSymbols } from '../api/symbols';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import { symbolMasterSettingsHints } from '../api/upstream-hints';
import { PageContainer } from '../layout/PageContainer';
import { DefinitionRow, PanelCard, ToolbarButton } from '../ui/PageShell';

const VERSION = 'v0.1.0';
const SYMBOLS_INFO_QUERY_KEY = ['symbols', 'info'] as const;

function formatRelative(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'Never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hour ago`;
  return `${Math.floor(delta / 86_400_000)} days ago`;
}

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageContainer className="grid grid-cols-[minmax(0,42rem)] content-start">
      <PanelCard as="section" className="p-md flex flex-col gap-md text-sm">
        <DefinitionRow label="API URL" value={config?.api_url ?? '…'} />
        <DefinitionRow label="Version" value={VERSION} />
        <SymbolMasterSection />
        <p className="text-xs text-fg-dimmer pt-sm border-t border-border">
          편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
        </p>
      </PanelCard>
    </PageContainer>
  );
}

function SymbolMasterSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: SYMBOLS_INFO_QUERY_KEY,
    queryFn: getSymbolMasterInfo,
    refetchOnWindowFocus: false,
  });
  const [updating, setUpdating] = useState(false);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await refreshSymbols();
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_INFO_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_QUERY_KEY });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className="space-y-2 pt-md border-t border-border">
      <h3 className="text-sm font-semibold">Symbol Master</h3>
      <DefinitionRow label="Items" value={data ? data.count.toLocaleString() : (isLoading ? '…' : '0')} />
      <DefinitionRow label="Last fetched" value={formatRelative(data?.fetched_at_ms)} />
      <DefinitionRow label="Status" value={data?.status ?? '…'} />
      {data?.reason && (
        <div className="text-xs text-error">{symbolMasterSettingsHints[data.reason]}</div>
      )}
      <ToolbarButton
        onClick={handleUpdate}
        disabled={updating || isLoading}
        className="mt-2"
      >
        {updating ? 'Updating… (~30-120s)' : 'Update Now'}
      </ToolbarButton>
    </section>
  );
}
```

- [ ] **Step 4: Refactor Capture cards**

Modify `frontend/src/pages/Capture.tsx` imports and sections:

```tsx
import { PanelCard } from '../ui/PageShell';
```

Replace the left section:

```tsx
      <PanelCard as="section" className="p-md overflow-y-auto">
        <CaptureForm referenceYear={year} referenceMonth={month} initialCode={initialCode} />
      </PanelCard>
```

Replace the right section:

```tsx
      <PanelCard as="section" className="p-md flex flex-col min-h-0 min-w-0">
        <CaptureQueue />
      </PanelCard>
```

Do not change the `PageContainer` grid, splitter width, `leftPct`, storage key, or nudge logic.

- [ ] **Step 5: Refactor Inventory states**

Modify `frontend/src/pages/Inventory.tsx` imports:

```tsx
import { PageContainer } from '../layout/PageContainer';
import { PageState } from '../ui/PageShell';
```

Replace early returns:

```tsx
  if (isLoading) {
    return (
      <PageContainer>
        <PageState>Loading inventory…</PageState>
      </PageContainer>
    );
  }
  if (!data || data.captures.length === 0) {
    return (
      <PageContainer>
        <PageState>캡처된 데이터가 없습니다.</PageState>
      </PageContainer>
    );
  }
```

Keep the existing loaded `PageContainer` grid and child components unchanged.

- [ ] **Step 6: Run low-risk route tests**

Run:

```bash
cd frontend
npx vitest run src/ui/PageShell.test.tsx src/pages/Settings.test.tsx src/pages/Capture.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ui/PageShell.tsx frontend/src/ui/PageShell.test.tsx frontend/src/pages/Settings.tsx frontend/src/pages/Settings.test.tsx frontend/src/pages/Capture.tsx frontend/src/pages/Capture.test.tsx frontend/src/pages/Inventory.tsx
git commit -m "refactor: align low-risk feature page shells"
```

---

### Task 3: Apply Shallow Controls to Heatmap and Screener

**Files:**
- Modify: `frontend/src/pages/Heatmap.tsx`
- Modify: `frontend/src/pages/Heatmap.test.tsx`
- Modify: `frontend/src/pages/Screener.tsx`
- Modify: `frontend/src/pages/Screener.test.tsx`

**Interfaces:**
- Consumes: `ControlBar`, `ToolbarButton`, `SegmentedControl`, and `PageState` from `frontend/src/ui/PageShell.tsx`.
- Produces: Heatmap and Screener using shared shell primitives only where the replacement is mechanical.

- [ ] **Step 1: Write shallow behavior-preservation assertions**

Update `frontend/src/pages/Heatmap.test.tsx` in the first test after the existing assertions:

```tsx
  expect(screen.getByRole('group', { name: '행 정렬' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '그룹 정렬' })).toBeInTheDocument();
```

Update `frontend/src/pages/Screener.test.tsx` by adding this focused top-action assertion:

```tsx
it('renders shared top action buttons without changing the screener workflow', async () => {
  renderPage();
  expect(await screen.findByRole('button', { name: /조회/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /저장/ })).toHaveClass('bg-bg-input');
});
```

`frontend/src/pages/Screener.test.tsx` already defines `renderPage()`, so use that helper directly.

- [ ] **Step 2: Run the targeted tests before implementation**

Run:

```bash
cd frontend
npx vitest run src/pages/Heatmap.test.tsx src/pages/Screener.test.tsx
```

Expected: Heatmap FAILS because the segmented control groups do not yet expose the new group labels. Screener may fail if the existing button class differs.

- [ ] **Step 3: Refactor Heatmap header controls**

Modify `frontend/src/pages/Heatmap.tsx` imports:

```tsx
import { ControlBar, PageState, SegmentedControl, ToolbarButton } from '../ui/PageShell';
```

Replace early returns:

```tsx
  if (isLoading) return <PageState>히트맵 불러오는 중…</PageState>;
  if (error) return <PageState tone="error">히트맵을 불러오지 못했습니다.</PageState>;
  if (entries.length === 0) return <PageState>히트맵이 비어 있습니다.</PageState>;
```

Replace the existing header's outer control layout with:

```tsx
      <header className="flex items-center gap-3 px-3 py-2 bg-bg-subtle border-b border-border-strong flex-none">
        <span className="text-md font-semibold text-fg">히트맵</span>
        {phase && <span className="text-xs font-mono text-fg-dim">{PHASE_LABEL[phase] ?? phase}</span>}
        <span className="text-xs font-mono text-fg-dimmer">{updated} 갱신 · {visibleCount}종목</span>
        <div className="flex-1" />
        <ControlBar className="gap-sm">
          <ToolbarButton onClick={() => { void refetch(); }}>
            새로고침
          </ToolbarButton>
          <span className="flex items-center gap-1 text-xs">
            <span className="text-fg-dim">행</span>
            <SegmentedControl aria-label="행 정렬" className="rounded">
              <button
                type="button"
                aria-label="행을 등락률 높은 순으로"
                onClick={() => setSortMode('change')}
                className={segBtn(sortMode === 'change')}
              >등락률 ↓</button>
              <button
                type="button"
                aria-label="행 수동 순서"
                onClick={() => setSortMode('manual')}
                className={segBtn(sortMode === 'manual')}
              >수동</button>
            </SegmentedControl>
          </span>
          <span className="flex items-center gap-1 text-xs">
            <span className="text-fg-dim">그룹</span>
            <SegmentedControl aria-label="그룹 정렬" className="rounded">
              <button
                type="button"
                aria-label="그룹을 평균 등락률 높은 순으로"
                onClick={() => setGroupSort('desc')}
                className={segBtn(groupSort === 'desc')}
              >등락률 ↓</button>
              <button
                type="button"
                aria-label="그룹을 평균 등락률 낮은 순으로"
                onClick={() => setGroupSort('asc')}
                className={segBtn(groupSort === 'asc')}
              >등락률 ↑</button>
              <button
                type="button"
                aria-label="그룹 수동 순서"
                onClick={() => setGroupSort('manual')}
                className={segBtn(groupSort === 'manual')}
              >수동</button>
            </SegmentedControl>
          </span>
        </ControlBar>
      </header>
```

Keep `segBtn` unchanged unless TypeScript requires a tiny class adjustment. Do not change board rendering, sorting functions, row click handlers, DnD behavior, or `SectorTempStrip`.

- [ ] **Step 4: Refactor Screener top action buttons shallowly**

Modify `frontend/src/pages/Screener.tsx` imports:

```tsx
import { ControlBar, ToolbarButton } from '../ui/PageShell';
```

In the top card, replace mechanically repeated top-row button classes with `ToolbarButton`:

```tsx
        <ControlBar className="gap-sm">
          <ToolbarButton
            onClick={() => void handleSave()}
            disabled={!editor.dirty || saving}
          >
            저장
          </ToolbarButton>
          <ToolbarButton
            onClick={handleRevert}
            disabled={!editor.dirty}
          >
            되돌리기
          </ToolbarButton>
          <div className="inline-flex rounded-lg border border-border bg-bg-input overflow-hidden" role="group" aria-label="스크리너 기준">
            {/* keep the existing basis buttons unchanged */}
          </div>
          <ToolbarButton
            tone="primary"
            onClick={() => void screener.run()}
            disabled={!canRun || screener.isFetching}
            className="px-lg py-sm text-base"
          >
            조회
          </ToolbarButton>
          <ToolbarButton
            onClick={() => void update.run()}
            disabled={!canUpdate}
          >
            갱신
          </ToolbarButton>
        </ControlBar>
```

Use the existing handler names from `Screener.tsx`; if they differ, keep the current handlers and only replace the shell class. Do not restructure the three-column grid or move the result table.

- [ ] **Step 5: Run Heatmap and Screener tests**

Run:

```bash
cd frontend
npx vitest run src/pages/Heatmap.test.tsx src/pages/Screener.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run final verification**

Run:

```bash
cd frontend
npx vitest run src/ui/PageShell.test.tsx src/layout/PageContainer.test.tsx src/pages/Settings.test.tsx src/pages/Capture.test.tsx src/pages/Heatmap.test.tsx src/pages/Screener.test.tsx
npm run build
```

Expected: all tests PASS and build exits with code 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.test.tsx frontend/src/pages/Screener.tsx frontend/src/pages/Screener.test.tsx
git commit -m "refactor: share route controls across feature pages"
```

---

## Self-Review

- Spec coverage: shared primitives, low-risk feature route alignment, shallow Screener/Heatmap adoption, non-goals, and verification are covered by Tasks 1-3.
- Placeholder scan: no red-flag placeholder patterns remain.
- Type consistency: primitive names and prop signatures are consistent across the tasks.
- Scope check: this remains Phase 1 only; user-facing UX redesign is explicitly excluded.
