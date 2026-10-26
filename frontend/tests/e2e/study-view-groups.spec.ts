import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';
import { API_URL } from './worktreeEnv';

test('차트에서 새 그룹과 저장뷰를 만들고 같은 기간을 다시 저장한 뒤 빈 그룹으로 이동한다', async ({ page, request }, testInfo) => {
  const initial = await (await request.get(`${API_URL}/api/study-views/saves`)).json();
  for (const group of initial.groups) await request.delete(`${API_URL}/api/study-views/groups/${group.id}`);
  await installLiveMocks(page);
  await page.route(apiPrefix('live/past-daily-candles'), (r) => r.fulfill({ json: {
    code: '098460', from: '20260901', to: '20260910', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: Array.from({ length: 10 }, (_, i) => ({ t_ms: Date.UTC(2026, 8, 1 + i), open: 35000, high: 35200, low: 34900, close: 35100, volume: 100 })),
  } }));
  await page.route(apiPrefix('captures/coverage-preview'), (r) => r.fulfill({ json: { have: 10, to_collect: 0, est_minutes: 0, missing: [] } }));
  await page.goto('/live?code=098460');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const chart = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
    store.getState().setChartTimeframe(chart.id, 'D');
    store.getState().setWindowSymbol(chart.id, { code: '098460', name: '고영', kind: 'stock' });
  });
  const saveButton = page.getByRole('button', { name: '현재 뷰 저장' }).first();
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  const dialog = page.getByRole('dialog', { name: '저장뷰 저장' });
  await dialog.getByLabel('새 그룹 이름').fill('돌파 복기');
  await dialog.getByLabel('이름', { exact: true }).fill('기간 A');
  await page.screenshot({ path: testInfo.outputPath('create-group-and-save.png') });
  await dialog.getByRole('button', { name: '그룹 만들고 저장' }).click();
  await expect(dialog).toHaveCount(0);
  await saveButton.click();
  await expect(dialog.getByLabel('저장 그룹')).not.toHaveValue('');
  await dialog.getByLabel('이름', { exact: true }).fill('기간 B');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '목록에서 보기' }).click();
  const panel = page.getByRole('complementary', { name: '저장뷰', exact: true });
  await expect(panel.getByRole('button', { name: '기간 A 저장뷰 열기' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '기간 B 저장뷰 열기' })).toBeVisible();
  const file = await (await request.get(`${API_URL}/api/study-views/saves`)).json();
  expect(file.saves).toHaveLength(2);
  expect(file.saves[0].range).toEqual(file.saves[1].range);
  expect(file.saves[0].id).not.toEqual(file.saves[1].id);
  await panel.getByRole('button', { name: '새 그룹 만들기', exact: true }).click();
  const create = page.getByRole('dialog', { name: '그룹 만들기' });
  await create.getByLabel('그룹 이름').fill('다음 복기');
  await create.getByRole('button', { name: '저장' }).click();
  await expect(panel.getByText('캔들차트의 저장 버튼으로 추가')).toBeVisible();
  await panel.getByRole('button', { name: '기간 A 저장뷰 열기' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '그룹 이동' }).click();
  const move = page.getByRole('dialog', { name: '그룹 이동' });
  await move.getByLabel('저장 그룹').click();
  await page.getByRole('option', { name: '다음 복기', exact: true }).click();
  await move.getByRole('button', { name: '이동', exact: true }).click();
  await expect(panel.getByRole('region', { name: '다음 복기 저장뷰' }).getByText('고영 · 기간 A')).toBeVisible();
  await page.reload();
  await expect(panel.getByRole('region', { name: '다음 복기 저장뷰' }).getByText('고영 · 기간 A')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-user-groups.png') });
});

test('2년보다 과거인 일봉도 보이는 전체 기간을 저장하고 목록과 재조회에 표시한다', async ({ page, request }, testInfo) => {
  const initial = await (await request.get(`${API_URL}/api/study-views/saves`)).json();
  for (const group of initial.groups) await request.delete(`${API_URL}/api/study-views/groups/${group.id}`);
  await page.clock.setFixedTime(new Date('2026-10-26T18:00:00+09:00'));
  await installLiveMocks(page);
  let captureRequests = 0;
  await page.route(apiPrefix('captures/coverage-preview'), r => {
    captureRequests++;
    return r.fulfill({ json: { have: 0, to_collect: 10, est_minutes: 10, missing: [] } });
  });
  await page.route(apiPrefix('live/past-daily-candles'), r => r.fulfill({ json: {
    code: '098460', from: '20200710', to: '20200719', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: Array.from({ length: 10 }, (_, i) => ({ t_ms: Date.UTC(2020, 6, 10 + i), open: 35000, high: 35200, low: 34900, close: 35100, volume: 100 })),
  } }));
  await page.goto('/live?code=098460');
  await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const chart = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
    store.getState().setChartTimeframe(chart.id, 'D');
  });
  const saveButton = page.getByRole('button', { name: '현재 뷰 저장' }).first();
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  const dialog = page.getByRole('dialog', { name: '저장뷰 저장' });
  await expect(dialog.getByText('기간 참조 · 2020-07-10–07-19', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('빠진 기간 수집')).toHaveCount(0);
  await dialog.getByLabel('새 그룹 이름').fill('과거 전체 기간');
  await dialog.getByLabel('이름', { exact: true }).fill('2020년 일봉');
  await dialog.getByRole('button', { name: '그룹 만들고 저장' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '목록에서 보기' }).click();
  const panel = page.getByRole('complementary', { name: '저장뷰', exact: true });
  await expect(panel.getByText('20.07.10–20.07.19', { exact: true })).toBeVisible();
  const file = await (await request.get(`${API_URL}/api/study-views/saves`)).json();
  expect(file.saves[0].range).toEqual({ from_date: '20200710', to_date: '20200719',
    from_ms: Date.UTC(2020, 6, 10), to_ms: Date.UTC(2020, 6, 19) });
  await page.reload();
  await expect(panel.getByText('20.07.10–20.07.19', { exact: true })).toBeVisible();
  expect(captureRequests).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('old-daily-period-saved.png') });
});
