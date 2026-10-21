import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

for (const query of ['엘리스', '0158s0']) {
  test(`새 히트맵 그룹에 ${query} 선택 즉시 추가하고 실패 재시도·연속 입력·실행 취소를 제공한다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: query === '엘리스' ? 1280 : 800, height: 720 });
    await installLiveMocks(page);
    const code = '0158S0';
    const folder = { id: 'f_0000000b', name: '신규상장', order: 1 };
    const folders = [{ id: 'f_0000000a', name: '기존 그룹', order: 0 }];
    const entries = [{ code, name: '엘리스', folder_id: folders[0].id, order: 0 }];
    const writes: string[] = [], removals: string[] = [];
    const symbols = [{ code, name: '엘리스' }, { code: '000660', name: 'SK하이닉스' }];
    await page.route(apiPrefix('symbols'), route => route.fulfill({ json: {
      status: 'fresh', fetched_at_ms: Date.now(), capture_counts_status: 'ready', symbols: symbols.map(hit => ({
        ...hit, market: 'KOSDAQ', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
      })),
    } }));
    await page.route(apiExact('heatmap'), route => route.fulfill({ json: {
      folders, entries, capture_markers: {}, next_run_at_ms: 0,
    } }));
    await page.route(apiExact('heatmap/folders'), route => {
      expect(route.request().postDataJSON()).toEqual({ name: '신규상장' });
      folders.push(folder);
      return route.fulfill({ status: 201, json: folder });
    });
    await page.route(apiExact(`heatmap/folders/${folder.id}/members`), route => {
      const requested = route.request().postDataJSON().code;
      writes.push(requested);
      if (writes.length === 1) return route.fulfill({ status: 503, json: {
        detail: { code: 'temporarily_unavailable', message: '저장 서버에 연결할 수 없습니다. 다시 시도하세요.' },
      } });
      const entry = { code: requested, name: symbols.find(hit => hit.code === requested)!.name,
        folder_id: folder.id, order: entries.filter(entry => entry.folder_id === folder.id).length };
      entries.push(entry);
      return route.fulfill({ status: 201, json: entry });
    });
    await page.route(apiPrefix(`heatmap/folders/${folder.id}/members/`), route => {
      expect(route.request().method()).toBe('DELETE');
      const removed = route.request().url().split('/').at(-1)!;
      removals.push(removed);
      const index = entries.findIndex(entry => entry.folder_id === folder.id && entry.code === removed);
      expect(index).toBeGreaterThanOrEqual(0);
      entries.splice(index, 1);
      return route.fulfill({ status: 204, body: '' });
    });

    await page.goto('/heatmap');
    await page.getByRole('button', { name: '＋ 새 그룹', exact: true }).click();
    const groupDialog = page.getByRole('dialog', { name: '새 그룹 만들기' });
    await groupDialog.getByPlaceholder('그룹 이름 입력').fill(folder.name);
    await groupDialog.getByPlaceholder('그룹 이름 입력').press('Enter');
    const dialog = page.getByRole('dialog', { name: '종목 추가', exact: true });
    await expect(dialog).toBeVisible();
    const search = dialog.getByPlaceholder('종목명 또는 6자리 코드');
    await search.fill(query);
    await dialog.getByRole('option').filter({ hasText: '엘리스' }).click();
    await expect(dialog.getByRole('alert')).toContainText('종목을 추가하지 못했습니다. 저장 서버에 연결할 수 없습니다. 다시 시도하세요.');
    await expect(search).toHaveValue('엘리스 0158S0');
    await expect(dialog.getByRole('button', { name: '추가', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('add-error.png') });
    await dialog.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(dialog.getByLabel('종목 추가 안내')).toContainText('엘리스 추가됨');
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    const target = page.locator(`[data-heatmap-drop-folder="${folder.id}"]`);
    await expect(target.getByTestId(`heatmap-row-${code}`)).toBeVisible();
    await expect(dialog.getByLabel('종목 추가 안내')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath('quick-add-success.png') });

    await search.fill(query);
    const added = dialog.getByRole('option').filter({ hasText: '엘리스' });
    await expect(added).toContainText('추가됨');
    await expect(added).toHaveAttribute('aria-disabled', 'true');
    await search.press('Enter');
    expect(writes).toEqual([code, code]);
    await dialog.getByRole('button', { name: '실행 취소', exact: true }).click();
    await expect(target.getByTestId(`heatmap-row-${code}`)).toHaveCount(0);
    await expect(page.locator(`[data-heatmap-drop-folder="${folders[0].id}"]`).getByTestId(`heatmap-row-${code}`)).toBeVisible();
    expect(removals).toEqual([code]);
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();

    await search.fill('SK하이닉스');
    await search.press('Enter');
    await expect(target.getByTestId('heatmap-row-000660')).toBeVisible();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    expect(writes).toEqual([code, code, '000660']);
    // A later addition replaces the undo target without touching the earlier one.
    await search.fill(query);
    await search.press('Enter');
    await expect(target.getByTestId(`heatmap-row-${code}`)).toBeVisible();
    await dialog.getByRole('button', { name: '실행 취소', exact: true }).click();
    await expect(target.getByTestId(`heatmap-row-${code}`)).toHaveCount(0);
    await expect(target.getByTestId('heatmap-row-000660')).toBeVisible();
    expect(removals).toEqual([code, code]);
    expect(writes).toEqual([code, code, '000660', code]);
    await search.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(target.getByRole('button', { name: '종목 추가', exact: true })).toBeFocused();
  });
}
