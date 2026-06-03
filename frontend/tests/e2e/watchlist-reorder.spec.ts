// frontend/tests/e2e/watchlist-reorder.spec.ts
//
// E2E for the Watchlist Panel drag-reorder (ADR-0057): this is the layer the
// jsdom unit tests deliberately mock away — a REAL dnd-kit PointerSensor drag
// (past the 8px activation) → closestCenter collision → onDragEnd → reorderCodes
// → PUT /api/watchlist/order → optimistic DOM reshuffle → persistence on reload.
//
// Backend-independent (like live-smoke.spec.ts): every endpoint the page touches
// is mocked via page.route, so the panel never hits the real :8000 backend. The
// GET /api/watchlist mock is STATEFUL — the PUT /order mock mutates the order it
// returns, so the post-mutation invalidate-refetch (and the reload) observe the
// persisted order rather than snapping back.

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

// System Chrome — this worktree's OS is outside Playwright's bundled-Chromium
// matrix (same rationale as live-smoke.spec.ts).
test.use({ channel: 'chrome' });

const API = 'http://localhost:8000';

interface Entry {
  code: string;
  name: string;
  registered_at_kst_date: string;
  last_success_date: string | null;
}

const ENTRIES: Entry[] = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null },
  { code: '035720', name: '카카오', registered_at_kst_date: '20260527', last_success_date: null },
];

test.describe('Watchlist Panel drag-reorder', () => {
  test('drag past 8px reorders, PUTs the new order, and persists across reload', async ({ page }) => {
    // Scaffolding mocks make /live render without the real backend.
    await installLiveMocks(page);

    // Stateful watchlist order, mutated by the PUT mock — mirrors reorder_entries.
    let order = ENTRIES.map((e) => e.code);
    let lastPutCodes: string[] | null = null;
    const entriesIn = (codes: string[]) => codes.map((c) => ENTRIES.find((e) => e.code === c)!);
    const json = (route: import('@playwright/test').Route, body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    // Live Quote overlay → empty (rows render 현재가 as '—'). Registered after
    // installLiveMocks so it wins; installLiveMocks doesn't cover /api/live/quotes.
    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));

    // PUT /order — capture the new code order, mutate server state, echo it back.
    // Registered LAST so it wins over installLiveMocks's `**/api/watchlist*`.
    await page.route(`${API}/api/watchlist/order`, async (route) => {
      const codes = (JSON.parse(route.request().postData() || '{}').codes ?? []) as string[];
      lastPutCodes = codes;
      order = codes;
      return json(route, { entries: entriesIn(order), next_run_at_ms: 0 });
    });
    // GET /api/watchlist — reflects the current (possibly reordered) state.
    await page.route(`${API}/api/watchlist`, (r) => json(r, { entries: entriesIn(order), next_run_at_ms: 0 }));

    const codesInDom = () =>
      page.locator('[data-testid^="watchlist-row-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('watchlist-row-', '')),
      );

    const openPanelIfClosed = async () => {
      const firstRow = page.getByTestId('watchlist-row-005930');
      if (!(await firstRow.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
      }
      await expect(firstRow).toBeVisible();
    };

    await page.goto('/live');
    await openPanelIfClosed();

    // Initial order.
    await expect(page.getByTestId('watchlist-row-035720')).toBeVisible();
    expect(await codesInDom()).toEqual(['005930', '000660', '035720']);

    // Drag the first row (005930) down onto the third (035720). arrayMove(0→2)
    // ⇒ ['000660', '035720', '005930'].
    const from = await page.getByTestId('watchlist-row-005930').boundingBox();
    const to = await page.getByTestId('watchlist-row-035720').boundingBox();
    if (!from || !to) throw new Error('watchlist row has no bounding box');
    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;
    const tx = to.x + to.width / 2;
    const ty = to.y + to.height / 2;

    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 10, { steps: 5 }); // cross the 8px activation distance
    await page.mouse.move(tx, ty, { steps: 15 }); // travel onto the target → closestCenter `over`
    await page.mouse.move(tx, ty + 2, { steps: 2 }); // settle on target
    await page.mouse.up();

    // The drag fired exactly the expected new order to the backend...
    await expect.poll(() => lastPutCodes).toEqual(['000660', '035720', '005930']);
    // ...and the optimistic cache reshuffled the visible rows immediately.
    await expect.poll(codesInDom).toEqual(['000660', '035720', '005930']);

    // Persistence: reload — the stateful GET serves the new order, so it holds.
    await page.reload();
    await openPanelIfClosed();
    expect(await codesInDom()).toEqual(['000660', '035720', '005930']);
  });
});
