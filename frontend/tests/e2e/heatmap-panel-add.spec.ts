import { test, expect, type Page, type Locator } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

const A = 'f_0000000a', B = 'f_0000000b';
async function setup(page: Page, panel: 'watchlist' | 'heatmap' = 'watchlist') {
  await installLiveMocks(page);
  const folders = [{ id: A, name: '원본', order: 0 }, { id: B, name: '반도체', order: 1 }];
  const source = { code: '005930', name: '삼성전자', folder_id: A, order: 0 };
  const entries = [source];
  const requests: string[] = [];
  let fail = false;
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(apiPrefix('live/quotes'), (r) => r.fulfill(json({ phase: 'open', quotes: [] })));
  await page.route(apiExact('watchlist'), (r) => r.fulfill(json({ folders: [folders[0]], entries: [{ ...source, registered_at_kst_date: '20260908', last_success_date: null }], memos: [], next_run_at_ms: 0 })));
  await page.route(apiExact('heatmap'), (r) => r.fulfill(json({ folders, entries, capture_markers: {}, next_run_at_ms: 0 })));
  await page.route(apiExact(`heatmap/folders/${B}/members`), (r) => {
    requests.push(r.request().postDataJSON().code);
    if (fail) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '저장 실패' }) });
    const added = { ...source, folder_id: B };
    if (!entries.some((e) => e.folder_id === B)) entries.push(added);
    return r.fulfill(json(added));
  });
  const sourceWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /\/api\/(watchlist|heatmap\/(move|entries\/transaction))/.test(request.url())) sourceWrites.push(request.url());
  });
  await page.goto('/heatmap');
  const panelTestId = panel === 'watchlist' ? 'watchlist-group-' : 'heatmap-drawer-group-';
  if (!(await page.getByTestId(`${panelTestId}${A}`).isVisible())) {
    await page.getByRole('button', { name: panel === 'watchlist' ? /관심종목 패널 토글/ : /히트맵 패널 토글/ }).click();
  }
  const handle = page.getByTestId(`${panelTestId}${A}`).getByRole('button', { name: '삼성전자 이동', exact: true });
  await expect(handle).toBeVisible();
  const target = page.locator(`[data-heatmap-drop-folder="${B}"]`);
  await expect(target).toBeVisible();
  return { handle, target, requests, sourceWrites, entries, fail: () => { fail = true; } };
}
async function start(page: Page, handle: Locator, target: Locator) {
  await handle.hover();
  const from = await handle.boundingBox(), to = await target.boundingBox();
  if (!from || !to) throw new Error('Missing drag surface');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x - 8, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await expect(page.getByRole('status').filter({ hasText: '반도체 그룹에 추가' })).toBeVisible();
  await expect(target).toHaveClass(/ring-success/);
}

for (const panel of ['watchlist', 'heatmap'] as const) {
  test(`${panel} 패널에서 빈 보드 그룹에 추가하고 원본·중복을 보존한다`, async ({ page }) => {
    const state = await setup(page, panel);
    await start(page, state.handle, state.target);
    await page.mouse.up();
    await expect(state.target.getByText('삼성전자', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '반도체 그룹에 추가했습니다' })).toBeVisible();
    await expect(state.handle).toBeVisible();
    await start(page, state.handle, state.target);
    await page.mouse.up();
    await expect(page.getByRole('status').filter({ hasText: '이미 반도체 그룹에 등록된 종목입니다' })).toBeVisible();
    expect(state.requests).toEqual(['005930']);
    expect(state.sourceWrites).toEqual([]);
    expect(state.entries.filter((e) => e.folder_id === A)).toHaveLength(1);
  });
}

test('Esc와 그룹 밖 드롭은 저장하지 않는다', async ({ page }) => {
  const state = await setup(page);
  await start(page, state.handle, state.target);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(state.target).not.toHaveClass(/ring-success/);
  await start(page, state.handle, state.target);
  await page.mouse.move(2, 2, { steps: 10 });
  await page.mouse.up();
  await expect(state.target).not.toHaveClass(/ring-success/);
  expect(state.requests).toEqual([]);
  expect(state.sourceWrites).toEqual([]);
});

test('저장 실패를 안내하고 원본을 유지한다', async ({ page }) => {
  const state = await setup(page);
  state.fail();
  await start(page, state.handle, state.target);
  await page.mouse.up();
  await expect(page.getByRole('status').filter({ hasText: '종목을 추가하지 못했습니다' })).toBeVisible();
  await expect(state.handle).toBeVisible();
  await expect(state.target.getByText('삼성전자', { exact: true })).toHaveCount(0);
  expect(state.sourceWrites).toEqual([]);
});

for (const panel of ['screener', 'ranking'] as const) {
  test(`${panel} 결과를 스크롤한 뒤 포인터 아래 보드 그룹에 추가한다`, async ({ page }) => {
    const state = await setup(page);
    const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const row = { code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, change_pct: 1.5, trade_value_won: 1e9, rank: 1 };
    const rows = [row, ...Array.from({ length: 59 }, (_, i) => ({ ...row, code: String(200000 + i), name: `종목${i}`, rank: i + 2, change_pct: 1 }))];
    if (panel === 'screener') {
      await page.route(apiExact('screener/saves'), (r) => r.fulfill(json({ schema_version: 1, saves: [{ id: 's_a', name: '검증', conditions: [{ id: 'c1', type: 'trade_value', params: { min_eok: 100 } }], universe: {}, created_at_ms: 0, updated_at_ms: 0 }] })));
      await page.route(apiPrefix('screener/status'), (r) => r.fulfill(json({ status: 'ok', universe_size: 2000, days_behind: 0 })));
      await page.route(apiExact('screener/scan'), (r) => r.fulfill(json({ status: 'ok', warnings: [], rows })));
      await page.getByRole('button', { name: /스크리너 패널 토글/ }).click();
      await page.getByTestId('screener-panel').getByRole('button', { name: /시작/ }).click();
    } else {
      await page.route(apiPrefix('live/rankings'), (r) => r.fulfill(json({ kind: 'change', market: 'all', direction: 'up', rows, market_open: true, fetched_at_ms: Date.now() })));
      await page.getByRole('button', { name: /순위 패널 토글/ }).click();
    }
    const source = page.getByTestId(`${panel}-row-005930`);
    await expect(source).toBeVisible();
    await start(page, source, state.target);
    const scroller = page.getByTestId(`${panel}-scroll`);
    await scroller.evaluate((el) => { el.scrollTop = 100; });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(state.target).toHaveClass(/ring-success/);
    await page.mouse.up();
    await expect(state.target.getByText('삼성전자', { exact: true })).toBeVisible();
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await expect(source).toBeVisible();
    expect(state.requests).toEqual(['005930']);
    expect(state.sourceWrites).toEqual([]);
  });
}
