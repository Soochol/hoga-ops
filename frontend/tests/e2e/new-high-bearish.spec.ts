import { test, expect } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import type { WorkspaceWindow } from '../../src/state/workspace';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

test('신고가 음봉 시가선 설정·계산·반복 추가·숨김·삭제·복원', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-01T21:00:00+09:00'));
  await installLiveMocks(page);
  const ohlc = [...Array.from({ length: 5 }, () => [100, 101, 99, 100]), [110, 120, 109, 110], [109, 111, 99, 100], [99, 100, 89, 90], [89, 90, 79, 80]];
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
  await page.route(apiExact('live/past-daily-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260901', to: '20261001', venue: 'KRX', source: 'screener_daily', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: ohlc.map(([open, high, low, close], i) => ({ t_ms: Date.parse(`${dates[i]}T09:00:00+09:00`), open, high, low, close, volume: 100 })),
  } }));
  await page.goto('/live?code=098460');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts?.size ?? 0)).toBeGreaterThan(0);
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts'; const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
    store.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: 'D' } }], zOrder: [win.id], maximizedId: null });
    return win.id as string;
  });
  await page.getByTestId('live-indicators-button').click();
  const editor = page.getByTestId('indicator-panel-shell');
  await editor.getByRole('button', { name: '지표 추가', exact: true }).click();
  await editor.getByRole('button', { name: '신고가 음봉 시가선', exact: true }).click();
  const n = editor.getByRole('spinbutton', { name: '신고가 기준 N거래일' });
  const drop = editor.getByRole('spinbutton', { name: '전일 종가 대비 저가 하락률 (%)' });
  const months = editor.getByRole('spinbutton', { name: '우측 확장 기간 (개월)' });
  await expect(n).toHaveValue('200'); await expect(drop).toHaveValue('7'); await expect(months).toHaveValue('6');
  await n.fill('5'); await n.press('Enter');
  await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await page.getByRole('dialog', { name: '지표', exact: true }).getByRole('button', { name: '닫기', exact: true }).click(); await expect(editor).toBeHidden();
  const legend = page.getByTestId('pane-legend-rows-candle');
  await expect(legend).toContainText('신고가 음봉 시가선 (5일, -7%, 1개, 6개월)'); await expect(legend).toContainText('109');
  await page.getByTestId('live-indicators-button').click();
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '내 지표', exact: true }).click();
  await editor.getByRole('button', { name: '신고가 음봉 시가선', exact: true }).click();
  await editor.getByRole('combobox', { name: '신고가 이후 찾을 음봉 수' }).selectOption('2');
  await months.fill('3'); await months.press('Enter'); await page.getByRole('dialog', { name: '지표', exact: true }).getByRole('button', { name: '닫기', exact: true }).click(); await expect(editor).toBeHidden();
  const label = '신고가 음봉 시가선 (5일, -7%, 2개, 3개월)';
  await expect(legend).toContainText(label); await expect(legend).toContainText('99');
  await page.screenshot({ path: info.outputPath('new-high-bearish-lines.png') });
  const saved = async () => page.evaluate(async id => {
    const path = '/src/state/livePage.ts'; const { useLivePageStore } = await import(path);
    return useLivePageStore.getState().indicatorsByWindow[`live:${id}`].D;
  }, id);
  await page.getByRole('button', { name: `${label} 표시 숨김/표시`, exact: true }).click();
  await expect.poll(async () => (await saved()).newHighBearishHidden).toBe(true);
  await page.evaluate(() => history.replaceState(null, '', '/live')); await page.reload();
  await expect(legend).toContainText(label); await expect.poll(async () => (await saved()).newHighBearishMonths).toBe(3);
  await page.getByRole('button', { name: `${label} 표시 숨김/표시`, exact: true }).click();
  await page.getByRole('button', { name: `${label} 삭제`, exact: true }).click(); await expect(legend).not.toContainText('신고가 음봉 시가선');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(legend).toContainText(label);
  await page.getByTestId('live-indicators-button').click();
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '내 지표', exact: true }).click();
  await editor.getByRole('button', { name: '신고가 음봉 시가선', exact: true }).click();
  await editor.getByRole('button', { name: '설정 복사해서 추가', exact: true }).click(); await n.fill('8'); await n.press('Enter');
  await editor.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await editor.getByRole('button', { name: '내 지표', exact: true }).click();
  await editor.getByRole('button', { name: '신고가 음봉 시가선 1 설정', exact: true }).click(); await expect(n).toHaveValue('5');
  await editor.getByRole('button', { name: '신고가 음봉 시가선 2 설정', exact: true }).click(); await expect(n).toHaveValue('8'); await expect(months).toHaveValue('3');
  await editor.screenshot({ path: info.outputPath('new-high-bearish-settings.png') });
  expect(errors.filter(e => !e.startsWith('ResizeObserver loop'))).toEqual([]);
});
