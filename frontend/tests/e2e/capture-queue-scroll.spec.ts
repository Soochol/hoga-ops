import { expect, test, type Page, type Route } from '@playwright/test';

const API = 'http://localhost:8080';

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  test.use({
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  });
}

function queueItem(index: number) {
  return {
    item_id: `q-${index}`,
    code: '005930',
    date: `202606${String((index % 28) + 1).padStart(2, '0')}`,
    phase: 'queued',
    force_retry: false,
    pause_origin: false,
    enqueued_at_ms: index,
    started_at_ms: null,
    progress: null,
    result: null,
    error: null,
    skip_reason: null,
    attempt: 1,
  };
}

async function installCaptureQueueMocks(page: Page) {
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route(`${API}/api/captures/queue*`, (route) =>
    json(route, {
      active: [],
      queued: Array.from({ length: 260 }, (_, i) => queueItem(i)),
      done: [],
      paused: false,
      max_concurrent: 3,
    }),
  );
  await page.route(`${API}/api/symbols/all*`, (route) =>
    json(route, {
      symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0 }],
      status: 'fresh',
      fetched_at_ms: 1,
    }),
  );
  await page.route(`${API}/api/stock-dates*`, (route) => json(route, []));
  await page.route(`${API}/api/calendar*`, (route) => json(route, { cells: [], holidays: [] }));
  await page.routeWebSocket('**/api/ws', (ws) => {
    ws.onMessage(() => {
      ws.send(JSON.stringify({ ch: 'heartbeat', t_ms: Date.now() }));
    });
  });
}

test('capture queue keeps long launcher lists scrollable inside the right card', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installCaptureQueueMocks(page);

  await page.goto('/capture');
  await expect(page.getByTestId('queue-list')).toBeVisible();

  const before = await page.evaluate(() => {
    const queue = document.querySelector('[data-testid="queue-list"]') as HTMLElement | null;
    const pane = document.querySelector('[data-testid="capture-queue-pane"]') as HTMLElement | null;
    if (!queue || !pane) throw new Error('queue or pane missing');
    return {
      queueClientHeight: queue.clientHeight,
      queueScrollHeight: queue.scrollHeight,
      paneClientHeight: pane.clientHeight,
      paneScrollHeight: pane.scrollHeight,
      queueScrollTop: queue.scrollTop,
    };
  });

  expect(before.queueScrollHeight).toBeGreaterThan(before.queueClientHeight);
  expect(before.paneScrollHeight).toBe(before.paneClientHeight);

  await page.getByTestId('queue-list').evaluate((el) => {
    el.scrollTop = 500;
  });

  await expect.poll(async () =>
    page.getByTestId('queue-list').evaluate((el) => (el as HTMLElement).scrollTop),
  ).toBeGreaterThan(before.queueScrollTop);
});
