import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

// Read the actual same-origin frozen report: numerical correctness is checked by
// offline replay and unit tests, while these tests exercise the native route.
test.beforeEach(async ({ page }) => {
  await installLiveMocks(page);
  await page.goto('/breadth');
});

test('native navigation, vertical analysis sections, and bulk ETF selection survive reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '공탐지수', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '공탐지수', exact: true })).toHaveAttribute('href', '/breadth');
  await expect(page.getByRole('img', { name: '전체 원점수 기본 그래프' })).toBeVisible();
  for (const name of ['추이와 확산', 'ETF 비교', '시장 스트레스', '변화의 원인']) {
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1);
  }
  await page.getByRole('navigation', { name: '공탐지수 분석 바로가기' }).getByRole('link', { name: /ETF 비교/ }).click();
  await expect(page.getByRole('heading', { name: 'ETF 비교', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '전체 선택', exact: true }).click();
  await expect(page.getByRole('heading', { name: '선택한 ETF 42개' })).toBeVisible();
  const comparison = page.getByRole('img', { name: '선택 ETF 겹쳐 보기', exact: true });
  await expect(comparison).toHaveCount(1);
  await expect(comparison.locator('path[data-line-id]')).toHaveCount(43);
  await expect(page.getByRole('group', { name: 'ETF 선택 목록' }).getByRole('checkbox', { checked: true })).toHaveCount(42);
  await page.reload();
  await expect(page.getByRole('heading', { name: '선택한 ETF 42개' })).toHaveCount(1);
  await expect(comparison.locator('path[data-line-id]')).toHaveCount(43);
  await page.getByRole('checkbox', { name: '전체 원점수 비교', exact: true }).uncheck();
  await expect(comparison.locator('path[data-line-id]')).toHaveCount(42);
  await page.getByRole('button', { name: '전체 해제', exact: true }).click();
  await expect(page.getByRole('heading', { name: '선택한 ETF 0개' })).toBeVisible();
  await page.getByRole('link', { name: '기본 그래프 ↑' }).nth(1).click();
  await expect(page.getByRole('img', { name: '전체 원점수 기본 그래프' })).toBeInViewport();
  await page.reload();
  await expect(page.getByRole('heading', { name: '선택한 ETF 0개' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('recovery headers cycle sorting and legend/table focus emphasizes a stable ETF line', async ({ page }) => {
  const comparison = page.getByRole('img', { name: '선택 ETF 겹쳐 보기', exact: true });
  const path = comparison.locator('path[data-line-id="0221Z0"]');
  await expect(path).toHaveCount(1);
  const originalStroke = await path.getAttribute('stroke');
  const originalDash = await path.getAttribute('stroke-dasharray');
  await page.getByRole('button', { name: '전체 선택', exact: true }).click();
  await expect(path).toHaveAttribute('stroke', originalStroke!);
  expect(await path.getAttribute('stroke-dasharray')).toBe(originalDash);
  const table = page.getByRole('table', { name: '회복 지속성' });
  const defaultOrder = await table.locator('tbody tr').evaluateAll(rows => rows.map(row => row.getAttribute('data-fund-code')));
  for (const name of ['ETF', '원점수', '5일 변화', '20일 변화', '연속 개선', '최근 5일 개선']) {
    const header = table.getByRole('columnheader', { name, exact: true });
    const button = header.getByRole('button');
    await button.click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await button.press('Enter');
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await button.press('Space');
    await expect(header).toHaveAttribute('aria-sort', 'none');
    await expect(table.locator('caption')).toContainText('기본 순서 · 연속 개선 내림차순');
    expect(await table.locator('tbody tr').evaluateAll(rows => rows.map(row => row.getAttribute('data-fund-code')))).toEqual(defaultOrder);
  }
  await table.getByRole('button', { name: '5일 변화', exact: true }).click();
  const values = await table.locator('tbody tr td:nth-child(3)').allTextContents();
  const numeric = values.map(Number);
  expect(numeric).toEqual([...numeric].sort((a, b) => a - b));
  await expect(path).toHaveAttribute('stroke', originalStroke!);
  expect(await path.getAttribute('stroke-dasharray')).toBe(originalDash);
  const legend = page.getByRole('button', { name: 'ACE K바이오코스닥액티브 그래프 강조', exact: true }).first();
  await legend.hover();
  await expect(path).toHaveAttribute('stroke-width', '3');
  await expect(comparison.locator('path[data-line-id="baseline"]')).toHaveAttribute('opacity', '0.18');
  await comparison.locator('..').screenshot({ path: test.info().outputPath('breadth-all-etfs-highlight.png') });
  await page.getByRole('heading', { name: '선택한 ETF 42개' }).hover();
  await expect(path).toHaveAttribute('stroke-width', '2');
  const rowButton = table.getByRole('button', { name: 'ACE K바이오코스닥액티브 그래프 강조', exact: true });
  await rowButton.focus();
  await expect(path).toHaveAttribute('stroke-width', '3');
  await table.getByRole('button', { name: 'ETF', exact: true }).focus();
  await expect(path).toHaveAttribute('stroke-width', '2');
  await page.getByRole('group', { name: 'ETF 선택 목록' }).getByRole('checkbox', { name: /0221Z0/ }).uncheck();
  await expect(path).toHaveCount(0);
  await page.getByRole('group', { name: 'ETF 선택 목록' }).getByRole('checkbox', { name: /0221Z0/ }).check();
  await expect(path).toHaveAttribute('stroke', originalStroke!);
  expect(await path.getAttribute('stroke-dasharray')).toBe(originalDash);
});

test('spread and attribution share the selected endpoint horizon with searchable stock contributions', async ({ page }) => {
  const spread = page.locator('#spread');
  const causes = page.locator('#causes');
  await expect(spread.getByRole('img', { name: '개선 49종목, 악화 61종목, 동일 367종목', exact: true })).toBeVisible();
  await spread.getByRole('button', { name: '20거래일', exact: true }).click();
  await expect(spread.getByRole('img', { name: '개선 52종목, 악화 236종목, 동일 189종목', exact: true })).toBeVisible();
  await causes.getByRole('heading', { name: '종목별 점수 기여' }).scrollIntoViewIfNeeded();
  await expect(causes.getByRole('button', { name: '20거래일', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(causes.getByText('-23.20점', { exact: true })).toBeVisible();
  await causes.getByRole('combobox', { name: '종목 기여 방향' }).selectOption('all');
  await causes.getByRole('textbox', { name: '종목 검색' }).fill('005930');
  await expect(causes.getByRole('rowheader', { name: /삼성전자/ })).toBeVisible();
  await causes.getByRole('textbox', { name: '종목 검색' }).fill('검색결과없음');
  await expect(causes.getByText('조건에 맞는 종목이 없습니다.')).toBeVisible();
});

test('failed report stays visibly unavailable and can be retried', async ({ page }) => {
  await page.route('**/market-breadth/snapshot.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('자료를 불러오지 못했습니다');
  await expect(page.getByRole('img', { name: '전체 원점수 기본 그래프' })).toHaveCount(0);
  await page.unroute('**/market-breadth/snapshot.json');
  await page.getByRole('button', { name: '다시 불러오기' }).click();
  await expect(page.getByRole('heading', { name: '공탐지수', exact: true })).toBeVisible();
});

test('charts and analysis fit the project content area in both dark and light themes', async ({ page }) => {
  for (const theme of ['trading-desk', 'ledger']) {
    await page.evaluate(value => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: value })), theme);
    await page.reload();
    await expect(page.getByRole('heading', { name: '공탐지수', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '전체 선택', exact: true }).click();
    for (const width of [1440, 960, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      const content = page.getByTestId('breadth-page');
      await expect.poll(() => content.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await expect(page.getByRole('img', { name: '전체 원점수 기본 그래프' })).toBeVisible();
      if (theme === 'trading-desk' && width === 1440) {
        await page.screenshot({ path: test.info().outputPath('breadth-native-page.png') });
      }
    }
  }
});
