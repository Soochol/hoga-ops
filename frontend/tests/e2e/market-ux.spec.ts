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
    if (populated) {
      const sectors = Array.from({ length: 16 }, (_, i) => ({ code: String(i + 5).padStart(3, '0'), name: `업종 ${i + 1}`, change_pct: (i - 8) / 2 }));
      responses.sectors = { markets: { '0': { sectors }, '1': { sectors: [] } }, volatility: { value: 20, change_pct: 1 } };
      responses['sector-flow'] = { date: '20260909', markets: { KOSPI: sectors.map((s, i) => ({ ...s, foreign: i * 100 - 500, institution: 500 - i * 80, individual: -i * 20 })) } };
      const values = Array.from({ length: 8 }, (_, i) => ({ date: `2026090${i + 1}`, value_eok: (i + 1) * 10000 }));
      responses['trade-value'] = { markets: { KOSPI: values, KOSDAQ: values.map(p => ({ ...p, value_eok: p.value_eok / 2 })) } };
      responses.streaks = { 외국인: [{ code: '005930', name: '삼성전자', streak_days: 3, streak_net_eok: 200 }], 기관: [{ code: '000660', name: 'SK하이닉스', streak_days: 2, streak_net_eok: -100 }] };
    }
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

async function expectProgramHeaderSingleLine(page: Page) {
  const bounds = await page.locator('.market-program-card .market-card-header h2').evaluate(el => {
    const title = document.createRange();
    title.selectNodeContents(el.firstChild!);
    const titleRect = title.getBoundingClientRect();
    const hint = el.querySelector('span')!.getBoundingClientRect();
    return {
      overlap: Math.min(titleRect.bottom, hint.bottom) - Math.max(titleRect.top, hint.top),
      hintRight: hint.right, right: el.getBoundingClientRect().right,
    };
  });
  expect(bounds.overlap).toBeGreaterThan(0);
  expect(bounds.hintRight).toBeLessThanOrEqual(bounds.right + 1);
}

async function expectContextChartHeights(page: Page) {
  await expectProgramHeaderSingleLine(page);
  const charts = page.locator('.market-context-chart').filter({ visible: true });
  await expect(charts).toHaveCount(3);
  const heights = await charts.evaluateAll(elements => elements.map(el => ({
    top: el.getBoundingClientRect().top,
    bottom: el.getBoundingClientRect().bottom,
    cardTop: el.closest('.market-card')!.getBoundingClientRect().top,
    plot: el.getBoundingClientRect().height,
    svg: el.querySelector('svg')!.getBoundingClientRect().height,
    probe: el.querySelector('[role="group"]')!.getBoundingClientRect().height,
    expected: parseFloat(getComputedStyle(document.documentElement).fontSize) * 9,
  })));
  for (const height of heights) {
    expect(height.plot).toBeCloseTo(height.expected, 1);
    expect(height.svg).toBeCloseTo(height.plot, 1);
    expect(height.probe).toBeCloseTo(height.plot, 1);
  }
  for (const a of heights) for (const b of heights) {
    if (Math.abs(a.cardTop - b.cardTop) < 1) {
      expect(a.top).toBeCloseTo(b.top, 1);
      expect(a.bottom).toBeCloseTo(b.bottom, 1);
    }
  }
}

