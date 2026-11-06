import { expect, test, type Page } from '@playwright/test';
import type { LivePastDailyCandle } from '../../src/api/livePastDailyCandles';
import type { IChartApi } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

declare global { interface Window { __liveCharts?: Map<string, IChartApi> } }
const day = 86400000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
const parse = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
function bars(from: string, to: string, tf: 'D' | 'W' | 'M') {
  const result: LivePastDailyCandle[] = [];
  for (let date = parse(from); date <= parse(to); date += day) {
    const d = new Date(date);
    if ([0, 6].includes(d.getUTCDay()) || ymd(date) === '20260331') continue;
    if (tf === 'W' && d.getUTCDay() !== 1) continue;
    if (tf === 'M' && d.getUTCDate() > 3) continue;
    if (tf === 'M' && result.some(c => new Date(c.t_ms).getUTCMonth() === d.getUTCMonth()
      && new Date(c.t_ms).getUTCFullYear() === d.getUTCFullYear())) continue;
    const close = (tf === 'M' ? 30000 : tf === 'W' ? 20000 : 10000) + Math.floor((date - parse('20240101')) / day);
    result.push({ t_ms: date, open: close - 3, high: close + 7, low: close - 9, close, volume: 777, trade_value_won: 123456789 });
  }
  return result;
}
type SetupOptions = { sourceTf?: 'W' | 'M'; targetTf?: 'D' | 'W' | 'M'; minute?: boolean;
  daily?: 'normal' | 'empty' | 'partial' | 'failed' | 'delayed'; wrongStock?: boolean; missingTarget?: boolean; sourceFrom?: string; sourceTo?: string; lastDailyDate?: string; now?: string; peer?: boolean; coldTarget?: boolean };
