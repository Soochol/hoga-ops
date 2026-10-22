import { expect, test, type Route } from '@playwright/test';
import type { IndexHeaderQuoteResponse } from '../../src/api/indexHeaderQuote';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

const now = new Date('2026-10-22T10:00:00+09:00').getTime();
function quote(indexId: string, overrides: Partial<IndexHeaderQuoteResponse> = {}): IndexHeaderQuoteResponse {
  return { index_id: indexId, value: 2650.35, change: 32.46, change_rate: 1.24, previous_close: 2617.89,
    trading_date: '20261022', observed_at_ms: now, checked_at_ms: now, market_timezone: 'Asia/Seoul',
    session_status: 'open', refresh_status: 'normal', source: 'kiwoom', delay_unverified: false, ...overrides };
}

test('지수 헤더의 전환·실패·재시도와 좁은 창 조작을 보존한다', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.clock.setFixedTime(now);
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.addInitScript(() => {
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: [{ id: 'index-chart', kind: 'chart', group: 1, chart: { timeframe: 'D' },
        rect: { x: 0, y: 0, w: 1, h: 1 } }], zOrder: ['index-chart'],
      groupSymbols: { 1: { code: 'KOSPI', name: 'KOSPI', kind: 'index' } },
    }));
  });
  await page.route(apiExact('live/index-candles'), route => {
    const p = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { index_id: p.get('index_id'), timeframe: p.get('timeframe'),
      from: p.get('from'), to: p.get('to'), candles: [], data_warnings: [] } });
  });
  let pending: Route | undefined;
  await page.route(apiExact('live/index-header-quote'), async route => {
    const params = new URL(route.request().url()).searchParams;
    const id = params.get('index_id')!;
    if (id === 'KOSDAQ' && !params.has('retry')) { pending = route; return; }
    await route.fulfill({ json: quote(id, id === 'KOSDAQ' ? { value: 850.12, change_rate: -0.58 } : {}) });
  });
  await page.goto('/live?index=KOSPI');
  const win = page.locator('[data-win="index-chart"]');
  const price = win.getByTestId('titlebar-current-price');
  await expect(price).toHaveText('2,650.35');
  await expect(win.getByTestId('titlebar-change')).toHaveText('+1.24%');
  await expect(price).toHaveAttribute('title', /전일 종가 2,617.89/);
  await expect(price).toHaveAttribute('title', /기준 거래일 2026-10-22/);
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore } = await import(path);
    useWorkspaceStore.getState().setWindowSymbol('index-chart', { kind: 'index', code: 'KOSDAQ', name: 'KOSDAQ' });
  });
  await expect(price).toHaveText('—');
  await expect.poll(() => !!pending).toBe(true);
  await pending!.fulfill({ json: quote('KOSDAQ', { value: 850.12, change_rate: -0.58, refresh_status: 'stale' }) });
  await expect(price).toHaveText('850.12');
  await expect(win.getByTestId('titlebar-change')).toHaveText('-0.58%');
  const retry = win.getByRole('button', { name: 'KOSDAQ 시세 다시 조회' });
  await expect(retry).toBeVisible();
  const before = await win.boundingBox();
  await retry.click();
  await expect(retry).toBeHidden();
  expect(await win.boundingBox()).toEqual(before);
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.setState({ windows: store.getState().windows.map((w: WorkspaceWindow) => ({ ...w, rect: { ...w.rect, w: .28 } })) });
  });
  await expect(price).toBeVisible();
  await expect(win.getByTestId('titlebar-change')).toBeHidden();
  for (const label of ['차트 설정', '창 최대화', '항상 위', '종목 고정']) {
    await expect(win.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('index-header-narrow.png') });
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.setState({ windows: store.getState().windows.map((w: WorkspaceWindow) => ({ ...w, rect: { ...w.rect, w: .12 } })) });
  });
  await expect(price).toBeHidden();
  for (const label of ['차트 설정', '창 최대화', '항상 위', '종목 고정']) {
    const button = win.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    const frame = (await win.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(frame.x);
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
  }
});

test('미국 지수의 뉴욕 거래일과 장 종료 시세를 표시한다', async ({ page }, info) => {
  await page.clock.setFixedTime(now);
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.route(apiExact('live/index-header-quote'), route => route.fulfill({ json: quote('SP500', {
    value: 6025.75, change: -15.25, change_rate: -0.25, previous_close: 6041,
    trading_date: '20261021', observed_at_ms: null, market_timezone: 'America/New_York',
    source: 'kis_daily', delay_unverified: true, session_status: 'closed',
  }) }));
  await page.goto('/live?index=SP500');
  const header = page.getByTestId('titlebar-symbol-row').first();
  await expect(header.getByTestId('titlebar-current-price')).toHaveText('6,025.75');
  await expect(header.getByTestId('titlebar-change')).toHaveText('-0.25%');
  await expect(header.getByTestId('titlebar-current-price')).toHaveAttribute('title', /2026-10-21 \(뉴욕 기준\)/);
  await expect(header.getByTestId('titlebar-current-price')).toHaveAttribute('title', /완료된 일봉 종가 기준/);
  await expect(header.getByTestId('titlebar-index-status')).toHaveText('장 종료');
  await page.screenshot({ path: info.outputPath('us-index-header.png') });
});
