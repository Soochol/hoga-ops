import { expect, test } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import type { RangeBundle } from '../../src/api/types';
import { apiExact } from './helpers/apiRoutes';

const T = Date.parse('2026-05-28T09:00:00+09:00');
const candles = [0, 1, 2].map(i => ({ t_ms: T + i * 60_000,
  open: 70000, high: 70500, low: 69900, close: 70000 + i * 200, volume: 1000 }));
const program = { points: [0, 1, 2].map(i => ({ t: T + i * 30_000,
  net_qty: 1000 + i * 500, net_amount: 100_000_000 + i * 50_000_000, gap_risk: false })) };

for (const first of ['price', 'program'] as const) {
  test(`프로그램 창은 ${first} 선부터 표시하고 새로고침 후에도 종목 변경·재조회 상태를 구분한다`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.clock.setFixedTime(new Date('2026-05-28T10:00:00+09:00'));
    await page.routeWebSocket(/\/api\/ws/, () => {});
    await page.addInitScript(() => {
      localStorage.setItem('live.programTradeDisplay.v1', JSON.stringify({ view: 'intraday', measure: 'amount' }));
      sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
        windows: [
          { id: 'chart', kind: 'chart', group: 1, chart: { timeframe: '1m' }, rect: { x: 0, y: 0, w: .5, h: .8 } },
          { id: 'program', kind: 'program', group: 1, rect: { x: .52, y: 0, w: .45, h: .5 } },
        ], zOrder: ['chart', 'program'], groupSymbols: { 1: { code: '098460', name: '고영' } },
      }));
    });
    await installLiveMocks(page);
    await page.route(apiExact('symbols/all'), route => route.fulfill({ json: {
      symbols: [{ code: '098460', name: '고영', market: 'KOSDAQ' }, { code: '005930', name: '삼성전자', market: 'KOSPI' }],
      status: 'fresh', fetched_at_ms: Date.now(), reason: null,
    } }));
    let outcome: 'success' | 'empty' | 'error' = 'success';
    let release!: () => void;
    let gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(apiExact('live/past-candles'), async route => {
      if (first === 'program') await gate;
      const p = new URL(route.request().url()).searchParams;
      await route.fulfill({ json: { code: p.get('code'), from: p.get('from'), to: '20260528', candles,
        cached_dates: [], fresh_dates: ['20260528'], data_warnings: [] } });
    });
    await page.route(apiExact('range'), async route => {
      const p = new URL(route.request().url()).searchParams;
      const hasProgram = p.get('mode') === 'sidecar' && p.get('program_trade_enabled') === 'true';
      if (first === 'price' && hasProgram) await gate;
      if (hasProgram && outcome === 'error') return route.fulfill({ status: 503, json: { detail: 'program temporarily unavailable' } });
      const response: RangeBundle = {
        code: p.get('code')!, from_date: p.get('from')!, to_date: '20260528', bucket_ms: 60000,
        segments: [{ date: '20260528', session_open_ms: T, session_close_ms: T + 23_400_000, source: 'kiwoom_live' }],
        candles: [], quote_ratio: { bucket_ms: 60000, points: [] }, fill_strength: { bucket_ms: 60000, points: [] },
        volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
        volume_profile_by_day: [], excluded_dates: [], data_warnings: [],
        broker_late_entries: [], ask_peaks: [], bid_peaks: [], trade_volume_pocs: [], volume_distributions: [], depth_heatmap: [], investorPoints: [],
        program_trade: hasProgram && outcome === 'success' ? program : { points: [] },
      };
      await route.fulfill({ json: response });
    });
    await page.goto('/live');
    const card = page.locator('[data-win="program"]');
    for (const run of ['initial', 'reload', 'symbol']) {
      if (run === 'reload') {
        gate = new Promise<void>(resolve => { release = resolve; });
        await page.reload();
      }
      if (run === 'symbol') {
        gate = new Promise<void>(resolve => { release = resolve; });
        await page.getByRole('button', { name: '종목 검색 열기' }).click();
        const dialog = page.getByRole('dialog', { name: '종목 검색' });
        await dialog.getByRole('combobox', { name: '종목 검색' }).fill('삼성전자');
        await dialog.getByRole('option').first().click();
        await expect(card.locator('.live-symbol-name')).toHaveText('삼성전자');
      }
      await expect(card.getByRole('status')).toContainText(first === 'price' ? '프로그램 순매수 불러오는 중' : '종가 불러오는 중');
      const readyLine = card.getByTestId(first === 'price' ? 'program-price-graph' : 'sparkline-solid');
      await expect(readyLine).toBeVisible();
      await expect(card.getByTestId(first === 'price' ? 'sparkline-solid' : 'program-price-graph')).toHaveCount(0);
      expect((await readyLine.getAttribute('points'))?.split(' ').length).toBeGreaterThanOrEqual(2);
      await card.screenshot({ path: info.outputPath(`${first}-first-${run}.png`) });
      release();
      await expect(card.getByTestId('program-price-graph')).toBeVisible();
      await expect(card.getByTestId('sparkline-solid')).toBeVisible();
      await expect(card.getByRole('status')).toHaveCount(0);
      expect(errors).toEqual([]);
    }
    if (first === 'price') {
      outcome = 'error';
      await page.reload();
      await expect(card.getByTestId('program-price-graph')).toBeVisible();
      await expect(card.getByRole('status')).toContainText('프로그램 순매수 조회 실패', { timeout: 15_000 });
      await expect(card.getByRole('status')).not.toContainText('데이터 없음');
      await card.screenshot({ path: info.outputPath('program-failure-with-price.png') });
      outcome = 'empty';
      await page.reload();
      await expect(card.getByTestId('program-price-graph')).toBeVisible();
      await expect(card.getByRole('status')).toContainText('프로그램 순매수 데이터 없음');
      await expect(card.getByRole('status')).not.toContainText('조회 실패');
      expect(errors).toEqual([]);
    }
  });
}
