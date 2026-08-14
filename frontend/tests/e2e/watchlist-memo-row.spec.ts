// frontend/tests/e2e/watchlist-memo-row.spec.ts
//
// 메모("빈칸") 행의 실제 브라우저 흐름: 그룹 ⋯ → '빈칸 추가' → POST /memos →
// 행이 종목 **사이** 제자리에 나타나고 → 클릭해 텍스트 입력 → PATCH → 표시.
// 단위 테스트가 못 보는 것을 여기서 잰다: 실제 레이아웃(행 높이·들여쓰기가 종목
// 행과 맞는지)과 order 축 병합이 진짜 DOM 순서로 이어지는지.
//
// 백엔드 독립(page.route mock) — GET 은 stateful 이라 추가/수정이 반영된다.

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

interface Entry {
  code: string; name: string; registered_at_kst_date: string;
  last_success_date: string | null; folder_id: string | null; order: number;
}
interface Memo { id: string; folder_id: string; order: number; text: string }

const FOLDERS = [{ id: 'f_0000000a', name: '스윙', order: 0, capture_enabled: true }];
// items: [005930(0), 000660(1)] — 메모는 테스트가 만든다.
const makeEntries = (): Entry[] => [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
];

const json = (route: import('@playwright/test').Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const openPanelIfClosed = async (page: import('@playwright/test').Page, testId: string) => {
  const row = page.getByTestId(testId);
  if (!(await row.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  }
  await expect(row).toBeVisible();
};

test.describe('Watchlist Panel — 메모(빈칸) 행', () => {
  test('빈칸 추가 → 종목 사이 제자리 → 인라인 편집으로 텍스트 저장', async ({ page }) => {
    await installLiveMocks(page);

    const entries = makeEntries();
    let memos: Memo[] = [];

    await page.route(apiExact('watchlist'), (route) =>
      json(route, { folders: FOLDERS, entries, memos, next_run_at_ms: Date.now() + 3_600_000 }));

    // 삽입: 요청의 at 을 그대로 반영한다(서버 시맨틱과 동일 — 그 자리에 끼우고 뒤를 민다).
    await page.route(apiPrefix('watchlist/folders/f_0000000a/memos'), async (route) => {
      const body = route.request().postDataJSON() as { text: string; at: number | null };
      const at = body.at ?? entries.length + memos.length;
      // 삽입 지점 이후의 종목 order 를 한 칸 민다(서버 items 삽입과 같은 효과).
      for (const e of entries) if (e.order >= at) e.order += 1;
      for (const m of memos) if (m.order >= at) m.order += 1;
      const memo: Memo = { id: 'm_0000000a', folder_id: 'f_0000000a', order: at, text: body.text };
      memos = [...memos, memo];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(memo) });
    });

    await page.route(apiPrefix('watchlist/memos/'), async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const { text } = route.request().postDataJSON() as { text: string };
      memos = memos.map((m) => ({ ...m, text }));
      await json(route, { ...memos[0], text });
    });

    await page.goto('/inventory');
    await openPanelIfClosed(page, 'watchlist-row-005930');

    // 1) 행 우클릭 → "위에 빈칸 삽입" (000660 자리 = items 인덱스 1)
    await page.getByTestId('watchlist-row-000660').click({ button: 'right' });
    await page.getByText('위에 빈칸 삽입').click();

    const memoRow = page.getByTestId('watchlist-memo-m_0000000a');
    await expect(memoRow).toBeVisible();

    // 2) 종목 **사이**에 있어야 한다 — order 축 병합이 실제 DOM 순서로 이어졌는지
    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll('li[data-testid^="watchlist-row-"], li[data-testid^="watchlist-memo-"]'))
        .map((el) => el.getAttribute('data-testid')));
    expect(order).toEqual([
      'watchlist-row-005930',
      'watchlist-memo-m_0000000a',
      'watchlist-row-000660',
    ]);

    // 3) 갓 만든 빈칸은 즉시 편집 모드로 열린다 → 텍스트 입력 후 Enter
    const input = page.getByTestId('watchlist-memo-m_0000000a-input');
    await expect(input).toBeVisible();
    await input.fill('실적 발표 대기');
    await input.press('Enter');

    await expect(memoRow).toContainText('실적 발표 대기');

    // 4) 레이아웃 — 메모 행 높이가 종목 행과 같아야 한 리스트로 읽힌다
    const [memoBox, rowBox] = await Promise.all([
      memoRow.boundingBox(),
      page.getByTestId('watchlist-row-005930').boundingBox(),
    ]);
    expect(memoBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(Math.abs(memoBox!.height - rowBox!.height)).toBeLessThanOrEqual(1);
    // 들여쓰기(pl-10)도 같아야 종목명과 같은 x 에서 텍스트가 시작한다
    expect(Math.abs(memoBox!.x - rowBox!.x)).toBeLessThanOrEqual(1);
  });

  test('빈 텍스트로 저장하면 빈 줄로 남는다 — 행이 사라지지 않는다', async ({ page }) => {
    await installLiveMocks(page);

    const entries = makeEntries();
    let memos: Memo[] = [{ id: 'm_0000000b', folder_id: 'f_0000000a', order: 2, text: '지울 내용' }];

    await page.route(apiExact('watchlist'), (route) =>
      json(route, { folders: FOLDERS, entries, memos, next_run_at_ms: Date.now() + 3_600_000 }));
    await page.route(apiPrefix('watchlist/memos/'), async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const { text } = route.request().postDataJSON() as { text: string };
      memos = memos.map((m) => ({ ...m, text }));
      await json(route, memos[0]);
    });

    await page.goto('/inventory');
    await openPanelIfClosed(page, 'watchlist-row-005930');

    const memoRow = page.getByTestId('watchlist-memo-m_0000000b');
    await expect(memoRow).toContainText('지울 내용');

    await memoRow.click();
    const input = page.getByTestId('watchlist-memo-m_0000000b-input');
    await input.fill('');
    await input.press('Enter');

    // 텍스트만 비고 행은 남는다 — 그게 "빈칸"이다.
    await expect(memoRow).toBeVisible();
    await expect(memoRow).toHaveText('');
    const box = await memoRow.boundingBox();
    expect(box!.height).toBeGreaterThan(10);   // 높이를 유지한다(0 으로 접히지 않음)
  });
});
