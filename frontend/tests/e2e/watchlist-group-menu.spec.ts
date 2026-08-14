// frontend/tests/e2e/watchlist-group-menu.spec.ts
//
// 패널 그룹 헤더 ⋯ 메뉴 e2e: 실제 마우스 hover 로 ⋯ 노출(group-hover CSS —
// jsdom 이 검증 못 하는 층) → 메뉴 → 그룹 이름 변경 다이얼로그(기존 이름 prefill)
// → PATCH /api/watchlist/folders/{id} → 헤더 라벨 즉시 갱신. 그리고 Escape 레이어링:
// 열린 메뉴/다이얼로그의 Escape 는 패널을 닫지 않는다(useLiveKeyboard 양보 계약).

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

// 호스트를 박지 않는다 — 'http://localhost:8080' 은 API 주소가 아니라
// config.ts 의 DEFAULT_CONFIG **폴백**이었다. /config.json 이 정상 제공되면
// 앱은 진짜 백엔드로 가고 이 모킹은 한 건도 안 걸린다(2026-07-30 실측).

const makeState = () => ({
  folders: [{ id: 'f_a', name: '스윙', order: 0 }],
  entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527',
      last_success_date: null, folder_id: 'f_a', order: 0 },
  ],
});

const json = (route: import('@playwright/test').Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(page: import('@playwright/test').Page) {
  await installLiveMocks(page);
  const state = makeState();
  let patched: { id: string; name: string } | null = null;

  await page.route(apiPrefix('live/quotes'), (r) => json(r, { phase: 'open', quotes: [] }));
  // PATCH /folders/{id} — stateful rename. {id} 경로라 GET 보다 먼저 등록.
  await page.route(apiPrefix('watchlist/folders/'), async (route) => {
    if (route.request().method() === 'PATCH') {
      const id = route.request().url().split('/').pop()!;
      const name = (JSON.parse(route.request().postData() || '{}') as { name: string }).name;
      patched = { id, name };
      state.folders = state.folders.map((f) => (f.id === id ? { ...f, name } : f));
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fallback();
  });
  await page.route(apiExact('watchlist'), (r) => json(r, { ...state, memos: [], next_run_at_ms: 0 }));

  await page.goto('/live');
  const group = page.locator('[data-testid="watchlist-group-f_a"]');
  const headerLabelButton = group.getByRole('button', { name: /^스윙(\s+\d+)?$/ });
  const header = page.locator('div.group', { hasText: '스윙' });
  if (!(await header.first().isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  }
  await expect(headerLabelButton).toBeVisible();
  return {
    group,
    getPatched: () => patched,
    hoverHeader: async () => {
      await headerLabelButton.hover();
    },
    dots: group.getByRole('button', { name: '스윙 그룹 메뉴' }),
    sortButton: group.getByRole('button', { name: '스윙 정렬' }),
    menuByLabel: (label: string) => page.getByRole('menu', { name: label }),
  };
}

test.describe('Watchlist Panel group ⋯ menu', () => {
  test('⋯ 메뉴 → 이름 변경 dialog (prefilled) → PATCH and header updates', async ({ page }) => {
    const { getPatched, hoverHeader, dots } = await setup(page);

    // **hover 로 나타나던 시절의 단언을 걷어냈다.** 그룹 헤더 도구(드래그·정렬·⋯)는
    // 이제 호버 없이 항시 표시된다 — `WatchlistDrawer.tsx` 주석 그대로:
    // "그룹 헤더 도구(드래그·정렬·⋯)는 호버 없이 항시 표시(사용자 요청) — dim 으로
    // 밀도는 유지하되 발견성을 높인다". opacity 0→1 을 기대하면 항상 1 이라 실패한다.
    // hover 는 남겨 둔다(실 마우스 경로를 계속 지나가게).
    await expect(dots).toBeVisible();
    await hoverHeader();

    await dots.click();
    await page.getByRole('menuitem', { name: '그룹 이름 변경' }).click();
    const input = page.getByPlaceholder('그룹 이름 입력');
    await expect(input).toHaveValue('스윙');                       // 기존 이름 prefill
    await input.fill('단타');
    await page.getByRole('button', { name: '변경' }).click();

    await expect.poll(() => getPatched()).toEqual({ id: 'f_a', name: '단타' });
    const group = page.locator('[data-testid="watchlist-group-f_a"]');
    await expect(group.getByRole('button', { name: /^단타(\s+\d+)?$/ })).toBeVisible(); // 헤더 갱신
  });

  test('group sort icon toggles sort directly', async ({ page }) => {
    const { sortButton, hoverHeader } = await setup(page);

    // 위 테스트와 같은 이유로 opacity 전제를 걷어냈다(항시 표시).
    await expect(sortButton).toBeVisible();
    await hoverHeader();

    await sortButton.click();
    await expect(page.getByRole('menu', { name: '정렬' })).toHaveCount(0);
  });

  test('Escape 는 열린 메뉴·다이얼로그만 닫는다 — 패널은 그대로(#534 로 패널 단축키는 제거됨)', async ({ page }) => {
    const { hoverHeader, dots, menuByLabel } = await setup(page);
    const panel = page.getByTestId('watchlist-panel');

    // 메뉴 열고 Escape → 메뉴만 닫힌다
    await hoverHeader();
    await dots.click();
    await expect(menuByLabel('스윙')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuByLabel('스윙')).toHaveCount(0);
    await expect(panel).toBeVisible();

    // 다이얼로그 열고 Escape → 다이얼로그만 닫힌다
    // "새 그룹 만들기" 도 메뉴 항목이 아니라 헤더의 독립 버튼이 됐다.
    await page.getByRole('button', { name: '새 그룹 만들기' }).click();
    await expect(page.getByRole('dialog', { name: '그룹 추가하기' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '그룹 추가하기' })).toHaveCount(0);
    await expect(panel).toBeVisible();

    // **"마지막 Escape 가 패널을 닫는다" 단계를 걷어냈다.** 그 단축키는 #534
    // ("fix(live): Esc 우측 사이드패널 닫기 단축키 제거")에서 의도적으로 없앴다 —
    // `useLiveKeyboard.ts` 에 Escape 처리가 아예 없다. 회귀가 아니라 제거된 기능이다.
    // 이 테스트가 지키는 건 **레이어링**(열린 메뉴/다이얼로그의 Escape 가 패널까지
    // 삼키지 않는다)이고, 그건 위에서 이미 검증했다. 아무것도 안 열린 상태의 Escape 가
    // 패널을 그대로 두는 것까지 못박아 둔다.
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
  });
});
