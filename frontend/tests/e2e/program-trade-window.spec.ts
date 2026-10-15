import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';

const CODE = '098460';

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'KRX' }));
    if (!sessionStorage.getItem('live.workspace.v1')) {
      sessionStorage.setItem('live.workspace.v1', JSON.stringify({
        schema_version: 2,
        windows: [{ id: 'trade-only', kind: 'trade', group: 1, rect: { x: 0, y: 0, w: 0.22, h: 0.45 } }],
        zOrder: ['trade-only'], groupSymbols: { 1: { code: '098460', name: '고영' } },
      }));
    }
  });
  await installLiveMocks(page);
  const ws = await installLiveWs(page);
  await page.route(/^https?:\/\/[^/]+\/api\/live\/series\?/, route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: {
      code: params.get('code'), date: params.get('date'), session_open_ms: Date.now(), session_close_ms: null, is_open: true,
      snapshots: [], trades: [], brokers: [], programs: [], after_hours: [], expected: [], ask_peak_today: null, bid_peak_today: null,
    } });
  });
  await page.goto('/live');
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-program-trade').click();
  const window = page.getByTestId('program-trade-window');
  await expect(window).toBeVisible();
  await ws.waitForSubscribe(CODE);
  return { ws, window };
}

test('프로그램 체결은 차트 없이 세 열로 수신분 증감을 표시하고 거래소·새로고침을 분리한다', async ({ page }, testInfo) => {
  const { ws, window } = await setup(page);
  const time = Date.now();
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', t_ms: time, price: 125500, net_qty: 500000, event_delta_qty: 1200 });
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', t_ms: time + 1, price: 125400, net_qty: 900000, event_delta_qty: -300 });
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', t_ms: time + 2, price: 125300, event_delta_qty: 0 });
  ws.pushLive(CODE, { kind: 'program', venue: 'NXT', t_ms: time + 3, price: 125200, event_delta_qty: 777 });
  const table = window.getByRole('table', { name: '프로그램 체결 내역' });
  await expect(table.getByRole('columnheader')).toHaveText(['수신시각', '현재가(원)', '순매수 증감(주)']);
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(1)).toContainText('125,400−300');
  await expect(table.getByText('+1,200')).toHaveClass(/text-price-up/);
  await expect(table.getByText('−300')).toHaveClass(/text-price-down/);
  await expect(window.getByText('최근 체결')).toHaveCount(0);
  await window.screenshot({ path: testInfo.outputPath('program-trade-window.png') });
  await page.getByTestId('live-venue-picker').click();
  await page.getByTestId('live-venue-option-NXT').click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('+777')).toBeVisible();
  await expect(table.getByText('−300')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('program-trade-window')).toBeVisible();
});

test('프로그램 체결은 최신 200행만 유지하고 오래된 누적 payload를 증감으로 사용하지 않는다', async ({ page }) => {
  const { ws, window } = await setup(page);
  const time = Date.now();
  ws.pushLive(CODE, { kind: 'program', venue: 'KRX', t_ms: time, price: 125500, net_qty: 999999 });
  await expect(window.getByRole('table')).toHaveCount(0);
  ws.pushBatch(CODE, Array.from({ length: 205 }, (_, i) => ({ kind: 'program', venue: 'KRX', t_ms: time + i + 1,
    price: 125500, event_delta_qty: i + 1 })), []);
  const table = window.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(201);
  await expect(table.getByRole('row').nth(1)).toContainText('+205');
  await expect(table.getByRole('row').last()).toContainText('+6');
  await expect(table.getByText('+5', { exact: true })).toHaveCount(0);
});
