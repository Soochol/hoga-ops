import { test, expect, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { API_URL } from './worktreeEnv';

// 배포 번들에서 실제 폰트와 패널 레이아웃을 검증한다.
test.use({ baseURL: API_URL });

function snapshot(params: URLSearchParams, count: number) {
  return {
    kind: params.get('kind'), market: params.get('market'), direction: params.get('direction'),
    venue: params.get('venue'), market_open: true, fetched_at_ms: Date.now(),
    queried_count: count, has_more: count < 300,
    rows: Array.from({ length: count }, (_, i) => ({
      rank: i + 1, code: String(100000 + i), name: `순위종목${i + 1}`,
      price: 10000 + i, change_pct: (i + 1) / 10, trade_value_won: (300 - i) * 100000000,
      program_net_buy_won: params.get('kind') === 'program' ? (300 - i) * 1000000 : undefined,
    })),
  };
}

async function anchor(scroller: Locator) {
  return scroller.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = Array.from(el.querySelectorAll<HTMLElement>('li[data-testid^="ranking-row-"]'))
      .find(node => node.getBoundingClientRect().bottom > top);
    return { id: row?.dataset.testid, offset: row ? row.getBoundingClientRect().top - top : 0 };
  });
}

test('sorted expansion and polling preserve the visible stock and expanded range', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installLiveMocks(page);
  const requested: number[] = [];
  await page.route(apiExact('live/rankings'), async route => {
    const params = new URL(route.request().url()).searchParams;
    const limit = Number(params.get('limit') ?? 100);
    requested.push(limit);
    await route.fulfill({ json: snapshot(params, limit) });
  });
  await page.goto('/live');
  await page.getByRole('button', { name: '순위 패널 토글', exact: true }).click();
  const panel = page.getByTestId('ranking-panel');
  await panel.getByRole('button', { name: '거래대금', exact: true }).click();
  await expect(panel.getByText('상위 100위 조회', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '등락률 정렬', exact: true }).click();
  const more = panel.getByRole('button', { name: '101~200위 더 보기', exact: true });
  await more.scrollIntoViewIfNeeded();
  const scroller = page.getByTestId('ranking-scroll');
  const before = await anchor(scroller);
  const chartHeight = await page.locator('main').evaluate(el => el.getBoundingClientRect().height);
  await more.click();
  await expect(panel.getByText('상위 200위 조회 · 조회 범위 내 등락률순', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(200);
  const after = await anchor(scroller);
  expect(after.id).toBe(before.id);
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
  expect(await page.locator('main').evaluate(el => el.getBoundingClientRect().height)).toBe(chartHeight);
  await panel.screenshot({ path: testInfo.outputPath('expanded-ranking.png') });

  await expect.poll(() => requested.filter(n => n === 200).length, { timeout: 15000 }).toBeGreaterThan(1);
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(200);
  expect((await anchor(scroller)).id).toBe(before.id);
  await panel.getByRole('combobox', { name: '시장' }).selectOption('kosdaq');
  await expect(panel.getByText('상위 100위 조회 · 조회 범위 내 등락률순', { exact: true })).toBeVisible();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
});

test('additional request failure keeps rows and scroll, retries, and ends at the last range', async ({ page }) => {
  await installLiveMocks(page);
  let finish: () => void = () => {};
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let fail = true;
  await page.route(apiExact('live/rankings'), async route => {
    const params = new URL(route.request().url()).searchParams;
    const limit = Number(params.get('limit') ?? 100);
    if (limit === 200 && fail) {
      await pending;
      await route.fulfill({ status: 502, json: { detail: { message: 'temporary failure' } } });
    } else {
      await route.fulfill({ json: snapshot(params, limit) });
    }
  });
  await page.goto('/live');
  await page.getByRole('button', { name: '순위 패널 토글', exact: true }).click();
  const panel = page.getByTestId('ranking-panel');
  await panel.getByRole('button', { name: '거래대금', exact: true }).click();
  const more = panel.getByRole('button', { name: '101~200위 더 보기', exact: true });
  await more.scrollIntoViewIfNeeded();
  const scroller = page.getByTestId('ranking-scroll');
  const before = await anchor(scroller);
  await more.click();
  await expect(panel.getByRole('button', { name: '불러오는 중…', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(100);
  finish();
  await expect(panel.getByText('추가 조회 실패', { exact: false })).toBeVisible();
  expect((await anchor(scroller)).id).toBe(before.id);
  fail = false;
  await panel.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(200);
  await panel.getByRole('button', { name: '201~300위 더 보기', exact: true }).click();
  await expect(panel.getByText('마지막 순위입니다', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /위 더 보기/ })).toHaveCount(0);
});

test('program starts at 50, expands to 150 and keeps the range when excluding ETFs', async ({ page }) => {
  await installLiveMocks(page);
  await page.route(apiExact('live/rankings'), route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: snapshot(params, Number(params.get('limit') ?? 100)) });
  });
  await page.goto('/live');
  await page.getByRole('button', { name: '순위 패널 토글', exact: true }).click();
  const panel = page.getByTestId('ranking-panel');
  await panel.getByRole('button', { name: '프로그램', exact: true }).click();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(50);
  await panel.getByRole('button', { name: '51~150위 더 보기', exact: true }).click();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(150);
  await expect(panel.getByText('순매수 금액 · 상위 150 · 30초 갱신', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('ranking-row-100000').getByTitle('프로그램 순매수 +3억')).toHaveCount(1);
  await panel.getByRole('button', { name: 'ETF 제외', exact: true }).click();
  await expect(panel.getByRole('button', { name: '151~250위 더 보기', exact: true })).toBeEnabled();
  await panel.getByRole('combobox', { name: '시장' }).selectOption('kosdaq');
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(50);
  await expect(panel.getByRole('button', { name: '51~150위 더 보기', exact: true })).toBeEnabled();
});
