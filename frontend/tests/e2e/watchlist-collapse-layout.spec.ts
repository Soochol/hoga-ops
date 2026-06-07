// frontend/tests/e2e/watchlist-collapse-layout.spec.ts
//
// 레이아웃 회귀: 관심종목 패널 콘텐츠가 뷰포트보다 길 때 App 루트 grid의
// 암시적 auto 행이 콘텐츠 높이만큼 늘어나 같은 행의 <main>(= /live 차트)이
// 함께 커지고, 그룹 접기/펼치기가 차트 높이를 바꾸던 버그를 고정한다.
// 실브라우저 레이아웃 계산이 필요한 버그라 jsdom(vitest)에는 시임이 없다 —
// e2e가 유일한 올바른 시임. 근본 수정: App.tsx gridTemplateRows minmax(0,1fr).

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

const API = 'http://localhost:8000';

// 뷰포트(기본 720px)를 확실히 넘기는 콘텐츠: 2개 그룹 × 25행 ≈ 1850px+
const makeState = () => {
  const entry = (i: number, folderId: string, order: number) => ({
    code: String(100000 + i),
    name: `테스트종목${i}`,
    registered_at_kst_date: '20260601',
    last_success_date: null,
    folder_id: folderId,
    order,
  });
  return {
    folders: [
      { id: 'f_a', name: '폴더A', order: 0 },
      { id: 'f_b', name: '폴더B', order: 1 },
    ],
    entries: [
      ...Array.from({ length: 25 }, (_, i) => entry(i, 'f_a', i)),
      ...Array.from({ length: 25 }, (_, i) => entry(25 + i, 'f_b', i)),
    ],
  };
};

async function setup(page: import('@playwright/test').Page) {
  await installLiveMocks(page);
  const json = (route: import('@playwright/test').Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
  await page.route(`${API}/api/watchlist*`, (r) => json(r, { ...makeState(), next_run_at_ms: 0 }));

  await page.goto('/live');
  const panel = page.getByTestId('watchlist-panel');
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  }
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('watchlist-row-100000')).toBeVisible();
  return panel;
}

const mainHeight = async (page: import('@playwright/test').Page) =>
  (await page.locator('main').boundingBox())!.height;

test.describe('Watchlist Panel collapse — app-shell layout invariance', () => {
  test('panel content taller than viewport does not grow <main>; collapse/expand keeps height invariant', async ({ page }) => {
    const panel = await setup(page);
    const vh = page.viewportSize()!.height;

    // 패널·main 모두 뷰포트에 묶인다 — auto 행 폭주(버그)면 콘텐츠 높이(≈1900px+)로 커진다.
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(vh);
    const h0 = await mainHeight(page);
    expect(h0).toBeCloseTo(vh, 0); // 뷰포트 일치 — DPR/서브픽셀 내성(±0.5px); 불변성 검사는 아래서 엄격 비교

    // 긴 목록은 패널 내부 스크롤 영역(overflow:auto)이 받는다 — 행이 커지면 스크롤이 죽는다.
    const scroller = page.getByTestId('watchlist-scroll');
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    // 그룹 접기 → <main>(차트 높이의 결정자) 불변. 이것이 사용자 증상의 직접 가드.
    await page.getByRole('button', { name: '폴더A 접기' }).click();
    await expect(page.getByTestId('watchlist-row-100000')).toBeHidden();
    expect(await mainHeight(page)).toBe(h0);

    // 다시 펼쳐도 불변.
    await page.getByRole('button', { name: '폴더A 펼치기' }).click();
    await expect(page.getByTestId('watchlist-row-100000')).toBeVisible();
    expect(await mainHeight(page)).toBe(h0);
  });
});
