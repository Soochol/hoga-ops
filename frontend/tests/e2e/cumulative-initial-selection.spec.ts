import { expect, test, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

const days = Array.from({ length: 900 }, (_, i) => Date.UTC(2023, 11, 26 + i))
  .filter(t => t <= Date.UTC(2026, 4, 28) && ![0, 6].includes(new Date(t).getUTCDay()));
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
async function add(page: Page, label: string) {
  await page.getByTestId('live-indicators-button').first().click();
  const panel = page.getByTestId('indicator-panel-shell');
  await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
  await panel.getByRole('button', { name: '닫기', exact: true }).click();
}
async function state(page: Page) {
  return page.evaluate(() => {
    const charts = (window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts;
    const [id, chart] = [...charts.entries()][0];
    return { id, series: chart.panes().flatMap(p => p.getSeries()).map(s => ({
      type: s.seriesType(), values: s.data().flatMap(p => 'value' in p ? [p.value] : []), count: s.data().length,
    })), range: chart.timeScale().getVisibleLogicalRange() };
  });
}

test('watchlist selection completes cumulative history without a candle prepend, then restores A-B-A', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  await page.route(apiExact('watchlist'), r => r.fulfill({ json: { folders: [], memos: [], next_run_at_ms: 0,
    entries: ['098460', '000660', '005930'].map((code, order) => ({ code, name: code === '098460' ? '고영' : code === '000660' ? 'SK하이닉스' : '삼성전자',
      folder_id: null, order, registered_at_kst_date: '20260527', last_success_date: null })) } }));
  const requests: { code: string | null; from: string | null; to: string | null; kind: string }[] = [];
  const progress = new Map<string, number>();
  let releaseLate: () => void = () => {};
  const late = new Promise<void>(resolve => { releaseLate = resolve; });
  let lateStarted = false;
  let lateFinished = false;
  for (const kind of ['past-daily-candles', 'investor-daily-flow']) {
    await page.route(apiExact(`live/${kind}`), async route => {
      const p = new URL(route.request().url()).searchParams;
      const code = p.get('code'), from = p.get('from'), to = p.get('to');
      requests.push({ code, from, to, kind });
      const dates = days.filter(t => ymd(t) >= from! && ymd(t) <= to!);
      if (kind === 'past-daily-candles') return route.fulfill({ json: { code, from, to,
        candles: dates.map((t_ms, i) => ({ t_ms, open: 35000 + i * 5, high: 35300 + i * 5,
          low: 34700 + i * 5, close: 35100 + i * 5, volume: 100000 })),
        cached_batches: [], fresh_batches: [], data_warnings: [] } });
      const key = `${code}/${to}`;
      const n = (progress.get(key) ?? 0) + 1;
      progress.set(key, n);
      const partial = code !== '098460' && n === 1;
      if (code === '005930' && n === 2) {
        lateStarted = true;
        await late;
      }
      await route.fulfill({ json: { code, from, to, source: 'kiwoom_ka10059', provider_scope: 'KRX',
        unit: 'qty_shares', trade_side: 'net', observations: dates.map(t_ms => ({ date: ymd(t_ms), t_ms,
          institution_net_shares: code === '000660' ? 100 : 200, foreign_net_shares: -50 })),
        pagination: partial ? 'incomplete' : 'covered', unlocated_defect: false, pages_observed: partial ? 6 : 7,
        can_continue: partial, data_warnings: partial ? [{ reason: 'page_budget', date: null, subject: null,
          message: '합성 공급자 페이지 한도' }] : [] } });
      if (code === '005930' && n === 2) lateFinished = true;
    });
  }
  await page.goto('/live?code=098460');
  await page.getByRole('button', { name: '일', exact: true }).first().click();
  await add(page, '기관 누적 순매수');
  await add(page, '외국인 누적 순매수');
  const institution = page.getByTestId('pane-legend-rows-institution-cumulative');
  const foreign = page.getByTestId('pane-legend-rows-foreign-cumulative');
  await expect(institution).toContainText('조회 완료');
  const a = await state(page);
  const panel = page.getByTestId('watchlist-panel');
  if (!await panel.isVisible()) await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  await panel.getByTestId('watchlist-row-000660').click();
  await expect.poll(() => requests.filter(r => r.kind === 'investor-daily-flow' && r.code === '000660').length).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('initial-selection.png') });
  await expect(institution).toContainText('조회 완료');
  await expect(foreign).toContainText('조회 완료');
  const b = await state(page);
  const count = b.series.find(s => s.type === 'Candlestick')!.count;
  const lineValues = b.series.filter(s => s.type === 'Line').map(s => s.values);
  expect(count).toBeGreaterThan(100);
  expect(lineValues).toContainEqual(Array.from({ length: count }, (_, i) => i * 100));
  expect(lineValues).toContainEqual(Array.from({ length: count }, (_, i) => i === 0 ? 0 : i * -50));
  await page.screenshot({ path: info.outputPath('completed-selection.png') });
  expect(new Set(requests.filter(r => r.kind === 'investor-daily-flow' && r.code === '000660').map(r => r.from)).size).toBe(1);
  expect(requests.filter(r => r.kind === 'past-daily-candles' && r.code === '000660')).toHaveLength(1);
  await panel.getByTestId('watchlist-row-098460').click();
  await expect(institution).toContainText('조회 완료');
  await expect.poll(async () => (await state(page)).series.filter(s => s.type === 'Line').map(s => s.values)).toEqual(a.series.filter(s => s.type === 'Line').map(s => s.values));
  await panel.getByTestId('watchlist-row-005930').click();
  await expect.poll(() => lateStarted).toBe(true);
  await panel.getByTestId('watchlist-row-098460').click();
  await expect(institution).toContainText('조회 완료');
  releaseLate();
  await expect.poll(() => lateFinished).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(async () => (await state(page)).series.filter(s => s.type === 'Line').map(s => s.values)).toEqual(a.series.filter(s => s.type === 'Line').map(s => s.values));
  await page.reload();
  await expect(institution).toContainText('조회 완료');
  await expect(foreign).toContainText('조회 완료');
  await page.screenshot({ path: info.outputPath('restored.png') });
  await info.attach('requests-and-series', { body: JSON.stringify({ a, b, restored: await state(page), requests }), contentType: 'application/json' });
});