async function setup(page: Page, options: SetupOptions = {}) {
  const sourceTf = options.sourceTf ?? 'M';
  const targetTf = options.targetTf ?? 'D';
  const sourceTo = options.sourceTo ?? (sourceTf === 'M' ? '20260331' : '20260405');
  const sourceFrom = options.sourceFrom ?? (sourceTf === 'M' ? '20260301' : '20260330');
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: Array<{ path: string; from: string; to: string; tf: string }> = [];
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.clock.setFixedTime(new Date(options.now ?? '2026-11-04T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const frames = [{ id: 'source', tf: sourceTf, x: 0, y: 0 }, { id: 'target', tf: targetTf, x: .5, y: 0 },
    ...(options.minute ? [{ id: 'minute', tf: '3m', x: 0, y: .5 }] : []),
    ...(options.peer ? [{ id: 'peer', tf: 'W', x: .5, y: .5 }] : [])];
  await page.addInitScript(({ frames, wrongStock }) => {
    sessionStorage.setItem('live.workspace.v1', JSON.stringify({ schema_version: 2,
      windows: frames.map(w => ({ id: w.id, kind: 'chart', group: 1,
        rect: { x: w.x, y: w.y, w: .5, h: .5 }, chart: { timeframe: w.tf },
        ...(w.id === 'target' && wrongStock ? { pinned: { code: '000660', name: 'SK하이닉스' } } : {}) })),
      zOrder: frames.map(w => w.id), groupSymbols: { 1: { code: '005930', name: '삼성전자' } } }));
    localStorage.setItem('live.venue.v1', JSON.stringify({ state: { venue: 'KRX' }, version: 0 }));
  }, { frames, wrongStock: options.wrongStock });
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
    schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false,
  } }));
  await page.route(apiExact('live/series'), route => route.fulfill({ json: {
    code: new URL(route.request().url()).searchParams.get('code'), date: '20261104',
    session_open_ms: parse('20261104'), session_close_ms: parse('20261104') + 23400000,
    is_open: false, snapshots: [], trades: [], brokers: [],
  } }));
  await page.route(/\/api\/live\/past-(daily|calendar)-candles\?/, async route => {
    const u = new URL(route.request().url());
    const p = u.searchParams;
    const from = p.get('from') ?? ''; const to = p.get('to') ?? '';
    const rawTf = p.get('timeframe'); const tf = rawTf === 'W' || rawTf === 'M' ? rawTf : 'D';
    const lookup = tf === 'D' && from === sourceFrom && to === sourceTo;
    requests.push({ path: u.pathname, from, to, tf });
    if (lookup && options.daily === 'delayed') await gate;
    if (lookup && options.daily === 'failed') { await route.fulfill({ status: 503, json: { detail: 'fixture failure' } }); return; }
    const end = tf === sourceTf && to > sourceTo ? sourceTo : to;
    let candles = lookup && options.daily === 'empty' ? [] : bars(from, end, tf);
    const lastDailyDate = options.lastDailyDate;
    if (lookup && lastDailyDate) candles = candles.filter(c => ymd(c.t_ms) <= lastDailyDate);
    if (!lookup && options.coldTarget && tf === targetTf && from > sourceTo) candles = [];
    if (!lookup && options.missingTarget) candles = candles.filter(c => ymd(c.t_ms) !== '20260330');
    await route.fulfill({ json: { code: p.get('code'), from, to, venue: p.get('venue'),
      ...(tf === 'D' ? {} : { timeframe: tf }), candles, cached_batches: [], fresh_batches: [from],
      data_warnings: lookup && options.daily === 'partial' ? [{ batch: from, reason: 'transport_error', is_failure: true, msg: 'fixture partial' }] : [] } });
  });
  await page.route(apiExact('live/past-candles'), route => {
    const p = new URL(route.request().url()).searchParams;
    const from = p.get('from') ?? ''; const to = p.get('to') ?? '';
    requests.push({ path: 'minute', from, to, tf: '3m' });
    const bucket = Number(p.get('bucket_ms') ?? 180000);
    const candles = bars(from, to, 'D').flatMap(c => Array.from({ length: Math.ceil(23400000 / bucket) }, (_, i) => ({ ...c, t_ms: c.t_ms + i * bucket })));
    return route.fulfill({ json: { code: p.get('code'), from, to, venue: p.get('venue'), bucket_ms: bucket,
      candles, cached_dates: [], fresh_dates: [], data_warnings: [] } });
  });
  await page.route(apiExact('range'), route => {
    const p = new URL(route.request().url()).searchParams;
    const from = p.get('from') ?? ''; const to = p.get('to') ?? '';
    return route.fulfill({ json: { code: p.get('code'), from_date: from, to_date: to,
      bucket_ms: Number(p.get('bucket_ms') ?? 180000), segments: bars(from, to, 'D').map(c => ({ date: ymd(c.t_ms),
        session_open_ms: c.t_ms, session_close_ms: c.t_ms + 23400000, source: 'kiwoom_live' })),
      candles: [], quote_ratio: { bucket_ms: 180000, points: [] }, fill_strength: { bucket_ms: 180000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [], volume_distributions: [], investorPoints: [], ask_peaks: [], bid_peaks: [],
      trade_volume_pocs: [], broker_late_entries: [], excluded_dates: [], missing_dates: [], data_warnings: [] } });
  });
  await page.goto('/live');
  await expect(page.locator('[data-win="source"]').getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  await expect(page.locator('[data-win="target"]').getByTestId('chart-reveal-cover')).toHaveCSS('opacity', '0');
  return { requests, release, errors, sourceFrom, sourceTo };
}
async function pan(page: Page, id: string, direction = 1) {
  const box = await page.locator(`[data-win="${id}"]`).getByTestId('live-chart-root').boundingBox();
  if (!box) throw new Error(`no bounds for ${id}`);
  await page.mouse.move(box.x + box.width * .45, box.y + box.height * .4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (.45 + direction * .25), box.y + box.height * .4, { steps: 20 });
  await page.mouse.up();
}
async function snapshot(page: Page, id: string) {
  return page.evaluate(id => {
    const chart = window.__liveCharts?.get(id);
    const series = chart?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick');
    const range = chart?.timeScale().getVisibleLogicalRange();
    if (!chart || !series || !range) throw new Error(`missing dev chart handle ${id}`);
    const rows = series.data(); const last = rows.at(-1);
    if (!last) throw new Error('no chart rows');
    const lastIndex = chart.timeScale().timeToIndex(last.time, false);
    if (lastIndex === null) throw new Error('no global last index');
    const right = rows.findLast(row => {
      const index = chart.timeScale().timeToIndex(row.time, false);
      return 'close' in row && index !== null && index <= range.to;
    });
    return { rows, range, span: range.to - range.from, padding: Math.max(0, range.to - (lastIndex + 1)),
      rightClose: right && 'close' in right ? right.close : null,
      rightX: right ? chart.timeScale().timeToCoordinate(right.time) : null };

  }, id);
}

for (const [sourceTf, targetTf] of [['M', 'W'], ['M', 'D'], ['W', 'M'], ['W', 'D']] satisfies Array<['M' | 'W', 'M' | 'W' | 'D']>) {
  test(`${sourceTf} → ${targetTf} works with calendar-only receivers, repeat and clear`, async ({ page }, info) => {
    const fixture = await setup(page, { sourceTf, targetTf });
    const button = page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button');
    await expect(button).toBeEnabled();
    await button.click();
    const chip = page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip');
    const date = sourceTf === 'W' ? '04-03' : '03-30';
    await expect(chip).toHaveText(`점프 ${date}`);
    await chip.getByRole('button', { name: '기간 점프 해제' }).click();
    await expect(chip).toHaveCount(0);
    await page.locator('[data-win="source"]').click({ position: { x: 80, y: 15 } });
    await page.keyboard.press('g');
    await expect(chip).toHaveText(`점프 ${date}`);
    expect(fixture.requests.filter(r => r.from === fixture.sourceFrom && r.to === fixture.sourceTo && r.tf === 'D')).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${sourceTf}-${targetTf}.png`) });
    await info.attach('requests', { body: JSON.stringify(fixture.requests), contentType: 'application/json' });
  });
}

test('delayed daily lookup leaves minute immediate and a real target pan cancels late placement', async ({ page }, info) => {
  const fixture = await setup(page, { minute: true, daily: 'delayed' });
  await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
  await expect(page.locator('[data-win="minute"]').getByTestId('live-minute-jump-chip')).toContainText('03-30');
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toContainText('거래일 확인 중');
  await pan(page, 'target');
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toContainText('이동 취소됨');
  fixture.release();
  await expect.poll(() => fixture.requests.some(r => r.from === fixture.sourceFrom && r.to === fixture.sourceTo)).toBe(true);
  await page.locator('[data-win="source"]').getByRole('group', { name: 'LiveTimeframe' }).getByRole('button', { name: '주', exact: true }).click();
  await expect(page.locator('[data-win="minute"]').getByTestId('live-minute-jump-chip')).toContainText('03-30');
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('delayed-pan.png') });
});

for (const daily of ['empty', 'partial', 'failed'] satisfies SetupOptions['daily'][]) {
  test(`daily ${daily} is terminal without claiming a candle`, async ({ page }) => {
    await setup(page, { daily });
    await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
    await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip'))
      .toContainText(daily === 'empty' ? '봉 없음' : '조회 실패', { timeout: 15000 });
  });
}

test('a different actual pinned stock cannot enable a calendar-only jump', async ({ page }) => {
  await setup(page, { wrongStock: true });
  await expect(page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button')).toBeDisabled();
});

test('missing exact target candle ends as no-data rather than using its neighbour', async ({ page }) => {
  await setup(page, { missingTarget: true });
  await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toContainText('봉 없음');
});

test('dev geometry proves native OHLCV and captured span with live and historical gutter', async ({ page }, info) => {
  test.skip(process.env.E2E_CALENDAR_GEOMETRY !== '1', 'Requires dev window-id chart handles; built UI journeys run separately.');
  const fixture = await setup(page, { sourceTf: 'W', targetTf: 'M', daily: 'delayed' });
  const before = await snapshot(page, 'target');
  await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
  fixture.release();
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toHaveText('점프 04-03');
  const after = await snapshot(page, 'target');
  expect(after.rows).toEqual(before.rows);
  expect(after.span).toBeCloseTo(before.span, 5);
  const expected = before.rows.find(c => 'close' in c && c.close === 30821);
  expect(expected).toBeDefined();
  const placement = await page.evaluate(({ expected, padding }) => {
    const chart = window.__liveCharts?.get('target');
    if (!chart || !expected) throw new Error('missing expected native candle');
    const index = chart.timeScale().timeToIndex(expected.time, false);
    const range = chart.timeScale().getVisibleLogicalRange();
    return { to: range?.to, expectedTo: index === null ? null : index + 1 + padding };
  }, { expected, padding: before.padding });
  expect(placement.to).toBeCloseTo(placement.expectedTo ?? NaN, 5);
  await pan(page, 'target');
  const panned = await snapshot(page, 'target');
  expect(Math.abs(panned.range.from - after.range.from)).toBeGreaterThan(1);
  await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toHaveText('점프 04-03');
  const repeated = await snapshot(page, 'target');
  expect(repeated.span).toBeCloseTo(panned.span, 5);
  expect(panned.padding).toBe(0);
  const historicalTo = await page.evaluate(expected => {
    const chart = window.__liveCharts?.get('target');
    if (!chart || !expected) throw new Error('missing native target');
    const index = chart.timeScale().timeToIndex(expected.time, false);
    return index === null ? NaN : index + 1;
  }, expected);
  expect(repeated.range.to).toBeCloseTo(historicalTo, 5);
  await info.attach('geometry', { body: JSON.stringify({ before, after, placement, panned, repeated }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('calendar-geometry.png') });
});

for (const scenario of [
  { name: 'month-end holiday', sourceTf: 'M', targetTf: 'W', sourceFrom: '20260801', sourceTo: '20260831', lastDailyDate: '20260828', label: '08-28' },
  { name: 'year-boundary week', sourceTf: 'W', targetTf: 'M', sourceFrom: '20251229', sourceTo: '20260104', lastDailyDate: '20260102', label: '01-02' },
  { name: 'ongoing week', sourceTf: 'W', targetTf: 'M', sourceFrom: '20261102', sourceTo: '20261104', lastDailyDate: '20261104', label: '11-04' },
] satisfies Array<SetupOptions & { name: string; label: string }>) {
  test(`${scenario.name} uses the last observed daily date`, async ({ page }) => {
    await setup(page, scenario);
    await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
    await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toHaveText(`점프 ${scenario.label}`);
  });
}

test('dev geometry proves no late pull after pan while daily lookup is pending', async ({ page }, info) => {
  test.skip(process.env.E2E_CALENDAR_GEOMETRY !== '1', 'Requires dev window-id chart handles; built UI journeys run separately.');
  const fixture = await setup(page, { minute: true, peer: true, daily: 'delayed' });
  await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
  await expect(page.locator('[data-win="minute"]').getByTestId('live-minute-jump-chip')).toContainText('03-30');
  const before = await snapshot(page, 'target');
  await pan(page, 'target');
  const panned = await snapshot(page, 'target');
  expect(Math.abs(panned.range.from - before.range.from)).toBeGreaterThan(1);
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toContainText('이동 취소됨');
  const response = page.waitForResponse(r => r.url().includes(`from=${fixture.sourceFrom}&to=${fixture.sourceTo}`));
  fixture.release();
  await response;
  await expect(page.locator('[data-win="peer"]').getByTestId('live-calendar-jump-chip')).toHaveText('점프 03-30');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  const after = await snapshot(page, 'target');
  expect(after.span).toBeCloseTo(panned.span, 5);
  expect(after.range.from - panned.range.from).toBeCloseTo(after.rows.length - panned.rows.length, 5);
  expect(after.rightClose).toBe(panned.rightClose);
  expect(after.rightX).toBeCloseTo(panned.rightX ?? NaN, 1);
  await info.attach('late-response-geometry', { body: JSON.stringify({ before, panned, after }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('cancelled-without-pull.png') });
});

test('dev geometry proves existing history extension preserves the captured viewport span', async ({ page }, info) => {
  test.skip(process.env.E2E_CALENDAR_GEOMETRY !== '1', 'Requires dev window-id chart handles; built UI journeys run separately.');
  const fixture = await setup(page, { sourceFrom: '20250101', sourceTo: '20250131', lastDailyDate: '20250130' });
  const before = await snapshot(page, 'target');
  await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toHaveText('점프 25-01-30');
  const after = await snapshot(page, 'target');
  expect(after.rows.length).toBeGreaterThan(before.rows.length);
  expect(after.span).toBeCloseTo(before.span, 5);
  expect(fixture.requests.some(r => r.from === '20250130' && r.to === '20261104')).toBe(true);
  await info.attach('extended-geometry', { body: JSON.stringify({ before, after, requests: fixture.requests }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('extended-history.png') });
});

test('an initially empty calendar target loads the requested historical period and lands', async ({ page }) => {
  const fixture = await setup(page, { sourceFrom: '20250101', sourceTo: '20250131', lastDailyDate: '20250130', coldTarget: true });
  await page.locator('[data-win="source"]').getByTestId('live-jump-to-minute-button').click();
  await expect(page.locator('[data-win="target"]').getByTestId('live-calendar-jump-chip')).toHaveText('점프 25-01-30');
  expect(fixture.requests.some(r => r.from === '20250130' && r.to === '20261104')).toBe(true);
});
