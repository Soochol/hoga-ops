import { test, expect, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';

async function marketMocks(page: Page, populated = false) {
  await installLiveMocks(page);
  await page.route(apiPrefix('market/'), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.split('/').at(-1);
    const responses: Record<string, unknown> = {
      sectors: { markets: { '0': { sectors: [{ code: '1', name: '긴 업종 이름', change_pct: 2 }] } }, volatility: { value: 20, change_pct: 1 } },
      'futures-quotes': { quotes: [], session: 'closed' },
      funds: { as_of: '20260904', series: [
        { date: '20260901', deposit_won: 100e12, credit_won: 30e12, cma_won: 80e12 },
        { date: '20260904', deposit_won: 93.5e12, credit_won: 31e12, cma_won: 81e12 },
      ] },
      'investor-flow': { date: '20260909', confirmed: false, markets: populated ? { KOSPI: [
        { t_ms: Date.UTC(2026, 8, 9, 0), individual: 10, foreign: -5, institution: -5 },
        { t_ms: Date.UTC(2026, 8, 9, 1), individual: 20, foreign: -10, institution: -10 },
      ] } : {}, coverage: {}, daily: [
        { date: '20260908', markets: { KOSPI: { foreign: 100, institution: -100 } } },
      ] },
      'deriv-flow': { date: '20260909', products: {}, unit: null },
      'sector-flow': { date: '20260909', markets: {} },
      program: { markets: { KOSPI: [
        { t: '200000', arb_net_eok: 100, non_arb_net_eok: -20, total_net_eok: 80 },
        { t: '182100', arb_net_eok: 50, non_arb_net_eok: -10, total_net_eok: 40 },
      ] } },
      streaks: {}, breadth: { markets: {} }, 'trade-value': { markets: {} },
    };
    if (populated && path === 'program') {
      const points = ['090000', '100000'].map((t, i) => ({
        t: url.searchParams.get('axis') === 'daily' ? `2026090${9 - i}000000` : t,
        arb_net_eok: 100 + i * 10, non_arb_net_eok: -20, total_net_eok: 80 + i * 10,
      }));
      responses.program = { markets: { KOSPI: points, KOSDAQ: points } };
    }
    await route.fulfill({ json: responses[path ?? ''] ?? {} });
  });
  await page.route(apiPrefix('live/index-quotes'), (r) => r.fulfill({ json: { quotes:
    ['KOSPI', 'KOSDAQ', 'KOSPI200', 'KOSDAQ150'].map((id) => ({ id, label: id, value: 1234.5, change: 1, change_rate: 0.1, t_ms: 1 })),
  } }));
  await page.route(apiPrefix('live/index-candles'), (r) => r.fulfill({ json: { candles: [] } }));
  await page.route(apiPrefix('live/rankings'), (r) => r.fulfill({ json: {
    rows: [{ rank: 1, code: '005930', name: '삼성전자', price: 71200, change_pct: 1, trade_value_won: 3119200000000 }],
    market_open: false, fetched_at_ms: 1, venue: 'KRX', warnings: [],
  } }));
}

for (const width of [1440, 800, 600]) {
  test(`market cards fit available width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await marketMocks(page);
    await page.goto('/market');
    const market = page.locator('.market-page');
    await expect(market.getByText('93.5조', { exact: true })).toBeVisible();
    await expect(market.getByText('거래대금(억)')).toHaveCount(1);
    const metrics = await market.evaluate((el) => ({
      right: el.getBoundingClientRect().right,
      overflow: [...el.querySelectorAll<HTMLElement>('.market-main,.market-pair,.market-ranks,.market-indices')]
        .map((grid) => grid.scrollWidth - grid.clientWidth),
    }));
    expect(metrics.right).toBeLessThanOrEqual(width);
    expect(metrics.overflow.every((px) => px <= 1)).toBe(true);
    await market.getByText('거래대금(억)').scrollIntoViewIfNeeded();
    await expect(market.getByText('31,192', { exact: true })).toBeVisible();
  });
}

test('market empty-state action, chart keyboard inspection and after-hours axis', async ({ page }) => {
  await marketMocks(page);
  await page.goto('/market');
  const market = page.locator('.market-page');
  await expect(market.getByText('20:00', { exact: true })).toBeVisible();
  await market.getByRole('button', { name: '일별 수급 보기' }).click();
  await expect(market.getByText('09/08 기준', { exact: true })).toBeVisible();
  const chart = market.getByRole('group', { name: /차트 상세/ }).last();
  await chart.focus();
  await chart.press('Home');
  await expect(chart.getByRole('status')).toContainText('09/01');
  await chart.press('End');
  await expect(chart.getByRole('status')).toContainText('09/04');
  await expect(chart.getByRole('status')).toContainText('-6.5조원');
});

for (const populated of [false, true]) for (const width of [1440, 800, 600]) {
  test(`mode switches preserve card and scroll positions at ${width}px (populated=${populated})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await marketMocks(page, populated);
    await page.goto('/market');
    await expect(page.getByText('93.5조', { exact: true })).toBeVisible();
    for (const label of ['수급 표시 구간', '프로그램 표시 구간']) {
      const group = page.getByRole('group', { name: label, exact: true });
      await group.scrollIntoViewIfNeeded();
      const positions = () => page.locator('.market-page').evaluate((root) => ({
        headings: [...root.querySelectorAll('h2')].map((el) => el.getBoundingClientRect().top),
        buttons: [...root.querySelectorAll('[aria-label="수급 표시 구간"] button,[aria-label="프로그램 표시 구간"] button')].map((el) => ({ top: el.getBoundingClientRect().top, left: el.getBoundingClientRect().left })),
        scroll: [...root.querySelectorAll('*')].filter((el) => el.scrollTop > 0).map((el) => el.scrollTop),
      }));
      const before = await positions();
      for (const mode of ['일별', '당일', '일별', '당일']) {
        await group.getByRole('button', { name: mode, exact: true }).click();
        expect(await positions()).toEqual(before);
        if (populated && label === '프로그램 표시 구간') {
          if (mode === '일별') await expect(page.getByText('표본 2거래일', { exact: true })).toHaveCount(2);
          else await expect(page.getByText(/표본 2개/)).toHaveCount(2);
        }
        await expect.poll(positions).toEqual(before);
        if (populated) {
          const overflow = await page.locator('.market-investor-body,.market-program-body')
            .evaluateAll(elements => elements.map(el => el.scrollHeight - el.clientHeight));
          expect(overflow.every(px => px <= 1)).toBe(true);
        }
      }
    }
  });
}