test('flow layout groups market context and preserves explorer preferences across views', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1400 });
  await marketMocks(page, true);
  await page.goto('/market');
  await expect(page.getByLabel('투자자별 순매수 · 억원')).toContainText('-10');
  const flow = page.getByRole('region', { name: '시장 흐름', exact: true });
  await expect(flow.getByRole('heading', { name: /업종 등락 · 수급/ })).toBeVisible();
  const context = page.getByRole('region', { name: '거래와 자금', exact: true });
  const positions = await context.locator(':scope > .market-card').evaluateAll(cards => cards.map(card => {
    const { top, bottom } = card.getBoundingClientRect();
    return { top, bottom };
  }));
  expect(new Set(positions.map(position => position.top)).size).toBe(1);
  expect(new Set(positions.map(position => position.bottom)).size).toBe(1);
  await expectContextChartHeights(page);
  const mainBounds = await flow.locator(':scope > .market-card').evaluateAll(cards => cards.map(el => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top, bottom };
  }));
  expect(mainBounds[0].top).toBeCloseTo(mainBounds[1].top, 1);
  expect(mainBounds[0].bottom).toBeCloseTo(mainBounds[1].bottom, 1);
  const mainBottom = mainBounds[0].bottom;
  await flow.getByRole('button', { name: '전체 보기', exact: true }).click();
  expect(await flow.locator('.market-sector-card').evaluate(el => el.getBoundingClientRect().bottom)).toBeCloseTo(mainBottom, 1);
  const sectorTable = flow.getByRole('region', { name: '업종 등락과 수급 목록' });
  expect(await sectorTable.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1);
  await sectorTable.focus();
  await sectorTable.press('End');
  await expect(sectorTable.getByRole('row').last()).toBeInViewport();
  await context.getByRole('group', { name: '거래대금 시장', exact: true }).getByRole('button', { name: '코스닥' }).click();
  await expect(context.getByRole('region', { name: '코스닥 거래대금', exact: true })).toContainText('4.00조');
  const ranks = page.getByRole('group', { name: '종목 순위 기준', exact: true });
  await ranks.getByRole('button', { name: '상승률' }).click();
  await expect(ranks.getByRole('button', { name: '상승률' })).toBeFocused();
  await expect(page.getByRole('heading', { name: /상승률 상위/ })).toBeVisible();
  await expect(page.getByText('현재가(원)', { exact: true }).filter({ visible: true })).toHaveCount(1);
  const foreignMarket = page.getByRole('group', { name: '외국인 연속 매매 시장', exact: true });
  await foreignMarket.getByRole('button', { name: '코스닥' }).click();
  await page.getByRole('group', { name: '외국인 연속 매매 방향', exact: true }).getByRole('button', { name: '순매도' }).click();
  await page.getByRole('group', { name: '연속 매매 주체', exact: true }).getByRole('button', { name: '기관', exact: true }).click();
  await expect(page.getByRole('group', { name: '연속 매매 주체', exact: true }).getByRole('button', { name: '기관', exact: true })).toBeFocused();
  await expect(page.getByRole('group', { name: '기관 연속 매매 시장', exact: true }).getByRole('button', { name: '코스피' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: '연속 매매 주체', exact: true }).getByRole('button', { name: '외국인', exact: true }).click();
  await expect(foreignMarket.getByRole('button', { name: '코스닥' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: '외국인 연속 매매 방향', exact: true }).getByRole('button', { name: '순매도' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.market-desk').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('market-flow-desktop.png') });
  for (const width of [1000, 800]) {
    await page.setViewportSize({ width, height: 1100 });
    await expectContextChartHeights(page);
  }
  for (const theme of ['trading-desk', 'ledger-studio']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = '20px'; }, theme);
    await page.setViewportSize({ width: 600, height: 1100 });
    const overflow = await page.locator('.market-page').evaluate(root => [...root.querySelectorAll<HTMLElement>('.market-main,.market-context,.market-ranks,.market-card')].map(el => el.scrollWidth - el.clientWidth));
    expect(overflow.every(px => px <= 1)).toBe(true);
    await expectContextChartHeights(page);
    await page.screenshot({ path: testInfo.outputPath(`market-flow-compact-${theme}.png`) });
  }
  await page.reload();
  await page.getByRole('group', { name: '연속 매매 주체', exact: true }).scrollIntoViewIfNeeded();
  await expect(foreignMarket.getByRole('button', { name: '코스닥' })).toHaveAttribute('aria-pressed', 'true');
});

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
  await expect(market.getByRole('table', { name: '투자자 일별 수급 · 단위 억원' }).getByRole('row').nth(1)).toContainText('09/08');
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
          if (mode === '일별') await expect(page.getByText(/^표본 \d+거래일$/)).toHaveCount(0);
          else {
            await expect(page.getByText(/^표본 2개 ·/)).toHaveCount(0);
            await expect(page.getByRole('note', { includeHidden: true }).filter({ hasText: '2개 표본' })).toHaveCount(2);
          }
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

