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
import { apiExact, apiPrefix } from './helpers/apiRoutes';

const N = 1000;
const SCAN = {
  rows: Array.from({ length: N }, (_, i) => ({
    code: String(100000 + i).padStart(6, '0'), name: `종목${i}`, market: 'KOSPI',
    price: 10000 + i, change_pct: (i % 20) - 10, trade_value_won: 1e10 + i,
  })),
  scanned_at_ms: 0, universe_size: 2000, basis: 'eod',
};

test.use({ channel: 'chrome' });

test('1,000행 결과가 유계 영역에서 내부 스크롤되고 DOM 은 창 크기만 그린다', async ({ page }) => {
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
    return { scrollH: shell.scrollHeight, clientH: shell.clientHeight };
  });
  // 유계 + 넘침 = 내부 스크롤이 산다. `min-h-0` 이 빠지면 clientH 가 콘텐츠 높이까지
  // 자라 둘이 같아지고(실측 28152/28152) 스크롤이 사라진다.
  expect(metrics.clientH).toBeLessThan(metrics.scrollH);
  expect(metrics.clientH).toBeLessThan(2000);

  // 끝까지 스크롤하면 **마지막 행**이 실제로 나온다 — 잘림 회귀의 직접 가드.
  await box.evaluate((el) => {
    const shell = el.closest('[class*="overflow-auto"]') as HTMLElement;
    shell.scrollTop = shell.scrollHeight;
  });
  await expect(page.getByRole('button', { name: /종목999 100999 호가창 열기/ })).toBeVisible();
});
