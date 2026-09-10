import { expect, test, type WebSocketRoute } from '@playwright/test';
import { apiPrefix } from './helpers/apiRoutes';

const snapshot = (revision: number, degraded: boolean) => ({
  active: [], queued: [], done: [], paused: false, max_concurrent: 3,
  queue_owned: true, persistence_degraded: degraded, last_persisted_at_ms: null,
  persistence_epoch: 'e2e-server', persistence_revision: revision,
});

const push = (socket: WebSocketRoute, revision: number, degraded: boolean) => socket.send(JSON.stringify({
  ch: 'event', data: { type: 'capture_queue_persistence', ...snapshot(revision, degraded) },
}));

test('queue warning survives delayed HTTP and stale push, then clears on recovery', async ({ page }) => {
  let socket: WebSocketRoute | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.routeWebSocket('**/api/ws', (ws) => { socket = ws; });
  await page.route(apiPrefix('captures/queue'), async (route) => {
    requested = true;
    await gate;
    await route.fulfill({ json: snapshot(1, false) });
  });
  await page.goto('/capture');
  await expect.poll(() => socket !== undefined && requested).toBe(true);
  push(socket!, 2, true);
  const received = page.waitForResponse((r) => r.url().includes('/api/captures/queue'));
  release();
  await received;
  const warning = page.getByTestId('queue-persistence-banner');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('재시작하면 일부 작업이 복원되지 않을 수 있습니다');
  push(socket!, 3, false);
  await expect(warning).toHaveCount(0);
  push(socket!, 2, true);
  await expect(page.getByTestId('queue-empty')).toBeVisible();
  await expect(warning).toHaveCount(0);
});

test('queue changes made while disconnected appear on reconnect', async ({ page }) => {
  let socket: WebSocketRoute | undefined;
  let revision = 1;
  let connections = 0;
  await page.routeWebSocket('**/api/ws', (ws) => { socket = ws; connections += 1; });
  await page.route(apiPrefix('captures/queue'), (route) => route.fulfill({ json: snapshot(revision, revision > 1) }));
  await page.goto('/capture');
  await expect(page.getByTestId('queue-empty')).toBeVisible();
  await expect.poll(() => connections).toBe(1);
  revision = 2;
  socket!.close();
  await expect.poll(() => connections).toBe(2);
  await expect(page.getByTestId('queue-persistence-banner')).toBeVisible();
});
