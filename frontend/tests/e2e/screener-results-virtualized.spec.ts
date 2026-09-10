// `/screener` 결과표: **유계 높이 + 내부 스크롤 + 가상화**.
//
// 두 가지를 한 번에 지킨다.
//
// 1. **행이 잘리지 않는다.** 결과 섹션에 `min-h-0` 이 빠져 있어 flex 자식의 기본
//    `min-height:auto` 때문에 섹션이 콘텐츠 높이(1,000행 ≈ 28,000px)로 자랐고, 부모
//    (`overflow:hidden`, 644px)가 그걸 잘라냈다 — 아래쪽 행은 **스크롤로도 도달할 수
//    없었다**. jsdom 에는 레이아웃이 없어 단위 테스트로는 잡히지 않는다.
// 2. **가상화가 실제로 걸린다.** 유계가 아니면 가상화기가 "전부 보인다"고 판단해
//    1,000행을 그대로 그린다(실측). 즉 ①이 ②의 전제다 — 둘을 함께 봐야 의미가 있다.
import { test, expect, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

const N = 1000;
const SCAN = {
  rows: Array.from({ length: N }, (_, i) => ({
    code: String(100000 + i).padStart(6, '0'), name: `종목${i}`, market: 'KOSPI',
    price: 10000 + i, change_pct: (i % 20) - 10, trade_value_won: 1e10 + i,
    price_date: '2026-09-07',
  })),
  status: 'ok', warnings: [], universe_size: 2000, basis: 'eod',
};

test.use({ channel: 'chrome' });

test('1,000행 가상 결과의 검색·선택·CSV와 조회 당시 값이 유지된다', async ({ page }, testInfo) => {
  const measurementWarnings: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.text().includes("Missing attribute name 'data-index")) measurementWarnings.push(message.text());
  });
  const json = (r: Route, b: unknown) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route(apiPrefix('live/quotes'), (r) => json(r, { phase: 'open', quotes: [] }));
  await page.route(apiPrefix('screener/status'), (r) =>
    json(r, { status: 'ok', universe_size: 2000, days_behind: 0 }));
  await page.route(apiExact('screener/scan'), (r) => json(r, SCAN));
  await page.route(apiExact('screener/saves'), (r) => json(r, { schema_version: 1, saves: [] }));

  // 조회는 조건이 있어야 활성된다 — 빌더 draft 를 심어 둔다.
  await page.addInitScript(() => {
    localStorage.setItem('screenerDraft.v1', JSON.stringify({
      conditions: [{ id: 'c1', type: 'trade_value', params: { min_eok: 1 } }],
      universe: {}, anchorId: null, anchorName: null, dirty: true,
    }));
  });

  await page.goto('/screener');
  await page.getByRole('button', { name: '조회', exact: true }).click();

  const box = page.getByTestId('screener-result-rows');
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box).toHaveAttribute('data-virtualized', 'true');

  const rows = page.locator('[aria-label*="호가창 열기"]');
  // 창 크기만 그린다 — 1,000행 전부가 아니다. 정확한 수는 뷰포트에 좌우되므로
  // 상한만 못박는다(실측 14).
  expect(await rows.count()).toBeLessThan(100);

  const metrics = await box.evaluate((el) => {
    const shell = el.closest('[class*="overflow-auto"]') as HTMLElement;
    return {
      scrollH: shell.scrollHeight, clientH: shell.clientHeight, offset: (el as HTMLElement).offsetTop,
      relativeTop: el.getBoundingClientRect().top - shell.getBoundingClientRect().top + shell.scrollTop - shell.clientTop,
    };
  });
  // 유계 + 넘침 = 내부 스크롤이 산다. `min-h-0` 이 빠지면 clientH 가 콘텐츠 높이까지
  // 자라 둘이 같아지고(실측 28152/28152) 스크롤이 사라진다.
  expect(metrics.clientH).toBeLessThan(metrics.scrollH);
  expect(metrics.clientH).toBeLessThan(2000);
  expect(metrics.offset).toBeCloseTo(metrics.relativeTop, 0);

  // 끝까지 스크롤하면 **마지막 행**이 실제로 나온다 — 잘림 회귀의 직접 가드.
  await box.evaluate((el) => {
    const shell = el.closest('[class*="overflow-auto"]') as HTMLElement;
    shell.scrollTop = shell.scrollHeight;
  });
  await expect(page.getByRole('button', { name: /종목999 100999 호가창 열기/ })).toBeVisible();
  await page.getByRole('checkbox', { name: '종목999 100999 선택', exact: true }).check();
  await expect(page).toHaveURL(/\/screener$/);
  await page.getByRole('searchbox', { name: '결과 내 종목 검색' }).fill('종목0');
  await expect(page.getByText(/숨김 1종목 포함/)).toBeVisible();
  await page.getByRole('checkbox', { name: '검색 결과 전체 선택' }).check();
  await page.getByRole('button', { name: '조회 당시', exact: true }).click();
  await expect(page.getByRole('button', { name: '종목0 100000 호가창 열기' })).toContainText('10,000 (-10.00%)');
  await expect(page.getByText('2026-09-07', { exact: true })).toBeVisible();

  const selectedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '선택 CSV', exact: true }).click();
  const selectedFile = await selectedDownload;
  expect(selectedFile.suggestedFilename()).toMatch(/^screener-\d{14}\.csv$/);
  const selectedPath = testInfo.outputPath('selected.csv');
  await selectedFile.saveAs(selectedPath);
  const selectedCsv = await readFile(selectedPath, 'utf8');
  expect(selectedCsv).toContain('"\'100000"');
  expect(selectedCsv).toContain('"\'100999"');
  expect(selectedCsv.trim().split('\r\n')).toHaveLength(3);
  expect(selectedCsv).toContain('""min_eok"":1');

  // 전체 선택은 DOM의 수십 행이 아니라 필터를 통과한 1,000행에 적용된다.
  await page.getByRole('searchbox').fill('');
  await page.getByRole('checkbox', { name: '검색 결과 전체 선택' }).check();
  const allDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '선택 CSV', exact: true }).click();
  const allPath = testInfo.outputPath('all.csv');
  await (await allDownload).saveAs(allPath);
  expect((await readFile(allPath, 'utf8')).trim().split('\r\n')).toHaveLength(1001);
  expect(await rows.count()).toBeLessThan(100);
  expect(measurementWarnings).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath('results-wide.png') });
  await page.setViewportSize({ width: 944, height: 624 });
  await expect(page.getByRole('button', { name: '선택 CSV', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('results-compact.png') });
  await page.reload();
  await page.getByRole('button', { name: '조회 당시', exact: true }).click();
  await expect(page.getByRole('button', { name: '종목0 100000 호가창 열기' })).toContainText('10,000 (-10.00%)');
  await expect(page.getByRole('button', { name: '선택 CSV', exact: true })).toBeDisabled();
  expect(pageErrors).toEqual([]);
});
