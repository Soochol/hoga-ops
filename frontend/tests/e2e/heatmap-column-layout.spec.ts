import { test, expect, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test.use({ viewport: { width: 1600, height: 1000 } });
const folder = { id: 'f_0000000a', name: '열 정렬', order: 0 };
const otherFolder = { id: 'f_0000000b', name: '다른 그룹', order: 1 };
const entries = [
  { code: '005930', name: '삼성전자', order: 0 },
  { code: '000660', name: 'SK하이닉스', order: 1 },
].map(entry => ({ ...entry, folder_id: entry.order ? otherFolder.id : folder.id }));

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
    return { name: read('.quote-row-name'), flow: read('.quote-row-flow'), price: read('.quote-row-price'), percent: read('.quote-row-percent'),
      gap: parseFloat(getComputedStyle(element).columnGap), padding: parseFloat(getComputedStyle(element).paddingRight),
      height: origin.height };
  });
}

for (const fontSize of [16, 20]) {
  test(`히트맵 흐름·그룹 헤더 정렬·반응형 여백·관측 폭 유지 (${fontSize}px)`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-19T01:00:00Z') });
    await installLiveMocks(page);
    let flowRequests = 0;
    const series = Array.from({ length: 132 }, (_, i) => i < 60 ? Math.round((Math.sin(i / 7) + i / 40) * 100) / 100 : null);
    await page.route(apiExact('panel-flow'), route => { flowRequests++; return route.fulfill({ json: {
      date: '2026-10-19', venue: 'KRX', bucket_ms: 300000, t_base_ms: 1792368000000, as_of_ms: 1792371600000,
      stocks: entries.map(entry => ({ code: entry.code, venue: 'KRX', pct: series, last_observed_ms: 1792371600000, missing_reason: null })), groups: [{ folder_id: folder.id, pct: series, counts: series.map(value => value == null ? 0 : 1), total: 1 }],
    } }); });
    await page.route(apiExact('heatmap'), route => route.fulfill({ json: { folders: [folder, otherFolder], entries, capture_markers: {} } }));
    let price = 123456, percent = -1.23;
    let expectedPrice: number | undefined;
    await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: {
      phase: 'open', quotes: entries.map((entry, index) => ({ code: entry.code,
        price: index ? price : 1234, change_pct: index ? percent : 2.34, change_won: 0,
        ...(index && expectedPrice != null ? { expected_price: expectedPrice, expected_change_pct: percent } : {}) })),
    } }));
    await page.goto('/live?code=098460');
    await page.addStyleTag({ content: `:root { font-size: ${fontSize}px !important; }` });
    const panel = page.getByTestId('heatmap-panel');
    if (!(await panel.isVisible())) await page.getByRole('button', { name: /히트맵 패널 토글/ }).click();
    const first = panel.getByTestId('heatmap-drawer-row-005930'), second = panel.getByTestId('heatmap-drawer-row-000660');
    await expect(second.locator('.quote-row-flow')).toBeVisible();
    await expect(second.locator('.quote-row-price')).toHaveCount(1);
    await first.click();
    await expect(first).toHaveAttribute('aria-current', 'true');
    const scale = fontSize / 16;
    await expect(panel).toHaveCSS('width', `${320 * scale}px`);
    const columnsHeader = panel.getByTestId('quote-columns-header');
    await expect(columnsHeader).toHaveText('종목명흐름가격등락률');
    const headerGeometry = await geometry(columnsHeader);
    const rowGeometry = await geometry(first);
    for (const column of ['name', 'flow', 'price', 'percent'] as const) {
      expect(headerGeometry[column].left).toBeCloseTo(rowGeometry[column].left, 3);
      expect(headerGeometry[column].right).toBeCloseTo(rowGeometry[column].right, 3);
    }
    await panel.screenshot({ path: `/tmp/hoga-heatmap-four-columns-${fontSize}.png` });
    for (const [width, gap, padding] of [[360, 8, 12], [320, 4, 8], [280, 4, 8], [240, 2, 4]]) {
      await page.addStyleTag({ content: `:root { --watchlist-panel-w: ${width / 16}rem !important; }` });
      await expect.poll(() => geometry(first).then(value => value.gap)).toBe(gap * scale);
      const [a, b] = await Promise.all([geometry(first), geometry(second)]);
      expect(a.padding).toBe(padding * scale);
      expect(a.name.left).toBe(40 * scale);
      expect(a.flow.right).toBeCloseTo(b.flow.right, 3);
      expect(a.percent.right).toBeCloseTo(b.percent.right, 3);
      expect(a.flow.width).toBe(64);
      expect(a.price.right).toBeCloseTo(b.price.right, 3);
      expect(a.flow.right).toBeLessThanOrEqual(a.price.left);
      expect(a.flow.right).toBeCloseTo(b.flow.right, 3);
      for (const value of [a.price, b.price, a.percent, b.percent]) {
        expect(value.full).toBe(true);
        expect(value.align).toBe('right');
        expect(value.whiteSpace).toBe('nowrap');
      }
      for (const header of await panel.getByTestId('heatmap-group-header').all()) {
        await expect(header.locator('.quote-row-flow, .heatmap-group-percent')).toHaveCount(0);
        await expect(header).not.toContainText('%');
      }
      if (width === 320) await panel.screenshot({ path: `/tmp/hoga-heatmap-columns-default-${fontSize}.png` });
      expect(a.height).toBeLessThanOrEqual(26 * scale);
      if (width !== 280) expect(await panel.getByTestId('heatmap-drawer-scroll').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(width >= 320);
    }
    await panel.getByRole('button', { name: '종목 정렬', exact: true }).click();
    await panel.getByRole('button', { name: '그룹 정렬', exact: true }).click();
    expect((await geometry(first)).flow.width).toBe((await geometry(second)).flow.width);
    // Real query refreshes grow and then shrink the displayed figures. The
    // retained budget must survive shrink, search and group collapse.
    price = 123456789; percent = -1234.56; expectedPrice = 1234567890;
    await page.clock.fastForward(11_000);
    await expect(second.locator('.quote-row-price')).toHaveCount(1);
    await expect(second.getByTestId('heatmap-drawer-row-000660-expected-marker')).toBeVisible();
    await expect(second.locator('.quote-row-percent')).toHaveText('-1234.56%');
    await expect.poll(() => geometry(second).then(value => value.flow.full && value.percent.full)).toBe(true);
    const wide = await geometry(first);
    const scroll = panel.getByTestId('heatmap-drawer-scroll');
    await page.addStyleTag({ content: ':root { --watchlist-panel-w: 10rem !important; }' });
    await expect.poll(() => scroll.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    expect((await geometry(second)).flow.full).toBe(true);
    await page.addStyleTag({ content: ':root { --watchlist-panel-w: 15rem !important; }' });
    price = 12; percent = 1; expectedPrice = undefined;
    await page.clock.fastForward(11_000);
    await expect(second.locator('.quote-row-price')).toHaveCount(1);
    await expect(second.getByTestId('heatmap-drawer-row-000660-expected-marker')).toHaveCount(0);
    expect((await geometry(first)).flow.width).toBe(wide.flow.width);
    expect((await geometry(first)).percent.width).toBe(wide.percent.width);
    expect(flowRequests).toBe(1);
    const search = panel.getByRole('textbox', { name: '종목·그룹 검색' });
    await search.fill('삼성');
    await expect(second).toHaveCount(0);
    expect((await geometry(first)).flow.width).toBe(wide.flow.width);
    await search.fill('');
    await panel.getByRole('button', { name: '전체 접기' }).click();
    await expect(first).toHaveCount(0);
    await panel.getByRole('button', { name: '전체 펼치기' }).click();
    expect((await geometry(first)).flow.width).toBe(wide.flow.width);
    expect((await geometry(first)).percent.width).toBe(wide.percent.width);
    // Group drag keeps the name/count header without flow or percentage.
    const header = panel.getByTestId('heatmap-group-header').filter({ hasText: folder.name });
    await panel.getByRole('button', { name: '그룹 정렬', exact: true }).click();
    await panel.getByRole('button', { name: '그룹 정렬', exact: true }).click();
    const box = await header.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 8, box!.y + box!.height / 2, { steps: 3 });
    const ghost = page.getByTestId('heatmap-drag-ghost');
    await expect(ghost).toBeVisible();
    await expect(ghost.locator('.quote-row-flow, .heatmap-group-percent')).toHaveCount(0);
    await expect(ghost).not.toContainText('%');
    await expect(ghost).toContainText(folder.name);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
    await panel.screenshot({ path: `/tmp/hoga-heatmap-columns-${fontSize}.png` });
    expect(pageErrors).toEqual([]);
  });
}
