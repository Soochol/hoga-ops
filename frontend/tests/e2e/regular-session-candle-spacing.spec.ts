import { test, expect } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';

for (const minutes of [1, 3, 5, 10]) {
  test(`KRX ${minutes}m regular-session toggle preserves candle spacing with indicators`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-05-28T10:00:00+09:00'));
    await page.addInitScript(() => {
      localStorage.setItem('live.venue.v1', JSON.stringify({ venue: 'KRX' }));
      localStorage.setItem('live.indicators.v2', JSON.stringify({
        byTimeframe: { minute: { ratioEnabled: true, programTradeEnabled: true, fillStrengthEnabled: true } },
      }));
    });
    await installLiveMocks(page);
    const start = Date.parse('2026-05-27T08:00:00+09:00');
    const all = Array.from({ length: 721 }, (_, i) => ({
      t_ms: start + i * 60_000, open: 35000, high: 35200, low: 34900, close: 35100, volume: 100,
    }));
    await page.route('**/api/live/past-candles?**', r => {
      const bucket = Number(new URL(r.request().url()).searchParams.get('bucket_ms') ?? 60_000);
      return r.fulfill({ json: {
        code: '098460', venue: 'KRX', bucket_ms: bucket, from: '20260527', to: '20260528',
        candles: all.filter(b => b.t_ms % bucket === 0), cached_dates: ['20260527'],
        fresh_dates: [], data_warnings: [],
        effective_sessions: [{ date: '20260527', venue: 'KRX', open_ms: start + 3600000, close_ms: start + 12 * 3600000 }],
      } });
    });
    await page.route(/^https?:\/\/[^/]+\/api\/range(?:\?|$)/, r => {
      const bucket = Number(new URL(r.request().url()).searchParams.get('bucket_ms') ?? 60_000);
      // Reproduce the API contract: regular-session mode requests 1m hoga,
      // while candles are displayed at the user's selected timeframe.
      const points = all.filter(b => b.t_ms % bucket === 0).map(b => ({
        t: b.t_ms, bid_total: 200, ask_total: 100, bid_max: 210, ask_max: 110,
        imb_max_bid: 200, imb_max_ask: 100, band_pct: 1, tick: 50,
      }));
      return r.fulfill({ json: {
        code: '098460', from_date: '20260527', to_date: '20260527', bucket_ms: bucket,
        segments: [{ date: '20260527', session_open_ms: start + 3600000, session_close_ms: start + 12 * 3600000, source: 'hogaplay' }],
        candles: [], quote_ratio: { bucket_ms: bucket, points },
        fill_strength: { bucket_ms: bucket, points: points.map(p => ({ t: p.t, buy_qty: 20, sell_qty: 10 })) },
        program_trade: { points: points.map(p => ({ t: p.t, net_qty: 100, net_amount: 10000, gap_risk: false })) },
        volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
        volume_profile_by_day: [], volume_distributions: [], investorPoints: [],
        ask_peaks: [], bid_peaks: [], broker_late_entries: [], excluded_dates: [], data_warnings: [],
      } });
    });
    await page.goto('/live?code=098460');
    if (minutes !== 1) {
      await page.getByRole('button', { name: '분봉 선택 열기: 1분', exact: true }).click();
      await page.getByRole('menuitemradio', { name: `${minutes}분`, exact: true }).click();
    }
    const snapshot = () => page.evaluate(() => {
      const charts = [...(window as unknown as { __liveCharts?: Map<string, IChartApi> }).__liveCharts?.values() ?? []];
      if (charts.length !== 1) return null;
      const chart = charts[0];
      const candles = chart.panes().flatMap(p => p.getSeries())
        .find(s => s.seriesType() === 'Candlestick')?.data() ?? [];
      if (candles.length < 2) return null;
      const ts = chart.timeScale();
      const a = ts.timeToCoordinate(candles[0].time);
      const b = ts.timeToCoordinate(candles[1].time);
      const spacing = ts.options().barSpacing;
      return {
        gapRatio: a == null || b == null ? null : (b - a) / spacing,
        count: candles.length, spacing, range: ts.getVisibleLogicalRange(), paneCount: chart.panes().length,
      };
    });
    await expect(page.getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
    // Candle, volume, ratio, fill strength, and program panes must all be active.
    await expect.poll(async () => (await snapshot())?.paneCount).toBe(5);
    await page.evaluate(() => {
      const charts = [...(window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts.values()];
      if (charts.length !== 1) throw new Error('Expected exactly one chart window');
      charts[0].timeScale().setVisibleLogicalRange({ from: 0, to: 20 });
    });
    await expect.poll(async () => (await snapshot())?.range?.to).toBe(20);
    await expect.poll(async () => (await snapshot())?.gapRatio).toBeCloseTo(1, 3);
    const before = (await snapshot())!;
    await page.getByRole('button', { name: '차트 더보기' }).click();
    const regularSession = page.getByRole('checkbox', { name: '정규장만 보기', exact: true });
    await regularSession.check();
    await expect(regularSession).toBeChecked();
    await expect.poll(async () => (await snapshot())?.count).toBeLessThan(before.count);
    // Global barSpacing alone passes on broken code: adjacent candles were
    // 3/5/10 axis slots apart. Measure the real coordinate gap as well.
    await expect.poll(async () => (await snapshot())?.gapRatio).toBeCloseTo(1, 3);
    await expect.poll(async () => (await snapshot())?.spacing).toBeCloseTo(before.spacing, 5);
    await regularSession.uncheck();
    await expect.poll(async () => (await snapshot())?.count).toBe(before.count);
    await expect.poll(async () => (await snapshot())?.gapRatio).toBeCloseTo(1, 3);
    await expect.poll(async () => (await snapshot())?.spacing).toBeCloseTo(before.spacing, 5);
  });
}
