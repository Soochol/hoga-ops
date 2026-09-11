import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiPrefix } from './helpers/apiRoutes';

const CODE = '098460';
const close = Date.UTC(2026, 8, 14, 6, 30);

test('expected price expires during the closed phase without another quote response', async ({ page }) => {
  await page.clock.install({ time: close });
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  let requests = 0;
  await page.route(apiPrefix('live/quotes'), route => {
    requests += 1;
    return route.fulfill({ json: {
      phase: 'closed', quotes: [{ code: CODE, price: 30000, change_pct: 0, change_won: 0 }],
    } });
  });
  await page.goto(`/live?code=${CODE}`);
  await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  const row = page.getByTestId(`watchlist-row-${CODE}`);
  await expect(row).toContainText('30,000');
  await ws.waitForSubscribe(CODE);
  ws.pushLive(CODE, {
    kind: 'ob', venue: 'KRX', t_ms: close - 1000,
    expected_price: 36000, expected_qty: 100,
  });
  await expect(row).toContainText('36,000');
  const beforeExpiry = requests;
  await page.clock.runFor(31_000);
  await expect(row).not.toContainText('36,000');
  await expect(row).toContainText('30,000');
  expect(requests).toBe(beforeExpiry);
});
