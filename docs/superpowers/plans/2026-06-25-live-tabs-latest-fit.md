# Live Tabs Latest-Fit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `/live` tab switching so tabs retain instrument and timeframe only, while chart position always resets to the latest-candle default fit.

**Architecture:** Keep the existing Live Tab projection model, but stop using tab viewport and historical scrollback as tab-restored state. `/live` will no longer snapshot outgoing viewport, pass `restoreViewport`, or persist pan-driven `historicalFromDate` into tabs. Existing persisted `viewport` and `historicalFromDate` fields remain tolerated for compatibility.

**Tech Stack:** React, TypeScript, Zustand, Vitest, lightweight-charts.

## Global Constraints

- Preserve tab identity fields: `instrument`, `code`, `label`.
- Preserve selected timeframe per tab, including minute frames and `D`/`W`/`M`.
- Stop preserving `viewport`, `historicalFromDate`, zoom, and horizontal scroll position during `/live` tab switching.
- Keep existing persisted `live.tabs.v2` records loadable even if they contain `viewport` and `historicalFromDate`.
- Retain chart viewport capture callback for study-view save flows.

---

### Task 1: Stop Restoring Live Tab Position

**Files:**
- Modify: `frontend/src/state/liveTabProjection.ts`
- Modify: `frontend/src/state/liveTabs.ts`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/state/liveTabs.test.ts`
- Modify: `frontend/src/live/LivePage.test.tsx`

**Interfaces:**
- Consumes: `projectTabToActiveView(tab, currentPageTimeframe): ActiveViewProjection`
- Consumes: `mirrorPageViewToActiveTab(tabs, activeTabId, page): LiveTab[]`
- Produces: `projectTabToActiveView` always returns `historicalFromDate: null` for tab focus.
- Produces: `mirrorPageViewToActiveTab` mirrors only `candleTimeframe` onto active tab.

- [ ] **Step 1: Write failing projection tests**

Add tests in `frontend/src/state/liveTabs.test.ts` asserting that a tab with stored `historicalFromDate` focuses with `useLivePageStore.historicalFromDate === null`, and that a pan-only `extendHistoricalRange()` does not update the active tab's `historicalFromDate`.

Use this test shape:

```ts
it('focusTab ignores stored historicalFromDate so tab switches start at latest fit', () => {
  openTab('005930', '삼성전자');
  const tabId = useLiveTabsStore.getState().tabs[0].id;
  useLiveTabsStore.setState({
    tabs: useLiveTabsStore.getState().tabs.map((t) => (
      t.id === tabId ? { ...t, historicalFromDate: '20260601' } : t
    )),
  });

  useLivePageStore.setState({ historicalFromDate: '20260501' });
  useLiveTabsStore.getState().focusTab(tabId);

  expect(useLivePageStore.getState().historicalFromDate).toBeNull();
});

it('pan changes are not mirrored into the active tab', () => {
  openTab('005930', '삼성전자');
  useLivePageStore.getState().extendHistoricalRange('20260601');

  expect(useLiveTabsStore.getState().tabs[0].historicalFromDate).toBeNull();
});
```

- [ ] **Step 2: Run projection tests and verify failure**

Run:

```bash
cd frontend
npm test -- --run src/state/liveTabs.test.ts
```

Expected: FAIL because `projectTabToActiveView` currently returns the tab's stored `historicalFromDate`, and `mirrorPageViewToActiveTab` mirrors pan changes.

- [ ] **Step 3: Implement projection behavior**

Change `frontend/src/state/liveTabProjection.ts`:

```ts
export function projectTabToActiveView(
  tab: LiveTab | null,
  currentPageTimeframe: LiveTimeframe,
): ActiveViewProjection {
  return {
    instrument: tab?.instrument ?? (tab?.code ? stockInstrument(tab.code, tab.label) : null),
    code: tab?.code ?? null,
    timeframe: tab?.timeframe ?? currentPageTimeframe,
    historicalFromDate: null,
  };
}

export function mirrorPageViewToActiveTab(
  tabs: LiveTab[],
  activeTabId: string | null,
  page: PageViewMirror,
): LiveTab[] {
  if (!activeTabId) return tabs;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (!activeTab) return tabs;
  const userChangedTimeframe = page.candleTimeframe !== activeTab.timeframe;
  if (!userChangedTimeframe) return tabs;

  return tabs.map((t) =>
    t.id === activeTabId
      ? {
          ...t,
          timeframe: page.candleTimeframe,
          historicalFromDate: null,
          viewport: null,
        }
      : t,
  );
}
```

- [ ] **Step 4: Stop live tab viewport snapshot/restore**

Change `frontend/src/state/liveTabs.ts` so `openSymbolInNewTab`, `addBlankTab`, and `focusTab` do not call `snapshotActiveViewport()`. Leave `registerViewportCapture` and `saveViewportToActiveTab` exported for now so `LiveChartRoot` and study-save flows remain compatible during this behavior change.

Change `frontend/src/live/LivePage.tsx` so it no longer computes active tab `restoreViewport`, and pass `restoreViewport={null}` and `persistLiveViewport={false}` to `LiveWorkarea`.

Add `persistLiveViewport?: boolean` to `LiveWorkarea` props and thread it through to `LiveChartRoot`.

- [ ] **Step 5: Update page tests**

Update `frontend/src/live/LivePage.test.tsx` tests that expect the active tab viewport to be passed into `LiveChartRoot`. Replace that expectation with:

```ts
expect(screen.getByTestId('live-chart-root')).toBeInTheDocument();
const chartProps = vi.mocked(LiveChartRoot).mock.calls.at(-1)?.[0];
expect(chartProps?.restoreViewport).toBeNull();
expect(chartProps?.persistLiveViewport).toBe(false);
```

If `LiveChartRoot` is not mocked in that file, use the existing local helper pattern in the test file to inspect the rendered props instead of introducing a new mocking style.

- [ ] **Step 6: Run focused frontend tests**

Run:

```bash
cd frontend
npm test -- --run src/state/liveTabs.test.ts src/live/LivePage.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Run relevant chart tests**

Run:

```bash
cd frontend
npm test -- --run src/live/LiveChartRoot.test.tsx
```

Expected: PASS. Existing direct `LiveChartRoot` tests may still cover restore behavior as a component capability; `/live` simply opts out.

- [ ] **Step 8: Commit implementation**

Run:

```bash
git add frontend/src/state/liveTabProjection.ts frontend/src/state/liveTabs.ts frontend/src/live/LivePage.tsx frontend/src/live/LiveWorkarea.tsx frontend/src/state/liveTabs.test.ts frontend/src/live/LivePage.test.tsx
git commit -m "fix: reset live tabs to latest candles on focus"
```

