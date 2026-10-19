/** Opt-in browser experiment, not a wall-clock pass/fail performance budget.
 * HOGA_RUN_CACHE_BENCHMARK=1 npx playwright test live-cache-benchmark --reporter=list
 * Each variant gets an isolated context and the same synthetic API responses.
 * Only test-served Vite constants change; no production runtime override exists.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import type { WorkspaceWindow } from '../../src/state/workspace';
import type { IChartApi } from 'lightweight-charts';
import type { liveCacheStats } from '../../src/api/liveCachePolicy';
import type { QueryClient } from '@tanstack/react-query';

type Stats = ReturnType<typeof liveCacheStats>;
type Profile = { frames: number[]; tasks: number[]; inputs: number[] };
type BenchWindow = Window & {
  __liveCharts: Map<string, IChartApi>;
  __liveCacheStats: () => Stats;
  __cacheProfile: Profile;
  __cacheBenchClient: QueryClient;
};
type Config = { name: string; codes: number; entries: number; mib: number };
const variants: Config[] = [
  { name: 'baseline-32-32-512', codes: 32, entries: 32, mib: 512 },
  { name: 'expanded-64-128-512', codes: 64, entries: 128, mib: 512 },
  ...[384, 256, 128].map(mib => ({ name: `memory-64-128-${mib}`, codes: 64, entries: 128, mib })),
  { name: 'count-64-64-512', codes: 64, entries: 64, mib: 512 },
  { name: 'count-32-128-512', codes: 32, entries: 128, mib: 512 },
];
const enabled = process.env.HOGA_RUN_CACHE_BENCHMARK === '1';
const selected = (process.env.HOGA_CACHE_BENCH_VARIANTS ?? '').split(',').filter(Boolean);
const codes = Array.from({ length: Number(process.env.HOGA_CACHE_BENCH_CODES ?? 64) }, (_, i) => String(100000 + i));
const repetitions = Number(process.env.HOGA_CACHE_BENCH_REPEATS ?? 2);
const day = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
const days: number[] = [];
for (let ms = Date.UTC(2026, 9, 16); days.length < 20; ms -= day) {
  if (![0, 6].includes(new Date(ms).getUTCDay())) days.unshift(ms);
}
const from = ymd(days[0]);
const to = '20261019';
const payloads = new Map<string, string>();
const emptyProfile = { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] };

function payload(url: URL, candlesOnly: boolean): string {
  const key = `${candlesOnly}:${url.search}`;
  const cached = payloads.get(key);
  if (cached) return cached;
  const code = url.searchParams.get('code')!;
  const base = 10000 + Number(code) - 100000;
  const bucket = Number(url.searchParams.get('bucket_ms') ?? 60000);
  const stride = bucket / 60000;
  const start = url.searchParams.get('from')!;
  const end = url.searchParams.get('to')!;
  const hoga = url.searchParams.get('mode') === 'hoga';
  const sessions = days.filter(ms => ymd(ms) >= start && ymd(ms) <= end);
  const bars = sessions.flatMap(ms => Array.from({ length: 390 / stride }, (_, i) => {
    const price = base + i * stride / 100;
    return { t_ms: ms + i * bucket, open: price, high: price + 2, low: price - 2, close: price + 1, volume: 100 + i };
  }));
  const body = candlesOnly ? {
    code, venue: 'KRX', from: start, to: end, bucket_ms: bucket, candles: bars,
    cached_dates: sessions.map(ymd), fresh_dates: [], data_warnings: [],
  } : {
    code, from_date: start, to_date: end, bucket_ms: bucket,
    segments: sessions.map(ms => ({ date: ymd(ms), session_open_ms: ms, session_close_ms: ms + 23400000, source: 'kiwoom_live', gap_ms: 0 })),
    candles: [],
    quote_ratio: { bucket_ms: bucket, points: hoga ? bars.map((b, i) => ({ t: b.t_ms, bid_total: 2000 + i % 70, ask_total: 1800 + i % 90,
      bid_max: 400, ask_max: 350, imb_max_bid: 0, imb_max_ask: 0, band_pct: 0.5, tick: 10 })) : [] },
    fill_strength: { bucket_ms: bucket, points: hoga ? bars.map((b, i) => ({ t: b.t_ms, buy_qty: 100 + i % 50, sell_qty: 90 + i % 60 })) : [] },
    depth_heatmap: url.searchParams.get('depth_heatmap_enabled') === 'true' ? bars.map(b => ({ t_ms: b.t_ms,
      asks: Array.from({ length: 10 }, (_, i) => [base + 10 * i, 200 + i]),
      bids: Array.from({ length: 10 }, (_, i) => [base - 10 * i, 220 + i]),
    })) : [],
    volume_profile_range: emptyProfile, volume_profile_by_day: [], volume_distributions: [],
    investorPoints: [], ask_peaks: [], bid_peaks: [], trade_volume_pocs: [], broker_late_entries: [],
    excluded_dates: [], missing_dates: [], data_warnings: [],
  };
  const result = JSON.stringify(body);
  payloads.set(key, result);
  return result;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] * 100) / 100;
}

async function startTrace(cdp: CDPSession) {
  const gc: { name: string; dur?: number }[] = [];
  const listener = ({ value }: { value: Record<string, string>[] }) => {
    gc.push(...value.filter(e => e.name === 'MajorGC' || e.name === 'MinorGC')
      .map(e => ({ name: e.name, dur: Number(e.dur ?? 0) })));
  };
  cdp.on('Tracing.dataCollected', listener);
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8', transferMode: 'ReportEvents' });
  return async () => {
    const complete = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve()));
    await cdp.send('Tracing.end');
    await complete;
    cdp.off('Tracing.dataCollected', listener);
    return { events: gc.length, majorEvents: gc.filter(e => e.name === 'MajorGC').length,
      totalMs: gc.reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000,
      maxMs: Math.max(0, ...gc.map(e => (e.dur ?? 0) / 1000)) };
  };
}

async function install(page: Page, config: Config) {
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  // Date advances normally, preserving real LRU order and real performance timers.
  await page.addInitScript(() => {
    const OriginalDate = Date;
    const offset = new OriginalDate('2026-10-19T18:00:00+09:00').getTime() - OriginalDate.now();
    class BenchmarkDate extends OriginalDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (!args.length) super(OriginalDate.now() + offset);
        else super(...args);
      }
      static now() { return OriginalDate.now() + offset; }
    }
    Object.assign(window, { Date: BenchmarkDate });
    const state = window as unknown as BenchWindow;
    state.__cacheProfile = { frames: [], tasks: [], inputs: [] };
    let previous = performance.now();
    const frame = (now: number) => {
      state.__cacheProfile.frames.push(now - previous);
      previous = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new PerformanceObserver(list => state.__cacheProfile.tasks.push(...list.getEntries().map(e => e.duration)))
      .observe({ type: 'longtask' });
    document.addEventListener('pointermove', () => {
      const start = performance.now();
      requestAnimationFrame(() => state.__cacheProfile.inputs.push(performance.now() - start));
    }, { passive: true });
  });
  for (const [path, replacements] of [
    ['liveCachePolicy', { LIVE_CACHE_MAX_ESTIMATED_BYTES: `${config.mib} * 1024 * 1024`, LIVE_CACHE_RECENT_CODES: String(config.codes) }],
    ['range', { MERGED_LIVE_RANGE_MAX_ENTRIES: String(config.entries) }],
  ] as const) {
    await page.route(new RegExp(`/src/api/${path}\\.ts(?:\\?.*)?$`), async route => {
      const response = await route.fetch();
      let body = await response.text();
      for (const [name, value] of Object.entries(replacements)) {
        const match = new RegExp(`const ${name} = [^;]+;`);
        expect(body).toMatch(match);
        body = body.replace(match, `const ${name} = ${value};`);
      }
      if (path === 'liveCachePolicy') {
        const marker = 'function liveCacheStats(client) {';
        expect(body).toContain(marker);
        body = body.replace(marker, `${marker}\nwindow.__cacheBenchClient = client;`);
      }
      await route.fulfill({ response, body });
    });
  }
  await page.route(apiExact('live/settings'), r => r.fulfill({ json: { rest_bypass_enabled: false, krx_prefer_hogaplay: false, screener_depth_autocollect: false } }));
  await page.route(apiExact('symbols/all'), r => r.fulfill({ json: { status: 'fresh', fetched_at_ms: 1,
    symbols: codes.map(code => ({ code, name: `Bench ${code}`, market: 'KOSPI', sector: '', nxt_enabled: false,
      captured_count: 20, captured_breakdown: { complete: 20, source_partial: 0, client_incomplete: 0, invalid: 0 } })) } }));
  const requests: { endpoint: string; code: string | null; mode: string | null; depth: boolean; from: string | null; to: string | null }[] = [];
  for (const endpoint of ['live/past-candles', 'range']) {
    await page.route(apiExact(endpoint), async route => {
      const url = new URL(route.request().url());
      requests.push({ endpoint, code: url.searchParams.get('code'), mode: url.searchParams.get('mode'), depth: url.searchParams.get('depth_heatmap_enabled') === 'true', from: url.searchParams.get('from'), to: url.searchParams.get('to') });
      const body = payload(url, endpoint !== 'range');
      await new Promise(resolve => setTimeout(resolve, 35));
      await route.fulfill({ contentType: 'application/json', body });
    });
  }
  return requests;
}

async function visit(page: Page, id: string, code: string, timeframe: '1m' | '3m') {
  return page.evaluate(async ({ id, code, timeframe, from }) => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const state = window as unknown as BenchWindow;
    const started = performance.now();
    store.getState().setChartTimeframe(id, timeframe);
    store.getState().setWindowSymbol(id, { code, name: `Bench ${code}`, kind: 'stock' });
    store.getState().extendChartHistoricalRange(id, from);
    const close = 10000 + Number(code) - 100000 + (timeframe === '1m' ? 389 : 387) / 100 + 1;
    let fittedRows = -1;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const chart = state.__liveCharts?.get(id);
        const series = chart?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
        const rows = series?.data();
        const last = rows?.at(-1);
        // Keep the requested history visible. Otherwise normal viewport
        // contraction legitimately discards the left history during loading.
        if (last && 'close' in last && Math.abs(last.close - close) < .00001 && rows!.length !== fittedRows) {
          chart!.timeScale().fitContent();
          fittedRows = rows!.length;
        }
        state.__liveCacheStats(); // Initializes the test-only QueryClient handle.
        const indicators = state.__cacheBenchClient.getQueryCache().findAll({
          queryKey: ['live', 'range-merged'], predicate: q => q.getObserversCount() > 0,
        });
        const complete = indicators.length === 2 && indicators.every(q => {
          const data = q.state.data as { code: string; from_date: string; bucket_ms: number } | undefined;
          return data?.code === code && data.from_date <= from && data.bucket_ms === (timeframe === '1m' ? 60000 : 180000);
        });
        if (last && 'close' in last && Math.abs(last.close - close) < .00001
          && complete) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        } else if (performance.now() - started > 20000) reject(new Error(`Chart did not settle for ${code}/${timeframe}: ${JSON.stringify(indicators.map(q => ({ key: q.queryKey, data: q.state.data && { code: (q.state.data as {code:string}).code, from: (q.state.data as {from_date:string}).from_date } })))}`));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    return { code, timeframe, ms: performance.now() - started, stats: state.__liveCacheStats() };
  }, { id, code, timeframe, from });
}

test('cache configuration browser measurement', async ({ browser }, testInfo) => {
  test.skip(!enabled, 'Opt-in cache performance experiment');
  test.setTimeout(3_600_000);
  const results = [];
  const errors: string[] = [];
  const consoleErrors: { config: string; repeat: number; message: string }[] = [];
  for (let repeat = 0; repeat < repetitions; repeat++) {
    // Reverse the second run to reduce fixed run-order/thermal effects.
    const order = repeat % 2 ? [...variants].reverse() : variants;
    for (const config of order.filter(v => !selected.length || selected.includes(v.name))) {
      const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${config.name}: ${e.message}`));
      page.on('console', msg => {
        if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource:')) {
          consoleErrors.push({ config: config.name, repeat, message: msg.text() });
        }
      });
      const requests = await install(page, config);
      const cdp = await context.newCDPSession(page);
      await page.goto(`/live?code=${codes[0]}`);
      await page.waitForFunction(() => (window as unknown as BenchWindow).__liveCharts?.size > 0);
      const id = await page.evaluate(async () => {
        const workspacePath = '/src/state/workspace.ts';
        const indicatorsPath = '/src/state/livePage.ts';
        const [{ useWorkspaceStore: store }, { useLivePageStore: indicators }] = await Promise.all([import(workspacePath), import(indicatorsPath)]);
        const win = store.getState().windows.find((w: WorkspaceWindow) => w.kind === 'chart');
        store.getState().applyWorkspaceSnapshot({ windows: [{ ...win, group: 1, pinned: undefined,
          rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { ...win.chart, timeframe: '1m' } }], zOrder: [win.id], maximizedId: null });
        for (const tf of ['1m', '3m']) indicators.getState().patchIndicatorsScoped({ windowKey: `live:${win.id}` }, tf, {
          ratioEnabled: true, fillStrengthEnabled: true, depthHeatmapEnabled: true,
        });
        return win.id as string;
      });
      // Confirm the served constants really differ; no silent override failures.
      const actual = await page.evaluate(async () => {
        const a = '/src/api/liveCachePolicy.ts';
        const b = '/src/api/range.ts';
        const [policy, range] = await Promise.all([import(a), import(b)]);
        return { codes: policy.LIVE_CACHE_RECENT_CODES, entries: range.MERGED_LIVE_RANGE_MAX_ENTRIES, mib: policy.LIVE_CACHE_MAX_ESTIMATED_BYTES / 1048576 };
      });
      expect(actual).toEqual({ codes: config.codes, entries: config.entries, mib: config.mib });
      const stages = [];
      for (const phase of ['cold', 'revisit'] as const) {
        const countBefore = requests.length;
        await page.evaluate(() => { (window as unknown as BenchWindow).__cacheProfile = { frames: [], tasks: [], inputs: [] }; });
        const stopTrace = await startTrace(cdp);
        const visits = [];
        let peakHeap = 0;
        const sequence = phase === 'cold' ? codes : [...codes].reverse();
        for (let i = 0; i < sequence.length; i++) {
          const code = sequence[i];
          const tf = Number(code) % 2 ? '3m' : '1m';
          visits.push(await visit(page, id, code, tf));
          const heap = await cdp.send('Runtime.getHeapUsage');
          peakHeap = Math.max(peakHeap, heap.usedSize);
          if (phase === 'revisit' && i % 8 === 0) {
            for (let step = 0; step < 6; step++) await page.mouse.move(350 + step * 70, 300);
          }
        }
        const gc = await stopTrace();
        const profile = await page.evaluate(() => (window as unknown as BenchWindow).__cacheProfile);
        const stats = await page.evaluate(() => (window as unknown as BenchWindow).__liveCacheStats());
        // Explicit GC is outside all timing/GC stages and identifies retained heap.
        await cdp.send('HeapProfiler.collectGarbage');
        const retained = await cdp.send('Runtime.getHeapUsage');
        const sent = requests.slice(countBefore);
        stages.push({ phase, visits, requests: sent, peakJsHeapMiB: peakHeap / 1048576,
          retainedJsHeapMiB: retained.usedSize / 1048576, stats, gc,
          latencyMedianMs: percentile(visits.map(v => v.ms), .5), latencyP95Ms: percentile(visits.map(v => v.ms), .95),
          frameP95Ms: percentile(profile.frames, .95), frameMaxMs: Math.max(0, ...profile.frames),
          longTaskCount: profile.tasks.length, longTaskMaxMs: Math.max(0, ...profile.tasks),
          pointerToFrameP95Ms: percentile(profile.inputs, .95),
        });
      }
      const row = { config, repeat, stages };
      results.push(row);
      console.log(JSON.stringify({ config, repeat, revisit: stages[1] && { median: stages[1].latencyMedianMs, p95: stages[1].latencyP95Ms,
        requests: stages[1].requests.length, heap: stages[1].retainedJsHeapMiB, entries: stages[1].stats.mergedEntries } }));
      await context.close();
      const output = resolve(process.env.HOGA_CACHE_BENCH_OUTPUT ?? testInfo.outputPath('cache-benchmark.json'));
      await mkdir(resolve(output, '..'), { recursive: true });
      await writeFile(output, JSON.stringify({ schema: 1, browser: browser.version(), workload: {
        codes: codes.length, sessions: days.length, first: from, last: to, requestDelayMs: 35,
        depthLevelsPerSide: 10, timeframes: ['1m', '3m'], revisitOrder: 'reverse', viewport: 'fit requested history',
        fixtureSha256: createHash('sha256').update(JSON.stringify({ codes, days })).digest('hex'),
        scope: 'isolated real /live page with deterministic synthetic API data; dev build; no vendor latency or multi-hour soak',
      }, errors, consoleErrors, results }, null, 2));
    }
  }
  expect(errors).toEqual([]);
});
