import { expect, test, type WebSocketRoute } from '@playwright/test';
import { apiPrefix } from './helpers/apiRoutes';

test('queue persistence warning clears on recovery push without a page reload', async ({ page }) => {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/ws', (ws) => { socket = ws; });
  await page.route(apiPrefix('captures/queue'), (route) => route.fulfill({
    json: {
      active: [], queued: [], done: [], paused: false, max_concurrent: 3,
      queue_owned: true, persistence_degraded: true, last_persisted_at_ms: null,
    },
  }));
  await page.goto('/capture');
  const warning = page.getByTestId('queue-persistence-banner');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('재시작하면 일부 작업이 복원되지 않을 수 있습니다');
  await expect(warning).toContainText('저장 성공 기록이 없습니다');
  await expect.poll(() => socket !== undefined).toBe(true);
  socket!.send(JSON.stringify({
    ch: 'event',
    data: { type: 'capture_queue_persistence', persistence_degraded: false, last_persisted_at_ms: 1789010000000 },
  }));
  await expect(warning).toHaveCount(0);
  await expect(page.getByTestId('queue-empty')).toBeVisible();
});
