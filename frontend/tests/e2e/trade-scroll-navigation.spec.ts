import { expect, test, type Locator, type Page } from '@playwright/test';
import type { IChartApi } from 'lightweight-charts';
import { setup, hoverCandle, START, DATE } from './helpers/tradeCursorMocks';
import type { LiveTimeframe } from '../../src/state/livePage';

type ChartsWindow = Window & { __liveCharts: Map<string, IChartApi>;
  __tapeCrosshairEvents?: { time: number | null; pointer: boolean }[] };
const tapeOf = (page: Page) => page.locator('[data-win="cursor-trade"] [data-testid="trade-window"]');
async function frame(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function scrollTo(scroll: Locator, top: number) {
  return await scroll.evaluate((el, value) => { el.scrollTop = value; return el.scrollTop; }, top);
}
async function arrange(page: Page, tf: LiveTimeframe, options: { failure?: boolean; changed?: boolean; targetCandle?: boolean } = {}) {
  const result = await setup(page, tf, true, options.targetCandle ? 1000 : 240, !!options.targetCandle);
  const step = Number(tf.slice(0, -1)) * (tf.endsWith('s') ? 1000 : 60000);
  const requests: URL[] = [], books: URL[] = [];
  let seed = 0, failed = false;
  await page.route('**/api/orderbook?**', async route => {
    const u = new URL(route.request().url()); books.push(u);
    const t = Number(u.searchParams.get('t'));
    await route.fulfill({ json: { source: u.searchParams.get('source_pref'), available_from: t,
      snapshot: { ts_ms: t, ask: Array.from({ length: 10 }, (_, i) => ({ price: 35100 + 50 * i, qty: 1000 + (t - START) / 1000 })),
        bid: Array.from({ length: 10 }, (_, i) => ({ price: 35050 - 50 * i, qty: 1000 + (t - START) / 1000 })), tot_ask: 1000, tot_bid: 1000 } } });
  });
  await page.route('**/api/trades/spot?**', async route => {
    const url = new URL(route.request().url()); requests.push(url);
    const p = url.searchParams, from = Number(p.get('from_ms'));
    const head = seed === 0 || from === seed;
    const cursor = p.get('cursor');
    if (cursor && options.failure && !failed) {
      failed = true;
      await route.fulfill({ status: options.changed ? 409 : 503, json: { detail: 'fixture failure' } });
      return;
    }
    const aggregate = p.get('source_pref') !== 'hogaplay';
    const count = head ? (cursor ? 40 : 200) : 80;
    const offset = cursor ? 200 : 0;
    await route.fulfill({ json: {
      code: p.get('code'), date: p.get('date'), venue: p.get('venue'), source_pref: p.get('source_pref'),
      from_ms: from, to_ms: Number(p.get('to_ms')), source: aggregate ? 'kiwoom_live' : 'hogaplay',
      representation: aggregate ? 'second_price_aggregate' : 'ticks', status: 'observed', coverage: 'unverified',
      storage_error: null, revision: 'r1', prev_close: 35000,
      has_more: head && !cursor, next_cursor: head && !cursor ? 'tail' : null,
      previous_observed_ms: from > START + step * 2 ? from - step * (options.targetCandle ? 599 : 1) - 1 : null,
      rows: Array.from({ length: count }, (_, i) => ({ event_id: `${from}:${offset + i}`,
        t_ms: from + Math.max(0, step - 1 - (offset + i)), price: 35100, qty: 100 + i, side: 1, count: aggregate ? 3 : 1 })),
    } });
  });
  await hoverCandle(page, tf.endsWith('s'));
  const tape = tapeOf(page);
  await expect(tape).toHaveAttribute('data-mode', 'spot');
  await expect(tape.locator('[data-tape-event]').first()).toBeVisible();
  await tape.locator('[data-tape-event]').first().hover();
  const scroll = tape.getByLabel('체결 탐색 목록');
  await expect(scroll).toBeVisible();
  await expect(tape).toHaveAttribute('data-loaded-count', '200');
  seed = Number(await tape.getAttribute('data-reading-ms'));
  await page.mouse.wheel(0, 100);
  await expect(tape).toHaveAttribute('data-mode', 'browse');
  return { ...result, requests, books, tape, scroll, seed, step };
}

for (const tf of ['1m', '5m', '1s', '5s', '10s', '30s'] as const) {
  test(`${tf}: 체결 페이지를 먼저 소진하고 이전 봉을 이어 붙이며 읽는 봉에 차트·10호가가 함께 이동한다`, async ({ page }, testInfo) => {
    const { tape, scroll, requests, books, errors, seed, step } = await arrange(page, tf);
    const marker = page.locator('[data-win="cursor-chart"] [data-testid="trade-browse-crosshair"]');
    await expect(marker).toHaveAttribute('data-rendered-ms', String(seed));
    await page.evaluate(() => {
      const w = window as unknown as ChartsWindow;
      w.__tapeCrosshairEvents = [];
      w.__liveCharts.get('cursor-chart')!.subscribeCrosshairMove(e => {
        w.__tapeCrosshairEvents!.push({ time: typeof e.time === 'number' ? e.time : null, pointer: !!e.sourceEvent });
      });
    });
    // Constrain the viewport so browsing backwards must pan, without changing its span.
    await page.evaluate(() => {
      const scale = (window as unknown as ChartsWindow).__liveCharts.get('cursor-chart')!.timeScale();
      const range = scale.getVisibleLogicalRange()!;
      scale.setVisibleLogicalRange({ from: range.to - 5, to: range.to });
    });
    await frame(page);
    const span = await page.evaluate(() => {
      const r = (window as unknown as ChartsWindow).__liveCharts.get('cursor-chart')!.timeScale().getVisibleLogicalRange()!;
      return r.to - r.from;
    });
    await scrollTo(scroll, 1e8);
    await expect(tape).toHaveAttribute('data-loaded-count', '240');
    expect(requests.at(-1)!.searchParams.get('cursor')).toBe('tail');
    expect(Number(requests.at(-1)!.searchParams.get('from_ms'))).toBe(seed);
    await page.mouse.wheel(0, 1);
    const appendTop = await scrollTo(scroll, 1e8);
    await expect(tape).toHaveAttribute('data-loaded-count', '320');
    expect(await scroll.evaluate(el => el.scrollTop)).toBe(appendTop);
    // Loading data below the viewport must not move the time consumers.
    await expect(tape).toHaveAttribute('data-reading-ms', String(seed));
    expect(Number(books.at(-1)!.searchParams.get('t'))).toBe(seed);
    const older = Number(requests.at(-1)!.searchParams.get('from_ms'));
    expect(older).toBe(seed - step * 2); // an empty bar is skipped, never fabricated
    const rowHeight = await tape.locator('[data-tape-event]').first().evaluate(el => el.getBoundingClientRect().height);
    await scrollTo(scroll, 240 * rowHeight + 36);
    await expect(tape).toHaveAttribute('data-reading-ms', String(older));
    await expect(marker).toHaveAttribute('data-rendered-ms', String(older));
    await expect.poll(() => Number(books.at(-1)!.searchParams.get('t'))).toBe(older);
    await expect(page.locator('[data-win="cursor-book"]').getByText((1000 + (older - START) / 1000).toLocaleString('ko-KR'), { exact: true }).first()).toBeVisible();
    expect(books.at(-1)!.searchParams.get('source_pref')).toBe('hogaplay');
    expect(books.at(-1)!.searchParams.get('date')).toBe(DATE);
    expect(books.at(-1)!.searchParams.has('bucket_ms')).toBe(!tf.endsWith('s'));
    const viewport = await page.evaluate(({ index }) => {
      const chart = (window as unknown as ChartsWindow).__liveCharts.get('cursor-chart')!;
      const r = chart.timeScale().getVisibleLogicalRange()!;
      const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const bar = series.data()[index];
      return { span: r.to - r.from, x: chart.timeScale().timeToCoordinate(bar.time), width: chart.timeScale().width(), time: bar.time };
    }, { index: Math.round((older - START) / step) });
    expect(viewport.span).toBeCloseTo(span, 4);
    expect(viewport.x).not.toBeNull();
    expect(viewport.x!).toBeGreaterThanOrEqual(0);
    expect(viewport.x!).toBeLessThanOrEqual(viewport.width);
    // A native data repaint re-emits crosshairMove without a real sourceEvent.
    // It must not steal the tape's time channel.
    await page.evaluate(() => {
      const series = (window as unknown as ChartsWindow).__liveCharts.get('cursor-chart')!.panes()[0]
        .getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const last = series.data().at(-1)!;
      series.update({ ...last });
    });
    await frame(page);
    await expect(tape).toHaveAttribute('data-mode', 'browse');
    await expect(tape).toHaveAttribute('data-reading-ms', String(older));
    await expect.poll(() => page.evaluate(() => (window as unknown as ChartsWindow).__tapeCrosshairEvents?.filter(e => !e.pointer && e.time !== null).at(-1)?.time)).toBe(viewport.time);
    // Virtualization keeps mounted rows bounded even after multiple API pages.
    expect(await tape.locator('[data-tape-event]').count()).toBeLessThan(70);
    if (tf === '1m') await page.screenshot({ path: testInfo.outputPath('trade-scroll-older.png') });
    await scrollTo(scroll, 0);
    await expect(tape).toHaveAttribute('data-reading-ms', String(seed));
    await expect(marker).toHaveAttribute('data-rendered-ms', String(seed));
    await expect(page.locator('[data-win="cursor-book"]').getByText((1000 + (seed - START) / 1000).toLocaleString('ko-KR'), { exact: true }).first()).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(tape).toHaveAttribute('data-mode', 'browse');
    await expect(page.locator('[data-win="other-trade"] [data-testid="trade-window"]')).toHaveAttribute('data-mode', 'latest');
    if (tf === '1m') await page.screenshot({ path: testInfo.outputPath('trade-scroll-linked.png') });
    await hoverCandle(page, tf.endsWith('s'));
    await expect(tape).toHaveAttribute('data-mode', 'spot');
    await expect(marker).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('조회 실패는 위치·기존 행을 보존해 재시도하고 최신으로/연동 OFF는 탐색을 종료한다', async ({ page }) => {
  const { tape, scroll, requests, seed, errors } = await arrange(page, '1m', { failure: true });
  await scrollTo(scroll, 1e8);
  await expect(tape.getByRole('alert')).toContainText('이전 체결 조회 실패');
  await expect(tape).toHaveAttribute('data-loaded-count', '200');
  await expect(tape).toHaveAttribute('data-reading-ms', String(seed));
  const top = await scroll.evaluate(el => el.scrollTop);
  await tape.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(tape).toHaveAttribute('data-loaded-count', '240');
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(top);
  await tape.getByRole('button', { name: '최신으로', exact: true }).click();
  await expect(tape).toHaveAttribute('data-mode', 'latest');
  await hoverCandle(page, false);
  await expect(tape).toHaveAttribute('data-mode', 'spot');
  await tape.locator('[data-tape-event]').first().hover();
  await page.mouse.wheel(0, 20);
  await expect(tape).toHaveAttribute('data-mode', 'browse');
  await page.locator('[data-win="cursor-chart"]').getByRole('button', { name: '호버 연동', exact: true }).click();
  await expect(tape).toHaveAttribute('data-mode', 'latest');
  expect(requests.filter(r => r.searchParams.has('cursor')).length).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('409 재시작은 이전 페이지 커서를 버리고 첫 봉부터 다시 가져온다', async ({ page }) => {
  const { tape, scroll, requests, seed } = await arrange(page, '5s', { failure: true, changed: true });
  await scrollTo(scroll, 1e8);
  await expect(tape.getByRole('alert')).toContainText('체결 데이터가 변경되었습니다');
  await tape.getByRole('button', { name: '처음부터 다시 조회' }).click();
  await expect(tape.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => requests.at(-1)?.searchParams.has('cursor')).toBe(false);
  expect(Number(requests.at(-1)!.searchParams.get('from_ms'))).toBe(seed);
  await expect(tape).toHaveAttribute('data-loaded-count', '200');
  await expect(tape).toHaveAttribute('data-reading-ms', String(seed));
});

test('체결창이 아직 로드되지 않은 과거 초봉을 가리키면 그 시각의 차트 구간을 추가로 읽는다', async ({ page }) => {
  const { tape, scroll, secondRequests, seed } = await arrange(page, '1s', { targetCandle: true });
  const chart = page.getByTestId('second-chart');
  await expect(chart).toHaveAttribute('data-bar-count', '240');
  await scrollTo(scroll, 1e8);
  await expect(tape).toHaveAttribute('data-loaded-count', '240');
  await scrollTo(scroll, 1e8);
  await expect(tape).toHaveAttribute('data-loaded-count', '320');
  const rowHeight = await tape.locator('[data-tape-event]').first().evaluate(el => el.getBoundingClientRect().height);
  await scrollTo(scroll, 240 * rowHeight + 36);
  const older = seed - 600000;
  await expect(tape).toHaveAttribute('data-reading-ms', String(older));
  await expect(chart).toHaveAttribute('data-bar-count', String(240 + Math.min(240, (older - START) / 1000 + 1)));
  const marker = page.locator('[data-win="cursor-chart"] [data-testid="trade-browse-crosshair"]');
  await expect(marker).toHaveAttribute('data-rendered-ms', String(older));
  expect(secondRequests.some(r => Number(r.searchParams.get('to_ms')) === older + 1000
    && Number(r.searchParams.get('from_ms')) === older + 1000 - 240000)).toBe(true);
});

test('탐색 중 hogaplay 우선 설정 변경은 기존 탐색을 종료하고 다음 탐색은 WS로 이어진다', async ({ page }) => {
  const { tape, requests, books, errors } = await arrange(page, '1m');
  await page.getByRole('button', { name: '설정', exact: true }).first().click();
  const editor = page.getByTestId('settings-shell');
  await editor.getByTestId('settings-nav-data-source').click();
  await editor.getByRole('switch', { name: 'KRX에서 hogaplay 우선', exact: true }).click();
  await expect(tape).toHaveAttribute('data-mode', 'latest');
  await page.keyboard.press('Escape');
  await hoverCandle(page, false);
  await expect(tape).toContainText('WS · 1초 집계');
  await tape.locator('[data-tape-event]').first().hover();
  await page.mouse.wheel(0, 20);
  await expect(tape).toHaveAttribute('data-mode', 'browse');
  const scroll = tape.getByLabel('체결 탐색 목록');
  await scrollTo(scroll, 1e8);
  await expect(tape).toHaveAttribute('data-loaded-count', '240');
  expect(requests.at(-1)!.searchParams.get('source_pref')).toBe('kiwoom_live');
  expect(books.at(-1)!.searchParams.get('source_pref')).toBe('kiwoom_live');
  await expect(tape.getByRole('columnheader', { name: '합산량(주)' })).toBeVisible();
  expect(errors).toEqual([]);
});
