import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test('Delete excludes only the focused group membership and keeps keyboard focus', async ({ page }) => {
  await installLiveMocks(page);
  const stock = { code: '005930', name: '삼성전자', registered_at_kst_date: '20260908', last_success_date: null, folder_id: 'f_a', order: 0 };
  let entries = [stock, { ...stock, code: '000660', name: 'SK하이닉스', order: 1 }, { ...stock, folder_id: 'f_b' }];
  const memberDeletes: string[] = [];
  const globalDeletes: string[] = [];
  await page.route(apiExact('watchlist'), (r) => r.fulfill({ json: {
    folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
    entries, memos: [], next_run_at_ms: 0,
  } }));
  await page.route(apiPrefix('live/quotes'), (r) => r.fulfill({ json: { phase: 'open', quotes: [] } }));
  await page.route(apiExact('watchlist/folders/f_a/members/005930'), (r) => {
    expect(r.request().method()).toBe('DELETE');
    memberDeletes.push('f_a:005930');
    entries = entries.filter((e) => !(e.folder_id === 'f_a' && e.code === '005930'));
    return r.fulfill({ status: 204 });
  });
  await page.route(apiExact('watchlist/005930'), (r) => {
    globalDeletes.push(r.request().method());
    return r.fulfill({ status: 204 });
  });
  await page.goto('/live');
  const panel = page.getByTestId('watchlist-panel');
  if (!(await panel.isVisible())) await page.getByRole('button', { name: '관심종목 패널 토글' }).click();
  const source = page.getByTestId('watchlist-dropzone-f_a');
  const other = page.getByTestId('watchlist-dropzone-f_b');
  const row = source.getByTestId('watchlist-row-005930');
  await expect(row).toBeVisible();
  // 중첩 메뉴 버튼의 Delete는 행 제외로 전파되지 않는다.
  await row.getByRole('button').first().focus();
  await page.keyboard.press('Delete');
  await expect(row).toBeVisible();
  expect(memberDeletes).toEqual([]);
  await row.focus();
  await page.keyboard.press('Backspace');
  await expect(row).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(row).toHaveCount(0);
  await expect(other.getByTestId('watchlist-row-005930')).toBeVisible();
  await expect(source.getByTestId('watchlist-row-000660')).toBeFocused();
  expect(memberDeletes).toEqual(['f_a:005930']);
  expect(globalDeletes).toEqual([]);
});
