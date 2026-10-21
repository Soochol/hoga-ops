import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

const A = 'f_0000000a', B = 'f_0000000b';
for (const surface of ['heatmap-header', 'heatmap-group', 'watchlist-popover', 'watchlist-edit'] as const) {
  test(`${surface}: 선택 즉시 추가·재시도·연속 입력·그룹별 실행 취소`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await installLiveMocks(page);
    const heatmap = surface.startsWith('heatmap');
    const domain = heatmap ? 'heatmap' : 'watchlist';
    const folders = [{ id: B, name: '추가 그룹', order: 0 }, { id: A, name: '기존 그룹', order: 1 }];
    const hits = [{ code: '0158S0', name: '엘리스' }, { code: '000660', name: 'SK하이닉스' }];
    const entries = [{ ...hits[0], folder_id: A, order: 0, registered_at_kst_date: '20261021', last_success_date: null }];
    const writes: string[] = [], removals: string[] = [];
    await page.route(apiPrefix('symbols'), route => route.fulfill({ json: {
      status: 'fresh', fetched_at_ms: Date.now(), capture_counts_status: 'ready', symbols: hits.map(hit => ({
        ...hit, market: 'KOSDAQ', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
      })),
    } }));
    await page.route(apiExact(domain), route => route.fulfill({ json: {
      folders, entries, memos: [], capture_markers: {}, next_run_at_ms: 0,
    } }));
    await page.route(apiExact(`${domain}/folders/${B}/members`), route => {
      const code = route.request().postDataJSON().code;
      writes.push(code);
      if (writes.length === 1) return route.fulfill({ status: 503, json: { detail: { code: 'write_failed', message: '저장 실패' } } });
      const entry = { ...hits.find(hit => hit.code === code)!, folder_id: B,
        order: entries.filter(entry => entry.folder_id === B).length,
        registered_at_kst_date: '20261021', last_success_date: null };
      entries.push(entry);
      return route.fulfill({ status: 201, json: entry });
    });
    await page.route(apiPrefix(`${domain}/folders/${B}/members/`), route => {
      expect(route.request().method()).toBe('DELETE');
      const code = route.request().url().split('/').at(-1)!;
      removals.push(code);
      if (removals.length === 1) return route.fulfill({ status: 503, json: { detail: { code: 'undo_failed', message: '취소 실패' } } });
      const index = entries.findIndex(entry => entry.folder_id === B && entry.code === code);
      expect(index).toBeGreaterThanOrEqual(0);
      entries.splice(index, 1);
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('/heatmap');
    const panel = page.getByTestId(heatmap ? 'heatmap-panel' : 'watchlist-panel');
    if (!await panel.isVisible()) await page.getByRole('button', { name: heatmap ? /히트맵 패널 토글/ : /관심종목 패널 토글/ }).click();
    if (surface === 'heatmap-header') await page.getByTestId('heatmap-header-add').click();
    else if (surface === 'watchlist-edit') {
      await page.getByRole('button', { name: '관심종목 편집', exact: true }).click();
      await page.getByTestId(`folder-row-${B}`).getByRole('button', { name: /^추가 그룹\s+\d+$/ }).click();
    } else {
      const header = panel.getByRole('group', { name: '추가 그룹 그룹', exact: true });
      await header.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /종목 추가/ }).click();
    }
    const dialog = page.getByRole('dialog', { name: surface === 'watchlist-edit' ? '관심종목 편집' : '종목 추가', exact: true });
    const search = dialog.getByPlaceholder('종목명 또는 6자리 코드');
    await expect(search).toBeVisible();
    if (surface !== 'watchlist-edit') {
      // The menu's callback ref is briefly detached while its replacement mounts.
      // The add popup must stay beside the right panel, not jump to (0, 0).
      await expect.poll(async () => (await dialog.boundingBox())?.x ?? 0).toBeGreaterThan(640);
    }
    await search.fill('0158s0');
    await dialog.getByRole('option').filter({ hasText: '엘리스' }).click();
    await expect(dialog.getByRole('alert')).toContainText('종목을 추가하지 못했습니다. 저장 실패');
    await expect(search).toHaveValue('엘리스 0158S0');
    await expect(dialog.getByRole('button', { name: /^(추가|＋ 종목 추가)$/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: '다시 시도' }).click();
    await expect(dialog.getByLabel('종목 추가 안내')).toContainText('엘리스 추가됨');
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(dialog.getByLabel('종목 추가 안내')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath(`${surface}-success.png`) });
    await search.fill('엘리스');
    const added = dialog.getByRole('option').filter({ hasText: '엘리스' });
    await expect(added).toHaveAttribute('aria-disabled', 'true');
    await expect(added).toContainText('추가됨');
    await search.press('Enter');
    expect(writes).toEqual(['0158S0', '0158S0']);
    await dialog.getByRole('button', { name: '실행 취소' }).click();
    await expect(dialog.getByRole('alert')).toContainText('추가를 취소하지 못했습니다. 취소 실패');
    await dialog.getByRole('button', { name: '다시 시도' }).click();
    await expect(dialog.getByLabel('종목 추가 안내')).toContainText('엘리스 추가 취소됨');
    expect(entries.some(entry => entry.folder_id === A && entry.code === '0158S0')).toBe(true);
    expect(entries.some(entry => entry.folder_id === B && entry.code === '0158S0')).toBe(false);
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await search.fill('SK하이닉스');
    await search.press('Enter');
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(dialog.getByLabel('종목 추가 안내')).toContainText('SK하이닉스 추가됨');
    expect(writes).toEqual(['0158S0', '0158S0', '000660']);
    expect(removals).toEqual(['0158S0', '0158S0']);
    if (surface === 'heatmap-header' || surface === 'watchlist-edit') {
      await search.fill('다음 검색');
      if (surface === 'heatmap-header') await dialog.getByRole('combobox', { name: '추가할 그룹' }).selectOption(A);
      else await dialog.getByTestId(`folder-row-${A}`).getByRole('button', { name: /^기존 그룹\s+\d+$/ }).click();
      await expect(search).toHaveValue('');
      await expect(dialog.getByRole('button', { name: '실행 취소' })).toHaveCount(0);
    }
    await search.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(panel).toBeVisible();
  });
}