test('daily list keeps its header and total visible while dates scroll', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await marketMocks(page);
  await page.route(apiPrefix('market/investor-flow'), route => route.fulfill({ json: {
    date: '20260909', markets: {}, daily: Array.from({ length: 20 }, (_, i) => ({
      date: `202608${String(i + 1).padStart(2, '0')}`,
      markets: { KOSPI: { foreign: i * 100, institution: -i * 10 } },
    })),
  } }));
  await page.goto('/market');
  await page.getByRole('group', { name: '수급 표시 구간', exact: true }).getByRole('button', { name: '일별', exact: true }).click();
  const table = page.getByRole('table', { name: '투자자 일별 수급 · 단위 억원' });
  await expect(table.locator('.daily-net-rows [role="row"]').first()).toContainText('08/20');
  const viewport = page.getByRole('region', { name: '투자자 일별 수급 목록 스크롤' });
  await viewport.scrollIntoViewIfNeeded();
  const metrics = () => viewport.evaluate(el => ({
    header: el.querySelector('.daily-net-heading')!.getBoundingClientRect().top,
    footer: el.querySelector('.daily-net-total')!.getBoundingClientRect().bottom,
    overflow: el.scrollWidth - el.clientWidth,
  }));
  const before = await metrics();
  await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const after = await metrics();
  // scrollTop is rounded to CSS pixels, while row heights may be fractional.
  expect(Math.abs(after.header - before.header)).toBeLessThan(1);
  expect(Math.abs(after.footer - before.footer)).toBeLessThan(1);
  expect(after.overflow).toBeLessThanOrEqual(1);
  expect(before.overflow).toBeLessThanOrEqual(1);
  await expect(table.locator('.daily-net-rows [role="row"]').last()).toBeInViewport();
});

test('investor flow refreshes every ten seconds after 15:30 and recovers from API failure', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-10T15:31:00+09:00') });
  await marketMocks(page, true);
  let count = 2;
  let failing = false;
  let requests = 0;
  const t = Date.parse('2026-09-10T15:31:00+09:00');
  await page.route(apiPrefix('market/investor-flow'), async (route) => {
    requests++;
    if (failing) {
      await route.fulfill({ status: 503, json: { detail: 'temporarily unavailable' } });
      return;
    }
    const received = t + (count - 2) * 10_000;
    await route.fulfill({ json: {
      date: '20260910', unit: 'amt_eok', confirmed: false, daily: [],
      session_start_sec: 8 * 3600, session_end_sec: 16.5 * 3600,
      markets: { KOSPI: [
        { t_ms: t - 10_000, individual: 10, foreign: -5, institution: -5 },
        { t_ms: received, individual: 20, foreign: -10, institution: -10 },
      ] },
      coverage: { KOSPI: { first_sample_ms: t - 10_000, last_sample_ms: received,
        sample_count: count, expected_count: 3060, gap_ranges: [] } },
      collection: { server_now_ms: received, collection_expected: true,
        poll_interval_ms: 10_000, stale_after_ms: 30_000, targets: { KOSPI: {
          status: 'receiving', last_success_at_ms: received, last_written_at_ms: received,
          last_attempt_at_ms: received, consecutive_failures: 0, error_kind: null,
          failure_started_at_ms: null, gaps: [],
        } } },
    } });
  });
  await page.goto('/market');
  const card = page.locator('.market-switch-card').filter({ has: page.getByRole('heading', { name: /투자자 수급/ }) });
  await expect(card.getByRole('status')).toContainText('정상 수신');
  await expect(card.getByRole('heading')).toContainText('저장 표본 2개');
  count = 3;
  await page.clock.fastForward(10_000);
  await expect(card.getByRole('heading')).toContainText('저장 표본 3개');
  failing = true;
  const beforeFailure = requests;
  await page.clock.fastForward(10_000);
  await expect.poll(() => requests).toBeGreaterThan(beforeFailure);
  await page.clock.fastForward(2000); // query retry, not an arbitrary real-time sleep
  await expect(card.getByRole('status')).toContainText('서버 연결 확인 필요');
  await expect(card.getByRole('heading')).toContainText('저장 표본 3개');
  failing = false;
  count = 4;
  await page.clock.fastForward(10_000);
  await expect(card.getByRole('status')).toContainText('정상 수신');
  await expect(card.getByRole('heading')).toContainText('저장 표본 4개');
});
