import { test, expect, type Locator, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { API_URL } from './worktreeEnv';

test.use({ baseURL: API_URL, viewport: { width: 1600, height: 1000 } });

async function geometry(row: Locator) {
  return row.evaluate(element => {
    const origin = element.getBoundingClientRect();
    const read = (selector: string) => {
      const node = element.querySelector<HTMLElement>(selector)!;
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      const text = document.createRange(); text.selectNodeContents(node);
      return { left: box.left - origin.left, right: box.right - origin.left, width: box.width, top: box.top - origin.top, height: box.height,
        full: node.scrollWidth <= node.clientWidth + 1 && text.getBoundingClientRect().width <= box.width + 0.5,
        align: style.textAlign };
    };
    return { name: read('.quote-row-name'), rank: read('.ranking-rank'), price: read('.quote-row-price'), percent: read('.quote-row-percent'),
      metric: element.querySelector('.ranking-metric') ? read('.ranking-metric') : null,
      net: element.querySelector('.ranking-net-buy') ? read('.ranking-net-buy') : null,
      trade: element.querySelector('.ranking-trade-value') ? read('.ranking-trade-value') : null,
      detailWidth: parseFloat(getComputedStyle(element).getPropertyValue('--quote-detail-width')),
      gap: parseFloat(getComputedStyle(element).columnGap), padding: parseFloat(getComputedStyle(element).paddingRight) };
  });
}

async function cloneMatches(page: Page, row: Locator) {
  const before = await geometry(row), box = await row.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 8, box!.y + box!.height / 2, { steps: 3 });
  const ghost = page.getByTestId('ranking-drag-ghost');
  await expect(ghost).toBeVisible();
  const after = await geometry(ghost);
  for (const column of ['name', 'rank', 'price', 'percent'] as const) {
    expect(after[column].left).toBeCloseTo(before[column].left, 3);
    expect(after[column].width).toBeCloseTo(before[column].width, 3);
  }
  if (before.trade) {
    expect(after.trade!.full).toBe(true);
    expect(after.trade!.right).toBeCloseTo(before.trade.right, 3);
    expect(after.trade!.width).toBeCloseTo(before.trade.width, 3);
    await expect(ghost.locator('.ranking-trade-value')).toHaveText((await row.locator('.ranking-trade-value').textContent())!);
  }
  if (before.net) {
    expect(after.net!.full).toBe(true);
    expect(after.net!.right).toBeCloseTo(before.net.right, 3);
    await expect(ghost.locator('.ranking-net-buy')).toHaveText((await row.locator('.ranking-net-buy').textContent())!);
  }
  if (before.metric) {
    expect(after.metric!.full).toBe(true);
    expect(after.metric!.right).toBeCloseTo(before.metric.right, 3);
    expect(after.metric!.width).toBeCloseTo(before.metric.width, 3);
    await expect(ghost.locator('.ranking-metric')).toHaveText((await row.locator('.ranking-metric').textContent())!);
    await expect(ghost.locator('.ranking-metric')).toHaveAttribute('title', (await row.locator('.ranking-metric').getAttribute('title'))!);
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
  await page.waitForTimeout(60); // dnd-kit clears document click suppression after 50ms.
}

for (const fontSize of [16, 20]) {
  test(`등락금액·급증률·거래량 열의 한 줄 정렬과 드래그 (${fontSize}px)`, async ({ page }, info) => {
    await page.clock.install({ time: new Date('2026-10-19T01:00:00Z') });
    await installLiveMocks(page);
    let large = false;
    await page.route(apiExact('live/rankings'), route => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: {
        kind: params.get('kind'), market: params.get('market'), direction: params.get('direction'), venue: params.get('venue'),
        market_open: true, fetched_at_ms: Date.now(), queried_count: 4, has_more: false,
        rows: [0, 1, 2, 3].map(i => ({ rank: i + 1, code: String(100000 + i), name: `종목${i + 1}`,
          price: 71200, change_pct: 5.79,
          change_won: i === 3 ? null : i === 2 ? 0 : i === 0 ? 1200 : large ? -123456789 : -1200,
          volume_surge_pct: i === 3 ? null : i === 2 ? 0 : i === 0 ? 18.42 : large ? 1234567.89 : 1842.37,
          volume: i === 3 ? null : i === 2 ? 0 : i === 0 ? 9999 : large ? 123456789012 : 12345678,
        })),
      } });
    });
    await page.goto('/live?code=098460');
    await page.addStyleTag({ content: `:root { font-size: ${fontSize}px !important; }` });
    await page.getByRole('button', { name: '순위 패널 토글', exact: true }).click();
    const panel = page.getByTestId('ranking-panel');
    const first = panel.getByTestId('ranking-row-100000'), second = panel.getByTestId('ranking-row-100001');
    for (const [kind, label, text, title, zero, wideText] of [
      ['change', '등락률', '-1,200원', '전일대비 -1,200원', '0원', '-123,456,789원'],
      ['surge', '거래량 급증', '1,842.37%', '1분 기준 급증률 1,842.37%', '0%', '1,234,567.89%'],
      ['volume', '거래량', '1,235만주', '당일 거래량 12,345,678주', '0주', '12,345,679만주'],
    ]) {
      large = false;
      await panel.getByRole('button', { name: label, exact: true }).click();
      await expect(second.locator('.ranking-metric')).toHaveText(text);
      await expect(second.locator('.ranking-metric')).toHaveAttribute('title', title);
      await expect(panel.getByTestId('ranking-row-100002').locator('.ranking-metric')).toHaveText(zero);
      await expect(panel.getByTestId('ranking-row-100003').locator('.ranking-metric')).toHaveText('—');
      await expect(panel.locator('.quote-columns-header')).toHaveCount(0);
      const [a, b] = await Promise.all([geometry(first), geometry(second)]);
      expect(a.metric!.right).toBeCloseTo(b.metric!.right, 3);
      expect(b.metric!.left).toBeGreaterThanOrEqual(b.name.right);
      expect(b.price.left).toBeGreaterThanOrEqual(b.metric!.right);
      expect(b.metric!.top + b.metric!.height / 2).toBeCloseTo(b.name.top + b.name.height / 2, 3);
      expect(b.metric!.full && b.price.full && b.percent.full).toBe(true);
      await cloneMatches(page, second);
      await panel.screenshot({ path: info.outputPath(`${kind}.png`) });
      large = true;
      await page.clock.fastForward(11_000);
      await expect(second.locator('.ranking-metric')).toHaveText(wideText);
      const wide = await geometry(second);
      expect(wide.metric!.full && wide.price.full && wide.percent.full).toBe(true);
      large = false;
      await page.clock.fastForward(11_000);
      await expect(second.locator('.ranking-metric')).toHaveText(text);
      expect((await geometry(second)).metric!.width).toBe(wide.metric!.width);
    }
  });

  test(`거래대금 4열·320px·열 제목 없음·금액 갱신·드래그 (${fontSize}px)`, async ({ page }, info) => {
    await page.clock.install({ time: new Date('2026-10-19T01:00:00Z') });
    await installLiveMocks(page);
    let amount = 3_119_200_000_000, price = 123456, percent = -1.23;
    await page.route(apiExact('live/rankings'), route => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: {
        kind: params.get('kind'), market: params.get('market'), direction: params.get('direction'), venue: params.get('venue'),
        market_open: true, fetched_at_ms: Date.now(), queried_count: 40, has_more: false,
        rows: Array.from({ length: 40 }, (_, i) => ({
          rank: i + 1, code: String(100000 + i), name: i === 0 ? '이름이아주긴테스트종목' : `종목${i + 1}`,
          price: i === 2 ? null : price, change_pct: i === 2 ? null : percent,
          trade_value_won: i === 2 ? null : i === 3 ? 0 : i === 0 ? 123_456_000_000 : amount,
        })),
      } });
    });
    await page.goto('/live?code=098460');
    await page.addStyleTag({ content: `:root { font-size: ${fontSize}px !important; }` });
    await page.getByRole('button', { name: '순위 패널 토글', exact: true }).click();
    const panel = page.getByTestId('ranking-panel'), header = panel.getByTestId('ranking-value-columns-header');
    await expect(header).toHaveCount(0);
    await expect(panel.locator('.ranking-trade-value')).toHaveCount(0);
    await panel.getByRole('button', { name: '거래대금', exact: true }).click();
    await expect(panel).toHaveCSS('width', `${320 * fontSize / 16}px`);
    await expect(header).toHaveCount(0);
    const first = panel.getByTestId('ranking-row-100000'), second = panel.getByTestId('ranking-row-100001');
    await expect(first.locator('.ranking-trade-value')).toHaveText('1,235억');
    await expect(second.locator('.ranking-trade-value')).toHaveText('31,192억');
    await expect(second.locator('.ranking-trade-value')).toHaveAttribute('title', '3,119,200,000,000원');
    const missing = panel.getByTestId('ranking-row-100002');
    for (const selector of ['.ranking-trade-value', '.quote-row-price', '.quote-row-percent']) await expect(missing.locator(selector)).toHaveText('—');
    await expect(panel.getByTestId('ranking-row-100003').locator('.ranking-trade-value')).toHaveText('0억');
    const [a, b] = await Promise.all([geometry(first), geometry(second)]);
    for (const value of [a, b]) {
      expect(value.name.left).toBe(40 * fontSize / 16);
      for (const column of ['price', 'percent', 'trade'] as const) {
        expect(value[column]!.full).toBe(true);
        expect(value[column]!.align).toBe('right');
        expect(value[column]!.right).toBeCloseTo(a[column]!.right, 3);
      }
    }
    const scroll = panel.getByTestId('ranking-scroll');
    expect(await scroll.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await panel.screenshot({ path: info.outputPath('ranking-value.png') });
    await cloneMatches(page, second);
    amount = 123_456_789_012_345; price = 123456789012; percent = -1234.56;
    await page.clock.fastForward(11_000);
    await expect(second.locator('.ranking-trade-value')).toHaveText('1,234,568억');
    const wide = await geometry(second);
    expect(wide.trade!.full && wide.price.full && wide.percent.full).toBe(true);
    await expect.poll(() => scroll.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    amount = 100_000_000; price = 12; percent = 1;
    await page.clock.fastForward(11_000);
    await expect(second.locator('.ranking-trade-value')).toHaveText('1억');
    expect((await geometry(second)).trade!.width).toBe(wide.trade!.width);
    await panel.getByRole('button', { name: '등락률 정렬', exact: true }).click();
    await expect(second.getByTestId('ranking-rank')).toHaveText('2');
    await panel.getByRole('button', { name: 'ETF 제외', exact: true }).click();
    await expect(second.locator('.ranking-trade-value')).toHaveText('1억');
    expect((await geometry(second)).trade!.width).toBe(wide.trade!.width);
    await panel.getByRole('button', { name: '거래량', exact: true }).click();
    await expect(header).toHaveCount(0);
    await expect(panel.locator('.ranking-trade-value')).toHaveCount(0);
  });

  test(`순위 반응형 열·네 자리 번호·순매수 전체 금액·관측 폭 (${fontSize}px)`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-19T01:00:00Z') });
    await installLiveMocks(page);
    let price = 123456, percent = -1.23, amount = 12345678901234, empty = false;
    await page.route(apiExact('live/rankings'), route => {
      const params = new URL(route.request().url()).searchParams, kind = params.get('kind');
      return route.fulfill({ json: {
        kind, market: params.get('market'), direction: params.get('direction'), venue: params.get('venue'),
        quote_venue: params.get('venue'), market_open: true, fetched_at_ms: Date.now(), queried_count: empty ? 0 : 2, has_more: false,
        rows: empty ? [] : [
          { rank: 1, code: '005930', name: '삼성전자', price: 1234, change_pct: 2.34, trade_value_won: 1e10,
            program_net_buy_won: 1e8, investor_net_buy_won: 1e8 },
          { rank: kind === 'program' ? 50 : kind === 'institution' || kind === 'foreign' ? 100 : 5000,
            code: '000660', name: 'SK하이닉스', price, change_pct: percent, trade_value_won: 1e10,
            program_net_buy_won: -amount, investor_net_buy_won: -amount },
        ],
      } });
    });
    await page.goto('/live?code=098460');
    await page.addStyleTag({ content: `:root { font-size: ${fontSize}px !important; }` });
    await page.getByRole('button', { name: '순위 패널 토글', exact: true }).click();
    const panel = page.getByTestId('ranking-panel'), first = panel.getByTestId('ranking-row-005930'), second = panel.getByTestId('ranking-row-000660');
    await expect(second.locator('.quote-row-price')).toHaveText('123,456');
    await expect(second.getByTestId('ranking-rank')).toHaveText('5000');
    await first.click();
    await expect(first).toHaveAttribute('aria-current', 'true');
    const scale = fontSize / 16;
    for (const [width, gap, padding] of [[360, 8, 12], [320, 4, 8], [280, 4, 8], [240, 2, 4]]) {
      await page.addStyleTag({ content: `:root { --watchlist-panel-w: ${width / 16}rem !important; }` });
      await expect.poll(() => geometry(first).then(value => value.gap)).toBe(gap * scale);
      const [a, b] = await Promise.all([geometry(first), geometry(second)]);
      expect(a.name.left).toBe(40 * scale);
      expect(b.name.left).toBe(a.name.left);
      expect(b.name.left - b.rank.right).toBeCloseTo(2 * scale, 3);
      expect(a.padding).toBe(padding * scale);
      expect(a.price.right).toBeCloseTo(b.price.right, 3);
      expect(a.percent.right).toBeCloseTo(b.percent.right, 3);
      for (const value of [a.rank, b.rank, a.price, b.price, a.percent, b.percent]) {
        expect(value.full).toBe(true);
        expect(value.align).toBe('right');
      }
      expect(await panel.getByTestId('ranking-scroll').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      if (width === 320) await panel.screenshot({ path: `/tmp/hoga-ranking-default-${fontSize}.png` });
    }
    await cloneMatches(page, second);
    await panel.getByRole('button', { name: '등락률 정렬', exact: true }).click();
    price = 123456789; percent = -1234.56;
    await page.clock.fastForward(11_000);
    await expect(second.locator('.quote-row-price')).toHaveText('123,456,789');
    const wide = await geometry(second);
    expect(wide.price.full && wide.percent.full).toBe(true);
    price = 12; percent = 1;
    await page.clock.fastForward(11_000);
    await expect(second.locator('.quote-row-price')).toHaveText('12');
    expect((await geometry(second)).price.width).toBe(wide.price.width);
    empty = true;
    await page.clock.fastForward(11_000);
    await expect(first).toHaveCount(0);
    empty = false;
    await page.clock.fastForward(11_000);
    await expect(first).toBeVisible();
    expect((await geometry(first)).price.width).toBe(wide.price.width);
    await panel.getByRole('combobox', { name: '시장' }).selectOption('kosdaq');
    await expect(first).toBeVisible();
    await expect.poll(() => geometry(first).then(value => value.price.width)).toBeLessThan(wide.price.width);

    for (const label of ['프로그램', '기관', '외국인']) {
      amount = 12345678901234;
      await panel.getByRole('button', { name: label, exact: true }).click();
      await expect(second.locator('.ranking-net-buy')).toHaveText('-123,457억');
      const [a, b] = await Promise.all([geometry(first), geometry(second)]);
      expect(a.net!.full && b.net!.full).toBe(true);
      expect(a.net!.align).toBe('right');
      expect(a.net!.right).toBeCloseTo(b.net!.right, 3);
      expect(b.net!.left).toBeGreaterThanOrEqual(b.name.right);
      expect(b.price.left).toBeGreaterThanOrEqual(b.net!.right);
      expect(b.net!.top + b.net!.height / 2).toBeCloseTo(b.name.top + b.name.height / 2, 3);
      await panel.screenshot({ path: `/tmp/hoga-ranking-${label}-${fontSize}.png` });
      if (label === '프로그램') await cloneMatches(page, second);
      amount = 1e8;
      await page.clock.fastForward(31_000);
      await expect(second.locator('.ranking-net-buy')).toHaveText('-1억');
      expect((await geometry(second)).detailWidth).toBe(b.detailWidth);
    }
    const detailWidth = (await geometry(second)).detailWidth;
    await panel.getByRole('combobox', { name: '시장' }).selectOption('kospi');
    await expect(second.locator('.ranking-net-buy')).toHaveText('-1억');
    await expect.poll(() => geometry(second).then(value => value.detailWidth)).toBeLessThan(detailWidth);
    expect(errors).toEqual([]);
  });
}
