import { expect, test, type Page, type Route } from '@playwright/test';
import { apiPrefix } from './helpers/apiRoutes';

// 호스트를 박지 않는다 — 'http://localhost:8080' 은 API 주소가 아니라
// config.ts 의 DEFAULT_CONFIG **폴백**이었다. /config.json 이 정상 제공되면
// 앱은 진짜 백엔드로 가고 이 모킹은 한 건도 안 걸린다(2026-07-30 실측).

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

  await page.route(apiPrefix('captures/queue'), (route) =>
    json(route, {
      active: [],
      queued: Array.from({ length: 260 }, (_, i) => queueItem(i)),
      done: [],
      paused: false,
      max_concurrent: 3,
    }),
  );
  await page.route(apiPrefix('symbols/all'), (route) =>
    json(route, {
      symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0 }],
      status: 'fresh',
      fetched_at_ms: 1,
    }),
  );
  await page.route(apiPrefix('stock-dates'), (route) => json(route, []));
  await page.route(apiPrefix('calendar'), (route) => json(route, { cells: [], holidays: [] }));
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

  // **가상화가 켜지면 스크롤 컨테이너가 안쪽으로 들어간다.** 바깥 `queue-list` 는
  // 껍데기라 scrollHeight 가 clientHeight 와 같아지고(실측 701=701), 실제 스크롤은
  // `queue-virtual-scroller`(안쪽, scrollHeight 9500)가 받는다. 260건이면 가상화가
  // 켜지므로 그쪽을 잰다. 가상화가 꺼진 경우엔 없으므로 바깥으로 폴백한다.
  // 셀렉터 목록(`A, B`)은 **우선순위가 아니라 문서 순서**로 고르므로 바깥이 먼저 잡힌다
  // — 안쪽을 먼저 찾고 없을 때만 폴백한다.
  const scroller = (await page.getByTestId('queue-virtual-scroller').count())
    ? page.getByTestId('queue-virtual-scroller')
    : page.getByTestId('queue-list');
  const before = await scroller.evaluate((queue) => {
    const pane = document.querySelector('[data-testid="capture-queue-pane"]') as HTMLElement | null;
    if (!pane) throw new Error('pane missing');
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

  await scroller.evaluate((el) => { (el as HTMLElement).scrollTop = 500; });

  await expect.poll(async () =>
    scroller.evaluate((el) => (el as HTMLElement).scrollTop),
  ).toBeGreaterThan(before.queueScrollTop);
});
