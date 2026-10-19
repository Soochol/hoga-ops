import { test, expect, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test.use({ viewport: { width: 1600, height: 1000 } });
const entries = [
  { code: '005930', name: '삼성전자', market: 'KOSPI', price: 1234, change_pct: 2.34, trade_value_won: 1e10 },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 123456, change_pct: -1.23, trade_value_won: 1e10 },
];
const saves = ['조건 A', '조건 B'].map((name, index) => ({
  id: `s_${index}`, name, conditions: [{ id: 'c', type: 'trade_value', params: { min_eok: index ? 500 : 100 } }],
  universe: {}, created_at_ms: 1, updated_at_ms: 1,
}));

async function geometry(row: Locator) {
  return row.evaluate(element => {
    const origin = element.getBoundingClientRect();
    const read = (selector: string) => {
      const node = element.querySelector<HTMLElement>(selector)!;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return { left: box.left - origin.left, right: box.right - origin.left, width: box.width,
        full: node.scrollWidth <= node.clientWidth + 1, align: style.textAlign, whiteSpace: style.whiteSpace };
    };
    return { name: read('.quote-row-name'), price: read('.quote-row-price'), percent: read('.quote-row-percent'),
      gap: parseFloat(getComputedStyle(element).columnGap), padding: parseFloat(getComputedStyle(element).paddingRight),
      height: origin.height };
  });
}

for (const fontSize of [16, 20]) {
  test(`스크리너 숫자 열·예상가 고스트·같은 조건 폭 유지·새 조건 초기화 (${fontSize}px)`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-19T01:00:00Z') });
    await installLiveMocks(page);
    await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { schema_version: 1, saves } }));
    await page.route(apiPrefix('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [], days_behind: 0 } }));
    let included = entries.map(row => row.code), scans = 0;
    await page.route(apiExact('screener/scan'), route => {
      scans++;
      return route.fulfill({ json: { status: 'ok', warnings: [], has_more: false, rows: entries.filter(row => included.includes(row.code)) } });
    });
    let price = 123456, percent = -1.23;
    let expectedPrice: number | undefined;
    await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: { phase: 'open', quotes: entries.map((row, index) => ({
      code: row.code, price: index ? price : 1234, change_pct: index ? percent : 2.34, change_won: 0,
      ...(index && expectedPrice != null ? { expected_price: expectedPrice, expected_change_pct: percent } : {}),
    })) } }));
    await page.goto('/live?code=098460');
    await page.addStyleTag({ content: `:root { font-size: ${fontSize}px !important; }` });
    const panel = page.getByTestId('screener-panel');
    if (!(await panel.isVisible())) await page.getByRole('button', { name: /스크리너 패널 토글/ }).click();
    const toggle = panel.getByTestId('screener-monitor-toggle');
    await toggle.click();
    const first = panel.getByTestId('screener-row-005930'), second = panel.getByTestId('screener-row-000660');
    await expect(second.locator('.quote-row-price')).toHaveText('123,456');
    await first.click();
    await expect(first).toHaveAttribute('aria-current', 'true');
    const scale = fontSize / 16;
    for (const [width, gap, padding] of [[360, 8, 12], [280, 4, 8], [240, 2, 4]]) {
      await page.addStyleTag({ content: `:root { --watchlist-panel-w: ${width / 16}rem !important; }` });
      await expect.poll(() => geometry(first).then(value => value.gap)).toBe(gap * scale);
      const [a, b] = await Promise.all([geometry(first), geometry(second)]);
      expect(a.name.left).toBe(40 * scale);
      expect(a.padding).toBe(padding * scale);
      expect(a.price.right).toBeCloseTo(b.price.right, 3);
      expect(a.percent.right).toBeCloseTo(b.percent.right, 3);
      for (const value of [a.price, a.percent, b.price, b.percent]) {
        expect(value.full).toBe(true);
        expect(value.align).toBe('right');
        expect(value.whiteSpace).toBe('nowrap');
      }
      expect(a.height).toBeLessThanOrEqual(26 * scale);
      expect(await panel.getByTestId('screener-scroll').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      if (width === 280) await panel.screenshot({ path: `/tmp/hoga-screener-columns-default-${fontSize}.png` });
    }
    await panel.getByRole('button', { name: '스크리너 결과 정렬' }).click();
    await toggle.click(); // Pause automatic scans; quotes continue refreshing.
    price = 123456789; percent = -1234.56; expectedPrice = 1234567890;
    await page.clock.fastForward(11_000);
    await expect(second.locator('.quote-row-price')).toHaveText('1,234,567,890');
    await expect(second.locator('.quote-row-percent')).toHaveText('-1234.56%');
    const wide = await geometry(second);
    expect(wide.price.full && wide.percent.full).toBe(true);

    // The body-portal clone uses the same budget and expected quote as its source.
    const box = await second.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 8, box!.y + box!.height / 2, { steps: 3 });
    const ghost = page.getByTestId('screener-drag-ghost');
    await expect(ghost).toBeVisible();
    await expect(ghost.locator('.quote-row-price')).toHaveText('1,234,567,890');
    await expect(ghost.getByTestId('screener-drag-ghost-expected-marker')).toBeVisible();
    const clone = await geometry(ghost);
    expect(clone.price.width).toBe(wide.price.width);
    expect(clone.percent.width).toBe(wide.percent.width);
    expect(clone.gap).toBe(wide.gap);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
    await page.waitForTimeout(60); // dnd-kit removes document click suppression after 50ms.

    const scroll = panel.getByTestId('screener-scroll');
    await page.addStyleTag({ content: ':root { --watchlist-panel-w: 10rem !important; }' });
    await expect.poll(() => scroll.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await page.addStyleTag({ content: ':root { --watchlist-panel-w: 17.5rem !important; }' });
    price = 12; percent = 1; expectedPrice = undefined;
    await page.clock.fastForward(11_000);
    await expect(second.locator('.quote-row-price')).toHaveText('12');
    expect((await geometry(second)).price.width).toBe(wide.price.width);

    const rescan = async () => {
      const before = scans;
      if ((await toggle.textContent())!.includes('종료')) await toggle.click();
      await toggle.click();
      await expect.poll(() => scans).toBeGreaterThan(before);
    };
    included = ['005930'];
    await rescan();
    await expect(second).toHaveCount(0);
    await expect(first).toBeVisible();
    expect((await geometry(first)).price.width).toBe(wide.price.width);
    included = [];
    await rescan();
    await expect(panel.getByText('조건에 맞는 종목이 없습니다')).toBeVisible();
    included = ['005930'];
    await rescan();
    await expect(first).toBeVisible();
    expect((await geometry(first)).price.width).toBe(wide.price.width);
    expect((await geometry(first)).percent.width).toBe(wide.percent.width);

    const before = scans;
    await panel.getByRole('button', { name: '저장한 조건검색 선택' }).click();
    await page.getByRole('option', { name: '조건 B' }).click();
    await expect.poll(() => scans).toBeGreaterThan(before);
    await expect(first).toBeVisible();
    await expect.poll(() => geometry(first).then(value => value.price.width)).toBeLessThan(wide.price.width);
    expect((await geometry(first)).percent.width).toBeLessThan(wide.percent.width);
    await panel.screenshot({ path: `/tmp/hoga-screener-columns-new-condition-${fontSize}.png` });
    expect(errors).toEqual([]);
  });
}
