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
      return { left: box.left - origin.left, right: box.right - origin.left, width: box.width,
        full: node.scrollWidth <= node.clientWidth + 1 && text.getBoundingClientRect().width <= box.width + 0.5,
        align: style.textAlign };
    };
    return { name: read('.quote-row-name'), rank: read('.ranking-rank'), price: read('.quote-row-price'), percent: read('.quote-row-percent'),
      net: element.querySelector('.ranking-net-buy') ? read('.ranking-net-buy') : null,
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
  if (before.net) {
    expect(after.net!.full).toBe(true);
    expect(after.net!.right).toBeCloseTo(before.net.right, 3);
    await expect(ghost.locator('.ranking-net-buy')).toHaveText((await row.locator('.ranking-net-buy').textContent())!);
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
  await page.waitForTimeout(60); // dnd-kit clears document click suppression after 50ms.
}

for (const fontSize of [16, 20]) {
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
    for (const [width, gap, padding] of [[360, 8, 12], [280, 4, 8], [240, 2, 4]]) {
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
      if (width === 280) await panel.screenshot({ path: `/tmp/hoga-ranking-default-${fontSize}.png` });
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
      await expect(second.locator('.ranking-net-buy')).toHaveText('-123,456.79억');
      const [a, b] = await Promise.all([geometry(first), geometry(second)]);
      expect(a.net!.full && b.net!.full).toBe(true);
      expect(a.net!.align).toBe('right');
      expect(a.net!.right).toBeCloseTo(b.net!.right, 3);
      expect(b.net!.right).toBeCloseTo(b.name.right, 3);
      await panel.screenshot({ path: `/tmp/hoga-ranking-${label}-${fontSize}.png` });
      if (label === '프로그램') await cloneMatches(page, second);
      amount = 1e8;
      await page.clock.fastForward(31_000);
      await expect(second.locator('.ranking-net-buy')).toHaveText('-1.00억');
      expect((await geometry(second)).detailWidth).toBe(b.detailWidth);
    }
    const detailWidth = (await geometry(second)).detailWidth;
    await panel.getByRole('combobox', { name: '시장' }).selectOption('kospi');
    await expect(second.locator('.ranking-net-buy')).toHaveText('-1.00억');
    await expect.poll(() => geometry(second).then(value => value.detailWidth)).toBeLessThan(detailWidth);
    expect(errors).toEqual([]);
  });
}
