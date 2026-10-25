import { expect, test, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

async function boundaryPixels(page: Page, id: string) {
  return page.evaluate(id => {
    const chart = ((window as any).__liveCharts as Map<string, any>).get(id);
    if (!chart) return [];
    const candles = chart.panes()[0].getSeries().find((s: any) => s.seriesType() === 'Candlestick')?.data();
    const boundary = candles?.[120];
    if (!boundary) return [];
    const x = chart.timeScale().timeToCoordinate(boundary.time);
    if (x === null) return [];
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    const context = probe.getContext('2d')!;
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-day-boundary').trim();
    context.fillRect(0, 0, 1, 1);
    const color = context.getImageData(0, 0, 1, 1).data;
    const canvases = [...chart.chartElement().querySelectorAll('canvas')] as HTMLCanvasElement[];
    return chart.panes().map((pane: any) => {
      const layers = canvases.filter(c => Math.abs(c.clientWidth - chart.timeScale().width()) < 2
        && Math.abs(c.clientHeight - pane.getHeight()) < 2);
      return Math.max(0, ...layers.map(canvas => {
        const ratio = canvas.width / canvas.clientWidth;
        const left = Math.max(0, Math.floor((x - 2) * ratio));
        const width = Math.min(canvas.width - left, Math.ceil(5 * ratio));
        const pixels = canvas.getContext('2d')!.getImageData(left, 0, width, canvas.height).data;
        let rows = 0;
        for (let y = 0; y < canvas.height; y++) {
          for (let dx = 0; dx < width; dx++) {
            const i = (y * width + dx) * 4;
            if (pixels[i + 3] > 200 && [0, 1, 2].every(c => Math.abs(pixels[i + c] - color[c]) <= 2)) {
              rows++; break;
            }
          }
        }
        return rows;
      }));
    });
  }, id);
}

test('seconds day boundary is drawn in candle and volume panes and follows pan/zoom', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installLiveMocks(page);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const dates = [2, 1].map(offset => new Date(Date.parse(`${today}T12:00:00Z`) - offset * 86400000).toISOString().slice(0, 10).replaceAll('-', ''));
  await page.route('**/api/live/second-trade-dates?**', r => r.fulfill({ json: { dates } }));
  await page.route('**/api/live/second-aggregates?**', r => {
    const p = new URL(r.request().url()).searchParams;
    const date = p.get('date')!, seconds = Number(p.get('seconds')), step = seconds * 1000;
    const start = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T14:30:20+09:00`);
    const bars = dates.includes(date) ? Array.from({ length: 120 }, (_, i) => ({ t_ms: start + i * step,
      open: 35000, high: 35100, low: 34900, close: 35050, volume: 100, count: 1, trade_value: 3500000 })) : [];
    const from = Number(p.get('from_ms') ?? 0), to = Number(p.get('to_ms') ?? Infinity);
    return r.fulfill({ json: { code: '098460', venue: p.get('venue'), date, seconds,
      source: 'second_trades', coverage: 'unverified', status: bars.length ? 'observed' : 'unavailable', storage_error: null,
      first_observed_ms: bars[0]?.t_ms ?? null, last_observed_ms: bars.at(-1)?.t_ms ?? null,
      bars: bars.filter(b => b.t_ms >= from && b.t_ms < to), prices: [] } });
  });
  await page.goto('/live?code=098460');
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: any) => w.kind === 'chart');
    store.setState({ windows: [{ ...win, chart: { timeframe: '10s' }, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      zOrder: [win.id], maximizedId: null, chartRuntime: {} });
    return win.id as string;
  });
  const chart = page.getByTestId('second-chart');
  await expect(chart).toHaveAttribute('data-bar-count', '240');
  await expect(chart).toHaveAttribute('data-day-count', '2');
  for (const range of [{ from: 70, to: 170 }, { from: 95, to: 155 }]) {
    await page.evaluate(({ id, range }) => ((window as any).__liveCharts as Map<string, any>).get(id).timeScale().setVisibleLogicalRange(range), { id, range });
    await expect.poll(async () => (await boundaryPixels(page, id)).map((rows: number) => rows > 10)).toEqual([true, true]);
  }
  await page.screenshot({ path: testInfo.outputPath('seconds-day-boundaries.png') });
  expect(errors).toEqual([]);
});