for (const [width, fontSize] of [[1440, 16], [800, 16], [600, 20], [1440, 24]]) test(`daily lists fill their card without covering rows at ${width}px / ${fontSize}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  await marketMocks(page);
  await page.route(apiPrefix('market/investor-flow'), route => route.fulfill({ json: {
    date: '20260909', markets: {}, daily: Array.from({ length: 20 }, (_, i) => ({
      date: `202608${String(i + 1).padStart(2, '0')}`,
      markets: { KOSPI: { foreign: i * 100, institution: -i * 10 } },
    })),
  } }));
  await page.route(apiPrefix('market/program'), route => route.fulfill({ json: {
    markets: { KOSPI: Array.from({ length: 20 }, (_, i) => ({
      t: `202608${String(i + 1).padStart(2, '0')}000000`,
      arb_net_eok: i * 100, non_arb_net_eok: -i * 10, total_net_eok: i * 90,
    })) },
  } }));
  await page.goto('/market');
  await page.evaluate(fontSize => { document.documentElement.style.fontSize = `${fontSize}px`; }, fontSize);
  for (const [modeLabel, label, bodyClass] of [
    ['수급 표시 구간', '투자자 일별 수급', '.market-investor-body'],
    ['프로그램 표시 구간', '코스피 프로그램 일별 수급', '.market-program-body'],
  ]) {
    const body = page.locator(bodyClass);
    const cardHeight = await body.evaluate(el => el.closest('.market-card')!.getBoundingClientRect().height);
    await page.getByRole('group', { name: modeLabel, exact: true }).getByRole('button', { name: '일별', exact: true }).click();
    const table = page.getByRole('table', { name: `${label} · 단위 억원` });
    const viewport = page.getByRole('region', { name: `${label} 목록 스크롤` });
    await expect(viewport.getByRole('row').first()).toContainText('08/20');
    if (modeLabel === '프로그램 표시 구간') await expectProgramHeaderSingleLine(page);
    expect(await viewport.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1);
    expect(await body.evaluate(el => el.closest('.market-card')!.getBoundingClientRect().height)).toBeCloseTo(cardHeight, 1);
    await viewport.scrollIntoViewIfNeeded();
    const metrics = () => table.evaluate(el => ({
      header: el.querySelector('.daily-net-heading')!.getBoundingClientRect().top,
      footer: el.querySelector('.daily-net-total')!.getBoundingClientRect().bottom,
      headerBottom: el.querySelector('.daily-net-heading')!.getBoundingClientRect().bottom,
      footerTop: el.querySelector('.daily-net-total')!.getBoundingClientRect().top,
      scrollTop: el.querySelector('[role="region"]')!.getBoundingClientRect().top,
      scrollBottom: el.querySelector('[role="region"]')!.getBoundingClientRect().bottom,
      lastRowBottom: el.querySelector('.daily-net-rows')!.lastElementChild!.getBoundingClientRect().bottom,
      lastRowTop: el.querySelector('.daily-net-rows')!.lastElementChild!.getBoundingClientRect().top,
      overflow: el.scrollWidth - el.clientWidth,
    }));
    const before = await metrics();
    expect(before.headerBottom).toBeLessThanOrEqual(before.scrollTop);
    expect(before.footerTop).toBeGreaterThanOrEqual(before.scrollBottom);
    await viewport.focus();
    await viewport.press('End');
    // Scrolling rounds to CSS pixels, while row heights can be fractional.
    await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    await expect(viewport.getByRole('row').last()).toBeInViewport();
    const after = await metrics();
    expect(after.lastRowBottom).toBeLessThanOrEqual(after.scrollBottom + 1);
    expect(after.lastRowTop).toBeGreaterThanOrEqual(after.scrollTop - 1);
    expect(Math.abs(after.header - before.header)).toBeLessThan(1);
    expect(Math.abs(after.footer - before.footer)).toBeLessThan(1);
    expect(after.overflow).toBeLessThanOrEqual(1);
    expect(await body.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    const bounds = await body.boundingBox();
    expect(Math.abs(after.footer - (bounds!.y + bounds!.height))).toBeLessThan(1);
    const cardBottomGap = await body.evaluate(el => {
      const card = el.closest('.market-card')!;
      const style = getComputedStyle(card);
      return card.getBoundingClientRect().bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth)
        - el.getBoundingClientRect().bottom;
    });
    expect(Math.abs(cardBottomGap)).toBeLessThan(1);
    await viewport.press('Home');
    await expect(viewport.getByRole('row').first()).toBeInViewport({ ratio: 0.99 });
    await body.screenshot({ path: testInfo.outputPath(`${modeLabel}-daily.png`) });
  }
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
        { t_ms: received, individual: count * 20, foreign: -count * 10, institution: -count * 10 },
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
  const summary = card.getByLabel('투자자별 순매수 · 억원');
  await expect(summary).toContainText('-20');
  await expect(card.getByRole('heading')).toHaveText('투자자 수급');
  count = 3;
  await page.clock.fastForward(10_000);
  await expect(summary).toContainText('-30');
  failing = true;
  const beforeFailure = requests;
  await page.clock.fastForward(10_000);
  await expect.poll(() => requests).toBeGreaterThan(beforeFailure);
  await page.clock.fastForward(2000); // query retry, not an arbitrary real-time sleep
  await expect(card.getByRole('status')).toContainText('서버 연결 확인 필요');
  await expect(summary).toContainText('-30');
  failing = false;
  count = 4;
  await page.clock.fastForward(10_000);
  await expect(summary).toContainText('-40');
  await expect(card.getByRole('status')).toHaveCount(0);
});

for (const width of [1440, 600]) test(`flow freshness and inspection fit without clipping at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await marketMocks(page, true);
  await page.route(apiPrefix('market/investor-flow'), async route => {
    const t = Date.UTC(2026, 8, 9, 4);
    await route.fulfill({ json: {
      date: '20260909', unit: 'amt_eok', confirmed: false,
      markets: { KOSPI: [
        { t_ms: t, individual: 10, foreign: -20, institution: 10 },
        { t_ms: t + 10000, individual: 30, foreign: -40, institution: 10 },
      ] }, daily: [], coverage: { KOSPI: { sample_count: 2, first_sample_ms: t, last_sample_ms: t + 10000, gap_ranges: [] } },
      collection: { server_now_ms: t + 10000, poll_interval_ms: 10000, stale_after_ms: 30000,
        collection_expected: false, targets: { KOSPI: { status: 'closed', last_success_at_ms: t + 10000, gaps: [] } } },
    } });
  });
  await page.goto('/market');
  const body = page.locator('.market-investor-body');
  const lastReceipt = body.getByTitle('마지막 정상 수신 시각');
  await expect(body.getByLabel('투자자별 순매수 · 억원')).toContainText('-40');
  await expect(lastReceipt).toHaveCount(0);
  await expect(body.getByText('수집 종료', { exact: true })).toHaveCount(0);
  const probe = body.getByRole('group', { name: /차트 상세/ });
  await probe.focus();
  await probe.press('Home');
  await expect(probe.getByRole('status')).toContainText('개인 +10억원');
  expect(await body.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await probe.press('End');
  await expect(probe.getByRole('status')).toContainText('외국인 -40억원');
  const details = await probe.getByRole('status').boundingBox();
  const axis = await body.getByText('15:30', { exact: true }).boundingBox();
  expect(details!.y + details!.height).toBeLessThanOrEqual(axis!.y);
  await body.screenshot({ path: testInfo.outputPath('investor-flow.png') });
});

