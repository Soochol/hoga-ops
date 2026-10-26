import { test, expect } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import type { StudyViewReference } from '../../src/api/studyViews';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

const start = Date.parse('2026-10-16T09:00:00+09:00');
const minute = 60_000;
const at = (offset: number) => start + offset * minute;
const save: StudyViewReference = {
  id: 'wooriro-partial', schema_version: 2, group_id: 'partial', code: '046970', label: '우리로',
  name: '우리로 오전 복기', timeframe: '3m', memo: '', tags: [], created_at_ms: 1, updated_at_ms: 1,
  range: { from_date: '20261016', to_date: '20261016', from_ms: start, to_ms: at(180) },
  viewport: { right_edge_ms: at(180), left_edge_ms: start, bar_span: 70, at_live_edge: false },
};

test('a saved minute view supplements its missing morning, preserving disk candles and real gaps', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.clock.setFixedTime(new Date('2026-10-26T18:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const vendorRequests: string[] = [];
  await page.route(apiExact('live/past-candles'), async route => {
    const p = new URL(route.request().url()).searchParams;
    vendorRequests.push(route.request().url());
    await route.fulfill({ json: {
      code: save.code, from: p.get('from'), to: p.get('to'), venue: 'KRX', bucket_ms: Number(p.get('bucket_ms')),
      candles: [
        { t_ms: at(0), open: 8100, high: 8100, low: 8100, close: 8100, volume: 0 },
        { t_ms: at(3), open: 8110, high: 8130, low: 8100, close: 8120, volume: 25 },
        { t_ms: at(60), open: 8140, high: 8160, low: 8130, close: 8150, volume: 70 },
        { t_ms: at(144), open: 9999, high: 9999, low: 9999, close: 9999, volume: 9999 },
        { t_ms: at(147), open: 8310, high: 8330, low: 8300, close: 8320, volume: 15 },
      ], cached_dates: [], fresh_dates: ['20261016'], data_warnings: [], adjust_factors: { '20261016': 1 },
    } });
  });
  await page.route(apiExact('range'), async route => {
    const p = new URL(route.request().url()).searchParams;
    const candleMode = p.get('mode') === 'candles';
    const covered = p.get('from')! <= '20261016' && p.get('to')! >= '20261016';
    await route.fulfill({ json: {
      code: save.code, from_date: p.get('from'), to_date: p.get('to'), bucket_ms: Number(p.get('bucket_ms')),
      segments: covered ? [{ date: '20261016', session_open_ms: start, session_close_ms: at(390), source: 'hogaplay' }] : [],
      candles: candleMode && covered ? [{ ts_ms: at(144), open: 8290, high: 8310, low: 8280, close: 8300, vol_a: 20, vol_b: 30 }] : [],
      quote_ratio: { bucket_ms: 180000, points: [] }, fill_strength: { bucket_ms: 180000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [], missing_dates: [], excluded_dates: [], data_warnings: [],
    } });
  });
  await page.route(apiExact('study-views/saves'), r => r.fulfill({ json: {
    schema_version: 2, groups: [{ id: 'partial', name: '부분 누락' }], saves: [save],
  } }));
  await page.goto('/live?code=046970');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    store.setState({ windows: [{ id: 'partial-chart', kind: 'chart', group: 1,
      chart: { timeframe: '3m' }, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      zOrder: ['partial-chart'], chartRuntime: {}, maximizedId: null,
      groupSymbols: { 1: { code: '046970', name: '우리로', kind: 'stock' } } });
  });
  await page.getByRole('button', { name: '저장뷰 패널 토글' }).click();
  await page.getByRole('button', { name: '우리로 오전 복기 저장뷰 열기', exact: true }).click();
  await expect(page.getByTestId('live-saved-range-chip')).toContainText('키움 부분 보충 1일');
  await expect(page.getByTestId('live-saved-range-chip')).toHaveAttribute('data-tooltip', /호가 파생 지표가 추가되지 않습니다/);
  const inspect = () => page.evaluate(() => {
    const chart = (window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts.get('partial-chart');
    const series = chart?.panes().flatMap(p => p.getSeries()).find(s => s.seriesType() === 'Candlestick');
    const candles = (series?.data() ?? []).filter(p => 'close' in p);
    return { closes: candles.map(p => 'close' in p ? p.close : null),
      morningVisible: candles.slice(0, 3).every(p => {
        const x = chart!.timeScale().timeToCoordinate(p.time);
        return x !== null && x >= 0 && x <= chart!.timeScale().width();
      }) };
  });
  await expect.poll(async () => (await inspect()).closes).toEqual([8100, 8120, 8150, 8300, 8320]);
  await expect.poll(async () => (await inspect()).morningVisible).toBe(true);
  // The saved range ends on 10/16; eligibility must use real today (10/26).
  expect(vendorRequests.some(url => url.includes('from=20261016') && url.includes('to=20261016'))).toBe(true);
  await expect(page.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  await page.screenshot({ path: testInfo.outputPath('saved-partial-morning.png') });
});
