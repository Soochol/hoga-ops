import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { WhiteboardDocument } from '../../src/api/whiteboards';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { API_URL, BASE_URL } from './worktreeEnv';

test('분봉 버튼 한 번으로 시장·수급·일봉·분봉을 세로 첨부하고 저장·묶음 이동·재열기를 보존한다', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-05-28T06:40:00Z'));
  await installLiveMocks(page);
  const at = Date.UTC(2026, 4, 28);
  const candle = (t_ms: number, i: number, base = 35000) => ({ t_ms, open: base + i * 10,
    high: base + i * 10 + 120, low: base + i * 10 - 50, close: base + i * 10 + 50, volume: 100 + i * 20 });
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: { schema_version: 1, rest_bypass_enabled: false, krx_prefer_hogaplay: false, screener_depth_autocollect: false } }));
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: '098460', venue: 'KRX', from: '20260527', to: '20260528', cached_dates: [], fresh_dates: ['20260527', '20260528'], data_warnings: [],
    candles: [candle(at - 86400000, 0), ...Array.from({ length: 70 }, (_, i) => candle(at + i * 300000, i))],
  } }));
  await page.route(apiExact('live/past-daily-candles'), route => route.fulfill({ json: {
    code: '098460', venue: 'KRX', from: '20250528', to: '20260528', cached_batches: [], fresh_batches: [], data_warnings: [],
    candles: Array.from({ length: 90 }, (_, i) => candle(at - (89 - i) * 86400000, i)),
  } }));
  const marketRequests: string[] = [];
  await page.route(apiExact('live/index-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    marketRequests.push(params.toString());
    return route.fulfill({ json: { index_id: params.get('index_id'), timeframe: '5m', from: '20260528', to: '20260528', data_warnings: [],
      candles: Array.from({ length: 79 }, (_, i) => candle(at + i * 300000, i, params.get('index_id') === 'KOSPI' ? 2500 : 700)) } });
  });
  await page.route(apiExact('market/investor-flow'), route => route.fulfill({ json: {
    date: '20260529', unit: 'amt_eok', confirmed: false, markets: {}, coverage: {}, session_start_sec: 32400, session_end_sec: 59400,
    daily: [{ date: '20260528', markets: { KOSPI: { foreign: 0, institution: 860, individual: -860 }, KOSDAQ: { foreign: -640, institution: 210, individual: 430 } } }],
  } }));
  const before = await (await request.get(`${API_URL}/api/whiteboards`)).json();
  const baseline = new Set(before.boards.map((board: { id: string }) => board.id));
  try {
    await page.goto('/live?code=098460');
    await page.evaluate(async () => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      const chart = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
      store.setState({ windows: [{ ...chart, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: '5m' } }], zOrder: [chart.id], maximizedId: null });
      store.getState().setWindowSymbol(chart.id, { code: '098460', name: '고영', kind: 'stock' });
    });
    await expect(page.getByTestId('live-chart-root').locator('.legend-ohlc-open')).toBeVisible();
    const add = page.getByTestId('chart-window-header').getByRole('button', { name: '복기 노트에 추가', exact: true });
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page).toHaveURL(/\/whiteboard\?board=/, { timeout: 45000 });
    await expect(page.getByTestId('review-canvas')).toBeVisible();
    const id = new URL(page.url()).searchParams.get('board');
    const read = async (): Promise<WhiteboardDocument> => (await request.get(`${API_URL}/api/whiteboards/${id}`)).json();
    const images = (doc: WhiteboardDocument) => doc.scene.elements.filter(el => el.type === 'image' && !el.isDeleted);
    await expect.poll(async () => images(await read()).length).toBe(5);
    await expect.poll(async () => (await read()).review?.stocks).toContain('098460');
    const saved = await read(), attached = images(saved);
    expect(saved.review?.date).toBe('2026-05-28');
    expect(saved.review?.stocks).toContain('098460');
    const sources = attached.map(el => (el.customData as { chartSource: Record<string, unknown> }).chartSource);
    expect(sources.map(source => source.section)).toEqual(['market', 'market', 'investor-flow', 'stock-daily', 'stock-minute']);
    expect(sources.slice(0, 2).map(source => source.index_id)).toEqual(['KOSPI', 'KOSDAQ']);
    expect(sources[0].data_message).toBe('');
    expect(sources[3].data_message).toBe('');
    expect(sources[2].markets).toMatchObject({ KOSPI: { foreign: 0, basis: '확정치' }, KOSDAQ: { foreign: -640 } });
    for (const source of sources) expect(source.review_date).toBe('2026-05-28');
    expect(new Set(attached.map(el => el.x)).size).toBe(1);
    const frame = saved.scene.elements.find(el => el.type === 'frame' && !el.isDeleted)!;
    for (let i = 0; i < attached.length; i++) {
      expect(attached[i].frameId).toBe(frame.id);
      expect(attached[i].groupIds).toEqual(attached[0].groupIds);
      if (i) expect(Number(attached[i].y)).toBeGreaterThan(Number(attached[i - 1].y) + Number(attached[i - 1].height));
    }
    expect(attached[0].link).toBe('/live?index=KOSPI');
    expect(attached[4].link).toBe('/live?code=098460');
    expect(marketRequests).toHaveLength(2);
    for (const query of marketRequests) expect(query).toContain('from=20260528&to=20260528');
    expect(Object.keys(saved.scene.files)).toHaveLength(5);
    // Inspect real persisted PNG assets, rather than only counting image elements.
    for (const file of Object.values(saved.scene.files)) {
      expect(file.width).toBeGreaterThanOrEqual(1000);
      expect(file.size).toBeGreaterThan(2000);
    }
    await page.getByRole('button', { name: '안내 닫기', exact: true }).click();
    await page.screenshot({ path: info.outputPath('review-auto-capture.png') });
    // Selecting one chart selects the group. A keyboard move must move all five together.
    await page.locator('canvas.interactive').click({ position: { x: 600, y: 210 } });
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Number(images(await read())[0].x)).toBeGreaterThan(Number(attached[0].x));
    const moved = images(await read());
    expect(new Set(moved.map(el => Number(el.x) - Number(attached[0].x))).size).toBe(1);
    await page.reload();
    await expect(page.getByTestId('review-canvas')).toBeVisible();
    await expect.poll(async () => images(await read()).map(el => el.id)).toEqual(moved.map(el => el.id));
    expect(images(await read()).map(el => [el.x, el.y, el.frameId, el.groupIds])).toEqual(moved.map(el => [el.x, el.y, el.frameId, el.groupIds]));
  } finally {
    const result = await (await request.get(`${API_URL}/api/whiteboards`)).json();
    for (const board of result.boards as { id: string }[]) if (!baseline.has(board.id)) {
      const doc: WhiteboardDocument = await (await request.get(`${API_URL}/api/whiteboards/${board.id}`)).json();
      await request.put(`${API_URL}/api/whiteboards/${doc.id}`, { headers: { Origin: BASE_URL }, data: {
        mutation_id: randomUUID().replaceAll('-', ''), expected_revision: doc.revision, name: doc.name, scene: doc.scene, review: doc.review, deleted: true,
      } });
    }
  }
});
