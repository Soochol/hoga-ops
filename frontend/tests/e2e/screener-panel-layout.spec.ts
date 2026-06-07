// frontend/tests/e2e/screener-panel-layout.spec.ts
//
// watchlist-collapse-layout.spec.ts 의 ScreenerDrawer 변형 — 같은 앱 셸 행
// 계약(App.tsx gridTemplateRows minmax(0,1fr))을 공유하지만 ScreenerDrawer 는
// 자체 overflow:hidden + min-h-0 계약을 갖는 별도 컴포넌트라 독립적으로
// 회귀할 수 있다. 긴 조회 결과가 <main>(차트 높이의 결정자)을 키우지 않고
// 패널 내부 스크롤로 흡수되는지 고정한다.

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

const API = 'http://localhost:8000';

// 뷰포트(기본 720px)를 확실히 넘기는 결과: 60행 ≈ 2200px+
const SAVES = {
  schema_version: 1,
  saves: [{
    id: 's_a', name: '레이아웃테스트',
    conditions: [{ id: 'c1', type: 'trade_value', params: { min_eok: 100 } }],
    universe: {}, created_at_ms: 0, updated_at_ms: 0,
  }],
};
const SCAN = {
  status: 'ok',
  warnings: [],
  rows: Array.from({ length: 60 }, (_, i) => ({
    code: String(200000 + i), name: `결과종목${i}`, market: 'KOSPI',
    price: 10000 + i, trade_value_won: 1_000_000_000, change_pct: 1.5,
  })),
};

test.describe('Screener Panel results — app-shell layout invariance', () => {
  test('results taller than viewport do not grow <main>; panel scrolls internally', async ({ page }) => {
    await installLiveMocks(page);
    const json = (route: import('@playwright/test').Route, body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    await page.route(`${API}/api/screener/saves`, (r) => json(r, SAVES));
    await page.route(`${API}/api/screener/status*`, (r) => json(r, { status: 'ok', universe_size: 2000, days_behind: 0 }));
    await page.route(`${API}/api/screener/scan`, (r) => json(r, SCAN));

    await page.goto('/live');
    const panel = page.getByTestId('screener-panel');
    if (!(await panel.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /스크리너 패널 토글/ }).click();
    }
    await expect(panel).toBeVisible();

    // 조회 실행 → 60행 렌더 대기
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await expect(page.getByTestId('screener-row-200000')).toBeVisible();

    // 패널·main 모두 뷰포트에 묶인다 — auto 행 폭주(버그)면 결과 높이(≈2200px+)로 커진다.
    const vh = page.viewportSize()!.height;
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(vh);
    expect((await page.locator('main').boundingBox())!.height).toBeCloseTo(vh, 0); // DPR/서브픽셀 내성

    // 긴 결과는 패널 내부 스크롤 영역(min-h-0 + overflow-auto)이 받는다.
    const scroller = page.getByTestId('screener-scroll');
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  });
});
