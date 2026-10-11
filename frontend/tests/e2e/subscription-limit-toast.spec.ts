import { test, expect, type WebSocketRoute } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('app reference limits and vendor slot exhaustion show independent recovery guidance', async ({ page }) => {
  await installLiveMocks(page);
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/ws', ws => {
    socket = ws;
    ws.onMessage(message => {
      const msg = JSON.parse(String(message));
      if (msg.action === 'subscribe') ws.send(JSON.stringify({ ch: 'subscribed', code: msg.code }));
    });
  });
  await page.goto('/live?code=098460');
  await expect.poll(() => !!socket).toBe(true);
  socket!.send(JSON.stringify({ ch: 'event', data: { type: 'live_subscription_limit', code: '393890' } }));
  const app = page.getByRole('status', { name: '앱 화면 구독 한도 초과' });
  await expect(app).toContainText('새로고침');
  await expect(page.getByRole('status', { name: '키움 실시간 구독 슬롯 부족' })).toHaveCount(0);
  socket!.send(JSON.stringify({ ch: 'event', data: { type: 'kiwoom_full_house', code: '399720' } }));
  const vendor = page.getByRole('status', { name: '키움 실시간 구독 슬롯 부족' });
  await expect(vendor).toContainText('자동으로 연결');
  await expect(app).toContainText('393890');
  await expect(vendor).toContainText('399720');
  await expect(app).toHaveCSS('opacity', '1');
  await expect(vendor).toHaveCSS('opacity', '1');
  await page.screenshot({ path: '/tmp/hoga-subscription-limit-toasts.png' });
  await app.getByRole('button', { name: '닫기' }).click();
  await expect(app).toHaveCount(0);
  await expect(vendor).toBeVisible();
  // The same rejection does not undo dismissal, a new code does.
  socket!.send(JSON.stringify({ ch: 'event', data: { type: 'live_subscription_limit', code: '393890' } }));
  socket!.send(JSON.stringify({ ch: 'event', data: { type: 'live_subscription_limit', code: '402030' } }));
  await expect(app).toContainText('402030');
  await vendor.getByRole('button', { name: '닫기' }).click();
  await expect(vendor).toHaveCount(0);
  await expect(app).toBeVisible();
});

test('vendor recovery removes only restored codes without reconnecting or clearing the app limit', async ({ page }) => {
  await installLiveMocks(page);
  let socket: WebSocketRoute | undefined;
  let connections = 0;
  await page.routeWebSocket('**/api/ws', ws => {
    socket = ws;
    connections += 1;
    ws.onMessage(message => {
      const msg = JSON.parse(String(message));
      if (msg.action === 'subscribe') ws.send(JSON.stringify({ ch: 'subscribed', code: msg.code }));
    });
  });
  await page.goto('/live?code=098460');
  await expect.poll(() => !!socket).toBe(true);
  const event = (type: string, code: string) => socket!.send(JSON.stringify({ ch: 'event', data: { type, code } }));
  const vendor = page.getByRole('status', { name: '키움 실시간 구독 슬롯 부족' });
  const app = page.getByRole('status', { name: '앱 화면 구독 한도 초과' });
  event('live_subscription_limit', '393890');
  event('kiwoom_full_house', '393890');
  event('kiwoom_full_house', '399720');
  await expect(vendor).toContainText('393890, 399720');
  event('kiwoom_full_house_resolved', '393890');
  await expect(vendor).not.toContainText('393890');
  await expect(vendor).toContainText('399720');
  await expect(app).toContainText('393890');
  event('kiwoom_full_house_resolved', '399720');
  await expect(vendor).toHaveCount(0);
  await expect(app).toBeVisible();
  // A later genuine shortage must reopen even after a dismissed warning recovered.
  event('kiwoom_full_house', '399720');
  await expect(vendor).toBeVisible();
  await vendor.getByRole('button', { name: '닫기' }).click();
  await expect(vendor).toHaveCount(0);
  event('kiwoom_full_house_resolved', '399720');
  event('kiwoom_full_house', '399720');
  await expect(vendor).toBeVisible();
  expect(connections).toBe(1);
});