test('주말 market에서 공통 상태 패널로 점검과 연결 상태를 확인한다', async ({ page }) => {
  await marketMocks(page);
  await page.route(apiPrefix('live/status'), (route) => route.fulfill({ json: {
    running: false, started_at_ms: null, last_tick_ms: null, cycle_lag_ms: 0,
    watchlist_count: 0, live_set: [], capture_healthy: false, capture_reason: 'closed',
    rest_bypass_enabled: false,
    provider_status: {
      observed_at_ms: 1789180000000, connection: 'unavailable', connected_accounts: 0,
      configured_accounts: 5, last_received_at_ms: null, notice_config_error: false,
      notice_phase: 'active', notice: {
        id: 'kiwoom-20260912', starts_at_ms: 1789169400000, ends_at_ms: 1789210800000,
        reason: 'KRX 애프터마켓 이행 관련 시스템 작업', source: '사용자 제공 키움 공지',
      },
    },
  } }));
  await page.goto('/market');
  await page.getByRole('button', { name: /서비스 상태/ }).click();
  const banner = page.getByRole('dialog', { name: '서비스 상태' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('연결 0/5계정');
  await expect(banner).toContainText('20:00');
  const bannerBounds = await banner.boundingBox();
  const mainBounds = await page.locator('main').boundingBox();
  expect(bannerBounds).not.toBeNull();
  expect(mainBounds).not.toBeNull();
  expect(bannerBounds!.x).toBeGreaterThanOrEqual(0);
  expect(bannerBounds!.x + bannerBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const mainY = mainBounds!.y;
  await banner.getByRole('button', { name: '서비스 상태 닫기' }).click();
  expect((await page.locator('main').boundingBox())!.y).toBe(mainY);
  await page.screenshot({ path: '/tmp/hoga-kiwoom-maintenance.png' });
  await page.goto('/live');
  await page.getByRole('button', { name: /서비스 상태/ }).click();
  await expect(banner).toBeVisible();
});

test('실시간 연결이 정상이어도 REST 서버 오류를 표시한다', async ({ page }) => {
  await marketMocks(page);
  await page.route(apiPrefix('live/status'), (route) => route.fulfill({ json: {
    running: true, started_at_ms: null, last_tick_ms: null, cycle_lag_ms: 0,
    watchlist_count: 0, live_set: [], capture_healthy: true, capture_reason: 'healthy',
    rest_bypass_enabled: false,
    provider_status: {
      observed_at_ms: 1789180000000, connection: 'connected', connected_accounts: 5,
      configured_accounts: 5, last_received_at_ms: 1789180000000, notice_config_error: false,
      notice_phase: null, notice: null,
      failures: [{ channel: 'rest', kind: 'server', operation: 'ka10001',
        observed_at_ms: 1789180000000, code: '503' }],
    },
  } }));
  await page.goto('/market');
  await page.getByRole('button', { name: /서비스 상태/ }).click();
  const banner = page.getByRole('dialog', { name: '서비스 상태' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('종목정보 조회 실패');
  await expect(banner).toContainText('실시간 연결 정상');
  await expect(banner).toContainText('서버 오류');
  await banner.locator('summary').click();
  await expect(banner.getByText('API · ka10001')).toBeVisible();
  await expect(banner.getByText('오류 코드 · 503')).toBeVisible();
  await expect(banner).not.toContainText('점검');
  await page.screenshot({ path: '/tmp/hoga-service-status.png' });
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const trigger = page.getByRole('button', { name: /서비스 상태 · 문제/ });
    await expect(trigger).toBeInViewport();
    const bounds = await banner.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
  await page.keyboard.press('Escape');
  await expect(banner).not.toBeVisible();
  await expect(page.getByRole('button', { name: /서비스 상태 · 문제/ })).toBeFocused();
});

test('연결 5계정 중 구독 미완료 계정의 실패 단계와 자동 복구를 표시한다', async ({ page }) => {
  await marketMocks(page);
  let recovered = false;
  let phase: 'REG' | 'dispatch' = 'REG';
  await page.route(apiPrefix('live/status'), (route) => route.fulfill({ json: {
    running: true, started_at_ms: null, last_tick_ms: null, cycle_lag_ms: 0,
    watchlist_count: 0, live_set: [], capture_healthy: recovered,
    capture_reason: recovered ? 'healthy' : 'registration_incomplete', rest_bypass_enabled: false,
    provider_status: {
      observed_at_ms: 1790821510000, connection: recovered ? 'connected' : 'partial',
      connected_accounts: 5, configured_accounts: 5, ready_accounts: recovered ? 5 : 4,
      last_received_at_ms: 1790821510000, notice_config_error: false, notice_phase: null, notice: null,
      failures: recovered ? [] : [{ channel: 'ws', kind: phase === 'REG' ? 'timeout' : 'transport', operation: 'session',
        observed_at_ms: 1790821510000, code: null, account_id: 0, connection_generation: 7,
        phase, elapsed_ms: 10_000 }],
    },
  } }));
  await page.goto('/market');
  await page.getByRole('button', { name: /서비스 상태/ }).click();
  const panel = page.getByRole('dialog', { name: '서비스 상태' });
  await expect(panel).toContainText('연결 5/5계정 · 구독 준비 4/5계정');
  await expect(panel).not.toContainText('실시간 연결 정상');
  await panel.getByText('상세 보기').click();
  await expect(panel.getByText('계정 · 1', { exact: true })).toBeVisible();
  await expect(panel.getByText('실패 단계 · 구독 등록', { exact: true })).toBeVisible();
  await expect(panel.getByText('단계 소요 · 10.00초', { exact: true })).toBeVisible();
  await expect(panel).toContainText('자동 재연결 후 로그인과 구독 준비가 확인되면 관측이 해제됩니다');
  phase = 'dispatch';
  await expect(panel).toContainText('서버 내부 실시간 데이터 처리 지연 또는 실패', { timeout: 10_000 });
  recovered = true;
  await expect(panel).toContainText('구독 준비 5/5계정', { timeout: 10_000 });
  await expect(panel).toContainText('실시간 연결 정상');
  await expect(panel.getByRole('button', { name: '현재 문제 0' })).toBeVisible();
  await panel.getByRole('button', { name: '최근 해제 2' }).click();
  await expect(panel).toContainText('관측 해제');
  await page.screenshot({ path: '/tmp/hoga-kiwoom-recovery-20261001.png' });
});
